// The desktop app's browser and the server's idle timer: the server sees the agent's calls, not a person looking at or
// using a tab in the app, which says so itself (Cavvy.inUse, desktop-electron/src/browser-host.ts).
import { afterEach, expect, test } from "bun:test";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { attachDesktopHost, detachDesktopHost } = await import("../src/browser/host");
const { BrowserPool } = await import("../src/browser/pool");

/** An app that answers every command, opens the tab it's asked for, and can say its browser is in use. */
function app() {
    let channel = "";
    let closed = false;
    const host = attachDesktopHost({
        send: (text) => {
            const m = JSON.parse(text);
            if (m.open) channel = m.channel;
            if (m.close) closed = true;
            if (!m.data) return;
            const cmd = JSON.parse(m.data);
            const reply = (data: unknown) => queueMicrotask(() => host.receive(JSON.stringify({ channel, data: JSON.stringify(data) })));
            if (cmd.method === "Target.createTarget") {
                reply({ id: cmd.id, result: { targetId: "T1" } });
                reply({ method: "Target.attachedToTarget", params: { sessionId: "desktop-1", targetInfo: { targetId: "T1", type: "page", url: "about:blank" }, waitingForDebugger: true } });
            } else reply({ id: cmd.id, result: cmd.method === "Browser.getVersion" ? { userAgent: "Chrome/140" } : {} });
        },
        close() {},
    });
    const inUse = () => host.receive(JSON.stringify({ channel, data: JSON.stringify({ method: "Cavvy.inUse", params: {} }) }));
    return { host, inUse, closed: () => closed };
}

const client = { hooks: { frame() {}, changed() {} }, viewport: () => ({ width: 800, height: 600, scale: 1 }), adopt: () => false, refuse: () => undefined, closed() {}, lost() {}, watching: () => false, busy: () => false } as any;

let pool: InstanceType<typeof BrowserPool> | undefined;
let attached: ReturnType<typeof app> | undefined;
afterEach(async () => {
    await pool?.dispose();
    if (attached) detachDesktopHost(attached.host);
    pool = attached = undefined;
});
process.on("exit", () => iso.cleanup());

test("a tab the person is looking at or using in the app keeps its browser from closing as idle", async () => {
    attached = app();
    pool = new BrowserPool({ root: tempDir("cavvy-host-idle-"), settings: () => ({}), idleMs: 300 });
    pool.clients.add(client);
    await pool.openPage(client, "agent");
    expect(pool.hosted).toBe(true);
    // Several idle periods, the app saying it's in use throughout.
    for (let i = 0; i < 12; i++) {
        attached.inUse();
        await Bun.sleep(100);
    }
    expect(pool.running).toBe(true);
    expect(attached.closed()).toBe(false);
    // Then nobody: it ends.
    const deadline = Date.now() + 5000;
    while (pool.running && Date.now() < deadline) await Bun.sleep(50);
    expect(pool.running).toBe(false);
    expect(attached.closed()).toBe(true);
});
