import type { SecretStore } from "../agent/secrets";
import type { ImagePart } from "../providers/types";
import type { Settings } from "../config/settings";
import type { PermissionMode } from "../permissions/modes";
import type { Sandbox } from "../permissions/sandbox";
import type { FileHistory } from "../agent/checkpoints";

export type JsonSchema = Record<string, unknown>;

export type ToolCategory = "read" | "edit" | "execute" | "network" | "meta" | "mcp";

export interface ToolDisplay {
    /** One-line result summary shown under the call, e.g. "Read 120 lines". */
    summary?: string;
    /** Optional preview body (dimmed, truncated by the UI). */
    body?: string;
    /** File change to render as a colored diff. */
    diff?: { path: string; before: string; after: string };
}

export interface ToolResult {
    /** Text sent back to the model. */
    content: string;
    images?: ImagePart[];
    isError?: boolean;
    display?: ToolDisplay;
}

export interface FileState {
    mtimeMs: number;
    size: number;
    /** True when only a slice of the file was read (offset/limit). */
    partial: boolean;
}

export interface TodoItem {
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm?: string;
}

export interface BackgroundShell {
    id: string;
    command: string;
    startedAt: number;
    output: string;
    readOffset: number;
    exitCode: number | null;
    /** Started in the auto-mode sandbox. */
    sandboxed?: boolean;
    /** The message for the model when it failed in there (refused hosts, what the sandbox blocks). */
    sandboxHint?: () => string | undefined;
    /** SIGTERM, then SIGKILL after the grace period if anything in the group is still running. */
    kill: (graceMs?: number) => Promise<"gone" | "stopped" | "killed">;
}

/** Shared, mutable state that tools read and write during a session. */
export interface ToolState {
    cwd: string;
    readonly projectRoot: string;
    fileState: Map<string, FileState>;
    todos: TodoItem[];
    shells: Map<string, BackgroundShell>;
    /** Plan text submitted via ExitPlanMode and approved. */
    approvedPlan?: string;
    /** Saves files before edit tools change them, for /rewind (see writeTracked). */
    fileHistory?: FileHistory;
    /** Secrets the user gave this session (RequestSecret), for its Bash processes. */
    secrets?: SecretStore;
}

export interface UiBridge {
    /** Ask the user a multiple-choice question (AskUserQuestion tool). */
    askQuestion?(question: string, options: { label: string; description?: string }[], multi: boolean): Promise<string[] | undefined>;
    /**
     * Present a plan for approval (ExitPlanMode). Returns the chosen next mode or undefined if rejected.
     * `handoff`: not approved here because the user is carrying it out in another session; `feedback` says where.
     */
    approvePlan?(plan: string): Promise<{ approved: boolean; mode?: PermissionMode; feedback?: string; handoff?: boolean }>;
    /** Ask the user to type in a secret (RequestSecret): the value, or undefined if they declined. `purpose` is already safe to show. */
    requestSecret?(name: string, purpose: string, signal: AbortSignal): Promise<string | undefined>;
}

export interface ToolContext {
    state: ToolState;
    settings: Settings;
    signal: AbortSignal;
    mode: () => PermissionMode;
    setMode: (m: PermissionMode) => void;
    /** Streams live progress text (e.g. command output) to the UI. */
    onProgress?: (text: string) => void;
    ui: UiBridge;
    /** Runs a sub-agent (Task tool), on `model` (provider:model) when given. */
    runSubagent?: (opts: { description: string; prompt: string; agentType?: string; model?: string }, signal: AbortSignal) => Promise<{ report: string; isError?: boolean; model?: string }>;
    /** The agent types and models a sub-agent can run on (ListModels tool). */
    listModels?: (opts: { provider?: string; query?: string }, signal: AbortSignal) => Promise<string>;
    /** Model-facing web search (WebSearch tool). */
    webSearch?: (query: string, signal: AbortSignal) => Promise<string>;
    /** Small-model helper for WebFetch prompts. */
    summarize?: (content: string, prompt: string, signal: AbortSignal) => Promise<string>;
    /**
     * Files a search (Grep/Glob/LS) must leave out of its results: denied or
     * ask-gated for reading, the credential store, credential files. The
     * permission check only sees the search root, not every file under it.
     */
    hidden?: (toolName: string, absPath: string) => HiddenReason | undefined;
    /** Auto mode approved this shell command on the condition that it runs in this sandbox. */
    sandbox?: Sandbox;
}

export interface Tool<I = Record<string, unknown>> {
    name: string;
    description: string;
    parameters: JsonSchema;
    category: ToolCategory;
    /** Safe to run concurrently with other read-only calls. */
    readOnly: boolean | ((input: I) => boolean);
    /** Short label shown in the transcript: Read(src/index.ts). */
    title(input: I): string;
    /** Return an error string to reject bad input before permission checks. */
    validate?(input: I, ctx: ToolContext): string | undefined | Promise<string | undefined>;
    /** Preview for the permission prompt (diff for edits, command for bash). */
    preview?(input: I, ctx: ToolContext): Promise<ToolDisplay | undefined>;
    run(input: I, ctx: ToolContext): Promise<ToolResult>;
    /** Only offered when this returns true (e.g. WebSearch needs a backend). */
    enabled?(ctx: { settings: Settings }): boolean;
}

/**
 * Why a search leaves a file out. "deny" and "protected" are absolute;
 * "sensitive" and `ask:<rules>` (every ask rule that matched) are lifted for
 * files under a root the user approved for exactly the same reason.
 */
export type HiddenReason = "deny" | "protected" | "sensitive" | `ask:${string}`;

export function isReadOnly(tool: Tool<any>, input: any): boolean {
    return typeof tool.readOnly === "function" ? tool.readOnly(input) : tool.readOnly;
}
