// SuggestTask / suggest_task (src/tools/suggest-tools.ts, src/agent/suggestions.ts): what the agent may suggest, what
// it's told, the card's states, and where the tool isn't offered.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
afterAll(() => iso.cleanup());
const { SuggestTaskTool, suggestServerTools, servedSuggestTool, nativeSuggestCall, servedSuggestName, SUGGEST_INSTRUCTIONS, SUGGEST_TOOL_NAMES } = await import("../src/tools/suggest-tools");
const { applyAction, branchSlug, checkSuggestion, pendingCount, refusal, rewoundAway, shownSuggestions, SUGGEST_LIMITS, SuggestionError } = await import("../src/agent/suggestions");
import type { SuggestionRecord, SuggestHost, SuggestionInput } from "../src/agent/suggestions";

const ROOT = join(import.meta.dir, "..");
const input = { title: "Login button misaligned", prompt: "The login button on /login sits 4px below the field. Fix the CSS in src/login.css.", why: "Saw it in the screenshot of /login." };
const rec = (o: Partial<SuggestionRecord> = {}): SuggestionRecord => ({ id: "c1", title: "Flaky auth test", prompt: "Fix it.", why: "It failed twice.", at: 1, state: "pending", seg: 1, msg: 3, ...o });
const ctx = (suggest?: SuggestHost, callId = "toolu_1") => ({ state: { suggest }, callId, signal: new AbortController().signal }) as never;

describe("input", () => {
    test("title, prompt and why are required, and bounded", () => {
        expect(checkSuggestion({ ...input, title: " " })).toEqual({ error: expect.stringContaining("title is required") });
        expect(checkSuggestion({ ...input, prompt: "" })).toEqual({ error: expect.stringContaining("prompt is required") });
        expect(checkSuggestion({ ...input, why: undefined })).toEqual({ error: expect.stringContaining("why is required") });
        expect(checkSuggestion({ ...input, title: "x".repeat(81) })).toEqual({ error: expect.stringContaining("keep it to 80") });
        expect(checkSuggestion({ ...input, prompt: "x".repeat(4001) })).toEqual({ error: expect.stringContaining("keep it to 4000") });
        expect(checkSuggestion({ ...input, why: "x".repeat(201) })).toEqual({ error: expect.stringContaining("keep it to 200") });
        expect(checkSuggestion({ ...input, model: "not a model" })).toEqual({ error: expect.stringContaining("provider:model") });
        expect(checkSuggestion({ ...input, effort: "huge" })).toEqual({ error: expect.stringContaining("effort must be one of") });
    });

    test("title and why are one line; hints kept; secrets redacted", () => {
        const c = checkSuggestion({ ...input, title: "Login\n  button", why: "Saw\nit", model: "codex:gpt-5", effort: "high", prompt: "Token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ leaks into the log." });
        if ("error" in c) throw new Error(c.error);
        expect(c.input.title).toBe("Login button");
        expect(c.input.why).toBe("Saw it");
        expect(c.input.hint).toEqual({ model: "codex:gpt-5", effort: "high" });
        expect(c.input.prompt).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    });

    test("no machine or folder in the schema: the card defaults to the suggesting session's", () => {
        expect(Object.keys(SuggestTaskTool.parameters.properties as object).sort()).toEqual(["effort", "model", "prompt", "title", "why"]);
        expect(SuggestTaskTool.parameters.required).toEqual(["title", "prompt", "why"]);
        expect(SuggestTaskTool.readOnly).toBe(true);
        expect(SuggestTaskTool.category).toBe("meta");
    });
});

describe("refusals", () => {
    test("at most 3 a turn, no repeat of a pending or dismissed title, at most 20 waiting", () => {
        expect(refusal([], "A", 3)).toContain("You've suggested 3 tasks this turn");
        expect(refusal([rec({ title: "Flaky Auth Test" })], "flaky auth test", 0)).toBe("“flaky auth test” is already suggested in this session.");
        expect(refusal([rec({ state: "starting" })], "Flaky auth test", 0)).toContain("already suggested");
        expect(refusal([rec({ state: "dismissed" })], "Flaky auth test", 0)).toBe("The user dismissed “Flaky auth test” in this session. Don't suggest it again.");
        // Started, or rewound away: may come up again.
        expect(refusal([rec({ state: "started" }), rec({ id: "c2", state: "withdrawn" })], "Flaky auth test", 0)).toBeUndefined();
        const many = Array.from({ length: 20 }, (_, i) => rec({ id: `c${i}`, title: `T${i}` }));
        expect(refusal(many, "Another", 0)).toBe("20 suggestions are waiting for the user in this session. Mention this one in your reply.");
        // One being started holds its place.
        expect(refusal([...many.slice(1), rec({ id: "s", title: "S", state: "starting" })], "Another", 0)).toContain("20 suggestions are waiting");
    });
});

describe("the tool", () => {
    test("returns at once: the agent is told nothing has started; the row says what it suggested", async () => {
        const got: { s: SuggestionInput; id: string }[] = [];
        const host: SuggestHost = { suggest: (s, id) => (got.push({ s, id }), { ok: true }) };
        const r = await SuggestTaskTool.run(input, ctx(host));
        expect(r.isError).toBeFalsy();
        expect(r.content).toBe("Suggested “Login button misaligned” to the user. Nothing has started: they decide. Carry on with your task; don't work on it here.");
        expect(r.display?.summary).toBe("Suggested “Login button misaligned”");
        expect(got).toEqual([{ s: { title: input.title, prompt: input.prompt, why: input.why }, id: "toolu_1" }]);
    });

    test("with no host (a sub-agent, a one-shot run, the terminal) it's refused; a host's refusal is the agent's", async () => {
        expect(await SuggestTaskTool.run(input, ctx(undefined))).toEqual({ content: "Tasks can't be suggested from here. Mention the problem in your reply instead.", isError: true });
        const r = await SuggestTaskTool.run(input, ctx({ suggest: () => ({ error: "nope" }) }));
        expect(r).toEqual({ content: "nope", isError: true });
    });

    test("served to the CLIs as suggest_task, read-only, its text naming itself so", async () => {
        const seen: unknown[] = [];
        const [t] = suggestServerTools(async (tool, args, _signal, callId) => (seen.push([tool.name, args, callId]), { text: "Suggested “x”. SuggestTask again for another." }));
        expect(t!.name).toBe("suggest_task");
        expect(t!.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
        expect(t!.description).not.toContain("SuggestTask");
        const r = await t!.call(input, { signal: new AbortController().signal, meta: { callId: "x1" } } as never);
        expect(r.text).toBe("Suggested “x”. suggest_task again for another.");
        expect(seen).toEqual([["SuggestTask", input, "x1"]]);
        expect(servedSuggestTool("cavvy", "mcp__cavvy__suggest_task")).toBe(true);
        expect(servedSuggestTool("cavvy", "mcp__cavvy__start_session")).toBe(false);
        expect(nativeSuggestCall("suggest_task", { a: 1 })).toEqual({ name: "SuggestTask", input: { a: 1 } });
        expect(servedSuggestName("SuggestTask")).toBe("suggest_task");
        expect(SUGGEST_INSTRUCTIONS).toContain("suggest_task");
    });

    test("not offered to sub-agents or in the terminal", () => {
        const agent = readFileSync(join(ROOT, "src/agent/agent.ts"), "utf-8");
        // The sub-agent's tools leave it out (and get no suggest host: their toolState is built without one).
        expect(agent).toMatch(/const exclude = new Set\(\[[^\]]*\.\.\.SUGGEST_TOOL_NAMES/);
        expect(SUGGEST_TOOL_NAMES).toEqual(["SuggestTask"]);
        // The terminal offers no SuggestTask (v1).
        expect(readFileSync(join(ROOT, "src/ui/app.ts"), "utf-8")).not.toMatch(/SUGGEST_TOOLS|suggest-tools/);
    });

    test("what it adds to every request, measured", () => {
        const schema = JSON.stringify(SuggestTaskTool.parameters);
        const chars = SuggestTaskTool.description.length + schema.length + SuggestTaskTool.name.length;
        // About 4 characters a token: the PR says what this comes to.
        console.log(`SuggestTask: description ${SuggestTaskTool.description.length} + schema ${schema.length} characters (≈${Math.round(chars / 4)} tokens); CLI instructions ${SUGGEST_INSTRUCTIONS.length} characters`);
        expect(chars).toBeLessThan(2600);
    });
});

describe("the card's states", () => {
    test("claim, then started or failed; dismiss and restore", () => {
        const claimed = applyAction(rec({ failed: "earlier" }), { action: "claim" });
        expect(claimed).toMatchObject({ state: "starting", failed: undefined });
        expect(() => applyAction(claimed, { action: "claim" })).toThrow(SuggestionError);
        // A claim whose window never came back (no started or failed) may be taken over after a while.
        const taken = applyAction(claimed, { action: "claim" }, claimed.claimedAt! + SUGGEST_LIMITS.staleClaimMs);
        expect(taken).toMatchObject({ state: "starting" });
        // The first window's late word is refused; the new claim's goes through.
        expect(() => applyAction(taken, { action: "failed", message: "x", claimedAt: claimed.claimedAt })).toThrow("another window");
        expect(() => applyAction(taken, { action: "started", started: { sessionId: "s9", title: "T", cwd: "/w", at: 1 } })).toThrow("another window");
        expect(() => applyAction(taken, { action: "failed", message: "x" })).toThrow("another window");
        const retakenFailed = applyAction(taken, { action: "failed", message: "x", claimedAt: taken.claimedAt });
        expect(retakenFailed.state).toBe("pending");
        // And after the newer claim failed, the older one's late success still isn't taken.
        expect(() => applyAction(retakenFailed, { action: "started", started: { sessionId: "s9", title: "T", cwd: "/w", at: 1 }, claimedAt: claimed.claimedAt })).toThrow("another window");
        expect(() => applyAction(retakenFailed, { action: "started", started: { sessionId: "s9", title: "T", cwd: "/w", at: 1 } })).toThrow("another window");
        // Not taken over: a window that doesn't send claimedAt is still heard.
        expect(applyAction(claimed, { action: "failed", message: "x" }).state).toBe("pending");
        expect(() => applyAction(claimed, { action: "dismissed" })).toThrow("It's being started.");
        const failed = applyAction(claimed, { action: "failed", message: "box didn't answer." });
        expect(failed).toMatchObject({ state: "pending", failed: "box didn't answer." });
        const started = applyAction(claimed, { action: "started", started: { sessionId: "s2", title: "T", cwd: "/w", at: 5 } });
        expect(started).toMatchObject({ state: "started", started: { sessionId: "s2", title: "T", cwd: "/w", at: 5 } });
        // The same start again: no change; another session: refused.
        expect(applyAction(started, { action: "started", started: { sessionId: "s2", title: "T", cwd: "/w", at: 6 } }).state).toBe("started");
        expect(() => applyAction(started, { action: "started", started: { sessionId: "s3", title: "T", cwd: "/w", at: 6 } })).toThrow("already started");
        expect(() => applyAction(started, { action: "failed", message: "x" })).toThrow();
        const dismissed = applyAction(rec(), { action: "dismissed" });
        expect(dismissed.state).toBe("dismissed");
        expect(() => applyAction(dismissed, { action: "claim" })).toThrow("Restore it to start it.");
        expect(applyAction(dismissed, { action: "pending" }).state).toBe("pending");
        expect(() => applyAction(rec({ state: "withdrawn" }), { action: "claim" })).toThrow("gone");
        try {
            applyAction(claimed, { action: "claim" });
        } catch (e) {
            expect((e as InstanceType<typeof SuggestionError>).code).toBe("not_pending");
        }
    });

    test("windows get none rewound away, invisible characters shown, old resolved ones without their prompt", () => {
        const resolved = Array.from({ length: SUGGEST_LIMITS.withPrompt + 2 }, (_, i) => rec({ id: `r${i}`, at: 10 + i, state: i % 2 ? "started" : "dismissed" }));
        const shown = shownSuggestions([rec({ id: "w", state: "withdrawn" }), rec({ id: "p", at: 100, title: "Fix‮evil", prompt: "do​this\nnow" }), ...resolved]);
        expect(shown.find((s) => s.id === "w")).toBeUndefined();
        const p = shown.find((s) => s.id === "p")!;
        expect(p.title).toBe("Fix⟨U+202E⟩evil");
        expect(p.prompt).toBe("do⟨U+200B⟩this\nnow");
        expect("seg" in p).toBe(false);
        expect(shown.filter((s) => s.prompt === undefined).map((s) => s.id)).toEqual(["r0", "r1"]);
        expect(pendingCount([rec(), rec({ id: "b", state: "dismissed" }), rec({ id: "c" })])).toBe(2);
    });

    test("a rewind takes away those made after what it keeps, in the same segment", () => {
        const rs = [rec({ id: "a", msg: 2 }), rec({ id: "b", msg: 5 }), rec({ id: "c", msg: 9, seg: 0 })];
        expect(rewoundAway(rs, 1, 4).map((r) => r.id)).toEqual(["b"]);
        expect(rewoundAway(rs, 1, 1).map((r) => r.id)).toEqual(["a", "b"]);
    });

    test("branch names", () => {
        expect(branchSlug("Login button misaligned!")).toBe("fix/login-button-misaligned");
        expect(branchSlug("Ünïcode & émoji 🎉")).toBe("fix/unicode-emoji");
        expect(branchSlug("!!!")).toBe("fix/task");
        // A leading "fix" isn't said twice.
        expect(branchSlug("Fix subtract() in math.ts returning a + b")).toBe("fix/subtract-in-math-ts-returning-a-b");
        expect(branchSlug("Fixes: login")).toBe("fix/login");
        expect(branchSlug("fixed")).toBe("fix/task");
        expect(branchSlug("Fixture loader flaky")).toBe("fix/fixture-loader-flaky");
        expect(branchSlug("a ".repeat(60)).length).toBeLessThanOrEqual(44);
    });
});
