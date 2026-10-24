// The browser of one project folder: a single Chrome process, shared by every session open there, with a profile of
// its own that keeps logins between runs. It starts on the first page anyone opens and ends when the last session
// lets go of it, after a while with nobody using it, or when it dies (the next page starts a new one). Sessions own
// the tabs they open (session.ts); this owns the process, the connection and the tabs' plumbing.

import { join, resolve } from "path";
import { projectStateDir } from "../config/paths";
import { browserSettings, type Settings } from "../config/settings";
import { CdpClient, CdpError } from "./cdp";
import { cachedChrome, launchChrome, type ChromeProcess } from "./chrome";
import type { Owner } from "./control";
import { BrowserError, Page, type PageHooks, type Viewport } from "./page";

/** What the pool asks of a session: the tabs it owns. */
export interface PoolClient {
    hooks: PageHooks;
    /** The size a new tab opens at. */
    viewport(): Viewport;
    /** A page one of its tabs (`opener`) opened (window.open): now one of its tabs, or closed if it has too many. */
    adopt(page: Page, opener: Page): void;
    /** Why the permission rules keep a page from being at this address, if they do (a page's own navigations aren't asked about). */
    refuse(url: string): string | undefined;
    /** A tab went away on its own (the page closed itself). */
    closed(page: Page): void;
    /** The browser is gone, with every tab. `crashed`: it wasn't meant to end. */
    lost(crashed: boolean): void;
    /** A person is looking at one of its tabs. */
    watching(): boolean;
    /** A call is using the browser now (a long wait, a slow page). */
    busy(): boolean;
}

export interface PoolOptions {
    root: string;
    settings: () => Settings;
    /** With nobody using it this long, the browser ends (default 10 minutes). */
    idleMs?: number;
    /** How long the browser has to start (default one minute: a cold first start can be slow). */
    startupMs?: number;
}

const IDLE_MS = 10 * 60_000;
/** Where a page may be attached from: the pool asks to be told of pages, and holds them until the code that made them asks. */
interface Attachment {
    sessionId: string;
    info: { targetId: string; type: string; openerId?: string; url: string };
}

export class BrowserPool {
    /** Sessions using it; it ends when the last lets go. */
    clients = new Set<PoolClient>();
    disposed = false;
    private chrome?: ChromeProcess;
    private cdp?: CdpClient;
    private starting?: Promise<CdpClient>;
    private abort = new AbortController();
    private pages = new Map<string, { page: Page; client: PoolClient }>();
    /** Pages the browser attached that no one has taken yet (the one it opens with, or one just made). */
    private attached = new Map<string, Attachment>();
    private attachWaiters = new Map<string, { resolve: (a: Attachment) => void; reject: (e: Error) => void }>();
    private idleTimer?: ReturnType<typeof setTimeout>;

    constructor(readonly o: PoolOptions) {}

    get root(): string {
        return this.o.root;
    }

    /** Whether the browser process is up. */
    get running(): boolean {
        return this.cdp !== undefined && !this.cdp.closed;
    }

    get launching(): boolean {
        return this.starting !== undefined;
    }

    get pid(): number | undefined {
        return this.chrome?.pid;
    }

    /** Opens a tab for `client`, starting the browser if need be. */
    async openPage(client: PoolClient, owner: Owner): Promise<Page> {
        const cdp = await this.connect();
        this.touch();
        const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
        const attachment = await this.attachment(targetId);
        try {
            const page = await this.setUp(cdp, attachment, client, owner);
            await cdp.send("Runtime.runIfWaitingForDebugger", {}, attachment.sessionId);
            return page;
        } catch (e) {
            this.pages.delete(targetId);
            await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
            throw e;
        }
    }

    private async setUp(cdp: CdpClient, a: Attachment, client: PoolClient, owner: Owner): Promise<Page> {
        const page = await Page.attach(cdp, a.sessionId, a.info.targetId, { root: this.o.root, viewport: client.viewport(), owner, hooks: client.hooks, refuse: (url) => client.refuse(url) });
        this.pages.set(a.info.targetId, { page, client });
        return page;
    }

    /** Closes a tab. */
    async closePage(page: Page) {
        if (!this.pages.delete(page.targetId)) return;
        page.dispose();
        await this.cdp?.send("Target.closeTarget", { targetId: page.targetId }).catch(() => undefined);
    }

    /** Brings a tab to the front: a tab behind another is hidden, and a hidden page gets no frames, runs timers slowly and has its dialogs suppressed. */
    async activate(page: Page) {
        await this.cdp?.send("Target.activateTarget", { targetId: page.targetId }).catch(() => undefined);
    }

    /** A session is done with its tabs and with the pool; the last one out ends the browser. */
    async release(client: PoolClient) {
        for (const [id, p] of [...this.pages]) {
            if (p.client !== client) continue;
            this.pages.delete(id);
            p.page.dispose();
            await this.cdp?.send("Target.closeTarget", { targetId: id }).catch(() => undefined);
        }
        this.clients.delete(client);
    }

    /** A call is using the browser: it isn't idle. */
    touch() {
        clearTimeout(this.idleTimer);
        if (!this.running || this.disposed) return;
        this.idleTimer = setTimeout(() => {
            if ([...this.clients].some((c) => c.watching() || c.busy())) this.touch();
            else void this.shutdown(false);
        }, this.o.idleMs ?? IDLE_MS);
        this.idleTimer.unref?.();
    }

    // -----------------------------------------------------------------------
    // The process

    private connect(): Promise<CdpClient> {
        if (this.disposed) return Promise.reject(new BrowserError("The browser is shutting down."));
        if (this.cdp && !this.cdp.closed) return Promise.resolve(this.cdp);
        return (this.starting ??= this.launch().finally(() => {
            this.starting = undefined;
        }));
    }

    private async launch(): Promise<CdpClient> {
        const found = cachedChrome(browserSettings(this.o.settings()).executable);
        if (!found.ok) throw new BrowserError(found.error);
        let chrome: ChromeProcess;
        try {
            chrome = await launchChrome({ executable: found.path, profile: join(projectStateDir(this.o.root), "browser"), headless: browserSettings(this.o.settings()).headless, startupMs: this.o.startupMs, signal: this.abort.signal });
        } catch (e) {
            throw new BrowserError(`The browser didn't start: ${(e as Error).message}`);
        }
        const failed = async (e: unknown, cdp?: CdpClient): Promise<never> => {
            cdp?.close();
            await chrome.stop();
            throw new BrowserError(`The browser didn't start: ${(e as Error).message}`);
        };
        const cdp = await CdpClient.connect(chrome.wsUrl, { signal: this.abort.signal }).catch((e) => failed(e));
        try {
            this.listen(cdp);
            cdp.onClose(() => void this.lost(chrome, cdp, true));
            // Every new page waits for the pool to set it up (URL policy and the rest) before it loads anything.
            await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "page" }, { exclude: true }] });
            // Titles and addresses of the pages, as they change (for the pane's tab strip).
            await cdp.send("Target.setDiscoverTargets", { discover: true });
            // A page can't put files on the disk: a download is refused, and told to the tab it came from.
            await cdp.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true });
        } catch (e) {
            return failed(e, cdp);
        }
        if (this.disposed) {
            cdp.close();
            await chrome.stop();
            throw new BrowserError("The browser is shutting down.");
        }
        this.chrome = chrome;
        this.cdp = cdp;
        void chrome.exited.then(() => this.lost(chrome, cdp, true));
        this.touch();
        return cdp;
    }

    private listen(cdp: CdpClient) {
        cdp.on("Target.attachedToTarget", (p: { sessionId: string; targetInfo: Attachment["info"] }) => {
            const a: Attachment = { sessionId: p.sessionId, info: p.targetInfo };
            if (a.info.type !== "page") return;
            const opener = a.info.openerId ? this.pages.get(a.info.openerId) : undefined;
            if (opener) void this.adopt(cdp, a, opener);
            else if (this.attachWaiters.has(a.info.targetId)) {
                this.attachWaiters.get(a.info.targetId)!.resolve(a);
                this.attachWaiters.delete(a.info.targetId);
            } else this.attached.set(a.info.targetId, a);
        });
        cdp.on("Target.targetInfoChanged", (p: { targetInfo: { targetId: string; title?: string; url?: string } }) => this.pages.get(p.targetInfo.targetId)?.page.targetChanged(p.targetInfo));
        cdp.on("Target.targetDestroyed", (p: { targetId: string }) => {
            this.attached.delete(p.targetId);
            const gone = this.pages.get(p.targetId);
            if (!gone) return;
            this.pages.delete(p.targetId);
            gone.page.dispose();
            gone.client.closed(gone.page);
        });
        cdp.on("Browser.downloadWillBegin", (p: { frameId: string; url: string; suggestedFilename?: string }) => {
            this.pages.get(p.frameId)?.page.console.add("download", `A download was blocked: ${p.suggestedFilename || p.url.slice(0, 200)}. Downloads aren't saved.`);
        });
    }

    /** A page one of the tabs opened: the same session's, set up like any other. */
    private async adopt(cdp: CdpClient, a: Attachment, opener: { page: Page; client: PoolClient }) {
        try {
            const page = await this.setUp(cdp, a, opener.client, opener.page.control.owner);
            await cdp.send("Runtime.runIfWaitingForDebugger", {}, a.sessionId);
            opener.client.adopt(page, opener.page);
        } catch {
            this.pages.delete(a.info.targetId);
            await cdp.send("Target.closeTarget", { targetId: a.info.targetId }).catch(() => undefined);
        }
    }

    /** The page the browser attached for a target just made: it may have been reported before the answer that names it, or after. */
    private attachment(targetId: string): Promise<Attachment> {
        const have = this.attached.get(targetId);
        if (have) {
            this.attached.delete(targetId);
            return Promise.resolve(have);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.attachWaiters.delete(targetId);
                reject(new BrowserError("The browser didn't attach to the new tab."));
            }, 10_000);
            this.attachWaiters.set(targetId, {
                resolve: (a) => {
                    clearTimeout(timer);
                    resolve(a);
                },
                reject: (e) => {
                    clearTimeout(timer);
                    reject(e);
                },
            });
        });
    }

    /** The connection or the process ended. */
    private async lost(chrome: ChromeProcess, cdp: CdpClient, crashed: boolean) {
        if (this.chrome !== chrome) return;
        this.chrome = undefined;
        this.cdp = undefined;
        clearTimeout(this.idleTimer);
        const gone = [...this.pages.values()];
        this.pages.clear();
        this.attached.clear();
        for (const w of this.attachWaiters.values()) w.reject(new BrowserError("The browser closed while the tab was opening."));
        this.attachWaiters.clear();
        for (const { page } of gone) page.dispose();
        cdp.close();
        for (const c of new Set([...gone.map((g) => g.client), ...this.clients])) c.lost(crashed && !this.disposed);
        await chrome.stop();
    }

    /** Ends the browser (idle, or the end of the last session); the next page starts another. */
    async shutdown(crashed: boolean) {
        const chrome = this.chrome;
        const cdp = this.cdp;
        if (chrome && cdp) await this.lost(chrome, cdp, crashed);
    }

    /** No more use for the pool: ends the browser, and anything starting it. */
    async dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.abort.abort();
        clearTimeout(this.idleTimer);
        await this.starting?.catch(() => undefined);
        await this.shutdown(false);
    }
}

const pools = new Map<string, BrowserPool>();

/** The pool for a project folder, made on first use; each acquire needs a releasePool. */
export function acquirePool(o: PoolOptions, client: PoolClient): BrowserPool {
    const root = resolve(o.root);
    let pool = pools.get(root);
    if (!pool || pool.disposed) {
        pool = new BrowserPool({ ...o, root });
        pools.set(root, pool);
    }
    pool.clients.add(client);
    return pool;
}

/** `client` is done with the pool: its tabs close, and the last client to leave ends the browser. */
export async function releasePool(pool: BrowserPool, client: PoolClient) {
    await pool.release(client);
    if (pool.clients.size > 0) return;
    if (pools.get(pool.root) === pool) pools.delete(pool.root);
    await pool.dispose();
}

/** Errors from a command that mean the browser went away under it, as the agent should hear them. */
export function lostBrowser(e: unknown): BrowserError | undefined {
    if (e instanceof CdpError && /connection to the browser|browser is closed/i.test(e.message)) return new BrowserError("The browser closed while this ran (it may have crashed), and its tabs are gone. Open a page again (BrowserNavigate) to start a new one.");
    return undefined;
}
