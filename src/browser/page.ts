// One tab: what it shows and says (URL, title, console, requests, dialogs), and the commands that read or move it.
// A Page is attached to a browser target through the shared CDP connection (cdp.ts). Acting on a page by ref or
// coordinates is in interact.ts; who may act on it, in control.ts.

import type { ImagePart } from "../providers/types";
import { redact } from "../util/redact";
import { domFacts, outlineOf, SNAPSHOT_CHARS, type AxNode } from "./ax";
import { CdpClient, COMMAND_TIMEOUT_MS } from "./cdp";
import { TAKEN_OVER, TabControl, type Owner } from "./control";
import { ConsoleLog, NetworkLog, type ConsoleLevel } from "./logs";
import { RefTable } from "./refs";
import { allowedPage, checkUrl, displayUrl } from "./url-policy";

/** A failure the agent can act on: its message says what to do. */
export class BrowserError extends Error {}

export interface Viewport {
    /** CSS pixels. */
    width: number;
    height: number;
    /** Device pixels per CSS pixel. */
    scale: number;
}

/** The size agents see, so their screenshots are the same from one session to the next. */
export const AGENT_VIEWPORT: Viewport = { width: 1280, height: 800, scale: 1 };
export const MIN_SIDE = 200;
export const MAX_SIDE = 4000;

/** A frame of what the page shows, for the pane. `width` and `height`: the page's size in CSS pixels. */
export interface Frame {
    data: string;
    width: number;
    height: number;
}

export interface PageHooks {
    /** Something a viewer shows changed: address, title, loading, dialog, who has control. */
    changed(page: Page): void;
    frame(page: Page, frame: Frame): void;
}

export interface PendingDialog {
    type: string;
    message: string;
    defaultPrompt?: string;
}

/** The time a page gets to finish loading before a call goes on without it. */
export const LOAD_TIMEOUT_MS = 30_000;
/** How long without a request in flight counts as the page having settled, and the most a call waits for it. */
const QUIET_MS = 300;
const SETTLE_MAX_MS = 3000;
const EVAL_MAX_CHARS = 10_000;
const SCREENSHOT_MAX_BASE64 = 4 * 1024 * 1024;
const FULL_PAGE_MAX_HEIGHT = 8000;

/** An object as JSON, with what JSON can't say named: elements, functions, big integers, a second visit to an object. */
const SERIALIZE = `function () {
    const seen = new WeakSet();
    return JSON.stringify(this, (key, value) => {
        if (typeof value === "bigint") return value + "n";
        if (typeof value === "function") return "[function " + value.name + "]";
        if (typeof value === "symbol") return value.toString();
        if (value instanceof Node) return "<" + value.nodeName.toLowerCase() + (value.id ? "#" + value.id : "") + ">";
        if (value instanceof Window) return "[window]";
        if (value && typeof value === "object") {
            if (seen.has(value)) return "[repeated]";
            seen.add(value);
        }
        return value;
    }, 2);
}`;

const LEVELS: Record<string, ConsoleLevel> = { log: "log", info: "info", debug: "debug", verbose: "debug", warning: "warn", warn: "warn", error: "error", assert: "error", trace: "debug" };

interface RemoteObject {
    type: string;
    subtype?: string;
    value?: unknown;
    unserializableValue?: string;
    description?: string;
    preview?: { properties?: { name: string; value?: string }[]; overflow?: boolean };
}

/** A console argument as it reads in a log. */
function shown(o: RemoteObject): string {
    if (o.type === "string") return String(o.value ?? "");
    if (o.value !== undefined) return typeof o.value === "object" ? JSON.stringify(o.value) : String(o.value);
    if (o.unserializableValue) return o.unserializableValue;
    if (o.preview?.properties?.length && o.subtype !== "error") {
        const props = o.preview.properties.map((p) => `${p.name}: ${p.value}`).join(", ");
        return o.subtype === "array" ? `[${o.preview.properties.map((p) => p.value).join(", ")}${o.preview.overflow ? ", …" : ""}]` : `${o.description ?? "Object"} {${props}${o.preview.overflow ? ", …" : ""}}`;
    }
    return o.description ?? o.type;
}

/** Why a navigation failed, with what to do about it. */
function navigationFailure(url: string, error: string): string {
    const where = displayUrl(url);
    if (/ERR_CONNECTION_REFUSED/.test(error)) return `Couldn't load ${where}: nothing is listening there (${error}). If it's a dev server, start it first (Bash with run_in_background) and wait for it to be ready.`;
    if (/ERR_NAME_NOT_RESOLVED/.test(error)) return `Couldn't load ${where}: the host name doesn't resolve (${error}).`;
    if (/ERR_ABORTED/.test(error)) return `Couldn't load ${where}: the load was aborted (${error}). It may be a download (downloads are blocked here), or a page that redirected itself elsewhere.`;
    if (/ERR_BLOCKED_BY_CLIENT/.test(error)) return `Couldn't load ${where}: the browser here doesn't open that kind of address.`;
    return `Couldn't load ${where}: ${error}`;
}

export interface PageOptions {
    /** The project: file: URLs must be inside it. */
    root: string;
    /** Why the permission rules refuse a page to be at this address (a deny rule), if they do. Asked of every document and file the page loads. */
    refuse?: (url: string) => string | undefined;
    viewport: Viewport;
    owner: Owner;
    hooks: PageHooks;
}

export class Page {
    readonly refs = new RefTable();
    readonly console = new ConsoleLog();
    readonly network = new NetworkLog();
    readonly control: TabControl;
    url = "";
    title = "";
    loading = false;
    crashed = false;
    dialog?: PendingDialog;
    canGoBack = false;
    canGoForward = false;
    viewport: Viewport;
    /** The last outline given for this page, for what changed since. */
    lastOutline?: { generation: number; text: string };
    /** The HTTP status of the document the page shows. */
    documentStatus?: number;
    /** The latest main-frame document response, by the load it belongs to. */
    private document?: { loaderId: string; status: number };
    closed = false;
    /** Main-frame navigations so far: a call that causes one waits for this to move. */
    private navigations = 0;
    private waiters = new Set<() => void>();
    private unlisten: (() => void)[] = [];
    private lock: Promise<unknown> = Promise.resolve();
    private streaming = false;

    private constructor(
        readonly cdp: CdpClient,
        readonly sessionId: string,
        readonly targetId: string,
        private o: PageOptions,
    ) {
        this.control = new TabControl(o.owner);
        this.viewport = o.viewport;
    }

    /**
     * Attaches to a target and sets it up: events on, requests to documents checked against the URL policy, the page
     * sized. The target may still be waiting for the debugger (Target.setAutoAttach): the caller resumes it.
     */
    static async attach(cdp: CdpClient, sessionId: string, targetId: string, o: PageOptions): Promise<Page> {
        const page = new Page(cdp, sessionId, targetId, o);
        page.listen();
        try {
            await Promise.all([
                page.send("Page.enable"),
                page.send("Page.setLifecycleEventsEnabled", { enabled: true }),
                page.send("Runtime.enable"),
                page.send("Network.enable"),
                page.send("Log.enable"),
                // Pages that load from somewhere the policy refuses never start loading; nor does anything a page reads from a file.
                page.send("Fetch.enable", { patterns: [{ resourceType: "Document", requestStage: "Request" }, { urlPattern: "file:*", requestStage: "Request" }] }),
                // A page nobody is looking at in a headless browser still behaves as focused: focus styles, blur handlers.
                page.send("Emulation.setFocusEmulationEnabled", { enabled: true }),
                page.setViewport(o.viewport),
            ]);
        } catch (e) {
            page.dispose();
            throw e;
        }
        return page;
    }

    get inflight(): number {
        return this.network.inflight;
    }

    /** Runs a CDP command on this page. */
    send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
        if (this.closed) return Promise.reject(new BrowserError("This tab was closed."));
        return this.cdp.send<T>(method, params, this.sessionId, timeoutMs);
    }

    /**
     * An input event (a click, a key). A page that opens a dialog while handling it holds the command until the dialog
     * is answered, and the answer may only come from a later call: so a dialog opening ends the wait too.
     */
    async input(method: string, params: Record<string, unknown>) {
        const stop = new AbortController();
        const sent = this.send(method, params);
        const dialog = this.waitUntil(() => this.dialog !== undefined, COMMAND_TIMEOUT_MS, stop.signal).then(
            () => undefined,
            () => undefined,
        );
        try {
            await Promise.race([sent, dialog]);
        } finally {
            stop.abort();
            sent.catch(() => undefined);
        }
    }

    /** One command on the page at a time: calls that arrive together (parallel tool calls) take turns. */
    exclusive<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.lock.then(fn);
        this.lock = run.catch(() => undefined);
        return run;
    }

    /** An input the agent sends: refused once the person has the tab or the call is cancelled, so a click queued behind a long wait doesn't land on their page. */
    agentInput(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
        this.stillAgent(signal);
        return this.input(method, params);
    }

    /** The start of an action by the agent: the tab is up to it (ready), and still the agent's to act on. */
    actable(signal?: AbortSignal) {
        this.ready();
        this.stillAgent(signal);
    }

    /** Throws if the agent may no longer act on the tab: the call was cancelled, or the person took the tab. */
    stillAgent(signal?: AbortSignal) {
        if (signal?.aborted) throw new BrowserError("Interrupted by user.");
        if (this.control.owner === "human") throw new BrowserError(TAKEN_OVER);
    }

    /** Fails a call that can't run now: the tab crashed, or a dialog is holding the page. */
    ready() {
        if (this.closed) throw new BrowserError("This tab was closed.");
        if (this.crashed) throw new BrowserError("This tab's page crashed. Reload it (BrowserNavigate action=reload) or open the address again.");
        if (this.dialog) throw new BrowserError(`A JavaScript ${this.dialog.type} dialog is open ("${this.dialog.message.slice(0, 200)}"). Answer it with BrowserAct action=dialog (accept true or false) before anything else.`);
    }

    // -----------------------------------------------------------------------
    // Events

    private on(event: string, fn: (params: any) => void) {
        this.unlisten.push(this.cdp.on(event, (params, sessionId) => sessionId === this.sessionId && fn(params)));
    }

    private wake() {
        for (const w of [...this.waiters]) w();
    }

    /** Something a viewer shows changed (and anything waiting may go on). */
    private changed() {
        this.wake();
        if (!this.closed) this.o.hooks.changed(this);
    }

    private listen() {
        const mainFrame = (p: { frameId?: string }) => p.frameId === this.targetId;
        this.on("Page.frameStartedLoading", (p) => {
            if (!mainFrame(p)) return;
            this.loading = true;
            this.changed();
        });
        this.on("Page.frameStoppedLoading", (p) => {
            if (!mainFrame(p)) return;
            this.loading = false;
            this.changed();
            void this.refreshHistory();
            // The browser's report of the title can come late or not at all: the pane's tab strip reads it from the page.
            void this.readTitle();
        });
        this.on("Page.frameNavigated", (p: { frame: { id: string; parentId?: string; url: string; loaderId?: string } }) => {
            if (p.frame.parentId) return;
            this.navigations++;
            this.url = p.frame.url;
            this.title = "";
            this.crashed = false;
            this.refs.invalidate();
            this.network.forgetInflight();
            this.lastOutline = undefined;
            this.documentStatus = this.document && this.document.loaderId === p.frame.loaderId ? this.document.status : undefined;
            const why = this.refusal(this.url);
            if (why) void this.block(this.url, why);
            this.changed();
        });
        this.on("Page.navigatedWithinDocument", (p: { frameId: string; url: string }) => {
            if (!mainFrame(p)) return;
            this.navigations++;
            this.url = p.url;
            this.changed();
            void this.refreshHistory();
        });
        this.on("Page.javascriptDialogOpening", (p: { type: string; message: string; defaultPrompt?: string }) => {
            // An alert or a leave-the-page prompt has one answer worth giving; only a question needs someone to choose.
            if (p.type === "alert" || p.type === "beforeunload") {
                this.console.add("dialog", `${p.type}: ${p.message}`);
                void this.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => undefined);
                return;
            }
            this.dialog = { type: p.type, message: p.message, ...(p.defaultPrompt ? { defaultPrompt: p.defaultPrompt } : {}) };
            this.console.add("dialog", `${p.type}: ${p.message}`);
            this.changed();
        });
        this.on("Page.javascriptDialogClosed", () => {
            this.dialog = undefined;
            this.changed();
        });
        this.on("Inspector.targetCrashed", () => {
            this.crashed = true;
            this.loading = false;
            this.changed();
        });
        this.on("Fetch.requestPaused", (p: { requestId: string; request: { url: string } }) => {
            const why = this.refusal(p.request.url);
            if (why) this.console.add("error", `Blocked a load of ${displayUrl(p.request.url)}: ${why}`);
            const command = why ? this.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }) : this.send("Fetch.continueRequest", { requestId: p.requestId });
            command.catch(() => undefined);
        });
        this.on("Runtime.consoleAPICalled", (p: { type: string; args: RemoteObject[] }) => {
            this.console.add(LEVELS[p.type] ?? "log", p.args.map(shown).join(" "));
            this.wake();
        });
        this.on("Runtime.exceptionThrown", (p: { exceptionDetails: { text: string; url?: string; lineNumber?: number; exception?: { description?: string } } }) => {
            const d = p.exceptionDetails;
            this.console.add("exception", `${d.exception?.description ?? d.text}${d.url ? ` (${displayUrl(d.url)}:${(d.lineNumber ?? 0) + 1})` : ""}`);
            this.wake();
        });
        this.on("Log.entryAdded", (p: { entry: { level: string; text: string; url?: string } }) => {
            // The browser's hints to developers ("inputs should have autocomplete") and every site's missing favicon aren't news.
            if (p.entry.level === "verbose" || p.entry.url?.endsWith("/favicon.ico")) return;
            this.console.add(LEVELS[p.entry.level] ?? "log", `${p.entry.text}${p.entry.url ? ` (${displayUrl(p.entry.url)})` : ""}`);
            this.wake();
        });
        this.on("Network.requestWillBeSent", (p: { requestId: string; type?: string; request: { method: string; url: string }; redirectResponse?: { status: number } }) => {
            this.network.start(p.requestId, p.request.method, p.request.url, p.type, p.redirectResponse);
            this.wake();
        });
        this.on("Network.responseReceived", (p: { requestId: string; loaderId?: string; type?: string; frameId?: string; response: { status: number } }) => {
            this.network.response(p.requestId, p.response.status);
            // The page's own response comes before the navigation it commits: kept until then.
            if (p.type === "Document" && mainFrame(p) && p.loaderId) this.document = { loaderId: p.loaderId, status: p.response.status };
        });
        this.on("Network.loadingFinished", (p: { requestId: string }) => {
            this.network.finish(p.requestId);
            this.wake();
        });
        this.on("Network.loadingFailed", (p: { requestId: string; errorText: string; canceled?: boolean }) => {
            this.network.fail(p.requestId, p.errorText, Boolean(p.canceled));
            this.wake();
        });
        this.on("Page.screencastFrame", (p: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
            // Acknowledged at once: Chrome sends the next frame when the page changes; the pane's own pace is the feed's (feed.ts).
            this.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => undefined);
            if (this.streaming) this.o.hooks.frame(this, { data: p.data, width: p.metadata.deviceWidth, height: p.metadata.deviceHeight });
        });
    }

    /** Why a page may not be at (or load) this address, if it may not: the URL policy, then the permission rules' deny rules. */
    private refusal(url: string): string | undefined {
        if (!allowedPage(url, this.o.root)) return (checkUrl(url, this.o.root) as { error: string }).error;
        // The browser's own error page and a blank tab aren't places.
        return url === "" || url.startsWith("chrome-error:") ? undefined : this.o.refuse?.(url);
    }

    /** The address changed to somewhere that isn't allowed (a script, a link): back to a blank page. */
    private async block(url: string, why: string) {
        this.console.add("error", `Navigation to ${displayUrl(url)} was blocked: ${why}`);
        await this.send("Page.navigate", { url: "about:blank" }).catch(() => undefined);
    }

    private async refreshHistory() {
        try {
            const h = await this.send<{ currentIndex: number; entries: unknown[] }>("Page.getNavigationHistory");
            const back = h.currentIndex > 0;
            const forward = h.currentIndex < h.entries.length - 1;
            if (back !== this.canGoBack || forward !== this.canGoForward) {
                this.canGoBack = back;
                this.canGoForward = forward;
                this.changed();
            }
        } catch {
            // closed meanwhile
        }
    }

    /** Called with what the browser knows of the target, when it changes. */
    targetChanged(info: { title?: string; url?: string }) {
        if (info.title !== undefined && info.title !== this.title) {
            this.title = info.title;
            this.changed();
        }
    }

    /**
     * Waits until `done()` holds, for at most `ms`: true if it did. Re-checked at every event from the page. Rejects when
     * `signal` aborts or the tab closes.
     */
    waitUntil(done: () => boolean, ms: number, signal?: AbortSignal): Promise<boolean> {
        return new Promise((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const finish = (outcome: boolean | Error) => {
                clearTimeout(timer);
                this.waiters.delete(check);
                signal?.removeEventListener("abort", abort);
                if (outcome instanceof Error) reject(outcome);
                else resolve(outcome);
            };
            const check = () => {
                if (this.closed) finish(new BrowserError("This tab was closed."));
                else if (done()) finish(true);
            };
            const abort = () => finish(new BrowserError("Interrupted by user."));
            if (signal?.aborted) return abort();
            this.waiters.add(check);
            signal?.addEventListener("abort", abort, { once: true });
            timer = setTimeout(() => finish(false), Math.max(0, ms));
            check();
        });
    }

    /** Waits for the page to go quiet: loaded, and no request in flight for a moment. Never longer than `maxMs`. */
    async settle(signal?: AbortSignal, maxMs = SETTLE_MAX_MS) {
        const deadline = Date.now() + maxMs;
        for (;;) {
            const left = deadline - Date.now();
            if (left <= 0) return;
            if (this.loading || this.inflight > 0) {
                await this.waitUntil(() => !this.loading && this.inflight === 0, left, signal);
                continue;
            }
            if (!(await this.waitUntil(() => this.loading || this.inflight > 0, Math.min(QUIET_MS, left), signal))) return;
        }
    }

    // -----------------------------------------------------------------------
    // Navigation

    /** Runs `start`, which makes the page navigate, and waits for the new page to load. False if it hadn't within `timeoutMs`. */
    private async navigate(start: () => Promise<void>, signal: AbortSignal | undefined, timeoutMs: number): Promise<boolean> {
        const before = this.navigations;
        await start();
        const deadline = Date.now() + timeoutMs;
        // A navigation that changes nothing (the same fragment) or is refused leaves the count where it was: not waited for long.
        if (!(await this.waitUntil(() => this.navigations > before, Math.min(timeoutMs, 5000), signal))) return true;
        const loaded = await this.waitUntil(() => !this.loading, deadline - Date.now(), signal);
        if (loaded) await this.settle(signal);
        return loaded;
    }

    /** Opens `url` (already checked by the URL policy) and waits for the load. False if it was still loading after `timeoutMs`. */
    goto(url: string, signal?: AbortSignal, timeoutMs = LOAD_TIMEOUT_MS): Promise<boolean> {
        this.ready();
        return this.navigate(async () => {
            const r = await this.send<{ errorText?: string }>("Page.navigate", { url });
            if (r.errorText) throw new BrowserError(navigationFailure(url, r.errorText));
        }, signal, timeoutMs);
    }

    async go(delta: -1 | 1, signal?: AbortSignal, timeoutMs = LOAD_TIMEOUT_MS): Promise<boolean> {
        this.ready();
        return this.navigate(async () => {
            const h = await this.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory");
            const entry = h.entries[h.currentIndex + delta];
            if (!entry) throw new BrowserError(delta < 0 ? "This tab has no earlier page to go back to." : "This tab has no later page to go forward to.");
            await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
        }, signal, timeoutMs);
    }

    reload(signal?: AbortSignal, timeoutMs = LOAD_TIMEOUT_MS): Promise<boolean> {
        if (this.closed) return Promise.reject(new BrowserError("This tab was closed."));
        return this.navigate(async () => {
            // A crashed tab and one holding a dialog are what a reload is for.
            if (this.dialog) await this.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => undefined);
            await this.send("Page.reload");
        }, signal, timeoutMs);
    }

    async setViewport(v: Viewport) {
        this.viewport = v;
        await this.send("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: v.scale, mobile: false });
    }

    // -----------------------------------------------------------------------
    // Reading

    /** The page's outline, with a ref for each element to act on. */
    async outline(): Promise<{ text: string; lines: number; shown: number }> {
        if (!allowedPage(this.url, this.o.root)) throw new BrowserError(`This tab is at ${displayUrl(this.url)}, which the browser here doesn't show.`);
        const [tree, dom] = await Promise.all([this.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree"), this.send("DOMSnapshot.captureSnapshot", { computedStyles: [] })]);
        const outline = outlineOf(tree.nodes, { refs: this.refs, dom: domFacts(dom), maxChars: SNAPSHOT_CHARS });
        this.refs.replace(outline.entries);
        return outline;
    }

    /** The document's title, from the page itself (the target's own can be a step behind). */
    async readTitle(): Promise<string> {
        // A page held by a dialog (or crashed) answers nothing.
        if (this.dialog || this.crashed) return this.title;
        try {
            const r = await this.send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression: "document.title", returnByValue: true });
            if (typeof r.result.value === "string" && r.result.value !== this.title) {
                this.title = r.result.value;
                this.changed();
            }
        } catch {
            // keeps what it knew
        }
        return this.title;
    }

    /**
     * A screenshot: the viewport, the whole page (up to a height), or `clip`, a box in the viewport's CSS pixels. Its size
     * is in CSS pixels whatever the device scale, so it doesn't depend on who is watching.
     */
    async screenshot(o: { fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } } = {}): Promise<ImagePart & { width: number; height: number }> {
        this.ready();
        const m = await this.send<{ cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }; cssContentSize: { width: number; height: number } }>("Page.getLayoutMetrics");
        const v = m.cssVisualViewport;
        const region = o.fullPage ? { x: 0, y: 0, width: Math.ceil(m.cssContentSize.width), height: Math.min(Math.ceil(m.cssContentSize.height), FULL_PAGE_MAX_HEIGHT) } : o.clip ? { ...o.clip, x: o.clip.x + v.pageX, y: o.clip.y + v.pageY } : { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight };
        const shoot = async (format: "png" | "jpeg") => {
            const r = await this.send<{ data: string }>("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality: 80 } : {}), clip: { ...region, scale: 1 / this.viewport.scale }, captureBeyondViewport: o.fullPage === true });
            return r.data;
        };
        let data = await shoot("png");
        let mediaType = "image/png";
        // A busy page's PNG can be several megabytes; the same view as a JPEG is a fraction.
        if (data.length > SCREENSHOT_MAX_BASE64) {
            data = await shoot("jpeg");
            mediaType = "image/jpeg";
        }
        return { type: "image", mediaType, data, width: Math.round(region.width), height: Math.round(region.height) };
    }

    /** Evaluates JavaScript in the page; its value as JSON (a description of what JSON can't carry), redacted and capped. */
    async evaluate(expression: string, signal?: AbortSignal): Promise<string> {
        this.ready();
        const group = "harness-eval";
        try {
            const r = await raceAbort(this.send<{ result: RemoteObject & { objectId?: string }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", { expression, awaitPromise: true, userGesture: true, allowUnsafeEvalBlockedByCSP: true, timeout: 15_000, objectGroup: group }, 20_000), signal);
            if (r.exceptionDetails) throw new BrowserError(`The expression threw: ${redact(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 2000)}`);
            const o = r.result;
            let text: string | undefined;
            if (o.type === "undefined") text = "undefined";
            else if (o.objectId && o.type === "object" && o.subtype !== "null") {
                const s = await this.send<{ result: { value?: string } }>("Runtime.callFunctionOn", { objectId: o.objectId, functionDeclaration: SERIALIZE, returnByValue: true });
                text = s.result.value;
            } else text = o.value !== undefined ? (JSON.stringify(o.value, null, 2) ?? String(o.value)) : (o.unserializableValue ?? o.description ?? o.type);
            const safe = redact(text ?? o.description ?? o.type);
            return safe.length > EVAL_MAX_CHARS ? `${safe.slice(0, EVAL_MAX_CHARS)}\n… (${safe.length - EVAL_MAX_CHARS} more characters)` : safe;
        } finally {
            this.send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined);
        }
    }

    /** Answers the dialog the page is showing. */
    async answerDialog(accept: boolean, promptText?: string) {
        if (!this.dialog) throw new BrowserError("No JavaScript dialog is open in this tab.");
        await this.send("Page.handleJavaScriptDialog", { accept, ...(promptText !== undefined ? { promptText } : {}) });
    }

    // -----------------------------------------------------------------------
    // Streaming

    /** Frames of the page go to the hooks, at most `width` by `height` device pixels. */
    async startScreencast(width: number, height: number) {
        this.streaming = true;
        await this.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: Math.round(width), maxHeight: Math.round(height), everyNthFrame: 1 });
    }

    async stopScreencast() {
        if (!this.streaming) return;
        this.streaming = false;
        await this.send("Page.stopScreencast").catch(() => undefined);
    }

    get screencasting(): boolean {
        return this.streaming;
    }

    /** The tab is gone: nothing waits for it any more, and it hears nothing more. */
    dispose() {
        if (this.closed) return;
        this.closed = true;
        this.streaming = false;
        for (const off of this.unlisten) off();
        this.unlisten = [];
        this.wake();
        this.waiters.clear();
    }
}

/** `promise`, or a rejection as soon as `signal` aborts (the work it started goes on, bounded by its own limit). */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    return new Promise<T>((resolve, reject) => {
        const abort = () => reject(new BrowserError("Interrupted by user."));
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}
