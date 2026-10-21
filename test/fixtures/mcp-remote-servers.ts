// Remote MCP server fixtures beyond Streamable HTTP (mcp-http-server.ts):
//
//   startSseMcpServer   - the HTTP+SSE transport of 2024-11-05: GET /sse opens
//                         an event stream whose first event names the POST
//                         endpoint; responses (and the server's own requests)
//                         come back on the stream.
//   startWsMcpServer    - JSON-RPC over a WebSocket, subprotocol "mcp".
//   startOAuthMcpServer - a Streamable HTTP server behind OAuth, with its own
//                         authorization server: protected resource metadata,
//                         RFC 8414 metadata, dynamic registration, an
//                         /authorize that redirects straight back (the
//                         "browser"), and a token endpoint that checks PKCE,
//                         the resource and refresh tokens.
//
// All speak the legacy protocol (initialize, then requests) with the same
// small set of tools and resources.

import { createHash } from "crypto";

type Json = Record<string, any>;

const TOOLS = [
    { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    { name: "ask_name", description: "Asks the client for a name", inputSchema: { type: "object", properties: {} } },
];
const RESOURCES = [{ uri: "remote://note", name: "note", mimeType: "text/plain" }];

/**
 * One JSON-RPC message in, maybe one answer out. `ask` sends a request to
 * the client and resolves with its response (for elicitation).
 */
async function answer(msg: Json, ask: (method: string, params: Json) => Promise<Json>): Promise<Json | undefined> {
    if (msg.id === undefined || msg.id === null || typeof msg.method !== "string") return undefined;
    const ok = (result: Json) => ({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
        case "server/discover":
            return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
        case "initialize":
            return ok({ protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "remote-fixture", version: "1" } });
        case "tools/list":
            return ok({ tools: TOOLS });
        case "resources/list":
            return ok({ resources: RESOURCES });
        case "resources/read":
            return ok({ contents: [{ uri: msg.params?.uri, mimeType: "text/plain", text: "a remote note" }] });
        case "tools/call": {
            const args = msg.params?.arguments ?? {};
            if (msg.params?.name === "echo") return ok({ content: [{ type: "text", text: `echo: ${args.text}` }] });
            if (msg.params?.name === "ask_name") {
                const r = await ask("elicitation/create", { mode: "form", message: "Name?", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } });
                return ok({ content: [{ type: "text", text: JSON.stringify(r.result ?? r.error) }] });
            }
            return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "Unknown tool" } };
        }
        default:
            return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
}

/** Requests to the client and the responses that come back, matched by id. */
function asker(send: (msg: Json) => void) {
    let seq = 0;
    const waiting = new Map<string, (m: Json) => void>();
    return {
        ask: (method: string, params: Json) =>
            new Promise<Json>((resolve) => {
                const id = `srv-${++seq}`;
                waiting.set(id, resolve);
                send({ jsonrpc: "2.0", id, method, params });
            }),
        /** True when `msg` was a response to one of our requests. */
        take(msg: Json): boolean {
            if (msg.method !== undefined || msg.id === undefined) return false;
            const w = waiting.get(String(msg.id));
            if (w) {
                waiting.delete(String(msg.id));
                w(msg);
            }
            return true;
        },
    };
}

export interface SseFixture {
    url: string;
    /** Headers of the GET that opened the stream, and of each POST. */
    getHeaders: Record<string, string>[];
    postHeaders: Record<string, string>[];
    /** End every open stream (the client sees the connection drop). */
    dropStreams(): void;
    stop(): void;
}

/**
 * `endpoint`: what the endpoint event names (default "/messages?session=<id>");
 * `status`: answer the GET with this instead (401 sends a Bearer challenge).
 */
export function startSseMcpServer(o: { endpoint?: (base: string, session: string) => string; status?: number; silent?: boolean; /** POSTs need "Bearer <value>" (else 401); change value to revoke. */ postToken?: { value: string } } = {}): SseFixture {
    const enc = new TextEncoder();
    const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    const getHeaders: Record<string, string>[] = [];
    const postHeaders: Record<string, string>[] = [];
    let n = 0;
    const askers = new Map<string, ReturnType<typeof asker>>();
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        idleTimeout: 0,
        async fetch(req) {
            const u = new URL(req.url);
            if (req.method === "GET" && u.pathname === "/sse") {
                getHeaders.push(Object.fromEntries(req.headers));
                if (o.status === 401) return new Response("no", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="x"' } });
                if (o.status) return new Response("no", { status: o.status });
                const session = String(++n);
                const stream = new ReadableStream<Uint8Array>({
                    start(c) {
                        streams.set(session, c);
                        const send = (msg: Json) => c.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(msg)}\n\n`));
                        askers.set(session, asker(send));
                        if (o.silent) return;
                        const ep = o.endpoint ? o.endpoint(`http://127.0.0.1:${server.port}`, session) : `/messages?session=${session}`;
                        c.enqueue(enc.encode(`event: endpoint\ndata: ${ep}\n\n`));
                    },
                    cancel() {
                        streams.delete(session);
                    },
                });
                return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
            }
            if (req.method === "POST" && u.pathname === "/messages") {
                postHeaders.push(Object.fromEntries(req.headers));
                if (o.postToken && req.headers.get("authorization") !== `Bearer ${o.postToken.value}`) return new Response("no", { status: 401, headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' } });
                const session = u.searchParams.get("session") ?? "";
                const c = streams.get(session);
                const a = askers.get(session);
                if (!c || !a) return new Response("unknown session", { status: 404 });
                const msg = (await req.json()) as Json;
                if (a.take(msg)) return new Response("Accepted", { status: 202 });
                void answer(msg, a.ask).then((r) => {
                    if (r) c.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(r)}\n\n`));
                });
                return new Response("Accepted", { status: 202 });
            }
            return new Response("not found", { status: 404 });
        },
    });
    return {
        url: `http://127.0.0.1:${server.port}/sse`,
        getHeaders,
        postHeaders,
        dropStreams() {
            for (const c of streams.values()) c.close();
            streams.clear();
        },
        stop: () => server.stop(true),
    };
}

export interface WsFixture {
    url: string;
    /** Upgrade request headers and the subprotocol asked for. */
    upgrades: { headers: Record<string, string>; protocol: string | null }[];
    /** Close every socket with this code. */
    closeAll(code?: number): void;
    stop(): void;
}

/** `token`: the upgrade (and a plain GET) needs "Bearer <value>", else 401 with a challenge. */
export function startWsMcpServer(o: { token?: { value: string } } = {}): WsFixture {
    const upgrades: WsFixture["upgrades"] = [];
    const sockets = new Set<any>();
    const server = Bun.serve<{ a?: ReturnType<typeof asker> }, never>({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req, srv) {
            const protocol = req.headers.get("sec-websocket-protocol");
            upgrades.push({ headers: Object.fromEntries(req.headers), protocol });
            if (o.token && req.headers.get("authorization") !== `Bearer ${o.token.value}`) return new Response("no", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="ws"' } });
            if (!protocol?.split(",").map((s) => s.trim()).includes("mcp")) return new Response("subprotocol mcp required", { status: 400 });
            if (srv.upgrade(req, { headers: { "Sec-WebSocket-Protocol": "mcp" }, data: {} })) return undefined as unknown as Response;
            return new Response("upgrade failed", { status: 400 });
        },
        websocket: {
            open(ws) {
                sockets.add(ws);
                ws.data.a = asker((m) => ws.send(JSON.stringify(m)));
            },
            async message(ws, raw) {
                const msg = JSON.parse(String(raw)) as Json;
                if (ws.data.a!.take(msg)) return;
                const r = await answer(msg, ws.data.a!.ask);
                if (r) ws.send(JSON.stringify(r));
            },
            close(ws) {
                sockets.delete(ws);
            },
        },
    });
    return {
        url: `ws://127.0.0.1:${server.port}/`,
        upgrades,
        closeAll(code = 1011) {
            for (const s of sockets) s.close(code, "going away");
        },
        stop: () => server.stop(true),
    };
}

export interface OAuthFixture {
    /** The MCP endpoint. */
    url: string;
    issuer: string;
    /** Every request, in order: method and path (with query). */
    log: string[];
    registrations: Json[];
    tokenRequests: Record<string, string>[];
    authorizeParams: Record<string, string>[];
    /** Access tokens the MCP endpoint accepts now (revoke by clearing). */
    valid: Set<string>;
    /** Make the next authorization response carry this `iss` (or none with null). */
    issOverride?: string | null;
    /** Make the next authorization response carry another `state`. */
    stateOverride?: string;
    /** Answer the next /authorize with ?error=access_denied. */
    deny?: boolean;
    /** Refuse refresh tokens. */
    refuseRefresh?: boolean;
    /** Access token lifetime in seconds. */
    expiresIn: number;
    /** What the 401 challenge carries besides resource_metadata (scope, error). */
    challengeExtra: string;
    /** Fields that replace the authorization server's metadata (a hostile endpoint). */
    metaExtra?: Json;
    stop(): void;
}

/** `register: false`: the authorization server has no registration endpoint. `prmAt`: where the resource metadata lives ("header" - named by the challenge; "path" - the well-known URL with the MCP path; "root" - the well-known root). */
export function startOAuthMcpServer(o: { register?: boolean; prmAt?: "header" | "path" | "root"; pkce?: boolean } = {}): OAuthFixture {
    const codes = new Map<string, { challenge: string; redirect: string; resource: string; client: string }>();
    const refresh = new Map<string, string>();
    let seq = 0;
    const f: OAuthFixture = {
        url: "",
        issuer: "",
        log: [],
        registrations: [],
        tokenRequests: [],
        authorizeParams: [],
        valid: new Set(),
        expiresIn: 3600,
        challengeExtra: "",
        stop: () => server.stop(true),
    };
    const json = (b: Json, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    const mint = () => {
        const access = `at-${++seq}`;
        const rt = `rt-${seq}`;
        f.valid.add(access);
        refresh.set(rt, access);
        return { access_token: access, token_type: "Bearer", expires_in: f.expiresIn, refresh_token: rt };
    };
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
            const u = new URL(req.url);
            f.log.push(`${req.method} ${u.pathname}${u.search}`);
            const base = `http://127.0.0.1:${server.port}`;
            const prm = { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["mcp:read", "mcp:write"] };
            const at = o.prmAt ?? "header";
            if (u.pathname === "/meta/prm" && at === "header") return json(prm);
            if (u.pathname === "/.well-known/oauth-protected-resource/mcp" && at === "path") return json(prm);
            if (u.pathname === "/.well-known/oauth-protected-resource" && at === "root") return json(prm);
            if (u.pathname === "/.well-known/oauth-authorization-server") {
                return json({
                    issuer: base,
                    authorization_endpoint: `${base}/authorize`,
                    token_endpoint: `${base}/token`,
                    ...(o.register === false ? {} : { registration_endpoint: `${base}/register` }),
                    code_challenge_methods_supported: o.pkce === false ? ["plain"] : ["S256"],
                    authorization_response_iss_parameter_supported: true,
                    ...f.metaExtra,
                });
            }
            if (u.pathname === "/register" && req.method === "POST") {
                const body = (await req.json()) as Json;
                f.registrations.push(body);
                return json({ client_id: `client-${f.registrations.length}`, redirect_uris: body.redirect_uris, token_endpoint_auth_method: "none" }, 201);
            }
            if (u.pathname === "/authorize") {
                const q = Object.fromEntries(u.searchParams);
                f.authorizeParams.push(q);
                const back = new URL(q.redirect_uri!);
                back.searchParams.set("state", f.stateOverride ?? q.state!);
                const iss = f.issOverride === undefined ? base : f.issOverride;
                if (iss !== null) back.searchParams.set("iss", iss);
                f.issOverride = undefined;
                f.stateOverride = undefined;
                if (f.deny) {
                    f.deny = false;
                    back.searchParams.set("error", "access_denied");
                } else {
                    const code = `code-${++seq}`;
                    codes.set(code, { challenge: q.code_challenge!, redirect: q.redirect_uri!, resource: q.resource!, client: q.client_id! });
                    back.searchParams.set("code", code);
                }
                return Response.redirect(back.href, 302);
            }
            if (u.pathname === "/token" && req.method === "POST") {
                const form = Object.fromEntries(new URLSearchParams(await req.text()));
                f.tokenRequests.push(form);
                if (form.grant_type === "authorization_code") {
                    const c = codes.get(form.code ?? "");
                    if (!c) return json({ error: "invalid_grant" }, 400);
                    codes.delete(form.code!);
                    const verified = createHash("sha256").update(form.code_verifier ?? "").digest("base64url") === c.challenge;
                    if (!verified || form.redirect_uri !== c.redirect || form.resource !== c.resource || form.client_id !== c.client) return json({ error: "invalid_grant", error_description: "PKCE, redirect, resource or client mismatch" }, 400);
                    return json(mint());
                }
                if (form.grant_type === "refresh_token") {
                    if (f.refuseRefresh || !refresh.has(form.refresh_token ?? "")) return json({ error: "invalid_grant" }, 400);
                    f.valid.delete(refresh.get(form.refresh_token!)!);
                    refresh.delete(form.refresh_token!);
                    return json(mint());
                }
                return json({ error: "unsupported_grant_type" }, 400);
            }
            if (u.pathname === "/mcp" && req.method === "POST") {
                const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
                if (!token || !f.valid.has(token)) {
                    const meta = at === "header" ? `resource_metadata="${base}/meta/prm"` : "";
                    return new Response("unauthorized", { status: 401, headers: { "WWW-Authenticate": `Bearer ${[meta, f.challengeExtra].filter(Boolean).join(", ")}`.trim() } });
                }
                const msg = (await req.json()) as Json;
                const r = await answer(msg, async () => ({ error: { code: -1, message: "no server requests over plain HTTP here" } }));
                return r ? json(r) : new Response(null, { status: 202 });
            }
            return new Response("not found", { status: 404 });
        },
    });
    f.url = `http://127.0.0.1:${server.port}/mcp`;
    f.issuer = `http://127.0.0.1:${server.port}`;
    return f;
}

/** The "browser": follow the authorization link (the fixture redirects straight to the loopback callback). */
export async function browse(url: string): Promise<number> {
    const r = await fetch(url, { redirect: "follow" });
    await r.text();
    return r.status;
}
