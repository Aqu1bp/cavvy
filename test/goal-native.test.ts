// /goal on Claude Code and Codex: their own goals, not the loop in src/agent/goal.ts. Claude Code
// gets /goal as it is and reports the goal as it goes (active_goal); Codex's thread goal is driven
// with thread/goal/* and the run waits through the turns Codex starts for it. Fake CLIs (test/fixtures).

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { fakeEnvFile, stopLiveCodex } from "./helpers/fake-env";

const iso = isolate();
const registry = await import("../src/providers/registry");
const { clientFor, forgetClient } = await import("../src/providers/models");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const trust = await import("../src/config/trust");
const { codexGoal, codexGoalCommand, CodexTurn } = await import("../src/backends/codex");
const { claudeGoal } = await import("../src/backends/claude-code");
const { nativeGoalView, nativeGoalStatus, nativeGoals } = await import("../src/agent/goal");
const { Engine } = await import("../src/server/engine");
const { stopTiming } = await import("../src/backends/cli");

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
const fakeEnv = fakeEnvFile(bin);

afterEach(() => stopLiveCodex());

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
    fakeEnv.write();
    registry.saveAgentConfig("claude-code", { path: claudeBin });
    registry.saveAgentConfig("codex", { path: codexBin });
    forgetClient("claude-code");
    forgetClient("codex");
});

const received = () => (existsSync(LOG) ? readFileSync(LOG, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []).flatMap((l: any) => (l.received ? [l.received] : []));

/**
 * `live`: Codex keeps one app-server for the session (#219), and the turns it starts by itself are wakes the host
 * adopts (`wakes`); off, an app-server per run waits through them in the run (agentCli.liveSessions false).
 */
async function makeAgent(provider: "claude-code" | "codex", session = Session.create(cwd, { persist: false }), queue: string[] = [], o: { live?: boolean } = {}) {
    const settings = { agentCli: { liveSessions: o.live === true } };
    const wakes: import("../src/backends/types").BackendWake[] = [];
    const events: AgentEvent[] = [];
    trust.trustForSession(cwd);
    const client = await clientFor(provider);
    let mode: import("../src/permissions/modes").PermissionMode = "bypassPermissions";
    const agent = new Agent({
        session,
        model: { provider, id: "default" },
        client,
        settings: () => settings,
        checker: new PermissionChecker(() => settings, cwd),
        tools: BUILTIN_TOOLS,
        mode: { get: () => mode, set: (m) => (mode = m) },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
        host: { drainQueued: () => queue.splice(0), emit: (e) => events.push(e), ui: {}, wake: (w) => void wakes.push(w) },
    });
    const run = (text: string, signal = new AbortController().signal) => {
        fakeEnv.write();
        return agent.run([{ type: "text", text }], { signal });
    };
    const goals = () => events.flatMap((e) => (e.type === "goal" ? [e.goal] : []));
    const notices = () => events.flatMap((e) => (e.type === "notice" ? [e.message] : []));
    // setMode: the mode as the turn reads it next, with nothing told; switchMode: as the user switches it (the running turn is told).
    const switchMode = (m: typeof mode) => {
        const from = mode;
        mode = m;
        agent.noteModeChange(from, m);
    };
    /** Take the next wake turn Codex (or the harness, for it) started: adopted as the runtime does. */
    const adoptNext = async (ms = 5000) => {
        for (const end = Date.now() + ms; !wakes.length; ) {
            if (Date.now() > end) throw new Error("no wake came");
            await Bun.sleep(5);
        }
        const w = wakes.shift()!;
        return { wake: w, reason: await agent.run([{ type: "text", text: w.label ?? "" }], { signal: new AbortController().signal, kind: "wake", display: w.label, adopt: w }) };
    };
    return { agent, events, run, goals, notices, session, setMode: (m: typeof mode) => (mode = m), switchMode, wakes, adoptNext };
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

    test("/goal stays the whole prompt: Harness's notes wait, and an earlier conversation goes beside it", async () => {
        const session = Session.create(cwd, { persist: false });
        session.push({ role: "user", content: [{ type: "text", text: "the API is in src/api" }] });
        session.push({ role: "assistant", content: [{ type: "text", text: "Noted." }] });
        const a = await makeAgent("claude-code", session);
        a.agent.addReminder("The permission mode is now Plan.");
        expect(await a.run("/goal the tests pass")).toBe("done");
        const sent = received().filter((m) => m.type === "user").map((m) => m.message.content.find((c: any) => c.type === "text")?.text);
        expect(sent[0]).toBe("/goal the tests pass");
        expect(a.goals()[0]).toMatchObject({ condition: "the tests pass" });
        const argv = received().length ? (readFileSync(LOG, "utf-8").trim().split("\n").map((l) => JSON.parse(l)).find((l: any) => l.argv)?.argv as string[]) : [];
        const system = argv[argv.indexOf("--append-system-prompt") + 1];
        expect(system).toContain("<conversation-so-far>");
        expect(system).toContain("the API is in src/api");
        // The note goes with the next prompt.
        expect(await a.run("go on")).toBe("done");
        const next = received().filter((m) => m.type === "user").map((m) => m.message.content.map((c: any) => c.text ?? "").join("\n")).at(-1);
        expect(next).toContain("The permission mode is now Plan.");
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

    test("a character split across reads stays whole, and an unreadable transcript is passed over", () => {
        const file = join(bin, "t2.jsonl");
        const seen: any[] = [];
        const w = new ClaudeGoalWatch(() => file, Date.now() - 1000, (g: any) => seen.push(g));
        const set = Buffer.from(line({ met: false, sentinel: true, condition: "tests pass for café" }) + line({ met: false, condition: "tests pass for café", reason: "Not yet." }));
        const cut = set.indexOf(Buffer.from("é")) + 1;
        writeFileSync(file, set.subarray(0, cut));
        w.poll();
        writeFileSync(file, set);
        w.poll();
        expect(seen).toEqual([expect.objectContaining({ condition: "tests pass for café", turns: 0 }), expect.objectContaining({ condition: "tests pass for café", turns: 1, lastReason: "Not yet." })]);
        expect(seen[1].since).toBe(seen[0].since);
        const broken = new ClaudeGoalWatch(() => bin, 0, () => {});
        expect(() => broken.poll()).not.toThrow();
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
        // Status keeps showing it.
        expect(a.goals().at(-1)).toMatchObject({ status: "paused", condition: "migrate the API" });
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

    test("/goal resume with a note waiting stays a resume, and /goal after another model sets just the condition", async () => {
        process.env.FAKE_GOAL_TURNS = "1";
        const session = Session.create(cwd, { persist: false });
        session.push({ role: "user", content: [{ type: "text", text: "the API is in src/api" }] });
        session.push({ role: "assistant", content: [{ type: "text", text: "Noted." }] });
        const a = await makeAgent("codex", session);
        a.agent.addReminder("The permission mode is now Plan.");
        expect(await a.run("/goal the docs build")).toBe("done");
        const sets = received().filter((m) => m.method === "thread/goal/set").map((m) => m.params);
        expect(sets[0]).toMatchObject({ objective: "the docs build", status: "paused" });
        const turnText = received().find((m) => m.method === "turn/start")!.params.input[0].text as string;
        expect(turnText).toContain("the API is in src/api");
        expect(turnText).toEndWith("the docs build");
        expect(await a.run("/goal pause")).toBe("done");
        a.agent.addReminder("The permission mode is now Plan.");
        expect(await a.run("/goal resume")).toBe("done");
        // Still the docs goal: the note didn't turn the resume into a new goal.
        const objectives = received().filter((m) => m.method === "thread/goal/set" && m.params.objective).map((m) => m.params.objective);
        expect(objectives).toEqual(["the docs build"]);
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

    test("a message sent while waiting for Codex's next goal turn goes into that turn, not the one after", async () => {
        process.env.FAKE_GOAL_TURNS = "3";
        process.env.FAKE_TURN_MS = "80";
        process.env.FAKE_GOAL_CONTINUE_MS = "100";
        const queue: string[] = [];
        const a = await makeAgent("codex", undefined, queue);
        const done = a.run("/goal the docs build");
        const until = Date.now() + 5000;
        while (!a.goals().some((g) => g?.status === "active" && g.tokens === 150) && Date.now() < until) await Bun.sleep(2);
        queue.push("also fix the links");
        a.agent.queueChanged();
        expect(await done).toBe("done");
        const steer = received().find((m) => m.method === "turn/steer");
        expect(steer?.params).toMatchObject({ expectedTurnId: "turn-2", input: [{ text: "also fix the links" }] });
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

    test("a mode changed between the goal's turns applies to the next one Codex starts (it's restarted under it)", async () => {
        process.env.FAKE_GOAL_TURNS = "4";
        process.env.FAKE_GOAL_CONTINUE_MS = "150";
        const a = await makeAgent("codex");
        const done = a.run("/goal the docs build");
        const until = Date.now() + 5000;
        // The first turn has ended (one counted), and Codex hasn't started its next yet.
        while (!a.goals().some((g) => g?.status === "active" && g.tokens === 150) && Date.now() < until) await Bun.sleep(2);
        a.setMode("plan");
        expect(await done).toBe("done");
        const starts = received().filter((m) => m.method === "turn/start");
        expect(starts.at(-1)!.params.sandboxPolicy).toMatchObject({ type: "readOnly" });
        expect(starts.at(-1)!.params.input[0].text).toContain("plan mode");
        // The goal went on after the restart.
        expect(a.goals().at(-1)).toMatchObject({ status: "complete" });
    });

    test("one Codex starts first when refusing a turn/start runs under the mode now: switched to plan, it's restarted", async () => {
        process.env.FAKE_GOAL_TURNS = "3";
        process.env.FAKE_GOAL_RACE = "1";
        process.env.FAKE_TURN_MS = "80";
        // Codex doesn't go on by itself before the turn/start (which it then refuses, starting its own).
        process.env.FAKE_GOAL_CONTINUE_MS = "3000";
        const queue: string[] = [];
        const a = await makeAgent("codex", undefined, queue);
        const done = a.run("/goal the docs build");
        const until = Date.now() + 5000;
        while (!a.goals().some((g) => g?.status === "active") && Date.now() < until) await Bun.sleep(2);
        // Switched while the first turn runs (it's past starting): the next turn is the one it applies to.
        await Bun.sleep(30);
        queue.push("also fix the links");
        a.setMode("plan");
        expect(await done).toBe("done");
        const starts = received().filter((m) => m.method === "turn/start").map((m) => m.params);
        // The refused one, then (Codex's own turn-2, begun under bypass, stopped as it started) asked for again under plan mode.
        expect(starts.slice(1, 3).map((p) => p.sandboxPolicy.type)).toEqual(["readOnly", "readOnly"]);
        expect(received().find((m) => m.method === "turn/interrupt")!.params.turnId).toBe("turn-2");
        // Nothing went into turn-2: the message went into the turn asked for again.
        expect(received().filter((m) => m.method === "turn/steer" && (m.params.expectedTurnId === "turn-2" || /also fix the links/.test(m.params.input[0].text)))).toEqual([]);
        expect(JSON.stringify(starts[2]!.input)).toContain("also fix the links");
        expect(a.goals().at(-1)).toMatchObject({ status: "complete" });
    });

    test("a message for Codex's next goal turn waits for its restart when the mode switched to plan since", async () => {
        process.env.FAKE_GOAL_TURNS = "3";
        process.env.FAKE_TURN_MS = "80";
        const queue: string[] = [];
        const a = await makeAgent("codex", undefined, queue);
        const done = a.run("/goal the docs build");
        const until = Date.now() + 5000;
        while (!a.goals().some((g) => g?.status === "active") && Date.now() < until) await Bun.sleep(2);
        await Bun.sleep(30);
        queue.push("also fix the links");
        a.setMode("plan");
        expect(await done).toBe("done");
        // Codex's own next turn (under bypass) was stopped before anything went into it.
        expect(received().filter((m) => m.method === "turn/steer" && (m.params.expectedTurnId === "turn-2" || /also fix the links/.test(m.params.input[0].text)))).toEqual([]);
        expect(received().find((m) => m.method === "turn/interrupt")!.params.turnId).toBe("turn-2");
        const restart = received().filter((m) => m.method === "turn/start").at(-1)!.params;
        expect(restart.sandboxPolicy.type).toBe("readOnly");
        expect(restart.input[0].text).toContain("also fix the links");
    });

    test("a mode switched while the goal's first turn starts: restarted before the goal is made active", async () => {
        process.env.FAKE_GOAL_TURNS = "2";
        process.env.FAKE_SLOW_TURN_START = "150";
        const a = await makeAgent("codex");
        const done = a.run("/goal the docs build");
        const until = Date.now() + 5000;
        while (!received().some((m) => m.method === "turn/start") && Date.now() < until) await Bun.sleep(2);
        a.setMode("plan");
        expect(await done).toBe("done");
        const rpc = received().filter((m) => m.method);
        const firstActive = rpc.findIndex((m) => m.method === "thread/goal/set" && m.params.status === "active");
        const starts = rpc.map((m, i) => [m, i] as const).filter(([m]) => m.method === "turn/start");
        expect(starts.map(([m]) => m.params.sandboxPolicy.type)).toEqual(["dangerFullAccess", "readOnly"]);
        // Active only once the turn under plan mode had started.
        expect(firstActive).toBeGreaterThan(starts[1]![1]);
    });

    test("a thread's policy and the mode it's kept for come from one reading of the mode", async () => {
        process.env.FAKE_GOAL_TURNS = "5";
        process.env.FAKE_TURN_MS = "80";
        const session = Session.create(cwd, { persist: false });
        const a = await makeAgent("codex", session);
        // A goal left active on the thread (Codex goes on with it).
        const ac = new AbortController();
        const running = a.run("/goal the docs build", ac.signal);
        const until = Date.now() + 5000;
        while (!a.goals().some((g) => g?.status === "active") && Date.now() < until) await Bun.sleep(2);
        ac.abort();
        await running;
        const goalsFile = JSON.parse(readFileSync(LOG + ".goals.json", "utf-8"));
        goalsFile["thr-new"].status = "active";
        writeFileSync(LOG + ".goals.json", JSON.stringify(goalsFile));
        // The next run: the mode switches to plan while the thread is being resumed (under bypass), and Codex
        // starts its own turn as it refuses the one for the message.
        process.env.FAKE_GOAL_RACE = "1";
        const proto = CodexTurn.prototype as any;
        const original = proto.mcpOverrides;
        proto.mcpOverrides = async function (...args: unknown[]) {
            const r = await original.apply(this, args);
            a.setMode("plan");
            return r;
        };
        const before = received().length;
        try {
            expect(await a.run("go on")).toBe("done");
        } finally {
            proto.mcpOverrides = original;
        }
        const later = received().slice(before);
        expect(later.find((m) => m.method === "thread/resume")!.params.sandbox).toBe("danger-full-access");
        // Codex's own turn ran under the thread's bypass: stopped before the message went in, and restarted under plan.
        expect(later.filter((m) => m.method === "turn/steer" && /go on/.test(m.params.input[0].text))).toEqual([]);
        expect(later.some((m) => m.method === "turn/interrupt")).toBe(true);
        const restart = later.filter((m) => m.method === "turn/start").at(-1)!.params;
        expect(restart.sandboxPolicy.type).toBe("readOnly");
        expect(restart.input[0].text).toContain("go on");
    });

    test("a goal turn Codex starts under the thread's old policy is stopped as it starts, not when it's taken up", async () => {
        process.env.FAKE_GOAL_TURNS = "3";
        process.env.FAKE_TURN_MS = "150";
        const queue: string[] = [];
        const a = await makeAgent("codex", undefined, queue);
        // Taking up Codex's next turn is slow (a long queue drain, say): longer than that turn runs.
        const proto = CodexTurn.prototype as any;
        const original = proto.nextGoalTurn;
        proto.nextGoalTurn = async function (...args: unknown[]) {
            await Bun.sleep(400);
            return original.apply(this, args);
        };
        try {
            const done = a.run("/goal the docs build");
            const until = Date.now() + 5000;
            while (!a.goals().some((g) => g?.status === "active") && Date.now() < until) await Bun.sleep(2);
            await Bun.sleep(30);
            queue.push("also fix the links");
            a.setMode("plan");
            expect(await done).toBe("done");
        } finally {
            proto.nextGoalTurn = original;
        }
        // Codex's own turn-2 (under bypass) was stopped, and the goal went on under plan mode with the message.
        expect(received().find((m) => m.method === "turn/interrupt")?.params.turnId).toBe("turn-2");
        const restart = received().filter((m) => m.method === "turn/start").at(-1)!.params;
        expect(restart.sandboxPolicy.type).toBe("readOnly");
        expect(restart.input[0].text).toContain("also fix the links");
        expect(a.goals().at(-1)).toMatchObject({ status: "complete" });
    });

    test("a mode switched between the goal's turns pauses the goal in Codex and stops its turn under the old policy", async () => {
        process.env.FAKE_GOAL_TURNS = "3";
        process.env.FAKE_TURN_MS = "150";
        const queue: string[] = [];
        const a = await makeAgent("codex", undefined, queue);
        // Taking up Codex's next turn is slow (a long queue drain, say): the switch comes while no turn is waited on.
        const proto = CodexTurn.prototype as any;
        const original = proto.nextGoalTurn;
        proto.nextGoalTurn = async function (...args: unknown[]) {
            await Bun.sleep(400);
            return original.apply(this, args);
        };
        try {
            const done = a.run("/goal the docs build");
            const until = Date.now() + 5000;
            while (!a.goals().some((g) => g?.status === "active") && Date.now() < until) await Bun.sleep(2);
            queue.push("also fix the links");
            // The first turn has ended and Codex's own next one (turn-2, under bypass) is running.
            await Bun.sleep(200);
            a.switchMode("plan");
            expect(await done).toBe("done");
        } finally {
            proto.nextGoalTurn = original;
        }
        const rpc = received().filter((m) => m.method);
        expect(rpc.some((m) => m.method === "thread/goal/set" && m.params.status === "paused")).toBe(true);
        expect(rpc.find((m) => m.method === "turn/interrupt")?.params.turnId).toBe("turn-2");
        const starts = rpc.filter((m) => m.method === "turn/start").map((m) => m.params);
        expect(starts.slice(1).every((p) => p.sandboxPolicy.type === "readOnly")).toBe(true);
        expect(starts.at(-1)!.input[0].text).toContain("also fix the links");
        // The goal went on (active again once the turn under plan mode had started), and the tab never showed it paused.
        expect(a.goals().at(-1)).toMatchObject({ status: "complete" });
        const statuses = a.goals().map((g) => g?.status);
        expect(statuses.slice(statuses.indexOf("active")).includes("paused")).toBe(false);
    });

    test("a turn Codex starts while one is being started here is stopped once the answer says it wasn't this one", async () => {
        process.env.FAKE_GOAL_TURNS = "3";
        process.env.FAKE_TURN_MS = "150";
        // Codex goes on by itself only after the turn for the message has been asked for, and that one answers late.
        process.env.FAKE_GOAL_CONTINUE_MS = "1700";
        process.env.FAKE_SLOW_TURN_START_AT = "2:700";
        const queue: string[] = [];
        const a = await makeAgent("codex", undefined, queue);
        const done = a.run("/goal the docs build");
        const until = Date.now() + 8000;
        while (!a.goals().some((g) => g?.status === "active") && Date.now() < until) await Bun.sleep(2);
        queue.push("also fix the links");
        while (received().filter((m) => m.method === "turn/start").length < 2 && Date.now() < until) await Bun.sleep(5);
        // Codex's own turn-3 has started meanwhile (under bypass); then the switch, while the answer is still coming.
        await Bun.sleep(250);
        a.switchMode("plan");
        expect(await done).toBe("done");
        expect(received().filter((m) => m.method === "turn/interrupt").map((m) => m.params.turnId)).toContain("turn-3");
        expect(a.goals().at(-1)).toMatchObject({ status: "complete" });
    });

    test("a turn stopped for the mode that Codex doesn't stop: Codex is stopped, as on a user's stop", async () => {
        process.env.FAKE_GOAL_TURNS = "3";
        process.env.FAKE_TURN_MS = "1500";
        process.env.FAKE_IGNORE_INTERRUPT = "1";
        const saved = { ...stopTiming };
        Object.assign(stopTiming, { interruptMs: 200 });
        try {
            const a = await makeAgent("codex");
            const done = a.run("/goal the docs build");
            const until = Date.now() + 5000;
            while (!a.goals().some((g) => g?.status === "active") && Date.now() < until) await Bun.sleep(2);
            const started = Date.now();
            a.switchMode("plan");
            expect(await done).toBe("error");
            expect(Date.now() - started).toBeLessThan(1200);
            expect(JSON.stringify(a.events)).toContain("Codex didn't stop a turn running under the permission mode from before");
        } finally {
            Object.assign(stopTiming, saved);
        }
    });

    test("a turn not yet known to be Codex's or the one being started is judged by the looser of their policies", () => {
        const sent: any[] = [];
        const turn = Object.assign(Object.create(CodexTurn.prototype), {
            t: { readOnly: false, session: { mode: () => "plan" } },
            rpc: { request: async (method: string, params: unknown) => void sent.push({ method, params }), proc: { kill() {} } },
            threadId: "thr",
            aborted: false,
            starting: true,
            // The thread's policy was plan mode's; the turn/start on its way asks for bypass (a quick switch, then back).
            startingThreadMode: "plan",
            startingMode: "bypassPermissions",
            running: new Map([["turn-9", undefined]]),
            ownTurns: new Set(),
            stoppedForMode: new Set(),
            completedTurns: new Map(),
            modeKills: new Set(),
        });
        turn.stopStale();
        for (const timer of turn.modeKills) clearTimeout(timer);
        expect(sent).toEqual([{ method: "turn/interrupt", params: { threadId: "thr", turnId: "turn-9" } }]);
    });

    test("the turn for a message refused for a turn of Codex's stopped for the mode is asked for again, the message kept", async () => {
        process.env.FAKE_GOAL_TURNS = "3";
        process.env.FAKE_TURN_MS = "150";
        // The turn under plan mode is refused (Codex started one of its own as the pause came): asked again once it's stopped.
        process.env.FAKE_REFUSE_TURN_START_AT = "2";
        process.env.FAKE_GOAL_CONTINUE_MS = "3000";
        const queue: string[] = [];
        const a = await makeAgent("codex", undefined, queue);
        const done = a.run("/goal the docs build");
        const until = Date.now() + 5000;
        while (!a.goals().some((g) => g?.status === "active") && Date.now() < until) await Bun.sleep(2);
        queue.push("also fix the links");
        await Bun.sleep(30);
        a.switchMode("plan");
        expect(await done).toBe("done");
        const starts = received().filter((m) => m.method === "turn/start").map((m) => m.params);
        // The refused one, asked for again, and the message's turn after it: all under plan mode.
        expect(starts.length).toBeGreaterThanOrEqual(3);
        expect(starts.slice(1).every((p) => p.sandboxPolicy.type === "readOnly")).toBe(true);
        expect(starts.slice(3).some((p) => JSON.stringify(p.input).includes("also fix the links"))).toBe(true);
        expect(a.goals().at(-1)).toMatchObject({ status: "complete" });
    });

    test("leaving plan mode between the goal's turns applies to the next one Codex starts too", async () => {
        process.env.FAKE_GOAL_TURNS = "3";
        process.env.FAKE_TURN_MS = "80";
        const a = await makeAgent("codex");
        a.setMode("plan");
        const done = a.run("/goal the docs build");
        const until = Date.now() + 5000;
        while (!a.goals().some((g) => g?.status === "active") && Date.now() < until) await Bun.sleep(2);
        await Bun.sleep(30);
        a.setMode("bypassPermissions");
        expect(await done).toBe("done");
        const starts = received().filter((m) => m.method === "turn/start").map((m) => m.params);
        expect(starts[0].sandboxPolicy.type).toBe("readOnly");
        expect(starts.at(-1)!.sandboxPolicy.type).toBe("dangerFullAccess");
        expect(a.goals().at(-1)).toMatchObject({ status: "complete" });
    });

    test("/goal <condition> takes its images into the goal's first turn", async () => {
        process.env.FAKE_GOAL_TURNS = "1";
        const a = await makeAgent("codex");
        expect(await a.agent.run([{ type: "text", text: "/goal match this mockup" }, { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" }], { signal: new AbortController().signal })).toBe("done");
        expect(received().find((m) => m.method === "thread/goal/set")!.params.objective).toBe("match this mockup");
        const input = received().find((m) => m.method === "turn/start")!.params.input;
        expect(input).toContainEqual({ type: "image", url: "data:image/png;base64,iVBORw0KGgo=" });
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
    async function session(provider: "claude-code" | "codex", o: { live?: boolean } = {}) {
        writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: `${provider}:default`, permissions: { allowBypass: true }, ...(o.live === false ? { agentCli: { liveSessions: false } } : {}) }));
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

    test("Codex: the turns Codex starts for its goal are wake turns of the session, and its end is said", async () => {
        process.env.FAKE_GOAL_TURNS = "2";
        const { engine, rt } = await session("codex");
        try {
            await rt.send("/goal the docs build");
            await until(() => !rt.busy && shown(rt).some((n: string) => n.startsWith("✓ Goal achieved")));
            expect(shown(rt)).toContain("✓ Goal achieved: the docs build");
            expect(rt.snapshot().state.goal).toBeUndefined();
            expect(rt.goal.active).toBe(false);
            // The goal's first turn is the prompt's; the two Codex started itself are wake turns of their own (#219).
            expect(rt.snapshot().turns.map((t: any) => t.prompt?.text)).toEqual(["/goal the docs build", "Codex went on with the goal: the docs build", "Codex went on with the goal: the docs build"]);
            // All in one thread of one app-server: started once, never resumed.
            expect(received().filter((m) => m.method === "thread/start" && !m.params.ephemeral)).toHaveLength(1);
            expect(received().some((m) => m.method === "thread/resume")).toBe(false);
            // Codex still reports the met goal at the start of later runs: it isn't said again.
            await rt.send("thanks");
            await until(() => !rt.busy && rt.snapshot().turns.length === 4);
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
            fakeEnv.write();
            await (rt as any).runScheduled("Your usage limit has reset. Continue where you left off.", { kind: "resume", prompt: "", at: Date.now() }, "Resuming after the usage limit reset");
            await until(() => !rt.busy && shown(rt).some((n: string) => n.startsWith("✓ Goal achieved")));
            const sets = received().filter((m) => m.method === "thread/goal/set").map((m) => m.params.status);
            expect(sets.at(-1)).toBe("active");
        } finally {
            await engine.stop();
        }
    }, 20_000);

    const goalFile = () => (existsSync(LOG + ".goals.json") ? JSON.parse(readFileSync(LOG + ".goals.json", "utf-8"))["thr-new"] : undefined);

    test("Codex: switching to another model between its goal's turns pauses the goal there; its background work goes on, and coming back says how to resume (#412)", async () => {
        process.env.FAKE_GOAL_TURNS = "50";
        // The goal's first turn leaves a command running; Codex starts each next turn of the goal a while after the last.
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd";
        process.env.FAKE_BG_MS = "never";
        process.env.FAKE_TURN_MS = "100";
        process.env.FAKE_GOAL_CONTINUE_MS = "400";
        const { engine, rt } = await session("codex");
        const running = () => (rt as any).agent.backgroundTasks().filter((t: any) => t.provider === "codex" && t.status === "running");
        try {
            await rt.send("/goal the docs build");
            // Idle between the goal's turns: the first is over, and Codex hasn't started the next yet.
            await until(() => !rt.busy && received().some((m) => m.method === "thread/goal/set" && m.params.status === "active") && running().length === 1);
            expect(goalFile()).toMatchObject({ status: "active", turns: 1 });
            expect(await rt.switchModel("claude-code:default")).toBe(true);
            // Paused in Codex, and said so.
            const sets = received().filter((m) => m.method === "thread/goal/set").map((m) => m.params);
            expect(sets.at(-1)).toEqual({ threadId: "thr-new", status: "paused" });
            expect(goalFile().status).toBe("paused");
            expect(shown(rt).at(-1)).toBe("Codex's goal is paused while this session is on another model: the docs build. Its background task keeps running. Switch back to Codex and send /goal resume to go on with it.");
            expect(rt.snapshot().state.goal).toBeUndefined();
            // Codex starts no more turns for it: none comes as a wake, and the goal's count stays.
            await Bun.sleep(1000);
            expect(goalFile()).toMatchObject({ status: "paused", turns: 1 });
            expect(shown(rt).filter((n: string) => /started a turn of its own|went on with the goal/.test(n))).toEqual([]);
            expect(rt.snapshot().turns.map((t: any) => t.prompt?.text)).toEqual(["/goal the docs build"]);
            expect(rt.snapshot().state.goal).toBeUndefined();
            // Its background command goes on.
            expect(running()).toHaveLength(1);
            expect(received().some((m) => m.method === "thread/backgroundTerminals/terminate")).toBe(false);
            // Back on Codex: the goal shows paused, and how to go on is said.
            expect(await rt.switchModel("codex:default")).toBe(true);
            expect(shown(rt).at(-1)).toBe("Codex's goal is paused: the docs build. /goal resume goes on with it.");
            expect(rt.snapshot().state.goal).toMatchObject({ condition: "the docs build", state: "paused", by: "Codex" });
            // And it does.
            process.env.FAKE_GOAL_TURNS = "2";
            fakeEnv.write();
            await rt.send("/goal resume");
            await until(() => !rt.busy && shown(rt).some((n: string) => n.startsWith("✓ Goal achieved")));
            expect(received().filter((m) => m.method === "thread/goal/set").at(-1)!.params.status).toBe("active");
            expect(running()).toHaveLength(1);
        } finally {
            await engine.stop();
        }
    }, 30_000);

    test("Codex: a goal turn Codex had already started when the session switched away is stopped (#412)", async () => {
        process.env.FAKE_GOAL_TURNS = "50";
        process.env.FAKE_TURN_MS = "300";
        process.env.FAKE_GOAL_CONTINUE_MS = "300";
        const { engine, rt } = await session("codex");
        try {
            // Its next turns aren't taken up here (as while the switch is under way): one is running when the switch comes.
            const adopt = (rt as any).adoptWake.bind(rt);
            let woke = 0;
            (rt as any).adoptWake = (w: any) => {
                if (woke++) return;
                adopt(w);
            };
            await rt.send("/goal the docs build");
            await until(() => woke >= 2 && !rt.busy);
            expect(await rt.switchModel("claude-code:default")).toBe(true);
            await until(() => received().some((m) => m.method === "turn/interrupt"));
            const rpc = received().filter((m) => m.method);
            expect(rpc.findIndex((m) => m.method === "thread/goal/set" && m.params.status === "paused")).toBeLessThan(rpc.findIndex((m) => m.method === "turn/interrupt"));
            const turns = goalFile().turns;
            await Bun.sleep(900);
            expect(goalFile()).toMatchObject({ status: "paused", turns });
        } finally {
            await engine.stop();
        }
    }, 30_000);

    test("Codex per run: its app-server is gone between runs, so switching away sends it nothing; coming back says how to resume (#412)", async () => {
        process.env.FAKE_GOAL_TURNS = "50";
        process.env.FAKE_TURN_MS = "200";
        const { engine, rt } = await session("codex", { live: false });
        try {
            // A run goes on through the goal's turns: it's over, with the goal still set, once it's stopped (which pauses it).
            await rt.send("/goal the docs build");
            await until(() => goalFile()?.status === "active");
            rt.interrupt();
            await until(() => !rt.busy && goalFile()?.status === "paused");
            // Codex's (JSON-RPC, with a method), not the fake Claude Code's beside it.
            const codexRpc = () => received().filter((m) => m.method);
            const before = codexRpc().length;
            const appServers = () => readFileSync(LOG, "utf-8").trim().split("\n").filter((l) => JSON.parse(l).argv?.[0] === "app-server").length;
            const processes = appServers();
            expect(await rt.switchModel("claude-code:default")).toBe(true);
            expect(codexRpc().slice(before)).toEqual([]);
            expect(appServers()).toBe(processes);
            expect(rt.snapshot().state.goal).toBeUndefined();
            expect(await rt.switchModel("codex:default")).toBe(true);
            expect(shown(rt).at(-1)).toBe("Codex's goal is paused: the docs build. /goal resume goes on with it.");
        } finally {
            await engine.stop();
        }
    }, 30_000);

    test("Codex: while the switch away pauses its goal, the agent is on the new model already (#412)", async () => {
        const { engine, rt } = await session("codex");
        try {
            const agent = (rt as any).agent;
            let release: (() => void) | undefined;
            agent.pauseNativeGoal = () => new Promise((r) => (release = () => r(undefined)));
            const switching = rt.switchModel("claude-code:default");
            await until(() => release !== undefined);
            expect(agent.model.provider).toBe("claude-code");
            release!();
            expect(await switching).toBe(true);
        } finally {
            await engine.stop();
        }
    }, 20_000);

    /** The session's live Codex connection (src/backends/codex-live.ts). */
    async function codexConn(rt: any) {
        const { codexLive } = await import("../src/backends/codex-live");
        return (codexLive((await clientFor("codex")) as any).pool.get(rt.session.meta.id, "codex")!.adapter as any).conn;
    }

    test("Codex: a host turn with a background report, not yet known to be ours as the session switches away, isn't stopped (#412)", async () => {
        process.env.FAKE_GOAL_TURNS = "50";
        process.env.FAKE_CODEX_SCENARIOS = "bg,cmd";
        process.env.FAKE_BG_MS = "300";
        process.env.FAKE_TURN_MS = "100";
        process.env.FAKE_GOAL_CONTINUE_MS = "5000";
        // The report's turn (the second turn/start) says it started well before turn/start answers.
        process.env.FAKE_STARTED_FIRST_AT = "2:600";
        const { engine, rt } = await session("codex");
        try {
            await rt.send("/goal the docs build");
            await until(() => received().filter((m) => m.method === "turn/start").length === 2);
            await Bun.sleep(100);
            expect(rt.busy).toBe(false);
            expect(goalFile().status).toBe("active");
            expect(await rt.switchModel("claude-code:default")).toBe(true);
            // Its report reaches the model the session is on now, and the turn that carries it isn't stopped.
            await until(() => shown(rt).some((n: string) => n.includes("bg 1 done")));
            expect(received().filter((m) => m.method === "turn/interrupt")).toEqual([]);
            expect(goalFile().status).toBe("paused");
        } finally {
            await engine.stop();
        }
    }, 30_000);

    test("Codex: a turn going on with the goal under a new mode, being started as the session switches away, doesn't make it active again (#412)", async () => {
        process.env.FAKE_GOAL_TURNS = "50";
        process.env.FAKE_TURN_MS = "100";
        process.env.FAKE_GOAL_CONTINUE_MS = "5000";
        // The turn the goal goes on in under the new mode answers late.
        process.env.FAKE_SLOW_TURN_START_AT = "2:600";
        const { engine, rt } = await session("codex");
        try {
            await rt.send("/goal the docs build");
            await until(() => !rt.busy && goalFile()?.status === "active" && goalFile()?.turns === 1);
            // The mode changes between the goal's turns: Codex pauses it, and a turn of the host's goes on with it under the mode.
            rt.setMode("plan");
            (await codexConn(rt)).liveModeChanged();
            await until(() => received().filter((m) => m.method === "turn/start").length === 2);
            expect(await rt.switchModel("claude-code:default")).toBe(true);
            await until(() => received().some((m) => m.method === "turn/interrupt"));
            await Bun.sleep(300);
            const sets = received().filter((m) => m.method === "thread/goal/set").map((m) => m.params.status);
            expect(sets.at(-1)).toBe("paused");
            expect(sets.filter((s) => s === "active")).toHaveLength(1);
            expect(goalFile().status).toBe("paused");
        } finally {
            await engine.stop();
        }
    }, 30_000);

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
