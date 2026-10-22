// A stand-in for Anthropic's Messages API with a prompt cache: each request's
// prefix is cached for `ttlMs` from when it was sent, and reading it again
// refreshes it, as the real cache does. Token counts are characters scaled by
// `tokensPerChar`, so a test can have a 250K-token conversation without
// sending megabytes. `prefillMs` per 1K uncached tokens delays the first byte,
// as reading a long uncached prompt does. The system prompt and tools count
// at about four characters a token, unscaled.

export interface MockAnthropicRequest {
    messages: { role: string; content: unknown }[];
    system?: unknown;
    /** The request as sent. */
    body: Record<string, unknown>;
    at: number;
    usage: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
    compaction: boolean;
}

export interface MockAnthropic {
    url: string;
    requests: MockAnthropicRequest[];
    /** The reply text for a request, or an HTTP status to fail it with. */
    reply: (req: MockAnthropicRequest) => string | number;
    /** Holds a response back until this settles. */
    hold?: (req: MockAnthropicRequest) => Promise<void> | undefined;
    stop(): void;
}

const textOf = (content: unknown): string => (typeof content === "string" ? content : JSON.stringify(content));

export function startMockAnthropic(o: { ttlMs?: number; ttl1h?: boolean; tokensPerChar?: number; prefillMs?: number; now?: () => number; model?: string } = {}): MockAnthropic {
    const ttlMs = o.ttlMs ?? (o.ttl1h ? 3_600_000 : 300_000);
    const now = o.now ?? (() => Date.now());
    const scale = o.tokensPerChar ?? 1;
    /** Cached prefixes: their length in tokens, and until when they last. */
    let cache: { key: string; tokens: number; until: number }[] = [];
    const mock: MockAnthropic = {
        url: "",
        requests: [],
        reply: (r) => (r.compaction ? "Summary: the user asked for a long review; next step is to continue it." : "ok"),
        stop: () => server.stop(true),
    };
    const server = Bun.serve({
        port: 0,
        // A long prefill keeps a request quiet for a while.
        idleTimeout: 255,
        async fetch(req) {
            const url = new URL(req.url);
            if (url.pathname.endsWith("/models")) {
                return Response.json({ data: [{ type: "model", id: o.model ?? "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-01-01T00:00:00Z" }], has_more: false, first_id: null, last_id: null });
            }
            const body = (await req.json()) as { messages: { role: string; content: unknown }[]; system?: unknown; tools?: unknown };
            const at = now();
            cache = cache.filter((c) => c.until > at);
            // The prompt as cumulative prefixes: system and tools, then each message.
            const parts = [JSON.stringify([body.system, body.tools]), ...body.messages.map((m) => textOf(m.content))];
            let key = "";
            let tokens = 0;
            // The system prompt and tools at about four characters a token; the conversation scaled.
            const prefixes = parts.map((p, i) => ((key += p.length + ":" + p), (tokens += Math.ceil(i ? p.length * scale : p.length / 4)), { key, tokens }));
            const total = prefixes[prefixes.length - 1]!.tokens;
            const hit = [...prefixes].reverse().find((p) => cache.some((c) => c.key === p.key));
            const read = hit?.tokens ?? 0;
            for (const c of cache) if (hit && c.key === hit.key) c.until = at + ttlMs;
            // What it caches: everything up to the last message (where cache_control goes).
            cache.push({ key: prefixes[prefixes.length - 1]!.key, tokens: total, until: at + ttlMs });
            const last = body.messages[body.messages.length - 1];
            const compaction = /write a detailed summary of the conversation/.test(textOf(last?.content));
            const usage = { input_tokens: 3, cache_read_input_tokens: read, cache_creation_input_tokens: Math.max(0, total - read - 3) };
            const r: MockAnthropicRequest = { messages: body.messages, system: body.system, body, at, usage, compaction };
            mock.requests.push(r);
            const out = mock.reply(r);
            if (typeof out === "number") return Response.json({ type: "error", error: { type: "api_error", message: "mock failure" } }, { status: out });
            const delay = ((total - read) / 1000) * (o.prefillMs ?? 0);
            const enc = new TextEncoder();
            const event = (type: string, data: unknown) => enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`);
            const cacheCreation = o.ttl1h ? { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: usage.cache_creation_input_tokens } : { ephemeral_5m_input_tokens: usage.cache_creation_input_tokens, ephemeral_1h_input_tokens: 0 };
            const stream = new ReadableStream({
                async start(c) {
                    if (delay) await Bun.sleep(delay);
                    await mock.hold?.(r);
                    c.enqueue(event("message_start", { message: { id: `msg_${mock.requests.length}`, type: "message", role: "assistant", model: o.model ?? "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, cache_creation: cacheCreation, output_tokens: 1 } } }));
                    c.enqueue(event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
                    c.enqueue(event("content_block_delta", { index: 0, delta: { type: "text_delta", text: out } }));
                    c.enqueue(event("content_block_stop", { index: 0 }));
                    c.enqueue(event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: Math.ceil(out.length / 4) } }));
                    c.enqueue(event("message_stop", {}));
                    c.close();
                },
            });
            return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        },
    });
    mock.url = `http://127.0.0.1:${server.port}`;
    return mock;
}
