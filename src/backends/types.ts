// Agent backends: providers that run a whole coding agent rather than answer
// single model requests. Claude Code and Codex are run as the user's own
// installed CLIs, signed in by the user through those CLIs. The harness never
// sees, reads or stores their credentials; it starts the official program,
// sends it the prompt, shows what it does and answers its permission prompts.

import type { AgentEvent, TurnEndReason } from "../agent/agent";
import type { ImagePart, ModelInfo, PdfPart, ProviderClient, Usage } from "../providers/types";
import type { PermissionMode } from "../permissions/modes";
import type { Effort } from "../config/settings";
import type { ApprovedMcpServers } from "../mcp/manager";
import type { ToolDisplay } from "../tools/types";
import type { HookConfig } from "../config/settings";
import type { HookEvent, HookOutcome, HookResult } from "../agent/hooks";
import type { Skill } from "../agent/skills";
import type { ClaudeAgentDefinition } from "./claude-agents";
import type { PlanLimits } from "../server/protocol";
import type { BackgroundTaskInfo } from "./live/info";

/** A permission prompt raised by the backend's own permission system. */
export interface BackendPermission {
    /**
     * Asked by a background sub-agent of the CLI's (its work outlives the turn): the turn's end or Esc doesn't
     * withdraw it; the session's end does.
     */
    background?: boolean;
    /** With background: aborts when the request no longer matters (its sub-agent's turn ended), withdrawing the prompt. */
    signal?: AbortSignal;
    /** The harness tool whose rules apply: Bash, Edit, Write, Read, WebFetch, mcp__server__tool, or the backend's own name. */
    toolName: string;
    /** Input in that tool's shape (command, file_path, url, …). */
    input: Record<string, unknown>;
    /** Shown in the prompt when the harness has no tool of that name. */
    title?: string;
    /** Why the backend asks. */
    reason?: string;
    /** A preview the harness can't compute itself (a patch). */
    preview?: ToolDisplay;
    /** More files the same change writes: deny rules for any of them refuse it, and only rules covering all of them approve it. */
    otherPaths?: string[];
    /**
     * Access the request would open up (Codex's extra permissions): a deny
     * rule for any of these paths refuses it, plan mode refuses it, and it's
     * never approved without asking.
     */
    widens?: { read: string[]; write: string[] };
    /**
     * The backend asks about every command (Codex in untrusted mode), so the
     * ask says nothing of its own: a command the harness would run without
     * asking for its own models is approved. False: it does say something.
     * Left out, a read-only agent's asks count as saying nothing (they come
     * from the harness's own rule).
     */
    asksAlways?: boolean;
    /** One of the backend's own sub-agents asks (Codex's): the prompt says which, and a no stops only it. */
    agentLabel?: string;
    /** The call it asks about, as its tool_start names it: its row waits while it asks. */
    callId?: string;
    /** What PreToolUse hooks said of it (the backend ran them before asking): allow approves it unless a rule denies it. */
    hookDecision?: "allow" | "ask";
    /** The backend asked only because PreToolUse hooks needed to see it: approve what the mode allows. */
    hooksOnly?: boolean;
    /** The backend's sub-agent asking, by its type (a harness agent Claude Code runs natively): its own mode applies. */
    agentType?: string;
}

export type PermissionAnswer =
    | {
          allow: true;
          /** The user switched modes from the prompt ("allow all edits"). */ mode?: PermissionMode;
          /** A PermissionRequest hook approved this input in place of the one asked about (already checked against the rules). */
          updatedInput?: Record<string, unknown>;
      }
    | {
          allow: false;
          message: string;
          /** End the turn: the user wants to say what to do instead. */
          stop: boolean;
          /** The message is the user's own words (they declined and said what to do instead). */
          fromUser?: boolean;
      };

export interface BackendQuestion {
    question: string;
    header?: string;
    options: { label: string; description?: string }[];
    multiSelect?: boolean;
}

/** A queued message as a prompt of its own: its text (attached text files framed in), its images, and PDFs for a backend that reads them. */
export interface BackendPrompt {
    text: string;
    images: ImagePart[];
    documents: PdfPart[];
    /** As BackendTurn's: the user's message as typed, which its $names are read from, and what follows it in `text`. */
    request?: string;
    requestAfter?: string;
}

/**
 * A message drained to steer with (TurnSink.drainQueued): its text, and the images and PDFs (for a backend
 * that reads them) attached to it, which the backend sends beside its text. They belong to this message alone,
 * however many say the same words.
 */
export interface SteerMessage {
    text: string;
    images: ImagePart[];
    documents: PdfPart[];
    /**
     * For one with attachments (it comes alone): it's still the host's until the backend has it. The backend calls
     * this once: true once it's gone (Codex accepted its turn/steer; written to Claude Code's stdin), and the host
     * records it then; false when it doesn't go (refused, the turn ended or was stopped first), and the host keeps
     * it queued, attachments and all, to go as a prompt of its own. Never given to undelivered().
     */
    settle?(sent: boolean): Promise<void>;
}

/** Something a backend reports about the session rather than a turn: its background work, a notice when no turn runs. */
export type SessionEvent =
    | { type: "background_task"; task: BackgroundTaskInfo }
    | { type: "notice"; level: "info" | "warn" | "error"; message: string }
    /** Something the CLI did outside any turn (a background sub-agent's steps, its Agent call ending): shown where it belongs (by its call's id). */
    | { type: "event"; event: AgentEvent };

/** A turn the CLI started by itself (a background task's report, a goal's next step), for the host to adopt as a wake turn. */
export interface BackendWake {
    /** The agent CLI it's in. */
    provider: string;
    /** The turn, as the backend names it (BackendTurn.adopt). */
    ref: string;
    /** What it's about, for the wake's row: "Background task finished: Map auth". */
    label?: string;
    /**
     * The turn answers a message of the user's (`label`, as they typed it): one that Esc sent at once in place of
     * the turn it stopped. Recorded as their prompt, not as a wake.
     */
    prompt?: boolean;
    /**
     * What the background work it reports said (a finished command's output, a sub-agent's report), redacted:
     * shown, and told to the session's model, when the session can't take the turn over (it's on another model).
     */
    report?: string;
}

/**
 * What a backend asks of the harness about the session, whichever turn is running or none (a background
 * sub-agent's permission prompt between turns): permissions, questions, the mode, hooks, usage, its own
 * session id, plan limits, session-level events and wakes. Bound once a live session (#219); the per-turn
 * backends get one with each turn.
 */
export interface SessionHost {
    /** The harness's permission mode now (it can change during a turn). */
    mode(): PermissionMode;
    /** Fast mode now: a sub-agent's follows its session, which can change during its turn. BackendTurn.fastMode otherwise. */
    fastMode?(): boolean;
    permission(req: BackendPermission): Promise<PermissionAnswer>;
    /** One answer list per question; undefined when the user dismissed them. */
    askQuestions(questions: BackendQuestion[]): Promise<string[][] | undefined>;
    approvePlan(plan: string): Promise<{ approved: boolean; mode?: PermissionMode; feedback?: string; handoff?: boolean }>;
    /** The backend changed modes itself (a plan was approved). */
    setMode(m: PermissionMode): void;
    /** Tokens and spend for this turn; `cost` 0 when it's covered by the user's plan. */
    usage(u: Usage, opts: { contextTokens?: number; contextWindow?: number }): void;
    /** The context as the backend works (from its last request), before the turn's usage comes; nothing is counted. */
    context?(contextTokens: number): void;
    /** The backend's own session or thread id, for resuming it next turn. */
    sessionId(id: string): void;
    /** The plan's usage limits, as the CLI reported them (`partial`: only some windows). */
    limits?(limits: PlanLimits, partial: boolean): void;
    /** Run the harness's hooks for something the backend did (Codex's items). */
    hooks?(event: HookEvent, payload: Record<string, unknown>): Promise<HookOutcome | undefined>;
    /** Run one hook handler the backend called back for (Claude Code's hook_callback), with the backend's input. */
    hookHandler?(event: HookEvent, h: HookConfig, input: Record<string, unknown>, signal: AbortSignal): Promise<HookResult>;
    /** Session-level news: a background task started, changed or ended; a notice outside any turn. */
    emitSession?(e: SessionEvent): void;
    /** The CLI started a turn by itself: the host starts a wake turn that adopts it (BackendTurn.adopt). */
    onWake?(w: BackendWake): void;
}

/** Where one turn's events go, and what the turn takes in while it runs (messages to steer with). */
export interface TurnSink {
    emit(e: AgentEvent): void;
    /** Messages the user typed while the backend was working. If any are drained,
     * consume and record preceding output before recording the queued prompt. `live`: whether the
     * backend can still take them, checked before they're taken (their hooks run first). */
    drainQueued(progress?: () => BackendResult, live?: () => boolean): SteerMessage[] | Promise<SteerMessage[]>;
    /**
     * For when the CLI is between its turns, waiting only on background work: nothing is mid-step, so
     * the next message the user queued goes now as a prompt of its own, whatever its mode, with what's
     * attached (drainQueued's rules are for a running step). Undefined when none can: held ones, and
     * commands and `!commands` (Harness runs those itself, after the run). Records the output before
     * it, as drainQueued does. `live`: whether the backend can still send it (not stopped, its CLI not gone),
     * checked last before it's taken; from then to the send nothing is awaited.
     */
    drainWaiting?(progress?: () => BackendResult, live?: () => boolean): Promise<BackendPrompt | undefined>;
    /** A drained message is an event a watch raised (others' words, such as a PR comment), not the user's. */
    fromWake?(text: string): boolean;
    /** The words the user typed of a drained message of theirs, which it starts with: what a hook added follows. */
    requestOf?(text: string): string | undefined;
    /** Called when a message to steer with arrives mid-turn, for a backend that can take it at once (Codex). Returns the unsubscribe. */
    onQueued?(listener: () => void): () => void;
    /**
     * Drained messages the backend never received (its turn ended before it took
     * them). They're in the transcript already; the host saves them for the next
     * turn, so they reach it even after a restart. Never one with attachments: that
     * stays queued until it goes (SteerMessage.settle).
     */
    undelivered?(messages: SteerMessage[]): void;
    /**
     * Files the backend changed (absolute paths): the language servers' new
     * problems in them, as a note for the model, or undefined when there's
     * nothing new. The user is told either way (a notice). For a backend
     * without diagnostics of its own (Codex).
     */
    diagnose?(paths: string[]): Promise<string | undefined>;
}

export interface BackendTurn {
    /** The CLI config folder selection; omitted means its Default account. */
    accountId?: string;
    prompt: string;
    /** With a /goal command as the prompt: what Harness would have put before it (the conversation so far), kept apart. */
    goalContext?: string;
    /**
     * The prompt isn't only the user's own words (an event a watch raised, or what the harness adds before
     * them): Claude Code reads it as written, with no @mention expansion or slash command.
     */
    synthetic?: boolean;
    images: ImagePart[];
    /** PDFs, for a backend that reads them (Claude Code); others get a note in the prompt instead. */
    documents?: PdfPart[];
    cwd: string;
    model: ModelInfo;
    mode: PermissionMode;
    effort?: Effort;
    fastMode?: boolean;
    appendSystemPrompt?: string;
    /** Grace for Claude Code background shells without a timeout of their own, and monitors (seconds, default 1800). */
    backgroundWaitSec?: number;
    /**
     * Run on the session's live CLI process, kept between turns (#219), rather than one process per turn: the
     * agentCli.liveSessions setting (on unless it's false). A backend without live sessions ignores it.
     */
    liveSessions?: boolean;
    /** Start a turn that tells the CLI when a background command it started ends after its turn (Codex; default true). */
    wakeOnBackgroundCommand?: boolean;
    additionalDirectories: string[];
    /** The user trusts this folder's configuration. */
    trusted: boolean;
    /**
     * The harness's skills (src/agent/skills.ts), for the backend to hand its
     * CLI so the CLI runs them itself (src/backends/native-skills.ts).
     */
    skills?: readonly Skill[];
    /** The user's message as typed: its /name or $name are read from this. `prompt` ends with it and then `requestAfter`. */
    request?: string;
    /** What follows the user's message in `prompt`: its attached files' text and the harness's notes, which name no skills. */
    requestAfter?: string;
    /** Enabled harness plugins' folders, for a backend that loads them itself (Claude Code's --plugin-dir). */
    pluginDirs?: string[];
    /** Snapshot of the MCP manager’s folder and approved definitions; absent means strict MCP isolation. */
    approvedMcpServers?: ApprovedMcpServers;
    /** The harness's deny and ask rules, and the root their paths are relative to. */
    rules: { deny: string[]; ask: string[]; root: string };
    /** The harness's hooks the backend runs itself, at its own lifecycle points (Claude Code). */
    hooks?: Partial<Record<HookEvent, HookConfig[]>>;
    /** Stop after this many model turns (Claude Code). */
    maxTurns?: number;
    /** Continue this backend session (from an earlier turn). */
    resumeId?: string;
    /** It's shared with a forked session: continue a copy of it (a new id), never the session itself. */
    forkSession?: boolean;
    /**
     * The harness's MCP server, with its tools for delegating to other
     * providers' models (src/agent/delegation.ts). The backend attaches it
     * for the turn without putting the token in its arguments or environment.
     */
    orchestrator?: OrchestratorServer;
    /**
     * A read-only sub-agent (explore). Its mode asks before any change and
     * the harness refuses them; the backend also turns off what could change
     * files without asking (Claude Code's edit tools, its user allow rules and
     * sandbox auto-approval for commands, MCP servers from its own config).
     */
    readOnly?: boolean;
    /**
     * The harness's agent definitions for Claude Code to run with its own
     * Agent tool (src/backends/claude-agents.ts). Codex ignores them.
     */
    agents?: Record<string, ClaudeAgentDefinition>;
    signal: AbortSignal;
    /** The harness session (or child agent) the turn belongs to: a live CLI process is kept per key. */
    sessionKey: string;
    /**
     * Send nothing: the CLI started this turn itself (BackendWake.ref), and this run takes its events
     * until it ends. Only for a backend with adoptsTurns.
     */
    adopt?: string;
    /**
     * Nothing will take a report after this turn (-p, the SDK runner, a harness sub-agent): the turn itself should
     * wait for the work it leaves in the background. A backend may run it on a process of its own with the per-turn
     * path's bounded wait (backgroundWaitSec, #193's timeouts, servers stopped at the answer), as Claude Code does
     * (#219 PR 4); one that ignores it ends the turn at its answer, and what's left in the background stops at release.
     */
    untilQuiet?: boolean;
    /** The session's side: permissions, usage, background tasks, wakes. */
    session: SessionHost;
    /** This turn's events and steering. */
    sink: TurnSink;
}

export interface OrchestratorServer {
    /** The server's name, as the backend's tools see it (mcp__<name>__<tool>). */
    name: string;
    url: string;
    /** The Authorization header (holds the token). */
    authorization: string;
    tools: string[];
    /** For the backend's system prompt, where its MCP server instructions don't reach the model. */
    instructions: string;
    /** How long a call may take, in seconds (a delegate call can wait an hour). */
    toolTimeoutSec: number;
}

export interface BackendResult {
    reason: TurnEndReason;
    /** The assistant's text over the whole turn. */
    text: string;
    /** Its answer: what it said last, without the narration on the way (what a sub-agent reports). Text when not given. */
    answer?: string;
    /** What the backend did, e.g. Bash(npm test). */
    actions: string[];
    error?: string;
    /** Background work stopped by this run, for a durable next-prompt reminder. */
    backgroundStopped?: string[];
    /** The session in resumeId couldn't be resumed (gone, or another folder's). */
    resumeFailed?: boolean;
    /** It stopped on the plan's usage limit; `resetsAt` (ms) when the backend said when that lifts. */
    limit?: { resetsAt?: number };
}

export interface AgentBackendClient extends ProviderClient {
    readonly agentBackend: true;
    runTurn(t: BackendTurn): Promise<BackendResult>;
    /** Compact the backend session with the backend's own compaction. */
    compact(t: Omit<BackendTurn, "prompt" | "images"> & { instructions?: string }): Promise<BackendResult>;
    /** The user changed the permission mode while a turn runs. */
    setMode(m: PermissionMode): void;
    /** It can take over a turn its CLI started by itself (BackendTurn.adopt). */
    readonly adoptsTurns?: boolean;
    /**
     * Ask for background tasks of a session to stop (these, or every one): how each went. A stop counts once
     * the task is reported not running (SessionEvent background_task); none here means the backend can't.
     */
    stopBackground?(sessionKey: string, ids?: string[]): Promise<Record<string, BackgroundStop>>;
    /**
     * Esc with a message the user sent while the turn ran: the backend sends it at once in place of the turn
     * the interrupt stops (Claude Code's send_now), and reports its turn as a wake with `prompt`. False when it
     * can't now: the message stays the caller's. Called just before the turn's signal is aborted.
     */
    sendNow?(sessionKey: string, text: string): boolean;
    /** Restart a session's live CLI process (it didn't answer an interrupt): what runs under it stops. */
    restart?(sessionKey: string): Promise<void>;
    /**
     * The harness is done with this session (closed, cleared or replaced, the harness quitting) or sub-agent
     * (its run is over): stop the CLI process kept for it. What ran in it stopped with it, and is reported so
     * (SessionEvent background_task, status stopped, withProcess), as any loss of the process is. A session
     * already let go records nothing more: its log keeps those tasks running, so when it's opened again they
     * show as stopped when Harness quit, and the agent is told (src/agent/background.ts).
     */
    release?(sessionKey: string): Promise<void>;
    /** Stop every live CLI process it keeps (the client is dropped, or the harness quits), reported as release's are. */
    shutdown?(): Promise<void>;
}

/**
 * How a request to stop a background task went (see src/backends/live/tasks.ts StopResult). `ended`: it had
 * already ended on its own (before the stop, or while it was pending), so the stop wasn't what ended it.
 */
export type BackgroundStop = "stopped" | "timeout" | "failed" | "not_stoppable" | "unknown" | "ended";

export function isAgentBackend(c: ProviderClient | undefined): c is AgentBackendClient {
    return Boolean(c && (c as Partial<AgentBackendClient>).agentBackend === true);
}

/** Model info for a backend: the backend manages context, tools and pricing itself. */
export function backendModel(provider: string, id: string, name?: string, extra: Partial<ModelInfo> = {}): ModelInfo {
    return { provider, id, name, supportsTools: true, supportsImages: true, supportsReasoning: true, ...extra };
}
