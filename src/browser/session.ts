// One Harness session's use of its project's browser (pool.ts): the tabs it opened, which one is current, and who is
// driving each. The agent's tools work through it, and so does the GUI's Browser pane, which watches the current tab
// as a stream of frames and sends a person's clicks and keys back. It needs no GUI: the TUI and headless runs use
// it as the tools do, and the server only subscribes to what it announces.

import { redact } from "../util/redact";
import type { BrowserInput, BrowserState, BrowserTabInfo } from "../server/protocol";
import { browserSettings, type Settings } from "../config/settings";
import { cachedChrome } from "./chrome";
import type { Owner } from "./control";
import { FrameFeed } from "./feed";
import { InputQueue } from "./input-queue";
import { forward, parseInput, takesControl } from "./interact";
import { AGENT_VIEWPORT, BrowserError, MAX_SIDE, MIN_SIDE, type Frame, type Page, type PageHooks, type Viewport } from "./page";
import { acquirePool, lostBrowser, releasePool, type BrowserPool, type PoolClient, type PoolOptions } from "./pool";
import { addressToUrl, checkUrl } from "./url-policy";

/** A session's tabs at most: each is a page in the browser's memory. */
export const MAX_TABS = 8;

/** What the window shows of the current tab, with the tab it came from. */
export type TabFrame = Frame & { tab: number };

const TURNED_OFF = "The browser is turned off: browser.enabled is false in the settings.";

/** The most state announcements are sent: the changes of a busy page arrive in bursts. */
const ANNOUNCE_MS = 40;

export interface SessionOptions {
    root: string;
    settings: () => Settings;
    /** Why the permission rules (deny rules) keep a page from being at this address, if they do. */
    refuse?: (url: string, approvedFile?: string) => string | undefined;
    /** Tests: shorter idle and startup times. */
    pool?: Pick<PoolOptions, "idleMs" | "startupMs">;
}

export class BrowserSession implements PoolClient {
    private pool?: BrowserPool;
    private tabs = new Map<number, Page>();
    private ids = new WeakMap<Page, number>();
    /** The person's input, per tab (input-queue.ts). */
    private inputs = new WeakMap<Page, InputQueue>();
    private seq = 0;
    private feed = new FrameFeed<TabFrame>();
    private listeners = new Set<() => void>();
    private announcing?: ReturnType<typeof setTimeout>;
    /** The pane's size while a window watches: tabs follow it. */
    private view?: Viewport;
    private streaming: Promise<void> = Promise.resolve();
    private crashed = false;
    /** Tabs being opened (a slot each until they are tabs). */
    private opening = 0;
    /** Calls in progress (run). */
    private calls = 0;
    /** Why the tabs are gone, told with the next call that asks for one. */
    private lostNote?: string;
    disposed = false;
    /** The current tab. */
    active?: number;

    constructor(private o: SessionOptions) {}

    get root(): string {
        return this.o.root;
    }

    // -----------------------------------------------------------------------
    // What the window shows

    state(): BrowserState {
        const tabs = this.tabInfo();
        if (this.pool?.running || this.pool?.launching) return { status: this.pool.running ? "ready" : "starting", tabs, active: this.active };
        if (this.crashed) return { status: "crashed", error: "The browser stopped unexpectedly. Open a page to start it again.", tabs, active: this.active };
        const s = browserSettings(this.o.settings());
        if (!s.enabled) return { status: "unavailable", error: TURNED_OFF, tabs, active: this.active };
        const found = cachedChrome(s.executable);
        return found.ok ? { status: "idle", tabs, active: this.active } : { status: "unavailable", error: found.error, tabs, active: this.active };
    }

    private tabInfo(): BrowserTabInfo[] {
        return [...this.tabs].map(([id, p]) => ({
            id,
            title: p.title,
            url: p.url,
            loading: p.loading,
            owner: p.control.owner,
            canGoBack: p.canGoBack,
            canGoForward: p.canGoForward,
            crashed: p.crashed,
            ...(p.dialog ? { dialog: p.dialog } : {}),
        }));
    }

    /** Calls `fn` after the browser's tabs or state change (soon, and once for a burst). Returns how to stop. */
    onChange(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    private announce() {
        if (this.announcing || this.disposed) return;
        this.announcing = setTimeout(() => {
            this.announcing = undefined;
            for (const fn of [...this.listeners]) {
                try {
                    fn();
                } catch (e) {
                    console.error(e);
                }
            }
        }, ANNOUNCE_MS);
        this.announcing.unref?.();
    }

    /** A window starts (or resizes) watching the current tab: `send` gets its frames, one at a time as it acks them. */
    watch(key: object, send: (frame: TabFrame, frameId: string) => void, size: { width: number; height: number; scale: number }) {
        this.feed.add(key, send);
        this.resize(size);
    }

    /** The pane's size changed (CSS pixels, and device pixels per CSS pixel). */
    resize(size: { width: number; height: number; scale: number }) {
        const clamp = (n: number) => Math.round(Math.min(Math.max(Number.isFinite(n) ? n : MIN_SIDE, MIN_SIDE), MAX_SIDE));
        this.view = { width: clamp(size.width), height: clamp(size.height), scale: Math.min(Math.max(Number.isFinite(size.scale) ? size.scale : 1, 1), 3) };
        this.syncStream(true);
        this.pool?.touch();
    }

    unwatch(key: object) {
        this.feed.remove(key);
        if (!this.feed.size) this.view = undefined;
        this.syncStream(true);
    }

    ack(key: object, frameId: string) {
        this.feed.ack(key, frameId);
    }

    watching(): boolean {
        return this.feed.size > 0;
    }

    busy(): boolean {
        return this.calls > 0;
    }

    /**
     * Streams the current tab while a window watches, sized to its pane; every other tab, and all of them when nobody
     * watches, go back to the agent's size. One change at a time.
     */
    private syncStream(restart: boolean) {
        this.streaming = this.streaming.then(async () => {
            const want = this.view && !this.disposed ? this.tabs.get(this.active ?? -1) : undefined;
            for (const p of this.tabs.values()) {
                if (p === want) continue;
                try {
                    if (p.screencasting) await p.stopScreencast();
                    const v = p.viewport;
                    if (v.width !== AGENT_VIEWPORT.width || v.height !== AGENT_VIEWPORT.height || v.scale !== AGENT_VIEWPORT.scale) await p.setViewport(AGENT_VIEWPORT);
                } catch {
                    // the tab closed meanwhile
                }
            }
            if (!want) return;
            try {
                const v = this.view!;
                if (restart || !want.screencasting) {
                    this.feed.clearWaiting();
                    // Asked again with other limits it goes on with the old ones: it is started over.
                    await want.stopScreencast();
                    await want.setViewport(v);
                    await want.startScreencast(v.width * v.scale, v.height * v.scale);
                }
            } catch {
                // the tab closed meanwhile
            }
        });
    }

    // -----------------------------------------------------------------------
    // PoolClient

    get hooks(): PageHooks {
        return {
            changed: () => this.announce(),
            frame: (page, frame) => {
                const id = this.ids.get(page);
                if (id !== undefined && id === this.active) this.feed.push({ ...frame, tab: id });
            },
        };
    }

    viewport(): Viewport {
        return this.view ?? AGENT_VIEWPORT;
    }

    refuse(url: string, approvedFile?: string): string | undefined {
        return this.o.refuse?.(url, approvedFile);
    }

    /** A page a tab opened is a tab of the session; the current one stays where it is (the agent's next call is about the page it was on). */
    adopt(page: Page, opener: Page): boolean {
        // Past the limit it is closed: popups are no way round it.
        if (this.tabs.size + this.opening >= MAX_TABS) {
            opener.console.add("error", `A page this one opened was closed: this session already has ${MAX_TABS} tabs.`);
            void this.pool?.closePage(page);
            return false;
        }
        this.add(page);
        // The new page opened in front of the one the agent is working in.
        const current = this.tabs.get(this.active ?? -1);
        if (current) void this.pool?.activate(current);
        return true;
    }

    closed(page: Page) {
        const id = this.ids.get(page);
        if (id !== undefined) this.forget(id);
    }

    lost(crashed: boolean) {
        for (const p of this.tabs.values()) p.dispose();
        this.tabs.clear();
        this.active = undefined;
        this.crashed = crashed;
        this.lostNote = crashed ? "The browser stopped unexpectedly, so its tabs are gone." : "The browser was closed after sitting idle, so its tabs are gone.";
        this.announce();
    }

    // -----------------------------------------------------------------------
    // Tabs

    private add(page: Page): number {
        const id = ++this.seq;
        this.tabs.set(id, page);
        this.ids.set(page, id);
        this.announce();
        return id;
    }

    private forget(id: number) {
        if (!this.tabs.delete(id)) return;
        if (this.active === id) this.setActive([...this.tabs.keys()].at(-1));
        this.announce();
    }

    private setActive(id: number | undefined) {
        this.active = id;
        const page = this.tabs.get(id ?? -1);
        if (page) void this.pool?.activate(page);
        this.syncStream(false);
        this.announce();
    }

    /** The tab `id`, or the current one; opens one if there is none (unless the browser just went away: `open` says to start it again). */
    async page(id?: number, o: { open?: boolean } = {}): Promise<Page> {
        if (this.disposed) throw new BrowserError("This session's browser was closed.");
        if (id !== undefined) {
            const page = this.tabs.get(id);
            if (!page) throw this.noTab(id);
            this.pool?.touch();
            return page;
        }
        const current = this.active !== undefined ? this.tabs.get(this.active) : undefined;
        if (current) {
            this.pool?.touch();
            return current;
        }
        if (this.lostNote && !o.open) throw new BrowserError(`${this.lostNote} Open a page again (BrowserNavigate) to start a new browser.`);
        return this.openTab("agent");
    }

    /** A new blank tab, which becomes the current one. */
    async openTab(owner: Owner = "agent"): Promise<Page> {
        if (this.disposed) throw new BrowserError("This session's browser was closed.");
        if (!browserSettings(this.o.settings()).enabled) throw new BrowserError(TURNED_OFF);
        if (this.tabs.size + this.opening >= MAX_TABS) throw new BrowserError(`This session already has ${MAX_TABS} tabs open. Close one first (BrowserNavigate action=close_tab). ${this.tabsText()}`);
        const pool = (this.pool ??= acquirePool({ root: this.o.root, settings: this.o.settings, ...this.o.pool }, this));
        this.crashed = false;
        this.announce();
        let page: Page;
        this.opening++;
        try {
            page = await pool.openPage(this, owner);
        } catch (e) {
            this.announce();
            throw lostBrowser(e) ?? e;
        } finally {
            this.opening--;
        }
        this.lostNote = undefined;
        if (this.disposed) {
            await pool.closePage(page);
            throw new BrowserError("This session's browser was closed.");
        }
        this.setActive(this.add(page));
        return page;
    }

    async switchTab(id: number) {
        if (!this.tabs.has(id)) throw this.noTab(id);
        this.setActive(id);
        this.pool?.touch();
    }

    async closeTab(id: number) {
        const page = this.tabs.get(id);
        if (!page) throw this.noTab(id);
        this.forget(id);
        await this.pool?.closePage(page);
    }

    /** A tab that isn't there: gone with the browser, or never was. */
    private noTab(id: number): BrowserError {
        return new BrowserError(`${this.lostNote ?? `There is no tab ${id}.`} ${this.tabsText()}`.trim());
    }

    /** The id of a tab, for messages. */
    idOf(page: Page): number | undefined {
        return this.ids.get(page);
    }

    /** The tabs as the agent reads them. */
    tabsText(): string {
        if (!this.tabs.size) return "No tabs are open.";
        return `Tabs:\n${[...this.tabs].map(([id, p]) => `  [${id}] ${p.title ? `${JSON.stringify(p.title)} ` : ""}${p.url || "about:blank"}${id === this.active ? " (current)" : ""}${p.control.owner === "human" ? " (the user has control)" : ""}`).join("\n")}`;
    }

    get tabCount(): number {
        return this.tabs.size;
    }

    /** A browser call that failed because the browser went away says so in words the agent can act on. */
    async run<T>(fn: () => Promise<T>): Promise<T> {
        this.calls++;
        try {
            return await fn();
        } catch (e) {
            throw lostBrowser(e) ?? e;
        } finally {
            this.calls--;
            this.pool?.touch();
        }
    }

    /** The agent is about to change a tab (not just read it): refused while a person has it. */
    agentAct(page: Page) {
        const was = page.control.owner;
        const g = page.control.agentAct();
        if (!g.ok) throw new BrowserError(g.error);
        if (was !== page.control.owner) this.announce();
    }

    // -----------------------------------------------------------------------
    // A person at the pane

    private tab(id: number | undefined): Page {
        const page = this.tabs.get(id ?? this.active ?? -1);
        if (!page) throw new BrowserError("That tab isn't open.");
        return page;
    }

    /** The person took the tab: the agent's refs no longer mean anything, and it must wait to be handed it back. */
    private taken(page: Page) {
        if (!page.control.humanInput()) return;
        page.refs.invalidate();
        page.lastOutline = undefined;
        this.announce();
    }

    /** What the person did in the pane (checked here: it comes off the wire). */
    async input(raw: unknown, tab?: number): Promise<void> {
        const input = parseInput(raw);
        const page = this.tabs.get(tab ?? this.active ?? -1);
        if (!input || !page || page.closed) return;
        if ((input.kind === "key" || input.kind === "mouse") && input.type === "up" && page.control.owner !== "human") return;
        if (takesControl(input)) this.taken(page);
        this.pool?.touch();
        let queue = this.inputs.get(page);
        if (!queue) this.inputs.set(page, (queue = new InputQueue((i) => forward(page, i))));
        await queue.push(input);
    }

    /** What the pane's address bar and tab strip ask for. Opening or navigating a page is the person acting: the tab is theirs. */
    async command(c: { command: string; url?: string; tab?: number }): Promise<void> {
        switch (c.command) {
            case "new_tab": {
                const page = await this.openTab("human");
                if (c.url) await this.humanGoto(page, c.url);
                return;
            }
            case "switch_tab":
                return this.switchTab(Number(c.tab));
            case "close_tab":
                return this.closeTab(Number(c.tab));
            case "goto": {
                const page = this.tabs.get(c.tab ?? this.active ?? -1) ?? (await this.openTab("human"));
                return this.humanGoto(page, c.url ?? "");
            }
            case "back":
            case "forward":
            case "reload": {
                const page = this.tab(c.tab);
                this.taken(page);
                await this.run(() => (c.command === "reload" ? page.reload() : page.go(c.command === "back" ? -1 : 1)));
                return;
            }
            default:
                throw new BrowserError(`Unknown browser command ${JSON.stringify(c.command)}.`);
        }
    }

    private async humanGoto(page: Page, text: string) {
        const url = addressToUrl(text);
        if (!url) throw new BrowserError(`"${redact(text).slice(0, 100)}" isn't an address. Type a URL like localhost:3000 or https://example.com.`);
        const checked = checkUrl(url, this.o.root);
        if (!checked.ok) throw new BrowserError(checked.error);
        const refused = this.refuse(checked.url);
        if (refused) throw new BrowserError(`${redact(checked.url).slice(0, 100)} can't be opened: ${refused}`);
        this.taken(page);
        await this.run(() => page.goto(checked.url));
    }

    /** The person gives the tab back to the agent. */
    handBack(tab?: number) {
        const page = this.tab(tab);
        if (page.control.handBack()) this.announce();
    }

    async answerDialog(accept: boolean, promptText?: string, tab?: number) {
        const page = this.tab(tab);
        this.taken(page);
        await page.answerDialog(accept, promptText);
    }

    // -----------------------------------------------------------------------

    /** The session is over: its tabs close, and with the last session of the project, the browser. */
    async dispose() {
        if (this.disposed) return;
        this.disposed = true;
        clearTimeout(this.announcing);
        this.listeners.clear();
        this.feed = new FrameFeed();
        this.view = undefined;
        await this.streaming.catch(() => undefined);
        for (const p of this.tabs.values()) p.dispose();
        this.tabs.clear();
        const pool = this.pool;
        this.pool = undefined;
        if (pool) await releasePool(pool, this);
    }
}
