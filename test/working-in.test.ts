// The session follows the agent into another worktree (SessionState.workingIn): from what the agent reports
// (Claude Code's turn starts and its EnterWorktree/ExitWorktree results, Cavvy's own after a cd or its own
// EnterWorktree), kept with the session and restored when it's opened again.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { startMockLlm } = await import("../scripts/mock-llm");
const { Engine } = await import("../src/server/engine");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BashTool } = await import("../src/tools/bash");
const { EnterWorktreeTool, ExitWorktreeTool } = await import("../src/tools/worktree-tools");
const { workingWorktree } = await import("../src/server/session-worktrees");
const { claudeWorktreeMove } = await import("../src/backends/claude-code");
const { gitArgv, gitEnv } = await import("../src/util/git");
import type { ChatRequest } from "../src/providers/types";
import type { SessionSnapshot } from "../src/server/protocol";

const mock = startMockLlm({ delayMs: 0 });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));
afterAll(() => {
    mock.stop();
    iso.cleanup();
});

function git(cwd: string, ...args: string[]): string {
    const result = Bun.spawnSync(gitArgv(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Cavvy Test", "-c", "user.email=test@example.invalid", ...args]), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
}

/** A repository with a worktree under its .claude/worktrees, as Claude Code's EnterWorktree makes one. */
function repo(name: string) {
    const main = join(realpathSync(iso.home), name);
    mkdirSync(main);
    git(main, "init", "-b", "main");
    writeFileSync(join(main, "readme.txt"), "hello\n");
    git(main, "add", "-A");
    git(main, "commit", "-m", "Initial commit");
    const linked = join(main, ".claude", "worktrees", "ui-fixes");
    git(main, "worktree", "add", "-b", "worktree-ui-fixes", linked);
    return { main, linked };
}

async function until(fn: () => boolean, ms = 10_000) {
    const end = Date.now() + ms;
    while (!fn() && Date.now() < end) await Bun.sleep(20);
}

describe("workingWorktree", () => {
    test("the other worktree a folder is in, the innermost; none for the session's own, or outside the repository", () => {
        const { main, linked } = repo("which");
        mkdirSync(join(linked, "src"));
        mkdirSync(join(main, "src"));
        expect(workingWorktree(main, linked)).toMatchObject({ path: linked, branch: "worktree-ui-fixes" });
        // Inside the main checkout's folder, but in the worktree there.
        expect(workingWorktree(main, join(linked, "src"))?.path).toBe(linked);
        expect(workingWorktree(main, main)).toBeUndefined();
        expect(workingWorktree(main, join(main, "src"))).toBeUndefined();
        expect(workingWorktree(main, realpathSync(iso.home))).toBeUndefined();
        // A folder whose name only starts like the worktree's isn't in it.
        const beside = `${linked}-2`;
        mkdirSync(beside);
        expect(workingWorktree(main, beside)).toBeUndefined();
        // From inside the worktree, the main checkout is the other one.
        expect(workingWorktree(linked, main)).toMatchObject({ path: main, branch: "main" });
    });
});

describe("claudeWorktreeMove", () => {
    test("the folder Claude Code's worktree tools leave its session in, from their structured results", () => {
        expect(claudeWorktreeMove("EnterWorktree", { worktreePath: "/repo/.claude/worktrees/x", worktreeBranch: "worktree-x", message: "…" })).toBe("/repo/.claude/worktrees/x");
        expect(claudeWorktreeMove("ExitWorktree", { action: "keep", originalCwd: "/repo", worktreePath: "/repo/.claude/worktrees/x", restoredCwd: "/repo" })).toBe("/repo");
        // An ExitWorktree with no worktree entered moves nothing; nor does any other tool, or a path that isn't one.
        expect(claudeWorktreeMove("ExitWorktree", { message: "No worktree session is active." })).toBeUndefined();
        expect(claudeWorktreeMove("Bash", { worktreePath: "/repo/x" })).toBeUndefined();
        expect(claudeWorktreeMove("EnterWorktree", { worktreePath: "relative/x" })).toBeUndefined();
        expect(claudeWorktreeMove("EnterWorktree", undefined)).toBeUndefined();
    });
});

describe("Session.setWorkdir", () => {
    test("is written when it changes, read back, cleared, and taken by a fork", () => {
        const { main, linked } = repo("record");
        const s = Session.create(main);
        s.push({ role: "user", content: [{ type: "text", text: "hi" }] });
        s.setWorkdir(linked);
        s.setWorkdir(linked);
        expect(Session.load(s.path).workdir).toBe(linked);
        expect(s.fork({ persist: false }).workdir).toBe(linked);
        s.setWorkdir(undefined);
        expect(Session.load(s.path).workdir).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Cavvy's own EnterWorktree and ExitWorktree, as a model Cavvy runs calls them

const reply = (content: any[], stopReason = "end_turn") => ({ role: "assistant", provider: "test", model: "test", stopReason, content }) as any;
const text = (t: string) => reply([{ type: "text", text: t }]);
const toolCall = (id: string, name: string, input: unknown) => reply([{ type: "tool_call", id, name, input }], "tool_use");

/** An agent whose model makes `calls` one after another, then says done; what it reported of its folder, and each result. */
function scripted(proj: string, calls: [string, unknown][]) {
    const events: string[] = [];
    const results: { content: string; isError?: boolean }[] = [];
    const state = { cwd: proj, projectRoot: proj, fileState: new Map(), todos: [], shells: new Map() } as any;
    let n = 0;
    const agent = new Agent({
        session: Session.create(proj, { persist: false, system: "S" }),
        model: { provider: "test", id: "test" } as any,
        client: {
            stream: async (req: ChatRequest) => {
                const last = req.messages.at(-1) as any;
                if (last?.meta?.kind === "tool_results") results.push(...last.content.map((p: any) => ({ content: typeof p.content === "string" ? p.content : JSON.stringify(p.content), isError: p.isError })));
                const next = calls[n];
                n++;
                return next ? toolCall(`c${n}`, next[0], next[1]) : text("done");
            },
        } as any,
        settings: () => ({ autoCompact: false }) as any,
        checker: new PermissionChecker(() => ({}) as any, proj),
        tools: [BashTool, EnterWorktreeTool, ExitWorktreeTool],
        mode: { get: () => "bypassPermissions" as any, set() {} },
        toolState: state,
        host: { emit: (e: any) => e.type === "cwd" && events.push(e.cwd), ui: {} } as any,
    });
    const run = () => agent.run([{ type: "text", text: "go" }], { signal: new AbortController().signal });
    return { run, state, events, results };
}

describe("Cavvy's EnterWorktree and ExitWorktree", () => {
    test("makes a worktree on worktree-<name>, works there, and goes back keeping it", async () => {
        const { main } = repo("tool-keep");
        const made = join(main, ".claude", "worktrees", "feature");
        const a = scripted(main, [["EnterWorktree", { name: "feature" }], ["Bash", { command: "pwd" }], ["ExitWorktree", { action: "keep" }]]);
        await a.run();
        expect(a.results[0]!.isError).toBeFalsy();
        expect(a.results[1]!.content).toContain(made);
        expect(git(made, "branch", "--show-current")).toBe("worktree-feature");
        expect(a.events).toEqual([made, main]);
        expect(a.state.cwd).toBe(main);
        expect(existsSync(made)).toBe(true);
    });

    test("never removes one: asked to, it refuses and the session stays; leaving keeps it", async () => {
        const { main } = repo("tool-remove");
        const made = join(main, ".claude", "worktrees", "made");
        // A file of its own in it, as a copied .env would be.
        const a = scripted(main, [["EnterWorktree", { name: "made" }], ["Bash", { command: "echo SECRET=1 > .env" }], ["ExitWorktree", { action: "remove" }], ["ExitWorktree", {}]]);
        await a.run();
        expect(a.results[2]!.isError).toBe(true);
        expect(a.results[3]!.isError).toBeFalsy();
        expect(existsSync(join(made, ".env"))).toBe(true);
        expect(git(main, "branch", "--list", "worktree-made")).toContain("worktree-made");
        expect(a.events).toEqual([made, main]);
    });

    test("moves into an existing worktree by path", async () => {
        const { main, linked } = repo("tool-path");
        const a = scripted(main, [["EnterWorktree", { path: ".claude/worktrees/ui-fixes" }], ["ExitWorktree", { action: "keep" }]]);
        await a.run();
        expect(a.results[0]!.isError).toBeFalsy();
        expect(existsSync(linked)).toBe(true);
        expect(a.events).toEqual([linked, main]);
    });

    test("refuses a second new worktree while in one, a folder that isn't a worktree, and the session's own folder", async () => {
        const { main } = repo("tool-refuse");
        mkdirSync(join(main, "plain"));
        const a = scripted(main, [["EnterWorktree", { path: "plain" }], ["EnterWorktree", { path: "." }], ["EnterWorktree", { name: "one" }], ["EnterWorktree", { name: "two" }]]);
        await a.run();
        expect(a.results.map((r) => Boolean(r.isError))).toEqual([true, true, false, true]);
        expect(a.results[3]!.content).toContain("ExitWorktree");
        expect(existsSync(join(main, ".claude", "worktrees", "two"))).toBe(false);
    });

    test("checked as a command is: Manual and Accept edits ask, Plan refuses (saying why), Bypass runs it", async () => {
        const c = new PermissionChecker(() => ({}) as any, "/w");
        const decide = (tool: typeof EnterWorktreeTool | typeof ExitWorktreeTool) => (["default", "acceptEdits", "plan", "bypassPermissions"] as const).map((m) => c.check(tool, {}, m, "/w").behavior);
        expect(decide(EnterWorktreeTool)).toEqual(["ask", "ask", "deny", "allow"]);
        expect(decide(ExitWorktreeTool)).toEqual(["ask", "ask", "deny", "allow"]);
        expect(c.check(EnterWorktreeTool, { name: "x" }, "plan", "/w").reason).toBe("Plan mode is active: the session stays where it is, in no new worktree. Call ExitPlanMode with your plan first.");
    });
});

// ---------------------------------------------------------------------------
// The session following it

describe("SessionState.workingIn", () => {
    test("follows the folder the agent reports, is kept with the session, and brings a Cavvy-run agent back there when reopened", async () => {
        const { main, linked } = repo("follow");
        const engine = new Engine();
        const c = { subs: new Set<string>(), send() {} };
        engine.clients.add(c as never);
        const snap = (await engine.handle(c as never, "session.create", { cwd: main })) as SessionSnapshot;
        const id = snap.state.id;
        const rt = engine.runtimes.get(id)! as any;
        expect(rt.view.state.workingIn).toBeUndefined();
        expect(rt.view.state.branch).toBe("main");
        // Saved once it has a message.
        await engine.handle(c as never, "session.send", { id, text: "hi" });
        await until(() => rt.idle && rt.session.messages.length >= 2);

        // The worktree in .claude/worktrees shows in the main checkout as a new folder, to every session there.
        expect(git(main, "status", "--porcelain")).toContain(".claude/");
        rt.followCwd(linked);
        expect(rt.view.state.workingIn).toEqual({ path: linked, branch: "worktree-ui-fixes" });
        expect(rt.session.workdir).toBe(linked);
        // Once followed, it's kept out of the main checkout's changes, as Cavvy's own worktrees are.
        expect(git(main, "status", "--porcelain")).toBe("");
        // A folder inside it is the same worktree; the session's own folder clears it.
        mkdirSync(join(linked, "src"));
        rt.followCwd(join(linked, "src"));
        expect(rt.view.state.workingIn?.path).toBe(linked);
        rt.followCwd(main);
        expect(rt.view.state.workingIn).toBeUndefined();
        rt.followCwd(linked);
        await engine.handle(c as never, "session.close", { id });
        await engine.stop();

        const again = new Engine();
        try {
            const c2 = { subs: new Set<string>(), send() {} };
            again.clients.add(c2 as never);
            const reopened = (await again.handle(c2 as never, "session.open", { id })) as SessionSnapshot;
            expect(reopened.state.workingIn).toEqual({ path: linked, branch: "worktree-ui-fixes" });
            expect((again.runtimes.get(id) as any).toolState.cwd).toBe(linked);
        } finally {
            await again.stop();
        }
    });

    test("the worktree a session's agent works in counts as the session's: removing it is refused while it's open", async () => {
        const { main, linked } = repo("guard");
        const engine = new Engine();
        try {
            const c = { subs: new Set<string>(), send() {} };
            engine.clients.add(c as never);
            const snap = (await engine.handle(c as never, "session.create", { cwd: main })) as SessionSnapshot;
            (engine.runtimes.get(snap.state.id) as any).followCwd(linked);
            await expect((engine as any).removeWorktree(main, linked)).rejects.toMatchObject({ code: "in_use" });
            expect(existsSync(linked)).toBe(true);
        } finally {
            await engine.stop();
        }
    });

    test("a worktree that's gone isn't shown when the session is reopened", async () => {
        const { main, linked } = repo("gone");
        const s = Session.create(main);
        s.push({ role: "user", content: [{ type: "text", text: "hi" }] });
        s.setWorkdir(linked);
        git(main, "worktree", "remove", "--force", linked);
        const engine = new Engine();
        try {
            const c = { subs: new Set<string>(), send() {} };
            engine.clients.add(c as never);
            const reopened = (await engine.handle(c as never, "session.open", { id: s.meta.id })) as SessionSnapshot;
            expect(reopened.state.workingIn).toBeUndefined();
            expect((engine.runtimes.get(s.meta.id) as any).toolState.cwd).toBe(main);
        } finally {
            await engine.stop();
        }
    });
});

// ---------------------------------------------------------------------------
// A turn's places: only the worktrees it reached

describe("a turn's places", () => {
    test("are the worktrees it reached: one another session changes meanwhile isn't listed", async () => {
        const { main, linked } = repo("places");
        const theirs = join(main, ".claude", "worktrees", "theirs");
        git(main, "worktree", "add", "-b", "worktree-theirs", theirs);
        const { WriteTool } = await import("../src/tools/file-tools");
        const session = Session.create(main, { system: "S" });
        let n = 0;
        const agent = new Agent({
            session,
            model: { provider: "test", id: "test" } as any,
            client: {
                stream: async () => {
                    n++;
                    if (n === 1) {
                        // Another session at work in the other worktree while this turn runs.
                        writeFileSync(join(theirs, "theirs.txt"), "not this session's\n");
                        return toolCall("w1", "Write", { file_path: join(linked, "ours.txt"), content: "this turn's\n" });
                    }
                    return text("done");
                },
                listModels: async () => [],
            } as any,
            settings: () => ({ autoCompact: false, delegation: false }) as any,
            checker: new PermissionChecker(() => ({}) as any, main),
            tools: [WriteTool],
            mode: { get: () => "bypassPermissions" as any, set() {} },
            toolState: { cwd: main, projectRoot: main, fileState: new Map(), todos: [], shells: new Map() } as any,
            trusted: () => true,
            host: { emit() {}, ui: {} } as any,
        });
        try {
            await agent.run([{ type: "text", text: "add a file in ui-fixes" }], { signal: new AbortController().signal });
            const turn = agent.turnSnapshots!.list().at(-1)!;
            const info = await agent.turnSnapshots!.changes({ scope: "turn", turnId: turn.id });
            expect(info.places?.map((p) => p.branch)).toEqual(["worktree-ui-fixes"]);
        } finally {
            session.release();
        }
    });

    test("a command's relative paths count from where the agent works: git -C into a worktree reaches it", async () => {
        const { main } = repo("relative");
        const session = Session.create(main, { system: "S" });
        let n = 0;
        const commit = "git -C .claude/worktrees/ui-fixes -c user.name=t -c user.email=t@example.invalid -c core.hooksPath=/dev/null -c commit.gpgsign=false commit -q --allow-empty -m relative";
        const agent = new Agent({
            session,
            model: { provider: "test", id: "test" } as any,
            client: { stream: async () => (++n === 1 ? toolCall("b1", "Bash", { command: commit }) : text("done")), listModels: async () => [] } as any,
            settings: () => ({ autoCompact: false, delegation: false }) as any,
            checker: new PermissionChecker(() => ({}) as any, main),
            tools: [BashTool],
            mode: { get: () => "bypassPermissions" as any, set() {} },
            toolState: { cwd: main, projectRoot: main, fileState: new Map(), todos: [], shells: new Map() } as any,
            trusted: () => true,
            host: { emit() {}, ui: {} } as any,
        });
        try {
            await agent.run([{ type: "text", text: "commit in ui-fixes" }], { signal: new AbortController().signal });
            const turn = agent.turnSnapshots!.list().at(-1)!;
            expect((await agent.turnSnapshots!.changes({ scope: "turn", turnId: turn.id })).places?.map((p) => p.branch)).toEqual(["worktree-ui-fixes"]);
        } finally {
            session.release();
        }
    });

    test("a command that writes a worktree's file by its path (as Codex does from the session's folder) reaches it", async () => {
        const { main, linked } = repo("redirect");
        const session = Session.create(main, { system: "S" });
        let n = 0;
        const agent = new Agent({
            session,
            model: { provider: "test", id: "test" } as any,
            client: { stream: async () => (++n === 1 ? toolCall("b1", "Bash", { command: `printf 'x\\n' >${join(linked, "codex.txt")}` }) : text("done")), listModels: async () => [] } as any,
            settings: () => ({ autoCompact: false, delegation: false }) as any,
            checker: new PermissionChecker(() => ({}) as any, main),
            tools: [BashTool],
            mode: { get: () => "bypassPermissions" as any, set() {} },
            toolState: { cwd: main, projectRoot: main, fileState: new Map(), todos: [], shells: new Map() } as any,
            trusted: () => true,
            host: { emit() {}, ui: {} } as any,
        });
        try {
            await agent.run([{ type: "text", text: "write in ui-fixes" }], { signal: new AbortController().signal });
            const turn = agent.turnSnapshots!.list().at(-1)!;
            expect((await agent.turnSnapshots!.changes({ scope: "turn", turnId: turn.id })).places?.map((p) => p.branch)).toEqual(["worktree-ui-fixes"]);
        } finally {
            session.release();
        }
    });

    test("an agent CLI's own tool that names its file its own way (OpenCode's filepath, relative here) reaches it", async () => {
        const { main } = repo("own-tool");
        const session = Session.create(main, { system: "S" });
        const own = { name: "write", category: "edit", readOnly: false, description: "d", parameters: { type: "object", properties: {} }, title: () => "write", run: async (i: any) => (writeFileSync(join(main, i.filepath), "x\n"), { content: "ok" }) } as any;
        let n = 0;
        const agent = new Agent({
            session,
            model: { provider: "test", id: "test" } as any,
            client: { stream: async () => (++n === 1 ? toolCall("w1", "write", { filepath: ".claude/worktrees/ui-fixes/opencode.txt" }) : text("done")), listModels: async () => [] } as any,
            settings: () => ({ autoCompact: false, delegation: false }) as any,
            checker: new PermissionChecker(() => ({}) as any, main),
            tools: [own],
            mode: { get: () => "bypassPermissions" as any, set() {} },
            toolState: { cwd: main, projectRoot: main, fileState: new Map(), todos: [], shells: new Map() } as any,
            trusted: () => true,
            host: { emit() {}, ui: {} } as any,
        });
        try {
            await agent.run([{ type: "text", text: "write in ui-fixes" }], { signal: new AbortController().signal });
            const turn = agent.turnSnapshots!.list().at(-1)!;
            expect((await agent.turnSnapshots!.changes({ scope: "turn", turnId: turn.id })).places?.map((p) => p.branch)).toEqual(["worktree-ui-fixes"]);
        } finally {
            session.release();
        }
    });

    test("a turn that only read in a worktree another session changes meanwhile doesn't get its card", async () => {
        const { main, linked } = repo("read-only");
        const { ReadTool } = await import("../src/tools/file-tools");
        const session = Session.create(main, { system: "S" });
        let n = 0;
        const agent = new Agent({
            session,
            model: { provider: "test", id: "test" } as any,
            client: {
                stream: async () => {
                    if (++n > 2) return text("done");
                    // Another session at work there while this one reads it.
                    writeFileSync(join(linked, `theirs-${n}.txt`), "not this session's\n");
                    return n === 1 ? toolCall("r1", "Read", { file_path: join(linked, "readme.txt") }) : toolCall("b1", "Bash", { command: `git -C ${linked} log --oneline -1` });
                },
                listModels: async () => [],
            } as any,
            settings: () => ({ autoCompact: false, delegation: false }) as any,
            checker: new PermissionChecker(() => ({}) as any, main),
            tools: [ReadTool, BashTool],
            mode: { get: () => "bypassPermissions" as any, set() {} },
            toolState: { cwd: main, projectRoot: main, fileState: new Map(), todos: [], shells: new Map() } as any,
            trusted: () => true,
            host: { emit() {}, ui: {} } as any,
        });
        try {
            await agent.run([{ type: "text", text: "look at ui-fixes" }], { signal: new AbortController().signal });
            const turn = agent.turnSnapshots!.list().at(-1)!;
            expect((await agent.turnSnapshots!.changes({ scope: "turn", turnId: turn.id })).places).toBeUndefined();
        } finally {
            session.release();
        }
    });
});
