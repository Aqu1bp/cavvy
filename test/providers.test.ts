import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { isolate, FAKE } from "./helpers/isolate";

const iso = isolate();
const { OpenAICompatProvider, toOpenAIMessages, httpError } = await import("../src/providers/openai-compat");
const { OpenAIResponsesProvider, toResponsesInput } = await import("../src/providers/openai-responses");
const { toAnthropicMessages, sanitizeToolId } = await import("../src/providers/anthropic");
const { BUILTIN_PROVIDERS, customProviders, writeProvidersFile } = await import("../src/providers/registry");
const { ProviderError } = await import("../src/providers/types");
const { stall } = await import("../src/providers/sse");
import type { ProviderDef } from "../src/providers/registry";
import type { AssistantMessage, ChatRequest, Message, ModelInfo, StreamEvent } from "../src/providers/types";

type Json = Record<string, any>;

// ---------------------------------------------------------------------------
// Mock server

interface Seen {
    path: string;
    headers: Record<string, string>;
    body: Json;
}
const seen: Seen[] = [];
let respond: (path: string, body: Json) => Response | Promise<Response> = () => new Response("not configured", { status: 500 });

const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => (headers[k] = v));
        const body = (await req.json().catch(() => null)) as Json;
        const path = new URL(req.url).pathname;
        seen.push({ path, headers, body });
        return respond(path, body);
    },
});
const BASE = `http://127.0.0.1:${server.port}/v1`;

afterAll(() => {
    server.stop(true);
    iso.cleanup();
});
beforeEach(() => {
    seen.length = 0;
});

/** SSE body; each item becomes one `data:` event. Strings are sent raw. */
function sse(items: (Json | string)[], opts: { splitEvery?: number; pauseAfter?: number; pauseMs?: number } = {}): Response {
    const enc = new TextEncoder();
    let text = "";
    const chunks: string[] = [];
    items.forEach((it, i) => {
        const ev = typeof it === "string" ? it : `data: ${JSON.stringify(it)}\n\n`;
        text += ev;
        if (opts.pauseAfter !== undefined && i === opts.pauseAfter) {
            chunks.push(text);
            text = "";
        }
    });
    if (text) chunks.push(text);
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        async start(c) {
            for (let ci = 0; ci < chunks.length; ci++) {
                let piece = chunks[ci]!;
                // Split mid-event so the parser has to buffer partial lines.
                const n = opts.splitEvery ?? piece.length;
                for (let i = 0; i < piece.length; i += n) {
                    if (cancelled) return;
                    c.enqueue(enc.encode(piece.slice(i, i + n)));
                    await Bun.sleep(1);
                }
                if (ci === 0 && opts.pauseMs) await Bun.sleep(opts.pauseMs);
            }
            if (!cancelled) c.close();
        },
        cancel() {
            cancelled = true;
        },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

function builtin(id: string, over: Partial<ProviderDef> = {}): ProviderDef {
    return { ...BUILTIN_PROVIDERS.find((p) => p.id === id)!, baseUrl: BASE, ...over };
}

const CUSTOM: ProviderDef = {
    id: "custom-x",
    name: "Custom X",
    kind: "openai",
    baseUrl: BASE,
    envKeys: ["CUSTOM_X_API_KEY"],
    requiresKey: true,
    maxTokensField: "max_completion_tokens",
    streamUsage: true,
    custom: true,
};

function req(model: ModelInfo, messages: Message[], extra: Partial<ChatRequest> = {}): ChatRequest {
    return {
        model,
        system: "You are a test.",
        messages,
        tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
        ...extra,
    };
}

function collect(): { events: StreamEvent[]; on: (e: StreamEvent) => void } {
    const events: StreamEvent[] = [];
    return { events, on: (e) => events.push(e) };
}

const PNG = "iVBORw0KGgo=";

// A transcript in the provider-neutral format, with a turn from another provider.
const HISTORY: Message[] = [
    { role: "user", content: [{ type: "text", text: "Look at this" }, { type: "image", mediaType: "image/png", data: PNG }], meta: { kind: "prompt" } },
    {
        role: "assistant",
        provider: "anthropic",
        model: "claude-test",
        content: [
            { type: "thinking", text: "foreign reasoning", signature: "sig" },
            { type: "text", text: "Reading it." },
            { type: "tool_call", id: "toolu_01", name: "read_file", input: { path: "a.txt" } },
            { type: "tool_call", id: "toolu_02", name: "read_file", input: { path: "b.txt" } },
        ],
        raw: { anthropic: [{ type: "text", text: "Reading it." }] },
    },
    {
        role: "user",
        content: [
            { type: "tool_result", toolCallId: "toolu_01", toolName: "read_file", content: "file body", images: [{ type: "image", mediaType: "image/png", data: PNG }] },
            { type: "tool_result", toolCallId: "toolu_02", toolName: "read_file", content: "not found", isError: true },
        ],
        meta: { kind: "tool_results" },
    },
    { role: "user", content: [{ type: "text", text: "Thanks" }] },
];

// ---------------------------------------------------------------------------

describe("Chat Completions: message conversion", () => {
    test("converts the neutral transcript", () => {
        expect(toOpenAIMessages("SYS", HISTORY, CUSTOM)).toEqual([
            { role: "system", content: "SYS" },
            { role: "user", content: [{ type: "text", text: "Look at this" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }] },
            {
                role: "assistant",
                content: "Reading it.",
                tool_calls: [
                    { id: "toolu_01", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
                    { id: "toolu_02", type: "function", function: { name: "read_file", arguments: '{"path":"b.txt"}' } },
                ],
            },
            { role: "tool", tool_call_id: "toolu_01", content: "file body\n[1 image(s) attached in the next message]" },
            { role: "tool", tool_call_id: "toolu_02", content: "Error: not found" },
            { role: "user", content: [{ type: "text", text: "Images returned by the tool calls above:" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }] },
            { role: "user", content: "Thanks" },
        ]);
    });

    test("is deterministic", () => {
        expect(JSON.stringify(toOpenAIMessages("S", HISTORY, CUSTOM))).toBe(JSON.stringify(toOpenAIMessages("S", HISTORY, CUSTOM)));
    });

    test("replays raw.openai verbatim only for the same provider", () => {
        const raw = { role: "assistant", content: "exact bytes", tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{ \"a\" : 1 }" } }] };
        const msg: AssistantMessage = { role: "assistant", provider: "custom-x", model: "m", content: [{ type: "text", text: "different" }], raw: { openai: raw } };
        expect(toOpenAIMessages("", [msg], CUSTOM)).toEqual([raw]);
        expect(toOpenAIMessages("", [{ ...msg, provider: "other" }], CUSTOM)).toEqual([{ role: "assistant", content: "different" }]);
    });

    test("assistant turns with only tool calls send content null; empty turns are skipped", () => {
        const msgs: Message[] = [
            { role: "assistant", provider: "x", model: "m", content: [{ type: "tool_call", id: "a", name: "t", input: {} }] },
            { role: "assistant", provider: "x", model: "m", content: [{ type: "thinking", text: "only thinking" }] },
        ];
        const out = toOpenAIMessages("", msgs, CUSTOM);
        expect(out).toHaveLength(1);
        expect(out[0]!.content).toBeNull();
    });

    test("mistral: tool-call ids are mapped to 9 alphanumerics, consistently", () => {
        const out = toOpenAIMessages("", HISTORY, builtin("mistral"));
        const callIds = out.find((m) => m.role === "assistant")!.tool_calls.map((c: Json) => c.id);
        const resultIds = out.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
        for (const id of callIds) expect(id).toMatch(/^[A-Za-z0-9]{9}$/);
        expect(resultIds).toEqual(callIds);
        expect(callIds[0]).not.toBe(callIds[1]);
    });

    test("gemini: foreign tool calls get the documented placeholder signature on the first call", () => {
        const out = toOpenAIMessages("", HISTORY, builtin("gemini"));
        const calls = out.find((m) => m.role === "assistant")!.tool_calls;
        expect(calls[0].extra_content).toEqual({ google: { thought_signature: "skip_thought_signature_validator" } });
        expect(calls[1].extra_content).toBeUndefined();
    });

    test("deepseek: reasoning_content is present on every assistant turn", () => {
        const noThinking: AssistantMessage = { role: "assistant", provider: "openai", model: "gpt", content: [{ type: "text", text: "plain" }] };
        const out = toOpenAIMessages("", [...HISTORY, noThinking], builtin("deepseek"));
        const assistants = out.filter((m) => m.role === "assistant");
        expect(assistants.map((a) => a.reasoning_content)).toEqual(["foreign reasoning", ""]);
        // Other providers never get the field.
        expect(toOpenAIMessages("", HISTORY, CUSTOM).find((m) => m.role === "assistant")).not.toHaveProperty("reasoning_content");
    });
});

describe("Chat Completions: streaming", () => {
    const model: ModelInfo = { provider: "custom-x", id: "test-model", maxOutput: 8000, supportsTools: true };

    test("custom DeepSeek: reasoning survives storage and the next tool turn, but stays out of other dialects", async () => {
        writeProvidersFile({ custom: [{ id: CUSTOM.id, name: CUSTOM.name, baseUrl: BASE, deepseekCompat: true }] });
        try {
            const def = customProviders()[0]!;
            respond = () => sse([
                { choices: [{ delta: { reasoning_content: "Check " } }] },
                { choices: [{ delta: { reasoning_content: "the file.", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
            ]);
            const { events, on } = collect();
            const first = await new OpenAICompatProvider(def, undefined).stream(req(model, []), on);
            const stored: AssistantMessage = JSON.parse(JSON.stringify(first));
            expect(stored.raw?.openai?.reasoning_content).toBe("Check the file.");
            expect(events.filter((e) => e.type === "thinking").map((e) => e.text).join("")).toBe("Check the file.");
            const result: Message = { role: "user", content: [{ type: "tool_result", toolCallId: "c1", toolName: "read_file", content: "body" }] };
            respond = () => sse([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
            await new OpenAICompatProvider(def, undefined).stream(req(model, [stored, result]), () => {});
            expect(seen.at(-1)!.body.messages.find((m: Json) => m.role === "assistant").reasoning_content).toBe("Check the file.");
            expect(toOpenAIMessages("", [{ ...stored, raw: undefined }], def)[0]!.reasoning_content).toBe("Check the file.");
            for (const target of [CUSTOM, builtin("groq"), builtin("gemini")]) {
                expect(toOpenAIMessages("", [stored], target)[0]).not.toHaveProperty("reasoning_content");
            }
            expect(stored.raw?.openai?.reasoning_content).toBe("Check the file.");
        } finally {
            writeProvidersFile({});
        }
    });

    test("reasoning_content is retained even for unknown dialects, including empty values", async () => {
        for (const reasoning of ["received", ""]) {
            respond = () => sse([{ choices: [{ delta: { reasoning_content: reasoning, content: "answer" }, finish_reason: "stop" }] }]);
            const msg = await new OpenAICompatProvider(CUSTOM, undefined).stream(req(model, []), () => {});
            expect(msg.raw?.openai?.reasoning_content).toBe(reasoning);
            expect(toOpenAIMessages("", [msg], CUSTOM)[0]).not.toHaveProperty("reasoning_content");
        }
    });

    test("DeepSeek host detection is exact and explicit configuration overrides it", () => {
        const msg: AssistantMessage = { role: "assistant", provider: CUSTOM.id, model: "m", content: [{ type: "thinking", text: "thought" }, { type: "text", text: "answer" }], raw: { openai: { role: "assistant", content: "answer" } } };
        const direct = { ...CUSTOM, baseUrl: "https://api.deepseek.com/v1" };
        expect(toOpenAIMessages("", [msg], direct)[0]!.reasoning_content).toBe("thought");
        for (const def of [{ ...direct, deepseekCompat: false }, { ...direct, baseUrl: "https://api.deepseek.com.example/v1" }]) {
            expect(toOpenAIMessages("", [msg], def)[0]).not.toHaveProperty("reasoning_content");
        }
    });

    test("DeepSeek detection uses the effective constructor base URL", async () => {
        const previousFetch = globalThis.fetch;
        const bodies: Json[] = [];
        globalThis.fetch = (async (_url, init) => {
            bodies.push(JSON.parse(String(init?.body)));
            return sse([{ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] }]);
        }) as typeof fetch;
        try {
            const prior: AssistantMessage = { role: "assistant", provider: CUSTOM.id, model: "m", content: [{ type: "text", text: "previous" }] };
            await new OpenAICompatProvider(CUSTOM, undefined, "https://api.deepseek.com/v1").stream(req(model, [prior]), () => {});
            expect(bodies[0]!.messages.find((m: Json) => m.role === "assistant").reasoning_content).toBe("");
            await new OpenAICompatProvider({ ...CUSTOM, baseUrl: "https://api.deepseek.com/v1" }, undefined, BASE).stream(req(model, [prior]), () => {});
            expect(bodies[1]!.messages.find((m: Json) => m.role === "assistant")).not.toHaveProperty("reasoning_content");
        } finally {
            globalThis.fetch = previousFetch;
        }
    });


    test("text deltas, a chunked tool call, finish_reason and usage", async () => {
        respond = () =>
            sse(
                [
                    { id: "c1", model: "test-model-0613", choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] },
                    { id: "c1", choices: [{ index: 0, delta: { content: "lo" } }] },
                    { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "read_file", arguments: "" } }] } }] },
                    { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] },
                    { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th": "a' } }] } }] },
                    { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '.txt"}' } }] } }] },
                    // A second call without an index (some compat layers omit it).
                    { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ id: "call_def", type: "function", function: { name: "read_file", arguments: '{"path":"b.txt"}' } }] } }] },
                    { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
                    { id: "c1", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 5 } } },
                    "data: [DONE]\n\n",
                ],
                { splitEvery: 37 },
            );
        const { events, on } = collect();
        const p = new OpenAICompatProvider(CUSTOM, FAKE.openai);
        const msg = await p.stream(req(model, HISTORY, { maxTokens: 16_000 }), on);

        expect(msg.provider).toBe("custom-x");
        expect(msg.model).toBe("test-model-0613");
        expect(msg.stopReason).toBe("tool_use");
        expect(msg.content).toEqual([
            { type: "text", text: "Hello" },
            { type: "tool_call", id: "call_abc", name: "read_file", input: { path: "a.txt" } },
            { type: "tool_call", id: "call_def", name: "read_file", input: { path: "b.txt" } },
        ]);
        expect(msg.usage).toEqual({ inputTokens: 70, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0, reasoningTokens: 5, cost: undefined });
        expect(msg.raw?.openai).toEqual({
            role: "assistant",
            content: "Hello",
            tool_calls: [
                { id: "call_abc", type: "function", function: { name: "read_file", arguments: '{"path": "a.txt"}' } },
                { id: "call_def", type: "function", function: { name: "read_file", arguments: '{"path":"b.txt"}' } },
            ],
        });

        expect(events).toEqual([
            { type: "text", text: "Hel" },
            { type: "text", text: "lo" },
            { type: "tool_call_start", id: "call_abc", name: "read_file" },
            { type: "tool_call_delta", id: "call_abc", partial: '{"pa' },
            { type: "tool_call_delta", id: "call_abc", partial: 'th": "a' },
            { type: "tool_call_delta", id: "call_abc", partial: '.txt"}' },
            { type: "tool_call_start", id: "call_def", name: "read_file" },
            { type: "tool_call_delta", id: "call_def", partial: '{"path":"b.txt"}' },
        ]);
    });

    test("request body: messages, tools, stream_options, max tokens field and auth", async () => {
        respond = () => sse([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }, "data: [DONE]\n\n"]);
        await new OpenAICompatProvider(CUSTOM, FAKE.openai).stream(req(model, HISTORY, { maxTokens: 16_000 }), () => {});
        const r = seen[0]!;
        expect(r.path).toBe("/v1/chat/completions");
        expect(r.headers.authorization).toBe(`Bearer ${FAKE.openai}`);
        expect(r.headers["content-type"]).toBe("application/json");
        expect(r.body.model).toBe("test-model");
        expect(r.body.stream).toBe(true);
        expect(r.body.stream_options).toEqual({ include_usage: true });
        // min(request maxTokens, model maxOutput), in the provider's field
        expect(r.body.max_completion_tokens).toBe(8000);
        expect(r.body.max_tokens).toBeUndefined();
        expect(r.body.messages).toEqual(toOpenAIMessages("You are a test.", HISTORY, CUSTOM));
        expect(r.body.tools).toEqual([
            { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
        ]);
        expect(r.body.reasoning_effort).toBeUndefined();
    });

    test("no tools -> no tools field; unknown maxOutput -> no limit field", async () => {
        respond = () => sse([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }]);
        const msg = await new OpenAICompatProvider(builtin("groq"), "gsk_" + "x".repeat(40)).stream(
            { model: { provider: "groq", id: "llama" }, system: "", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] },
            () => {},
        );
        expect(msg.content).toEqual([{ type: "text", text: "ok" }]);
        expect(msg.stopReason).toBe("end_turn");
        const b = seen[0]!.body;
        expect(b.tools).toBeUndefined();
        expect(b.max_tokens).toBeUndefined();
        expect(b.messages).toEqual([{ role: "user", content: "hi" }]);
    });

    test("openrouter: no stream_options, reasoning object, attribution headers, reported cost", async () => {
        respond = () =>
            sse([
                { choices: [{ index: 0, delta: { reasoning: "thinking...", reasoning_details: [{ type: "reasoning.text", index: 0, text: "thinking..." }] } }] },
                { choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] },
                { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0012 } },
            ]);
        const def = builtin("openrouter");
        const m: ModelInfo = { provider: "openrouter", id: "vendor/model", supportsReasoning: true, maxOutput: 4000 };
        const msg = await new OpenAICompatProvider(def, FAKE.openrouter).stream(req(m, [{ role: "user", content: [{ type: "text", text: "q" }] }], { effort: "high" }), () => {});
        const r = seen[0]!;
        expect(r.body.stream_options).toBeUndefined();
        expect(r.body.reasoning).toEqual({ effort: "high" });
        expect(r.body.reasoning_effort).toBeUndefined();
        expect(r.body.max_tokens).toBe(4000);
        expect(r.headers["http-referer"]).toBe("https://github.com/harness-cli");
        expect(r.headers["x-title"]).toBe("Harness CLI");
        expect(msg.usage?.cost).toBe(0.0012);
        expect(msg.content[0]).toEqual({ type: "thinking", text: "thinking..." });
        expect(msg.raw?.openai?.reasoning_details).toEqual([{ type: "reasoning.text", index: 0, text: "thinking..." }]);
    });

    test("deepseek: reasoning_content streamed, stored, and sent back on the next turn", async () => {
        const def = builtin("deepseek");
        const m: ModelInfo = { provider: "deepseek", id: "deepseek-reasoner", maxOutput: 32_000, supportsReasoning: true };
        respond = () =>
            sse([
                { model: "deepseek-reasoner", choices: [{ index: 0, delta: { role: "assistant", content: null, reasoning_content: "Let me " } }] },
                { choices: [{ index: 0, delta: { content: null, reasoning_content: "think." } }] },
                { choices: [{ index: 0, delta: { content: "Answer." } }] },
                { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 9, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 10 } },
                "data: [DONE]\n\n",
            ]);
        const { events, on } = collect();
        const first: Message[] = [{ role: "user", content: [{ type: "text", text: "q1" }] }];
        const a1 = await new OpenAICompatProvider(def, FAKE.deepseek).stream(req(m, first), on);
        expect(a1.content).toEqual([
            { type: "thinking", text: "Let me think." },
            { type: "text", text: "Answer." },
        ]);
        expect(a1.raw?.openai).toEqual({ role: "assistant", content: "Answer.", reasoning_content: "Let me think." });
        expect(a1.usage).toMatchObject({ inputTokens: 10, outputTokens: 9, cacheReadTokens: 40 });
        expect(events.filter((e) => e.type === "thinking")).toEqual([
            { type: "thinking", text: "Let me " },
            { type: "thinking", text: "think." },
        ]);

        seen.length = 0;
        respond = () => sse([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }]);
        const foreign: AssistantMessage = { role: "assistant", provider: "anthropic", model: "c", content: [{ type: "thinking", text: "claude thoughts" }, { type: "text", text: "hi" }] };
        await new OpenAICompatProvider(def, FAKE.deepseek).stream(req(m, [...first, a1, { role: "user", content: [{ type: "text", text: "q2" }] }, foreign, { role: "user", content: [{ type: "text", text: "q3" }] }]), () => {});
        const assistants = seen[0]!.body.messages.filter((x: Json) => x.role === "assistant");
        expect(assistants).toEqual([
            { role: "assistant", content: "Answer.", reasoning_content: "Let me think." },
            { role: "assistant", content: "hi", reasoning_content: "claude thoughts" },
        ]);
    });

    test("malformed tool arguments are kept as __invalid_json; finish 'stop' with calls is tool_use", async () => {
        respond = () =>
            sse([
                { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c9", function: { name: "read_file", arguments: '{"path": ' } }] } }] },
                { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
            ]);
        const msg = await new OpenAICompatProvider(CUSTOM, FAKE.openai).stream(req(model, []), () => {});
        expect(msg.content).toEqual([{ type: "tool_call", id: "c9", name: "read_file", input: { __invalid_json: '{"path": ' } }]);
        expect(msg.stopReason).toBe("tool_use");
    });

    test("finish_reason length maps to max_tokens", async () => {
        respond = () => sse([{ choices: [{ index: 0, delta: { content: "cut" }, finish_reason: "length" }] }]);
        const msg = await new OpenAICompatProvider(CUSTOM, FAKE.openai).stream(req(model, []), () => {});
        expect(msg.stopReason).toBe("max_tokens");
    });

    test("an error chunk mid-stream becomes a ProviderError", async () => {
        respond = () => sse([{ choices: [{ index: 0, delta: { content: "par" } }] }, { error: { code: 429, message: "Rate limit exceeded" } }]);
        const err = await new OpenAICompatProvider(CUSTOM, FAKE.openai).stream(req(model, []), () => {}).catch((e) => e);
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.message).toBe("Custom X: Rate limit exceeded");
        expect(err.status).toBe(429);
        expect(err.retryable).toBe(true);
    });

    test("aborting mid-stream rejects with 'aborted' instead of returning partial text", async () => {
        respond = () => sse([{ choices: [{ index: 0, delta: { content: "partial " } }] }, { choices: [{ index: 0, delta: { content: "rest" }, finish_reason: "stop" }] }], { pauseAfter: 0, pauseMs: 3000 });
        const ac = new AbortController();
        const events: StreamEvent[] = [];
        const t0 = Date.now();
        const result = new OpenAICompatProvider(CUSTOM, FAKE.openai)
            .stream(req(model, [], { signal: ac.signal }), (e) => {
                events.push(e);
                if (e.type === "text") ac.abort();
            })
            .then(
                (m) => ({ resolved: m }),
                (e) => ({ rejected: e }),
            );
        const r = (await result) as { resolved?: AssistantMessage; rejected?: InstanceType<typeof ProviderError> };
        expect(r.resolved).toBeUndefined();
        expect(r.rejected).toBeInstanceOf(ProviderError);
        expect(r.rejected!.message).toBe("aborted");
        expect(r.rejected!.retryable).toBe(false);
        expect(events).toEqual([{ type: "text", text: "partial " }]);
        expect(Date.now() - t0).toBeLessThan(2000);
    });

    test("aborting before the response arrives rejects with 'aborted'", async () => {
        respond = async () => {
            await Bun.sleep(1000);
            return sse([{ choices: [{ index: 0, delta: { content: "late" }, finish_reason: "stop" }] }]);
        };
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 30);
        const err = await new OpenAICompatProvider(CUSTOM, FAKE.openai).stream(req(model, [], { signal: ac.signal }), () => {}).catch((e) => e);
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.message).toBe("aborted");
    });

    describe("a server that stops sending is a retryable error, not a hang", () => {
        const prev = stall.ms;
        beforeEach(() => void (stall.ms = 150));
        afterAll(() => void (stall.ms = prev));

        test("no response at all", async () => {
            respond = async () => {
                await Bun.sleep(1500);
                return sse([{ choices: [{ index: 0, delta: { content: "late" }, finish_reason: "stop" }] }]);
            };
            const t0 = Date.now();
            const err = await new OpenAICompatProvider(CUSTOM, FAKE.openai).stream(req(model, []), () => {}).catch((e) => e);
            expect(err).toBeInstanceOf(ProviderError);
            expect(err.message).toBe("No response from Custom X for 0s");
            expect(err.retryable).toBe(true);
            expect(Date.now() - t0).toBeLessThan(1000);
        });

        test("Vertex, which sends nothing until the reply is ready, gets longer for the first byte", async () => {
            const prevFirst = stall.firstByteMs;
            stall.firstByteMs = 1000;
            try {
                // Silent for longer than the usual limit, then the whole reply at once.
                respond = async () => {
                    await Bun.sleep(400);
                    return sse([{ choices: [{ index: 0, delta: { content: "whole" }, finish_reason: "stop" }] }]);
                };
                const vertex: ProviderDef = { ...CUSTOM, id: "vertex", name: "Vertex AI" };
                const msg = await new OpenAICompatProvider(vertex, FAKE.openai).stream(req(model, []), () => {});
                expect(msg.content).toEqual([{ type: "text", text: "whole" }]);
                // Anyone else still gives up at the usual limit.
                const err = await new OpenAICompatProvider(CUSTOM, FAKE.openai).stream(req(model, []), () => {}).catch((e) => e);
                expect(err.message).toBe("No response from Custom X for 0s");
                // The longer wait is only for the first byte, and the message says which limit ran out.
                respond = async () => {
                    await Bun.sleep(1500);
                    return sse([]);
                };
                const late = await new OpenAICompatProvider(vertex, FAKE.openai).stream(req(model, []), () => {}).catch((e) => e);
                expect(late.message).toBe("No response from Vertex AI for 1s");
                expect(late.retryable).toBe(true);
                respond = () => sse([{ choices: [{ index: 0, delta: { content: "par" } }] }, { choices: [{ index: 0, delta: { content: "t" }, finish_reason: "stop" }] }], { pauseAfter: 0, pauseMs: 1500 });
                const t0 = Date.now();
                const cut = await new OpenAICompatProvider(vertex, FAKE.openai).stream(req(model, []), () => {}).catch((e) => e);
                expect(cut.message).toBe("No response from Vertex AI for 0s");
                expect(Date.now() - t0).toBeLessThan(900);
                // A rejected token is refreshed and the request sent again: that request waits for its first byte too.
                class Refreshing extends OpenAICompatProvider {
                    protected override canRefresh() {
                        return true;
                    }
                }
                let n = 0;
                respond = async () => {
                    if (++n === 1) return new Response("expired", { status: 401 });
                    await Bun.sleep(400);
                    return sse([{ choices: [{ index: 0, delta: { content: "again" }, finish_reason: "stop" }] }]);
                };
                const again = await new Refreshing(vertex, FAKE.openai).stream(req(model, []), () => {});
                expect(n).toBe(2);
                expect(again.content).toEqual([{ type: "text", text: "again" }]);
            } finally {
                stall.firstByteMs = prevFirst;
            }
        }, 20_000);

        test("silence partway through the body", async () => {
            respond = () => sse([{ choices: [{ index: 0, delta: { content: "par" } }] }, { choices: [{ index: 0, delta: { content: "t" }, finish_reason: "stop" }] }], { pauseAfter: 0, pauseMs: 1500 });
            const err = await new OpenAICompatProvider(CUSTOM, FAKE.openai).stream(req(model, []), () => {}).catch((e) => e);
            expect(err).toBeInstanceOf(ProviderError);
            expect(err.message).toBe("No response from Custom X for 0s");
            expect(err.retryable).toBe(true);
        });

        test("an error status whose body never finishes", async () => {
            respond = () =>
                new Response(
                    new ReadableStream({
                        async start(ctl) {
                            ctl.enqueue(new TextEncoder().encode('{"error":'));
                            await Bun.sleep(1500);
                            ctl.close();
                        },
                    }),
                    { status: 400 },
                );
            const err = await new OpenAICompatProvider(CUSTOM, FAKE.openai).stream(req(model, []), () => {}).catch((e) => e);
            expect(err.message).toBe("No response from Custom X for 0s");
            expect(err.retryable).toBe(true);
            const ac = new AbortController();
            setTimeout(() => ac.abort(), 50);
            const aborted = await new OpenAIResponsesProvider(builtin("openai"), FAKE.openai)
                .stream(req({ provider: "openai", id: "gpt-6-sol" }, [], { signal: ac.signal }), () => {})
                .catch((e) => e);
            expect(aborted.message).toBe("aborted");
        });

        test("steady chunks keep the request alive past the limit", async () => {
            const items = Array.from({ length: 6 }, (_, i) => ({ choices: [{ index: 0, delta: { content: String(i) }, ...(i === 5 ? { finish_reason: "stop" } : {}) }] }));
            respond = () => {
                const enc = new TextEncoder();
                return new Response(
                    new ReadableStream({
                        async start(ctl) {
                            for (const it of items) {
                                ctl.enqueue(enc.encode(`data: ${JSON.stringify(it)}\n\n`));
                                await Bun.sleep(60);
                            }
                            ctl.close();
                        },
                    }),
                    { headers: { "Content-Type": "text/event-stream" } },
                );
            };
            const msg = await new OpenAICompatProvider(CUSTOM, FAKE.openai).stream(req(model, []), () => {});
            expect(msg.content).toEqual([{ type: "text", text: "012345" }]);
        });

        test("the Responses API too", async () => {
            respond = async () => {
                await Bun.sleep(1500);
                return new Response("late");
            };
            const err = await new OpenAIResponsesProvider(builtin("openai"), FAKE.openai)
                .stream(req({ provider: "openai", id: "gpt-6-sol" }, []), () => {})
                .catch((e) => e);
            expect(err).toBeInstanceOf(ProviderError);
            expect(err.message).toBe("No response from OpenAI for 0s");
            expect(err.retryable).toBe(true);
        });
    });
});

// ---------------------------------------------------------------------------

describe("Chat Completions: effort discovery", () => {
    for (const [provider, id] of [
        ["groq", "openai/gpt-oss-120b"], ["groq", "openai/gpt-oss-20b"],
        ["together", "openai/gpt-oss-120b"],
        ["fireworks", "accounts/fireworks/models/gpt-oss-120b"], ["fireworks", "accounts/fireworks/models/gpt-oss-20b"],
        ["cerebras", "gpt-oss-120b"], ["ollama", "gpt-oss:20b"], ["ollama", "gpt-oss:120b"],
    ] as const) {
        test(`${provider} ${id}: discovered levels control the wire request`, async () => {
            respond = () => Response.json({ data: [{ id }, { id: "llama-plain" }, { id: `${id}-unknown` }] });
            const client = new OpenAICompatProvider(builtin(provider), undefined);
            const models = await client.listModels();
            expect(models[0]).toMatchObject({ supportsReasoning: true, effortLevels: ["low", "medium", "high"] });
            respond = () => sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
            for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
                await client.stream(req(models[0]!, [], { effort }), () => {});
                expect(seen.at(-1)!.body.reasoning_effort).toBe(effort === "max" || effort === "xhigh" ? "high" : effort);
            }
            for (const model of models.slice(1)) {
                expect(model.supportsReasoning).not.toBe(true);
                await client.stream(req(model, [], { effort: "high" }), () => {});
                expect(seen.at(-1)!.body).not.toHaveProperty("reasoning_effort");
            }
        });
    }

    test("xAI uses advertised levels rather than forwarding max", async () => {
        respond = () => Response.json({ data: [
            { id: "grok-4.7", capabilities: { reasoning_effort: ["low", "medium", "high", "xhigh"] } },
            { id: "grok-4.5", capabilities: { reasoning_effort: ["low", "medium", "high"] } },
            { id: "no-effort" },
        ] });
        const client = new OpenAICompatProvider(builtin("xai"), undefined);
        const models = await client.listModels();
        expect(models[0]!.effortLevels).toEqual(["low", "medium", "high", "xhigh"]);
        expect(models[1]!.effortLevels).toEqual(["low", "medium", "high"]);
        respond = () => sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
        for (const [i, expected] of [[0, "xhigh"], [1, "high"], [2, undefined]] as const) {
            await client.stream(req(models[i]!, [], { effort: "max" }), () => {});
            expect(seen.at(-1)!.body.reasoning_effort).toBe(expected);
        }
    });

    test("custom per-model effort configuration works with listings, appended models and a missing listing", async () => {
        writeProvidersFile({ custom: [{ id: CUSTOM.id, name: CUSTOM.name, baseUrl: BASE, models: ["configured", "plain"], modelEffortLevels: { configured: ["low", "high"], listed: ["medium", "high"] } }] });
        try {
            const def = customProviders()[0]!;
            for (const status of [200, 404]) {
                respond = () => status === 200 ? Response.json({ data: [{ id: "listed" }, { id: "openai/gpt-oss-120b" }] }) : new Response("no models", { status });
                const client = new OpenAICompatProvider(def, undefined);
                const models = await client.listModels();
                expect(models.find((m) => m.id === "configured")).toMatchObject({ supportsReasoning: true, effortLevels: ["low", "high"] });
                respond = () => sse([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
                for (const model of models) {
                    await client.stream(req(model, [], { effort: "max" }), () => {});
                    expect(seen.at(-1)!.body.reasoning_effort).toBe(["configured", "listed"].includes(model.id) ? "high" : undefined);
                }
            }
        } finally {
            writeProvidersFile({});
        }
    });

    test("LM Studio and arbitrary custom endpoints do not infer effort from model names", async () => {
        respond = () => Response.json({ data: [{ id: "openai/gpt-oss-20b" }, { id: "deepseek-reasoner" }] });
        for (const def of [builtin("lmstudio"), CUSTOM]) {
            expect((await new OpenAICompatProvider(def, undefined).listModels()).some((m) => m.supportsReasoning)).toBe(false);
        }
    });

    test("custom configuration changes invalidate clients and every cached model lookup", async () => {
        const { listAllModels, cachedListings, resolveModelInfo, lookupModel, clientFor, forgetClient } = await import("../src/providers/models");
        const previousFetch = globalThis.fetch;
        const bodies: Json[] = [];
        globalThis.fetch = (async (url, init) => {
            if (String(url) === "https://gateway.example/v1/models") return Response.json({ data: [{ id: "configured" }] });
            if (String(url) === "https://gateway.example/v1/chat/completions") {
                bodies.push(JSON.parse(String(init?.body)));
                return sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
            }
            return new Response("not configured", { status: 404 });
        }) as typeof fetch;
        try {
            writeProvidersFile({ custom: [{ id: CUSTOM.id, name: CUSTOM.name, baseUrl: "https://gateway.example/v1", requiresKey: false, deepseekCompat: true, modelEffortLevels: { configured: ["low", "high"] } }] });
            expect(resolveModelInfo(`${CUSTOM.id}:configured`)).toMatchObject({ supportsReasoning: true, effortLevels: ["low", "high"] });
            await listAllModels({ refresh: true });
            expect(cachedListings().find((l) => l.provider.id === CUSTOM.id)?.models[0]?.supportsReasoning).toBe(true);
            const oldClient = await clientFor(CUSTOM.id);
            writeProvidersFile({ custom: [{ id: CUSTOM.id, name: CUSTOM.name, baseUrl: "https://gateway.example/v1", requiresKey: false }] });
            expect(cachedListings().find((l) => l.provider.id === CUSTOM.id)).toBeUndefined();
            expect(resolveModelInfo(`${CUSTOM.id}:configured`)?.supportsReasoning).toBeUndefined();
            expect((await lookupModel(`${CUSTOM.id}:configured`))?.supportsReasoning).toBeUndefined();
            const client = await clientFor(CUSTOM.id);
            expect(client).not.toBe(oldClient);
            const m = resolveModelInfo(`${CUSTOM.id}:configured`)!;
            const prior: AssistantMessage = { role: "assistant", provider: CUSTOM.id, model: m.id, content: [{ type: "text", text: "previous" }], raw: { openai: { role: "assistant", content: "previous", reasoning_content: "thought" } } };
            await client.stream(req(m, [prior], { effort: "high" }), () => {});
            expect(bodies[0]).not.toHaveProperty("reasoning_effort");
            expect(bodies[0]!.messages.find((m: Json) => m.role === "assistant")).not.toHaveProperty("reasoning_content");
        } finally {
            globalThis.fetch = previousFetch;
            forgetClient(CUSTOM.id);
            writeProvidersFile({});
        }
    });
});

describe("Responses API", () => {
    const def = builtin("openai");
    const model: ModelInfo = { provider: "openai", id: "gpt-6-sol", maxOutput: 128_000, supportsReasoning: true, effortLevels: ["low", "medium", "high"] };

    const reasoningItem = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Thinking hard" }], encrypted_content: "ENCRYPTED==" };
    const messageItem = { type: "message", id: "msg_1", role: "assistant", status: "completed", phase: "commentary", content: [{ type: "output_text", text: "Hi there", annotations: [] }] };
    const callItem = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}', status: "completed" };

    function stream1() {
        return sse(
            [
                { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
                { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
                { type: "response.reasoning_summary_part.added", item_id: "rs_1", output_index: 0, summary_index: 0 },
                { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, delta: "Thinking hard" },
                { type: "response.output_item.done", output_index: 0, item: reasoningItem },
                { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
                { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "Hi " },
                { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "there" },
                { type: "response.output_item.done", output_index: 1, item: messageItem },
                { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" } },
                { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 2, delta: '{"path":' },
                { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 2, delta: '"a.txt"}' },
                { type: "response.output_item.done", output_index: 2, item: callItem },
                {
                    type: "response.completed",
                    response: {
                        id: "resp_1",
                        status: "completed",
                        model: "gpt-6-sol",
                        output: [reasoningItem, messageItem, callItem],
                        usage: { input_tokens: 200, input_tokens_details: { cached_tokens: 50 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 10 } },
                    },
                },
            ],
            { splitEvery: 53 },
        );
    }

    let first: AssistantMessage;
    const prompt: Message = { role: "user", content: [{ type: "text", text: "list files" }, { type: "image", mediaType: "image/png", data: PNG }] };

    test("streams reasoning, text and a function call; maps usage", async () => {
        respond = () => stream1();
        const { events, on } = collect();
        first = await new OpenAIResponsesProvider(def, FAKE.openai).stream(req(model, [prompt], { effort: "xhigh", showThinking: true, cacheKey: "sess-1", maxTokens: 64_000 }), on);
        expect(first.content).toEqual([
            { type: "thinking", text: "Thinking hard" },
            { type: "text", text: "Hi there" },
            { type: "tool_call", id: "call_1", name: "read_file", input: { path: "a.txt" } },
        ]);
        expect(first.stopReason).toBe("tool_use");
        expect(first.model).toBe("gpt-6-sol");
        expect(first.provider).toBe("openai");
        expect(first.usage).toEqual({ inputTokens: 150, outputTokens: 40, cacheReadTokens: 50, cacheWriteTokens: 0, reasoningTokens: 10 });
        expect(first.raw?.responses).toEqual([reasoningItem, messageItem, callItem]);
        expect(events).toEqual([
            { type: "thinking", text: "Thinking hard" },
            { type: "text", text: "Hi " },
            { type: "text", text: "there" },
            { type: "tool_call_start", id: "call_1", name: "read_file" },
            { type: "tool_call_delta", id: "call_1", partial: '{"path":' },
            { type: "tool_call_delta", id: "call_1", partial: '"a.txt"}' },
        ]);

        const b = seen[0]!.body;
        expect(seen[0]!.path).toBe("/v1/responses");
        expect(seen[0]!.headers.authorization).toBe(`Bearer ${FAKE.openai}`);
        expect(b.store).toBe(false);
        expect(b.stream).toBe(true);
        expect(b.instructions).toBe("You are a test.");
        expect(b.input).toEqual([
            { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }, { type: "input_image", image_url: `data:image/png;base64,${PNG}`, detail: "auto" }] },
        ]);
        expect(b.tools).toEqual([{ type: "function", name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, strict: false }]);
        expect(b.tool_choice).toBe("auto");
        expect(b.parallel_tool_calls).toBe(true);
        expect(b.max_output_tokens).toBe(64_000);
        // xhigh isn't offered by this model: nearest level is used
        expect(b.reasoning).toEqual({ effort: "high", summary: "auto" });
        expect(b.prompt_cache_key).toBe("sess-1");
    });

    test("next request replays output items verbatim (store:false) followed by tool output", async () => {
        respond = () => sse([{ type: "response.completed", response: { status: "completed", model: "gpt-6-sol", output: [] } }]);
        const results: Message = { role: "user", content: [{ type: "tool_result", toolCallId: "call_1", toolName: "read_file", content: "contents" }], meta: { kind: "tool_results" } };
        const msg = await new OpenAIResponsesProvider(def, FAKE.openai).stream(req(model, [prompt, first, results]), () => {});
        expect(msg.content).toEqual([]);
        expect(msg.stopReason).toBe("end_turn");
        const input = seen[0]!.body.input;
        expect(input.slice(1)).toEqual([reasoningItem, messageItem, callItem, { type: "function_call_output", call_id: "call_1", output: "contents" }]);
        expect(seen[0]!.body.store).toBe(false);
    });

    test("reasoning items are dropped when the model changes", () => {
        const items = toResponsesInput([prompt, first], def, "gpt-6-luna");
        expect(items.slice(1)).toEqual([messageItem, callItem]);
        expect(toResponsesInput([prompt, first], def, "gpt-6-sol").slice(1)).toEqual([reasoningItem, messageItem, callItem]);
    });

    test("turns from other providers become message / function_call items", () => {
        const items = toResponsesInput(HISTORY, def, "gpt-6-sol");
        expect(items).toEqual([
            { type: "message", role: "user", content: [{ type: "input_text", text: "Look at this" }, { type: "input_image", image_url: `data:image/png;base64,${PNG}`, detail: "auto" }] },
            { type: "message", role: "assistant", content: "Reading it." },
            { type: "function_call", call_id: "toolu_01", name: "read_file", arguments: '{"path":"a.txt"}' },
            { type: "function_call", call_id: "toolu_02", name: "read_file", arguments: '{"path":"b.txt"}' },
            {
                type: "function_call_output",
                call_id: "toolu_01",
                output: [
                    { type: "input_text", text: "file body" },
                    { type: "input_image", image_url: `data:image/png;base64,${PNG}`, detail: "auto" },
                ],
            },
            { type: "function_call_output", call_id: "toolu_02", output: "Error: not found" },
            { type: "message", role: "user", content: [{ type: "input_text", text: "Thanks" }] },
        ]);
    });

    test("call ids are sanitized identically for calls and outputs", () => {
        const msgs: Message[] = [
            { role: "assistant", provider: "x", model: "m", content: [{ type: "tool_call", id: "weird:id/1", name: "t", input: {} }] },
            { role: "user", content: [{ type: "tool_result", toolCallId: "weird:id/1", toolName: "t", content: "" }] },
        ];
        const items = toResponsesInput(msgs, def, "gpt-6-sol");
        expect(items[0]!.call_id).toBe("weird_id_1");
        expect(items[1]).toEqual({ type: "function_call_output", call_id: "weird_id_1", output: "(no output)" });
    });

    test("non-reasoning model ids get no reasoning block", async () => {
        respond = () => sse([{ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "x" }] }] } }]);
        const msg = await new OpenAIResponsesProvider(def, FAKE.openai).stream(req({ provider: "openai", id: "gpt-4.1" }, [prompt], { effort: "high" }), () => {});
        expect(seen[0]!.body.reasoning).toBeUndefined();
        // Falls back to response.output when no output_item.done events arrived
        expect(msg.content).toEqual([{ type: "text", text: "x" }]);
        expect(msg.model).toBe("gpt-4.1");
    });

    test("incomplete response: max_output_tokens maps to max_tokens", async () => {
        respond = () => sse([{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] } }]);
        const msg = await new OpenAIResponsesProvider(def, FAKE.openai).stream(req(model, [prompt]), () => {});
        expect(msg.stopReason).toBe("max_tokens");
    });

    test("refusal content maps to stopReason refusal", async () => {
        respond = () => sse([{ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] }] } }]);
        const msg = await new OpenAIResponsesProvider(def, FAKE.openai).stream(req(model, [prompt]), () => {});
        expect(msg.stopReason).toBe("refusal");
        expect(msg.content).toEqual([{ type: "text", text: "I can't help with that." }]);
    });

    test("response.failed and error events become ProviderErrors", async () => {
        respond = () => sse([{ type: "response.failed", response: { error: { code: "server_error", message: "Something broke" } } }]);
        const e1 = await new OpenAIResponsesProvider(def, FAKE.openai).stream(req(model, [prompt]), () => {}).catch((e) => e);
        expect(e1).toBeInstanceOf(ProviderError);
        expect(e1.message).toBe("OpenAI: Something broke (server_error)");
        expect(e1.retryable).toBe(true);

        respond = () => sse([{ type: "error", code: "invalid_prompt", message: "Bad prompt" }]);
        const e2 = await new OpenAIResponsesProvider(def, FAKE.openai).stream(req(model, [prompt]), () => {}).catch((e) => e);
        expect(e2.message).toBe("OpenAI: Bad prompt (invalid_prompt)");
        expect(e2.retryable).toBe(false);
    });

    test("a stream that ends before response.completed is a retryable error", async () => {
        respond = () => sse([{ type: "response.output_text.delta", delta: "half" }]);
        const err = await new OpenAIResponsesProvider(def, FAKE.openai).stream(req(model, [prompt]), () => {}).catch((e) => e);
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.retryable).toBe(true);
        expect(err.message).toContain("stream ended before the response completed");
    });

    test("aborting mid-stream rejects with 'aborted' instead of returning partial output", async () => {
        respond = () =>
            sse(
                [
                    { type: "response.output_text.delta", output_index: 0, delta: "partial" },
                    { type: "response.output_item.done", output_index: 0, item: { type: "message", content: [{ type: "output_text", text: "partial rest" }] } },
                    { type: "response.completed", response: { status: "completed", output: [] } },
                ],
                { pauseAfter: 0, pauseMs: 3000 },
            );
        const ac = new AbortController();
        const t0 = Date.now();
        const r = await new OpenAIResponsesProvider(def, FAKE.openai)
            .stream(req(model, [prompt], { signal: ac.signal }), (e) => {
                if (e.type === "text") ac.abort();
            })
            .then(
                (m) => ({ resolved: m, rejected: undefined }),
                (e) => ({ resolved: undefined, rejected: e }),
            );
        expect(r.resolved).toBeUndefined();
        expect(r.rejected).toBeInstanceOf(ProviderError);
        expect(r.rejected.message).toBe("aborted");
        expect(Date.now() - t0).toBeLessThan(2000);
    });
});

// ---------------------------------------------------------------------------

describe("HTTP errors", () => {
    const model: ModelInfo = { provider: "custom-x", id: "m", maxOutput: 1000 };
    const run = () => new OpenAICompatProvider(CUSTOM, FAKE.openai).stream(req(model, []), () => {}).catch((e) => e);

    test("401 is not retryable and points at /login", async () => {
        respond = () => Response.json({ error: { message: "Invalid API key", type: "invalid_request_error" } }, { status: 401 });
        const err = await run();
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.status).toBe(401);
        expect(err.retryable).toBe(false);
        expect(err.retryAfterMs).toBeUndefined();
        expect(err.message).toBe("Custom X: Invalid API key (401). Check the API key with /login.");
        expect(err.body).toContain("Invalid API key");
    });

    test("429 is retryable and parses retry-after seconds", async () => {
        respond = () => Response.json({ error: { message: "slow down" } }, { status: 429, headers: { "retry-after": "3" } });
        const err = await run();
        expect(err.status).toBe(429);
        expect(err.retryable).toBe(true);
        expect(err.retryAfterMs).toBe(3000);
    });

    test("503 with an HTTP-date retry-after", async () => {
        const when = new Date(Date.now() + 6000).toUTCString();
        respond = () => new Response("upstream unavailable", { status: 503, headers: { "retry-after": when } });
        const err = await run();
        expect(err.status).toBe(503);
        expect(err.retryable).toBe(true);
        expect(err.retryAfterMs).toBeGreaterThan(3000);
        expect(err.retryAfterMs).toBeLessThanOrEqual(6000);
        expect(err.message).toContain("upstream unavailable");
    });

    test("500 without retry-after is retryable with no delay hint", async () => {
        respond = () => new Response("", { status: 500 });
        const err = await run();
        expect(err.retryable).toBe(true);
        expect(err.retryAfterMs).toBeUndefined();
    });

    test("400 and 402 are not retryable", async () => {
        respond = () => Response.json({ error: { message: "bad field" } }, { status: 400 });
        expect((await run()).retryable).toBe(false);
        respond = () => Response.json({ error: { message: "no money" } }, { status: 402 });
        const e = await run();
        expect(e.retryable).toBe(false);
        expect(e.message).toContain("out of credits");
    });

    test("Responses provider uses the same mapping", async () => {
        respond = () => Response.json({ error: { message: "Rate limited" } }, { status: 429, headers: { "retry-after": "1" } });
        const err = await new OpenAIResponsesProvider(builtin("openai"), FAKE.openai).stream(req({ provider: "openai", id: "gpt-6-sol" }, []), () => {}).catch((e) => e);
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.status).toBe(429);
        expect(err.retryable).toBe(true);
        expect(err.retryAfterMs).toBe(1000);
        expect(err.message).toBe("OpenAI: Rate limited (429)");
    });

    test("connection refused is a retryable ProviderError", async () => {
        const tmp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
        const port = tmp.port;
        tmp.stop(true);
        const p = new OpenAICompatProvider({ ...CUSTOM, baseUrl: `http://127.0.0.1:${port}/v1` }, FAKE.openai);
        const err = await p.stream(req(model, []), () => {}).catch((e) => e);
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.retryable).toBe(true);
        expect(err.status).toBeUndefined();
        expect(err.message).toMatch(/^Connection error to Custom X/);
    });

    test("httpError parses nested and top-level messages", () => {
        expect(httpError(404, "Not Found", JSON.stringify({ message: "no such model" }), null, "P").message).toBe("P: no such model (404)");
        expect(httpError(422, "Unprocessable", JSON.stringify({ detail: [{ msg: "x" }] }), null, "P").message).toBe('P: [{"msg":"x"}] (422)');
        expect(httpError(400, "Bad Request", JSON.stringify([{ error: { message: "gemini style" } }]), null, "P").message).toBe("P: gemini style (400)");
        expect(httpError(403, "Forbidden", "", null, "P").message).toBe("P API error 403 Forbidden. Check the API key with /login.");
        expect(httpError(529, "Overloaded", "", "0", "P").retryAfterMs).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------

describe("Anthropic message conversion", () => {
    test("consecutive user messages are merged so roles alternate", () => {
        const out = toAnthropicMessages([
            { role: "user", content: [{ type: "text", text: "one" }] },
            { role: "user", content: [{ type: "text", text: "two" }], meta: { kind: "interrupt" } },
            { role: "assistant", provider: "anthropic", model: "c", content: [{ type: "text", text: "reply" }] },
            { role: "user", content: [{ type: "text", text: "" }] }, // empty: skipped
            { role: "user", content: [{ type: "text", text: "three" }] },
        ]);
        expect(out).toEqual([
            {
                role: "user",
                content: [
                    { type: "text", text: "one" },
                    { type: "text", text: "two" },
                ],
            },
            { role: "assistant", content: [{ type: "text", text: "reply" }] },
            { role: "user", content: [{ type: "text", text: "three" }] },
        ]);
    });

    test("tool results become tool_result blocks; images become base64 image blocks", () => {
        const out = toAnthropicMessages(HISTORY);
        expect(out[0]).toEqual({
            role: "user",
            content: [
                { type: "text", text: "Look at this" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
            ],
        });
        // raw.anthropic is replayed verbatim
        expect(out[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "Reading it." }] });
        // tool results and the following plain user turn are merged into one user message
        expect(out[2]).toEqual({
            role: "user",
            content: [
                {
                    type: "tool_result",
                    tool_use_id: "toolu_01",
                    content: [
                        { type: "text", text: "file body" },
                        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
                    ],
                },
                { type: "tool_result", tool_use_id: "toolu_02", content: "not found", is_error: true },
                { type: "text", text: "Thanks" },
            ],
        });
        expect(out).toHaveLength(3);
    });

    test("assistant turns without raw blocks: text + tool_use, foreign thinking dropped, ids sanitized", () => {
        const out = toAnthropicMessages([
            {
                role: "assistant",
                provider: "openai",
                model: "gpt",
                content: [
                    { type: "thinking", text: "not replayable" },
                    { type: "text", text: "Let me check." },
                    { type: "tool_call", id: "call:1/x", name: "bash", input: { command: "ls" } },
                ],
            },
            { role: "user", content: [{ type: "tool_result", toolCallId: "call:1/x", toolName: "bash", content: "" }] },
        ]);
        expect(out).toEqual([
            {
                role: "assistant",
                content: [
                    { type: "text", text: "Let me check." },
                    { type: "tool_use", id: "call_1_x", name: "bash", input: { command: "ls" } },
                ],
            },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1_x", content: "(no output)" }] },
        ]);
    });

    test("stripThinking removes thinking blocks from raw replay", () => {
        const raw = [
            { type: "thinking", thinking: "t", signature: "s" },
            { type: "redacted_thinking", data: "d" },
            { type: "text", text: "answer" },
        ];
        const msg: AssistantMessage = { role: "assistant", provider: "anthropic", model: "c", content: [{ type: "text", text: "answer" }], raw: { anthropic: raw } };
        expect(toAnthropicMessages([msg])[0]!.content as unknown).toEqual(raw);
        expect(toAnthropicMessages([msg], true)[0]!.content).toEqual([{ type: "text", text: "answer" }]);
        // The stored transcript is not modified.
        expect(msg.raw!.anthropic).toHaveLength(3);
    });

    test("conversion is deterministic and does not mutate the input", () => {
        const before = JSON.stringify(HISTORY);
        const a = JSON.stringify(toAnthropicMessages(HISTORY));
        const b = JSON.stringify(toAnthropicMessages(HISTORY));
        expect(a).toBe(b);
        expect(JSON.stringify(HISTORY)).toBe(before);
    });

    test("sanitizeToolId", () => {
        expect(sanitizeToolId("toolu_01ABC-x")).toBe("toolu_01ABC-x");
        expect(sanitizeToolId("a.b:c")).toBe("a_b_c");
        expect(sanitizeToolId("")).toBe("tool");
        expect(sanitizeToolId("x".repeat(100))).toHaveLength(64);
    });
});

describe("Anthropic streaming", () => {
    test("thinking that isn't streamed still says it started", async () => {
        const { AnthropicProvider } = await import("../src/providers/anthropic");
        const ev = (type: string, data: Json) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
        respond = () =>
            new Response(
                [
                    ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
                    // display "omitted": the block opens, gets only its signature, and closes.
                    ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
                    ev("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig" } }),
                    ev("content_block_stop", { index: 0 }),
                    ev("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
                    ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Done." } }),
                    ev("content_block_stop", { index: 1 }),
                    ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 500 } }),
                    ev("message_stop", {}),
                ].join(""),
                { headers: { "content-type": "text/event-stream" } },
            );
        const m: ModelInfo = { provider: "anthropic", id: "claude-haiku-5-5", maxOutput: 64_000, supportsReasoning: true, adaptiveThinking: true };
        const { events, on } = collect();
        const msg = await new AnthropicProvider(builtin("anthropic", { baseUrl: `http://127.0.0.1:${server.port}` }), FAKE.anthropic).stream(req(m, [{ role: "user", content: [{ type: "text", text: "q" }] }]), on);
        expect(seen[0]!.body.thinking).toMatchObject({ type: "adaptive", display: "omitted" });
        expect(events.filter((e) => e.type === "thinking" || e.type === "text")).toEqual([
            { type: "thinking", text: "" },
            { type: "text", text: "Done." },
        ]);
        expect(msg.content).toEqual([
            { type: "thinking", text: "", signature: "sig" },
            { type: "text", text: "Done." },
        ]);
    });
});

describe("quick requests (the auto-mode reviewer's first step)", () => {
    const ev = (type: string, data: Json) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const answer = (model: string) => () =>
        new Response(
            [
                ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
                ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
                ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ALLOW" } }),
                ev("content_block_stop", { index: 0 }),
                ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
                ev("message_stop", {}),
            ].join(""),
            { headers: { "content-type": "text/event-stream" } },
        );
    const ask = async (id: string, extra: Partial<ChatRequest>) => {
        const { AnthropicProvider } = await import("../src/providers/anthropic");
        respond = answer(id);
        const m: ModelInfo = { provider: "anthropic", id, maxOutput: 64_000, supportsReasoning: true, adaptiveThinking: true };
        await new AnthropicProvider(builtin("anthropic", { baseUrl: `http://127.0.0.1:${server.port}` }), FAKE.anthropic).stream(req(m, [{ role: "user", content: [{ type: "text", text: "q" }] }], { tools: [], lightweight: true, ...extra }), () => {});
        return seen.at(-1)!.body;
    };

    test("Sonnet 5.5 turns extended thinking off with between_tools (it refuses disabled), with nothing else inside, and effort no higher than high", async () => {
        const body = await ask("claude-sonnet-5-5", { noThinking: true, effort: "xhigh" });
        expect(body.thinking).toEqual({ type: "between_tools" });
        expect(body.output_config).toEqual({ effort: "high" });
        const low = await ask("claude-sonnet-5-5", { noThinking: true, effort: "low" });
        expect(low.output_config).toEqual({ effort: "low" });
    });

    test("a model with no way to turn thinking off keeps adaptive thinking", async () => {
        const body = await ask("claude-haiku-5-5", { noThinking: true, effort: "low" });
        expect(body.thinking).toMatchObject({ type: "adaptive" });
    });

    test("cacheSystem caches the instructions even on a lightweight request; otherwise lightweight caches nothing", async () => {
        const cached = await ask("claude-sonnet-5-5", { cacheSystem: true });
        expect(cached.system).toEqual([{ type: "text", text: "You are a test.", cache_control: { type: "ephemeral" } }]);
        expect(cached.cache_control).toBeUndefined();
        const plain = await ask("claude-sonnet-5-5", {});
        expect(plain.system).toEqual([{ type: "text", text: "You are a test." }]);
        expect(plain.cache_control).toBeUndefined();
    });
});

describe("stop reasons and cut-off streams", () => {
    const rdef = builtin("openai");
    const rmodel: ModelInfo = { provider: "openai", id: "gpt-6-sol", maxOutput: 128_000 };
    const hi: Message = { role: "user", content: [{ type: "text", text: "hi" }] };
    const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}', status: "completed" };
    const responses = () => new OpenAIResponsesProvider(rdef, FAKE.openai).stream(req(rmodel, [hi]), () => {});

    test("Responses: a cut-off response is max_tokens even when it holds a complete function call", async () => {
        respond = () => sse([{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [call] } }]);
        expect((await responses()).stopReason).toBe("max_tokens");
    });

    test("Responses: incomplete for any other reason never yields tool_use", async () => {
        respond = () => sse([{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "something_new" }, output: [call] } }]);
        expect((await responses()).stopReason).toBe("max_tokens");
        respond = () => sse([{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "something_new" }, output: [] } }]);
        expect((await responses()).stopReason).toBe("other");
    });

    test("Responses: a refusal outranks a function call", async () => {
        respond = () => sse([{ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "No." }] }, call] } }]);
        expect((await responses()).stopReason).toBe("refusal");
        respond = () => sse([{ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [call] } }]);
        expect((await responses()).stopReason).toBe("refusal");
    });

    test("Responses: a completed function call is still tool_use", async () => {
        respond = () => sse([{ type: "response.completed", response: { status: "completed", output: [call] } }]);
        expect((await responses()).stopReason).toBe("tool_use");
    });

    const cmodel: ModelInfo = { provider: "custom-x", id: "m1" };

    test("Chat Completions: a body that ends with neither [DONE] nor finish_reason is a retryable error", async () => {
        respond = () => sse([{ choices: [{ index: 0, delta: { content: "half an ans" } }] }]);
        const err = await new OpenAICompatProvider(CUSTOM, "k-123456789").stream(req(cmodel, [hi]), () => {}).catch((e) => e);
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.retryable).toBe(true);
        expect(err.message).toContain("stream ended before the response completed");
    });

    test("Chat Completions: [DONE] alone (no finish_reason) still completes", async () => {
        respond = () => sse([{ choices: [{ index: 0, delta: { content: "ok" } }] }, "data: [DONE]\n\n"]);
        const msg = await new OpenAICompatProvider(CUSTOM, "k-123456789").stream(req(cmodel, [hi]), () => {});
        expect(msg.content).toEqual([{ type: "text", text: "ok" }]);
    });

    test("Chat Completions: an explicit maxTokens is sent even when the model's limit is unknown", async () => {
        respond = () => sse([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }]);
        await new OpenAICompatProvider(CUSTOM, "k-123456789").stream(req(cmodel, [hi], { maxTokens: 2048 }), () => {});
        expect(seen[0]!.body.max_completion_tokens).toBe(2048);
        seen.length = 0;
        await new OpenAICompatProvider(CUSTOM, "k-123456789").stream(req(cmodel, [hi]), () => {});
        expect(seen[0]!.body.max_completion_tokens).toBeUndefined();
    });
});

describe("the auto-mode reviewer's model", () => {
    test("one you chose that can't be used is an error (so you decide), not a quiet switch to the session's model", async () => {
        const { reviewTarget } = await import("../src/providers/models");
        // Nothing chosen and no Anthropic key: the session's own model reviews.
        expect(await reviewTarget(undefined)).toBeUndefined();
        await expect(reviewTarget("openrouter:some/model")).rejects.toThrow(/^the reviewer you chose \(openrouter:some\/model\) can't be used: /);
        await expect(reviewTarget("not a model")).rejects.toThrow(/can't be used/);
        await expect(reviewTarget("claude-code:claude-opus-5-5")).rejects.toThrow(/can't be used/);
    });
});
