// A long session's turns are kept in its turn store as it's let go of (src/server/turn-store.ts), and it opens from
// there next time: what the window is sent then is what building it from its logs would send, and a session whose
// logs changed since is built from them again.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { AgentRun, SessionSnapshot, Turn } from "../src/server/protocol";

const iso = isolate();
const { startMockLlm } = await import("../scripts/mock-llm");
const { startServer } = await import("../src/server/server");
const { applyOp } = await import("../src/server/timeline");
const { writeThread } = await import("../scripts/perf-thread");
const { TurnStore } = await import("../src/server/turn-store");
const { findSessionAnywhere } = await import("../src/agent/session");
const { turnStoring, turnBuilding, storedFirst } = await import("../src/server/runtime");
// An open from the store reads only its last turns' heads (the rest as they're asked for): as few as it reads, so that
// these sessions (60 to 150 turns) have earlier turns left to read.
const firstRead = storedFirst.turns;

let srv: Awaited<ReturnType<typeof startServer>>;
let mock: ReturnType<typeof startMockLlm>;
let ws: WebSocket;
let seq = 0;
const replies = new Map<number, (msg: any) => void>();
const views = new Map<string, { turns: Turn[]; agents: AgentRun[]; seq: number; state: any }>();
const listeners = new Set<() => void>();

const call = async (method: string, params: unknown): Promise<any> => {
    const id = ++seq;
    const msg = await new Promise<any>((r) => {
        replies.set(id, r);
        ws.send(JSON.stringify({ id, method, params }));
    });
    if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
    return msg.result;
};

/** Opened, the view kept up to date from its ops. */
async function open(id: string, params: object = {}): Promise<SessionSnapshot> {
    const snap = (await call("session.open", { id, ...params })) as SessionSnapshot;
    views.set(id, { turns: structuredClone(snap.turns), agents: structuredClone(snap.agents), seq: snap.seq, state: snap.state });
    return snap;
}

const close = (id: string) => call("session.close", { id });

/** Until the session's view (from its ops) is as `pred` says. */
const until = (id: string, pred: (v: { turns: Turn[]; state: any }) => boolean) =>
    new Promise<void>((resolve, reject) => {
        const check = () => {
            const v = views.get(id);
            if (v && pred(v)) {
                listeners.delete(check);
                clearTimeout(t);
                resolve();
            }
        };
        const t = setTimeout(() => reject(new Error("timed out")), 15_000);
        listeners.add(check);
        check();
    });

beforeAll(async () => {
    storedFirst.turns = 20;
    mock = startMockLlm({ delayMs: 0 });
    mkdirSync(iso.home, { recursive: true });
    writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
    writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));
    const TOKEN = "turn-store-token-0123456789";
    srv = await startServer({ token: TOKEN });
    ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { protocols: ["cavvy.v1", `auth.${TOKEN}`] } as any);
    await new Promise((r, j) => {
        ws.onopen = r;
        ws.onerror = j;
    });
    ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data));
        if (msg.id) {
            const r = replies.get(msg.id);
            replies.delete(msg.id);
            setImmediate(() => r?.(msg));
            return;
        }
        if (msg.event?.type === "session.ops") {
            const v = views.get(msg.event.sessionId);
            if (v && msg.event.seq > v.seq) {
                for (const op of msg.event.ops) applyOp(v as any, op);
                v.seq = msg.event.seq;
            }
        }
        for (const l of listeners) l();
    };
}, 30_000);

afterAll(async () => {
    // Other test files run in the same process (a CI shard): as it was.
    storedFirst.turns = firstRead;
    ws?.close();
    await srv?.stop();
    mock?.stop();
    iso.cleanup();
});

const storeOf = (file: string, id: string) => join(dirname(file), "turns", `${id}.json`);

/** Unset on the wire is null (wireReplacer), and unset or absent in memory alike: compared as absent. */
const unset = (x: unknown) => JSON.parse(JSON.stringify(x), (_k, v) => (v === null ? undefined : v));

/** A finished turn's thoughts come without their text: each as the window asks for it, opened (session.block). */
async function fillThoughts(id: string) {
    for (const t of views.get(id)!.turns) {
        for (const [i, b] of t.blocks.entries()) if (b.t === "thinking" && b.omitted) t.blocks[i] = await call("session.block", { id, turnId: t.id, blockId: b.id });
    }
}

/** Less the notice each open shows on its own (Claude Code isn't installed here: the session says so as it opens). */
const lessOpenNotice = (turns: Turn[]) => turns.filter((t) => t.prompt || t.blocks.some((b) => b.t !== "notice" || !b.text.includes("isn't available now")));

/** All of what the window has of it once opened (its ops since included), the sub-agents whole too. */
async function everything(id: string) {
    await open(id);
    // A call that sends what's waiting first: the ops opening it made (a notice) are in the view.
    await call("session.find", { id, query: "" });
    const v = views.get(id)!;
    await fillThoughts(id);
    // Every sub-agent: as listed (those not sent are only counted as it opens), and whole.
    const list = (await call("session.agentList", { id })) as AgentRun[];
    const agents = [];
    for (const a of list) agents.push(await call("session.agent", { id, agentId: a.id }));
    return unset({ turns: lessOpenNotice(v.turns), agents: v.agents, list, whole: agents });
}

for (const kind of ["cli", "native"] as const) {
    describe(`a long ${kind === "cli" ? "Claude Code session" : "session of one of Cavvy's own models"}`, () => {
        test("opens from its store as it would from its logs", async () => {
            const cwd = join(tempDir(`cavvy-turn-store-${kind}-`), "project");
            mkdirSync(cwd, { recursive: true });
            const t = writeThread({ cwd, items: 1500, kind, seed: 3 });
            expect(t.turns).toBeGreaterThan(40);
            const built = await everything(t.id);
            if (kind === "cli") expect(built.list.length).toBeGreaterThan(0);
            const found = await call("session.find", { id: t.id, query: "Turn 7:" });
            await close(t.id);

            // Opened again: from its store.
            const opened = await everything(t.id);
            expect(existsSync(storeOf(t.file, t.id))).toBe(true);
            expect(opened).toEqual(built);
            expect(await call("session.find", { id: t.id, query: "Turn 7:" })).toEqual(found);
            // As the window opens it: its last turns, the rest a page at a time.
            const last = await open(t.id, { last: 5 });
            const page = await call("session.turns", { id: t.id, before: last.turns[0]!.id, all: true });
            const thoughtless = (turns: Turn[]) => turns.map((x) => ({ ...x, blocks: x.blocks.map((b) => (b.t === "thinking" ? { ...b, text: "", omitted: true } : b)) }));
            expect(unset(lessOpenNotice([...page.turns, ...last.turns]))).toEqual(unset(thoughtless(built.turns)));
            await close(t.id);
        }, 60_000);

        test("a session whose logs changed since is built from them again", async () => {
            const cwd = join(tempDir(`cavvy-turn-store-changed-${kind}-`), "project");
            mkdirSync(cwd, { recursive: true });
            const t = writeThread({ cwd, items: 1500, kind, seed: 4 });
            await open(t.id);
            await close(t.id);
            // Written as the session is let go of, a moment after (synced to the disk first).
            for (let i = 0; i < 200 && !existsSync(storeOf(t.file, t.id)); i++) await Bun.sleep(10);
            expect(existsSync(storeOf(t.file, t.id))).toBe(true);
            // Written to elsewhere (a terminal) while it was closed: a prompt and its reply.
            const msg = (m: object) => JSON.stringify({ t: "msg", m }) + "\n";
            appendFileSync(t.file, msg({ role: "user", content: [{ type: "text", text: "Written elsewhere" }], meta: { kind: "prompt" } }) + msg({ role: "assistant", provider: "mock", model: "mock-opus", stopReason: "end_turn", content: [{ type: "text", text: "Answered elsewhere" }] }));
            const snap = await open(t.id, { last: 3 });
            expect(snap.turns.some((x) => x.prompt?.text === "Written elsewhere")).toBe(true);
            await close(t.id);
        }, 60_000);
    });
}

for (const kind of ["cli", "native"] as const) {
    test(`a ${kind === "cli" ? "Claude Code session" : "session"} opened from its store reads its earlier turns as they're asked for, and they're as built`, async () => {
        const cwd = join(tempDir(`cavvy-turn-store-earlier-${kind}-`), "project");
        mkdirSync(cwd, { recursive: true });
        const t = writeThread({ cwd, items: 1500, kind, seed: 12 });
        const built = await everything(t.id);
        await close(t.id);
        // Its last turns read, and those before counted: as many as there are, their sub-agents too (agentsMore).
        storedFirst.turns = 1000;
        let whole: SessionSnapshot;
        try {
            whole = (await call("session.open", { id: t.id, last: 5 })) as SessionSnapshot;
            await close(t.id);
        } finally {
            storedFirst.turns = 20;
        }
        const index = storeOf(t.file, t.id);
        const stat = () => { const s = statSync(index); return `${s.ino}:${s.mtimeMs}`; };
        const was = stat();
        // Opened, its last turns read, and closed: nothing changed, nothing written (its earlier turns aren't read for that).
        await open(t.id, { last: 5 });
        await close(t.id);
        await Bun.sleep(200);
        if (kind === "native") expect(stat()).toBe(was);
        const last = await open(t.id, { last: 5 });
        const shown = (x: SessionSnapshot) => unset({ earlier: x.earlier, agentsMore: x.agentsMore, agents: x.agents, turns: lessOpenNotice(x.turns) });
        expect(shown(last)).toEqual(shown(whole));
        expect(last.earlier).toBeGreaterThan(20);
        // A page at a time back to the first: what building them all made.
        const pages: Turn[] = [];
        let first = last.turns[0]!.id;
        for (let earlier = last.earlier!; earlier > 0; ) {
            const page = await call("session.turns", { id: t.id, before: first, count: 7 });
            expect(page.turns.length).toBe(Math.min(7, earlier));
            expect(page.earlier).toBe(earlier - page.turns.length);
            pages.unshift(...page.turns);
            earlier = page.earlier;
            first = page.turns[0].id;
        }
        const thoughtless = (turns: Turn[]) => turns.map((x) => ({ ...x, blocks: x.blocks.map((b) => (b.t === "thinking" ? { ...b, text: "", omitted: true } : b)) }));
        expect(unset(lessOpenNotice([...pages, ...last.turns]))).toEqual(unset(thoughtless(built.turns)));
        expect(await call("session.agentList", { id: t.id })).toEqual(built.list);
        await close(t.id);
        // Nothing changed: its index as it was. (Not a Claude Code session's here, where each open shows a notice that
        // Claude Code isn't installed: its ids move on, and the index is written again.)
        await Bun.sleep(200);
        if (kind === "native") expect(stat()).toBe(was);
        // Opened with its last turns, then all asked for at once (Find, the agents' list): all of them, as built.
        await open(t.id, { last: 5 });
        expect(unset(await everything(t.id))).toEqual(built);
        await close(t.id);
    }, 60_000);
}

// An index of the format before this one (the whole index one line of JSON) isn't read: the session is built from its
// logs, all of it, and written in this one as it's let go of.
test("a session whose store is of the version before opens with all its turns", async () => {
    const cwd = join(tempDir("cavvy-turn-store-v3-"), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items: 1500, kind: "native", seed: 13 });
    const built = await everything(t.id);
    await close(t.id);
    const index = storeOf(t.file, t.id);
    for (let i = 0; i < 200 && !existsSync(index); i++) await Bun.sleep(10);
    // As the version before wrote it, its logs as they are (it would be read, were it of this version), and no turns.
    const lines = readFileSync(index, "utf-8").trimEnd().split("\n");
    const meta = JSON.parse(lines.at(-1)!);
    writeFileSync(index, JSON.stringify({ v: 3, logs: meta.logs, ids: meta.ids, turns: [], agents: [], ui: meta.ui }));
    expect(unset(await everything(t.id))).toEqual(built);
    await close(t.id);
    for (let i = 0; i < 200 && !existsSync(index); i++) await Bun.sleep(10);
    expect(JSON.parse(readFileSync(index, "utf-8").trimEnd().split("\n").at(-1)!).v).toBe(4);
    expect(unset(await everything(t.id))).toEqual(built);
    await close(t.id);
}, 60_000);

test("a session opened from its store with its last turns read rewinds as one opened whole does", async () => {
    const outline = (turns: Turn[]) => turns.map((x) => [x.prompt?.text, x.status, x.pos, x.archived, x.blocks.map((b) => b.t)]);
    const rewound: unknown[] = [];
    for (const partly of [false, true]) {
        const cwd = join(tempDir("cavvy-turn-store-rewind-partly-"), "project");
        mkdirSync(cwd, { recursive: true });
        const t = writeThread({ cwd, items: 3000, kind: "native", seed: 14 });
        await open(t.id);
        await close(t.id);
        storedFirst.turns = partly ? 20 : 1000;
        try {
            const snap = await open(t.id, { last: 5 });
            const last = snap.turns.at(-1)!.pos!.index;
            const plan = await call("session.rewindPlan", { id: t.id, index: last });
            await call("session.rewind", { id: t.id, index: last, planId: plan.planId, code: false, conversation: true });
            await until(t.id, (v) => !v.turns.some((x) => x.id === snap.turns.at(-1)!.id));
            await close(t.id);
        } finally {
            storedFirst.turns = 20;
        }
        await open(t.id);
        await call("session.find", { id: t.id, query: "" });
        await fillThoughts(t.id);
        rewound.push(outline(views.get(t.id)!.turns));
        await close(t.id);
    }
    expect(rewound[1]).toEqual(rewound[0]);
}, 120_000);

test("a store read from its end, its earlier turns a few at a time, reads what it would whole", async () => {
    const dir = tempDir("cavvy-turn-store-partly-");
    const log = join(dir, "s.jsonl");
    writeFileSync(log, '{"t":"meta"}\n');
    const store = TurnStore.of(log, "s", [log]);
    const turns = Array.from({ length: 6 }, (_, i) => ({ head: { id: `t${i}`, startedAt: i, status: "done" } as never, ...store.put({ id: `t${i}`, startedAt: i, status: "done", blocks: [{ t: "text", id: `b${i}`, text: `turn ${i} ${"x".repeat(i * 3000)}` }] } as Turn) }));
    const agent = (id: string, turnId: string, more: object = {}) => ({ head: { id, turnId, description: id, status: "done", startedAt: 1, ...more } as never });
    // Each turn's, one at work of the first turn, a background task's, one of no turn; and one failed.
    const agents = [agent("a0", "t0"), agent("a1", "t1", { status: "failed" }), agent("live", "t0", { status: "running" }), agent("a4", "t4"), agent("task", "t2", { taskId: "x" }), agent("lost", "none"), agent("a5", "t5")];
    await store.writeIndex(turns, agents, 7, { state: {}, created: true }, undefined, "first prompt");
    store.close();
    const whole = TurnStore.of(log, "s", [log]).read()!;
    expect(whole.heads).toEqual(turns);
    expect(whole.agents.map((a) => a.head.id)).toEqual(agents.map((a) => (a.head as { id: string }).id));
    expect(whole.earlier).toBeUndefined();
    const partly = TurnStore.of(log, "s", [log]);
    const end = partly.read(2)!;
    expect(end.heads.map((x) => x.head.id)).toEqual(["t4", "t5"]);
    // Those of its last turns, and those kept with them whatever their turn, in their order.
    expect(end.agents.map((a) => a.head.id)).toEqual(["live", "a4", "task", "lost", "a5"]);
    expect(end).toMatchObject({ ids: 7, first: "first prompt", earlier: { turns: 4, agents: 2, failed: 1 } });
    expect(partly.partial).toBe(true);
    const next = partly.readEarlier(3);
    expect(next.heads.map((x) => x.head.id)).toEqual(["t1", "t2", "t3"]);
    expect(next.agents.map((a) => a.head.id)).toEqual(["a1"]);
    const rest = partly.readEarlier();
    expect(rest.heads.map((x) => x.head.id)).toEqual(["t0"]);
    expect(rest.agents.map((a) => a.head.id)).toEqual(["a0"]);
    expect(partly.partial).toBe(false);
    expect(partly.readEarlier()).toEqual({ heads: [], agents: [] });
    for (const x of [...end.heads, ...next.heads, ...rest.heads]) expect(partly.get<Turn>(x.at, x.len).id).toBe(x.head.id);
    // Nothing changed since it was read: as it says, whatever was read of it.
    expect(partly.unchanged(6, 7, 7)).toBe(true);
    partly.close();
});

test("a turn taken after opening from the store is kept, and the session opens as building it again would", async () => {
    const cwd = join(tempDir("cavvy-turn-store-turn-"), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items: 1500, kind: "native", seed: 5 });
    await open(t.id);
    await close(t.id);
    await open(t.id);
    await call("session.send", { id: t.id, text: "One more thing" });
    await until(t.id, (v) => v.turns.at(-1)?.prompt?.text === "One more thing" && v.turns.at(-1)!.status === "done" && !v.state.busy);
    await call("session.find", { id: t.id, query: "" });
    await fillThoughts(t.id);
    const shown = unset({ turns: views.get(t.id)!.turns });
    await close(t.id);

    // As it was shown.
    const stored = await everything(t.id);
    expect({ turns: stored.turns }).toEqual(shown);
    await close(t.id);
    // And as building it from its logs makes it: the same turns, the same parts (a live turn has a little more of
    // some, such as how long it thought), numbered as they were built.
    rmSync(dirname(storeOf(t.file, t.id)), { recursive: true, force: true });
    const rebuilt = await everything(t.id);
    const outline = (x: { turns: Turn[] }) => x.turns.map((t) => [t.prompt?.text, t.status, t.blocks.map((b) => b.t)]);
    expect(outline(stored)).toEqual(outline(rebuilt));
    await close(t.id);
}, 60_000);

test("a session opened and closed with nothing changed leaves its index as it was; a change writes it again", async () => {
    const cwd = join(tempDir("cavvy-turn-store-same-"), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items: 1500, kind: "native", seed: 9 });
    const index = storeOf(t.file, t.id);
    const stat = () => { const s = statSync(index); return `${s.ino}:${s.mtimeMs}`; };
    await open(t.id);
    await close(t.id);
    for (let i = 0; i < 200 && !existsSync(index); i++) await Bun.sleep(10);
    const first = stat();
    // Opened from it, read, closed: nothing to write (an index is written whole, by a new file put in its place).
    await open(t.id);
    await call("session.find", { id: t.id, query: "" });
    await close(t.id);
    await Bun.sleep(300);
    expect(stat()).toBe(first);
    // A turn more: written again, and opens with it.
    await open(t.id);
    await call("session.send", { id: t.id, text: "One more thing" });
    await until(t.id, (v) => v.turns.at(-1)?.prompt?.text === "One more thing" && v.turns.at(-1)!.status === "done" && !v.state.busy);
    await close(t.id);
    for (let i = 0; i < 200 && stat() === first; i++) await Bun.sleep(10);
    expect(stat()).not.toBe(first);
    const again = await open(t.id);
    expect(again.turns.at(-1)?.prompt?.text).toBe("One more thing");
    await close(t.id);
}, 60_000);

test("a store not written whole, or of another version, isn't read", async () => {
    const dir = tempDir("cavvy-turn-store-unit-");
    const log = join(dir, "s.jsonl");
    writeFileSync(log, '{"t":"meta"}\n');
    const store = TurnStore.of(log, "s", [log]);
    const at = store.put({ id: "t1", startedAt: 1, status: "done", blocks: [{ t: "text", id: "b", text: "hello" }] } as Turn);
    expect(store.get(at.at, at.len)).toMatchObject({ id: "t1", blocks: [{ text: "hello" }] });
    // No index yet (it's written last): nothing.
    expect(TurnStore.of(log, "s", [log]).read()).toBeUndefined();
    await store.writeIndex([{ head: { id: "t1", startedAt: 1, status: "done" } as never, ...at }], [], 1, { state: {}, created: true });
    store.close();
    const read = TurnStore.of(log, "s", [log]).read();
    expect(read?.heads).toHaveLength(1);
    // The log changed since: nothing.
    appendFileSync(log, '{"t":"title","title":"x"}\n');
    expect(TurnStore.of(log, "s", [log]).read()).toBeUndefined();
});

test("a store that's mostly old versions of its turns is rewritten without them", async () => {
    const dir = tempDir("cavvy-turn-store-compact-");
    const log = join(dir, "s.jsonl");
    writeFileSync(log, '{"t":"meta"}\n');
    const store = TurnStore.of(log, "s", [log]);
    const turn = (n: number) => ({ id: "t1", startedAt: 1, status: "done", blocks: [{ t: "text", id: "b", text: `${n} `.padEnd(1024 * 1024, "x") }] }) as Turn;
    let at = store.put(turn(0));
    // Few old versions: left as they are.
    expect(await store.compact([at])).toBeUndefined();
    for (let n = 1; n <= 12; n++) at = store.put(turn(n));
    const moved = (await store.compact([at]))!;
    expect(store.size).toBe(at.len + 1);
    expect(store.get(moved.get(at.at)!, at.len)).toEqual(turn(12));
    store.close();
});

/** Ids as where they first appear: two builds that number the same turns in another order compare equal. */
function canon(x: unknown) {
    const ids = new Map<string, string>();
    const walk = (v: unknown, key = ""): unknown => {
        if (typeof v === "string" && /(^id$|Id$)/.test(key)) {
            if (!ids.has(v)) ids.set(v, `id${ids.size}`);
            return ids.get(v);
        }
        if (Array.isArray(v)) return v.map((e) => walk(e, key));
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, e]) => [k, walk(e, k)]));
        return v;
    };
    return walk(x);
}

// A compacted session opened the first time: its last segment's turns built and sent first, the earlier ones after.
// All of them are what building them at once makes; a window asking for its last turns isn't kept waiting for the rest.
// A Claude Code session (never compacted here) likewise: its last prompts' turns from the end of its GUI log, the rest after.
for (const [kind, what] of [["native", "a compacted session"], ["cli", "a long Claude Code session"]] as const)
test(`${what} opened the first time is built from its latest turns, and comes out as built all at once`, async () => {
    const cwd = join(tempDir("cavvy-turn-store-tail-"), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items: 3000, kind, seed: 11 });
    // Its last 10 prompts' turns first (a session of 3,000 items has fewer than the 100 it's built from otherwise).
    const prompts = turnBuilding.tailPrompts;
    turnBuilding.tailPrompts = 10;
    const file = findSessionAnywhere(t.id)!;
    const forget = () => {
        for (const f of [storeOf(file, t.id), storeOf(file, t.id).replace(/\.json$/, ".jsonl"), join(dirname(file), "state", `${t.id}.json`)]) rmSync(f, { force: true });
    };
    turnBuilding.tailFirst = false;
    let whole;
    try {
        whole = await everything(t.id);
        await close(t.id);
    } finally {
        turnBuilding.tailFirst = true;
    }
    forget();
    // Its last turns: at once, with at least the earlier segments' compactions counted before them.
    const first = (await call("session.open", { id: t.id, last: 5 })) as SessionSnapshot;
    expect(first.turns.length).toBe(5);
    expect(first.earlier).toBeGreaterThan(0);
    await close(t.id);
    forget();
    const tail = await everything(t.id);
    await close(t.id);
    turnBuilding.tailPrompts = prompts;
    expect(canon(tail)).toEqual(canon(whole));
}, 120_000);

// A turn coming while the earlier turns are still being built (the notice a Claude Code session opens with here, where
// it isn't installed; a prompt sent at once) started putting the latest ones in the store; the build, done, put them
// there again from scratch, after the first had let go of them: those came out empty, there and in every open after.
test("a long Claude Code session opened the first time, a turn coming while its earlier turns are built: none comes out empty", async () => {
    const cwd = join(tempDir("cavvy-turn-store-tail-turn-"), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items: 8000, kind: "cli", seed: 11 });
    const file = findSessionAnywhere(t.id)!;
    const forget = () => {
        for (const f of [storeOf(file, t.id), storeOf(file, t.id).replace(/\.json$/, ".jsonl"), join(dirname(file), "state", `${t.id}.json`)]) rmSync(f, { force: true });
    };
    const prompts = turnBuilding.tailPrompts;
    turnBuilding.tailFirst = false;
    let whole;
    try {
        whole = await everything(t.id);
        await close(t.id);
    } finally {
        turnBuilding.tailFirst = true;
    }
    forget();
    // More of its last turns first than the store starts at (KEEP_BUILT + EXTRA_BUILT).
    turnBuilding.tailPrompts = 80;
    try {
        await call("session.open", { id: t.id, last: 5 });
        const tail = await everything(t.id);
        await close(t.id);
        expect(canon(tail)).toEqual(canon(whole));
        // And opened again, from its store.
        const again = await everything(t.id);
        await close(t.id);
        expect(canon(again)).toEqual(canon(whole));
    } finally {
        turnBuilding.tailPrompts = prompts;
    }
}, 180_000);

// Opened the first time, its turns are put in its store a slice at a time after the window is sent them. A new turn
// meanwhile (a notice: Claude Code isn't installed here) left the rest to that: it put them all there at once, and
// held the server 1.1 s for a session of 100,000 items.
test("a long session opened the first time puts its turns in its store a slice at a time, a new turn meanwhile too", async () => {
    const cwd = join(tempDir("cavvy-turn-store-slices-"), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items: 1500, kind: "cli", seed: 9 });
    // How many go in the store in each task (a slice of no time: a turn, or a sub-agent, at a time).
    const put = TurnStore.prototype.put;
    let inTask = 0;
    let most = 0;
    let all = 0;
    TurnStore.prototype.put = function (this: InstanceType<typeof TurnStore>, ...args: Parameters<typeof put>) {
        inTask++;
        all++;
        most = Math.max(most, inTask);
        return put.apply(this, args);
    };
    let ticking = true;
    const tick = () => {
        inTask = 0;
        if (ticking) setImmediate(tick);
    };
    const slice = turnStoring.sliceMs;
    turnStoring.sliceMs = 0;
    try {
        tick();
        const snap = await open(t.id, { last: 10 });
        expect(snap.earlier).toBeGreaterThan(50);
        // Done: nothing more put for a while.
        for (let last = -1; last !== all; ) {
            last = all;
            await Bun.sleep(200);
        }
        expect(all).toBeGreaterThan(50);
        // A turn (or a sub-agent), and one more a change in the same task put there.
        expect(most).toBeLessThanOrEqual(2);
    } finally {
        ticking = false;
        turnStoring.sliceMs = slice;
        TurnStore.prototype.put = put;
    }
    await close(t.id);
}, 60_000);

test("a session that grows long while it's open lets go of its older turns then, and opens again as it was", async () => {
    const cwd = join(tempDir("cavvy-turn-store-grows-"), "project");
    mkdirSync(cwd, { recursive: true });
    const snap = (await call("session.create", { cwd })) as SessionSnapshot;
    const id = snap.state.id;
    views.set(id, { turns: structuredClone(snap.turns), agents: [], seq: snap.seq, state: snap.state });
    // Past the latest 20 and the 50 more a session keeps built before it has a store (runtime.ts KEEP_BUILT, EXTRA_BUILT).
    for (let i = 0; i < 75; i++) {
        await call("session.send", { id, text: `Prompt ${i}` });
        await until(id, (v) => v.turns.at(-1)?.prompt?.text === `Prompt ${i}` && v.turns.at(-1)!.status === "done" && !v.state.busy);
    }
    // Its earlier turns, from the store while it's open.
    const sessionFile = findSessionAnywhere(id)!;
    expect(existsSync(join(dirname(sessionFile), "turns", `${id}.jsonl`))).toBe(true);
    const page = await call("session.turns", { id, before: views.get(id)!.turns.at(-1)!.id, all: true });
    expect(page.turns.map((t: Turn) => t.prompt?.text)).toEqual(Array.from({ length: 74 }, (_, i) => `Prompt ${i}`));
    await call("session.find", { id, query: "" });
    await fillThoughts(id);
    const shown = unset({ turns: views.get(id)!.turns });
    await close(id);
    expect(unset({ turns: (await everything(id)).turns })).toEqual(shown);
    await close(id);
}, 120_000);

// A store whose turns can't be read (cut short by a power cut, damaged) isn't the session's undoing: it opens, built
// from its logs as it was before it had a store. (It didn't open at all: "JSON Parse error", every time.)
test("a session whose store is damaged opens anyway, built from its logs", async () => {
    const cwd = join(tempDir("cavvy-turn-store-damaged-"), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items: 1500, kind: "native", seed: 5 });
    const whole = await everything(t.id);
    await close(t.id);
    const file = findSessionAnywhere(t.id)!;
    const data = storeOf(file, t.id).replace(/\.json$/, ".jsonl");
    expect(existsSync(data)).toBe(true);
    // Its last 4 KB zeroed: the latest turns, which an open reads first.
    const size = Bun.file(data).size;
    const fd = openSync(data, "r+");
    writeSync(fd, Buffer.alloc(Math.min(4096, size)), 0, Math.min(4096, size), Math.max(0, size - 4096));
    closeSync(fd);
    expect(canon(await everything(t.id))).toEqual(canon(whole));
    await close(t.id);
    // And again: put in the store afresh.
    expect(canon(await everything(t.id))).toEqual(canon(whole));
    await close(t.id);
}, 120_000);

// One of its earlier turns damaged (read only as it's sent: an open sends a session whole here): found as it's sent, the
// session is let go of and opened again from its logs, at once; its store isn't indexed again over the damage either.
test("a session whose store has an earlier turn damaged opens whole", async () => {
    const cwd = join(tempDir("cavvy-turn-store-damaged-early-"), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items: 1500, kind: "native", seed: 6 });
    const whole = await everything(t.id);
    await close(t.id);
    const data = storeOf(findSessionAnywhere(t.id)!, t.id).replace(/\.json$/, ".jsonl");
    // Its first turn's line, the session's oldest.
    const fd = openSync(data, "r+");
    writeSync(fd, Buffer.alloc(64), 0, 64, 0);
    closeSync(fd);
    expect(canon(await everything(t.id))).toEqual(canon(whole));
    await close(t.id);
    expect(canon(await everything(t.id))).toEqual(canon(whole));
    await close(t.id);
}, 120_000);

// Still at work (a command running in it) as it's opened again with a damaged turn among those sent: it isn't let go of
// to be built again (that would stop the command); the open fails as it did, and its work goes on.
test("a session at work isn't let go of to rebuild a damaged store", async () => {
    const cwd = join(tempDir("cavvy-turn-store-damaged-busy-"), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items: 1500, kind: "native", seed: 8 });
    await everything(t.id);
    await close(t.id);
    const data = storeOf(findSessionAnywhere(t.id)!, t.id).replace(/\.json$/, ".jsonl");
    const fd = openSync(data, "r+");
    writeSync(fd, Buffer.alloc(64), 0, 64, 0);
    closeSync(fd);
    await open(t.id, { last: 1 });
    await call("session.send", { id: t.id, text: "!sleep 3; echo still-working" });
    await until(t.id, (v) => v.state.busy === true);
    await close(t.id);
    await open(t.id).catch(() => undefined);
    await open(t.id, { last: 1 });
    expect(views.get(t.id)!.state.busy).toBe(true);
    await until(t.id, (v) => !v.state.busy);
    expect(JSON.stringify(views.get(t.id)!.turns.at(-1))).toContain("still-working");
    await close(t.id);
}, 120_000);

test("a rewind builds only the turns since the last compaction again, and they're what building all of them makes", async () => {
    const cwd = join(tempDir("cavvy-turn-store-rewind-"), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items: 3000, kind: "native", seed: 8 });
    const snap = await open(t.id);
    await call("session.find", { id: t.id, query: "" });
    const before = views.get(t.id)!.turns;
    const last = before.at(-1)!.pos!.index;
    const plan = await call("session.rewindPlan", { id: t.id, index: last });
    await call("session.rewind", { id: t.id, index: last, planId: plan.planId, code: false, conversation: true });
    await until(t.id, (v) => !v.turns.some((x) => x.id === before.at(-1)!.id));
    // All of them (the reset sent the window its last 100).
    await open(t.id);
    await call("session.find", { id: t.id, query: "" });
    const outline = (turns: Turn[]) => turns.map((x) => [x.prompt?.text, x.status, x.pos, x.archived, x.blocks.map((b) => b.t)]);
    // Earlier turns are those it had (the same ids): only the last segment's were built again.
    const after = views.get(t.id)!.turns;
    expect(after.length).toBe(before.length - 1);
    const segment = before.at(-1)!.pos!.seg;
    expect(segment).toBeGreaterThan(0);
    const firstOfSegment = before.findIndex((x) => x.pos?.seg === segment);
    expect(after.slice(0, firstOfSegment + 1).map((x) => x.id)).toEqual(before.slice(0, firstOfSegment + 1).map((x) => x.id));
    expect(snap.turns.length).toBe(before.length);
    await fillThoughts(t.id);
    const rewound = outline(views.get(t.id)!.turns);
    await close(t.id);
    // Built from its logs, all of it.
    rmSync(dirname(storeOf(t.file, t.id)), { recursive: true, force: true });
    rmSync(join(dirname(t.file), "state"), { recursive: true, force: true });
    await open(t.id);
    await fillThoughts(t.id);
    expect(outline(views.get(t.id)!.turns)).toEqual(rewound);
    await close(t.id);
}, 60_000);
