import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { Runtime } = await import("../src/server/runtime");
const { trashSession, trashDir } = await import("../src/server/session-delete");
const { Session } = await import("../src/agent/session");
afterAll(() => iso.cleanup());

function planningRuntime() {
    // Exercise the real interaction lifecycle without starting a provider or socket.
    const rt: any = Object.create(Runtime.prototype);
    Object.assign(rt, {
        session: Session.create(iso.home, { persist: false }),
        mode: "plan",
        pending: new Map(),
        handoffs: new Set(),
        abort: new AbortController(),
        runningTool: () => undefined,
        newId: () => "plan-request",
        setState() {},
        setStatus() {},
        backendModel: () => false,
        engine: { notify() {} },
        schedules: { poke() {} },
    });
    return rt;
}

test("native handoff answers the plan and aborts the turn before another model request", async () => {
    const rt = planningRuntime();
    const answer = rt.approvePlan("# Implement an isolated change");
    expect(rt.pending.size).toBe(1);
    expect(rt.handOffPlan("plan-request", "New session in /worktree")).toBe(true);
    expect(await answer).toEqual({ approved: false, feedback: "New session in /worktree", handoff: true });
    expect(rt.abort.signal.aborted).toBe(true);
    expect(rt.mode).toBe("plan");
    expect(rt.pending.size).toBe(0);
});

for (const provider of ["test", "claude-code"]) {
    test(`${provider} handoff returns queued shell input and attachments without executing in the source folder`, async () => {
        const cwd = join(realpathSync(iso.home), `queued-${provider}`);
        mkdirSync(cwd);
        const engine = new Engine({ listModels: async () => [] });
        const drafts: any[] = [];
        engine.draft = (_rt, text, attachments) => { drafts.push({ text, attachments }); };
        try {
            const rt = await engine.createSession(cwd, { mode: "plan" });
            await rt.ready;
            rt.session.meta.system = "Test";
            rt.session.setTitle("Plan handoff regression");
            const attachment = { type: "image" as const, mediaType: "image/png", data: "aGVsbG8=" };
            let runs = 0;
            let turnSignal: AbortSignal | undefined;
            Object.assign(rt, {
                model: { provider, id: "test" },
                agent: {
                    model: { provider, id: "test" },
                    // As the real Agent: told when a message to steer with is queued (the image message is one).
                    queueChanged() {},
                    // As the real Agent: its CLI's background work (none here), which keeps a session from counting as idle.
                    backgroundTasks: () => [],
                    async run(_parts: unknown, { signal }: { signal: AbortSignal }) {
                        runs++;
                        if (runs > 1) return "done";
                        turnSignal = signal;
                        const answer = (rt as any).approvePlan("# Implement in a worktree");
                        const interaction = rt.snapshot().state.interactions.find((i) => i.kind === "plan")!;
                        expect(await rt.send("!touch queued-command-ran")).toEqual({ queued: true });
                        expect(await rt.send("Follow up", [attachment])).toEqual({ queued: true });
                        expect(rt.handOffPlan(interaction.id, "Moved to a worktree")).toBe(true);
                        expect(await answer).toMatchObject({ approved: false, handoff: true });
                        return "aborted";
                    },
                },
            });
            await rt.startTurn("Make a plan");
            expect(rt.idle).toBe(true);
            expect(rt.mode).toBe("plan");
            expect(turnSignal?.aborted).toBe(true);
            expect(runs).toBe(1);
            expect(existsSync(join(cwd, "queued-command-ran"))).toBe(false);
            expect(drafts).toEqual([{ text: "!touch queued-command-ran\n\nFollow up", attachments: [attachment] }]);
            expect(rt.snapshot().state.queued).toEqual([]);
        } finally { await engine.stop(); }
    });
}

test("ordinary plan rejection keeps planning without aborting", async () => {
    const rt = planningRuntime();
    const answer = rt.approvePlan("# Refine a plan");
    rt.respond("plan-request", { kind: "plan", approved: false, feedback: "Explain the tests" });
    expect(await answer).toMatchObject({ approved: false, feedback: "Explain the tests" });
    expect(rt.abort.signal.aborted).toBe(false);
});

test("a plan cannot be approved during handoff and interruption prevents starting implementation", async () => {
    const engine: any = new Engine();
    const client = { subs: new Set<string>(), send() {} };
    let pending = true;
    let sent = false;
    let createStarted!: () => void;
    const started = new Promise<void>((resolve) => { createStarted = resolve; });
    let release!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const source = {
        id: "source", ws: { cwd: iso.home },
        session: { model: "test/model", accountId: () => "default" },
        planText: () => ({ id: "plan", text: "# Isolated change", interactionId: pending ? "interaction" : undefined }),
        respond() { throw new Error("The planning session must not be approved"); },
    };
    engine.runtimes.set(source.id, source);
    engine.madeWorktree = () => ({ path: iso.home, branch: "implementation" });
    engine.createSession = async () => {
        createStarted();
        await pause;
        return { id: "destination", async setModel() { return true; }, send() { sent = true; } };
    };
    const implementing = engine.handle(client, "session.implementPlan", {
        id: source.id, branch: "implementation", mode: "default", resume: iso.home,
    });
    await started;
    await expect(engine.handle(client, "session.respond", {
        id: source.id, interactionId: "interaction", response: { kind: "plan", approved: true, mode: "acceptEdits" },
    })).rejects.toMatchObject({ code: "busy" });
    await expect(engine.handle(client, "session.setMode", { id: source.id, mode: "acceptEdits" })).rejects.toMatchObject({ code: "busy" });
    pending = false;
    release();
    expect(await implementing).toMatchObject({ sessionId: "destination", failed: { code: "expired" } });
    expect(sent).toBe(false);
    expect(engine.implementing.size).toBe(0);
});

for (const interrupted of [false, true]) {
    test(interrupted ? "interruption during model setup prevents implementing an expired plan" : "model setup failure reports the new session that already exists", async () => {
        const engine: any = new Engine();
        const client = { subs: new Set<string>(), send() {} };
        let pending = true;
        let sent = false;
        const source = {
            id: "source", ws: { cwd: iso.home }, session: { model: "test/model", accountId: () => "default" },
            planText: () => ({ id: "plan", text: "# Isolated change", interactionId: pending ? "interaction" : undefined }),
        };
        engine.runtimes.set(source.id, source);
        engine.madeWorktree = () => ({ path: iso.home, branch: "implementation" });
        const destination = {
            id: "destination",
            async setModel(ref: string) {
                expect(ref).toBe("test/model");
                await Promise.resolve();
                if (interrupted) pending = false;
                else throw new Error("Provider setup failed");
                return true;
            },
            send() { sent = true; },
        };
        engine.createSession = async (_cwd: string, opts: { model?: string }) => {
            engine.runtimes.set(destination.id, destination);
            // Matches createSession: a model error occurs after registering the runtime.
            if (opts.model) await destination.setModel(opts.model);
            return destination;
        };
        const result = await engine.handle(client, "session.implementPlan", {
            id: source.id, branch: "implementation", mode: "default", resume: iso.home,
        });
        expect(result.sessionId).toBe(destination.id);
        expect(result.failed).toMatchObject(interrupted ? { code: "expired" } : { message: "Provider setup failed" });
        expect(engine.runtimes.get(result.sessionId)).toBe(destination);
        expect(sent).toBe(false);
        expect(engine.implementing.size).toBe(0);
    });
}

test("trash Undo waits while the session's worktree is reserved for removal without losing trash", async () => {
    const engine: any = new Engine();
    const client = { subs: new Set<string>(), send() {} };
    const cwd = join(realpathSync(iso.home), "restored-worktree");
    mkdirSync(cwd);
    const session = Session.create(cwd);
    session.push({ role: "user", content: [{ type: "text", text: "A saved session" }] });
    session.release();
    const id = session.meta.id;
    trashSession(id, { pinned: false, archived: false, settled: false });
    const trashed = join(trashDir(), id, "transcript.jsonl");
    engine.removing.add(cwd);
    await expect(engine.handle(client, "session.restore", { id })).rejects.toMatchObject({ code: "busy" });
    expect(existsSync(trashed)).toBe(true);
    expect(existsSync(session.path)).toBe(false);
    engine.removing.clear();
    await engine.handle(client, "session.restore", { id });
    expect(existsSync(session.path)).toBe(true);
    expect(existsSync(trashed)).toBe(false);
});

test("a plan with no selected or saved model fails before creating a worktree", async () => {
    const engine: any = new Engine();
    const client = { subs: new Set<string>(), send() {} };
    engine.runtimes.set("source", {
        id: "source", session: {}, ws: { cwd: iso.home },
        planText: () => ({ id: "plan", text: "# Implement" }),
    });
    let made = false;
    engine.madeWorktree = () => { made = true; throw new Error("Must not create a worktree"); };
    await expect(engine.handle(client, "session.implementPlan", { id: "source", branch: "implementation", mode: "default", resume: iso.home })).rejects.toMatchObject({ code: "no_model" });
    expect(made).toBe(false);
});

test("an unavailable source model cannot silently start with the workspace default", async () => {
    const engine: any = new Engine();
    const client = { subs: new Set<string>(), send() {} };
    let sent = false;
    let handedOff = false;
    engine.runtimes.set("source", {
        id: "source", session: { model: "unavailable/model", accountId: () => "default" }, ws: { cwd: iso.home },
        planText: () => ({ id: "plan", text: "# Implement", interactionId: "waiting" }),
        handOffPlan() { handedOff = true; },
    });
    engine.madeWorktree = () => ({ path: iso.home, branch: "implementation" });
    engine.createSession = async () => ({
        id: "destination", model: { provider: "default", id: "other-model" },
        async setModel() { return false; },
        send() { sent = true; },
    });
    const result = await engine.handle(client, "session.implementPlan", { id: "source", branch: "implementation", mode: "default", resume: iso.home });
    expect(result).toMatchObject({ sessionId: "destination", failed: { code: "model_unavailable" } });
    expect(sent).toBe(false);
    expect(handedOff).toBe(false);
});
