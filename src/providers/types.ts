// Provider-neutral conversation model.
//
// The transcript is stored in this shape and converted to each wire format on
// every request. Conversion must be deterministic (same input -> same bytes):
// Anthropic binds thinking blocks to the exact conversation prefix, and every
// provider's prompt cache is a prefix match.

import type { Effort } from "../config/settings";

export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image"; mediaType: string; data: string /* base64 */ };

export type ThinkingPart = {
    type: "thinking";
    text: string;
    /** Opaque provider data needed to replay this block (Anthropic signature, redacted data). */
    signature?: string;
    redactedData?: string;
};

export type ToolCallPart = {
    type: "tool_call";
    id: string;
    name: string;
    input: Record<string, unknown>;
    /** Provider-specific fields that must be echoed back (e.g. Gemini thought signatures). */
    extra?: Record<string, unknown>;
};

export type ToolResultPart = {
    type: "tool_result";
    toolCallId: string;
    toolName: string;
    content: string;
    images?: ImagePart[];
    isError?: boolean;
};

export type UserContent = TextPart | ImagePart | ToolResultPart;
export type AssistantContent = TextPart | ThinkingPart | ToolCallPart;

export interface UserMessage {
    role: "user";
    content: UserContent[];
    /** Harness-only bookkeeping, never sent to providers. */
    meta?: { kind?: "prompt" | "tool_results" | "interrupt" | "summary" | "command" | "reminder"; display?: string };
}

export interface AssistantMessage {
    role: "assistant";
    content: AssistantContent[];
    provider: string;
    model: string;
    stopReason?: StopReason;
    usage?: Usage;
    /**
     * Exact wire payload as returned, replayed verbatim when the next request
     * goes to the same wire format. Keyed by wire kind.
     */
    raw?: { anthropic?: unknown[]; openai?: Record<string, unknown>; responses?: unknown[] };
}

export type Message = UserMessage | AssistantMessage;

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "stop_sequence" | "pause_turn" | "error" | "aborted" | "other";

export interface Usage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    /** Provider-reported cost in USD, when available (OpenRouter). */
    cost?: number;
}

export interface ToolSchema {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema (type: object)
}

export interface ChatRequest {
    model: ModelInfo;
    system: string;
    messages: Message[];
    tools: ToolSchema[];
    maxTokens?: number;
    effort?: Effort;
    showThinking?: boolean;
    signal?: AbortSignal;
    /** Small one-off requests (classifier, titles) skip caching/fallback extras. */
    lightweight?: boolean;
    /** Anthropic server-side web search. */
    webSearch?: boolean;
    /** Stable per-session key for providers with keyed prompt caches (OpenAI). */
    cacheKey?: string;
}

export type StreamEvent =
    | { type: "text"; text: string }
    | { type: "thinking"; text: string }
    | { type: "tool_call_start"; id: string; name: string }
    | { type: "tool_call_delta"; id: string; partial: string }
    | { type: "server_tool"; name: string; detail: string }
    | { type: "retry"; attempt: number; delayMs: number; reason: string }
    | { type: "notice"; message: string }
    | { type: "usage"; usage: Usage };

export interface ModelInfo {
    provider: string;
    id: string;
    name?: string;
    contextWindow?: number;
    maxOutput?: number;
    /** USD per million tokens. */
    pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
    /** Pricing borrowed from another catalog (OpenRouter), not the provider's own API. */
    pricingEstimated?: boolean;
    supportsTools?: boolean;
    supportsImages?: boolean;
    supportsReasoning?: boolean;
    /** Anthropic: effort levels this model accepts. */
    effortLevels?: Effort[];
    /** Anthropic: adaptive thinking supported. */
    adaptiveThinking?: boolean;
    /** Anthropic: budget-style thinking (older models). */
    budgetThinking?: boolean;
    created?: number;
    deprecated?: boolean;
}

export function modelRef(m: { provider: string; id: string }): string {
    return `${m.provider}:${m.id}`;
}

export function parseModelRef(ref: string): { provider: string; id: string } | undefined {
    const idx = ref.indexOf(":");
    if (idx <= 0) return undefined;
    return { provider: ref.slice(0, idx), id: ref.slice(idx + 1) };
}

export class ProviderError extends Error {
    constructor(
        message: string,
        public status?: number,
        public retryable = false,
        public retryAfterMs?: number,
        public body?: string,
    ) {
        super(message);
        this.name = "ProviderError";
    }
}

export interface ProviderClient {
    stream(req: ChatRequest, onEvent: (e: StreamEvent) => void): Promise<AssistantMessage>;
    listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
}

export function textOf(msg: Message): string {
    return msg.content
        .filter((p): p is TextPart => p.type === "text")
        .map((p) => p.text)
        .join("");
}

export function toolCallsOf(msg: AssistantMessage): ToolCallPart[] {
    return msg.content.filter((p): p is ToolCallPart => p.type === "tool_call");
}
