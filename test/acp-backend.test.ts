// OpenCode (an ACP agent) through the real Agent loop and Cavvy's permission
// checks, and in the server's provider and account lists, with a fake `opencode`
// (test/fixtures/fake-acp.ts). Nothing here runs the real OpenCode.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const { cleanup } = isolate();
const registry = await import("../src/providers/registry");
const { clientFor, forgetClient } = await import("../src/providers/models");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const trust = await import("../src/config/trust");
const { canAnswerOneOff } = await import("../src/agent/goal");
const { loginCommand } = await import("../src/backends/account-login");
const { permissionFor } = await import("../src/backends/acp/connection");
const { agentCli } = await import("../src/backends/defs");
type AgentEvent = import("../src/agent/agent").AgentEvent;
type PermissionRequest = import("../src/agent/agent").PermissionRequest;
type PermissionResponse = import("../src/agent/agent").PermissionResponse;
type PermissionMode = import("../src/permissions/modes").PermissionMode;

const bin = tempDir("fake-acp-agent-");
const LOG = join(bin, "log.jsonl");
const fake = join(bin, "opencode");
writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-acp.ts")}" "$@"\n`);
chmodSync(fake, 0o755);

afterAll(() => {
    cleanup();
    rmSync(bin, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
});

const logLines = (): any[] => (existsSync(LOG) ? readFileSync(LOG, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const answers = () => logLines().flatMap((l) => (l.permissionAnswer ? [l.permissionAnswer] : []));

let cwd: string;
const agents: { dispose?(): unknown }[] = [];
beforeEach(() => {
    cwd = realpathSync(tempDir("acp-agent-proj-"));
    rmSync(LOG, { force: true });
    process.env.FAKE_LOG = LOG;
    registry.saveAgentConfig("opencode", { path: fake });
    forgetClient("opencode");
});
afterEach(async () => {
    const c = await clientFor("opencode");
    await (c as any).shutdown?.();
});

async function makeAgent(o: { mode?: PermissionMode; settings?: any; ask?: (r: PermissionRequest) => PermissionResponse | Promise<PermissionResponse>; queued?: string[] } = {}) {
    const settings = o.settings ?? {};
    const events: AgentEvent[] = [];
    const asked: PermissionRequest[] = [];
    let mode: PermissionMode = o.mode ?? "default";
    trust.trustForSession(cwd);
    const client = await clientFor("opencode");
    const session = Session.create(cwd, { persist: false });
    const agent = new Agent({
        session,
        model: { provider: "opencode", id: "opencode/big-pickle" },
        client,
        settings: () => settings,
        checker: new PermissionChecker(() => settings, cwd),
        tools: BUILTIN_TOOLS,
        mode: { get: () => mode, set: (m) => (mode = m) },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
        host: {
            drainQueued: () => o.queued?.splice(0) ?? [],
            emit: (e) => events.push(e),
            ui: {},
            askPermission: o.ask
                ? async (req) => {
                      asked.push(req);
                      return o.ask!(req);
                  }
                : undefined,
        },
    });
    const run = (text: string, signal = new AbortController().signal) => agent.run([{ type: "text", text }], { signal });
    return { agent, events, asked, session, run };
}
const notices = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "notice" ? [`${e.level}: ${e.message}`] : []));
const once = { outcome: { outcome: "selected", optionId: "once" } };
const reject = { outcome: { outcome: "selected", optionId: "reject" } };

describe("OpenCode's asks, by Cavvy's mode", () => {
    test("default: a write asks the user; their yes is allow_once, and the row waits on the call", async () => {
        const a = await makeAgent({ ask: () => ({ allow: true }) });
        expect(await a.run("[[write:a.txt]]")).toBe("done");
        expect(a.asked).toHaveLength(1);
        expect(a.asked[0]).toMatchObject({ tool: { name: "Write" }, input: { file_path: join(cwd, "a.txt") }, callId: "call_write" });
        expect(answers()).toEqual([once]);
        expect(readFileSync(join(cwd, "a.txt"), "utf-8")).toBe("x");
        // The session continues the same OpenCode session.
        expect(a.session.backends.get("opencode")?.id).toMatch(/^ses_fake1_/);
    });

    test("default: a read-only command runs unasked (it asks about every one); others ask", async () => {
        const a = await makeAgent({ ask: () => ({ allow: false }) });
        await a.run("[[run:ls]]");
        expect(a.asked).toEqual([]);
        expect(answers()).toEqual([once]);
        expect(await a.run("[[run:rm -rf build]]")).toBe("denied");
        expect(a.asked).toHaveLength(1);
        expect(answers()[1]).toEqual(reject);
    });

    test("acceptEdits approves a write in the workspace, and asks outside it", async () => {
        const a = await makeAgent({ mode: "acceptEdits", ask: () => ({ allow: false, feedback: "not there" }) });
        await a.run("[[write:in.txt]]");
        expect(a.asked).toEqual([]);
        expect(answers()).toEqual([once]);
        const outside = join(tempDir("acp-outside-"), "x.txt");
        await a.run(`[[write:${outside}]]`);
        expect(a.asked).toHaveLength(1);
        expect(answers()[1]).toEqual(reject);
    });

    test("plan mode refuses a write without asking, and sets OpenCode's own plan mode", async () => {
        const a = await makeAgent({ mode: "plan", ask: () => ({ allow: true }) });
        await a.run("[[write:p.txt]]");
        expect(a.asked).toEqual([]);
        expect(answers()).toEqual([reject]);
        expect(existsSync(join(cwd, "p.txt"))).toBe(false);
        expect(logLines().some((l) => l.received?.method === "session/set_config_option" && l.received.params.configId === "mode" && l.received.params.value === "plan")).toBe(true);
    });

    test("bypassPermissions approves without asking; a deny rule still refuses", async () => {
        const a = await makeAgent({ mode: "bypassPermissions", settings: { permissions: { deny: ["Bash(curl:*)"] } }, ask: () => ({ allow: true }) });
        await a.run("[[run:make build]]");
        await a.run("[[run:curl https://x.test]]");
        expect(a.asked).toEqual([]);
        expect(answers()).toEqual([once, reject]);
    });

    test("a deny rule refuses a write in default mode without asking; a fetch goes by WebFetch's rules", async () => {
        const a = await makeAgent({ settings: { permissions: { deny: ["Write(secret.txt)", "WebFetch(domain:evil.test)"] } }, ask: () => ({ allow: true }) });
        await a.run("[[write:secret.txt]]");
        await a.run("[[fetch:https://evil.test/x]]");
        expect(a.asked).toEqual([]);
        expect(answers()).toEqual([reject, reject]);
    });

    test("anything else asks as OpenCode's own tool; with no one to ask, it's refused", async () => {
        const a = await makeAgent({ ask: () => ({ allow: true }) });
        await a.run("[[other]]");
        expect(a.asked[0]).toMatchObject({ tool: { name: "OpenCode" } });
        const b = await makeAgent();
        await b.run("[[run:make]]");
        expect(answers()).toEqual([once, reject]);
    });

    test("a yes to a change covers that change only: not the file's delete or move, nor other content for it", () => {
        const checker = new PermissionChecker(() => ({}), cwd);
        const file = join(cwd, "a.txt");
        const ask = (toolCall: any) => {
            const r = permissionFor(agentCli("opencode")!, toolCall, undefined, cwd)!;
            const tool = BUILTIN_TOOLS.find((t) => t.name === r.toolName)!;
            return { r, decision: () => checker.check(tool, r.input, "default", cwd).behavior, approve: () => checker.approve(tool, r.input, cwd) };
        };
        const diff = (newText: string) => ({ kind: "edit", locations: [{ path: file }], content: [{ type: "diff", path: file, oldText: "old", newText }] });
        const deleted = { kind: "delete", locations: [{ path: file }] };
        const moved = { kind: "move", rawInput: { source: file, destination: join(cwd, "b.txt") } };
        // An edit that doesn't say its content: a yes to it isn't one to delete or move the file.
        const bare = ask({ kind: "edit", rawInput: { file_path: file, old_string: "a", new_string: "b" } });
        expect(bare.r).toMatchObject({ toolName: "Edit", input: { file_path: file } });
        bare.approve();
        expect(bare.decision()).toBe("allow");
        expect(ask(deleted).decision()).toBe("ask");
        expect(ask(moved).decision()).toBe("ask");
        // One that does: the same content again is remembered; other content asks again.
        const one = ask(diff("one"));
        expect(one.r).toMatchObject({ toolName: "Write", input: { file_path: file, content: "one" } });
        expect(one.decision()).toBe("ask");
        one.approve();
        expect(ask(diff("one")).decision()).toBe("allow");
        expect(ask(diff("two")).decision()).toBe("ask");
        expect(ask({ kind: "edit", rawInput: { file_path: file, content: "two" } }).decision()).toBe("ask");
        expect(ask(deleted).decision()).toBe("ask");
        // A deny rule on Edit or Write still covers each of them.
        const denied = new PermissionChecker(() => ({ permissions: { deny: ["Edit(a.txt)"] } }), cwd);
        for (const c of [diff("one"), deleted, moved, { kind: "edit", rawInput: { file_path: file, old_string: "a", new_string: "b" } }]) {
            const r = permissionFor(agentCli("opencode")!, c, undefined, cwd)!;
            expect([c.kind, denied.check(BUILTIN_TOOLS.find((t) => t.name === r.toolName)!, r.input, "acceptEdits", cwd).behavior]).toEqual([c.kind, "deny"]);
        }
    });

    test("Esc while it asks: the ask is answered cancelled and the turn ends", async () => {
        const ac = new AbortController();
        const a = await makeAgent({ ask: () => new Promise(() => {}) });
        const run = a.run("[[run:make]]", ac.signal);
        while (!a.asked.length) await Bun.sleep(5);
        ac.abort();
        expect(await run).toBe("aborted");
        while (!answers().length) await Bun.sleep(5);
        expect(answers()).toEqual([{ outcome: { outcome: "cancelled" } }]);
    });

    test("the tripwire ends the turn with an error that says why", async () => {
        const a = await makeAgent({ ask: () => ({ allow: true }) });
        expect(await a.run("[[noask:x.txt]]")).toBe("error");
        expect(notices(a.events).join("\n")).toMatch(/OpenCode ran `Write\(.*x\.txt\)` without asking Cavvy, so the turn was stopped/);
    });

    test("a steer during a streamed answer: what it said before is saved before the steer, the rest after", async () => {
        const queued: string[] = [];
        const a = await makeAgent({ queued });
        const done = a.run("[[stream]]");
        while (!a.events.some((e) => e.type === "text")) await Bun.sleep(5);
        queued.push("banana");
        a.agent.queueChanged();
        expect(await done).toBe("done");
        const said = a.session.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => [m.role, (m.content as any[]).find((c) => c.type === "text")?.text]);
        expect(said).toEqual([
            ["user", "[[stream]]"],
            ["assistant", "Before the steer."],
            ["user", "banana"],
            ["assistant", " After: banana"],
        ]);
    });

    test("compaction says it isn't supported, and never runs on its own", async () => {
        const a = await makeAgent();
        await a.run("hi");
        await expect(a.agent.compact({ auto: false, signal: new AbortController().signal })).rejects.toThrow(/\/compact isn't supported for OpenCode/);
        expect(a.agent.idleCompactPlan()).toBeNull();
        expect(a.events.some((e) => e.type === "compact_start")).toBe(false);
    });

    test("one-offs go elsewhere; its sign-in runs its own command", () => {
        expect(canAnswerOneOff(undefined, "opencode")).toBe(false);
        expect(canAnswerOneOff("anthropic:x", "opencode")).toBe(true);
        expect(loginCommand("opencode").argv).toEqual([fake, "auth", "login"]);
        expect(() => loginCommand("opencode", "work")).toThrow(/Invalid account provider/);
    });
});

describe("Cavvy's EnterWorktree, which OpenCode has none of", () => {
    test("goes to OpenCode on Cavvy's MCP server; the user is asked once, as it runs; OpenCode's next turn runs in the worktree", async () => {
        const g = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd });
        g("init", "-q", "-b", "main");
        writeFileSync(join(cwd, "readme.txt"), "hi\n");
        g("add", "-A");
        g("commit", "-q", "-m", "init");
        const a = await makeAgent({ ask: () => ({ allow: true }) });
        expect(await a.run('[[mcp:enter_worktree {"name":"oc-wt"}]]')).toBe("done");
        const wt = join(cwd, ".claude", "worktrees", "oc-wt");
        expect(logLines().find((l) => l.mcp)?.mcp).toEqual([{ type: "http", name: "cavvy", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/) }]);
        // OpenCode's own ask is answered yes; the user is asked once, by Cavvy, as the tool runs.
        expect(answers()).toEqual([once]);
        expect(a.asked.map((r) => r.tool.name)).toEqual(["EnterWorktree"]);
        expect(a.events.filter((e) => e.type === "cwd")).toEqual([{ type: "cwd", cwd: wt }]);
        expect(a.events.find((e) => e.type === "tool_start")).toMatchObject({ call: { name: "EnterWorktree", input: { name: "oc-wt" } }, title: "EnterWorktree(oc-wt)" });
        expect(logLines().find((l) => l.mcpResult)?.mcpResult.text).toContain(`Your shell still starts in ${cwd} until this turn ends`);
        // Its next turn: its process in the worktree, its session resumed there.
        expect(await a.run("hello")).toBe("done");
        expect(logLines().filter((l) => l.argv).map((l) => realpathSync(l.cwd))).toEqual([cwd, wt]);
        expect(logLines().some((l) => l.received?.method === "session/resume" && l.received.params.cwd === wt)).toBe(true);
    });

    test("what it asks about after the move, that turn, is checked where its shell still runs: the folder the turn started in", async () => {
        const g = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd });
        g("init", "-q", "-b", "main");
        writeFileSync(join(cwd, "readme.txt"), "hi\n");
        g("add", "-A");
        g("commit", "-q", "-m", "init");
        // Untracked, so not in the worktree: from the main checkout, `creds/` is Cavvy's own folder.
        symlinkSync(process.env.CAVVY_HOME!, join(cwd, "creds"));
        process.env.FAKE_ACP_AFTER_MCP = "cat creds/settings.json";
        try {
            const a = await makeAgent({ ask: () => ({ allow: true }) });
            expect(await a.run('[[mcp:enter_worktree {"name":"oc-wt"}]]')).toBe("done");
            expect(a.events.filter((e) => e.type === "cwd")).toEqual([{ type: "cwd", cwd: join(cwd, ".claude", "worktrees", "oc-wt") }]);
            // Read in the worktree, it would be a plain read-only command; where it runs, it reads Cavvy's files: asked.
            expect(a.asked.map((r) => [r.tool.name, r.input.command])).toEqual([["EnterWorktree", undefined], ["Bash", "cat creds/settings.json"]]);
        } finally {
            delete process.env.FAKE_ACP_AFTER_MCP;
        }
    });

    test("a rule naming it as served (mcp__cavvy__*) holds even in bypass: OpenCode approves Cavvy's tools, so Cavvy enforces it", async () => {
        const a = await makeAgent({ mode: "bypassPermissions", settings: { permissions: { deny: ["mcp__cavvy__*"] } } });
        await a.run('[[mcp:enter_worktree {"name":"oc-wt"}]]');
        expect(logLines().find((l) => l.mcpResult)?.mcpResult).toMatchObject({ isError: true, text: expect.stringContaining("mcp__cavvy__*") });
        expect(a.events.some((e) => e.type === "cwd")).toBe(false);
        expect(existsSync(join(cwd, ".claude", "worktrees", "oc-wt"))).toBe(false);
    });

    test("a command or a file named like the tool is checked as what it is", async () => {
        const a = await makeAgent({ ask: () => ({ allow: false }) });
        await a.run("[[run:cavvy_exit_worktree]]");
        expect(a.asked.map((r) => [r.tool.name, r.input.command])).toEqual([["Bash", "cavvy_exit_worktree"]]);
        expect(answers()).toEqual([reject]);
    });
});

describe("the server's lists", () => {
    test("providers.list, accounts.list and the plan checks don't throw with OpenCode on", async () => {
        const { Engine } = await import("../src/server/engine");
        const engine = new Engine({ startCwd: cwd, listModels: async () => [] });
        const client = { subs: new Set<string>(), send() {} };
        try {
            const providers: any[] = await engine.handle(client, "providers.list", {});
            const oc = providers.find((p) => p.id === "opencode");
            expect(oc).toMatchObject({ kind: "agent", configured: true, agentCli: { installed: true, signIn: "opencode auth login", plan: "OpenCode", multiAccount: false, planLimits: false, defaultAccount: "default" } });
            expect(providers.find((p) => p.id === "codex").agentCli).toMatchObject({ multiAccount: true, planLimits: true });
            const accounts = await engine.handle(client, "accounts.list", { provider: "opencode", refresh: true });
            expect(accounts).toEqual([expect.objectContaining({ id: "default", name: "Default", signedIn: true, description: expect.stringContaining("OpenCode 0.0.0-fake") })]);
            await (engine as any).checkPlans();
            await expect(engine.handle(client, "accounts.add", { provider: "opencode", id: "x", name: "X" })).rejects.toThrow(/Invalid account provider/);
        } finally {
            await engine.stop();
        }
    });
});
