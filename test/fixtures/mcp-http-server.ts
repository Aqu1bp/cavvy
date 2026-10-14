// Streamable HTTP MCP server fixture (Bun.serve on a random localhost port).
//
//   legacy - 2025-06-18 with sessions: initialize returns Mcp-Session-Id, later
//            requests must carry it plus MCP-Protocol-Version; requests without
//            a session get 400 + JSON-RPC -32000 (like the TypeScript SDK);
//            tools/call answers over SSE with a notification and a ping
//            request ahead of the response; DELETE ends the session.
//   modern - 2026-07-28: no sessions; MCP-Protocol-Version and Mcp-Method
//            headers must match the body; x-mcp-header arguments are mirrored
//            into Mcp-Param-* headers; unknown methods get 404 + -32601.
//   auth   - every request gets 401 with a Bearer challenge.

type Json = Record<string, any>;

export interface Recorded {
    httpMethod: string;
    headers: Record<string, string>;
    body: Json | null;
}

export interface HttpFixture {
    url: string;
    requests: Recorded[];
    /** Responses the client POSTed back (answers to our ping). */
    clientResponses: Json[];
    deletes: Recorded[];
    sessionId?: string;
    expireSession(): void;
    stop(): void;
}

const MODERN = "2026-07-28";
const LEGACY = "2025-06-18";

const LEGACY_TOOLS: Json[] = [
    { name: "greet", description: "Greets", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
    { name: "stream_greet", description: "Greets over SSE", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
];

const MODERN_TOOLS: Json[] = [
    {
        name: "lookup",
        description: "Region-routed lookup",
        inputSchema: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" }, q: { type: "string" } } },
    },
    // Invalid x-mcp-header annotations: both tools must be dropped by the client.
    { name: "bad_type", inputSchema: { type: "object", properties: { x: { type: "object", "x-mcp-header": "X" } } } },
    { name: "bad_name", inputSchema: { type: "object", properties: { x: { type: "string", "x-mcp-header": "Bad Header!" } } } },
    { name: "plain", description: "No header params", inputSchema: { type: "object", properties: {} } },
];

function json(body: Json, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function sse(events: string[]): Response {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(c) {
            for (const e of events) {
                c.enqueue(enc.encode(e));
                await Bun.sleep(5);
            }
            c.close();
        },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

export function startHttpMcpServer(mode: "legacy" | "modern" | "auth"): HttpFixture {
    const requests: Recorded[] = [];
    const clientResponses: Json[] = [];
    const deletes: Recorded[] = [];
    let session: string | undefined;
    let counter = 0;

    const fixture: HttpFixture = {
        url: "",
        requests,
        clientResponses,
        deletes,
        expireSession() {
            session = undefined;
        },
        stop() {
            server.stop(true);
        },
    };

    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
            const headers: Record<string, string> = {};
            req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
            const text = req.method === "POST" ? await req.text() : "";
            let body: Json | null = null;
            try {
                body = text ? JSON.parse(text) : null;
            } catch {
                return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
            }
            const rec: Recorded = { httpMethod: req.method, headers, body };
            requests.push(rec);

            if (mode === "auth") return new Response("unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="fixture", resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"' } });
            if (mode === "modern") return modernHandler(req.method, headers, body);
            return legacyHandler(req.method, headers, body, rec);
        },
    });
    fixture.url = `http://127.0.0.1:${server.port}/mcp`;

    function legacyHandler(httpMethod: string, headers: Record<string, string>, body: Json | null, rec: Recorded): Response {
        if (httpMethod === "DELETE") {
            deletes.push(rec);
            if (session && headers["mcp-session-id"] === session) {
                session = undefined;
                return new Response(null, { status: 200 });
            }
            return new Response("no such session", { status: 404 });
        }
        if (httpMethod !== "POST" || !body) return new Response("method not allowed", { status: 405 });
        if (body.method === "initialize") {
            if (headers["mcp-session-id"]) return json({ jsonrpc: "2.0", id: body.id, error: { code: -32600, message: "initialize must not carry a session" } }, 400);
            session = `sess-${++counter}-${Math.random().toString(36).slice(2)}`;
            fixture.sessionId = session;
            return json(
                {
                    jsonrpc: "2.0",
                    id: body.id,
                    result: { protocolVersion: LEGACY, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "http-legacy", version: "1.0.0" }, instructions: "HTTP legacy instructions" },
                },
                200,
                { "Mcp-Session-Id": session },
            );
        }
        const sid = headers["mcp-session-id"];
        if (!sid) return json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Bad Request: No valid session ID provided" } }, 400);
        if (sid !== session) return json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32001, message: "Session not found" } }, 404);
        if (headers["mcp-protocol-version"] !== LEGACY) return json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32000, message: `Bad MCP-Protocol-Version: ${headers["mcp-protocol-version"]}` } }, 400);
        // Client responses (to our ping) and notifications.
        if (body.method === undefined && (body.result !== undefined || body.error !== undefined)) {
            clientResponses.push(body);
            return new Response(null, { status: 202 });
        }
        if (body.id === undefined) return new Response(null, { status: 202 });
        switch (body.method) {
            case "tools/list": {
                const start = body.params?.cursor !== undefined ? Number(body.params.cursor) : 0;
                const next = start + 1 < LEGACY_TOOLS.length ? String(start + 1) : undefined;
                return json({ jsonrpc: "2.0", id: body.id, result: { tools: LEGACY_TOOLS.slice(start, start + 1), ...(next ? { nextCursor: next } : {}) } });
            }
            case "tools/call": {
                const name = body.params?.arguments?.name ?? "nobody";
                if (body.params?.name === "greet") return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `hello ${name}` }] } });
                return sse([
                    ": keep-alive comment\n\n",
                    `event: message\nid: 1\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
                    `event: message\nid: 2\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "srv-ping-1", method: "ping" })}\n\n`,
                    `event: message\nid: 3\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `streamed hello ${name}` }] } })}\n\n`,
                ]);
            }
            default:
                return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
        }
    }

    function modernHandler(httpMethod: string, headers: Record<string, string>, body: Json | null): Response {
        if (httpMethod !== "POST" || !body) return new Response("method not allowed", { status: 405 });
        const id = body.id ?? null;
        const v = headers["mcp-protocol-version"];
        if (v !== MODERN || body.params?._meta?.["io.modelcontextprotocol/protocolVersion"] !== MODERN) {
            return json({ jsonrpc: "2.0", id, error: { code: -32022, message: "Unsupported protocol version", data: { supported: [MODERN], requested: v ?? null } } }, 400);
        }
        if (headers["mcp-method"] !== body.method) return json({ jsonrpc: "2.0", id, error: { code: -32020, message: `Mcp-Method header mismatch: ${headers["mcp-method"]}` } }, 400);
        switch (body.method) {
            case "server/discover":
                return json({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        resultType: "complete",
                        supportedVersions: [MODERN],
                        capabilities: { tools: {} },
                        instructions: "HTTP modern instructions",
                        _meta: { "io.modelcontextprotocol/serverInfo": { name: "http-modern", version: "2.0.0" } },
                        ttlMs: 0,
                        cacheScope: "private",
                    },
                });
            case "tools/list":
                return json({ jsonrpc: "2.0", id, result: { resultType: "complete", tools: MODERN_TOOLS } });
            case "tools/call": {
                const echo = { mcpName: headers["mcp-name"] ?? null, region: headers["mcp-param-region"] ?? null, session: headers["mcp-session-id"] ?? null };
                return sse([`data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { resultType: "complete", content: [{ type: "text", text: JSON.stringify(echo) }], structuredContent: echo } })}\n\n`]);
            }
            default:
                return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${body.method}` } }, 404);
        }
    }

    return fixture;
}
