// The new hook events in the harness's own loop: tool failures, batches,
// permission prompts, sub-agent starts, compaction, a turn that fails, the
// working directory moving, watched files changing, memory files loading,
// and a hook that ends the turn (continue: false).

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const { cleanup } = isolate();
const { Agent, errorType } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { TaskTool } = await import("../src/tools/meta-tools");
const { BashTool } = await import("../src/tools/bash");
const { sessionStartHooks } = await import("../src/agent/session-hooks");
const trust = await import("../src/config/trust");
import type { ChatRequest } from "../src/providers/types";

afterAll(cleanup);

const record = (file: string, extra = "") => ({ command: `cat >> '${file}'; echo >> '${file}'${extra}` });
const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
async function until(fn: () => boolean, ms = 3000) {
    const end = Date.now() + ms;
    while (!fn() && Date.now() < end) await Bun.sleep(20);
}

const reply = (content: any[], stopReason = "end_turn") => ({ role: "assistant", provider: "test", model: "test", stopReason, content }) as any;
const text = (t: string) => reply([{ type: "text", text: t }]);
const toolCall = (id: string, name: string, input: unknown) => reply([{ type: "tool_call", id, name, input }], "tool_use");
const afterTools = (req: ChatRequest) => (req.messages.at(-1) as any)?.meta?.kind === "tool_results";

const tool = (name: string, run: (input: any) => any, extra: any = {}) => ({ name, category: "meta", readOnly: true, description: name, title: () => name, parameters: { type: "object", properties: { x: { type: "string" } } }, run: async (input: any) => run(input), ...extra });

function agentFor(proj: string, settings: any, answer: (req: ChatRequest, n: number) => any, tools: any[] = [], o: { mode?: string; ask?: (req: any) => any; helpers?: any; readOnly?: boolean } = {}) {
    const requests: { system: string; messages: any[] }[] = [];
    const notices: string[] = [];
    const asked: any[] = [];
    const session = Session.create(proj, { persist: false, system: "PARENT" });
    const agent = new Agent({
        session,
        model: { provider: "test", id: "test" } as any,
        client: {
            stream: async (req: ChatRequest) => {
                requests.push({ system: req.system, messages: JSON.parse(JSON.stringify(req.messages)) });
                const r = answer(req, requests.length);
                if (r instanceof Error) throw r;
                return r;
            },
        } as any,
        settings: () => settings,
        checker: new PermissionChecker(() => settings, proj),
        tools,
        mode: { get: () => (o.mode ?? "bypassPermissions") as any, set() {} },
        toolState: { cwd: proj, projectRoot: proj, fileState: new Map(), todos: [], shells: new Map() } as any,
        helpers: o.helpers,
        readOnly: o.readOnly,
        host: { emit: (e: any) => e.type === "notice" && notices.push(e.message), ui: {}, ...(o.ask ? { askPermission: async (req: any) => (asked.push(req), o.ask!(req)) } : {}) } as any,
    });
    return { agent, session, requests, notices, asked };
}
const run = (agent: any, prompt: string, signal = new AbortController().signal) => agent.run([{ type: "text", text: prompt }], { signal });
const resultsOf = (req: { messages: any[] }) => req.messages.at(-1).content;

describe("hook answers the rest of the turn respects (review of #173)", () => {
    test("a read-only agent refuses a write a PreToolUse hook rewrote a read into", async () => {
        const proj = tempDir();
        const rewrite = `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "touch rewritten-write" } } })}'`;
        const { agent, requests } = agentFor(proj, { autoCompact: false, hooks: { PreToolUse: [{ command: rewrite }] } }, (req) => (afterTools(req) ? text("ok") : toolCall("c", "Bash", { command: "pwd" })), [BashTool], { readOnly: true });
        await run(agent, "go");
        expect(existsSync(join(proj, "rewritten-write"))).toBe(false);
        expect(resultsOf(requests[1]!)[0].isError).toBe(true);
    });
    test("a read-only agent refuses a write a PermissionRequest hook rewrote a call into", async () => {
        const proj = tempDir();
        const allowAs = `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { command: "touch rewritten-write" } } } })}'`;
        // Reading a secret asks, even in a read-only agent; the hook answers with a write.
        writeFileSync(join(proj, ".env"), "KEY=1\n");
        const out = join(proj, "asked.jsonl");
        const { agent } = agentFor(proj, { autoCompact: false, hooks: { PermissionRequest: [{ command: `cat > '${out}'; ${allowAs}` }] } }, (req) => (afterTools(req) ? text("ok") : toolCall("c", "Bash", { command: "cat .env" })), [BashTool], { readOnly: true, mode: "default", ask: () => ({ allow: false }) });
        await run(agent, "go");
        // The hook was asked (so the test reaches the rewrite), and its write didn't run.
        expect(existsSync(out)).toBe(true);
        expect(existsSync(join(proj, "rewritten-write"))).toBe(false);
    });
    test("continue: false from a PermissionRequest hook refuses the call it approved and ends the turn", async () => {
        const proj = tempDir();
        const allow = `echo '${JSON.stringify({ continue: false, stopReason: "freeze", hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } })}'`;
        const { agent, requests, notices, asked } = agentFor(proj, { autoCompact: false, hooks: { PermissionRequest: [{ command: allow }] } }, (req) => (afterTools(req) ? text("ok") : toolCall("c", "Bash", { command: "touch made" })), [BashTool], { mode: "default", ask: () => ({ allow: true }) });
        expect(await run(agent, "go")).toBe("blocked");
        expect(existsSync(join(proj, "made"))).toBe(false);
        expect(asked).toEqual([]);
        expect(requests).toHaveLength(1);
        expect(notices).toContain("Stopped by a hook: freeze");
    });
    test("continue: false stops the later calls of the same response, not just the next response", async () => {
        const proj = tempDir();
        const stop = { matcher: "Bash", command: `echo '{"continue":false,"stopReason":"enough"}'` };
        const reply2 = reply([{ type: "tool_call", id: "a", name: "Bash", input: { command: "touch first" } }, { type: "tool_call", id: "b", name: "Bash", input: { command: "touch second" } }], "tool_use");
        const { agent, notices } = agentFor(proj, { autoCompact: false, hooks: { PostToolUse: [stop] } }, (req) => (afterTools(req) ? text("ok") : reply2), [BashTool]);
        await run(agent, "go");
        expect(existsSync(join(proj, "first"))).toBe(true);
        expect(existsSync(join(proj, "second"))).toBe(false);
        expect(notices.some((n) => n.includes("enough"))).toBe(true);
    });
});

describe("PostToolUse and PostToolUseFailure", () => {
    test("a tool that fails runs PostToolUseFailure (with the error), not PostToolUse", async () => {
        const proj = tempDir();
        const ok = join(proj, "ok.jsonl");
        const failed = join(proj, "failed.jsonl");
        const settings = { autoCompact: false, hooks: { PostToolUse: [record(ok)], PostToolUseFailure: [record(failed, `; echo '{"additionalContext":"try --force"}'`)] } };
        const tools = [tool("Good", () => ({ content: "fine" })), tool("Bad", () => ({ content: "Exit code 1\nboom", isError: true }))];
        let n = 0;
        const { agent, requests } = agentFor(proj, settings, (req) => (afterTools(req) ? text("done") : ++n === 1 ? reply([{ type: "tool_call", id: "g", name: "Good", input: {} }, { type: "tool_call", id: "b", name: "Bad", input: { x: "1" } }], "tool_use") : text("x")), tools);
        expect(await run(agent, "go")).toBe("done");
        expect(lines(ok).map((l) => [l.tool_name, l.tool_use_id, l.tool_response])).toEqual([["Good", "g", { content: "fine", is_error: false }]]);
        expect(lines(failed)).toEqual([expect.objectContaining({ hook_event_name: "PostToolUseFailure", tool_name: "Bad", tool_input: { x: "1" }, tool_use_id: "b", error: "Exit code 1\nboom", is_interrupt: false, duration_ms: expect.any(Number) })]);
        expect(JSON.stringify(resultsOf(requests[1]!))).toContain("Context from a PostToolUseFailure hook (Bad):\\ntry --force");
    });
    test("updatedToolOutput replaces what the model sees", async () => {
        const settings = { autoCompact: false, hooks: { PostToolUse: [{ command: `echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":"[trimmed]"}}'` }] } };
        const { agent, requests } = agentFor(tempDir(), settings, (req) => (afterTools(req) ? text("ok") : toolCall("c", "Good", {})), [tool("Good", () => ({ content: "very long output" }))]);
        await run(agent, "go");
        expect(resultsOf(requests[1]!)[0].content).toBe("[trimmed]");
    });
});

describe("PostToolBatch", () => {
    test("sees the whole batch; a block ends the turn after the results are saved", async () => {
        const proj = tempDir();
        const out = join(proj, "batch.jsonl");
        const settings = { autoCompact: false, hooks: { PostToolBatch: [record(out, "; echo 'enough for now' >&2; exit 2")] } };
        const { agent, session, requests, notices } = agentFor(proj, settings, () => reply([{ type: "tool_call", id: "a", name: "Good", input: {} }, { type: "tool_call", id: "b", name: "Good", input: { x: "2" } }], "tool_use"), [tool("Good", () => ({ content: "fine" }))]);
        expect(await run(agent, "go")).toBe("blocked");
        expect(requests).toHaveLength(1);
        expect(lines(out)[0].tool_calls).toEqual([
            { tool_name: "Good", tool_input: {}, tool_use_id: "a", tool_response: { content: "fine", is_error: false } },
            { tool_name: "Good", tool_input: { x: "2" }, tool_use_id: "b", tool_response: { content: "fine", is_error: false } },
        ]);
        expect(session.messages.at(-1)!.meta?.kind).toBe("tool_results");
        expect(notices).toContain("Stopped by a PostToolBatch hook: enough for now");
    });
});

describe("PreToolUse", () => {
    test("updatedInput replaces the model's input, and is validated", async () => {
        const seen: any[] = [];
        const settings = { autoCompact: false, hooks: { PreToolUse: [{ command: `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"x":"safe"}}}'` }] } };
        const { agent } = agentFor(tempDir(), settings, (req) => (afterTools(req) ? text("ok") : toolCall("c", "Good", { x: "risky" })), [tool("Good", (i) => (seen.push(i), { content: "ran" }))]);
        await run(agent, "go");
        expect(seen).toEqual([{ x: "safe" }]);
    });
    test("continue: false refuses the call and ends the turn", async () => {
        const ran: any[] = [];
        const settings = { autoCompact: false, hooks: { PreToolUse: [{ command: `echo '{"continue":false,"stopReason":"maintenance window"}'` }] } };
        const { agent, requests, notices } = agentFor(tempDir(), settings, () => toolCall("c", "Good", {}), [tool("Good", (i) => (ran.push(i), { content: "ran" }))]);
        expect(await run(agent, "go")).toBe("blocked");
        expect(ran).toEqual([]);
        expect(requests).toHaveLength(1);
        expect(notices).toContain("Stopped by a hook: maintenance window");
    });
});

describe("PermissionRequest", () => {
    // Bash in Ask mode asks: the hook answers before the user is asked.
    const bash = (command: string) => (req: ChatRequest) => (afterTools(req) ? text("ok") : toolCall("c", "Bash", { command }));
    test("allow runs it without asking the user", async () => {
        const proj = tempDir();
        const out = join(proj, "pr.jsonl");
        const settings = { autoCompact: false, hooks: { PermissionRequest: [record(out, `; echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'`)] } };
        const { agent, asked, requests } = agentFor(proj, settings, bash("touch made"), [BashTool], { mode: "default", ask: () => ({ allow: false }) });
        await run(agent, "go");
        expect(asked).toHaveLength(0);
        expect(existsSync(join(proj, "made"))).toBe(true);
        expect(lines(out)[0]).toMatchObject({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "touch made" }, permission_mode: "default" });
        expect(resultsOf(requests[1]!)[0].isError).toBeFalsy();
    });
    test("allow with updatedInput runs the new input, but a deny rule still refuses it", async () => {
        const proj = tempDir();
        const allowAs = (command: string) => ({ command: `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { command } } } })}'` });
        const a = agentFor(proj, { autoCompact: false, hooks: { PermissionRequest: [allowAs("touch other")] } }, bash("touch made"), [BashTool], { mode: "default", ask: () => ({ allow: false }) });
        await run(a.agent, "go");
        expect(existsSync(join(proj, "other"))).toBe(true);
        expect(existsSync(join(proj, "made"))).toBe(false);
        const settings = { autoCompact: false, permissions: { deny: ["Bash(rm:*)"] }, hooks: { PermissionRequest: [allowAs("rm -f victim")] } };
        writeFileSync(join(proj, "victim"), "x");
        const b = agentFor(proj, settings, bash("touch made"), [BashTool], { mode: "default", ask: () => ({ allow: true }) });
        await run(b.agent, "go");
        expect(existsSync(join(proj, "victim"))).toBe(true);
        expect(resultsOf(b.requests[1]!)[0].isError).toBe(true);
    });
    test("deny refuses it with the hook's message, without asking", async () => {
        const proj = tempDir();
        const settings = { autoCompact: false, hooks: { PermissionRequest: [{ command: `echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Use the Makefile"}}}'` }] } };
        const { agent, asked, requests } = agentFor(proj, settings, bash("touch made"), [BashTool], { mode: "default", ask: () => ({ allow: true }) });
        await run(agent, "go");
        expect(asked).toHaveLength(0);
        expect(existsSync(join(proj, "made"))).toBe(false);
        expect(resultsOf(requests[1]!)[0]).toMatchObject({ isError: true, content: "Use the Makefile" });
    });
    test("no answer: the user is asked as before; never runs for calls that don't ask", async () => {
        const proj = tempDir();
        const out = join(proj, "pr.jsonl");
        const settings = { autoCompact: false, hooks: { PermissionRequest: [record(out)] } };
        const { agent, asked } = agentFor(proj, settings, bash("touch made"), [BashTool], { mode: "default", ask: () => ({ allow: true }) });
        await run(agent, "go");
        expect(asked).toHaveLength(1);
        const b = agentFor(proj, settings, bash("ls"), [BashTool], { mode: "bypassPermissions" });
        await run(b.agent, "go");
        expect(lines(out)).toHaveLength(1);
    });
});

describe("SubagentStart", () => {
    test("runs as a sub-agent starts, and its context reaches the sub-agent", async () => {
        const proj = tempDir();
        const out = join(proj, "start.jsonl");
        const settings = { autoCompact: false, hooks: { SubagentStart: [{ matcher: "general-purpose", ...record(out, `; echo '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"use pnpm"}}'`) }, { matcher: "explore", command: "echo never" }] } };
        const { agent, session, requests } = agentFor(proj, settings, (req) => (req.system !== "PARENT" ? text("child done") : afterTools(req) ? text("parent done") : toolCall("t1", "Task", { description: "Greet", prompt: "Say hi", subagent_type: "general-purpose" })), [TaskTool]);
        expect(await run(agent, "delegate")).toBe("done");
        expect(lines(out)).toEqual([expect.objectContaining({ hook_event_name: "SubagentStart", session_id: session.meta.id, agent_id: expect.any(String), agent_type: "general-purpose", description: "Greet" })]);
        const child = requests.find((r) => r.system !== "PARENT")!;
        expect(JSON.stringify(child.messages[0].content)).toContain("Context from a SubagentStart hook:\\nuse pnpm");
    });
});

describe("Stop and StopFailure", () => {
    test("a turn that ends on an error runs StopFailure with what kind of error", async () => {
        const proj = tempDir();
        const out = join(proj, "fail.jsonl");
        const settings = { autoCompact: false, hooks: { StopFailure: [{ matcher: "rate_limit", ...record(out) }], Stop: [{ command: "echo never >&2; exit 2" }] } };
        const { agent } = agentFor(proj, settings, () => Object.assign(new Error("429 Too Many Requests: rate limit exceeded"), { status: 429 }));
        expect(await run(agent, "go")).toBe("error");
        await until(() => lines(out).length > 0);
        expect(lines(out)).toEqual([expect.objectContaining({ hook_event_name: "StopFailure", error: "rate_limit", error_details: expect.stringContaining("429") })]);
    });
    test("error types, as Claude Code names them", () => {
        expect(errorType("Overloaded (529)")).toBe("overloaded");
        expect(errorType("401 Unauthorized")).toBe("authentication_failed");
        expect(errorType("Your credit balance is too low")).toBe("billing_error");
        expect(errorType("502 Bad Gateway")).toBe("server_error");
        expect(errorType("something odd")).toBe("unknown");
    });
    test("a prompt hook can keep the model going, at most three times", async () => {
        const settings = { autoCompact: false, hooks: { Stop: [{ type: "prompt", prompt: "Did it run the tests? $ARGUMENTS" }] } };
        let asked = 0;
        const helpers = { complete: async () => (asked++, '{"ok": false, "reason": "run the tests"}') };
        const { agent, requests } = agentFor(tempDir(), settings, () => text("done"), [], { helpers });
        expect(await run(agent, "go")).toBe("done");
        expect(asked).toBe(3);
        expect(requests).toHaveLength(4);
        expect(JSON.stringify(requests[1]!.messages.at(-1))).toContain("A Stop hook asked you to keep going:\\nrun the tests");
    });
});

describe("PreCompact and PostCompact", () => {
    test("a PreCompact block skips the compaction and says why", async () => {
        const settings = { autoCompact: false, hooks: { PreCompact: [{ matcher: "manual", command: "echo 'not before the release' >&2; exit 2" }] } };
        const { agent, session, notices } = agentFor(tempDir(), settings, () => text("Summary"));
        await run(agent, "hello");
        const before = session.messages.length;
        expect(await agent.compact({ auto: false, signal: new AbortController().signal })).toBe(false);
        expect(session.messages.length).toBe(before);
        expect(notices).toContain("Compaction skipped: a PreCompact hook blocked it: not before the release");
        // The matcher: an automatic compaction isn't blocked by it.
        expect(await agent.compact({ auto: true, signal: new AbortController().signal })).toBe(true);
    });
    test("PostCompact gets the summary", async () => {
        const proj = tempDir();
        const out = join(proj, "post.jsonl");
        const { agent } = agentFor(proj, { autoCompact: false, hooks: { PostCompact: [record(out)] } }, () => text("1. Summary of it all"));
        await run(agent, "hello");
        await agent.compact({ auto: false, signal: new AbortController().signal });
        await until(() => lines(out).length > 0);
        expect(lines(out)).toEqual([expect.objectContaining({ hook_event_name: "PostCompact", trigger: "manual", compact_summary: "1. Summary of it all" })]);
    });
    test("after compaction SessionStart runs with source compact, and its context goes with the next prompt", async () => {
        const proj = tempDir();
        const out = join(proj, "start.jsonl");
        const settings = { autoCompact: false, hooks: { SessionStart: [{ matcher: "compact", command: `cat >> '${out}'; echo >> '${out}'; echo 'Re-read TODO.md'` }] } };
        const { agent, requests } = agentFor(proj, settings, () => text("Summary"));
        await run(agent, "hello");
        await agent.compact({ auto: true, signal: new AbortController().signal });
        await until(() => lines(out).length > 0);
        expect(lines(out)).toEqual([expect.objectContaining({ hook_event_name: "SessionStart", source: "compact" })]);
        await Bun.sleep(50);
        await run(agent, "next");
        expect(JSON.stringify(requests.at(-1)!.messages)).toContain("Re-read TODO.md");
    });
});

describe("CwdChanged and FileChanged", () => {
    test("Bash cd runs CwdChanged with both folders", async () => {
        // Canonical, as the shell reports its folder (macOS's /var is /private/var).
        const proj = realpathSync(tempDir());
        mkdirSync(join(proj, "sub"));
        const out = join(proj, "cwd.jsonl");
        const { agent } = agentFor(proj, { autoCompact: false, hooks: { CwdChanged: [record(out)] } }, (req) => (afterTools(req) ? text("ok") : toolCall("c", "Bash", { command: "cd sub" })), [BashTool]);
        await run(agent, "go");
        await until(() => lines(out).length > 0);
        expect(lines(out)).toEqual([expect.objectContaining({ hook_event_name: "CwdChanged", old_cwd: proj, new_cwd: join(proj, "sub") })]);
    });
    test("a watched file changing on disk runs FileChanged, whatever changed it; watchPaths add more", async () => {
        const proj = tempDir();
        // One file per handler: they run in parallel, so a shared file would interleave.
        const outA = join(proj, "a.jsonl");
        const outB = join(proj, "b.jsonl");
        const extra = join(proj, "extra.txt");
        const settings = { autoCompact: false, hooks: { FileChanged: [{ matcher: ".envrc", ...record(outA, `; echo '{"watchPaths":["${extra}"]}'`) }, { ...record(outB) }] } };
        const { agent } = agentFor(proj, settings, () => text("ok"));
        await run(agent, "go");
        writeFileSync(join(proj, ".envrc"), "export A=1\n");
        await until(() => lines(outA).length >= 1 && lines(outB).length >= 1);
        // Both groups ran for .envrc (the one without a matcher takes every watched file).
        for (const out of [outA, outB]) expect(lines(out).map((l) => [l.hook_event_name, l.file_path, l.event])).toEqual([["FileChanged", join(proj, ".envrc"), "add"]]);
        writeFileSync(extra, "x");
        await until(() => lines(outB).length >= 2);
        expect(lines(outB).slice(1).map((l) => [l.file_path, l.event])).toEqual([[extra, "add"]]);
        // The .envrc matcher doesn't take extra.txt.
        expect(lines(outA)).toHaveLength(1);
        await agent.dispose();
        writeFileSync(join(proj, ".envrc"), "export A=2\n");
        await Bun.sleep(300);
        expect(lines(outA)).toHaveLength(1);
        expect(lines(outB)).toHaveLength(2);
    });
});

describe("SessionStart context and InstructionsLoaded", () => {
    test("SessionStart's context goes with the first prompt; each memory file runs InstructionsLoaded", async () => {
        const proj = tempDir();
        mkdirSync(join(proj, ".git"));
        writeFileSync(join(proj, "AGENTS.md"), "Use tabs.\n");
        trust.trustFolder(proj);
        const out = join(proj, "loaded.jsonl");
        const settings = { autoCompact: false, hooks: { SessionStart: [{ command: "echo on branch main" }], InstructionsLoaded: [record(out)] } };
        const { agent, session, requests } = agentFor(proj, settings, () => text("ok"));
        const warnings: string[] = [];
        await sessionStartHooks(settings as any, session, "startup", proj, (m) => warnings.push(m));
        expect(warnings).toEqual([]);
        expect(lines(out)).toEqual([expect.objectContaining({ hook_event_name: "InstructionsLoaded", file_path: join(proj, "AGENTS.md"), memory_type: "Project", load_reason: "session_start" })]);
        await run(agent, "hi");
        await run(agent, "again");
        expect(JSON.stringify(requests[0]!.messages.at(-1).content)).toContain("Context from a SessionStart hook:\\non branch main");
        expect(JSON.stringify(requests[1]!.messages.at(-1).content)).not.toContain("SessionStart");
    });
});

describe("hook input", () => {
    test("every event gets the session, the mode and the effort", async () => {
        const proj = tempDir();
        const out = join(proj, "in.jsonl");
        const { agent, session } = agentFor(proj, { effort: "high", autoCompact: false, hooks: { UserPromptSubmit: [record(out)] } }, () => text("ok"));
        await run(agent, "hi");
        expect(lines(out)).toEqual([{ hook_event_name: "UserPromptSubmit", cwd: proj, session_id: session.meta.id, permission_mode: "bypassPermissions", effort: { level: "high" }, prompt: "hi" }]);
    });
});
