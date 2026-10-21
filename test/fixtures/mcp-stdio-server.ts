// Stdio MCP server fixture: newline-delimited JSON-RPC on stdin/stdout.
//
// Run with: bun --no-env-file test/fixtures/mcp-stdio-server.ts
//
// MCP_FIXTURE_ERA selects the protocol era:
//   legacy   - 2025-06-18: server/discover -> -32601, initialize handshake,
//              notifications/initialized required before anything else.
//   lenient  - legacy, but answers server/discover with an empty result {}.
//   modern   - 2026-07-28: server/discover, no initialize, every request must
//              carry params._meta["io.modelcontextprotocol/protocolVersion"],
//              every result has resultType "complete".
//   unsupported - server/discover -> -32022 with data.supported taken from
//              MCP_FIXTURE_SUPPORTED (comma separated); otherwise legacy.
// MCP_FIXTURE_IGNORE_EOF=1     keep running after stdin closes.
// MCP_FIXTURE_IGNORE_SIGTERM=1 ignore SIGTERM (only SIGKILL stops it).
// MCP_FIXTURE_MARKER=<file>    append the process id to that file as soon as
//                              it starts (tests that check a server never ran).
// MCP_FIXTURE_FAIL_IF=<file>   exit with status 1 at once while that file exists.
// MCP_FIXTURE_STDERR_ENV=<var> print that variable's value to stderr first.

import { appendFileSync, existsSync, writeSync } from "fs";

if (process.env.MCP_FIXTURE_MARKER) appendFileSync(process.env.MCP_FIXTURE_MARKER, `${process.pid}\n`);
if (process.env.MCP_FIXTURE_STDERR_ENV) writeSync(2, `${process.env[process.env.MCP_FIXTURE_STDERR_ENV] ?? ""}\n`);
if (process.env.MCP_FIXTURE_FAIL_IF && existsSync(process.env.MCP_FIXTURE_FAIL_IF)) {
    writeSync(2, "fixture told to fail\n");
    process.exit(1);
}

type Json = Record<string, any>;

const ERA = process.env.MCP_FIXTURE_ERA ?? "legacy";
const MODERN = "2026-07-28";
const LEGACY = ERA === "unsupported" ? "2025-11-25" : "2025-06-18";
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const modern = ERA === "modern";

// MCP_FIXTURE_TOOLS_ONLY=1: offers only tools. MCP_FIXTURE_NO_TOOLS=1: only resources and prompts (tools/list then fails).
const CAPS: Json = process.env.MCP_FIXTURE_TOOLS_ONLY ? { tools: { listChanged: true } } : { ...(process.env.MCP_FIXTURE_NO_TOOLS ? {} : { tools: { listChanged: true } }), resources: { listChanged: true }, prompts: { listChanged: true } };
let initialized = false;
let serverReqId = 0;
const waiting = new Map<string, (msg: Json) => void>();
const log: Json[] = [];
const cancelled: unknown[] = [];

const TOOLS: Json[] = [
    { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
    { name: "image", title: "Make image", description: "Returns an image", inputSchema: { type: "object", properties: {} } },
    { name: "fail", description: "Always fails", inputSchema: { type: "object", properties: {} } },
    { name: "pid", description: "Server process id", inputSchema: { type: "object", properties: {} } },
    { name: "ping_client", description: "Sends a ping request to the client", inputSchema: { type: "object", properties: {} } },
    { name: "server_request", description: "Sends an arbitrary request to the client", inputSchema: { type: "object", properties: { method: { type: "string" } } } },
    { name: "get_log", description: "Messages received so far", inputSchema: { type: "object", properties: {} } },
    { name: "crash", description: "Exits with status 3", inputSchema: { type: "object", properties: {} } },
    { name: "slow", description: "Answers after ms milliseconds", inputSchema: { type: "object", properties: { ms: { type: "number" } } } },
    { name: "needs_input", description: "Returns an input_required result", inputSchema: { type: "object", properties: {} } },
    { name: "list_changed", description: "Sends notifications/tools/list_changed", inputSchema: { type: "object", properties: {} } },
    { name: "ask_name", description: "Asks the user for a name (elicitation)", inputSchema: { type: "object", properties: { url: { type: "boolean" } } } },
    { name: "sample", description: "Asks the client's model (sampling)", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    { name: "roots", description: "Asks the client for its roots", inputSchema: { type: "object", properties: {} } },
    { name: "notify_lists", description: "Sends resources and prompts list_changed", inputSchema: { type: "object", properties: {} } },
];

const RESOURCES: Json[] = [
    { uri: "fixture://readme", name: "readme", title: "Read me", description: "A short text", mimeType: "text/markdown" },
    { uri: "fixture://big", name: "big", description: "100 KB of text", mimeType: "text/plain" },
    { uri: "fixture://pixel", name: "pixel", description: "A PNG", mimeType: "image/png" },
    { uri: "fixture://slow", name: "slow", description: "Takes 2s", mimeType: "text/plain" },
    { uri: "fixture://secret", name: "secret", description: "Asks first (modern: MRTR)", mimeType: "text/plain" },
];
const TEMPLATES: Json[] = [{ uriTemplate: "fixture://items/{id}", name: "item", description: "An item by id" }];
const PROMPTS: Json[] = [
    { name: "greet", title: "Greet someone", description: "Says hello", arguments: [{ name: "name", description: "Who", required: true }, { name: "tone", description: "How" }] },
    { name: "rich", description: "Text, an embedded resource and an image", arguments: [] },
    { name: "welcome", description: "Asks who to welcome first", arguments: [] },
];
const PAGE = 4;

// 1x1 transparent PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function send(msg: Json) {
    process.stdout.write(JSON.stringify(msg) + "\n");
}

function result(id: unknown, r: Json) {
    send({ jsonrpc: "2.0", id, result: modern ? { resultType: "complete", ...r } : r });
}

function error(id: unknown, code: number, message: string, data?: unknown) {
    send({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

function askClient(method: string, timeoutMs: number, params?: Json): Promise<Json | "no-response"> {
    const id = `srv-${++serverReqId}`;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            waiting.delete(id);
            resolve("no-response");
        }, timeoutMs);
        waiting.set(id, (msg) => {
            clearTimeout(timer);
            resolve(msg);
        });
        send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });
}

const NAME_FORM = { mode: "form", message: "What's your name?", requestedSchema: { type: "object", properties: { name: { type: "string", title: "Name" } }, required: ["name"] } };
const URL_FORM = { mode: "url", message: "Sign in to continue", url: "https://example.com/connect" };
const SAMPLE = (q: string) => ({ messages: [{ role: "user", content: { type: "text", text: q } }], systemPrompt: "Answer briefly.", maxTokens: 50 });

/**
 * What a server asks of the client, both ways: a modern server answers with
 * input_required (and checks the retry), a legacy one sends a request.
 */
async function ask(id: unknown, params: Json, key: string, method: string, askParams: Json | undefined, done: (answer: Json) => Json) {
    if (modern) {
        const got = params.inputResponses?.[key];
        if (got === undefined) return send({ jsonrpc: "2.0", id, result: { resultType: "input_required", inputRequests: { [key]: { method, ...(askParams ? { params: askParams } : {}) } }, requestState: `state-${key}` } });
        if (params.requestState !== `state-${key}`) return error(id, -32602, "requestState was not echoed");
        return result(id, done(got));
    }
    const r = await askClient(method, Number(process.env.MCP_FIXTURE_ASK_TIMEOUT_MS) || 5000, askParams);
    if (r === "no-response") return result(id, { content: [{ type: "text", text: "no-response" }], isError: true });
    if (r.error) return result(id, { content: [{ type: "text", text: `client error ${r.error.code}: ${r.error.message}` }], isError: true });
    return result(id, done(r.result));
}

async function callTool(id: unknown, params: Json) {
    const args = params.arguments ?? {};
    const text = (t: string) => ({ content: [{ type: "text", text: t }] });
    switch (params.name) {
        case "echo":
            return result(id, text(`echo: ${args.text}`));
        case "image":
            return result(id, { content: [{ type: "text", text: "here is an image" }, { type: "image", data: PNG, mimeType: "image/png" }] });
        case "fail":
            return result(id, { content: [{ type: "text", text: "boom" }], isError: true });
        case "pid":
            return result(id, text(String(process.pid)));
        case "ping_client": {
            const r = await askClient("ping", modern ? 300 : 2000);
            return result(id, text(JSON.stringify(r)));
        }
        case "server_request": {
            const r = await askClient(String(args.method), 2000);
            return result(id, text(JSON.stringify(r)));
        }
        case "get_log":
            return result(id, text(JSON.stringify({ log, cancelled })));
        case "crash":
            writeSync(2, "fatal: fixture crashed on purpose\n");
            process.exit(3);
        case "slow":
            await new Promise((r) => setTimeout(r, Number(args.ms ?? 1000)));
            return result(id, text("slow done"));
        case "needs_input":
            return send({ jsonrpc: "2.0", id, result: { resultType: "input_required", inputRequests: {} } });
        case "list_changed":
            send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
            return result(id, text("sent"));
        case "ask_name":
            return ask(id, params, "name", "elicitation/create", args.url ? URL_FORM : NAME_FORM, (a) => text(JSON.stringify(a)));
        case "sample":
            return ask(id, params, "llm", "sampling/createMessage", SAMPLE(String(args.q ?? "2+2?")), (a) => text(JSON.stringify(a)));
        case "roots":
            return ask(id, params, "roots", "roots/list", undefined, (a) => text(JSON.stringify(a)));
        case "notify_lists":
            send({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
            send({ jsonrpc: "2.0", method: "notifications/prompts/list_changed" });
            return result(id, text("sent"));
        default:
            return error(id, -32602, `Unknown tool: ${params.name}`);
    }
}

function handleRequest(id: unknown, method: string, params: Json) {
    if (modern) {
        const v = params?._meta?.[META_VERSION];
        if (v !== MODERN) return error(id, -32022, "Unsupported protocol version", { supported: [MODERN], requested: v ?? null });
        switch (method) {
            case "server/discover":
                return result(id, {
                    supportedVersions: [MODERN],
                    capabilities: CAPS,
                    instructions: "Modern fixture instructions",
                    _meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture-modern", version: "0.2.0" } },
                    ttlMs: 60_000,
                    cacheScope: "private",
                });
            case "tools/list":
                if (process.env.MCP_FIXTURE_NO_TOOLS) return error(id, -32601, "Method not found: tools/list");
                return listTools(id, params);
            case "tools/call":
                return void callTool(id, params);
            default:
                return other(id, method, params);
        }
    }

    if (method === "server/discover") {
        if (ERA === "lenient") return result(id, {});
        if (ERA === "unsupported") {
            const supported = (process.env.MCP_FIXTURE_SUPPORTED ?? "").split(",").filter(Boolean);
            return error(id, -32022, "Unsupported protocol version", { supported, requested: params?._meta?.[META_VERSION] });
        }
        return error(id, -32601, "Method not found");
    }
    if (method === "initialize") {
        return result(id, {
            protocolVersion: LEGACY,
            capabilities: CAPS,
            serverInfo: { name: "fixture-legacy", version: "0.1.0" },
            instructions: "Legacy fixture instructions",
        });
    }
    if (method === "ping") return result(id, {});
    if (!initialized) return error(id, -32600, "Server not initialized: notifications/initialized was not received");
    switch (method) {
        case "tools/list":
            if (process.env.MCP_FIXTURE_NO_TOOLS) return error(id, -32601, "Method not found: tools/list");
            return listTools(id, params);
        case "tools/call":
            return void callTool(id, params);
        default:
            return other(id, method, params);
    }
}

/** Resources and prompts, the same in both eras. */
function other(id: unknown, method: string, params: Json) {
    switch (method) {
        case "resources/list":
            return page(id, params, RESOURCES, "resources");
        case "resources/templates/list":
            return result(id, { resourceTemplates: TEMPLATES });
        case "resources/read":
            return void readResource(id, params);
        case "prompts/list":
            return result(id, { prompts: PROMPTS });
        case "prompts/get":
            return getPrompt(id, params);
        default:
            return error(id, -32601, `Method not found: ${method}`);
    }
}

async function readResource(id: unknown, params: Json) {
    const uri = String(params.uri ?? "");
    const one = (c: Json) => result(id, { contents: [{ uri, ...c }] });
    if (uri === "fixture://readme") return one({ mimeType: "text/markdown", text: "# Fixture\nHello from a resource." });
    if (uri === "fixture://big") return one({ mimeType: "text/plain", text: "x".repeat(100_000) });
    if (uri === "fixture://pixel") return one({ mimeType: "image/png", blob: PNG });
    if (uri === "fixture://slow") {
        await new Promise((r) => setTimeout(r, 2000));
        return one({ mimeType: "text/plain", text: "slow resource" });
    }
    if (uri === "fixture://secret") return ask(id, params, "ok", "elicitation/create", { mode: "form", message: "Show the secret?", requestedSchema: { type: "object", properties: {} } }, (a) => ({ contents: [{ uri, mimeType: "text/plain", text: a.action === "accept" ? "the secret" : "declined" }] }));
    const item = uri.match(/^fixture:\/\/items\/(.+)$/);
    if (item) return one({ mimeType: "text/plain", text: `item ${item[1]}` });
    return error(id, -32602, `Resource not found: ${uri}`);
}

function getPrompt(id: unknown, params: Json) {
    const args = params.arguments ?? {};
    if (params.name === "greet") {
        if (!args.name) return error(id, -32602, "Missing required argument: name");
        return result(id, { description: "A greeting", messages: [{ role: "user", content: { type: "text", text: `Say hello to ${args.name}${args.tone ? `, ${args.tone}` : ""}.${Buffer.from(process.env.MCP_FIXTURE_GREET_SUFFIX_B64 ?? "", "base64").toString()}` } }] });
    }
    if (params.name === "rich") {
        return result(id, {
            messages: [
                { role: "user", content: { type: "text", text: "Look at these." } },
                { role: "user", content: { type: "resource", resource: { uri: "fixture://readme", mimeType: "text/markdown", text: "# Fixture" } } },
                { role: "user", content: { type: "image", data: PNG, mimeType: "image/png" } },
            ],
        });
    }
    if (params.name === "welcome") {
        return ask(id, params, "name", "elicitation/create", NAME_FORM, (a) => ({ messages: [{ role: "user", content: { type: "text", text: `Welcome ${a.content?.name ?? "nobody"}.` } }] }));
    }
    return error(id, -32602, `Unknown prompt: ${params.name}`);
}

function page(id: unknown, params: Json, all: Json[], key: string) {
    const start = params?.cursor !== undefined ? Number(params.cursor) : 0;
    const next = start + PAGE < all.length ? String(start + PAGE) : undefined;
    return result(id, { [key]: all.slice(start, start + PAGE), ...(next ? { nextCursor: next } : {}) });
}

function listTools(id: unknown, params: Json) {
    const start = params?.cursor !== undefined ? Number(params.cursor) : 0;
    const page = TOOLS.slice(start, start + PAGE);
    const next = start + PAGE < TOOLS.length ? String(start + PAGE) : undefined;
    return result(id, { tools: page, ...(next ? { nextCursor: next } : {}) });
}

function handle(msg: Json) {
    // A response to one of our own requests.
    if (msg.id !== undefined && msg.method === undefined) {
        const w = waiting.get(String(msg.id));
        if (w) {
            waiting.delete(String(msg.id));
            w(msg);
        }
        return;
    }
    log.push({ method: msg.method, id: msg.id ?? null, params: msg.params ?? null });
    if (msg.id === undefined) {
        if (msg.method === "notifications/initialized") initialized = true;
        if (msg.method === "notifications/cancelled") cancelled.push(msg.params?.requestId);
        return;
    }
    handleRequest(msg.id, msg.method, msg.params ?? {});
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: Json;
        try {
            msg = JSON.parse(line);
        } catch {
            send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
            continue;
        }
        handle(msg);
    }
});

if (process.env.MCP_FIXTURE_IGNORE_SIGTERM) process.on("SIGTERM", () => {});
if (process.env.MCP_FIXTURE_IGNORE_EOF) setInterval(() => {}, 1000);
else process.stdin.on("end", () => process.exit(0));
