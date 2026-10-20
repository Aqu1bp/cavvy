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

async function makeAgent(provider: "claude-code" | "codex", settings: any, mode: PermissionMode = "bypassPermissions", ask?: () => any) {
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

    test("bypass mode with PreToolUse hooks: Codex asks about each command, so a hook can refuse it", async () => {
        const seen = join(cwd, "pre.jsonl");
        const settings = { hooks: { PreToolUse: [{ matcher: "Bash", command: `${record(seen)}; echo 'touching is banned' >&2; exit 2` }] } };
        const { run, events, asked } = await makeAgent("codex", settings, "bypassPermissions", () => ({ allow: true }));
        expect(await run("make x")).toBe("done");
        expect(turnStarts()[0]).toMatchObject({ approvalPolicy: "untrusted", sandboxPolicy: { type: "dangerFullAccess" } });
        expect(decision()).toBe("decline");
        expect(asked).toEqual([]);
        expect(jsonl(seen)[0]).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "touch x" } });
        expect(toolEnds(events)[0]!.result).toMatchObject({ isError: true, content: expect.stringContaining("touching is banned") });
        expect(logLines().find((l) => "ran" in l)).toMatchObject({ ran: false });
    });

    test("bypass mode: a hook that says nothing lets the command run without asking, as bypass would", async () => {
        const { run, asked } = await makeAgent("codex", { hooks: { PreToolUse: [{ command: "true" }] } }, "bypassPermissions", () => ({ allow: false, message: "no", stop: false }));
        expect(await run("make x")).toBe("done");
        expect(decision()).toBe("accept");
        expect(asked).toEqual([]);
    });

    test("without PreToolUse hooks bypass mode stays Codex's own (never asks)", async () => {
        const { run } = await makeAgent("codex", { hooks: { PostToolUse: [{ command: "true" }] } });
        expect(await run("make x")).toBe("done");
        expect(turnStarts()[0]).toMatchObject({ approvalPolicy: "never" });
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

    test("default mode: a hook's ask asks the user even where a rule would allow it", async () => {
        const settings = { permissions: { allow: ["Bash(touch:*)"] }, hooks: { PreToolUse: [{ command: say({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } }) }] } };
        const { run, asked } = await makeAgent("codex", settings, "default", () => ({ allow: true }));
        expect(await run("make x")).toBe("done");
        expect(asked).toHaveLength(1);
        expect(decision()).toBe("accept");
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
