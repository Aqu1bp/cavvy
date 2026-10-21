// /goal in the GUI server: real turns on the mock model (scripts/mock-llm.ts),
// whose goal check says "not met" first and "met" after.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { startMockLlm } = await import("../scripts/mock-llm");
const mock = startMockLlm({ delayMs: 0 });
mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku", permissions: { allow: ["Bash"] } }));
const { Engine } = await import("../src/server/engine");
const { Session } = await import("../src/agent/session");
type Runtime = import("../src/server/runtime").Runtime;

afterAll(() => {
    mock.stop();
    iso.cleanup();
});

async function until(what: () => boolean, ms = 10_000) {
    const end = Date.now() + ms;
    while (!what()) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(10);
    }
}

const notices = (rt: Runtime) => rt.snapshot().turns.flatMap((t) => t.blocks.filter((b) => b.t === "notice").map((b) => (b as { text: string }).text));

test("/goal runs turns until the check says it's met, then clears; the GUI state follows", async () => {
    const engine = new Engine({ listModels: async () => [] });
    try {
        const cwd = realpathSync(tempDir("goal-rt-"));
        const rt = await engine.createSession(cwd, { mode: "bypassPermissions" });
        await rt.ready;
        const states: (string | null)[] = [];
        const orig = (rt as any).setState.bind(rt);
        (rt as any).setState = (patch: any) => {
            if ("goal" in patch) states.push(patch.goal?.state ?? null);
            return orig(patch);
        };
        // What the sidebar shows between turns: Working, with a start time, while the check runs.
        const sidebar: { status: string; since?: number; busy: boolean }[] = [];
        const changed = engine.sessionChanged.bind(engine);
        engine.sessionChanged = (r) => {
            if (r === rt) sidebar.push({ status: rt.status, since: rt.sidebarTurnStartedAt, busy: rt.busy });
            return changed(r);
        };
        const t0 = Date.now();
        expect((await rt.send("/goal goaldemo: the auth tests pass")).queued).toBe(false);
        await until(() => !rt.goal.active && !rt.busy);
        const turns = rt.snapshot().turns.filter((t) => t.prompt);
        expect(turns.map((t) => t.prompt!.text)).toEqual(["/goal goaldemo: the auth tests pass", "/goal · keep going"]);
        expect(turns.every((t) => t.prompt!.command)).toBe(true);
        const shown = notices(rt);
        expect(shown).toContain("◎ Goal not met yet: The conversation shows no linter run yet; run it and show that it's clean.");
        expect(shown.find((n) => n.startsWith("✓ Goal achieved: goaldemo: the auth tests pass (2 turns"))).toBeDefined();
        expect(states).toContain("checking");
        const between = sidebar.filter((x) => !x.busy && x.status === "running");
        expect(between.length).toBeGreaterThan(0);
        for (const x of between) expect(x.since).toBeGreaterThanOrEqual(t0);
        expect(rt.status).toBe("idle");
        expect(states.at(-1)).toBeNull();
        expect(rt.snapshot().state.goal).toBeUndefined();
        // The verdicts are kept with the session; the goal isn't.
        const saved = Session.load(rt.session.path);
        expect(saved.goal).toBeUndefined();
        expect(saved.notices.map((n) => n.text).some((t) => t.startsWith("✓ Goal achieved"))).toBe(true);
        // The second turn was told why it wasn't met.
        const second = rt.session.messages.filter((m) => m.role === "user" && m.meta?.kind === "command").at(-1)!;
        expect(JSON.stringify(second.content)).toContain("no linter run yet");
        // The check went to the small model, with the goal in its prompt.
        const checks = mock.requests.filter((r) => r.model === "mock-haiku" && r.prompt.includes("<goal>"));
        expect(checks).toHaveLength(2);
    } finally {
        await engine.stop();
    }
});

test("/goal status, pause, resume and clear answer at once, even mid-turn, and aren't queued", async () => {
    const engine = new Engine({ listModels: async () => [] });
    try {
        const rt = await engine.createSession(realpathSync(tempDir("goal-cmd-")), { mode: "bypassPermissions" });
        await rt.ready;
        await rt.send("/goal");
        expect(notices(rt).at(-1)).toBe("No goal set. /goal <condition> keeps working, turn after turn, until the condition holds.");
        await rt.send("/goal clear");
        expect(notices(rt).at(-1)).toBe("No goal set");
        // A turn is running: a new goal waits in the queue (with what's attached), and starts its own turn after.
        void rt.send("pause for a moment");
        await until(() => rt.busy);
        expect((await rt.send("/goal goaldemo: tests pass")).queued).toBe(true);
        expect(rt.snapshot().state.queued).toEqual(["/goal goaldemo: tests pass"]);
        expect(rt.snapshot().state.goal).toBeUndefined();
        await until(() => rt.snapshot().state.goal?.condition === "goaldemo: tests pass");
        // status and pause answer at once, mid-turn, without queueing.
        expect((await rt.send("/goal pause")).queued).toBe(false);
        expect(rt.snapshot().state.goal).toMatchObject({ state: "paused" });
        await until(() => !rt.busy);
        await Bun.sleep(50);
        // Paused: no further turn started after the goal's first.
        expect(rt.snapshot().turns.filter((t) => t.prompt).map((t) => t.prompt!.text)).toEqual(["pause for a moment", "/goal goaldemo: tests pass"]);
        await rt.send("/goal");
        expect(notices(rt).at(-1)).toStartWith("◎ Goal (paused): goaldemo: tests pass");
        await rt.send("/goal resume");
        await until(() => !rt.goal.active && !rt.busy);
        expect(notices(rt).some((n) => n.startsWith("✓ Goal achieved"))).toBe(true);
        await rt.send("/goal");
        expect(notices(rt).at(-1)).toBe("✓ Last goal achieved: goaldemo: tests pass");
        await expect(rt.send(`/goal ${"x".repeat(4001)}`)).rejects.toThrow("up to 4,000 characters");
    } finally {
        await engine.stop();
    }
});

test("an interrupt pauses the goal; the user's next message picks it up", async () => {
    const engine = new Engine({ listModels: async () => [] });
    try {
        const rt = await engine.createSession(realpathSync(tempDir("goal-int-")), { mode: "bypassPermissions" });
        await rt.ready;
        // "pause": the mock waits a moment before answering, time enough to interrupt.
        await rt.send("/goal the pause is over");
        await until(() => rt.busy);
        rt.interrupt();
        await until(() => !rt.busy);
        await until(() => rt.snapshot().state.goal?.state === "paused");
        expect(rt.goal.pending()).toBe(false);
        await rt.send("goaldemo now run the tests");
        await until(() => !rt.goal.active && !rt.busy);
        expect(notices(rt).some((n) => n.startsWith("✓ Goal achieved"))).toBe(true);
    } finally {
        await engine.stop();
    }
});

test("a reopened session gets its goal back, paused until the next message", async () => {
    const engine = new Engine({ listModels: async () => [] });
    try {
        const cwd = realpathSync(tempDir("goal-reopen-"));
        const s = Session.create(cwd);
        s.push({ role: "user", content: [{ type: "text", text: "hello" }], meta: { kind: "prompt" } });
        s.push({ role: "assistant", content: [{ type: "text", text: "hi" }], provider: "mock", model: "mock-opus", stopReason: "end_turn" });
        s.setGoal({ condition: "goaldemo: ship it", setAt: 1 });
        s.release();
        const rt = engine.openSession(s.meta.id);
        await rt.ready;
        expect(rt.snapshot().state.goal).toMatchObject({ condition: "goaldemo: ship it", state: "paused", turns: 0 });
        expect(rt.idle).toBe(true);
        await rt.send("/goal resume");
        await until(() => !rt.goal.active && !rt.busy);
        expect(notices(rt).some((n) => n.startsWith("✓ Goal achieved: goaldemo: ship it"))).toBe(true);
    } finally {
        await engine.stop();
    }
});

test("a !command queued during a goal turn runs, then the goal checks and goes on", async () => {
    const engine = new Engine({ listModels: async () => [] });
    try {
        const rt = await engine.createSession(realpathSync(tempDir("goal-shellq-")), { mode: "bypassPermissions" });
        await rt.ready;
        const before = mock.requests.length;
        // "pause": the goal's first turn waits a moment, time enough to queue the command.
        await rt.send("/goal goaldemo: the pause is over");
        await until(() => rt.busy);
        expect((await rt.send("!printf queued-shell-done")).queued).toBe(true);
        await until(() => !rt.goal.active && !rt.busy);
        expect(notices(rt).some((n) => n.startsWith("✓ Goal achieved: goaldemo: the pause is over"))).toBe(true);
        expect(mock.requests.slice(before).filter((r) => r.model === "mock-haiku" && r.prompt.includes("<goal>")).length).toBeGreaterThan(0);
    } finally {
        await engine.stop();
    }
}, 15_000);

test("a background shell still running holds the goal check until it exits", async () => {
    const engine = new Engine({ listModels: async () => [] });
    try {
        const rt = await engine.createSession(realpathSync(tempDir("goal-bgshell-")), { mode: "bypassPermissions" });
        await rt.ready;
        const shell = { id: "b1", command: "sleep 20", startedAt: Date.now(), output: "", readOffset: 0, exitCode: null as number | null };
        rt.toolState.shells.set(shell.id, shell as any);
        const before = mock.requests.length;
        const checks = () => mock.requests.slice(before).filter((r) => r.model === "mock-haiku" && r.prompt.includes("<goal>")).length;
        await rt.send("/goal goaldemo: the server answers");
        await until(() => rt.snapshot().state.goal?.state === "waiting");
        expect(checks()).toBe(0);
        expect(rt.goal.pending()).toBe(true);
        shell.exitCode = 0;
        await until(() => !rt.goal.active && !rt.busy);
        expect(checks()).toBe(2);
    } finally {
        await engine.stop();
    }
}, 15_000);

test("scheduled prompts wait while a goal is between turns, and leave a paused goal paused", async () => {
    const engine = new Engine({ listModels: async () => [] });
    try {
        const rt = await engine.createSession(realpathSync(tempDir("goal-sched-")), { mode: "bypassPermissions" });
        await rt.ready;
        rt.goal.restore({ condition: "goaldemo: ship it", setAt: 1 });
        await (rt as any).runScheduled("hello there", { kind: "cron" }, "Scheduled (every 1d)");
        await until(() => !rt.busy);
        expect(rt.snapshot().state.goal?.state).toBe("paused");
        await (rt as any).runScheduled("goaldemo continue", { kind: "resume" }, "Resuming after the usage limit reset");
        await until(() => rt.snapshot().state.goal?.state === "checking" || !rt.goal.active);
        if (rt.goal.active) expect((rt as any).schedulable()).toBe(false);
        await until(() => !rt.goal.active && !rt.busy);
        expect(notices(rt).some((n) => n.startsWith("✓ Goal achieved: goaldemo: ship it"))).toBe(true);
        expect((rt as any).schedulable()).toBe(true);
    } finally {
        await engine.stop();
    }
}, 15_000);
