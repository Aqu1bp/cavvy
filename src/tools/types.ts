import type { SecretStore } from "../agent/secrets";
import type { ImagePart, TodoItem } from "../providers/types";
import type { Settings } from "../config/settings";
import type { PermissionMode } from "../permissions/modes";
import type { Sandbox } from "../permissions/sandbox";
import type { FileHistory } from "../agent/checkpoints";
import type { Scheduler } from "../agent/schedule";
import type { WakeQueue } from "../agent/wakes";
import type { SessionBackground } from "../agent/background";
import type { LspManager } from "../lsp/manager";
import type { DiagnosticReport } from "../lsp/diagnostics";
import type { BrowserSession } from "../browser/session";


/** One completion on the session's own model for an MCP server's sampling request: at most `maxTokens`, with why it stopped. */
export type Sampler = (system: string, prompt: string, signal: AbortSignal, maxTokens?: number) => Promise<{ text: string; model: string; stopReason?: string }>;
export type JsonSchema = Record<string, unknown>;

export type ToolCategory = "read" | "edit" | "execute" | "network" | "meta" | "mcp";

export interface ToolDisplay {
    /** One-line result summary shown under the call, e.g. "Read 120 lines". */
    summary?: string;
    /** Optional preview body (dimmed, truncated by the UI). */
    body?: string;
    /** File change to render as a colored diff. */
    diff?: { path: string; before: string; after: string };
    /** What the language server found after an edit (src/lsp). */
    diagnostics?: DiagnosticReport;
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

// Defined beside the transcript types, which carry todos across compaction.
export type { TodoItem } from "../providers/types";

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
    /** Take in what its command has printed so far now, not at the next poll of its output. */
    drain?: () => void;
    /** SIGTERM, then SIGKILL after the grace period if anything in the group is still running. */
    kill: (graceMs?: number) => Promise<"gone" | "stopped" | "killed">;
    /** Started by Monitor: its stdout lines wake the agent. */
    monitor?: { description: string; events: number; expiresAt: number };
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
    /** The session's schedules (CronCreate, /loop); interactive sessions only. */
    scheduler?: Scheduler;
    /** The project's language servers, for diagnostics after edits; shared with sub-agents, outliving any one Agent. */
    lsp?: LspManager;
    /** The session's tabs in the project's browser (src/browser); made when the session starts, closed with it, shared with its sub-agents. */
    browser?: BrowserSession;
    /** Events that wake the session's agent (watched pull requests, monitors); the host starts a turn for them when idle. */
    wakes?: WakeQueue;
    /** Things watching in the background for this session, by id; the host stops them when the session closes. */
    watchers?: Map<string, Watcher>;
    /** The session's background work as one list: what agent CLIs report, beside its delegated tasks and shells (src/agent/background.ts). */
    background?: SessionBackground;
}

/** Something a tool left running that raises wakes (a pull request watch, a monitor). */
export interface Watcher {
    id: string;
    /** "pull-request", "monitor". */
    kind: string;
    /** One line for listings: "PR #12 in owner/repo". */
    label: string;
    /** Where it is on the web. */
    url?: string;
    /** How it stands now: "checks pending", "2 checks failing". */
    detail?: string;
    /** Stops it and drops its wakes still pending. */
    stop(): void;
    /** Set by the list it's in: called when url or detail change. */
    onChange?: () => void;
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
    runSubagent?: (opts: { description: string; prompt: string; agentType?: string; model?: string; background?: boolean }, signal: AbortSignal) => Promise<{ report: string; isError?: boolean; model?: string; background?: boolean }>;
    /** A background sub-agent's result or state, or all of them (TaskStatus tool), waiting up to `waitMs` for it to finish. */
    taskStatus?: (taskId: string | undefined, waitMs: number, signal: AbortSignal) => Promise<{ text: string; isError?: boolean }>;
    /** The agent types and models a sub-agent can run on (ListModels tool). */
    listModels?: (opts: { provider?: string; query?: string }, signal: AbortSignal) => Promise<string>;
    /** Model-facing web search (WebSearch tool). */
    webSearch?: (query: string, signal: AbortSignal) => Promise<string>;
    /** One completion on the session's model, for an MCP server's sampling request (after the user allowed it). */
    sample?: Sampler;
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
    /** Wake the session's agent later (the main agent only; missing for sub-agents and one-shot runs). */
    wakes?: WakeQueue;
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

/** Tools that run a shell command: permission rules, the sandbox and the reviewer treat them alike. */
export function isShellTool(name: string): boolean {
    return name === "Bash" || name === "Monitor";
}

/** The tools that drive the browser (src/tools/browser-tools.ts). */
const BROWSER_TOOL_NAMES = new Set(["BrowserNavigate", "BrowserSnapshot", "BrowserAct", "BrowserScreenshot", "BrowserEval", "BrowserLogs"]);

export function isBrowserTool(name: string): boolean {
    return BROWSER_TOOL_NAMES.has(name);
}

export function isReadOnly(tool: Tool<any>, input: any): boolean {
    return typeof tool.readOnly === "function" ? tool.readOnly(input) : tool.readOnly;
}
