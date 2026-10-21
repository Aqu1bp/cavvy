// /goal on Claude Code and Codex: their own goals, not the loop in src/agent/goal.ts. Claude Code
// gets /goal as it is and reports the goal as it goes (active_goal); Codex's thread goal is driven
// with thread/goal/* and the run waits through the turns Codex starts for it. Fake CLIs (test/fixtures).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const registry = await import("../src/providers/registry");
const { clientFor, forgetClient } = await import("../src/providers/models");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const trust = await import("../src/config/trust");
const { codexGoal, codexGoalCommand } = await import("../src/backends/codex");
const { claudeGoal } = await import("../src/backends/claude-code");
const { nativeGoalView, nativeGoalStatus, nativeGoals } = await import("../src/agent/goal");
const { Engine } = await import("../src/server/engine");

type AgentEvent = import("../src/agent/agent").AgentEvent;

const bin = tempDir("fake-goal-agents-");
const LOG = join(bin, "log.jsonl");
function wrapper(name: string, fixture: string): string {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", fixture)}" "$@"\n`);
    chmodSync(p, 0o755);
    return p;
}
const claudeBin = wrapper("claude", "fake-claude.ts");
const codexBin = wrapper("codex", "fake-codex.ts");

afterAll(() => {
    iso.cleanup();
    rmSync(bin, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
});

let cwd: string;
beforeEach(() => {
    cwd = realpathSync(tempDir("goal-native-proj-"));
    for (const f of [LOG, LOG + ".goals.json", LOG + ".tiers.json", LOG + ".usage.json"]) rmSync(f, { force: true });
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    // Claude Code's own remote sessions report their goal on stdout too (a test may run in one).
    delete process.env.CLAUDE_CODE_REMOTE;
    process.env.FAKE_LOG = LOG;
    registry.saveAgentConfig("claude-code", { path: claudeBin });
    registry.saveAgentConfig("codex", { path: codexBin });
    forgetClient("claude-code");
    forgetClient("codex");
});

const received = () => (existsSync(LOG) ? readFileSync(LOG, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).flatMap((l: any) => (l.received ? [l.received] : []));

async function makeAgent(provider: "claude-code" | "codex", session = Session.create(cwd, { persist: false }), queue: string[] = []) {
    const events: AgentEvent[] = [];
    trust.trustForSession(cwd);
    const client = await clientFor(provider);
    let mode: import("../src/permissions/modes").PermissionMode = "bypassPermissions";
    const agent = new Agent({
        session,
        model: { provider, id: "default" },
        client,
        settings: () => ({}),
        checker: new PermissionChecker(() => ({}), cwd),
        tools: BUILTIN_TOOLS,
        mode: { get: () => mode, set: (m) => (mode = m) },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
        host: { drainQueued: () => queue.splice(0), emit: (e) => events.push(e), ui: {} },
    });
    const run = (text: string, signal = new AbortController().signal) => agent.run([{ type: "text", text }], { signal });
    const goals = () => events.flatMap((e) => (e.type === "goal" ? [e.goal] : []));
    const notices = () => events.flatMap((e) => (e.type === "notice" ? [e.message] : []));
    return { agent, events, run, goals, notices, session };
}

describe("parsing what the CLIs report", () => {
    test("Claude Code's active_goal and Codex's ThreadGoal", () => {
        expect(claudeGoal(null)).toBeNull();
        expect(claudeGoal({ condition: "  " })).toBeNull();
        expect(claudeGoal({ condition: "tests pass", iterations: 2, set_at: 1_782_622_440_000, tokens_at_start: 0, last_reason: "Two still fail." })).toEqual({ provider: "claude-code", condition: "tests pass", status: "active", since: 1_782_622_440_000, turns: 2, lastReason: "Two still fail." });
        // Seconds are taken as seconds.
        expect(claudeGoal({ condition: "x", set_at: 1_782_622_440 })!.since).toBe(1_782_622_440_000);
        expect(codexGoal({ objective: "ship it", status: "usageLimited", createdAt: 1_782_622_440, tokensUsed: 900 })).toEqual({ provider: "codex", condition: "ship it", status: "limited", since: 1_782_622_440_000, tokens: 900 });
        expect(codexGoal({ objective: "x", status: "budgetLimited" })!.status).toBe("limited");
        expect(codexGoal({ objective: "x", status: "something-new" })!.status).toBe("paused");
        expect(codexGoal({ objective: "", status: "active" })).toBeNull();
        expect(codexGoalCommand("/goal")).toEqual({ kind: "status" });
        expect(codexGoalCommand("  /goal   the docs build ")).toEqual({ kind: "set", condition: "the docs build" });
        expect(codexGoalCommand("/goals")).toBeUndefined();
        expect(codexGoalCommand("set a /goal")).toBeUndefined();
        expect(nativeGoals("claude-code") && nativeGoals("codex")).toBe(true);
        expect(nativeGoals("anthropic") || nativeGoals("openai") || nativeGoals(undefined)).toBe(false);
    });

    test("how one shows: working while its turn runs, waiting for the user after", () => {
        const cc = claudeGoal({ condition: "tests pass", iterations: 1, set_at: 5 })!;
        expect(nativeGoalView(cc, true)).toMatchObject({ state: "active", judge: "native", by: "Claude Code", canPause: false, turns: 1 });
        expect(nativeGoalView(cc, false)).toMatchObject({ state: "paused", note: "Claude Code goes on with it after your next message." });
        const cx = codexGoal({ objective: "ship", status: "paused", createdAt: 1 })!;
        expect(nativeGoalView(cx, false)).toMatchObject({ state: "paused", by: "Codex", canPause: true, note: "Paused in Codex. /goal resume continues it." });
        expect(nativeGoalStatus(undefined, true)).toBe("No goal set.");
        expect(nativeGoalStatus(cx, true)).toStartWith("◎ Goal (Codex, paused): ship");
    });
});

describe("Claude Code", () => {
    // In -p mode it reports active_goal only in its remote sessions: the goal is read from its transcript.
    test("/goal goes to it as it is, and its goal is followed in its transcript as it goes", async () => {
        const { run, goals } = await makeAgent("claude-code");
        expect(await run("/goal the tests pass")).toBe("done");
        const sent = received().filter((m) => m.type === "user").map((m) => m.message.content.find((c: any) => c.type === "text")?.text);
        expect(sent).toContain("/goal the tests pass");
        const g = goals();
        expect(g[0]).toMatchObject({ provider: "claude-code", condition: "the tests pass", status: "active", turns: 0 });
        expect(g[1]).toMatchObject({ status: "active", turns: 1, lastReason: "The tests haven't run yet." });
        expect(g.at(-1)).toMatchObject({ status: "complete", turns: 2, lastReason: "The tests pass." });
        expect(g).toHaveLength(3);
    });

    test("judged impossible is said; its remote sessions' own reports aren't doubled", async () => {
        process.env.FAKE_GOAL_IMPOSSIBLE = "1";
        process.env.CLAUDE_CODE_REMOTE = "1";
        try {
            const { run, goals } = await makeAgent("claude-code");
            expect(await run("/goal the tests pass")).toBe("done");
            expect(goals().map((g) => g?.status ?? null)).toEqual(["active", "active", "failed"]);
            expect(goals().at(-1)).toMatchObject({ lastReason: "There is no test suite." });
        } finally {
            delete process.env.CLAUDE_CODE_REMOTE;
        }
    });

    test("a resumed session's goal still set is reported once at the start; one met before isn't", async () => {
        process.env.FAKE_GOAL_HOLD = "1";
        const session = Session.create(cwd, { persist: false });
        const a = await makeAgent("claude-code", session);
        const ac = new AbortController();
        const running = a.run("/goal the tests pass", ac.signal);
        const until = Date.now() + 5000;
        while (a.goals().length < 2 && Date.now() < until) await Bun.sleep(5);
        ac.abort();
        expect(await running).toBe("aborted");
        const before = a.goals().length;
        delete process.env.FAKE_GOAL_HOLD;
        expect(await a.run("go on")).toBe("done");
        expect(a.goals().slice(before)).toEqual([expect.objectContaining({ status: "active", condition: "the tests pass", turns: 1 })]);
        // Met, then another message: nothing more about it.
        expect(await a.run("/goal the docs build")).toBe("done");
        const after = a.goals().length;
        expect(await a.run("thanks")).toBe("done");
        expect(a.goals().slice(after)).toEqual([]);
    });
});

describe("ClaudeGoalWatch", () => {
    const { ClaudeGoalWatch } = require("../src/backends/claude-goal");
    const line = (attachment: object, at = Date.now()) => JSON.stringify({ type: "attachment", timestamp: new Date(at).toISOString(), attachment: { type: "goal_status", ...attachment } }) + "\n";
    test("reads only whole lines, as they're written, and a cleared goal is null", () => {
        const file = join(bin, "t.jsonl");
        writeFileSync(file, "");
        const seen: any[] = [];
        const w = new ClaudeGoalWatch(() => file, Date.now() - 1000, (g: any) => seen.push(g));
        const set = line({ met: false, sentinel: true, condition: "ship" });
        writeFileSync(file, set.slice(0, 20));
        w.poll();
        expect(seen).toEqual([]);
        writeFileSync(file, set + JSON.stringify({ type: "user", message: { content: "goal_status" } }) + "\n" + line({ met: true, sentinel: true, condition: "ship" }));
        w.poll();
        expect(seen.map((g) => g?.status ?? null)).toEqual(["active", null]);
    });
});

describe("Codex", () => {
    test("/goal <condition> sets its thread goal and the run lasts through the turns Codex starts for it", async () => {
        process.env.FAKE_GOAL_TURNS = "3";
        const { run, goals, notices } = await makeAgent("codex");
        expect(await run("/goal the docs build")).toBe("done");
        const rpc = received().filter((m) => m.method).map((m) => m.method);
        // Paused until its first turn has started, then active: Codex doesn't start one of its own first.
        const sets = received().filter((m) => m.method === "thread/goal/set").map((m) => m.params);
        expect(sets[0]).toMatchObject({ objective: "the docs build", status: "paused" });
        expect(sets[1]).toEqual({ threadId: "thr-new", status: "active" });
        expect(rpc.indexOf("turn/start")).toBeLessThan(rpc.lastIndexOf("thread/goal/set"));
        // One turn started here; the other two Codex started itself, inside this one run.
        expect(rpc.filter((m) => m === "turn/start")).toHaveLength(1);
        const turnText = received().find((m) => m.method === "turn/start")!.params.input[0].text as string;
        expect(turnText).toEndWith("the docs build");
        expect(goals().at(-1)).toMatchObject({ status: "complete", condition: "the docs build" });
        expect(notices().filter((n) => /Codex didn't go on/.test(n))).toEqual([]);
    });

    test("status, pause, resume and clear go to its thread goal; pause stops it going on", async () => {
        process.env.FAKE_GOAL_TURNS = "5";
        const session = Session.create(cwd, { persist: false });
        const a = await makeAgent("codex", session);
        expect(await a.run("/goal")).toBe("done");
        expect(a.notices()).toContain("No goal set.");
        // Stopped by the user mid-goal: paused, so Codex doesn't go on by itself.
        const ac = new AbortController();
        const running = a.run("/goal migrate the API", ac.signal);
        const until = Date.now() + 5000;
        while (!a.goals().some((g) => g?.status === "active") && Date.now() < until) await Bun.sleep(5);
        ac.abort();
        expect(await running).toBe("aborted");
        const goalsFile = JSON.parse(readFileSync(LOG + ".goals.json", "utf-8"));
        expect(goalsFile["thr-new"].status).toBe("paused");
        expect(await a.run("/goal")).toBe("done");
        expect(a.notices().at(-1)).toBe("◎ Goal (Codex, paused): migrate the API");
        // Resume: a turn of its own here, under the mode as it is now (as T3 Code's), made active once it has
        // started; then Codex carries it on to the end.
        process.env.FAKE_GOAL_TURNS = "2";
        const starts = received().filter((m) => m.method === "turn/start").length;
        expect(await a.run("/goal resume")).toBe("done");
        expect(a.goals().at(-1)).toMatchObject({ status: "complete" });
        const resumed = received().filter((m) => m.method === "turn/start").slice(starts);
        expect(resumed).toHaveLength(1);
        expect(resumed[0].params).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
        const rpc = received().map((m) => m.method ?? "");
        expect(rpc.lastIndexOf("turn/start")).toBeLessThan(rpc.findLastIndex((m, i) => m === "thread/goal/set" && received()[i].params.status === "active"));
        expect(await a.run("/goal clear")).toBe("done");
        expect(a.notices().at(-1)).toBe("Goal cleared: migrate the API");
        expect(await a.run("/goal pause")).toBe("done");
        expect(a.notices().at(-1)).toBe("No goal set. /goal <condition> sets one.");
    });

    test("a message sent as Codex starts the goal's next turn goes into that turn, not a turn of its own", async () => {
        process.env.FAKE_GOAL_TURNS = "3";
        process.env.FAKE_TURN_MS = "80";
        // Codex has started its next turn by the time the message is taken.
        process.env.FAKE_GOAL_CONTINUE_MS = "0";
        const queue: string[] = [];
        const a = await makeAgent("codex", undefined, queue);
        const done = a.run("/goal the docs build");
        const until = Date.now() + 5000;
        while (!a.goals().some((g) => g?.status === "active") && Date.now() < until) await Bun.sleep(2);
        queue.push("also fix the links");
        expect(await done).toBe("done");
        expect(received().filter((m) => m.method === "turn/start")).toHaveLength(1);
        const steer = received().find((m) => m.method === "turn/steer");
        expect(steer?.params.input[0].text).toBe("also fix the links");
        expect(steer?.params.expectedTurnId).not.toBe("turn-1");
        expect(a.goals().at(-1)).toMatchObject({ status: "complete" });
    });

    test("one Codex refuses because it started the goal's turn first: the message goes into that turn", async () => {
        process.env.FAKE_GOAL_TURNS = "3";
        process.env.FAKE_GOAL_RACE = "1";
        process.env.FAKE_TURN_MS = "80";
        const queue: string[] = [];
        const a = await makeAgent("codex", undefined, queue);
        const done = a.run("/goal the docs build");
        const until = Date.now() + 5000;
        while (!a.goals().some((g) => g?.status === "active") && Date.now() < until) await Bun.sleep(2);
        queue.push("also fix the links");
        expect(await done).toBe("done");
        expect(a.notices().filter((n) => /a turn is already running/.test(n))).toEqual([]);
        expect(received().find((m) => m.method === "turn/steer")?.params.input[0].text).toBe("also fix the links");
        expect(a.goals().at(-1)).toMatchObject({ status: "complete" });
    });

    test("an older Codex without goals says so", async () => {
        process.env.FAKE_NO_GOALS = "1";
        const { run, notices } = await makeAgent("codex");
        expect(await run("/goal the docs build")).toBe("done");
        expect(notices().some((n) => /This Codex doesn't keep goals/.test(n))).toBe(true);
        expect(received().filter((m) => m.method === "turn/start")).toHaveLength(0);
    });
});

describe("in the app's server", () => {
    async function session(provider: "claude-code" | "codex") {
        writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: `${provider}:default`, permissions: { allowBypass: true } }));
        const engine = new Engine({ listModels: async () => [] });
        const rt = await engine.createSession(cwd, { mode: "bypassPermissions" });
        await rt.ready;
        return { engine, rt };
    }
    const shown = (rt: any) => rt.snapshot().turns.flatMap((t: any) => t.blocks.filter((b: any) => b.t === "notice").map((b: any) => b.text as string));
    async function until(what: () => boolean, ms = 10_000) {
        const end = Date.now() + ms;
        while (!what()) {
            if (Date.now() > end) throw new Error("timed out");
            await Bun.sleep(10);
        }
    }

    test("Claude Code: /goal runs as a turn of its own, the tab follows its reports, and the loop here stays out of it", async () => {
        process.env.FAKE_GOAL_HOLD = "1";
        const { engine, rt } = await session("claude-code");
        try {
            const seen: (string | undefined)[] = [];
            const orig = (rt as any).setState.bind(rt);
            (rt as any).setState = (patch: any) => {
                if ("goal" in patch) seen.push(patch.goal ? `${patch.goal.state}:${patch.goal.by}` : undefined);
                return orig(patch);
            };
            await rt.send("/goal the tests pass");
            await until(() => rt.snapshot().state.goal?.turns === 1);
            expect(rt.snapshot().state.goal).toMatchObject({ condition: "the tests pass", state: "active", judge: "native", by: "Claude Code", canPause: false });
            expect(rt.goal.active).toBe(false);
            // Mid-turn: status answers from what it reported; pause isn't Claude Code's.
            await rt.send("/goal");
            expect(shown(rt).at(-1)).toStartWith("◎ Goal (Claude Code): the tests pass");
            await rt.send("/goal pause");
            expect(shown(rt).at(-1)).toStartWith("Claude Code's goals don't pause");
            // Clear mid-turn: the turn stops, then Claude Code gets the clear.
            await rt.send("/goal clear");
            await until(() => !rt.busy && rt.snapshot().state.goal === undefined);
            const prompts = rt.snapshot().turns.filter((t: any) => t.prompt).map((t: any) => t.prompt.text);
            expect(prompts).toEqual(["/goal the tests pass", "/goal clear"]);
            expect(seen).toContain("active:Claude Code");
        } finally {
            await engine.stop();
        }
    }, 20_000);

    test("Codex: the run waits through Codex's own goal turns, and its end is said", async () => {
        process.env.FAKE_GOAL_TURNS = "2";
        const { engine, rt } = await session("codex");
        try {
            await rt.send("/goal the docs build");
            await until(() => !rt.busy && shown(rt).some((n: string) => n.startsWith("✓ Goal achieved")));
            expect(shown(rt)).toContain("✓ Goal achieved: the docs build");
            expect(rt.snapshot().state.goal).toBeUndefined();
            expect(rt.goal.active).toBe(false);
            // Codex still reports the met goal at the start of later runs: it isn't said again.
            await rt.send("thanks");
            await until(() => !rt.busy && rt.snapshot().turns.length === 2);
            await Bun.sleep(50);
            expect(shown(rt).filter((n: string) => n.startsWith("✓ Goal achieved"))).toHaveLength(1);
            expect(rt.snapshot().state.goal).toBeUndefined();
        } finally {
            await engine.stop();
        }
    }, 20_000);

    test("Codex: the resume after a usage limit makes its goal active again", async () => {
        process.env.FAKE_SCENARIO = "usage-limit";
        process.env.FAKE_TURN_MS = "50";
        const { engine, rt } = await session("codex");
        try {
            await rt.send("/goal the docs build");
            await until(() => !rt.busy && rt.snapshot().state.goal?.note?.includes("usage") === true);
            process.env.FAKE_SCENARIO = "cmd";
            process.env.FAKE_GOAL_TURNS = "1";
            await (rt as any).runScheduled("Your usage limit has reset. Continue where you left off.", { kind: "resume", prompt: "", at: Date.now() }, "Resuming after the usage limit reset");
            await until(() => !rt.busy && shown(rt).some((n: string) => n.startsWith("✓ Goal achieved")));
            const sets = received().filter((m) => m.method === "thread/goal/set").map((m) => m.params.status);
            expect(sets.at(-1)).toBe("active");
        } finally {
            await engine.stop();
        }
    }, 20_000);

    test("a goal of the loop here doesn't go on with Claude Code or Codex: switching to one clears it, and says so", async () => {
        const { engine, rt } = await session("codex");
        try {
            rt.goal.set("the docs build");
            rt.goal.pause("Paused for the test.");
            expect(rt.goal.active).toBe(true);
            expect(await rt.setModel("claude-code:default")).toBe(true);
            expect(rt.goal.active).toBe(false);
            expect(rt.session.goal).toBeUndefined();
            expect(shown(rt).at(-1)).toBe("Goal cleared: the docs build. Claude Code keeps goals of its own: /goal <condition> sets one there.");
            expect(rt.snapshot().state.goal).toBeUndefined();
        } finally {
            await engine.stop();
        }
    }, 20_000);
});
