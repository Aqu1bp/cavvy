// /goal: the controller (src/agent/goal.ts) with a fake host, and what the session file keeps.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";
import type { Message } from "../src/providers/types";

const iso = isolate();
const goalMod = await import("../src/agent/goal");
const { GoalController, parseGoalCommand, parseVerdict, selfReport, classifyError, judgePrompt, usedTools, goalSummary, GOAL_MAX_CHARS, IDLE_TURNS, RETRY_DELAYS_MS, BACKGROUND_WAIT_MS, CONTINUE_DISPLAY } = goalMod;
const { Session } = await import("../src/agent/session");
const { forkSession } = await import("../src/agent/fork");
type GoalHost = import("../src/agent/goal").GoalHost;

afterAll(() => iso.cleanup());

const user = (text: string, kind: "prompt" | "command" | "reminder" = "prompt"): Message => ({ role: "user", content: [{ type: "text", text }], meta: { kind } });
const said = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }], provider: "test", model: "m", stopReason: "end_turn" });
const tool = (name: string): Message => ({ role: "assistant", content: [{ type: "tool_call", id: `c-${name}`, name, input: { command: "bun test" } }], provider: "test", model: "m", stopReason: "tool_use" });
const result = (content: string): Message => ({ role: "user", content: [{ type: "tool_result", toolCallId: "c", toolName: "Bash", content }], meta: { kind: "tool_results" } });

/** A host that records what the controller asked for; timers run when the test says so. */
function harness(opts: { judge?: (system: string, prompt: string, signal: AbortSignal) => Promise<string>; canJudge?: boolean } = {}) {
    const session = Session.create(realpathSync(tempDir("goal-")), { persist: false });
    const notices: { text: string; level: string }[] = [];
    const turns: { prompt: string; display: string }[] = [];
    const timers: { fn: () => void; ms: number; id: number }[] = [];
    const judged: string[] = [];
    const alerts: { kind: string; text: string }[] = [];
    let changes = 0;
    let clock = 1_000_000;
    let tokens = 0;
    let background = 0;
    let idle = true;
    let seq = 0;
    const host: GoalHost = {
        session,
        tokens: () => tokens,
        canJudge: () => opts.canJudge ?? true,
        judge: async (system, prompt, signal) => {
            judged.push(prompt);
            if (opts.judge) return opts.judge(system, prompt, signal);
            return JSON.stringify({ verdict: "not_met", reason: "No test output yet." });
        },
        backgroundRunning: () => background,
        idle: () => idle,
        notice: (text, level) => notices.push({ text, level }),
        changed: () => void changes++,
        alert: (kind, text) => alerts.push({ kind, text }),
        startTurn: (prompt, display) => turns.push({ prompt, display }),
        setTimer: (fn, ms) => {
            const id = ++seq;
            timers.push({ fn, ms, id });
            return id;
        },
        clearTimer: (id) => {
            const i = timers.findIndex((t) => t.id === id);
            if (i >= 0) timers.splice(i, 1);
        },
        now: () => clock,
    };
    const goal = new GoalController(host);
    /** Run every due timer (and those they schedule with no delay). */
    const flush = (advance = 0) => {
        clock += advance;
        for (let n = 0; n < 50 && timers.length; n++) {
            const t = timers.shift()!;
            t.fn();
        }
    };
    /** A turn's messages, pushed to the session; returns where it started. */
    const turn = (...messages: Message[]) => {
        const from = session.messages.length;
        for (const m of messages) session.push(m);
        return from;
    };
    return {
        session, goal, host, notices, turns, timers, judged, alerts, flush, turn,
        changes: () => changes,
        setTokens: (n: number) => (tokens = n),
        setBackground: (n: number) => (background = n),
        setIdle: (v: boolean) => (idle = v),
        advance: (ms: number) => (clock += ms),
    };
}

describe("parseGoalCommand", () => {
    test("reads status, clear and its aliases, pause, resume and a condition", () => {
        expect(parseGoalCommand("")).toEqual({ kind: "status" });
        expect(parseGoalCommand("   ")).toEqual({ kind: "status" });
        for (const w of ["clear", "stop", "off", "reset", "none", "cancel", "CLEAR", " Stop "]) expect(parseGoalCommand(w)).toEqual({ kind: "clear" });
        expect(parseGoalCommand("pause")).toEqual({ kind: "pause" });
        expect(parseGoalCommand("resume")).toEqual({ kind: "resume" });
        expect(parseGoalCommand("continue")).toEqual({ kind: "resume" });
        expect(parseGoalCommand("all tests pass\nand lint is clean")).toEqual({ kind: "set", condition: "all tests pass\nand lint is clean" });
        // A word that only starts like a subcommand is a condition.
        expect(parseGoalCommand("stop the flaky test from failing")).toEqual({ kind: "set", condition: "stop the flaky test from failing" });
    });

    test("refuses a condition over the limit, and takes one at it", () => {
        expect(parseGoalCommand("x".repeat(GOAL_MAX_CHARS))).toEqual({ kind: "set", condition: "x".repeat(GOAL_MAX_CHARS) });
        const c = parseGoalCommand("x".repeat(GOAL_MAX_CHARS + 1));
        expect(c.kind).toBe("invalid");
        expect((c as { message: string }).message).toContain("4,000");
    });
});

describe("the check's answer", () => {
    test("parseVerdict takes JSON, fenced JSON and a bare word, and nothing else", () => {
        expect(parseVerdict('{"verdict":"met","reason":"12 pass"}')).toEqual({ verdict: "met", reason: "12 pass" });
        expect(parseVerdict('```json\n{"verdict": "not_met", "reason": "lint not run"}\n```')).toEqual({ verdict: "not_met", reason: "lint not run" });
        expect(parseVerdict('Here: {"verdict":"Not Met","reason":"x"}')).toEqual({ verdict: "not_met", reason: "x" });
        expect(parseVerdict('{"verdict":"impossible","reason":"contradiction"}')).toEqual({ verdict: "impossible", reason: "contradiction" });
        expect(parseVerdict("not met: the build fails")).toEqual({ verdict: "not_met", reason: "the build fails" });
        expect(parseVerdict("Met. Everything passes.")).toEqual({ verdict: "met", reason: "Everything passes." });
        expect(parseVerdict("I can't tell.")).toBeUndefined();
        // Prose that only mentions the word is never taken as a verdict, least of all as "met".
        expect(parseVerdict("The goal has not been met: the linter still reports 3 errors.")).toBeUndefined();
        expect(parseVerdict("It is not yet met.")).toBeUndefined();
        expect(parseVerdict('{"verdict":"maybe"}')).toBeUndefined();
    });

    test("selfReport reads the last GOAL: line of the turn's last report", () => {
        expect(selfReport([said("Done.\n\nGOAL: met")])).toEqual({ verdict: "met", reason: "" });
        expect(selfReport([said("GOAL: not met — lint still fails")])).toEqual({ verdict: "not_met", reason: "lint still fails" });
        expect(selfReport([said("**GOAL: impossible** - the API was removed")])).toEqual({ verdict: "impossible", reason: "the API was removed" });
        expect(selfReport([said("**GOAL:** met")])).toEqual({ verdict: "met", reason: "" });
        expect(selfReport([said("`GOAL:` **not met** — docs")])).toEqual({ verdict: "not_met", reason: "docs" });
        // The last line wins; an earlier message's report is overtaken by a later one.
        expect(selfReport([said("GOAL: not met — x"), tool("Bash"), said("GOAL: not met — y\nGOAL: met")])?.verdict).toBe("met");
        expect(selfReport([said("No status here")])).toBeUndefined();
        // The prompt's instructions (a user message) are never read as a report.
        expect(selfReport([user("End with `GOAL: met`")])).toBeUndefined();
    });

    test("classifyError: fix-it errors, limits, and the rest", () => {
        expect(classifyError("401 Unauthorized: invalid x-api-key")).toBe("fatal");
        expect(classifyError("Your credit balance is too low to access the Anthropic API")).toBe("fatal");
        expect(classifyError("insufficient_quota: You exceeded your current quota")).toBe("fatal");
        expect(classifyError("prompt is too long: 250000 tokens > 200000 maximum")).toBe("fatal");
        expect(classifyError('The model "gpt-9" does not exist or is not available')).toBe("fatal");
        expect(classifyError("429 Too Many Requests: rate_limit_error")).toBe("limit");
        expect(classifyError("You've hit your usage limit. It resets at 5pm.")).toBe("limit");
        expect(classifyError("529 Overloaded")).toBe("transient");
        expect(classifyError("fetch failed: ECONNRESET")).toBe("transient");
        expect(classifyError("")).toBe("transient");
    });

    test("usedTools sees the harness's tool calls and a CLI backend's actions note", () => {
        expect(usedTools([said("thinking about it")])).toBe(false);
        expect(usedTools([tool("Bash")])).toBe(true);
        expect(usedTools([said("[Claude Code used: Bash(bun test), Edit(src/a.ts)]")])).toBe(true);
        expect(usedTools([user("[Claude Code used: Bash]")])).toBe(false);
    });

    test("judgePrompt keeps the newest conversation within its budget, trims tool output, drops reminders", () => {
        const big = "line\n".repeat(2000);
        const messages: Message[] = [user("first prompt"), tool("Bash"), result(big), user("<system-reminder>mode note</system-reminder>steer"), said("latest words")];
        const p = judgePrompt("tests pass", messages, { turns: 2, minutes: 5 });
        expect(p).toContain("<goal>\ntests pass\n</goal>");
        expect(p).toContain("Check 2 of this goal; it has been running 5 minutes.");
        expect(p).toContain("AGENT: latest words");
        expect(p).toContain("USER: steer");
        expect(p).not.toContain("mode note");
        expect(p).toContain("characters cut");
        expect(p.length).toBeLessThan(6000);
        const small = judgePrompt("x", messages, { turns: 1, minutes: 1 }, 50);
        expect(small).toContain("[earlier conversation omitted]");
        expect(small).toContain("latest words");
        expect(small).not.toContain("first prompt");
        expect(small).toContain("1 minute.");
    });

    test("goalSummary", () => {
        expect(goalSummary(1, 4000, 0)).toBe("1 turn · 4s");
        expect(goalSummary(3, 250_000, 120_400)).toBe("3 turns · 4m 10s · 120k tokens");
        expect(goalSummary(12, 2 * 3600_000 + 60_000, 1_500_000)).toBe("12 turns · 2h 1m · 1.50M tokens");
    });
});

describe("GoalController", () => {
    test("setting a goal saves it and gives the first turn's prompt; replacing one says so", () => {
        const h = harness();
        const first = h.goal.set("all tests in test/auth pass");
        expect(first.display).toBe("/goal all tests in test/auth pass");
        expect(first.prompt).toContain("all tests in test/auth pass");
        expect(first.prompt).toContain("separate check");
        expect(first.prompt).not.toContain("GOAL: met");
        expect(h.session.goal).toEqual({ condition: "all tests in test/auth pass", setAt: 1_000_000 });
        expect(h.goal.view()).toMatchObject({ condition: "all tests in test/auth pass", state: "active", turns: 0, judge: "model" });
        h.goal.set("lint is clean");
        expect(h.notices.at(-1)!.text).toBe("Replaced the goal: all tests in test/auth pass");
        expect(h.goal.condition).toBe("lint is clean");
    });

    test("not met: the reason is shown and the next turn starts with it as guidance; met: cleared with a summary", async () => {
        let n = 0;
        const h = harness({ judge: async () => (++n === 1 ? '{"verdict":"not_met","reason":"Lint has not been run."}' : '{"verdict":"met","reason":"Tests and lint pass."}') });
        h.goal.set("tests and lint pass");
        h.setTokens(5000);
        await h.goal.afterTurn("done", h.turn(user("go"), tool("Bash"), result("12 pass"), said("Tests pass.")), true);
        expect(h.notices.at(-1)).toEqual({ text: "◎ Goal not met yet: Lint has not been run.", level: "info" });
        expect(h.goal.pending()).toBe(true);
        expect(h.turns).toEqual([]);
        h.flush();
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0]!.display).toBe(CONTINUE_DISPLAY);
        expect(h.turns[0]!.prompt).toContain("It isn't met yet: Lint has not been run.");
        expect(h.goal.pending()).toBe(false);
        h.setTokens(9000);
        h.advance(65_000);
        await h.goal.afterTurn("done", h.turn(user("keep going"), tool("Bash"), said("Lint is clean.")), true);
        expect(h.goal.active).toBe(false);
        expect(h.session.goal).toBeUndefined();
        expect(h.notices.at(-1)!.text).toBe("✓ Goal achieved: tests and lint pass (2 turns · 1m 5s · 9.0k tokens)\nTests and lint pass.");
        expect(h.goal.last).toMatchObject({ result: "met", turns: 2, tokens: 9000 });
        // The user who walked away hears that it finished (and not of each turn).
        expect(h.alerts).toEqual([{ kind: "done", text: h.notices.at(-1)!.text }]);
        h.flush();
        expect(h.turns).toHaveLength(1);
        // Only the newest part of the conversation goes to the check, with the progress line.
        expect(h.judged[1]).toContain("Check 2 of this goal");
    });

    test("impossible ends the goal with the reason", async () => {
        const h = harness({ judge: async () => '{"verdict":"impossible","reason":"The file it names was never in this repo."}' });
        h.goal.set("restore deleted.ts from git");
        await h.goal.afterTurn("done", h.turn(user("go"), tool("Bash"), said("No such file in history.")), true);
        expect(h.goal.active).toBe(false);
        expect(h.notices.at(-1)).toEqual({ text: "✗ Goal stopped, judged impossible: The file it names was never in this repo.", level: "warn" });
        expect(h.goal.last).toMatchObject({ result: "impossible" });
    });

    test("without a model to check, the working model reports for itself", async () => {
        const h = harness({ canJudge: false });
        const first = h.goal.set("docs build");
        expect(first.prompt).toContain("GOAL: met");
        expect(h.goal.view()!.judge).toBe("self");
        await h.goal.afterTurn("done", h.turn(user("go"), tool("Bash"), said("Built.\nGOAL: not met — two broken links")), true);
        expect(h.judged).toEqual([]);
        expect(h.notices.at(-1)!.text).toBe("◎ Goal not met yet: two broken links");
        h.flush();
        expect(h.turns[0]!.prompt).toContain("GOAL: met");
        // No report at all counts as not met.
        await h.goal.afterTurn("done", h.turn(user("again"), tool("Edit"), said("Fixed one.")), true);
        expect(h.notices.at(-1)!.text).toBe("◎ Goal not met yet: No goal status was reported at the end of the turn.");
        await h.goal.afterTurn("done", h.turn(user("again"), tool("Edit"), said("All fixed.\nGOAL: met")), true);
        expect(h.goal.active).toBe(false);
    });

    test(`${IDLE_TURNS} goal turns in a row without a tool pause it; the goal stays set and a message picks it up`, async () => {
        const h = harness();
        h.goal.set("x");
        for (let i = 0; i < IDLE_TURNS - 1; i++) {
            await h.goal.afterTurn("done", h.turn(user("k"), said("I will do it.")), true);
            h.flush();
        }
        expect(h.turns).toHaveLength(IDLE_TURNS - 1);
        await h.goal.afterTurn("done", h.turn(user("k"), said("Still planning.")), true);
        expect(h.goal.view()!.state).toBe("paused");
        expect(h.notices.at(-1)!.text).toContain(`${IDLE_TURNS} turns in a row without using a tool`);
        expect(h.goal.pending()).toBe(false);
        h.flush();
        expect(h.turns).toHaveLength(IDLE_TURNS - 1);
        // A turn the user starts makes it active again; its end is checked.
        h.goal.userTurn();
        expect(h.goal.view()!.state).toBe("active");
        await h.goal.afterTurn("done", h.turn(user("try the tests"), tool("Bash")), false);
        h.flush();
        expect(h.turns).toHaveLength(IDLE_TURNS);
    });

    test("a user's own turn without tools doesn't count toward the idle pause", async () => {
        const h = harness();
        h.goal.set("x");
        for (let i = 0; i < IDLE_TURNS + 1; i++) {
            await h.goal.afterTurn("done", h.turn(user("question?"), said("answer")), false);
            h.flush();
        }
        expect(h.goal.view()!.state).toBe("active");
    });

    test("an interrupt pauses it without a check; /goal resume checks where it stands, then continues", async () => {
        const h = harness();
        h.goal.set("x");
        await h.goal.afterTurn("aborted", h.turn(user("go")), true);
        expect(h.judged).toEqual([]);
        expect(h.goal.view()).toMatchObject({ state: "paused" });
        expect(h.goal.view()!.note).toBe("Interrupted. It continues after your next message, or /goal resume.");
        h.flush();
        expect(h.turns).toEqual([]);
        // Ending another turn while paused does nothing.
        await h.goal.afterTurn("done", h.turn(user("x"), tool("Bash")), true);
        expect(h.judged).toEqual([]);
        expect(h.goal.resume()).toBe(true);
        await Bun.sleep(0);
        expect(h.judged).toHaveLength(1);
        h.flush();
        expect(h.turns).toHaveLength(1);
    });

    test("/goal resume ends the goal at once when the check finds it already met", async () => {
        const h = harness({ judge: async () => '{"verdict":"met","reason":"Already green."}' });
        h.goal.restore({ condition: "x", setAt: 1 });
        h.goal.resume();
        await Bun.sleep(0);
        expect(h.goal.active).toBe(false);
        expect(h.turns).toEqual([]);
        expect(h.notices.at(-1)!.text).toStartWith("✓ Goal achieved: x (1 turn");
    });

    test("/goal resume while a turn runs waits for that turn's end", async () => {
        const h = harness();
        h.goal.set("x");
        h.goal.pause("Paused with /goal pause.");
        h.setIdle(false);
        h.goal.resume();
        await Bun.sleep(0);
        expect(h.judged).toEqual([]);
        expect(h.goal.view()!.state).toBe("active");
        h.setIdle(true);
        await h.goal.afterTurn("done", h.turn(user("go"), tool("Bash")), false);
        expect(h.judged).toHaveLength(1);
    });

    test("denied and blocked turns pause it", async () => {
        for (const reason of ["denied", "blocked", "max_turns"] as const) {
            const h = harness();
            h.goal.set("x");
            await h.goal.afterTurn(reason, h.turn(user("go")), true);
            expect(h.goal.view()!.state).toBe("paused");
            expect(h.notices.at(-1)!.level).toBe("warn");
        }
    });

    test("an error you have to fix clears the goal", async () => {
        const h = harness();
        h.goal.set("x");
        const from = h.turn(user("go"));
        h.session.recordNotice("error", "401 Unauthorized: invalid x-api-key");
        await h.goal.afterTurn("error", from, true);
        expect(h.goal.active).toBe(false);
        expect(h.notices.at(-1)!.text).toBe("Goal cleared after an unrecoverable error: 401 Unauthorized: invalid x-api-key. Fix it, then run /goal again to continue.");
        expect(h.alerts.map((a) => a.kind)).toEqual(["error"]);
    });

    test("a limit pauses it", async () => {
        const h = harness();
        h.goal.set("x");
        const from = h.turn(user("go"));
        h.session.recordNotice("error", "You've hit your usage limit. It resets at 5pm.");
        await h.goal.afterTurn("error", from, true);
        expect(h.goal.view()!.state).toBe("paused");
        expect(h.notices.at(-1)!.text).toStartWith("Goal paused: You've hit your usage limit");
        expect(h.alerts.map((a) => a.kind)).toEqual(["done"]);
    });

    test.each([
        "Service unavailable (503). Provider requested retry after 600s; automatic retries stop above 300s. Try again after that wait.",
        "Google Gemini: You exceeded your current quota, please check your plan and billing details. Please retry in 33.9s. (429)",
        'Google Gemini: You exceeded your current quota, please check your plan and billing details. {"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"33s"}',
        'Google Gemini: You exceeded your current quota, please check your plan and billing details. {"quotaId":"RequestsPerMinute"}',
        'Google Gemini: You exceeded your current quota, please check your plan and billing details. {"quotaId":"RequestsPerDay"}',
    ])("provider waits pause the goal without clearing it or scheduling an early retry: %s", async (message) => {
        expect(classifyError(message)).toBe("limit");
        const h = harness();
        h.goal.set("finish the work");
        const from = h.turn(user("go"));
        h.session.recordNotice("error", message);
        await h.goal.afterTurn("error", from, true);
        expect(h.goal.view()).toMatchObject({ state: "paused", condition: "finish the work" });
        expect(h.timers).toEqual([]);
        h.flush(120_000);
        expect(h.turns).toEqual([]);
        expect(h.notices.at(-1)!.text).toStartWith("Goal paused:");
    });

    test.each(["object", "array", "string-wrapped"])("Gemini structured retry details survive classification after HTTP formatting: %s", async (shape) => {
        const { httpError } = await import("../src/providers/openai-compat");
        const error = {
            code: 429,
            message: "You exceeded your current quota, please check your plan and billing details.",
            status: "RESOURCE_EXHAUSTED",
            details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "33s" }, { quotaId: "RequestsPerMinute" }],
        };
        const body = shape === "array" ? [{ error }] : shape === "string-wrapped" ? { error: { message: JSON.stringify({ error }) } } : { error };
        const e = httpError(429, "Too Many Requests", JSON.stringify(body), "33", "Google Gemini");
        expect(e.retryable).toBe(true);
        expect(classifyError(e.message)).toBe("limit");
        const h = harness();
        h.goal.set("finish the work");
        const from = h.turn(user("go"));
        h.session.recordNotice("error", e.message);
        await h.goal.afterTurn("error", from, true);
        expect(h.goal.view()?.state).toBe("paused");
        expect(h.timers).toEqual([]);
        // Explicit OpenAI quota codes still clear a goal after the HTTP formatter drops the code.
        const permanent = httpError(429, "Too Many Requests", JSON.stringify({ error: { code: "insufficient_quota", message: error.message } }), null, "OpenAI");
        expect(permanent.retryable).toBe(false);
        expect(classifyError(permanent.message)).toBe("fatal");
    });

    test("Vertex's explicit billing-disabled error still clears the goal", async () => {
        const { vertexError } = await import("../src/providers/vertex");
        const e = vertexError(403, "Forbidden", JSON.stringify({ error: { message: "BILLING_DISABLED" } }), "Vertex AI", { project: "test-project", account: "test@example.com" } as any);
        expect(e.message).toContain("no billing account linked");
        expect(classifyError(e.message)).toBe("fatal");
        const h = harness();
        h.goal.set("finish the work");
        const from = h.turn(user("go"));
        h.session.recordNotice("error", e.message);
        await h.goal.afterTurn("error", from, true);
        expect(h.goal.active).toBe(false);
        expect(h.notices.at(-1)!.text).toStartWith("Goal cleared after an unrecoverable error:");
    });

    test("other errors retry after a wait, three times, then pause; a success resets the count", async () => {
        const h = harness();
        h.goal.set("x");
        const fail = async () => {
            const from = h.turn(user("go"));
            h.session.recordNotice("error", "529 Overloaded");
            await h.goal.afterTurn("error", from, true);
        };
        for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
            await fail();
            expect(h.goal.view()).toMatchObject({ state: "waiting", retryAt: expect.any(Number) });
            expect(h.goal.pending()).toBe(true);
            expect(h.timers.at(-1)!.ms).toBe(RETRY_DELAYS_MS[i]!);
            expect(h.notices.at(-1)!.text).toBe(`Goal still active: retrying in ${RETRY_DELAYS_MS[i]! / 1000}s after an error (${i + 1} of ${RETRY_DELAYS_MS.length}).`);
            h.flush(RETRY_DELAYS_MS[i]!);
            expect(h.turns).toHaveLength(i + 1);
        }
        await fail();
        expect(h.goal.view()!.state).toBe("paused");
        expect(h.notices.at(-1)!.text).toContain(`still failing after ${RETRY_DELAYS_MS.length} retries`);
        // After a resume and a good turn, errors get their retries again.
        h.goal.resume();
        await Bun.sleep(0);
        h.flush();
        await h.goal.afterTurn("done", h.turn(user("k"), tool("Bash")), true);
        h.flush();
        await fail();
        expect(h.goal.view()!.state).toBe("waiting");
    });

    test("delegated tasks still running hold the check until they finish", async () => {
        const h = harness();
        h.goal.set("x");
        h.setBackground(2);
        await h.goal.afterTurn("done", h.turn(user("go"), tool("Task")), true);
        expect(h.goal.view()!.state).toBe("waiting");
        expect(h.goal.pending()).toBe(true);
        expect(h.judged).toEqual([]);
        h.timers.shift()!.fn();
        expect(h.judged).toEqual([]);
        h.setBackground(0);
        h.timers.shift()!.fn();
        await Bun.sleep(0);
        expect(h.judged).toHaveLength(1);
    });

    test(`background work holds the check for ${BACKGROUND_WAIT_MS / 60_000} minutes at most`, async () => {
        const h = harness();
        h.goal.set("x");
        h.setBackground(1);
        await h.goal.afterTurn("done", h.turn(user("go"), tool("Task")), true);
        h.advance(BACKGROUND_WAIT_MS);
        h.timers.shift()!.fn();
        await Bun.sleep(0);
        expect(h.judged).toHaveLength(1);
    });

    test("a user's turn overtakes a check in flight: its verdict is dropped", async () => {
        let release!: (s: string) => void;
        const h = harness({ judge: () => new Promise<string>((r) => (release = r)) });
        h.goal.set("x");
        const checking = h.goal.afterTurn("done", h.turn(user("go"), tool("Bash")), true);
        await Bun.sleep(0);
        expect(h.goal.view()!.state).toBe("checking");
        expect(h.goal.pending()).toBe(true);
        h.goal.userTurn();
        expect(h.goal.view()!.state).toBe("active");
        release('{"verdict":"not_met","reason":"late"}');
        await checking;
        h.flush();
        expect(h.turns).toEqual([]);
        expect(h.notices.map((n) => n.text)).not.toContain("◎ Goal not met yet: late");
    });

    test("clear during a check drops it; a check that fails twice pauses with the reason", async () => {
        let release!: (s: string) => void;
        const h = harness({ judge: () => new Promise<string>((r) => (release = r)) });
        h.goal.set("x");
        const checking = h.goal.afterTurn("done", h.turn(user("go"), tool("Bash")), true);
        await Bun.sleep(0);
        expect(h.goal.clear()).toBe("x");
        release('{"verdict":"met","reason":"done"}');
        await checking;
        expect(h.notices.some((n) => n.text.startsWith("✓"))).toBe(false);
        expect(h.goal.clear()).toBeUndefined();

        const bad = harness({ judge: async () => "I am not sure" });
        bad.goal.set("x");
        await bad.goal.afterTurn("done", bad.turn(user("go"), tool("Bash")), true);
        expect(bad.judged).toHaveLength(2);
        expect(bad.goal.view()!.state).toBe("paused");
        expect(bad.notices.at(-1)!.text).toBe("Goal paused: couldn't check the goal (its answer wasn't a verdict). Send a message or /goal resume to continue.");

        const down = harness({ judge: async () => { throw new Error("fetch failed"); } });
        down.goal.set("x");
        await down.goal.afterTurn("done", down.turn(user("go"), tool("Bash")), true);
        expect(down.notices.at(-1)!.text).toContain("couldn't check the goal (fetch failed)");
    });

    test("the next turn waits while something else runs (a command, a queued message)", async () => {
        const h = harness();
        h.goal.set("x");
        await h.goal.afterTurn("done", h.turn(user("go"), tool("Bash")), true);
        h.setIdle(false);
        h.timers.shift()!.fn();
        expect(h.turns).toEqual([]);
        expect(h.timers).toHaveLength(1);
        h.setIdle(true);
        h.flush();
        expect(h.turns).toHaveLength(1);
    });

    test("pause during the wait for the next turn stops it", async () => {
        const h = harness();
        h.goal.set("x");
        await h.goal.afterTurn("done", h.turn(user("go"), tool("Bash")), true);
        h.goal.pause("Paused with /goal pause.");
        h.flush();
        expect(h.turns).toEqual([]);
        expect(h.goal.pending()).toBe(false);
    });

    test("a compaction during the turn: what's left is the turn's, and its error is found by time", async () => {
        const h = harness({ canJudge: false });
        h.goal.set("x");
        // The turn started at message 40; a compaction left 3 messages, the last with the report.
        for (let i = 0; i < 3; i++) h.session.push(i === 2 ? said("GOAL: met") : tool("Bash"));
        await h.goal.afterTurn("done", 40, true);
        expect(h.goal.active).toBe(false);
        expect(h.notices.at(-1)!.text).toStartWith("✓ Goal achieved");

        const e = harness();
        e.goal.set("x");
        const startedAt = Date.now();
        e.session.recordNotice("error", "429 Too Many Requests");
        // An old error from before the turn doesn't count; its index doesn't matter.
        e.session.notices[0]!.at = startedAt - 10_000;
        e.session.notices.push({ index: 0, level: "error", text: "invalid x-api-key", at: startedAt + 5 });
        await e.goal.afterTurn("error", 99, true, startedAt);
        expect(e.goal.active).toBe(false);
        expect(e.notices.at(-1)!.text).toContain("invalid x-api-key");
    });

    test("a user's turn tells the UI its check is gone, even from checking to active", async () => {
        let release!: (s: string) => void;
        const h = harness({ judge: () => new Promise<string>((r) => (release = r)) });
        h.goal.set("x");
        void h.goal.afterTurn("done", h.turn(user("go"), tool("Bash")), true);
        await Bun.sleep(0);
        const before = h.changes();
        h.goal.userTurn();
        expect(h.changes()).toBe(before + 1);
        expect(h.goal.view()!.state).toBe("active");
        release("{}");
    });

    test("the next turn starts before the UI hears of it, so it never reads as idle in between", async () => {
        const h = harness();
        const seen: boolean[] = [];
        h.host.changed = () => seen.push(h.goal.pending() || h.turns.length > 0);
        h.goal.set("x");
        seen.length = 0;
        await h.goal.afterTurn("done", h.turn(user("go"), tool("Bash")), true);
        h.flush();
        expect(h.turns).toHaveLength(1);
        // checking → (not met, next turn scheduled) → turn started: each change shows something coming.
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every(Boolean)).toBe(true);
    });

    test("/goal resume waits for delegated work before it checks", async () => {
        const h = harness();
        h.goal.restore({ condition: "x", setAt: 1 });
        h.setBackground(1);
        h.goal.resume();
        expect(h.goal.view()!.state).toBe("waiting");
        expect(h.judged).toEqual([]);
        h.setBackground(0);
        h.timers.shift()!.fn();
        await Bun.sleep(0);
        expect(h.judged).toHaveLength(1);
    });

    test("a reopened session's goal comes back paused, with counters reset", () => {
        const h = harness();
        h.setTokens(50_000);
        h.goal.restore({ condition: "ship it", setAt: 5 });
        expect(h.goal.view()).toMatchObject({ condition: "ship it", state: "paused", turns: 0, tokens: 0, since: 1_000_000 });
        expect(h.goal.view()!.note).toContain("Restored");
        expect(h.goal.pending()).toBe(false);
        // Nothing to restore, or one already set: nothing changes.
        h.goal.restore(undefined);
        h.goal.restore({ condition: "other", setAt: 1 });
        expect(h.goal.condition).toBe("ship it");
    });

    test("dispose stops pending timers", async () => {
        const h = harness();
        h.goal.set("x");
        await h.goal.afterTurn("done", h.turn(user("go"), tool("Bash")), true);
        h.goal.dispose();
        h.flush();
        expect(h.turns).toEqual([]);
    });
});

describe("the session file", () => {
    test("keeps the goal across a reload and forgets it once it ends; a fork starts without it", () => {
        const s = Session.create(realpathSync(tempDir("goal-session-")));
        s.push(user("hello"));
        s.push(said("hi"));
        s.setGoal({ condition: "all green", setAt: 42 });
        const again = Session.load(s.path);
        expect(again.goal).toEqual({ condition: "all green", setAt: 42 });
        const fork = forkSession(again, { cut: again.messages.length });
        expect(fork.goal).toBeUndefined();
        s.setGoal(null);
        expect(Session.load(s.path).goal).toBeUndefined();
        // Clearing when there's none writes nothing.
        const lines = readFileSync(s.path, "utf8").trim().split("\n").length;
        s.setGoal(null);
        expect(readFileSync(s.path, "utf8").trim().split("\n").length).toBe(lines);
    });

    test("ignores a malformed goal line", () => {
        const s = Session.create(realpathSync(tempDir("goal-bad-")));
        s.push(user("hello"));
        s.setGoal({ condition: "  ", setAt: 1 });
        expect(Session.load(s.path).goal).toBeUndefined();
    });
});
