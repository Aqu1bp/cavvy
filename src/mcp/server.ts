// A small MCP server (Streamable HTTP, on 127.0.0.1) for the harness's own
// tools, offered to Claude Code and Codex when they run a turn: delegating
// work to other providers' models. Each registration gets its own random
// bearer token, kept in memory (hashed) and redacted from anything shown or
// saved; a request without a live token never reaches a tool. Browsers are
// refused (they send Origin), so a web page can't drive it either.

import { createHash, randomBytes, randomUUID } from "crypto";
import type { Server } from "bun";
import { APP_NAME, APP_TITLE, APP_VERSION } from "../config/paths";
import type { ImagePart } from "../providers/types";
import { redact, registerSecret } from "../util/redact";

export interface ServerToolResult {
    text: string;
    isError?: boolean;
    /** Sent after the text as image content. The tool fits them to what providers take (fitToolImages) first. */
    images?: ImagePart[];
}

export interface ServerTool {
    name: string;
    title?: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
    /** Listed as the tool's _meta (`{ ui: { visibility: ["app"] } }` keeps it from the model). */
    meta?: Record<string, unknown>;
    /** The signal ends when the client goes away or cancels the call. `meta` is the request's _meta. */
    call(args: Record<string, unknown>, ctx: { signal: AbortSignal; meta: Record<string, unknown> }): Promise<ServerToolResult>;
}

export interface Registration {
    url: string;
    /** The Authorization header value. */
    authorization: string;
    /** Revoke the token; calls in flight are cancelled. */
    close(): void;
}

/** Protocol versions answered, newest first. */
export const SERVER_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** SSE comments while a long call runs, so nothing between here and the client gives up on a quiet connection. */
export const serverTiming = { keepAliveMs: 15_000 };

interface Entry {
    tools: () => ServerTool[];
    instructions?: () => string | undefined;
    calls: Map<string, AbortController>;
}

let server: Server<undefined> | undefined;
const entries = new Map<string, Entry>();

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

function ensureServer(): Server<undefined> {
    server ??= Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (req, srv) => handle(req, srv),
    });
    // Nothing else keeps the process alive: quitting doesn't wait for it.
    server.unref();
    return server;
}

/** Offer these tools under a new token; `instructions` are read when a client connects. A function is read on each request (the set can change). */
export function registerTools(tools: ServerTool[] | (() => ServerTool[]), instructions?: () => string | undefined): Registration {
    const srv = ensureServer();
    const token = randomBytes(32).toString("base64url");
    registerSecret(token, `${APP_NAME} MCP token`);
    const key = hash(token);
    const entry: Entry = { tools: typeof tools === "function" ? tools : () => tools, instructions, calls: new Map() };
    entries.set(key, entry);
    return {
        url: `http://127.0.0.1:${srv.port}/mcp`,
        authorization: `Bearer ${token}`,
        close() {
            if (!entries.delete(key)) return;
            for (const c of entry.calls.values()) c.abort();
            entry.calls.clear();
        },
    };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const rpcError = (id: unknown, code: number, message: string, status = 200) => json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);

async function handle(req: Request, srv: Server<undefined>): Promise<Response> {
    if (new URL(req.url).pathname !== "/mcp") return new Response("Not found", { status: 404 });
    if (req.headers.get("origin")) return new Response("Forbidden", { status: 403 });
    const token = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)$/i)?.[1];
    const key = token ? hash(token) : undefined;
    const entry = key ? entries.get(key) : undefined;
    if (!key || !entry) return new Response("Unauthorized", { status: 401 });
    // Stateless: there's no session to end, and no stream of server messages to open.
    if (req.method === "DELETE") return new Response(null, { status: 200 });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST, DELETE" } });

    let body: any;
    try {
        body = await req.json();
    } catch {
        return rpcError(null, -32700, "Parse error", 400);
    }
    // Revoked while the body came in.
    if (entries.get(key) !== entry) return new Response("Unauthorized", { status: 401 });
    if (Array.isArray(body)) return rpcError(null, -32600, "Batched requests aren't supported", 400);
    if (!body || typeof body !== "object" || body.jsonrpc !== "2.0") return rpcError(body?.id, -32600, "Invalid request", 400);
    // Notifications, and answers to requests (this server sends none).
    if (body.id === undefined || body.id === null || typeof body.method !== "string") {
        if (body.method === "notifications/cancelled") entry.calls.get(String(body.params?.requestId))?.abort();
        return new Response(null, { status: 202 });
    }
    const id = body.id;
    const params = body.params && typeof body.params === "object" ? body.params : {};
    switch (body.method) {
        case "initialize": {
            const asked = String(params.protocolVersion ?? "");
            const instructions = entry.instructions?.();
            return json(
                {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        protocolVersion: SERVER_VERSIONS.includes(asked) ? asked : SERVER_VERSIONS[1],
                        capabilities: { tools: { listChanged: false } },
                        serverInfo: { name: APP_NAME, title: APP_TITLE, version: APP_VERSION },
                        ...(instructions ? { instructions } : {}),
                    },
                },
                200,
                // Clients send it back; nothing is kept for it.
                { "Mcp-Session-Id": randomUUID() },
            );
        }
        case "ping":
            return json({ jsonrpc: "2.0", id, result: {} });
        case "tools/list":
            return json({
                jsonrpc: "2.0",
                id,
                result: { tools: entry.tools().map((t) => ({ name: t.name, ...(t.title ? { title: t.title } : {}), description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}), ...(t.meta ? { _meta: t.meta } : {}) })) },
            });
        case "tools/call":
            return callTool(req, srv, entry, id, params);
        default:
            return rpcError(id, -32601, `Method not found: ${String(body.method)}`);
    }
}

function callTool(req: Request, srv: Server<undefined>, entry: Entry, id: unknown, params: Record<string, any>): Response {
    const name = String(params.name ?? "");
    const tool = entry.tools().find((t) => t.name === name);
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
    const meta = params._meta && typeof params._meta === "object" ? params._meta : {};
    const ac = new AbortController();
    const key = String(id);
    entry.calls.set(key, ac);
    req.signal.addEventListener("abort", () => ac.abort(), { once: true });
    const result = tool
        .call(args, { signal: ac.signal, meta })
        .then(
            (r) => ({ content: [{ type: "text", text: r.text }, ...(r.images ?? []).map((i) => ({ type: "image", data: i.data, mimeType: i.mediaType }))], isError: Boolean(r.isError) }),
            (e) => ({ content: [{ type: "text", text: `${name} failed: ${redact((e as Error).message ?? String(e))}` }], isError: true }),
        )
        .finally(() => {
            if (entry.calls.get(key) === ac) entry.calls.delete(key);
        });
    // A call can take as long as the work it waits for; keep-alives (or the client) end it.
    srv.timeout(req, 0);
    if (!(req.headers.get("accept") ?? "").includes("text/event-stream")) return jsonWhenDone(result, id);
    const enc = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
        start(c) {
            timer = setInterval(() => {
                try {
                    c.enqueue(enc.encode(": keep-alive\n\n"));
                } catch {
                    clearInterval(timer);
                }
            }, serverTiming.keepAliveMs);
            void result.then((r) => {
                clearInterval(timer);
                try {
                    c.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: r })}\n\n`));
                    c.close();
                } catch {
                    // the client went away
                }
            });
        },
        cancel() {
            clearInterval(timer);
            ac.abort();
        },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

/** A client that takes only JSON gets the response once the call ends. */
function jsonWhenDone(result: Promise<unknown>, id: unknown): Response {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(c) {
            const r = await result;
            try {
                c.enqueue(enc.encode(JSON.stringify({ jsonrpc: "2.0", id, result: r })));
                c.close();
            } catch {
                // the client went away
            }
        },
    });
    return new Response(stream, { headers: { "Content-Type": "application/json" } });
}

/** For tests: stop the server (registrations stay revoked). */
export function stopServer() {
    for (const e of entries.values()) for (const c of e.calls.values()) c.abort();
    entries.clear();
    server?.stop(true);
    server = undefined;
}
