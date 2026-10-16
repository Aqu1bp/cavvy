// Exercise the real RPC dispatcher without a listening server or a model service.
import { afterAll, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";
import type { Message } from "../src/providers/types";
import type { EngineClient } from "../src/server/engine";
import type { ServerEvent, SessionSnapshot, Turn } from "../src/server/protocol";

const iso = isolate();
const { Engine, RpcError } = await import("../src/server/engine");
const { Session, listSessions } = await import("../src/agent/session");
const { UiLog, promptKey } = await import("../src/server/history");
const { FileHistory } = await import("../src/agent/checkpoints");
afterAll(iso.cleanup);

const prompt = (text: string, checkpoint: number): Message => ({ role: "user", content: [{ type: "text", text }], meta: { kind: "prompt", checkpoint } });
const reply = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }], provider: "test", model: "test", stopReason: "end_turn" });
const prompted = (s: SessionSnapshot) => s.turns.filter((t) => t.prompt);
const shape = (t: Turn) => ({ prompt: t.prompt, blocks: t.blocks, status: t.status, startedAt: t.startedAt, endedAt: t.endedAt });

async function setup() {
    const engine = new Engine({ listModels: async () => [] });
    const session = Session.create(realpathSync(tempDir("fork-runtime-")), { system: "Frozen system" });
    session.push(prompt("first", 1000));
    session.push(reply("one"));
    session.push(prompt("second", 2000));
    session.push(reply("two"));
    session.setTitle("Questions");
    session.setModel("test:selected-now");
    session.setFastMode(true);
    session.recordUsage("test:test", { inputTokens: 100, outputTokens: 20 }, 0.5);
    const ui = new UiLog(session.path, session.meta.id, false);
    for (const index of [0, 2]) ui.write({ t: "turn", seg: 0, index, prompt: promptKey(session.messages[index]!), at: 100 + index, end: 200 + index, status: "done" });
    ui.close();
    session.release();
    const rt = engine.openSession(session.meta.id);
    await rt.ready;
    const events: ServerEvent[] = [];
    const client: EngineClient = { subs: new Set(), send: (e) => events.push(e) };
    engine.clients.add(client);
    const fork = (turn = prompted(rt.snapshot())[0]!, extra: Record<string, unknown> = {}) => engine.handle(client, "session.fork", { id: rt.id, index: turn.prompt!.index, text: turn.prompt!.text, turn: turn.id, ...extra });
    return { engine, rt, client, events, fork };
}

test("fork RPC preserves history, settings and times, broadcasts, and persists the mode with default effort", async () => {
    const { engine, rt, client, events, fork } = await setup();
    try {
        rt.setMode("acceptEdits");
        expect(rt.effort).toBeUndefined();
        const before = readFileSync(rt.session.path, "utf8");
        const original = rt.snapshot();
        const made = await fork();
        const f = engine.runtimes.get(made.state.id)!;
        expect(made.state).toMatchObject({ title: "Fork of Questions", mode: "acceptEdits", cost: 0, tokensIn: 0, tokensOut: 0, forkOf: { id: rt.id, title: "Questions" } });
        expect(f.session.messages).toEqual(rt.session.messages.slice(0, 2));
        expect(f.session.model).toBe("test:selected-now");
        expect(f.session.fastMode).toBe(true);
        expect(prompted(made).map(shape)).toEqual(prompted(original).slice(0, 1).map(shape));
        expect(client.subs.has(f.id)).toBe(true);
        expect(events.some((e) => e.type === "sessions.upsert" && e.session.id === f.id)).toBe(true);
        expect(readFileSync(rt.session.path, "utf8")).toBe(before);
        await f.close();
        engine.runtimes.delete(f.id);
        const reopened = engine.openSession(f.id);
        await reopened.ready;
        expect(reopened.snapshot().state.mode).toBe("acceptEdits");
        rt.setEffort("high");
        const latest = await fork(prompted(rt.snapshot())[1]!);
        expect(latest.state.effort).toBe("high");
        expect(engine.runtimes.get(latest.state.id)!.session.messages).toEqual(rt.session.messages);
    } finally {
        await engine.stop();
    }
});

test("invalid, running, archived and stale fork requests are RpcErrors and create no session", async () => {
    const { engine, rt, fork } = await setup();
    try {
        const turn = prompted(rt.snapshot())[0]!;
        const files = () => listSessions(rt.ws.cwd).map((s) => s.id).sort();
        const before = files();
        for (const extra of [{ id: "missing" }, { index: 0.5 }, { index: "0" }, { index: -1 }, { index: 999 }, { index: 1 }, { text: "stale" }, { turn: "stale" }]) {
            await expect(fork(turn, extra)).rejects.toBeInstanceOf(RpcError);
            expect(files()).toEqual(before);
        }
        // The current in-flight boundary is internal runtime state; the RPC path remains real.
        (rt as any).runStart = 2;
        await expect(fork(prompted(rt.snapshot())[1]!)).rejects.toThrow("still running");
        const earlier = await fork(turn);
        expect(engine.runtimes.get(earlier.state.id)!.session.messages).toEqual(rt.session.messages.slice(0, 2));
        (rt as any).runStart = undefined;
        const plan = rt.rewindPlan(0);
        await rt.rewind(0, plan.planId, false, true);
        await expect(fork(turn)).rejects.toBeInstanceOf(RpcError);
        rt.session.push(prompt("first", 3000));
        rt.session.push(reply("replacement"));
        (rt as any).rebuild();
        await expect(fork(turn)).rejects.toThrow("changed since this was shown");
        const current = prompted(rt.snapshot())[0]!;
        rt.session.compact("summary", [{ role: "user", content: [{ type: "text", text: "summary" }], meta: { kind: "summary" } }]);
        (rt as any).rebuild();
        await expect(fork(current)).rejects.toBeInstanceOf(RpcError);
    } finally {
        await engine.stop();
    }
});

test("fork rewind uses only its own file history and retains the pre-fork explanation", async () => {
    const { engine, rt, fork } = await setup();
    try {
        const history = FileHistory.for(rt.session)!;
        const file = `${rt.ws.cwd}/answer.txt`;
        history.begin("first", 1000);
        await history.write(file, Buffer.from("original session edit"));
        const made = await fork();
        const f = engine.runtimes.get(made.state.id)!;
        const plan = f.rewindPlan(0);
        expect(plan).toMatchObject({ forked: true, restore: [] });
        expect((await f.rewind(0, plan.planId, true, true)).restored).toEqual([]);
        expect(readFileSync(file, "utf8")).toBe("original session edit");
        const originPlan = rt.rewindPlan(0);
        expect(originPlan.restore).toHaveLength(1);
        expect((await rt.rewind(0, originPlan.planId, true, false)).restored).toEqual(["answer.txt"]);
    } finally {
        await engine.stop();
    }
});

test("imported responses can fork at either boundary while imported rewind remains disabled", async () => {
    const engine = new Engine({ listModels: async () => [] });
    try {
        const s = Session.create(realpathSync(tempDir("fork-imported-runtime-")));
        for (const [i, text] of ["first imported", "second imported"].entries()) {
            const p = prompt(text, 1000 + i);
            if (p.role === "user") p.meta = { ...p.meta, imported: true };
            s.push(p);
            s.push(reply(`answer ${i}`));
        }
        s.setImported({ source: "codex", id: "native-original", importedAt: Date.now(), messages: 4, omitted: 0 });
        s.release();
        const rt = engine.openSession(s.meta.id);
        await rt.ready;
        const client: EngineClient = { subs: new Set(), send() {} };
        expect(rt.rewindTargets()).toEqual([]);
        for (const [i, turn] of prompted(rt.snapshot()).entries()) {
            expect(turn.prompt!.index).toBeUndefined();
            const made = await engine.handle(client, "session.fork", { id: rt.id, index: turn.pos!.index, text: turn.prompt!.text, turn: turn.id });
            const f = engine.runtimes.get(made.state.id)!;
            expect(f.session.messages).toEqual(rt.session.messages.slice(0, (i + 1) * 2));
            expect(prompted(made)).toHaveLength(i + 1);
            expect(made.turns.some((t) => t.blocks.some((b) => b.t === "imported"))).toBe(true);
            expect(f.rewindTargets()).toEqual([]);
        }
    } finally {
        await engine.stop();
    }
});
