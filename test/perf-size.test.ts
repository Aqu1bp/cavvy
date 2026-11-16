// Cost depends on what's on screen, not on how long the session is (docs/performance-plan.md). Each thing the app does
// with a session, done to a session of 3,000 items and to one of 30,000 (scripts/perf-thread.ts), counted rather than
// timed: what it sends the window, what the server reads from disk and keeps in memory. The big one may cost no more
// than the small one, give or take.
//
// test.failing: a target the app doesn't meet yet, with what will meet it. It fails once it's met: make it a test then.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { heapStats } from "bun:jsc";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { startMockLlm } = await import("../scripts/mock-llm");
const { startServer } = await import("../src/server/server");
const { writeThread } = await import("../scripts/perf-thread");
// The window's own numbers, not copies: a change to them is measured here too. Opened as a window opens one with
// work shown folded (the default: gui/src/state/app.ts opening).
const { OPEN_TURNS, OPEN_BYTES } = await import("../gui/src/state/app");
const { findKeeping } = await import("../src/server/runtime");
const { Session, checkpointing } = await import("../src/agent/session");
const { uiLogFile } = await import("../src/server/history");
// What Find searches, let go of soon after it was used (as it is a while after: runtime.ts findKeeping).
const keptFor = findKeeping.ms;
findKeeping.ms = 300;

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
/**
 * The heap once it's steady: within 64 KB for a second, at most 8 s (as keptOpen waits, below). Read at once, the
 * session before was still letting go of what it kept (closed, its turns stored): the next one's baseline was high by
 * that, and what it kept read 4 MB less than nothing.
 */
const settledHeap = async () => {
    let last = heap();
    for (let i = 0, steady = 0; i < 80 && steady < 10; i++) {
        await Bun.sleep(100);
        const now = heap();
        steady = Math.abs(now - last) < 64 * 1024 ? steady + 1 : 0;
        last = now;
    }
    return last;
};

interface Cost { openSent: number; findSent: number; rewindSent?: number; readOnOpen?: number; keptAfterOpen: number; keptOpen: number; readOnReopen?: number; keptAfterReopen: number; openMs: number; reopenMs: number }

async function costs(kind: "cli" | "native", items: number): Promise<Cost> {
    const cwd = join(tempDir(`cavvy-perf-size-${kind}-`), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items, kind, seed: 7 });
    const before = await settledHeap();
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
    // Kept while it's open: once its turns are in its store (a slice at a time after it opened) and Find has let go.
    let keptOpen = heap() - before;
    // Steady for a second (what it builds and stores after it opens is done).
    for (let i = 0, steady = 0; i < 80 && steady < 10; i++) {
        await Bun.sleep(100);
        const now = heap() - before;
        steady = Math.abs(now - keptOpen) < 64 * 1024 ? steady + 1 : 0;
        keptOpen = now;
    }
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
        openSent: open.bytes, findSent: find.bytes, rewindSent, readOnOpen: read0 === undefined || read1 === undefined ? undefined : read1 - read0, keptAfterOpen: kept, keptOpen,
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
    // Other test files run in the same process (a CI shard): as it was.
    findKeeping.ms = keptFor;
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
    // Open, its turns beyond the latest in its store (put there a slice at a time after it opens), and what Find
    // searches let go of a while after it's used (runtime.ts findKeeping: 30 MB for 100,000 items).
    test("open, the server keeps what's on screen", () => {
        const { small, large } = measured.native!;
        expect(keptWithin(small.keptOpen, large.keptOpen)).toBe(true);
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
    // Opened again, its turns and sub-agents come from its store, and its messages (a Claude Code session's aren't
    // compacted here: every reply's text) from its checkpoint's digest of them, read only as they're asked for. Its log
    // was read whole and its history kept: 1 MB read and 2 MB kept at 3,000 items, 4.7 and 6.7 at 30,000.
    test("opening it again reads, and keeps in the server, what's on screen", () => {
        const { small, large } = measured.cli!;
        expect(small.readOnReopen).toBeDefined();
        expect(within(small.readOnReopen!, large.readOnReopen!)).toBe(true);
        expect(keptWithin(small.keptAfterReopen, large.keptAfterReopen)).toBe(true);
    });
    // Imported (src/server/cli-import.ts writes its turns done, never started): nothing was left running, so its
    // messages aren't read to see whether a turn was cut off. They were, at every open.
    test("opening an imported one again doesn't read its messages", async () => {
        const cwd = join(tempDir("cavvy-perf-size-imported-"), "project");
        mkdirSync(cwd, { recursive: true });
        const t = writeThread({ cwd, items: SMALL, kind: "cli", seed: 9 });
        const log = uiLogFile(t.file, t.id);
        writeFileSync(log, readFileSync(log, "utf8").split("\n").filter((l) => !l.startsWith('{"t":"turn"') || JSON.parse(l).status !== undefined).join("\n"));
        // Read from a checkpoint (one this short has none).
        const was = checkpointing.after;
        checkpointing.after = 1;
        try {
            await ok("session.open", { id: t.id, last: OPEN_TURNS, budget: OPEN_BYTES, fold: true });
            await ok("session.close", { id: t.id });
        } finally {
            checkpointing.after = was;
        }
        const store = join(dirname(t.file), "turns", `${t.id}.json`);
        for (let i = 0; i < 200 && !existsSync(store); i++) await Bun.sleep(10);
        const proto = Session.prototype as unknown as { readMessages(): void };
        const read = proto.readMessages;
        let reads = 0;
        proto.readMessages = function (this: unknown) {
            reads++;
            return read.call(this);
        };
        try {
            await ok("session.open", { id: t.id, last: OPEN_TURNS, budget: OPEN_BYTES, fold: true });
            await ok("session.close", { id: t.id });
        } finally {
            proto.readMessages = read;
        }
        expect(reads).toBe(0);
    });
    // Its history (every reply's text) is in it too: 4.6 MB at 3,000 items, 6.2 at 30,000.
    test("open, the server keeps what's on screen", () => {
        const { small, large } = measured.cli!;
        expect(keptWithin(small.keptOpen, large.keptOpen)).toBe(true);
    });
    test("finding in it sends what's found, not every turn", () => {
        const { small, large } = measured.cli!;
        expect(within(small.findSent, large.findSent)).toBe(true);
    });
});

// A session whose GUI log passes 2 GiB (whole files written, long diffs, sub-agents that run long: the worst the app
// keeps of each) opens with all its steps: the log was read into one string, which can't be that long, and the read's
// failure was taken for an empty log. It writes 2.3 GB and takes a while: set CAVVY_PERF_HUGE=1 to run it. (100,000
// items came to 1.9 GB, under 2 GiB: it passed as failing without ever reaching what it's about.)
(process.env.CAVVY_PERF_HUGE ? test : test.skip)("a session whose log passes 2 GiB opens with its work", async () => {
    const cwd = join(tempDir("cavvy-perf-huge-"), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items: 120_000, kind: "cli", heavy: true, seed: 3 });
    expect(t.uiBytes).toBeGreaterThan(2 ** 31);
    // As the window opens one (gui/src/state/app.ts: OPEN_TURNS, OPEN_BYTES).
    const open = await ok("session.open", { id: t.id, last: OPEN_TURNS, budget: OPEN_BYTES, fold: true });
    const tools = (open.msg.result.turns as { blocks: { t: string }[] }[]).flatMap((x) => x.blocks).filter((b) => b.t === "tool");
    expect(tools.length).toBeGreaterThan(100);
}, 600_000);
