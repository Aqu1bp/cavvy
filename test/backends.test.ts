// Agent backends (Claude Code, Codex) through the real Agent loop, with fake
// `claude` and `codex` programs that speak the same protocols (test/fixtures).
// Nothing here runs the real CLIs or touches the network.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir, FAKE } from "./helpers/isolate";

const { cleanup } = isolate();
const registry = await import("../src/providers/registry");
const { clientFor, forgetClient, listAllModels } = await import("../src/providers/models");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const { isAgentBackend } = await import("../src/backends/types");
const { checkAgentCli } = await import("../src/backends/index");
const { applyHunks, codexPolicy, changePreview } = await import("../src/backends/codex");
const trust = await import("../src/config/trust");
const { claudeRule, claudePermissions } = await import("../src/backends/claude-code");
const { untrustedArgs, requestedPaths } = await import("../src/backends/codex");
const { stopTiming } = await import("../src/backends/cli");

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
    cleanup();
    rmSync(bin, { recursive: true, force: true });
});

let cwd: string;
beforeEach(() => {
    cwd = tempDir("backend-proj-");
    rmSync(LOG, { force: true });
    process.env.FAKE_LOG = LOG;
    for (const k of ["FAKE_SCENARIO", "FAKE_LOGGED_IN", "FAKE_API_KEY_SOURCE", "FAKE_ACCOUNT", "FAKE_DECLINE", "FAKE_IGNORE_STOP", "FAKE_CRASH_ON_SECOND", "FAKE_HANG_INIT", "FAKE_CODEX_TRUSTS"]) delete process.env[k];
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
    ask?: (req: PermissionRequest) => PermissionResponse | Promise<PermissionResponse>;
    ui?: any;
    /** The user trusts the folder (otherwise it's only trusted implicitly, as a folder with nothing to protect is). */
    trusted?: boolean;
    session?: InstanceType<typeof Session>;
    queued?: string[][];
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
    const agent = new Agent({
        session,
        model: { provider: o.provider, id: "default", ...o.model },
        client,
        settings: () => settings,
        checker: new PermissionChecker(() => settings, cwd),
        tools: BUILTIN_TOOLS,
        mode: { get: () => mode, set: (m) => (mode = m) },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
        host: {
            drainQueued: () => queued.shift() ?? [],
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
    return { agent, events, asked, session, run, mode: () => mode, setMode: (m: PermissionMode) => (mode = m), switchMode };
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
        const args = starts().find((s) => s.argv.includes("--no-session-persistence"))!.argv;
        expect(args).toContain("--strict-mcp-config");
        expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
        const codex = listings.find((l) => l.provider.id === "codex")!;
        // Default first; hidden ones left out.
        expect(codex.models.map((m) => m.id)).toEqual(["gpt-test", "gpt-other"]);
        expect(codex.models[0]!.effortLevels).toEqual(["low", "high"]);
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
    });

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

    test("/compact runs Claude Code's own compaction on the session", async () => {
        const { run, agent, events } = await makeAgent({ provider: "claude-code", ask: () => ({ allow: true }) });
        expect(await agent.compact({ auto: false, signal: new AbortController().signal })).toBe(false);
        await run("go");
        expect(await agent.compact({ auto: false, signal: new AbortController().signal, instructions: "keep the plan" })).toBe(true);
        expect(userTexts().at(-1)).toBe("/compact keep the plan");
        expect(events.some((e) => e.type === "compact_end")).toBe(true);
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
        expect(p.input[0].text).toBe("make x");
        expect(session.backends.get("codex")?.id).toBe("thr-new");
        expect(session.cost).toBe(0);
        const said = session.messages.at(-1)!.content.map((x) => (x as any).text).join("\n");
        expect(said).toContain("Running it.");
        expect(said).toContain("[Codex used: Bash(touch x)]");
    });

    test("modes map to Codex's approval policy and sandbox", () => {
        expect(codexPolicy("default", [])).toMatchObject({ approvalPolicy: "untrusted", sandbox: "read-only" });
        expect(codexPolicy("plan", [])).toMatchObject({ approvalPolicy: "untrusted", sandbox: "read-only" });
        expect(codexPolicy("acceptEdits", ["/x"])).toMatchObject({ approvalPolicy: "untrusted", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/x"] } });
        expect(codexPolicy("auto", [])).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write" });
        expect(codexPolicy("bypassPermissions", [])).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
    });

    test("headless: the command is refused with the reason, and the turn ends", async () => {
        const { run, events } = await makeAgent({ provider: "codex" });
        expect(await run("make x")).toBe("done");
        expect(toolEnds(events)[0]!.result).toMatchObject({ isError: true, content: expect.stringMatching(/not granted \(non-interactive session\)/) });
        expect(turnStarts()).toHaveLength(1);
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

    test("declining with feedback where it can only cancel: the feedback starts the next turn", async () => {
        let n = 0;
        const { run } = await makeAgent({ provider: "codex", ask: () => (n++ === 0 ? { allow: false, feedback: "use y instead" } : { allow: true }) });
        await run("make x");
        expect(received().find((m) => m.result?.decision)?.result.decision).toBe("cancel");
        expect(turnStarts()).toHaveLength(2);
        expect(turnStarts()[1].input[0].text).toContain("use y instead");
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
        const methods = received().map((m) => m.method).filter((m) => m?.startsWith("thread/"));
        expect(methods).toEqual(["thread/resume", "thread/start"]);
    });

    test("acceptEdits: workspace-write with the extra directories, but commands still ask", async () => {
        const { run, events } = await makeAgent({ provider: "codex", mode: "acceptEdits", settings: { permissions: { additionalDirectories: ["/extra"] } } });
        await run("go");
        expect(turnStarts()[0]).toMatchObject({ approvalPolicy: "untrusted", sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/extra"] } });
        // Codex asked (headless: refused), rather than running it itself.
        expect(toolEnds(events)[0]!.result.content).toMatch(/not granted/);
        expect(logLines().find((l) => "ran" in l)?.ran).toBe(false);
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
        expect(claudeRule("WebFetch(domain:example.com)", root)).toEqual(["WebFetch(domain:example.com)"]);
        expect(claudeRule("Task(explore)", root)).toEqual(["Agent(explore)"]);
        expect(claudeRule("mcp__github", root)).toEqual(["mcp__github"]);
        expect(claudeRule("*", root)).toEqual([]);
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
        expect(toolEnds(a.events)[0]!.call.input).toEqual({ file_path: join(cwd, "a.txt") });
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
        expect(asked.asked[0]!.decision.reason).toContain(`write ${join(cwd, "secrets")}`);
        expect(granted()?.permissions?.fileSystem?.write).toEqual([join(cwd, "secrets")]);
        expect(requestedPaths({ fileSystem: { read: ["/a"], write: null, entries: [{ path: { type: "path", path: "/b" }, access: "write" }] }, network: { enabled: true } })).toEqual({ read: ["/a"], write: ["/b"], network: true });
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
        expect(second.input[0].text).toBe("and then this");
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
