// OpenAI Responses API adapter (POST /v1/responses), stateless (store:false).
//
// Every output item from `response.output_item.done` is stored verbatim and
// replayed unchanged on the next request, which keeps encrypted reasoning and
// assistant `phase` values intact (per OpenAI's reasoning guide). Turns from
// other providers are converted to plain message / function_call items.

import { apiFastModeInfo } from "./fast-mode";
import type { ProviderDef } from "./registry";
import { resolveBaseUrl, customProviderModels } from "./registry";
import { parseSse, stallError, stallTimer } from "./sse";
import { fileAsText, frameName, readsPdf } from "./files";
import { httpError } from "./openai-compat";
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
import type { Effort } from "../config/settings";

type Json = Record<string, any>;

const ALL: Effort[] = ["low", "medium", "high", "xhigh", "max"];

// From the OpenAI model pages (2026-10). The models endpoint only returns ids.
const KNOWN: [RegExp, Partial<ModelInfo>][] = [
    [/^gpt-6-astra/, { name: "GPT-6 Astra", pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } }],
    [/^gpt-6\.1-sol/, { name: "GPT-6.1 Sol", pricing: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } }],
    [/^gpt-6-sol/, { name: "GPT-6 Sol", pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } }],
    [/^gpt-6-luna/, { name: "GPT-6 Luna", pricing: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } }],
    [/^gpt-5\.6-sol/, { name: "GPT-5.6 Sol", pricing: { input: 4, output: 20, cacheRead: 0.4 } }],
    [/^gpt-5\.6-terra/, { name: "GPT-5.6 Terra", pricing: { input: 2, output: 12, cacheRead: 0.2 } }],
    [/^gpt-5\.6-luna/, { name: "GPT-5.6 Luna", pricing: { input: 0.2, output: 1.2, cacheRead: 0.02 } }],
];

export function responsesModelInfo(provider: string, id: string, baseUrl: string): ModelInfo {
    const k = KNOWN.find(([re]) => re.test(id))?.[1];
    const reasoning = /^(gpt-[5-9]|o\d)/.test(id);
    return {
        provider,
        id,
        name: k?.name,
        pricing: k?.pricing,
        ...apiFastModeInfo(provider, id, baseUrl),
        contextWindow: /^gpt-(5\.[5-9]|[6-9])/.test(id) ? 1_050_000 : undefined,
        maxOutput: /^gpt-(5\.[5-9]|[6-9])/.test(id) ? 128_000 : undefined,
        supportsTools: true,
        supportsImages: true,
        supportsReasoning: reasoning,
        effortLevels: reasoning ? ALL : undefined,
    };
}

function sanitizeCallId(id: string): string {
    const s = id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
    return s || "call";
}

export function toResponsesInput(messages: Message[], def: ProviderDef, modelId: string, pdf = true): Json[] {
    const out: Json[] = [];
    for (const msg of messages) {
        if (msg.role === "user") {
            for (const p of msg.content) {
                if (p.type !== "tool_result") continue;
                let text = p.content || "(no output)";
                if (p.isError && !/^error/i.test(text)) text = `Error: ${text}`;
                const output: string | Json[] = p.images?.length
                    ? [{ type: "input_text", text }, ...p.images.map((img) => ({ type: "input_image", image_url: `data:${img.mediaType};base64,${img.data}`, detail: "auto" }))]
                    : text;
                out.push({ type: "function_call_output", call_id: sanitizeCallId(p.toolCallId), output });
            }
            const parts: Json[] = [];
            for (const p of msg.content) {
                if (p.type === "text" && p.text) parts.push({ type: "input_text", text: p.text });
                else if (p.type === "image") parts.push({ type: "input_image", image_url: `data:${p.mediaType};base64,${p.data}`, detail: "auto" });
                else if (p.type === "file") parts.push(p.kind === "pdf" && pdf ? { type: "input_file", filename: frameName(p.name), file_data: `data:application/pdf;base64,${p.data}` } : { type: "input_text", text: fileAsText(p) });
            }
            if (parts.length) out.push({ type: "message", role: "user", content: parts });
            continue;
        }
        if (msg.raw?.responses && msg.provider === def.id) {
            // Encrypted reasoning is only meaningful to the model family that
            // produced it; drop it when the model changed mid-session.
            const items = msg.raw.responses as Json[];
            out.push(...(msg.model === modelId ? items : items.filter((i) => i.type !== "reasoning")));
            continue;
        }
        const text = msg.content
            .filter((p) => p.type === "text")
            .map((p) => (p as { text: string }).text)
            .join("");
        if (text) out.push({ type: "message", role: "assistant", content: text });
        for (const p of msg.content) {
            if (p.type !== "tool_call") continue;
            out.push({ type: "function_call", call_id: sanitizeCallId(p.id), name: p.name, arguments: JSON.stringify(p.input ?? {}) });
        }
    }
    return out;
}

export class OpenAIResponsesProvider implements ProviderClient {
    private base: string;

    constructor(
        private def: ProviderDef,
        private apiKey: string | undefined,
    ) {
        this.base = resolveBaseUrl(def);
    }

    private headers(): Record<string, string> {
        const h: Record<string, string> = { "Content-Type": "application/json", ...(this.def.headers ?? {}) };
        if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
        return h;
    }

    async stream(req: ChatRequest, onEvent: (e: StreamEvent) => void): Promise<AssistantMessage> {
        const def = this.def;
        const m = req.model;
        const body: Json = {
            model: m.id,
            store: false,
            stream: true,
            input: toResponsesInput(req.messages, def, m.id, readsPdf(req.model)),
        };
        // Left out, the project's own tier applies (auto); "default" would override it, so only fast is asked for.
        if (req.fastMode && m.supportsFastMode && def.id === "openai" && apiFastModeInfo(def.id, m.id, this.base).supportsFastMode) body.service_tier = "fast";
        if (req.system) body.instructions = req.system;
        if (req.tools.length) {
            body.tools = req.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }));
            body.tool_choice = "auto";
            body.parallel_tool_calls = true;
        }
        const limit = Math.min(req.maxTokens ?? 64_000, m.maxOutput ?? Infinity);
        if (Number.isFinite(limit)) body.max_output_tokens = limit;
        if (m.supportsReasoning !== false && /^(gpt-[5-9]|o\d)/.test(m.id)) {
            const reasoning: Json = {};
            if (req.effort) reasoning.effort = pickEffort(req.effort, m.effortLevels);
            if (req.showThinking) reasoning.summary = "auto";
            if (Object.keys(reasoning).length) body.reasoning = reasoning;
        }
        if (req.cacheKey && !req.lightweight) body.prompt_cache_key = req.cacheKey;

        const items: Json[] = [];
        // Argument deltas carry item_id, not call_id: map from output_item.added.
        const calls = new Map<string, { callId: string; name: string }>();
        let final: Json | undefined;
        let summaryParts = 0;
        // A request that stops sending anything is retried instead of waited on forever.
        const stall = stallTimer(req.signal);
        try {
            const res = await fetch(`${this.base}/responses`, {
                method: "POST",
                headers: this.headers(),
                body: JSON.stringify(body),
                signal: stall.signal,
            }).catch((e: Error) => {
                if (req.signal?.aborted) throw new ProviderError("aborted");
                if (stall.stalled()) throw stallError(def.name, stall.limit());
                throw new ProviderError(`Connection error to ${def.name}: ${e.message}`, undefined, true);
            });
            stall.touch();
            if (!res.ok || !res.body) {
                const text = await res.text().catch(() => "");
                if (req.signal?.aborted) throw new ProviderError("aborted");
                if (stall.stalled()) throw stallError(def.name, stall.limit());
                throw httpError(res.status, res.statusText, text, res.headers.get("retry-after"), def.name);
            }

            try {
                for await (const ev of parseSse(res.body, stall.signal, stall.touch)) {
                    if (ev.data === "[DONE]") break;
                    let e: Json;
                    try {
                        e = JSON.parse(ev.data);
                    } catch {
                        continue;
                    }
                    switch (e.type) {
                        case "response.output_item.added": {
                            const it = e.item ?? {};
                            if (it.type === "function_call") {
                                calls.set(it.id ?? `idx_${e.output_index}`, { callId: it.call_id, name: it.name });
                                onEvent({ type: "tool_call_start", id: it.call_id, name: it.name });
                            }
                            break;
                        }
                        case "response.output_text.delta":
                            if (e.delta) onEvent({ type: "text", text: e.delta });
                            break;
                        case "response.reasoning_summary_part.added":
                            if (summaryParts++ > 0) onEvent({ type: "thinking", text: "\n\n" });
                            break;
                        case "response.reasoning_summary_text.delta":
                        case "response.reasoning_text.delta":
                            if (e.delta) onEvent({ type: "thinking", text: e.delta });
                            break;
                        case "response.function_call_arguments.delta": {
                            const c = calls.get(e.item_id) ?? calls.get(`idx_${e.output_index}`);
                            if (c && e.delta) onEvent({ type: "tool_call_delta", id: c.callId, partial: e.delta });
                            break;
                        }
                        case "response.output_item.done":
                            if (e.item) items[typeof e.output_index === "number" ? e.output_index : items.length] = e.item;
                            break;
                        case "response.completed":
                        case "response.incomplete":
                            final = e.response;
                            break;
                        case "response.failed": {
                            const err = e.response?.error ?? {};
                            throw new ProviderError(`${def.name}: ${err.message ?? "response failed"}${err.code ? ` (${err.code})` : ""}`, undefined, /server_error|overloaded|rate_limit/i.test(String(err.code ?? "")));
                        }
                        case "error": {
                            const code = String(e.code ?? e.error?.code ?? "");
                            const msg = e.message ?? e.error?.message ?? "stream error";
                            throw new ProviderError(`${def.name}: ${msg}${code ? ` (${code})` : ""}`, undefined, /server_error|overloaded|rate_limit|timeout/i.test(code));
                        }
                    }
                }
            } catch (e) {
                if (req.signal?.aborted) throw new ProviderError("aborted");
                if (stall.stalled()) throw stallError(def.name, stall.limit());
                if (e instanceof ProviderError) throw e;
                throw new ProviderError(`Stream from ${def.name} failed: ${(e as Error).message}`, undefined, true);
            }
        } finally {
            stall.stop();
        }
        if (!final) throw new ProviderError(`${def.name}: stream ended before the response completed`, undefined, true);

        const output: Json[] = items.filter(Boolean).length ? items.filter(Boolean) : (final.output ?? []);
        const content: AssistantContent[] = [];
        let refused = false;
        for (const it of output) {
            if (it.type === "reasoning") {
                const text = [...(it.summary ?? []), ...(it.content ?? [])]
                    .map((s: Json) => s.text ?? "")
                    .filter(Boolean)
                    .join("\n\n");
                if (text) content.push({ type: "thinking", text });
            } else if (it.type === "message") {
                for (const c of it.content ?? []) {
                    if (c.type === "output_text" && c.text) pushText(content, c.text);
                    else if (c.type === "refusal") {
                        refused = true;
                        pushText(content, c.refusal ?? "");
                    }
                }
            } else if (it.type === "function_call") {
                let input: Record<string, unknown>;
                try {
                    input = it.arguments?.trim() ? JSON.parse(it.arguments) : {};
                    if (typeof input !== "object" || input === null || Array.isArray(input)) input = { __invalid_json: it.arguments };
                } catch {
                    input = { __invalid_json: it.arguments };
                }
                content.push({ type: "tool_call", id: it.call_id, name: it.name, input });
            }
        }

        // A declined or cut-off response outranks its tool calls: their
        // arguments may be partial, and the agent must not run them.
        let stopReason: StopReason = "end_turn";
        const reason = final.incomplete_details?.reason;
        const hasCalls = content.some((p) => p.type === "tool_call");
        if (refused || reason === "content_filter") stopReason = "refusal";
        else if (reason === "max_output_tokens") stopReason = "max_tokens";
        else if (final.status === "incomplete") stopReason = hasCalls ? "max_tokens" : "other";
        else if (hasCalls) stopReason = "tool_use";

        if (req.fastMode && final.service_tier === "default") onEvent({ type: "notice", message: "OpenAI served this response at standard speed and rates (fast service was unavailable)." });
        return {
            role: "assistant",
            content,
            provider: def.id,
            // The id we asked for, not `final.model`: if the API answers with a
            // dated snapshot, comparing it to the request id on the next turn
            // would drop the reasoning every time.
            model: m.id,
            stopReason,
            usage: final.usage ? { ...mapUsage(final.usage), ...(final.service_tier ? { fastMode: ["fast", "priority"].includes(final.service_tier) } : {}) } : undefined,
            raw: { responses: JSON.parse(JSON.stringify(output)) },
        };
    }

    async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
        const def = this.def;
        const res = await fetch(`${this.base}/models`, { headers: this.headers(), signal: signal ?? AbortSignal.timeout(20_000) });
        if (!res.ok) {
            const configured = customProviderModels(def.id);
            if (configured.length) return configured.map((id) => responsesModelInfo(def.id, id, this.base));
            throw httpError(res.status, res.statusText, await res.text().catch(() => ""), null, def.name);
        }
        const json = (await res.json()) as { data?: Json[] };
        const ids = new Set((json.data ?? []).map((r) => String(r.id)));
        const out: ModelInfo[] = [];
        for (const r of json.data ?? []) {
            const id = String(r.id);
            if (def.hideModels?.test(id)) continue;
            if (!def.custom && !/^(gpt-|o\d|codex)/.test(id)) continue;
            // Hide dated snapshots when the alias is listed too.
            const alias = id.replace(/-\d{4}-\d{2}-\d{2}$/, "");
            if (alias !== id && ids.has(alias)) continue;
            out.push({ ...responsesModelInfo(def.id, id, this.base), created: r.created ? r.created * 1000 : undefined });
        }
        for (const id of customProviderModels(def.id)) if (!out.some((m) => m.id === id)) out.push(responsesModelInfo(def.id, id, this.base));
        return out;
    }
}

function pushText(content: AssistantContent[], text: string) {
    const last = content[content.length - 1];
    if (last?.type === "text") last.text += text;
    else content.push({ type: "text", text });
}

function pickEffort(want: Effort, have: Effort[] | undefined): Effort {
    if (!have?.length || have.includes(want)) return want;
    const order: Effort[] = ["low", "medium", "high", "xhigh", "max"];
    const wi = order.indexOf(want);
    return [...have].sort((a, b) => Math.abs(order.indexOf(a) - wi) - Math.abs(order.indexOf(b) - wi))[0]!;
}

function mapUsage(u: Json): Usage {
    const input = Number(u.input_tokens ?? 0) || 0;
    const cached = Number(u.input_tokens_details?.cached_tokens ?? 0) || 0;
    const cacheWrite = Number(u.input_tokens_details?.cache_write_tokens ?? u.cache_write_tokens ?? 0) || 0;
    return {
        inputTokens: Math.max(0, input - cached - cacheWrite),
        outputTokens: Number(u.output_tokens ?? 0) || 0,
        cacheReadTokens: cached,
        cacheWriteTokens: cacheWrite,
        reasoningTokens: Number(u.output_tokens_details?.reasoning_tokens ?? 0) || undefined,
    };
}
