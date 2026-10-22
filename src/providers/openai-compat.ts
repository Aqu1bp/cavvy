// OpenAI Chat Completions adapter, used for every "OpenAI-compatible"
// provider (OpenRouter, Gemini's compat layer, Groq, DeepSeek, Mistral, xAI,
// Together, Fireworks, Cerebras, Ollama, LM Studio, custom endpoints).

import type { ProviderDef } from "./registry";
import { resolveBaseUrl, customProviderModels } from "./registry";
import { parseSse, stallError, stallTimer } from "./sse";
import { fileAsText, fitRequest, frameName, providerReadsPdf } from "./files";
import {
    splitSystemPrompt,
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
import { plainErrorText } from "../util/html";

type Json = Record<string, any>;

/** Gemini accepts this documented placeholder for tool calls it didn't produce. */
const GEMINI_FOREIGN_SIGNATURE = "skip_thought_signature_validator";

/** Permanent quota exhaustion, distinct from a rate limit that resets with time. */
export function isUsageLimit(error: Json): boolean {
    // Gemini and gateways can reuse billing language for quotas that reset.
    if (/RetryInfo|Please retry in|quotaId[^,}]*Per(?:Minute|Day)/i.test(JSON.stringify(error))) return false;
    return error.code === "insufficient_quota" || error.type === "insufficient_quota"
        || /credit balance (?:is )?(?:too low|exhausted)|(?:out of|insufficient) credits/i.test(String(error.message ?? ""));
}

export const usageLimitHint = ". Usage limit / billing: check your plan and credit balance.";

export function httpError(status: number, statusText: string, body: string, retryAfter: string | null, providerName: string, authHint = "Check the API key with /login."): ProviderError {
    let message = `${providerName} API error ${status} ${statusText}`;
    let usageLimit = false;
    try {
        const j = JSON.parse(body);
        usageLimit = isUsageLimit(j?.error ?? j ?? {});
        const m = j?.error?.message ?? j?.message ?? j?.detail ?? (Array.isArray(j) ? j[0]?.error?.message : undefined);
        if (m) message = `${providerName}: ${typeof m === "string" ? m : JSON.stringify(m)} (${status})`;
    } catch {
        if (body.trim()) message += `: ${plainErrorText(body).slice(0, 300)}`;
    }
    if (status === 401 || status === 403) message += `. ${authHint}`;
    if (status === 402) message += `. The account may be out of credits.`;
    // A quota of 0 (Gemini's free tier for a model it doesn't include) never frees up: no use retrying.
    const noQuota = status === 429 && /\blimit:\s*0\b/.test(body);
    if (noQuota) message += ". Not retried: the quota for this model is 0 on this key's plan.";
    if (usageLimit) message += usageLimitHint;
    const retryable = !usageLimit && !noQuota && [408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529].includes(status);
    const ra = retryAfter ? Number(retryAfter) * 1000 || Date.parse(retryAfter) - Date.now() : undefined;
    return new ProviderError(message, status, retryable, ra && ra > 0 ? ra : undefined, body);
}

/** Deterministic id mapping for providers with strict tool-call id formats. */
function mapToolId(id: string, def: ProviderDef): string {
    if (def.id !== "mistral") return id;
    if (/^[A-Za-z0-9]{9}$/.test(id)) return id;
    // Mistral requires exactly 9 alphanumerics.
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
    let out = "";
    let x = h >>> 0;
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    for (let i = 0; i < 9; i++) {
        out += alphabet[x % alphabet.length];
        x = Math.floor(x / alphabet.length) + (i + 1) * 7919 + id.length;
    }
    return out;
}

function usesDeepSeekDialect(def: ProviderDef, base = resolveBaseUrl(def)): boolean {
    if (def.deepseekCompat !== undefined) return def.deepseekCompat;
    if (def.id === "deepseek") return true;
    try {
        return new URL(base).hostname === "api.deepseek.com";
    } catch {
        return false;
    }
}

function visibleReasoning(msg: AssistantMessage): string {
    return msg.content.filter((p) => p.type === "thinking").map((p) => p.text).join("\n");
}

export function toOpenAIMessages(system: string, messages: Message[], def: ProviderDef): Json[] {
    const out: Json[] = [];
    const deepseek = usesDeepSeekDialect(def);
    if (system) out.push({ role: "system", content: system });
    /** The last user message out, and its parts: one straight after it joins it. */
    let lastUser: { m: Json; parts: Json[] } | undefined;
    for (const msg of messages) {
        if (msg.role === "user") {
            const extraImages: Json[] = [];
            for (const p of msg.content) {
                if (p.type !== "tool_result") continue;
                let content = p.content || "(no output)";
                if (p.isError && !/^error/i.test(content)) content = `Error: ${content}`;
                if (p.images?.length) {
                    content += `\n[${p.images.length} image(s) attached in the next message]`;
                    for (const img of p.images) extraImages.push({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.data}` } });
                }
                out.push({ role: "tool", tool_call_id: mapToolId(p.toolCallId, def), content });
            }
            const parts: Json[] = [];
            for (const p of msg.content) {
                if (p.type === "text" && p.text) parts.push({ type: "text", text: p.text });
                else if (p.type === "image") parts.push({ type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` } });
                else if (p.type === "file") {
                    // Only OpenRouter documents a PDF part here; elsewhere the model hears one was attached.
                    if (p.kind === "pdf" && providerReadsPdf(def)) parts.push({ type: "file", file: { filename: frameName(p.name), file_data: `data:application/pdf;base64,${p.data}` } });
                    else parts.push({ type: "text", text: fileAsText(p) });
                }
            }
            if (extraImages.length) parts.unshift({ type: "text", text: "Images returned by the tool calls above:" }, ...extraImages);
            if (parts.length) {
                // Consecutive user messages (a summary and the prompt it kept, a prompt after an interrupt) go as one, in
                // order: chat templates that want roles to alternate (Mistral's, many local models') refuse two in a row.
                if (lastUser && out[out.length - 1] === lastUser.m) lastUser.parts.push(...parts);
                else out.push((lastUser = { m: { role: "user" }, parts }).m);
                const all = lastUser.parts;
                lastUser.m.content = all.every((x) => x.type === "text") ? all.map((x) => x.text).join("\n\n") : all;
            }
            continue;
        }
        if (msg.raw?.openai && msg.provider === def.id) {
            const raw = { ...msg.raw.openai };
            if (Array.isArray(raw.tool_calls)) {
                raw.tool_calls = raw.tool_calls.map((call: Json) => {
                    if (!call.function) return call;
                    try {
                        const input = JSON.parse(call.function.arguments);
                        if (input && typeof input === "object" && !Array.isArray(input)) return call;
                    } catch {}
                    // Keep valid argument bytes intact; the tool result explains invalid input.
                    return { ...call, function: { ...call.function, arguments: "{}" } };
                });
            }
            if (deepseek) raw.reasoning_content ??= visibleReasoning(msg);
            else delete raw.reasoning_content;
            out.push(raw);
            continue;
        }
        const text = msg.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
        const calls = msg.content.filter((p) => p.type === "tool_call");
        if (!text && !calls.length) continue;
        const m: Json = { role: "assistant", content: text || null };
        if (deepseek) {
            // Turns from other providers: hand over their visible reasoning (if any)
            // so the reasoning_content field is present on every assistant turn.
            m.reasoning_content = visibleReasoning(msg);
        }
        if (calls.length) {
            m.tool_calls = calls.map((c, i) => {
                const tc: Json = { id: mapToolId(c.id, def), type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } };
                if (def.geminiCompat && i === 0) tc.extra_content = { google: { thought_signature: GEMINI_FOREIGN_SIGNATURE } };
                return tc;
            });
        }
        out.push(m);
    }
    return out;
}

function deepMerge(a: Json | undefined, b: Json): Json {
    const out: Json = { ...(a ?? {}) };
    for (const [k, v] of Object.entries(b)) {
        if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object") out[k] = deepMerge(out[k], v);
        else if (typeof v === "string" && typeof out[k] === "string" && k !== "thought_signature") out[k] = out[k] + v;
        else out[k] = v;
    }
    return out;
}

function supportedEfforts(value: unknown): Effort[] {
    return Array.isArray(value) ? value.filter((e): e is Effort => ["low", "medium", "high", "xhigh", "max"].includes(e)) : [];
}

/** Only documented model/endpoint pairs: reasoning output alone is not effort support. */
export function compatModelInfo(def: ProviderDef, id: string): ModelInfo {
    let levels = def.modelEffortLevels?.[id];
    if (levels === undefined) {
        // https://console.groq.com/docs/reasoning
        // https://docs.together.ai/docs/gpt-oss
        // https://docs.fireworks.ai/api-reference/post-chatcompletions (Harmony)
        // https://inference-docs.cerebras.ai/capabilities/reasoning
        // https://docs.ollama.com/api/openai-compatibility and /capabilities/thinking
        const gptOss: Record<string, RegExp> = {
            groq: /^openai\/gpt-oss-(20b|120b)$/,
            together: /^openai\/gpt-oss-(20b|120b)$/,
            fireworks: /^accounts\/fireworks\/models\/gpt-oss-(20b|120b)$/,
            cerebras: /^gpt-oss-120b$/,
            ollama: /^gpt-oss(?::(?:latest|20b|120b))?$/,
        };
        if (gptOss[def.id]?.test(id)) levels = ["low", "medium", "high"];
    }
    const effortLevels = supportedEfforts(levels);
    return { provider: def.id, id, ...(levels !== undefined ? { supportsReasoning: effortLevels.length > 0, effortLevels } : {}) };
}

function effortFor(def: ProviderDef, model: ModelInfo, effort: Effort | undefined): string | undefined {
    if (!effort || !model.supportsReasoning) return undefined;
    const levels = model.effortLevels;
    if (levels?.length) {
        if (levels.includes(effort)) return effort;
        const order: Effort[] = ["low", "medium", "high", "xhigh", "max"];
        const wi = order.indexOf(effort);
        return [...levels].sort((x, y) => Math.abs(order.indexOf(x) - wi) - Math.abs(order.indexOf(y) - wi))[0];
    }
    // Gemini compat accepts minimal/low/medium/high; map the top levels down.
    if (def.geminiCompat || def.reasoning === "openai") return effort === "xhigh" || effort === "max" ? "high" : effort;
    return effort;
}

export class OpenAICompatProvider implements ProviderClient {
    protected base: string;

    constructor(
        protected def: ProviderDef,
        private apiKey: string | undefined,
        base?: string,
    ) {
        this.base = base ?? resolveBaseUrl(def);
        this.def = { ...def, deepseekCompat: usesDeepSeekDialect(def, this.base) };
    }

    /** The Authorization header, if any. `fresh`: the previous one was rejected. */
    protected async authorization(_fresh: boolean): Promise<string | undefined> {
        return this.apiKey ? `Bearer ${this.apiKey}` : undefined;
    }

    /** Whether a rejected credential can be swapped for a fresh one and the request sent again. */
    protected canRefresh(): boolean {
        return false;
    }

    protected apiError(status: number, statusText: string, body: string, retryAfter: string | null): ProviderError {
        return httpError(status, statusText, body, retryAfter, this.def.name);
    }

    private async headers(fresh = false): Promise<Record<string, string>> {
        const h: Record<string, string> = { "Content-Type": "application/json", ...(this.def.headers ?? {}) };
        const auth = await this.authorization(fresh);
        if (auth) h.Authorization = auth;
        return h;
    }

    async stream(req: ChatRequest, onEvent: (e: StreamEvent) => void): Promise<AssistantMessage> {
        const def = this.def;
        const m = req.model;
        const body: Json & { messages?: never } = {
            model: m.id,
            stream: true,
        };
        // OpenRouter's Claude routes support automatic caching; Gemini 2.5+ uses implicit caching.
        // https://openrouter.ai/docs/guides/best-practices/prompt-caching
        const cacheClaude = def.id === "openrouter" && /^~?anthropic\/claude-/.test(m.id);
        if (cacheClaude && !req.lightweight) body.cache_control = { type: "ephemeral" };
        if (req.tools.length) {
            body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
        }
        if (def.streamUsage && def.id !== "openrouter") body.stream_options = { include_usage: true };
        // With no known output limit, send only a cap the caller asked for:
        // a guessed default could exceed what the model allows.
        const limit = Math.min(req.maxTokens ?? 32_000, m.maxOutput ?? Infinity);
        if ((m.maxOutput || req.maxTokens !== undefined) && Number.isFinite(limit)) body[def.maxTokensField ?? "max_tokens"] = limit;
        const effort = effortFor(def, m, req.effort);
        if (effort) {
            if (def.reasoning === "openrouter") body.reasoning = { effort };
            else body.reasoning_effort = effort;
        }

        const payload = fitRequest(req.messages, providerReadsPdf(def), (messages) => {
            const converted = toOpenAIMessages(req.system, messages, def);
            if (cacheClaude && req.cacheSystem && req.system) {
                // The breakpoint goes before the session context (date, git), so sessions share the prefix.
                const { shared, session } = splitSystemPrompt(req.system);
                converted[0]!.content = [{ type: "text", text: shared, cache_control: { type: "ephemeral" } }, ...(session ? [{ type: "text", text: session }] : [])];
            }
            return JSON.stringify({ ...body, messages: converted });
        });
        // A request that stops sending anything is retried instead of waited on forever.
        const stall = stallTimer(req.signal, def.id === "vertex");
        const post = async (fresh: boolean) =>
            fetch(`${this.base}/chat/completions`, {
                method: "POST",
                headers: await this.headers(fresh),
                body: payload,
                signal: stall.signal,
            }).catch((e: Error) => {
                if (req.signal?.aborted) throw new ProviderError("aborted");
                if (stall.stalled()) throw stallError(def.name, stall.limit());
                throw new ProviderError(`Connection error to ${def.name}: ${e.message}`, undefined, true);
            });
        try {
            return await this.read(req, await post(false), post, stall, onEvent);
        } finally {
            stall.stop();
        }
    }

    private async read(req: ChatRequest, res: Response, post: (fresh: boolean) => Promise<Response>, stall: ReturnType<typeof stallTimer>, onEvent: (e: StreamEvent) => void): Promise<AssistantMessage> {
        const def = this.def;
        const m = req.model;
        stall.touch();
        // An expired token: get a new one and try once more.
        if (res.status === 401 && this.canRefresh()) {
            await res.body?.cancel().catch(() => {});
            stall.restart();
            res = await post(true);
            stall.touch();
        }
        if (!res.ok || !res.body) {
            const text = await res.text().catch(() => "");
            if (req.signal?.aborted) throw new ProviderError("aborted");
            if (stall.stalled()) throw stallError(def.name, stall.limit());
            throw this.apiError(res.status, res.statusText, text, res.headers.get("retry-after"));
        }

        let text = "";
        let reasoning = "";
        let reasoningContent: string | undefined;
        let reasoningDetails: Json[] | undefined;
        const calls = new Map<number, { id: string; name: string; args: string; extra?: Json }>();
        let finish: string | undefined;
        let done = false;
        let usage: Usage | undefined;
        let model = m.id;
        try {
            for await (const ev of parseSse(res.body, stall.signal, stall.touch)) {
                if (ev.data === "[DONE]") {
                    done = true;
                    break;
                }
                let chunk: Json;
                try {
                    chunk = JSON.parse(ev.data);
                } catch {
                    continue;
                }
                if (chunk.error) {
                    const code = Number(chunk.error.code) || undefined;
                    const usageLimit = isUsageLimit(chunk.error);
                    throw new ProviderError(`${def.name}: ${chunk.error.message ?? JSON.stringify(chunk.error)}${usageLimit ? usageLimitHint : ""}`, code, !usageLimit && (code === 429 || (code ?? 0) >= 500));
                }
                if (chunk.model) model = chunk.model;
                const u = chunk.usage ?? chunk.x_groq?.usage;
                if (u) usage = mapUsage(u);
                const choice = chunk.choices?.[0];
                if (!choice) continue;
                const d = choice.delta ?? choice.message ?? {};
                if (typeof d.content === "string" && d.content) {
                    text += d.content;
                    onEvent({ type: "text", text: d.content });
                }
                const r = d.reasoning_content ?? d.reasoning;
                if (typeof d.reasoning_content === "string") reasoningContent = (reasoningContent ?? "") + d.reasoning_content;
                if (typeof r === "string" && r) {
                    reasoning += r;
                    onEvent({ type: "thinking", text: r });
                }
                if (Array.isArray(d.reasoning_details) && d.reasoning_details.length) {
                    reasoningDetails = mergeReasoningDetails(reasoningDetails, d.reasoning_details);
                }
                for (const tc of d.tool_calls ?? []) {
                    let idx: number = typeof tc.index === "number" ? tc.index : -1;
                    if (idx < 0) {
                        const byId = [...calls.entries()].find(([, v]) => tc.id && v.id === tc.id);
                        idx = byId ? byId[0] : calls.size;
                    }
                    let entry = calls.get(idx);
                    if (!entry) {
                        entry = { id: "", name: "", args: "" };
                        calls.set(idx, entry);
                    }
                    if (tc.id && !entry.id) entry.id = tc.id;
                    const fname = tc.function?.name;
                    if (fname && fname !== entry.name) {
                        const isNew = !entry.name;
                        entry.name = isNew ? fname : entry.name + fname;
                        if (isNew) onEvent({ type: "tool_call_start", id: entry.id || `call_${idx}`, name: fname });
                    }
                    if (typeof tc.function?.arguments === "string" && tc.function.arguments) {
                        entry.args += tc.function.arguments;
                        onEvent({ type: "tool_call_delta", id: entry.id || `call_${idx}`, partial: tc.function.arguments });
                    } else if (tc.function?.arguments && typeof tc.function.arguments === "object") {
                        entry.args = JSON.stringify(tc.function.arguments);
                    }
                    if (tc.extra_content) entry.extra = deepMerge(entry.extra, tc.extra_content);
                }
                if (choice.finish_reason) finish = choice.finish_reason;
            }
        } catch (e) {
            if (req.signal?.aborted) throw new ProviderError("aborted");
            if (stall.stalled()) throw stallError(def.name, stall.limit());
            if (e instanceof ProviderError) throw e;
            throw new ProviderError(`Stream from ${def.name} failed: ${(e as Error).message}`, undefined, true);
        }
        // A dropped connection ends the body cleanly too; without [DONE] or a
        // finish reason the text and tool arguments may be cut short.
        if (!done && !finish) {
            if (req.signal?.aborted) throw new ProviderError("aborted");
            throw new ProviderError(`${def.name}: stream ended before the response completed`, undefined, true);
        }

        const content: AssistantContent[] = [];
        if (reasoning) content.push({ type: "thinking", text: reasoning });
        if (text) content.push({ type: "text", text });
        const rawCalls: Json[] = [];
        let n = 0;
        for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
            if (!c.name) continue;
            const id = c.id || `call_${Date.now().toString(36)}_${n++}`;
            let input: Record<string, unknown>;
            try {
                input = c.args.trim() ? JSON.parse(c.args) : {};
                if (typeof input !== "object" || input === null || Array.isArray(input)) input = { __invalid_json: c.args };
            } catch {
                input = { __invalid_json: c.args };
            }
            content.push({ type: "tool_call", id, name: c.name, input, ...(c.extra ? { extra: c.extra } : {}) });
            const raw: Json = { id, type: "function", function: { name: c.name, arguments: c.args || "{}" } };
            if (c.extra) raw.extra_content = c.extra;
            rawCalls.push(raw);
        }
        const rawMsg: Json = { role: "assistant", content: text || null };
        if (rawCalls.length) rawMsg.tool_calls = rawCalls;
        if (def.reasoning === "openrouter") {
            if (reasoningDetails?.length) rawMsg.reasoning_details = reasoningDetails;
            else if (reasoning) rawMsg.reasoning = reasoning;
        }
        // DeepSeek: with tools in the request, reasoning_content of every
        // earlier assistant turn must be sent back or the API returns 400.
        // Store this even for unknown dialects. Receiving it does not establish
        // that the endpoint accepts it as input; replay is gated separately.
        if (reasoningContent !== undefined || def.deepseekCompat) rawMsg.reasoning_content = reasoningContent ?? reasoning;

        let stopReason: StopReason = mapFinish(finish);
        if (rawCalls.length && stopReason === "end_turn") stopReason = "tool_use";
        return {
            role: "assistant",
            content,
            provider: def.id,
            model,
            stopReason,
            usage,
            raw: { openai: rawMsg },
        };
    }

    async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
        const def = this.def;
        if (def.id === "gemini") {
            const native = await this.listGeminiNative(signal).catch(() => undefined);
            if (native?.length) return native;
        }
        const res = await fetch(`${this.base}/models`, { headers: await this.headers(), signal: signal ?? AbortSignal.timeout(20_000) });
        if (!res.ok) {
            const configured = customProviderModels(def.id);
            if (configured.length) return configured.map((id) => compatModelInfo(def, id));
            throw this.apiError(res.status, res.statusText, await res.text().catch(() => ""), null);
        }
        const json = (await res.json()) as Json;
        const list: Json[] = Array.isArray(json) ? json : (json.data ?? json.models ?? []);
        const out: ModelInfo[] = [];
        for (const r of list) {
            const id: string = r.id ?? r.name;
            if (!id || (def.hideModels && def.hideModels.test(id))) continue;
            const label: string | undefined = r.display_name ?? r.name;
            const info: ModelInfo = { ...compatModelInfo(def, id), name: label && label !== id ? label : undefined, created: r.created ? r.created * 1000 : undefined };
            info.contextWindow = num(r.context_length ?? r.context_window ?? r.max_context_length ?? r.top_provider?.context_length);
            info.maxOutput = num(r.top_provider?.max_completion_tokens ?? r.max_output_tokens ?? r.max_completion_tokens);
            if (def.id === "openrouter") {
                const params: string[] = r.supported_parameters ?? [];
                if (!params.includes("tools")) continue;
                if (id.endsWith(":batch")) continue;
                info.supportsTools = true;
                info.supportsReasoning = params.includes("reasoning") || params.includes("reasoning_effort");
                info.supportsImages = (r.architecture?.input_modalities ?? []).includes("image");
                const p = r.pricing ?? {};
                const pin = Number(p.prompt);
                const pout = Number(p.completion);
                if (pin >= 0 && pout >= 0 && Number.isFinite(pin) && Number.isFinite(pout)) {
                    info.pricing = {
                        input: pin * 1e6,
                        output: pout * 1e6,
                        cacheRead: p.input_cache_read !== undefined ? Number(p.input_cache_read) * 1e6 : undefined,
                        cacheWrite: p.input_cache_write !== undefined ? Number(p.input_cache_write) * 1e6 : undefined,
                    };
                }
                const efforts: string[] = r.reasoning?.supported_efforts ?? [];
                const ours = efforts.filter((e): e is Effort => ["low", "medium", "high", "xhigh", "max"].includes(e));
                if (ours.length) info.effortLevels = ours;
            } else if (def.id === "mistral") {
                if (r.capabilities && r.capabilities.function_calling === false) continue;
                if (r.capabilities && r.capabilities.completion_chat === false) continue;
                info.supportsImages = Boolean(r.capabilities?.vision);
            } else if (def.id === "together") {
                if (r.type && r.type !== "chat") continue;
                if (r.pricing && (r.pricing.input || r.pricing.output)) info.pricing = { input: Number(r.pricing.input) || 0, output: Number(r.pricing.output) || 0 };
            } else if (def.id === "deepseek") {
                const lv: string[] = r.effort?.supported_levels ?? [];
                const ours = lv.filter((e): e is Effort => ["low", "medium", "high", "xhigh", "max"].includes(e));
                if (ours.length) {
                    info.effortLevels = ours;
                    info.supportsReasoning = true;
                }
            } else if (def.id === "xai") {
                // Prices are reported in USD cents per 100M tokens.
                const pin = num(r.prompt_text_token_price);
                const pout = num(r.completion_text_token_price);
                if (pin !== undefined && pout !== undefined) info.pricing = { input: pin / 10_000, output: pout / 10_000, cacheRead: num(r.cached_prompt_text_token_price) !== undefined ? num(r.cached_prompt_text_token_price)! / 10_000 : undefined };
                // xAI documents low/medium/high, plus xhigh on supported models.
                // https://docs.x.ai/developers/model-capabilities/text/reasoning
                const levels = supportedEfforts(r.capabilities?.reasoning_effort).filter((e) => e !== "max");
                if (levels.length) {
                    info.supportsReasoning = true;
                    info.effortLevels = levels;
                }
            } else if (def.id === "groq") {
                if (r.active === false) continue;
            }
            out.push(info);
        }
        for (const id of customProviderModels(def.id)) if (!out.some((m) => m.id === id)) out.push(compatModelInfo(def, id));
        return out;
    }

    private async listGeminiNative(signal?: AbortSignal): Promise<ModelInfo[]> {
        const out: ModelInfo[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < 10; page++) {
            const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
            url.searchParams.set("pageSize", "1000");
            if (pageToken) url.searchParams.set("pageToken", pageToken);
            const res = await fetch(url, { headers: { "x-goog-api-key": this.apiKey ?? "" }, signal: signal ?? AbortSignal.timeout(20_000) });
            if (!res.ok) throw httpError(res.status, res.statusText, await res.text(), null, "Gemini");
            const json = (await res.json()) as { models?: Json[]; nextPageToken?: string };
            for (const r of json.models ?? []) {
                if (!(r.supportedGenerationMethods ?? []).includes("generateContent")) continue;
                const id = String(r.name ?? "").replace(/^models\//, "");
                if (!id || this.def.hideModels?.test(id)) continue;
                out.push({
                    provider: "gemini",
                    id,
                    name: r.displayName,
                    contextWindow: num(r.inputTokenLimit),
                    maxOutput: num(r.outputTokenLimit),
                    supportsReasoning: Boolean(r.thinking),
                    supportsTools: true,
                    supportsImages: true,
                });
            }
            pageToken = json.nextPageToken;
            if (!pageToken) break;
        }
        return out;
    }
}

function num(v: unknown): number | undefined {
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

function mergeReasoningDetails(acc: Json[] | undefined, incoming: Json[]): Json[] {
    const out = [...(acc ?? [])];
    for (const d of incoming) {
        const idx = typeof d.index === "number" ? out.findIndex((x) => x.index === d.index && x.type === d.type) : -1;
        if (idx < 0) {
            out.push({ ...d });
            continue;
        }
        const cur = out[idx]!;
        for (const [k, v] of Object.entries(d)) {
            if ((k === "text" || k === "summary" || k === "data") && typeof v === "string" && typeof cur[k] === "string") cur[k] += v;
            else if (v !== null && v !== undefined) cur[k] = v;
        }
    }
    return out;
}

function mapUsage(u: Json): Usage {
    const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0) || 0;
    const cacheWrite = Number(u.prompt_tokens_details?.cache_write_tokens ?? 0) || 0;
    const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
    return {
        inputTokens: Math.max(0, prompt - cached - cacheWrite),
        outputTokens: Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0,
        cacheReadTokens: cached,
        cacheWriteTokens: cacheWrite,
        reasoningTokens: Number(u.completion_tokens_details?.reasoning_tokens ?? 0) || undefined,
        cost: typeof u.cost === "number" ? u.cost : undefined,
    };
}

function mapFinish(f: string | undefined): StopReason {
    switch (f) {
        case "stop":
        case "end_turn":
            return "end_turn";
        case "tool_calls":
        case "function_call":
            return "tool_use";
        case "length":
            return "max_tokens";
        case "content_filter":
            return "refusal";
        case "error":
            return "error";
        case undefined:
            return "end_turn";
        default:
            return "other";
    }
}
