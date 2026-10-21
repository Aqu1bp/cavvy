// Hooks on the agent backends, with the fake `claude` and `codex` programs:
// Claude Code runs the harness's tool hooks itself, calling back for each
// handler (hook_callback); Codex's items run them on the harness's side.
// Also the worktree hooks, which stand in for Git when they're configured.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { secretsSnapshot } from "./helpers/secrets";

const iso = isolate();
const restoreSecrets = await secretsSnapshot();
const registry = await import("../src/providers/registry");
const { clientFor, forgetClient } = await import("../src/providers/models");
const { Agent, backendOwnedHooks, CLAUDE_CODE_HOOK_EVENTS } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const trust = await import("../src/config/trust");
const { createWorktreeWithHooks, planRemoval, runRemoval, listWorktrees } = await import("../src/server/worktrees");
const { gitArgv, gitEnv } = await import("../src/util/git");

type AgentEvent = import("../src/agent/agent").AgentEvent;
type PermissionMode = import("../src/permissions/modes").PermissionMode;

const bin = tempDir("fake-agents-");
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
    restoreSecrets();
    iso.cleanup();
    rmSync(bin, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
});

let cwd: string;
beforeEach(() => {
    cwd = realpathSync(tempDir("hook-backend-"));
    rmSync(LOG, { force: true });
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    process.env.FAKE_LOG = LOG;
    registry.saveAgentConfig("claude-code", { path: claudeBin });
    registry.saveAgentConfig("codex", { path: codexBin });
    forgetClient("claude-code");
    forgetClient("codex");
});

const logLines = (): any[] => (existsSync(LOG) ? readFileSync(LOG, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const received = () => logLines().flatMap((l) => (l.received ? [l.received] : []));
const jsonl = (file: string): any[] => (existsSync(file) ? readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const record = (file: string, then = "") => `cat >> '${file}'; echo >> '${file}'${then}`;
const say = (o: unknown) => `echo '${JSON.stringify(o)}'`;
const toolEnds = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "tool_end" ? [e] : []));

async function makeAgent(provider: "claude-code" | "codex", settings: any, mode: PermissionMode = "bypassPermissions", ask?: () => any, o: { readOnly?: boolean } = {}) {
    trust.trustForSession(cwd);
    const events: AgentEvent[] = [];
    const asked: unknown[] = [];
    const session = Session.create(cwd, { persist: false });
    const agent = new Agent({
        session,
        model: { provider, id: "default" },
        client: await clientFor(provider),
        settings: () => settings,
        checker: new PermissionChecker(() => settings, cwd),
        tools: BUILTIN_TOOLS,
        mode: { get: () => mode, set: (m) => (mode = m) },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
        host: { drainQueued: () => [], emit: (e) => events.push(e), ui: {}, askPermission: ask ? async (req) => (asked.push(req), ask()) : undefined },
        readOnly: o.readOnly,
    });
    const run = (text: string) => agent.run([{ type: "text", text }], { signal: new AbortController().signal });
    return { agent, events, asked, session, run };
}

describe("Claude Code runs the harness's tool hooks itself", () => {
    test("only the events it owns are registered, one callback per handler, with Claude Code's timeouts", () => {
        const hooks = { UserPromptSubmit: [{ command: "a" }], Stop: [{ command: "b" }], PreToolUse: [{ matcher: "Bash", command: "c" }], PostToolUse: [{ command: "d" }], SessionStart: [{ command: "e" }], CwdChanged: [{ command: "f" }] };
        expect(Object.keys(backendOwnedHooks({ hooks } as any) ?? {})).toEqual(["PreToolUse", "PostToolUse", "CwdChanged"]);
        // The harness keeps the prompt, the turn's end, the session and its own watchers.
        for (const own of ["UserPromptSubmit", "Stop", "SessionStart", "SessionEnd", "Notification", "PermissionRequest", "FileChanged", "InstructionsLoaded"]) expect(CLAUDE_CODE_HOOK_EVENTS).not.toContain(own as any);
        expect(backendOwnedHooks({} as any)).toBeUndefined();
    });

    test("a PreToolUse deny comes back from the callback and Claude Code refuses the tool", async () => {
        process.env.FAKE_SCENARIO = "bash";
        const seen = join(cwd, "pre.jsonl");
        const settings = {
            hooks: {
                PreToolUse: [{ matcher: "Bash", command: `${record(seen)}; ${say({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no npm here" } })}` }],
                UserPromptSubmit: [{ command: "true" }],
            },
        };
        const { run, events, session } = await makeAgent("claude-code", settings);
        expect(await run("test it")).toBe("done");
        const init = received().find((m) => m.request?.subtype === "initialize")!.request;
        expect(init.hooks).toEqual({ PreToolUse: [{ matcher: "Bash", hookCallbackIds: ["harness_0"], timeout: 60 }] });
        expect(toolEnds(events)[0]!.result).toMatchObject({ isError: true, content: "no npm here" });
        // The handler saw Claude Code's input, under the harness's session id (Claude Code's is kept beside it).
        const [input] = jsonl(seen);
        expect(input).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "toolu_b", session_id: session.meta.id });
        expect(input.backend_session_id).toMatch(/^sess-/);
        expect(logLines().find((l) => l.hookAnswers)?.hookAnswers.answers[0]).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    });

    test("PostToolUse context goes back as Claude Code's additionalContext; a matcher the tool misses isn't called", async () => {
        process.env.FAKE_SCENARIO = "bash";
        const seen = join(cwd, "post.jsonl");
        const settings = {
            hooks: {
                PostToolUse: [{ matcher: "Bash", command: `${record(seen)}; ${say({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "tests are slow" } })}` }],
                PreToolUse: [{ matcher: "Edit|Write", command: `touch '${join(cwd, "called")}'` }],
            },
        };
        const { run } = await makeAgent("claude-code", settings);
        expect(await run("test it")).toBe("done");
        const answers = logLines().filter((l) => l.hookAnswers).map((l) => l.hookAnswers);
        expect(answers.find((a) => a.event === "PostToolUse")?.answers).toEqual([{ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "tests are slow" } }]);
        expect(jsonl(seen)[0]).toMatchObject({ hook_event_name: "PostToolUse", tool_name: "Bash" });
        expect(existsSync(join(cwd, "called"))).toBe(false);
    });

    test("an async hook doesn't hold Claude Code's tool call: the callback answers at once", async () => {
        process.env.FAKE_SCENARIO = "bash";
        const done = join(cwd, "async-done");
        const { run } = await makeAgent("claude-code", { hooks: { PreToolUse: [{ matcher: "Bash", async: true, command: `sleep 2; touch '${done}'` }] } });
        const started = Date.now();
        expect(await run("test it")).toBe("done");
        expect(Date.now() - started).toBeLessThan(1800);
        expect(existsSync(done)).toBe(false);
        expect(logLines().find((l) => l.hookAnswers)?.hookAnswers.answers).toEqual([{}]);
    });

    test("a PermissionRequest hook's rewritten input is what Claude Code is told to run", async () => {
        process.env.FAKE_SCENARIO = "bash";
        const allowAs = say({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { command: "printf safe-replacement" } } } });
        const { run, asked } = await makeAgent("claude-code", { hooks: { PermissionRequest: [{ command: allowAs }] } }, "default", () => ({ allow: false, message: "no", stop: false }));
        expect(await run("test it")).toBe("done");
        expect(asked).toEqual([]);
        const answer = received().filter((m) => m.type === "control_response" && m.response?.response?.behavior).map((m) => m.response.response)[0];
        expect(answer).toMatchObject({ behavior: "allow", updatedInput: { command: "printf safe-replacement" } });
    });

    test("an `if` condition the backend can't express is checked on the harness's side", async () => {
        process.env.FAKE_SCENARIO = "bash";
        const settings = { hooks: { PreToolUse: [{ matcher: "Bash", if: "Bash(git *)", command: say({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no git" } }) }] } };
        const { run, events } = await makeAgent("claude-code", settings);
        expect(await run("test it")).toBe("done");
        // npm test isn't a git command: the callback answers nothing, and the tool runs.
        expect(logLines().find((l) => l.hookAnswers)?.hookAnswers.answers).toEqual([{}]);
        expect(toolEnds(events)[0]!.result).toMatchObject({ isError: false });
    });
});

describe("Codex's items run the harness's hooks", () => {
    const turnStarts = () => received().filter((m) => m.method === "turn/start").map((m) => m.params);
    const decision = () => received().find((m) => m.result?.decision)?.result.decision;

    const ranLine = () => logLines().find((l) => "ran" in l);
    const hookArg = () => (logLines()[0]?.argv as string[]).find((a) => a.startsWith("hooks="));

    test("bypass mode with PreToolUse hooks: Codex runs them itself before the command, without being made to ask", async () => {
        const seen = join(cwd, "pre.jsonl");
        const settings = { hooks: { PreToolUse: [{ matcher: "Bash", command: `${record(seen)}; echo 'touching is banned' >&2; exit 2` }] } };
        const { run, events, asked } = await makeAgent("codex", settings, "bypassPermissions", () => ({ allow: true }));
        expect(await run("make x")).toBe("done");
        // Codex's own policy for the mode, and the hook is one of Codex's, trusted.
        expect(turnStarts()[0]).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
        expect(hookArg()).toContain('"type"="mcp_tool"');
        expect(received().some((m) => m.method === "hooks/list")).toBe(true);
        expect(received().some((m) => m.method?.endsWith("requestApproval"))).toBe(false);
        expect(asked).toEqual([]);
        expect(jsonl(seen)[0]).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "touch x" }, tool_use_id: "cmd-turn-1" });
        expect(ranLine()).toMatchObject({ ran: false, blockedByHook: expect.stringContaining("touching is banned") });
        // Codex reports no item for a call it never started: the harness shows it, refused.
        expect(toolEnds(events)[0]).toMatchObject({ call: { name: "Bash", input: { command: "touch x" } }, result: { isError: true, content: expect.stringContaining("touching is banned") } });
    });

    test("the hook's tool is the harness's and hidden from the model; its server's token goes over stdin, not in arguments", async () => {
        const { run } = await makeAgent("codex", { hooks: { PreToolUse: [{ command: "true" }] } });
        expect(await run("make x")).toBe("done");
        const start = received().find((m) => m.method === "thread/start")!.params;
        const server = start.config.mcp_servers.harness_hooks;
        const { url, http_headers: { Authorization: auth } } = server;
        expect(url).toStartWith("http://127.0.0.1:");
        expect(server.default_tools_approval_mode).toBe("approve");
        expect(hookArg()).not.toContain(auth.slice(7));
        const listed = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: auth }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
        // Closed with the turn: the token no longer works.
        expect(listed.status).toBe(401);
        expect(logLines().find((l) => l.mcpConnected === "harness_hooks")?.tools).toEqual(["pre_tool_use"]);
    });

    test("bypass mode: a hook that says nothing lets the command run without asking, as bypass would", async () => {
        const { run, asked } = await makeAgent("codex", { hooks: { PreToolUse: [{ command: "true" }] } }, "bypassPermissions", () => ({ allow: false, message: "no", stop: false }));
        expect(await run("make x")).toBe("done");
        expect(ranLine()).toMatchObject({ ran: true });
        expect(logLines().find((l) => l.hookCalled)?.hookCalled).toMatchObject({ tool: "pre_tool_use", input: { tool_name: "Bash", tool_input: { command: "touch x" } }, answer: "" });
        expect(asked).toEqual([]);
    });

    test("bypass mode: a hook's ask asks the user from the hook, since Codex never asks there", async () => {
        const ask = { hooks: { PreToolUse: [{ command: say({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } }) }] } };
        const a = await makeAgent("codex", ask, "bypassPermissions", () => ({ allow: false, message: "not that", stop: false }));
        await a.run("make x");
        expect(a.asked).toHaveLength(1);
        expect(ranLine()).toMatchObject({ ran: false, blockedByHook: expect.stringContaining("declined") });
    });

    test("without PreToolUse hooks bypass mode stays Codex's own (never asks), and Codex gets no hook", async () => {
        const { run } = await makeAgent("codex", { hooks: { PostToolUse: [{ command: "true" }] } });
        expect(await run("make x")).toBe("done");
        expect(turnStarts()[0]).toMatchObject({ approvalPolicy: "never" });
        expect(hookArg()).toBeUndefined();
        expect(received().find((m) => m.method === "thread/start")!.params.config?.mcp_servers?.harness_hooks).toBeUndefined();
    });

    test("default mode: a hook's allow approves without asking the user; a deny rule still wins", async () => {
        const allow = { hooks: { PreToolUse: [{ command: say({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }) }] } };
        const a = await makeAgent("codex", allow, "default", () => ({ allow: false, message: "no", stop: false }));
        expect(await a.run("make x")).toBe("done");
        expect(decision()).toBe("accept");
        expect(a.asked).toEqual([]);

        rmSync(LOG, { force: true });
        const b = await makeAgent("codex", { ...allow, permissions: { deny: ["Bash(touch:*)"] } }, "default", () => ({ allow: true }));
        expect(await b.run("make x")).toBe("done");
        expect(decision()).toBe("decline");
    });

    test("default mode: a hook's ask asks the user once, even where a rule would allow it", async () => {
        const settings = { permissions: { allow: ["Bash(touch:*)"] }, hooks: { PreToolUse: [{ command: say({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } }) }] } };
        const { run, asked } = await makeAgent("codex", settings, "default", () => ({ allow: true }));
        expect(await run("make x")).toBe("done");
        expect(asked).toHaveLength(1);
        expect(decision()).toBe("accept");
    });

    test("a PreToolUse rewrite runs on Codex, checked as the call it becomes (deny rules, read-only agents)", async () => {
        const rewrite = (command: string) => say({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command } } });
        const a = await makeAgent("codex", { hooks: { PreToolUse: [{ command: rewrite("printf safe-replacement") }] } }, "bypassPermissions", () => ({ allow: true }));
        expect(await a.run("make x")).toBe("done");
        expect(ranLine()).toMatchObject({ ran: true, command: "printf safe-replacement" });
        expect(a.asked).toEqual([]);

        // Rewritten into something a deny rule covers: refused, and neither ran.
        rmSync(LOG, { force: true });
        const b = await makeAgent("codex", { permissions: { deny: ["Bash(rm:*)"] }, hooks: { PreToolUse: [{ command: rewrite("rm -rf src") }] } }, "bypassPermissions", () => ({ allow: true }));
        expect(await b.run("make x")).toBe("done");
        expect(ranLine()).toMatchObject({ ran: false });
        expect(toolEnds(b.events)[0]!.result).toMatchObject({ isError: true });

        // A read-only agent's call rewritten into a write: refused.
        rmSync(LOG, { force: true });
        process.env.FAKE_COMMAND = "ls";
        const c = await makeAgent("codex", { hooks: { PreToolUse: [{ command: rewrite("touch rewritten-write") }] } }, "default", () => ({ allow: true }), { readOnly: true });
        expect(await c.run("look")).toBe("done");
        expect(ranLine()).toMatchObject({ ran: false });
        expect(c.asked).toEqual([]);
    });

    test("a PreToolUse ask answered by a PermissionRequest rewrite runs the rewrite on Codex, not the original", async () => {
        const ask = say({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } });
        const allowAs = (command: string) => say({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { command } } } });
        const a = await makeAgent("codex", { hooks: { PreToolUse: [{ command: ask }], PermissionRequest: [{ command: allowAs("printf safe-replacement") }] } }, "bypassPermissions", () => ({ allow: true }));
        expect(await a.run("make x")).toBe("done");
        expect(ranLine()).toMatchObject({ ran: true, command: "printf safe-replacement" });
        expect(a.asked).toEqual([]);

        // A PreToolUse rewrite rewritten again by PermissionRequest: the second one runs.
        rmSync(LOG, { force: true });
        const twice = { PreToolUse: [{ command: say({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", updatedInput: { command: "printf first" } } }) }], PermissionRequest: [{ command: allowAs("printf second") }] };
        const b = await makeAgent("codex", { hooks: twice }, "default", () => ({ allow: true }));
        expect(await b.run("make x")).toBe("done");
        expect(ranLine()).toMatchObject({ ran: true, command: "printf second" });

        // A PermissionRequest rewrite into something a deny rule covers: neither ran.
        rmSync(LOG, { force: true });
        const c = await makeAgent("codex", { permissions: { deny: ["Bash(rm:*)"] }, hooks: { PreToolUse: [{ command: ask }], PermissionRequest: [{ command: allowAs("rm -rf src") }] } }, "bypassPermissions", () => ({ allow: true }));
        expect(await c.run("make x")).toBe("done");
        expect(ranLine()).toMatchObject({ ran: false });
    });

    test("Codex can't run a PermissionRequest hook's rewritten command, so it isn't approved", async () => {
        const allowAs = say({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { command: "printf safe-replacement" } } } });
        const a = await makeAgent("codex", { hooks: { PermissionRequest: [{ command: allowAs }] } }, "default", () => ({ allow: true }));
        expect(await a.run("make x")).toBe("done");
        expect(decision()).toBe("decline");
        expect(ranLine()).toMatchObject({ ran: false });
        expect(a.asked).toEqual([]);
    });

    test("continue:false from a PermissionRequest hook refuses the call it approved and stops the turn", async () => {
        const allow = say({ continue: false, stopReason: "freeze", hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
        const a = await makeAgent("codex", { hooks: { PermissionRequest: [{ command: allow }] } }, "default", () => ({ allow: true }));
        await a.run("make x");
        // Codex's "cancel" refuses the call and ends its turn.
        expect(decision()).toBe("cancel");
        expect(ranLine()).toMatchObject({ ran: false });
        expect(a.asked).toEqual([]);
    });

    test("continue:false from a PreToolUse hook refuses the call and stops the turn", async () => {
        const stop = say({ continue: false, stopReason: "enough for today" });
        const a = await makeAgent("codex", { hooks: { PreToolUse: [{ command: stop }] } }, "bypassPermissions");
        await a.run("make x");
        expect(ranLine()).toMatchObject({ ran: false });
        expect(received().some((m) => m.method === "turn/interrupt")).toBe(true);
        expect(a.events.some((e) => e.type === "notice" && e.message.includes("enough for today"))).toBe(true);
    });

    test("if the hook's call fails, Codex goes on with the command, so the turn is stopped and says why", async () => {
        process.env.FAKE_HOOK_SERVER_DOWN = "1";
        const a = await makeAgent("codex", { hooks: { PreToolUse: [{ command: "true" }] } }, "bypassPermissions");
        await a.run("make x");
        expect(received().some((m) => m.method === "turn/interrupt")).toBe(true);
        expect(a.events.some((e) => e.type === "notice" && e.level === "error" && e.message.includes("couldn't run"))).toBe(true);
    });

    describe("a Codex that doesn't run the harness's hooks itself (before 0.160)", () => {
        beforeEach(() => (process.env.FAKE_NO_HOOKS = "1"));

        test("bypass mode: Codex is made to ask about each command, so a hook can still refuse it", async () => {
            const seen = join(cwd, "pre.jsonl");
            const settings = { hooks: { PreToolUse: [{ matcher: "Bash", command: `${record(seen)}; echo 'touching is banned' >&2; exit 2` }] } };
            const { run, events, asked } = await makeAgent("codex", settings, "bypassPermissions", () => ({ allow: true }));
            expect(await run("make x")).toBe("done");
            expect(turnStarts()[0]).toMatchObject({ approvalPolicy: "untrusted", sandboxPolicy: { type: "dangerFullAccess" } });
            expect(received().find((m) => m.method === "thread/start")!.params.config?.mcp_servers?.harness_hooks).toBeUndefined();
            expect(decision()).toBe("decline");
            expect(asked).toEqual([]);
            expect(jsonl(seen)[0]).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "touch x" } });
            expect(toolEnds(events)[0]!.result).toMatchObject({ isError: true, content: expect.stringContaining("touching is banned") });
            expect(ranLine()).toMatchObject({ ran: false });
        });

        test("a hook that says nothing lets the command run as bypass would; a rewrite is refused", async () => {
            const a = await makeAgent("codex", { hooks: { PreToolUse: [{ command: "true" }] } }, "bypassPermissions", () => ({ allow: false, message: "no", stop: false }));
            expect(await a.run("make x")).toBe("done");
            expect(decision()).toBe("accept");
            expect(a.asked).toEqual([]);

            rmSync(LOG, { force: true });
            const rewrite = say({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "printf safe-replacement" } } });
            const b = await makeAgent("codex", { hooks: { PreToolUse: [{ command: rewrite }] } }, "bypassPermissions", () => ({ allow: true }));
            expect(await b.run("make x")).toBe("done");
            expect(decision()).toBe("decline");
            expect(toolEnds(b.events)[0]!.result).toMatchObject({ isError: true, content: expect.stringContaining("rewrite") });
        });
    });

    test("a PermissionRequest hook that rewrites Codex's permissions request grants nothing, not the original scope", async () => {
        process.env.FAKE_SCENARIO = "perms";
        const allowAs = say({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { permissions: {} } } } });
        const a = await makeAgent("codex", { hooks: { PermissionRequest: [{ command: allowAs }] } }, "default", () => ({ allow: true }));
        expect(await a.run("write there")).toBe("done");
        expect(logLines().find((l) => "granted" in l)?.granted).toEqual({ permissions: {}, scope: "turn" });
        expect(a.asked).toEqual([]);
        expect(a.events.some((e) => e.type === "notice" && e.message.includes("a hook rewrote the request"))).toBe(true);
    });

    test("PostToolUse runs after the command with its output, and its context is steered into the turn", async () => {
        const seen = join(cwd, "post.jsonl");
        const settings = { hooks: { PostToolUse: [{ matcher: "Bash", command: `${record(seen)}; ${say({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x is generated" } })}` }] } };
        const { run } = await makeAgent("codex", settings);
        expect(await run("make x")).toBe("done");
        expect(jsonl(seen)[0]).toMatchObject({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "touch x" }, tool_response: { content: "ok\n" } });
        expect(typeof jsonl(seen)[0].duration_ms).toBe("number");
        const steer = received().find((m) => m.method === "turn/steer");
        expect(steer?.params.input[0].text).toBe("<system-reminder>\nContext from a PostToolUse hook (Bash):\nx is generated\n</system-reminder>");
    });

    test("a declined command doesn't run PostToolUse or PostToolUseFailure", async () => {
        const seen = join(cwd, "post.jsonl");
        const settings = { hooks: { PostToolUse: [{ command: record(seen) }], PostToolUseFailure: [{ command: record(seen) }] } };
        const { run } = await makeAgent("codex", settings, "default");
        expect(await run("make x")).toBe("done");
        expect(decision()).toBe("decline");
        expect(jsonl(seen)).toEqual([]);
    });
});

describe("WorktreeCreate and WorktreeRemove", () => {
    function git(dir: string, ...args: string[]): string {
        const r = Bun.spawnSync(gitArgv(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args]), { cwd: dir, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
        if (r.exitCode !== 0) throw new Error(r.stderr.toString());
        return r.stdout.toString().trim();
    }
    function repo(): string {
        const main = realpathSync(tempDir("wt-hooks-"));
        git(main, "init", "-b", "main");
        git(main, "commit", "--allow-empty", "-m", "first");
        return main;
    }
    const managed = (main: string, name: string) => join(main, ".claude", "worktrees", name);

    test("without hooks Git makes the worktree", async () => {
        const main = repo();
        const r = await createWorktreeWithHooks({ path: main, branch: "plain" }, undefined, {});
        expect(r.path).toBe(managed(main, "plain"));
        expect(listWorktrees(main).map((w) => w.branch)).toContain("plain");
    });

    test("a WorktreeCreate hook makes it instead of Git: the last line it prints is the folder", async () => {
        const main = repo();
        const target = managed(main, "by-hook");
        const seen = join(main, "..", `${main.split("/").pop()}-create.jsonl`);
        const command = `${record(seen)}; git worktree add -q -b hooked '${target}' >/dev/null 2>&1; echo 'making it'; printf '\\033[32m${target}\\033[0m\\n'`;
        const r = await createWorktreeWithHooks({ path: main, branch: "hooked", folder: "by-hook" }, undefined, { hooks: { WorktreeCreate: [{ command }] } });
        expect(r).toMatchObject({ path: target, branch: "hooked" });
        expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(jsonl(seen)[0]).toMatchObject({ hook_event_name: "WorktreeCreate", name: "by-hook", branch: "hooked", base: null });
    });

    test("a WorktreeCreate hook that fails, prints nothing, or prints a folder that isn't there refuses", async () => {
        const main = repo();
        const make = (command: string) => createWorktreeWithHooks({ path: main, branch: "b" }, undefined, { hooks: { WorktreeCreate: [{ command }] } });
        await expect(make("echo nope >&2; exit 2")).rejects.toMatchObject({ code: "hook_failed", message: expect.stringContaining("nope") });
        await expect(make("exit 1")).rejects.toMatchObject({ code: "hook_failed" });
        await expect(make("true")).rejects.toThrow("didn't print the new worktree's path");
        await expect(make(`echo '${join(main, "missing")}'`)).rejects.toThrow("isn't a folder");
        await expect(make(`echo '${main}/../${main.split("/").pop()}'`)).rejects.toThrow("without . or ..");
    });

    test("a WorktreeRemove hook that deletes the folder removes it; Git's record is pruned", async () => {
        const main = repo();
        const path = managed(main, "gone");
        git(main, "worktree", "add", "-q", "-b", "gone", path);
        const plan = planRemoval({ path: main, worktree: path, inUse: () => false });
        const r = await runRemoval(plan, { settings: { hooks: { WorktreeRemove: [{ command: `rm -rf '${path}'` }] } } });
        expect(r).toEqual({ removed: true });
        expect(existsSync(path)).toBe(false);
        expect(listWorktrees(main).map((w) => w.path)).not.toContain(path);
    });

    test("a WorktreeRemove hook that only looks (logging) leaves the removal to Git", async () => {
        const main = repo();
        const path = managed(main, "logged");
        git(main, "worktree", "add", "-q", "-b", "logged", path);
        const seen = join(main, "..", `${main.split("/").pop()}-remove.jsonl`);
        const r = await runRemoval(planRemoval({ path: main, worktree: path, inUse: () => false }), { settings: { hooks: { WorktreeRemove: [{ command: record(seen) }] } } });
        expect(r).toEqual({ removed: true });
        expect(existsSync(path)).toBe(false);
        expect(jsonl(seen)[0]).toMatchObject({ hook_event_name: "WorktreeRemove", worktree_path: path });
    });

    test("a WorktreeRemove hook that fails while the folder is still there keeps it", async () => {
        const main = repo();
        const path = managed(main, "kept");
        git(main, "worktree", "add", "-q", "-b", "kept", path);
        mkdirSync(join(path, "sub"));
        await expect(runRemoval(planRemoval({ path: main, worktree: path, inUse: () => false }), { settings: { hooks: { WorktreeRemove: [{ command: "echo busy >&2; exit 1" }] } } })).rejects.toMatchObject({ code: "hook_failed" });
        expect(existsSync(path)).toBe(true);
    });
});
