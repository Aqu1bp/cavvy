// Delegation: Claude Code and Codex hand tasks to other providers' models
// through the harness's MCP server, and harness models pick a model for the
// Task tool. Fake CLIs (test/fixtures) and a scripted model stand in for the
// real ones; nothing here runs the real CLIs or touches the network.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
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
const { registerTools, serverTiming, stopServer } = await import("../src/mcp/server");
const { McpClient } = await import("../src/mcp/client");
const { redact } = await import("../src/util/redact");
const { DELEGATE_TOOL, DELEGATION_LIMITS, Delegations, delegationAvailable, nativeModel, orchestratorTools } = await import("../src/agent/delegation");
const { App } = await import("../src/ui/app");

type AgentEvent = import("../src/agent/agent").AgentEvent;
type PermissionRequest = import("../src/agent/agent").PermissionRequest;
type PermissionResponse = import("../src/agent/agent").PermissionResponse;
type ModelInfo = import("../src/providers/types").ModelInfo;
type ChatRequest = import("../src/providers/types").ChatRequest;
type ProviderListing = import("../src/providers/models").ProviderListing;
type ChildResult = import("../src/agent/delegation").ChildResult;
type ChildRequest = import("../src/agent/delegation").ChildRequest;

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
    stopServer();
    cleanup();
    rmSync(bin, { recursive: true, force: true });
    // The fakes' settings would reach other test files' fake CLIs (FAKE_LOG points into the folder just removed).
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
});

const TOOLS = ["models", "delegate", "task_status", "task_cancel"];
const TOOL_TIMEOUT_SEC = DELEGATION_LIMITS.maxWaitMs / 1000 + 300;

// ---- the other provider's model: scripted
const GEMINI: ModelInfo = { provider: "gemini", id: "gemini-test", name: "Gemini Test", contextWindow: 1_000_000 };
let script: (req: ChatRequest, n: number) => unknown;
let childRequests: ChatRequest[] = [];
const reply = (content: unknown[], stopReason = "end_turn") => ({ role: "assistant", provider: "gemini", model: "gemini-test", stopReason, content, usage: { inputTokens: 100, outputTokens: 20 } });
const say = (text: string) => reply([{ type: "text", text }]);
const use = (id: string, name: string, input: Record<string, unknown>) => reply([{ type: "tool_call", id, name, input }], "tool_use");
const childClient = {
    stream: async (req: ChatRequest) => {
        childRequests.push(req);
        return script(req, childRequests.length);
    },
    listModels: async () => [GEMINI],
};
const promptText = (req: ChatRequest) =>
    req.messages
        .filter((m) => m.role === "user")
        .flatMap((m) => m.content.flatMap((p: any) => (p.type === "text" ? [p.text as string] : [])))
        .join("\n");

/** A child that works until it's let go (or stopped). */
function gate() {
    let open!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    return {
        open,
        wait: (signal?: AbortSignal) =>
            new Promise<void>((resolve, reject) => {
                void opened.then(resolve);
                if (signal?.aborted) return reject(new Error("aborted"));
                signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }),
    };
}

async function until(cond: () => boolean, ms = 5000) {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error("timed out waiting");
        await Bun.sleep(10);
    }
}

async function resolveModel(ref: string) {
    const i = ref.indexOf(":");
    const provider = ref.slice(0, i);
    const id = ref.slice(i + 1);
    if (provider === "gemini" && ["gemini-test", "gemini-other"].includes(id)) return { model: { ...GEMINI, id }, client: childClient as any };
    if (provider === "gemini" && id === "gemini-fast") return { model: { ...GEMINI, id, supportsFastMode: true }, client: childClient as any };
    if (provider === "codex") return { model: { provider: "codex", id, ...(id === "gpt-fast" ? { supportsFastMode: true, fastModeTier: "priority" } : {}) }, client: await clientFor("codex") };
    if (provider === "claude-code") return { model: { provider: "claude-code", id }, client: await clientFor("claude-code") };
    return undefined;
}

const listing = (id: string, models: string[]): ProviderListing => ({ provider: registry.getProvider(id)!, models: models.map((m) => (id === "gemini" && m === GEMINI.id ? GEMINI : { provider: id, id: m })), status: "ok" });
let listings: ProviderListing[];

let cwd: string;
const agents: InstanceType<typeof Agent>[] = [];
beforeEach(() => {
    cwd = realpathSync(tempDir("deleg-proj-"));
    rmSync(LOG, { force: true });
    rmSync(LOG + ".tiers.json", { force: true });
    rmSync(LOG + ".usage.json", { force: true });
    process.env.FAKE_LOG = LOG;
    for (const k of ["FAKE_FINAL_TEXT", "FAKE_SUBAGENT_V2", "FAKE_PHASES", "FAKE_ELICIT", "FAKE_ELICIT_FIELDS", "FAKE_CHILD_EARLY", "FAKE_SCENARIO", "FAKE_CODEX_SCENARIO", "FAKE_MCP_CALLS", "FAKE_MCP_REFUSE", "FAKE_DECLINE", "FAKE_COMMAND", "FAKE_COMMAND_SCRIPT", "FAKE_COMMAND_RAW", "FAKE_COMMAND_CWD", "FAKE_REJECT_CONFIG", "FAKE_USER_MCP", "FAKE_NO_CONFIG_READ"]) delete process.env[k];
    registry.saveAgentConfig("claude-code", { path: claudeBin });
    registry.saveAgentConfig("codex", { path: codexBin });
    forgetClient("claude-code");
    forgetClient("codex");
    listings = [listing("claude-code", ["default"]), listing("codex", ["gpt-test"]), listing("gemini", ["gemini-test", "gemini-other"]), listing("openrouter", ["anthropic/claude-x", "openai/gpt-x", "google/gemini-y"])];
    childRequests = [];
    script = (req) => say(`Report on: ${promptText(req)}`);
});
afterEach(async () => {
    await Promise.all(agents.splice(0).map((a) => a.dispose(1000)));
});

function logLines(): any[] {
    return existsSync(LOG) ? readFileSync(LOG, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}
const starts = () => logLines().filter((l) => l.argv);
const received = () => logLines().flatMap((l) => (l.received ? [l.received] : []));
const mcpResults = () => logLines().flatMap((l) => (l.mcpResult ? [l.mcpResult] : []));
const setServers = () => received().filter((m) => m.type === "control_request" && m.request?.subtype === "mcp_set_servers");
const userTexts = () => received().flatMap((m) => (m.type === "user" ? m.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text as string) : []));
const notices = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "notice" ? [`${e.level}: ${e.message}`] : []));
const calls = (list: { server?: string; tool: string; args: Record<string, unknown> }[]) => (process.env.FAKE_MCP_CALLS = JSON.stringify(list));

interface Opts {
    provider: string;
    model?: Partial<ModelInfo>;
    client?: unknown;
    settings?: any;
    ask?: (req: PermissionRequest) => PermissionResponse | Promise<PermissionResponse>;
    /** Non-interactive, like -p: no one to ask. */
    headless?: boolean;
    /** Save the session to disk. */
    persist?: boolean;
}

async function makeAgent(o: Opts) {
    const settings = o.settings ?? {};
    const events: AgentEvent[] = [];
    const asked: PermissionRequest[] = [];
    let mode: import("../src/permissions/modes").PermissionMode = "default";
    trust.trustForSession(cwd);
    const client = o.client ?? (await clientFor(o.provider));
    const session = Session.create(cwd, { persist: o.persist ?? false });
    const agent = new Agent({
        session,
        model: { provider: o.provider, id: "default", ...o.model },
        client: client as any,
        settings: () => settings,
        checker: new PermissionChecker(() => settings, cwd),
        tools: BUILTIN_TOOLS,
        mode: { get: () => mode, set: (m) => (mode = m) },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
        helpers: { resolveModel },
        listings: () => listings,
        host: {
            emit: (e) => events.push(e),
            ui: {},
            askPermission: o.headless
                ? undefined
                : async (req) => {
                      asked.push(req);
                      return o.ask ? o.ask(req) : { allow: true };
                  },
        },
    });
    agents.push(agent);
    const run = (text: string, signal = new AbortController().signal) => agent.run([{ type: "text", text }], { signal });
    /** The user switching the permission mode. */
    const switchMode = (to: typeof mode) => {
        const from = mode;
        mode = to;
        agent.noteModeChange(from, to);
    };
    return { agent, events, asked, session, run, switchMode };
}

// ---------------------------------------------------------------------------

describe("the harness's MCP server", () => {
    const echo = { name: "echo", description: "Echo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, call: async (args: Record<string, unknown>, ctx: { meta: Record<string, unknown> }) => ({ text: `echo ${JSON.stringify(args)} ${JSON.stringify(ctx.meta)}` }) };
    const post = (url: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) =>
        fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body), signal });
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    /** The JSON-RPC message in a response, JSON or SSE. */
    const message = async (r: Response) => {
        const text = await r.text();
        if (!(r.headers.get("content-type") ?? "").includes("text/event-stream")) return JSON.parse(text);
        const data = text.split("\n").filter((l) => l.startsWith("data:"));
        return JSON.parse(data.at(-1)!.slice(5));
    };

    test("only its own clients get in, with a live token", async () => {
        const reg = registerTools([echo]);
        const other = registerTools([{ ...echo, name: "other" }]);
        const auth = { Authorization: reg.authorization };
        expect((await post(reg.url, ping)).status).toBe(401);
        expect((await post(reg.url, ping, { Authorization: "Bearer nope" })).status).toBe(401);
        // A web page can't drive it: browsers send Origin.
        expect((await post(reg.url, ping, { ...auth, Origin: "https://example.com" })).status).toBe(403);
        expect((await post(reg.url.replace("/mcp", "/other"), ping, auth)).status).toBe(404);
        expect((await fetch(reg.url, { headers: auth })).status).toBe(405);
        expect((await post(reg.url, "{nope", auth)).status).toBe(400);
        expect((await post(reg.url, [ping], auth)).status).toBe(400);
        expect(await (await post(reg.url, ping, auth)).json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
        // A modern client's probe gets "method not found", so it falls back to initialize.
        expect((await (await post(reg.url, { jsonrpc: "2.0", id: 2, method: "server/discover" }, auth)).json()).error.code).toBe(-32601);
        // Each token reaches its own tools.
        const list = async (a: string) => (await message(await post(reg.url, { jsonrpc: "2.0", id: 3, method: "tools/list" }, { Authorization: a }))).result.tools.map((t: any) => t.name);
        expect(await list(reg.authorization)).toEqual(["echo"]);
        expect(await list(other.authorization)).toEqual(["other"]);
        // The token is redacted wherever it might show.
        const token = reg.authorization.slice("Bearer ".length);
        expect(redact(`header ${reg.authorization}`)).not.toContain(token);
        reg.close();
        other.close();
        expect((await post(reg.url, ping, auth)).status).toBe(401);
    });

    test("negotiates the protocol version, and gives instructions when it has some", async () => {
        let instructions: string | undefined = "Use it well.";
        const reg = registerTools([echo], () => instructions);
        const auth = { Authorization: reg.authorization };
        const init = async (protocolVersion: string) => {
            const r = await post(reg.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "t", version: "0" } } }, auth);
            expect(r.headers.get("mcp-session-id")).toBeTruthy();
            return (await r.json()).result;
        };
        expect((await init("2025-03-26")).protocolVersion).toBe("2025-03-26");
        expect((await init("2099-01-01")).protocolVersion).toBe("2025-06-18");
        const r = await init("2025-06-18");
        expect(r.instructions).toBe("Use it well.");
        expect(r.capabilities).toEqual({ tools: { listChanged: false } });
        instructions = undefined;
        expect("instructions" in (await init("2025-06-18"))).toBe(false);
        expect((await post(reg.url, { jsonrpc: "2.0", method: "notifications/initialized" }, auth)).status).toBe(202);
        const tools = (await message(await post(reg.url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, auth))).result.tools;
        expect(tools).toEqual([{ name: "echo", description: "Echo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }]);
        expect((await message(await post(reg.url, call(3, "nope"), auth))).error.code).toBe(-32602);
        // The call's _meta reaches the tool.
        const echoed = await message(await post(reg.url, { ...call(4, "echo", { a: 1 }), params: { name: "echo", arguments: { a: 1 }, _meta: { callId: "item-1" } } }, auth));
        expect(echoed.result).toEqual({ content: [{ type: "text", text: 'echo {"a":1} {"callId":"item-1"}' }], isError: false });
        reg.close();
    });

    test("a long call streams keep-alives, then the result; a client that takes only JSON gets it at the end", async () => {
        const old = serverTiming.keepAliveMs;
        serverTiming.keepAliveMs = 20;
        const reg = registerTools([{ name: "slow", description: "", inputSchema: { type: "object" }, call: async () => (await Bun.sleep(150), { text: "done slowly" }) }]);
        const auth = { Authorization: reg.authorization };
        const result = { content: [{ type: "text", text: "done slowly" }], isError: false };
        try {
            const sse = await post(reg.url, call(5, "slow"), auth);
            expect(sse.headers.get("content-type")).toContain("text/event-stream");
            const body = await sse.text();
            expect(body).toContain(": keep-alive\n\n");
            expect(body).toContain(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 5, result })}`);
            const plain = await fetch(reg.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", ...auth }, body: JSON.stringify(call(6, "slow")) });
            expect(plain.headers.get("content-type")).toContain("application/json");
            expect(await plain.json()).toEqual({ jsonrpc: "2.0", id: 6, result });
        } finally {
            serverTiming.keepAliveMs = old;
            reg.close();
        }
    });

    test("a tool that throws gives an error result, with secrets redacted", async () => {
        const { registerSecret } = await import("../src/util/redact");
        const secret = "s3cr3t-" + "q".repeat(30);
        registerSecret(secret, "test secret");
        const reg = registerTools([{ name: "boom", description: "", inputSchema: { type: "object" }, call: async () => Promise.reject(new Error(`bad ${secret}`)) }]);
        const r = (await message(await post(reg.url, call(1, "boom"), { Authorization: reg.authorization }))).result;
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toStartWith("boom failed: bad ");
        expect(r.content[0].text).not.toContain(secret);
        reg.close();
    });

    test("cancelling a call, the client going away and revoking the token each stop the tool", async () => {
        const started: string[] = [];
        const stopped: string[] = [];
        const reg = registerTools([
            {
                name: "wait",
                description: "",
                inputSchema: { type: "object" },
                call: (args, ctx) =>
                    new Promise((resolve) => {
                        started.push(String(args.n));
                        ctx.signal.addEventListener("abort", () => {
                            stopped.push(String(args.n));
                            resolve({ text: "stopped" });
                        });
                    }),
            },
        ]);
        const auth = { Authorization: reg.authorization };
        const first = post(reg.url, call(11, "wait", { n: 1 }), auth).then(message);
        await until(() => started.includes("1"));
        expect((await post(reg.url, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 11 } }, auth)).status).toBe(202);
        await until(() => stopped.includes("1"));
        expect((await first).result.content[0].text).toBe("stopped");

        const ac = new AbortController();
        void post(reg.url, call(12, "wait", { n: 2 }), auth, ac.signal)
            .then((r) => r.text())
            .catch(() => "");
        await until(() => started.includes("2"));
        ac.abort();
        await until(() => stopped.includes("2"));

        void post(reg.url, call(13, "wait", { n: 3 }), auth)
            .then((r) => r.text())
            .catch(() => "");
        await until(() => started.includes("3"));
        reg.close();
        await until(() => stopped.includes("3"));
    });

    test("a token revoked while a request's body is still coming in doesn't reach a tool", async () => {
        let ran = false;
        const reg = registerTools([{ ...echo, call: async () => ((ran = true), { text: "ran" }) }]);
        let push!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start: (c) => void (push = c) });
        const json = new TextEncoder().encode(JSON.stringify(call(1, "echo")));
        const pending = fetch(reg.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: reg.authorization }, body, duplex: "half" } as RequestInit);
        push.enqueue(json.slice(0, 10));
        await Bun.sleep(100);
        reg.close();
        push.enqueue(json.slice(10));
        push.close();
        expect((await pending).status).toBe(401);
        expect(ran).toBe(false);
    });

    test("the harness's own MCP client can use it (a client that probes for the newer protocol first)", async () => {
        const reg = registerTools([echo], () => "hello");
        const c = new McpClient("harness", { url: reg.url, headers: { Authorization: reg.authorization } }, cwd);
        try {
            await c.connect();
            expect(c.era).toBe("legacy");
            expect(c.instructions).toBe("hello");
            expect((await c.listTools()).map((t) => t.name)).toEqual(["echo"]);
            const r = await c.callTool("echo", { a: 1 });
            expect(r.isError).toBe(false);
            expect((r.content[0] as any).text).toContain('{"a":1}');
        } finally {
            await c.close();
            reg.close();
        }
    });
});

// ---------------------------------------------------------------------------

describe("which models a backend delegates to", () => {
    test("its own provider's models (and the same through OpenRouter) aren't offered", () => {
        expect(nativeModel("claude-code", { provider: "anthropic", id: "claude-x" })).toBe(true);
        expect(nativeModel("claude-code", { provider: "claude-code", id: "default" })).toBe(true);
        expect(nativeModel("claude-code", { provider: "openrouter", id: "anthropic/claude-x" })).toBe(true);
        expect(nativeModel("claude-code", { provider: "openrouter", id: "openai/gpt-x" })).toBe(false);
        expect(nativeModel("claude-code", { provider: "codex", id: "gpt-test" })).toBe(false);
        expect(nativeModel("codex", { provider: "openai", id: "gpt-x" })).toBe(true);
        expect(nativeModel("codex", { provider: "openrouter", id: "openai/gpt-x" })).toBe(true);
        expect(nativeModel("codex", { provider: "claude-code", id: "default" })).toBe(false);
        // Harness models have no sub-agents of their own: everything is theirs to use.
        expect(nativeModel("anthropic", { provider: "anthropic", id: "claude-x" })).toBe(false);
    });

    test("delegation is offered only with someone to delegate to", () => {
        expect(delegationAvailable("claude-code", [listing("claude-code", ["default"]), listing("anthropic", ["claude-x"]), listing("openrouter", ["anthropic/claude-y"])])).toBe(false);
        expect(delegationAvailable("claude-code", [listing("claude-code", ["default"]), listing("codex", ["gpt-test"])])).toBe(true);
        expect(delegationAvailable("codex", [listing("codex", ["gpt-test"]), listing("openai", ["gpt-x"])])).toBe(false);
        expect(delegationAvailable("codex", [listing("gemini", ["gemini-test"])])).toBe(true);
    });
});

describe("the delegate tools", () => {
    function setup(caller = "claude-code", run?: (req: ChildRequest, signal: AbortSignal) => Promise<ChildResult>, claimCall: () => Promise<string | undefined> = async () => "call-1") {
        const runs: ChildRequest[] = [];
        const done = (req: ChildRequest): ChildResult => ({ status: "done", report: `did: ${req.prompt}`, model: req.model!, tokens: 1200, cost: 0.01, durationMs: 5 });
        const tasks = new Delegations(async (req, signal) => (runs.push(req), run ? run(req, signal) : done(req)));
        const tools = orchestratorTools({
            caller: () => caller,
            listings: () => listings,
            projectRoot: () => cwd,
            checkModel: async (ref) => (ref.startsWith("gemini:") ? { ok: true } : `${ref} isn't set up here.`),
            claimCall,
            tasks,
        });
        const call = (name: string, args: Record<string, unknown>, signal = new AbortController().signal) => tools.find((t) => t.name === name)!.call(args, { signal, meta: {} });
        return { tasks, call, runs, tools };
    }
    /** A child that works until let go, and stops when cancelled. */
    const gated = (g: ReturnType<typeof gate>) => async (req: ChildRequest, signal: AbortSignal): Promise<ChildResult> => {
        try {
            await g.wait(signal);
            return { status: "done", report: `did: ${req.prompt}`, model: req.model!, tokens: 10, durationMs: 5 };
        } catch {
            return { status: "cancelled", report: "It was stopped.", model: req.model!, tokens: 0, durationMs: 5 };
        }
    };

    test("are the four, described for the model", () => {
        const { tools } = setup();
        expect(tools.map((t) => t.name)).toEqual(TOOLS);
        const delegate = tools.find((t) => t.name === "delegate")!;
        expect(delegate.inputSchema.required).toEqual(["task", "description"]);
        expect(Object.keys((delegate.inputSchema as any).properties)).toEqual(["task", "description", "model", "agent", "wait", "timeout_minutes"]);
    });

    test("delegate runs the task and returns its report", async () => {
        const { call, runs, tasks } = setup();
        const r = await call("delegate", { task: "Review src/a.ts", description: "Review a.ts", model: "gemini:gemini-test", agent: "explore" });
        expect(r.isError).toBe(false);
        expect(r.text).toBe('Task task-1 "Review a.ts" (explore on gemini:gemini-test) finished (1.2k tokens, $0.010, 0s).\n\ndid: Review src/a.ts');
        expect(runs).toEqual([{ description: "Review a.ts", prompt: "Review src/a.ts", agent: "explore", model: "gemini:gemini-test", callId: "call-1", writes: false, generation: 0 } as any]);
        expect(tasks.get("task-1")!.delivered).toBe(true);
    });

    test("refuses the caller's own models and says what to use instead", async () => {
        for (const [caller, model, own] of [
            ["claude-code", "anthropic:claude-x", "your own Agent tool"],
            ["claude-code", "claude-code:default", "your own Agent tool"],
            ["claude-code", "openrouter:anthropic/claude-x", "your own Agent tool"],
            ["codex", "openai:gpt-x", "your own sub-agents"],
            ["codex", "codex:gpt-test", "your own sub-agents"],
            ["codex", "openrouter:openai/gpt-x", "your own sub-agents"],
        ] as const) {
            const { call, runs } = setup(caller);
            const r = await call("delegate", { task: "x", description: "x", model });
            expect(r.isError).toBe(true);
            expect(r.text).toContain(`use ${own} for it`);
            expect(runs).toEqual([]);
        }
        // Another vendor's model through OpenRouter is fine (here: not set up).
        const r = await setup("claude-code").call("delegate", { task: "x", description: "x", model: "openrouter:openai/gpt-x" });
        expect(r.text).toBe("openrouter:openai/gpt-x isn't set up here.");
    });

    test("explains a request it can't run", async () => {
        const { call, runs } = setup();
        const err = async (args: Record<string, unknown>) => {
            const r = await call("delegate", args);
            expect(r.isError).toBe(true);
            return r.text;
        };
        expect(await err({ task: "  ", description: "x", model: "gemini:gemini-test" })).toContain("The task is empty");
        expect(await err({ task: "x", description: "x", model: "gemini:gemini-test", agent: "nope" })).toBe('Unknown agent type "nope". Call models to see the agent types.');
        expect(await err({ task: "x", description: "x" })).toContain("Say which model to run it on");
        expect(await err({ task: "x", description: "x", model: "gemini" })).toContain("isn't a model reference");
        expect(await err({ task: "x", description: "x", model: "nope:x" })).toContain("isn't a model reference");
        expect(runs).toEqual([]);
    });

    test("one task that can change files at a time, and a few tasks at once", async () => {
        const g = gate();
        const { call, tasks } = setup("claude-code", gated(g));
        const start = (agent: string) => call("delegate", { task: "t", description: agent, model: "gemini:gemini-test", agent, wait: false });
        expect((await start("general-purpose")).text).toStartWith('Started task task-1 "general-purpose" (general-purpose on gemini:gemini-test)');
        const second = await start("general-purpose");
        expect(second.isError).toBe(true);
        expect(second.text).toContain('Task task-1 "general-purpose" can change files in this folder, and only one such task runs at a time');
        for (let i = 0; i < DELEGATION_LIMITS.running - 1; i++) expect((await start("explore")).isError).toBeFalsy();
        const over = await start("explore");
        expect(over.isError).toBe(true);
        expect(over.text).toContain(`${DELEGATION_LIMITS.running} delegated tasks are running, the most at once`);
        g.open();
        await Promise.all(tasks.list().map((t) => t.settled));
        expect(tasks.list().map((t) => t.status)).toEqual(["done", "done", "done", "done"]);
        expect((await start("general-purpose")).isError).toBeFalsy();
    });

    test("a wait that runs out leaves the task running; task_status gets the result, task_cancel stops one", async () => {
        const g = gate();
        const { call, tasks } = setup("claude-code", gated(g));
        // 0.002 minutes: a wait of 120ms.
        const r = await call("delegate", { task: "slow", description: "Slow", model: "gemini:gemini-test", timeout_minutes: 0.002 });
        expect(r.isError).toBeFalsy();
        expect(r.text).toMatch(/^Task task-1 "Slow" \(general-purpose on gemini:gemini-test\) is still running \(\d+s so far\)\. It keeps running: get its result with task_status/);
        expect((await call("task_status", { task_id: "task-1" })).text).toContain("is still running");
        expect((await call("task_status", { task_id: "task-9" })).text).toBe("No task task-9. Tasks: task-1.");
        setTimeout(() => g.open(), 50);
        const status = await call("task_status", { task_id: "task-1", wait_seconds: 5 });
        expect(status.text).toContain('Task task-1 "Slow" (general-purpose on gemini:gemini-test) finished');
        expect(status.text).toContain("did: slow");
        expect(tasks.get("task-1")!.delivered).toBe(true);
        expect((await call("task_status", {})).text).toBe('Task task-1 "Slow": done (result already given).');

        const g2 = gate();
        const { call: call2 } = setup("claude-code", gated(g2));
        await call2("delegate", { task: "a", description: "A", model: "gemini:gemini-test", wait: false });
        const cancelled = await call2("task_cancel", { task_id: "task-1" });
        expect(cancelled.text).toStartWith('Task task-1 "A" (general-purpose on gemini:gemini-test) was cancelled');
        expect((await call2("task_cancel", { task_id: "task-1" })).text).toBe("Task task-1 already cancelled.");
        expect((await call2("task_cancel", { task_id: "task-2" })).isError).toBe(true);
    });

    test("task_status without an id waits for any running task, and lists them all", async () => {
        const g = gate();
        const { call } = setup("claude-code", gated(g));
        await call("delegate", { task: "a", description: "A", model: "gemini:gemini-test", agent: "explore", wait: false });
        await call("delegate", { task: "b", description: "B", model: "gemini:gemini-test", agent: "explore", wait: false });
        setTimeout(() => g.open(), 50);
        const all = await call("task_status", { wait_seconds: 5 });
        expect(all.text.split("\n\n---\n\n")).toHaveLength(2);
        expect(all.text).toContain("did: a");
        expect(all.text).toContain("did: b");
    });

    test("a task still being set up when the user stops the tasks (esc, /tasks stop, leaving) doesn't start", async () => {
        let claimed!: () => void;
        const { call, tasks, runs } = setup("claude-code", undefined, () => new Promise((r) => (claimed = () => r("call-1"))));
        const pending = call("delegate", { task: "a", description: "A", model: "gemini:gemini-test" });
        await until(() => claimed !== undefined);
        expect(tasks.cancelAll()).toBe(0);
        claimed();
        const r = await pending;
        expect(r.isError).toBe(true);
        expect(r.text).toContain("wasn't started");
        expect(runs).toEqual([]);
        expect(tasks.list()).toEqual([]);
        // A cancelled call doesn't start one either.
        const ac = new AbortController();
        claimed = undefined as any;
        const second = call("delegate", { task: "b", description: "B", model: "gemini:gemini-test" }, ac.signal);
        await until(() => claimed !== undefined);
        ac.abort();
        claimed();
        expect((await second).text).toBe("The call was cancelled before the task started.");
        expect(runs).toEqual([]);
    });

    test("after the session ends, the running tasks stop and no task starts", async () => {
        const g = gate();
        const { call, tasks, runs } = setup("claude-code", gated(g));
        await call("delegate", { task: "a", description: "A", model: "gemini:gemini-test", agent: "explore", wait: false });
        expect(tasks.close().map((t) => t.id)).toEqual(["task-1"]);
        await tasks.get("task-1")!.settled;
        expect(tasks.get("task-1")!.status).toBe("cancelled");
        expect(await call("delegate", { task: "b", description: "B", model: "gemini:gemini-test" })).toEqual({ text: "The session ended, so the task wasn't started.", isError: true });
        expect(runs).toHaveLength(1);
    });

    test("task_cancel waits a moment for the task to stop, and says so when it hasn't yet", async () => {
        const g = gate();
        // It finishes the step it's on before it stops.
        const { call, tasks } = setup("claude-code", async (req) => (await g.wait(), { status: "done", report: `did: ${req.prompt}`, model: req.model!, tokens: 10, durationMs: 5 }));
        const saved = DELEGATION_LIMITS.cancelWaitMs;
        DELEGATION_LIMITS.cancelWaitMs = 50;
        try {
            await call("delegate", { task: "a", description: "A", model: "gemini:gemini-test", wait: false });
            const stopping = "Task task-1 is stopping. task_status shows when it has.";
            expect(await call("task_cancel", { task_id: "task-1" })).toEqual({ text: stopping });
            expect(await call("task_cancel", { task_id: "task-1" })).toEqual({ text: stopping });
            expect(tasks.get("task-1")!.status).toBe("running");
            g.open();
            await tasks.get("task-1")!.settled;
            expect((await call("task_status", { task_id: "task-1" })).text).toContain("did: a");
        } finally {
            DELEGATION_LIMITS.cancelWaitMs = saved;
        }
    });

    test("the call ending (the backend gave up on it) ends the wait, and the task keeps going", async () => {
        const g = gate();
        const { call, tasks } = setup("claude-code", gated(g));
        const ac = new AbortController();
        const pending = call("delegate", { task: "a", description: "A", model: "gemini:gemini-test" }, ac.signal);
        await Bun.sleep(30);
        ac.abort();
        expect((await pending).text).toContain("It keeps running");
        expect(tasks.get("task-1")!.status).toBe("running");
        g.open();
        await tasks.get("task-1")!.settled;
        expect(tasks.undelivered().map((t) => t.id)).toEqual(["task-1"]);
    });
});

// ---------------------------------------------------------------------------

describe("Claude Code as the main agent", () => {
    test("delegates to another provider's model through the harness's MCP server", async () => {
        process.env.FAKE_SCENARIO = "mcp";
        calls([{ tool: "delegate", args: { task: "Write notes.txt, then report", description: "Write notes", model: "gemini:gemini-test" } }]);
        script = (_req, n) => (n === 1 ? use("w1", "Write", { file_path: join(cwd, "notes.txt"), content: "from gemini\n" }) : say("I wrote notes.txt."));
        const { run, events, asked, session } = await makeAgent({ provider: "claude-code" });
        expect(await run("get gemini to write notes")).toBe("done");

        // The server went over stdin, before the prompt, with its tools allowed and a timeout past the longest wait.
        const set = setServers()[0].request.servers.harness;
        expect(set).toMatchObject({ type: "http", alwaysLoad: true, timeout: TOOL_TIMEOUT_SEC * 1000 });
        expect(set.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        expect(set.tools).toEqual(TOOLS.map((name) => ({ name, permission_policy: "always_allow" })));
        const order = received().flatMap((m) => (m.type === "user" ? ["prompt"] : m.type === "control_request" ? [m.request.subtype] : []));
        expect(order.indexOf("mcp_set_servers")).toBeLessThan(order.indexOf("prompt"));
        // The token is in neither its arguments nor the session, and it's redacted.
        const token = String(set.headers.Authorization).replace(/^Bearer /, "");
        expect(token.length).toBeGreaterThan(30);
        expect(JSON.stringify(starts())).not.toContain(token);
        expect(JSON.stringify(session.messages)).not.toContain(token);
        expect(redact(token)).not.toContain(token);

        // It connected, and got the instructions (Claude Code puts them in its system prompt).
        const conn = logLines().find((l) => l.mcpConnected);
        expect(conn).toMatchObject({ mcpConnected: "harness", tools: TOOLS });
        expect(conn.instructions).toContain("For Claude models, keep using your own Agent tool.");

        // The delegated agent's edit was asked about like the main agent's, naming it and its model.
        expect(asked.map((a) => [a.tool.name, a.agentLabel])).toEqual([["Write", "Write notes (gemini:gemini-test)"]]);
        expect(readFileSync(join(cwd, "notes.txt"), "utf-8")).toBe("from gemini\n");
        // Its first request had the task, and no tools to delegate further.
        expect(promptText(childRequests[0]!)).toContain("Write notes.txt, then report");
        const childTools = childRequests[0]!.tools.map((t) => t.name);
        expect(childTools).toContain("Write");
        expect(childTools).not.toContain("Task");
        expect(childTools).not.toContain("ListModels");

        // Claude Code got the report.
        const [result] = mcpResults();
        expect(result.isError).toBe(false);
        expect(result.text).toStartWith('Task task-1 "Write notes" (general-purpose on gemini:gemini-test) finished (');
        expect(result.text).toEndWith("I wrote notes.txt.");

        // Its work shows under the call, which is titled for what it does.
        const start = events.find((e) => e.type === "tool_start" && e.call.name === DELEGATE_TOOL) as any;
        expect(start.title).toBe("Delegate(Write notes · gemini:gemini-test)");
        const subs = events.filter((e) => e.type === "subagent") as any[];
        expect(subs.length).toBeGreaterThan(0);
        expect(subs.every((e) => e.parentId === start.call.id && e.label === "Write notes (gemini:gemini-test)")).toBe(true);
        // Its spend counts toward the session's.
        expect(session.usageByModel.get("gemini:gemini-test")?.usage).toMatchObject({ inputTokens: 200, outputTokens: 40 });
    });

    test("lists the models it can delegate to, without its own", async () => {
        process.env.FAKE_SCENARIO = "mcp";
        calls([{ tool: "models", args: {} }]);
        const { run } = await makeAgent({ provider: "claude-code" });
        expect(await run("what can you use?")).toBe("done");
        const text = mcpResults()[0].text as string;
        expect(text).toContain("general-purpose:");
        expect(text).toContain("explore:");
        expect(text).toContain("gemini:gemini-test (Gemini Test, 1.00M context)");
        expect(text).toContain("codex:gpt-test");
        expect(text).toContain("openrouter:openai/gpt-x");
        expect(text).not.toContain("anthropic/claude-x");
        expect(text).not.toContain("claude-code:default");
    });

    test("a background task follows the session's speed when it changes", async () => {
        process.env.FAKE_SCENARIO = "mcp";
        calls([{ tool: "delegate", args: { task: "Look around", description: "Look", model: "gemini:gemini-fast", agent: "explore", wait: false } }]);
        const g = gate();
        script = async (req, n) => {
            if (n > 1) return say("Done.");
            await g.wait(req.signal);
            return use("g1", "Glob", { pattern: "*" });
        };
        listings = listings.map((l) => (l.provider.id === "gemini" ? listing("gemini", ["gemini-test", "gemini-fast"]) : l));
        const { run, agent, session } = await makeAgent({ provider: "claude-code", model: { supportsFastMode: true }, settings: { fastMode: false } });
        session.setFastMode(true);
        expect(await run("start")).toBe("done");
        expect(mcpResults()[0].text).toStartWith("Started task task-1");
        await until(() => childRequests.length === 1);
        session.setFastMode(false);
        g.open();
        await agent.delegatedTasks[0]!.settled;
        expect(agent.delegatedTasks[0]!.status).toBe("done");
        expect(childRequests.map((r) => r.fastMode)).toEqual([true, false]);
    });

    test("a background task's result comes with the next prompt", async () => {
        process.env.FAKE_SCENARIO = "mcp";
        calls([{ tool: "delegate", args: { task: "Review the code", description: "Review", model: "gemini:gemini-test", agent: "explore", wait: false } }]);
        const g = gate();
        script = async (req) => {
            await g.wait(req.signal);
            return say("Looks fine.");
        };
        const { run, events, agent } = await makeAgent({ provider: "claude-code" });
        expect(await run("start a review")).toBe("done");
        expect(mcpResults()[0].text).toStartWith('Started task task-1 "Review" (explore on gemini:gemini-test)');
        expect(notices(events)).toContain("info: 1 delegated task is still running. Its result goes to Claude Code with your next message (/tasks shows them, /tasks stop stops them).");
        expect(agent.delegatedTasks.map((t) => t.status)).toEqual(["running"]);

        g.open();
        await agent.delegatedTasks[0]!.settled;
        expect(notices(events)).toContain('info: Delegated task task-1 "Review" (gemini:gemini-test) finished. Its result goes to Claude Code with your next message.');

        calls([]);
        expect(await run("anything back?")).toBe("done");
        const last = userTexts().at(-1)!;
        expect(last).toContain("A task you delegated (with the harness delegate tool) has ended.");
        expect(last).toContain("Looks fine.");
        expect(last).toContain("anything back?");
        // Given once.
        expect(await run("and now?")).toBe("done");
        expect(userTexts().at(-1)).not.toContain("A task you delegated");
    });

    test("in a one-shot run (-p) there's no next message: the main agent is told to collect results, and a task left running stops with the run", async () => {
        process.env.FAKE_SCENARIO = "mcp";
        calls([{ tool: "delegate", args: { task: "Review the code", description: "Review", model: "gemini:gemini-test", agent: "explore", wait: false } }]);
        const g = gate();
        script = async (req) => {
            await g.wait(req.signal);
            return say("Looks fine.");
        };
        const { run, events, agent } = await makeAgent({ provider: "claude-code", headless: true });
        expect(await run("start a review")).toBe("done");
        const conn = logLines().find((l) => l.mcpConnected);
        expect(conn.instructions).toContain("This run ends with your turn: get every task's result before you finish");
        expect(conn.instructions).not.toContain("next message");
        expect(notices(events)).toContain("info: 1 delegated task is still running. It stops with this run.");
        await agent.dispose(1000);
        expect(agent.delegatedTasks.map((t) => t.status)).toEqual(["cancelled"]);
    });

    test("interrupting the turn stops the tasks it delegated", async () => {
        process.env.FAKE_SCENARIO = "mcp";
        calls([{ tool: "delegate", args: { task: "Take forever", description: "Forever", model: "gemini:gemini-test", agent: "explore" } }]);
        script = async (req) => {
            await gate().wait(req.signal);
            return say("never");
        };
        const { run, events, agent } = await makeAgent({ provider: "claude-code" });
        const ac = new AbortController();
        const done = run("go", ac.signal);
        await until(() => childRequests.length > 0);
        ac.abort();
        expect(await done).toBe("aborted");
        expect(agent.delegatedTasks.map((t) => t.status)).toEqual(["cancelled"]);
        expect(notices(events)).toContain("info: Stopped 1 delegated task.");
    });

    test("after a switch to a harness model, esc still stops the tasks running in the background", async () => {
        process.env.FAKE_SCENARIO = "mcp";
        calls([{ tool: "delegate", args: { task: "Review", description: "Review", model: "gemini:gemini-test", agent: "explore", wait: false } }]);
        script = async (req) => {
            await gate().wait(req.signal);
            return say("never");
        };
        const { run, agent, events } = await makeAgent({ provider: "claude-code" });
        expect(await run("start it")).toBe("done");
        expect(agent.delegatedTasks.map((t) => t.status)).toEqual(["running"]);
        // A model that works until it's stopped.
        const native = { stream: (req: ChatRequest) => gate().wait(req.signal).then(() => say("never")), listModels: async () => [] };
        agent.setModel({ provider: "anthropic", id: "claude-main" }, native as any);
        const ac = new AbortController();
        const done = run("something else", ac.signal);
        await Bun.sleep(50);
        ac.abort();
        expect(await done).toBe("aborted");
        await agent.delegatedTasks[0]!.settled;
        expect(agent.delegatedTasks.map((t) => t.status)).toEqual(["cancelled"]);
        expect(notices(events)).toContain("info: Stopped 1 delegated task.");
    });

    test("stopping a task withdraws its permission prompt, and stops the shells it started", async () => {
        process.env.FAKE_SCENARIO = "mcp";
        calls([{ tool: "delegate", args: { task: "Start a watcher, then edit", description: "Watch", model: "gemini:gemini-test", wait: false } }]);
        script = (_req, n) =>
            n === 1
                ? reply(
                      [
                          { type: "tool_call", id: "b1", name: "Bash", input: { command: "sleep 30", run_in_background: true } },
                          // A launcher that leaves its watcher running (writing elsewhere) and exits.
                          { type: "tool_call", id: "b2", name: "Bash", input: { command: "sleep 31 > /dev/null 2>&1 & echo $!", run_in_background: true } },
                      ],
                      "tool_use",
                  )
                : n === 2
                  ? use("w1", "Write", { file_path: join(cwd, "x.txt"), content: "x\n" })
                  : say("done");
        // The user doesn't answer the edit's prompt.
        const { run, agent, asked } = await makeAgent({ provider: "claude-code", ask: (req) => (req.tool.name === "Write" ? new Promise<PermissionResponse>(() => {}) : { allow: true }) });
        let killedOther = false;
        const otherShell = { id: "other", command: "npm run dev", startedAt: 0, output: "", readOffset: 0, exitCode: null, kill: async () => ((killedOther = true), "stopped" as const) };
        agent.state.shells.set("other", otherShell);
        expect(await run("go")).toBe("done");
        await until(() => asked.some((a) => a.tool.name === "Write"));
        const prompt = asked.find((a) => a.tool.name === "Write")!;
        expect(prompt.signal?.aborted).toBe(false);
        const shell = [...agent.state.shells.values()].find((s) => s.command === "sleep 30")!;
        expect(shell.exitCode).toBeNull();
        const launcher = [...agent.state.shells.values()].find((s) => s.command.startsWith("sleep 31"))!;
        await until(() => launcher.exitCode !== null && launcher.output.trim() !== "");
        const watcher = Number(launcher.output.trim());
        const alive = (pid: number) => {
            try {
                return process.kill(pid, 0);
            } catch {
                return false;
            }
        };
        expect(alive(watcher)).toBe(true);

        expect(agent.stopDelegated("task-1")).toBe(1);
        await agent.delegatedTasks[0]!.settled;
        expect(prompt.signal!.aborted).toBe(true);
        expect(agent.delegatedTasks[0]!.status).toBe("cancelled");
        expect(shell.exitCode).not.toBeNull();
        await until(() => !alive(watcher));
        expect(killedOther).toBe(false);
        expect(existsSync(join(cwd, "x.txt"))).toBe(false);
    });

    test("a delegate request goes with the call it came from: by id when the backend sends one, by its arguments otherwise", async () => {
        const { agent } = await makeAgent({ provider: "claude-code" });
        const a = agent as any;
        const input = { task: "t", description: "d", model: "gemini:gemini-test" };
        const open = (id: string) => a.delegateCalls.push({ id, input, claimed: false });
        open("c1");
        open("c2");
        expect(await a.claimDelegateCall(input, { callId: "c2" })).toBe("c2");
        expect(await a.claimDelegateCall(input, {})).toBe("c1");
        // A call not seen yet is waited for, though another with the same arguments is open.
        open("c3");
        const pending = a.claimDelegateCall(input, { callId: "c4" });
        await Bun.sleep(100);
        open("c4");
        expect(await pending).toBe("c4");
        // An id that never shows up: the arguments decide.
        expect(await a.claimDelegateCall(input, { callId: "c9" })).toBe("c3");
        expect(await a.claimDelegateCall({ ...input, task: "other" }, {})).toBeUndefined();
    });

    test("/tasks stop and leaving the session stop tasks, and the token stops working", async () => {
        process.env.FAKE_SCENARIO = "mcp";
        calls([
            { tool: "delegate", args: { task: "One", description: "One", model: "gemini:gemini-test", agent: "explore", wait: false } },
            { tool: "delegate", args: { task: "Two", description: "Two", model: "gemini:gemini-other", agent: "explore", wait: false } },
        ]);
        script = async (req) => {
            await gate().wait(req.signal);
            return say("never");
        };
        const { run, agent } = await makeAgent({ provider: "claude-code" });
        expect(await run("go")).toBe("done");
        expect(agent.delegatedTasks.map((t) => [t.id, t.model, t.status])).toEqual([
            ["task-1", "gemini:gemini-test", "running"],
            ["task-2", "gemini:gemini-other", "running"],
        ]);
        expect(agent.stopDelegated("task-1")).toBe(1);
        expect(agent.stopDelegated("task-1")).toBe(0);
        await agent.delegatedTasks[0]!.settled;
        expect(agent.delegatedTasks.map((t) => t.status)).toEqual(["cancelled", "running"]);

        const set = setServers()[0].request.servers.harness;
        await agent.dispose(2000);
        expect(agent.delegatedTasks.map((t) => t.status)).toEqual(["cancelled", "cancelled"]);
        const r = await fetch(set.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: set.headers.Authorization }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
        expect(r.status).toBe(401);
        // Nor does a later turn get the tools.
        rmSync(LOG, { force: true });
        calls([]);
        expect(await run("again")).toBe("done");
        expect(setServers()).toEqual([]);
    });

    test("a delegated Codex agent works under the same prompts, and gets no delegation tools of its own", async () => {
        process.env.FAKE_SCENARIO = "mcp";
        process.env.FAKE_CODEX_SCENARIO = "cmd";
        calls([{ tool: "delegate", args: { task: "Touch x", description: "Touch", model: "codex:gpt-test" } }]);
        const { run, asked } = await makeAgent({ provider: "claude-code" });
        expect(await run("go")).toBe("done");
        const thread = received().find((m) => m.method === "thread/start")!.params;
        expect(thread.config).toBeUndefined();
        expect(thread.developerInstructions).toStartWith("You are working as a sub-agent of");
        expect(thread.developerInstructions).not.toContain("Delegating to other models");
        expect(asked.map((a) => [a.tool.name, a.agentLabel])).toEqual([["Bash", "Touch (codex:gpt-test)"]]);
        expect(logLines().find((l) => "ran" in l)).toMatchObject({ ran: true });
        // Its report is its answer (its last message), then what it did: not what it said on the way.
        expect(mcpResults()[0].text).toEndWith("\n\nFinished.\n\n[Codex used: Bash(touch x)]");
        expect(mcpResults()[0].text).not.toContain("Running it.");
    });

    test("the Codex thread a delegated agent ran on is recorded in the session it ran for, not taken for one of the user's", async () => {
        process.env.FAKE_SCENARIO = "mcp";
        process.env.FAKE_CODEX_SCENARIO = "cmd";
        calls([{ tool: "delegate", args: { task: "Touch x", description: "Touch", model: "codex:gpt-test" } }]);
        const { run, session } = await makeAgent({ provider: "claude-code", persist: true });
        try {
            expect(await run("go")).toBe("done");
            const { cliLinks } = await import("../src/agent/session");
            const links = cliLinks(session.path);
            expect(links.filter((l) => l.kind === "subagent")).toEqual([{ provider: "codex", id: "thr-new", kind: "subagent" }]);
            // The parent's own Claude Code session is its backend, as before.
            expect(links.some((l) => l.kind === "backend" && l.provider === "claude-code")).toBe(true);
        } finally {
            session.release();
        }
    });

    test("a delegated Codex agent whose model marks its messages reports the ones it marks as its answer", async () => {
        process.env.FAKE_SCENARIO = "mcp";
        process.env.FAKE_CODEX_SCENARIO = "subagent";
        process.env.FAKE_PHASES = "1";
        calls([{ tool: "delegate", args: { task: "Count", description: "Count", model: "codex:gpt-test" } }]);
        const { run } = await makeAgent({ provider: "claude-code" });
        expect(await run("go")).toBe("done");
        const report = mcpResults()[0].text as string;
        expect(report).toEndWith("\n\nFinished.\n\n[Codex used: Task(Count the files), Wait for sub-agents]");
        // Neither its own narration nor its sub-agent's words.
        for (const not of ["Running it.", "Looking around.", "CHILD_REPORT"]) expect(report).not.toContain(not);
    });

    test("a delegated Codex agent's report is redacted, as its stored turn is", async () => {
        process.env.FAKE_SCENARIO = "mcp";
        process.env.FAKE_CODEX_SCENARIO = "cmd";
        const token = "ghp_" + "a".repeat(36);
        process.env.FAKE_FINAL_TEXT = `Done. The token is ${token}.`;
        calls([{ tool: "delegate", args: { task: "Touch x", description: "Touch", model: "codex:gpt-test" } }]);
        const { run } = await makeAgent({ provider: "claude-code" });
        expect(await run("go")).toBe("done");
        const report = mcpResults()[0].text as string;
        expect(report).toContain("Done. The token is [REDACTED github-token].");
        expect(report).not.toContain(token);
    });

    test("a read-only agent on Codex can't change anything, the user isn't asked, and it goes on to its report", async () => {
        process.env.FAKE_SCENARIO = "mcp";
        process.env.FAKE_CODEX_SCENARIO = "cmd";
        calls([{ tool: "delegate", args: { task: "Look around", description: "Look", model: "codex:gpt-test", agent: "explore" } }]);
        const { run, asked } = await makeAgent({ provider: "claude-code" });
        expect(await run("go")).toBe("done");
        const thread = received().find((m) => m.method === "thread/start")!.params;
        expect(thread).toMatchObject({ approvalPolicy: "untrusted", sandbox: "read-only" });
        expect(thread.developerInstructions).toContain("This task is read-only");
        expect(asked).toEqual([]);
        expect(logLines().find((l) => "ran" in l)).toMatchObject({ ran: false });
        // Declined, not cancelled: a refused command doesn't end the task before it reports.
        expect(received().find((m) => m.result?.decision)?.result.decision).toBe("decline");
        expect(mcpResults()[0]).toMatchObject({ isError: false, text: expect.stringContaining("Finished.") });
        // No user MCP servers: no config.
        expect(thread.config).toBeUndefined();
    });

    test("a read-only agent on Codex runs with the user's own MCP servers turned off, or not at all", async () => {
        process.env.FAKE_SCENARIO = "mcp";
        process.env.FAKE_CODEX_SCENARIO = "cmd";
        process.env.FAKE_USER_MCP = JSON.stringify({ files: { command: "files-mcp", default_tools_approval_mode: "approve" }, "web.search": { url: "http://127.0.0.1:9/mcp" } });
        calls([{ tool: "delegate", args: { task: "Look around", description: "Look", model: "codex:gpt-test", agent: "explore" } }]);
        const { run } = await makeAgent({ provider: "claude-code" });
        expect(await run("go")).toBe("done");
        expect(received().find((m) => m.method === "config/read")!.params).toEqual({ cwd });
        expect(received().find((m) => m.method === "thread/start")!.params.config).toEqual({ mcp_servers: { files: { enabled: false }, "web.search": { enabled: false } } });

        // Codex can't list them: the task doesn't run there.
        rmSync(LOG, { force: true });
        process.env.FAKE_NO_CONFIG_READ = "1";
        const second = await makeAgent({ provider: "claude-code" });
        expect(await second.run("go")).toBe("done");
        expect(received().some((m) => m.method === "thread/start")).toBe(false);
        const [result] = mcpResults();
        expect(result.isError).toBe(true);
        expect(result.text).toContain("Codex didn't list its MCP servers (config/read failed: invalid configuration), so a read-only task can't run on it");
    });

    test("without the server (turned off, nobody to delegate to, or Claude Code refusing it) the turn runs as before", async () => {
        const { run } = await makeAgent({ provider: "claude-code", settings: { delegation: false } });
        expect(await run("hi")).toBe("done");
        expect(setServers()).toEqual([]);

        rmSync(LOG, { force: true });
        listings = [listing("claude-code", ["default"]), listing("anthropic", ["claude-x"]), listing("openrouter", ["anthropic/claude-y"])];
        const second = await makeAgent({ provider: "claude-code" });
        expect(await second.run("hi")).toBe("done");
        expect(setServers()).toEqual([]);

        rmSync(LOG, { force: true });
        listings = [listing("gemini", ["gemini-test"])];
        process.env.FAKE_MCP_REFUSE = "1";
        const third = await makeAgent({ provider: "claude-code" });
        expect(await third.run("hi")).toBe("done");
        expect(setServers()).toHaveLength(1);
        expect(notices(third.events)).toContain("warn: Claude Code couldn't connect to Harness's delegation tools (Unsupported control request subtype: mcp_set_servers); this turn runs without them.");
        expect(readFileSync(join(cwd, "out.txt"), "utf-8")).toBe("hi\n");
    });
});

describe("Codex as the main agent", () => {
    test("gets the server in its thread config and the instructions as developer instructions; the work shows under the call", async () => {
        process.env.FAKE_SCENARIO = "mcp";
        calls([
            { tool: "models", args: {} },
            { tool: "delegate", args: { task: "Summarize README", description: "Summarize", model: "gemini:gemini-test", agent: "explore" } },
        ]);
        const { run, events } = await makeAgent({ provider: "codex" });
        expect(await run("go")).toBe("done");

        const thread = received().find((m) => m.method === "thread/start")!.params;
        const cfg = thread.config.mcp_servers.harness;
        expect(cfg).toMatchObject({ tool_timeout_sec: TOOL_TIMEOUT_SEC, startup_timeout_sec: 30, default_tools_approval_mode: "approve", supports_parallel_tool_calls: true });
        expect(cfg.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        const token = String(cfg.http_headers.Authorization).replace(/^Bearer /, "");
        expect(JSON.stringify(starts())).not.toContain(token);
        expect(thread.developerInstructions).toContain("For OpenAI models, keep using your own sub-agents.");
        // Given once: not again as the server's instructions.
        const conn = logLines().find((l) => l.mcpConnected);
        expect(conn).toMatchObject({ mcpConnected: "harness", tools: TOOLS, approvalMode: "approve" });
        expect(conn.instructions).toBeUndefined();

        const [models, delegated] = mcpResults();
        expect(models.text).toContain("gemini:gemini-test");
        expect(models.text).toContain("claude-code:default");
        expect(models.text).toContain("openrouter:anthropic/claude-x");
        expect(models.text).not.toContain("openai/gpt-x");
        expect(models.text).not.toContain("codex:gpt-test");
        expect(delegated.text).toStartWith('Task task-1 "Summarize" (explore on gemini:gemini-test) finished');
        expect(delegated.text).toContain("Report on: Summarize README");

        const start = events.find((e) => e.type === "tool_start" && e.call.name === DELEGATE_TOOL) as any;
        expect(start.call.id).toBe("mcp-turn-1-1");
        expect(start.title).toBe("Delegate(Summarize · gemini:gemini-test)");
        const subs = events.filter((e) => e.type === "subagent") as any[];
        expect(subs.length).toBeGreaterThan(0);
        expect(new Set(subs.map((e) => e.parentId))).toEqual(new Set(["mcp-turn-1-1"]));
        expect(events.find((e) => e.type === "tool_start" && e.call.name === "mcp__harness__models")).toMatchObject({ title: "Models" });
    });

    test("a read-only agent on Claude Code starts without its edit tools or MCP servers, and every command comes to the harness", async () => {
        process.env.FAKE_CODEX_SCENARIO = "mcp";
        process.env.FAKE_SCENARIO = "bash";
        calls([{ tool: "delegate", args: { task: "Run the tests and report", description: "Tests", model: "claude-code:default", agent: "explore" } }]);
        const { run, asked } = await makeAgent({ provider: "codex" });
        expect(await run("go")).toBe("done");
        const argv: string[] = starts().find((s) => s.argv.includes("--permission-prompt-tool=stdio"))!.argv;
        expect(argv[argv.indexOf("--disallowedTools") + 1]).toBe("Write,Edit,MultiEdit,NotebookEdit");
        expect(argv).toContain("--strict-mcp-config");
        expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("default");
        const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
        expect(settings.sandbox).toEqual({ autoAllowBashIfSandboxed: false });
        expect(settings.permissions.ask).toContain("Bash");
        expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Write", "Edit", "MultiEdit", "NotebookEdit"]));
        // `npm test` isn't read-only: refused, and the user isn't asked.
        expect(asked).toEqual([]);
        const reply = received().find((m) => m.type === "control_response" && m.response?.response?.behavior)!.response.response;
        expect(reply.behavior).toBe("deny");
        expect(reply.message).toContain("read-only agent");
        // No harness server for the child.
        expect(setServers()).toEqual([]);
        expect(mcpResults()[0].text).toContain('(explore on claude-code:default) finished');
    });

    test("a read-only agent on Claude Code runs read-only commands without asking", async () => {
        process.env.FAKE_CODEX_SCENARIO = "mcp";
        process.env.FAKE_SCENARIO = "bash";
        process.env.FAKE_COMMAND = "wc -l greet.py";
        calls([{ tool: "delegate", args: { task: "Count lines", description: "Count", model: "claude-code:default", agent: "explore" } }]);
        const { run, asked } = await makeAgent({ provider: "codex", ask: () => ({ allow: false }) });
        expect(await run("go")).toBe("done");
        expect(asked).toEqual([]);
        const reply = received().find((m) => m.type === "control_response" && m.response?.response?.behavior)!.response.response;
        expect(reply.behavior).toBe("allow");
    });

    test("a read-only agent on Codex runs read-only commands without asking, and refuses one that only looks read-only", async () => {
        process.env.FAKE_SCENARIO = "mcp";
        process.env.FAKE_CODEX_SCENARIO = "cmd";
        process.env.FAKE_COMMAND = "wc -l greet.py";
        calls([{ tool: "delegate", args: { task: "Count lines", description: "Count", model: "codex:gpt-test", agent: "explore" } }]);
        const first = await makeAgent({ provider: "claude-code", ask: () => ({ allow: false }) });
        expect(await first.run("go")).toBe("done");
        expect(first.asked).toEqual([]);
        expect(logLines().find((l) => "ran" in l)).toMatchObject({ ran: true, command: "wc -l greet.py" });
        // Unlike a Codex agent that may change things in manual mode, it isn't told it can.
        const childTurn = received().find((m) => m.method === "turn/start");
        expect(childTurn.params.input[0].text).not.toContain("you can still change files");

        // Codex's parsed form leaves the touch out; the whole command is what's checked.
        rmSync(LOG, { force: true });
        process.env.FAKE_COMMAND_SCRIPT = "touch y; wc -l greet.py";
        const second = await makeAgent({ provider: "claude-code", ask: () => ({ allow: false }) });
        expect(await second.run("go")).toBe("done");
        expect(second.asked).toEqual([]);
        expect(logLines().find((l) => "ran" in l)).toMatchObject({ ran: false });
        // Codex's model hears only "rejected": it's told why, and which commands do run.
        expect(received().find((m) => m.method === "turn/steer")?.params.input[0].text).toContain("This is a read-only agent: only read-only commands run (plain commands such as cat");
    });

    test("a mode change reaches the Claude Code agents it delegated to, and a read-only one stays read-only", async () => {
        process.env.FAKE_CODEX_SCENARIO = "mcp";
        process.env.FAKE_SCENARIO = "hang";
        const modeSets = () => received().flatMap((m) => (m.type === "control_request" && m.request?.subtype === "set_permission_mode" ? [m.request.mode] : []));
        for (const [type, expected] of [
            ["general-purpose", ["bypassPermissions", "plan"]],
            ["explore", ["default", "plan"]],
        ] as const) {
            rmSync(LOG, { force: true });
            calls([{ tool: "delegate", args: { task: "Wait", description: "Wait", model: "claude-code:default", agent: type, wait: false } }]);
            const { run, agent, switchMode } = await makeAgent({ provider: "codex" });
            expect(await run("go")).toBe("done");
            await until(() => received().some((m) => m.type === "user"));
            switchMode("bypassPermissions");
            switchMode("plan");
            await until(() => modeSets().length === 2);
            expect(modeSets()).toEqual([...expected]);
            agent.stopDelegated();
            await agent.delegatedTasks[0]!.settled;
            expect(agent.delegatedTasks[0]!.status).toBe("cancelled");
        }
    });

    test("a Codex that won't take the config keeps its thread, and runs without the tools", async () => {
        const { run, events, session } = await makeAgent({ provider: "codex" });
        expect(await run("first")).toBe("done");
        expect(session.backends.get("codex")?.id).toBe("thr-new");
        process.env.FAKE_REJECT_CONFIG = "1";
        rmSync(LOG, { force: true });
        expect(await run("second")).toBe("done");
        const resumes = received().filter((m) => m.method === "thread/resume").map((m) => m.params);
        expect(resumes).toHaveLength(2);
        expect(resumes[0].config).toBeDefined();
        expect(resumes[1].config).toBeUndefined();
        expect(resumes[1].developerInstructions).toBeUndefined();
        expect(resumes[1].threadId).toBe("thr-new");
        expect(received().some((m) => m.method === "thread/start")).toBe(false);
        expect(notices(events)).toContain("warn: Codex didn't accept Harness's delegation tools (invalid config: unknown field `default_tools_approval_mode`); this turn runs without them.");
        expect(notices(events).join("\n")).not.toContain("Starting a new one");

        const fresh = await makeAgent({ provider: "codex" });
        expect(await fresh.run("new")).toBe("done");
        const starts = received().filter((m) => m.method === "thread/start").map((m) => m.params);
        expect(starts.map((s) => Boolean(s.config))).toEqual([true, false]);
    });

    test("no server with nobody to delegate to", async () => {
        listings = [listing("codex", ["gpt-test"]), listing("openai", ["gpt-x"]), listing("openrouter", ["openai/gpt-y"])];
        const { run } = await makeAgent({ provider: "codex" });
        expect(await run("go")).toBe("done");
        const thread = received().find((m) => m.method === "thread/start")!.params;
        expect(thread.config).toBeUndefined();
        expect(thread.developerInstructions).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------

describe("harness models", () => {
    test("Task runs a sub-agent on the model asked for, and ListModels shows what can run", async () => {
        const mainRequests: ChatRequest[] = [];
        const main = (content: unknown[], stopReason = "end_turn") => ({ role: "assistant", provider: "anthropic", model: "claude-main", stopReason, content, usage: { inputTokens: 10, outputTokens: 5 } });
        const steps = [
            main([{ type: "tool_call", id: "t1", name: "ListModels", input: {} }], "tool_use"),
            main([{ type: "tool_call", id: "t2", name: "Task", input: { description: "Second opinion", prompt: "Is 2+2 4?", model: "gemini:gemini-test", subagent_type: "explore" } }], "tool_use"),
            main([{ type: "tool_call", id: "t3", name: "Task", input: { description: "Bad", prompt: "x", model: "nope:x" } }], "tool_use"),
            main([{ type: "text", text: "ok" }]),
        ];
        const client = { stream: async (req: ChatRequest) => (mainRequests.push(req), steps[mainRequests.length - 1]), listModels: async () => [] };
        script = () => say("Yes, 4.");
        const { run, events, session } = await makeAgent({ provider: "anthropic", model: { id: "claude-main" }, client });
        expect(await run("ask gemini")).toBe("done");

        const tools = mainRequests[0]!.tools;
        expect(tools.map((t) => t.name)).toContain("ListModels");
        expect(Object.keys((tools.find((t) => t.name === "Task")!.parameters as any).properties)).toContain("model");
        const ends = events.flatMap((e) => (e.type === "tool_end" ? [e] : []));
        const listed = ends.find((e) => e.call.id === "t1")!.result.content;
        expect(listed).toContain("you are on anthropic:claude-main");
        expect(listed).toContain("gemini:gemini-test (Gemini Test, 1.00M context)");
        // Nothing is left out for a harness model: it has no sub-agents of its own.
        expect(listed).toContain("openrouter:anthropic/claude-x");
        const task = ends.find((e) => e.call.id === "t2")!;
        expect(task.result.isError).toBeFalsy();
        expect(task.result.content).toBe("Yes, 4.");
        expect(promptText(childRequests[0]!)).toContain("Is 2+2 4?");
        // An explore agent gets read-only tools.
        expect(childRequests[0]!.tools.map((t) => t.name)).not.toContain("Write");
        const subs = events.filter((e) => e.type === "subagent") as any[];
        expect(subs.every((e) => e.parentId === "t2" && e.label === "Second opinion (gemini:gemini-test)")).toBe(true);
        const bad = ends.find((e) => e.call.id === "t3")!;
        expect(bad.result.isError).toBe(true);
        expect(bad.result.content).toContain("Can't run a sub-agent on nope:x");
        expect(session.usageByModel.get("gemini:gemini-test")?.usage.inputTokens).toBe(100);
    });

    test("a sub-agent runs at its session's speed (not the default for new chats) where its model has fast mode", async () => {
        const mainRequests: ChatRequest[] = [];
        const main = (content: unknown[], stopReason = "end_turn") => ({ role: "assistant", provider: "anthropic", model: "claude-main", stopReason, content, usage: { inputTokens: 10, outputTokens: 5 } });
        const steps = [
            main([{ type: "tool_call", id: "t1", name: "Task", input: { description: "Fast one", prompt: "a", model: "gemini:gemini-fast", subagent_type: "explore" } }], "tool_use"),
            main([{ type: "tool_call", id: "t2", name: "Task", input: { description: "Standard one", prompt: "b", model: "gemini:gemini-test", subagent_type: "explore" } }], "tool_use"),
            main([{ type: "text", text: "ok" }]),
        ];
        const client = { stream: async (req: ChatRequest) => (mainRequests.push(req), steps[mainRequests.length - 1]), listModels: async () => [] };
        const { run, session } = await makeAgent({ provider: "anthropic", model: { id: "claude-main", supportsFastMode: true }, client, settings: { fastMode: false } });
        session.setFastMode(true);
        expect(await run("go")).toBe("done");
        expect(mainRequests.map((r) => r.fastMode)).toEqual([true, true, true]);
        // Fast where the sub-agent's model has it; standard on one without.
        expect(childRequests.map((r) => [r.model.id, r.fastMode])).toEqual([["gemini-fast", true], ["gemini-test", false]]);
    });

    test("a Claude Code or Codex sub-agent kept going (a Stop hook) takes up a speed change made meanwhile", async () => {
        const flag = join(cwd, "stopped-once");
        const main = (content: unknown[], stopReason = "end_turn") => ({ role: "assistant", provider: "anthropic", model: "claude-main", stopReason, content, usage: { inputTokens: 10, outputTokens: 5 } });
        const steps = [main([{ type: "tool_call", id: "t1", name: "Task", input: { description: "On Codex", prompt: "a", model: "codex:gpt-fast" } }], "tool_use"), main([{ type: "text", text: "ok" }])];
        let n = 0;
        const client = { stream: async () => steps[n++], listModels: async () => [] };
        const settings = { hooks: { Stop: [{ command: `[ -f '${flag}' ] || { touch '${flag}'; sleep 1; echo "keep going" >&2; exit 2; }` }] } };
        const { run, session } = await makeAgent({ provider: "anthropic", model: { id: "claude-main", supportsFastMode: true }, client, settings });
        session.setFastMode(true);
        const done = run("go");
        await until(() => existsSync(flag));
        session.setFastMode(false);
        expect(await done).toBe("done");
        const turns = received().filter((m) => m.method === "turn/start");
        expect(turns.length).toBe(2);
        expect(turns[0].params.serviceTier).toBe("priority");
        // Standard now: the thread comes off the fast tier.
        expect(turns[1].params.serviceTier).toBeNull();
    });

    test("a session showing standard (its model has no fast mode) doesn't run sub-agents fast", async () => {
        const main = (content: unknown[], stopReason = "end_turn") => ({ role: "assistant", provider: "anthropic", model: "claude-main", stopReason, content, usage: { inputTokens: 10, outputTokens: 5 } });
        const steps = [main([{ type: "tool_call", id: "t1", name: "Task", input: { description: "Fast-capable", prompt: "a", model: "gemini:gemini-fast", subagent_type: "explore" } }], "tool_use"), main([{ type: "text", text: "ok" }])];
        let n = 0;
        const client = { stream: async () => steps[n++], listModels: async () => [] };
        // Fast was chosen on another model; this one has none.
        const { run, session } = await makeAgent({ provider: "anthropic", model: { id: "claude-main", supportsFastMode: false }, client });
        session.setFastMode(true);
        expect(await run("go")).toBe("done");
        expect(childRequests.map((r) => r.fastMode)).toEqual([false]);
    });

    test("a harness model gets no MCP server: delegation is its Task tool", async () => {
        const client = { stream: async () => ({ role: "assistant", provider: "anthropic", model: "claude-main", stopReason: "end_turn", content: [{ type: "text", text: "hi" }] }), listModels: async () => [] };
        const { run, agent } = await makeAgent({ provider: "anthropic", model: { id: "claude-main" }, client });
        expect(await run("hi")).toBe("done");
        expect(agent.delegatedTasks).toEqual([]);
        expect((agent as any).registration).toBeUndefined();
    });
});

describe("the app", () => {
    test("a stopped sub-agent's prompt is withdrawn, and one still queued isn't shown", async () => {
        const app = new App({ cwd, trusted: true, mode: "default", allowBypass: false, startupNotes: [] });
        (app as any).screen = { print: () => ({}), replace() {}, redraw() {}, setLive() {}, flushNow() {}, stop() {}, clearScreen() {}, focus: true };
        (app as any).renderLive = () => {};
        app.session = Session.create(cwd, { persist: false });
        const shown: string[] = [];
        const dialog = (app as any).permissionDialog.bind(app);
        (app as any).permissionDialog = (r: PermissionRequest) => (shown.push(r.title), dialog(r));
        const ask = (title: string, signal?: AbortSignal): Promise<PermissionResponse> =>
            (app as any).askPermission({ tool: { name: "Bash", category: "execute" }, input: { command: "ls" }, title, decision: { behavior: "ask" }, agentLabel: "Watch (gemini:gemini-test)", signal });
        const stopped = new AbortController();
        const first = ask("Bash(one)", stopped.signal);
        const second = ask("Bash(two)", stopped.signal);
        const another = ask("Bash(three)");
        await until(() => (app as any).dialogs.length === 1);
        expect(shown).toEqual(["Bash(one)"]);
        stopped.abort();
        expect(await first).toEqual({ allow: false });
        expect(await second).toEqual({ allow: false });
        // The next one in line is another agent's: it's shown.
        await until(() => shown.length === 2);
        expect(shown).toEqual(["Bash(one)", "Bash(three)"]);
        (app as any).dialogs.at(-1).cancel();
        expect(await another).toEqual({ allow: false });
        // Stopped while its prompt is being put together: it isn't shown.
        await until(() => (app as any).dialogs.length === 0);
        const late = new AbortController();
        const pending = dialog({ tool: { name: "Bash", category: "execute" }, input: { command: "ls" }, title: "Bash(four)", decision: { behavior: "ask" }, signal: late.signal });
        late.abort();
        expect(await pending).toEqual({ allow: false });
        expect((app as any).dialogs).toEqual([]);
    });
});
