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
import { ProviderError, modelRef, parseModelRef, textOf, toolCallsOf } from "../providers/types";
import type { Effort, Settings } from "../config/settings";
import type { ApprovedMcpServers } from "../mcp/manager";
import type { PermissionMode } from "../permissions/modes";
import { MODE_INFO } from "../permissions/modes";
import type { Decision } from "../permissions/checker";
import { PermissionChecker } from "../permissions/checker";
import { AutoClassifier, type ReviewContext } from "../permissions/classifier";
import { sandboxKind, sandboxPolicy, type Sandbox } from "../permissions/sandbox";
import { APP_TITLE, harnessHome } from "../config/paths";
import type { Tool, ToolContext, ToolDisplay, ToolResult, ToolState, UiBridge } from "../tools/types";
import { isReadOnly } from "../tools/types";
import { coerceInput, validateInput, EXPLORE_TOOLS, toSchema } from "../tools/index";
import { isReadOnlyCommand, notReadOnly } from "../permissions/bash-safety";
import { mcpToolMatches } from "../permissions/rules";
import { costOf, promptTokens, type CostEstimate } from "../providers/pricing";
import { Session } from "./session";
import { fireHooks, runHooks } from "./hooks";
import { compactRequestMessage, estimateTokens, summaryMessage, transcriptCompactRequest, compactTranscriptText, handoffTranscript } from "./compact";
import { loadAgents } from "./agents";
import { buildSystemPrompt, EXPLORE_APPEND, SUBAGENT_CORE } from "./system-prompt";
import { FileHistory, promptNotes, resetToolState } from "./checkpoints";
import { TurnSnapshots } from "./turn-snapshots";
import { redact } from "../util/redact";
import { isAgentBackend, type AgentBackendClient, type BackendHost, type BackendPermission, type BackendResult, type BackendTurn, type OrchestratorServer, type PermissionAnswer } from "../backends/types";
import { getProvider } from "../providers/registry";
import { forBackend, pastedTexts, readsPdf } from "../providers/files";
import { cachedListings, type ProviderListing } from "../providers/models";
import { registerTools, type Registration, type ServerTool, type ServerToolResult } from "../mcp/server";
import { SECRET_INSTRUCTIONS, secretTools, secretToolTitle } from "./secret-tools";
import { BashTool } from "../tools/bash";
import {
    DELEGATE_TOOL,
    DELEGATION_LIMITS,
    MCP_SERVER_NAME,
    Delegations,
    catalog,
    delegationAvailable,
    inheritedEffort,
    orchestrationInstructions,
    orchestratorTitle,
    orchestratorTools,
    taskReport,
    type ChildRequest,
    type ChildResult,
    type DelegatedTask,
} from "./delegation";
import { suggestBashRules } from "../permissions/bash-safety";
import { trustedByUser } from "../config/trust";
import { deniedWithin } from "../permissions/rules";
import { expandPath } from "../util/files";
import type { PlanLimits } from "../server/protocol";

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
    | { type: "tool_end"; call: ToolCallPart; result: ToolResult; durationMs: number; /** Its title now, when what it did was only known at its end (a backend's web search). */ title?: string }
    | { type: "notice"; level: "info" | "warn" | "error"; message: string }
    | { type: "retry"; attempt: number; delayMs: number; reason: string }
    | { type: "usage"; usage: Usage; cost: CostEstimate; contextTokens: number }
    | { type: "compact_start"; auto: boolean }
    | { type: "compact_end"; summary: string }
    | { type: "subagent"; parentId: string; label: string; event: AgentEvent }
    /** An agent CLI reported the user's plan limits (`partial`: earlier windows it left out still stand). */
    | { type: "limits"; limits: PlanLimits; partial: boolean }
    /** The commands an agent CLI says it runs itself (Claude Code's skills and built-ins). */
    | { type: "cli_commands"; provider: string; names: string[] }
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
    /** Ends when the request no longer matters (its sub-agent was stopped): the prompt is withdrawn. */
    signal?: AbortSignal;
    /** run_with_secrets: the secrets the command gets in its environment, by name. Prompts show them. */
    secrets?: string[];
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
    /** Read the current manager at each turn (including after approval changes). */
    approvedMcpServers?: () => ApprovedMcpServers;
    checker: PermissionChecker;
    classifier?: AutoClassifier;
    /** Fixed list, or a getter (MCP tools appear once their servers connect). */
    tools: Tool<any>[] | (() => Tool<any>[]);
    mode: ModeRef;
    toolState: ToolState;
    host: AgentHost;
    helpers?: Helpers;
    isSubagent?: boolean;
    /** Current folder trust; private working-tree snapshots require it. */
    trusted?: () => boolean;
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
    /** Sub-agents: the parent session's speed choice, read each request (a background task follows a later change). */
    parentFastMode?: () => boolean | undefined;
    /** The model catalog as the host last listed it (local servers aren't cached); the cache by default. */
    listings?: () => ProviderListing[];
}

const MAX_RETRIES = 10;
/** Requests that got nothing back for minutes (sse.ts) are tried this many more times. */
const MAX_STALL_RETRIES = 2;
/** After the results of tools a turn was stopped in. */
const TOOL_INTERRUPT = "[Request interrupted by user for tool use]";
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

/** The shared background-shell list, noting the ids of the shells added through it. */
function trackShells<V>(shells: Map<string, V>, added: Set<string>): Map<string, V> {
    return new Proxy(shells, {
        get(target, p) {
            if (p === "set") return (k: string, v: V) => (added.add(k), target.set(k, v));
            const v = Reflect.get(target, p, target);
            return typeof v === "function" ? v.bind(target) : v;
        },
    });
}

/** The promise's value, or `fallback` once the signal ends. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal, fallback: T): Promise<T> {
    if (signal.aborted) return Promise.resolve(fallback);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<T>((r) => {
        onAbort = () => r(fallback);
        signal.addEventListener("abort", onAbort, { once: true });
    });
    return Promise.race([p, aborted]).finally(() => signal.removeEventListener("abort", onAbort!));
}

/** What the agent hears when the auto-mode reviewer blocks an action. */
export function blockedByReviewer(reason: string): string {
    return `Auto mode's safety reviewer blocked this: ${reason || "it isn't routine"}\nDon't try to get the same result another way (another command, a script, a split or encoded form): that will be blocked too. If a clearly safer approach does the job, take it; if not, stop and tell the user what you need and why.`;
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

/**
 * What a read-only agent hears when it tries to change something. For a
 * command: what in it isn't read-only (so it doesn't send the same command
 * again), and which ones do run.
 */
function readOnlyRefusal(toolName: string, command?: string, why?: string): string {
    if (toolName !== "Bash") return "This is a read-only agent: that action isn't allowed. Report what should be changed instead.";
    const what = why ?? (command !== undefined ? notReadOnly(command) : undefined);
    return `This is a read-only agent, and ${what ?? "this command isn't read-only"}. Only read-only commands run: plain commands such as cat, rg, wc or git log, and pipes of them, with no loops, subshells, $(…) or > redirects. Tests, builds and scripts don't run either. Leave out or replace just that part, or report what should be run or changed instead.`;
}

/** For a backend whose last turn was stopped without its knowing (Harness was closed or died while it worked). */
const BACKEND_CUT_OFF = "Your last turn in this session was cut off: Harness stopped while you were working (it was closed, or it crashed), so that turn may not have finished what it set out to do.";

function reminder(text: string): TextPart {
    return { type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` };
}

/** Notes that say where something is now: only the latest of each kind matters. */
type StateKind = "mode" | "model";

interface PendingNote {
    text: string;
    kind?: StateKind;
    /** For a state note: where it was when the model last heard ("" when that's unknown, after a rewind). */
    from?: string;
}

const PLAN_NOTE =
    "Plan mode is now active. The user wants you to research and plan before changing anything. Do not edit files, run commands that change state, or commit; those tools will be refused. Explore with read-only tools, then present your plan with the ExitPlanMode tool. If the user only asked a question, just answer it.";

/** What the model hears when the mode went from `from` (as it last heard) to `to`. */
function modeNote(from: string, to: PermissionMode): string {
    if (to === "plan") return PLAN_NOTE;
    if (from === "plan") return `Plan mode has ended. The permission mode is now "${MODE_INFO[to].label}"; you can make changes again.`;
    return `The user switched the permission mode to "${MODE_INFO[to].label}": ${MODE_INFO[to].description}`;
}

/** Which state a note (a reminder's text) reports, this version's wording or an earlier one's. */
function stateKind(note: string): StateKind | undefined {
    if (/^(Plan mode is now active\.|Plan mode has ended\.|The user switched the permission mode to |The permission mode is ")/.test(note)) return "mode";
    if (/^(The user switched the model to |You are running as )/.test(note)) return "model";
    return undefined;
}

/**
 * A message without its notes on the mode or model: in the transcript a
 * backend is given of turns it missed they're stale ("You are now running
 * as" another model), and its own turn says where things are now.
 */
function withoutStateNotes(m: Message): Message {
    if (m.role !== "user") return m;
    const content = m.content.filter((p) => p.type !== "text" || !promptNotes({ ...m, content: [p] }).some((n) => stateKind(n)));
    return content.length === m.content.length ? m : { ...m, content };
}

export class Agent {
    readonly session: Session;
    model: ModelInfo;
    client: ProviderClient;
    readonly state: ToolState;
    readonly turnSnapshots?: TurnSnapshots;
    private pendingReminders: PendingNote[] = [];
    /** Why the model call is being retried right now (shown if the user stops it meanwhile). */
    private retrying?: string;
    /** additionalContext from PostToolUse hooks, sent along with the tool results. */
    private toolHookContext: string[] = [];
    private running = false;
    /** The session is being let go; awaited checkpoints must not append another prompt or tool result. */
    private cutOff = false;
    /** This turn's prompt is in the session. */
    private prompted = false;
    /** Prompt tokens of the most recent request (context usage). */
    contextTokens = 0;
    private lastUsageTotal = 0;
    /** The last few tool calls, for the auto-mode reviewer ("Bash: npm test"). */
    private recentActions: string[] = [];
    /** Tasks a backend (Claude Code, Codex) delegated to other models through the harness's MCP tools. */
    private delegations?: Delegations;
    private registration?: Registration;
    /** What the harness MCP server offers this turn, and its instructions (read by the server on each request). */
    private serverTools: ServerTool[] = [];
    private serverInstructions = "";
    /** The backend's open delegate calls: a delegated agent's work shows under the call that started it. */
    private delegateCalls: { id: string; input: Record<string, unknown>; claimed: boolean }[] = [];
    private disposed = false;
    /** Sub-agents running now (Task, delegated tasks). */
    private children = new Set<Agent>();

    constructor(private o: AgentOptions) {
        this.session = o.session;
        this.model = o.model;
        this.client = o.client;
        this.state = o.toolState;
        // Edits are saved into this session's file history; sub-agents get their parent's.
        if (!o.isSubagent) {
            this.state.fileHistory = FileHistory.for(o.session);
            this.turnSnapshots = TurnSnapshots.for(o.session, this.state.cwd);
        }
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

    /** Take back a note of where the mode or model is that hasn't been sent. */
    dropStateNote(kind: StateKind) {
        this.pendingReminders = this.pendingReminders.filter((r) => r.kind !== kind);
    }

    /** Queue a note for the model, delivered with the next user message. */
    addReminder(text: string) {
        this.pendingReminders.push({ text });
    }

    /**
     * A note of where the mode or model is now, replacing one of the same kind
     * not sent yet: the model hears the current state once, not each step on
     * the way (and nothing if it's back where the model last heard it was).
     */
    private noteState(kind: StateKind, from: string, to: string, text: (from: string) => string) {
        const origin = this.pendingReminders.find((r) => r.kind === kind)?.from ?? from;
        this.pendingReminders = this.pendingReminders.filter((r) => r.kind !== kind);
        if (origin !== to) this.pendingReminders.push({ kind, from: origin, text: text(origin) });
    }

    noteModeChange(from: PermissionMode, to: PermissionMode) {
        if (from === to) return;
        // A backend turn in progress takes the new mode now (where the backend can), and so do
        // sub-agents running on Claude Code or Codex, each in its own mode (a read-only one stays read-only).
        if (this.running && isAgentBackend(this.client)) this.client.setMode(to);
        for (const c of this.children) if (isAgentBackend(c.client)) c.client.setMode(to);
        this.noteState("mode", from, to, (origin) => modeNote(origin, to));
    }

    /** The user picked another model (`from` is the one before, provider:id). */
    noteModelChange(from: string, to: ModelInfo) {
        const ref = modelRef(to);
        this.noteState("model", from, ref, () => `The user switched the model to ${to.name ?? to.id} (${ref}). You are now running as this model.`);
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

    /** Fast mode as chosen for this session (a sub-agent's is the speed its parent runs at). */
    private fastModeChoice(): boolean | undefined {
        return this.o.parentFastMode ? this.o.parentFastMode() : (this.session.fastMode ?? this.o.settings().fastMode);
    }

    /** The speed this agent runs at: as chosen, where its model has fast mode. */
    private fastMode(): boolean {
        return Boolean(this.fastModeChoice() && this.model.supportsFastMode);
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
            fastMode: this.fastMode(),
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
        this.prompted = false;
        // Interrupting a turn stops the delegated tasks still running, those in the background too
        // (delegated on an earlier turn, maybe before a switch to another model).
        const onAbort = () => this.cancelTasks();
        opts.signal.addEventListener("abort", onAbort, { once: true });
        try {
            return await this.runInner(content, opts);
        } finally {
            await this.turnSnapshots?.end();
            opts.signal.removeEventListener("abort", onAbort);
            this.running = false;
            this.prompted = false;
        }
    }

    private async runInner(content: UserContent[], opts: { signal: AbortSignal; display?: string; kind?: "prompt" | "command" }): Promise<TurnEndReason> {
        const { signal } = opts;
        const settings = this.o.settings();
        const promptText = [...content.filter((p): p is TextPart => p.type === "text").map((p) => p.text), ...pastedTexts(content)].join("\n");
        const checkpoint = await this.checkpoint(opts.display ?? promptText);
        if (this.cutOff) return "aborted";

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

        // Delegated tasks that ended during a turn on another model (not a backend's) go with this prompt.
        this.deliverTasks(false);
        const parts: UserContent[] = [...content];
        for (const r of this.pendingReminders.splice(0)) parts.push(reminder(r.text));
        const prompt = this.session.push({ role: "user", content: parts, meta: { kind: opts.kind ?? "prompt", display: opts.display, checkpoint } });
        this.prompted = true;

        // Claude Code, Codex: the backend runs the whole turn with its own tools (the prompt as stored: redacted).
        if (isAgentBackend(this.client)) return this.runBackend(this.client, prompt.content, signal);

        let turns = 0;
        let maxTokenStrikes = 0;
        let pauses = 0;
        let stopHookRounds = 0;
        let overflowCompacted = false;
        /** The model has said or done something this turn. */
        let answered = false;
        const maxTurns = this.o.maxTurns ?? Infinity;

        while (true) {
            if (signal.aborted) return this.interrupted(false);
            if (++turns > maxTurns) {
                this.endNotice("warn", `Stopped after ${maxTurns} model turn${maxTurns === 1 ? "" : "s"} (max turns).`);
                this.emit({ type: "turn_end", reason: "max_turns" });
                return "max_turns";
            }

            if (this.shouldAutoCompact()) {
                let ok = false;
                try {
                    ok = await this.compact({ auto: true, signal, continuing: true });
                } catch (e) {
                    // Stopped while compacting: an interrupt like any other, not an unexpected error.
                    if (isAbort(e, signal)) return this.interrupted(false);
                    this.emit({ type: "notice", level: "warn", message: `Auto-compact failed: ${(e as Error).message}` });
                }
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
                this.endNotice("error", redact((e as Error).message || String(e)));
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
            if (calls.length || textOf(msg).trim()) answered = true;

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
                    this.endNotice("warn", "The model declined to continue this request.");
                    this.emit({ type: "turn_end", reason: "done" });
                    return "done";
                }
                if (++maxTokenStrikes >= 3) {
                    this.endNotice("error", "The model kept hitting the output token limit. Try raising maxOutputTokens or asking for smaller steps.");
                    this.emit({ type: "turn_end", reason: "error" });
                    return "error";
                }
                this.emit({ type: "notice", level: "warn", message: "Response hit the output token limit; asking the model to retry in smaller steps." });
                continue;
            }

            if (!calls.length) {
                if (msg.stopReason === "max_tokens") this.endNotice("warn", "Response was cut off at the output token limit.");
                else if (msg.stopReason === "refusal") this.endNotice("warn", "The model declined this request.");
                // Nothing at all came back this turn: say so rather than end it blank.
                else if (!answered && !textOf(msg).trim()) this.endNotice("warn", `${this.model.name ?? this.model.id} sent back an empty response${msg.stopReason === "end_turn" ? "" : ` (stop reason: ${msg.stopReason})`}. Try again, or another model.`);

                // Messages typed while the model was answering: deliver them now.
                const queued = this.o.host.drainQueued?.() ?? [];
                if (queued.length) {
                    await this.checkpoint(queued.join("\n"), false, (checkpoint) => {
                        this.session.push({ role: "user", content: [{ type: "text", text: queued.join("\n\n") }], meta: { kind: "prompt", display: queued.join("\n"), checkpoint } });
                    });
                    if (this.cutOff) return "aborted";
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
            let recorded = false;
            const record = (checkpoint?: number) => {
                this.session.push({ role: "user", content: [...results, ...extra], meta: { kind: "tool_results", ...(checkpoint !== undefined ? { checkpoint } : {}) } });
                recorded = true;
            };
            if (!signal.aborted) {
                const queued = this.o.host.drainQueued?.() ?? [];
                if (queued.length) {
                    extra.push({ type: "text", text: `${STEERING}${queued.join("\n\n")}` });
                    await this.checkpoint(queued.join("\n"), true, record);
                }
            }
            if (this.cutOff) return "aborted";
            // Steering saved the completed results before its capture: an interrupt is a new message.
            if (signal.aborted && recorded) return this.interrupted(false);
            if (signal.aborted) extra.push({ type: "text", text: TOOL_INTERRUPT });
            if (!recorded) record();
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
    private async checkpoint(prompt: string, snapshotOnly = false, record?: (checkpoint: number | undefined) => void): Promise<number | undefined> {
        // Steering inside tool results isn't a /rewind target: keep its edit copies with the original prompt.
        const history = this.o.isSubagent ? undefined : this.state.fileHistory;
        const cp = snapshotOnly ? history?.nextId() : history?.begin();
        // Once drained, queued text must be on disk before a capture can yield to session shutdown.
        record?.(cp);
        if (cp !== undefined && this.o.trusted?.()) await this.turnSnapshots?.begin(cp, redact(prompt));
        return cp;
    }

    /**
     * Drop the history from message `index` (a prompt) on, for /rewind, with
     * what came from it: the context estimate, read state, todos, the approved
     * plan and the auto-mode reviewer's verdicts. Notes that went out with that
     * prompt were pending just before it, so they're queued again.
     */
    rewind(index: number) {
        if (this.running) throw new Error("Agent is already running");
        const dropped = this.session.messages.slice(index);
        const prompt = dropped[0];
        this.session.rewind(index);
        this.contextTokens = 0;
        this.lastUsageTotal = 0;
        resetToolState(this.state, this.session.messages);
        this.o.classifier?.clearCache();
        // Notes about the mode or model aren't queued again as they were: what's current is said instead.
        const notes = prompt?.role === "user" ? promptNotes(prompt) : [];
        this.pendingReminders.unshift(...notes.filter((n) => !stateKind(n)).map((text) => ({ text })));
        // The mode may have changed in the dropped turns: say what it is now.
        const mode = this.o.mode.get();
        this.pendingReminders = this.pendingReminders.filter((r) => r.kind !== "mode");
        this.pendingReminders.push({ kind: "mode", from: "", text: mode === "plan" ? modeNote("", "plan") : `The permission mode is "${MODE_INFO[mode].label}": ${MODE_INFO[mode].description}` });
        // So may the model, if a dropped prompt told it of a switch (a switch since is still queued).
        const switched = dropped.some((m) => m.role === "user" && promptNotes(m).some((n) => stateKind(n) === "model"));
        if (switched && !this.pendingReminders.some((r) => r.kind === "model")) {
            this.pendingReminders.push({ kind: "model", from: "", text: `You are running as ${this.model.name ?? this.model.id} (${modelRef(this.model)}).` });
        }
    }

    private interrupted(_duringTools: boolean): TurnEndReason {
        // Stopped while waiting to try again: what it was waiting on is why nothing came back.
        if (this.retrying) this.session.recordNotice("warn", `Stopped while retrying: ${this.retrying}`);
        this.retrying = undefined;
        this.session.push({ role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }], meta: { kind: "interrupt" } });
        this.emit({ type: "turn_end", reason: "aborted" });
        return "aborted";
    }

    /**
     * Its session is being closed while this turn is still stopping (a CLI
     * backend gets seconds to answer an interrupt; a tool may not stop at
     * once): note the interrupt now, as the turn would have. The caller lets
     * the file go right after, so what the turn still writes is dropped, not
     * recorded after this.
     */
    noteStopped(): Promise<void> {
        this.cutOff = true;
        const stopping = this.turnSnapshots?.stop() ?? Promise.resolve();
        // Not running, or its prompt isn't in yet (then nothing of the turn is).
        if (!this.running || !this.prompted) return stopping;
        const last = this.session.messages.at(-1);
        if (last?.role === "user" && (last.meta?.kind === "interrupt" || last.content.some((p) => p.type === "text" && p.text === TOOL_INTERRUPT))) return stopping;
        const calls = last?.role === "assistant" ? toolCallsOf(last) : [];
        if (!calls.length) {
            this.interrupted(false);
            return stopping;
        }
        // Tools still running: their calls get results, or the next request is refused.
        this.session.push({
            role: "user",
            content: [...calls.map((c) => ({ type: "tool_result" as const, toolCallId: c.id, toolName: c.name, content: "Interrupted by user", isError: true })), { type: "text", text: TOOL_INTERRUPT }],
            meta: { kind: "tool_results" },
        });
        this.emit({ type: "turn_end", reason: "aborted" });
        return stopping;
    }

    /**
     * A notice that says how the turn ended: shown now, and kept in the
     * session file, so a reopened session shows why the turn stopped (it's
     * never sent to a model).
     */
    private endNotice(level: "warn" | "error", message: string) {
        this.session.recordNotice(level, message);
        this.emit({ type: "notice", level, message });
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
        this.session.recordUsage(modelRef(this.model), usage, cost.usd, cost.unknown);
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
        // Agent backends manage their own context.
        if (isAgentBackend(this.client)) return false;
        const window = this.model.contextWindow;
        if (!window) return false;
        const reserve = Math.min(this.model.maxOutput ?? 32_000, 32_000);
        const threshold = s.autoCompactThreshold ?? 0.92;
        return this.session.messages.length > 4 && this.estimatedContext() > (window - reserve) * threshold;
    }

    // -----------------------------------------------------------------------
    // Model calls with retries

    private async callModel(signal: AbortSignal, extra: Partial<ChatRequest> = {}, messages?: Message[]): Promise<AssistantMessage> {
        let stalls = 0;
        this.retrying = undefined;
        try {
            for (let attempt = 1; ; attempt++) {
                this.emit({ type: "request_start" });
                try {
                    return await this.client.stream(this.request(messages ?? this.session.messages, signal, extra), (e: StreamEvent) => this.forward(e));
                } catch (e) {
                    if (isAbort(e, signal)) throw new ProviderError("aborted");
                    const pe = e instanceof ProviderError ? e : new ProviderError((e as Error)?.message ?? String(e), undefined, false);
                    // Each stall waits minutes for a byte: after a few, the provider is down, and the turn says so.
                    if (pe.stalled && ++stalls > MAX_STALL_RETRIES) throw pe;
                    if (!pe.retryable || attempt >= MAX_RETRIES) throw pe;
                    const base = Math.min(32_000, 1000 * 2 ** (attempt - 1));
                    const delay = Math.min(60_000, pe.retryAfterMs ?? Math.round(base * (0.75 + Math.random() * 0.5)));
                    const reason = redact(pe.message);
                    this.retrying = `${reason} (attempt ${attempt})`;
                    this.emit({ type: "retry", attempt, delayMs: delay, reason });
                    await sleep(delay, signal);
                }
            }
        } finally {
            // Interrupted while waiting, the reason is still there for interrupted().
            if (!signal.aborted) this.retrying = undefined;
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
        if (isAgentBackend(this.client)) return this.compactBackend(this.client, opts);
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
                this.session.recordUsage(modelRef(this.model), res.usage, cost.usd, cost.unknown);
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
            const transcript = compactTranscriptText(history, maxChars);
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
    // Agent backends (src/backends): Claude Code and Codex run the turn

    /** Approvals as they stand for each CLI launch (a Stop-hook continuation or a resume retry starts another), never more than the turn began with. */
    private freshApprovals(base: { approvedMcpServers?: ApprovedMcpServers }): ApprovedMcpServers | undefined {
        if (!base.approvedMcpServers) return undefined;
        try {
            return this.o.approvedMcpServers?.();
        } catch {
            return undefined;
        }
    }

    private backendTurn(signal: AbortSignal, host: BackendHost): Omit<BackendTurn, "prompt" | "images" | "resumeId"> {
        const s = this.o.settings();
        let trusted = false;
        let approvedMcpServers: ApprovedMcpServers | undefined;
        try {
            // Implicit session trust does not authorize CLI project configuration.
            trusted = trustedByUser(this.state.cwd);
            approvedMcpServers = this.o.approvedMcpServers?.();
        } catch {
            trusted = false;
            host.emit({ type: "notice", level: "warn", message: "Could not check folder trust or approved MCP servers; this turn runs without project configuration or MCP servers." });
        }
        return {
            cwd: this.state.cwd,
            model: this.model,
            mode: this.o.mode.get(),
            effort: s.effort,
            fastMode: this.fastMode(),
            appendSystemPrompt: this.o.appendSystemPrompt,
            additionalDirectories: s.permissions?.additionalDirectories ?? [],
            trusted,
            approvedMcpServers,
            rules: { deny: s.permissions?.deny ?? [], ask: s.permissions?.ask ?? [], root: this.state.projectRoot },
            maxTurns: this.o.maxTurns,
            orchestrator: this.orchestrator(),
            readOnly: this.o.readOnly,
            signal,
            host,
        };
    }

    // -----------------------------------------------------------------------
    // Delegation (src/agent/delegation.ts): a backend main agent hands tasks
    // to other providers' models through the harness's MCP tools.

    /**
     * The MCP server for this turn; none for sub-agents. Delegation tools when it's on and there's another provider to
     * delegate to; secret tools when there's someone to ask.
     */
    private orchestrator(): OrchestratorServer | undefined {
        if (this.o.isSubagent || this.disposed) return undefined;
        const caller = this.model.provider;
        const delegating = this.o.settings().delegation !== false && delegationAvailable(caller, this.listings());
        const store = this.state.secrets;
        const ask = this.o.host.ui.requestSecret?.bind(this.o.host.ui);
        if (!delegating && !(store && ask)) return undefined;
        const tools: ServerTool[] = [];
        const instructions: string[] = [];
        if (delegating) {
            tools.push(
                ...orchestratorTools({
                    caller: () => this.model.provider,
                    listings: () => this.listings(),
                    projectRoot: () => this.state.projectRoot,
                    checkModel: (ref) => this.checkModel(ref),
                    claimCall: (args, meta) => this.claimDelegateCall(args, meta),
                    tasks: this.tasks(),
                }),
            );
            instructions.push(orchestrationInstructions(caller, this.oneShot));
        }
        if (store && ask) {
            tools.push(...secretTools({ store, ask, authorize: (name, input, signal) => this.authorizeSecretTool(name, input, signal), run: (o, signal) => this.runWithSecrets(o, signal) }));
            instructions.push(SECRET_INSTRUCTIONS);
        }
        this.serverTools = tools;
        this.serverInstructions = instructions.join("\n\n");
        // Claude Code puts MCP server instructions in its system prompt; Codex gets them as developer instructions.
        this.registration ??= registerTools(
            () => this.serverTools,
            () => (this.model.provider === "codex" ? undefined : this.serverInstructions),
        );
        return {
            name: MCP_SERVER_NAME,
            url: this.registration.url,
            authorization: this.registration.authorization,
            tools: tools.map((t) => t.name),
            instructions: this.serverInstructions,
            // Above the longest wait, so the harness's own timeout is what ends a long call.
            toolTimeoutSec: DELEGATION_LIMITS.maxWaitMs / 1000 + 5 * 60,
        };
    }

    private listings(): ProviderListing[] {
        return this.o.listings?.() ?? cachedListings();
    }

    /** A non-interactive run (-p): it ends with this turn, and tasks still running end with it. */
    private get oneShot(): boolean {
        return !this.o.host.askPermission;
    }

    private tasks(): Delegations {
        return (this.delegations ??= new Delegations(
            (req, signal) => this.runChild(req.callId ?? "", req, signal),
            (t) => this.taskSettled(t),
        ));
    }

    /** A task finished while nothing was running: its result goes with the next prompt. */
    private taskSettled(t: DelegatedTask) {
        if (this.running || t.delivered || this.disposed) return;
        this.deliverTasks();
    }

    /** Results the backend hasn't been given go with the next prompt (at turn end, or when they come in later). */
    private deliverTasks(notify = true) {
        const name = getProvider(this.model.provider)?.name ?? this.model.provider;
        for (const t of this.delegations?.undelivered() ?? []) {
            t.delivered = true;
            this.addReminder(`A task you delegated (with the ${MCP_SERVER_NAME} delegate tool) has ended. Its result:\n\n${taskReport(t)}`);
            if (notify) this.emit({ type: "notice", level: "info", message: `Delegated task ${t.id} "${t.description}" (${t.model}) ${t.status === "done" ? "finished" : t.status}. Its result goes to ${name} with your next message.` });
        }
    }

    /** Stop the delegated tasks still running (the user interrupted the turn). */
    private cancelTasks() {
        const n = this.delegations?.cancelAll() ?? 0;
        if (n) this.emit({ type: "notice", level: "info", message: `Stopped ${n} delegated task${n === 1 ? "" : "s"}.` });
    }

    /** Tasks delegated in this session (/tasks). */
    get delegatedTasks(): DelegatedTask[] {
        return this.delegations?.list() ?? [];
    }

    /** Stop one delegated task, or all of them; how many were running. */
    stopDelegated(id?: string): number {
        if (!this.delegations) return 0;
        return id ? Number(this.delegations.cancel(id)) : this.delegations.cancelAll();
    }

    /** The session is done with this agent: stop its delegated tasks (waiting a moment for them) and revoke its MCP token. */
    async dispose(graceMs = 3000): Promise<void> {
        this.disposed = true;
        this.registration?.close();
        this.registration = undefined;
        const running = this.delegations?.close() ?? [];
        if (running.length) await Promise.race([Promise.all(running.map((t) => t.settled)), Bun.sleep(graceMs)]);
    }

    /** Whether a model can run a delegated task: its provider is set up, and the model exists there. */
    private async checkModel(ref: string): Promise<string | { effortLevels?: Effort[]; effort?: Effort }> {
        const p = parseModelRef(ref);
        if (!p) return `"${ref}" isn't a model reference (provider:model).`;
        const r = await this.o.helpers?.resolveModel?.(ref);
        if (!r) return `${getProvider(p.provider)?.name ?? p.provider} isn't set up in ${APP_TITLE}, so ${ref} can't run here. Call models to see what can.`;
        const listed = this.listings().find((l) => l.provider.id === p.provider)?.models;
        if (listed?.length && !listed.some((m) => m.id === p.id)) return `${p.provider} has no model "${p.id}". Call models (with provider "${p.provider}") to see its models.`;
        return { effortLevels: r.model.effortLevels, effort: inheritedEffort(r.model, this.o.settings().effort) };
    }

    /**
     * Which open delegate call of the backend's a request came from: Codex
     * sends the call's id in _meta; otherwise the arguments tell. The call
     * may not have been seen yet, so this waits a moment for it.
     */
    private async claimDelegateCall(args: Record<string, unknown>, meta: Record<string, unknown>): Promise<string | undefined> {
        const id = typeof meta.callId === "string" ? meta.callId : undefined;
        const same = (a: Record<string, unknown>) => ["task", "description", "model", "agent"].every((k) => a[k] === args[k]);
        for (let i = 0; i < 40; i++) {
            // By id when there is one; by the arguments otherwise (or if no call has that id after a moment).
            const open = this.delegateCalls.filter((x) => !x.claimed);
            const c = open.find((x) => id !== undefined && x.id === id) ?? (id === undefined || i >= 10 ? open.find((x) => same(x.input)) : undefined);
            if (c) {
                c.claimed = true;
                return c.id;
            }
            await Bun.sleep(50);
        }
        return undefined;
    }

    /**
     * The prompt for a backend turn. A new backend session gets the
     * conversation so far (it may have started on another model); a resumed
     * one gets what other models said since its last turn.
     */
    private backendPrompt(text: string, promptIndex: number, resume?: { synced: number }): string {
        const missed = this.session.messages.slice(resume ? resume.synced : 0, promptIndex).map(withoutStateNotes);
        // Only that its last turn was stopped, which it never heard (Harness stopped or died part way): said plainly.
        if (resume && missed.length && missed.every((m) => m.role === "user" && m.meta?.kind === "interrupt")) return `${reminder(BACKEND_CUT_OFF).text}\n\n${text}`;
        const { text: transcript, shortenedChars } = handoffTranscript(missed, 60_000);
        if (!transcript && !shortenedChars) return text;
        const intro = resume
            ? "While another model answered in this session, the conversation went on. Here is what happened since your last turn:"
            : "This conversation started before you joined it (with another model, or before the history was compacted or rewound). Here it is so far:";
        const shortened = shortenedChars ? ` Parts of it were shortened or left out (${shortenedChars} characters); the user's messages are given whole where they fit.` : "";
        return `<conversation-so-far>\n${intro}${shortened}\n\n${transcript}\n</conversation-so-far>\n\n${text}`;
    }

    private async runBackend(backend: AgentBackendClient, parts: UserContent[], signal: AbortSignal): Promise<TurnEndReason> {
        try {
            return await this.runBackendTurn(backend, parts, signal);
        } finally {
            this.delegateCalls = [];
        }
    }

    private async runBackendTurn(backend: AgentBackendClient, parts: UserContent[], signal: AbortSignal): Promise<TurnEndReason> {
        const provider = this.model.provider;
        const name = getProvider(provider)?.name ?? provider;
        let promptIndex = this.session.messages.length - 1;
        const { text, images, documents } = forBackend(parts, readsPdf(this.model));
        let declined = false;
        const host: BackendHost = {
            emit: (e) => this.emitFromBackend(e),
            mode: () => this.o.mode.get(),
            fastMode: () => this.fastMode(),
            permission: async (req) => {
                const a = await this.backendPermission(req, signal);
                // A no to one of the backend's own sub-agents stops that one (the backend says so to it), not this turn.
                if (!a.allow && a.stop && !req.agentLabel) declined = true;
                return a;
            },
            askQuestions: async (qs) => {
                const ask = this.o.host.ui.askQuestion;
                if (!ask) return undefined;
                const out: string[][] = [];
                for (const q of qs) {
                    const a = await ask(q.question, q.options, Boolean(q.multiSelect));
                    if (!a) return undefined;
                    out.push(a.map(redact));
                }
                return out;
            },
            approvePlan: async (plan) => {
                if (!this.o.host.ui.approvePlan) return { approved: false, feedback: "This is a non-interactive run, so the plan can't be approved here. Give the complete plan as your final answer." };
                const r = await this.o.host.ui.approvePlan(plan);
                return r.feedback ? { ...r, feedback: redact(r.feedback) } : r;
            },
            setMode: (m) => {
                if (this.o.mode.get() !== m) this.o.mode.set(m);
            },
            usage: (u, o) => this.recordBackendUsage(u, o),
            context: (tokens) => this.recordBackendContext(tokens),
            sessionId: (id) => this.session.setBackendSession(provider, id, this.session.messages.length),
            drainQueued: async () => {
                if (this.cutOff) return [];
                const queued = this.o.host.drainQueued?.() ?? [];
                if (!queued.length) return [];
                let text = "";
                await this.checkpoint(queued.join("\n"), false, (checkpoint) => {
                    const m = this.session.push({ role: "user", content: [{ type: "text", text: queued.join("\n\n") }], meta: { kind: "prompt", display: queued.join("\n"), checkpoint } });
                    text = textOf(m);
                });
                if (this.cutOff) return [];
                return [text];
            },
        };
        const base = this.backendTurn(signal, host);
        let stopRounds = 0;
        let prompt = text;
        let promptImages = images;
        let promptDocuments = documents;
        while (true) {
            const resume = this.session.backends.get(provider);
            this.emit({ type: "request_start" });
            let result: BackendResult;
            try {
                // A sub-agent kept going (a Stop hook) takes up a speed change since.
                result = await backend.runTurn({ ...base, approvedMcpServers: this.freshApprovals(base), fastMode: this.fastMode(), prompt: this.backendPrompt(prompt, promptIndex, resume), images: promptImages, documents: promptDocuments, resumeId: resume?.id });
                if (result.resumeFailed) {
                    // Gone, or made in another folder: start a new one with this conversation as context.
                    this.session.forgetBackendSession(provider);
                    this.emit({ type: "notice", level: "warn", message: `${redact(result.error ?? `Couldn't continue the earlier ${name} session`)}. Starting a new one with this conversation as context.` });
                    result = await backend.runTurn({ ...base, approvedMcpServers: this.freshApprovals(base), fastMode: this.fastMode(), prompt: this.backendPrompt(prompt, promptIndex), images: promptImages, documents: promptDocuments, resumeId: undefined });
                }
            } catch (e) {
                if (isAbort(e, signal)) return this.interrupted(false);
                this.endNotice("error", redact((e as Error).message || String(e)));
                this.emit({ type: "turn_end", reason: "error" });
                return "error";
            }
            this.recordBackendTurn(provider, name, result);
            if (result.reason === "aborted" || signal.aborted) {
                const r = declined ? this.endBackendTurn(provider, "denied") : this.interrupted(false);
                this.syncBackend(provider);
                return r;
            }
            if (declined) return this.endBackendTurn(provider, "denied");
            if (result.reason === "error") {
                this.endNotice("error", redact(result.error || `${name} stopped with an error.`));
                return this.endBackendTurn(provider, "error");
            }
            if (result.reason === "max_turns") {
                this.endNotice("warn", `Stopped after ${this.o.maxTurns ?? "the maximum"} model turns (max turns).`);
                return this.endBackendTurn(provider, "max_turns");
            }
            const settings = this.o.settings();
            if (settings.hooks?.Stop?.length && stopRounds < 3) {
                const h = await runHooks(settings, "Stop", { session_id: this.session.meta.id, last_message: result.text }, this.state.cwd, signal).catch(() => undefined);
                for (const err of h?.errors ?? []) this.emit({ type: "notice", level: "warn", message: err });
                if (h?.blocked) {
                    stopRounds++;
                    prompt = reminder(`A Stop hook asked you to keep going:\n${redact(h.blocked)}`).text;
                    promptImages = [];
                    promptDocuments = [];
                    this.session.push({ role: "user", content: [{ type: "text", text: prompt }], meta: { kind: "reminder" } });
                    promptIndex = this.session.messages.length - 1;
                    this.syncBackend(provider, 1);
                    continue;
                }
            }
            return this.endBackendTurn(provider, "done");
        }
    }

    /** The turn in this session's history, as text: other models (and /export) see what the backend said and did. */
    private recordBackendTurn(provider: string, name: string, r: BackendResult) {
        const content: AssistantMessage["content"] = [];
        if (r.text.trim()) content.push({ type: "text", text: r.text });
        if (r.actions.length) content.push({ type: "text", text: backendActionsNote(name, r.actions) });
        if (!content.length) return;
        this.session.push({ role: "assistant", content, provider, model: this.model.id, stopReason: r.reason === "done" ? "end_turn" : "other" });
        // As a sub-agent it reports its answer (not what it said on the way), then, shorter, what it did.
        const answer = (r.answer ?? r.text).trim();
        // Redacted as the stored turn is: it goes to another model.
        this.backendReport = redact([answer, r.actions.length ? backendActionsNote(name, r.actions, REPORT_ACTIONS_CHARS) : ""].filter(Boolean).join("\n\n"));
    }

    /** The last backend turn as its report, when this agent is a sub-agent on a backend. */
    private backendReport?: string;

    /** The backend session has now seen everything up to here (minus `pending` messages it hasn't been sent yet). */
    private syncBackend(provider: string, pending = 0) {
        const b = this.session.backends.get(provider);
        if (b) this.session.setBackendSession(provider, b.id, this.session.messages.length - pending);
    }

    private endBackendTurn(provider: string, reason: TurnEndReason): TurnEndReason {
        this.syncBackend(provider);
        this.deliverTasks();
        const running = this.delegations?.running().length ?? 0;
        if (running) {
            const name = getProvider(provider)?.name ?? provider;
            const then = this.oneShot ? `${running === 1 ? "It stops" : "They stop"} with this run.` : `${running === 1 ? "Its result goes" : "Their results go"} to ${name} with your next message (/tasks shows them, /tasks stop stops them).`;
            this.emit({ type: "notice", level: "info", message: `${running} delegated task${running === 1 ? " is" : "s are"} still running. ${then}` });
        }
        this.emit({ type: "turn_end", reason });
        return reason;
    }

    private async compactBackend(backend: AgentBackendClient, opts: { auto: boolean; signal: AbortSignal; instructions?: string }): Promise<boolean> {
        const provider = this.model.provider;
        const resume = this.session.backends.get(provider);
        if (!resume) return false;
        this.emit({ type: "compact_start", auto: opts.auto });
        const host: BackendHost = {
            emit: (e) => {
                if (e.type === "notice" || e.type === "retry" || e.type === "limits") this.emit(e);
            },
            mode: () => this.o.mode.get(),
            permission: async () => ({ allow: false, message: "Not during compaction.", stop: true }),
            askQuestions: async () => undefined,
            approvePlan: async () => ({ approved: false }),
            setMode: () => {},
            usage: (u, o) => this.recordBackendUsage(u, o),
            sessionId: (id) => this.session.setBackendSession(provider, id, this.session.messages.length),
            drainQueued: () => [],
        };
        const r = await backend.compact({ ...this.backendTurn(opts.signal, host), resumeId: resume.id, instructions: opts.instructions });
        if (r.reason === "aborted") throw new ProviderError("aborted");
        if (r.reason === "error") throw new Error(r.error ?? "Compaction failed");
        this.contextTokens = 0;
        this.emit({ type: "compact_end", summary: `${getProvider(provider)?.name ?? provider} compacted its own context.` });
        return true;
    }

    /**
     * Backend tool calls use the harness's tool (when there is one) for titles
     * and rendering. Their output is redacted here, as the harness's own tools
     * redact theirs (keys in a file the backend read, say).
     */
    private emitFromBackend(e: AgentEvent) {
        e = redactBackendEvent(e);
        if (e.type === "tool_start" || e.type === "tool_end") {
            const call = e.call;
            if (call.name === DELEGATE_TOOL && e.type === "tool_start") this.delegateCalls.push({ id: call.id, input: (call.input ?? {}) as Record<string, unknown>, claimed: false });
            else if (call.name === DELEGATE_TOOL) this.delegateCalls = this.delegateCalls.filter((c) => c.id !== call.id);
        }
        const own = e.type === "tool_start" ? (orchestratorTitle(e.call.name, (e.call.input ?? {}) as Record<string, unknown>) ?? secretToolTitle(e.call.name, (e.call.input ?? {}) as Record<string, unknown>)) : undefined;
        if (own && e.type === "tool_start") e = { ...e, title: own };
        else if (e.type === "tool_end" && e.title) {
            // Retitled at its end (its input only known then): titled as at its start.
            const tool = this.findTool(e.call.name);
            try {
                if (tool) e = { ...e, title: tool.title(e.call.input as any) || e.title };
            } catch {
                // keep the backend's title
            }
        } else if (e.type === "tool_start" && !e.tool) {
            const tool = this.findTool(e.call.name);
            if (tool) {
                let title = e.title;
                try {
                    title = tool.title(e.call.input as any) || title;
                } catch {
                    // keep the backend's title
                }
                e = { ...e, tool, title };
            }
        }
        this.emit(e);
    }

    /** The backend's context while it works: shown now, with nothing counted (its usage comes at the end of the turn). */
    private recordBackendContext(tokens: number) {
        if (!tokens || tokens === this.contextTokens) return;
        this.contextTokens = tokens;
        this.emit({ type: "usage", usage: { inputTokens: 0, outputTokens: 0 }, cost: { usd: 0, estimated: false, unknown: false }, contextTokens: tokens });
    }

    private recordBackendUsage(usage: Usage, o: { contextTokens?: number; contextWindow?: number }) {
        const cost = costOf(usage, this.model);
        this.session.recordUsage(modelRef(this.model), usage, cost.usd, cost.unknown);
        if (o.contextWindow && !this.model.contextWindow) this.model.contextWindow = o.contextWindow;
        if (o.contextTokens) this.contextTokens = o.contextTokens;
        this.lastUsageTotal = this.session.messages.length;
        this.emit({ type: "usage", usage, cost, contextTokens: this.contextTokens });
    }

    /** The CLI auto-approves our MCP tools, so their explicit rules must be enforced here. */
    private async authorizeSecretTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ServerToolResult | undefined> {
        const refuse = (text: string): ServerToolResult => ({ text, isError: true });
        const tool = backendTool(`mcp__${MCP_SERVER_NAME}__${name}`, secretToolTitle(name, input));
        // Like the command check below, explicit asks still apply in bypass mode.
        const decision = this.o.checker.check(tool, input, "default", this.state.cwd);
        if (decision.behavior === "deny") return refuse(decision.reason ?? "Denied by a permission rule.");
        if (signal.aborted) return refuse("Interrupted by user");
        if (decision.behavior !== "ask" || !decision.rule) return undefined;
        if (!this.o.host.askPermission) return refuse(`Permission to use ${tool.name} was not granted (non-interactive session).`);
        const answer = await this.o.host.askPermission({ tool, input, title: tool.title(input), decision: { ...decision, suggestions: [] }, signal });
        if (signal.aborted) return refuse("Interrupted by user");
        if (!answer.allow) return refuse("The user declined this tool call. Don't retry it; wait for the user to say how to proceed.");
        return undefined;
    }

    /**
     * run_with_secrets (Claude Code, Codex): one command with Harness's Bash and those secrets. The CLI approves
     * Harness's tools without asking, so the check is here, at least as strict as backendPermission's for a
     * command: deny rules, plan mode and read-only agents refuse it, and only an allow rule runs it without asking
     * (no mode or reviewer does: it holds secrets). The prompt shows the command as written, and the secrets' names.
     */
    private async runWithSecrets(o: { command: string; names: string[]; description?: string; timeoutMs?: number }, signal: AbortSignal): Promise<ServerToolResult> {
        const refuse = (text: string): ServerToolResult => ({ text, isError: true });
        const store = this.state.secrets;
        if (!store) return refuse("This session holds no secrets.");
        const input = { command: o.command, description: o.description, timeout: o.timeoutMs };
        const mode = this.o.mode.get();
        if (this.o.readOnly) return refuse(readOnlyRefusal("run_with_secrets"));
        if (mode === "plan") return refuse("Plan mode is active: run_with_secrets runs nothing until the user approves a plan.");
        const cwd = this.state.cwd;
        // As in the default mode: it runs outside any sandbox (so auto mode's sandbox rules don't fit it), and modes don't approve it.
        const decision = this.o.checker.check(BashTool, input, "default", cwd);
        if (decision.behavior === "deny") return refuse(decision.reason ?? "Denied by a permission rule.");
        const names = o.names.join(", ");
        if (!(decision.behavior === "allow" && decision.rule)) {
            if (!this.o.host.askPermission) return refuse("Permission to run a command with secrets was not granted (non-interactive session).");
            const ask = {
                ...decision,
                behavior: "ask" as const,
                reason: `Runs with ${o.names.length === 1 ? "the secret" : "the secrets"} ${names} in its environment.${decision.behavior === "ask" && decision.reason ? ` ${decision.reason}` : ""}`,
                // Once at a time: an "always" here would also let the agent's own shell run such commands unasked.
                suggestions: [],
                sandbox: undefined,
                needsClassifier: undefined,
            };
            // The signal withdraws the prompt if the CLI cancels the call.
            const answer = await this.o.host.askPermission({ tool: BashTool, input, title: `RunWithSecrets(${names})`, decision: ask, secrets: o.names, signal });
            if (signal.aborted) return refuse("Interrupted by user");
            if (!answer.allow) {
                const fb = answer.feedback?.trim();
                return refuse(fb ? `The user declined this command and said:\n${redact(fb)}` : "The user declined this command. Don't retry it; wait for the user to say how to proceed.");
            }
        }
        // Its own copy of the state: these secrets only, and a cd in it doesn't move the session.
        const state: ToolState = { ...this.state, secrets: store.only(o.names) };
        let r: ToolResult;
        try {
            r = await BashTool.run(input, { ...this.toolContext("", signal), state, onProgress: undefined });
        } catch (e) {
            r = { content: signal.aborted ? "Interrupted by user" : `Tool error: ${redact((e as Error).message ?? String(e))}`, isError: true };
        }
        return { text: redact(r.content), isError: r.isError };
    }

    /**
     * A permission prompt from the backend. Its own permission system decided
     * to ask; the harness's rules then apply: deny rules (and the harness's
     * protected files) refuse it, an explicit allow rule approves it, and
     * anything else goes to the user. The harness's mode defaults never
     * approve on the user's behalf what the backend wanted confirmed, except
     * where the ask says nothing of its own: Codex asking about every command,
     * or a read-only agent asking because of the harness's own rule. There a
     * read-only command the harness would run for its own models runs.
     */
    private async backendPermission(req: BackendPermission, signal: AbortSignal): Promise<PermissionAnswer> {
        const tool = this.findTool(req.toolName) ?? backendTool(req.toolName, req.title);
        const input = req.input;
        const mode = this.o.mode.get();
        const cwd = this.state.cwd;
        // A read-only agent (explore) on a backend: reads, searches and read-only commands only.
        if (this.o.readOnly) {
            const reads = !req.widens && (tool.category === "read" || tool.category === "network" || (tool.name === "Bash" && isReadOnlyCommand(String(input.command ?? ""))));
            if (!reads) return { allow: false, message: readOnlyRefusal(tool.name, String(input.command ?? ""), req.widens ? "it asks for more access than the sandbox gives" : undefined), stop: false };
        }
        // Approved without asking: by an allow rule, or an edit the harness's mode approves (accept edits: inside the workspace).
        const approves = (d: Decision) => d.behavior === "allow" && (Boolean(d.rule) || tool.category === "edit");
        let decision = this.o.checker.check(tool, input, mode, cwd);
        let ruled = approves(decision);
        for (const p of req.otherPaths ?? []) {
            if (decision.behavior === "deny") break;
            const d = this.o.checker.check(tool, { ...input, file_path: p }, mode, cwd);
            if (d.behavior === "deny") decision = d;
            else if (!approves(d)) ruled = false;
        }
        const command = tool.name === "Bash" ? String(input.command ?? "") : "";
        // Allowed as read-only by the checker: no ask rule, nothing with credentials, not left to a sandbox.
        if (command && (req.asksAlways ?? this.o.readOnly) && decision.behavior === "allow" && !decision.sandbox && isReadOnlyCommand(command)) ruled = true;
        if (req.widens) {
            // More access for the backend's sandbox: never in plan mode, never past a deny rule, never without asking.
            if (mode === "plan") return { allow: false, message: "Plan mode is active: no extra permissions until the user approves a plan.", stop: false };
            const deny = this.o.settings().permissions?.deny ?? [];
            const access: ["read" | "write", string[]][] = [
                ["read", req.widens.read],
                ["write", req.widens.write],
            ];
            for (const [kind, list] of access) {
                for (const p of list) {
                    const abs = expandPath(p, cwd);
                    const rule = deniedWithin(deny, abs, this.state.projectRoot, kind);
                    if (rule) return { allow: false, message: `Denied: the permission rule ${rule} covers ${abs}.`, stop: false };
                    if (this.o.checker.isProtectedArea(abs)) return { allow: false, message: `Denied: ${abs} holds the harness's credential store.`, stop: false };
                }
            }
            ruled = false;
        }
        if (decision.behavior === "deny") return { allow: false, message: decision.reason ?? "Denied by a permission rule.", stop: false };
        let title = req.title ?? tool.name;
        try {
            title = tool.title(input as any) || title;
        } catch {
            // keep the backend's title
        }
        if (ruled) return { allow: true };
        if (!this.o.host.askPermission) {
            return { allow: false, message: `Permission to use ${tool.name} was not granted (non-interactive session). ${req.reason ?? ""} Allow it with --allowedTools, a permission rule, or --permission-mode.`.replace(/\s+/g, " ").trim(), stop: false };
        }
        let preview = req.preview;
        if (!preview) {
            try {
                preview = await tool.preview?.(input, this.toolContext("", signal));
            } catch {
                // preview is optional
            }
        }
        const ask = {
            ...decision,
            behavior: "ask" as const,
            reason: decision.behavior === "ask" ? (decision.reason ?? req.reason) : req.reason,
            suggestions: decision.suggestions ?? (command ? suggestBashRules(command) : tool.category === "mcp" ? [tool.name] : undefined),
            sandbox: undefined,
            needsClassifier: undefined,
        };
        const answer = await this.o.host.askPermission({ tool, input, title, decision: ask, preview, ...(req.agentLabel ? { agentLabel: req.agentLabel } : {}) });
        if (signal.aborted) return { allow: false, message: "Interrupted by user", stop: true };
        if (answer.setMode) this.o.mode.set(answer.setMode);
        if (answer.rules?.length) {
            this.o.checker.sessionAllow.push(...answer.rules);
            if (answer.scope && answer.scope !== "session") this.o.host.saveRules?.(answer.rules, answer.scope);
        }
        if (answer.allow) return { allow: true, mode: answer.setMode };
        const fb = answer.feedback?.trim();
        if (fb) return { allow: false, message: `The user declined this tool call and said:\n${redact(fb)}`, stop: false, fromUser: true };
        return { allow: false, message: "The user declined this tool call. Stop and wait for the user to tell you how to proceed; don't retry it.", stop: true };
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
                // ExitPlanMode reports the change in its own result: the model knows the mode now.
                if (from !== "plan") this.noteModeChange(from, m);
                else this.pendingReminders = this.pendingReminders.filter((r) => r.kind !== "mode");
            },
            onProgress: (text) => this.emit({ type: "tool_progress", id: callId, text }),
            ui: this.o.host.ui,
            hidden: (toolName, abs) => this.o.checker.hiddenFromSearch(toolName, abs),
            runSubagent: this.o.isSubagent ? undefined : (opts, sig) => this.runSubagent(callId, opts, sig),
            listModels: this.o.isSubagent ? undefined : (opts, sig) => catalog(this.state.projectRoot, { ...opts, listings: this.o.listings?.(), current: modelRef(this.model), signal: sig }),
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
            if (writes) return { result: this.errorResult(call, readOnlyRefusal(tool.name, String(input.command ?? ""))) };
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
                if (v.decision === "allow") return { tool, input, sandbox, auto: v.ms === undefined ? v.reason : `${v.reason} (reviewed in ${(v.ms / 1000).toFixed(1)}s)` };
                // Told why, the agent can take a safer way (the user decides once blocks pile up).
                if (v.decision === "block") return { result: this.errorResult(call, blockedByReviewer(v.reason)) };
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
        // The reviewer sent it to the user, who has now decided: its blocks count afresh.
        if (classifierReason !== undefined) this.o.classifier?.userDecided();
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
        // Tools redact their own output; this catches any that print a secret (RequestSecret's) without doing so, before hooks, windows or the model.
        result = redactResult(result);
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
            // A long paste rides as an attachment, but it's what the developer asked for too.
            const text = () => [textOf(m), ...pastedTexts(m.content)].join("\n").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
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
    // Sub-agents (Task tool, and tasks a backend delegates)

    private async runSubagent(callId: string, opts: { description: string; prompt: string; agentType?: string; model?: string }, signal: AbortSignal): Promise<{ report: string; isError?: boolean; model?: string }> {
        const r = await this.runChild(callId, { description: opts.description, prompt: opts.prompt, agent: opts.agentType || "general-purpose", model: opts.model }, signal);
        if (r.status === "cancelled") return { report: "The sub-agent was interrupted by the user.", model: r.model };
        if (r.status === "failed") return { report: r.report, isError: true, model: r.model };
        return { report: r.report || "(The sub-agent finished without a report.)", model: r.model };
    }

    /**
     * Run a sub-agent on its own fresh session: on the model asked for, the
     * agent type's, or this agent's. It shares this agent's permission mode,
     * rules and prompts (labeled with its task), and its spend is added to
     * this session's.
     */
    private async runChild(callId: string, req: ChildRequest, signal: AbortSignal): Promise<ChildResult> {
        const started = Date.now();
        const fail = (report: string, model = req.model ?? modelRef(this.model)): ChildResult => ({ status: "failed", report, model, tokens: 0, durationMs: Date.now() - started });
        const type = req.agent || "general-purpose";
        const defs = loadAgents(this.state.projectRoot);
        const def = defs.find((a) => a.name === type);
        if (!def) return fail(`Unknown agent type "${type}". Available: ${defs.map((d) => d.name).join(", ")}`);

        let model = this.model;
        let client = this.client;
        const ref = req.model || def.model;
        if (ref) {
            const r = await this.o.helpers?.resolveModel?.(ref);
            if (r) ({ model, client } = r);
            // An agent type's model that isn't set up falls back to this one; one asked for by name doesn't.
            else if (req.model) return fail(`Can't run a sub-agent on ${req.model}: ${parseModelRef(req.model) ? "that provider isn't set up here, or the model isn't known" : "it isn't a provider:model reference"}. Call ListModels to see the models that can run.`);
        }
        const effort = req.effort ?? inheritedEffort(model, this.o.settings().effort);
        const backend = isAgentBackend(client);
        const other = modelRef(model) !== modelRef(this.model);

        const exclude = new Set(["Task", "ListModels", "TodoWrite", "AskUserQuestion", "RequestSecret", "ExitPlanMode"]);
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
        // Not saved itself: a Claude Code or Codex session it runs on is recorded in this one.
        session.runsFor = this.session;
        // Prompts and progress name the model when it isn't this agent's.
        const label = other ? `${req.description} (${modelRef(model)})` : req.description;
        const parentHost = this.o.host;
        let lastError: string | undefined;
        const parentMode = this.o.mode;
        /** Background shells it starts (in the shared list): stopped with it if it's stopped. */
        const shellsStarted = new Set<string>();
        const child = new Agent({
            ...this.o,
            session,
            model,
            client,
            tools,
            isSubagent: true,
            settings: () => ({ ...this.o.settings(), effort }),
            parentRequests: () => this.requestContext(),
            delegatedTask: req.prompt,
            // At the speed the parent runs at (not fast where the parent's model has none and shows standard),
            // on its own model if that one has fast mode.
            parentFastMode: () => this.fastMode(),
            subagent: { type, description: req.description, parentSessionId: this.session.meta.id },
            readOnly: def.readOnly,
            // A read-only agent on Claude Code or Codex runs in a mode where they ask before changing anything (and the harness refuses).
            mode: backend && def.readOnly ? { get: () => (parentMode.get() === "plan" ? "plan" : "default"), set: () => {} } : this.o.mode,
            maxTurns: 200,
            // Claude Code and Codex use their own system prompts: this goes on top.
            appendSystemPrompt: backend ? [BACKEND_SUBAGENT, def.prompt, def.readOnly ? BACKEND_READ_ONLY : ""].filter(Boolean).join("\n\n") : undefined,
            nativeWebSearch: this.o.nativeWebSearch && model.provider === this.model.provider,
            toolState: {
                cwd: this.state.cwd,
                projectRoot: this.state.projectRoot,
                fileState: new Map(this.state.fileState),
                todos: [],
                shells: trackShells(this.state.shells, shellsStarted),
                fileHistory: this.state.fileHistory,
                // Its Bash sees the secrets the user gave this session (only the main agent can ask for one).
                secrets: this.state.secrets,
            },
            host: {
                emit: (e) => {
                    if (e.type === "notice" && e.level === "error") lastError = e.message;
                    // What its own sub-agents do (Codex's, say) is named as theirs, under this one, as they ask.
                    parentHost.emit({ type: "subagent", parentId: callId, label, event: e.type === "subagent" ? { ...e, label: nestedAgentLabel(label, e.label) } : e });
                },
                // A stopped sub-agent's prompt is withdrawn (declined), so it can stop rather than wait for an answer.
                // A backend's own sub-agent (one of Codex's) asks as itself, under this one.
                askPermission: parentHost.askPermission ? (p) => untilAborted(parentHost.askPermission!({ ...p, agentLabel: backend && p.agentLabel ? nestedAgentLabel(label, p.agentLabel) : label, signal }), signal, { allow: false }) : undefined,
                saveRules: parentHost.saveRules,
                ui: {},
            },
        });
        let reason: TurnEndReason;
        this.children.add(child);
        try {
            reason = await child.run([{ type: "text", text: req.prompt }], { signal });
        } catch (e) {
            reason = signal.aborted ? "aborted" : "error";
            lastError ??= redact((e as Error).message ?? String(e));
        } finally {
            this.children.delete(child);
        }
        // Stopped: so is what it left running (a watcher writing files, say), even where the shell itself has exited.
        if (signal.aborted) await Promise.all([...shellsStarted].map((id) => this.state.shells.get(id)?.kill().catch(() => undefined)));
        // Fold the child's spend into the parent session's totals.
        let tokens = 0;
        let cost = 0;
        for (const u of session.usageRecords) {
            this.session.recordUsage(u.model, u.usage, u.cost, u.unknown);
            tokens += u.usage.inputTokens + u.usage.outputTokens + (u.usage.cacheReadTokens ?? 0) + (u.usage.cacheWriteTokens ?? 0);
            cost += u.cost;
        }
        const last = [...session.messages].reverse().find((m) => m.role === "assistant");
        // A backend's: its answer, then what it did ("[Codex used: …]").
        const report = backend ? (child.backendReport ?? "") : !last ? "" : textOf(last).trim();
        const result = (status: ChildResult["status"], text: string): ChildResult => ({ status, report: text, model: modelRef(model), tokens, cost: cost || undefined, durationMs: Date.now() - started });
        switch (reason) {
            case "aborted":
                return result("cancelled", report ? `It was stopped. Its last message:\n${report}` : "It was stopped before it reported anything.");
            case "error":
            case "blocked":
                return result("failed", `The sub-agent stopped with an error${lastError ? `: ${lastError}` : "."}${report ? `\nIts last message:\n${report}` : ""}`);
            case "denied":
                return result("failed", `The user declined one of its actions, which stopped it.${report ? ` Its last message:\n${report}` : ""}`);
            case "max_turns":
                return result("done", `${report}\n\n(It stopped at its limit of 200 model turns.)`.trim());
            default:
                return result("done", report);
        }
    }
}

/** How much of what a backend did its turn's note keeps in the history, and in a sub-agent's report. */
const ACTIONS_CHARS = 16_000;
const REPORT_ACTIONS_CHARS = 2_000;

/**
 * The note after a backend's turn in the history, "[Codex used: Bash(…),
 * Edit(…)]": every action, each on one line and clipped, up to a length.
 * It's how other models, /export and a reopened session know what it did.
 */
export function backendActionsNote(name: string, actions: string[], maxChars = ACTIONS_CHARS): string {
    const shown: string[] = [];
    let used = 0;
    for (const a of actions) {
        const one = a.replace(/\s+/g, " ").trim();
        const t = one.length > 200 ? `${one.slice(0, 199)}…` : one;
        if (shown.length && used + t.length + 2 > maxChars) break;
        shown.push(t);
        used += t.length + 2;
    }
    const more = actions.length - shown.length;
    return `[${name} used: ${shown.join(", ")}${more ? `, and ${more} more` : ""}]`;
}

const BACKEND_SUBAGENT = `You are working as a sub-agent of ${APP_TITLE}: another agent gave you one self-contained task. Complete it, then reply with a final report. The other agent sees only your last message, so make it complete: findings, file paths with line numbers, what you changed (if anything), and anything left unresolved. Don't commit, push or make changes outside the task's scope.`;
const BACKEND_READ_ONLY = "This task is read-only: read, search and run read-only commands, but don't change any files, and don't run tests, builds or scripts; those will be refused. Report what should be changed or run instead.";

/** Stands in for a backend tool the harness has no tool of its own for (rules still match its name). */
function backendTool(name: string, title?: string): Tool<any> {
    return {
        name,
        description: "",
        parameters: { type: "object" },
        category: name.startsWith("mcp__") ? "mcp" : "execute",
        readOnly: false,
        title: () => title ?? name,
        run: async () => ({ content: "" }),
    };
}

/** A tool's result with every known secret taken out, as the model, hooks and windows see it. */
function redactResult(r: ToolResult): ToolResult {
    const d = r.display;
    const display = d && { ...d, summary: d.summary && redact(d.summary), body: d.body && redact(d.body), diff: d.diff && { path: d.diff.path, before: redact(d.diff.before), after: redact(d.diff.after) } };
    return { ...r, content: redact(r.content), display };
}

/**
 * A backend's event with its output redacted, as the harness's own tools
 * redact theirs (keys in a file the backend read, say): its sub-agents'
 * tool output and what they say too.
 */
function redactBackendEvent(e: AgentEvent): AgentEvent {
    if (e.type === "tool_progress") return { ...e, text: redact(e.text) };
    if (e.type === "tool_end") return { ...e, result: redactResult(e.result) };
    if (e.type === "subagent") return { ...e, event: e.event.type === "text" ? { ...e.event, text: redact(e.event.text) } : redactBackendEvent(e.event) };
    return e;
}

/** How a sub-agent's own sub-agent is named (in its permission prompts, and in the GUI): under the one whose it is. */
function nestedAgentLabel(parent: string, label: string): string {
    return `${parent} › ${label}`;
}
