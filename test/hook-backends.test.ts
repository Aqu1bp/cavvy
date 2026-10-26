// Hooks on the agent backends, with the fake `claude` and `codex` programs:
// Claude Code runs Cavvy's tool hooks itself, calling back for each
// handler (hook_callback); Codex's items run them on Cavvy's side.
// Also the worktree hooks, which stand in for Git when they're configured.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { secretsSnapshot } from "./helpers/secrets";
import { stopLiveCodex } from "./helpers/fake-env";

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
const { textOf } = await import("../src/providers/types");

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

afterEach(() => stopLiveCodex());

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
const ranLine = () => logLines().find((l) => "ran" in l);
const toolEnds = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "tool_end" ? [e] : []));

async function makeAgent(provider: "claude-code" | "codex", settings: any, mode: PermissionMode = "bypassPermissions", ask?: () => any, o: { readOnly?: boolean; oneOffs?: boolean } = {}) {
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
        // As the runtime's complete(): one-off requests go to the session's own backend.
        helpers: o.oneOffs ? { complete: async (system: string, prompt: string, signal?: AbortSignal) => textOf(await (await clientFor(provider)).stream({ model: { provider, id: "default" } as any, system, messages: [{ role: "user", content: [{ type: "text", text: prompt }] }], tools: [], lightweight: true, signal }, () => {})) } : undefined,
    });
    const run = (text: string) => agent.run([{ type: "text", text }], { signal: new AbortController().signal });
    return { agent, events, asked, session, run };
}

describe("Claude Code runs Cavvy's tool hooks itself", () => {
    test("only the events it owns are registered, one callback per handler, with Claude Code's timeouts", () => {
        const hooks = { UserPromptSubmit: [{ command: "a" }], Stop: [{ command: "b" }], PreToolUse: [{ matcher: "Bash", command: "c" }], PostToolUse: [{ command: "d" }], SessionStart: [{ command: "e" }], CwdChanged: [{ command: "f" }] };
        expect(Object.keys(backendOwnedHooks({ hooks } as any) ?? {})).toEqual(["PreToolUse", "PostToolUse", "CwdChanged", "SessionStart"]);
        // SessionStart only for compaction (Claude Code's own too), and only handlers that match it.
        const starts = { SessionStart: [{ command: "a" }, { matcher: "startup", command: "b" }, { matcher: "compact|resume", command: "c" }] };
        expect(backendOwnedHooks({ hooks: starts } as any)?.SessionStart).toEqual([{ command: "a", matcher: "compact" }, { matcher: "compact", command: "c" }]);
        // Cavvy keeps the prompt, the turn's end, the session and its own watchers.
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
        expect(init.hooks).toEqual({ PreToolUse: [{ matcher: "Bash|Monitor", hookCallbackIds: ["cavvy_0"], timeout: 60 }] });
        expect(toolEnds(events)[0]!.result).toMatchObject({ isError: true, content: "no npm here" });
        // The handler saw Claude Code's input, under Cavvy's session id (Claude Code's is kept beside it).
        const [input] = jsonl(seen);
        expect(input).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "toolu_b", session_id: session.meta.id });
        expect(input.backend_session_id).toMatch(/^sess-/);
        expect(logLines().find((l) => l.hookAnswers)?.hookAnswers.answers[0]).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    });

    test("SessionStart after compacting is Claude Code's to run, so its context reaches Claude Code's model, once", async () => {
        process.env.FAKE_SCENARIO = "bash";
        const seen = join(cwd, "start.jsonl");
        const settings = { hooks: { SessionStart: [{ command: `${record(seen)}; echo 'the codeword is PELICAN'` }] } };
        const { run, agent, session } = await makeAgent("claude-code", settings);
        expect(await run("go")).toBe("done");
        expect(await agent.compact({ auto: false, signal: new AbortController().signal })).toBe(true);
        await Bun.sleep(200);
        const answers = logLines().find((l) => l.hookAnswers?.event === "SessionStart")?.hookAnswers.answers;
        expect(answers).toEqual([{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "the codeword is PELICAN" } }]);
        expect(jsonl(seen).map((l) => l.source)).toEqual(["compact"]);
        // Not again with the next prompt: Claude Code has it.
        expect(session.hookContext).toEqual([]);
    });

    test("prompt hooks go to Claude Code in its settings, so it asks its own model; no callback for them", async () => {
        process.env.FAKE_SCENARIO = "bash";
        const settings = { hooks: { PreToolUse: [{ matcher: "Bash", type: "prompt", prompt: "Refuse rm. $ARGUMENTS", model: "haiku", if: "Bash(rm *)" }, { matcher: "Bash", type: "prompt", prompt: "p2", model: "anthropic:claude-haiku-4-5", timeout: 9 }, { matcher: "Bash", command: "true" }] } };
        const { run } = await makeAgent("claude-code", settings);
        expect(await run("test it")).toBe("done");
        const init = received().find((m) => m.request?.subtype === "initialize")!.request;
        expect(init.hooks).toEqual({ PreToolUse: [{ matcher: "Bash|Monitor", hookCallbackIds: ["cavvy_0"], timeout: 60 }] });
        const argv = logLines()[0].argv as string[];
        const given = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
        // A Cavvy model reference (provider:model) is left to Claude Code's default.
        expect(given.hooks).toEqual({
            PreToolUse: [
                { matcher: "Bash|Monitor", hooks: [{ type: "prompt", prompt: "Refuse rm. $ARGUMENTS", timeout: 30, model: "haiku", if: "Bash(rm *)" }] },
                { matcher: "Bash|Monitor", hooks: [{ type: "prompt", prompt: "p2", timeout: 9 }] },
            ],
        });
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

    test("an `if` condition the backend can't express is checked on Cavvy's side", async () => {
        process.env.FAKE_SCENARIO = "bash";
        const settings = { hooks: { PreToolUse: [{ matcher: "Bash", if: "Bash(git *)", command: say({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no git" } }) }] } };
        const { run, events } = await makeAgent("claude-code", settings);
        expect(await run("test it")).toBe("done");
        // npm test isn't a git command: the callback answers nothing, and the tool runs.
        expect(logLines().find((l) => l.hookAnswers)?.hookAnswers.answers).toEqual([{}]);
        expect(toolEnds(events)[0]!.result).toMatchObject({ isError: false });
    });
});

describe("one-off requests on Claude Code and Codex (prompt hooks, MCP sampling)", () => {
    const ask = (provider: "claude-code" | "codex", tools: any[] = []) =>
        clientFor(provider).then((c) => c.stream({ model: { provider, id: "default" } as any, system: "Reply with JSON.", messages: [{ role: "user", content: [{ type: "text", text: "Is it fine?" }] }], tools, maxTokens: 300, lightweight: true }, () => {}));

    test("Codex answers in an ephemeral thread with its system prompt as instructions, and no shell, MCP servers or other tools", async () => {
        process.env.FAKE_ONEOFF_ANSWER = '{"ok": false, "reason": "no"}';
        process.env.FAKE_USER_MCP = JSON.stringify({ notes: { command: "notes-server" } });
        // A plugin installed with `codex plugin add`: its servers start unless the plugin is off.
        process.env.FAKE_USER_PLUGINS = JSON.stringify({ "fmt@local": { enabled: true } });
        const r = await ask("codex");
        expect(r.content).toEqual([{ type: "text", text: '{"ok": false, "reason": "no"}' }]);
        expect(logLines().find((l) => l.oneOffThread)?.oneOffThread).toMatchObject({ baseInstructions: "Reply with JSON.", approvalPolicy: "never", sandbox: "read-only", config: { "features.shell_tool": false, "features.unified_exec": false, "features.multi_agent": false, web_search: "disabled", mcp_servers: { notes: { enabled: false } }, plugins: { "fmt@local": { enabled: false } } } });
        expect(logLines().find((l) => "oneOffPrompt" in l)?.oneOffPrompt).toBe("Is it fine?");
    });

    test("Claude Code answers in a session with no tools, settings, MCP servers or session file", async () => {
        process.env.FAKE_ONEOFF_ANSWER = '{"ok": true}';
        const r = await ask("claude-code");
        expect(r.content).toEqual([{ type: "text", text: '{"ok": true}' }]);
        expect(logLines().find((l) => l.oneOff)?.oneOff).toEqual({ system: "Reply with JSON.", prompt: "Is it fine?" });
        const argv = logLines()[0].argv as string[];
        for (const f of ["--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]) expect(argv).toContain(f);
        expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
    });

    test("a request that offers tools, or one that fails, is an error", async () => {
        for (const provider of ["codex", "claude-code"] as const) {
            await expect(ask(provider, [{ name: "t", description: "", parameters: {} }])).rejects.toThrow("offers tools");
            process.env.FAKE_ONEOFF_FAIL = "overloaded";
            await expect(ask(provider)).rejects.toThrow("overloaded");
            delete process.env.FAKE_ONEOFF_FAIL;
        }
    });

    test("a prompt hook on Codex is answered by Codex itself, and its no refuses the command", async () => {
        process.env.FAKE_ONEOFF_ANSWER = '{"ok": false, "reason": "touching files is not allowed"}';
        const { run, events } = await makeAgent("codex", { hooks: { PreToolUse: [{ matcher: "Bash", type: "prompt", prompt: "Refuse touch. $ARGUMENTS" }] } }, "bypassPermissions", undefined, { oneOffs: true });
        expect(await run("make x")).toBe("done");
        expect(logLines().find((l) => "oneOffPrompt" in l)?.oneOffPrompt).toContain('"command":"touch x"');
        expect(ranLine()).toMatchObject({ ran: false, blockedByHook: expect.stringContaining("touching files is not allowed") });
        expect(toolEnds(events)[0]!.result).toMatchObject({ isError: true });
    });
});

describe("Codex's items run Cavvy's hooks", () => {
    const turnStarts = () => received().filter((m) => m.method === "turn/start").map((m) => m.params);
    const decision = () => received().find((m) => m.result?.decision)?.result.decision;

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
        // Codex reports no item for a call it never started: Cavvy shows it, refused.
        expect(toolEnds(events)[0]).toMatchObject({ call: { name: "Bash", input: { command: "touch x" } }, result: { isError: true, content: expect.stringContaining("touching is banned") } });
    });

    test("the hook's tool is Cavvy's and hidden from the model; its server's token goes over stdin, not in arguments", async () => {
        const { run } = await makeAgent("codex", { hooks: { PreToolUse: [{ command: "true" }] } });
        expect(await run("make x")).toBe("done");
        const start = received().find((m) => m.method === "thread/start")!.params;
        const server = start.config.mcp_servers.cavvy_hooks;
        const { url, http_headers: { Authorization: auth } } = server;
        expect(url).toStartWith("http://127.0.0.1:");
        expect(server.default_tools_approval_mode).toBe("approve");
        expect(hookArg()).not.toContain(auth.slice(7));
        const list = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: auth }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
        // Open while the session's app-server is (#219): later turns' calls reach it too.
        expect((await list()).status).toBe(200);
        // Closed with the app-server: the token no longer works.
        await stopLiveCodex();
        expect((await list()).status).toBe(401);
        expect(logLines().find((l) => l.mcpConnected === "cavvy_hooks")?.tools).toEqual(["pre_tool_use"]);
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
        expect(received().find((m) => m.method === "thread/start")!.params.config?.mcp_servers?.cavvy_hooks).toBeUndefined();
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

    test("Codex runs SubagentStart and SubagentStop as its own: the context reaches the sub-agent, a block keeps it going", async () => {
        process.env.FAKE_SCENARIO = "subagent";
        const starts = join(cwd, "start.jsonl");
        const stops = join(cwd, "stop.jsonl");
        const settings = {
            hooks: {
                SubagentStart: [{ command: `${record(starts)}; ${say({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "use the fast path" } })}` }],
                SubagentStop: [{ command: `${record(stops)}; [ -f '${stops}.once' ] || { touch '${stops}.once'; echo 'check the tests too' >&2; exit 2; }` }],
            },
        };
        const { run } = await makeAgent("codex", settings);
        expect(await run("count")).toBe("done");
        expect(hookArg()).toContain('"SubagentStart"=[{"hooks"=[{"type"="mcp_tool"');
        expect(logLines().find((l) => l.subagentContext)?.subagentContext).toEqual(["use the fast path"]);
        expect(logLines().find((l) => l.subagentKeptGoing)?.subagentKeptGoing).toBe("check the tests too");
        expect(jsonl(starts)).toEqual([expect.objectContaining({ hook_event_name: "SubagentStart", agent_id: "thr-child", agent_type: "codex" })]);
        // Once with its answer, then again (stop_hook_active) after it kept going; Cavvy doesn't run them a third time.
        expect(jsonl(stops).map((l) => [l.agent_type, l.stop_hook_active, l.last_assistant_message])).toEqual([
            ["codex", false, "CHILD_REPORT: 2 files."],
            ["codex", true, "CHILD_REPORT: checked again."],
        ]);
    });

    describe("a Codex that doesn't run Cavvy's hooks itself (before 0.160)", () => {
        beforeEach(() => (process.env.FAKE_NO_HOOKS = "1"));

        test("bypass mode: Codex is made to ask about each command, so a hook can still refuse it", async () => {
            const seen = join(cwd, "pre.jsonl");
            const settings = { hooks: { PreToolUse: [{ matcher: "Bash", command: `${record(seen)}; echo 'touching is banned' >&2; exit 2` }] } };
            const { run, events, asked } = await makeAgent("codex", settings, "bypassPermissions", () => ({ allow: true }));
            expect(await run("make x")).toBe("done");
            expect(turnStarts()[0]).toMatchObject({ approvalPolicy: "untrusted", sandboxPolicy: { type: "dangerFullAccess" } });
            expect(received().find((m) => m.method === "thread/start")!.params.config?.mcp_servers?.cavvy_hooks).toBeUndefined();
            expect(decision()).toBe("decline");
            expect(asked).toEqual([]);
            expect(jsonl(seen)[0]).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "touch x" } });
            expect(toolEnds(events)[0]!.result).toMatchObject({ isError: true, content: expect.stringContaining("touching is banned") });
            expect(ranLine()).toMatchObject({ ran: false });
        });

        test("sub-agent hooks run in Cavvy, once each, and can't add context or keep it going", async () => {
            process.env.FAKE_SCENARIO = "subagent";
            const stops = join(cwd, "stop.jsonl");
            const settings = { hooks: { SubagentStart: [{ command: say({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "ctx" } }) }], SubagentStop: [{ command: `${record(stops)}; echo 'more' >&2; exit 2` }] } };
            const { run } = await makeAgent("codex", settings);
            expect(await run("count")).toBe("done");
            expect(hookArg()).toContain("SubagentStop");
            expect(logLines().some((l) => l.subagentContext || l.subagentKeptGoing)).toBe(false);
            await Bun.sleep(100);
            expect(jsonl(stops).map((l) => l.agent_type)).toEqual(["codex"]);
        });

        test("a deny that also says continue:false refuses the command and ends the turn", async () => {
            const stop = say({ continue: false, stopReason: "enough for today", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } });
            const a = await makeAgent("codex", { hooks: { PreToolUse: [{ command: stop }] } }, "default", () => ({ allow: true }));
            await a.run("make x");
            // Codex's "cancel" refuses the call and ends its turn; a plain decline would let it go on.
            expect(decision()).toBe("cancel");
            expect(ranLine()).toMatchObject({ ran: false });
            expect(a.asked).toEqual([]);
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
        const once = `[ -f '${seen}.once' ] || { touch '${seen}.once'; ${say({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x is generated" } })}; }`;
        const settings = { hooks: { PostToolUse: [{ matcher: "Bash", command: `${record(seen)}; ${once}` }] } };
        const { run } = await makeAgent("codex", settings);
        expect(await run("make x")).toBe("done");
        expect(jsonl(seen)[0]).toMatchObject({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "touch x" }, tool_response: { content: "ok\n" } });
        expect(typeof jsonl(seen)[0].duration_ms).toBe("number");
        // Steered into the turn while it runs; this fake ends it right after the command, so it starts the next one.
        const said = received().flatMap((m) => (m.method === "turn/steer" || (m.method === "turn/start" && m.params.input[0].text !== "make x") ? [m.params.input[0].text] : []));
        expect(said).toEqual(["<system-reminder>\nContext from a PostToolUse hook (Bash):\nx is generated\n</system-reminder>"]);
    });

    test("PostToolUse context from a hook that finishes after Codex ended the turn comes in the next turn", async () => {
        process.env.FAKE_STEER_FAIL = "1";
        const flag = join(cwd, "once");
        const settings = { hooks: { PostToolUse: [{ matcher: "Bash", command: `sleep 0.3; [ -f '${flag}' ] || { touch '${flag}'; ${say({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x is generated" } })}; }` }] } };
        const { run } = await makeAgent("codex", settings);
        expect(await run("make x")).toBe("done");
        const turns = received().filter((m) => m.method === "turn/start");
        expect(turns).toHaveLength(2);
        expect(turns[1].params.input[0].text).toContain("x is generated");
    });

    test("context from several PostToolUse hooks that finish after the turn all comes in the next turn", async () => {
        process.env.FAKE_SCENARIO = "steps";
        process.env.FAKE_STEER_FAIL = "1";
        // One per command (ls 1, ls 2), once each, so the next turn's commands add nothing.
        const hook = `n=$(grep -o 'ls [0-9]' | head -1 | tr -d ' '); sleep 0.3; [ -f '${cwd}/'$n ] || { touch '${cwd}/'$n; echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"saw '$n'"}}'; }`;
        const { run } = await makeAgent("codex", { hooks: { PostToolUse: [{ matcher: "Bash", command: hook }] } });
        expect(await run("check")).toBe("done");
        const next = received().filter((m) => m.method === "turn/start")[1]?.params.input[0].text;
        expect(next).toContain("saw ls1");
        expect(next).toContain("saw ls2");
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
        // Relative too: resolved against the repository, a .. still names somewhere else.
        await expect(make(`echo '../${main.split("/").pop()}'`)).rejects.toThrow("without . or ..");
        await expect(make(`echo './sub'`)).rejects.toThrow("without . or ..");
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
