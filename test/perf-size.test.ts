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

interface Cost { openSent: number; findSent: number; rewindSent?: number; readOnOpen?: number; keptAfterOpen: number }

async function costs(kind: "cli" | "native", items: number): Promise<Cost> {
    const cwd = join(tempDir(`cavvy-perf-size-${kind}-`), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items, kind, seed: 7 });
    const before = heap();
    const read0 = readSoFar();
    const open = await ok("session.open", { id: t.id, last: 100 });
    const read1 = readSoFar();
    const kept = heap() - before;
    expect(open.msg.result.turns).toHaveLength(100);
    // Find asks for every turn the window doesn't have (Transcript.tsx: loadEarlier all).
    const find = await ok("session.turns", { id: t.id, before: open.msg.result.turns[0].id, all: true });
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
    return { openSent: open.bytes, findSent: find.bytes, rewindSent, readOnOpen: read0 === undefined || read1 === undefined ? undefined : read1 - read0, keptAfterOpen: kept };
}

const measured: Record<string, { small: Cost; large: Cost }> = {};
const within = (small: number, large: number) => large <= small * RATIO + SLACK;

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
    // The server reads the whole file and builds every turn: a turn index, and turns built as they're shown.
    test.failing("opening it reads, and keeps in the server, what's on screen", () => {
        const { small, large } = measured.native!;
        if (small.readOnOpen !== undefined) expect(within(small.readOnOpen, large.readOnOpen!)).toBe(true);
        expect(within(Math.max(small.keptAfterOpen, 1), large.keptAfterOpen)).toBe(true);
    });
    // Find loads every turn into the window: the server answers it.
    test.failing("finding in it sends what's found, not every turn", () => {
        const { small, large } = measured.native!;
        expect(within(small.findSent, large.findSent)).toBe(true);
    });
});

describe("a Claude Code session", () => {
    // Every sub-agent still goes, as its list shows it (about 220 bytes each: AgentRun.partial); whole, only those of
    // the turns it sends and any still running.
    test("opening it sends its last turns and their sub-agents, whatever came before", () => {
        const { small, large } = measured.cli!;
        expect(within(small.openSent, large.openSent)).toBe(true);
    });
    test.failing("opening it reads, and keeps in the server, what's on screen", () => {
        const { small, large } = measured.cli!;
        if (small.readOnOpen !== undefined) expect(within(small.readOnOpen, large.readOnOpen!)).toBe(true);
        expect(within(Math.max(small.keptAfterOpen, 1), large.keptAfterOpen)).toBe(true);
    });
    test.failing("finding in it sends what's found, not every turn", () => {
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
    const open = await ok("session.open", { id: t.id, last: 100 });
    const tools = (open.msg.result.turns as { blocks: { t: string }[] }[]).flatMap((x) => x.blocks).filter((b) => b.t === "tool");
    expect(tools.length).toBeGreaterThan(100);
}, 600_000);
