// A suggested task's card (gui/src/state/suggestions.ts, gui/src/lib/cards.ts): what it starts with, what Start asks
// of which machine and in what order, and what each failure says. The server's side is test/gui-suggest.test.ts.
import { expect, test } from "bun:test";
import type { ModelSummary, SuggestionState, ToolBlock } from "../src/server/protocol";
import { cardOf, staysInTurn } from "../gui/src/lib/cards";
import { workSegments } from "../gui/src/lib/live-line";
import { RpcError } from "../gui/src/lib/rpc";
import { chooseEffort, chooseModel, startProblem, startSuggestion, visible, whyLine, type StartCalls, type StartPick } from "../gui/src/state/suggestions";

const tool = (name: string, extra: Partial<ToolBlock> = {}) => ({ t: "tool", id: "t1", name, title: name, status: "ok", input: {}, ...extra }) as ToolBlock;

test("a SuggestTask call is a card of its own, by either name; a sub-agent's isn't", () => {
    expect(cardOf(tool("SuggestTask"))).toBe("suggest");
    expect(cardOf(tool("mcp__cavvy__suggest_task"))).toBe("suggest");
    expect(cardOf(tool("SuggestTask", { agent: true } as never))).toBeUndefined();
    expect(cardOf(tool("Read"))).toBeUndefined();
});

test("the card stays in its turn when the work folds away, as a plan's does", () => {
    expect(staysInTurn("suggest")).toBe(true);
    expect(staysInTurn("plan")).toBe(true);
    expect(staysInTurn("edit")).toBe(false);
    const segs = workSegments([
        { kind: "activity", card: undefined },
        { kind: "activity", card: "suggest" },
        { kind: "activity", card: "edit" },
    ] as never);
    expect(segs.map((s) => s.kind)).toEqual(["work", "item", "work"]);
});

test("what wouldn't show is written out; a prompt keeps its lines and tabs", () => {
    expect(visible("Fix login‮")).toBe("Fix login⟨U+202E⟩");
    expect(visible("a​b")).toBe("a⟨U+200B⟩b");
    expect(visible("one\ntwo")).toBe("one⟨U+000A⟩two");
    expect(visible("one\r\n\ttwo⁦", true)).toBe("one\n\ttwo⟨U+2066⟩");
});

test("the why line goes when it only says the title again", () => {
    expect(whyLine({ title: "Fix the flaky login test", why: "Fix the flaky login test." })).toBeUndefined();
    expect(whyLine({ title: "Fix it", why: "  " })).toBeUndefined();
    expect(whyLine({ title: "Fix it", why: "test/login.test.ts failed twice, passed on rerun." })).toBe("test/login.test.ts failed twice, passed on rerun.");
});

const m = (ref: string, extra: Partial<ModelSummary> = {}): ModelSummary => ({ ref, provider: ref.split(":")[0]!, id: ref.split(":")[1]!, name: ref, ...extra });

test("the model: the user's pick, else the agent's hint, else the suggester's, where the target has it; else the target's default", () => {
    const models = [m("codex:gpt-6"), m("claude-code:opus")];
    expect(chooseModel({ picked: "codex:gpt-6", hint: "claude-code:opus", models })).toBe("codex:gpt-6");
    expect(chooseModel({ hint: "claude-code:opus", suggester: "codex:gpt-6", models })).toBe("claude-code:opus");
    // The hint isn't on the target: the suggester's model.
    expect(chooseModel({ hint: "api:other", suggester: "codex:gpt-6", targetDefault: "claude-code:opus", models })).toBe("codex:gpt-6");
    expect(chooseModel({ hint: "api:other", suggester: "api:mine", targetDefault: "claude-code:opus", models })).toBe("claude-code:opus");
    // A pick for a machine that doesn't have it (picked, then the machine changed): the next in line.
    expect(chooseModel({ picked: "api:gone", suggester: "codex:gpt-6", models })).toBe("codex:gpt-6");
    // The target's models not listed yet: the first named (the machine says if it hasn't it).
    expect(chooseModel({ hint: "api:other", suggester: "codex:gpt-6", models: [] })).toBe("api:other");
});

test("the effort: the first the model takes", () => {
    const model = m("codex:gpt-6", { supportsReasoning: true, effortLevels: ["low", "medium", "high"] });
    expect(chooseEffort(model, { picked: "xhigh", hint: "high", targetDefault: "low" })).toBe("high");
    expect(chooseEffort(model, { suggester: "medium", targetDefault: "low" })).toBe("medium");
    expect(chooseEffort(m("api:plain"), { picked: "high" })).toBeUndefined();
    expect(chooseEffort(undefined, { picked: "high" })).toBeUndefined();
});

test("each failure of tasks.start says what to do, on that machine", () => {
    const pick = { on: "box", cwd: "/home/me/app", model: "codex:gpt-6", effort: "high" as const };
    const models = [m("codex:gpt-6", { name: "GPT-6" })];
    expect(startProblem(new RpcError("x", "no_folder", "/home/me/app"), pick)).toEqual({ message: "No folder /home/me/app on box." });
    expect(startProblem(new RpcError("x", "model_unavailable"), pick, models)).toEqual({ message: "GPT-6 isn't available on box. Pick another." });
    expect(startProblem(new RpcError("x", "not_git"), pick).message).toBe("/home/me/app isn't a Git repository. Turn off New worktree.");
    expect(startProblem(new RpcError("Disconnected", "disconnected"), pick)).toEqual({ message: "box didn't answer.", retry: true });
    expect(startProblem(new Error("socket"), { ...pick, on: undefined }).message).toMatch(/^This (Mac|computer) didn't answer\.$/);
    expect(startProblem(new RpcError("Branch fix/x couldn't be made", "worktree_failed"), pick)).toEqual({ message: "Branch fix/x couldn't be made", retry: true });
});

// ---------------------------------------------------------------------------
// Start, against calls of the test's own

const suggestion: SuggestionState = { id: "call-1", title: "Fix the flaky test", prompt: "It fails", why: "Saw it fail", at: 0, state: "pending" };
const pick = (extra: Partial<StartPick> = {}): StartPick => ({ sessionId: "s1", from: { title: "Add SSO", mode: "acceptEdits", on: undefined }, suggestion, on: undefined, cwd: "/repo", title: "Fix the flaky test", prompt: "It fails", model: "codex:gpt-6", effort: "high", worktree: true, ...extra });

function calls(o: { claim?: Error; start?: (params: any) => unknown; link?: Error; after?: Error } = {}) {
    const log: unknown[] = [];
    const trusts: string[] = [];
    const made: unknown[] = [];
    const c: StartCalls = {
        suggestion: async (params) => {
            log.push(["session.suggestion", params]);
            if (params.action === "claim" && o.claim) throw o.claim;
            if (params.action !== "claim" && o.after) throw o.after;
            return params.action === "claim" ? { ...suggestion, state: "starting", claimedAt: 1234 } : {};
        },
        link: async (on) => {
            if (o.link) throw o.link;
            return { call: (async (method: string, params: unknown) => (log.push([method, on, params]), o.start ? o.start(params) : { sessionId: "new-1", title: "Fix the flaky test", cwd: "/repo/.worktrees/fix", worktree: { path: "/repo/.worktrees/fix", branch: "fix/flaky" } })) as never };
        },
        trust: (folder, then) => {
            trusts.push(folder);
            void then;
        },
        again: () => undefined,
        made: (id, _link, on) => void made.push([id, on]),
    };
    return { c, log, trusts, made };
}

test("Start claims, starts on the target, then says it started: in that order", async () => {
    const { c, log } = calls();
    const out = await startSuggestion(pick(), c);
    expect(out.kind).toBe("started");
    expect(log.map((l) => (l as [string, any])[0] === "session.suggestion" ? `suggestion:${(l as any)[1].action}` : (l as any)[0])).toEqual(["suggestion:claim", "tasks.start", "suggestion:started"]);
    const start = (log[1] as [string, unknown, any])[2];
    expect(start).toMatchObject({ cwd: "/repo", title: "Fix the flaky test", prompt: "It fails", model: "codex:gpt-6", effort: "high", worktree: true, mode: "acceptEdits", origin: { key: "s1#call-1", session: "s1", title: "Add SSO" } });
    // The same machine as the suggesting session: neither names it.
    expect(start.origin.machine).toBeUndefined();
    const started = (log[2] as [string, any])[1].started;
    expect(started).toMatchObject({ sessionId: "new-1", worktree: { branch: "fix/flaky" } });
    expect(started.machine).toBeUndefined();
});

test("on a server: started there, and both sides say which machine", async () => {
    const { c, log } = calls();
    const out = await startSuggestion(pick({ on: "box", worktree: false }), c);
    expect(out.kind).toBe("started");
    const [, on, params] = log[1] as [string, string, any];
    expect(on).toBe("box");
    expect(params.worktree).toBeUndefined();
    // The suggester is this computer's, named as the user knows it (no server can be called that).
    expect(params.origin.machine).toMatch(/^This (Mac|computer)$/);
    expect((log[2] as [string, any])[1].started.machine).toBe("box");
});

test("a claim refused because a terminal holds the session says so, and nothing starts", async () => {
    const { c, log } = calls({ claim: new RpcError("Close this session in the terminal to start it.", "held") });
    expect(await startSuggestion(pick(), c)).toEqual({ kind: "failed", message: "Close this session in the terminal to start it." });
    expect(log).toHaveLength(1);
});

test("a claim refused because it's no longer pending says nothing: the card shows what it is now", async () => {
    const { c, log } = calls({ claim: new RpcError("Not pending", "not_pending") });
    expect(await startSuggestion(pick(), c)).toEqual({ kind: "failed", message: "" });
    expect(log).toHaveLength(1);
});

test("a machine that can't be reached: put back to pending, with why, and Try again", async () => {
    const { c, log } = calls({ link: new Error("unreachable") });
    expect(await startSuggestion(pick({ on: "box" }), c)).toEqual({ kind: "failed", message: "box isn't connected.", retry: true });
    expect((log.at(-1) as [string, any])[1]).toMatchObject({ action: "failed", message: "box isn't connected." });
});

test("a check that fails before anything is made: back to pending with its words", async () => {
    const { c, log } = calls({ start: () => { throw new RpcError("no", "no_folder", "/repo"); } });
    const out = await startSuggestion(pick({ on: "box" }), c);
    expect(out).toEqual({ kind: "failed", message: "No folder /repo on box." });
    expect((log.at(-1) as [string, any])[1]).toMatchObject({ action: "failed", message: "No folder /repo on box." });
});

test("an untrusted folder brings up the trust question; Start runs again once it's answered", async () => {
    const { c, trusts, log } = calls({ start: () => { throw new RpcError("trust", "needs_trust", "/repo"); } });
    expect(await startSuggestion(pick(), c)).toEqual({ kind: "trust" });
    expect(trusts).toEqual(["/repo"]);
    // Released meanwhile, so the card isn't left Starting… if the question is dismissed.
    expect((log.at(-1) as [string, any])[1].action).toBe("failed");
});

test("a worktree made but no session: Try again starts in that worktree", async () => {
    const { c } = calls({ start: () => ({ title: "t", cwd: "/repo", worktree: { path: "/repo/.wt/fix", branch: "fix/t" }, failed: { message: "The CLI didn't start", code: "send_failed" } }) });
    expect(await startSuggestion(pick(), c)).toEqual({ kind: "failed", message: "The CLI didn't start", retry: true, resume: "/repo/.wt/fix" });
});

test("a session made whose first message wasn't sent: started, with the problem", async () => {
    const { c, log } = calls({ start: () => ({ sessionId: "new-2", title: "t", cwd: "/repo", failed: { message: "the model refused", code: "send_failed" } }) });
    const out = await startSuggestion(pick(), c);
    expect(out.kind).toBe("started");
    expect((log.at(-1) as [string, any])[1].started).toMatchObject({ sessionId: "new-2", problem: "the model refused" });
});

test("the claim's time goes with how the start went, and the made session is told to the window", async () => {
    const { c, log, made } = calls();
    await startSuggestion(pick({ on: "box" }), c);
    expect((log.at(-1) as [string, any])[1]).toMatchObject({ action: "started", claimedAt: 1234 });
    expect(made).toEqual([["new-1", "box"]]);
    const failing = calls({ start: () => { throw new RpcError("no", "no_folder", "/repo"); } });
    await startSuggestion(pick(), failing.c);
    expect((failing.log.at(-1) as [string, any])[1]).toMatchObject({ action: "failed", claimedAt: 1234 });
});

test("another window took the start over: no failure is shown, the card shows how it stands", async () => {
    const taken = new RpcError("It's being started from another window.", "superseded");
    expect(await startSuggestion(pick(), calls({ after: taken }).c)).toEqual({ kind: "superseded" });
    expect(await startSuggestion(pick(), calls({ after: taken, start: () => { throw new RpcError("no", "no_folder"); } }).c)).toEqual({ kind: "superseded" });
});

test("the worktree made, its folder to be trusted: the trust question, then Start again in that worktree", async () => {
    const { c, trusts, log } = calls({ start: () => ({ title: "t", cwd: "/repo", worktree: { path: "/repo/.wt/fix", branch: "fix/t" }, failed: { message: "trust it", code: "needs_trust", folder: "/repo/.wt/fix" } }) });
    expect(await startSuggestion(pick(), c)).toEqual({ kind: "trust", resume: "/repo/.wt/fix" });
    expect(trusts).toEqual(["/repo/.wt/fix"]);
    expect((log.at(-1) as [string, any])[1]).toMatchObject({ action: "failed" });
});

test("a Start let go of while its claim was answered makes nothing", async () => {
    const { c, log } = calls();
    expect(await startSuggestion(pick(), { ...c, alive: () => false })).toEqual({ kind: "superseded" });
    expect(log.map((l) => (l as [string])[0])).toEqual(["session.suggestion"]);
});
