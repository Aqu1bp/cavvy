// A window on another machine is sent its stream compressed (src/server/server.ts, Conn.compress), and this machine's own
// windows aren't: bytes per streamed character on the wire, counted by a proxy in front of the server.
// 127.0.0.2 is loopback on Linux only (macOS answers 127.0.0.1 alone), so this runs where it can name another address.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { startServer } = await import("../src/server/server");
const { startMockLlm } = await import("../scripts/mock-llm");
const TOKEN = "test-token-0123456789";
// A delay, so a reply streams at its own pace (with none, it all comes at once).
const mock = startMockLlm({ delayMs: 1 });
mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));
const stops: (() => void)[] = [];
afterAll(() => {
    for (const s of stops) s();
    mock.stop?.();
    iso.cleanup();
});

/** A TCP proxy on 127.0.0.1 to `host:port`, counting what comes back; the Host header rewritten to name the server. */
function proxy(host: string, port: number) {
    let down = 0;
    const from = (p: number) => `127.0.0.1:${p}`;
    const srv = Bun.listen<{ up?: Promise<import("bun").Socket>; port: number }>({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
            open(c) {
                c.data = { port: srv.port, up: Bun.connect({ hostname: host, port, socket: { data(_s, d) { down += d.byteLength; c.write(d); }, close() { c.end(); } } }) };
            },
            async data(c, d) {
                const text = Buffer.from(d).toString("latin1").split(from(c.data.port)).join(`${host}:${port}`);
                (await c.data.up!).write(Buffer.from(text, "latin1"));
            },
            async close(c) { (await c.data.up)?.end(); },
        },
    });
    stops.push(() => srv.stop(true));
    return { port: srv.port, reset: () => { down = 0; }, get down() { return down; } };
}

async function streamed(host: string): Promise<{ chars: number; wire: number }> {
    const server = await startServer({ host, port: 0, token: TOKEN });
    stops.push(() => server.stop?.());
    const p = proxy(host, server.port);
    const ws = new WebSocket(`ws://127.0.0.1:${p.port}/ws`, { protocols: ["cavvy.v1", `auth.${TOKEN}`] } as any);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let seq = 0, chars = 0, on = false, idle = false;
    const replies = new Map<number, (v: any) => void>();
    ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data));
        if (msg.id) return replies.get(msg.id)?.(msg);
        if (!on || msg.event?.type !== "session.ops") return;
        for (const o of msg.event.ops) {
            if (o.op === "append") chars += o.text.length;
            if (o.op === "state" && o.patch?.status === "idle") idle = true;
        }
    };
    const call = (method: string, params: unknown) => new Promise<any>((r) => { const id = ++seq; replies.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const id = (await call("session.create", { cwd: tempDir("cavvy-ws-compress-") })).result.state.id;
    await call("session.open", { id });
    p.reset();
    on = true;
    // A model's pace: 40 characters every 10 ms, each its own message, as a reply streams.
    await call("session.send", { id, text: "perfreply 8000 40 10" });
    for (let i = 0; i < 300 && !idle; i++) await Bun.sleep(20);
    on = false;
    ws.close();
    return { chars, wire: p.down };
}

test.skipIf(process.platform !== "linux")("a window on another machine is sent about a byte a streamed character, this machine's own its messages whole", async () => {
    const remote = await streamed("127.0.0.2");
    const local = await streamed("127.0.0.1");
    expect(remote.chars).toBeGreaterThan(7000);
    expect(local.chars).toBeGreaterThan(7000);
    // Target G: ≤ 1.2 bytes a streamed character to another machine (measured 0.55).
    expect(remote.wire / remote.chars).toBeLessThanOrEqual(1.2);
    // Uncompressed here: what the CPU would cost buys nothing on loopback (measured 2.66, almost 5 times as much).
    expect(local.wire).toBeGreaterThan(remote.wire * 3);
}, 30_000);
