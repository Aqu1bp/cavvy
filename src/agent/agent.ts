// The agent loop: send the conversation to the model, run the tools it asks
// for (with permission checks), feed the results back, repeat until done.
//
// Invariants that keep every provider's prompt cache and Anthropic's
// preserved thinking valid:
//   - history is append-only; the system prompt and tool list are frozen
//   - mode changes and other harness notes are appended as reminder text
//   - every tool call gets exactly one tool result, even when interrupted
//   - an interrupted (partial) model response is discarded, never stored

import type {
    AssistantMessage,
    ChatRequest,
    ImagePart,
    Message,
    ModelInfo,
    ProviderClient,
    StreamEvent,
    TextPart,
    ToolCallPart,
    ToolResultPart,
    Usage,
    UserContent,
    UserMessage,
} from "../providers/types";
import { ProviderError, modelRef, textOf, toolCallsOf } from "../providers/types";
import type { Settings } from "../config/settings";
import type { PermissionMode } from "../permissions/modes";
import { MODE_INFO } from "../permissions/modes";
import type { Decision } from "../permissions/checker";
import { PermissionChecker } from "../permissions/checker";
import { AutoClassifier, type ReviewContext } from "../permissions/classifier";
import { sandboxKind, sandboxPolicy, type Sandbox } from "../permissions/sandbox";
import { harnessHome } from "../config/paths";
import type { Tool, ToolContext, ToolDisplay, ToolResult, ToolState, UiBridge } from "../tools/types";
import { isReadOnly } from "../tools/types";
import { coerceInput, validateInput, EXPLORE_TOOLS, toSchema } from "../tools/index";
import { isReadOnlyCommand } from "../permissions/bash-safety";
import { mcpToolMatches } from "../permissions/rules";
import { costOf, promptTokens, type CostEstimate } from "../providers/pricing";
import { Session } from "./session";
import { fireHooks, runHooks } from "./hooks";
import { compactRequestMessage, estimateTokens, summaryMessage, transcriptCompactRequest, transcriptText } from "./compact";
import { loadAgents } from "./agents";
import { buildSystemPrompt, EXPLORE_APPEND, SUBAGENT_CORE } from "./system-prompt";
import { FileHistory, promptNotes, resetToolState } from "./checkpoints";
import { redact } from "../util/redact";

// ---------------------------------------------------------------------------
// Host interface (implemented by the TUI and by headless mode)

export type AgentEvent =
    | { type: "request_start" }
    | { type: "text"; text: string }
    | { type: "thinking"; text: string }
    | { type: "tool_call_start"; id: string; name: string }
    | { type: "tool_call_delta"; id: string; partial: string }
    | { type: "server_tool"; name: string; detail: string }
    | { type: "assistant"; message: AssistantMessage }
    | { type: "tool_start"; call: ToolCallPart; title: string; tool?: Tool<any>; autoApproved?: string }
    | { type: "tool_progress"; id: string; text: string }
    | { type: "tool_approved"; id: string; reason: string; sandboxed?: boolean }
    | { type: "tool_end"; call: ToolCallPart; result: ToolResult; durationMs: number }
    | { type: "notice"; level: "info" | "warn" | "error"; message: string }
    | { type: "retry"; attempt: number; delayMs: number; reason: string }
    | { type: "usage"; usage: Usage; cost: CostEstimate; contextTokens: number }
    | { type: "compact_start"; auto: boolean }
    | { type: "compact_end"; summary: string }
    | { type: "subagent"; parentId: string; label: string; event: AgentEvent }
    | { type: "turn_end"; reason: TurnEndReason };

export type TurnEndReason = "done" | "aborted" | "error" | "denied" | "max_turns" | "blocked";

export interface PermissionRequest {
    tool: Tool<any>;
    input: any;
    title: string;
    decision: Decision;
    preview?: ToolDisplay;
    agentLabel?: string;
    /** The tool call waiting on the answer. */
    callId?: string;
    /** Why the auto-mode reviewer escalated. */
    classifierReason?: string;
}

export interface PermissionResponse {
    allow: boolean;
    /** Rules to add for "don't ask again". */
    rules?: string[];
    scope?: "session" | "local" | "project" | "user";
    setMode?: PermissionMode;
    feedback?: string;
}

export interface AgentHost {
    emit(e: AgentEvent): void;
    /** Missing in non-interactive mode: anything that needs approval is denied. */
    askPermission?(req: PermissionRequest): Promise<PermissionResponse>;
    /** Persist "don't ask again" rules. */
    saveRules?(rules: string[], scope: "local" | "project" | "user"): void;
    ui: UiBridge;
    /** Messages the user typed while the agent was busy. */
    drainQueued?(): string[];
}

export interface Helpers {
    /** One-shot completion on a cheap model (classifier, summaries). */
    complete?(system: string, prompt: string, signal?: AbortSignal): Promise<string>;
    webSearch?(query: string, signal: AbortSignal): Promise<string>;
    /** Resolve "provider:model" into a client (custom agents with their own model). */
    resolveModel?(ref: string): Promise<{ model: ModelInfo; client: ProviderClient } | undefined>;
}

export interface ModeRef {
    get(): PermissionMode;
    set(m: PermissionMode): void;
}

export interface AgentOptions {
    session: Session;
    model: ModelInfo;
    client: ProviderClient;
    settings: () => Settings;
    checker: PermissionChecker;
    classifier?: AutoClassifier;
    /** Fixed list, or a getter (MCP tools appear once their servers connect). */
    tools: Tool<any>[] | (() => Tool<any>[]);
    mode: ModeRef;
    toolState: ToolState;
    host: AgentHost;
    helpers?: Helpers;
    isSubagent?: boolean;
    /** A sub-agent's type and task, for its SubagentStop hooks. */
    subagent?: { type: string; description: string; parentSessionId: string };
    /** Read-only agent (explore): edits and state-changing commands are refused. */
    readOnly?: boolean;
    maxTurns?: number;
    /**
     * This run's --append-system-prompt. Added to the session's frozen system
     * prompt on each request rather than stored in it, so it also reaches a
     * resumed session and isn't kept by later runs without the flag.
     */
    appendSystemPrompt?: string;
    /** Use the provider's server-side web search when available. */
    nativeWebSearch?: boolean;
    /**
     * Sub-agents: what the developer asked the parent for. The child's own
     * session holds only the task the parent wrote, which authorizes nothing.
     */
    parentRequests?: () => Pick<ReviewContext, "requests" | "summary">;
    /** Sub-agents: the task the parent gave it. */
    delegatedTask?: string;
}

const MAX_RETRIES = 10;
/** Starts the text of a message the user sent while tools were running. */
const STEERING = "The user sent this message while you were working:\n";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new ProviderError("aborted"));
        const t = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(t);
            reject(new ProviderError("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function isAbort(e: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return true;
    const err = e as { name?: string; message?: string };
    return err?.name === "AbortError" || err?.message === "aborted";
}

function isContextOverflow(e: unknown): boolean {
    const err = e as ProviderError;
    const msg = String(err?.message ?? "") + String(err?.body ?? "");
    return (err?.status === 400 || err?.status === 413 || err?.status === undefined) && /prompt is too long|context.{0,20}(length|window|limit)|maximum context|too many (input )?tokens|input (is )?too long|exceeds the context|exceeds the maximum number of tokens/i.test(msg);
}

function reminder(text: string): TextPart {
    return { type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` };
}

export class Agent {
    readonly session: Session;
    model: ModelInfo;
    client: ProviderClient;
    readonly state: ToolState;
    private pendingReminders: string[] = [];
    /** additionalContext from PostToolUse hooks, sent along with the tool results. */
    private toolHookContext: string[] = [];
    private running = false;
    /** Prompt tokens of the most recent request (context usage). */
    contextTokens = 0;
    private lastUsageTotal = 0;
    /** The last few tool calls, for the auto-mode reviewer ("Bash: npm test"). */
    private recentActions: string[] = [];

    constructor(private o: AgentOptions) {
        this.session = o.session;
        this.model = o.model;
        this.client = o.client;
        this.state = o.toolState;
        // Edits are saved into this session's file history; sub-agents get their parent's.
        if (!o.isSubagent) this.state.fileHistory = FileHistory.for(o.session);
    }

    get tools(): Tool<any>[] {
        return typeof this.o.tools === "function" ? this.o.tools() : this.o.tools;
    }

    get busy(): boolean {
        return this.running;
    }

    get options(): AgentOptions {
        return this.o;
    }

    setModel(model: ModelInfo, client: ProviderClient) {
        this.model = model;
        this.client = client;
        this.session.setModel(modelRef(model));
    }

    /** Queue a note for the model, delivered with the next user message. */
    addReminder(text: string) {
        this.pendingReminders.push(text);
    }

    noteModeChange(from: PermissionMode, to: PermissionMode) {
        if (from === to) return;
        if (to === "plan") {
            this.addReminder(
                "Plan mode is now active. The user wants you to research and plan before changing anything. Do not edit files, run commands that change state, or commit; those tools will be refused. Explore with read-only tools, then present your plan with the ExitPlanMode tool. If the user only asked a question, just answer it.",
            );
        } else if (from === "plan") {
            this.addReminder(`Plan mode has ended. The permission mode is now "${MODE_INFO[to].label}"; you can make changes again.`);
        } else {
            this.addReminder(`The user switched the permission mode to "${MODE_INFO[to].label}": ${MODE_INFO[to].description}`);
        }
    }

    /** The system prompt as sent: the session's, plus --append-system-prompt. */
    systemPrompt(): string {
        const base = this.session.meta.system ?? "";
        const append = this.o.appendSystemPrompt;
        // Sessions frozen by older versions may end with it already, as its own paragraph.
        if (!append || base === append || base.endsWith(`\n\n${append}`)) return base;
        return base ? `${base}\n\n${append}` : append;
    }

    private toolSchemas() {
        return this.tools.map(toSchema);
    }

    private request(messages: Message[], signal: AbortSignal, extra: Partial<ChatRequest> = {}): ChatRequest {
        const s = this.o.settings();
        return {
            model: this.model,
            system: this.systemPrompt(),
            messages,
            tools: this.toolSchemas(),
            maxTokens: s.maxOutputTokens,
            effort: s.effort,
            showThinking: s.showThinking,
            signal,
            webSearch: this.o.nativeWebSearch,
            cacheKey: this.session.meta.id,
            ...extra,
        };
    }

    // -----------------------------------------------------------------------

    /** Run one user turn to completion. */
    async run(content: UserContent[], opts: { signal: AbortSignal; display?: string; kind?: "prompt" | "command" }): Promise<TurnEndReason> {
        if (this.running) throw new Error("Agent is already running");
        this.running = true;
        try {
            return await this.runInner(content, opts);
        } finally {
            this.running = false;
        }
    }

    private async runInner(content: UserContent[], opts: { signal: AbortSignal; display?: string; kind?: "prompt" | "command" }): Promise<TurnEndReason> {
        const { signal } = opts;
        const settings = this.o.settings();
        const promptText = content
            .filter((p): p is TextPart => p.type === "text")
            .map((p) => p.text)
            .join("\n");

        if (!this.o.isSubagent && settings.hooks?.UserPromptSubmit?.length) {
            const h = await runHooks(settings, "UserPromptSubmit", { prompt: promptText, session_id: this.session.meta.id }, this.state.cwd, signal).catch(() => undefined);
            for (const err of h?.errors ?? []) this.emit({ type: "notice", level: "warn", message: err });
            if (h?.blocked) {
                this.emit({ type: "notice", level: "warn", message: `Prompt blocked by hook: ${h.blocked}` });
                this.emit({ type: "turn_end", reason: "blocked" });
                return "blocked";
            }
            if (h?.additionalContext) this.addReminder(`Context from a UserPromptSubmit hook:\n${h.additionalContext}`);
        }

        const parts: UserContent[] = [...content];
        for (const r of this.pendingReminders.splice(0)) parts.push(reminder(r));
        this.session.push({ role: "user", content: parts, meta: { kind: opts.kind ?? "prompt", display: opts.display, checkpoint: this.checkpoint() } });

        let turns = 0;
        let maxTokenStrikes = 0;
        let pauses = 0;
        let stopHookRounds = 0;
        let overflowCompacted = false;
        const maxTurns = this.o.maxTurns ?? Infinity;

        while (true) {
            if (signal.aborted) return this.interrupted(false);
            if (++turns > maxTurns) {
                this.emit({ type: "notice", level: "warn", message: `Stopped after ${maxTurns} model turn${maxTurns === 1 ? "" : "s"} (max turns).` });
                this.emit({ type: "turn_end", reason: "max_turns" });
                return "max_turns";
            }

            if (this.shouldAutoCompact()) {
                const ok = await this.compact({ auto: true, signal, continuing: true }).catch((e) => {
                    if (isAbort(e, signal)) throw e;
                    this.emit({ type: "notice", level: "warn", message: `Auto-compact failed: ${(e as Error).message}` });
                    return false;
                });
                if (ok) overflowCompacted = true;
            }

            let msg: AssistantMessage;
            try {
                msg = await this.callModel(signal);
            } catch (e) {
                if (isAbort(e, signal)) return this.interrupted(false);
                if (isContextOverflow(e) && !overflowCompacted) {
                    overflowCompacted = true;
                    this.emit({ type: "notice", level: "warn", message: "The conversation exceeded the model's context window; compacting and retrying." });
                    try {
                        if (await this.compact({ auto: true, signal, continuing: true })) continue;
                    } catch (ce) {
                        if (isAbort(ce, signal)) return this.interrupted(false);
                    }
                }
                this.emit({ type: "notice", level: "error", message: redact((e as Error).message || String(e)) });
                this.emit({ type: "turn_end", reason: "error" });
                return "error";
            }

            // A provider that returns (rather than throws) after an abort hands
            // back a cut-off response; drop it like any other partial response.
            if (signal.aborted) return this.interrupted(false);

            // From here on, the redacted copy: it's what gets shown and what tools run with.
            msg = this.session.push(msg);
            this.emit({ type: "assistant", message: msg });
            if (msg.usage) this.recordUsage(msg.usage);

            const calls = toolCallsOf(msg);

            if (msg.stopReason === "pause_turn" && !calls.length && pauses++ < 5) continue;

            if (calls.length && (msg.stopReason === "max_tokens" || msg.stopReason === "refusal")) {
                // Inputs may be truncated (max_tokens) or the turn was declined: never run them.
                const why =
                    msg.stopReason === "max_tokens"
                        ? "Your response hit the output token limit, so this tool call may be incomplete and was not run. Retry it in smaller pieces (for large files, write a skeleton first and add the rest with Edit)."
                        : "This tool call was not run because the response was declined.";
                this.session.push({
                    role: "user",
                    content: calls.map((c) => ({ type: "tool_result", toolCallId: c.id, toolName: c.name, content: why, isError: true })),
                    meta: { kind: "tool_results" },
                });
                if (msg.stopReason === "refusal") {
                    this.emit({ type: "notice", level: "warn", message: "The model declined to continue this request." });
                    this.emit({ type: "turn_end", reason: "done" });
                    return "done";
                }
                if (++maxTokenStrikes >= 3) {
                    this.emit({ type: "notice", level: "error", message: "The model kept hitting the output token limit. Try raising maxOutputTokens or asking for smaller steps." });
                    this.emit({ type: "turn_end", reason: "error" });
                    return "error";
                }
                this.emit({ type: "notice", level: "warn", message: "Response hit the output token limit; asking the model to retry in smaller steps." });
                continue;
            }

            if (!calls.length) {
                if (msg.stopReason === "max_tokens") this.emit({ type: "notice", level: "warn", message: "Response was cut off at the output token limit." });
                else if (msg.stopReason === "refusal") this.emit({ type: "notice", level: "warn", message: "The model declined this request." });

                // Messages typed while the model was answering: deliver them now.
                const queued = this.o.host.drainQueued?.() ?? [];
                if (queued.length) {
                    this.session.push({ role: "user", content: [{ type: "text", text: queued.join("\n\n") }], meta: { kind: "prompt", display: queued.join("\n"), checkpoint: this.checkpoint() } });
                    continue;
                }

                const stopEvent = this.o.isSubagent ? "SubagentStop" : "Stop";
                if (settings.hooks?.[stopEvent]?.length && stopHookRounds < 3) {
                    const sub = this.o.subagent;
                    const payload = sub ? { session_id: sub.parentSessionId, agent_type: sub.type, description: sub.description } : { session_id: this.session.meta.id };
                    const h = await runHooks(this.o.settings(), stopEvent, { ...payload, last_message: textOf(msg) }, this.state.cwd, signal).catch(() => undefined);
                    for (const err of h?.errors ?? []) this.emit({ type: "notice", level: "warn", message: err });
                    if (h?.blocked) {
                        stopHookRounds++;
                        this.session.push({ role: "user", content: [reminder(`A ${stopEvent} hook asked you to keep going:\n${h.blocked}`)], meta: { kind: "reminder" } });
                        continue;
                    }
                }
                this.emit({ type: "turn_end", reason: "done" });
                return "done";
            }

            maxTokenStrikes = 0;
            const { results, denied } = await this.executeTools(calls, signal);
            const extra: UserContent[] = this.toolHookContext.splice(0).map(reminder);
            if (signal.aborted) extra.push({ type: "text", text: "[Request interrupted by user for tool use]" });
            else {
                const queued = this.o.host.drainQueued?.() ?? [];
                if (queued.length) extra.push({ type: "text", text: `${STEERING}${queued.join("\n\n")}` });
            }
            this.session.push({ role: "user", content: [...results, ...extra], meta: { kind: "tool_results" } });
            if (signal.aborted) {
                this.emit({ type: "turn_end", reason: "aborted" });
                return "aborted";
            }
            if (denied) {
                this.emit({ type: "turn_end", reason: "denied" });
                return "denied";
            }
        }
    }

    /** A new file checkpoint for a user prompt; a sub-agent's edits belong to its parent's. */
    private checkpoint(): number | undefined {
        return this.o.isSubagent ? undefined : this.state.fileHistory?.begin();
    }

    /**
     * Drop the history from message `index` (a prompt) on, for /rewind, with
     * what came from it: the context estimate, read state, todos, the approved
     * plan and the auto-mode reviewer's verdicts. Notes that went out with that
     * prompt were pending just before it, so they're queued again.
     */
    rewind(index: number) {
        if (this.running) throw new Error("Agent is already running");
        const prompt = this.session.messages[index];
        this.session.rewind(index);
        this.contextTokens = 0;
        this.lastUsageTotal = 0;
        resetToolState(this.state, this.session.messages);
        this.o.classifier?.clearCache();
        if (prompt?.role === "user") this.pendingReminders.unshift(...promptNotes(prompt));
        // The mode may have changed in the dropped turns: say what it is now.
        const mode = this.o.mode.get();
        if (mode === "plan") this.noteModeChange("default", "plan");
        else this.addReminder(`The permission mode is "${MODE_INFO[mode].label}": ${MODE_INFO[mode].description}`);
    }

    private interrupted(_duringTools: boolean): TurnEndReason {
        this.session.push({ role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }], meta: { kind: "interrupt" } });
        this.emit({ type: "turn_end", reason: "aborted" });
        return "aborted";
    }

    private emit(e: AgentEvent) {
        try {
            this.o.host.emit(e);
        } catch {
            // UI errors must not break the loop
        }
    }

    private recordUsage(usage: Usage) {
        const cost = costOf(usage, this.model);
        this.session.recordUsage(modelRef(this.model), usage, cost.usd);
        this.contextTokens = promptTokens(usage) + usage.outputTokens;
        this.lastUsageTotal = this.session.messages.length;
        this.emit({ type: "usage", usage, cost, contextTokens: this.contextTokens });
    }

    /** Estimated tokens in the next request. */
    estimatedContext(): number {
        const since = this.session.messages.slice(this.lastUsageTotal);
        if (!this.contextTokens) return estimateTokens(this.session.messages) + Math.ceil(this.systemPrompt().length / 3.5) + this.tools.length * 300;
        return this.contextTokens + estimateTokens(since);
    }

    private shouldAutoCompact(): boolean {
        const s = this.o.settings();
        if (s.autoCompact === false || this.o.isSubagent) return false;
        const window = this.model.contextWindow;
        if (!window) return false;
        const reserve = Math.min(this.model.maxOutput ?? 32_000, 32_000);
        const threshold = s.autoCompactThreshold ?? 0.92;
        return this.session.messages.length > 4 && this.estimatedContext() > (window - reserve) * threshold;
    }

    // -----------------------------------------------------------------------
    // Model calls with retries

    private async callModel(signal: AbortSignal, extra: Partial<ChatRequest> = {}, messages?: Message[]): Promise<AssistantMessage> {
        for (let attempt = 1; ; attempt++) {
            this.emit({ type: "request_start" });
            try {
                return await this.client.stream(this.request(messages ?? this.session.messages, signal, extra), (e: StreamEvent) => this.forward(e));
            } catch (e) {
                if (isAbort(e, signal)) throw new ProviderError("aborted");
                const pe = e instanceof ProviderError ? e : new ProviderError((e as Error)?.message ?? String(e), undefined, false);
                if (!pe.retryable || attempt >= MAX_RETRIES) throw pe;
                const base = Math.min(32_000, 1000 * 2 ** (attempt - 1));
                const delay = Math.min(60_000, pe.retryAfterMs ?? Math.round(base * (0.75 + Math.random() * 0.5)));
                this.emit({ type: "retry", attempt, delayMs: delay, reason: redact(pe.message) });
                await sleep(delay, signal);
            }
        }
    }

    private forward(e: StreamEvent) {
        switch (e.type) {
            case "text":
            case "thinking":
            case "tool_call_start":
            case "tool_call_delta":
            case "server_tool":
                this.emit(e);
                break;
            case "notice":
                this.emit({ type: "notice", level: "info", message: e.message });
                break;
            case "retry":
                this.emit(e);
                break;
        }
    }

    // -----------------------------------------------------------------------
    // Compaction

    /** Summarize the history and replace it. Returns false if there was nothing to do. */
    async compact(opts: { auto: boolean; signal: AbortSignal; instructions?: string; continuing?: boolean }): Promise<boolean> {
        const history = this.session.messages;
        if (history.length < 2) return false;
        this.emit({ type: "compact_start", auto: opts.auto });
        if (!this.o.isSubagent) {
            const warn = (message: string) => this.emit({ type: "notice", level: "warn", message });
            await fireHooks(this.o.settings(), "PreCompact", { session_id: this.session.meta.id, trigger: opts.auto ? "auto" : "manual", custom_instructions: opts.instructions ?? "" }, this.state.cwd, warn, opts.signal);
        }
        const req = [...history, compactRequestMessage(opts.instructions)];
        let summary = "";
        try {
            // Same system prompt and tools as the session, so the cached prefix is reused.
            const res = await this.client.stream(this.request(req, opts.signal, { maxTokens: 16_000 }), () => {});
            summary = textOf(res);
            if (res.usage) {
                const cost = costOf(res.usage, this.model);
                this.session.recordUsage(modelRef(this.model), res.usage, cost.usd);
            }
        } catch (e) {
            if (isAbort(e, opts.signal)) throw e;
            if (!isContextOverflow(e)) throw e;
        }
        if (!summary.trim()) {
            // Too long even to summarize, or the model only called tools:
            // summarize a condensed text transcript instead, without tools.
            const window = this.model.contextWindow;
            const maxOut = window ? Math.min(16_000, Math.floor(window / 4)) : 16_000;
            // ~2.5 characters per token leaves room for code and JSON.
            const maxChars = window ? Math.max(2_000, Math.min(400_000, Math.floor((window - maxOut - 2_000) * 2.5))) : 100_000;
            const transcript = transcriptText(history, maxChars);
            if (!transcript.trim()) throw new Error("Nothing in the conversation to summarize");
            const req = this.request([transcriptCompactRequest(transcript, opts.instructions)], opts.signal, {
                system: "You summarize conversations between a user and an AI coding assistant so the work can continue in a fresh context.",
                tools: [],
                maxTokens: maxOut,
                lightweight: true,
            });
            const res = await this.client.stream(req, () => {});
            summary = textOf(res);
        }
        if (!summary.trim()) throw new Error("The model returned an empty summary");
        const keep: Message[] = [summaryMessage(summary, Boolean(opts.continuing))];
        this.session.compact(summary, keep);
        this.contextTokens = 0;
        this.lastUsageTotal = 0;
        this.state.fileState.clear();
        this.emit({ type: "compact_end", summary });
        return true;
    }

    // -----------------------------------------------------------------------
    // Tools

    private findTool(name: string): Tool<any> | undefined {
        return this.tools.find((t) => t.name === name);
    }

    private toolContext(callId: string, signal: AbortSignal, sandbox?: Sandbox): ToolContext {
        return {
            sandbox,
            state: this.state,
            settings: this.o.settings(),
            signal,
            mode: () => this.o.mode.get(),
            setMode: (m) => {
                const from = this.o.mode.get();
                this.o.mode.set(m);
                // ExitPlanMode reports the change in its own result.
                if (from !== "plan") this.noteModeChange(from, m);
            },
            onProgress: (text) => this.emit({ type: "tool_progress", id: callId, text }),
            ui: this.o.host.ui,
            hidden: (toolName, abs) => this.o.checker.hiddenFromSearch(toolName, abs),
            runSubagent: this.o.isSubagent ? undefined : (opts, sig) => this.runSubagent(callId, opts, sig),
            webSearch: this.o.helpers?.webSearch,
            summarize: this.o.helpers?.complete
                ? (content, prompt, sig) =>
                      this.o.helpers!.complete!(
                          "You extract information from web pages. Answer the request using only the page content provided. Be concise; quote exact values, code and URLs where relevant.",
                          `Request: ${prompt}\n\nPage content:\n${content}`,
                          sig,
                      )
                : undefined,
        };
    }

    private concurrent(tool: Tool<any> | undefined, input: unknown): boolean {
        if (!tool) return true;
        if (tool.name === "Task") return true;
        try {
            return isReadOnly(tool, input);
        } catch {
            return false;
        }
    }

    private async executeTools(calls: ToolCallPart[], signal: AbortSignal): Promise<{ results: ToolResultPart[]; denied: boolean }> {
        const results = new Map<string, ToolResultPart>();
        let denied = false;
        let i = 0;
        while (i < calls.length) {
            // A batch: consecutive concurrency-safe calls, or a single other call.
            const batch: ToolCallPart[] = [];
            const first = calls[i]!;
            if (this.concurrent(this.findTool(first.name), first.input)) {
                while (i < calls.length && this.concurrent(this.findTool(calls[i]!.name), calls[i]!.input)) batch.push(calls[i++]!);
            } else batch.push(calls[i++]!);

            const approved: { call: ToolCallPart; tool: Tool<any>; input: any; auto?: string; sandbox?: boolean }[] = [];
            for (const call of batch) {
                if (denied || signal.aborted) break;
                const prep = await this.prepare(call, signal);
                if ("result" in prep) {
                    results.set(call.id, prep.result);
                    if (prep.stop) denied = true;
                } else approved.push({ call, ...prep });
            }
            if (signal.aborted) break;
            await Promise.all(approved.map(async (a) => results.set(a.call.id, await this.runTool(a.call, a.tool, a.input, signal, a.auto, a.sandbox))));
            if (denied || signal.aborted) break;
        }
        const out: ToolResultPart[] = calls.map(
            (c) =>
                results.get(c.id) ?? {
                    type: "tool_result",
                    toolCallId: c.id,
                    toolName: c.name,
                    content: signal.aborted ? "Interrupted by user before this tool ran." : "Not run: the user rejected an earlier tool call in this batch.",
                    isError: true,
                },
        );
        return { results: out, denied };
    }

    private errorResult(call: ToolCallPart, content: string, display?: ToolDisplay): ToolResultPart {
        const r: ToolResult = { content, isError: true, display };
        this.emit({ type: "tool_end", call, result: r, durationMs: 0 });
        return { type: "tool_result", toolCallId: call.id, toolName: call.name, content, isError: true };
    }

    /** Validate and get permission. Either an approved job or a ready result. */
    private async prepare(
        call: ToolCallPart,
        signal: AbortSignal,
    ): Promise<{ tool: Tool<any>; input: any; auto?: string; sandbox?: boolean } | { result: ToolResultPart; stop?: boolean }> {
        const tool = this.findTool(call.name);
        if (!tool) {
            this.emit({ type: "tool_start", call, title: call.name });
            return { result: this.errorResult(call, `No such tool: ${call.name}. Available tools: ${this.tools.map((t) => t.name).join(", ")}`) };
        }
        let input: any = coerceInput(tool, call.input ?? {});
        let title = call.name;
        try {
            title = tool.title(input);
        } catch {
            // keep the bare name
        }
        this.emit({ type: "tool_start", call, title, tool });

        const schemaErr = validateInput(tool, input);
        if (schemaErr) return { result: this.errorResult(call, `Invalid input for ${tool.name}: ${schemaErr}`) };
        const ctx = this.toolContext(call.id, signal);
        try {
            const err = await tool.validate?.(input, ctx);
            if (err) return { result: this.errorResult(call, err) };
        } catch (e) {
            return { result: this.errorResult(call, `Validation failed: ${(e as Error).message}`) };
        }

        // Read-only agents (explore) never change anything.
        if (this.o.readOnly) {
            const writes = tool.category === "edit" || (tool.name === "Bash" && !isReadOnlyCommand(String(input.command ?? ""))) || tool.category === "mcp" && !isReadOnly(tool, input);
            if (writes) return { result: this.errorResult(call, "This is a read-only agent: that action isn't allowed. Report what should be changed instead.") };
        }

        const settings = this.o.settings();
        let hookDecision: "allow" | "deny" | "ask" | undefined;
        if (settings.hooks?.PreToolUse?.length) {
            const h = await runHooks(settings, "PreToolUse", { tool_name: tool.name, tool_input: input, session_id: this.session.meta.id }, this.state.cwd, signal).catch(() => undefined);
            for (const err of h?.errors ?? []) this.emit({ type: "notice", level: "warn", message: err });
            if (h?.blocked) return { result: this.errorResult(call, `Blocked by PreToolUse hook: ${h.blocked}`) };
            hookDecision = h?.decision;
            if (hookDecision === "deny") return { result: this.errorResult(call, `Denied by PreToolUse hook${h?.reason ? `: ${h.reason}` : ""}`) };
        }

        const mode = this.o.mode.get();
        const decision = this.o.checker.check(tool, input, mode, this.state.cwd);
        if (decision.behavior === "deny") return { result: this.errorResult(call, decision.reason ?? "Permission denied") };
        // Whatever approves it, a command the checker sandboxed stays sandboxed.
        const sandbox = decision.sandbox;
        if (decision.behavior === "allow" && hookDecision !== "ask") return { tool, input, sandbox, auto: sandbox ? "sandboxed" : undefined };
        if (hookDecision === "allow" && !decision.dangerous) return { tool, input, sandbox, auto: "hook" };

        let classifierReason: string | undefined;
        // A hook that asked wants the user, not the auto-mode reviewer.
        if (decision.needsClassifier && !decision.dangerous && hookDecision !== "ask" && this.o.classifier) {
            try {
                const v = await this.o.classifier.classify({ toolName: tool.name, input, cwd: this.state.cwd, context: this.reviewContext(), sandboxed: sandbox }, signal);
                if (v.warning) this.emit({ type: "notice", level: "warn", message: v.warning });
                if (v.decision === "allow") return { tool, input, sandbox, auto: v.reason };
                classifierReason = v.reason;
            } catch (e) {
                if (isAbort(e, signal)) return { result: this.errorResult(call, "Interrupted") };
            }
        }

        if (!this.o.host.askPermission) {
            return {
                result: this.errorResult(
                    call,
                    `Permission to use ${tool.name} was not granted (non-interactive session). ${decision.reason ?? ""} Allow it with --allowedTools, a permission rule, or --permission-mode.`.trim(),
                ),
            };
        }

        let preview: ToolDisplay | undefined;
        try {
            preview = await tool.preview?.(input, ctx);
        } catch {
            // preview is optional
        }
        const answer = await this.o.host.askPermission({ tool, input, title, decision, preview, classifierReason, agentLabel: this.o.isSubagent ? "sub-agent" : undefined, callId: call.id });
        if (signal.aborted) return { result: this.errorResult(call, "Interrupted by user") };
        if (answer.setMode) {
            const from = this.o.mode.get();
            this.o.mode.set(answer.setMode);
            this.noteModeChange(from, answer.setMode);
        }
        if (answer.rules?.length) {
            if (answer.scope === "session" || !answer.scope) this.o.checker.sessionAllow.push(...answer.rules);
            else {
                this.o.checker.sessionAllow.push(...answer.rules);
                this.o.host.saveRules?.(answer.rules, answer.scope);
            }
        }
        if (answer.allow) return { tool, input, sandbox };
        const fb = answer.feedback?.trim();
        if (fb) {
            return { result: this.errorResult(call, `The user declined this tool call and said:\n${fb}`) };
        }
        return {
            result: this.errorResult(call, "The user declined this tool call. Stop and wait for the user to tell you how to proceed; don't retry it."),
            stop: true,
        };
    }

    private async runTool(call: ToolCallPart, tool: Tool<any>, input: any, signal: AbortSignal, auto?: string, sandboxed?: boolean): Promise<ToolResultPart> {
        const started = Date.now();
        this.noteAction(tool, input);
        if (auto) this.emit({ type: "tool_approved", id: call.id, reason: auto, sandboxed });
        let sandbox: Sandbox | undefined;
        if (sandboxed) {
            const kind = sandboxKind();
            // Approved on the condition that it's contained: never fall back to running it bare.
            if (!kind) return this.errorResult(call, "The sandbox this command was approved for isn't available. Run it with dangerouslyDisableSandbox: true to have it reviewed instead.");
            sandbox = { kind, policy: sandboxPolicy(this.o.checker.workspaceRoots(), { harnessHome: harnessHome() }) };
        }
        let result: ToolResult;
        try {
            result = await tool.run(input, this.toolContext(call.id, signal, sandbox));
        } catch (e) {
            result = signal.aborted ? { content: "Interrupted by user", isError: true } : { content: `Tool error: ${redact((e as Error).message ?? String(e))}`, isError: true };
        }
        const settings = this.o.settings();
        if (settings.hooks?.PostToolUse?.length && !signal.aborted) {
            const h = await runHooks(settings, "PostToolUse", { tool_name: tool.name, tool_input: input, tool_response: { content: result.content.slice(0, 20_000), is_error: Boolean(result.isError) }, session_id: this.session.meta.id }, this.state.cwd, signal).catch(() => undefined);
            for (const err of h?.errors ?? []) this.emit({ type: "notice", level: "warn", message: err });
            if (h?.blocked) result = { ...result, content: `${result.content}\n\nPostToolUse hook feedback:\n${h.blocked}` };
            if (h?.additionalContext) this.toolHookContext.push(`Context from a PostToolUse hook (${tool.name}):\n${h.additionalContext}`);
        }
        this.emit({ type: "tool_end", call, result, durationMs: Date.now() - started });
        return {
            type: "tool_result",
            toolCallId: call.id,
            toolName: call.name,
            content: result.content,
            images: result.images as ImagePart[] | undefined,
            isError: result.isError,
        };
    }

    /**
     * What the developer asked for: their last few messages (prompts and the
     * slash commands they ran), plus the compaction summary when their
     * earlier messages were folded into one. The summary is the model's
     * writing, so the reviewer is told not to treat it as the developer's.
     */
    requestContext(): Pick<ReviewContext, "requests" | "summary"> {
        const requests: string[] = [];
        let summary: string | undefined;
        for (let i = this.session.messages.length - 1; i >= 0; i--) {
            const m = this.session.messages[i]!;
            if (m.role !== "user") continue;
            const kind = m.meta?.kind;
            const text = () => textOf(m).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
            if (kind === "summary") {
                summary = text() || undefined;
                break;
            }
            if (requests.length < 3 && (kind === "prompt" || kind === "command" || !m.meta)) {
                const t = text();
                if (t) requests.unshift(kind === "command" && m.meta?.display ? `(ran ${m.meta.display})\n${t}` : t);
            }
            // Messages the developer sent while tools ran ride along with the results.
            if (requests.length < 3 && kind === "tool_results") {
                const sent = m.content.flatMap((p) => (p.type === "text" && p.text.startsWith(STEERING) ? [p.text.slice(STEERING.length).trim()] : [])).filter(Boolean);
                if (sent.length) requests.unshift(sent.join("\n\n"));
            }
        }
        return { requests, summary };
    }

    private reviewContext(): ReviewContext {
        if (this.o.parentRequests) return { ...this.o.parentRequests(), delegatedTask: this.o.delegatedTask, recentActions: [...this.recentActions] };
        return { ...this.requestContext(), recentActions: [...this.recentActions] };
    }

    private noteAction(tool: Tool<any>, input: any) {
        const i = (input ?? {}) as Record<string, unknown>;
        const what = i.command ?? i.file_path ?? i.notebook_path ?? i.url ?? i.pattern ?? i.path ?? i.query ?? JSON.stringify(input ?? {});
        this.recentActions.push(`${tool.name}: ${String(what).replace(/\s+/g, " ").slice(0, 300)}`);
        if (this.recentActions.length > 8) this.recentActions.shift();
    }

    // -----------------------------------------------------------------------
    // Sub-agents (Task tool)

    private async runSubagent(callId: string, opts: { description: string; prompt: string; agentType?: string }, signal: AbortSignal): Promise<string> {
        const type = opts.agentType || "general-purpose";
        const defs = loadAgents(this.state.projectRoot);
        const def = defs.find((a) => a.name === type);
        if (!def) return `Unknown agent type "${type}". Available: ${defs.map((d) => d.name).join(", ")}`;

        let model = this.model;
        let client = this.client;
        if (def.model && this.o.helpers?.resolveModel) {
            const r = await this.o.helpers.resolveModel(def.model);
            if (r) ({ model, client } = r);
        }

        const exclude = new Set(["Task", "TodoWrite", "AskUserQuestion", "ExitPlanMode"]);
        let tools = this.tools.filter((t) => !exclude.has(t.name));
        if (def.readOnly) tools = tools.filter((t) => EXPLORE_TOOLS.has(t.name) || (t.category === "mcp" && t.readOnly === true));
        if (def.tools?.length) {
            const allow = new Set(def.tools);
            tools = tools.filter((t) => allow.has(t.name) || [...allow].some((a) => mcpToolMatches(a, t.name)));
        }

        const system = buildSystemPrompt({
            cwd: this.state.projectRoot,
            model,
            replaceCore: def.prompt ? `${SUBAGENT_CORE}\n\n${def.prompt}` : SUBAGENT_CORE,
            append: def.readOnly ? EXPLORE_APPEND : undefined,
            includeGit: false,
        });
        const session = Session.create(this.state.projectRoot, { persist: false, system });
        const label = opts.description;
        const parentHost = this.o.host;
        const child = new Agent({
            ...this.o,
            session,
            model,
            client,
            tools,
            isSubagent: true,
            parentRequests: () => this.requestContext(),
            delegatedTask: opts.prompt,
            subagent: { type, description: label, parentSessionId: this.session.meta.id },
            readOnly: def.readOnly,
            maxTurns: 200,
            appendSystemPrompt: undefined,
            nativeWebSearch: this.o.nativeWebSearch && model.provider === this.model.provider,
            toolState: {
                cwd: this.state.cwd,
                projectRoot: this.state.projectRoot,
                fileState: new Map(this.state.fileState),
                todos: [],
                shells: this.state.shells,
                fileHistory: this.state.fileHistory,
            },
            host: {
                emit: (e) => parentHost.emit({ type: "subagent", parentId: callId, label, event: e }),
                askPermission: parentHost.askPermission ? (req) => parentHost.askPermission!({ ...req, agentLabel: label }) : undefined,
                saveRules: parentHost.saveRules,
                ui: {},
            },
        });
        const reason = await child.run([{ type: "text", text: opts.prompt }], { signal });
        // Fold the child's spend into the parent session's totals.
        for (const [m, u] of session.usageByModel) this.session.recordUsage(m, u.usage, u.cost);
        if (reason === "aborted") return "The sub-agent was interrupted by the user.";
        const last = [...session.messages].reverse().find((m) => m.role === "assistant");
        const report = last ? textOf(last).trim() : "";
        if (reason === "error") return `The sub-agent stopped with an error.${report ? ` Its last message:\n${report}` : ""}`;
        return report || "(The sub-agent finished without a report.)";
    }
}
