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

function askClient(method: string, timeoutMs: number): Promise<Json | "no-response"> {
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
        send({ jsonrpc: "2.0", id, method });
    });
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
                    capabilities: { tools: { listChanged: true } },
                    instructions: "Modern fixture instructions",
                    _meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture-modern", version: "0.2.0" } },
                    ttlMs: 60_000,
                    cacheScope: "private",
                });
            case "tools/list":
                return listTools(id, params);
            case "tools/call":
                return void callTool(id, params);
            default:
                return error(id, -32601, `Method not found: ${method}`);
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
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "fixture-legacy", version: "0.1.0" },
            instructions: "Legacy fixture instructions",
        });
    }
    if (method === "ping") return result(id, {});
    if (!initialized) return error(id, -32600, "Server not initialized: notifications/initialized was not received");
    switch (method) {
        case "tools/list":
            return listTools(id, params);
        case "tools/call":
            return void callTool(id, params);
        default:
            return error(id, -32601, `Method not found: ${method}`);
    }
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
