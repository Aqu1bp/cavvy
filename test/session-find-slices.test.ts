// Find in a long session's turns works a slice at a time (src/server/find.ts): the server goes on answering meanwhile
// (other sessions stream, the windows' calls are answered), and a query a newer one took the place of stops.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { startServer } = await import("../src/server/server");
const { writeThread } = await import("../scripts/perf-thread");

let srv: Awaited<ReturnType<typeof startServer>>;
let ws: WebSocket;
let seq = 0;
const replies = new Map<number, (v: any) => void>();
const call = async (method: string, params: unknown) => {
    const r = await new Promise<any>((res) => {
        const id = ++seq;
        replies.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
    });
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
};

beforeAll(async () => {
    mkdirSync(iso.home, { recursive: true });
    writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus" }));
    const TOKEN = "find-slices-token-0123456789";
    srv = await startServer({ token: TOKEN });
    ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { protocols: ["cavvy.v1", `auth.${TOKEN}`] } as any);
    await new Promise((r, j) => {
        ws.onopen = r;
        ws.onerror = j;
    });
    ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data));
        if (msg.id) {
            replies.get(msg.id)?.(msg);
            replies.delete(msg.id);
        }
    };
});
afterAll(async () => {
    ws?.close();
    await srv?.stop();
    iso.cleanup();
});

test("Find working through a long session for the first time doesn't hold the server", async () => {
    const cwd = join(tempDir("cavvy-find-slices-"), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items: 30_000, kind: "native", seed: 9 });
    const open = await call("session.open", { id: t.id, last: 5 });
    const before = open.turns[0].id;

    // The server and this test share a thread: the longest it went without coming back to the event loop.
    let longest = 0;
    let last = performance.now();
    let ticking = true;
    const tick = () => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
        if (ticking) setImmediate(tick);
    };
    setImmediate(tick);
    // Asked twice, as the bar opens (warming what's searched) and as a query is typed: the first stops.
    const warming = call("session.find", { id: t.id, query: "", before });
    const found = await call("session.find", { id: t.id, query: "Turn 7:", before });
    expect((await warming).matches).toEqual([]);
    ticking = false;
    expect(found.matches).toHaveLength(1);
    // Before: the whole search at once (733 ms for this session on an M5).
    expect(longest).toBeLessThan(100);
}, 120_000);
