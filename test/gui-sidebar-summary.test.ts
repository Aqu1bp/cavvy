import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { Interaction, SessionOp, SessionState, SessionSummary, Turn } from "../src/server/protocol";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { Runtime } = await import("../src/server/runtime");
const { Session } = await import("../src/agent/session");
const { applyOp } = await import("../src/server/timeline");
afterAll(() => iso.cleanup());

// Exercise the real summary and interaction transitions without a model, socket,
// workspace hooks, or credentials. Only the timeline's persistence is omitted.
function fixture() {
    const engine = new Engine({ listModels: async () => [] });
    const session = Session.create(tempDir());
    session.push({ role: "user", content: [{ type: "text", text: "A prompt" }] });
    const view = {
        state: { status: "running", interactions: [], activity: { label: "Thinking", since: 100 } } as unknown as SessionState,
        turns: [{ id: "first", startedAt: 100, status: "running", blocks: [] }] as Turn[],
        agents: [],
    };
    const rt = Object.assign(Object.create(Runtime.prototype), {
        engine, session, ws: { cwd: session.meta.cwd }, view, busy: true,
        lastActive: 100, turnId: "first", pending: new Map(), schedules: { poke() {} },
        op: (op: SessionOp) => applyOp(view, op),
    });
    const summaries: SessionSummary[] = [];
    engine.clients.add({ subs: new Set<string>(), send: (event: { type: string; session?: SessionSummary }) => {
        if (event.type === "sessions.upsert") summaries.push(event.session!);
    } } as never);
    return { engine, rt, view, summaries };
}

describe("sidebar summaries", () => {
    test("run metadata and outcome coexist with waiting kinds and visible turn timing", async () => {
        const { engine, rt, view } = fixture();
        writeFileSync(join(process.env.HARNESS_HOME!, "gui.json"), JSON.stringify({ runs: [{
            id: "run", label: "Compare models", cwd: "/original", sessions: [{ id: rt.id, model: "mock:a", modelName: "Model A" }],
        }] }));
        view.state.status = "waiting";
        view.state.interactions = [{ id: "ask", kind: "plan" } as Interaction];
        expect(engine.summaryOf(rt)).toMatchObject({
            waitingKind: "plan", turnStartedAt: 100,
            run: { id: "run", label: "Compare models", cwd: "/original", model: "mock:a", modelName: "Model A", outcome: "working" },
        });
        rt.busy = false;
        view.state.status = "idle";
        view.turns[0]!.status = "done";
        expect(engine.summaryOf(rt).run?.outcome).toBe("done");
        expect(engine.summaryOf(rt).waitingKind).toBeUndefined();
        expect(engine.summaryOf(rt).turnStartedAt).toBeUndefined();
        view.turns[0]!.status = "aborted";
        expect(engine.summaryOf(rt).run?.outcome).toBe("stopped");
        await engine.stop();
    });

    test("pending kinds are available even without a subscribed session", async () => {
        const { engine, rt, view } = fixture();
        for (const kind of ["permission", "question", "plan", "secret"] as const) {
            view.state.status = "waiting";
            view.state.interactions = [{ id: "request", kind } as Interaction];
            expect(engine.summaryOf(rt)).toMatchObject({ status: "waiting", waitingKind: kind, turnStartedAt: 100 });
        }
        view.state.status = "running";
        expect(engine.summaryOf(rt).waitingKind).toBeUndefined();
        await engine.stop();
    });

    test("answering the first of several requests publishes the remaining kind", async () => {
        const { engine, rt, view, summaries } = fixture();
        const question: Interaction = { kind: "question", id: "question", question: "Which?", options: [], multi: false };
        const plan: Interaction = { kind: "plan", id: "plan", plan: "A plan" };
        view.state.status = "waiting";
        view.state.interactions = [question, plan];
        for (const interaction of view.state.interactions) rt.pending.set(interaction.id, { interaction, resolve: () => {} });
        rt.respond("question", { kind: "question", answers: ["yes"] });
        expect(summaries.at(-1)).toMatchObject({ status: "waiting", waitingKind: "plan" });
        rt.respond("plan", { kind: "plan", approved: true });
        expect(summaries.at(-1)).toMatchObject({ status: "running" });
        expect(summaries.at(-1)?.waitingKind).toBeUndefined();
        await engine.stop();
    });

    test("working time follows the visible turn, not tool activity or the initial queued turn", async () => {
        const { engine, rt, view } = fixture();
        view.state.activity = { label: "Reading", since: 400 };
        expect(engine.summaryOf(rt).turnStartedAt).toBe(100);
        view.turns[0]!.status = "done";
        view.turns.push({ id: "queued", startedAt: 500, status: "running", blocks: [] });
        rt.turnId = "queued";
        view.state.activity = { label: "Writing", since: 700 };
        expect(engine.summaryOf(rt).turnStartedAt).toBe(500);
        // Manual compaction has no visible turn; its own activity is the clock.
        rt.turnId = undefined;
        expect(engine.summaryOf(rt).turnStartedAt).toBe(700);
        rt.busy = false;
        view.state.status = "idle";
        expect(engine.summaryOf(rt).turnStartedAt).toBeUndefined();
        await engine.stop();
    });
    test("waiting sessions survive the server list limit; opening an old result supplies its summary", async () => {
        const { engine, rt, view, summaries } = fixture();
        engine.runtimes.set(rt.id, rt);
        view.state.status = "waiting";
        view.state.interactions = [{ id: "ask", kind: "question" } as Interaction];
        expect(engine.listSessions(0).map((s) => s.id)).toContain(rt.id);
        view.state.status = "idle";
        rt.busy = false;
        expect(engine.listSessions(0).map((s) => s.id)).not.toContain(rt.id);
        rt.snapshot = () => ({ state: view.state, turns: view.turns, seq: 0 });
        const client = [...engine.clients][0]!;
        await engine.handle(client, "session.open", { id: rt.id });
        expect(summaries.at(-1)).toMatchObject({ id: rt.id, status: "idle" });
        expect(client.subs.has(rt.id)).toBe(true);
        // This fixture never booted Runtime's persistence/cleanup resources.
        engine.runtimes.clear();
        await engine.stop();
    });

});
