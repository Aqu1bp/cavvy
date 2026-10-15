// Agent backends: providers that run a whole coding agent rather than answer
// single model requests. Claude Code and Codex are run as the user's own
// installed CLIs, signed in by the user through those CLIs. The harness never
// sees, reads or stores their credentials; it starts the official program,
// sends it the prompt, shows what it does and answers its permission prompts.

import type { AgentEvent, TurnEndReason } from "../agent/agent";
import type { ImagePart, ModelInfo, ProviderClient, Usage } from "../providers/types";
import type { PermissionMode } from "../permissions/modes";
import type { Effort } from "../config/settings";
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
    permission(req: BackendPermission): Promise<PermissionAnswer>;
    /** One answer list per question; undefined when the user dismissed them. */
    askQuestions(questions: BackendQuestion[]): Promise<string[][] | undefined>;
    approvePlan(plan: string): Promise<{ approved: boolean; mode?: PermissionMode; feedback?: string }>;
    /** The backend changed modes itself (a plan was approved). */
    setMode(m: PermissionMode): void;
    /** Tokens and spend for this turn; `cost` 0 when it's covered by the user's plan. */
    usage(u: Usage, opts: { contextTokens?: number; contextWindow?: number }): void;
    /** The backend's own session or thread id, for resuming it next turn. */
    sessionId(id: string): void;
    /** Messages the user typed while the backend was working. */
    drainQueued(): string[];
}

export interface BackendTurn {
    prompt: string;
    images: ImagePart[];
    cwd: string;
    model: ModelInfo;
    mode: PermissionMode;
    effort?: Effort;
    appendSystemPrompt?: string;
    additionalDirectories: string[];
    /** The user trusts this folder's configuration. */
    trusted: boolean;
    /** Stop after this many model turns (Claude Code). */
    maxTurns?: number;
    /** Continue this backend session (from an earlier turn). */
    resumeId?: string;
    signal: AbortSignal;
    host: BackendHost;
}

export interface BackendResult {
    reason: TurnEndReason;
    /** The assistant's text over the whole turn. */
    text: string;
    /** What the backend did, e.g. Bash(npm test). */
    actions: string[];
    error?: string;
    /** The session in resumeId couldn't be resumed (gone, or another folder's). */
    resumeFailed?: boolean;
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
