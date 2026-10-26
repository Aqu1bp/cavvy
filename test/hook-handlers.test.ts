// Hook configuration (our flat format and Claude Code's nested one), the
// matcher rules, the four handler types (command, http, prompt, mcp_tool),
// running hooks at once, timeouts, and the JSON answers they give.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir, FAKE } from "./helpers/isolate";

const { cleanup } = isolate();
const { normalizeHooks, normalizeHookList } = await import("../src/config/hook-config");
const { runHooks, matcherFn, claudeCodeHookOutput, hooksFor, fileMatcherNames, backendMatcher } = await import("../src/agent/hooks");
const { loadSettings, hookConfigWarnings } = await import("../src/config/settings");
const { paths } = await import("../src/config/paths");

afterAll(cleanup);

const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

describe("configuration", () => {
    test("Claude Code's nested groups and our flat entries become the same flat handlers", () => {
        const list = normalizeHookList([
            { matcher: "Edit|Write", hooks: [{ type: "command", command: "fmt", timeout: 5 }, { type: "http", url: "http://localhost:1/h" }] },
            { matcher: "Bash", command: "check" },
            { hooks: [{ type: "prompt", prompt: "Is $ARGUMENTS safe?", model: "anthropic:claude-haiku-5-5" }] },
            { matcher: "*", hooks: [{ type: "mcp_tool", server: "lint", tool: "scan", input: { file: "${tool_input.file_path}" } }] },
        ]);
        expect(list).toEqual([
            { matcher: "Edit|Write", type: "command", command: "fmt", timeout: 5 },
            { matcher: "Edit|Write", type: "http", url: "http://localhost:1/h" },
            { matcher: "Bash", command: "check" },
            { type: "prompt", prompt: "Is $ARGUMENTS safe?", model: "anthropic:claude-haiku-5-5" },
            { matcher: "*", type: "mcp_tool", server: "lint", tool: "scan", input: { file: "${tool_input.file_path}" } },
        ]);
    });
    test("entries that can't run are dropped with a reason, and nothing throws", () => {
        const warnings: string[] = [];
        const list = normalizeHookList([{ type: "agent", prompt: "x" }, { hooks: [{ type: "command" }] }, { type: "http", url: "ftp://x" }, "nope", { type: "mcp_tool", server: "s" }, { command: "ok" }], (m) => warnings.push(m));
        expect(list).toEqual([{ command: "ok" }]);
        expect(warnings).toEqual([
            'hooks: hook type "agent" isn\'t supported (use command, http, prompt, mcp_tool)',
            "hooks: a command hook needs a command",
            "hooks: an http hook needs an http(s) url",
            "hooks: each hook must be an object",
            "hooks: an mcp_tool hook needs a server and a tool",
        ]);
        expect(normalizeHooks({ Setup: [{ command: "x" }], Stop: "nope" }, (m) => warnings.push(m))).toEqual({});
        expect(warnings.slice(-2)).toEqual(["hooks: Setup isn't a hook event Cavvy runs", "hooks: Stop: an event's hooks must be a list"]);
    });
    test("extra fields (a plugin's root) go on every handler", () => {
        expect(normalizeHooks({ Stop: [{ hooks: [{ command: "a" }, { command: "b" }] }] }, undefined, { pluginRoot: "/p" })).toEqual({ Stop: [{ pluginRoot: "/p", command: "a" }, { pluginRoot: "/p", command: "b" }] });
    });
    test("settings files in either format merge, and what they can't run is listed for /hooks", () => {
        const cwd = tempDir();
        mkdirSync(join(cwd, ".cavvy"), { recursive: true });
        mkdirSync(paths.userSettings().replace(/\/[^/]+$/, ""), { recursive: true });
        writeFileSync(paths.userSettings(), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", command: "user" }] } }));
        writeFileSync(paths.projectSettings(cwd), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "project" }] }], TeammateIdle: [{ command: "x" }] } }));
        const s = loadSettings(cwd);
        expect(s.hooks?.PreToolUse).toEqual([
            { matcher: "Bash", command: "user" },
            { matcher: "Bash", type: "command", command: "project" },
        ]);
        expect(hookConfigWarnings(s)).toEqual(["hooks: TeammateIdle isn't a hook event Cavvy runs"]);
        // Fixed, a reload has none: they belong to the load that found them.
        writeFileSync(paths.projectSettings(cwd), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", command: "project" }] } }));
        expect(hookConfigWarnings(loadSettings(cwd))).toEqual([]);
        expect(hookConfigWarnings(s)).toHaveLength(1);
    });
});

describe("matchers", () => {
    test("Claude Code's rules: all, an exact name or list, or an unanchored regex", () => {
        expect(matcherFn(undefined)("x")).toBe(true);
        expect(matcherFn("")("x")).toBe(true);
        expect(matcherFn("*")("x")).toBe(true);
        expect(matcherFn("Edit|Write")("Write")).toBe(true);
        expect(matcherFn("Edit, Write")("Write")).toBe(true);
        expect(matcherFn("Edit|Write")("MultiEdit")).toBe(false);
        expect(matcherFn("mcp__.*")("mcp__github__issue")).toBe(true);
        expect(matcherFn("^Notebook")("NotebookEdit")).toBe(true);
        expect(matcherFn("Edit.*")("MultiEdit")).toBe(true);
        expect(matcherFn("([")("x")).toBe(false);
    });
    test("a matcher that covers Bash covers Monitor, here and as given to a backend that matches hooks itself", () => {
        const s = (matcher: string) => ({ hooks: { PreToolUse: [{ matcher, command: "c" }] } }) as any;
        const runs = (matcher: string, tool: string) => hooksFor(s(matcher), "PreToolUse", { tool_name: tool, tool_input: { command: "ls" } }, "/").length === 1;
        for (const m of ["Bash", "Edit|Bash", "^Bash$", "Ba.*"]) {
            expect(runs(m, "Monitor")).toBe(true);
            const given = backendMatcher("PreToolUse", m)!;
            expect([matcherFn(given)("Bash"), matcherFn(given)("Monitor"), matcherFn(given)("Edit")]).toEqual([true, true, matcherFn(m)("Edit")]);
        }
        expect(runs("Edit", "Monitor")).toBe(false);
        // Others as written: no Bash in them, Monitor already in them, no tool to match, or match everything.
        expect(backendMatcher("PreToolUse", "Edit|Write")).toBe("Edit|Write");
        expect(backendMatcher("PreToolUse", "Bash|Monitor")).toBe("Bash|Monitor");
        expect(backendMatcher("SessionStart", "Bash")).toBe("Bash");
        expect(backendMatcher("PostToolUse", undefined)).toBeUndefined();
        expect(backendMatcher("PostToolUse", "*")).toBe("*");
    });
    test("each event matches its own field; events without one run every hook", () => {
        const s = { hooks: { SessionStart: [{ matcher: "resume", command: "a" }], Stop: [{ matcher: "nothing-matches", command: "b" }], FileChanged: [{ matcher: ".env|.envrc", command: "c" }] } } as any;
        expect(hooksFor(s, "SessionStart", { source: "startup" }, "/")).toHaveLength(0);
        expect(hooksFor(s, "SessionStart", { source: "resume" }, "/")).toHaveLength(1);
        expect(hooksFor(s, "Stop", {}, "/")).toHaveLength(1);
        expect(hooksFor(s, "FileChanged", { file_path: "/p/.envrc" }, "/")).toHaveLength(1);
        expect(hooksFor(s, "FileChanged", { file_path: "/p/package.json" }, "/")).toHaveLength(0);
    });
    test("FileChanged: a name matches the file's name, a path the file itself, a pattern its name", () => {
        const s = (matcher: string) => ({ hooks: { FileChanged: [{ matcher, command: "c" }] } }) as any;
        const runs = (matcher: string, file: string) => hooksFor(s(matcher), "FileChanged", { file_path: file }, "/elsewhere").length === 1;
        expect(runs("config/app.json", "/p/config/app.json")).toBe(true);
        expect(runs("./config/app.json", "/p/config/app.json")).toBe(true);
        expect(runs("config/app.json", "/p/app.json")).toBe(false);
        expect(runs("/p/.env", "/p/.env")).toBe(true);
        expect(runs("/p/.env", "/q/.env")).toBe(false);
        expect(runs("^\\.env", "/p/.env.local")).toBe(true);
        expect(fileMatcherNames(".envrc|config/app.json")).toEqual([".envrc", "config/app.json"]);
        expect(fileMatcherNames("^\\.env")).toBeUndefined();
        expect(fileMatcherNames("*")).toBeUndefined();
    });
    test("watchPaths from parallel hooks are all kept", async () => {
        const s = { hooks: { SessionStart: [{ command: `echo '{"watchPaths":["/p/.env"]}'` }, { command: `echo '{"watchPaths":["/p/package.json","/p/.env"]}'` }] } } as any;
        expect((await runHooks(s, "SessionStart", {}, tempDir())).watchPaths).toEqual(["/p/.env", "/p/package.json"]);
    });
    test("`if` narrows a tool event with a permission rule", () => {
        const s = { hooks: { PreToolUse: [{ matcher: "Bash", if: "Bash(git *)", command: "a" }] } } as any;
        expect(hooksFor(s, "PreToolUse", { tool_name: "Bash", tool_input: { command: "git push" } }, "/")).toHaveLength(1);
        expect(hooksFor(s, "PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test" } }, "/")).toHaveLength(0);
    });
    test("identical handlers run once", () => {
        const s = { hooks: { Stop: [{ command: "a" }, { matcher: "*", command: "a" }, { command: "a", timeout: 5 }] } } as any;
        expect(hooksFor(s, "Stop", {}, "/")).toHaveLength(2);
    });
});

describe("command hooks", () => {
    test("matching hooks run at once, not one after another", async () => {
        const s = { hooks: { PostToolUse: [{ command: "sleep 0.4; echo '{\"additionalContext\":\"one\"}'" }, { command: "sleep 0.4; echo '{\"additionalContext\":\"two\"}'" }, { command: "sleep 0.4; echo '{\"additionalContext\":\"three\"}'" }] } } as any;
        const t = Date.now();
        const o = await runHooks(s, "PostToolUse", { tool_name: "Edit" }, tempDir());
        expect(Date.now() - t).toBeLessThan(1000);
        // In the order configured, whichever finished first.
        expect(o.additionalContext).toBe("one\ntwo\nthree");
    });
    test("the strictest decision wins, whichever hook gave it", async () => {
        const s = { hooks: { PreToolUse: [{ command: `echo '{"permissionDecision":"allow"}'` }, { command: `sleep 0.1; echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no"}}'` }, { command: `echo '{"permissionDecision":"ask"}'` }] } } as any;
        const o = await runHooks(s, "PreToolUse", { tool_name: "Bash" }, tempDir());
        expect(o).toMatchObject({ decision: "deny", reason: "no" });
    });
    test("a hook that runs too long is stopped and reported, and doesn't block", async () => {
        const t = Date.now();
        const o = await runHooks({ hooks: { PreToolUse: [{ command: "sleep 10", timeout: 1 }] } } as any, "PreToolUse", { tool_name: "Bash" }, tempDir());
        expect(Date.now() - t).toBeLessThan(3000);
        expect(o.blocked).toBeUndefined();
        expect(o.errors).toEqual(['PreToolUse hook "sleep 10" timed out after 1s']);
    });
    test("an interrupt stops it quietly", async () => {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 100);
        const t = Date.now();
        const o = await runHooks({ hooks: { Stop: [{ command: "sleep 10" }] } } as any, "Stop", {}, tempDir(), ac.signal);
        expect(Date.now() - t).toBeLessThan(3000);
        expect(o).toEqual({ errors: [], messages: [] });
    });
    test("a program that isn't there is a non-blocking error", async () => {
        const o = await runHooks({ hooks: { Stop: [{ command: "/no/such/program", args: [] }] } } as any, "Stop", {}, tempDir());
        expect(o.blocked).toBeUndefined();
        expect(o.errors[0]).toMatch(/^Stop hook failed to start|^Stop hook "\/no\/such\/program" exited/);
    });
    test("exec form: no shell, with ${CLAUDE_PROJECT_DIR} and a plugin's root expanded", async () => {
        const dir = tempDir();
        const o = await runHooks({ hooks: { UserPromptSubmit: [{ command: "/bin/echo", args: ["${CLAUDE_PROJECT_DIR}", "$CAVVY_PLUGIN_ROOT", "; rm -rf x"], pluginRoot: "/plug" }] } } as any, "UserPromptSubmit", { prompt: "p" }, dir);
        expect(o.additionalContext).toBe(`${dir} /plug ; rm -rf x`);
    });
    test("continue: false ends the turn with its reason; systemMessage is for the user", async () => {
        const o = await runHooks({ hooks: { PostToolUse: [{ command: `echo '{"continue":false,"stopReason":"build broke","systemMessage":"heads up"}'` }] } } as any, "PostToolUse", { tool_name: "Bash" }, tempDir());
        expect(o.stop).toBe("build broke");
        expect(o.messages).toEqual(["heads up"]);
    });
    test("PermissionRequest: a decision answers for the user (deny wins); exit 2 is ignored", async () => {
        const allow = `echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"command":"npm run lint"}}}}'`;
        const deny = `echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"not today","interrupt":true}}}'`;
        expect(await runHooks({ hooks: { PermissionRequest: [{ command: allow }] } } as any, "PermissionRequest", { tool_name: "Bash" }, tempDir())).toMatchObject({ permission: { behavior: "allow" }, updatedInput: { command: "npm run lint" } });
        const both = await runHooks({ hooks: { PermissionRequest: [{ command: allow }, { command: deny }] } } as any, "PermissionRequest", { tool_name: "Bash" }, tempDir());
        expect(both.permission).toEqual({ behavior: "deny", message: "not today", interrupt: true });
        expect(both.updatedInput).toBeUndefined();
        expect(await runHooks({ hooks: { PermissionRequest: [{ command: "echo x >&2; exit 2" }] } } as any, "PermissionRequest", { tool_name: "Bash" }, tempDir())).toEqual({ errors: [], messages: [] });
    });
    test("an async hook doesn't hold anything up, and what it says comes later", async () => {
        const later: any[] = [];
        const t = Date.now();
        const o = await runHooks({ hooks: { PostToolUse: [{ command: `sleep 0.3; echo '{"additionalContext":"tests pass"}'`, async: true }] } } as any, "PostToolUse", { tool_name: "Edit" }, tempDir(), { onAsync: (x) => later.push(x) });
        expect(Date.now() - t).toBeLessThan(200);
        expect(o.additionalContext).toBeUndefined();
        for (let i = 0; i < 50 && !later.length; i++) await Bun.sleep(20);
        expect(later).toEqual([{ errors: [], messages: [], additionalContext: "tests pass" }]);
    });
    test("WorktreeCreate: the path is the last line printed, banners before it ignored", async () => {
        const o = await runHooks({ hooks: { WorktreeCreate: [{ command: "echo banner; printf '\\033[1m/tmp/wt\\033[0m\\n'" }] } } as any, "WorktreeCreate", { name: "x" }, tempDir());
        expect(o.worktreePath).toBe("/tmp/wt");
    });
});

describe("http hooks", () => {
    const received: { body: any; headers: Record<string, string> }[] = [];
    let reply: (req: Request) => Response | Promise<Response> = () => new Response("");
    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            received.push({ body: await req.json(), headers: Object.fromEntries(req.headers) });
            return reply(req);
        },
    });
    afterAll(() => server.stop(true));
    const url = `http://127.0.0.1:${server.port}/hook`;
    const hook = (extra: any = {}) => ({ hooks: { PreToolUse: [{ type: "http", url, ...extra }] } }) as any;

    test("gets the input as the body; an empty 2xx is a plain yes", async () => {
        received.length = 0;
        reply = () => new Response("", { status: 204 });
        const o = await runHooks(hook(), "PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }, "/w");
        expect(o).toEqual({ errors: [], messages: [] });
        expect(received[0]!.body).toEqual({ hook_event_name: "PreToolUse", cwd: "/w", tool_name: "Bash", tool_input: { command: "ls" } });
        expect(received[0]!.headers["content-type"]).toBe("application/json");
    });
    test("a JSON body decides like a command's output", async () => {
        reply = () => Response.json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "prod" } });
        expect(await runHooks(hook(), "PreToolUse", { tool_name: "Bash" }, "/w")).toMatchObject({ decision: "deny", reason: "prod" });
        reply = () => Response.json({ decision: "block", reason: "nope" });
        expect((await runHooks({ hooks: { Stop: [{ type: "http", url }] } } as any, "Stop", {}, "/w")).blocked).toBe("nope");
    });
    test("text, an error status or no server is a non-blocking error", async () => {
        reply = () => new Response("ok then");
        expect((await runHooks(hook(), "PreToolUse", { tool_name: "Bash" }, "/w")).errors).toEqual([`PreToolUse http hook ${url} returned text, not JSON: ok then`]);
        reply = () => new Response("boom", { status: 500 });
        expect((await runHooks(hook(), "PreToolUse", { tool_name: "Bash" }, "/w")).errors).toEqual([`PreToolUse http hook ${url} returned 500: boom`]);
        const o = await runHooks({ hooks: { Stop: [{ type: "http", url: "http://127.0.0.1:9/x" }] } } as any, "Stop", {}, "/w");
        expect(o.blocked).toBeUndefined();
        expect(o.errors[0]).toMatch(/^Stop http hook http:\/\/127.0.0.1:9\/x failed: /);
    });
    test("too slow: stopped after its timeout", async () => {
        reply = async () => (await Bun.sleep(3000), new Response(""));
        const t = Date.now();
        const o = await runHooks(hook({ timeout: 1 }), "PreToolUse", { tool_name: "Bash" }, "/w");
        expect(Date.now() - t).toBeLessThan(2500);
        expect(o.errors).toEqual([`PreToolUse http hook ${url} timed out after 1s`]);
    });
    test("headers take only the variables allowed, and never a provider key", async () => {
        received.length = 0;
        reply = () => new Response("");
        process.env.MY_HOOK_TOKEN = "tok123";
        process.env.ANTHROPIC_API_KEY = FAKE.anthropic;
        try {
            await runHooks(hook({ headers: { a: "Bearer $MY_HOOK_TOKEN", b: "${OTHER_VAR}x", c: "$ANTHROPIC_API_KEY" }, allowedEnvVars: ["MY_HOOK_TOKEN", "ANTHROPIC_API_KEY"] }), "PreToolUse", { tool_name: "Bash" }, "/w");
        } finally {
            delete process.env.MY_HOOK_TOKEN;
            delete process.env.ANTHROPIC_API_KEY;
        }
        expect(received[0]!.headers).toMatchObject({ a: "Bearer tok123", b: "x", c: "" });
    });
});

describe("prompt hooks", () => {
    const asked: { system: string; prompt: string; model?: string }[] = [];
    const answering = (answer: string) => ({ complete: async (system: string, prompt: string, _s: AbortSignal, model?: string) => (asked.push({ system, prompt, model }), answer) });
    const stop = (extra: any = {}) => ({ hooks: { Stop: [{ type: "prompt", prompt: "Are all tasks done? $ARGUMENTS", ...extra }] } }) as any;

    test("the model sees the rule with the input in place of $ARGUMENTS", async () => {
        asked.length = 0;
        const o = await runHooks(stop({ model: "openai:gpt-test" }), "Stop", { last_assistant_message: "done" }, "/w", answering('{"ok": true}'));
        expect(o).toEqual({ errors: [], messages: [] });
        expect(asked[0]!.prompt).toBe(`Are all tasks done? {"hook_event_name":"Stop","cwd":"/w","last_assistant_message":"done"}`);
        expect(asked[0]!.model).toBe("openai:gpt-test");
    });
    test("no $ARGUMENTS: the input goes after the prompt; \\$ is a literal $", async () => {
        asked.length = 0;
        await runHooks({ hooks: { UserPromptSubmit: [{ type: "prompt", prompt: "Costs \\$5?" }] } } as any, "UserPromptSubmit", { prompt: "hi" }, "/w", answering('{"ok":true}'));
        expect(asked[0]!.prompt).toBe(`Costs $5?\n\n{"hook_event_name":"UserPromptSubmit","cwd":"/w","prompt":"hi"}`);
    });
    test("a \\$ inside the input reaches the model as it is; an escaped \\$ARGUMENTS stays text", async () => {
        asked.length = 0;
        await runHooks({ hooks: { PreToolUse: [{ type: "prompt", prompt: "Safe? $ARGUMENTS" }] } } as any, "PreToolUse", { tool_name: "Bash", tool_input: { command: "echo \\$HOME" } }, "/w", answering('{"ok":true}'));
        expect(asked[0]!.prompt).toContain(JSON.stringify("echo \\$HOME"));
        await runHooks({ hooks: { PreToolUse: [{ type: "prompt", prompt: "Mentions \\$ARGUMENTS" }] } } as any, "PreToolUse", { tool_name: "Read" }, "/w", answering('{"ok":true}'));
        expect(asked[1]!.prompt).toStartWith("Mentions $ARGUMENTS\n\n{");
    });
    test("a no blocks, with its reason; on PreToolUse it denies the call", async () => {
        expect((await runHooks(stop(), "Stop", {}, "/w", answering('Sure: {"ok": false, "reason": "tests still fail"}'))).blocked).toBe("tests still fail");
        const pre = await runHooks({ hooks: { PreToolUse: [{ type: "prompt", prompt: "Block .env reads" }] } } as any, "PreToolUse", { tool_name: "Read" }, "/w", answering('{"ok": false, "reason": "reads .env"}'));
        expect(pre).toMatchObject({ decision: "deny", reason: "reads .env" });
        expect(pre.blocked).toBeUndefined();
    });
    test("impossible lets Stop end; a garbled answer or no model is an error, not a block", async () => {
        expect(await runHooks(stop(), "Stop", {}, "/w", answering('{"ok": false, "reason": "x", "impossible": true}'))).toEqual({ errors: [], messages: [] });
        expect((await runHooks(stop(), "Stop", {}, "/w", answering("I think so"))).errors).toEqual(['Stop prompt hook gave no {"ok": …} answer: I think so']);
        expect((await runHooks(stop(), "Stop", {}, "/w")).errors).toEqual(["Stop prompt hook skipped: no model is set up to answer it"]);
        expect((await runHooks({ hooks: { SessionEnd: [{ type: "prompt", prompt: "x" }] } } as any, "SessionEnd", {}, "/w", answering('{"ok":false}'))).errors).toEqual(["SessionEnd doesn't run prompt hooks (use a command hook)"]);
    });
    test("too slow: stopped after its timeout (30s by default)", async () => {
        const slow = { complete: (_a: string, _b: string, signal: AbortSignal) => new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) };
        const o = await runHooks(stop({ timeout: 0.2 }), "Stop", {}, "/w", slow);
        expect(o.errors).toEqual(["Stop prompt hook timed out after 0.2s"]);
    });
});

describe("mcp_tool hooks", () => {
    const calls: any[] = [];
    const services = (result: { text: string; isError: boolean }) => ({ callTool: async (server: string, tool: string, input: any) => (calls.push({ server, tool, input }), result) });
    const hook = { hooks: { PostToolUse: [{ type: "mcp_tool", server: "lint", tool: "scan", input: { file: "${tool_input.file_path}", whole: "${tool_input}", note: "in ${cwd}" } }] } } as any;

    test("its input takes fields from the event; its text is read like stdout", async () => {
        calls.length = 0;
        const o = await runHooks(hook, "PostToolUse", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }, "/w", services({ text: '{"additionalContext":"2 lint errors"}', isError: false }));
        expect(calls).toEqual([{ server: "lint", tool: "scan", input: { file: "a.ts", whole: { file_path: "a.ts" }, note: "in /w" } }]);
        expect(o.additionalContext).toBe("2 lint errors");
    });
    test("an error result, or no MCP here, is a non-blocking error", async () => {
        expect((await runHooks(hook, "PostToolUse", { tool_name: "Edit" }, "/w", services({ text: "server down", isError: true }))).errors).toEqual(["PostToolUse hook mcp__lint__scan failed: server down"]);
        expect((await runHooks(hook, "PostToolUse", { tool_name: "Edit" }, "/w")).errors).toEqual(["PostToolUse hook mcp__lint__scan skipped: no MCP servers are connected here"]);
    });
});

describe("Claude Code's hook_callback answers", () => {
    test("our results in its output schema", () => {
        expect(claudeCodeHookOutput("PreToolUse", { kind: "block", reason: "no" })).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } });
        expect(claudeCodeHookOutput("PostToolUse", { kind: "block", reason: "fix lint" })).toEqual({ decision: "block", reason: "fix lint" });
        expect(claudeCodeHookOutput("PreToolUse", { kind: "output", json: { permissionDecision: "allow", additionalContext: "c" } })).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", additionalContext: "c" } });
        expect(claudeCodeHookOutput("PostToolUse", { kind: "output", json: { continue: false, stopReason: "s", hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x" } } })).toEqual({ continue: false, stopReason: "s", hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "x" } });
        expect(claudeCodeHookOutput("Stop", { kind: "error", message: "e" })).toEqual({});
        expect(claudeCodeHookOutput("Stop", { kind: "output", text: "plain" })).toEqual({});
        // Plain text is context where Cavvy takes it so (a sub-agent's start, on Claude Code).
        expect(claudeCodeHookOutput("SubagentStart", { kind: "output", text: "Use pnpm\n" })).toEqual({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "Use pnpm" } });
    });
});

describe("no hooks", () => {
    test("cost next to nothing", async () => {
        const s = { hooks: { Stop: [{ command: "x" }] } } as any;
        const t = performance.now();
        for (let i = 0; i < 10_000; i++) await runHooks(s, "PreToolUse", { tool_name: "Bash" }, "/w");
        // 10k calls for an event with no hooks: well under a millisecond each.
        expect((performance.now() - t) / 10_000).toBeLessThan(0.05);
    });
});
