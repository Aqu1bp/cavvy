// Cost depends on what's on screen, not on how long the session is (docs/performance-plan.md). Each thing the app does
// with a session, done to a session of 3,000 items and to one of 30,000 (scripts/perf-thread.ts), counted rather than
// timed: what it sends the window, what the server reads from disk and keeps in memory. The big one may cost no more
// than the small one, give or take.
//
// test.failing: a target the app doesn't meet yet, with what will meet it. It fails once it's met: make it a test then.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { heapStats } from "bun:jsc";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { startMockLlm } = await import("../scripts/mock-llm");
const { startServer } = await import("../src/server/server");
const { writeThread } = await import("../scripts/perf-thread");
// The window's own numbers, not copies: a change to them is measured here too. Opened as a window opens one with
// work shown folded (the default: gui/src/state/app.ts opening).
const { OPEN_TURNS, OPEN_BYTES } = await import("../gui/src/state/app");

const SMALL = 3_000;
const LARGE = 30_000;
/** The big session's cost may be this much more than the small one's, and this many bytes. */
const RATIO = 1.25;
const SLACK = 64 * 1024;

let srv: Awaited<ReturnType<typeof startServer>>;
let mock: ReturnType<typeof startMockLlm>;
let ws: WebSocket;
let seq = 0;
const replies = new Map<number, (v: { msg: any; bytes: number }) => void>();
let opsBytes = 0;
const call = (method: string, params: unknown) => new Promise<{ msg: any; bytes: number }>((r) => {
    const id = ++seq;
    replies.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
});
const ok = async (method: string, params: unknown) => {
    const r = await call(method, params);
    if (r.msg.error) throw new Error(`${method}: ${r.msg.error.message}`);
    return r;
};

/** Bytes this process has read from files since it started (Linux), or undefined where that isn't known. */
const readSoFar = () => (existsSync("/proc/self/io") ? Number(/rchar: (\d+)/.exec(readFileSync("/proc/self/io", "utf8"))?.[1]) : undefined);
/** What the server's JavaScript keeps, after a full collection: the process's resident size moves with the allocator. */
const heap = () => {
    Bun.gc(true);
    return heapStats().heapSize;
};

interface Cost { openSent: number; findSent: number; rewindSent?: number; readOnOpen?: number; keptAfterOpen: number; readOnReopen?: number; keptAfterReopen: number; openMs: number; reopenMs: number }

async function costs(kind: "cli" | "native", items: number): Promise<Cost> {
    const cwd = join(tempDir(`cavvy-perf-size-${kind}-`), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items, kind, seed: 7 });
    const before = heap();
    const read0 = readSoFar();
    // As the window opens one (gui/src/state/app.ts: OPEN_TURNS, OPEN_BYTES).
    let at = performance.now();
    const open = await ok("session.open", { id: t.id, last: OPEN_TURNS, budget: OPEN_BYTES, fold: true });
    const openMs = performance.now() - at;
    const read1 = readSoFar();
    const kept = heap() - before;
    expect(open.msg.result.earlier).toBeGreaterThan(0);
    // Find, in the turns the window doesn't have (session.find): a query found once, whatever the session's size.
    const find = await ok("session.find", { id: t.id, query: "Turn 7:", before: open.msg.result.turns[0].id });
    expect(find.msg.result.matches).toHaveLength(1);
    let rewindSent: number | undefined;
    if (kind === "native") {
        // Back to before the last prompt.
        const last = open.msg.result.turns.at(-1).pos.index as number;
        const plan = await ok("session.rewindPlan", { id: t.id, index: last });
        opsBytes = 0;
        await ok("session.rewind", { id: t.id, index: last, planId: plan.msg.result.planId, code: false, conversation: true });
        await Bun.sleep(150);
        rewindSent = opsBytes;
    }
    await ok("session.close", { id: t.id });
    // Opened again (its turns stored as it was let go of: src/server/turn-store.ts), twice: what it keeps is the less
    // of the two (the heap after a collection still moves by a megabyte or so from one open to the next).
    let reopen: { read?: number; kept: number; ms: number } | undefined;
    for (let i = 0; i < 2; i++) {
        const before2 = heap();
        const read2 = readSoFar();
        at = performance.now();
        await ok("session.open", { id: t.id, last: OPEN_TURNS, budget: OPEN_BYTES, fold: true });
        const ms = performance.now() - at;
        const read3 = readSoFar();
        const kept2 = heap() - before2;
        await ok("session.close", { id: t.id });
        reopen ??= { read: read2 === undefined || read3 === undefined ? undefined : read3 - read2, kept: kept2, ms };
        reopen.kept = Math.min(reopen.kept, kept2);
    }
    return {
        openSent: open.bytes, findSent: find.bytes, rewindSent, readOnOpen: read0 === undefined || read1 === undefined ? undefined : read1 - read0, keptAfterOpen: kept,
        readOnReopen: reopen!.read, keptAfterReopen: reopen!.kept, openMs, reopenMs: reopen!.ms,
    };
}

const measured: Record<string, { small: Cost; large: Cost }> = {};
const within = (small: number, large: number) => large <= small * RATIO + SLACK;
/**
 * What the server keeps, measured from its heap after a collection, moves by a megabyte or two from one open to the
 * next (once -3.8 MB, on an M5): within this of the small session's, the same. The goal is no more than 10 MB above a
 * short session's (docs/performance-plan.md).
 */
const HEAP_SLACK = 2 * 1024 * 1024;
const keptWithin = (small: number, large: number) => large <= Math.max(small, 0) * RATIO + HEAP_SLACK;

beforeAll(async () => {
    mock = startMockLlm({ delayMs: 1 });
    mkdirSync(iso.home, { recursive: true });
    writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
    writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));
    const TOKEN = "perf-size-token-0123456789";
    srv = await startServer({ token: TOKEN });
    ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { protocols: ["cavvy.v1", `auth.${TOKEN}`] } as any);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => {
        const text = String(m.data);
        const msg = JSON.parse(text);
        if (msg.id) {
            replies.get(msg.id)?.({ msg, bytes: Buffer.byteLength(text) });
            replies.delete(msg.id);
        } else if (msg.event?.type === "session.ops") opsBytes += Buffer.byteLength(text);
    };
    for (const kind of ["cli", "native"] as const) measured[kind] = { small: await costs(kind, SMALL), large: await costs(kind, LARGE) };
    // What it came to, for whoever reads the log (and the PR that changes it).
    console.log(JSON.stringify(measured));
}, 180_000);

afterAll(async () => {
    ws?.close();
    await srv?.stop();
    mock?.stop();
    iso.cleanup();
});

describe("a session of one of Cavvy's own models", () => {
    test("opening it sends its last turns, whatever came before", () => {
        const { small, large } = measured.native!;
        expect(within(small.openSent, large.openSent)).toBe(true);
    });
    test("a rewind sends its last turns, not all of them", () => {
        const { small, large } = measured.native!;
        expect(within(small.rewindSent!, large.rewindSent!)).toBe(true);
    });
    // Opened again, its turns come from its store (src/server/turn-store.ts): only the latest are built.
    test("opening it again keeps in the server what's on screen", () => {
        const { small, large } = measured.native!;
        expect(keptWithin(small.keptAfterReopen, large.keptAfterReopen)).toBe(true);
    });
    // Its log from its checkpoint on (agent/session.ts: what reading it came to, kept as it was read).
    // Counted from /proc/self/io: Linux only (CI's).
    test.skipIf(!existsSync("/proc/self/io"))("opening it again reads what's on screen", () => {
        const { small, large } = measured.native!;
        expect(small.readOnReopen).toBeDefined();
        expect(within(small.readOnReopen!, large.readOnReopen!)).toBe(true);
    });
    test("finding in it sends what's found, not every turn", () => {
        const { small, large } = measured.native!;
        expect(within(small.findSent, large.findSent)).toBe(true);
    });
});

describe("a Claude Code session", () => {
    // Whole, the sub-agents of the turns it sends and any still running; the rest counted (agentsMore), and listed
    // as the panel's Finished fold shows them (session.agentList). Every one listed was 232 of the 576 KB it sent.
    test("opening it sends its last turns and their sub-agents, whatever came before", () => {
        const { small, large } = measured.cli!;
        expect(within(small.openSent, large.openSent)).toBe(true);
    });
    // Opened again, its turns and sub-agents come from its store, but its log is read whole and its history kept (a
    // Claude Code session's isn't compacted here: every reply's text): 1 MB read and 2 MB kept at 3,000 items, 4.7 and
    // 6.7 at 30,000. The session's state kept with the store, and its messages read as they're needed, would do it.
    test.failing("opening it again reads, and keeps in the server, what's on screen", () => {
        const { small, large } = measured.cli!;
        expect(small.readOnReopen).toBeDefined();
        expect(within(small.readOnReopen!, large.readOnReopen!)).toBe(true);
        expect(keptWithin(small.keptAfterReopen, large.keptAfterReopen)).toBe(true);
    });
    test("finding in it sends what's found, not every turn", () => {
        const { small, large } = measured.cli!;
        expect(within(small.findSent, large.findSent)).toBe(true);
    });
});

// A session whose GUI log passes 2 GiB (whole files written, long diffs, sub-agents that run long: the worst the app
// keeps of each) opens with all its steps: the log was read into one string, which can't be that long, and the read's
// failure was taken for an empty log. It writes 2.2 GB and takes a while: set CAVVY_PERF_HUGE=1 to run it.
(process.env.CAVVY_PERF_HUGE ? test.failing : test.skip)("a session whose log passes 2 GiB opens with its work", async () => {
    const cwd = join(tempDir("cavvy-perf-huge-"), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items: 100_000, kind: "cli", heavy: true, seed: 3 });
    expect(t.uiBytes).toBeGreaterThan(2 ** 31);
    // As the window opens one (gui/src/state/app.ts: OPEN_TURNS, OPEN_BYTES).
    const open = await ok("session.open", { id: t.id, last: OPEN_TURNS, budget: OPEN_BYTES, fold: true });
    const tools = (open.msg.result.turns as { blocks: { t: string }[] }[]).flatMap((x) => x.blocks).filter((b) => b.t === "tool");
    expect(tools.length).toBeGreaterThan(100);
}, 600_000);
