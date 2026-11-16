// How long the server holds its event loop after opening a long session, and what it keeps right after: a session of
// scripts/perf-thread.ts written, opened as the window opens one, then found in, while a tick measures each wait
// between turns of the loop. A wait the heap shrank across was (most likely) a collection.
//
//   bun scripts/open-gaps.ts [cli|native] [items] [ms to watch after the open]
//
// Prints one line of JSON. Runs in a home of its own (removed after).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { heapStats } from "bun:jsc";

const kind = (process.argv[2] ?? "cli") as "cli" | "native";
const items = Number(process.argv[3] ?? 30_000);
const watchMs = Number(process.argv[4] ?? 4_000);

const home = mkdtempSync(join(tmpdir(), "cavvy-open-gaps-"));
process.env.CAVVY_HOME = home;
process.env.CAVVY_NO_KEYCHAIN = "1";
const { startMockLlm } = await import("./mock-llm");
const { startServer } = await import("../src/server/server");
const { writeThread } = await import("./perf-thread");
const { OPEN_TURNS, OPEN_BYTES } = await import("../gui/src/state/app");

const mock = startMockLlm({ delayMs: 1 });
writeFileSync(join(home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));
const cwd = join(home, "project");
mkdirSync(cwd, { recursive: true });
const thread = writeThread({ cwd, items, kind, seed: 7 });

const TOKEN = "open-gaps-token-0123456789";
const srv = await startServer({ token: TOKEN });
const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { protocols: ["cavvy.v1", `auth.${TOKEN}`] } as any);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const replies = new Map<number, (m: any) => void>();
ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id) { replies.get(msg.id)?.(msg); replies.delete(msg.id); }
};
const call = (method: string, params: unknown) => new Promise<any>((r) => { const id = ++seq; replies.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const MB = 1024 * 1024;
const heap = () => { Bun.gc(true); return +(heapStats().heapSize / MB).toFixed(1); };

// Each wait between ticks over 20 ms: when it began (from the open's reply), how long, and the heap either side.
const waits: { at: number; ms: number; heapBefore: number; heapAfter: number }[] = [];
let ticking = false;
let last = 0;
let lastHeap = 0;
let since = 0;
const tick = () => {
    const now = performance.now();
    const used = process.memoryUsage().heapUsed / MB;
    if (now - last > 20) waits.push({ at: Math.round(last - since), ms: Math.round(now - last), heapBefore: Math.round(lastHeap), heapAfter: Math.round(used) });
    last = now;
    lastHeap = used;
    if (ticking) setImmediate(tick);
};

const heapBefore = heap();
const at = performance.now();
const open = await call("session.open", { id: thread.id, last: OPEN_TURNS, budget: OPEN_BYTES, fold: true });
if (open.error) throw new Error(open.error.message);
const openMs = performance.now() - at;
const heapAfterOpen = heap();
since = last = performance.now();
lastHeap = process.memoryUsage().heapUsed / MB;
ticking = true;
setImmediate(tick);
const f = performance.now();
const found = await call("session.find", { id: thread.id, query: "Turn 7:", before: open.result.turns[0].id });
const findMs = performance.now() - f;
await Bun.sleep(Math.max(0, watchMs - (performance.now() - since)));
ticking = false;
const heapAtEnd = heap();
console.log(JSON.stringify({
    bun: Bun.version, kind, items, openMs: Math.round(openMs), findMs: Math.round(findMs), found: found.result?.matches?.length,
    heapMB: { before: heapBefore, afterOpen: heapAfterOpen, atEnd: heapAtEnd },
    longestWaitMs: Math.max(0, ...waits.map((w) => w.ms)), waits: waits.sort((a, b) => b.ms - a.ms).slice(0, 10),
}));
ws.close();
await srv.stop();
mock.stop();
rmSync(home, { recursive: true, force: true });
process.exit(0);
