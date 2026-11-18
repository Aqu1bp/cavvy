// A screenshot of a page the Browser pane draws smaller than its size (a device's size scaled to fit, the floating
// view): Chromium draws such a page only as finely as it's shown, so the screenshot was that small picture enlarged.
// The app has the window draw it at its own scale for the screenshot, under a still of how it looked
// (desktop-electron/src/browser-host.ts sharpFor, gui/src/components/BrowserHostLayer.tsx). Electron is stood in for.
import { afterEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";

mock.module("electron", () => ({
    BrowserWindow: class {},
    nativeTheme: { shouldUseDarkColors: false },
    screen: {},
    app: { getAppMetrics: () => [], userAgentFallback: "Chrome/140", getName: () => "Cavvy" },
    session: { fromPartition: () => ({ setUserAgent() {}, getUserAgent: () => "Chrome/140", on() {}, setPermissionRequestHandler() {} }) },
}));
const { BrowserHost } = await import("../desktop-electron/src/browser-host");

/** What happened, in order: what the window was told ("sharp on"/"sharp off") and what reached the page. */
type Log = string[];

class Page extends EventEmitter {
    readonly mainFrame = { name: "page" };
    focusedFrame: { name: string } | null = null;
    constructor(
        readonly targetId: string,
        readonly log: Log,
    ) {
        super();
    }
    readonly debugger = {
        attach() {},
        detach() {},
        isAttached: () => true,
        on() {},
        sendCommand: async (method: string) => {
            if (method === "Target.getTargetInfo") return { targetInfo: { targetId: this.targetId } };
            if (method === "Page.captureScreenshot") this.log.push("capture");
            return {};
        },
    };
    isLoading = () => false;
    isDestroyed = () => false;
    isCurrentlyAudible = () => false;
    getOSProcessId = () => 1;
    getTitle = () => "";
    getURL = () => "";
    setWindowOpenHandler() {}
    sendInputEvent() {}
}

let hosts: any[] = [];
afterEach(() => {
    for (const h of hosts) h.close();
    hosts = [];
});

/** `answer`: the window says the page is drawn at its own scale (the GUI's part), at once. */
async function app(o: { answer: boolean; visible?: boolean }) {
    const log: Log = [];
    const gui = new EventEmitter();
    const pages: Page[] = [];
    let host: any;
    const win = {
        isDestroyed: () => false,
        isVisible: () => o.visible ?? true,
        isMinimized: () => false,
        webContents: {
            isDestroyed: () => false,
            sendInputEvent() {},
            send: (_channel: string, msg: { type: string; key: string; partition: string; id?: number; on?: boolean }) => {
                if (msg.type === "sharp") {
                    log.push(`sharp ${msg.on ? "on" : "off"}`);
                    if (msg.on && o.answer) queueMicrotask(() => host.sharpened(msg.id));
                }
                if (msg.type !== "create") return;
                const page = new Page(`T${pages.length + 1}`, log);
                pages.push(page);
                gui.emit("will-attach-webview", { preventDefault() {} }, {}, { src: `about:blank#${msg.key}`, partition: msg.partition });
                gui.emit("did-attach-webview", {}, page);
            },
        },
    };
    host = new BrowserHost(() => win as any) as any;
    hosts.push(host);
    host.watch(gui);
    host.receive(JSON.stringify({ channel: "c", open: { profile: "p" } }));
    await host.command(host.channels.get("c"), { id: 1, method: "Target.createTarget", params: { url: "about:blank" } });
    const tab = host.tabsByKey.get("tab-1");
    const shoot = () => host.command(host.channels.get("c"), { id: 2, method: "Page.captureScreenshot", params: { format: "png" }, sessionId: tab.sid });
    return { host, log, shoot };
}

test("a page drawn smaller than its size is drawn at its own scale for its screenshot, and put back after", async () => {
    const a = await app({ answer: true });
    a.host.drawnSmall("tab-1", true);
    await a.shoot();
    expect(a.log).toEqual(["sharp on", "capture", "sharp off"]);
});

test("a page drawn at its size, or in a window out of sight, is taken as it is", async () => {
    const a = await app({ answer: true });
    await a.shoot();
    a.host.drawnSmall("tab-1", true);
    a.host.drawnSmall("tab-1", false);
    await a.shoot();
    expect(a.log).toEqual(["capture", "capture"]);
    const b = await app({ answer: true, visible: false });
    b.host.drawnSmall("tab-1", true);
    await b.shoot();
    expect(b.log).toEqual(["capture"]);
});

test("the GUI and the app agree on the messages", () => {
    const layer = readFileSync(join(import.meta.dir, "../gui/src/components/BrowserHostLayer.tsx"), "utf8");
    const main = readFileSync(join(import.meta.dir, "../desktop-electron/src/main.ts"), "utf8");
    const preload = readFileSync(join(import.meta.dir, "../desktop-electron/src/preload.ts"), "utf8");
    // The page is drawn at its own scale only under a still, so the pane looks the same meanwhile.
    expect(layer).toContain("electron!.browserStill?.(");
    expect(layer.indexOf("wrap.appendChild(img)")).toBeLessThan(layer.indexOf("setSharp(true)"));
    expect(layer).toContain('transform: scale === 1 || sharp() ? "" : `scale(${scale})`');
    expect(layer).toContain("electron!.browserSmall?.(p.tab.key, small)");
    for (const channel of ["browser_small", "browser_sharp", "browser_still"]) {
        expect(main).toContain(`"${channel}"`);
        expect(preload).toContain(`"${channel}"`);
    }
});
