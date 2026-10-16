import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir, FAKE } from "./helpers/isolate";

const iso = isolate();
const { McpClient, McpError, headerValue, MODERN_VERSION } = await import("../src/mcp/client");
const { McpManager, toolNameFor, serverSegment, formatMcpResult } = await import("../src/mcp/manager");
const { startHttpMcpServer } = await import("./fixtures/mcp-http-server");
import type { McpServerConfig, Settings } from "../src/config/settings";
import type { McpClient as McpClientT } from "../src/mcp/client";
import type { HttpFixture } from "./fixtures/mcp-http-server";

const FIXTURE = join(import.meta.dir, "fixtures", "mcp-stdio-server.ts");
const WORK = tempDir("harness-mcp-");

function stdio(era: string, env: Record<string, string> = {}): McpServerConfig {
    return { command: process.execPath, args: ["--no-env-file", FIXTURE], env: { MCP_FIXTURE_ERA: era, ...env }, cwd: WORK };
}

const clients: McpClientT[] = [];
const fixtures: HttpFixture[] = [];
function client(name: string, cfg: McpServerConfig): McpClientT {
    const c = new McpClient(name, cfg, WORK);
    clients.push(c);
    return c;
}
function http(mode: "legacy" | "modern" | "auth"): HttpFixture {
    const f = startHttpMcpServer(mode);
    fixtures.push(f);
    return f;
}

afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    for (const f of fixtures) f.stop();
    rmSync(WORK, { recursive: true, force: true });
    iso.cleanup();
});

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (cond()) return true;
        await Bun.sleep(20);
    }
    return cond();
}

function textOf(r: { content: { type: string; text?: string }[] }): string {
    return r.content.map((c) => c.text ?? "").join("");
}

async function serverLog(c: McpClientT): Promise<{ log: { method: string; id: unknown; params: any }[]; cancelled: unknown[] }> {
    return JSON.parse(textOf(await c.callTool("get_log", {})));
}

async function pidOf(c: McpClientT): Promise<number> {
    return Number(textOf(await c.callTool("pid", {})));
}

const ALL_TOOLS = ["echo", "image", "fail", "pid", "ping_client", "server_request", "get_log", "crash", "slow", "needs_input", "list_changed"];

// ---------------------------------------------------------------------------

describe("stdio, legacy server (2025-06-18)", () => {
    let c: McpClientT;

    test("falls back to initialize when server/discover returns -32601", async () => {
        c = client("legacy", stdio("legacy"));
        await c.connect();
        expect(c.era).toBe("legacy");
        expect(c.protocolVersion).toBe("2025-06-18");
        expect(c.serverInfo).toEqual({ name: "fixture-legacy", version: "0.1.0" });
        expect(c.instructions).toBe("Legacy fixture instructions");
    });

    test("listTools follows nextCursor across pages", async () => {
        const tools = await c.listTools();
        expect(tools.map((t) => t.name)).toEqual(ALL_TOOLS);
        expect(c.tools).toBe(tools);
    });

    test("handshake order, initialize params, and no _meta on legacy requests", async () => {
        const { log } = await serverLog(c);
        expect(log.map((l) => l.method)).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/list", "tools/list", "tools/list", "tools/call"]);
        const init = log[1]!;
        expect(init.params.protocolVersion).toBe("2025-11-25");
        expect(init.params.capabilities).toEqual({});
        expect(init.params.clientInfo.name).toBe("harness");
        // notifications/initialized is a notification: no id
        expect(log[2]!.id).toBeNull();
        expect(log[3]!.params).toEqual({});
        expect(log[4]!.params).toEqual({ cursor: "4" });
        expect(log[5]!.params).toEqual({ cursor: "8" });
        for (const l of log.slice(3)) expect(l.params?._meta).toBeUndefined();
    });

    test("callTool returns text content", async () => {
        const r = await c.callTool("echo", { text: "hi there" });
        expect(r).toEqual({ content: [{ type: "text", text: "echo: hi there" }], structuredContent: undefined, isError: false });
    });

    test("callTool returns image content", async () => {
        const r = await c.callTool("image", {});
        expect(r.content).toHaveLength(2);
        expect(r.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
        expect((r.content[1] as { data: string }).data.length).toBeGreaterThan(10);
    });

    test("callTool surfaces isError", async () => {
        const r = await c.callTool("fail", {});
        expect(r.isError).toBe(true);
        expect(textOf(r)).toBe("boom");
    });

    test("client answers a server ping with an empty result", async () => {
        const r = JSON.parse(textOf(await c.callTool("ping_client", {})));
        expect(r).toEqual({ jsonrpc: "2.0", id: "srv-1", result: {} });
    });

    test("client refuses other server requests with -32601", async () => {
        const r = JSON.parse(textOf(await c.callTool("server_request", { method: "roots/list" })));
        expect(r.error.code).toBe(-32601);
        expect(r.result).toBeUndefined();
    });

    test("abort sends notifications/cancelled and rejects with 'aborted'", async () => {
        const ac = new AbortController();
        const p = c.callTool("slow", { ms: 1500 }, ac.signal);
        setTimeout(() => ac.abort(), 50);
        await expect(p).rejects.toThrow("aborted");
        const { cancelled } = await serverLog(c);
        expect(cancelled).toHaveLength(1);
        expect(typeof cancelled[0]).toBe("number");
    });

    test("per-call timeout rejects with code -1", async () => {
        const err = await c.callTool("slow", { ms: 1500 }, undefined, 100).catch((e) => e);
        expect(err).toBeInstanceOf(McpError);
        expect(err.message).toMatch(/tools\/call timed out/);
        expect(err.code).toBe(-1);
    });

    test("close() ends the child process", async () => {
        const pid = await pidOf(c);
        expect(alive(pid)).toBe(true);
        const t0 = Date.now();
        await c.close();
        expect(await waitFor(() => !alive(pid))).toBe(true);
        // The fixture exits on stdin EOF, so no SIGTERM wait was needed.
        expect(Date.now() - t0).toBeLessThan(1400);
        await expect(c.callTool("echo", { text: "x" })).rejects.toThrow("server is not running");
    });
});

describe("stdio, modern server (2026-07-28)", () => {
    let c: McpClientT;

    test("server/discover result selects the modern era (no initialize)", async () => {
        c = client("modern", stdio("modern"));
        await c.connect();
        expect(c.era).toBe("modern");
        expect(c.protocolVersion).toBe(MODERN_VERSION);
        expect(MODERN_VERSION).toBe("2026-07-28");
        expect(c.serverInfo).toEqual({ name: "fixture-modern", version: "0.2.0" });
        expect(c.instructions).toBe("Modern fixture instructions");
    });

    test("every request carries _meta with version, capabilities and client info", async () => {
        const tools = await c.listTools();
        expect(tools.map((t) => t.name)).toEqual(ALL_TOOLS);
        const { log } = await serverLog(c);
        const methods = log.map((l) => l.method);
        expect(methods).toEqual(["server/discover", "tools/list", "tools/list", "tools/list", "tools/call"]);
        expect(methods).not.toContain("initialize");
        expect(methods).not.toContain("notifications/initialized");
        for (const l of log) {
            expect(l.params._meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
            expect(l.params._meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({});
            expect(l.params._meta["io.modelcontextprotocol/clientInfo"].name).toBe("harness");
        }
        expect(log[2]!.params.cursor).toBe("4");
        expect(log[4]!.params.name).toBe("get_log");
        expect(log[4]!.params.arguments).toEqual({});
    });

    test("tools/call with resultType complete", async () => {
        const r = await c.callTool("echo", { text: "modern" });
        expect(r.content).toEqual([{ type: "text", text: "echo: modern" }]);
        expect(r.isError).toBe(false);
        expect((await c.callTool("fail", {})).isError).toBe(true);
    });

    test("resultType input_required is rejected (no sampling/elicitation support)", async () => {
        await expect(c.callTool("needs_input", {})).rejects.toThrow(/extra input/);
    });

    test("server-to-client requests are ignored in the modern era", async () => {
        expect(JSON.parse(textOf(await c.callTool("ping_client", {})))).toBe("no-response");
    });

    test("notifications/tools/list_changed triggers onToolsChanged", async () => {
        let changed = 0;
        c.onToolsChanged = () => changed++;
        await c.callTool("list_changed", {});
        expect(await waitFor(() => changed === 1, 1000)).toBe(true);
    });
});

describe("stdio era detection edge cases", () => {
    test("an empty server/discover result is not a DiscoverResult: legacy fallback", async () => {
        const c = client("lenient", stdio("lenient"));
        await c.connect();
        expect(c.era).toBe("legacy");
        expect(c.protocolVersion).toBe("2025-06-18");
    });

    test("-32022 listing only unknown versions fails without falling back", async () => {
        const c = client("unsup", stdio("unsupported", { MCP_FIXTURE_SUPPORTED: "2027-01-01" }));
        await expect(c.connect()).rejects.toThrow(/none of which this client speaks/);
    });

    test("-32022 listing a legacy version falls back to initialize", async () => {
        const c = client("dual", stdio("unsupported", { MCP_FIXTURE_SUPPORTED: "2027-01-01,2025-11-25" }));
        await c.connect();
        expect(c.era).toBe("legacy");
        expect(c.protocolVersion).toBe("2025-11-25");
    });

    test("a command that cannot be spawned fails fast instead of waiting for the initialize timeout", async () => {
        // Bun emits 'error' but no 'exit' for ENOENT, so the transport is never
        // marked exited and the fallback initialize request waits 60 s.
        const c = new McpClient("missing", { command: join(WORK, "does-not-exist") }, WORK);
        const outcome = await Promise.race([
            c.connect().then(
                () => "connected",
                (e: Error) => `rejected: ${e.message}`,
            ),
            Bun.sleep(3000).then(() => "still pending after 3s"),
        ]);
        expect(outcome).toMatch(/^rejected: /);
    }, 6000);
});

describe("stdio shutdown and crashes", () => {
    test("close() escalates to SIGTERM when the server ignores stdin EOF", async () => {
        const c = client("stubborn", stdio("legacy", { MCP_FIXTURE_IGNORE_EOF: "1" }));
        await c.connect();
        const pid = await pidOf(c);
        const t0 = Date.now();
        await c.close();
        const elapsed = Date.now() - t0;
        expect(await waitFor(() => !alive(pid))).toBe(true);
        expect(elapsed).toBeGreaterThanOrEqual(1400);
        expect(elapsed).toBeLessThan(3400);
    }, 8000);

    test("close() escalates to SIGKILL when SIGTERM is ignored too", async () => {
        const c = client("very-stubborn", stdio("legacy", { MCP_FIXTURE_IGNORE_EOF: "1", MCP_FIXTURE_IGNORE_SIGTERM: "1" }));
        await c.connect();
        const pid = await pidOf(c);
        const t0 = Date.now();
        await c.close();
        expect(Date.now() - t0).toBeGreaterThanOrEqual(3400);
        expect(await waitFor(() => !alive(pid))).toBe(true);
    }, 10000);

    test("a crash rejects the in-flight call, fires onExit, and keeps stderr", async () => {
        const c = client("crashy", stdio("legacy"));
        await c.connect();
        let exited = false;
        c.onExit = () => (exited = true);
        await expect(c.callTool("crash", {})).rejects.toThrow("server exited (3)");
        expect(await waitFor(() => exited)).toBe(true);
        expect(c.stderrTail()).toContain("fatal: fixture crashed on purpose");
        await expect(c.callTool("echo", { text: "x" })).rejects.toThrow("server is not running");
    });

    test("a server config needs a command or url", () => {
        expect(() => new McpClient("empty", {}, WORK)).toThrow(/needs a "command" or a "url"/);
    });
});

// ---------------------------------------------------------------------------

describe("streamable HTTP, legacy server with sessions", () => {
    let f: HttpFixture;
    let c: McpClientT;

    test("falls back to initialize, stores the session id and protocol version", async () => {
        f = http("legacy");
        c = client("http-legacy", { url: f.url, headers: { "X-Custom": "abc" } });
        expect(c.isHttp).toBe(true);
        await c.connect();
        expect(c.era).toBe("legacy");
        expect(c.protocolVersion).toBe("2025-06-18");
        expect(c.serverInfo?.name).toBe("http-legacy");

        const [discover, init, initialized] = f.requests;
        expect(discover!.body!.method).toBe("server/discover");
        expect(discover!.headers["mcp-protocol-version"]).toBe("2026-07-28");
        expect(discover!.headers["mcp-method"]).toBe("server/discover");
        expect(discover!.headers.accept).toContain("application/json");
        expect(discover!.headers.accept).toContain("text/event-stream");
        expect(discover!.headers["x-custom"]).toBe("abc");

        expect(init!.body!.method).toBe("initialize");
        expect(init!.headers["mcp-session-id"]).toBeUndefined();
        expect(init!.headers["mcp-protocol-version"]).toBeUndefined();

        expect(initialized!.body).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
        expect(initialized!.headers["mcp-session-id"]).toBe(f.sessionId!);
        expect(initialized!.headers["mcp-protocol-version"]).toBe("2025-06-18");
    });

    test("listTools paginates and sends the session header", async () => {
        const tools = await c.listTools();
        expect(tools.map((t) => t.name)).toEqual(["greet", "stream_greet"]);
        const lists = f.requests.filter((r) => r.body?.method === "tools/list");
        expect(lists.map((r) => r.body!.params)).toEqual([{}, { cursor: "1" }]);
        for (const r of lists) expect(r.headers["mcp-session-id"]).toBe(f.sessionId!);
        for (const r of lists) expect(r.headers["mcp-method"]).toBeUndefined();
    });

    test("JSON response", async () => {
        const r = await c.callTool("greet", { name: "ada" });
        expect(textOf(r)).toBe("hello ada");
    });

    test("SSE response: notification and ping on the stream are handled before the result", async () => {
        let changed = 0;
        c.onToolsChanged = () => changed++;
        const r = await c.callTool("stream_greet", { name: "bob" });
        expect(textOf(r)).toBe("streamed hello bob");
        expect(changed).toBe(1);
        expect(await waitFor(() => f.clientResponses.length > 0)).toBe(true);
        expect(f.clientResponses[0]).toEqual({ jsonrpc: "2.0", id: "srv-ping-1", result: {} });
    });

    test("close() sends DELETE with the session id", async () => {
        const sid = f.sessionId!;
        await c.close();
        expect(f.deletes).toHaveLength(1);
        expect(f.deletes[0]!.headers["mcp-session-id"]).toBe(sid);
    });

    test("404 on a request with a session id means the session expired", async () => {
        const f2 = http("legacy");
        const c2 = client("http-expire", { url: f2.url });
        await c2.connect();
        f2.expireSession();
        const err = await c2.callTool("greet", { name: "x" }).catch((e) => e);
        expect(err).toBeInstanceOf(McpError);
        expect(err.code).toBe(404);
        expect(err.message).toBe("session expired");
    });
});

describe("streamable HTTP, modern server", () => {
    let f: HttpFixture;
    let c: McpClientT;

    test("server/discover selects the modern era; no initialize", async () => {
        f = http("modern");
        c = client("http-modern", { url: f.url });
        await c.connect();
        expect(c.era).toBe("modern");
        expect(c.serverInfo).toEqual({ name: "http-modern", version: "2.0.0" });
        expect(c.instructions).toBe("HTTP modern instructions");
        expect(f.requests.map((r) => r.body?.method)).toEqual(["server/discover"]);
    });

    test("tools with invalid x-mcp-header annotations are dropped", async () => {
        const tools = await c.listTools();
        expect(tools.map((t) => t.name)).toEqual(["lookup", "plain"]);
        const req = f.requests.at(-1)!;
        expect(req.headers["mcp-method"]).toBe("tools/list");
        expect(req.headers["mcp-protocol-version"]).toBe("2026-07-28");
    });

    test("tools/call sends Mcp-Name and Mcp-Param-* headers (SSE response)", async () => {
        const r = await c.callTool("lookup", { region: "eu-west", q: "x" });
        expect(r.structuredContent).toEqual({ mcpName: "lookup", region: "eu-west", session: null });
        expect(JSON.parse(textOf(r))).toEqual({ mcpName: "lookup", region: "eu-west", session: null });
    });

    test("non-ASCII header values use the base64 sentinel", async () => {
        const r = await c.callTool("lookup", { region: "zürich" });
        const region = (r.structuredContent as { region: string }).region;
        expect(region).toBe(headerValue("zürich"));
        expect(region).toMatch(/^=\?base64\?.+\?=$/);
        expect(Buffer.from(region.slice(9, -2), "base64").toString("utf-8")).toBe("zürich");
    });

    test("close() sends no DELETE in the modern era", async () => {
        await c.close();
        expect(f.requests.filter((r) => r.httpMethod === "DELETE")).toHaveLength(0);
    });

    test("headerValue keeps safe values and encodes the rest", () => {
        expect(headerValue("simple-value_1.2")).toBe("simple-value_1.2");
        expect(headerValue("has inner space")).toBe("has inner space");
        expect(headerValue(" leading")).toMatch(/^=\?base64\?/);
        expect(headerValue("trailing ")).toMatch(/^=\?base64\?/);
        expect(headerValue("line\nbreak")).toMatch(/^=\?base64\?/);
        expect(headerValue("=?base64?abc?=")).toBe(`=?base64?${Buffer.from("=?base64?abc?=").toString("base64")}?=`);
    });
});

describe("streamable HTTP, authorization", () => {
    test("401 stops connect with an actionable error (no legacy retry)", async () => {
        const f = http("auth");
        const c = client("http-auth", { url: f.url });
        const err = await c.connect().catch((e) => e);
        expect(err).toBeInstanceOf(McpError);
        expect(err.code).toBe(401);
        expect(err.message).toContain("requires authorization (OAuth)");
        expect(f.requests).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------

describe("toolNameFor", () => {
    test("prefixes server and tool", () => {
        expect(toolNameFor("github", "create_issue")).toBe("mcp__github__create_issue");
    });

    test("sanitizes characters outside [A-Za-z0-9_-]", () => {
        expect(toolNameFor("my server", "tool.name/v2")).toBe("mcp__my_server__tool_name_v2");
        expect(toolNameFor("café", "naïve")).toBe("mcp__caf__na_ve");
    });

    test("caps the name at 64 characters", () => {
        const n = toolNameFor("s".repeat(40), "t".repeat(40));
        expect(n).toHaveLength(64);
        // The server part is capped at 30 so the "__" delimiter and the tool part survive.
        expect(n.startsWith(`mcp__${"s".repeat(30)}__t`)).toBe(true);
    });

    test("server part never contains '__', so server rules can't reach other servers", () => {
        expect(toolNameFor("github__x", "t")).toBe("mcp__github_x__t");
        expect(serverSegment("__a__b__")).toBe("a_b");
        expect(serverSegment("...")).toBe("server");
    });

    test("always yields a provider-valid tool name", () => {
        const inputs: [string, string][] = [
            ["a", "b"],
            ["x".repeat(100), "y"],
            ["日本", "ツール"],
            ["srv", "a b c ! @ # $ % ^ & * ( ) + = { } [ ] | \\ : ; \" ' < > , . ? /"],
        ];
        for (const [s, t] of inputs) expect(toolNameFor(s, t)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    });
});

describe("formatMcpResult", () => {
    test("maps every content type", () => {
        const f = formatMcpResult({
            content: [
                { type: "text", text: "first" },
                { type: "image", data: "AAAA", mimeType: "image/png" },
                { type: "image", data: "BBBB", mimeType: "image/svg+xml" },
                { type: "audio", data: "CCCC", mimeType: "audio/wav" },
                { type: "resource_link", uri: "file:///a.txt", name: "a.txt", title: "A file", description: "desc" },
                { type: "resource", resource: { uri: "file:///b.txt", text: "inline body" } },
                { type: "resource", resource: { uri: "file:///c.bin", blob: "ZZZZ", mimeType: "application/octet-stream" } },
            ],
        });
        expect(f.images).toEqual([{ type: "image", mediaType: "image/png", data: "AAAA" }]);
        expect(f.content.split("\n\n")).toEqual([
            "first",
            "[image of type image/svg+xml omitted]",
            "[audio (audio/wav) omitted]",
            "Resource: A file <file:///a.txt> - desc",
            "Resource file:///b.txt:\ninline body",
            "[binary resource file:///c.bin (application/octet-stream) omitted]",
        ]);
    });

    test("falls back to structuredContent only when there is no text", () => {
        expect(formatMcpResult({ content: [], structuredContent: { a: 1 } }).content).toBe('{\n  "a": 1\n}');
        expect(formatMcpResult({ content: [{ type: "text", text: "t" }], structuredContent: { a: 1 } }).content).toBe("t");
    });

    test("redacts secrets and truncates huge output", () => {
        const f = formatMcpResult({ content: [{ type: "text", text: `key=${FAKE.anthropic}` }] });
        expect(f.content).not.toContain(FAKE.anthropic);
        expect(f.content).toContain("[REDACTED anthropic-key]");

        const big = formatMcpResult({ content: [{ type: "text", text: "x".repeat(100_000) }] });
        expect(big.content.length).toBeLessThan(41_000);
        expect(big.content).toContain("characters");
    });
});

// ---------------------------------------------------------------------------

describe("McpManager.load and project .mcp.json approval", () => {
    const proj = tempDir("harness-mcp-proj-");
    afterAll(() => rmSync(proj, { recursive: true, force: true }));
    const cfg = (n: string): McpServerConfig => ({ command: "echo", args: [n] });
    writeFileSync(
        join(proj, ".mcp.json"),
        JSON.stringify({
            mcpServers: {
                approved: cfg("approved"),
                unapproved: cfg("unapproved"),
                rejected: cfg("rejected"),
                offInFile: { ...cfg("offInFile"), disabled: true },
                dup: cfg("from-project"),
            },
        }),
    );
    const base: Settings = {
        mcpServers: { fromSettings: cfg("s"), off: { ...cfg("off"), disabled: true }, dup: cfg("from-settings") },
        enabledMcpjsonServers: ["approved"],
        disabledMcpjsonServers: ["rejected"],
    };
    const status = (m: InstanceType<typeof McpManager>) => Object.fromEntries([...m.servers.values()].map((s) => [s.name, `${s.source}:${s.status}`]));

    test("trusted folder: project servers need approval unless listed", () => {
        const m = new McpManager(proj, () => base, true);
        m.load();
        expect(status(m)).toEqual({
            fromSettings: "settings:pending",
            off: "settings:disabled",
            dup: "settings:pending",
            approved: "project:pending",
            unapproved: "project:needs-approval",
            rejected: "project:disabled",
            offInFile: "project:disabled",
        });
        expect(m.servers.get("dup")!.config.args).toEqual(["from-settings"]);
        expect(m.needsApproval().map((s) => s.name)).toEqual(["unapproved"]);
    });

    test("approved set follows manager state, including failures but excluding collision refusals", () => {
        const m = new McpManager(proj, () => ({ ...base, mcpServers: { ...base.mcpServers, "same name": cfg("first"), same_name: cfg("collision") } }), true);
        m.load();
        m.servers.get("approved")!.status = "failed";
        expect(m.approvedServers()).toEqual({ cwd: proj, servers: {
            fromSettings: { config: cfg("s"), source: "settings" },
            dup: { config: cfg("from-settings"), source: "settings" },
            approved: { config: cfg("approved"), source: "project" },
            "same name": { config: cfg("first"), source: "settings" },
        } });
    });

    test("approved snapshots retain manager provenance and original definitions", () => {
        const implicit = cfg("implicit");
        const explicit = { ...cfg("explicit"), cwd: "/elsewhere" };
        const http = { url: "https://example.invalid/mcp" };
        const m = new McpManager(proj, () => ({ mcpServers: { implicit, explicit, http } }), true);
        m.load();
        const snapshot = m.approvedServers();
        expect(snapshot).toEqual({ cwd: proj, servers: {
            implicit: { config: implicit, source: "settings" },
            explicit: { config: explicit, source: "settings" },
            http: { config: http, source: "settings" },
        } });
        snapshot.servers.implicit!.config.command = "changed outside the manager";
        expect(m.approvedServers().servers.implicit!.config).toEqual(implicit);
        expect(implicit).not.toHaveProperty("cwd");
    });

    test("enableAllProjectMcpServers approves every project server (rejections still win)", () => {
        const m = new McpManager(proj, () => ({ ...base, enabledMcpjsonServers: [], enableAllProjectMcpServers: true }), true);
        m.load();
        expect(m.servers.get("approved")!.status).toBe("pending");
        expect(m.servers.get("unapproved")!.status).toBe("pending");
        expect(m.servers.get("rejected")!.status).toBe("disabled");
        expect(m.needsApproval()).toEqual([]);
    });

    test("untrusted folder: .mcp.json is ignored entirely, even with enableAll", () => {
        const m = new McpManager(proj, () => ({ ...base, enableAllProjectMcpServers: true }), false);
        m.load();
        expect([...m.servers.keys()].sort()).toEqual(["dup", "fromSettings", "off"]);
        expect([...m.servers.values()].every((s) => s.source === "settings")).toBe(true);
    });

    test("no .mcp.json: only settings servers", () => {
        const empty = tempDir("harness-mcp-empty-");
        try {
            const m = new McpManager(empty, () => base, true);
            m.load();
            expect([...m.servers.keys()].sort()).toEqual(["dup", "fromSettings", "off"]);
        } finally {
            rmSync(empty, { recursive: true, force: true });
        }
    });
});

describe("McpManager start, tools and shutdown", () => {
    const proj = tempDir("harness-mcp-run-");
    afterAll(() => rmSync(proj, { recursive: true, force: true }));
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { mod: stdio("modern") } }));
    let settings: Settings = { mcpServers: { leg: stdio("legacy") }, enabledMcpjsonServers: ["mod"] };
    const m = new McpManager(proj, () => settings, true);
    const ctx = { signal: new AbortController().signal } as never;
    afterAll(() => m.closeAll());

    test("startAll connects every pending server", async () => {
        m.load();
        let changes = 0;
        m.onChange = () => changes++;
        await m.startAll();
        const leg = m.servers.get("leg")!;
        const mod = m.servers.get("mod")!;
        expect(leg.status).toBe("connected");
        expect(mod.status).toBe("connected");
        expect(leg.era).toBe("legacy 2025-06-18");
        expect(mod.era).toBe("2026-07-28");
        expect(leg.tools).toHaveLength(ALL_TOOLS.length);
        expect(changes).toBeGreaterThanOrEqual(2);
    });

    test("tools() exposes wrappers named mcp__<server>__<tool>", () => {
        const tools = m.tools();
        const names = tools.map((t) => t.name);
        expect(names).toContain("mcp__leg__echo");
        expect(names).toContain("mcp__mod__echo");
        expect(names).toHaveLength(ALL_TOOLS.length * 2);
        const echo = tools.find((t) => t.name === "mcp__leg__echo")!;
        expect(echo.category).toBe("mcp");
        expect(echo.readOnly).toBe(true);
        expect(echo.parameters).toMatchObject({ type: "object", properties: { text: { type: "string" } } });
        expect(echo.description).toContain('(MCP tool "echo" from server "leg")');
        expect(echo.title({ text: "hello" })).toBe("leg - echo(hello)");
        const image = tools.find((t) => t.name === "mcp__mod__image")!;
        expect(image.readOnly).toBe(false);
        expect(image.title({})).toBe("mod - Make image");
    });

    test("wrappers run the tool and map results", async () => {
        const tools = m.tools();
        const run = (n: string, input: Record<string, unknown> = {}) => tools.find((t) => t.name === n)!.run(input, ctx);
        const echo = await run("mcp__mod__echo", { text: "via manager" });
        expect(echo.content).toBe("echo: via manager");
        expect(echo.isError).toBe(false);
        expect(echo.images).toBeUndefined();

        const fail = await run("mcp__leg__fail");
        expect(fail.isError).toBe(true);
        expect(fail.display?.summary).toBe("Error");

        const img = await run("mcp__leg__image");
        expect(img.images).toEqual([{ type: "image", mediaType: "image/png", data: expect.any(String) }]);
        expect(img.display?.summary).toBe("1 lines, 1 image(s)");

        const bad = await run("mcp__mod__needs_input");
        expect(bad.isError).toBe(true);
        expect(bad.content).toMatch(/^MCP error from mod: /);
    });

    test("instructions() combines connected servers' instructions", () => {
        const ins = m.instructions();
        expect(ins).toContain("# MCP server instructions");
        expect(ins).toContain("## leg\nLegacy fixture instructions");
        expect(ins).toContain("## mod\nModern fixture instructions");
    });

    test("load() keeps unchanged running clients and closes changed ones", async () => {
        const legClient = m.servers.get("leg")!.client!;
        const modClient = m.servers.get("mod")!.client!;
        const modPid = await pidOf(modClient);
        settings = { ...settings, mcpServers: { leg: stdio("legacy") } }; // same config
        m.load();
        expect(m.servers.get("leg")!.client).toBe(legClient);
        expect(m.servers.get("leg")!.status).toBe("connected");
        expect(m.servers.get("mod")!.client).toBe(modClient);

        // Changing a server's config replaces it.
        writeFileSync(join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { mod: stdio("modern", { CHANGED: "1" }) } }));
        m.load();
        expect(m.servers.get("mod")!.status).toBe("pending");
        expect(m.servers.get("mod")!.client).toBeUndefined();
        expect(await waitFor(() => !alive(modPid))).toBe(true);
    });

    test("closeAll() terminates every child", async () => {
        const legPid = await pidOf(m.servers.get("leg")!.client!);
        await m.closeAll();
        expect(await waitFor(() => !alive(legPid))).toBe(true);
    });

    test("a crashing server is marked failed with its stderr", async () => {
        const m2 = new McpManager(proj, () => ({ mcpServers: { boom: stdio("legacy") } }), false);
        m2.load();
        await m2.startAll();
        const st = m2.servers.get("boom")!;
        expect(st.status).toBe("connected");
        const crash = m2.tools().find((t) => t.name === "mcp__boom__crash")!;
        const r = await crash.run({}, ctx);
        expect(r.isError).toBe(true);
        expect(r.content).toContain("server exited (3)");
        expect(await waitFor(() => st.status === "failed")).toBe(true);
        expect(st.error).toContain("fatal: fixture crashed on purpose");
        expect(m2.tools()).toEqual([]);
    });

    test("a server that fails to connect is marked failed and its client dropped", async () => {
        const f = http("auth");
        const m3 = new McpManager(proj, () => ({ mcpServers: { locked: { url: f.url } } }), false);
        m3.load();
        await m3.startAll();
        const st = m3.servers.get("locked")!;
        expect(st.status).toBe("failed");
        expect(st.error).toContain("requires authorization");
        expect(st.client).toBeUndefined();
    });
});
