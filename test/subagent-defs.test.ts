// Sub-agent definitions (src/agent/agents.ts): the frontmatter fields from
// Claude Code's sub-agents (permissionMode, effort, maxTurns, isolation,
// skills, hooks, mcpServers, background, memory, disallowedTools), how each
// is read, and what each does when the agent runs. Scripted models stand in
// for real ones; a fixture is the MCP server; git runs for worktrees.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const { home, cleanup } = isolate();
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const trust = await import("../src/config/trust");
const { parseAgentFile, loadAgents, agentMemoryDir, readAgentMemory, MEMORY_LINES } = await import("../src/agent/agents");
const { childMode, withAgentHooks, createAgentWorktree, finishAgentWorktree, worktreeNote } = await import("../src/agent/subagent-setup");
const { stopServer } = await import("../src/mcp/server");

type AgentEvent = import("../src/agent/agent").AgentEvent;
type ChatRequest = import("../src/providers/types").ChatRequest;
type PermissionRequest = import("../src/agent/agent").PermissionRequest;
type PermissionMode = import("../src/permissions/modes").PermissionMode;

afterAll(() => {
    stopServer();
    cleanup();
});

// ---------------------------------------------------------------------------
// Reading definitions

const file = (front: string, body = "Do the thing.") => `---\n${front}\n---\n${body}\n`;

describe("parsing", () => {
    test("every field, in YAML", () => {
        const d = parseAgentFile(
            file(`name: reviewer
description: "Reviews: diffs for bugs"
tools: [Read, Grep, Bash]
disallowedTools: WebFetch, WebSearch
model: gemini:gemini-test
permissionMode: acceptEdits
effort: high
maxTurns: 12
isolation: worktree
background: true
memory: project
skills:
  - code-review
  - testing
mcpServers:
  - github
  - scratch:
      command: scratch-mcp
      args: [--fast]
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: ./check.sh
          timeout: 5
  Stop:
    - command: ./done.sh`),
            "fallback",
            "user",
        );
        expect(d).toMatchObject({
            name: "reviewer",
            description: "Reviews: diffs for bugs",
            tools: ["Read", "Grep", "Bash"],
            disallowedTools: ["WebFetch", "WebSearch"],
            model: "gemini:gemini-test",
            permissionMode: "acceptEdits",
            effort: "high",
            maxTurns: 12,
            isolation: "worktree",
            background: true,
            memory: "project",
            skills: ["code-review", "testing"],
            mcpServers: [{ name: "github" }, { name: "scratch", config: { command: "scratch-mcp", args: ["--fast"] } }],
            // Claude Code's nested form becomes ours; Stop is SubagentStop for a sub-agent.
            hooks: { PreToolUse: [{ matcher: "Bash", command: "./check.sh", timeout: 5 }], SubagentStop: [{ command: "./done.sh" }] },
            prompt: "Do the thing.",
        });
        expect(d.warnings).toBeUndefined();
    });

    test("old frontmatter that isn't valid YAML still loads, line by line", () => {
        const d = parseAgentFile(file("name: old\ndescription: Reviews: diffs, finds bugs\ntools: Read, Grep\nmodel: gemini:gemini-test"), "x", "project");
        expect(d).toMatchObject({ name: "old", description: "Reviews: diffs, finds bugs", tools: ["Read", "Grep"], model: "gemini:gemini-test" });
        expect(d.warnings).toBeUndefined();
        // Structured fields can't be read that way: it says so.
        const h = parseAgentFile(file("name: old\ndescription: a: b\nhooks:\n  PreToolUse: []"), "x", "project");
        expect(h.warnings?.[0]).toContain("isn't valid YAML");
        expect(h.hooks).toBeUndefined();
    });

    test("values that can't be used are left out, each with a warning; the agent still loads", () => {
        const d = parseAgentFile(
            file(`name: bad
permissionMode: dontAsk
effort: extreme
maxTurns: -3
isolation: container
background: maybe
memory: team
model: sonnet
hooks:
  Nope: [{ command: x }]
  PreToolUse:
    - type: agent
      prompt: x
    - matcher: Bash
mcpServers:
  - broken: { args: [x] }`),
            "bad",
            "user",
        );
        for (const k of ["permissionMode", "effort", "maxTurns", "isolation", "background", "memory", "model", "hooks", "mcpServers"]) expect((d as any)[k]).toBeUndefined();
        const w = d.warnings!.join("\n");
        for (const s of ['permissionMode "dontAsk"', 'effort "extreme"', 'maxTurns "-3"', 'isolation "container"', 'background "maybe"', 'memory "team"', 'model "sonnet"', "Nope isn't a hook event", 'type "agent" isn\'t supported', "needs a command", "mcpServers.broken"]) expect(w).toContain(s);
        expect(d.name).toBe("bad");
    });

    test("hooks take every handler type settings do, read by the same rules (review of #173)", () => {
        const d = parseAgentFile(
            file(`name: h
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: http
          url: https://example.com/hook
        - type: prompt
          prompt: Refuse rm.
        - type: mcp_tool
          server: notes
          tool: log
        - type: command
          command: ./guard.sh
          args: [--strict]
          if: Bash(rm *)
          async: true
  Stop:
    - type: prompt
      prompt: Is it done?`),
            "h",
            "user",
        );
        expect(d.warnings).toBeUndefined();
        expect(d.hooks?.PreToolUse?.map((h) => h.type ?? "command")).toEqual(["http", "prompt", "mcp_tool", "command"]);
        expect(d.hooks?.PreToolUse?.[3]).toMatchObject({ matcher: "Bash", command: "./guard.sh", args: ["--strict"], if: "Bash(rm *)", async: true });
        expect(d.hooks?.SubagentStop).toEqual([expect.objectContaining({ type: "prompt", prompt: "Is it done?" })]);
    });

    test("line by line, YAML-style lists still work", () => {
        const d = parseAgentFile(file("description: a: b\ntools: [Read, Grep]\ndisallowedTools: ['Bash', \"WebFetch\"]"), "x", "user");
        expect(d.tools).toEqual(["Read", "Grep"]);
        expect(d.disallowedTools).toEqual(["Bash", "WebFetch"]);
    });

    test("an unquoted # in a value is kept, as before (YAML would take it for a comment)", () => {
        const d = parseAgentFile(file("description: Fixes issues tagged #frontend\neffort: high # the default is medium"), "x", "user");
        expect(d.description).toBe("Fixes issues tagged #frontend");
        // Where the value must be one of a few, the comment is a comment.
        expect(d.effort).toBe("high");
    });

    test("model: inherit is the session's model; maxTurns as a string", () => {
        const d = parseAgentFile(file("model: inherit\nmaxTurns: '7'"), "a", "user");
        expect(d.model).toBeUndefined();
        expect(d.maxTurns).toBe(7);
        expect(d.warnings).toBeUndefined();
    });

    test("bypassPermissions only from the user's own agents", () => {
        expect(parseAgentFile(file("permissionMode: bypassPermissions"), "a", "user").permissionMode).toBe("bypassPermissions");
        const p = parseAgentFile(file("permissionMode: bypassPermissions"), "a", "project");
        expect(p.permissionMode).toBeUndefined();
        expect(p.warnings?.[0]).toContain("only honored in your own agents");
    });

    test("a plugin's agents can't bring hooks, servers or a permission mode", () => {
        const d = parseAgentFile(file("permissionMode: acceptEdits\nhooks:\n  PreToolUse: [{ command: x }]\nmcpServers: [{ s: { command: y } }]\neffort: low"), "a", "plugin");
        expect(d.hooks).toBeUndefined();
        expect(d.mcpServers).toBeUndefined();
        expect(d.permissionMode).toBeUndefined();
        expect(d.effort).toBe("low");
        expect(d.warnings).toHaveLength(3);
    });

    test("mcpServers as a single map, and duplicate names count once", () => {
        const d = parseAgentFile(file("mcpServers:\n  a: { command: one }\n  b: { url: https://x.test/mcp }"), "x", "user");
        expect(d.mcpServers).toEqual([
            { name: "a", config: { command: "one" } },
            { name: "b", config: { url: "https://x.test/mcp" } },
        ]);
        expect(parseAgentFile(file("mcpServers: [a, a, b]"), "x", "user").mcpServers).toEqual([{ name: "a" }, { name: "b" }]);
    });

    test("loading many definitions stays fast", () => {
        const dir = join(home, "agents");
        mkdirSync(dir, { recursive: true });
        for (let i = 0; i < 200; i++) writeFileSync(join(dir, `a${i}.md`), file(`name: a${i}\ndescription: Agent ${i}\ntools: [Read, Grep]\neffort: high\nhooks:\n  PreToolUse: [{ matcher: Bash, command: ./x.sh }]`));
        const t0 = performance.now();
        const loaded = loadAgents(tempDir());
        const ms = performance.now() - t0;
        rmSync(dir, { recursive: true, force: true });
        expect(loaded.length).toBe(202);
        // About 5 ms here: a generous bound, for slow CI machines.
        expect(ms).toBeLessThan(500);
    });
});

describe("helpers", () => {
    test("the parent's bypass, auto and plan win over the agent's mode", () => {
        expect(childMode("default", "acceptEdits")).toBe("acceptEdits");
        expect(childMode("acceptEdits", "default")).toBe("default");
        expect(childMode("bypassPermissions", "default")).toBe("bypassPermissions");
        expect(childMode("auto", "acceptEdits")).toBe("auto");
        expect(childMode("plan", "bypassPermissions")).toBe("plan");
        expect(childMode("default", undefined)).toBe("default");
    });

    test("an agent's hooks come after the session's", () => {
        const s = { PreToolUse: [{ command: "a" }] };
        expect(withAgentHooks(s, { PreToolUse: [{ command: "b" }], SubagentStop: [{ command: "c" }] })).toEqual({ PreToolUse: [{ command: "a" }, { command: "b" }], SubagentStop: [{ command: "c" }] });
        expect(withAgentHooks(s, undefined)).toBe(s);
        expect(s.PreToolUse).toHaveLength(1);
    });

    test("MEMORY.md is cut at its first lines", () => {
        const dir = tempDir();
        writeFileSync(join(dir, "MEMORY.md"), Array.from({ length: MEMORY_LINES + 50 }, (_, i) => `line ${i}`).join("\n"));
        const m = readAgentMemory(dir);
        expect(m.truncated).toBe(true);
        expect(m.text.split("\n")).toHaveLength(MEMORY_LINES);
        expect(readAgentMemory(join(dir, "nope"))).toEqual({ text: "", truncated: false });
    });
});

// ---------------------------------------------------------------------------
// Running them

const MAIN = { provider: "anthropic", id: "claude-main", name: "Claude Main" };
const OTHER = { provider: "gemini", id: "gemini-test", name: "Gemini Test", effortLevels: ["low", "high"] as any };
type Reply = Record<string, unknown>;
const reply = (model: string, content: unknown[], stopReason = "end_turn"): Reply => ({ role: "assistant", provider: "x", model, stopReason, content, usage: { inputTokens: 10, outputTokens: 5 } });
const say = (text: string, model = "child") => reply(model, [{ type: "text", text }]);
const use = (id: string, name: string, input: Record<string, unknown>, model = "child") => reply(model, [{ type: "tool_call", id, name, input }], "tool_use");
const textOfReq = (req: ChatRequest) => JSON.stringify(req.messages);

let cwd: string;
let mainSteps: ((req: ChatRequest) => Reply | Promise<Reply>)[];
let childScript: (req: ChatRequest, n: number, signal?: AbortSignal) => Reply | Promise<Reply>;
let mainRequests: ChatRequest[];
/** What each main request held when it was sent (its messages array is the session's, which grows). */
let mainSent: string[];
let childRequests: ChatRequest[];
const agents: InstanceType<typeof Agent>[] = [];

beforeEach(() => {
    cwd = realpathSync(tempDir("subdefs-"));
    mainRequests = [];
    mainSent = [];
    childRequests = [];
    mainSteps = [];
    childScript = () => say("child done");
});
afterEach(async () => {
    await Promise.all(agents.splice(0).map((a) => a.dispose(1000)));
});

/** The main model asks for these tool calls in turn, then says "ok". */
function mainCalls(...calls: [string, string, Record<string, unknown>][]) {
    mainSteps = [...calls.map(([id, name, input]) => () => use(id, name, input, "main")), () => say("ok", "main")];
}

function defineAgent(name: string, front: string, body = "You are a test agent.", where: "project" | "user" = "project") {
    const dir = where === "project" ? join(cwd, ".harness", "agents") : join(home, "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), file(`name: ${name}\ndescription: test\n${front}`, body));
}

async function makeAgent(o: { mode?: PermissionMode; settings?: any; headless?: boolean; ask?: (r: PermissionRequest) => boolean } = {}) {
    const settings = o.settings ?? {};
    const events: AgentEvent[] = [];
    const asked: PermissionRequest[] = [];
    let mode: PermissionMode = o.mode ?? "default";
    trust.trustForSession(cwd);
    const mainClient = {
        stream: async (req: ChatRequest) => {
            mainRequests.push(req);
            mainSent.push(textOfReq(req));
            const step = mainSteps[mainRequests.length - 1] ?? (() => say("ok", "main"));
            return step(req);
        },
        listModels: async () => [],
    };
    const childClient = {
        stream: async (req: ChatRequest) => {
            childRequests.push(req);
            return childScript(req, childRequests.length, req.signal);
        },
        listModels: async () => [],
    };
    const session = Session.create(cwd, { persist: false });
    const agent = new Agent({
        session,
        model: MAIN as any,
        client: mainClient as any,
        settings: () => settings,
        checker: new PermissionChecker(() => settings, cwd),
        tools: BUILTIN_TOOLS,
        mode: { get: () => mode, set: (m) => (mode = m) },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
        // Sub-agents on gemini:gemini-test get the scripted child; so does the main model's own ref, for a child on it.
        helpers: { resolveModel: async (ref: string) => (ref === "gemini:gemini-test" ? { model: OTHER as any, client: childClient as any } : undefined) },
        listings: () => [],
        host: {
            emit: (e) => events.push(e),
            ui: {},
            askPermission: o.headless
                ? undefined
                : async (req) => {
                      asked.push(req);
                      return { allow: o.ask ? o.ask(req) : true };
                  },
        },
    });
    agents.push(agent);
    const run = (text: string, signal = new AbortController().signal) => agent.run([{ type: "text", text }], { signal });
    const result = (id: string) => events.flatMap((e) => (e.type === "tool_end" && e.call.id === id ? [e.result] : []))[0];
    const subNotices = () => events.flatMap((e: any) => (e.type === "subagent" && e.event.type === "notice" ? [e.event.message as string] : []));
    return { agent, run, events, asked, result, subNotices, setMode: (m: PermissionMode) => (mode = m) };
}

const task = (agentType: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ description: "Test task", prompt: "Do it", subagent_type: agentType, model: "gemini:gemini-test", ...extra });

describe("running", () => {
    test("maxTurns replaces the 200-turn limit", async () => {
        defineAgent("looper", "maxTurns: 3");
        let k = 0;
        childScript = () => use(`g${++k}`, "Glob", { pattern: "*.nothing" });
        mainCalls(["t1", "Task", task("looper")]);
        const { run, result } = await makeAgent();
        expect(await run("go")).toBe("done");
        expect(childRequests).toHaveLength(3);
        expect(result("t1")!.content).toContain("limit of 3 model turns");
    });

    test("effort: the agent's where the model has it, else the model's default", async () => {
        defineAgent("thinker", "effort: high");
        defineAgent("odd", "effort: max");
        mainCalls(["t1", "Task", task("thinker")], ["t2", "Task", task("odd")]);
        const { run } = await makeAgent({ settings: { effort: "low" } });
        await run("go");
        expect(childRequests[0]!.effort).toBe("high");
        // gemini-test has low and high only: for max it falls back to the session's.
        expect(childRequests[1]!.effort).toBe("low");
    });

    test("tools and disallowedTools", async () => {
        defineAgent("narrow", "tools: [Read, Grep, Glob, Bash]\ndisallowedTools: [Bash]");
        mainCalls(["t1", "Task", task("narrow")]);
        const { run } = await makeAgent();
        await run("go");
        expect(childRequests[0]!.tools.map((t) => t.name).sort()).toEqual(["Glob", "Grep", "Read"]);
    });

    test("permissionMode: the agent's own, but never out of plan mode", async () => {
        defineAgent("editor", "permissionMode: acceptEdits");
        childScript = (_r, n) => (n % 2 === 1 ? use(`w${n}`, "Write", { file_path: join(cwd, `out${n}.txt`), content: "hi" }) : say("wrote"));
        mainCalls(["t1", "Task", task("editor")]);
        const a = await makeAgent();
        await a.run("go");
        // In default mode a Write asks; the agent's acceptEdits writes in the workspace without asking.
        expect(a.asked).toHaveLength(0);
        expect(existsSync(join(cwd, "out1.txt"))).toBe(true);

        // The session plans: Task itself is refused for anything but explore, and the mode is plan for it anyway.
        mainCalls(["t2", "Task", task("editor")]);
        mainRequests = [];
        const b = await makeAgent({ mode: "plan" });
        await b.run("plan it");
        expect(b.result("t2")!.isError).toBe(true);
        expect(existsSync(join(cwd, "out3.txt"))).toBe(false);
    });

    test("skills are preloaded into its prompt; a missing one is noted", async () => {
        mkdirSync(join(home, "skills", "testing"), { recursive: true });
        writeFileSync(join(home, "skills", "testing", "SKILL.md"), "---\nname: testing\ndescription: x\n---\nAlways run bun test with a path.");
        defineAgent("skilled", "skills: [testing, nowhere]");
        mainCalls(["t1", "Task", task("skilled")]);
        const { run, subNotices } = await makeAgent();
        await run("go");
        expect(childRequests[0]!.system).toContain("# Skill: testing");
        expect(childRequests[0]!.system).toContain("Always run bun test with a path.");
        expect(childRequests[0]!.system).not.toContain("name: testing");
        expect(subNotices()).toContain('Skill "nowhere" wasn\'t found, so it wasn\'t loaded.');
    });

    test("its hooks run for it alone; Stop becomes SubagentStop", async () => {
        const log = join(cwd, "hooks.log");
        defineAgent("hooked", `hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: "echo blocked by agent hook >&2; exit 2"\n  Stop:\n    - command: "echo stop >> ${log}"`);
        childScript = (_r, n) => (n === 1 ? use("b1", "Bash", { command: "echo hi" }) : say("done"));
        mainCalls(["t1", "Task", task("hooked")], ["t2", "Bash", { command: "echo parent" }]);
        const { run, result } = await makeAgent({ mode: "bypassPermissions" });
        await run("go");
        expect(textOfReq(childRequests[1]!)).toContain("blocked by agent hook");
        expect(readFileSync(log, "utf-8").trim()).toBe("stop");
        // The parent's Bash isn't blocked.
        expect(result("t2")!.isError).toBeFalsy();
        expect(result("t2")!.content).toContain("parent");
    });

    test("memory: MEMORY.md in its prompt, file tools added, and writes there aren't harness config", async () => {
        defineAgent("rememberer", "memory: project\ntools: Grep");
        const dir = agentMemoryDir("project", "rememberer", cwd);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "MEMORY.md"), "- The tests live in test/.");
        childScript = (_r, n) => (n === 1 ? use("e1", "Write", { file_path: join(dir, "testing.md"), content: "- Use bun." }) : say("noted"));
        mainCalls(["t1", "Task", task("rememberer")]);
        const { run, asked } = await makeAgent({ mode: "acceptEdits" });
        await run("go");
        const system = childRequests[0]!.system;
        expect(system).toContain(`You keep a memory for this project (it can be checked in and shared) in ${dir}`);
        expect(system).toContain("- The tests live in test/.");
        expect(childRequests[0]!.tools.map((t) => t.name).sort()).toEqual(["Edit", "Grep", "Read", "Write"]);
        // .harness/ is config, which always asks; its agent-memory/ isn't.
        expect(asked).toHaveLength(0);
        expect(readFileSync(join(dir, "testing.md"), "utf-8")).toContain("Use bun.");
    });

    test("local memory is kept out of git", async () => {
        defineAgent("private", "memory: local");
        mainCalls(["t1", "Task", task("private")]);
        const { run } = await makeAgent();
        await run("go");
        expect(readFileSync(join(cwd, ".harness", "agent-memory-local", ".gitignore"), "utf-8")).toBe("*\n");
        expect(childRequests[0]!.system).toContain("MEMORY.md is empty or doesn't exist yet.");
    });

    test("its own MCP server starts with it and stops after; a named server must be configured", async () => {
        const fixture = join(import.meta.dir, "fixtures", "mcp-stdio-server.ts");
        defineAgent("mcpuser", `tools: [Read]\nmcpServers:\n  - nothere\n  - fix:\n      command: ${JSON.stringify(process.execPath)}\n      args: ["--no-env-file", ${JSON.stringify(fixture)}]`, "x", "user");
        childScript = (_r, n) => (n === 1 ? use("m1", "mcp__fix__echo", { text: "hello from mcp" }) : say("done"));
        mainCalls(["t1", "Task", task("mcpuser")]);
        const { run, subNotices } = await makeAgent({ mode: "bypassPermissions" });
        await run("go");
        const names = childRequests[0]!.tools.map((t) => t.name);
        // Its server's tools come with it even though its tools list only names Read.
        expect(names).toContain("mcp__fix__echo");
        expect(names).toContain("Read");
        expect(textOfReq(childRequests[1]!)).toContain("hello from mcp");
        expect(subNotices()).toContain('MCP server "nothere" isn\'t configured in this session.');
        // The parent never had it.
        expect(mainRequests[0]!.tools.map((t) => t.name)).not.toContain("mcp__fix__echo");
    });

    test("listing some of a server's tools gives only those; a name the session uses is refused", async () => {
        const fixture = join(import.meta.dir, "fixtures", "mcp-stdio-server.ts");
        const server = `command: ${JSON.stringify(process.execPath)}\n      args: ["--no-env-file", ${JSON.stringify(fixture)}]`;
        defineAgent("picky", `tools: [Read, mcp__fix__echo]\nmcpServers:\n  - fix:\n      ${server}\n  - taken:\n      ${server}`, "x", "user");
        mainCalls(["t1", "Task", task("picky")]);
        const { run, subNotices } = await makeAgent({ settings: { mcpServers: { taken: { command: "true" } } } });
        await run("go");
        expect(childRequests[0]!.tools.map((t) => t.name).sort()).toEqual(["Read", "mcp__fix__echo"]);
        expect(subNotices().join("\n")).toContain('MCP server "taken" wasn\'t started: a server with that name is configured');
    });

    test("a project agent's own MCP server needs approval like a .mcp.json server", async () => {
        const marker = join(cwd, "started.txt");
        defineAgent("projmcp", `mcpServers:\n  - fix:\n      command: ${JSON.stringify(process.execPath)}\n      args: ["--no-env-file", ${JSON.stringify(join(import.meta.dir, "fixtures", "mcp-stdio-server.ts"))}]\n      env: { MCP_FIXTURE_MARKER: ${JSON.stringify(marker)} }`);
        mainCalls(["t1", "Task", task("projmcp")]);
        const { run, subNotices } = await makeAgent();
        await run("go");
        expect(existsSync(marker)).toBe(false);
        expect(subNotices().join("\n")).toContain("needs the approval a .mcp.json server does");
    });
});

// ---------------------------------------------------------------------------
// Worktrees

async function git(dir: string, ...args: string[]): Promise<string> {
    const p = Bun.spawn(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out.trim();
}

async function initRepo() {
    await git(cwd, "init", "-q", "-b", "main");
    writeFileSync(join(cwd, "README.md"), "hi\n");
    await git(cwd, "add", ".");
    await git(cwd, "commit", "-qm", "init");
}

describe("isolation: worktree", () => {
    test("it works in a new worktree, removed with its branch when it changed nothing", async () => {
        await initRepo();
        defineAgent("isolated", "isolation: worktree");
        let seenCwd = "";
        childScript = (req, n) => {
            if (n === 1) {
                seenCwd = /You work in a git worktree of your own, (\S+), on branch/.exec(req.system)?.[1] ?? "";
                return use("b1", "Bash", { command: "pwd" });
            }
            return say("looked around");
        };
        mainCalls(["t1", "Task", task("isolated")]);
        const { run, result } = await makeAgent({ mode: "bypassPermissions" });
        await run("go");
        expect(seenCwd).toContain(join(".claude", "worktrees", "agent-isolated-"));
        // Its shell runs there.
        expect(textOfReq(childRequests[1]!)).toContain(seenCwd);
        expect(existsSync(seenCwd)).toBe(false);
        expect(await git(cwd, "branch", "--list", "agent/*")).toBe("");
        expect(result("t1")!.content).toContain("It made no changes, so its worktree was removed.");
    });

    test.each([".", "src"])("two runs of a worktree agent send the same cached prefix: each one's worktree is named after it (#255; session in %s)", async (dir) => {
        await initRepo();
        // The project's instructions at the repository root, an ancestor of a session opened in src/.
        mkdirSync(join(cwd, "src"));
        writeFileSync(join(cwd, "AGENTS.md"), "Run the linter before committing.\n");
        writeFileSync(join(cwd, "src", "main.ts"), "\n");
        await git(cwd, "add", ".");
        await git(cwd, "commit", "-qm", "layout");
        // Trusted by the user, so the worktrees inside it read the project's files.
        trust.trustFolder(cwd);
        cwd = join(cwd, dir === "." ? "" : dir);
        defineAgent("isolated", "isolation: worktree");
        childScript = () => say("looked around");
        mainCalls(["t1", "Task", task("isolated")], ["t2", "Task", task("isolated")]);
        const { run } = await makeAgent({ mode: "bypassPermissions" });
        await run("go");
        expect(childRequests).toHaveLength(2);
        // As the Anthropic provider sends them (the scripted child stands in for a Claude model).
        const { AnthropicProvider } = await import("../src/providers/anthropic");
        const { BUILTIN_PROVIDERS } = await import("../src/providers/registry");
        const anthropic = new AnthropicProvider(BUILTIN_PROVIDERS.find((p) => p.id === "anthropic")!, "sk-ant-test") as any;
        const sent = childRequests.map((r) => anthropic.buildParams({ ...r, model: { provider: "anthropic", id: "claude-haiku-5-5" } }, false).params);
        const prefix = (p: any) => JSON.stringify({ tools: p.tools, system: p.system.slice(0, 1) });
        expect(sent[0].system[0].cache_control).toEqual({ type: "ephemeral" });
        expect(prefix(sent[1])).toBe(prefix(sent[0]));
        const where = childRequests.map((r) => /You work in a git worktree of your own, (\S+), on branch (\S+)/.exec(r.system)!);
        expect(where[0]![1]).not.toBe(where[1]![1]);
        sent.forEach((p, i) => {
            expect(p.system[0].text).toContain(`Project: ${cwd} (you work in a git worktree of it`);
            expect(p.system[0].text).not.toContain(".claude/worktrees");
            expect(p.system[0].text).not.toContain("agent/isolated-");
            // Read from the worktree, named from where the session is.
            expect(p.system[0].text).toContain(`Contents of ${dir === "." ? "AGENTS.md" : "../AGENTS.md"} (project instructions, checked into the codebase):\n\nRun the linter before committing.`);
            expect(p.system[1].text).toContain(`Working directory: ${where[i]![1]}`);
            expect(p.system[1].text).toContain(where[i]![2]);
        });
    });

    test("one that changed something is kept, and the report says where", async () => {
        await initRepo();
        defineAgent("changer", "isolation: worktree\npermissionMode: acceptEdits");
        let wt = "";
        childScript = (req, n) => {
            if (n === 1) {
                wt = /You work in a git worktree of your own, (\S+), on branch/.exec(req.system)![1]!;
                return use("w1", "Write", { file_path: join(wt, "new.txt"), content: "x" });
            }
            return say("added a file");
        };
        mainCalls(["t1", "Task", task("changer")]);
        const { run, result } = await makeAgent();
        await run("go");
        expect(existsSync(join(wt, "new.txt"))).toBe(true);
        // The main checkout didn't change.
        expect(existsSync(join(cwd, "new.txt"))).toBe(false);
        const report = result("t1")!.content;
        expect(report).toContain(`It worked in the git worktree ${wt} on branch agent/changer-`);
        expect(report).toContain("1 uncommitted change");
        await git(cwd, "worktree", "remove", "--force", wt);
    });

    test("cleanup keeps a branch with the agent's commits even when its HEAD went back to the start", async () => {
        await initRepo();
        const w = await createAgentWorktree({ cwd, projectRoot: cwd, agent: "worker" });
        writeFileSync(join(w.path, "work.txt"), "work\n");
        await git(w.path, "add", ".");
        await git(w.path, "commit", "-qm", "work");
        const tip = await git(w.path, "rev-parse", "HEAD");
        // Back to where it started, detached (to compare with the old behavior, say).
        await git(w.path, "checkout", "-q", "--detach", w.base);
        const outcome = await finishAgentWorktree(w);
        expect(outcome.removed).toBe(false);
        expect(await git(cwd, "rev-parse", `refs/heads/${w.branch}`)).toBe(tip);
        expect(worktreeNote(w, outcome)).toContain("1 commit");
        await git(cwd, "worktree", "remove", "--force", w.path);
    });

    test("cleanup deletes the branch only while it's still at its starting commit", async () => {
        await initRepo();
        const w = await createAgentWorktree({ cwd, projectRoot: cwd, agent: "worker" });
        expect((await finishAgentWorktree(w)).removed).toBe(true);
        expect(await git(cwd, "branch", "--list", w.branch)).toBe("");
    });

    test("outside a git repository the task fails with the reason", async () => {
        defineAgent("isolated", "isolation: worktree");
        mainCalls(["t1", "Task", task("isolated")]);
        const { run, result } = await makeAgent();
        await run("go");
        expect(result("t1")!.isError).toBe(true);
        expect(result("t1")!.content).toContain("Couldn't create a git worktree for the isolated agent");
        expect(childRequests).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Background

function gate() {
    let open!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    return { open, opened };
}

async function until(cond: () => boolean, ms = 5000) {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error("timed out waiting");
        await Bun.sleep(10);
    }
}

describe("background", () => {
    test("run_in_background returns at once; the result comes with the next tool results, once", async () => {
        const g = gate();
        childScript = async () => {
            await g.opened;
            return say("background report");
        };
        mainSteps = [
            () => use("t1", "Task", task("general-purpose", { run_in_background: true }), "main"),
            () => {
                g.open();
                return use("g1", "Glob", { pattern: "*.x" }, "main");
            },
            async () => use("g2", "Glob", { pattern: "*.y" }, "main"),
            () => say("ok", "main"),
        ];
        const { run, result, agent } = await makeAgent();
        // The second Glob's results are sent after the child finished (it's let go when the first is asked for).
        mainSteps[2] = async () => {
            await until(() => agent.delegatedTasks[0]?.status === "done");
            return use("g2", "Glob", { pattern: "*.y" }, "main");
        };
        expect(await run("go")).toBe("done");
        expect(result("t1")!.content).toContain('Started background task task-1 "Test task"');
        const withResult = mainSent.map((t) => t.includes("background report"));
        // Not in what the model had before it finished; in the tool results after; given once (later requests repeat history only).
        expect(withResult[1]).toBe(false);
        expect(withResult[3]).toBe(true);
        expect(mainSent[3]!.split("A sub-agent you started in the background (Task task-1) has ended").length).toBe(2);
        expect(agent.delegatedTasks[0]!.delivered).toBe(true);
    });

    test("an agent type with background: true always runs there; TaskStatus waits for it", async () => {
        defineAgent("bg", "background: true");
        const g = gate();
        childScript = async () => {
            await g.opened;
            return say("bg done");
        };
        mainSteps = [
            () => use("t1", "Task", task("bg"), "main"),
            () => {
                setTimeout(g.open, 50);
                return use("s1", "TaskStatus", { task_id: "task-1", wait_seconds: 10 }, "main");
            },
            () => say("ok", "main"),
        ];
        const { run, result } = await makeAgent();
        await run("go");
        expect(result("t1")!.content).toContain("Started background task task-1");
        expect(result("s1")!.content).toContain("finished");
        expect(result("s1")!.content).toContain("bg done");
        // Given by TaskStatus: not again with the next request.
        expect(mainSent[2]!).not.toContain("has ended. Its result");
    });

    test("one still running when the turn ends says so; its result goes with the next prompt", async () => {
        const g = gate();
        childScript = async () => {
            await g.opened;
            return say("late report");
        };
        mainCalls(["t1", "Task", task("general-purpose", { run_in_background: true })]);
        const { run, events, agent } = await makeAgent();
        await run("go");
        expect(events.some((e) => e.type === "notice" && e.message.startsWith("1 background task is still running."))).toBe(true);
        g.open();
        await until(() => agent.delegatedTasks[0]?.status === "done");
        expect(events.some((e) => e.type === "notice" && e.message.includes('Background task task-1 "Test task"') && e.message.includes("with your next message"))).toBe(true);
        mainSteps = [() => say("thanks", "main")];
        mainRequests = [];
        mainSent = [];
        await run("next");
        expect(mainSent[0]!).toContain("late report");
    });

    test("one that finishes while the model writes its last answer is announced at the turn's end", async () => {
        childScript = () => say("quick report");
        mainSteps = [
            () => use("t1", "Task", task("general-purpose", { run_in_background: true }), "main"),
            async () => {
                await until(() => agent.delegatedTasks[0]?.status === "done");
                return say("all done", "main");
            },
        ];
        const { run, events, agent } = await makeAgent();
        await run("go");
        const said = events.flatMap((e) => (e.type === "notice" ? [e.message] : []));
        expect(said.some((m) => m.startsWith('Background task task-1 "Test task"') && m.includes("finished"))).toBe(true);
        expect(said.some((m) => m.includes("still running"))).toBe(false);
    });

    test("interrupting the turn leaves it running (#228); the session ending stops it", async () => {
        childScript = (_r, _n, signal) =>
            new Promise((_res, rej) => {
                signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
            });
        const ctrl = new AbortController();
        mainSteps = [
            () => use("t1", "Task", task("general-purpose", { run_in_background: true }), "main"),
            (req) =>
                new Promise((_res, rej) => {
                    req.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
                    setTimeout(() => ctrl.abort(), 20);
                }),
        ];
        const { run, agent } = await makeAgent();
        await run("go", ctrl.signal);
        // Esc stops the answer, not background work (agentCli.liveSessions; delegation.test.ts covers it off).
        await new Promise((r) => setTimeout(r, 100));
        expect(agent.delegatedTasks[0]!.status).toBe("running");

        // The session ending stops it.
        await agent.dispose(1000);
        expect(agent.delegatedTasks[0]!.status).toBe("cancelled");
    });

    test("a one-shot run (-p) runs it in the foreground", async () => {
        childScript = () => say("fg report");
        mainCalls(["t1", "Task", task("general-purpose", { run_in_background: true })]);
        const { run, result } = await makeAgent({ headless: true });
        await run("go");
        expect(result("t1")!.content).toBe("fg report");
    });

    test("one writer at a time in the background, but worktree agents don't count", async () => {
        await initRepo();
        defineAgent("iso", "isolation: worktree\nbackground: true");
        const g = gate();
        childScript = async () => {
            await g.opened;
            return say("done");
        };
        mainCalls(["t1", "Task", task("general-purpose", { run_in_background: true })], ["t2", "Task", task("general-purpose", { run_in_background: true })], ["t3", "Task", task("iso")]);
        const { run, result, agent } = await makeAgent();
        await run("go");
        expect(result("t1")!.content).toContain("Started background task task-1");
        expect(result("t2")!.isError).toBe(true);
        expect(result("t2")!.content).toContain("only one such task runs at a time");
        expect(result("t2")!.content).toContain("TaskStatus");
        expect(result("t3")!.content).toContain("Started background task task-2");
        g.open();
        await until(() => agent.delegatedTasks.every((t) => t.status !== "running"));
    });
});

// ---------------------------------------------------------------------------
// The permission checker and memory folders

describe("checker", () => {
    test("an agent's memory folder isn't harness config for that agent alone; a link out still is", () => {
        const settings = {};
        const checker = new PermissionChecker(() => settings, cwd);
        const write = BUILTIN_TOOLS.find((t) => t.name === "Write")!;
        const mem = agentMemoryDir("project", "r", cwd);
        const decide = (p: string, memoryDir: string | null = mem) => checker.check(write, { file_path: p, content: "x" }, "acceptEdits", cwd, { memoryDir: memoryDir ?? undefined });
        mkdirSync(mem, { recursive: true });
        expect(decide(join(mem, "MEMORY.md")).behavior).toBe("allow");
        // Another agent (or the main one) is asked, as for any harness config.
        expect(decide(join(mem, "MEMORY.md"), agentMemoryDir("project", "other", cwd)).behavior).toBe("ask");
        expect(decide(join(mem, "MEMORY.md"), null).behavior).toBe("ask");
        expect(decide(join(cwd, ".harness", "settings.json")).behavior).toBe("ask");
        symlinkSync(join(cwd, ".harness", "settings.json"), join(mem, "evil.md"));
        expect(decide(join(mem, "evil.md")).behavior).toBe("ask");
        // User memory lives in the harness home: the same holds there.
        const user = agentMemoryDir("user", "r", cwd);
        expect(decide(join(user, "MEMORY.md"), user).behavior).not.toBe("deny");
        expect(decide(join(user, "MEMORY.md"), null).behavior).toBe("ask");
    });

    test("a memory folder that is itself a link (or under one) is no exemption", () => {
        const settings = {};
        const checker = new PermissionChecker(() => settings, cwd);
        const write = BUILTIN_TOOLS.find((t) => t.name === "Write")!;
        const decide = (p: string, memoryDir: string) => checker.check(write, { file_path: p, content: "x" }, "acceptEdits", cwd, { memoryDir });
        mkdirSync(join(cwd, ".harness", "agent-memory"), { recursive: true });
        // worker -> .harness: its "settings.json" is the project's settings.
        const worker = agentMemoryDir("project", "worker", cwd);
        symlinkSync(join(cwd, ".harness"), worker);
        const d = decide(join(worker, "settings.json"), worker);
        expect(d.behavior).toBe("ask");
        expect((d as any).config).toBe(true);
        // agent-memory-local -> .harness: an agent named "agents" would write agent definitions.
        symlinkSync(join(cwd, ".harness"), join(cwd, ".harness", "agent-memory-local"));
        const agents = agentMemoryDir("local", "agents", cwd);
        expect(decide(join(agents, "evil.md"), agents).behavior).toBe("ask");
    });
});
