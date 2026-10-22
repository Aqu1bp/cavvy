// Anthropic Messages API adapter (official SDK, streaming, beta surface).
//
// Notes on correctness:
// - History is append-only and assistant turns are replayed from their raw
//   content blocks, so thinking blocks stay bound to an unchanged prefix.
// - System prompt and tool list are frozen per session by the caller.
// - Optional features (refusal fallbacks, progress-update display, thinking
//   block binding) are enabled per model and dropped automatically for the rest
//   of the process if an endpoint rejects them.

import { apiFastModeInfo } from "./fast-mode";
import Anthropic from "@anthropic-ai/sdk";
import type { ProviderDef } from "./registry";
import { resolveBaseUrl } from "./registry";
import {
    ProviderError,
    type AssistantContent,
    type AssistantMessage,
    type ChatRequest,
    type Message,
    type ModelInfo,
    type ProviderClient,
    type StopReason,
    type StreamEvent,
    type Usage,
} from "./types";
import { anthropicTraits, ANTHROPIC_FALLBACK_MODELS, ANTHROPIC_THINKING_BUDGETS, ANTHROPIC_BUDGET_EFFORTS } from "./anthropic-models";
import type { Effort } from "../config/settings";
import { plainErrorText } from "../util/html";
import { fileAsText, fitRequest, readsPdf } from "./files";

type BetaParams = Anthropic.Beta.Messages.MessageCreateParamsStreaming;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock;

const OFFICIAL = /^https:\/\/api\.anthropic\.com$/;

// Features that an endpoint rejected; disabled for the rest of the process.
const disabledFeatures = new Set<string>();

export function sanitizeToolId(id: string): string {
    const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    return clean.length ? clean.slice(0, 64) : "tool";
}

export class AnthropicProvider implements ProviderClient {
    private client: Anthropic;
    private official: boolean;

    constructor(
        private def: ProviderDef,
        apiKey: string,
    ) {
        const baseURL = resolveBaseUrl(def);
        this.official = OFFICIAL.test(baseURL);
        this.client = new Anthropic({
            apiKey,
            baseURL,
            maxRetries: 0, // the agent loop retries with user-visible notices
            timeout: 15 * 60 * 1000,
            defaultHeaders: def.headers,
        });
    }

    async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
        const out: ModelInfo[] = [];
        try {
            for await (const m of this.client.models.list({ limit: 100 }, { signal })) {
                const t = anthropicTraits(m.id);
                const caps = m.capabilities;
                const effortLevels: Effort[] = [];
                if (caps?.effort?.supported) {
                    for (const lvl of ["low", "medium", "high", "xhigh", "max"] as const) {
                        if (caps.effort[lvl]?.supported) effortLevels.push(lvl);
                    }
                }
                const adaptive = caps ? caps.thinking.types.adaptive.supported : t.adaptive;
                const budget = caps ? caps.thinking.types.enabled.supported : !!t.budget;
                out.push({
                    provider: this.def.id,
                    id: m.id,
                    name: m.display_name,
                    contextWindow: m.max_input_tokens ?? t.contextWindow,
                    maxOutput: m.max_tokens ?? t.maxOutput,
                    pricing: t.pricing,
                    ...apiFastModeInfo(this.def.id, m.id, resolveBaseUrl(this.def)),
                    supportsTools: true,
                    supportsImages: caps ? caps.image_input.supported : true,
                    supportsReasoning: caps ? caps.thinking.supported : t.adaptive || !!t.budget,
                    adaptiveThinking: adaptive,
                    budgetThinking: budget,
                    effortLevels: !adaptive && budget ? ANTHROPIC_BUDGET_EFFORTS : caps ? effortLevels : t.effort,
                    nativeEffortLevels: caps ? effortLevels : t.effort,
                    created: Date.parse(m.created_at) || undefined,
                    // Anthropic-compatible proxies may leave lifecycle out; that isn't a retirement signal.
                    deprecated: m.lifecycle !== undefined && m.lifecycle !== "active",
                });
            }
        } catch (e) {
            if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw toProviderError(e);
            if (out.length === 0) return ANTHROPIC_FALLBACK_MODELS.map((m) => this.staticInfo(m.id, m.name));
        }
        return out.filter((m) => !m.deprecated || /claude-(opus|sonnet|haiku)-4-[5-9]/.test(m.id));
    }

    staticInfo(id: string, name?: string): ModelInfo {
        const t = anthropicTraits(id);
        return {
            provider: this.def.id,
            id,
            name,
            ...apiFastModeInfo(this.def.id, id, resolveBaseUrl(this.def)),
            contextWindow: t.contextWindow,
            maxOutput: t.maxOutput,
            pricing: t.pricing,
            supportsTools: true,
            supportsImages: true,
            supportsReasoning: t.adaptive || !!t.budget,
            adaptiveThinking: t.adaptive,
            budgetThinking: !!t.budget,
            effortLevels: t.budget ? ANTHROPIC_BUDGET_EFFORTS : t.effort,
            nativeEffortLevels: t.effort,
        };
    }

    async stream(req: ChatRequest, onEvent: (e: StreamEvent) => void): Promise<AssistantMessage> {
        let jsonRetries = 0;
        let bindingRetry = false;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const { params, features } = this.buildParams(req, bindingRetry);
            try {
                return await this.runStream(params, req, onEvent);
            } catch (e) {
                if (e instanceof Anthropic.APIError) {
                    const msg = String(e.message ?? "");
                    if (e.status === 400) {
                        // An optional feature was rejected: drop it and retry once per feature.
                        const rejected = features.find((f) => featureMentioned(f, msg));
                        if (rejected) {
                            disabledFeatures.add(rejected);
                            onEvent({ type: "notice", message: `Endpoint rejected optional feature "${rejected}"; continuing without it.`, resent: true });
                            continue;
                        }
                        // Thinking blocks invalidated (history edited elsewhere): strip and retry once.
                        if (!bindingRetry && /signature|thinking/i.test(msg) && /block|bound|conversation|invalid/i.test(msg)) {
                            bindingRetry = true;
                            onEvent({ type: "notice", message: "Earlier reasoning blocks were rejected by the API; retrying without them.", resent: true });
                            continue;
                        }
                    }
                    throw toProviderError(e);
                }
                if (e instanceof Anthropic.APIUserAbortError || req.signal?.aborted) throw new ProviderError("aborted", undefined, false);
                if (isConnectionError(e)) throw toProviderError(e);
                // Eager input streaming hands invalid tool JSON to us; re-issue the turn.
                if (jsonRetries++ < 2 && e instanceof Error && /json/i.test(e.message)) {
                    onEvent({ type: "notice", message: "Tool input arrived malformed; re-issuing the request.", resent: true });
                    continue;
                }
                throw e;
            }
        }
    }

    private buildParams(req: ChatRequest, stripThinking: boolean): { params: BetaParams; features: string[] } {
        const m = req.model;
        const t = anthropicTraits(m.id);
        const adaptive = m.adaptiveThinking ?? t.adaptive;
        const budget = !adaptive && (m.budgetThinking ?? t.budget);
        // Manual models expose our budget levels to the UI, not native API effort.
        const effortLevels = budget ? m.nativeEffortLevels ?? t.effort : m.effortLevels ?? t.effort;
        const betas: string[] = [];
        const features: string[] = [];
        const use = (f: string) => !disabledFeatures.has(f) && (features.push(f), true);

        const maxOut = Math.min(req.maxTokens ?? 64_000, m.maxOutput ?? t.maxOutput);
        const tools: Anthropic.Beta.Messages.BetaToolUnion[] = req.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters as Anthropic.Beta.Messages.BetaTool.InputSchema,
            ...(this.official && !req.lightweight && !disabledFeatures.has("eager_input_streaming") ? { eager_input_streaming: true } : {}),
        }));
        if (req.webSearch && !req.lightweight && use("web_search")) {
            tools.push({ type: t.webSearchVersion, name: "web_search", max_uses: 8 } as Anthropic.Beta.Messages.BetaToolUnion);
        }

        const params: Omit<BetaParams, "messages"> = {
            model: m.id,
            max_tokens: maxOut,
            system: req.system ? [{ type: "text", text: req.system, ...(req.cacheSystem ? { cache_control: { type: "ephemeral" as const } } : {}) }] : undefined,
            tools: tools.length ? tools : undefined,
            stream: true,
        };
        // Standard is what the API runs when speed is left out, so only fast is asked for (and it needs the beta on every model).
        if (req.fastMode && this.official && m.supportsFastMode && apiFastModeInfo(this.def.id, m.id, resolveBaseUrl(this.def)).supportsFastMode) {
            params.speed = "fast";
            betas.push("fast-mode-2026-02-01");
        }
        if (!req.lightweight) params.cache_control = { type: "ephemeral" };

        if (adaptive && req.noThinking && t.thinkingOff === "between_tools") {
            // Sonnet 5.5's "off": nothing else may go inside it, and effort must be high or below.
            params.thinking = { type: "between_tools" };
        } else if (adaptive) {
            let display: "summarized" | "omitted" | "updates" = req.showThinking ? "summarized" : "omitted";
            if (!req.showThinking && t.displayUpdates && use("display_updates")) {
                display = "updates";
                betas.push("thinking-display-updates-2026-08-18");
            }
            const thinking: Anthropic.Beta.Messages.BetaThinkingConfigAdaptive = { type: "adaptive", display };
            if (!req.lightweight && use("block_binding")) {
                thinking.block_binding = { prefix_mismatch_behavior: "drop_block" };
                betas.push("thinking-binding-controls-2026-08-01");
            }
            params.thinking = thinking;
        } else if (budget && req.effort && !req.noThinking) {
            if (maxOut < 1025) throw new ProviderError("Extended thinking requires max_tokens of at least 1025. Increase the output limit or turn effort off.");
            // Keep the 1024-token minimum and reserve 1024 answer tokens where
            // the output cap permits it, without raising an explicit limit.
            params.thinking = { type: "enabled", budget_tokens: Math.min(ANTHROPIC_THINKING_BUDGETS[req.effort], Math.max(1024, maxOut - 1024)) };
            // Haiku 4.5 cannot interleave. Opus/Sonnet 4 need the beta for tools.
            if (tools.length && /^claude-(opus|sonnet)-4/.test(m.id)) betas.push("interleaved-thinking-2025-05-14");
        }
        const effort = req.effort;
        if (effort && effortLevels.length) {
            let chosen = effortLevels.includes(effort) ? effort : nearestEffort(effort, effortLevels);
            if (params.thinking?.type === "between_tools" && (chosen === "xhigh" || chosen === "max")) chosen = "high";
            params.output_config = { effort: chosen };
        }
        if (t.fallbacks && this.official && !req.lightweight && use("fallbacks")) {
            params.fallbacks = "default";
            betas.push("server-side-fallback-2026-07-01");
        }
        if (betas.length) params.betas = betas as Anthropic.Beta.AnthropicBeta[];
        return { params: fitRequest(req.messages, readsPdf(m), (messages) => ({ ...params, messages: toAnthropicMessages(messages, stripThinking, readsPdf(m)) })), features };
    }

    private async runStream(params: BetaParams, req: ChatRequest, onEvent: (e: StreamEvent) => void): Promise<AssistantMessage> {
        const stream = this.client.beta.messages.stream(params, { signal: req.signal });
        const blockTypes = new Map<number, string>();
        const toolIds = new Map<number, string>();
        for await (const ev of stream) {
            switch (ev.type) {
                case "content_block_start": {
                    const b = ev.content_block;
                    blockTypes.set(ev.index, b.type);
                    if (b.type === "tool_use") {
                        toolIds.set(ev.index, b.id);
                        onEvent({ type: "tool_call_start", id: b.id, name: b.name });
                    } else if (b.type === "server_tool_use") {
                        onEvent({ type: "server_tool", name: b.name, detail: "" });
                    } else if (b.type === "web_search_tool_result") {
                        const c = b.content;
                        const n = Array.isArray(c) ? c.length : 0;
                        onEvent({ type: "server_tool", name: "web_search_result", detail: Array.isArray(c) ? `${n} results` : "error" });
                    } else if (b.type === "thinking" || b.type === "redacted_thinking") {
                        // With display "omitted" nothing more arrives until the thinking ends; say it started.
                        onEvent({ type: "thinking", text: "" });
                    } else if (b.type === "fallback") {
                        onEvent({ type: "notice", message: `${b.from.model} declined this request; continuing on ${b.to.model}.` });
                    }
                    break;
                }
                case "content_block_delta": {
                    const d = ev.delta;
                    if (d.type === "text_delta") onEvent({ type: "text", text: d.text });
                    else if (d.type === "thinking_delta") {
                        if (d.thinking) onEvent({ type: "thinking", text: d.thinking });
                    } else if (d.type === "input_json_delta") {
                        const id = toolIds.get(ev.index);
                        if (id) onEvent({ type: "tool_call_delta", id, partial: d.partial_json });
                    }
                    break;
                }
                case "message_delta": {
                    break;
                }
            }
        }
        const final = await stream.finalMessage();
        if (req.fastMode && final.usage.speed === "standard") onEvent({ type: "notice", message: "Anthropic served this response at standard speed and rates." });
        return this.fromFinal(final, req);
    }

    private fromFinal(final: Anthropic.Beta.Messages.BetaMessage, req: ChatRequest): AssistantMessage {
        let blocks: BetaContentBlock[] = final.content;
        // After a mid-output fallback, blocks before the last boundary that
        // aren't text belong to the declined attempt: never run or replay them.
        const lastFallback = blocks.map((b) => b.type).lastIndexOf("fallback");
        if (lastFallback >= 0) {
            blocks = blocks.filter((b, i) => {
                if (b.type === "fallback") return false;
                if (i < lastFallback) return b.type === "text";
                return true;
            });
        }
        const content: AssistantContent[] = [];
        for (const b of blocks) {
            if (b.type === "text") {
                const last = content[content.length - 1];
                if (last?.type === "text") last.text += b.text;
                else content.push({ type: "text", text: b.text });
            } else if (b.type === "thinking") content.push({ type: "thinking", text: b.thinking, signature: b.signature });
            else if (b.type === "redacted_thinking") content.push({ type: "thinking", text: "", redactedData: b.data });
            else if (b.type === "tool_use") content.push({ type: "tool_call", id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> });
        }
        const u = final.usage;
        const usage: Usage = {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
            // A gateway may cache for an hour: priced (and kept warm) for that.
            ...(u.cache_creation ? { cacheWrite1hTokens: u.cache_creation.ephemeral_1h_input_tokens ?? 0 } : {}),
            ...(u.speed ? { fastMode: u.speed === "fast" } : {}),
        };
        return {
            role: "assistant",
            content,
            provider: req.model.provider,
            model: final.model ?? req.model.id,
            stopReason: mapStop(final.stop_reason),
            usage,
            raw: { anthropic: JSON.parse(JSON.stringify(blocks)) },
        };
    }
}

function nearestEffort(want: Effort, have: Effort[]): Effort {
    const order: Effort[] = ["low", "medium", "high", "xhigh", "max"];
    const wi = order.indexOf(want);
    let best = have[0]!;
    let bestDist = Infinity;
    for (const h of have) {
        const d = Math.abs(order.indexOf(h) - wi);
        if (d < bestDist) {
            best = h;
            bestDist = d;
        }
    }
    return best;
}

function featureMentioned(feature: string, msg: string): boolean {
    const m = msg.toLowerCase();
    switch (feature) {
        case "fallbacks":
            return m.includes("fallback");
        case "display_updates":
            return m.includes("display") || m.includes("thinking-display");
        case "block_binding":
            return m.includes("block_binding") || m.includes("thinking-binding");
        case "web_search":
            return m.includes("web_search");
        case "eager_input_streaming":
            return m.includes("eager_input_streaming");
    }
    return false;
}

function mapStop(s: string | null | undefined): StopReason {
    switch (s) {
        case "end_turn":
        case "tool_use":
        case "max_tokens":
        case "refusal":
        case "stop_sequence":
        case "pause_turn":
            return s;
        case "model_context_window_exceeded":
            return "max_tokens";
        default:
            return "other";
    }
}

function isConnectionError(e: unknown): boolean {
    return e instanceof Anthropic.APIConnectionError || e instanceof Anthropic.APIConnectionTimeoutError;
}

function toProviderError(e: unknown): ProviderError {
    if (e instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError("Request timed out", undefined, true);
    if (e instanceof Anthropic.APIConnectionError) return new ProviderError(`Connection error: ${e.message}`, undefined, true);
    if (e instanceof Anthropic.APIError) {
        const status = e.status;
        const retryAfter = Number(e.headers?.get?.("retry-after"));
        const retryable = status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
        let message = plainErrorText(e.message);
        if (status === 401) message = "Authentication failed: the Anthropic API key was rejected. Run /login to update it.";
        else if (status === 529 || /overloaded/i.test(message)) message = "Anthropic API is overloaded";
        return new ProviderError(message, status, retryable, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
    }
    return new ProviderError(String((e as Error)?.message ?? e));
}

// ---------------------------------------------------------------------------
// Conversion: neutral transcript -> Anthropic messages. Deterministic.

export function toAnthropicMessages(messages: Message[], stripThinking = false, pdf = true): BetaMessageParam[] {
    const out: BetaMessageParam[] = [];
    for (const msg of messages) {
        if (msg.role === "user") {
            const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
            for (const p of msg.content) {
                if (p.type === "text") {
                    if (p.text) content.push({ type: "text", text: p.text });
                } else if (p.type === "image") {
                    content.push({ type: "image", source: { type: "base64", media_type: p.mediaType as "image/png", data: p.data } });
                } else if (p.type === "file") {
                    if (p.kind === "pdf" && pdf) content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: p.data } });
                    else content.push({ type: "text", text: fileAsText(p) });
                } else if (p.type === "tool_result") {
                    const inner: (Anthropic.Beta.Messages.BetaTextBlockParam | Anthropic.Beta.Messages.BetaImageBlockParam)[] = [];
                    inner.push({ type: "text", text: p.content || "(no output)" });
                    for (const img of p.images ?? []) {
                        inner.push({ type: "image", source: { type: "base64", media_type: img.mediaType as "image/png", data: img.data } });
                    }
                    content.push({
                        type: "tool_result",
                        tool_use_id: sanitizeToolId(p.toolCallId),
                        content: inner.length === 1 ? (inner[0] as { text: string }).text : inner,
                        ...(p.isError ? { is_error: true } : {}),
                    });
                }
            }
            if (!content.length) continue;
            // Consecutive user turns (e.g. after an interrupt) are merged so
            // the request alternates roles. Deterministic, so cache-safe.
            const prev = out[out.length - 1];
            if (prev?.role === "user" && Array.isArray(prev.content)) prev.content.push(...content);
            else out.push({ role: "user", content });
            continue;
        }
        // assistant
        let blocks: Anthropic.Beta.Messages.BetaContentBlockParam[];
        if (msg.raw?.anthropic) {
            blocks = msg.raw.anthropic as Anthropic.Beta.Messages.BetaContentBlockParam[];
            if (stripThinking) blocks = blocks.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
        } else {
            blocks = [];
            for (const p of msg.content) {
                if (p.type === "text") {
                    if (p.text) blocks.push({ type: "text", text: p.text });
                } else if (p.type === "tool_call") {
                    blocks.push({ type: "tool_use", id: sanitizeToolId(p.id), name: p.name, input: p.input });
                }
                // Thinking from other providers can't be replayed here.
            }
        }
        if (blocks.length) out.push({ role: "assistant", content: blocks });
    }
    return out;
}
