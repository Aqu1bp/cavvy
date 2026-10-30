import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { sessionStatus } from "../gui/src/lib/session-status";
import { isolate, tempDir } from "./helpers/isolate";
import type { Interaction, SessionOp, SessionState, SessionSummary, Turn } from "../src/server/protocol";

const iso = isolate();
const { startMockLlm } = await import("../scripts/mock-llm");
const { Engine } = await import("../src/server/engine");
const { Runtime } = await import("../src/server/runtime");
const { Session, listAllSessions } = await import("../src/agent/session");
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
        writeFileSync(join(process.env.CAVVY_HOME!, "gui.json"), JSON.stringify({ runs: [{
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

    describe("a turn that leaves nothing in the history says it ended", () => {
        const mock = startMockLlm({ delayMs: 0 });
        const settings = join(process.env.CAVVY_HOME!, "settings.json");
        const providers = join(process.env.CAVVY_HOME!, "providers.json");
        afterAll(() => mock.stop());
        afterEach(() => {
            rmSync(settings, { force: true });
            rmSync(providers, { force: true });
        });
        const withModel = (hooks?: object) => {
            writeFileSync(providers, JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
            writeFileSync(settings, JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku", hooks }));
        };

        /** A new session, what it's sent, and every row the sidebar was sent for it until it's idle again. */
        async function rows(text: string, during?: (rt: InstanceType<typeof Runtime>) => void) {
            const engine = new Engine({ listModels: async () => [] });
            const sent: SessionSummary[] = [];
            engine.clients.add({ subs: new Set<string>(), send: (event: { type: string; session?: SessionSummary }) => {
                if (event.type === "sessions.upsert") sent.push(event.session!);
            } } as never);
            const rt = await engine.createSession(realpathSync(tempDir("sidebar-end-")), { mode: "bypassPermissions" });
            await rt.ready;
            // Empty, it isn't listed.
            engine.sessionChanged(rt);
            expect(sent).toEqual([]);
            const sending = rt.send(text);
            during?.(rt);
            await sending;
            while (rt.busy) await Bun.sleep(5);
            const model = rt.agent !== undefined;
            await engine.stop();
            return { model, sent, last: sent.at(-1)! };
        }

        function ended({ sent, last }: { sent: SessionSummary[]; last: SessionSummary }) {
            expect(sent[0]).toMatchObject({ status: "running", messages: 0 });
            expect(last).toMatchObject({ status: "idle", messages: 0 });
            expect(last.turnStartedAt).toBeUndefined();
            // Minutes later, as the row would show it.
            expect(sessionStatus(last, Date.now() + 480_000)).toBeUndefined();
        }

        test("a !command with no model", async () => {
            const r = await rows("!echo hi");
            expect(r.model).toBe(false);
            ended(r);
        });

        test("a !command as a new session's first message, with a model", async () => {
            withModel();
            const r = await rows("!echo hi");
            expect(r.model).toBe(true);
            ended(r);
        });

        test("a !command stopped while it runs", async () => {
            const r = await rows("!sleep 30", (rt) => setTimeout(() => rt.interrupt(), 50));
            ended(r);
        });

        test("a first prompt a hook blocks", async () => {
            withModel({ UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo no >&2; exit 2" }] }] });
            const r = await rows("hello");
            expect(r.model).toBe(true);
            ended(r);
        });
    });

    test("opening, repairing or renaming a saved session isn't work: it keeps its place, below one that worked since", async () => {
        const engine = new Engine({ listModels: async () => [] });
        const now = Date.now();
        const HOUR = 3_600_000;
        /** A saved session last written `ago` ms ago; `dangling`: it ends on a tool call without its result (a crash). */
        const saved = (text: string, ago: number, dangling = false) => {
            const s = Session.create(realpathSync(tempDir()));
            s.push({ role: "user", content: [{ type: "text", text }] });
            s.push({ role: "assistant", content: dangling ? [{ type: "tool_call", id: "call-1", name: "Bash", input: { command: "ls" } }] : [{ type: "text", text: "Done." }] } as never);
            s.release();
            utimesSync(s.path, (now - ago) / 1000, (now - ago) / 1000);
            return s;
        };
        const order = () => engine.listSessions().map((s) => s.id);
        const crashed = saved("Crashed two hours ago", 2 * HOUR, true);
        const older = saved("Worked an hour ago", HOUR);
        const renamed = saved("Worked three hours ago", 3 * HOUR);
        const newer = saved("Worked a minute ago", 60_000);
        try {
            const rt = engine.openSession(older.meta.id);
            await rt.ready;
            expect(Math.round(engine.summaryOf(rt).updatedAt)).toBe(Math.round(now - HOUR));
            // What opening it writes (its model, a title) doesn't move it, open or closed again.
            rt.rename("A new name");
            expect(statSync(older.path).mtimeMs).toBeGreaterThan(now - 1000);
            expect(order().indexOf(newer.meta.id)).toBeLessThan(order().indexOf(older.meta.id));
            // As its file says, for when it's closed again.
            expect(Math.round(listAllSessions().find((s) => s.id === older.meta.id)!.updatedAt)).toBe(Math.round(now - HOUR));

            // Loading repairs a crashed session's file before anything else: still where it was.
            const repaired = engine.openSession(crashed.meta.id);
            await repaired.ready;
            expect(repaired.session.messages.length).toBe(3);
            expect(statSync(crashed.path).mtimeMs).toBeGreaterThan(now - 1000);
            expect(Math.round(engine.summaryOf(repaired).updatedAt)).toBe(Math.round(now - 2 * HOUR));

            // Renamed from the sidebar without opening it.
            const client = { subs: new Set<string>(), send() {} } as never;
            await engine.handle(client, "session.rename", { id: renamed.meta.id, title: "Renamed" });
            expect(statSync(renamed.path).mtimeMs).toBeGreaterThan(now - 1000);
            // All four in the order they last worked.
            const ids = order();
            const places = [newer, older, crashed, renamed].map((s) => ids.indexOf(s.meta.id));
            expect(places).not.toContain(-1);
            expect(places).toEqual([...places].sort((a, b) => a - b));
        } finally {
            await engine.stop();
        }
    });
});
