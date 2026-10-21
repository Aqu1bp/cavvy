// /goal in the terminal app: the command, the turns it runs, the status line and Esc.

import { afterAll, expect, test } from "bun:test";
import { realpathSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";
import type { AssistantMessage, ChatRequest } from "../src/providers/types";

const { cleanup } = isolate();
const { App } = await import("../src/ui/app");
const { Session } = await import("../src/agent/session");
const { runCommand } = await import("../src/commands/index");
const { stripAnsi } = await import("../src/ui/ansi");
afterAll(cleanup);

const MODEL = { provider: "test", id: "m1", name: "Test model" } as any;
const msg = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "end_turn"): AssistantMessage => ({ role: "assistant", content, provider: "test", model: "m1", stopReason });

/** An app on a fake model: each turn globs once, then answers; the goal check answers from `verdicts` in order. */
function testApp(verdicts: string[], session?: InstanceType<typeof Session>, model = MODEL) {
    const cwd = realpathSync(tempDir("goal-tui-"));
    const app = new App({ cwd, trusted: true, mode: "default", allowBypass: false, startupNotes: [] });
    const printed: string[] = [];
    const print = (l: string | string[] | ((cols: number) => string[])) => (printed.push(...(typeof l === "function" ? l(100) : Array.isArray(l) ? l : [l])), {});
    (app as any).screen = { print, replace() {}, redraw() {}, setLive() {}, settle() {}, flushNow() {}, stop() {}, clearScreen() {} };
    (app as any).renderLive = () => {};
    app.session = session ?? Session.create(cwd, { persist: false });
    const checks: string[] = [];
    app.model = model;
    app.client = {
        stream: async (req: ChatRequest) => {
            if (/check whether a coding agent has reached a goal/.test(req.system)) {
                checks.push((req.messages[0]!.content[0] as { text: string }).text);
                return msg([{ type: "text", text: verdicts.shift() ?? '{"verdict":"met","reason":"ok"}' }]);
            }
            const last = req.messages.at(-1)!;
            if (last.role === "user" && last.content.some((p) => p.type === "tool_result")) return msg([{ type: "text", text: "Ran it." }]);
            return msg([{ type: "tool_call", id: `g${req.messages.length}`, name: "Glob", input: { pattern: "*" } }], "tool_use");
        },
        listModels: async () => [],
    };
    app.makeAgent();
    (app as any).bindGoal();
    return { app, checks, text: () => printed.map(stripAnsi).join("\n") };
}

async function until(what: () => boolean, ms = 5000) {
    const end = Date.now() + ms;
    while (!what()) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(5);
    }
}

test("/goal runs a turn, keeps going while the check says not met, and ends when it's met", async () => {
    const { app, checks, text } = testApp(['{"verdict":"not_met","reason":"No test output yet."}', '{"verdict":"met","reason":"12 tests pass."}']);
    await runCommand(app, "/goal the tests pass");
    await until(() => !app.goal!.active && !app.busy);
    const out = text();
    expect(out).toContain("> /goal the tests pass");
    expect(out).toContain("◎ Goal not met yet: No test output yet.");
    expect(out).toContain("> /goal · keep going");
    expect(out).toMatch(/✓ Goal achieved: the tests pass \(2 turns · \d+s\)/);
    expect(checks).toHaveLength(2);
    expect(checks[0]).toContain("<goal>\nthe tests pass\n</goal>");
    // Status after it ended shows what was achieved.
    await runCommand(app, "/goal");
    expect(text()).toContain("Goal achieved");
    expect(text()).toContain("12 tests pass.");
});

test("/goal with no goal, clear, pause and resume", async () => {
    const { app, text } = testApp([]);
    await runCommand(app, "/goal");
    expect(text()).toContain("No goal set.");
    await runCommand(app, "/goal clear");
    expect(text()).toContain("No goal set");
    await runCommand(app, "/goal pause");
    expect(text()).toContain("No goal set");
    await runCommand(app, `/goal ${"y".repeat(4001)}`);
    expect(text()).toContain("A goal can be up to 4,000 characters");
    expect(app.goal!.active).toBe(false);
    app.goal!.restore({ condition: "lint is clean", setAt: 1 });
    await runCommand(app, "/goal");
    expect(text()).toContain("Condition");
    expect(text()).toContain("lint is clean");
    expect(text()).toContain("paused");
    await runCommand(app, "/goal stop");
    expect(text()).toContain("Goal cleared: lint is clean");
    expect(app.goal!.active).toBe(false);
});

test("the status line shows the goal and its state; Esc pauses a pending check", async () => {
    let release!: (s: string) => void;
    const { app } = testApp([]);
    const line = () => stripAnsi((app as any).goalLine(120) ?? "");
    expect(line()).toBe("");
    // A check that waits until the test lets it answer.
    const stream = app.client!.stream.bind(app.client);
    app.client!.stream = async (req: ChatRequest, on) => {
        if (/check whether a coding agent/.test(req.system)) return msg([{ type: "text", text: await new Promise<string>((r) => (release = r)) }]);
        return stream(req, on);
    };
    void runCommand(app, "/goal docs build");
    await until(() => app.goal!.view()?.state === "checking");
    expect(line()).toContain("Checking the goal…");
    expect(line()).toContain("esc to pause");
    expect(app.goalPending()).toBe(true);
    (app as any).onKey({ name: "escape", ctrl: false, meta: false, shift: false, sequence: "\x1b" });
    expect(app.goal!.view()!.state).toBe("paused");
    expect(line()).toContain("◎ /goal paused");
    release('{"verdict":"not_met","reason":"late"}');
    await Bun.sleep(20);
    expect(app.busy).toBe(false);
    expect(app.goal!.view()!.state).toBe("paused");
    app.goal!.clear();
});

test("a new goal typed mid-turn waits in the queue; status answers at once", async () => {
    const { app, text } = testApp(['{"verdict":"met","reason":"done"}']);
    let release!: () => void;
    const stream = app.client!.stream.bind(app.client);
    app.client!.stream = async (req: ChatRequest, on) => {
        if (!release && /hold on/.test(JSON.stringify(req.messages.at(-1)))) await new Promise<void>((r) => (release = r));
        return stream(req, on);
    };
    void app.submitText("hold on");
    await until(() => app.busy && release !== undefined);
    await app.submitText("/goal the docs build");
    expect(app.goal!.active).toBe(false);
    expect((app as any).queued.map((d: { text: string }) => d.text)).toEqual(["/goal the docs build"]);
    await app.submitText("/goal");
    expect(text()).toContain("No goal set.");
    release();
    await until(() => app.goal!.last?.result === "met" && !app.busy);
    expect(text()).toContain("> /goal the docs build");
});

test("with only a CLI backend to ask, the model reports for itself and the user is told", async () => {
    const { app, text } = testApp([]);
    app.model = { provider: "codex", id: "gpt" } as any;
    expect(app.helperAnswers()).toBe(false);
    app.settings = { ...app.settings, smallModel: "anthropic:claude-haiku" };
    expect(app.helperAnswers()).toBe(true);
    app.settings = { ...app.settings, smallModel: undefined };
    app.model = MODEL;
    expect(app.helperAnswers()).toBe(true);
    app.model = { provider: "claude-code", id: "default" } as any;
    app.goal!.set("x");
    expect(app.goal!.view()!.judge).toBe("self");
    app.goal!.clear();
    void text;
});

test("a resumed session's goal comes back paused, with a note", () => {
    const cwd = realpathSync(tempDir("goal-tui-resume-"));
    const s = Session.create(cwd);
    s.push({ role: "user", content: [{ type: "text", text: "hi" }], meta: { kind: "prompt" } });
    s.setGoal({ condition: "migrate the API", setAt: 1 });
    const { app, text } = testApp([]);
    app.resume(s.path);
    expect(app.goal!.view()).toMatchObject({ condition: "migrate the API", state: "paused" });
    expect(text()).toContain("◎ Goal restored: migrate the API. It continues after your next message, or /goal resume.");
    // /clear starts a session without it.
    app.newSession();
    expect(app.goal!.active).toBe(false);
});

test("a background shell still running holds the goal check until it exits", async () => {
    const { app, checks } = testApp([]);
    const shell = { id: "b1", command: "sleep 20", startedAt: Date.now(), output: "", readOffset: 0, exitCode: null as number | null };
    app.toolState.shells.set(shell.id, shell as any);
    await runCommand(app, "/goal the server answers");
    await until(() => app.goal!.view()?.state === "waiting");
    expect(checks).toHaveLength(0);
    shell.exitCode = 0;
    await until(() => !app.goal!.active && !app.busy);
    expect(checks).toHaveLength(1);
}, 15_000);

test("scheduled prompts wait while a goal is between turns, and leave a paused goal paused (the usage-limit resume picks it up)", async () => {
    const { app, checks } = testApp(['{"verdict":"met","reason":"done"}']);
    (app as any).modelReady = true;
    app.goal!.restore({ condition: "ship it", setAt: 1 });
    // A scheduled prompt runs, but the paused goal stays paused: no check after it.
    await (app as any).runScheduled("run the nightly lint", "Scheduled (every 1d)");
    await until(() => !app.busy);
    expect(app.goal!.view()!.state).toBe("paused");
    expect(checks).toHaveLength(0);
    // The resume after a usage limit carries on with the goal, as Claude Code's does.
    await (app as any).runScheduled("Continue where you left off.", "Resuming after the usage limit reset", true);
    await until(() => !app.goal!.active && !app.busy);
    expect(app.goal!.last?.result).toBe("met");
    // While a check runs, nothing scheduled may start.
    let release!: (s: string) => void;
    const stream = app.client!.stream.bind(app.client);
    app.client!.stream = async (req: ChatRequest, on) => {
        if (/check whether a coding agent/.test(req.system)) return msg([{ type: "text", text: await new Promise<string>((r) => (release = r)) }]);
        return stream(req, on);
    };
    void runCommand(app, "/goal docs build");
    await until(() => app.goal!.view()?.state === "checking");
    expect((app as any).schedulable()).toBe(false);
    release('{"verdict":"met","reason":"built"}');
    await until(() => !app.goal!.active && !app.busy);
    expect((app as any).schedulable()).toBe(true);
});

test("on Claude Code or Codex, a reopened session's goal of the loop here is cleared, and that's said", async () => {
    const cwd = realpathSync(tempDir("goal-tui-"));
    const session = Session.create(cwd, { persist: false });
    session.setGoal({ condition: "the docs build", setAt: Date.now() });
    const { app, text } = testApp([], session, { provider: "codex", id: "default", name: "Codex" });
    expect(app.goal!.active).toBe(false);
    expect(session.goal).toBeUndefined();
    expect(text()).toContain("Goal cleared: the docs build. Codex keeps goals of its own: /goal <condition> sets one there.");
    expect(text()).not.toContain("Goal restored");
});

test("a CLI's goal ending is said once, as it ends, not when a later run reports it again", async () => {
    const { app, text } = testApp([]);
    const report = (status: string) => (app as any).nativeGoalReported({ provider: "codex", condition: "ship it", status, since: Date.now() });
    // A met goal from before: not news.
    report("complete");
    expect(text()).not.toContain("Goal achieved");
    report("active");
    report("complete");
    report("complete");
    expect(text().match(/✓ Goal achieved: ship it/g)).toHaveLength(1);
    expect(app.nativeGoal).toBeUndefined();
});

test("a CLI's goal doesn't follow /clear or /resume into another session", async () => {
    const { app } = testApp([]);
    const first = app.session;
    (app as any).nativeGoalReported({ provider: "codex", condition: "ship it", status: "active", since: Date.now() });
    expect(app.nativeGoal).toMatchObject({ condition: "ship it" });
    app.newSession();
    expect(app.nativeGoal).toBeUndefined();
    (app as any).nativeGoalReported({ provider: "codex", condition: "ship it", status: "active", since: Date.now() });
    app.resume(first);
    expect(app.nativeGoal).toBeUndefined();
});

test("/goal clear mid-turn also takes out a /goal still waiting in the queue", async () => {
    const { app, text } = testApp([]);
    (app as any).busy = true;
    await app.submitText("/goal the docs build");
    await app.submitText("and then this");
    expect((app as any).queued.map((d: any) => d.text)).toEqual(["/goal the docs build", "and then this"]);
    app.goal!.set("ship it");
    await app.submitText("/goal clear");
    expect(text()).toContain("Goal cleared: ship it. The queued /goal the docs build was taken out too.");
    expect((app as any).queued.map((d: any) => d.text)).toEqual(["and then this"]);
    expect(app.goal!.active).toBe(false);
    (app as any).busy = false;
});
