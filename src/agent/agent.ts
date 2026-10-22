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
import { claudePluginDirs, loadsPluginsNatively, withoutPluginHooks } from "../plugins/native";
import type { ApprovedMcpServers } from "../mcp/manager";
import type { PermissionMode } from "../permissions/modes";
import { MODE_INFO } from "../permissions/modes";
import type { Decision } from "../permissions/checker";
import { PermissionChecker } from "../permissions/checker";
import { AutoClassifier, needsSummary, summaryFits, type ReviewContext } from "../permissions/classifier";
import { sandboxKind, sandboxPolicy, type Sandbox } from "../permissions/sandbox";
import { APP_TITLE, harnessHome } from "../config/paths";
import type { Sampler, Tool, ToolContext, ToolDisplay, ToolResult, ToolState, UiBridge } from "../tools/types";
import { formatWakes, wakeDisplay } from "./wakes";
import { isReadOnly, isShellTool } from "../tools/types";
import { coerceInput, validateInput, EXPLORE_TOOLS, toSchema } from "../tools/index";
import { isReadOnlyCommand, notReadOnly } from "../permissions/bash-safety";
import { mcpToolMatches } from "../permissions/rules";
import { toolNameFor } from "../mcp/manager";
import { costOf, promptTokens, type CostEstimate } from "../providers/pricing";
import { Session } from "./session";
import { hookApplies, isAsync, matcherFn, runHandler, runHooks, runInBackground, type HookEvent, type HookOutcome, type HookServices } from "./hooks";
import { FileWatchHooks, type FileEvent } from "./file-watch-hooks";
import { instructionsLoadedHooks, sessionStartHooks } from "./session-hooks";
import { compactRequestMessage, estimateTokens, summaryMessage, transcriptCompactRequest, compactTranscriptText, handoffTranscript } from "./compact";
import { cacheTtl, idleCompactPlan, type CacheWindow, type IdleCompactPlan } from "./idle-compact";
import { agentMemoryDir, agentMemoryPrompt, DEFAULT_MAX_TURNS, findSkill, loadAgents, readAgentMemory, type AgentDef } from "./agents";
import { childMode, createAgentWorktree, finishAgentWorktree, fromServers, keepLocal, startAgentServers, withAgentHooks, worktreeNote, type AgentServers, type AgentWorktree, type WorktreeOutcome } from "./subagent-setup";
import { buildSystemPrompt, EXPLORE_APPEND, SUBAGENT_CORE } from "./system-prompt";
import { FileHistory, promptNotes, resetToolState } from "./checkpoints";
import { TurnSnapshots, type TurnCapture } from "./turn-snapshots";
import { redact } from "../util/redact";
import type { Skill } from "./skills";
import { claudeAgents } from "../backends/claude-agents";
import { isAgentBackend, type AgentBackendClient, type BackendHost, type BackendPermission, type BackendResult, type BackendTurn, type OrchestratorServer, type PermissionAnswer } from "../backends/types";
import { getProvider } from "../providers/registry";
import { ACCOUNT_PROVIDERS, account, accountRealPath } from "../providers/accounts";
import { forBackend, pastedTexts, readsPdf } from "../providers/files";
import { fitContent, fitToolImages, hasImages, imagesFor } from "../providers/images";
import { cachedListings, type ProviderListing } from "../providers/models";
import { registerTools, type Registration, type ServerTool, type ServerToolResult } from "../mcp/server";
import { CRON_TOOL_NAMES, SCHEDULE_INSTRUCTIONS, scheduleServerTools } from "./schedule-tools";
import { WATCH_INSTRUCTIONS, watchServerTools } from "../tools/git-tools";
import { MONITOR_INSTRUCTIONS, monitorServerTools, nativeMonitorCall } from "../tools/monitor";
import { SECRET_INSTRUCTIONS, secretTools, secretToolTitle } from "./secret-tools";
import { readFile } from "fs/promises";
import { join, relative } from "path";
import { BashTool } from "../tools/bash";
import { LspManager, DIAGNOSED_TOOLS, MAX_FILE_CHARS } from "../lsp/manager";
import { formatForModel, redactedReport, summaryLine } from "../lsp/diagnostics";
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
    taskStatusText,
    type ChildRequest,
    type ChildResult,
    type DelegatedTask,
} from "./delegation";
import { suggestBashRules } from "../permissions/bash-safety";
import { isTrusted, trustedByUser } from "../config/trust";
import { deniedWithin } from "../permissions/rules";
import { canonical, expandPath, isInside } from "../util/files";
import type { PlanLimits } from "../server/protocol";
import type { NativeGoal } from "./goal";

// ---------------------------------------------------------------------------
// Host interface (implemented by the TUI and by headless mode)

export type AgentEvent =
    | { type: "request_start" }
    | { type: "activity"; text?: string }
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
    /** `idle`: compacting a conversation left idle, before its prompt cache expires. */
    | { type: "compact_start"; auto: boolean; idle?: boolean }
    | { type: "compact_end"; summary: string; idle?: boolean }
    | { type: "subagent"; parentId: string; label: string; event: AgentEvent }
    /** An agent CLI reported the user's plan limits (`partial`: earlier windows it left out still stand). */
    | { type: "limits"; limits: PlanLimits; partial: boolean }
    /** The commands an agent CLI says it runs itself (Claude Code's skills and built-ins). */
    | { type: "cli_commands"; provider: string; names: string[] }
    /** The goal an agent CLI keeps itself (src/agent/goal.ts NativeGoal); null when it has none. */
    | { type: "goal"; goal: NativeGoal | null }
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
    /** One plain-English line on what it does and what makes it risky. */
    summary?: string;
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
    /** "Yes, and allow this for the session": the request's decision.grant takes effect. */
    grant?: boolean;
}

export interface AgentHost {
    emit(e: AgentEvent): void;
    /** Missing in non-interactive mode: anything that needs approval is denied. */
    askPermission?(req: PermissionRequest): Promise<PermissionResponse>;
    /** Persist "don't ask again" rules. */
    saveRules?(rules: string[], scope: "local" | "project" | "user"): void;
    ui: UiBridge;
    /**
     * Messages the user typed while the agent was busy, to steer the running turn with. `record`, when
     * given, is run once some are taken and before their turn starts, so the output before them is recorded first.
     */
    drainQueued?(record?: () => void): string[];
    /**
     * For a backend's CLI that's between its turns, waiting only on its background work: the first queued
     * message that can go now, as a prompt of its own, whatever its mode, prepared as a sent one is (its
     * attachments, @mentions and $skills). Not commands or `!commands`, nor held ones. `record` runs once one
     * is taken, before its turn starts, so the output before it is recorded first; `admit` runs the prompt's
     * hooks: "blocked" (a hook blocked it) means it's dropped, "stopped" (the turn was interrupted, or the
     * backend can't send any more) that it stays queued, "go" that it goes, with nothing awaited from then
     * until it's stored and sent.
     */
    drainWaiting?(steps: { record(): void; admit(parts: UserContent[], display: string): Promise<Admission> }): Promise<{ parts: UserContent[]; display: string } | undefined>;
}

/** What a queued message's hooks, and whether it can still go, decided (AgentHost.drainWaiting). */
export type Admission = "go" | "blocked" | "stopped";

export interface Helpers {
    /** One-shot completion on a cheap model (classifier, summaries). */
    complete?(system: string, prompt: string, signal?: AbortSignal): Promise<string>;
    webSearch?(query: string, signal: AbortSignal): Promise<string>;
    /** One completion on the session's own model (an MCP server's sampling request): its text and the model. */
    sample?: Sampler;
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
    /** The session's skills, which Claude Code and Codex are given to run themselves. */
    skills?: () => readonly Skill[];
    /** A sub-agent's type and task, for its SubagentStop hooks. */
    subagent?: { type: string; description: string; parentSessionId: string };
    /** Read-only agent (explore): edits and state-changing commands are refused. */
    readOnly?: boolean;
    /** Sub-agents: the folder its memory is kept in, which isn't harness configuration for it. */
    memoryDir?: string;
    maxTurns?: number;
    /**
     * This run's --append-system-prompt. Added to the session's frozen system
     * prompt on each request rather than stored in it, so it also reaches a
     * resumed session and isn't kept by later runs without the flag.
     */
    appendSystemPrompt?: string;
    /**
     * The system prompt for this run in place of the session's frozen one, not saved: a resumed session
     * the run doesn't trust, whose prompt was frozen with the project's memory files in it.
     */
    systemPrompt?: string;
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
 * A request refused for its images: too large, too many, not decodable, or a
 * model that takes none. Anthropic's "many-image requests" is documented,
 * and its "image dimensions exceed max allowed size" seen live; OpenRouter's
 * "No endpoints found that support image input" and the other wordings are
 * the shapes such errors take. "image" counts as a word only, not inside a
 * name (a tool called image_lookup), and an error about a tool's or
 * function's schema is never about the conversation's images.
 */
export function isImageRejection(e: unknown): boolean {
    const err = e as ProviderError;
    const msg = String(err?.message ?? "") + String(err?.body ?? "");
    if (!(err?.status === 400 || err?.status === 404 || err?.status === 413 || err?.status === 422) || isContextOverflow(e)) return false;
    if (/\b(tool|function)s?\b[^\n]{0,40}\b(schema|parameters)\b|\b(schema|parameters)\b[^\n]{0,40}\b(tool|function)s?\b|input_schema|\btools\.\d/i.test(msg)) return false;
    return /many-image|(?<![\w-])images?(?![\w-])[^.\n]{0,80}\b(exceeds?|too (large|big|many)|dimensions?|invalid|could not|couldn't|unable to|not supported|unsupported|does not match|not (a )?valid)|\b(invalid|unsupported|could not process|cannot process|can't process)\b[^.\n]{0,30}(?<![\w-])images?(?![\w-])|image_url|image input|image_parse_error/i.test(msg);
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

/** A /goal command, which a CLI backend runs as its own. */
const GOAL_COMMAND = /^\s*\/goal(\s|$)/i;

/** A prompt's words as hooks and checkpoints read them: its text parts, then pasted texts. */
function promptTextOf(content: readonly UserContent[]): string {
    return [...content.filter((p): p is TextPart => p.type === "text").map((p) => p.text), ...pastedTexts(content)].join("\n");
}

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
    /** A hook said continue: false during this turn: the turn ends, with this reason. */
    private hookStop?: string;
    /** A PreCompact hook refused automatic compaction this turn. */
    private autoCompactBlocked = false;
    /** The error the turn ended on, for StopFailure hooks. */
    private turnError?: string;
    /**
     * Messages whose images the model refused this turn, sent again without
     * them: recorded on the session (Session.refuseImages) once that's
     * answered, forgotten if it isn't (the images weren't the trouble then).
     */
    private refusing?: { model: string; messages: Set<Message> };
    private fileWatch?: FileWatchHooks;
    /** A backend turn that takes steering at once (Codex), told when a message to steer with arrives. */
    private queueListeners = new Set<() => void>();
    private running = false;
    /** The session is being let go; awaited checkpoints must not append another prompt or tool result. */
    private cutOff = false;
    /** This turn's prompt is in the session. */
    private prompted = false;
    /** Prompt tokens of the most recent request (context usage). */
    contextTokens = 0;
    private lastUsageTotal = 0;
    /** The prompt cache of the conversation's last request (idle compaction keeps it from going to waste). */
    private cache?: CacheWindow;
    /** An idle compaction was tried on this cache: failed or cancelled, it isn't tried again until the next request. */
    private idleTried = false;
    /** When the model request now answering was sent. */
    private sentAt = 0;
    /** How the last turn ended: only one that finished compacts while idle. */
    private lastEnd?: TurnEndReason;
    /** The last few tool calls, for the auto-mode reviewer ("Bash: npm test"). */
    private recentActions: string[] = [];
    /** Tasks a backend (Claude Code, Codex) delegated to other models through the harness's MCP tools. */
    private delegations?: Delegations;
    /** The harness agents this turn passed to Claude Code (--agents), by name: their permission modes apply to their asks. */
    private nativeDefs = new Map<string, AgentDef>();
    private nativeNotes = new Set<string>();
    private registration?: Registration;
    /** What the harness MCP server offers this turn, and its instructions (read by the server on each request). */
    private serverTools: ServerTool[] = [];
    /** The last run stopped on the plan's usage limit (an agent CLI said so), and when that resets if known. */
    limitStop?: { resetsAt?: number };
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
            // Language servers start on the first edit they handle and outlive this Agent (a model switch makes a new one).
            const root = this.state.projectRoot;
            this.state.lsp ??= new LspManager({ root, settings: o.settings, trusted: () => userTrusts(root) });
            this.state.lsp.attach(o.session.meta.id, (level, message) => this.emit({ type: "notice", level, message }));
        }
    }

    get tools(): Tool<any>[] {
        return typeof this.o.tools === "function" ? this.o.tools() : this.o.tools;
    }

    /** The host has a message to steer the running turn with. API models take it at their next step; a backend that can, now. */
    queueChanged() {
        for (const l of [...this.queueListeners]) l();
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
        // Caches are per model: the next request reads the history afresh.
        this.cache = undefined;
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
        // Each in the mode it works out under the new one: a read-only one stays read-only, one whose definition sets a mode keeps it (childMode).
        for (const c of this.children) if (isAgentBackend(c.client)) c.client.setMode(c.o.mode.get());
        this.noteState("mode", from, to, (origin) => modeNote(origin, to));
    }

    /** The user picked another model (`from` is the one before, provider:id). */
    noteModelChange(from: string, to: ModelInfo) {
        const ref = modelRef(to);
        this.noteState("model", from, ref, () => `The user switched the model to ${to.name ?? to.id} (${ref}). You are now running as this model.`);
    }

    /** The system prompt as sent: the session's, plus --append-system-prompt. */
    systemPrompt(): string {
        const base = this.o.systemPrompt ?? this.session.meta.system ?? "";
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

    /** The conversation with its images as this model may be sent them (src/providers/images.ts). */
    private sendable(messages: Message[]): Promise<Message[]> {
        const model = modelRef(this.model);
        const refusing = this.refusing?.model === model ? this.refusing.messages : undefined;
        return imagesFor(messages, { readsImages: this.model.supportsImages !== false, refused: (m) => Boolean(refusing?.has(m) || (m.role === "user" && m.meta?.imagesRefused?.includes(model))) });
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
    async run(content: UserContent[], opts: { signal: AbortSignal; display?: string; kind?: "prompt" | "command" | "wake" }): Promise<TurnEndReason> {
        if (this.running) throw new Error("Agent is already running");
        this.running = true;
        this.prompted = false;
        this.limitStop = undefined;
        // Interrupting a turn stops the delegated tasks still running, those in the background too
        // (delegated on an earlier turn, maybe before a switch to another model).
        const onAbort = () => this.cancelTasks();
        opts.signal.addEventListener("abort", onAbort, { once: true });
        this.hookStop = undefined;
        this.lastEnd = undefined;
        this.turnError = undefined;
        this.autoCompactBlocked = false;
        try {
            if (!this.o.isSubagent) {
                // SessionStart hooks still running (a first prompt sent at once): their context and watch paths come first.
                if (this.session.hooksStarting) await Promise.race([this.session.hooksStarting, new Promise((r) => opts.signal.addEventListener("abort", r, { once: true }))]);
                this.watchFiles();
                // Taken once: later turns leave the watch list as hooks have changed it since.
                const paths = this.session.hookWatchPaths;
                this.session.hookWatchPaths = undefined;
                if (paths) this.watchFiles()?.setDynamic(paths);
            }
            const reason = (this.lastEnd = await this.runInner(content, opts));
            if (reason === "error" && !this.o.isSubagent) {
                const message = this.turnError ?? "The turn ended on an error";
                void this.hooks("StopFailure", { error: errorType(message), error_details: message, last_assistant_message: this.lastAssistantText() });
            }
            return reason;
        } finally {
            await this.turnSnapshots?.end();
            opts.signal.removeEventListener("abort", onAbort);
            this.running = false;
            this.prompted = false;
        }
    }

    private async runInner(content: UserContent[], opts: { signal: AbortSignal; display?: string; kind?: "prompt" | "command" | "wake" }): Promise<TurnEndReason> {
        const { signal } = opts;
        const settings = this.hookSettings();
        const promptText = promptTextOf(content);
        const checkpoint = await this.checkpoint(opts.display ?? promptText);
        if (this.cutOff) return "aborted";

        // A wake isn't something the user typed.
        if (opts.kind !== "wake") {
            const h = await this.promptHooks(promptText, signal);
            if (h.blocked) {
                this.emit({ type: "turn_end", reason: "blocked" });
                return "blocked";
            }
            if (h.context) this.addReminder(h.context);
        }
        // SessionStart hooks' context goes with the first prompt after them.
        for (const c of this.o.isSubagent ? [] : this.session.hookContext.splice(0)) this.addReminder(c);

        // Delegated tasks that ended during a turn on another model (not a backend's) go with this prompt.
        this.deliverTasks(false);
        // Its images fitted to what providers take, before they're stored (and resent every turn). Claude Code and Codex take them as they came.
        const parts: UserContent[] = [...(isAgentBackend(this.client) ? content : await fitContent(content))];
        // A /goal to Claude Code or Codex is their own command, sent as typed: Harness's notes wait for the next prompt.
        const goalCommand = isAgentBackend(this.client) && GOAL_COMMAND.test(promptText);
        for (const r of goalCommand ? [] : this.pendingReminders.splice(0)) parts.push(reminder(r.text));
        // Codex's edits are checked too: what came after their wait goes with this prompt (after a /goal, with the next).
        const late = goalCommand ? undefined : this.lateDiagnostics();
        if (late) parts.push(late);
        const prompt = this.session.push({ role: "user", content: parts, meta: { kind: opts.kind ?? "prompt", display: opts.display, checkpoint } });
        this.prompted = true;

        // Claude Code, Codex: the backend runs the whole turn with its own tools (the prompt as stored: redacted).
        if (isAgentBackend(this.client)) return this.runBackend(this.client, prompt.content, signal, opts.kind === "wake");

        let turns = 0;
        let maxTokenStrikes = 0;
        let pauses = 0;
        let stopHookRounds = 0;
        let overflowCompacted = false;
        let imagesRejected = false;
        this.refusing = undefined;
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

            // A PreCompact hook that refused once this turn isn't asked again on every request.
            if (!this.autoCompactBlocked && this.shouldAutoCompact()) {
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
                // Refused for its images: once, they're left out and it's sent again. Answered, they stay out for this model (every later turn would be refused too).
                const model = modelRef(this.model);
                const carrying = isImageRejection(e) && !imagesRejected ? this.session.messages.filter((m) => hasImages(m) && !(m.role === "user" && m.meta?.imagesRefused?.includes(model))) : [];
                if (carrying.length) {
                    imagesRejected = true;
                    this.refusing = { model, messages: new Set(carrying) };
                    this.emit({ type: "notice", level: "warn", message: `The provider refused the conversation's images (${redact((e as Error).message)}); sending it again without them.` });
                    continue;
                }
                this.refusing = undefined;
                this.endNotice("error", redact((e as Error).message || String(e)));
                this.emit({ type: "turn_end", reason: "error" });
                return "error";
            }

            // A provider that returns (rather than throws) after an abort hands
            // back a cut-off response; drop it like any other partial response.
            if (signal.aborted) return this.interrupted(false);

            // Answered without the images it refused: they stay out for this model.
            if (this.refusing) {
                this.session.refuseImages([...this.refusing.messages], this.refusing.model);
                this.refusing = undefined;
            }

            // From here on, the redacted copy: it's what gets shown and what tools run with.
            msg = this.session.push(msg);
            this.emit({ type: "assistant", message: msg });
            if (msg.usage) {
                this.recordUsage(msg.usage);
                this.noteCache(msg.usage, this.sentAt);
            }

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
                // Events (a watched PR, a monitor) that came in during the last request: answer them in this turn.
                const woke = this.takeWakes();
                if (woke) {
                    this.session.push({ role: "user", content: [reminder(woke)], meta: { kind: "reminder" } });
                    continue;
                }

                const stopEvent = this.o.isSubagent ? "SubagentStop" : "Stop";
                if (settings.hooks?.[stopEvent]?.length && stopHookRounds < 3) {
                    const sub = this.o.subagent;
                    const last = textOf(msg);
                    const h = await this.hooks(stopEvent, { ...(sub ? { description: sub.description } : {}), stop_hook_active: stopHookRounds > 0, last_assistant_message: last, last_message: last }, signal);
                    if (this.hookStop) return this.stoppedByHook();
                    if (h?.blocked) {
                        stopHookRounds++;
                        this.session.push({ role: "user", content: [reminder(`A ${stopEvent} hook asked you to keep going:\n${h.blocked}`)], meta: { kind: "reminder" } });
                        continue;
                    }
                }
                this.noteRunningTasks();
                this.emit({ type: "turn_end", reason: "done" });
                return "done";
            }

            maxTokenStrikes = 0;
            const { results, denied } = await this.executeTools(calls, signal);
            let batchBlocked: string | undefined;
            if (!signal.aborted && settings.hooks?.PostToolBatch?.length) {
                const tool_calls = calls.map((c) => {
                    const r = results.find((x) => x.toolCallId === c.id);
                    return { tool_name: c.name, tool_input: c.input, tool_use_id: c.id, tool_response: r ? { content: r.content.slice(0, 20_000), is_error: Boolean(r.isError) } : undefined };
                });
                const h = await this.hooks("PostToolBatch", { tool_calls }, signal);
                if (h?.additionalContext) this.toolHookContext.push(`Context from a PostToolBatch hook:\n${h.additionalContext}`);
                batchBlocked = h?.blocked;
            }
            const extra: UserContent[] = [...this.toolHookContext.splice(0).map(reminder), ...this.takeTaskResults()];
            const late = this.lateDiagnostics();
            if (late) extra.push(late);
            let recorded = false;
            const record = (checkpoint?: number) => {
                this.session.push({ role: "user", content: [...results, ...extra], meta: { kind: "tool_results", ...(checkpoint !== undefined ? { checkpoint } : {}) } });
                recorded = true;
            };
            if (!signal.aborted) {
                const queued = this.o.host.drainQueued?.() ?? [];
                // Not into a round the user denied: that ends the turn, and the wake would go unanswered.
                const woke = denied ? undefined : this.takeWakes();
                if (queued.length) extra.push({ type: "text", text: `${STEERING}${queued.join("\n\n")}` });
                if (woke) extra.push(reminder(woke));
                // Steering's checkpoint records the results: everything to go with them is in by then.
                if (queued.length) await this.checkpoint(queued.join("\n"), true, record);
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
            if (this.hookStop) return this.stoppedByHook();
            if (batchBlocked) {
                this.endNotice("warn", `Stopped by a PostToolBatch hook: ${batchBlocked}`);
                this.emit({ type: "turn_end", reason: "blocked" });
                return "blocked";
            }
            if (denied) {
                this.emit({ type: "turn_end", reason: "denied" });
                return "denied";
            }
        }
    }

    /** A hook said continue: false: the turn ends here, with its reason. */
    private stoppedByHook(): TurnEndReason {
        this.endNotice("warn", `Stopped by a hook: ${this.hookStop}`);
        this.hookStop = undefined;
        this.emit({ type: "turn_end", reason: "blocked" });
        return "blocked";
    }

    /** What the model said last, for Stop and StopFailure hooks. */
    private lastAssistantText(): string {
        for (let i = this.session.messages.length - 1; i >= 0; i--) {
            const m = this.session.messages[i]!;
            if (m.role === "assistant") return textOf(m);
            if (m.role === "user" && m.meta?.kind === "prompt") break;
        }
        return "";
    }

    /** Wakes that may join the running turn, as one reminder; noted in the transcript. */
    private takeWakes(): string | undefined {
        if (this.o.isSubagent) return undefined;
        const wakes = this.state.wakes?.drainRunning() ?? [];
        if (!wakes.length) return undefined;
        this.emit({ type: "notice", level: "info", message: `↻ ${wakeDisplay(wakes)}` });
        return formatWakes(wakes);
    }

    /** A new file checkpoint for a user prompt; a sub-agent's edits belong to its parent's. */
    /**
     * The UserPromptSubmit hooks, for a prompt the user sent: whether one blocked it (the user is told), or
     * the context they add, as a note for the model.
     */
    private async promptHooks(promptText: string, signal: AbortSignal): Promise<{ blocked?: boolean; context?: string }> {
        if (this.o.isSubagent || !this.hookSettings().hooks?.UserPromptSubmit?.length) return {};
        const h = await this.hooks("UserPromptSubmit", { prompt: promptText }, signal);
        const blocked = h?.blocked ?? h?.stop;
        if (blocked) {
            this.hookStop = undefined;
            this.emit({ type: "notice", level: "warn", message: `Prompt blocked by hook: ${blocked}` });
            return { blocked: true };
        }
        return h?.additionalContext ? { context: `Context from a UserPromptSubmit hook:\n${h.additionalContext}` } : {};
    }

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
        if (level === "error") this.turnError = message;
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

    // -----------------------------------------------------------------------
    // Hooks (src/agent/hooks.ts)

    /**
     * Run this agent's hooks for an event, with the input fields every event
     * has. Problems and systemMessages show as notices. A sub-agent's hooks
     * get its parent's session id, and its own as agent_id.
     */
    async hooks(event: HookEvent, payload: Record<string, unknown>, signal?: AbortSignal): Promise<HookOutcome | undefined> {
        const settings = this.o.settings();
        if (!settings.hooks?.[event]?.length) return undefined;
        const sub = this.o.subagent;
        const common: Record<string, unknown> = { session_id: sub?.parentSessionId ?? this.session.meta.id, permission_mode: this.o.mode.get(), ...(sub ? { agent_id: this.session.meta.id, agent_type: sub.type } : {}) };
        if (settings.effort) common.effort = { level: settings.effort };
        const h = await runHooks(settings, event, { ...common, ...payload }, this.state.cwd, this.hookServices(signal)).catch((e): HookOutcome => ({ errors: [`${event} hook failed: ${(e as Error).message}`], messages: [] }));
        for (const message of h.errors) this.emit({ type: "notice", level: "warn", message });
        // A hook's systemMessage is for you to read, not a problem.
        for (const message of h.messages) this.emit({ type: "notice", level: "info", message });
        if (h.stop && this.running) this.hookStop ??= h.stop;
        if (h.watchPaths) this.watchFiles()?.setDynamic(h.watchPaths);
        return h;
    }

    /** What prompt and mcp_tool hooks run on: the small model, and this agent's MCP tools. */
    private hookServices(signal?: AbortSignal): HookServices {
        const helpers = this.o.helpers;
        return {
            signal,
            complete: helpers?.complete
                ? async (system, prompt, sig, model) => {
                      const r = model ? await helpers.resolveModel?.(model) : undefined;
                      if (model && !r) throw new Error(`${model} isn't set up here`);
                      if (!r) return helpers.complete!(system, prompt, sig);
                      const res = await r.client.stream({ model: r.model, system, messages: [{ role: "user", content: [{ type: "text", text: redact(prompt) }] }], tools: [], maxTokens: 1024, lightweight: true, signal: sig }, () => {});
                      if (res.usage) {
                          const cost = costOf(res.usage, r.model);
                          this.session.recordUsage(modelRef(r.model), res.usage, cost.usd, cost.unknown);
                      }
                      return textOf(res);
                  }
                : undefined,
            callTool: async (server, name, input, sig) => {
                const tool = this.tools.find((t) => t.category === "mcp" && t.name === toolNameFor(server, name));
                if (!tool) throw new Error(`no tool ${name} on a connected MCP server "${server}"`);
                const r = await tool.run(input, this.toolContext("", sig));
                return { text: r.content, isError: Boolean(r.isError) };
            },
            onAsync: (o) => {
                for (const message of o.errors) this.emit({ type: "notice", level: "warn", message });
                for (const message of o.messages) this.emit({ type: "notice", level: "info", message });
                if (o.additionalContext) this.addReminder(`Context from a background hook:\n${o.additionalContext}`);
            },
        };
    }

    /** The FileChanged watcher, once there are FileChanged hooks or paths to watch. Main agent only. */
    private watchFiles(): FileWatchHooks | undefined {
        if (this.o.isSubagent || this.disposed) return undefined;
        const list = this.o.settings().hooks?.FileChanged ?? [];
        if (!this.fileWatch && !list.length) return undefined;
        this.fileWatch ??= new FileWatchHooks(this.state.projectRoot, (path, event) => void this.fileChanged(path, event));
        this.fileWatch.setConfigured(list.map((h) => h.matcher));
        return this.fileWatch;
    }

    private async fileChanged(path: string, event: FileEvent) {
        await this.hooks("FileChanged", { file_path: path, event });
    }

    /** The session's working directory moved (Bash cd, or the user's own shell command). */
    async cwdChanged(from: string) {
        if (from === this.state.cwd) return;
        await this.hooks("CwdChanged", { old_cwd: from, new_cwd: this.state.cwd });
    }

    private recordUsage(usage: Usage) {
        const cost = costOf(usage, this.model);
        this.session.recordUsage(modelRef(this.model), usage, cost.usd, cost.unknown);
        this.contextTokens = promptTokens(usage) + usage.outputTokens;
        this.lastUsageTotal = this.session.messages.length;
        this.emit({ type: "usage", usage, cost, contextTokens: this.contextTokens });
    }

    /**
     * What a response says of the prompt cache: the history it sent is cached
     * from `at` for the provider's TTL (Anthropic's default five minutes, or
     * the hour Claude Code asks for on a subscription).
     */
    private noteCache(usage: Usage, at: number) {
        const ttlMs = cacheTtl(usage, getProvider(this.model.provider)?.kind === "anthropic", this.cache?.ttlMs);
        this.cache = ttlMs ? { at, ttlMs } : undefined;
    }

    /**
     * When this conversation, left idle, should compact (src/agent/idle-compact.ts),
     * or null: a sub-agent, a turn that didn't finish, delegated tasks still
     * running (their results go with the next message), a context too small or
     * a cache too short-lived for it to pay.
     */
    idleCompactPlan(now = Date.now()): IdleCompactPlan | null {
        if (this.o.isSubagent || this.running || this.lastEnd !== "done") return null;
        if (this.delegations?.running().length) return null;
        if (this.idleTried) return null;
        return idleCompactPlan({ settings: this.o.settings(), cache: this.cache, contextTokens: this.contextTokens, now });
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
                    // After any retries: the cache dates from the request that was answered.
                    this.sentAt = Date.now();
                    this.idleTried = false;
                    return await this.client.stream(this.request(await this.sendable(messages ?? this.session.messages), signal, extra), (e: StreamEvent) => this.forward(e));
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
                // Sent again by the provider itself: the cache dates from now.
                if (e.resent) this.sentAt = Date.now();
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
    async compact(opts: { auto: boolean; signal: AbortSignal; instructions?: string; continuing?: boolean; idle?: boolean }): Promise<boolean> {
        // Until a request of the conversation's own: usage a cancelled backend compaction reports doesn't count.
        if (opts.idle) this.idleTried = true;
        if (isAgentBackend(this.client)) return this.compactBackend(this.client, opts);
        const history = this.session.messages;
        if (history.length < 2) return false;
        if (!(await this.preCompact(opts))) return false;
        this.emit({ type: "compact_start", auto: opts.auto, ...(opts.idle ? { idle: true } : {}) });
        const req = await this.sendable([...history, compactRequestMessage(opts.instructions)]);
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
            // Refused for its images too: the text transcript below has none.
            if (!isContextOverflow(e) && !isImageRejection(e)) throw e;
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
        this.session.compact(summary, keep, opts.idle);
        this.contextTokens = 0;
        this.lastUsageTotal = 0;
        this.cache = undefined;
        this.state.fileState.clear();
        this.emit({ type: "compact_end", summary, ...(opts.idle ? { idle: true } : {}) });
        if (!this.o.isSubagent) void this.hooks("PostCompact", { trigger: opts.auto ? "auto" : "manual", compact_summary: summary }).then(() => this.compacted());
        return true;
    }

    /** PreCompact hooks: false when one blocked the compaction (it's then skipped, saying why). */
    private async preCompact(opts: { auto: boolean; signal: AbortSignal; instructions?: string }): Promise<boolean> {
        if (this.o.isSubagent) return true;
        const h = await this.hooks("PreCompact", { trigger: opts.auto ? "auto" : "manual", custom_instructions: opts.instructions ?? null }, opts.signal);
        if (!h?.blocked) return true;
        if (opts.auto) this.autoCompactBlocked = true;
        this.emit({ type: "notice", level: "warn", message: `Compaction skipped: a PreCompact hook blocked it: ${h.blocked}` });
        return false;
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

    /** Claude Code runs this turn with the plugins loaded itself (src/plugins/native.ts). */
    private pluginsNative(): boolean {
        return isAgentBackend(this.client) && !this.o.readOnly && loadsPluginsNatively(this.model.provider);
    }

    /** Settings for the hooks the harness runs: without the plugins' when Claude Code runs those. */
    private hookSettings(): Settings {
        const s = this.o.settings();
        return this.pluginsNative() ? withoutPluginHooks(s) : s;
    }

    private backendTurn(signal: AbortSignal, host: BackendHost): Omit<BackendTurn, "prompt" | "images" | "resumeId"> {
        const s = this.o.settings();
        let trusted = false;
        let approvedMcpServers: ApprovedMcpServers | undefined;
        try {
            // Implicit session trust does not authorize CLI project configuration, and a run told not to trust the folder
            // (the SDK's trusted: false) keeps it off even where the user trusted it.
            trusted = this.projectTrusted() !== false && trustedByUser(this.state.cwd);
            approvedMcpServers = this.o.approvedMcpServers?.();
        } catch {
            trusted = false;
            host.emit({ type: "notice", level: "warn", message: "Could not check folder trust or approved MCP servers; this turn runs without project configuration or MCP servers." });
        }
        return {
            cwd: this.state.cwd,
            accountId: this.session.accountId(this.model.provider),
            model: this.model,
            mode: this.o.mode.get(),
            effort: s.effort,
            fastMode: this.fastMode(),
            appendSystemPrompt: this.o.appendSystemPrompt,
            backgroundWaitSec: s.claudeCode?.backgroundWaitSec,
            additionalDirectories: s.permissions?.additionalDirectories ?? [],
            trusted,
            // The backend registers a project's own only where the user trusted it (the list may come from implicit trust).
            skills: this.o.skills?.() ?? [],
            ...(this.pluginsNative() ? { pluginDirs: claudePluginDirs(this.state.cwd, trusted) } : {}),
            approvedMcpServers,
            rules: { deny: s.permissions?.deny ?? [], ask: s.permissions?.ask ?? [], root: this.state.projectRoot },
            maxTurns: this.o.maxTurns,
            // Claude Code runs some of them itself; Codex only says what it does, so it hears of all of them.
            // Claude Code runs the plugins' hooks with the plugins (--plugin-dir), so only the harness's own are registered with it.
            hooks: this.model.provider === "claude-code" ? backendOwnedHooks(this.hookSettings()) : s.hooks,
            orchestrator: this.orchestrator(),
            readOnly: this.o.readOnly,
            agents: this.nativeAgents(trusted),
            signal,
            host,
        };
    }

    /** On Claude Code, the harness's agents run on its own Agent tool; none for sub-agents, which can't start more. */
    private nativeAgents(trusted: boolean): BackendTurn["agents"] {
        this.nativeDefs.clear();
        if (this.model.provider !== "claude-code" || this.o.isSubagent || this.o.readOnly) return undefined;
        try {
            const defs = loadAgents(this.state.projectRoot);
            const notes: string[] = [];
            const agents = claudeAgents(defs, { mode: this.o.mode.get(), trusted, cwd: this.state.cwd, projectRoot: this.state.projectRoot, settings: this.o.settings(), notes });
            for (const d of defs) if (Object.hasOwn(agents, d.name)) this.nativeDefs.set(d.name, d);
            // Said once a session, not every turn.
            for (const n of notes) if (!this.nativeNotes.has(n)) {
                this.nativeNotes.add(n);
                this.emit({ type: "notice", level: "warn", message: n });
            }
            return agents;
        } catch {
            return undefined;
        }
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
        const scheduling = Boolean(this.state.scheduler);
        // A watch wakes the session later: only one that stays open (not -p) has somewhere to wake.
        const watching = Boolean(this.state.wakes && this.state.watchers) && !this.oneShot;
        // Claude Code has a Monitor of its own; Codex gets Harness's.
        const monitoring = watching && caller === "codex";
        if (!delegating && !(store && ask) && !scheduling && !watching) return undefined;
        const tools: ServerTool[] = [];
        const instructions: string[] = [];
        if (delegating) {
            tools.push(
                ...orchestratorTools({
                    caller: () => this.model.provider,
                    listings: () => this.listings(),
                    projectRoot: () => this.state.projectRoot,
                    projectTrusted: () => this.projectTrusted(),
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
        if (scheduling) {
            tools.push(...scheduleServerTools(() => this.state.scheduler));
            instructions.push(SCHEDULE_INSTRUCTIONS);
        }
        if (watching) {
            tools.push(...watchServerTools((signal) => this.toolContext("", signal)));
            instructions.push(WATCH_INSTRUCTIONS);
        }
        if (monitoring) {
            tools.push(...monitorServerTools((tool, input, signal, callId) => this.runServed(tool, input, signal, callId), () => this.state));
            instructions.push(MONITOR_INSTRUCTIONS);
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

    /**
     * The host's decision about the folder (whether this run uses the project's memory files, agents and
     * skills), or undefined when it made none and the folder's own trust decides.
     */
    private projectTrusted(): boolean | undefined {
        return this.o.trusted?.();
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
        const backend = isAgentBackend(this.client);
        const name = backend ? (getProvider(this.model.provider)?.name ?? this.model.provider) : (this.model.name ?? this.model.id);
        for (const t of this.delegations?.undelivered() ?? []) {
            t.delivered = true;
            this.addReminder(taskEndedNote(t, backend));
            if (notify) this.emit({ type: "notice", level: "info", message: `${backend ? "Delegated" : "Background"} task ${t.id} "${t.description}" (${t.model}) ${t.status === "done" ? "finished" : t.status}. Its result goes to ${name} with your next message.` });
        }
    }

    /** Background tasks that ended while this turn's tools ran: their results go with the tool results. */
    private takeTaskResults(): UserContent[] {
        if (isAgentBackend(this.client)) return [];
        return (this.delegations?.undelivered() ?? []).map((t) => {
            t.delivered = true;
            return reminder(taskEndedNote(t, false));
        });
    }

    /** At the end of a turn of the harness's own: background tasks still running say where their results will go. */
    private noteRunningTasks() {
        if (this.o.isSubagent) return;
        // One that finished while the model was answering: said now, and its result goes with the next prompt.
        this.deliverTasks();
        const running = this.delegations?.running().length ?? 0;
        if (!running) return;
        this.emit({ type: "notice", level: "info", message: `${running} background task${running === 1 ? " is" : "s are"} still running. ${running === 1 ? "Its result goes" : "Their results go"} to ${this.model.name ?? this.model.id} with your next message (/tasks shows them, /tasks stop stops them).` });
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

    /** Children keep the accounts they started with even when the parent switches. */
    childUsesAccount(provider: string, id: string): boolean {
        return [...this.children].some((child) => child.session.accountId(provider) === id || child.childUsesAccount(provider, id));
    }

    /** Adding accounts refreshes the protection snapshot of every running CLI child. */
    hasCliChild(): boolean {
        return [...this.children].some((child) => isAgentBackend(child.client) || child.hasCliChild());
    }

    /** Stop one delegated task, or all of them; how many were running. */
    stopDelegated(id?: string): number {
        if (!this.delegations) return 0;
        return id ? Number(this.delegations.cancel(id)) : this.delegations.cancelAll();
    }

    /** The session is done with this agent: stop its delegated tasks (waiting a moment for them) and revoke its MCP token. */
    async dispose(graceMs = 3000): Promise<void> {
        this.disposed = true;
        this.fileWatch?.close();
        this.fileWatch = undefined;
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
        // Only that its last turn was stopped, which it never heard (Harness stopped or died part way), and
        // Harness's notes to it since (a message that missed that turn): said plainly, not as another model's turn.
        if (resume && missed.length && missed.every((m) => m.role === "user" && (m.meta?.kind === "interrupt" || m.meta?.kind === "reminder"))) {
            const kinds = missed.map((m) => (m.role === "user" ? m.meta?.kind : undefined));
            const notes = missed.filter((_, i) => kinds[i] === "reminder").map(textOf);
            return [...(kinds.includes("interrupt") ? [reminder(BACKEND_CUT_OFF).text] : []), ...notes, text].join("\n\n");
        }
        const { text: transcript, shortenedChars } = handoffTranscript(missed, 60_000);
        if (!transcript && !shortenedChars) return text;
        const intro = resume
            ? "While another model answered in this session, the conversation went on. Here is what happened since your last turn:"
            : "This conversation started before you joined it (with another model, or before the history was compacted or rewound). Here it is so far:";
        const shortened = shortenedChars ? ` Parts of it were shortened or left out (${shortenedChars} characters); the user's messages are given whole where they fit.` : "";
        return `<conversation-so-far>\n${intro}${shortened}\n\n${transcript}\n</conversation-so-far>\n\n${text}`;
    }

    /** `woken`: the turn is for wakes, so its prompt carries others' words (see BackendTurn.synthetic). */
    private async runBackend(backend: AgentBackendClient, parts: UserContent[], signal: AbortSignal, woken = false): Promise<TurnEndReason> {
        // A wake while the backend works is offered to it as a message the user queued is (Codex steers with it at once).
        const stopWaking = this.o.isSubagent ? undefined : this.state.wakes?.onReady(() => this.queueChanged());
        try {
            return await this.runBackendTurn(backend, parts, signal, woken);
        } finally {
            stopWaking?.();
            this.delegateCalls = [];
            // Written after the backend sync cursor: a resumed CLI must see this
            // on its next prompt, including after reopening or switching models.
            if (this.backendStopReminders.length) {
                this.session.push({ role: "user", content: [reminder(this.backendStopReminders.splice(0).join("\n"))], meta: { kind: "reminder" } });
            }
        }
    }

    private backendStopReminders: string[] = [];

    /** How a backend runs the harness's hooks: whole events (Codex's items), or one handler Claude Code calls back for. */
    private backendHooks(signal: AbortSignal): Pick<BackendHost, "hooks" | "hookHandler"> {
        return {
            hooks: (event, payload) => this.hooks(event, payload, signal),
            hookHandler: async (event, h, input, sig) => {
                // As the harness's own hooks: its session (Claude Code's own id beside it), and `if` applied here.
                const sub = this.o.subagent;
                const full: Record<string, unknown> = { ...input, hook_event_name: event, backend_session_id: input.session_id, session_id: sub?.parentSessionId ?? this.session.meta.id, ...(sub && input.agent_id === undefined ? { agent_id: this.session.meta.id, agent_type: sub.type } : {}) };
                const cwd = typeof input.cwd === "string" ? input.cwd : this.state.cwd;
                if (!hookApplies(h, event, full, cwd)) return { kind: "none" };
                // Claude Code waits for its callback: an async hook answers at once and goes on in the background.
                if (isAsync(h)) {
                    runInBackground(h, event, full, cwd, this.hookServices(signal));
                    return { kind: "none" };
                }
                const r = await runHandler(h, event, full, cwd, this.hookServices(AbortSignal.any([signal, sig])));
                if (r.kind === "error") this.emit({ type: "notice", level: "warn", message: r.message });
                if (r.kind === "output" && typeof r.json?.systemMessage === "string") this.emit({ type: "notice", level: "info", message: r.json.systemMessage });
                return r;
            },
        };
    }

    private async runBackendTurn(backend: AgentBackendClient, parts: UserContent[], signal: AbortSignal, woken: boolean): Promise<TurnEndReason> {
        // Its first request goes with the prompt.
        this.backendRequestAt = Date.now();
        this.idleTried = false;
        const provider = this.model.provider;
        const name = getProvider(provider)?.name ?? provider;
        const folder = this.backendFolder(provider);
        let promptIndex = this.session.messages.length - 1;
        const { text, images, documents } = forBackend(parts, readsPdf(this.model));
        let declined = false;
        /** What drainQueued handed over that came from wakes, not the user. */
        const wakeTexts = new Set<string>();
        const host: BackendHost = {
            ...this.backendHooks(signal),
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
            sessionId: (id) => this.session.setBackendSession(provider, id, this.session.messages.length, folder),
            onQueued: (listener) => {
                this.queueListeners.add(listener);
                return () => this.queueListeners.delete(listener);
            },
            // Saved past the sync cursor (see runBackend), so the next turn is sent them, after a restart too.
            diagnose: (paths) => this.diagnoseBackendEdits(paths, signal),
            undelivered: (texts) => {
                const news = texts.filter((t) => wakeTexts.has(t));
                const typed = texts.filter((t) => !wakeTexts.has(t));
                if (typed.length) this.backendStopReminders.push(`The user sent this while you were working, but your turn ended before it reached you:\n${typed.join("\n\n")}`);
                if (news.length) this.backendStopReminders.push(`This arrived while you were working, but your turn ended before it reached you:\n${news.join("\n\n")}`);
            },
            fromWake: (text) => wakeTexts.has(text),
            drainQueued: async (progress) => {
                if (this.cutOff) return [];
                // What the backend said before them goes first: the host places their turn after it.
                let recorded = false;
                const record = () => {
                    if (recorded || !progress) return;
                    recorded = true;
                    this.recordBackendTurn(provider, name, progress());
                };
                const queued = this.o.host.drainQueued?.(record) ?? [];
                // Events a watch raised join the running turn as the user's messages do (Codex steers with them at once).
                const woke = this.takeWakes();
                if (!queued.length && !woke) return [];
                record();
                const out: string[] = [];
                if (queued.length) {
                    await this.checkpoint(queued.join("\n"), false, (checkpoint) => {
                        const m = this.session.push({ role: "user", content: [{ type: "text", text: queued.join("\n\n") }], meta: { kind: "prompt", display: queued.join("\n"), checkpoint } });
                        out.push(textOf(m));
                    });
                }
                if (woke) {
                    // Not a prompt: no checkpoint, and the auto-mode reviewer doesn't read it as the user's request.
                    const m = this.session.push({ role: "user", content: [reminder(woke)], meta: { kind: "reminder" } });
                    const text = textOf(m);
                    wakeTexts.add(text);
                    out.push(text);
                }
                if (this.cutOff) return [];
                return out;
            },
            drainWaiting: async (progress, live) => {
                if (this.cutOff || !this.o.host.drainWaiting) return undefined;
                let context: string | undefined;
                let start: TurnCapture | undefined;
                let taken: { parts: UserContent[]; display: string } | undefined;
                // One its hooks block doesn't go; the next does, in order and through its own hooks.
                for (let blocked = true; blocked && !taken; ) {
                    blocked = false;
                    taken = await this.o.host.drainWaiting({
                        record: () => {
                            if (progress) this.recordBackendTurn(provider, name, progress());
                        },
                        // Its hooks, as for a prompt sent on its own (runInner): one can block it. Then what its
                        // start snapshot will be, taken before it goes but used only once it does: a stop
                        // meanwhile leaves the open turn's snapshot as it was.
                        admit: async (parts) => {
                            const h = await this.promptHooks(promptTextOf(parts), signal);
                            context = h.context;
                            if (h.blocked) {
                                blocked = true;
                                return "blocked";
                            }
                            const stopped = () => this.cutOff || signal.aborted || live?.() === false;
                            if (stopped()) return "stopped";
                            start = !this.o.isSubagent && this.o.trusted?.() ? await this.turnSnapshots?.prepare() : undefined;
                            return stopped() ? "stopped" : "go";
                        },
                    });
                    if (this.cutOff || signal.aborted) blocked = false;
                }
                if (!taken) return undefined;
                // Stored as a prompt sent then would be, with what a hook adds after it. Nothing is awaited from
                // "go" to here, nor from here to the backend sending it: an interrupt can't fall in between.
                const history = this.o.isSubagent ? undefined : this.state.fileHistory;
                const checkpoint = history?.begin();
                const content = this.session.push({ role: "user", content: [...taken.parts, ...(context ? [reminder(context)] : [])], meta: { kind: "prompt", display: taken.display, checkpoint } }).content;
                // Its turn's snapshot starts from what was captured before it went (above); snapshots run in
                // order, so the turn's end waits for it.
                if (checkpoint !== undefined && start) void this.turnSnapshots?.beginWith(checkpoint, redact(taken.display), start).catch(() => undefined);
                const prompt = forBackend(content, readsPdf(this.model));
                // The user's own words, for the skills they name ($name), as for a turn's prompt (runBackendTurn).
                const first = content[0]?.type === "text" && prompt.text.startsWith(content[0].text) ? content[0].text : undefined;
                return { ...prompt, ...(first !== undefined ? { request: first, requestAfter: prompt.text.slice(first.length) } : {}) };
            },
        };
        // A stop from Harness's checks of a tool it serves the backend (a hook, a PermissionRequest interrupt) ends the backend's turn, as a stop on its own call does.
        const stopper = new AbortController();
        this.stopServedTurn = () => {
            declined = true;
            stopper.abort();
        };
        const base = this.backendTurn(AbortSignal.any([signal, stopper.signal]), host);
        let stopRounds = 0;
        // The user's own message, for the skills it names: its first part, not the files and notes after it.
        // A sub-agent's task is the parent model's words, not the user's: it runs no skill the model may not.
        // Nor does a wake's, which quotes others (a PR comment's /name or $name).
        const first = !this.o.isSubagent && !woken && parts[0]?.type === "text" && text.startsWith(parts[0].text) ? parts[0].text : undefined;
        const asked = { request: first, requestAfter: first === undefined ? undefined : text.slice(first.length) };
        let prompt = text;
        // The conversation so far goes beside a /goal (goalContext), so the command stays the whole prompt.
        const goalCommand = GOAL_COMMAND.test(text);
        const toSend = (r?: { synced: number }) =>
            goalCommand && prompt === text ? { prompt, goalContext: this.backendPrompt("", promptIndex, r).trim() || undefined } : { prompt: this.backendPrompt(prompt, promptIndex, r) };
        let promptImages = images;
        let promptDocuments = documents;
        while (true) {
            const resume = this.backendResume(provider, folder);
            this.emit({ type: "request_start" });
            let result: BackendResult;
            try {
                // A sub-agent kept going (a Stop hook) takes up a speed change since.
                const sent = toSend(resume);
                result = await backend.runTurn({ ...base, approvedMcpServers: this.freshApprovals(base), fastMode: this.fastMode(), ...sent, synthetic: woken || sent.prompt !== prompt, ...(prompt === text ? asked : {}), images: promptImages, documents: promptDocuments, resumeId: resume?.id, forkSession: resume?.fork });
                if (result.resumeFailed) {
                    // Gone, or made in another folder: start a new one with this conversation as context.
                    this.session.forgetBackendSession(provider);
                    this.emit({ type: "notice", level: "warn", message: `${redact(result.error ?? `Couldn't continue the earlier ${name} session`)}. Starting a new one with this conversation as context.` });
                    const fresh = toSend();
                    result = await backend.runTurn({ ...base, approvedMcpServers: this.freshApprovals(base), fastMode: this.fastMode(), ...fresh, synthetic: woken || fresh.prompt !== prompt, ...(prompt === text ? asked : {}), images: promptImages, documents: promptDocuments, resumeId: undefined });
                }
            } catch (e) {
                if (isAbort(e, signal)) return this.interrupted(false);
                this.endNotice("error", redact((e as Error).message || String(e)));
                this.emit({ type: "turn_end", reason: "error" });
                return "error";
            }
            this.recordBackendTurn(provider, name, result);
            if (result.reason === "aborted" || signal.aborted) {
                if (this.hookStop && !signal.aborted) {
                    this.endNotice("warn", `Stopped by a hook: ${this.hookStop}`);
                    this.hookStop = undefined;
                    this.syncBackend(provider);
                    return this.endBackendTurn(provider, "blocked");
                }
                const r = declined ? this.endBackendTurn(provider, "denied") : this.interrupted(false);
                this.syncBackend(provider);
                return r;
            }
            if (declined) return this.endBackendTurn(provider, "denied");
            if (result.reason === "error") {
                this.limitStop = result.limit;
                this.endNotice("error", redact(result.error || `${name} stopped with an error.`));
                return this.endBackendTurn(provider, "error");
            }
            if (result.reason === "max_turns") {
                this.endNotice("warn", `Stopped after ${this.o.maxTurns ?? "the maximum"} model turns (max turns).`);
                return this.endBackendTurn(provider, "max_turns");
            }
            const settings = this.hookSettings();
            // A sub-agent's turn ends with SubagentStop, as one the harness runs does.
            const stopEvent = this.o.isSubagent ? "SubagentStop" : "Stop";
            if (settings.hooks?.[stopEvent]?.length && stopRounds < 3) {
                const sub = this.o.subagent;
                const h = await this.hooks(stopEvent, { ...(sub ? { description: sub.description } : {}), stop_hook_active: stopRounds > 0, last_assistant_message: result.text, last_message: result.text }, signal);
                if (this.hookStop) {
                    this.endNotice("warn", `Stopped by a hook: ${this.hookStop}`);
                    this.hookStop = undefined;
                    return this.endBackendTurn(provider, "blocked");
                }
                if (h?.blocked) {
                    stopRounds++;
                    prompt = reminder([`A ${stopEvent} hook asked you to keep going:\n${redact(h.blocked)}`, ...this.backendStopReminders.splice(0)].join("\n\n")).text;
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
        if (r.backgroundStopped?.length) {
            const message = `Harness stopped these ${name} background tasks: ${r.backgroundStopped.join("; ")}. They are no longer running and will not produce further results. Restart them only if still needed; do not wait for their old task IDs.`;
            this.session.recordNotice("warn", message);
            this.backendStopReminders.push(message);
        }
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

    /** The account folder a CLI backend's sessions live in; other backends have none. */
    private backendFolder(provider: string): string | undefined {
        if (!(ACCOUNT_PROVIDERS as readonly string[]).includes(provider)) return undefined;
        return accountRealPath(account(provider, this.session.accountId(provider)).folder);
    }

    private backendResume(provider: string, folder: string | undefined) {
        const hadSession = this.session.backends.has(provider);
        const resume = this.session.backendSession(provider, folder);
        if (hadSession && !resume) {
            const name = getProvider(provider)?.name ?? provider;
            const message = `${name}'s account folder changed. Starting a new ${name} thread with this conversation as context.`;
            this.session.recordNotice("info", message);
            this.emit({ type: "notice", level: "info", message });
        }
        return resume;
    }

    /** The backend session has now seen everything up to here (minus `pending` messages it hasn't been sent yet). */
    private syncBackend(provider: string, pending = 0) {
        const b = this.session.backends.get(provider);
        // Until the native fork answers with its own id, the shared source has seen no new messages.
        if (b && !b.fork) this.session.setBackendSession(provider, b.id, this.session.messages.length - pending);
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

    private async compactBackend(backend: AgentBackendClient, opts: { auto: boolean; signal: AbortSignal; instructions?: string; idle?: boolean }): Promise<boolean> {
        const provider = this.model.provider;
        const folder = this.backendFolder(provider);
        const resume = this.backendResume(provider, folder);
        if (!resume) return false;
        // Claude Code runs PreCompact and PostCompact hooks itself (they're registered with it); Codex can't.
        const ownHooks = provider === "codex";
        if (ownHooks && !(await this.preCompact(opts))) return false;
        this.emit({ type: "compact_start", auto: opts.auto, ...(opts.idle ? { idle: true } : {}) });
        const host: BackendHost = {
            ...this.backendHooks(opts.signal),
            emit: (e) => {
                if (e.type === "notice" || e.type === "retry" || e.type === "limits") this.emit(e);
            },
            mode: () => this.o.mode.get(),
            permission: async () => ({ allow: false, message: "Not during compaction.", stop: true }),
            askQuestions: async () => undefined,
            approvePlan: async () => ({ approved: false }),
            setMode: () => {},
            usage: (u, o) => this.recordBackendUsage(u, o),
            sessionId: (id) => this.session.setBackendSession(provider, id, this.session.messages.length, folder),
            drainQueued: () => [],
        };
        const r = await backend.compact({ ...this.backendTurn(opts.signal, host), resumeId: resume.id, forkSession: resume.fork, instructions: opts.instructions });
        if (r.reason === "aborted") throw new ProviderError("aborted");
        if (r.reason === "error") throw new Error(r.error ?? "Compaction failed");
        this.contextTokens = 0;
        this.cache = undefined;
        this.emit({ type: "compact_end", summary: `${getProvider(provider)?.name ?? provider} compacted its own context.`, ...(opts.idle ? { idle: true } : {}) });
        if (ownHooks && !this.o.isSubagent) void this.hooks("PostCompact", { trigger: opts.auto ? "auto" : "manual", compact_summary: "" });
        // Claude Code runs SessionStart (compact) itself (backendOwnedHooks); the harness runs it for Codex, and the memory files' InstructionsLoaded on both.
        if (!this.o.isSubagent) void (provider === "claude-code" ? instructionsLoadedHooks(this.o.settings(), this.session, "compact", this.state.cwd, (msg, level = "warn") => this.emit({ type: "notice", level, message: msg }), this.hookServices()) : this.compacted());
        return true;
    }

    /** After compaction, as in Claude Code: SessionStart (source compact) and the memory files' InstructionsLoaded; their context goes with the next prompt. */
    private compacted(): Promise<void> {
        return sessionStartHooks(this.o.settings(), this.session, "compact", this.state.cwd, (msg, level = "warn") => this.emit({ type: "notice", level, message: msg }), this.hookServices());
    }

    /**
     * Backend tool calls use the harness's tool (when there is one) for titles
     * and rendering. Their output is redacted here, as the harness's own tools
     * redact theirs (keys in a file the backend read, say).
     */
    private emitFromBackend(e: AgentEvent) {
        // Tools' results go back to the model in its next request: the cache is read from about now.
        if (e.type === "tool_end") this.backendRequestAt = Date.now();
        e = redactBackendEvent(e);
        this.noteServedCall(e, this.servedMain);
        // Harness's own tools it served (Monitor for Codex) show as those tools.
        if ((e.type === "tool_start" || e.type === "tool_end") && e.call.name.startsWith(`mcp__${MCP_SERVER_NAME}__`)) {
            const native = nativeMonitorCall(e.call.name.slice(`mcp__${MCP_SERVER_NAME}__`.length), (e.call.input ?? {}) as Record<string, unknown>);
            const tool = native && this.findTool(native.name);
            if (native && tool) {
                const call = { ...e.call, ...native };
                let title = native.name;
                try {
                    title = tool.title(native.input as any);
                } catch {
                    // keep the name
                }
                e = e.type === "tool_start" ? { ...e, call, title, tool } : { ...e, call, title };
            }
        }
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

    /**
     * When the backend's latest request went, or a little before: its cache
     * lasts from then (its usage comes at the end of the turn). The CLI reports
     * a request only once it has answered, so what's known is when the turn
     * started, or when tool results last went back: never a reply's end, which
     * for a long reply would be minutes after the cache was read.
     */
    private backendRequestAt?: number;

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
        this.noteCache(usage, this.backendRequestAt ?? Date.now());
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

    private servedCalls = 0;
    /** The backend's calls of the tools Harness serves it, by whose they are: its main thread's, or a sub-agent's. */
    private servedMain = new Set<string>();
    private servedSub = new Set<string>();

    private noteServedCall(e: AgentEvent, into: Set<string>): void {
        if (e.type === "subagent") return this.noteServedCall(e.event, this.servedSub);
        if ((e.type !== "tool_start" && e.type !== "tool_end") || !e.call.name.startsWith(`mcp__${MCP_SERVER_NAME}__monitor`)) return;
        if (e.type === "tool_start") into.add(e.call.id);
        else into.delete(e.call.id);
    }

    /** A served call one of the backend's sub-agents made. Its event may come just after the call, so this waits a moment for it. */
    private async fromBackendSubagent(callId: string): Promise<boolean> {
        for (let i = 0; i < 40; i++) {
            if (this.servedMain.has(callId)) return false;
            if (this.servedSub.has(callId)) return true;
            await Bun.sleep(50);
        }
        return false;
    }
    /** Ends the backend's running turn: a served call's checks said stop. */
    private stopServedTurn?: () => void;

    /**
     * One of Harness's own tools, called by a backend through the harness MCP server (Monitor for Codex). The CLI
     * approves Harness's tools without asking, so it goes through the same checks as the tool's call from a model
     * Harness runs: validation, read-only agents, PreToolUse hooks, rules and mode, the reviewer, the user, the
     * sandbox, PostToolUse hooks. The backend's own event for the call is what the transcript shows.
     */
    private async runServed(tool: Tool<any>, input: Record<string, unknown>, signal: AbortSignal, callId?: string): Promise<ServerToolResult> {
        // Only the main agent can be woken, so a sub-agent gets no Monitor (Harness's sub-agents don't either). Nor can its stop end the main turn.
        if (callId && (await this.fromBackendSubagent(callId))) return { text: "Monitor isn't available to sub-agents: only the main agent can be woken by one.", isError: true };
        const call: ToolCallPart = { type: "tool_call", id: callId ?? `served_${++this.servedCalls}`, name: tool.name, input };
        const prep = await this.prepare(call, signal, tool);
        if ("result" in prep) {
            if (prep.stop || this.hookStop) this.stopServedTurn?.();
            return { text: prep.result.content, isError: true };
        }
        // Cancelled while its checks ran (a hook, the reviewer): it doesn't start.
        if (signal.aborted) return { text: "Interrupted by user before this tool ran.", isError: true };
        const context: string[] = [];
        const r = await this.runTool(call, prep.tool, prep.input, signal, prep.auto, prep.sandbox, context);
        if (this.hookStop) this.stopServedTurn?.();
        // What a PostToolUse hook adds goes with the result: it's the backend that reads it.
        return { text: [r.content, ...context].join("\n\n"), isError: r.isError };
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
    /**
     * A PermissionRequest hook approved other input than the backend asked about: it goes back to the
     * backend to run (Claude Code takes it; Codex refuses it), once it passes what the original had to.
     */
    private rewrittenByHook(tool: Tool<any>, raw: Record<string, unknown>, mode: PermissionMode, cwd: string): PermissionAnswer {
        const own = this.findTool(tool.name);
        const input = own ? coerceInput(own, raw) : raw;
        const invalid = own ? validateInput(own, input) : undefined;
        if (invalid) return { allow: false, message: `A PermissionRequest hook changed the input to something invalid: ${invalid}`, stop: false };
        if (this.o.readOnly) {
            const reads = tool.category === "read" || tool.category === "network" || (tool.name === "Bash" && isReadOnlyCommand(String(input.command ?? "")));
            if (!reads) return { allow: false, message: readOnlyRefusal(tool.name, String(input.command ?? "")), stop: false };
        }
        const d = this.o.checker.check(tool, input, mode, cwd);
        if (d.behavior === "deny") return { allow: false, message: d.reason ?? "Denied by a permission rule.", stop: false };
        return { allow: true, updatedInput: input };
    }

    private async backendPermission(req: BackendPermission, signal: AbortSignal): Promise<PermissionAnswer> {
        const tool = this.findTool(req.toolName) ?? backendTool(req.toolName, req.title);
        const input = req.input;
        // One of the harness's agents Claude Code runs: its own permissionMode, as when the harness runs it.
        const own = req.agentType ? this.nativeDefs.get(req.agentType) : undefined;
        const mode = childMode(this.o.mode.get(), own?.permissionMode);
        const cwd = this.state.cwd;
        // A read-only agent (explore) on a backend: reads, searches and read-only commands only.
        if (this.o.readOnly) {
            const reads = !req.widens && (tool.category === "read" || tool.category === "network" || (tool.name === "Bash" && isReadOnlyCommand(String(input.command ?? ""))));
            if (!reads) return { allow: false, message: readOnlyRefusal(tool.name, String(input.command ?? ""), req.widens ? "it asks for more access than the sandbox gives" : undefined), stop: false };
        }
        // Approved without asking: by an allow rule, or an edit the harness's mode approves (accept edits: inside the workspace).
        const approves = (d: Decision) => d.behavior === "allow" && (Boolean(d.rule) || d.remembered === true || tool.category === "edit");
        const memory = { memoryDir: this.o.memoryDir };
        let decision = this.o.checker.check(tool, input, mode, cwd, memory);
        let ruled = approves(decision);
        for (const p of req.otherPaths ?? []) {
            if (decision.behavior === "deny") break;
            const d = this.o.checker.check(tool, { ...input, file_path: p }, mode, cwd, memory);
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
        // Codex was told to ask only so PreToolUse hooks would see the call (bypass mode): the mode decides, as it would have.
        if (req.hooksOnly && decision.behavior === "allow") ruled = true;
        // A PreToolUse hook that asks wants the user, whatever the rules say.
        if (req.hookDecision === "ask") ruled = false;
        if (ruled) return { allow: true };
        // A PreToolUse hook approved it: as for the harness's own tools, past everything but deny rules and dangerous commands.
        if (req.hookDecision === "allow" && !decision.dangerous) return { allow: true };
        if (this.o.settings().hooks?.PermissionRequest?.length) {
            const h = await this.hooks("PermissionRequest", { tool_name: tool.name, tool_input: input, ...(tool.category === "mcp" ? { mcp_server: mcpServerOf(tool.name) } : {}) }, signal);
            // continue: false ends the turn whatever the hook decided, as on every event.
            if (h?.stop) return { allow: false, message: `Stopped by PermissionRequest hook: ${h.stop}`, stop: true };
            if (h?.permission?.behavior === "allow") return h.updatedInput ? this.rewrittenByHook(tool, h.updatedInput, mode, cwd) : { allow: true };
            if (h?.permission?.behavior === "deny") return { allow: false, message: h.permission.message || "Denied by a PermissionRequest hook.", stop: Boolean(h.permission.interrupt) };
        }
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
            ...this.o.checker.withGrant(tool, input, decision, cwd),
            behavior: "ask" as const,
            reason: decision.behavior === "ask" ? (decision.reason ?? req.reason) : req.reason,
            suggestions: decision.suggestions ?? (command ? suggestBashRules(command) : tool.category === "mcp" ? [tool.name] : undefined),
            sandbox: undefined,
            needsClassifier: undefined,
        };
        const answer = await this.o.host.askPermission({ tool, input, title, decision: ask, preview, ...(req.agentLabel ? { agentLabel: req.agentLabel } : {}), ...(req.callId ? { callId: req.callId } : {}) });
        if (signal.aborted) return { allow: false, message: "Interrupted by user", stop: true };
        if (answer.setMode) this.o.mode.set(answer.setMode);
        if (answer.rules?.length) {
            this.o.checker.sessionAllow.push(...answer.rules);
            if (answer.scope && answer.scope !== "session") this.o.host.saveRules?.(answer.rules, answer.scope);
        }
        if (answer.allow) {
            const grant = answer.grant ? ask.grant : undefined;
            this.o.checker.approve(tool, input, cwd, { sandbox: decision.sandbox, grant });
            if (grant) this.o.checker.applyGrant(grant);
            return { allow: true, mode: answer.setMode };
        }
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
            // Only the session's own agent can be woken: a sub-agent's turn ends with its task.
            wakes: this.o.isSubagent ? undefined : this.state.wakes,
            hidden: (toolName, abs) => this.o.checker.hiddenFromSearch(toolName, abs),
            runSubagent: this.o.isSubagent ? undefined : (opts, sig) => this.runSubagent(callId, opts, sig),
            taskStatus: this.o.isSubagent ? undefined : (id, ms, sig) => this.taskStatus(id, ms, sig),
            listModels: this.o.isSubagent ? undefined : (opts, sig) => catalog(this.state.projectRoot, { ...opts, projectAgents: this.projectTrusted(), listings: this.o.listings?.(), current: modelRef(this.model), signal: sig }),
            webSearch: this.o.helpers?.webSearch,
            sample: this.o.helpers?.sample,
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
                // A hook's continue:false ends the turn here, so later calls in the reply don't run.
                if (denied || signal.aborted || this.hookStop) break;
                const prep = await this.prepare(call, signal);
                if ("result" in prep) {
                    results.set(call.id, prep.result);
                    if (prep.stop) denied = true;
                } else approved.push({ call, ...prep });
            }
            if (signal.aborted) break;
            await Promise.all(approved.map(async (a) => results.set(a.call.id, await this.runTool(a.call, a.tool, a.input, signal, a.auto, a.sandbox))));
            if (denied || signal.aborted || this.hookStop) break;
        }
        const out: ToolResultPart[] = calls.map(
            (c) =>
                results.get(c.id) ?? {
                    type: "tool_result",
                    toolCallId: c.id,
                    toolName: c.name,
                    content: signal.aborted
                        ? "Interrupted by user before this tool ran."
                        : this.hookStop
                          ? `Not run: a hook stopped the turn (${this.hookStop}).`
                          : "Not run: the user rejected an earlier tool call in this batch.",
                    isError: true,
                },
        );
        return { results: out, denied };
    }

    private errorResult(call: ToolCallPart, content: string, display?: ToolDisplay, quiet = false): ToolResultPart {
        const r: ToolResult = { content, isError: true, display };
        if (!quiet) this.emit({ type: "tool_end", call, result: r, durationMs: 0 });
        return { type: "tool_result", toolCallId: call.id, toolName: call.name, content, isError: true };
    }

    /**
     * Validate and get permission. Either an approved job or a ready result.
     * `served`: the tool, for a call a backend made through the harness MCP server (it shows as the backend's own tool call).
     */
    private async prepare(
        call: ToolCallPart,
        signal: AbortSignal,
        served?: Tool<any>,
    ): Promise<{ tool: Tool<any>; input: any; auto?: string; sandbox?: boolean } | { result: ToolResultPart; stop?: boolean }> {
        const quiet = Boolean(served);
        const tool = served ?? this.findTool(call.name);
        if (!tool) {
            if (!quiet) this.emit({ type: "tool_start", call, title: call.name });
            return { result: this.errorResult(call, `No such tool: ${call.name}. Available tools: ${this.tools.map((t) => t.name).join(", ")}`, undefined, quiet) };
        }
        let input: any = coerceInput(tool, call.input ?? {});
        let title = call.name;
        try {
            title = tool.title(input);
        } catch {
            // keep the bare name
        }
        if (!quiet) this.emit({ type: "tool_start", call, title, tool });

        const schemaErr = validateInput(tool, input);
        if (schemaErr) return { result: this.errorResult(call, `Invalid input for ${tool.name}: ${schemaErr}`, undefined, quiet) };
        const ctx = this.toolContext(call.id, signal);
        try {
            const err = await tool.validate?.(input, ctx);
            if (err) return { result: this.errorResult(call, err, undefined, quiet) };
        } catch (e) {
            return { result: this.errorResult(call, `Validation failed: ${(e as Error).message}`, undefined, quiet) };
        }

        // Read-only agents (explore) never change anything, whatever a hook later rewrites the call into.
        const writes = (input: any) => this.o.readOnly && (tool.category === "edit" || (isShellTool(tool.name) && !isReadOnlyCommand(String(input.command ?? ""))) || (tool.category === "mcp" && !isReadOnly(tool, input)));
        if (writes(input)) return { result: this.errorResult(call, readOnlyRefusal(tool.name, String(input.command ?? "")), undefined, quiet) };

        const settings = this.o.settings();
        let hookDecision: "allow" | "deny" | "ask" | undefined;
        if (settings.hooks?.PreToolUse?.length) {
            const h = await this.hooks("PreToolUse", { tool_name: tool.name, tool_input: input, tool_use_id: call.id }, signal);
            if (this.hookStop) return { result: this.errorResult(call, `Stopped by PreToolUse hook: ${this.hookStop}`, undefined, quiet) };
            if (h?.blocked) return { result: this.errorResult(call, `Blocked by PreToolUse hook: ${h.blocked}`, undefined, quiet) };
            hookDecision = h?.decision;
            if (hookDecision === "deny") return { result: this.errorResult(call, `Denied by PreToolUse hook${h?.reason ? `: ${h.reason}` : ""}`, undefined, quiet) };
            if (h?.updatedInput) {
                // The hook's input replaces the model's, and is checked like it.
                input = coerceInput(tool, h.updatedInput);
                const err = validateInput(tool, input);
                if (err) return { result: this.errorResult(call, `A PreToolUse hook changed the input to something invalid: ${err}`, undefined, quiet) };
                if (writes(input)) return { result: this.errorResult(call, readOnlyRefusal(tool.name, String(input.command ?? "")), undefined, quiet) };
            }
        }

        const mode = this.o.mode.get();
        let decision = this.o.checker.check(tool, input, mode, this.state.cwd, { memoryDir: this.o.memoryDir });
        if (decision.behavior === "deny") return { result: this.errorResult(call, decision.reason ?? "Permission denied", undefined, quiet) };
        // What an approval is remembered by: the call as the model made it, before hosts are added.
        const asked = input;
        // The hosts the checker opens by itself (settings, registries) join the ones the command listed.
        if (isShellTool(tool.name) && decision.sandbox && decision.hosts?.length) input = { ...input, allowedHosts: decision.hosts };
        // Whatever approves it, a command the checker sandboxed stays sandboxed.
        const sandbox = decision.sandbox;
        if (decision.behavior === "allow" && hookDecision !== "ask") return { tool, input, sandbox, auto: sandbox ? "sandboxed" : undefined };
        if (hookDecision === "allow" && !decision.dangerous) return { tool, input, sandbox, auto: "hook" };

        let classifierReason: string | undefined;
        let summary: string | undefined;
        // A hook that asked wants the user, not the auto-mode reviewer.
        if (decision.needsClassifier && !decision.dangerous && hookDecision !== "ask" && this.o.classifier) {
            try {
                const v = await this.o.classifier.classify({ toolName: tool.name, input, cwd: this.state.cwd, context: this.reviewContext(), sandboxed: sandbox, sensitive: decision.sensitive }, signal);
                if (v.warning) this.emit({ type: "notice", level: "warn", message: v.warning });
                if (v.decision === "allow") return { tool, input, sandbox, auto: v.ms === undefined ? v.reason : `${v.reason} (reviewed in ${(v.ms / 1000).toFixed(1)}s)` };
                // Told why, the agent can take a safer way (the user decides once blocks pile up).
                if (v.decision === "block") {
                    void this.hooks("PermissionDenied", { tool_name: tool.name, tool_input: input, tool_use_id: call.id, reason: v.reason });
                    return { result: this.errorResult(call, blockedByReviewer(v.reason), undefined, quiet) };
                }
                classifierReason = v.reason;
                summary = v.summary;
            } catch (e) {
                if (isAbort(e, signal)) return { result: this.errorResult(call, "Interrupted", undefined, quiet) };
            }
        }

        if (settings.hooks?.PermissionRequest?.length) {
            const h = await this.hooks("PermissionRequest", { tool_name: tool.name, tool_input: input, ...(tool.category === "mcp" ? { mcp_server: mcpServerOf(tool.name) } : {}) }, signal);
            // continue: false ends the turn whatever the hook decided, as on every event.
            if (this.hookStop) return { result: this.errorResult(call, `Stopped by PermissionRequest hook: ${this.hookStop}`, undefined, quiet) };
            if (h?.permission?.behavior === "allow") {
                const approvedInput = h.updatedInput ? coerceInput(tool, h.updatedInput) : input;
                const err = h.updatedInput ? validateInput(tool, approvedInput) : undefined;
                if (err) return { result: this.errorResult(call, `A PermissionRequest hook changed the input to something invalid: ${err}`, undefined, quiet) };
                if (!h.updatedInput) return { tool, input, sandbox, auto: "hook" };
                if (writes(approvedInput)) return { result: this.errorResult(call, readOnlyRefusal(tool.name, String(approvedInput.command ?? "")), undefined, quiet) };
                // The hook answers for you, but not past a deny rule, and the new command gets its own sandbox.
                const again = this.o.checker.check(tool, approvedInput, mode, this.state.cwd);
                if (again.behavior === "deny") return { result: this.errorResult(call, again.reason ?? "Permission denied", undefined, quiet) };
                const hosts = isShellTool(tool.name) && again.sandbox && again.hosts?.length ? { allowedHosts: again.hosts } : {};
                return { tool, input: { ...approvedInput, ...hosts }, sandbox: again.sandbox, auto: "hook" };
            }
            if (h?.permission?.behavior === "deny") return { result: this.errorResult(call, h.permission.message || "Denied by a PermissionRequest hook", undefined, quiet), stop: h.permission.interrupt };
        }

        if (!this.o.host.askPermission) {
            return {
                result: this.errorResult(
                    call,
                    `Permission to use ${tool.name} was not granted (non-interactive session). ${decision.reason ?? ""} Allow it with --allowedTools, a permission rule, or --permission-mode.`.trim(),
                    undefined,
                    quiet,
                ),
            };
        }

        let preview: ToolDisplay | undefined;
        try {
            preview = await tool.preview?.(input, ctx);
        } catch {
            // preview is optional
        }
        // No reviewer ran (or it gave none): a long command gets a line from the model, but the popup never waits long for it.
        const command = isShellTool(tool.name) ? String(input.command ?? "") : "";
        if (!summary && command && needsSummary(command)) summary = await this.o.classifier?.summarize({ toolName: tool.name, input, cwd: this.state.cwd }, signal);
        if (signal.aborted) return { result: this.errorResult(call, "Interrupted by user", undefined, quiet) };
        // Whichever step wrote it (the summary model, the full review, a repeated block), none for an action it couldn't see whole.
        if (summary && !summaryFits(input)) summary = undefined;
        decision = this.o.checker.withGrant(tool, asked, decision, this.state.cwd);
        const answer = await this.o.host.askPermission({ tool, input, title, decision, preview, classifierReason, summary, agentLabel: this.o.isSubagent ? "sub-agent" : undefined, callId: call.id, ...(quiet ? { signal } : {}) });
        if (signal.aborted) return { result: this.errorResult(call, "Interrupted by user", undefined, quiet) };
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
        if (answer.allow) {
            // This exact action needs no asking again; with a grant, what it covers doesn't either.
            const grant = answer.grant ? decision.grant : undefined;
            this.o.checker.approve(tool, asked, this.state.cwd, { sandbox, grant });
            if (grant) this.o.checker.applyGrant(grant);
            return { tool, input, sandbox };
        }
        const fb = answer.feedback?.trim();
        if (fb) {
            return { result: this.errorResult(call, `The user declined this tool call and said:\n${fb}`, undefined, quiet) };
        }
        return {
            result: this.errorResult(call, "The user declined this tool call. Stop and wait for the user to tell you how to proceed; don't retry it.", undefined, quiet),
            stop: true,
        };
    }

    /** `served`: a call a backend made through the harness MCP server (no events; hook context is collected here). */
    private async runTool(call: ToolCallPart, tool: Tool<any>, input: any, signal: AbortSignal, auto?: string, sandboxed?: boolean, served?: string[]): Promise<ToolResultPart> {
        const quiet = Boolean(served);
        const started = Date.now();
        this.noteAction(tool, input);
        if (auto && !quiet) this.emit({ type: "tool_approved", id: call.id, reason: auto, sandboxed });
        let sandbox: Sandbox | undefined;
        if (sandboxed) {
            const kind = sandboxKind();
            // Approved on the condition that it's contained: never fall back to running it bare.
            if (!kind) return this.errorResult(call, "The sandbox this command was approved for isn't available. Run it with dangerouslyDisableSandbox: true to have it reviewed instead.", undefined, quiet);
            sandbox = { kind, policy: sandboxPolicy(this.o.checker.workspaceRoots(), { harnessHome: harnessHome() }) };
        }
        let result: ToolResult;
        const cwdBefore = this.state.cwd;
        try {
            result = await tool.run(input, this.toolContext(call.id, signal, sandbox));
        } catch (e) {
            result = signal.aborted ? { content: "Interrupted by user", isError: true } : { content: `Tool error: ${redact((e as Error).message ?? String(e))}`, isError: true };
        }
        const durationMs = Date.now() - started;
        // Tools redact their own output; this catches any that print a secret (RequestSecret's) without doing so, before hooks, windows or the model.
        result = redactResult(result);
        // Its images fitted to what providers take, before anything shows or stores them.
        result = await fitToolImages(result);
        if (!this.o.isSubagent && this.state.cwd !== cwdBefore) void this.cwdChanged(cwdBefore);
        if (!result.isError && DIAGNOSED_TOOLS.has(tool.name) && this.state.lsp && !signal.aborted) result = await this.withDiagnostics(result, input, signal);
        // Succeeded: PostToolUse. Failed: PostToolUseFailure (a stopped tool runs neither, as in Claude Code).
        const event = result.isError ? "PostToolUseFailure" : "PostToolUse";
        if (this.o.settings().hooks?.[event]?.length && !signal.aborted) {
            const payload = result.isError
                ? { tool_name: tool.name, tool_input: input, tool_use_id: call.id, error: result.content.slice(0, 20_000), is_interrupt: false, duration_ms: durationMs }
                : { tool_name: tool.name, tool_input: input, tool_use_id: call.id, tool_response: { content: result.content.slice(0, 20_000), is_error: false }, duration_ms: durationMs };
            const h = await this.hooks(event, { ...payload, ...(tool.category === "mcp" ? { mcp_server: mcpServerOf(tool.name) } : {}) }, signal);
            if (h?.updatedToolOutput !== undefined) result = { ...result, content: redact(h.updatedToolOutput) };
            if (h?.blocked) result = { ...result, content: `${result.content}\n\n${event} hook feedback:\n${h.blocked}` };
            if (h?.additionalContext) (served ?? this.toolHookContext).push(`Context from a ${event} hook (${tool.name}):\n${h.additionalContext}`);
        }
        if (!quiet) this.emit({ type: "tool_end", call, result, durationMs: Date.now() - started });
        return {
            type: "tool_result",
            toolCallId: call.id,
            toolName: call.name,
            content: result.content,
            images: result.images as ImagePart[] | undefined,
            isError: result.isError,
        };
    }

    /** The language server's news on an edited file, after the tool's result (and under it, for the user). */
    private async withDiagnostics(result: ToolResult, input: { file_path?: unknown }, signal: AbortSignal): Promise<ToolResult> {
        if (typeof input.file_path !== "string") return result;
        const abs = expandPath(input.file_path, this.state.cwd);
        if (!this.state.lsp!.handles(abs) || Bun.file(abs).size > MAX_FILE_CHARS) return result;
        try {
            // From disk: what the result shows is redacted.
            const text = await readFile(abs, "utf-8");
            const report = await this.state.lsp!.afterEdit(abs, text, signal);
            if (!report) return result;
            return { ...result, content: `${result.content}\n\n${redact(formatForModel(report))}`, display: { ...result.display, diagnostics: redactedReport(report) } };
        } catch {
            return result;
        }
    }

    /**
     * The language server's news on files a backend changed itself (Codex has
     * no diagnostics of its own): a note for the model, and a line for the user.
     */
    private async diagnoseBackendEdits(paths: string[], signal: AbortSignal): Promise<string | undefined> {
        const lsp = this.state.lsp;
        if (!lsp || signal.aborted) return undefined;
        const root = this.state.projectRoot;
        const real = canonical(root);
        const files: { path: string; text: string }[] = [];
        for (const p of paths) {
            let abs = expandPath(p, this.state.cwd);
            // The backend names files by their real path; the servers know the project by the path it was opened at.
            if (!isInside(abs, root) && isInside(abs, real)) abs = join(root, relative(real, abs));
            if (!lsp.handles(abs)) continue;
            try {
                if (Bun.file(abs).size <= MAX_FILE_CHARS) files.push({ path: abs, text: await readFile(abs, "utf-8") });
            } catch {
                // gone (deleted, or moved again)
            }
        }
        if (!files.length) return undefined;
        const report = await lsp.afterEdits(files, signal).catch(() => undefined);
        if (!report || signal.aborted) return undefined;
        this.emit({ type: "notice", level: "info", message: `Diagnostics: ${summaryLine(report)} in ${report.files.map((f) => f.path).join(", ")}` });
        return redact(formatForModel(report));
    }

    /** Diagnostics that came after their edit stopped waiting, as a note for the model (and a line for the user). */
    private lateDiagnostics(): UserContent | undefined {
        const late = this.state.lsp?.takeLate();
        if (!late) return undefined;
        this.emit({ type: "notice", level: "info", message: `Diagnostics: ${summaryLine(late)} in ${late.files.map((f) => f.path).join(", ")}` });
        return reminder(redact(formatForModel(late)));
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
        // The checker is the session's, shared with its sub-agents: so are the approvals.
        const approvals = this.o.checker.recentApprovals();
        if (this.o.parentRequests) return { ...this.o.parentRequests(), delegatedTask: this.o.delegatedTask, recentActions: [...this.recentActions], approvals };
        return { ...this.requestContext(), recentActions: [...this.recentActions], approvals };
    }

    private noteAction(tool: Tool<any>, input: any) {
        const i = (input ?? {}) as Record<string, unknown>;
        const what = i.command ?? i.file_path ?? i.notebook_path ?? i.url ?? i.pattern ?? i.path ?? i.query ?? JSON.stringify(input ?? {});
        this.recentActions.push(`${tool.name}: ${String(what).replace(/\s+/g, " ").slice(0, 300)}`);
        if (this.recentActions.length > 8) this.recentActions.shift();
    }

    // -----------------------------------------------------------------------
    // Sub-agents (Task tool, and tasks a backend delegates)

    private async runSubagent(callId: string, opts: { description: string; prompt: string; agentType?: string; model?: string; background?: boolean }, signal: AbortSignal): Promise<{ report: string; isError?: boolean; model?: string; background?: boolean }> {
        const agent = opts.agentType || "general-purpose";
        const def = loadAgents(this.state.projectRoot, this.projectTrusted()).find((a) => a.name === agent);
        const req: ChildRequest = { description: opts.description, prompt: opts.prompt, agent, model: opts.model, callId, def };
        // A one-shot run (-p) ends with this turn: nothing would be there to take a background result.
        if (def && (opts.background || def.background) && !this.oneShot) return this.startBackground(req, def);
        const r = await this.runChild(callId, req, signal);
        if (r.status === "cancelled") return { report: "The sub-agent was interrupted by the user.", model: r.model };
        if (r.status === "failed") return { report: r.report, isError: true, model: r.model };
        return { report: r.report || "(The sub-agent finished without a report.)", model: r.model };
    }

    /** A Task in the background: it returns now, and the result comes with the next tool results or prompt. */
    private async startBackground(req: ChildRequest, def: AgentDef): Promise<{ report: string; isError?: boolean; model?: string; background?: boolean }> {
        // The model it runs on, for its row and report: one asked for must be set up; the agent type's falls back to this one.
        let model = req.model;
        if (!model && def.model && def.model !== modelRef(this.model)) model = (await this.o.helpers?.resolveModel?.(def.model)) ? def.model : undefined;
        model ??= modelRef(this.model);
        const t = this.tasks().start({ ...req, model, writes: !def.readOnly && def.isolation !== "worktree" }, { status: "TaskStatus", cancel: "/tasks stop (the user's)" });
        if (typeof t === "string") return { report: t, isError: true, model };
        return { report: `Started background task ${t.id} "${t.description}" (${t.agent} on ${t.model}). Its result comes to you automatically when it finishes; TaskStatus shows how it's going, or waits for it.`, model, background: true };
    }

    /** The TaskStatus tool: a background task's result or state, or all of them. */
    private async taskStatus(id: string | undefined, waitMs: number, signal: AbortSignal): Promise<{ text: string; isError?: boolean }> {
        const none = "No background tasks were started in this session.";
        if (!this.delegations) return { text: none, isError: Boolean(id) };
        return taskStatusText(this.delegations, id, waitMs, signal, none);
    }

    /**
     * Run a sub-agent on its own fresh session: on the model asked for, the
     * agent type's, or this agent's. It shares this agent's permission mode
     * (unless its definition sets one), rules and prompts (labeled with its
     * task), and its spend is added to this session's. What its definition
     * adds (src/agent/agents.ts) is set up here: a worktree, its own MCP
     * servers, hooks, skills and memory.
     */
    private async runChild(callId: string, req: ChildRequest, signal: AbortSignal): Promise<ChildResult> {
        const started = Date.now();
        const fail = (report: string, model = req.model ?? modelRef(this.model)): ChildResult => ({ status: "failed", report, model, tokens: 0, durationMs: Date.now() - started });
        const type = req.agent || "general-purpose";
        const defs = req.def?.name === type && (req.def.source !== "project" || this.projectTrusted() !== false) ? [req.def] : loadAgents(this.state.projectRoot, this.projectTrusted());
        const def = defs.find((a) => a.name === type);
        if (!def) return fail(`Unknown agent type "${type}". Available: ${defs.map((d) => d.name).join(", ")}`);

        let model = this.model;
        let client = this.client;
        const ref = req.model || def.model;
        if (ref && ref !== modelRef(this.model)) {
            const r = await this.o.helpers?.resolveModel?.(ref);
            if (r) ({ model, client } = r);
            // An agent type's model that isn't set up falls back to this one; one asked for by name doesn't.
            else if (req.model) return fail(`Can't run a sub-agent on ${req.model}: ${parseModelRef(req.model) ? "that provider isn't set up here, or the model isn't known" : "it isn't a provider:model reference"}. Call ListModels to see the models that can run.`);
        }
        // Asked for (delegate's effort), else the agent type's, else the session's: each only where the model has it.
        const effort = req.effort ?? (def.effort && inheritedEffort(model, def.effort)) ?? inheritedEffort(model, this.o.settings().effort);
        const backend = isAgentBackend(client);
        const other = modelRef(model) !== modelRef(this.model);
        const maxTurns = def.maxTurns ?? DEFAULT_MAX_TURNS;
        /** What it couldn't set up, shown under it. */
        const notes: string[] = [];

        // Its own checkout: the agent works there, and it's removed afterwards if nothing changed.
        let worktree: AgentWorktree | undefined;
        if (def.isolation === "worktree") {
            try {
                worktree = await createAgentWorktree({ cwd: this.state.cwd, projectRoot: this.state.projectRoot, agent: def.name });
            } catch (e) {
                return fail(`Couldn't create a git worktree for the ${def.name} agent (it has isolation: worktree): ${redact((e as Error).message ?? String(e))}`);
            }
        }
        const cwd = worktree?.cwd ?? this.state.cwd;
        const projectRoot = worktree?.projectRoot ?? this.state.projectRoot;

        let servers: AgentServers | undefined;
        if (def.mcpServers?.length && backend) notes.push(`mcpServers apply to agents ${APP_TITLE} runs itself; on ${getProvider(model.provider)?.name ?? model.provider} it has the session's servers.`);
        else if (def.mcpServers?.length) {
            servers = await startAgentServers(def, { projectRoot: this.state.projectRoot, settings: this.o.settings(), has: (name) => this.tools.some((t) => fromServers(t.name, [name])), signal }).catch((e) => {
                notes.push(`Its MCP servers didn't start: ${redact((e as Error).message ?? String(e))}`);
                return undefined;
            });
            notes.push(...(servers?.notes ?? []));
        }

        const exclude = new Set(["Task", "TaskStatus", "Monitor", "ListModels", "TodoWrite", "AskUserQuestion", "RequestSecret", "ExitPlanMode", ...CRON_TOOL_NAMES]);
        let tools = this.tools.filter((t) => !exclude.has(t.name));
        // Its own servers' tools (their names never match a configured server's: startAgentServers refuses those).
        if (servers?.tools.length) tools = [...tools, ...servers.tools];
        if (def.readOnly) tools = tools.filter((t) => EXPLORE_TOOLS.has(t.name) || (t.category === "mcp" && t.readOnly === true));
        if (def.tools?.length) {
            const allow = new Set(def.tools);
            // The servers it names, and the file tools its memory needs, come with it; a server it lists tools of gets only those.
            const named = [...(servers?.referenced ?? []), ...(servers?.started ?? [])].filter((name) => !def.tools!.some((a) => fromServers(a, [name])));
            tools = tools.filter((t) => allow.has(t.name) || [...allow].some((a) => mcpToolMatches(a, t.name)) || fromServers(t.name, named) || (def.memory && MEMORY_TOOLS.has(t.name)));
        }
        if (def.disallowedTools?.length) {
            const deny = def.disallowedTools;
            tools = tools.filter((t) => !deny.includes(t.name) && !deny.some((d) => mcpToolMatches(d, t.name)));
        }

        // What goes in its system prompt besides its own: the skills it preloads, its memory, its servers' instructions.
        const extra: string[] = [];
        for (const name of def.skills ?? []) {
            const skill = findSkill(name, this.state.projectRoot, this.projectTrusted());
            if (skill) extra.push(`# Skill: ${name}\n\n${skill.body}`);
            else notes.push(`Skill "${name}" wasn't found, so it wasn't loaded.`);
        }
        // The main checkout's, not a worktree's: what it learns outlives the worktree.
        const memoryDir = def.memory ? agentMemoryDir(def.memory, def.name, this.state.projectRoot) : undefined;
        if (def.memory && memoryDir) {
            const dir = memoryDir;
            const readable = def.memory === "user" || (this.projectTrusted() ?? isTrusted(this.state.projectRoot));
            if (def.memory === "local") keepLocal(dir);
            extra.push(agentMemoryPrompt(def.memory, dir, readable ? readAgentMemory(dir) : undefined));
        }
        if (servers?.instructions) extra.push(servers.instructions);
        if (worktree) extra.push(`# Your worktree\nYou work in a git worktree of your own, ${worktree.path}, on branch ${worktree.branch} (from ${worktree.base.slice(0, 12)}). Make your changes there. When you're done, commit them on that branch; the main agent will review and merge it. If you change nothing, the worktree is removed.`);
        const own = [def.prompt, ...extra].filter(Boolean).join("\n\n");

        const system = buildSystemPrompt({
            cwd: projectRoot,
            model,
            replaceCore: own ? `${SUBAGENT_CORE}\n\n${own}` : SUBAGENT_CORE,
            append: def.readOnly ? EXPLORE_APPEND : undefined,
            includeGit: false,
            projectFiles: this.projectTrusted(),
        });
        const session = Session.create(projectRoot, { persist: false, system });
        // Not saved itself: a Claude Code or Codex session it runs on is recorded in this one.
        session.runsFor = this.session;
        for (const provider of ["claude-code", "codex"]) session.setAccount(provider, this.session.accountId(provider));
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
            systemPrompt: undefined,
            settings: () => {
                const parent = this.o.settings();
                return { ...parent, effort, hooks: withAgentHooks(parent.hooks, def.hooks) };
            },
            parentRequests: () => this.requestContext(),
            delegatedTask: req.prompt,
            // At the speed the parent runs at (not fast where the parent's model has none and shows standard),
            // on its own model if that one has fast mode.
            parentFastMode: () => this.fastMode(),
            subagent: { type, description: req.description, parentSessionId: this.session.meta.id },
            readOnly: def.readOnly,
            // A read-only agent on Claude Code or Codex runs in a mode where they ask before changing anything (and the harness refuses).
            // In auto, Codex's is its read-only auto mode: reads run in its read-only sandbox without asking. Claude Code's
            // stays in default, where every command comes to the harness, which runs read-only ones without asking.
            // One whose definition sets a mode runs in it, unless the session's is bypass, auto or plan (childMode).
            mode: backend && def.readOnly
                ? { get: () => readOnlyBackendMode(parentMode.get(), model.provider), set: () => {} }
                : def.permissionMode
                  ? { get: () => childMode(parentMode.get(), def.permissionMode), set: () => {} }
                  : this.o.mode,
            memoryDir,
            maxTurns,
            // Claude Code and Codex use their own system prompts: this goes on top.
            appendSystemPrompt: backend ? [BACKEND_SUBAGENT, own, def.readOnly ? BACKEND_READ_ONLY : ""].filter(Boolean).join("\n\n") : undefined,
            nativeWebSearch: this.o.nativeWebSearch && model.provider === this.model.provider,
            toolState: {
                cwd,
                projectRoot,
                // What it has read: the parent's files, unless it works in a checkout of its own.
                fileState: worktree ? new Map() : new Map(this.state.fileState),
                todos: [],
                shells: trackShells(this.state.shells, shellsStarted),
                fileHistory: this.state.fileHistory,
                // Its Bash sees the secrets the user gave this session (only the main agent can ask for one).
                secrets: this.state.secrets,
                // Same servers, its own record of what it edited and was told.
                lsp: this.state.lsp?.fork(),
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
        for (const n of notes) parentHost.emit({ type: "subagent", parentId: callId, label, event: { type: "notice", level: "warn", message: n } });
        try {
            const starting = await this.hooks("SubagentStart", { agent_id: session.meta.id, agent_type: type, description: req.description }, signal);
            if (starting?.additionalContext) child.addReminder(`Context from a SubagentStart hook:\n${starting.additionalContext}`);
            // continue: false: it doesn't start at all (and the parent's turn ends too).
            if (starting?.stop) {
                lastError = `Stopped by SubagentStart hook: ${starting.stop}`;
                reason = "blocked";
            } else reason = await child.run([{ type: "text", text: req.prompt }], { signal });
        } catch (e) {
            reason = signal.aborted ? "aborted" : "error";
            lastError ??= redact((e as Error).message ?? String(e));
        } finally {
            this.children.delete(child);
            await servers?.close().catch(() => undefined);
        }
        // Stopped: so is what it left running (a watcher writing files, say), even where the shell itself has exited.
        if (signal.aborted) await Promise.all([...shellsStarted].map((id) => this.state.shells.get(id)?.kill().catch(() => undefined)));
        // Its worktree goes if it left nothing there, and nothing it started still runs in it.
        let worktreeText = "";
        if (worktree) {
            const busy = [...shellsStarted].some((id) => this.state.shells.get(id)?.exitCode === null);
            const outcome: WorktreeOutcome = busy ? { removed: false, error: "A background shell it started is still running there, so the worktree is kept." } : await finishAgentWorktree(worktree).catch(() => ({ removed: false, error: "Git couldn't tell whether it has changes, so it was kept." }));
            worktreeText = worktreeNote(worktree, outcome);
        }
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
        const result = (status: ChildResult["status"], text: string): ChildResult => ({ status, report: [text, worktreeText].filter(Boolean).join("\n\n"), model: modelRef(model), tokens, cost: cost || undefined, durationMs: Date.now() - started });
        switch (reason) {
            case "aborted":
                return result("cancelled", report ? `It was stopped. Its last message:\n${report}` : "It was stopped before it reported anything.");
            case "error":
            case "blocked":
                return result("failed", `The sub-agent stopped with an error${lastError ? `: ${lastError}` : "."}${report ? `\nIts last message:\n${report}` : ""}`);
            case "denied":
                return result("failed", `The user declined one of its actions, which stopped it.${report ? ` Its last message:\n${report}` : ""}`);
            case "max_turns":
                return result("done", `${report}\n\n(It stopped at its limit of ${maxTurns} model turns.)`.trim());
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

/** What the main agent hears when a task it started in the background (or delegated, on a backend) has ended. */
function taskEndedNote(t: DelegatedTask, delegated: boolean): string {
    return `${delegated ? `A task you delegated (with the ${MCP_SERVER_NAME} delegate tool)` : `A sub-agent you started in the background (Task ${t.id})`} has ended. Its result:\n\n${taskReport(t)}`;
}

/** The tools an agent with memory keeps it with, even when its definition's tools list leaves them out. */
const MEMORY_TOOLS = new Set(["Read", "Write", "Edit"]);

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
    if (e.type === "activity") return { ...e, text: e.text === undefined ? undefined : redact(e.text) };
    if (e.type === "tool_progress") return { ...e, text: redact(e.text) };
    if (e.type === "tool_end") return { ...e, result: redactResult(e.result) };
    if (e.type === "subagent") return { ...e, event: e.event.type === "text" ? { ...e.event, text: redact(e.event.text) } : redactBackendEvent(e.event) };
    return e;
}

/** How a sub-agent's own sub-agent is named (in its permission prompts, and in the GUI): under the one whose it is. */
function nestedAgentLabel(parent: string, label: string): string {
    return `${parent} › ${label}`;
}

/** The mode a read-only agent on Claude Code or Codex runs in, under the session's mode. */
export function readOnlyBackendMode(mode: PermissionMode, provider: string): PermissionMode {
    if (mode === "plan") return "plan";
    return mode === "auto" && provider === "codex" ? "auto" : "default";
}

/** The server of an MCP tool's name (mcp__server__tool). */
function mcpServerOf(name: string): string | undefined {
    return name.match(/^mcp__(.+?)__/)?.[1];
}

/** A StopFailure hook's matcher value: what kind of error ended the turn. */
export function errorType(message: string): string {
    const m = message.toLowerCase();
    if (/rate.?limit|\b429\b|usage limit|too many requests/.test(m)) return "rate_limit";
    if (/overloaded|\b529\b/.test(m)) return "overloaded";
    if (/\b401\b|\b403\b|unauthori[sz]ed|authentication|invalid (api )?key|not (signed|logged) in/.test(m)) return "authentication_failed";
    if (/billing|credit|\b402\b|payment|quota/.test(m)) return "billing_error";
    if (/\b5\d\d\b|server error|internal error|bad gateway|unavailable/.test(m)) return "server_error";
    if (/output token limit|max.?tokens/.test(m)) return "max_output_tokens";
    return "unknown";
}

/**
 * The events Claude Code runs the harness's hooks for itself, over its control
 * protocol: its tool calls, sub-agents, compactions, worktrees and cd. The
 * harness keeps the rest (prompts, Stop, the session's start and end,
 * permission prompts, notifications, the files it watches), so none runs twice.
 */
export const CLAUDE_CODE_HOOK_EVENTS: HookEvent[] = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "PermissionDenied", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "CwdChanged", "WorktreeCreate", "WorktreeRemove"];

export function backendOwnedHooks(s: Settings): BackendTurn["hooks"] {
    const out: NonNullable<BackendTurn["hooks"]> = {};
    for (const e of CLAUDE_CODE_HOOK_EVENTS) if (s.hooks?.[e]?.length) out[e] = s.hooks[e];
    // SessionStart after Claude Code compacts (its own auto-compaction too): Claude Code runs it, so its context reaches its model.
    const compact = (s.hooks?.SessionStart ?? []).filter((h) => matcherFn(h.matcher)("compact")).map((h) => ({ ...h, matcher: "compact" }));
    if (compact.length) out.SessionStart = compact;
    return Object.keys(out).length ? out : undefined;
}

/** Whether the user trusted the folder themselves (not for the session only); no when that can't be read. */
function userTrusts(dir: string): boolean {
    try {
        return trustedByUser(dir);
    } catch {
        return false;
    }
}
