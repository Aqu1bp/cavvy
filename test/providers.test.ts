import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { isolate, FAKE } from "./helpers/isolate";

const iso = isolate();
const { OpenAICompatProvider, toOpenAIMessages, httpError } = await import("../src/providers/openai-compat");
const { OpenAIResponsesProvider, toResponsesInput } = await import("../src/providers/openai-responses");
const { AnthropicProvider, toAnthropicMessages, sanitizeToolId } = await import("../src/providers/anthropic");
const { BUILTIN_PROVIDERS, customProviders, writeProvidersFile } = await import("../src/providers/registry");
const { ProviderError } = await import("../src/providers/types");
const { stall } = await import("../src/providers/sse");
const { costOf, promptTokens, usageCostParts } = await import("../src/providers/pricing");
import type { ProviderDef } from "../src/providers/registry";
import type { AssistantMessage, ChatRequest, Message, ModelInfo, StreamEvent } from "../src/providers/types";
import { SESSION_CONTEXT_HEADING } from "../src/providers/types";

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
            // The message after them joins the tool calls' images: roles alternate, as strict chat templates want.
            { role: "user", content: [{ type: "text", text: "Images returned by the tool calls above:" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }, { type: "text", text: "Thanks" }] },
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

    test.each(["anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-4.6:thinking", "~anthropic/claude-sonnet-latest"])("openrouter: Claude caching preserves the prefix across turns (%s)", async (id) => {
        respond = () => sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
        const def = builtin("openrouter");
        const m: ModelInfo = { provider: def.id, id };
        const p = new OpenAICompatProvider(def, FAKE.openrouter);
        const request = req(m, HISTORY, { cacheSystem: true });
        const original = JSON.stringify(request);
        const first = await p.stream(request, () => {});
        await p.stream({ ...request, messages: [...HISTORY, first, { role: "user", content: [{ type: "text", text: "Continue" }] }] }, () => {});
        const a = seen[0]!.body;
        const b = seen[1]!.body;
        expect(a.cache_control).toEqual({ type: "ephemeral" });
        expect(b.cache_control).toEqual(a.cache_control);
        expect(a.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }] });
        expect(JSON.stringify(b.messages.slice(0, a.messages.length))).toBe(JSON.stringify(a.messages));
        expect(JSON.stringify(b.tools)).toBe(JSON.stringify(a.tools));
        expect(a.tools).toEqual(request.tools.map((t) => ({ type: "function", function: t })));
        expect(a.messages.slice(1)).toEqual(toOpenAIMessages("", HISTORY, def));
        expect(b.messages.slice(a.messages.length)).toEqual([first.raw!.openai, { role: "user", content: "Continue" }]);
        // One system breakpoint plus the automatic breakpoint, with no TTL override.
        expect(JSON.stringify(b).match(/"cache_control"/g)).toHaveLength(2);
        expect(JSON.stringify(request)).toBe(original);
    });

    test.each([
        { lightweight: false, cacheSystem: false },
        { lightweight: false, cacheSystem: true },
        { lightweight: true, cacheSystem: false },
        { lightweight: true, cacheSystem: true },
    ])("openrouter: Claude honors lightweight and cacheSystem (%j)", async (flags) => {
        respond = () => sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
        const m: ModelInfo = { provider: "openrouter", id: "anthropic/claude-sonnet-4.6" };
        const p = new OpenAICompatProvider(builtin("openrouter"), FAKE.openrouter);
        await p.stream(req(m, HISTORY, flags), () => {});
        const b = seen[0]!.body;
        expect(b.cache_control).toEqual(flags.lightweight ? undefined : { type: "ephemeral" });
        expect(b.messages[0].content).toEqual(flags.cacheSystem ? [{ type: "text", text: "You are a test.", cache_control: { type: "ephemeral" } }] : "You are a test.");
        await p.stream(req(m, HISTORY, { ...flags, system: "", tools: [] }), () => {});
        expect(seen[1]!.body.messages).toEqual(toOpenAIMessages("", HISTORY, builtin("openrouter")));
        expect(seen[1]!.body.tools).toBeUndefined();
    });

    test("openrouter: the Claude system breakpoint stops before the session context, so sessions share the prefix", async () => {
        respond = () => sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
        const m: ModelInfo = { provider: "openrouter", id: "anthropic/claude-sonnet-4.6" };
        const system = (date: string) => `You are a test.\n\n${SESSION_CONTEXT_HEADING}\nToday's date: ${date}`;
        const p = new OpenAICompatProvider(builtin("openrouter"), FAKE.openrouter);
        for (const date of ["2026-10-21", "2026-10-22"]) await p.stream(req(m, HISTORY, { cacheSystem: true, system: system(date) }), () => {});
        const [a, b] = [seen[0]!.body.messages[0].content, seen[1]!.body.messages[0].content];
        expect(a[0]).toEqual({ type: "text", text: "You are a test.", cache_control: { type: "ephemeral" } });
        expect(b[0]).toEqual(a[0]);
        expect(a[1].text).toContain("2026-10-21");
        expect(b[1].text).toContain("2026-10-22");
        expect(a[1].cache_control).toBeUndefined();
    });

    test.each([
        ["openrouter", "openai/gpt-5"],
        ["openrouter", "google/gemini-2.5-pro"],
        ["openrouter", "google/gemini-3-pro-preview"],
        ["openrouter", "google/gemini-2.0-flash-001"],
        ["openrouter", "vendor/claude-sonnet-4.6"],
        ["openrouter", "openrouter/auto"],
        ["groq", "anthropic/claude-sonnet-4.6"],
        ["custom-x", "anthropic/claude-sonnet-4.6"],
    ])("cache_control is absent for %s / %s", async (provider, id) => {
        respond = () => sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
        const def = provider === "custom-x" ? CUSTOM : builtin(provider);
        await new OpenAICompatProvider(def, FAKE.openrouter).stream(req({ provider, id }, HISTORY, { cacheSystem: true }), () => {});
        expect(JSON.stringify(seen[0]!.body)).not.toContain('"cache_control"');
        expect(seen[0]!.body.messages).toEqual(toOpenAIMessages("You are a test.", HISTORY, def));
    });

    test.each([
        { details: { cached_tokens: 6000, cache_write_tokens: 2000 }, reportedCost: 0.0123 },
        { details: { cached_tokens: 6000, cache_write_tokens: 2000 }, reportedCost: undefined },
        { details: { cached_tokens: 6000 }, reportedCost: undefined },
        { details: { cache_write_tokens: 2000 }, reportedCost: undefined },
        { details: undefined, reportedCost: 0 },
    ])("openrouter: cache usage and cost are accounted for without assuming a one-hour TTL (%j)", async ({ details, reportedCost }) => {
        respond = () => sse([
            { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 10000, completion_tokens: 100, prompt_tokens_details: details, cost: reportedCost } },
        ]);
        const m: ModelInfo = { provider: "openrouter", id: "anthropic/claude-sonnet-4.6", pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
        const msg = await new OpenAICompatProvider(builtin("openrouter"), FAKE.openrouter).stream(req(m, HISTORY), () => {});
        const reads = details?.cached_tokens ?? 0;
        const writes = details?.cache_write_tokens ?? 0;
        expect(msg.usage).toEqual({ inputTokens: 10000 - reads - writes, outputTokens: 100, cacheReadTokens: reads, cacheWriteTokens: writes, reasoningTokens: undefined, cost: reportedCost });
        expect(msg.usage!.cacheWrite1hTokens).toBeUndefined();
        expect(promptTokens(msg.usage!)).toBe(10000);
        expect(usageCostParts(msg.usage!, m)).toMatchObject({ cacheRead: reads * 0.3 / 1e6, cacheWrite: writes * 3.75 / 1e6 });
        const cost = costOf(msg.usage!, m);
        expect(cost.estimated).toBe(reportedCost === undefined);
        expect(cost.unknown).toBe(false);
        expect(cost.usd).toBeCloseTo(reportedCost ?? ((10000 - reads - writes) * 3 + 100 * 15 + reads * 0.3 + writes * 3.75) / 1e6, 10);
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

        const { validateInput } = await import("../src/tools");
        const { ReadTool } = await import("../src/tools/file-tools");
        const call = msg.content[0]!;
        if (call.type !== "tool_call") throw new Error("expected a tool call");
        const error = validateInput(ReadTool, call.input)!;
        expect(error).toContain("The tool arguments were not valid JSON");
        respond = () => sse([{ choices: [{ index: 0, delta: { content: "retry" }, finish_reason: "stop" }] }]);
        await new OpenAICompatProvider(CUSTOM, FAKE.openai).stream(req(model, [msg, {
            role: "user", content: [{ type: "tool_result", toolCallId: call.id, toolName: call.name, content: error, isError: true }],
        }]), () => {});
        const replay = seen[1]!.body.messages;
        expect(replay[1].tool_calls[0].function.arguments).toBe("{}");
        expect(replay[2]).toEqual({ role: "tool", tool_call_id: "c9", content: `Error: ${error}` });
        expect((msg.raw!.openai!.tool_calls as Json[])[0]!.function.arguments).toBe('{"path": ');
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
    test("context-window exhaustion preserves partial output and usage with a distinct stop reason", async () => {
        const { AnthropicProvider } = await import("../src/providers/anthropic");
        const ev = (type: string, data: Json) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
        respond = () => new Response([
            ev("message_start", { message: { id: "msg_context", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } }),
            ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
            ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "partial answer" } }),
            ev("content_block_stop", { index: 0 }),
            ev("message_delta", { delta: { stop_reason: "model_context_window_exceeded", stop_sequence: null }, usage: { output_tokens: 12 } }),
            ev("message_stop", {}),
        ].join(""), { headers: { "content-type": "text/event-stream" } });
        const m: ModelInfo = { provider: "anthropic", id: "claude-haiku-5-5" };
        const msg = await new AnthropicProvider(builtin("anthropic", { baseUrl: `http://127.0.0.1:${server.port}` }), FAKE.anthropic).stream(req(m, [{ role: "user", content: [{ type: "text", text: "q" }] }]), () => {});
        expect(msg.stopReason).toBe("context_window_exceeded");
        expect(msg.content).toEqual([{ type: "text", text: "partial answer" }]);
        expect(msg.usage).toMatchObject({ inputTokens: 100, outputTokens: 12 });
    });

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

describe("Anthropic budget thinking", () => {
    const models = ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5", "claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-opus-4-1-20250805"];
    const budgets = { low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 24576 } as const;
    const levels = Object.keys(budgets) as (keyof typeof budgets)[];
    const provider = () => new AnthropicProvider(builtin("anthropic", { baseUrl: `http://127.0.0.1:${server.port}` }), FAKE.anthropic);
    const prompt: Message = { role: "user", content: [{ type: "text", text: "q" }] };
    const ask = async (model: ModelInfo, extra: Partial<ChatRequest> = {}) => {
        const ev = (type: string, data: Json) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
        respond = () => new Response([
            ev("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: model.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
            ev("content_block_start", { index: 0, content_block: { type: "text", text: "OK" } }),
            ev("content_block_stop", { index: 0 }),
            ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
            ev("message_stop", {}),
        ].join(""), { headers: { "content-type": "text/event-stream" } });
        await provider().stream(req(model, [prompt], extra), () => {});
        return seen.at(-1)!;
    };

    for (const id of models) {
        test(`${id}: each effort enables a budget and only supported wire parameters`, async () => {
            const model = provider().staticInfo(id);
            expect(model.supportsReasoning).toBe(true);
            expect(model.effortLevels).toEqual(levels);
            for (const effort of levels) {
                const { body, headers } = await ask(model, { effort });
                expect(body.thinking).toEqual({ type: "enabled", budget_tokens: budgets[effort] });
                expect(body.thinking.budget_tokens).toBeLessThan(body.max_tokens);
                expect(body.temperature).toBeUndefined();
                expect(body.top_k).toBeUndefined();
                // Omitted tool_choice defaults to auto; forced tool use is incompatible.
                expect(body.tool_choice).toBeUndefined();
                expect(body.output_config).toEqual(id === "claude-opus-4-5" ? { effort: effort === "xhigh" || effort === "max" ? "high" : effort } : undefined);
                expect(headers["anthropic-beta"]?.includes("interleaved-thinking-2025-05-14") ?? false).toBe(!id.includes("haiku"));
            }
        });

        test(`${id}: unset/off keeps thinking disabled`, async () => {
            const model = provider().staticInfo(id);
            for (const extra of [{}, { effort: "high" as const, noThinking: true }]) {
                const { body, headers } = await ask(model, extra);
                expect(body.thinking).toBeUndefined();
                expect(headers["anthropic-beta"] ?? "").not.toContain("interleaved-thinking");
            }
        });
    }

    test("cached requests replay signed thinking blocks byte-identically across tool turns", async () => {
        for (const id of ["claude-sonnet-4-5", "claude-opus-5-5"]) {
            const model = provider().staticInfo(id);
            const raw = [
                { type: "thinking", thinking: "  Keep spacing\n\tand unicode: λ  ", signature: "signed+/opaque==" },
                { type: "redacted_thinking", data: "redacted+/opaque==" },
                { type: "tool_use", id: "toolu_read", name: "read_file", input: { path: "a.txt" } },
            ];
            const serialized = JSON.stringify(raw);
            const turn: AssistantMessage = { role: "assistant", provider: "anthropic", model: id, content: [{ type: "text", text: "neutral content must not replace raw blocks" }], raw: { anthropic: raw } };
            const messages: Message[] = [prompt, turn, { role: "user", content: [{ type: "tool_result", toolCallId: "toolu_read", toolName: "read_file", content: "file body" }] }];
            const options: Partial<ChatRequest> = { effort: "high", cacheSystem: true, system: "Shared instructions\n\n" + SESSION_CONTEXT_HEADING + "\nSession-specific context" };
            const first = (await ask(model, { ...options, messages })).body;
            const next = (await ask(model, { ...options, messages: [...messages, prompt] })).body;
            for (const body of [first, next]) {
                expect(JSON.stringify(body.messages[1].content)).toBe(serialized);
                expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
                expect(body.system[1].cache_control).toBeUndefined();
                expect(body.cache_control).toEqual({ type: "ephemeral" });
            }
            expect(next.system).toEqual(first.system);
            expect(next.tools).toEqual(first.tools);
            expect(JSON.stringify(turn.raw!.anthropic)).toBe(serialized);
        }
    });

    test("lightweight helpers preserve their full output cap without budget thinking", async () => {
        for (const id of models) {
            for (const maxTokens of [100, 500, 1024, 1100, 2048]) {
                const { body, headers } = await ask(provider().staticInfo(id), { effort: "low", lightweight: true, maxTokens, tools: [] });
                expect(body.max_tokens).toBe(maxTokens);
                expect(body.thinking).toBeUndefined();
                expect(headers["anthropic-beta"] ?? "").not.toContain("interleaved-thinking");
            }
        }
    });

    test("budget respects request and model output caps, including the minimum boundary", async () => {
        const model = provider().staticInfo("claude-opus-4-5");
        for (const [cap, budget] of [[4096, 3072], [4000, 2976], [1025, 1024]] as const) {
            expect((await ask(model, { effort: "max", maxTokens: cap })).body.thinking.budget_tokens).toBe(budget);
            expect((await ask({ ...model, maxOutput: cap }, { effort: "max" })).body.thinking.budget_tokens).toBe(budget);
        }
        for (const maxTokens of [1024, 100]) {
            const before = seen.length;
            await expect(ask(model, { effort: "low", maxTokens })).rejects.toThrow("requires max_tokens of at least 1025");
            expect(seen.length).toBe(before);
        }
    });

    test("interleaving is only requested with tools, including server web search", async () => {
        const model = provider().staticInfo("claude-sonnet-4-5");
        expect((await ask(model, { effort: "high", tools: [] })).headers["anthropic-beta"] ?? "").not.toContain("interleaved-thinking");
        expect((await ask(model, { effort: "high", tools: [], webSearch: true })).headers["anthropic-beta"]).toContain("interleaved-thinking-2025-05-14");
    });

    test("explicit capabilities override static budget support; unknown models stay conservative", async () => {
        expect((await ask({ ...provider().staticInfo("claude-haiku-4-5"), budgetThinking: false }, { effort: "high" })).body.thinking).toBeUndefined();
        expect((await ask(provider().staticInfo("unknown"), { effort: "high" })).body.thinking).toBeUndefined();
        for (const id of ["custom", "claude-3-5-haiku-20241022", "claude-haiku-5-5"]) {
            // Old metadata guessed enabled support for every then-unknown model.
            const { body } = await ask({ provider: "anthropic", id, adaptiveThinking: false, budgetThinking: true, effortLevels: levels, nativeEffortLevels: [] }, { effort: "high" });
            expect(body.thinking).toBeUndefined();
            expect(body.output_config).toBeUndefined();
        }
    });

    test("unknown discovered models do not advertise manual thinking controls", async () => {
        respond = () => Response.json({ data: [{
            id: "custom", display_name: "Custom", type: "model", created_at: "2025-01-01T00:00:00Z",
            capabilities: {
                image_input: { supported: true },
                thinking: { supported: true, types: { adaptive: { supported: false }, enabled: { supported: true } } },
                effort: { supported: false },
            },
        }], has_more: false });
        const [model] = await provider().listModels();
        expect(model!.budgetThinking).toBe(false);
        expect(model!.supportsReasoning).toBe(false);
        expect(model!.effortLevels).toEqual([]);
        expect((await ask(model!, { effort: "high" })).body.thinking).toBeUndefined();
    });

    test("discovered native effort support stays separate from the budget controls", async () => {
        respond = () => Response.json({ data: [{
            id: "claude-opus-4-5", display_name: "Opus", type: "model", created_at: "2025-01-01T00:00:00Z",
            capabilities: {
                image_input: { supported: true },
                thinking: { supported: true, types: { adaptive: { supported: false }, enabled: { supported: true } } },
                effort: { supported: false },
            },
        }], has_more: false });
        const [model] = await provider().listModels();
        expect(model!.effortLevels).toEqual(levels);
        const { body } = await ask(model!, { effort: "max" });
        expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 24576 });
        expect(body.output_config).toBeUndefined();
    });

    test("adaptive models retain adaptive thinking and native effort", async () => {
        for (const id of ["claude-sonnet-4-6", "claude-opus-4-6", "claude-opus-4-8", "claude-haiku-5-5", "claude-sonnet-5-5"]) {
            const model = provider().staticInfo(id);
            for (const effort of model.effortLevels!) {
                const { body, headers } = await ask(model, { effort, lightweight: true, showThinking: true });
                expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
                expect(body.output_config).toEqual({ effort });
                expect(headers["anthropic-beta"] ?? "").not.toContain("interleaved-thinking");
            }
        }
    });

    test("existing cached budget models gain controls without losing native effort or other providers", async () => {
        const { resolveModelInfo } = await import("../src/providers/models");
        const { paths } = await import("../src/config/paths");
        const { mkdirSync, rmSync } = await import("fs");
        const { dirname } = await import("path");
        const path = paths.modelCache();
        mkdirSync(dirname(path), { recursive: true });
        const oldModels: ModelInfo[] = models.map((id) => ({
            provider: "anthropic", id, supportsReasoning: false, adaptiveThinking: false, budgetThinking: true,
            effortLevels: id === "claude-opus-4-5" ? ["low", "medium", "high"] : [],
            pricing: { input: 999, output: 999 },
        }));
        const unsupported: ModelInfo[] = ["custom", "claude-3-5-haiku-20241022", "claude-haiku-5-5"].map((id) => ({
            provider: "anthropic", id, supportsReasoning: false, adaptiveThinking: false, budgetThinking: true, effortLevels: [],
        }));
        // PR #279 may already have rewritten a guessed flag into mapped controls.
        unsupported.push({ provider: "anthropic", id: "custom-promoted", supportsReasoning: true, adaptiveThinking: false, budgetThinking: true, effortLevels: levels, nativeEffortLevels: [] });
        unsupported.push({ provider: "anthropic", id: "claude-opus-4-5-20251101", supportsReasoning: false, adaptiveThinking: false, budgetThinking: false, effortLevels: [] });
        const nativeOnly: ModelInfo = { provider: "anthropic", id: "custom-native-effort", adaptiveThinking: false, budgetThinking: true, effortLevels: ["low", "high"] };
        const unrelated = { provider: "openai", id: "cached-fixture", supportsReasoning: true, effortLevels: ["low"] };
        await Bun.write(path, JSON.stringify({ version: 3, providers: {
            anthropic: { fetchedAt: Date.now(), fp: "fixture", models: [...oldModels, ...unsupported, nativeOnly] },
            openai: { fetchedAt: Date.now(), fp: "fixture", models: [unrelated] },
        } }));
        try {
            for (const old of oldModels) {
                const model = resolveModelInfo(`anthropic:${old.id}`)!;
                expect(model.supportsReasoning).toBe(true);
                expect(model.effortLevels).toEqual(levels);
                expect(model.nativeEffortLevels).toEqual(old.effortLevels);
                expect(model.pricing).toEqual(provider().staticInfo(old.id).pricing);
                const { body } = await ask(model, { effort: "max" });
                expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 24576 });
                expect(body.output_config).toEqual(old.id === "claude-opus-4-5" ? { effort: "high" } : undefined);
            }
            for (const old of unsupported) {
                const model = resolveModelInfo(`anthropic:${old.id}`)!;
                expect(model.budgetThinking).toBe(false);
                expect(model.supportsReasoning).toBe(false);
                expect(model.effortLevels).toEqual([]);
                const { body } = await ask(model, { effort: "max" });
                expect(body.thinking).toBeUndefined();
                expect(body.output_config).toBeUndefined();
            }
            const native = resolveModelInfo("anthropic:custom-native-effort")!;
            expect(native.effortLevels).toEqual(["low", "high"]);
            const { body } = await ask(native, { effort: "high" });
            expect(body.thinking).toBeUndefined();
            expect(body.output_config).toEqual({ effort: "high" });
            expect(resolveModelInfo("openai:cached-fixture")).toEqual(unrelated);
        } finally {
            rmSync(path, { force: true });
        }
    });

    test("discovery and static resolution expose the mapped effort levels to GUI/TUI", async () => {
        const { resolveModelInfo } = await import("../src/providers/models");
        for (const withCaps of [false, true]) {
            respond = () => Response.json({ data: models.map((id) => ({
                id, display_name: id, type: "model", created_at: "2025-01-01T00:00:00Z",
                ...(withCaps ? { capabilities: {
                    image_input: { supported: true },
                    thinking: { supported: true, types: { adaptive: { supported: false }, enabled: { supported: true } } },
                    effort: { supported: id === "claude-opus-4-5", low: { supported: true }, medium: { supported: true }, high: { supported: true } },
                } } : {}),
            })), has_more: false });
            const listed = await provider().listModels();
            expect(listed).toHaveLength(models.length);
            for (const model of listed) {
                expect(model.supportsReasoning).toBe(true);
                expect(model.budgetThinking).toBe(true);
                expect(model.effortLevels).toEqual(levels);
                const resolved = resolveModelInfo(`anthropic:${model.id}`)!;
                expect(resolved.supportsReasoning).toBe(true);
                expect(resolved.effortLevels).toEqual(levels);
                expect((await ask(model, { effort: "max" })).body.thinking).toEqual({ type: "enabled", budget_tokens: 24576 });
            }
        }
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

    test("an agent request caches the system prompt up to its session context, and the conversation after it", async () => {
        const system = "You are a test.\n\n# Notes\nShared.\n\n# Session context\nToday's date: 2026-10-22\n\nAppended.";
        const agent = await ask("claude-sonnet-5-5", { system, cacheSystem: true, lightweight: false });
        expect(agent.system).toEqual([
            { type: "text", text: "You are a test.\n\n# Notes\nShared.", cache_control: { type: "ephemeral" } },
            { type: "text", text: "# Session context\nToday's date: 2026-10-22\n\nAppended." },
        ]);
        expect(agent.cache_control).toEqual({ type: "ephemeral" });
        // A prompt frozen before it had the section: cached whole.
        const older = await ask("claude-sonnet-5-5", { system: "You are a test.\n\n# Environment\nToday's date: 2026-10-22", cacheSystem: true, lightweight: false });
        expect(older.system).toEqual([{ type: "text", text: "You are a test.\n\n# Environment\nToday's date: 2026-10-22", cache_control: { type: "ephemeral" } }]);
        // Not cached on its own: sent as it is.
        const uncached = await ask("claude-sonnet-5-5", { system, lightweight: false });
        expect(uncached.system).toEqual([{ type: "text", text: system }]);
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
