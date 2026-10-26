// The agent's browser, hosted by this app: each tab is a <webview> in the GUI's page (gui/src/components/
// BrowserHostLayer.tsx), a real Chromium page in the window. The Browser pane lays the current tab over its page box,
// so the person uses the page itself; the agent drives the same tabs. The server's pool opens a channel per project on /browser-host (src/browser/host.ts) and
// speaks the DevTools protocol on it, as it would to a Chrome it started:
//   - a tab's own commands go to its webContents.debugger, and its events come back tagged with its session;
//   - the few browser-wide ones the pool uses are answered here: making a tab (Target.createTarget), closing and
//     fronting one, the browser's version, and what the pool turns on (auto-attach, discovery, downloads);
//   - Harness.viewSize tells a page its real size and scale (it is never emulated), Harness.humanInput that the person
//     used it directly (the tab becomes theirs, as a click in the streamed pane makes it).
// No DevTools port is opened: only the server, with its token, reaches these pages.
//
// A tab nobody can see and nobody has used for a while is frozen: its timers, animations and scripts stop (it costs no
// CPU) and it's told to give back what memory it can. Any command for it, or a pane showing it, wakes it first, so the
// agent never finds it different. Not one still loading, nor one playing sound.

import { app, session, type BrowserWindow, type Session, type WebContents } from "electron";
import { createHash } from "node:crypto";
import { sendToTab } from "./guest-input";

interface Tab {
    targetId: string;
    sid: string;
    /** The GUI's name for its webview. */
    key: string;
    wc: WebContents;
    channel: Channel;
    openerId?: string;
    /** Where it goes once the server has set it up (a page a tab opened). */
    pendingUrl?: string;
    /** Input commands from the agent in flight: input the view sees meanwhile is theirs, not the person's. */
    agentInputs: number;
    closed: boolean;
    /** When the agent, the person or a pane last used it (ms since the epoch). */
    usedAt: number;
    frozen: boolean;
    /** Chromium refused to freeze it once: it isn't tried again. */
    unfreezable?: boolean;
}

interface Channel {
    id: string;
    partition: string;
    session: Session;
    tabs: Map<string, Tab>;
}

/** Webviews the GUI is making: will-attach-webview names them (by src), did-attach-webview hands over their page. */
const WEBVIEW_SRC = /^about:blank#(tab-\d+)$/;
const PERSON_INPUT = new Set(["mouseDown", "keyDown", "mouseWheel"]);
/** A tab unseen and unused this long sleeps (checks may shorten it with HARNESS_ELECTRON_FREEZE_MS). */
const FREEZE_AFTER_MS = Number(process.env.HARNESS_ELECTRON_FREEZE_MS ?? 30_000);
/** An asleep tab's page process using more CPU than this (%, over the last 5s) is put back to sleep. */
const BUSY_ASLEEP_PERCENT = 1;
/** How long Chromium takes to take in a webview's visibility changing (a frame or two, with room). */
const VISIBILITY_MS = 100;

export class BrowserHost {
    private ws?: WebSocket;
    private channels = new Map<string, Channel>();
    private tabsBySid = new Map<string, Tab>();
    private tabsById = new Map<string, Tab>();
    private tabsByKey = new Map<string, Tab>();
    private seq = 0;
    private attaching: string[] = [];
    private attachWaiters = new Map<string, (wc: WebContents) => void>();
    private closing = false;
    /** The tabs a pane or the floating view shows (by the GUI's keys): never frozen. */
    private onScreen = new Set<string>();
    readonly stats = { frozen: 0, woken: 0, refused: 0, resleeps: 0, hideSent: 0, showSent: 0, lastShown: [] as string[] };

    constructor(private window: () => BrowserWindow | undefined) {
        setInterval(() => this.freezeIdle(), 5000).unref();
    }

    /** The server is up: be its browser (again, after a restart). */
    connect(info: { port: number; token: string }) {
        this.dropAll();
        this.ws?.close();
        const ws = new WebSocket(`ws://127.0.0.1:${info.port}/browser-host`, ["harness.v1", `auth.${info.token}`]);
        this.ws = ws;
        ws.onopen = () => console.error("[harness] browser host connected");
        ws.onmessage = (e) => this.receive(String(e.data));
        ws.onclose = () => {
            if (this.ws === ws) this.ws = undefined;
            this.dropAll();
        };
    }

    close() {
        this.closing = true;
        this.dropAll();
        this.ws?.close();
    }

    /** The window closed: its views went with it. */
    windowGone() {
        this.dropAll();
    }

    // -----------------------------------------------------------------------
    // The GUI's webviews

    /** The GUI's page: only webviews for our tabs, locked down (no preload, no Node), each with a page process of its own. */
    watch(gui: WebContents) {
        gui.on("will-attach-webview", (e, prefs, params) => {
            const key = WEBVIEW_SRC.exec(params.src ?? "")?.[1];
            const partition = params.partition ?? "";
            if (!key || !this.attachWaiters.has(key) || ![...this.channels.values()].some((c) => c.partition === partition)) {
                e.preventDefault();
                return;
            }
            delete prefs.preload;
            prefs.nodeIntegration = false;
            prefs.nodeIntegrationInSubFrames = false;
            prefs.contextIsolation = true;
            prefs.sandbox = true;
            prefs.webSecurity = true;
            prefs.backgroundThrottling = false;
            prefs.spellcheck = false;
            this.attaching.push(key);
        });
        gui.on("did-attach-webview", (_e, wc) => {
            const key = this.attaching.shift();
            const done = key ? this.attachWaiters.get(key) : undefined;
            if (key) this.attachWaiters.delete(key);
            if (done) done(wc);
            else wc.close();
        });
    }

    /** The GUI shows these tabs now (a pane, the floating view): they're woken, and kept awake. */
    shown(keys: string[]) {
        this.onScreen = new Set(keys);
        this.stats.lastShown = keys;
        for (const key of keys) {
            const tab = this.tabsByKey.get(key);
            if (tab) void this.wake(tab);
        }
    }

    private freezeIdle() {
        const now = Date.now();
        // CPU of each page process since the last look (percentCPUUsage is since the previous getAppMetrics).
        const cpu = new Map(app.getAppMetrics().map((m) => [m.pid, m.cpu.percentCPUUsage]));
        for (const tab of this.tabsById.values()) {
            if (this.onScreen.has(tab.key)) tab.usedAt = now;
            else if (!tab.frozen && !tab.closed && !tab.unfreezable && now - tab.usedAt >= FREEZE_AFTER_MS && !tab.wc.isLoading() && !tab.wc.isCurrentlyAudible()) void this.freeze(tab);
            // Asleep, but its page is busy again (Chromium drawing it once more): put it back to sleep.
            else if (tab.frozen && !tab.closed && (cpu.get(tab.wc.getOSProcessId()) ?? 0) > BUSY_ASLEEP_PERCENT) void this.resleep(tab);
        }
    }

    private async resleep(tab: Tab) {
        this.stats.resleeps++;
        this.toGui({ type: "sleep", key: tab.key, asleep: false });
        await new Promise((r) => setTimeout(r, VISIBILITY_MS));
        if (!tab.frozen || tab.closed) return;
        this.toGui({ type: "sleep", key: tab.key, asleep: true });
        await new Promise((r) => setTimeout(r, VISIBILITY_MS));
        await tab.wc.debugger.sendCommand("Page.setWebLifecycleState", { state: "frozen" }).catch(() => undefined);
    }

    /**
     * Asleep: the GUI hides its webview, so Chromium treats it as a background tab (stops drawing it, throttles its timers;
     * Page.setWebLifecycleState alone leaves a page it thinks is visible running), then freezes it, then asks it to give
     * back memory. Measured on a busy page: CPU 1.8% to 0.1%, GPU 1.6% to 0.1%, memory 171 to 114 MB.
     */
    private async freeze(tab: Tab) {
        tab.frozen = true;
        try {
            this.toGui({ type: "sleep", key: tab.key, asleep: true });
            this.stats.hideSent++;
            await new Promise((r) => setTimeout(r, VISIBILITY_MS));
            if (!tab.frozen || tab.closed) return;
            await tab.wc.debugger.sendCommand("Page.setWebLifecycleState", { state: "frozen" });
            await tab.wc.debugger.sendCommand("Memory.simulatePressureNotification", { level: "critical" }).catch(() => undefined);
            this.stats.frozen++;
        } catch (e) {
            tab.frozen = false;
            tab.unfreezable = true;
            this.toGui({ type: "sleep", key: tab.key, asleep: false });
            this.stats.refused++;
            console.error(`[harness] couldn't freeze a tab: ${(e as Error).message}`);
        }
    }

    /** Running and drawn again before anything reaches it. */
    private async wake(tab: Tab) {
        tab.usedAt = Date.now();
        if (!tab.frozen || tab.closed) return;
        tab.frozen = false;
        this.toGui({ type: "sleep", key: tab.key, asleep: false });
        this.stats.showSent++;
        await tab.wc.debugger.sendCommand("Page.setWebLifecycleState", { state: "active" }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, VISIBILITY_MS));
        this.stats.woken++;
    }

    /** The tabs' page processes (metrics.ts). */
    pids(): number[] {
        return [...this.tabsById.values()].filter((t) => !t.wc.isDestroyed()).map((t) => t.wc.getOSProcessId());
    }

    /** The GUI laid a tab's webview out at this size: its page's real viewport. */
    sized(key: string, size: { width: number; height: number; scale: number }) {
        const tab = this.tabsByKey.get(key);
        if (tab && !tab.closed) this.event(tab.channel, "Harness.viewSize", size, tab.sid);
    }

    private toGui(msg: unknown) {
        const win = this.window();
        if (win && !win.webContents.isDestroyed()) win.webContents.send("browser", msg);
    }

    // -----------------------------------------------------------------------
    // The server's side

    private write(msg: unknown) {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    }

    private event(channel: Channel, method: string, params: unknown, sessionId?: string) {
        this.write({ channel: channel.id, data: JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }) });
    }

    private answer(channel: Channel, id: number, result: unknown) {
        this.write({ channel: channel.id, data: JSON.stringify({ id, result }) });
    }

    private fail(channel: Channel, id: number, message: string) {
        this.write({ channel: channel.id, data: JSON.stringify({ id, error: { code: -32000, message } }) });
    }

    private receive(raw: string) {
        let msg: { channel?: string; open?: { profile?: string }; data?: string; close?: boolean };
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }
        if (typeof msg.channel !== "string") return;
        if (msg.open) return this.openChannel(msg.channel, String(msg.open.profile ?? "default"));
        const channel = this.channels.get(msg.channel);
        if (!channel) return;
        if (msg.close) return this.closeChannel(channel, false);
        if (typeof msg.data !== "string") return;
        let cmd: { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
        try {
            cmd = JSON.parse(msg.data);
        } catch {
            return;
        }
        if (typeof cmd.id !== "number" || typeof cmd.method !== "string") return;
        void this.command(channel, cmd).catch((e) => this.fail(channel, cmd.id, (e as Error).message ?? String(e)));
    }

    /** A project's browser: its own cookies and storage, kept between runs (the profile names them). */
    private openChannel(id: string, profile: string) {
        const partition = `persist:browser-${createHash("sha256").update(profile).digest("hex").slice(0, 16)}`;
        const ses = session.fromPartition(partition);
        // As Chrome, not as this app: no Electron or app name for sites to refuse.
        ses.setUserAgent(app.userAgentFallback.replace(/ Electron\/\S+/, "").replace(new RegExp(` ${app.getName()}/\\S+`, "i"), "").replace(/ harness-desktop-electron\/\S+/i, ""));
        // A page can't put files on the disk: refused, and told to the tab it came from (as Browser.setDownloadBehavior deny).
        ses.on("will-download", (e, item, wc) => {
            e.preventDefault();
            const tab = this.tabOf(wc);
            if (tab) this.event(tab.channel, "Browser.downloadWillBegin", { frameId: tab.targetId, url: item.getURL(), suggestedFilename: item.getFilename() });
        });
        // No camera, microphone, location or notifications for pages; full screen stays in the view.
        ses.setPermissionRequestHandler((_wc, permission, done) => done(permission === "fullscreen" || permission === "clipboard-sanitized-write"));
        this.channels.set(id, { id, partition, session: ses, tabs: new Map() });
    }

    private closeChannel(channel: Channel, tell: boolean) {
        for (const tab of [...channel.tabs.values()]) this.closeTab(tab, false);
        this.channels.delete(channel.id);
        if (tell) this.write({ channel: channel.id, closed: true });
    }

    private dropAll() {
        for (const channel of [...this.channels.values()]) this.closeChannel(channel, !this.closing);
    }

    private async command(channel: Channel, cmd: { id: number; method: string; params?: Record<string, unknown>; sessionId?: string }) {
        const p = cmd.params ?? {};
        if (cmd.sessionId) {
            const tab = this.tabsBySid.get(cmd.sessionId);
            if (!tab || tab.channel !== channel || tab.closed) return this.fail(channel, cmd.id, "No such tab");
            if (cmd.method === "Runtime.runIfWaitingForDebugger") {
                // Set up by the server: a page a tab opened goes where it was asked to now.
                const url = tab.pendingUrl;
                tab.pendingUrl = undefined;
                if (url) void tab.wc.loadURL(url).catch(() => undefined);
                return this.answer(channel, cmd.id, {});
            }
            await this.wake(tab);
            const input = cmd.method.startsWith("Input.");
            if (input) tab.agentInputs++;
            try {
                // Never through the window's focus into the UI (guest-input.ts).
                const result = await sendToTab(tab.wc, cmd.method, p);
                return this.answer(channel, cmd.id, result ?? {});
            } finally {
                if (input) tab.agentInputs--;
            }
        }
        switch (cmd.method) {
            case "Target.setAutoAttach":
            case "Target.setDiscoverTargets":
            case "Browser.setDownloadBehavior":
            case "Target.activateTarget":
                return this.answer(channel, cmd.id, {});
            case "Browser.getVersion":
                return this.answer(channel, cmd.id, { protocolVersion: "1.3", product: `Chrome/${process.versions.chrome}`, userAgent: channel.session.getUserAgent() });
            case "Target.createTarget": {
                const tab = await this.openTab(channel);
                if (typeof p.url === "string" && p.url !== "about:blank") tab.pendingUrl = p.url;
                return this.answer(channel, cmd.id, { targetId: tab.targetId });
            }
            case "Target.closeTarget": {
                const tab = this.tabsById.get(String(p.targetId));
                if (tab && tab.channel === channel) this.closeTab(tab, true);
                return this.answer(channel, cmd.id, { success: tab !== undefined });
            }
            default:
                return this.fail(channel, cmd.id, `${cmd.method} isn't supported by the desktop app's browser`);
        }
    }

    // -----------------------------------------------------------------------
    // Tabs

    private tabOf(wc: WebContents | null | undefined): Tab | undefined {
        if (!wc) return;
        for (const tab of this.tabsById.values()) if (tab.wc === wc) return tab;
    }

    private async openTab(channel: Channel, openerId?: string): Promise<Tab> {
        if (!this.window()) throw new Error("The app's window is closed");
        const key = `tab-${++this.seq}`;
        const wc = await new Promise<WebContents>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.attachWaiters.delete(key);
                reject(new Error("The window didn't make the tab"));
            }, 10_000);
            this.attachWaiters.set(key, (w) => {
                clearTimeout(timer);
                resolve(w);
            });
            this.toGui({ type: "create", key, partition: channel.partition });
        });
        // A page process to talk to, as a new Chrome tab has: commands the pool sends while setting it up need one.
        if (wc.isLoading()) await new Promise<void>((r) => wc.once("did-stop-loading", () => r()));
        wc.debugger.attach("1.3");
        const { targetInfo } = (await wc.debugger.sendCommand("Target.getTargetInfo")) as { targetInfo: { targetId: string } };
        const tab: Tab = { targetId: targetInfo.targetId, sid: `desktop-${this.seq}`, key, wc, channel, openerId, agentInputs: 0, closed: false, usedAt: Date.now(), frozen: false };
        channel.tabs.set(tab.targetId, tab);
        this.tabsById.set(tab.targetId, tab);
        this.tabsBySid.set(tab.sid, tab);
        this.tabsByKey.set(key, tab);

        wc.debugger.on("message", (_e, method, params, childSession) => {
            // The page's own events; frames and workers it attached aren't the pool's.
            if (!childSession) this.event(channel, method, params, tab.sid);
        });
        wc.debugger.on("detach", () => this.closeTab(tab, true));
        wc.once("destroyed", () => this.closeTab(tab, true));
        const changed = () => {
            if (!tab.closed) this.event(channel, "Target.targetInfoChanged", { targetInfo: { targetId: tab.targetId, type: "page", title: wc.getTitle(), url: wc.getURL(), attached: true } });
        };
        wc.on("page-title-updated", changed);
        wc.on("did-navigate", changed);
        wc.on("did-navigate-in-page", changed);
        // A page opening another opens a tab of the same session, as in Chrome (the pool adopts it by its opener).
        wc.setWindowOpenHandler(({ url }) => {
            void this.openTab(channel, tab.targetId).then((child) => {
                child.pendingUrl = url;
                this.announce(child);
            });
            return { action: "deny" };
        });
        // The person using the page directly: the tab is theirs. Input the agent sent meanwhile isn't theirs.
        const person = (type: string) => {
            if (tab.agentInputs > 0 || !PERSON_INPUT.has(type)) return;
            tab.usedAt = Date.now();
            this.event(channel, "Harness.humanInput", { type }, tab.sid);
        };
        wc.on("before-input-event", (_e, input) => person(input.type));
        wc.on("before-mouse-event", (_e, mouse) => person(mouse.type));
        wc.on("render-process-gone", () => this.event(channel, "Inspector.targetCrashed", {}, tab.sid));
        this.toGui({ type: "ready", key, targetId: tab.targetId });
        if (!openerId) this.announce(tab);
        return tab;
    }

    /** Tells the pool about a tab, waiting for it to be set up, as Chrome's auto-attach does. */
    private announce(tab: Tab) {
        this.event(tab.channel, "Target.attachedToTarget", {
            sessionId: tab.sid,
            targetInfo: { targetId: tab.targetId, type: "page", title: "", url: "about:blank", attached: true, ...(tab.openerId ? { openerId: tab.openerId } : {}) },
            waitingForDebugger: true,
        });
    }

    private closeTab(tab: Tab, tell: boolean) {
        if (tab.closed) return;
        tab.closed = true;
        tab.channel.tabs.delete(tab.targetId);
        this.tabsById.delete(tab.targetId);
        this.tabsBySid.delete(tab.sid);
        this.tabsByKey.delete(tab.key);
        try {
            if (!tab.wc.isDestroyed() && tab.wc.debugger.isAttached()) tab.wc.debugger.detach();
        } catch {
            // already gone
        }
        // The GUI drops the webview, and its page with it.
        this.toGui({ type: "destroy", key: tab.key });
        if (tell) {
            this.event(tab.channel, "Target.detachedFromTarget", { sessionId: tab.sid, targetId: tab.targetId });
            this.event(tab.channel, "Target.targetDestroyed", { targetId: tab.targetId });
        }
    }
}
