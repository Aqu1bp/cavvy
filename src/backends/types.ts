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

/** A permission prompt raised by the backend's own permission system. */
export interface BackendPermission {
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
}

export type PermissionAnswer =
    | { allow: true; /** The user switched modes from the prompt ("allow all edits"). */ mode?: PermissionMode }
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

export interface BackendHost {
    emit(e: AgentEvent): void;
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
    /** Messages the user typed while the backend was working. If any are drained,
     * consume and record preceding output before recording the queued prompt. */
    drainQueued(progress?: () => BackendResult): string[] | Promise<string[]>;
    /** Called when a message to steer with arrives mid-turn, for a backend that can take it at once (Codex). Returns the unsubscribe. */
    onQueued?(listener: () => void): () => void;
    /**
     * Drained messages the backend never received (its turn ended before it took
     * them). They're in the transcript already; the host saves them for the next
     * turn, so they reach it even after a restart.
     */
    undelivered?(texts: string[]): void;
}

export interface BackendTurn {
    /** The CLI config folder selection; omitted means its Default account. */
    accountId?: string;
    prompt: string;
    /** With a /goal command as the prompt: what Harness would have put before it (the conversation so far), kept apart. */
    goalContext?: string;
    images: ImagePart[];
    /** PDFs, for a backend that reads them (Claude Code); others get a note in the prompt instead. */
    documents?: PdfPart[];
    cwd: string;
    model: ModelInfo;
    mode: PermissionMode;
    effort?: Effort;
    fastMode?: boolean;
    appendSystemPrompt?: string;
    /** Grace for Claude Code background shells/monitors (seconds, default 600). */
    backgroundWaitSec?: number;
    additionalDirectories: string[];
    /** The user trusts this folder's configuration. */
    trusted: boolean;
    /** Snapshot of the MCP manager’s folder and approved definitions; absent means strict MCP isolation. */
    approvedMcpServers?: ApprovedMcpServers;
    /** The harness's deny and ask rules, and the root their paths are relative to. */
    rules: { deny: string[]; ask: string[]; root: string };
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
    signal: AbortSignal;
    host: BackendHost;
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
}

export function isAgentBackend(c: ProviderClient | undefined): c is AgentBackendClient {
    return Boolean(c && (c as Partial<AgentBackendClient>).agentBackend === true);
}

/** Model info for a backend: the backend manages context, tools and pricing itself. */
export function backendModel(provider: string, id: string, name?: string, extra: Partial<ModelInfo> = {}): ModelInfo {
    return { provider, id, name, supportsTools: true, supportsImages: true, supportsReasoning: true, ...extra };
}
