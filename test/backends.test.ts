// Agent backends (Claude Code, Codex) through the real Agent loop, with fake
// `claude` and `codex` programs that speak the same protocols (test/fixtures).
// Nothing here runs the real CLIs or touches the network.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { isolate, tempDir, FAKE } from "./helpers/isolate";
import { secretsSnapshot } from "./helpers/secrets";

const { cleanup } = isolate();
const restoreSecrets = await secretsSnapshot();
const registry = await import("../src/providers/registry");
const { clientFor, forgetClient, listAllModels } = await import("../src/providers/models");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const { isAgentBackend } = await import("../src/backends/types");
const { checkAgentCli } = await import("../src/backends/index");
const { applyHunks, codexPolicy, changePreview, insideWorkspace } = await import("../src/backends/codex");
const trust = await import("../src/config/trust");
const { mcpFingerprint, saveApproval } = await import("../src/mcp/approval");
const { loadSettings } = await import("../src/config/settings");
const { claudeRule, claudePermissions } = await import("../src/backends/claude-code");
const { untrustedArgs, requestedPaths, elicitationForm } = await import("../src/backends/codex");
const { deniedWithin } = await import("../src/permissions/rules");
const { stopTiming } = await import("../src/backends/cli");
const { backendActionsNote } = await import("../src/agent/agent");
const { withoutActionsNote } = await import("../src/server/history");
const { backgroundTiming } = await import("../src/backends/claude-code");
const { forkSession, forkCut } = await import("../src/agent/fork");
const { framedText, pdfPlaceholder } = await import("../src/providers/files");

type AgentEvent = import("../src/agent/agent").AgentEvent;
type PermissionRequest = import("../src/agent/agent").PermissionRequest;
type PermissionResponse = import("../src/agent/agent").PermissionResponse;
type PermissionMode = import("../src/permissions/modes").PermissionMode;
type ModelInfo = import("../src/providers/types").ModelInfo;

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
    cleanup();
    rmSync(bin, { recursive: true, force: true });
    // The fakes' settings would reach other test files' fake CLIs (FAKE_LOG points into the folder just removed).
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
});

let cwd: string;
beforeEach(() => {
    // Reached through a symlink, as macOS's temp folder is (/var -> /private/var): the CLIs see the real path.
    const real = tempDir("backend-proj-");
    cwd = `${real}-link`;
    symlinkSync(real, cwd);
    rmSync(LOG, { force: true });
    rmSync(LOG + ".tiers.json", { force: true });
    rmSync(LOG + ".usage.json", { force: true });
    process.env.FAKE_LOG = LOG;
    for (const k of ["FAKE_STOP_TASK", "FAKE_CLAUDE_VERSION", "FAKE_CONFIG_LAYERS", "FAKE_PROJECT_MCP", "FAKE_USER_MCP", "FAKE_NO_CONFIG_LAYERS", "FAKE_NO_CONFIG_READ", "FAKE_REJECT_CONFIG", "FAKE_RESUME_AGENT", "FAKE_UNANNOUNCED", "FAKE_ELICIT_OTHER_CALL", "FAKE_FINAL_TEXT", "FAKE_SUBAGENT_V2", "FAKE_PHASES", "FAKE_ELICIT", "FAKE_ELICIT_FIELDS", "FAKE_CHILD_EARLY", "FAKE_FAST_MODE_END", "FAKE_THREAD_TIER", "FAKE_CONFIG_TIER", "FAKE_SCENARIO", "FAKE_LOGGED_IN", "FAKE_API_KEY_SOURCE", "FAKE_ACCOUNT", "FAKE_DECLINE", "FAKE_REVIEW_DENY", "FAKE_REVIEW_NO_COMPLETED", "FAKE_REVIEW_MIXED", "FAKE_COMMAND", "FAKE_COMMAND_SCRIPT", "FAKE_COMMAND_RAW", "FAKE_COMMAND_CWD", "FAKE_IGNORE_STOP", "FAKE_CRASH_ON_SECOND", "FAKE_HANG_INIT", "FAKE_CODEX_TRUSTS", "FAKE_PERMS", "FAKE_SLOW_RESUME", "FAKE_SLOW_TURN_START", "FAKE_STEER_FAIL", "FAKE_STEER_WAKES", "FAKE_BACKGROUND_MS", "FAKE_STALE_TASK", "FAKE_OLD_RESULTS", "FAKE_SECOND_SCENARIO", "FAKE_LIST_FIRST", "FAKE_HOLD_STDOUT", "FAKE_LATE_TASK", "FAKE_AGENT_TYPE"]) delete process.env[k];
    registry.saveAgentConfig("claude-code", { path: claudeBin });
    registry.saveAgentConfig("codex", { path: codexBin });
    forgetClient("claude-code");
    forgetClient("codex");
});

function logLines(): any[] {
    return existsSync(LOG) ? readFileSync(LOG, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}
const starts = () => logLines().filter((l) => l.argv);
const received = () => logLines().flatMap((l) => (l.received ? [l.received] : []));

interface Opts {
    provider: "claude-code" | "codex";
    model?: Partial<ModelInfo>;
    mode?: PermissionMode;
    settings?: any;
    approvedMcpServers?: () => import("../src/mcp/manager").ApprovedMcpServers;
    readOnly?: boolean;
    ask?: (req: PermissionRequest) => PermissionResponse | Promise<PermissionResponse>;
    ui?: any;
    /** The user trusts the folder (otherwise it's only trusted implicitly, as a folder with nothing to protect is). */
    trusted?: boolean;
    session?: InstanceType<typeof Session>;
    queued?: string[][];
    /** In place of queued: the messages waiting when the turn ends. */
    drainQueued?: () => string[];
}

async function makeAgent(o: Opts) {
    const settings = o.settings ?? {};
    const events: AgentEvent[] = [];
    const asked: PermissionRequest[] = [];
    let mode: PermissionMode = o.mode ?? "default";
    if (o.trusted) trust.trustFolder(cwd);
    else trust.trustForSession(cwd);
    const queued = [...(o.queued ?? [])];
    const client = await clientFor(o.provider);
    const session = o.session ?? Session.create(cwd, { persist: false });
    const checker = new PermissionChecker(() => settings, cwd);
    const agent = new Agent({
        session,
        model: { provider: o.provider, id: "default", ...o.model },
        client,
        settings: () => settings,
        approvedMcpServers: o.approvedMcpServers,
        readOnly: o.readOnly,
        checker,
        tools: BUILTIN_TOOLS,
        mode: { get: () => mode, set: (m) => (mode = m) },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
        host: {
            drainQueued: o.drainQueued ?? (() => queued.shift() ?? []),
            emit: (e) => events.push(e),
            ui: o.ui ?? {},
            askPermission: o.ask
                ? async (req) => {
                      asked.push(req);
                      return o.ask!(req);
                  }
                : undefined,
        },
    });
    const run = (text: string, signal = new AbortController().signal) => agent.run([{ type: "text", text }], { signal });
    /** The user changing the mode (shift+tab): the agent hears about it. */
    const switchMode = (m: PermissionMode) => {
        const from = mode;
        mode = m;
        agent.noteModeChange(from, m);
    };
    return { agent, events, asked, session, checker, run, mode: () => mode, setMode: (m: PermissionMode) => (mode = m), switchMode };
}

const notices = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "notice" ? [`${e.level}: ${e.message}`] : []));
const toolEnds = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "tool_end" ? [e] : []));
const userTexts = () => received().flatMap((m) => (m.type === "user" ? m.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text as string) : []));
const permissionReplies = () => received().filter((m) => m.type === "control_response").map((m) => m.response.response);

describe("agent providers", () => {
    test("are off until turned on, and can't answer one-off requests", async () => {
        registry.removeAgentConfig("claude-code");
        forgetClient("claude-code");
        await expect(clientFor("claude-code")).rejects.toThrow(/isn't turned on. Run \/login claude-code/);
        registry.saveAgentConfig("claude-code", { path: claudeBin });
        const c = await clientFor("claude-code");
        expect(isAgentBackend(c)).toBe(true);
        await expect(c.stream({} as any, () => {})).rejects.toThrow(/can't answer one-off requests/);
    });

    test("a missing CLI says how to install and sign in", async () => {
        registry.saveAgentConfig("codex", { path: join(bin, "nope") });
        const st = await checkAgentCli("codex");
        expect(st.installed).toBe(false);
        const { run, events } = await makeAgent({ provider: "codex" });
        expect(await run("hi")).toBe("error");
        expect(notices(events).join("\n")).toMatch(/Codex isn't at .*nope/);
    });

    test("the sign-in check asks the CLI itself", async () => {
        const st = await checkAgentCli("claude-code");
        expect(st).toMatchObject({ installed: true, signedIn: true, path: claudeBin, signIn: "claude auth login" });
        expect(st.description).toContain("max");
        process.env.FAKE_LOGGED_IN = "0";
        expect((await checkAgentCli("claude-code")).signedIn).toBe(false);
        expect(await checkAgentCli("codex")).toMatchObject({ signedIn: true, description: "signed in with ChatGPT (plus plan)" });
        process.env.FAKE_ACCOUNT = "none";
        expect((await checkAgentCli("codex")).signedIn).toBe(false);
        process.env.FAKE_ACCOUNT = "apikey";
        expect((await checkAgentCli("codex")).apiKey).toBe(true);
    });

    test("model lists come from the CLIs (Claude Code: initialize, with no settings, MCP or session file)", async () => {
        const listings = await listAllModels({ refresh: true });
        const claude = listings.find((l) => l.provider.id === "claude-code")!;
        expect(claude.status).toBe("ok");
        expect(claude.models.map((m) => m.id)).toEqual(["default", "sonnet"]);
        expect(claude.models[0]!.name).toBe("Default (recommended) (claude-test-1)");
        expect(claude.models[0]!.effortLevels).toEqual(["low", "high"]);
        expect(claude.models[0]!.supportsFastMode).toBe(true);
        expect(claude.models[1]!.supportsFastMode).toBe(false);
        const args = starts().find((s) => s.argv.includes("--no-session-persistence"))!.argv;
        expect(args).toContain("--strict-mcp-config");
        expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
        const codex = listings.find((l) => l.provider.id === "codex")!;
        // Default first; hidden ones left out.
        expect(codex.models.map((m) => m.id)).toEqual(["gpt-test", "gpt-other"]);
        expect(codex.models[0]!.effortLevels).toEqual(["low", "high"]);
        expect(codex.models[0]!.fastModeTier).toBe("priority");
        expect(codex.models[1]!.supportsFastMode).toBe(false);
    });

    test("the startup trust check lists the project config of the CLIs that are on, skills and agents included", () => {
        const proj = tempDir("trust-");
        for (const d of [".claude/skills/x", ".claude/agents", ".codex"]) Bun.spawnSync(["mkdir", "-p", join(proj, d)]);
        writeFileSync(join(proj, ".claude", "settings.json"), "{}");
        expect(trust.projectConfigSummary(proj)).toEqual([".claude/settings.json", ".claude/skills/", ".claude/agents/", ".codex/"]);
        registry.removeAgentConfig("codex");
        expect(trust.projectConfigSummary(proj)).toEqual([".claude/settings.json", ".claude/skills/", ".claude/agents/"]);
    });
});

describe("Claude Code backend", () => {
    test("a turn: streamed text, a permission prompt with a preview, the edit, and the session record", async () => {
        const { run, events, asked, session, agent } = await makeAgent({ provider: "claude-code", trusted: true, ask: () => ({ allow: true }) });
        expect(await run("write the file")).toBe("done");
        expect(readFileSync(join(cwd, "out.txt"), "utf-8")).toBe("hi\n");
        expect(asked).toHaveLength(1);
        expect(asked[0]!.tool.name).toBe("Write");
        expect(asked[0]!.preview?.diff?.after).toBe("hi\n");
        expect(events.filter((e) => e.type === "text").map((e) => (e as any).text).join("")).toBe("Working on it.All done.");
        const start = events.find((e) => e.type === "tool_start") as any;
        expect(start.tool?.name).toBe("Write");
        expect(start.title).toContain("out.txt");
        const end = toolEnds(events)[0]!;
        expect(end.result.isError).toBe(false);
        expect(end.result.display?.diff?.after).toBe("hi\n");
        // The harness's history: the prompt, and the turn as text (what it said and did).
        expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
        const said = session.messages[1]!.content.map((p) => (p as any).text).join("\n");
        expect(said).toContain("Working on it.");
        expect(said).toContain("[Claude Code used: Write(");
        expect(session.backends.get("claude-code")).toEqual({ id: expect.stringMatching(/^sess-/), synced: 2 });
        // On a plan (no API key behind it): no cost; the context is from the last request.
        expect(session.cost).toBe(0);
        expect(agent.contextTokens).toBe(1015);
        const args = starts()[0]!.argv;
        expect(args).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--permission-prompt-tool=stdio", "--include-partial-messages"]));
        expect(args[args.indexOf("--permission-mode") + 1]).toBe("default");
        expect(args).not.toContain("--model");
        expect(args).not.toContain("--resume");
        expect(args).not.toContain("--setting-sources");
    });

    test("with an API key behind it, Claude Code's reported cost counts", async () => {
        process.env.FAKE_API_KEY_SOURCE = "ANTHROPIC_API_KEY";
        const { run, session } = await makeAgent({ provider: "claude-code", ask: () => ({ allow: true }) });
        await run("go");
        expect(session.cost).toBe(0.5);
    });

    test("the harness's provider keys never reach the CLI", async () => {
        process.env.ANTHROPIC_API_KEY = FAKE.anthropic;
        process.env.OPENAI_API_KEY = FAKE.openai;
        try {
            const { run } = await makeAgent({ provider: "claude-code", ask: () => ({ allow: true }) });
            await run("go");
            const c = await makeAgent({ provider: "codex", ask: () => ({ allow: true }) });
            await c.run("go");
        } finally {
            delete process.env.ANTHROPIC_API_KEY;
            delete process.env.OPENAI_API_KEY;
        }
        expect(starts().length).toBe(2);
        for (const s of starts()) expect([s.sawApiKey, s.sawOpenAiKey]).toEqual([false, false]);
    });

    test("keys are redacted both ways: in what's sent to the CLI, and in what its tools print", async () => {
        const { registerSecret } = await import("../src/util/redact");
        const key = FAKE.openrouter;
        registerSecret(key, "openrouter");
        writeFileSync(join(cwd, "secret.txt"), `KEY=${key}\n`);
        process.env.FAKE_SCENARIO = "leak";
        const { run, events } = await makeAgent({ provider: "claude-code", ask: () => ({ allow: true }) });
        await run(`use ${key} for this`);
        expect(userTexts()[0]).not.toContain(key);
        expect(userTexts()[0]).toContain("REDACTED");
        const out = toolEnds(events)[0]!.result.content;
        expect(out).not.toContain(key);
        expect(out).toContain("KEY=");
    });

    test("deny rules refuse without asking; allow rules approve without asking", async () => {
        const denied = await makeAgent({ provider: "claude-code", settings: { permissions: { deny: ["Write"] } }, ask: () => ({ allow: true }) });
        await denied.run("go");
        expect(denied.asked).toHaveLength(0);
        expect(existsSync(join(cwd, "out.txt"))).toBe(false);
        // Passed to Claude Code, which refuses it itself.
        expect(toolEnds(denied.events)[0]!.result.content).toMatch(/denied by your permission settings/);
        rmSync(LOG, { force: true });
        const allowed = await makeAgent({ provider: "claude-code", settings: { permissions: { allow: ["Write"] } }, ask: () => ({ allow: true }) });
        await allowed.run("go");
        expect(allowed.asked).toHaveLength(0);
        expect(existsSync(join(cwd, "out.txt"))).toBe(true);
    });

    test("declining stops the turn; declining with feedback passes it on", async () => {
        const a = await makeAgent({ provider: "claude-code", ask: () => ({ allow: false }) });
        expect(await a.run("go")).toBe("denied");
        expect(permissionReplies()[0]).toMatchObject({ behavior: "deny", interrupt: true });
        rmSync(LOG, { force: true });
        const b = await makeAgent({ provider: "claude-code", ask: () => ({ allow: false, feedback: "use foo.txt instead" }) });
        expect(await b.run("go")).toBe("done");
        const r = permissionReplies()[0];
        expect(r.behavior).toBe("deny");
        expect(r.message).toContain("use foo.txt instead");
        expect(r.interrupt).toBe(false);
    });

    test("without a prompt (headless) it's refused, saying how to allow it", async () => {
        const { run, events } = await makeAgent({ provider: "claude-code" });
        await run("go");
        expect(toolEnds(events)[0]!.result.content).toMatch(/not granted \(non-interactive session\).*--allowedTools/);
        expect(existsSync(join(cwd, "out.txt"))).toBe(false);
    });

    test("Bash prompts offer don't-ask-again rules, which then answer for the user", async () => {
        process.env.FAKE_SCENARIO = "bash";
        const a = await makeAgent({ provider: "claude-code", ask: (req) => ({ allow: true, rules: req.decision.suggestions, scope: "session" }) });
        await a.run("test it");
        expect(a.asked[0]!.decision.suggestions).toContain("Bash(npm test:*)");
        await a.run("again");
        expect(a.asked).toHaveLength(1);
    });

    test("the next turn resumes the session; one that's gone starts over with the conversation", async () => {
        const { run, session, events } = await makeAgent({ provider: "claude-code", ask: () => ({ allow: true }) });
        await run("first");
        const id = session.backends.get("claude-code")!.id;
        await run("second");
        const second = starts()[1]!.argv;
        expect(second[second.indexOf("--resume") + 1]).toBe(id);
        rmSync(LOG, { force: true });
        session.setBackendSession("claude-code", "gone-1234", session.messages.length);
        expect(await run("third")).toBe("done");
        expect(starts().map((s) => s.argv.includes("--resume"))).toEqual([true, false]);
        expect(notices(events).join("\n")).toMatch(/No conversation found with session ID: gone-1234.*Starting a new one/);
        const prompt = userTexts().at(-1)!;
        expect(prompt).toContain("<conversation-so-far>");
        expect(prompt).toContain("User: first");
        expect(prompt.endsWith("third")).toBe(true);
    }, 20_000);

    test("what other models said reaches the backend as context", async () => {
        const session = Session.create(cwd, { persist: false });
        session.push({ role: "user", content: [{ type: "text", text: "what is 2+2?" }], meta: { kind: "prompt" } });
        session.push({ role: "assistant", content: [{ type: "text", text: "It's 4." }], provider: "anthropic", model: "claude-x" });
        const { run } = await makeAgent({ provider: "claude-code", session, ask: () => ({ allow: true }) });
        await run("and times 3?");
        const prompt = userTexts()[0]!;
        expect(prompt).toMatch(/<conversation-so-far>[\s\S]*User: what is 2\+2\?[\s\S]*Assistant: It's 4\.[\s\S]*<\/conversation-so-far>\n\nand times 3\?$/);
        // Caught up: the next turn sends just the prompt.
        await run("thanks");
        expect(userTexts().at(-1)).toBe("thanks");
    });

    test("mode, model and effort reach the CLI; an untrusted folder's Claude Code settings stay off", async () => {
        const { run } = await makeAgent({ provider: "claude-code", mode: "plan", model: { id: "sonnet", effortLevels: ["low", "high"] }, settings: { effort: "high" }, ask: () => ({ allow: true }) });
        await run("go");
        const args = starts()[0]!.argv;
        expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
        expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
        expect(args[args.indexOf("--effort") + 1]).toBe("high");
        expect(args).toEqual(expect.arrayContaining(["--setting-sources", "user", "--strict-mcp-config"]));
        rmSync(LOG, { force: true });
        // An effort the model doesn't take isn't sent.
        const b = await makeAgent({ provider: "claude-code", model: { id: "sonnet", effortLevels: ["low", "high"] }, settings: { effort: "max" }, ask: () => ({ allow: true }) });
        await b.run("go");
        expect(starts()[0]!.argv).not.toContain("--effort");
    });

    test("esc interrupts the running turn", async () => {
        process.env.FAKE_SCENARIO = "hang";
        const ac = new AbortController();
        const { run, events, session } = await makeAgent({ provider: "claude-code" });
        const done = run("go", ac.signal);
        while (!events.some((e) => e.type === "tool_start")) await Bun.sleep(10);
        ac.abort();
        expect(await done).toBe("aborted");
        expect(received().some((m) => m.type === "control_request" && m.request.subtype === "interrupt")).toBe(true);
        expect(toolEnds(events)[0]!.result.content).toBe("Interrupted by user");
        expect((session.messages.at(-1)!.content[0] as any).text).toBe("[Request interrupted by user]");
    });

    test("AskUserQuestion goes to the harness's question dialog", async () => {
        process.env.FAKE_SCENARIO = "ask";
        const seen: string[] = [];
        const { run } = await makeAgent({ provider: "claude-code", ui: { askQuestion: async (q: string) => (seen.push(q), ["Blue"]) } });
        await run("pick");
        expect(seen).toEqual(["Which color?"]);
        expect(permissionReplies()[0]).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which color?": "Blue" } } });
    });

    test("ExitPlanMode: approving the plan switches the mode, here and in Claude Code", async () => {
        process.env.FAKE_SCENARIO = "plan";
        let plan = "";
        const a = await makeAgent({ provider: "claude-code", mode: "plan", ui: { approvePlan: async (p: string) => ((plan = p), { approved: true, mode: "acceptEdits" }) } });
        await a.run("plan it");
        expect(plan).toBe("1. Do the thing");
        expect(a.mode()).toBe("acceptEdits");
        // The harness's accept-edits runs Claude Code in its default mode (the harness approves the edits).
        expect(permissionReplies()[0]).toMatchObject({ behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }] });
    });

    test("ExitPlanMode: a plan taken to another session stops Claude Code's turn, still in plan mode", async () => {
        process.env.FAKE_SCENARIO = "plan";
        const a = await makeAgent({ provider: "claude-code", mode: "plan", ui: { approvePlan: async () => ({ approved: false, feedback: "It went to a new worktree.", handoff: true }) } });
        await a.run("plan it");
        expect(a.mode()).toBe("plan");
        expect(permissionReplies()[0]).toMatchObject({ behavior: "deny", interrupt: true });
        expect(permissionReplies()[0].message).toContain("It went to a new worktree.");
    });

    test("/compact runs Claude Code's own compaction on the session", async () => {
        const { run, agent, events } = await makeAgent({ provider: "claude-code", ask: () => ({ allow: true }) });
        expect(await agent.compact({ auto: false, signal: new AbortController().signal })).toBe(false);
        await run("go");
        expect(await agent.compact({ auto: false, signal: new AbortController().signal, instructions: "keep the plan" })).toBe(true);
        expect(userTexts().at(-1)).toBe("/compact keep the plan");
        expect(events.some((e) => e.type === "compact_end")).toBe(true);
    });
});

describe("Claude Code's background work (live test findings)", () => {
    const REPORT = "src/auth registers sign-in strategies in one list.";
    const texts = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "text" ? [(e as any).text as string] : [])).join("");
    const subEnds = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "subagent" && e.event.type === "turn_end" ? [e.event.reason] : []));
    const taskEnd = (events: AgentEvent[]) => toolEnds(events).find((e) => e.call.name === "Task")!;

    test("a sub-agent in the background keeps the turn going until Claude Code has its report and has answered with it", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        const { run, events, session } = await makeAgent({ provider: "claude-code" });
        expect(await run("map the auth module")).toBe("done");
        // One run of Claude Code: the sub-agent isn't stopped with the prompt's answer.
        expect(starts()).toHaveLength(1);
        expect(subEnds(events)).toEqual(["done"]);
        // The Agent call is open while the sub-agent works: its result is the report, and it took as long as the sub-agent.
        const end = taskEnd(events);
        expect([end.result.content, end.result.isError]).toEqual([REPORT, false]);
        expect(end.durationMs).toBeGreaterThanOrEqual(250);
        // Claude Code's own turn with the report is part of this one, and the user is told what it waits for.
        expect(texts(events)).toContain("The explorer reported back");
        expect(notices(events).join("\n")).toMatch(/^info: Waiting for 1 background sub-agent \(Map auth\)/m);
        expect(session.messages.at(-1)!.content.map((p) => (p as any).text).join("\n")).toContain("The explorer reported back");
    });

    test("...and its usage is what Claude Code reports for it", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        const { run, events } = await makeAgent({ provider: "claude-code" });
        await run("map the auth module");
        const used = events.flatMap((e) => (e.type === "subagent" && e.event.type === "usage" ? [e.event.usage.inputTokens + e.event.usage.outputTokens + (e.event.usage.cacheReadTokens ?? 0)] : []));
        // Its total so far (task_progress), then what it came to (task_notification): counted once.
        expect(used.reduce((a, b) => a + b, 0)).toBe(4321);
    });

    test("a background sub-agent that never finishes is waited on only so long, and the user is told it was stopped", async () => {
        process.env.FAKE_SCENARIO = "agent-background-stuck";
        const saved = { ...backgroundTiming };
        backgroundTiming.maxWaitMs = 400;
        try {
            const { run, events } = await makeAgent({ provider: "claude-code" });
            expect(await run("map the auth module")).toBe("done");
            expect(subEnds(events)).toEqual(["aborted"]);
            expect(taskEnd(events).result.isError).toBe(true);
            expect(notices(events).join("\n")).toMatch(/^warn: Stopped waiting for 1 background sub-agent \(Map auth\)/m);
        } finally {
            Object.assign(backgroundTiming, saved);
        }
    });

    test("a sub-agent Claude Code stops listing before it says it's done is still waited for, with its report", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        // Its notification comes later than the wait for a report turn lasts, and than Claude Code is given to exit after it.
        process.env.FAKE_LIST_FIRST = "3600";
        const saved = { ...backgroundTiming };
        backgroundTiming.settleMs = 50;
        try {
            const { run, events } = await makeAgent({ provider: "claude-code" });
            expect(await run("map the auth module")).toBe("done");
            expect(subEnds(events)).toEqual(["done"]);
            expect(taskEnd(events).result.content).toBe(REPORT);
            expect(texts(events)).toContain("The explorer reported back");
        } finally {
            Object.assign(backgroundTiming, saved);
        }
    }, 20_000);

    test("background work Claude Code lists after a sub-agent reported is waited for too: the report turn still comes", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        // The other task runs longer than the wait for a report turn lasts, and than Claude Code is given to exit after it.
        process.env.FAKE_LATE_TASK = "3600";
        const saved = { ...backgroundTiming };
        backgroundTiming.settleMs = 100;
        try {
            const { run, events } = await makeAgent({ provider: "claude-code" });
            expect(await run("map the auth module")).toBe("done");
            expect(taskEnd(events).result.content).toBe(REPORT);
            expect(texts(events)).toContain("The explorer reported back");
        } finally {
            Object.assign(backgroundTiming, saved);
        }
    }, 20_000);

    test("giving up on the wait ends the run even when something Claude Code started holds its output open", async () => {
        process.env.FAKE_SCENARIO = "agent-background-stuck";
        process.env.FAKE_HOLD_STDOUT = "1";
        const saved = { ...backgroundTiming };
        backgroundTiming.maxWaitMs = 300;
        try {
            const { run } = await makeAgent({ provider: "claude-code" });
            const t = Date.now();
            expect(await run("map the auth module")).toBe("done");
            // Not the 8 s the held output lasts.
            expect(Date.now() - t).toBeLessThan(6000);
        } finally {
            Object.assign(backgroundTiming, saved);
        }
    });

    test("esc while it waits on a background sub-agent stops it", async () => {
        process.env.FAKE_SCENARIO = "agent-background-stuck";
        const ac = new AbortController();
        const { run, events } = await makeAgent({ provider: "claude-code" });
        const done = run("map the auth module", ac.signal);
        while (!notices(events).some((n) => n.includes("Waiting for"))) await Bun.sleep(10);
        const t = Date.now();
        ac.abort();
        expect(await done).toBe("aborted");
        expect(Date.now() - t).toBeLessThan(stopTiming.interruptMs);
        expect(subEnds(events)).toEqual(["aborted"]);
    });

    test("esc waits for a queued start snapshot before ending a background turn", async () => {
        process.env.FAKE_SCENARIO = "agent-background-stuck";
        const ac = new AbortController();
        const session = Session.create(cwd, { system: "test" });
        let waiting = false;
        let sent = false;
        let capturing = false;
        let finished = false;
        let ended = false;
        let release!: () => void;
        const capture = new Promise<void>((resolve) => (release = resolve));
        const a = await makeAgent({
            provider: "claude-code",
            session,
            drainQueued: () => {
                if (!waiting || sent) return [];
                sent = true;
                return ["and check the tests"];
            },
        });
        a.agent.options.trusted = () => true;
        a.agent.turnSnapshots!.begin = async (_id, prompt) => {
            if (prompt !== "and check the tests") return;
            capturing = true;
            await capture;
        };
        a.agent.turnSnapshots!.end = async () => { ended = true; };
        const done = a.run("map the auth module", ac.signal).finally(() => { finished = true; });
        try {
            while (!notices(a.events).some((n) => n.includes("Waiting for"))) await Bun.sleep(10);
            waiting = true;
            while (!capturing) await Bun.sleep(10);
            ac.abort();
            await Bun.sleep(150);
            expect(finished).toBe(false);
            expect(ended).toBe(false);
            release();
            expect(await done).toBe("aborted");
            expect(ended).toBe(true);
            expect(userTexts()).not.toContain("and check the tests");
        } finally {
            ac.abort();
            release();
            await done;
            session.release();
        }
    });

    test("a message the user sends while it waits goes to Claude Code in the same run", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        process.env.FAKE_SECOND_SCENARIO = "none";
        process.env.FAKE_BACKGROUND_MS = "1500";
        let waiting = false;
        let sent = false;
        const a = await makeAgent({
            provider: "claude-code",
            drainQueued: () => {
                if (!waiting || sent) return [];
                sent = true;
                return ["and check the tests"];
            },
        });
        const done = a.run("map the auth module");
        while (!notices(a.events).some((n) => n.includes("Waiting for"))) await Bun.sleep(10);
        waiting = true;
        expect(await done).toBe("done");
        expect(starts()).toHaveLength(1);
        expect(userTexts().slice(-1)).toEqual(["and check the tests"]);
        expect(subEnds(a.events)).toEqual(["done"]);
        expect(texts(a.events)).toContain("The explorer reported back");
    }, 20_000);

    test("with an API key, Claude Code's own turn with the report doesn't count the run's spend twice", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        process.env.FAKE_API_KEY_SOURCE = "ANTHROPIC_API_KEY";
        const { run, session } = await makeAgent({ provider: "claude-code" });
        await run("map the auth module");
        // Each result's total_cost_usd includes the run's earlier ones (0.5, then 1).
        expect(session.cost).toBe(1);
    });

    test("with an API key, a resumed run's spend counts once: Claude Code's totals include the runs before it", async () => {
        process.env.FAKE_API_KEY_SOURCE = "ANTHROPIC_API_KEY";
        const { run, session } = await makeAgent({ provider: "claude-code", ask: () => ({ allow: true }) });
        await run("first");
        await run("second");
        // 0.5, then a total of 1 for the session.
        expect(session.cost).toBe(1);
    });

    test("a resumed turn isn't ended by Claude Code's report on a sub-agent the last run left behind", async () => {
        const { run, events, session } = await makeAgent({ provider: "claude-code", ask: () => ({ allow: true }) });
        await run("first");
        process.env.FAKE_STALE_TASK = "1";
        const from = events.length;
        expect(await run("second")).toBe("done");
        const later = events.slice(from);
        // The prompt's own answer, not the empty turn before it.
        expect(texts(later)).toBe("Working on it.All done.");
        expect(session.messages.at(-1)!.content.map((p) => (p as any).text).join("\n")).toContain("All done.");
        expect(notices(later).join("\n")).toMatch(/didn't finish before the previous session ended/);
    });

    test("a reply with nothing in it says so", async () => {
        process.env.FAKE_SCENARIO = "silent";
        const { run, events } = await makeAgent({ provider: "claude-code" });
        expect(await run("go")).toBe("done");
        expect(notices(events)).toEqual(["warn: Claude Code ended the turn without a reply."]);
    });

    test("results that don't say which prompt they answer (an older Claude Code) still end the turn", async () => {
        process.env.FAKE_OLD_RESULTS = "1";
        process.env.FAKE_SCENARIO = "agent-background";
        const { run, events } = await makeAgent({ provider: "claude-code" });
        expect(await run("map the auth module")).toBe("done");
        expect(subEnds(events)).toEqual(["done"]);
    });

    test("the context is updated as Claude Code works, not only when its turn ends", async () => {
        process.env.FAKE_SCENARIO = "hang";
        const ac = new AbortController();
        const { run, events, agent, session } = await makeAgent({ provider: "claude-code" });
        const done = run("go", ac.signal);
        while (!events.some((e) => e.type === "tool_start")) await Bun.sleep(10);
        // From the request's usage (10 + 1000 cached + 5 out), before any result; nothing is counted twice.
        expect(events.some((e) => e.type === "usage" && e.contextTokens === 1015)).toBe(true);
        expect(agent.contextTokens).toBe(1015);
        expect(session.usageByModel.size).toBe(0);
        ac.abort();
        await done;
    });
});

describe("Codex backend", () => {
    const turnStarts = () => received().filter((m) => m.method === "turn/start").map((m) => m.params);

    test("a turn: harness rules answer Codex's approval; manual mode is untrusted + read-only", async () => {
        const { run, events, session, asked } = await makeAgent({ provider: "codex", model: { id: "gpt-test" }, settings: { permissions: { allow: ["Bash(touch:*)"] } }, ask: () => ({ allow: true }) });
        expect(await run("make x")).toBe("done");
        expect(asked).toHaveLength(0);
        const end = toolEnds(events)[0]!;
        expect(end.call.input).toEqual({ command: "touch x" });
        expect(end.result).toMatchObject({ isError: false, content: "ok\n" });
        expect(received().find((m) => m.result?.decision)?.result.decision).toBe("accept");
        const p = turnStarts()[0];
        expect(p).toMatchObject({ threadId: "thr-new", model: "gpt-test", approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly", networkAccess: false } });
        expect(p.input[0].text).toEndWith("</system-reminder>\n\nmake x");
        expect(session.backends.get("codex")?.id).toBe("thr-new");
        expect(session.cost).toBe(0);
        const said = session.messages.at(-1)!.content.map((x) => (x as any).text).join("\n");
        expect(said).toContain("Running it.");
        expect(said).toContain("[Codex used: Bash(touch x)]");
    });

    test("modes map to Codex's approval policy and sandbox", () => {
        expect(codexPolicy("default", [])).toMatchObject({ approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" });
        // Added folders as the checker reads them: `~/…` and relative ones too.
        const home = realpathSync(homedir());
        expect(insideWorkspace(join(home, "proj", "src"), "/elsewhere", ["~/proj"])).toBe(true);
        expect(insideWorkspace(join(home, "other"), "/elsewhere", ["~/proj"])).toBe(false);
        expect(insideWorkspace(join(realpathSync(tmpdir()), "ws", "lib"), join(realpathSync(tmpdir()), "ws", "app"), ["../lib"])).toBe(true);
        // A read-only agent in auto: reads run in the read-only sandbox; anything more asks the harness, never Codex's reviewer.
        expect(codexPolicy("auto", ["/x"], true)).toEqual({ approvalPolicy: "on-request", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false }, approvalsReviewer: "user" });
        expect(codexPolicy("auto", ["/x"])).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review" });
        expect(codexPolicy("plan", [])).toMatchObject({ approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" });
        expect(codexPolicy("acceptEdits", ["/x"])).toMatchObject({ approvalPolicy: "untrusted", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/x"] }, approvalsReviewer: "user" });
        expect(codexPolicy("auto", [])).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review" });
        expect(codexPolicy("bypassPermissions", [])).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" });
    });

    test("auto mode: Codex's own reviewer answers what leaves its sandbox, and its no is shown; other modes take it back", async () => {
        process.env.FAKE_REVIEW_DENY = "1";
        const a = await makeAgent({ provider: "codex", mode: "auto", ask: () => ({ allow: true }) });
        expect(await a.run("make x")).toBe("done");
        expect(a.asked).toEqual([]);
        expect(received().find((m) => m.method === "thread/start")?.params.approvalsReviewer).toBe("auto_review");
        expect(turnStarts()[0]).toMatchObject({ approvalPolicy: "on-request", approvalsReviewer: "auto_review" });
        expect(logLines().find((l) => "ran" in l)).toMatchObject({ ran: false });
        expect(notices(a.events)).toContain("warn: Codex's reviewer blocked `touch x`: It sends the project to an unknown host.");
        // Its verdict lines aren't shown (the no is above, once); other warnings about the reviewer are.
        expect(notices(a.events).filter((n) => n.includes("(risk: "))).toEqual([]);
        expect(notices(a.events).filter((n) => /blocked|denied/.test(n))).toHaveLength(1);
        expect(notices(a.events)).toContain("warn: Codex's reviewer: Automatic approval review failed: the reviewer didn't answer");
        // The reviewer stays with the thread: manual mode says it's the user again, and the harness asks.
        a.setMode("default");
        expect(await a.run("make x again")).toBe("done");
        expect(turnStarts().at(-1)).toMatchObject({ approvalPolicy: "untrusted", approvalsReviewer: "user" });
        expect(a.asked).toHaveLength(1);
    });

    test("auto mode: when Codex doesn't send the reviewer's finished event, its no still shows, from the verdict line", async () => {
        process.env.FAKE_REVIEW_DENY = "1";
        process.env.FAKE_REVIEW_NO_COMPLETED = "1";
        const a = await makeAgent({ provider: "codex", mode: "auto", ask: () => ({ allow: true }) });
        expect(await a.run("make x")).toBe("done");
        expect(notices(a.events).filter((n) => /blocked|denied/.test(n))).toEqual(["warn: Codex's reviewer: Automatic approval review denied (risk: high, authorization: low): It sends the project to an unknown host."]);
        // A yes is never shown.
        expect(notices(a.events).some((n) => n.includes("approved (risk: "))).toBe(false);
    });

    test("auto mode: each verdict line is matched to the no it repeats by thread and reason, never just counted", async () => {
        process.env.FAKE_REVIEW_DENY = "1";
        process.env.FAKE_REVIEW_MIXED = "1";
        const a = await makeAgent({ provider: "codex", mode: "auto", ask: () => ({ allow: true }) });
        expect(await a.run("make x")).toBe("done");
        const said = (why: string) => notices(a.events).filter((n) => n.includes(why));
        const line = (why: string) => `warn: Codex's reviewer: Automatic approval review denied (risk: high, authorization: low): ${why}`;
        // A's no once, from its finished event; B's and C's, which came only as verdict lines, once each.
        expect(said("A: deletes the home folder.")).toEqual(["warn: Codex's reviewer blocked `touch x`: A: deletes the home folder.", line("A: deletes the home folder.")]);
        expect(said("B: pushes to main.")).toEqual([line("B: pushes to main.")]);
        expect(said("C: posts the token.")).toEqual([line("C: posts the token.")]);
        expect(notices(a.events)).toContain("warn: Codex's reviewer ran out of time on `touch x`.");
    });

    test("headless: the command is declined with the reason, and the turn goes on", async () => {
        const { run, events, session } = await makeAgent({ provider: "codex" });
        expect(await run("make x")).toBe("done");
        expect(received().find((m) => m.result?.decision)?.result.decision).toBe("decline");
        expect(toolEnds(events)[0]!.result).toMatchObject({ isError: true, content: expect.stringMatching(/not granted \(non-interactive session\)/) });
        expect(session.messages.at(-1)!.content.map((x) => (x as any).text).join("\n")).toContain("Finished.");
        expect(turnStarts()).toHaveLength(1);
        // Codex tells its model only "rejected by user": the reason goes into the turn.
        expect(received().find((m) => m.method === "turn/steer")?.params.input[0].text).toMatch(/^<system-reminder>\nHarness refused that: Permission to use Bash was not granted \(non-interactive session\)/);
    });

    test("the harness's reason is only steered in: when the turn is over, it doesn't start another (the user's words do)", async () => {
        process.env.FAKE_STEER_FAIL = "1";
        const headless = await makeAgent({ provider: "codex" });
        expect(await headless.run("make x")).toBe("done");
        expect(received().filter((m) => m.method === "turn/steer")).toHaveLength(1);
        expect(turnStarts()).toHaveLength(1);

        const user = await makeAgent({ provider: "codex", ask: () => ({ allow: false, feedback: "use y instead" }) });
        expect(await user.run("make x")).toBe("done");
        expect(turnStarts().length).toBeGreaterThanOrEqual(3);
        expect(JSON.stringify(turnStarts()[2])).toContain("use y instead");
    });

    test("declining with feedback: steered into the turn where Codex offers decline", async () => {
        process.env.FAKE_DECLINE = "1";
        const { run } = await makeAgent({ provider: "codex", ask: () => ({ allow: false, feedback: "use y instead" }) });
        await run("make x");
        expect(received().find((m) => m.result?.decision)?.result.decision).toBe("decline");
        const steer = received().find((m) => m.method === "turn/steer");
        expect(steer?.params.input[0].text).toContain("use y instead");
        expect(turnStarts()).toHaveLength(1);
    });

    test("declining with feedback where Codex lists only cancel (untrusted mode): still declined and steered", async () => {
        const { run } = await makeAgent({ provider: "codex", ask: () => ({ allow: false, feedback: "use y instead" }) });
        await run("make x");
        expect(received().find((m) => m.result?.decision)?.result.decision).toBe("decline");
        expect(received().find((m) => m.method === "turn/steer")?.params.input[0].text).toContain("use y instead");
        expect(turnStarts()).toHaveLength(1);
    });

    test("untrusted mode asks about every command: one the harness runs for its own models runs without asking", async () => {
        process.env.FAKE_COMMAND = "cat greet.py";
        const { run, asked } = await makeAgent({ provider: "codex", ask: () => ({ allow: false }) });
        expect(await run("read it")).toBe("done");
        expect(received().find((m) => m.result?.decision)?.result.decision).toBe("accept");
        expect(asked).toEqual([]);
        expect(logLines().find((l) => "ran" in l)).toMatchObject({ ran: true, command: "cat greet.py" });
    });

    test("a read-only command in another folder is checked there, and runs without asking unless it reads a secret", async () => {
        const other = join(cwd, "other");
        mkdirSync(other, { recursive: true });
        process.env.FAKE_COMMAND = "sed -n '1,5p' greet.py";
        process.env.FAKE_COMMAND_CWD = other;
        const quiet = await makeAgent({ provider: "codex", ask: () => ({ allow: false }) });
        expect(await quiet.run("read it")).toBe("done");
        expect(quiet.asked).toEqual([]);
        expect(logLines().find((l) => "ran" in l)).toMatchObject({ ran: true });
        rmSync(LOG, { force: true });
        process.env.FAKE_COMMAND = "cat .env";
        const secret = await makeAgent({ provider: "codex", ask: () => ({ allow: false, feedback: "no" }) });
        await secret.run("read it");
        expect(secret.asked.map((a) => a.input.command)).toEqual([`cd '${realpathSync(other)}' && cat .env`]);
        // A folder that's a symlink is checked where it leads: `keys -> .ssh` is the .ssh folder.
        const ssh = join(tempDir(), ".ssh");
        mkdirSync(ssh, { recursive: true });
        writeFileSync(join(ssh, "deploy_key"), "fake\n");
        symlinkSync(ssh, join(cwd, "keys"));
        for (const command of ["cat deploy_key", "cat *"]) {
            rmSync(LOG, { force: true });
            process.env.FAKE_COMMAND = command;
            process.env.FAKE_COMMAND_CWD = join(cwd, "keys");
            const linked = await makeAgent({ provider: "codex", ask: () => ({ allow: false, feedback: "no" }) });
            await linked.run("read it");
            expect(linked.asked.map((a) => a.input.command)).toEqual([`cd '${realpathSync(ssh)}' && ${command}`]);
            expect(logLines().find((l) => "ran" in l)).toMatchObject({ ran: false });
        }
        // Outside the workspace, even a read-only command asks: a search there reads what the checker can't see.
        const outside = tempDir();
        writeFileSync(join(outside, ".env"), "FAKE=1\n");
        symlinkSync(outside, join(cwd, "env-link"));
        for (const folder of [outside, join(cwd, "env-link")]) {
            rmSync(LOG, { force: true });
            process.env.FAKE_COMMAND = "rg --hidden .";
            process.env.FAKE_COMMAND_CWD = folder;
            const search = await makeAgent({ provider: "codex", ask: () => ({ allow: false, feedback: "no" }) });
            await search.run("look");
            expect(search.asked.map((a) => a.input.command)).toEqual([`cd '${realpathSync(outside)}' && rg --hidden .`]);
            expect(logLines().find((l) => "ran" in l)).toMatchObject({ ran: false });
        }
    });

    test("the command comes out of Codex's quoted shell wrapper as a shell would read it", async () => {
        // As Codex 0.162 showed it: double quotes, with the ! part in single quotes.
        process.env.FAKE_COMMAND_RAW = `/bin/zsh -lc "rg --files -g 'greet.py' -g '"'!**/.git/**'"'"`;
        const { run, asked, events } = await makeAgent({ provider: "codex", ask: () => ({ allow: false }) });
        expect(await run("find it")).toBe("done");
        expect(asked).toEqual([]);
        expect(logLines().find((l) => "ran" in l)).toMatchObject({ ran: true });
        expect(events.find((e) => e.type === "tool_start")).toMatchObject({ call: { input: { command: "rg --files -g 'greet.py' -g '!**/.git/**'" } } });

        // A wrapper with more around it stays whole (and isn't read-only).
        rmSync(LOG, { force: true });
        process.env.FAKE_COMMAND_RAW = `/bin/zsh -lc 'cat a' && rm -rf b`;
        const second = await makeAgent({ provider: "codex", ask: () => ({ allow: false, feedback: "no" }) });
        await second.run("go");
        expect(second.asked.map((a) => a.input.command)).toEqual([`/bin/zsh -lc 'cat a' && rm -rf b`]);
    });

    test("a shell the model named, or a folder it picked, isn't taken on trust: the prompt shows them", async () => {
        const cases: [Record<string, string>, string][] = [
            [{ FAKE_COMMAND_RAW: "./bash -lc 'cat greet.py'" }, "./bash -lc 'cat greet.py'"],
            [{ FAKE_COMMAND_RAW: "/tmp/x/zsh -lc 'cat greet.py'" }, "/tmp/x/zsh -lc 'cat greet.py'"],
            [{ FAKE_COMMAND: "touch notes.txt", FAKE_COMMAND_CWD: "/tmp/elsewhere" }, `cd '${realpathSync("/tmp")}/elsewhere' && touch notes.txt`],
        ];
        for (const [vars, shown] of cases) {
            rmSync(LOG, { force: true });
            for (const k of ["FAKE_COMMAND", "FAKE_COMMAND_RAW", "FAKE_COMMAND_CWD"]) delete process.env[k];
            Object.assign(process.env, vars);
            const { run, asked } = await makeAgent({ provider: "codex", ask: () => ({ allow: false, feedback: "no" }) });
            await run("read it");
            expect(asked.map((a) => a.input.command)).toEqual([shown]);
            expect(logLines().find((l) => "ran" in l)).toMatchObject({ ran: false });
        }
    });

    test("...but not past an ask rule, near credentials, or where the parsed command leaves something out", async () => {
        const cases: [Record<string, string>, any][] = [
            [{ FAKE_COMMAND: "cat notes.txt" }, { permissions: { ask: ["Bash(cat:*)"] } }],
            [{ FAKE_COMMAND: "cat .env" }, {}],
            [{ FAKE_COMMAND: "cat notes.txt", FAKE_COMMAND_SCRIPT: "rm -rf build; cat notes.txt" }, {}],
        ];
        for (const [vars, settings] of cases) {
            rmSync(LOG, { force: true });
            Object.assign(process.env, vars);
            const { run, asked } = await makeAgent({ provider: "codex", settings, ask: () => ({ allow: false, feedback: "no" }) });
            await run("read it");
            expect(asked).toHaveLength(1);
            // The prompt shows the whole command, not Codex's parsed version of it.
            expect(asked[0]!.input.command).toBe(vars.FAKE_COMMAND_SCRIPT ?? vars.FAKE_COMMAND);
            expect(logLines().find((l) => "ran" in l)).toMatchObject({ ran: false });
            delete process.env.FAKE_COMMAND_SCRIPT;
        }
    });

    test("declining without feedback cancels and ends the turn", async () => {
        const { run } = await makeAgent({ provider: "codex", ask: () => ({ allow: false }) });
        expect(await run("make x")).toBe("denied");
        expect(turnStarts()).toHaveLength(1);
    });

    test("signed out: says how to sign in", async () => {
        process.env.FAKE_ACCOUNT = "none";
        const { run, events } = await makeAgent({ provider: "codex" });
        expect(await run("hi")).toBe("error");
        expect(notices(events).join("\n")).toMatch(/Codex isn't signed in.*codex login/);
    });

    test("the next turn resumes the thread; a lost one starts over", async () => {
        const { run, session } = await makeAgent({ provider: "codex", settings: { permissions: { allow: ["Bash(touch:*)"] } } });
        await run("one");
        await run("two");
        expect(received().find((m) => m.method === "thread/resume")?.params.threadId).toBe("thr-new");
        rmSync(LOG, { force: true });
        session.setBackendSession("codex", "gone-9", session.messages.length);
        expect(await run("three")).toBe("done");
        const methods = received().map((m) => m.method).filter((m) => m?.startsWith("thread/") && !m.startsWith("thread/goal/"));
        expect(methods).toEqual(["thread/resume", "thread/start"]);
    }, 20_000);

    test("acceptEdits: workspace-write with the extra directories, but commands still ask", async () => {
        const { run, events } = await makeAgent({ provider: "codex", mode: "acceptEdits", settings: { permissions: { additionalDirectories: ["/extra"] } } });
        await run("go");
        expect(turnStarts()[0]).toMatchObject({ approvalPolicy: "untrusted", sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/extra"] } });
        // Codex asked (headless: refused), rather than running it itself.
        expect(toolEnds(events)[0]!.result.content).toMatch(/not granted/);
        expect(logLines().find((l) => "ran" in l)?.ran).toBe(false);
    });
});

describe("Codex: its own sub-agents, usage, MCP questions, what a turn did (transcript findings)", () => {
    const turnStarts = () => received().filter((m) => m.method === "turn/start").map((m) => m.params);
    const said = (session: InstanceType<typeof Session>) => session.messages.at(-1)!.content.map((x) => (x as any).text).join("\n");
    const streamed = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
    const subEvents = (events: AgentEvent[], parentId: string) => events.flatMap((e) => (e.type === "subagent" && e.parentId === parentId ? [e] : []));
    const elicitations = () => logLines().flatMap((l) => (l.elicitation !== undefined ? [l.elicitation] : []));
    const usageOf = (session: InstanceType<typeof Session>) => session.usageByModel.get("codex:default")!.usage;

    test("a sub-agent Codex starts: its words aren't the reply, its tokens aren't the context, and its work shows under the spawn", async () => {
        process.env.FAKE_SCENARIO = "subagent";
        const { run, events, session, agent, asked } = await makeAgent({ provider: "codex", ask: () => ({ allow: true }) });
        expect(await run("go")).toBe("done");
        // The reply, streamed and in the history, is the main thread's.
        expect(said(session)).toContain("Running it.");
        expect(said(session)).toContain("Finished.");
        for (const child of ["Looking around.", "CHILD_REPORT"]) {
            expect(said(session)).not.toContain(child);
            expect(streamed(events)).not.toContain(child);
        }
        expect(events.flatMap((e) => (e.type === "assistant" ? [(e.message.content[0] as any).text] : []))).toEqual(["Running it.", "Finished."]);
        // Its warning and error are its own: not the main agent's notices, and they don't fail the turn.
        expect(notices(events).join("\n")).not.toMatch(/hiccup|Model metadata/);
        expect(events.filter((e) => e.type === "request_start")).toHaveLength(2); // the harness's and the main turn's
        // The spawn is a sub-agent (Task) with its activity under it, and its answer is its report.
        const spawn = events.find((e) => e.type === "tool_start" && e.call.name === "Task") as Extract<AgentEvent, { type: "tool_start" }>;
        expect(spawn.call.input).toEqual({ description: "Count the files", prompt: "Count the files\nin src, then report." });
        expect(spawn.title).toBe("Task(Count the files)");
        const sub = subEvents(events, spawn.call.id);
        expect(sub.every((e) => e.label === "Count the files")).toBe(true);
        expect(sub.find((e) => e.event.type === "tool_start")?.event).toMatchObject({ call: { name: "Bash", input: { command: "touch y" } } });
        expect(sub.find((e) => e.event.type === "tool_end")?.event).toMatchObject({ result: { content: "ok\n", isError: false } });
        expect(sub.flatMap((e) => (e.event.type === "text" ? [e.event.text] : []))).toEqual(["CHILD_REPORT: 2 files."]);
        expect(sub.at(-1)?.event).toEqual({ type: "turn_end", reason: "done" });
        // Its command was asked about as the sub-agent's.
        expect(asked.map((a) => [a.input.command, a.agentLabel])).toEqual([["touch y", "Count the files"]]);
        // The wait shows what it reported; the history says what the main agent did.
        expect(toolEnds(events).find((e) => e.call.id.startsWith("wait-"))?.result.content).toContain("CHILD_REPORT: 2 files.");
        expect(said(session)).toMatch(/\[Codex used: Task\(Count the files\), Wait for sub-agents\]/);
        // Its tokens count toward the spend, not toward the main thread's context.
        const u = usageOf(session);
        expect(u.inputTokens + (u.cacheReadTokens ?? 0)).toBe(120 + 5000);
        expect(u.outputTokens).toBe(30 + 50);
        expect(agent.contextTokens).toBe(150);
    });

    for (const early of ["1", "all"])
        test(`a sub-agent's events from before the spawn said whose they are (${early === "1" ? "its first" : "all of them"}) still go under it, after the spawn call ends`, async () => {
            process.env.FAKE_SCENARIO = "subagent";
            process.env.FAKE_CHILD_EARLY = early;
            const { run, events, session, asked } = await makeAgent({ provider: "codex", ask: () => ({ allow: true }) });
            expect(await run("go")).toBe("done");
            expect(streamed(events)).not.toContain("Looking around.");
            expect(said(session)).not.toContain("Looking around.");
            const spawn = events.find((e) => e.type === "tool_start" && e.call.name === "Task") as Extract<AgentEvent, { type: "tool_start" }>;
            const sub = subEvents(events, spawn.call.id);
            expect(sub[0]?.event.type).toBe("request_start");
            expect(sub.flatMap((e) => (e.event.type === "text" ? [e.event.text] : []))).toEqual(["CHILD_REPORT: 2 files."]);
            expect(sub.at(-1)?.event).toEqual({ type: "turn_end", reason: "done" });
            // The call's end comes first: the GUI takes a Task's result as the report of a sub-agent that has already ended.
            const spawnEnd = events.findIndex((e) => e.type === "tool_end" && e.call.id === spawn.call.id);
            expect(spawnEnd).toBeLessThan(events.indexOf(sub[0]!));
            // Asking before Codex said whose thread it is: a sub-agent of Codex's all the same.
            expect(asked.map((a) => a.agentLabel)).toEqual([early === "all" ? "Codex sub-agent" : "Count the files"]);
            // Its usage shows on it once, counted once.
            expect(sub.flatMap((e) => (e.event.type === "usage" ? [e.event.usage.outputTokens] : []))).toEqual([50]);
            expect(usageOf(session).outputTokens).toBe(30 + 50);
        });

    test("a sub-agent Codex announces with an item of its own (multi_agent_v2) shows the same way", async () => {
        process.env.FAKE_SCENARIO = "subagent";
        process.env.FAKE_SUBAGENT_V2 = "1";
        const { run, events, session } = await makeAgent({ provider: "codex", ask: () => ({ allow: true }) });
        expect(await run("go")).toBe("done");
        const tasks = events.filter((e): e is Extract<AgentEvent, { type: "tool_start" }> => e.type === "tool_start" && e.call.name === "Task");
        // One per sub-agent: the item saying it finished isn't another.
        expect(tasks.map((e) => [e.call.id, e.call.input])).toEqual([["act-started-turn-1", { description: "count files", prompt: "" }]]);
        const sub = subEvents(events, "act-started-turn-1");
        expect(sub.find((e) => e.event.type === "tool_start")?.event).toMatchObject({ call: { name: "Bash", input: { command: "touch y" } } });
        expect(sub.flatMap((e) => (e.event.type === "text" ? [e.event.text] : []))).toEqual(["CHILD_REPORT: 2 files."]);
        expect(sub.at(-1)?.event).toEqual({ type: "turn_end", reason: "done" });
        expect(said(session)).not.toContain("CHILD_REPORT");
        expect(said(session)).toContain("[Codex used: Task(count files)]");
    });

    for (const v2 of [false, true])
        test(`a sub-agent of an earlier turn, set going again${v2 ? " (multi_agent_v2)" : ""}, shows under that call by the name it had`, async () => {
            process.env.FAKE_SCENARIO = "subagent";
            if (v2) process.env.FAKE_SUBAGENT_V2 = "1";
            const { run, events, session, asked, checker } = await makeAgent({ provider: "codex", ask: () => ({ allow: true }) });
            expect(await run("go")).toBe("done");
            const label = v2 ? "count files" : "Count the files";
            // The same command approved in the first turn would go through without asking.
            checker.resetSession();
            process.env.FAKE_RESUME_AGENT = "1";
            events.length = 0;
            asked.length = 0;
            expect(await run("go on")).toBe("done");
            const tasks = events.filter((e): e is Extract<AgentEvent, { type: "tool_start" }> => e.type === "tool_start" && e.call.name === "Task");
            expect(tasks.map((e) => [e.call.id.replace(/-turn-\d+$/, ""), e.title])).toEqual([[v2 ? "act-interacted" : "resume", `Task(${label})`]]);
            const sub = subEvents(events, tasks[0]!.call.id);
            expect(sub.every((e) => e.label === label)).toBe(true);
            expect(sub[0]?.event.type).toBe("request_start");
            expect(sub.find((e) => e.event.type === "tool_start")?.event).toMatchObject({ call: { name: "Bash", input: { command: "touch y" } } });
            expect(sub.flatMap((e) => (e.event.type === "text" ? [e.event.text] : []))).toEqual(["CHILD_REPORT: 2 files."]);
            expect(sub.at(-1)?.event).toEqual({ type: "turn_end", reason: "done" });
            expect(asked.map((a) => a.agentLabel)).toEqual([label]);
            // Not the main agent's.
            expect(streamed(events)).not.toContain("Looking around.");
            expect(toolEnds(events).filter((e) => e.call.name === "Bash")).toHaveLength(0);
            expect(said(session)).not.toContain("CHILD_REPORT");
        });

    test("declining a sub-agent's command: what the user said goes into its turn, and the main turn isn't ended for it", async () => {
        process.env.FAKE_SCENARIO = "subagent";
        const feedback = await makeAgent({ provider: "codex", ask: () => ({ allow: false, feedback: "use z instead" }) });
        expect(await feedback.run("go")).toBe("done");
        expect(received().find((m) => m.method === "turn/steer")?.params).toMatchObject({ threadId: "thr-child", expectedTurnId: "turn-c1", input: [{ text: "The user declined this tool call and said:\nuse z instead" }] });
        expect(turnStarts()).toHaveLength(1);
        rmSync(LOG, { force: true });
        const stop = await makeAgent({ provider: "codex", ask: () => ({ allow: false }) });
        expect(await stop.run("go")).toBe("done");
        expect(received().find((m) => m.result?.decision)?.result.decision).toBe("cancel");
        expect(logLines().find((l) => "childRan" in l)).toEqual({ childRan: false });
    });

    test("usage counts each response once: not again when the thread is resumed, or when a compaction starts", async () => {
        const { run, session, agent } = await makeAgent({ provider: "codex", settings: { permissions: { allow: ["Bash(touch:*)"] } } });
        await run("one");
        await run("two");
        // Codex says the last turn's usage again on resuming the thread: two turns, two responses.
        expect(usageOf(session).outputTokens).toBe(60);
        expect(usageOf(session).inputTokens).toBe(200);
        expect(agent.contextTokens).toBe(150);
        expect(await agent.compact({ auto: false, signal: new AbortController().signal })).toBe(true);
        // The compaction's own request counts; the usage it repeats as it starts doesn't.
        expect(usageOf(session).outputTokens).toBe(60 + 40);
        expect(usageOf(session).inputTokens).toBe(200 + 400);
    });

    // Several CLI subprocesses run sequentially; startup and teardown need time on busy machines.
    test("an MCP tool call Codex asks about goes to the harness's rules and the user, not declined unasked", async () => {
        process.env.FAKE_SCENARIO = "elicit";
        const yes = await makeAgent({ provider: "codex", ask: () => ({ allow: true }) });
        expect(await yes.run("go")).toBe("done");
        expect(yes.asked.map((a) => [a.tool.name, a.input])).toEqual([["mcp__probe__write_thing", { what: "x" }]]);
        expect(elicitations()).toEqual([{ action: "accept", content: {}, _meta: null }]);
        expect(toolEnds(yes.events)[0]!.result).toMatchObject({ isError: false, content: "wrote {}" });

        for (const [settings, reason] of [
            [{ permissions: { allow: ["mcp__probe__write_thing"] } }, undefined],
            [{ permissions: { deny: ["mcp__probe"] } }, /permission rule/],
        ] as const) {
            rmSync(LOG, { force: true });
            const ruled = await makeAgent({ provider: "codex", settings, ask: () => ({ allow: true }) });
            expect(await ruled.run("go")).toBe("done");
            expect(ruled.asked).toEqual([]);
            expect(elicitations()[0].action).toBe(reason ? "decline" : "accept");
            if (reason) expect(toolEnds(ruled.events)[0]!.result).toMatchObject({ isError: true, content: expect.stringMatching(reason) });
        }

        // Another call of the same server still open, with the same arguments, for a tool the user allows: the question
        // names the tool, so it's that one's rules that apply, and the user is asked.
        process.env.FAKE_ELICIT_OTHER_CALL = "1";
        rmSync(LOG, { force: true });
        const two = await makeAgent({ provider: "codex", settings: { permissions: { allow: ["mcp__probe__read_thing"] } }, ask: () => ({ allow: false, feedback: "not that" }) });
        expect(await two.run("go")).toBe("done");
        expect(two.asked.map((a) => a.tool.name)).toEqual(["mcp__probe__write_thing"]);
        expect(elicitations()[0].action).toBe("decline");
        delete process.env.FAKE_ELICIT_OTHER_CALL;

        // Nobody to ask: declined, saying why.
        rmSync(LOG, { force: true });
        const headless = await makeAgent({ provider: "codex" });
        expect(await headless.run("go")).toBe("done");
        expect(elicitations()).toEqual([{ action: "decline", content: null, _meta: null }]);
        expect(toolEnds(headless.events)[0]!.result.content).toMatch(/not granted \(non-interactive session\)/);

        // Declined with nothing to add: Codex goes on after a no to an MCP call, so the turn is stopped here.
        rmSync(LOG, { force: true });
        const no = await makeAgent({ provider: "codex", ask: () => ({ allow: false }) });
        expect(await no.run("go")).toBe("denied");
        expect(elicitations()[0].action).toBe("decline");
        expect(received().some((m) => m.method === "turn/interrupt")).toBe(true);
    }, 20_000);

    // Several CLI subprocesses run sequentially; startup and teardown need time on busy machines.
    test("an MCP server's form goes to the question dialog, its answers typed as the form asks; with nobody to ask it's declined", async () => {
        process.env.FAKE_SCENARIO = "elicit";
        process.env.FAKE_ELICIT = "form";
        const asked: { question: string; options: string[]; multi: boolean }[] = [];
        const answers: Record<string, string[]> = { color: ["Blue"], "How many": ["3"], "Sure?": ["Yes"], tags: ["Tag A", "Tag B"], Note: ["Leave empty"] };
        const askQuestion = async (question: string, options: { label: string }[], multi: boolean) => {
            asked.push({ question, options: options.map((o) => o.label), multi });
            const field = question.split("\n").at(-1)!;
            return Object.entries(answers).find(([k]) => field.startsWith(k))?.[1];
        };
        const a = await makeAgent({ provider: "codex", ui: { askQuestion } });
        expect(await a.run("go")).toBe("done");
        expect(asked[0]!.question).toContain("probe");
        expect(asked[0]!.question).toContain("Which color?");
        expect(asked.map((q) => [q.options, q.multi])).toEqual([
            [["Red", "Blue"], false],
            [["Leave empty"], false],
            [["Yes", "No", "Leave empty"], false],
            [["Tag A", "Tag B", "Leave empty"], true],
            [["Leave empty"], false],
        ]);
        expect(elicitations()).toEqual([{ action: "accept", content: { color: "blue", count: 3, ok: true, tags: ["a", "b"] }, _meta: null }]);

        // Typed outside what a field allows (not one of its choices; not a number), required or not: declined, saying why.
        for (const [field, typed] of [["color", "purple"], ["How many", "lots"]] as const) {
            rmSync(LOG, { force: true });
            const wrong = { ...answers, [field]: [typed] };
            const c = await makeAgent({ provider: "codex", ui: { askQuestion: async (q: string) => Object.entries(wrong).find(([k]) => q.split("\n").at(-1)!.startsWith(k))?.[1] } });
            expect(await c.run("go")).toBe("done");
            expect(elicitations()).toEqual([{ action: "decline", content: null, _meta: null }]);
            expect(notices(c.events).join("\n")).toMatch(/Declined the probe MCP server's form: the answer for "(color|count)" isn't one it allows/);
        }

        // A required field's own choice that reads like the skip option is sent as picked.
        rmSync(LOG, { force: true });
        process.env.FAKE_ELICIT_FIELDS = JSON.stringify({ color: { type: "string", enum: ["Leave empty", "x"] } });
        const d = await makeAgent({ provider: "codex", ui: { askQuestion: async () => ["Leave empty"] } });
        expect(await d.run("go")).toBe("done");
        expect(elicitations()).toEqual([{ action: "accept", content: { color: "Leave empty" }, _meta: null }]);
        delete process.env.FAKE_ELICIT_FIELDS;

        // A required field left unanswered (dismissed), or nobody to ask: declined.
        for (const ui of [{ askQuestion: async () => undefined }, {}]) {
            rmSync(LOG, { force: true });
            const b = await makeAgent({ provider: "codex", ui });
            expect(await b.run("go")).toBe("done");
            expect(elicitations()).toEqual([{ action: "decline", content: null, _meta: null }]);
        }
    }, 20_000);

    test("an MCP server's form: what's typed outside what a field allows isn't sent as its value", () => {
        const form = elicitationForm({
            type: "object",
            properties: {
                color: { type: "string", enum: ["red", "blue"], enumNames: ["Red", "Blue"] },
                tags: { type: "array", items: { enum: ["a", "b"] }, maxItems: 1 },
                count: { type: "integer", minimum: 1, maximum: 5 },
                name: { type: "string", minLength: 2, maxLength: 4 },
            },
        })!;
        const parse = (key: string, answer: string[]) => form.find((f) => f.key === key)!.parse(answer);
        expect([parse("color", ["Blue"]), parse("color", ["blue"]), parse("color", ["purple"])]).toEqual(["blue", "blue", undefined]);
        expect([parse("tags", ["a"]), parse("tags", ["a", "c"]), parse("tags", ["a", "b"])]).toEqual([["a"], undefined, undefined]);
        expect([parse("count", ["5"]), parse("count", ["0"]), parse("count", ["6"]), parse("count", ["2.5"])]).toEqual([5, undefined, undefined, undefined]);
        expect([parse("name", ["Ann"]), parse("name", ["A"]), parse("name", ["Annabel"])]).toEqual(["Ann", undefined, undefined]);
        // An answer that reads like the skip option is an answer: an optional field's skip is named apart from its own choices.
        const [required, optional] = elicitationForm({ type: "object", properties: { a: { type: "string", enum: ["Leave empty", "x"] }, b: { type: "string", enum: ["Leave empty", "x"] } }, required: ["a"] })!;
        expect([required!.skip, required!.options.map((o) => o.label)]).toEqual([undefined, ["Leave empty", "x"]]);
        expect([optional!.skip, optional!.options.map((o) => o.label)]).toEqual(["Leave empty (skip)", ["Leave empty", "x", "Leave empty (skip)"]]);
        expect(required!.parse(["Leave empty"])).toBe("Leave empty");
    });

    test("an MCP server's link: the question shows it; done accepts", async () => {
        process.env.FAKE_SCENARIO = "elicit";
        process.env.FAKE_ELICIT = "url";
        const asked: string[] = [];
        const a = await makeAgent({ provider: "codex", ui: { askQuestion: async (q: string) => (asked.push(q), ["Done"]) } });
        expect(await a.run("go")).toBe("done");
        expect(asked[0]).toContain("https://probe.example/login");
        expect(asked[0]).toContain("Sign in to Probe.");
        expect(elicitations()).toEqual([{ action: "accept", content: null, _meta: null }]);
    });

    test("a change Codex asks about without having said what it writes is refused, not approved blind", async () => {
        process.env.FAKE_SCENARIO = "rename";
        process.env.FAKE_UNANNOUNCED = "1";
        const { run, events, asked } = await makeAgent({ provider: "codex", mode: "acceptEdits", ask: () => ({ allow: true }) });
        expect(await run("rename it")).toBe("done");
        expect(asked).toEqual([]);
        expect(received().find((m) => m.result?.decision)?.result.decision).toBe("decline");
        expect(notices(events).join("\n")).toMatch(/doesn't know which files this change writes/);
    });

    test("a web search is saved with its query, which Codex sends only when it's done", async () => {
        process.env.FAKE_SCENARIO = "web";
        const { run, events, session } = await makeAgent({ provider: "codex" });
        expect(await run("search")).toBe("done");
        const end = toolEnds(events)[0]!;
        expect(end.call.input).toEqual({ query: "bun test runner" });
        expect(end.title).toBe("WebSearch(bun test runner)");
        expect(said(session)).toContain("[Codex used: WebSearch(bun test runner)]");
    });

    test("the note of what a turn did keeps every action, up to a length, each on one line", () => {
        const many = Array.from({ length: 165 }, (_, i) => `Bash(step ${i})`);
        const note = backendActionsNote("Codex", many);
        expect(note).toStartWith("[Codex used: Bash(step 0), ");
        expect(note).toEndWith("Bash(step 164)]");
        expect(note).not.toContain("more]");
        const long = backendActionsNote("Codex", ["Bash(" + "x".repeat(500) + ")", "Edit(a\nb)"]);
        expect(long).toContain("…");
        expect(long).toContain("Edit(a b)");
        expect(long.length).toBeLessThan(300);
        const capped = backendActionsNote("Codex", Array.from({ length: 5000 }, (_, i) => `Read(file-${i}.ts)`));
        expect(capped.length).toBeLessThanOrEqual(16_100);
        expect(capped).toMatch(/, and \d+ more\]$/);
        expect(withoutActionsNote(`Done.\n\n${capped}`)).toBe("Done.");
    });
});

describe("review findings (PR #1)", () => {
    const turnStarts = () => received().filter((m) => m.method === "turn/start").map((m) => m.params);
    const claudeArgs = () => starts()[0]!.argv as string[];

    function hostileRepo() {
        Bun.spawnSync(["mkdir", "-p", join(cwd, ".claude", "skills", "x")]);
        writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch ${join(cwd, "pwned")}` }] }] } }));
    }

    test("1. a repo's Claude Code hooks don't run unless the user trusted the folder, however Claude Code was turned on", async () => {
        hostileRepo();
        // Turned on after startup in a folder that was only trusted for having nothing to protect.
        const a = await makeAgent({ provider: "claude-code", ask: () => ({ allow: true }) });
        await a.run("go");
        expect(existsSync(join(cwd, "pwned"))).toBe(false);
        expect(claudeArgs()).toEqual(expect.arrayContaining(["--setting-sources", "user", "--strict-mcp-config"]));
        // Trusted since (as /login offers): from the next turn it loads them.
        trust.trustFolder(cwd);
        rmSync(LOG, { force: true });
        await a.run("again");
        expect(claudeArgs()).not.toContain("--setting-sources");
        expect(existsSync(join(cwd, "pwned"))).toBe(true);
    });

    test("1. Codex is told the folder is untrusted unless the user trusted it, even if Codex itself trusts the project", async () => {
        Bun.spawnSync(["mkdir", "-p", join(cwd, ".codex")]);
        writeFileSync(join(cwd, ".codex", "config.toml"), 'model = "repo-chosen-model"\n');
        process.env.FAKE_CODEX_TRUSTS = "1";
        const a = await makeAgent({ provider: "codex", model: { id: "default" }, settings: { permissions: { allow: ["Bash(touch:*)"] } } });
        await a.run("go");
        const thread = logLines().find((l) => l.received?.method === "thread/start");
        expect(thread).toBeDefined();
        expect(starts()[0].argv.join(" ")).toContain(`${JSON.stringify(cwd)}={trust_level="untrusted"}`);
        expect(untrustedArgs(cwd)[1]).toContain(`${JSON.stringify(cwd)}={trust_level="untrusted"}`);
        trust.trustFolder(cwd);
        rmSync(LOG, { force: true });
        await a.run("again");
        expect(starts()[0].argv.join(" ")).not.toContain("trust_level");
    });

    test("2. deny rules cover what Claude Code would read without asking", async () => {
        writeFileSync(join(cwd, "secret.txt"), "TOPSECRET\n");
        process.env.FAKE_SCENARIO = "read-secret";
        const a = await makeAgent({ provider: "claude-code", settings: { permissions: { deny: ["Read(secret.txt)"] } }, ask: () => ({ allow: true }) });
        await a.run("read it");
        expect(a.asked).toHaveLength(0);
        const r = toolEnds(a.events)[0]!.result;
        expect(r.isError).toBe(true);
        expect(r.content).not.toContain("TOPSECRET");
        // Without the rule, it reads it without asking: the rule is what stopped it.
        rmSync(LOG, { force: true });
        const b = await makeAgent({ provider: "claude-code", ask: () => ({ allow: true }) });
        await b.run("read it");
        expect(toolEnds(b.events)[0]!.result.content).toContain("TOPSECRET");
    });

    test("2. harness rules as Claude Code rules", () => {
        const root = "/proj";
        expect(claudeRule("Read(secret.txt)", root)).toEqual(["Read(//proj/**/secret.txt)", "Read(//proj/**/secret.txt/**)"]);
        expect(claudeRule("Edit(src/**)", root)).toEqual(["Edit(//proj/src/**)"]);
        expect(claudeRule("Write(//etc/hosts)", root)).toEqual(["Edit(//etc/hosts)", "Edit(//etc/hosts/**)"]);
        expect(claudeRule("Grep(./docs/)", root)).toEqual(["Read(//proj/docs/)", "Read(//proj/docs/**)"]);
        expect(claudeRule("Bash(git push:*)", root)).toEqual(["Bash(git push:*)"]);
        // The harness's domain rule covers subdomains; Claude Code's needs *. for those.
        expect(claudeRule("WebFetch(domain:example.com)", root)).toEqual(["WebFetch(domain:example.com)", "WebFetch(domain:*.example.com)"]);
        expect(claudeRule("WebFetch(domain:*.example.com)", root)).toEqual(["WebFetch(domain:*.example.com)"]);
        expect(claudeRule("Task(explore)", root)).toEqual(["Agent(explore)"]);
        expect(claudeRule("mcp__github", root)).toEqual(["mcp__github"]);
        // Every tool: bare, or for a path every reading and editing tool.
        expect(claudeRule("*", root)).toEqual(["*"]);
        expect(claudeRule("*(secrets/**)", root)).toEqual(["Read(//proj/secrets/**)", "Edit(//proj/secrets/**)"]);
        expect(claudeRule("*(domain:evil.com)", root)).toEqual(["WebFetch(domain:evil.com)", "WebFetch(domain:*.evil.com)"]);
        const p = claudePermissions({ deny: ["Bash(rm:*)"], ask: ["Edit(src/**)"], root });
        expect(p.ask).toEqual(["Edit(//proj/src/**)"]);
        // The harness's credential store is always denied.
        expect(p.deny[0]).toBe("Bash(rm:*)");
        expect(p.deny.some((r) => r.includes("credentials.json"))).toBe(true);
    });

    test("3. accept edits: Claude Code's file commands still ask; edits in the workspace don't", async () => {
        writeFileSync(join(cwd, "victim.txt"), "v\n");
        process.env.FAKE_SCENARIO = "rm";
        const rm = await makeAgent({ provider: "claude-code", mode: "acceptEdits" });
        await rm.run("delete it");
        expect(existsSync(join(cwd, "victim.txt"))).toBe(true);
        expect(toolEnds(rm.events)[0]!.result.content).toMatch(/not granted/);
        expect(claudeArgs()[claudeArgs().indexOf("--permission-mode") + 1]).toBe("default");
        rmSync(LOG, { force: true });
        process.env.FAKE_SCENARIO = "write";
        const write = await makeAgent({ provider: "claude-code", mode: "acceptEdits", ask: () => ({ allow: false }) });
        expect(await write.run("write")).toBe("done");
        expect(write.asked).toHaveLength(0);
        expect(existsSync(join(cwd, "out.txt"))).toBe(true);
    });

    test("3. accept edits: writing Claude Code's own config still asks", async () => {
        Bun.spawnSync(["mkdir", "-p", join(cwd, ".claude")]);
        process.env.FAKE_SCENARIO = "write-config";
        const a = await makeAgent({ provider: "claude-code", mode: "acceptEdits", ask: () => ({ allow: false }) });
        await a.run("go");
        expect(a.asked.map((r) => r.tool.name)).toEqual(["Write"]);
        expect(existsSync(join(cwd, ".claude", "settings.json"))).toBe(false);
    });

    test("4. a Codex rename into a denied path is refused without asking", async () => {
        process.env.FAKE_SCENARIO = "rename";
        const a = await makeAgent({ provider: "codex", mode: "acceptEdits", settings: { permissions: { deny: ["Edit(secrets/**)"] } }, ask: () => ({ allow: true }) });
        await a.run("move it");
        expect(a.asked).toHaveLength(0);
        expect(received().find((m) => m.result?.decision)?.result.decision).not.toBe("accept");
        // Codex reports the folder's real path (on macOS, /private/var/… for /var/…).
        expect(toolEnds(a.events)[0]!.call.input).toEqual({ file_path: join(realpathSync(cwd), "a.txt") });
        expect((toolEnds(a.events)[0] as any).result.content).toMatch(/Denied by permission rule Edit\(secrets\/\*\*\)/);
    });

    test("4. Codex's requests for more permissions: refused in plan mode and past deny rules, otherwise asked", async () => {
        process.env.FAKE_SCENARIO = "perms";
        const granted = () => logLines().find((l) => "granted" in l)?.granted;
        const plan = await makeAgent({ provider: "codex", mode: "plan", ask: () => ({ allow: true }) });
        await plan.run("go");
        expect(plan.asked).toHaveLength(0);
        expect(granted()).toEqual({ permissions: {}, scope: "turn" });
        rmSync(LOG, { force: true });
        // A rule for a file inside the requested folder.
        const denied = await makeAgent({ provider: "codex", settings: { permissions: { deny: ["Read(secrets/key.pem)"] } }, ask: () => ({ allow: true }) });
        await denied.run("go");
        expect(denied.asked).toHaveLength(0);
        expect(granted()).toEqual({ permissions: {}, scope: "turn" });
        rmSync(LOG, { force: true });
        const asked = await makeAgent({ provider: "codex", settings: { permissions: { allow: ["Edit(secrets/**)"] } }, ask: () => ({ allow: true }) });
        await asked.run("go");
        expect(asked.asked).toHaveLength(1);
        expect(asked.asked[0]!.decision.reason).toContain(`write ${join(realpathSync(cwd), "secrets")}`);
        expect(granted()?.permissions?.fileSystem?.write).toEqual([join(realpathSync(cwd), "secrets")]);
    });

    test("4. switching to plan mode mid-turn stops Codex's turn and goes on under plan mode", async () => {
        process.env.FAKE_SCENARIO = "slow";
        const a = await makeAgent({ provider: "codex", mode: "acceptEdits" });
        const done = a.run("work");
        while (!a.events.some((e) => e.type === "assistant")) await Bun.sleep(10);
        a.switchMode("plan");
        await done;
        expect(received().some((m) => m.method === "turn/interrupt")).toBe(true);
        const [first, second] = turnStarts();
        expect(first).toMatchObject({ approvalPolicy: "untrusted", sandboxPolicy: { type: "workspaceWrite" } });
        expect(second).toMatchObject({ approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly" } });
        expect(second.input[0].text).toContain("Plan mode is active");
    });

    test("4. a queued prompt runs under the mode as it is then", async () => {
        const a = await makeAgent({ provider: "codex", mode: "auto", queued: [["and then this"]] });
        // Changed without telling the agent (as answering a permission prompt can).
        const done = a.run("first");
        a.setMode("default");
        await done;
        const [, second] = turnStarts();
        // Manual mode: Codex is told its changes are asked about, not stopped by the read-only sandbox.
        expect(second.input[0].text).toMatch(/^<system-reminder>\nThe sandbox is read-only, but you can still change files and run other commands: each one goes to the user for approval first[\s\S]*\n\nand then this$/);
        expect(second).toMatchObject({ approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly" } });
    });

    test("5. esc stops a Codex that hangs while starting", async () => {
        process.env.FAKE_HANG_INIT = "1";
        const saved = { ...stopTiming };
        Object.assign(stopTiming, { interruptMs: 300, killMs: 300 });
        try {
            const ac = new AbortController();
            const a = await makeAgent({ provider: "codex" });
            const started = Date.now();
            const done = a.run("hi", ac.signal);
            await Bun.sleep(300);
            ac.abort();
            expect(await done).toBe("aborted");
            expect(Date.now() - started).toBeLessThan(5000);
        } finally {
            Object.assign(stopTiming, saved);
        }
    });

    test("5. an interrupt Claude Code ignores (and SIGTERM too) still ends the turn", async () => {
        process.env.FAKE_SCENARIO = "hang";
        process.env.FAKE_IGNORE_STOP = "1";
        const saved = { ...stopTiming };
        Object.assign(stopTiming, { interruptMs: 300, killMs: 300 });
        try {
            const ac = new AbortController();
            const a = await makeAgent({ provider: "claude-code" });
            const done = a.run("go", ac.signal);
            while (!a.events.some((e) => e.type === "tool_start")) await Bun.sleep(10);
            const stopped = Date.now();
            ac.abort();
            expect(await done).toBe("aborted");
            expect(Date.now() - stopped).toBeLessThan(5000);
            expect(logLines().some((l) => l.ignored === "SIGTERM")).toBe(true);
        } finally {
            Object.assign(stopTiming, saved);
        }
    });

    test("5. Claude Code crashing on a queued prompt is an error, not a success", async () => {
        process.env.FAKE_CRASH_ON_SECOND = "1";
        const a = await makeAgent({ provider: "claude-code", ask: () => ({ allow: true }), queued: [["one more thing"]] });
        expect(await a.run("go")).toBe("error");
        expect(notices(a.events).join("\n")).toMatch(/Claude Code stopped/);
    });
});

describe("review findings, round 2", () => {
    const turnStarts = () => received().filter((m) => m.method === "turn/start").map((m) => m.params);
    const granted = () => logLines().find((l) => "granted" in l)?.granted;

    test("a folder grant is refused when a deny rule could match anything in it, with symlinks resolved", () => {
        const real = tempDir("dw-");
        Bun.spawnSync(["mkdir", "-p", join(real, "w", "src"), join(real, "w", "docs")]);
        const link = `${real}-link`;
        symlinkSync(real, link);
        const w = join(link, "w");
        // A bare name matches at any depth; ** spans folders.
        expect(deniedWithin(["Read(.env)"], join(w, "src"), w, "read")).toBe("Read(.env)");
        expect(deniedWithin(["Read(**/secret.txt)"], join(w, "src"), w, "write")).toBe("Read(**/secret.txt)");
        // ** inside a name spans folders too, past a folder that matches its start.
        expect(deniedWithin(["Read(src/**.pem)"], join(w, "src", "nested"), w, "read")).toBe("Read(src/**.pem)");
        expect(deniedWithin(["Read(src/key**)"], join(w, "src", "keys", "old"), w, "write")).toBe("Read(src/key**)");
        expect(deniedWithin(["Read(src/key**)"], join(w, "src", "other"), w, "write")).toBeUndefined();
        expect(deniedWithin(["Read(src/**.pem)"], join(w, "docs"), w, "read")).toBeUndefined();
        // A rule for something inside the folder, written via the link, against the real path; and the other way round.
        expect(deniedWithin([`Read(/${join(w, "src", "secret.txt")})`], join(real, "w", "src"), w, "read")).toBeDefined();
        expect(deniedWithin([`Read(/${join(real, "w", "src")}/**)`], join(w, "src"), w, "read")).toBeDefined();
        // A grant of the whole project, or of the filesystem root, is refused for a rule about part of it.
        expect(deniedWithin(["Edit(src/**)"], w, w, "write")).toBe("Edit(src/**)");
        expect(deniedWithin(["Read(src/secret.txt)"], "/", w, "read")).toBe("Read(src/secret.txt)");
        expect(deniedWithin(["Read(.env)"], "/", w, "read")).toBe("Read(.env)");
        // But not for what can't be in the folder, or for edit rules on a read grant.
        expect(deniedWithin(["Read(src/secret.txt)"], join(w, "docs"), w, "read")).toBeUndefined();
        expect(deniedWithin(["Read(src/*.key)"], join(w, "docs"), w, "write")).toBeUndefined();
        expect(deniedWithin(["Edit(src/**)"], join(w, "src"), w, "read")).toBeUndefined();
        expect(deniedWithin(["Bash(rm:*)"], w, w, "write")).toBeUndefined();
    });

    test("Codex's special paths are resolved; ones that can't be are refused without asking", async () => {
        process.env.FAKE_SCENARIO = "perms";
        // The filesystem root holds the harness's credential store.
        process.env.FAKE_PERMS = JSON.stringify({ network: null, fileSystem: { read: null, write: null, entries: [{ path: { type: "special", value: { kind: "root" } }, access: "write" }] } });
        const root = await makeAgent({ provider: "codex", ask: () => ({ allow: true }) });
        await root.run("go");
        expect(root.asked).toHaveLength(0);
        expect(granted()).toEqual({ permissions: {}, scope: "turn" });
        rmSync(LOG, { force: true });
        process.env.FAKE_PERMS = JSON.stringify({ network: null, fileSystem: { read: null, write: null, entries: [{ path: { type: "special", value: { kind: "minimal" } }, access: "read" }] } });
        const minimal = await makeAgent({ provider: "codex", ask: () => ({ allow: true }) });
        await minimal.run("go");
        expect(minimal.asked).toHaveLength(0);
        expect(granted()).toEqual({ permissions: {}, scope: "turn" });
        expect(notices(minimal.events).join("\n")).toMatch(/Refused Codex's request for access to the special path "minimal"/);
        rmSync(LOG, { force: true });
        // An absolute subpath is the folder Codex opens (it replaces the project root), here the harness's own home.
        process.env.FAKE_PERMS = JSON.stringify({ network: null, fileSystem: { read: null, write: null, entries: [{ path: { type: "special", value: { kind: "project_roots", subpath: process.env.HARNESS_HOME } }, access: "write" }] } });
        const store = await makeAgent({ provider: "codex", ask: () => ({ allow: true }) });
        await store.run("go");
        expect(store.asked).toHaveLength(0);
        expect(granted()).toEqual({ permissions: {}, scope: "turn" });
        const roots = ["/w", "/extra"];
        const entries = [
            { path: { type: "path", path: "/b" }, access: "write" },
            { path: { type: "special", value: { kind: "project_roots", subpath: "out" } }, access: "write" },
            { path: { type: "glob_pattern", pattern: "/c/**/*.txt" }, access: "read" },
            { path: { type: "special", value: { kind: "root" } }, access: "deny" },
        ];
        expect(requestedPaths({ fileSystem: { read: ["/a"], write: null, entries }, network: { enabled: true } }, roots)).toEqual({ read: ["/a", "/c"], write: ["/b", "/w/out", "/extra/out"], network: true, unknown: [] });
        expect(requestedPaths({ somethingNew: { x: 1 } }, roots).unknown).toHaveLength(1);
        const special = (subpath: string) => requestedPaths({ fileSystem: { entries: [{ path: { type: "special", value: { kind: "project_roots", subpath } }, access: "write" }] } }, roots).write;
        expect(special("/etc")).toEqual(["/etc"]);
        expect(special("../up")).toEqual(["/up"]);
    });

    test("esc while Codex resumes its thread keeps the thread", async () => {
        const a = await makeAgent({ provider: "codex", settings: { permissions: { allow: ["Bash(touch:*)"] } } });
        await a.run("one");
        expect(a.session.backends.get("codex")?.id).toBe("thr-new");
        process.env.FAKE_SLOW_RESUME = "3000";
        const ac = new AbortController();
        const done = a.run("two", ac.signal);
        while (!received().some((m) => m.method === "thread/resume")) await Bun.sleep(10);
        ac.abort();
        expect(await done).toBe("aborted");
        expect(a.session.backends.get("codex")?.id).toBe("thr-new");
        expect(notices(a.events).join("\n")).not.toMatch(/resume/i);
    });

    test("switching to plan mode while Codex starts its turn still stops it", async () => {
        process.env.FAKE_SCENARIO = "slow";
        process.env.FAKE_SLOW_TURN_START = "500";
        const a = await makeAgent({ provider: "codex", mode: "auto" });
        const done = a.run("work");
        while (!received().some((m) => m.method === "turn/start")) await Bun.sleep(5);
        a.switchMode("plan");
        await done;
        expect(received().some((m) => m.method === "turn/interrupt")).toBe(true);
        const [first, second] = turnStarts();
        expect(first).toMatchObject({ approvalPolicy: "on-request" });
        expect(second).toMatchObject({ approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly" } });
    });
});

describe("patch previews", () => {
    test("hunks apply to the file; ones that don't fit give up", () => {
        expect(applyHunks("a\nb\nc\n", "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n")).toBe("a\nB\nc\n");
        expect(applyHunks("1\n2\n3\n4\n5\n6\n", "@@ -2,1 +2,2 @@\n-2\n+two\n+2b\n@@ -5,1 +6,1 @@\n-5\n+five\n")).toBe("1\ntwo\n2b\n3\n4\nfive\n6\n");
        expect(applyHunks("a\nb\n", "@@ -1,1 +1,1 @@\n-x\n+y\n")).toBeUndefined();
    });

    test("an added file shows its contents; an update shows before and after", () => {
        const dir = tempDir("patch-");
        writeFileSync(join(dir, "a.txt"), "line1\nline2\n");
        expect(changePreview({ path: join(dir, "new.txt"), kind: "add", diff: "hello\n" }, dir)).toEqual({ diff: { path: "new.txt", before: "", after: "hello\n" } });
        expect(changePreview({ path: join(dir, "a.txt"), kind: "update", diff: "@@ -1,2 +1,2 @@\n line1\n-line2\n+line two\n" }, dir)).toEqual({ diff: { path: "a.txt", before: "line1\nline2\n", after: "line1\nline two\n" } });
    });
});

describe("backend sessions in the session file", () => {
    test("survive a reload; a rewind past them or a compaction forgets them", () => {
        const s = Session.create(cwd);
        s.push({ role: "user", content: [{ type: "text", text: "a" }], meta: { kind: "prompt" } });
        s.push({ role: "assistant", content: [{ type: "text", text: "b" }], provider: "claude-code", model: "default" });
        s.setBackendSession("claude-code", "sess-1", 2);
        s.setBackendSession("codex", "thr-1", 1);
        expect(Object.fromEntries(Session.load(s.path).backends)).toEqual({ "claude-code": { id: "sess-1", synced: 2 }, codex: { id: "thr-1", synced: 1 } });
        s.rewind(1);
        expect([...Session.load(s.path).backends.keys()]).toEqual(["codex"]);
        s.forgetBackendSession("codex");
        expect(Session.load(s.path).backends.size).toBe(0);
        s.setBackendSession("codex", "thr-2", 1);
        s.compact("summary", []);
        expect(Session.load(s.path).backends.size).toBe(0);
    });
});


describe("fast mode backend wiring", () => {
    test("codex: standard takes a thread off a fast tier (an earlier fast turn, or Codex's own config), and leaves flex alone", async () => {
        for (const [env, tier, want] of [["FAKE_THREAD_TIER", "priority", null], ["FAKE_THREAD_TIER", "fast", null], ["FAKE_THREAD_TIER", "flex", undefined], ["FAKE_CONFIG_TIER", "priority", null]] as const) {
            delete process.env.FAKE_THREAD_TIER;
            delete process.env.FAKE_CONFIG_TIER;
            rmSync(LOG + ".tiers.json", { force: true });
            process.env[env] = tier;
            const { run, session } = await makeAgent({ provider: "codex", model: { supportsFastMode: true, fastModeTier: "priority" }, settings: { fastMode: false } });
            if (env === "FAKE_THREAD_TIER") session.setBackendSession("codex", "thr-old", 0);
            await run("hello");
            const turn = received().filter((m) => m.method === "turn/start").at(-1);
            if (want === null) expect(turn.params.serviceTier).toBeNull();
            else expect("serviceTier" in turn.params).toBe(false);
        }
    });

    test("codex: a speed change between the turns of one run (a queued message after it) applies to the next turn", async () => {
        // Changed as the first turn ends, when the message waiting after it is taken.
        let change = () => {};
        const waiting = [["and then this"], ["and this"]];
        const drainQueued = () => (waiting.length === 2 && change(), waiting.shift() ?? []);
        const a = await makeAgent({ provider: "codex", model: { supportsFastMode: true, fastModeTier: "priority" }, settings: { fastMode: true }, drainQueued });
        change = () => a.session.setFastMode(false);
        await a.run("first");
        const [first, second, third] = received().filter((m) => m.method === "turn/start").map((m) => m.params);
        expect(first.serviceTier).toBe("priority");
        // Off the fast tier once; the thread is on standard after that.
        expect(second.serviceTier).toBeNull();
        expect("serviceTier" in third).toBe(false);
    });

    test("codex: fast, then standard in the same session, ends with the thread back on standard", async () => {
        const { run, session } = await makeAgent({ provider: "codex", model: { supportsFastMode: true, fastModeTier: "priority" }, settings: { fastMode: true } });
        await run("fast one");
        session.setFastMode(false);
        await run("standard one");
        const turns = received().filter((m) => m.method === "turn/start");
        expect(turns[0].params.serviceTier).toBe("priority");
        expect(turns.at(-1).params.serviceTier).toBeNull();
    });

    test("a final fast-mode cooldown does not erase earlier paid credit usage", async () => {
        process.env.FAKE_FAST_MODE_END = "cooldown";
        const { run, session, events } = await makeAgent({ provider: "claude-code", model: { supportsFastMode: true }, settings: { fastMode: true } });
        await run("hello");
        expect(session.cost).toBe(0.5);
        expect(notices(events).some((m) => m.includes("total estimate"))).toBe(true);
    });
    for (const provider of ["claude-code", "codex"] as const) {
        for (const supported of [true, false]) test(`${provider}: fast mode ${supported ? "is requested" : "is gated"} without changing effort`, async () => {
            const { run } = await makeAgent({ provider, model: { id: "default", supportsFastMode: supported, fastModeTier: "priority", effortLevels: ["high"] }, settings: { fastMode: true, effort: "high" } });
            await run("hello");
            if (provider === "codex") {
                const thread = received().find((m) => m.method === "thread/start");
                const turn = received().find((m) => m.method === "turn/start");
                // Without fast, nothing is sent: a Codex from before "default" was a tier name would refuse it.
                if (supported) {
                    expect(thread.params.serviceTier).toBe("priority");
                    expect(turn.params.serviceTier).toBe("priority");
                } else {
                    expect("serviceTier" in thread.params).toBe(false);
                    expect("serviceTier" in turn.params).toBe(false);
                }
                expect(turn.params.effort).toBe("high");
            } else {
                const a = starts()[0]!.argv as string[];
                expect(JSON.parse(a[a.indexOf("--settings") + 1]!).fastMode).toBe(supported);
                expect(a[a.indexOf("--effort") + 1]).toBe("high");
            }
        });
        test(`${provider}: explicit standard session overrides fast default and resume`, async () => {
            const { run, session } = await makeAgent({ provider, model: { supportsFastMode: true, fastModeTier: "priority" }, settings: { fastMode: true } });
            session.setFastMode(false);
            await run("hello");
            await run("again");
            if (provider === "codex") {
                expect(received().filter((m) => m.method === "turn/start").every((m) => !("serviceTier" in m.params))).toBe(true);
                expect("serviceTier" in received().find((m) => m.method === "thread/resume").params).toBe(false);
            } else {
                for (const { argv: a } of starts()) expect(JSON.parse(a[a.indexOf("--settings") + 1]).fastMode).toBe(false);
            }
        });
    }
});

// A forked session and its original never go on with the same backend
// session: whichever goes on with a shared one first forks it (natively), and
// one that saw past the fork point isn't shared at all.
describe("forked sessions", () => {
    for (const provider of ["claude-code", "codex"] as const) for (const change of ["none", "selection", "folder"] as const) test(`${provider}: named-account fork with ${change} change respects the source folder`, async () => {
        const { addAccount, removeAccount } = await import("../src/providers/accounts");
        const selected = addAccount(provider, { id: "fork-work", name: "Fork work" });
        const other = addAccount(provider, { id: "fork-other", name: "Fork other" });
        const source = Session.create(cwd);
        source.setAccount(provider, selected.id);
        const settings = { delegation: false, permissions: { allow: ["Bash(touch:*)"] } };
        const orig = await makeAgent({ provider, session: source, settings, ask: () => ({ allow: true }) });
        let fork: Awaited<ReturnType<typeof makeAgent>> | undefined;
        let replacement = selected;
        try {
            await orig.run("first on work");
            const shared = source.backends.get(provider)!.id;
            if (change === "folder") {
                // A catalog change before forking must not relabel the source thread's owner.
                removeAccount(provider, selected.id, selected.folder);
                replacement = addAccount(provider, { id: selected.id, name: selected.name, folder: join(bin, `${provider}-replacement`) });
            }
            const session = forkSession(source, { cut: source.messages.length });
            expect(session.accountId(provider)).toBe(selected.id);
            expect(session.backendSession(provider, selected.folder)).toMatchObject({ id: shared, fork: true });
            if (change === "selection") session.setAccount(provider, other.id);
            session.release();
            fork = await makeAgent({ provider, session: Session.load(session.path), settings, ask: () => ({ allow: true }) });
            rmSync(LOG, { force: true });
            expect(await fork.run("in the fork")).toBe("done");
            const folder = change === "selection" ? other.folder : replacement.folder;
            expect(starts()[0][provider === "codex" ? "codexHome" : "claudeConfigDir"]).toBe(folder);
            if (provider === "claude-code") {
                expect(resumes()).toEqual([change === "none" ? `${shared} (fork)` : "new"]);
                if (change !== "none") expect(userTexts().at(-1)).toContain("User: first on work");
            } else {
                const threads = received().filter((m) => m.method?.startsWith("thread/") && !m.method.startsWith("thread/goal/"));
                expect(threads.map((m) => m.method)).toEqual([change === "none" ? "thread/fork" : "thread/start"]);
                if (change === "none") expect(threads[0].params.threadId).toBe(shared);
                else expect(JSON.stringify(received().find((m) => m.method === "turn/start")?.params.input)).toContain("User: first on work");
            }
            expect(fork.session.backendSession(provider, folder)?.fork).toBeUndefined();
            expect(source.backendSession(provider, selected.folder)).toMatchObject({ id: shared, fork: true });
        } finally {
            await fork?.agent.dispose();
            fork?.session.release();
            await orig.agent.dispose();
            source.release();
            removeAccount(provider, replacement.id, replacement.folder);
            removeAccount(provider, other.id, other.folder);
        }
    });

    /** Each Claude Code start: the session it resumed, and whether as a fork. */
    const resumes = () => starts().map((s) => {
        const a = s.argv as string[];
        const i = a.indexOf("--resume");
        return i < 0 ? "new" : `${a[i + 1]}${a.includes("--fork-session") ? " (fork)" : ""}`;
    });

    test("Claude Code: the fork's first turn forks the shared session (--resume … --fork-session), and so does the original's next one", async () => {
        const orig = await makeAgent({ provider: "claude-code", session: Session.create(cwd), ask: () => ({ allow: true }) });
        await orig.run("first");
        const shared = orig.session.backends.get("claude-code")!.id;
        const fork = await makeAgent({ provider: "claude-code", session: forkSession(orig.session, { cut: orig.session.messages.length }), ask: () => ({ allow: true }) });
        rmSync(LOG, { force: true });

        expect(await fork.run("in the fork")).toBe("done");
        const forkId = fork.session.backends.get("claude-code")!;
        expect(resumes()).toEqual([`${shared} (fork)`]);
        expect(forkId.id).toMatch(/^fork-/);
        expect(forkId.fork).toBeUndefined();
        // It had everything already: no conversation handed over.
        expect(userTexts().at(-1)).toBe("in the fork");

        await orig.run("in the original");
        const origId = orig.session.backends.get("claude-code")!.id;
        expect(origId).toMatch(/^fork-/);
        expect(origId).not.toBe(forkId.id);
        await orig.run("again");
        await fork.run("again in the fork");
        // From then on each goes on with its own; the shared one is never continued in place.
        expect(resumes()).toEqual([`${shared} (fork)`, `${shared} (fork)`, origId, forkId.id]);
        expect(resumes()).not.toContain(shared);
    });

    test("Claude Code: a compaction of a shared session compacts a copy of it", async () => {
        const orig = await makeAgent({ provider: "claude-code", session: Session.create(cwd), ask: () => ({ allow: true }) });
        await orig.run("first");
        const shared = orig.session.backends.get("claude-code")!.id;
        forkSession(orig.session, { cut: orig.session.messages.length }).release();
        rmSync(LOG, { force: true });
        expect(await orig.agent.compact({ auto: false, signal: new AbortController().signal })).toBe(true);
        expect(resumes()).toEqual([`${shared} (fork)`]);
        expect(orig.session.backends.get("claude-code")!.id).not.toBe(shared);
    });

    test("Claude Code: a fork from before the backend's last turn starts a new session with the conversation up to the fork", async () => {
        const orig = await makeAgent({ provider: "claude-code", session: Session.create(cwd), ask: () => ({ allow: true }) });
        await orig.run("first");
        await orig.run("second");
        const shared = orig.session.backends.get("claude-code")!;
        const session = forkSession(orig.session, { cut: forkCut(orig.session.messages, 0) });
        expect(session.backends.size).toBe(0);
        const fork = await makeAgent({ provider: "claude-code", session, ask: () => ({ allow: true }) });
        rmSync(LOG, { force: true });
        await fork.run("in the fork");
        expect(resumes()).toEqual(["new"]);
        const prompt = userTexts().at(-1)!;
        expect(prompt).toContain("<conversation-so-far>");
        expect(prompt).toContain("User: first");
        expect(prompt).not.toContain("second");
        // The original's own goes on as before: it saw nothing of the fork.
        expect(orig.session.backends.get("claude-code")).toEqual(shared);
        await orig.run("third");
        expect(resumes().at(-1)).toBe(shared.id);
    });

    test("Codex: the fork's first turn forks the shared thread (thread/fork), and so does the original's next one", async () => {
        const settings = { permissions: { allow: ["Bash(touch:*)"] } };
        const orig = await makeAgent({ provider: "codex", session: Session.create(cwd), settings });
        await orig.run("one");
        expect(orig.session.backends.get("codex")?.id).toBe("thr-new");
        const fork = await makeAgent({ provider: "codex", session: forkSession(orig.session, { cut: orig.session.messages.length }), settings });
        rmSync(LOG, { force: true });
        await fork.run("in the fork");
        const threads = () => received().filter((m) => m.method?.startsWith("thread/") && !m.method.startsWith("thread/goal/")).map((m) => `${m.method} ${m.params.threadId ?? ""}`.trim());
        expect(threads()).toEqual(["thread/fork thr-new"]);
        const forkThread = fork.session.backends.get("codex")!.id;
        expect(forkThread).toMatch(/^thr-fork-/);
        expect(received().find((m) => m.method === "turn/start")?.params.threadId).toBe(forkThread);
        // The forked thread's total includes the original's spend; only the fork's own turn is counted here.
        const tokensOf = (s: typeof orig.session) => [...s.usageByModel.values()].reduce((n, x) => n + x.usage.inputTokens + x.usage.outputTokens + (x.usage.cacheReadTokens ?? 0), 0);
        expect(tokensOf(fork.session)).toBeGreaterThan(0);
        expect(tokensOf(fork.session)).toBe(tokensOf(orig.session));

        await orig.run("in the original");
        const origThread = orig.session.backends.get("codex")!.id;
        expect(origThread).toMatch(/^thr-fork-/);
        expect(origThread).not.toBe(forkThread);
        await orig.run("again");
        expect(threads()).toEqual(["thread/fork thr-new", "thread/fork thr-new", `thread/resume ${origThread}`]);
    });

    test("Codex: a compaction of a shared thread compacts its own copy", async () => {
        const orig = await makeAgent({ provider: "codex", session: Session.create(cwd), settings: { permissions: { allow: ["Bash(touch:*)"] } } });
        await orig.run("first");
        const shared = orig.session.backends.get("codex")!.id;
        forkSession(orig.session, { cut: orig.session.messages.length }).release();
        rmSync(LOG, { force: true });
        expect(await orig.agent.compact({ auto: false, signal: new AbortController().signal })).toBe(true);
        const own = orig.session.backends.get("codex")!.id;
        expect(own).not.toBe(shared);
        expect(received().find((m) => m.method === "thread/fork")?.params.threadId).toBe(shared);
        expect(received().find((m) => m.method === "thread/compact/start")?.params.threadId).toBe(own);
    });

    test("an interrupted native fork leaves its shared source's synced position unchanged", async () => {
        const settings = { permissions: { allow: ["Bash(touch:*)"] } };
        const orig = await makeAgent({ provider: "codex", session: Session.create(cwd), settings });
        await orig.run("first");
        const fork = await makeAgent({ provider: "codex", session: forkSession(orig.session, { cut: orig.session.messages.length }), settings });
        const shared = { ...fork.session.backends.get("codex")! };
        process.env.FAKE_HANG_INIT = "1";
        const ac = new AbortController();
        try {
            const done = fork.run("the interrupted prompt", ac.signal);
            await Bun.sleep(300);
            ac.abort();
            expect(await done).toBe("aborted");
        } finally {
            delete process.env.FAKE_HANG_INIT;
        }
        expect(fork.session.backends.get("codex")).toEqual(shared);
        rmSync(LOG, { force: true });
        expect(await fork.run("try again")).toBe("done");
        expect(received().find((m) => m.method === "thread/fork")?.params.threadId).toBe(shared.id);
        expect(JSON.stringify(received().find((m) => m.method === "turn/start")?.params.input)).toContain("the interrupted prompt");
    });

    for (const provider of ["claude-code", "codex"] as const) test(`${provider}: a missing native fork source falls back to fresh context`, async () => {
        const settings = { permissions: { allow: ["Bash(touch:*)"] } };
        const orig = await makeAgent({ provider, session: Session.create(cwd), settings, ask: () => ({ allow: true }) });
        await orig.run("first");
        orig.session.setBackendSession(provider, "gone-source", orig.session.messages.length);
        const fork = await makeAgent({ provider, session: forkSession(orig.session, { cut: orig.session.messages.length }), settings, ask: () => ({ allow: true }) });
        rmSync(LOG, { force: true });
        expect(await fork.run("in the fork")).toBe("done");
        if (provider === "claude-code") {
            expect(resumes()).toEqual(["gone-source (fork)", "new"]);
            expect(userTexts().at(-1)).toContain("User: first");
        } else {
            expect(received().filter((m) => m.method?.startsWith("thread/") && !m.method.startsWith("thread/goal/")).map((m) => m.method)).toEqual(["thread/fork", "thread/start"]);
            expect(JSON.stringify(received().find((m) => m.method === "turn/start")?.params.input)).toContain("User: first");
        }
        expect(fork.session.backends.get(provider)?.fork).toBeUndefined();
        expect(orig.session.backends.get(provider)).toEqual({ id: "gone-source", synced: orig.session.messages.length, fork: true });
    });

    test("Codex: a fork from before the thread's last turn starts a new thread with the conversation as context", async () => {
        const settings = { permissions: { allow: ["Bash(touch:*)"] } };
        const orig = await makeAgent({ provider: "codex", session: Session.create(cwd), settings });
        await orig.run("one");
        await orig.run("two");
        const fork = await makeAgent({ provider: "codex", session: forkSession(orig.session, { cut: forkCut(orig.session.messages, 0) }), settings });
        rmSync(LOG, { force: true });
        await fork.run("in the fork");
        expect(received().filter((m) => m.method?.startsWith("thread/") && !m.method.startsWith("thread/goal/")).map((m) => m.method)).toEqual(["thread/start"]);
        const input = JSON.stringify(received().find((m) => m.method === "turn/start")?.params.input);
        expect(input).toContain("conversation-so-far");
        expect(input).toContain("User: one");
        expect(input).not.toContain("User: two");
        expect(orig.session.backends.get("codex")?.fork).toBeUndefined();
    });
});

describe("Claude Code project MCP settings", () => {
    test("trusted turns retain native user MCP while passing project approval names only", async () => {
        const { McpManager } = await import("../src/mcp/manager");
        const cfg = { command: "unused", env: { PRIVATE: "not-in-argv" } };
        writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { approved: cfg, pending: cfg } }));
        saveApproval(cwd, "approved", mcpFingerprint(cfg, cwd));
        const manager = new McpManager(cwd, () => loadSettings(cwd, { trusted: true }), true);
        manager.load();
        const { run } = await makeAgent({ provider: "claude-code", trusted: true, approvedMcpServers: () => manager.approvedServers() });
        expect(await run("hello")).toBe("done");
        const argv = starts()[0].argv;
        expect(argv).not.toContain("--strict-mcp-config");
        expect(JSON.parse(argv[argv.indexOf("--settings") + 1])).toMatchObject({ enabledMcpjsonServers: ["approved"], disabledMcpjsonServers: ["harness", "pending"] });
        expect(JSON.stringify(argv)).not.toContain("not-in-argv");
        expect(received().some((m) => m.request?.subtype === "mcp_set_servers")).toBe(false);
    });
});

describe("Claude Code MCP approval boundary", () => {
    const payloads = () => received().filter((m) => m.request?.subtype === "mcp_set_servers").map((m) => m.request.servers);
    const sentinel = "private-env-sentinel-123";
    const config = () => ({ command: "unused", args: ["./server.js"], env: { SENTINEL: sentinel } });
    const settingsFor = (start: any) => JSON.parse(start.argv[start.argv.indexOf("--settings") + 1]);

    for (const trusted of [false, true]) for (const readOnly of [false, true]) {
        test(`strict MCP for trusted=${trusted}, readOnly=${readOnly}, with no manager`, async () => {
            const { run } = await makeAgent({ provider: "claude-code", trusted, readOnly });
            await run("hello");
            expect(starts()[0].argv).toContain("--strict-mcp-config");
            expect(payloads()).toEqual([]);
        });
    }

    for (const [trusted, readOnly] of [[false, false], [false, true], [true, true]] as const) {
        test(`a populated manager cannot bypass strict MCP for trusted=${trusted}, readOnly=${readOnly}`, async () => {
            const { McpManager } = await import("../src/mcp/manager");
            writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { approved: config() } }));
            saveApproval(cwd, "approved", mcpFingerprint(config(), cwd));
            const manager = new McpManager(cwd, () => loadSettings(cwd, { trusted: true }), true);
            manager.load();
            const { run } = await makeAgent({ provider: "claude-code", trusted, readOnly, approvedMcpServers: () => manager.approvedServers() });
            expect(await run("hello")).toBe("done");
            expect(starts()[0].argv).toContain("--strict-mcp-config");
            if (!trusted) expect(starts()[0].argv).toEqual(expect.arrayContaining(["--setting-sources", "user"]));
            expect(settingsFor(starts()[0]).enabledMcpjsonServers).toBeUndefined();
            expect(payloads()).toEqual([]);
        });
    }

    for (const cause of ["missing manager", "malformed file", "ancestor file"]) {
        test(`${cause} falls back with one static warning`, async () => {
            const parent = tempDir("backend-mcp-scope-");
            cwd = join(parent, "workspace");
            mkdirSync(cwd);
            if (cause === "malformed file") writeFileSync(join(cwd, ".mcp.json"), sentinel);
            if (cause === "ancestor file") writeFileSync(join(parent, ".mcp.json"), JSON.stringify({ mcpServers: { unknown: config() } }));
            const { run, events } = await makeAgent({
                provider: "claude-code", trusted: true,
                approvedMcpServers: cause === "missing manager" ? undefined : () => ({ cwd, servers: {} }),
            });
            expect(await run("hello")).toBe("done");
            expect(starts()[0].argv).toContain("--strict-mcp-config");
            expect(payloads()).toEqual([]);
            const warnings = notices(events).filter((n) => n.startsWith("warn:"));
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain("strict MCP isolation");
            expect(JSON.stringify(events)).not.toContain(sentinel);
        });
    }

    test("an add-dir project's MCP configuration does not restrict native servers", async () => {
        const extra = tempDir("backend-extra-mcp-");
        writeFileSync(join(extra, ".mcp.json"), JSON.stringify({ mcpServers: { unseen: config() } }));
        const { run } = await makeAgent({
            provider: "claude-code", trusted: true,
            settings: { permissions: { additionalDirectories: [extra] } },
            approvedMcpServers: () => ({ cwd, servers: {} }),
        });
        expect(await run("hello")).toBe("done");
        expect(starts()[0].argv).toEqual(expect.arrayContaining(["--add-dir", extra]));
        expect(starts()[0].argv).not.toContain("--strict-mcp-config");
        expect(settingsFor(starts()[0])).toMatchObject({ enabledMcpjsonServers: [], disabledMcpjsonServers: ["harness"] });
    });

    test("only unchanged project approvals reach settings, and changes apply next turn", async () => {
        const { McpManager } = await import("../src/mcp/manager");
        const cfg = config();
        writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: {
            approved: cfg, pending: cfg, rejected: cfg, disabled: { ...cfg, disabled: true },
            same__name: cfg, shadowed: cfg, harness: cfg,
        } }));
        const settings = {
            mcpServers: { settings: cfg, same_name: cfg, shadowed: cfg },
            approvedMcpjsonServers: Object.fromEntries(["approved", "disabled", "same__name", "shadowed", "harness"].map((name) => [name, mcpFingerprint(cfg, cwd)])),
            disabledMcpjsonServers: ["rejected"],
        };
        const manager = new McpManager(cwd, () => settings, true);
        manager.load();
        const { run, events, session } = await makeAgent({ provider: "claude-code", trusted: true, approvedMcpServers: () => manager.approvedServers() });
        expect(await run("hello")).toBe("done");
        expect(settingsFor(starts()[0])).toMatchObject({
            enabledMcpjsonServers: ["approved"],
            disabledMcpjsonServers: ["disabled", "harness", "pending", "rejected", "same__name", "shadowed"],
        });
        expect(starts()[0].argv).not.toContain("--strict-mcp-config");
        expect(payloads()).toEqual([]);
        expect(JSON.stringify(starts())).not.toContain(sentinel);
        expect(JSON.stringify(events)).not.toContain(sentinel);
        expect(JSON.stringify(session.messages)).not.toContain(sentinel);
        settings.approvedMcpjsonServers.pending = mcpFingerprint(cfg, cwd);
        manager.load();
        expect(await run("again")).toBe("done");
        expect(settingsFor(starts()[1]).enabledMcpjsonServers).toEqual(["approved", "pending"]);
    });

    test("a changed definition is disabled through reload until its new fingerprint is approved", async () => {
        const { McpManager } = await import("../src/mcp/manager");
        writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { approved: config() } }));
        saveApproval(cwd, "approved", mcpFingerprint(config(), cwd));
        const manager = new McpManager(cwd, () => loadSettings(cwd, { trusted: true }), true);
        manager.load();
        const { run } = await makeAgent({ provider: "claude-code", trusted: true, approvedMcpServers: () => manager.approvedServers() });
        expect(await run("hello")).toBe("done");
        writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { approved: { ...config(), command: "changed" } } }));
        expect(await run("again")).toBe("done");
        expect(settingsFor(starts()[1])).toMatchObject({ enabledMcpjsonServers: [], disabledMcpjsonServers: ["approved", "harness"] });
        manager.load();
        expect(await run("reloaded")).toBe("done");
        expect(settingsFor(starts()[2])).toMatchObject({ enabledMcpjsonServers: [], disabledMcpjsonServers: ["approved", "harness"] });
        saveApproval(cwd, "approved", mcpFingerprint({ ...config(), command: "changed" }, cwd));
        manager.load();
        expect(await run("approved again")).toBe("done");
        expect(settingsFor(starts()[3]).enabledMcpjsonServers).toEqual(["approved"]);
    });

    test("a throwing manager fails closed without echoing its error", async () => {
        const { run, events } = await makeAgent({
            provider: "claude-code", trusted: true,
            approvedMcpServers: () => {
                throw new Error(sentinel);
            },
        });
        expect(await run("hello")).toBe("done");
        expect(starts()[0].argv).toContain("--strict-mcp-config");
        expect(payloads()).toEqual([]);
        expect(notices(events).filter((n) => n.startsWith("warn:"))).toHaveLength(1);
        expect(JSON.stringify(events)).not.toContain(sentinel);
    });

    test("approved project servers do not enter the attach wait", async () => {
        const { McpManager } = await import("../src/mcp/manager");
        writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { approved: config() } }));
        saveApproval(cwd, "approved", mcpFingerprint(config(), cwd));
        const manager = new McpManager(cwd, () => loadSettings(cwd, { trusted: true }), true);
        manager.load();
        process.env.FAKE_MCP_REFUSE = "hang";
        try {
            const { run, events } = await makeAgent({ provider: "claude-code", trusted: true, approvedMcpServers: () => manager.approvedServers() });
            expect(await run("hello")).toBe("done");
            expect(payloads()).toEqual([]);
            expect(notices(events).some((n) => n.includes("timed out"))).toBe(false);
        } finally {
            delete process.env.FAKE_MCP_REFUSE;
        }
    });

    for (const ending of ["normal", "failed", "aborted"]) test(`project definition secrets stay out of argv and transcripts when ${ending}`, async () => {
        const { McpManager } = await import("../src/mcp/manager");
        writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { approved: config() } }));
        saveApproval(cwd, "approved", mcpFingerprint(config(), cwd));
        const manager = new McpManager(cwd, () => loadSettings(cwd, { trusted: true }), true);
        manager.load();
        process.env.FAKE_SCENARIO = ending === "aborted" ? "hang" : "write";
        if (ending === "failed") process.env.FAKE_CRASH_ON_SECOND = "1";
        const ac = new AbortController();
        const { run, events, session } = await makeAgent({ provider: "claude-code", trusted: true, queued: ending === "failed" ? [["again"]] : [], approvedMcpServers: () => manager.approvedServers() });
        const done = run("hello", ac.signal);
        if (ending === "aborted") {
            while (!events.some((e) => e.type === "tool_start")) await Bun.sleep(10);
            ac.abort();
        }
        expect(await done).toBe(ending === "failed" ? "error" : ending === "aborted" ? "aborted" : "done");
        expect(payloads()).toEqual([]);
        for (const start of starts()) {
            expect(start.argv).not.toContain("--strict-mcp-config");
            expect(start.argv).not.toContain("--mcp-config");
            expect(JSON.stringify(start.argv)).not.toContain(sentinel);
        }
        expect(JSON.stringify(events)).not.toContain(sentinel);
        expect(JSON.stringify(session.messages)).not.toContain(sentinel);
    });
});


describe("Codex project MCP boundary", () => {
    test("trusted threads disable project servers, including project modifications to user servers", async () => {
        process.env.FAKE_USER_MCP = JSON.stringify({ personal: { command: "personal" }, shared: { command: "original" } });
        process.env.FAKE_PROJECT_MCP = JSON.stringify({ project: { command: "hostile" }, shared: { env: { OVERRIDE: "hostile" } }, "dotted.name": { command: "hostile" } });
        const { run } = await makeAgent({ provider: "codex", trusted: true });
        await run("hello");
        expect(received().find((m) => m.method === "config/read").params).toEqual({ cwd, includeLayers: true });
        const config = received().find((m) => m.method === "thread/start").params.config;
        expect(config).toEqual({ mcp_servers: { project: { enabled: false }, shared: { enabled: false }, "dotted.name": { enabled: false } } });
        await run("resume");
        expect(received().find((m) => m.method === "thread/resume").params.config).toEqual(config);
    });

    for (const layers of [
        [],
        [{ name: { type: "unknown" }, config: { mcp_servers: { personal: {} } } }],
        [{ name: { type: "project" }, config: { mcp_servers: { personal: {} } }, disabledReason: {} }],
    ]) test(`incomplete provenance disables servers in thread start and resume: ${JSON.stringify(layers)}`, async () => {
        process.env.FAKE_USER_MCP = JSON.stringify({ personal: { command: "personal" } });
        process.env.FAKE_CONFIG_LAYERS = JSON.stringify(layers);
        const { run, events } = await makeAgent({ provider: "codex", trusted: true });
        expect(await run("hello")).toBe("done");
        expect(await run("resume")).toBe("done");
        for (const method of ["thread/start", "thread/resume"]) {
            expect(received().find((m) => m.method === method).params.config).toEqual({ mcp_servers: { personal: { enabled: false } } });
        }
        expect(notices(events).join("\n")).toContain("all configured MCP servers are disabled");
    });

    test("missing provenance disables all configured servers, and a failed read prevents the turn", async () => {
        process.env.FAKE_USER_MCP = JSON.stringify({ personal: { command: "personal" } });
        process.env.FAKE_NO_CONFIG_LAYERS = "1";
        const { run, events } = await makeAgent({ provider: "codex", trusted: true });
        await run("hello");
        expect(received().find((m) => m.method === "thread/start").params.config).toEqual({ mcp_servers: { personal: { enabled: false } } });
        expect(notices(events).join("\n")).toContain("all configured MCP servers are disabled");
        rmSync(LOG, { force: true });
        process.env.FAKE_NO_CONFIG_READ = "1";
        const second = await makeAgent({ provider: "codex", trusted: true });
        expect(await second.run("hello")).toBe("error");
        expect(received().some((m) => m.method === "thread/start")).toBe(false);
    });
});

describe("attachments", () => {
    const file = { type: "file", kind: "text", name: "notes.md", size: 7, lines: 1, text: "# todo\n" } as const;
    const pdf = { type: "file", kind: "pdf", name: "spec.pdf", size: 9, mediaType: "application/pdf", data: Buffer.from("%PDF-1.4\n").toString("base64") } as const;
    const signal = () => new AbortController().signal;

    test("Claude Code gets text files framed in its prompt, and PDFs as document blocks", async () => {
        const { agent } = await makeAgent({ provider: "claude-code", ask: () => ({ allow: true }) });
        await agent.run([{ type: "text", text: "read these" }, file, pdf], { signal: signal() });
        const content = received().find((m) => m.type === "user").message.content;
        expect(content[0].type).toBe("text");
        expect(content[0].text.startsWith(`read these\n\n${framedText(file)}`)).toBe(true);
        expect(content.slice(1)).toEqual([{ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.data } }]);
    });

    test("Codex gets text files framed in its prompt; a PDF isn't sent, only named", async () => {
        const { agent } = await makeAgent({ provider: "codex", ask: () => ({ allow: true }) });
        await agent.run([{ type: "text", text: "read these" }, file, pdf], { signal: signal() });
        const start = received().find((m) => m.method === "turn/start").params;
        expect(start.input).toHaveLength(1);
        expect(start.input[0].type).toBe("text");
        expect(start.input[0].text).toContain(`read these\n\n${framedText(file)}\n\n${pdfPlaceholder(pdf)}`);
        expect(JSON.stringify(start)).not.toContain(pdf.data);
    });
});

describe("Claude Code turn reliability (#60, #61, #64)", () => {
    test("queued messages reach the running turn at a tool result, in order and before its result", async () => {
        process.env.FAKE_SCENARIO = "steering";
        const a = await makeAgent({ provider: "claude-code", queued: [["first correction", "second correction"]] });
        expect(await a.run("start")).toBe("done");
        expect(logLines().find((l) => l.foldedBeforeResult)?.foldedBeforeResult).toEqual(["first correction\n\nsecond correction"]);
        const timeline = a.session.messages.map((m) => [m.role, m.content.map((p: any) => p.text ?? "").join("\n")]);
        expect(timeline.map(([role]) => role)).toEqual(["user", "assistant", "user", "assistant"]);
        expect(timeline[1]![1]).toContain("Working on it.");
        expect(timeline[2]![1]).toBe("first correction\n\nsecond correction");
        expect(timeline[3]![1]).toContain("Adjusted: first correction");
        expect(timeline[3]![1]).not.toContain("Working on it.");
        expect(starts()).toHaveLength(1);
    });

    for (const version of ["2.1.200", "unknown"]) test(`${version}: unverified CLI versions retain between-turn delivery without losing queued input`, async () => {
        process.env.FAKE_CLAUDE_VERSION = version;
        process.env.FAKE_SCENARIO = "steering";
        process.env.FAKE_SECOND_SCENARIO = "none";
        const a = await makeAgent({ provider: "claude-code", queued: [["queued correction"]] });
        expect(await a.run("start")).toBe("done");
        expect(logLines().find((l) => l.foldedBeforeResult)?.foldedBeforeResult).toEqual([]);
        expect(userTexts()).toEqual(["start", "queued correction"]);
        expect(JSON.stringify(a.session.messages)).toContain("All done.");
        expect(notices(a.events).join("\n")).toContain("Queued messages will be delivered when its current turn ends");
    });

    test("mid-turn delivery stays within the CLI's 64-UUID acknowledgement window", async () => {
        process.env.FAKE_SCENARIO = "steering-many";
        const a = await makeAgent({ provider: "claude-code", queued: Array.from({ length: 65 }, (_, i) => [`correction ${i}`]) });
        expect(await a.run("start")).toBe("done");
        expect(userTexts()).toEqual(["start", ...Array.from({ length: 65 }, (_, i) => `correction ${i}`)]);
        expect(logLines().filter((l) => l.foldedBeforeResult).map((l) => l.foldedBeforeResult.length)).toEqual([63, 1]);
    });

    test("separately answered queued input waits for both results", async () => {
        process.env.FAKE_SCENARIO = "write";
        const a = await makeAgent({ provider: "claude-code", mode: "acceptEdits", queued: [["queued correction"]] });
        expect(await a.run("start")).toBe("done");
        expect(userTexts()).toEqual(["start", "queued correction"]);
        expect(a.events.filter((e) => e.type === "text" && e.text === "All done.")).toHaveLength(2);
    });

    for (const scenario of ["shell-background", "monitor-background"]) test(`${scenario} keeps the turn alive through completion and the report turn`, async () => {
        process.env.FAKE_SCENARIO = scenario;
        const a = await makeAgent({ provider: "claude-code" });
        expect(await a.run("run checks and wait")).toBe("done");
        expect(JSON.stringify(a.session.messages)).toContain("Background checks passed.");
        expect(notices(a.events).join("\n")).toContain("Waiting for 1 background");
        expect(notices(a.events).join("\n")).not.toContain("stopped with Claude Code");
    });

    test("a never-ending shell has a bounded wait and the model knows its lifetime", async () => {
        process.env.FAKE_SCENARIO = "shell-background-stuck";
        const saved = { ...backgroundTiming };
        Object.assign(backgroundTiming, { commandWaitMs: 100, pollMs: 20 });
        try {
            const a = await makeAgent({ provider: "claude-code" });
            expect(await a.run("run checks and wait")).toBe("done");
            expect(notices(a.events).join("\n")).toMatch(/warn: Stopped 1 background/);
            const args = starts()[0].argv;
            expect(args[args.indexOf("--append-system-prompt") + 1]).toContain("Background commands and monitors");
        } finally { Object.assign(backgroundTiming, saved); }
    });

    test("a result-only CLI error persists as a notice and is absent from reopened model history", async () => {
        process.env.FAKE_SCENARIO = "result-error";
        const session = Session.create(cwd, { system: "test" });
        try {
            const a = await makeAgent({ provider: "claude-code", session });
            expect(await a.run("check it")).toBe("error");
            const saved = readFileSync(session.file, "utf-8");
            expect(saved).toContain("CLI diagnostic: execution failed");
            session.release();
            const reopened = Session.load(session.file);
            try {
                expect(reopened.messages.filter((m) => m.role === "assistant")).toEqual([]);
                expect(reopened.notices.some((n) => n.level === "error" && n.text.includes("CLI diagnostic: execution failed"))).toBe(true);
            } finally { reopened.release(); }
        } finally { session.release(); }
    });

    for (const scenario of ["rate-limit", "partial-error", "partial-error-exit"]) test(`${scenario}: errors are notices, genuine partial replies survive and handoff excludes error prose`, async () => {
        process.env.FAKE_SCENARIO = scenario;
        const a = await makeAgent({ provider: "claude-code" });
        expect(await a.run("check it")).toBe("error");
        expect(JSON.stringify(a.session.messages)).not.toContain("You've hit your limit");
        expect(a.events.some((e) => e.type === "assistant" && JSON.stringify(e).includes("You've hit your limit"))).toBe(false);
        expect(a.session.notices.some((n) => n.level === "error" && /usage limit/.test(n.text) && n.text.includes("You've hit your limit"))).toBe(true);
        if (scenario.startsWith("partial-error")) expect(JSON.stringify(a.session.messages)).toContain("The first check passed.");
        process.env.FAKE_SCENARIO = "none";
        const b = await makeAgent({ provider: "codex", session: a.session });
        expect(await b.run("continue")).toBe("done");
        const handoff = JSON.stringify(received().find((m) => m.method === "turn/start")?.params);
        expect(handoff).not.toContain("You've hit your limit");
        expect(handoff).not.toContain("usage limit was reached");
        if (scenario.startsWith("partial-error")) expect(handoff).toContain("The first check passed.");
    });
});


describe("Claude Code background grace (#60 follow-up)", () => {
    test("default grace is ten minutes, invalid settings fall back, and zero disables waiting", async () => {
        const { claudeBackgroundWaitMs } = await import("../src/backends/claude-code");
        expect(claudeBackgroundWaitMs(undefined)).toBe(600_000);
        for (const value of [-1, Infinity, NaN, "10"]) expect(claudeBackgroundWaitMs(value)).toBe(600_000);
        expect(claudeBackgroundWaitMs(0)).toBe(0);
        expect(claudeBackgroundWaitMs(12)).toBe(12_000);
    });

    for (const scenario of ["shell-background-stuck", "monitor-background-stuck"]) test(`${scenario}: configured grace ends normally, names stopped work and sends a durable next-prompt reminder`, async () => {
        process.env.FAKE_SCENARIO = scenario;
        const saved = { ...backgroundTiming };
        backgroundTiming.pollMs = 10;
        const session = Session.create(cwd, { system: "test" });
        try {
            const a = await makeAgent({ provider: "claude-code", session, settings: { claudeCode: { backgroundWaitSec: 0.04 } } });
            const start = Date.now();
            expect(await a.run("wait for checks")).toBe("done");
            expect(Date.now() - start).toBeLessThan(3000);
            expect(notices(a.events).join("\n")).toMatch(/Stopped.*Wait for checks.*grace expired/);
            expect(JSON.stringify(session.messages)).toContain("Waiting for checks.");
            const label = `Waiting for background ${scenario.startsWith("shell") ? "command" : "monitor"}: Wait for checks · Esc to stop it`;
            expect(a.events.some((e) => e.type === "activity" && e.text === label)).toBe(true);
            expect(session.messages.at(-1)).toMatchObject({ role: "user", meta: { kind: "reminder" } });
            session.release();
            const reopened = Session.load(session.file);
            try {
                expect(reopened.notices.some((n) => n.text.includes("Wait for checks"))).toBe(true);
                process.env.FAKE_SCENARIO = "none";
                const b = await makeAgent({ provider: "claude-code", session: reopened });
                expect(await b.run("continue")).toBe("done");
                expect(userTexts().at(-1)).toContain("Harness stopped these Claude Code background tasks");
                expect(userTexts().at(-1)).toContain("Wait for checks");
                expect(userTexts().at(-1)).toContain("do not wait for their old task IDs");
            } finally { reopened.release(); }
        } finally { session.release(); Object.assign(backgroundTiming, saved); }
    });

    test("a Stop hook continuation receives the stopped-task reminder on that next prompt", async () => {
        process.env.FAKE_SCENARIO = "shell-background-stuck";
        const a = await makeAgent({ provider: "claude-code", settings: {
            claudeCode: { backgroundWaitSec: 0 },
            hooks: { Stop: [{ command: "if [ ! -f hook-ran ]; then touch hook-ran; printf 'Keep going' >&2; exit 2; fi" }] },
        } });
        expect(await a.run("wait for checks")).toBe("done");
        expect(userTexts()).toHaveLength(2);
        expect(userTexts()[1]).toContain("A Stop hook asked you to keep going");
        expect(userTexts()[1]).toContain("Harness stopped these Claude Code background tasks");
        expect(userTexts()[1]).toContain("Wait for checks");
    });

    test("a zero shell grace does not shorten a background agent's limit", async () => {
        process.env.FAKE_SCENARIO = "agent-background";
        const a = await makeAgent({ provider: "claude-code", settings: { claudeCode: { backgroundWaitSec: 0 } } });
        expect(await a.run("map auth")).toBe("done");
        expect(JSON.stringify(a.session.messages)).toContain("The explorer reported back");
        expect(notices(a.events).some((n) => n.includes("Stopped"))).toBe(false);
    });

    test("Esc stops the wait promptly while preserving output and the next-prompt reminder", async () => {
        process.env.FAKE_SCENARIO = "shell-background-stuck";
        const a = await makeAgent({ provider: "claude-code" });
        const ac = new AbortController();
        const done = a.run("wait for checks", ac.signal);
        while (!a.events.some((e) => e.type === "activity" && e.text?.includes("Waiting for background command"))) await Bun.sleep(10);
        const start = Date.now();
        ac.abort();
        expect(await done).toBe("aborted");
        expect(Date.now() - start).toBeLessThan(1500);
        expect(JSON.stringify(a.session.messages)).toContain("Waiting for checks.");
        expect(notices(a.events).join("\n")).toContain("interrupted by user");
        process.env.FAKE_SCENARIO = "none";
        expect(await a.run("continue")).toBe("done");
        expect(userTexts().at(-1)).toContain("background command: Wait for checks");
    });

    for (const command of ["bun run dev", "npm start", "pnpm run serve", "yarn watch", "vite", "tail -f out.log", "node --watch server.js"]) test(`long-lived command ends without the grace: ${command}`, async () => {
        process.env.FAKE_SCENARIO = "shell-background-stuck";
        process.env.FAKE_COMMAND = command;
        const a = await makeAgent({ provider: "claude-code" });
        const start = Date.now();
        expect(await a.run("start the server")).toBe("done");
        expect(Date.now() - start).toBeLessThan(3000);
        expect(a.events.some((e) => e.type === "activity" && e.text?.includes("Waiting for"))).toBe(false);
        expect(notices(a.events).join("\n")).toContain("recognized long-lived server/watcher");
        process.env.FAKE_SCENARIO = "none";
        await a.run("continue");
        expect(userTexts().at(-1)).toContain("Harness stopped these Claude Code background tasks");
    });

    test("finite commands are not classified by a word in output or a Vite build", async () => {
        const { longLivedClaudeCommand } = await import("../src/backends/claude-code");
        for (const command of ["bun test", "vite build", "echo start", "printf dev", "tail -n 20 out.log", "npm run restart-checks"]) expect(longLivedClaudeCommand(command)).toBe(false);
    });

    for (const [command, scenario] of [["sleep 150", "shell-background-mixed"], ["bun run dev", "shell-background-mixed"], ["bun run dev", "shell-background-nested"]]) test(`mixed shell/agent work stops only the shell and keeps the agent limit: ${scenario} ${command}`, async () => {
        process.env.FAKE_SCENARIO = scenario;
        process.env.FAKE_COMMAND = command;
        process.env.FAKE_BACKGROUND_MS = "220";
        const saved = { ...backgroundTiming };
        backgroundTiming.pollMs = 10;
        try {
            const a = await makeAgent({ provider: "claude-code", settings: { claudeCode: { backgroundWaitSec: 0.04 } } });
            expect(await a.run("start both")).toBe("done");
            expect(received().filter((m) => m.request?.subtype === "stop_task").map((m) => m.request.task_id)).toEqual(["background-1"]);
            if (command === "bun run dev") expect(notices(a.events).join("\n")).toContain("recognized long-lived server/watcher");
            expect(JSON.stringify(a.session.messages)).toContain("The explorer reported back");
            expect(a.events.some((e) => e.type === "subagent" && e.event.type === "turn_end" && e.event.reason === "done")).toBe(true);
            expect(a.events.some((e) => e.type === "activity" && e.text === "Waiting for background sub-agent: Map auth · Esc to stop it")).toBe(true);
        } finally { Object.assign(backgroundTiming, saved); }
    });

    for (const failure of ["reject", "hang"]) test(`an unconfirmed selective stop cannot leave the turn stuck (${failure})`, async () => {
        process.env.FAKE_SCENARIO = "shell-background-mixed";
        process.env.FAKE_COMMAND = "bun run dev";
        process.env.FAKE_STOP_TASK = failure;
        process.env.FAKE_BACKGROUND_MS = "10000";
        const saved = { ...backgroundTiming };
        Object.assign(backgroundTiming, { stopTimeoutMs: 40, pollMs: 10 });
        try {
            const a = await makeAgent({ provider: "claude-code" });
            expect(await a.run("start both")).toBe("done");
            expect(notices(a.events).join("\n")).toContain("did not confirm a task stop");
            expect(JSON.stringify(a.session.messages.at(-1))).toContain("Map auth");
        } finally { Object.assign(backgroundTiming, saved); }
    });
});

describe("Claude Code reviewed grace fixes", () => {
    test("repeated Monitor report turns cannot extend the overall background cap", async () => {
        process.env.FAKE_SCENARIO = "monitor-repeated-reports";
        const saved = { ...backgroundTiming };
        Object.assign(backgroundTiming, { maxWaitMs: 350, pollMs: 10 });
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 4000);
        try {
            const a = await makeAgent({ provider: "claude-code", settings: { claudeCode: { backgroundWaitSec: 0.2 } } });
            const outcome = await a.run("monitor checks", abort.signal);
            expect(outcome).toBe("done");
            expect(JSON.stringify(a.session.messages)).toContain("Monitor notification 2.");
            expect(notices(a.events).join("\n")).toMatch(/Stopped waiting for.*Watch checks.*after 1s/);
            expect(notices(a.events).join("\n")).not.toContain("grace expired");
            expect(a.session.messages.at(-1)).toMatchObject({ role: "user", meta: { kind: "reminder" } });
            expect(JSON.stringify(a.session.messages.at(-1))).toContain("background monitor: Watch checks");
            process.env.FAKE_SCENARIO = "none";
            const b = await makeAgent({ provider: "claude-code", session: a.session });
            expect(await b.run("continue")).toBe("done");
            expect(userTexts().at(-1)).toContain("Harness stopped these Claude Code background tasks: background monitor: Watch checks");
        } finally {
            clearTimeout(timeout);
            Object.assign(backgroundTiming, saved);
        }
    });

    for (const flags of ["--watch=false", "--watch=0", '--watch="false"', "--watch='0'", "--no-watch", "--watch --no-watch", "--watch --watch=false", "--watch=true --watch=0"]) test(`disabled watch flags preserve finite command results: ${flags}`, async () => {
        process.env.FAKE_SCENARIO = "shell-background";
        process.env.FAKE_COMMAND = `npm test -- ${flags}`;
        const a = await makeAgent({ provider: "claude-code" });
        expect(await a.run("run tests")).toBe("done");
        expect(JSON.stringify(a.session.messages)).toContain("Background checks passed.");
        expect(notices(a.events).some((n) => n.includes("recognized long-lived"))).toBe(false);
    });

    test("only enabling watch flags count, with the last flag taking precedence", async () => {
        const { longLivedClaudeCommand } = await import("../src/backends/claude-code");
        for (const flags of ["--watch", "--watch=true", "--watch=src", "--no-watch --watch", "--watch=0 --watch=src"]) expect(longLivedClaudeCommand(`npm test -- ${flags}`)).toBe(true);
        expect(longLivedClaudeCommand("npm test -- --watch=")).toBe(false);
    });

    for (const scenario of ["shell-grace-queued", "shell-grace-turn", "shell-grace-overlap", "shell-grace-replace", "shell-grace-renew"]) test(`${scenario}: each task gets its own full grace after its answer`, async () => {
        process.env.FAKE_SCENARIO = scenario;
        const saved = { ...backgroundTiming };
        backgroundTiming.pollMs = 10;
        let queueReady = false;
        let sent = false;
        try {
            const a = await makeAgent({ provider: "claude-code", settings: { claudeCode: { backgroundWaitSec: 0.3 } }, drainQueued: () => {
                if (!queueReady || sent) return [];
                sent = true;
                return ["start command B"];
            } });
            const done = a.run("start command A");
            if (scenario === "shell-grace-queued") {
                while (!a.events.some((e) => e.type === "activity" && e.text?.includes("Command A"))) await Bun.sleep(5);
                queueReady = true;
            }
            expect(await done).toBe("done");
            expect(JSON.stringify(a.session.messages)).toContain("Command B completed with its results.");
            expect(notices(a.events).some((n) => /Stopped.*Command B/.test(n))).toBe(false);
            const stops = received().filter((m) => m.request?.subtype === "stop_task").map((m) => m.request.task_id);
            expect(stops).toEqual(scenario === "shell-grace-overlap" ? ["A"] : []);
        } finally { Object.assign(backgroundTiming, saved); }
    });
});

// A message to steer with goes into Codex's running turn as it's sent (turn/steer), not at the turn's end.
describe("Codex mid-turn steering", () => {
    const turnStarts = () => received().filter((m) => m.method === "turn/start").map((m) => m.params);
    const steers = () => received().filter((m) => m.method === "turn/steer").map((m) => m.params);
    const until = async (ok: () => boolean, ms = 4000) => {
        for (const end = Date.now() + ms; !ok(); ) {
            if (Date.now() > end) throw new Error("timed out");
            await Bun.sleep(5);
        }
    };
    /** What the session holds, as role: text. */
    const transcript = (session: InstanceType<typeof Session>) => session.messages.map((m) => `${m.role}: ${m.content.map((c) => (c as any).text ?? "").join(" ").replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "").trim()}`);

    test("steered while the turn runs: turn/steer to that turn, recorded after what it said so far, and no second turn", async () => {
        process.env.FAKE_SCENARIO = "slow";
        process.env.FAKE_STEER_WAKES = "1";
        const host: string[] = [];
        const a = await makeAgent({ provider: "codex", drainQueued: () => host.splice(0) });
        const done = a.run("start");
        await until(() => logLines().some((l) => l.received?.method === "turn/start"));
        await Bun.sleep(50);
        host.push("also check y");
        a.agent.queueChanged();
        expect(await done).toBe("done");
        expect(steers()).toHaveLength(1);
        expect(steers()[0]).toMatchObject({ threadId: "thr-new", expectedTurnId: "turn-1", input: [{ type: "text", text: "also check y" }] });
        expect(turnStarts()).toHaveLength(1);
        expect(transcript(a.session)).toEqual(["user: start", "assistant: Running it.", "user: also check y", "assistant: Heard: also check y"]);
        expect(a.session.messages[2]!.meta?.kind).toBe("prompt");
    });

    test("nothing waiting: a nudge takes nothing and sends nothing", async () => {
        process.env.FAKE_SCENARIO = "slow";
        process.env.FAKE_STEER_WAKES = "1";
        const a = await makeAgent({ provider: "codex", drainQueued: () => [] });
        const ac = new AbortController();
        const done = a.run("start", ac.signal);
        await until(() => logLines().some((l) => l.received?.method === "turn/start"));
        a.agent.queueChanged();
        await Bun.sleep(50);
        ac.abort();
        expect(await done).toBe("aborted");
        expect(steers()).toEqual([]);
    });

    test("sent while the turn is starting: steered once Codex says which turn it is", async () => {
        process.env.FAKE_SCENARIO = "slow";
        process.env.FAKE_STEER_WAKES = "1";
        process.env.FAKE_SLOW_TURN_START = "300";
        const host: string[] = [];
        const a = await makeAgent({ provider: "codex", drainQueued: () => host.splice(0) });
        const done = a.run("start");
        await until(() => logLines().some((l) => l.received?.method === "turn/start"));
        host.push("early words");
        a.agent.queueChanged();
        expect(await done).toBe("done");
        expect(steers().map((s) => s.expectedTurnId)).toEqual(["turn-1"]);
        expect(turnStarts()).toHaveLength(1);
    });

    test("a steer Codex refuses (its turn just ended) starts the next turn, once", async () => {
        process.env.FAKE_SCENARIO = "steps";
        process.env.FAKE_STEER_FAIL = "1";
        process.env.FAKE_SLOW_TURN_START = "200";
        const host: string[] = [];
        const ac = new AbortController();
        const a = await makeAgent({ provider: "codex", drainQueued: () => host.splice(0) });
        const done = a.run("start", ac.signal);
        await until(() => logLines().some((l) => l.received?.method === "turn/start"));
        host.push("late words");
        a.agent.queueChanged();
        expect(await done).toBe("done");
        expect(steers()).toHaveLength(1);
        expect(turnStarts()).toHaveLength(2);
        expect(turnStarts()[1].input.at(-1).text).toEndWith("late words");
        // Recorded once, as the prompt it was.
        expect(transcript(a.session).filter((l) => l === "user: late words")).toHaveLength(1);
    });

    test("a steer Codex refused before the turn was stopped isn't lost: the thread's next turn starts with it", async () => {
        process.env.FAKE_SCENARIO = "slow";
        process.env.FAKE_STEER_FAIL = "1";
        const host: string[] = [];
        const ac = new AbortController();
        const a = await makeAgent({ provider: "codex", drainQueued: () => host.splice(0) });
        const done = a.run("start", ac.signal);
        await until(() => logLines().some((l) => l.received?.method === "turn/start"));
        await Bun.sleep(50);
        host.push("refused words");
        a.agent.queueChanged();
        await until(() => steers().length === 1);
        await Bun.sleep(20);
        ac.abort();
        expect(await done).toBe("aborted");
        expect(turnStarts()).toHaveLength(1);
        delete process.env.FAKE_SCENARIO;
        expect(await a.run("next")).toBe("done");
        expect(turnStarts()).toHaveLength(2);
        expect(turnStarts()[1].input.at(-1).text).toContain("refused words");
        expect(turnStarts()[1].input.at(-1).text).toEndWith("next");
        expect(transcript(a.session).filter((l) => l === "user: refused words")).toHaveLength(1);
    });

    test("a refused steer still reaches Codex after Harness restarts: it's saved in the session, past what Codex has seen", async () => {
        process.env.FAKE_SCENARIO = "slow";
        process.env.FAKE_STEER_FAIL = "1";
        const host: string[] = [];
        const ac = new AbortController();
        const session = Session.create(cwd, { persist: true });
        const a = await makeAgent({ provider: "codex", session, drainQueued: () => host.splice(0) });
        const done = a.run("start", ac.signal);
        await until(() => logLines().some((l) => l.received?.method === "turn/start"));
        await Bun.sleep(50);
        host.push("refused before restart");
        a.agent.queueChanged();
        await until(() => steers().length === 1);
        await Bun.sleep(20);
        ac.abort();
        expect(await done).toBe("aborted");
        const path = session.path;
        session.release();
        // A new process: a new Codex client and the session read back from disk.
        forgetClient("codex");
        delete process.env.FAKE_SCENARIO;
        const b = await makeAgent({ provider: "codex", session: Session.load(path) });
        expect(await b.run("next")).toBe("done");
        expect(turnStarts()).toHaveLength(2);
        expect(turnStarts()[1].input.at(-1).text).toContain("refused before restart");
        expect(turnStarts()[1].input.at(-1).text).toEndWith("next");
    });

    test("a message taken when the turn ends is recorded after that turn's words, not before them", async () => {
        const waiting = [["and then this"]];
        const a = await makeAgent({ provider: "codex", drainQueued: () => waiting.shift() ?? [] });
        expect(await a.run("first")).toBe("done");
        const t = transcript(a.session);
        expect(t[0]).toBe("user: first");
        expect(t.indexOf("user: and then this")).toBeGreaterThan(t.findIndex((l) => l.startsWith("assistant: Running it.")));
        expect(t.at(-1)).toStartWith("assistant: Running it.");
        expect(turnStarts()).toHaveLength(2);
    });

    test("after an interrupt nothing is steered", async () => {
        process.env.FAKE_SCENARIO = "slow";
        process.env.FAKE_STEER_WAKES = "1";
        const host: string[] = [];
        const ac = new AbortController();
        const a = await makeAgent({ provider: "codex", drainQueued: () => host.splice(0) });
        const done = a.run("start", ac.signal);
        await until(() => logLines().some((l) => l.received?.method === "turn/start"));
        ac.abort();
        host.push("too late");
        a.agent.queueChanged();
        expect(await done).toBe("aborted");
        expect(steers()).toEqual([]);
        expect(host).toEqual(["too late"]);
    });
});

const { paths } = await import("../src/config/paths");
describe("the harness's agents on Claude Code", () => {
    const agentLogs = () => logLines().filter((l) => "agents" in l);
    function writeAgents() {
        mkdirSync(paths.userAgents(), { recursive: true });
        writeFileSync(join(paths.userAgents(), "mine.md"), "---\nname: mine\ndescription: Mine\nmaxTurns: 3\n---\nBe brief.\n");
        writeFileSync(join(paths.userAgents(), "gpt.md"), "---\nname: gpt\ndescription: On GPT\nmodel: openai:gpt-5\n---\nx\n");
        mkdirSync(join(cwd, ".harness", "agents"), { recursive: true });
        writeFileSync(join(cwd, ".harness", "agents", "repo.md"), "---\nname: repo\ndescription: The repo's\n---\ny\n");
    }
    afterEach(() => rmSync(paths.userAgents(), { recursive: true, force: true }));

    test("go to its own Agent tool through --agents: user ones always, the repo's once the user trusts it", async () => {
        writeAgents();
        const a = await makeAgent({ provider: "claude-code" });
        await a.run("go");
        const [first] = agentLogs();
        expect(first.agents).toEqual({ mine: { description: "Mine", prompt: "Be brief.", model: "inherit", maxTurns: 3 } });
        // Read from a file only for the run: it's gone once Claude Code exits.
        expect(existsSync(first.agentsFile)).toBe(false);
        trust.trustFolder(cwd);
        rmSync(LOG, { force: true });
        await a.run("again");
        expect(Object.keys(agentLogs()[0].agents).sort()).toEqual(["mine", "repo"]);
    });

    test("not for read-only sub-agents, or when there are none to pass", async () => {
        writeAgents();
        await (await makeAgent({ provider: "claude-code", readOnly: true })).run("go");
        expect(starts()[0].argv).not.toContain("--agents");
        rmSync(paths.userAgents(), { recursive: true, force: true });
        rmSync(LOG, { force: true });
        await (await makeAgent({ provider: "claude-code" })).run("go");
        expect(starts()[0].argv).not.toContain("--agents");
    });

    test("each agent's own permissionMode decides its asks, as when the harness runs it", async () => {
        mkdirSync(paths.userAgents(), { recursive: true });
        writeFileSync(join(paths.userAgents(), "writer.md"), "---\nname: writer\ndescription: Writes\npermissionMode: acceptEdits\n---\nWrite.\n");
        writeFileSync(join(paths.userAgents(), "careful.md"), "---\nname: careful\ndescription: Asks\npermissionMode: default\n---\nWrite.\n");
        process.env.FAKE_SCENARIO = "native-agent-write";
        const answers = () => logLines().flatMap((l) => (l.agentWrite ? [l.agentWrite] : []));
        const run = async (type: string, mode: PermissionMode) => {
            process.env.FAKE_AGENT_TYPE = type;
            rmSync(LOG, { force: true });
            const a = await makeAgent({ provider: "claude-code", mode, ask: () => ({ allow: false }) });
            await a.run("go");
            return { asked: a.asked.length, answer: answers()[0] };
        };
        // An acceptEdits agent in a default session: its edit in the workspace goes through, as the harness's own run would.
        expect(await run("writer", "default")).toEqual({ asked: 0, answer: "allow" });
        // The reverse: a default agent in an acceptEdits session is asked.
        expect(await run("careful", "acceptEdits")).toEqual({ asked: 1, answer: "deny" });
        // Claude Code's own agents (and any it doesn't name) are under the session's mode.
        expect(await run("general-purpose", "default")).toEqual({ asked: 1, answer: "deny" });
        expect(await run("general-purpose", "acceptEdits")).toEqual({ asked: 0, answer: "allow" });
        // Plan mode in the session wins over the agent's own.
        expect((await run("writer", "plan")).answer).toBe("deny");
    });

    test("Codex isn't given them", async () => {
        writeAgents();
        await (await makeAgent({ provider: "codex" })).run("go");
        expect(agentLogs()).toEqual([]);
    });
});
