// A press of the person's in a Browser page that leaves it without the keyboard (desktop-electron/src/browser-host.ts):
// a page navigated while their focus was in a frame of it, and the window's elsewhere, takes none on a press, and their
// keys went nowhere (136 of 136, measured on macOS). The app tells the window, which focuses the page again
// (gui/src/lib/page-focus.ts). Electron itself is stood in for: pages whose press gives them the keyboard, or not.
import { afterEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

mock.module("electron", () => ({
    app: { getAppMetrics: () => [], userAgentFallback: "Chrome/140", getName: () => "Cavvy" },
    session: { fromPartition: () => ({ setUserAgent() {}, getUserAgent: () => "Chrome/140", on() {}, setPermissionRequestHandler() {} }) },
}));
const { BrowserHost } = await import("../desktop-electron/src/browser-host");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tab's page. `stuck`: a press gives it no keyboard. */
class Page extends EventEmitter {
    readonly mainFrame = { name: "page" };
    focusedFrame: { name: string } | null = null;
    stuck = false;
    constructor(readonly targetId: string) {
        super();
    }
    readonly debugger = {
        attach() {},
        detach() {},
        isAttached: () => true,
        on() {},
        sendCommand: async (method: string) => (method === "Target.getTargetInfo" ? { targetInfo: { targetId: this.targetId } } : {}),
    };
    isLoading = () => false;
    isDestroyed = () => false;
    isCurrentlyAudible = () => false;
    getOSProcessId = () => 1;
    getTitle = () => "";
    getURL = () => "";
    setWindowOpenHandler() {}
    sendInputEvent() {}
    /** The person presses in it: Electron says so before the press reaches the page, which then has the keyboard. */
    press() {
        this.emit("before-mouse-event", {}, { type: "mouseDown" });
        this.emit("before-mouse-event", {}, { type: "mouseUp" });
        this.focusedFrame = this.stuck ? null : this.mainFrame;
    }
}

let hosts: any[] = [];
afterEach(() => {
    for (const h of hosts) h.close();
    hosts = [];
});

async function app() {
    const told: { type: string; key?: string }[] = [];
    const gui = new EventEmitter();
    const pages: Page[] = [];
    const win = {
        webContents: {
            isDestroyed: () => false,
            sendInputEvent() {},
            send: (_channel: string, msg: { type: string; key: string; partition: string }) => {
                told.push(msg);
                if (msg.type !== "create") return;
                const page = new Page(`T${pages.length + 1}`);
                pages.push(page);
                gui.emit("will-attach-webview", { preventDefault() {} }, {}, { src: `about:blank#${msg.key}`, partition: msg.partition });
                gui.emit("did-attach-webview", {}, page);
            },
        },
    };
    const host = new BrowserHost(() => win as any) as any;
    hosts.push(host);
    host.watch(gui);
    host.receive(JSON.stringify({ channel: "c", open: { profile: "p" } }));
    await host.command(host.channels.get("c"), { id: 1, method: "Target.createTarget", params: { url: "about:blank" } });
    const refocus = () => told.filter((m) => m.type === "refocus");
    return { page: pages[0]!, host, refocus };
}

test("a press of the person's that leaves the page without the keyboard: the window is told to focus it again", async () => {
    const a = await app();
    a.page.stuck = true;
    a.page.press();
    await sleep(150);
    expect(a.refocus()).toEqual([{ type: "refocus", key: "tab-1" }]);
});

test("a press that gives the page the keyboard, as any does: nothing is said", async () => {
    const a = await app();
    a.page.press();
    await sleep(150);
    expect(a.refocus()).toEqual([]);
    // Nor for a page closed in the meantime.
    const b = await app();
    b.page.stuck = true;
    b.page.press();
    b.host.close();
    await sleep(150);
    expect(b.refocus()).toEqual([]);
});
