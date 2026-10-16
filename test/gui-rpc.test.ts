import { afterEach, expect, spyOn, test } from "bun:test";
import { Rpc } from "../gui/src/lib/rpc";
import { RequestAges, requestNoticeMs } from "../gui/src/lib/request-age";

test("request notices use 15s / 60s thresholds and clear only when the last slow reply arrives", () => {
    const ages = new RequestAges();
    expect(requestNoticeMs("session.send")).toBe(15_000);
    expect(requestNoticeMs("models.list")).toBe(60_000);
    expect(requestNoticeMs("projects.createWorktree")).toBe(60_000);
    ages.add(1, "settings.get", 0);
    ages.add(2, "session.send", 1000);
    ages.add(3, "models.list", 0);
    expect(ages.slow(14_999)).toBe(false);
    expect(ages.nextDelay(14_999)).toBe(1);
    expect(ages.slow(15_000)).toBe(true);
    ages.remove(1);
    expect(ages.slow(15_000)).toBe(false);
    expect(ages.slow(16_000)).toBe(true);
    ages.remove(2);
    expect(ages.slow(59_999)).toBe(false);
    expect(ages.slow(60_000)).toBe(true);
    ages.clear();
    expect(ages.slow(100_000)).toBe(false);
    expect(ages.nextDelay(100_000)).toBeUndefined();
});

class Socket {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = 0;
    sent: { id: number; method: string }[] = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number }) => void;
    constructor() {
        Socket.instances.push(this);
    }

    open() {
        this.readyState = 1;
        this.onopen?.();
    }

    send(raw: string) {
        this.sent.push(JSON.parse(raw));
    }

    message(msg: unknown) {
        this.onmessage?.({ data: JSON.stringify(msg) });
    }

    close() {
        this.readyState = 3;
        this.onclose?.({ code: 1006 });
    }
}

const originalSocket = globalThis.WebSocket;
const originalTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let restoreNow: (() => void) | undefined;
let rpc: Rpc | undefined;
afterEach(() => {
    rpc?.close();
    rpc = undefined;
    globalThis.WebSocket = originalSocket;
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    restoreNow?.();
});

function setup() {
    let now = 0;
    let id = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    Socket.instances = [];
    globalThis.WebSocket = Socket as unknown as typeof WebSocket;
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
        timers.set(++id, { at: now + ms, fn });
        return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
        timers.delete(id);
    }) as unknown as typeof clearTimeout;
    const spy = spyOn(performance, "now").mockImplementation(() => now);
    restoreNow = () => spy.mockRestore();
    rpc = new Rpc(async () => ({ url: "ws://test", token: "test" }));
    return {
        client: rpc,
        advance(ms: number) {
            now += ms;
            for (const [id, timer] of [...timers]) {
                if (timer.at <= now) {
                    timers.delete(id);
                    timer.fn();
                }
            }
        },
    };
}

test("slow feedback never cancels work and clears on replies, errors, and disconnect", async () => {
    const { client, advance } = setup();
    let slow = false;
    client.onSlow((v) => {
        slow = v;
    });
    await client.connect();
    const ws = Socket.instances[0]!;
    ws.open();
    const first = client.call("settings.get", {});
    advance(15_000);
    expect(slow).toBe(true);
    ws.message({ id: ws.sent[0]!.id, result: {} });
    await first;
    expect(slow).toBe(false);
    const second = client.call("settings.get", {}).catch((e) => e);
    advance(15_000);
    ws.message({ id: ws.sent[1]!.id, error: { message: "test failure" } });
    expect((await second).message).toBe("test failure");
    expect(slow).toBe(false);
    const third = client.call("session.send", { id: "session", text: "once" }).catch((e) => e);
    advance(15_000);
    expect(slow).toBe(true);
    ws.close();
    expect((await third).code).toBe("disconnected");
    expect(slow).toBe(false);
});

test("reconnect now replaces backoff and stale sockets without replaying mutations", async () => {
    const { client, advance } = setup();
    await client.connect();
    const old = Socket.instances[0]!;
    old.open();
    const sent = client.call("session.send", { id: "s", text: "once" }).catch((e) => e);
    old.close();
    await sent;
    await expect(client.call("session.send", { id: "s", text: "offline" })).rejects.toThrow("Not connected");
    client.reconnectNow();
    await Promise.resolve();
    const stale = Socket.instances[1]!;
    client.reconnectNow();
    await Promise.resolve();
    const current = Socket.instances[2]!;
    stale.open();
    expect(client.state).toBe("reconnecting");
    current.open();
    advance(100_000);
    await Promise.resolve();
    expect(Socket.instances.length).toBe(3);
    expect(current.sent).toEqual([]);
    expect(old.sent.length).toBe(1);
    expect(client.state).toBe("open");
});

test("compaction uses the long threshold regardless of activity display text", async () => {
    const { client, advance } = setup();
    let slow = false;
    client.onSlow((v) => {
        slow = v;
    });
    await client.connect();
    const ws = Socket.instances[0]!;
    ws.open();
    const compact = client.call("session.compact", { id: "s" });
    ws.message({ event: { type: "session.ops", sessionId: "s", ops: [{ op: "state", patch: { activity: { label: "Compacting conversation" } } }] } });
    advance(59_999);
    expect(slow).toBe(false);
    ws.message({ event: { type: "session.ops", sessionId: "s", ops: [{ op: "state", patch: { activity: { label: "Reworded activity" } } }] } });
    advance(1);
    expect(slow).toBe(true);
    ws.message({ id: ws.sent[0]!.id, result: null });
    await compact;
    expect(slow).toBe(false);
});

test("close rejects pending replies, clears feedback, and never reconnects", async () => {
    const { client, advance } = setup();
    let slow = false;
    client.onSlow((v) => {
        slow = v;
    });
    await client.connect();
    const ws = Socket.instances[0]!;
    ws.open();
    const pending = client.call("session.send", { id: "s", text: "once" }).catch((e) => e);
    advance(15_000);
    expect(slow).toBe(true);
    client.close();
    expect((await pending).code).toBe("disconnected");
    expect(slow).toBe(false);
    expect(client.state).toBe("unavailable");
    client.reconnectNow();
    advance(100_000);
    await client.connect();
    expect(Socket.instances).toHaveLength(1);
    await expect(client.call("session.send", { id: "s", text: "offline" })).rejects.toThrow("Not connected");
});

test("closing during credential lookup never opens a socket", async () => {
    setup();
    let resolve!: (value: { url: string; token: string }) => void;
    rpc = new Rpc(
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );
    const connecting = rpc.connect();
    rpc.close();
    resolve({ url: "ws://test", token: "test" });
    await connecting;
    expect(Socket.instances).toEqual([]);
});
