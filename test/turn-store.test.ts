// A long session's turns are kept in its turn store as it's let go of (src/server/turn-store.ts), and it opens from
// there next time: what the window is sent then is what building it from its logs would send, and a session whose
// logs changed since is built from them again.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
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

test("a store not written whole, or of another version, isn't read", () => {
    const dir = tempDir("cavvy-turn-store-unit-");
    const log = join(dir, "s.jsonl");
    writeFileSync(log, '{"t":"meta"}\n');
    const store = TurnStore.of(log, "s", [log]);
    const at = store.put({ id: "t1", startedAt: 1, status: "done", blocks: [{ t: "text", id: "b", text: "hello" }] } as Turn);
    expect(store.get(at.at, at.len)).toMatchObject({ id: "t1", blocks: [{ text: "hello" }] });
    // No index yet (it's written last): nothing.
    expect(TurnStore.of(log, "s", [log]).read()).toBeUndefined();
    store.writeIndex([{ head: { id: "t1", startedAt: 1, status: "done" } as never, ...at }], [], 1, { state: {}, created: true });
    store.close();
    const read = TurnStore.of(log, "s", [log]).read();
    expect(read?.heads).toHaveLength(1);
    // The log changed since: nothing.
    appendFileSync(log, '{"t":"title","title":"x"}\n');
    expect(TurnStore.of(log, "s", [log]).read()).toBeUndefined();
});

test("a store that's mostly old versions of its turns is rewritten without them", () => {
    const dir = tempDir("cavvy-turn-store-compact-");
    const log = join(dir, "s.jsonl");
    writeFileSync(log, '{"t":"meta"}\n');
    const store = TurnStore.of(log, "s", [log]);
    const turn = (n: number) => ({ id: "t1", startedAt: 1, status: "done", blocks: [{ t: "text", id: "b", text: `${n} `.padEnd(1024 * 1024, "x") }] }) as Turn;
    let at = store.put(turn(0));
    // Few old versions: left as they are.
    expect(store.compact([at])).toBeUndefined();
    for (let n = 1; n <= 12; n++) at = store.put(turn(n));
    const moved = store.compact([at])!;
    expect(store.size).toBe(at.len + 1);
    expect(store.get(moved.get(at.at)!, at.len)).toEqual(turn(12));
    store.close();
});

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
