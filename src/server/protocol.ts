// The GUI protocol: what the harness server and the GUI say to each other over
// the WebSocket. Shared by both sides, so it must stay pure TypeScript: no
// Bun, Node or DOM imports (the GUI bundles this file).
//
// Requests:  client -> { id, method, params }      server -> { id, result } | { id, error }
// Events:    server -> { event }                   (session timelines, sidebar updates, notifications)

export const PROTOCOL_VERSION = 1;

export type PermissionModeId = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type ToolCategoryId = "read" | "edit" | "execute" | "network" | "meta" | "mcp";

export const MODE_LABELS: Record<PermissionModeId, { label: string; description: string }> = {
    default: { label: "Manual", description: "Ask before edits, commands and other side effects" },
    acceptEdits: { label: "Accept edits", description: "Edit files in the workspace without asking" },
    plan: { label: "Plan", description: "Research and propose a plan; change nothing until approved" },
    auto: { label: "Auto", description: "A reviewer model approves routine actions; risky ones ask" },
    bypassPermissions: { label: "Bypass", description: "Run everything without asking (sandboxes only)" },
};

// ---------------------------------------------------------------------------
// Diffs

export interface DiffLine {
    t: "ctx" | "add" | "del";
    text: string;
    /** Line numbers in the old / new file. */
    a?: number;
    b?: number;
}

export interface DiffHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: DiffLine[];
}

export interface FileDiff {
    path: string;
    status: "added" | "modified" | "deleted";
    added: number;
    removed: number;
    hunks: DiffHunk[];
    /** Hunks were cut to keep the message small. */
    truncated?: boolean;
    /** Not text, too big, or not saved: no hunks. */
    note?: string;
}

// ---------------------------------------------------------------------------
// Timeline: a session as the GUI draws it. Built live from agent events and
// rebuilt from the saved transcript on open, in the same shape.

export type ToolStatus = "streaming" | "running" | "awaiting" | "ok" | "error" | "denied";

export interface TextBlock {
    t: "text";
    id: string;
    text: string;
}

export interface ThinkingBlock {
    t: "thinking";
    id: string;
    text: string;
    startedAt?: number;
    durationMs?: number;
}

export interface SubagentInfo {
    label: string;
    tools: ToolBlock[];
    toolCount: number;
    tokens: number;
    startedAt: number;
}

export interface ToolBlock {
    t: "tool";
    id: string;
    name: string;
    title: string;
    category?: ToolCategoryId;
    /** The call's input, with long strings cut. */
    input?: Record<string, unknown>;
    status: ToolStatus;
    summary?: string;
    output?: string;
    outputTruncated?: boolean;
    diff?: FileDiff;
    images?: number;
    /** Live output while it runs (a shell command's tail). */
    progress?: string;
    /** Characters of input received while the model writes the call. */
    receiving?: number;
    startedAt?: number;
    durationMs?: number;
    /** Who approved it without asking: "sandboxed", "hook", or the auto-mode reviewer's reason. */
    approval?: string;
    sandboxed?: boolean;
    sub?: SubagentInfo;
    /** It runs a sub-agent: a Task call, or a task Claude Code or Codex delegated to another model. */
    agent?: boolean;
}

/**
 * A sub-agent of the session, for the bar above the input and its activity
 * view: a Task call, or a task Claude Code or Codex delegated to another
 * provider's model. Its id is the call that started it.
 */
export interface AgentRun {
    id: string;
    /** The turn the call is in. */
    turnId: string;
    /** A delegated task's id (task-1): what stops it. Task sub-agents stop with the turn. */
    taskId?: string;
    description: string;
    /** "general-purpose", "explore", or a custom agent type. */
    agentType: string;
    /** provider:model, when it isn't the session's own. */
    model?: string;
    /** The instructions it was given (cut when long). */
    prompt?: string;
    status: "running" | "waiting" | "done" | "failed" | "stopped";
    startedAt: number;
    endedAt?: number;
    toolCount: number;
    tokens: number;
    /** What it's doing now: a tool's title, "Thinking", "Writing". */
    activity?: string;
    /** What it said and did, oldest first: its text, tool calls and notices (the most recent ones). */
    blocks: Block[];
    /** How many earlier blocks were dropped to keep the list short. */
    dropped?: number;
    report?: string;
    /** The last block of its earlier turns, when it started another (Codex's, messaged after it answered): its report is from what follows. */
    turnAfter?: string;
    /** From before the session was reopened: only the call and its result are known. */
    replayed?: boolean;
}

export interface NoticeBlock {
    t: "notice";
    id: string;
    level: "info" | "warn" | "error";
    text: string;
}

export interface CompactBlock {
    t: "compact";
    id: string;
    summary: string;
    auto: boolean;
}

/** Heads a conversation brought in from a Claude Code or Codex session. */
export interface ImportedBlock {
    t: "imported";
    id: string;
    /** "Claude Code" or "Codex". */
    source: string;
    /** When that session started. */
    startedAt?: number;
    /** Its earlier messages that weren't brought in. */
    omitted: number;
}

export interface ShellBlock {
    t: "shell";
    id: string;
    command: string;
    output: string;
    exitCode?: number | null;
    running: boolean;
}

export type Block = TextBlock | ThinkingBlock | ToolBlock | NoticeBlock | CompactBlock | ImportedBlock | ShellBlock;

export type TurnStatus = "running" | "done" | "aborted" | "error" | "denied" | "max_turns" | "blocked";

export interface TurnPrompt {
    text: string;
    images?: number;
    /** Started by a slash command (/init, /review, custom commands). */
    command?: boolean;
    /** Position of the prompt in the session's messages, when it can be rewound to. */
    index?: number;
}

export interface Turn {
    id: string;
    prompt?: TurnPrompt;
    blocks: Block[];
    status: TurnStatus;
    startedAt?: number;
    endedAt?: number;
    /** Before the last compaction: shown, but no longer in the model's context. */
    archived?: boolean;
    /** From a Claude Code or Codex session started elsewhere: shown, can't be rewound to. */
    imported?: boolean;
}

// ---------------------------------------------------------------------------
// Interactions: things the agent waits on the user for.

export interface PermissionOption {
    id: "yes" | "always" | "session-edits" | "no";
    label: string;
}

export interface PermissionInteraction {
    kind: "permission";
    id: string;
    toolId?: string;
    toolName: string;
    category?: ToolCategoryId;
    title: string;
    /** What it is, in a few words: "Run a shell command", "Edit file". */
    heading: string;
    command?: string;
    description?: string;
    path?: string;
    url?: string;
    hosts?: string[];
    json?: string;
    diff?: FileDiff;
    preview?: string;
    summary?: string;
    dangerous?: boolean;
    reason?: string;
    classifierReason?: string;
    agentLabel?: string;
    /** The sub-agent asking (an AgentRun id), when one is. */
    agentId?: string;
    options: PermissionOption[];
}

export interface QuestionInteraction {
    kind: "question";
    id: string;
    toolId?: string;
    question: string;
    options: { label: string; description?: string }[];
    multi: boolean;
}

export interface PlanInteraction {
    kind: "plan";
    id: string;
    toolId?: string;
    plan: string;
}

export type Interaction = PermissionInteraction | QuestionInteraction | PlanInteraction;

export type InteractionResponse =
    | { kind: "permission"; choice: PermissionOption["id"]; feedback?: string }
    | { kind: "question"; answers?: string[] }
    | { kind: "plan"; approved: boolean; mode?: PermissionModeId; feedback?: string };

// ---------------------------------------------------------------------------
// Session state

export interface ModelSummary {
    ref: string;
    provider: string;
    providerName?: string;
    id: string;
    name: string;
    contextWindow?: number;
    maxOutput?: number;
    pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
    pricingEstimated?: boolean;
    supportsImages?: boolean;
    supportsReasoning?: boolean;
    effortLevels?: EffortLevel[];
    supportsFastMode?: boolean;
    deprecated?: boolean;
}

export interface TodoEntry {
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm?: string;
}

export type SessionStatus = "idle" | "running" | "waiting" | "error";

export interface McpStatus {
    name: string;
    status: "pending" | "connecting" | "connected" | "failed" | "disabled" | "needs-approval";
    tools: number;
    error?: string;
    source: "settings" | "project";
}

export interface SessionState {
    id: string;
    cwd: string;
    projectName: string;
    title?: string;
    createdAt: number;
    /** Saved to disk (after the first message). */
    persisted: boolean;
    trusted: boolean;
    branch?: string;
    model?: ModelSummary;
    mode: PermissionModeId;
    bypassAllowed: boolean;
    effort?: EffortLevel;
    fastMode?: boolean;
    status: SessionStatus;
    busy: boolean;
    /** The spinner line: what it's doing right now. */
    activity?: { label: string; since: number; detail?: string };
    contextTokens: number;
    cost: number;
    /** Some usage had no known price: `cost` leaves it out (it isn't free). */
    costUnknown?: boolean;
    tokensIn: number;
    tokensOut: number;
    todos: TodoEntry[];
    queued: string[];
    /** Each queued message's id, in the same order (for session.dequeue). */
    queueIds: number[];
    interactions: Interaction[];
    mcp: McpStatus[];
    /** Files this session's edit tools changed (the Changes panel). */
    filesChanged: number;
    /** Background shells started by the agent. */
    shells: { id: string; command: string; running: boolean; exitCode: number | null; startedAt: number }[];
}

export interface SessionSnapshot {
    state: SessionState;
    turns: Turn[];
    agents: AgentRun[];
    seq: number;
}

/** A change to a session's timeline or state. Applied identically on both sides (applyOp). */
export type SessionOp =
    | { op: "state"; patch: Partial<SessionState> }
    | { op: "turn"; turn: Turn }
    | { op: "turn.patch"; turnId: string; patch: Partial<Omit<Turn, "blocks" | "id">> }
    | { op: "block"; turnId: string; block: Block; parent?: string }
    | { op: "block.patch"; turnId: string; blockId: string; patch: Partial<Block>; parent?: string }
    | { op: "block.remove"; turnId: string; blockId: string }
    | { op: "append"; turnId: string; blockId: string; field: "text" | "progress" | "output"; text: string }
    | { op: "reset"; turns: Turn[]; agents?: AgentRun[] }
    /** A sub-agent started (or replaced, with the same id). */
    | { op: "agent"; agent: AgentRun }
    | { op: "agent.patch"; id: string; patch: Partial<Omit<AgentRun, "id" | "blocks">> }
    /** Adds a block to a sub-agent's activity, or replaces the one with that id. */
    | { op: "agent.block"; id: string; block: Block }
    | { op: "agent.block.patch"; id: string; blockId: string; patch: Partial<Block> }
    | { op: "agent.append"; id: string; blockId: string; field: "text" | "progress"; text: string };

// ---------------------------------------------------------------------------
// Sidebar

export interface SessionSummary {
    id: string;
    cwd: string;
    projectName: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: number;
    status: SessionStatus;
    pinned: boolean;
    archived: boolean;
    /** Set aside: done with for now, listed apart from the sessions still in play. */
    settled: boolean;
    /** The model it last used ("provider:id"). */
    model?: string;
    /** Loaded in the server right now. */
    live: boolean;
}

/** A conversation started in the Claude Code or Codex CLI, offered for import. */
export interface CliSessionInfo {
    source: "claude-code" | "codex";
    id: string;
    /** The CLI's own title, else the first prompt (cut short). Redacted. */
    title: string;
    startedAt?: number;
    updatedAt: number;
    /** Prompts and replies; at least this many when `partial`. */
    messages: number;
    partial: boolean;
    model?: string;
    /** The Harness session that already holds it. */
    harnessId?: string;
    /** Changed in the last couple of minutes: it may still be open in a terminal. */
    recent: boolean;
}

export interface CliSourceInfo {
    source: "claude-code" | "codex";
    /** "Claude Code" or "Codex". */
    name: string;
    /** Turned on in Settings → Providers (import needs it). */
    enabled: boolean;
    /** Sessions of this folder not listed. */
    more: number;
    /** Ones already in Harness not listed (they have a limit of their own). */
    moreInHarness: number;
}

export interface CliSessionsList {
    sources: CliSourceInfo[];
    /** Both sources, newest first; ones already in Harness have `harnessId` (and don't count toward the limit). */
    sessions: CliSessionInfo[];
}

export interface ProjectInfo {
    path: string;
    name: string;
    exists: boolean;
    trusted: boolean;
    /** Configuration that trusting the folder would turn on. */
    needsTrust: string[];
    branch?: string;
    git: boolean;
    openedAt?: number;
}

export interface WorktreeInfo {
    path: string;
    branch?: string;
    head?: string;
    detached: boolean;
    current: boolean;
    exists: boolean;
    /** Empty string means locked/prunable without a reason. */
    locked?: string;
    prunable?: string;
    /** The repository's main worktree (Git lists it first). */
    main: boolean;
    /** Inside <main worktree>/.claude/worktrees/, where Harness creates them and may remove them. */
    managed: boolean;
}

/** Removed, or not yet: these ignored files (the first few of `total`) would be deleted with it. */
export type RemoveWorktreeResult = { removed: true } | { removed: false; ignored: string[]; total: number; confirm: string };

/** A worktree on a new branch; without `location` it goes in <main worktree>/.claude/worktrees/<folder>. */
export interface CreateWorktreeParams {
    /** A folder in the repository (any of its worktrees). */
    path: string;
    branch: string;
    /** Branch or commit to start from; the folder's HEAD when omitted. */
    base?: string;
    /** One path segment; the branch name with "/" as "-" when omitted. */
    folder?: string;
    /** An absolute path the user chose elsewhere: it mustn't exist yet, and its parent must. */
    location?: string;
}

export interface ProviderInfo {
    id: string;
    name: string;
    kind: string;
    configured: boolean;
    /** Where the key comes from: env, keychain or file; "gcloud" for Vertex; "local" for keyless servers. */
    source?: string;
    masked?: string;
    keyUrl?: string;
    local?: boolean;
    custom?: boolean;
    search?: boolean;
    requiresKey: boolean;
    /** Used through the user's own installed CLI and plan (Claude Code, Codex) instead of a key. */
    agentCli?: {
        installed: boolean;
        /** The CLI's own sign-in command, for when it isn't signed in. */
        signIn: string;
        install: string;
        /** What the plan is called in buttons ("Claude subscription", "ChatGPT plan"). */
        plan: string;
    };
}

export interface ProviderModels {
    provider: string;
    providerName: string;
    status: "ok" | "cached" | "error" | "offline" | "no-key";
    error?: string;
    models: ModelSummary[];
}

export interface CommandInfo {
    name: string;
    description: string;
    args?: string;
    custom?: boolean;
}

export interface RewindTargetInfo {
    index: number;
    text: string;
    files: number;
    tracked: boolean;
}

export interface RewindPlanInfo {
    index: number;
    /** Passed back to session.rewind, which restores exactly this plan (or refuses if the conversation moved on). */
    planId: string;
    restore: { path: string; action: "write" | "delete"; outside: boolean }[];
    skipped: { path: string; reason: string }[];
    tracked: boolean;
}

export interface ChangesInfo {
    files: FileDiff[];
    added: number;
    removed: number;
    tracked: boolean;
}

export interface GuiSettings {
    model?: string;
    smallModel?: string;
    /** The auto-mode reviewer. Unset: Claude Sonnet 5.5 with an Anthropic key, else the session's model. */
    reviewModel?: string;
    effort?: EffortLevel;
    fastMode?: boolean;
    defaultMode?: PermissionModeId;
    showThinking?: boolean;
    autoCompact?: boolean;
    webSearch?: string;
    allowBypass?: boolean;
    /** "Open files with": an id from the server's editor list (src/server/editors.ts). */
    editor?: string;
}

/** An editor Harness knows, and whether it's on this machine (the server's). */
export interface EditorInfo {
    id: string;
    name: string;
    installed: boolean;
    /** It can open a file at a line (an app found only as a bundle can't). */
    lines: boolean;
}

// ---------------------------------------------------------------------------
// Project scripts: named shell commands per project, kept in the Harness home
// (never in the repository) and run only from the GUI, in a terminal tab.

export const SCRIPT_ICONS = ["play", "test", "lint", "build", "setup", "debug"] as const;
export type ScriptIcon = (typeof SCRIPT_ICONS)[number];
export const SCRIPT_LIMITS = { name: 40, command: 2000, perProject: 50 } as const;

export interface ProjectScript {
    id: string;
    name: string;
    /** One line, typed into the shell as if by hand. */
    command: string;
    icon?: ScriptIcon;
}

export interface ProjectScripts {
    /** What the list is keyed by: a repository's main checkout (shared by its worktrees), or the folder. */
    project: string;
    scripts: ProjectScript[];
    /** The script run last here (the header button runs it). */
    lastUsed?: string;
    /** Entries in the file that can't be used as they are (edited by hand, say), kept there but neither shown nor run. */
    setAside?: { count: number; file: string };
}

// ---------------------------------------------------------------------------
// Events

export type ServerEvent =
    | { type: "terminal.data"; id: string; data: string }
    | { type: "terminal.exit"; id: string; exitCode: number }
    | { type: "session.ops"; sessionId: string; seq: number; ops: SessionOp[] }
    | { type: "sessions.upsert"; session: SessionSummary }
    | { type: "sessions.remove"; id: string }
    | { type: "notify"; sessionId: string; kind: "done" | "permission" | "question" | "plan" | "error"; title: string; body: string }
    | { type: "toast"; level: "info" | "warn" | "error"; message: string }
    /** What goes back into the session's input box (unsent messages after an interrupt, a rewound prompt). */
    | { type: "draft"; sessionId: string; text: string; images?: { mediaType: string; data: string }[] }
    | { type: "models.changed" }
    /** A project's scripts changed (in any window); `project` is ProjectScripts.project. */
    | { type: "scripts.changed"; project: string };

// ---------------------------------------------------------------------------
// Requests

export interface HelloResult {
    version: string;
    protocol: number;
    home: string;
    platform: string;
    homeDir: string;
    /** Who's signed in to this machine, and its name (the sidebar's profile). */
    user: string;
    host: string;
    /** The folder the server was started in, when it's a project. */
    startCwd?: string;
}

export interface Methods {
    "terminal.open": { params: { id: string; cwd: string; cols: number; rows: number }; result: { id: string; cwd: string } };
    "terminal.write": { params: { id: string; data: string }; result: null };
    /** The window has drawn this many characters of the terminal's output (flow control). */
    "terminal.ack": { params: { id: string; chars: number }; result: null };
    "terminal.resize": { params: { id: string; cols: number; rows: number }; result: null };
    "terminal.close": { params: { id: string }; result: null };
    /** After scripts.run, once the window has sent what was typed while it opened: the script's command may be typed now. */
    "terminal.arm": { params: { id: string }; result: null };
    hello: { params: { client?: string }; result: HelloResult };
    "scripts.list": { params: { cwd: string }; result: ProjectScripts };
    /** Creates a script, or updates the one with `id`. */
    "scripts.save": { params: { cwd: string; id?: string; name: string; command: string; icon?: ScriptIcon | null }; result: ProjectScript };
    "scripts.delete": { params: { cwd: string; id: string }; result: null };
    /** Every script's id, in the new order. */
    "scripts.reorder": { params: { cwd: string; ids: string[] }; result: ProjectScripts };
    /** Opens terminal `id` in `cwd`; the stored script's command is typed into it once the window arms it (terminal.arm) and the shell is reading. */
    "scripts.run": { params: { id: string; cwd: string; script: string; cols: number; rows: number }; result: { id: string; cwd: string; script: ProjectScript } };
    "sessions.list": { params: { limit?: number; archived?: boolean }; result: SessionSummary[] };
    "session.create": { params: { cwd: string; model?: string; mode?: PermissionModeId }; result: SessionSnapshot };
    "session.open": { params: { id: string }; result: SessionSnapshot };
    "session.close": { params: { id: string }; result: null };
    "session.send": { params: { id: string; text: string; images?: { mediaType: string; data: string }[] }; result: { queued: boolean } };
    "session.interrupt": { params: { id: string }; result: null };
    "session.respond": { params: { id: string; interactionId: string; response: InteractionResponse }; result: null };
    "session.setModel": { params: { id: string; ref: string; persist?: boolean }; result: null };
    "session.setMode": { params: { id: string; mode: PermissionModeId }; result: null };
    "session.setFastMode": { params: { id: string; enabled: boolean }; result: null };
    "session.setEffort": { params: { id: string; effort: EffortLevel }; result: null };
    "session.rename": { params: { id: string; title: string }; result: null };
    "session.compact": { params: { id: string; instructions?: string }; result: null };
    "session.rewindTargets": { params: { id: string }; result: RewindTargetInfo[] };
    "session.rewindPlan": { params: { id: string; index: number }; result: RewindPlanInfo };
    "session.rewind": { params: { id: string; index: number; planId: string; code: boolean; conversation: boolean }; result: { restored: string[]; failed: { path: string; error: string }[]; text: string } };
    "session.changes": { params: { id: string }; result: ChangesInfo };
    "session.pin": { params: { id: string; pinned: boolean }; result: null };
    "session.archive": { params: { id: string; archived: boolean }; result: null };
    "session.settle": { params: { id: string; settled: boolean }; result: null };
    /** Moves its files to the trash (sessions.remove follows); session.restore puts them back for a week. */
    "session.delete": { params: { id: string }; result: null };
    "session.restore": { params: { id: string }; result: null };
    "session.killShell": { params: { id: string; shellId: string }; result: null };
    /** Stop a delegated task (by its sub-agent's id), or every one still running. Task sub-agents stop with the turn. */
    "session.stopAgent": { params: { id: string; agentId?: string }; result: { stopped: number } };
    "session.export": { params: { id: string }; result: { markdown: string } };
    "session.toolOutput": { params: { id: string; toolId: string }; result: { output: string } };
    /** By the message's id (queueIds). With `edit`, the message comes back to put in the input box, images too. */
    "session.dequeue": { params: { id: string; queueId: number; edit?: boolean }; result: { removed: boolean; text?: string; images?: { mediaType: string; data: string }[] } };
    "models.list": { params: { refresh?: boolean }; result: ProviderModels[] };
    "providers.list": { params: Record<string, never>; result: ProviderInfo[] };
    /** `model`: the default model it set, when there was none yet. */
    "providers.setKey": { params: { provider?: string; key: string }; result: { provider: string; masked: string; warning?: string; model?: string } };
    "providers.removeKey": { params: { provider: string }; result: null };
    /** Turn on an agent CLI provider after checking (with the CLI) that it's installed and signed in. */
    "providers.connectCli": { params: { provider: string }; result: { description: string; warning?: string; model?: string } };
    /** Recent Claude Code and Codex sessions that ran in this folder. */
    "cliSessions.list": { params: { cwd: string }; result: CliSessionsList };
    /** Import one into a Harness session (or open the one that already holds it). */
    "cliSessions.import": { params: { cwd: string; source: string; id: string }; result: SessionSnapshot };
    "projects.recent": { params: Record<string, never>; result: ProjectInfo[] };
    "projects.inspect": { params: { path: string }; result: ProjectInfo };
    "projects.worktrees": { params: { path: string }; result: WorktreeInfo[] };
    /** `git worktree add -b`, with the repository's hooks off. */
    "projects.createWorktree": { params: CreateWorktreeParams; result: { path: string; branch: string } };
    /**
     * `git worktree remove` without --force, for a managed worktree; its branch is kept. `path` is any folder in
     * the repository. With ignored files in it, nothing happens until `deleteIgnored` is the `confirm` it returned.
     */
    "projects.removeWorktree": { params: { path: string; worktree: string; deleteIgnored?: string }; result: RemoveWorktreeResult };
    "projects.trust": { params: { path: string; trust: boolean }; result: ProjectInfo };
    "projects.forget": { params: { path: string }; result: null };
    "fs.mentions": { params: { cwd: string; query: string }; result: string[] };
    "fs.dirs": { params: { path: string }; result: { path: string; parent?: string; dirs: string[] } };
    /** The editors Harness knows, and the one chosen in settings. */
    "editors.list": { params: Record<string, never>; result: { editors: EditorInfo[]; selected?: string } };
    /**
     * Open a file (at a line) or a project folder in the chosen editor, on the
     * server's machine. The path is resolved against the session's folder (or
     * `cwd`, a project open in Harness) and must be inside its workspace roots.
     */
    "fs.open": { params: { sessionId?: string; cwd?: string; path: string; line?: number; col?: number; folder?: boolean }; result: { editor: string } };
    /** Which of these paths (from agent text) are files inside the session's roots: each one's absolute path, or null. At most 200. */
    "fs.exists": { params: { sessionId?: string; cwd?: string; paths: string[] }; result: (string | null)[] };
    "commands.list": { params: { cwd: string }; result: CommandInfo[] };
    "settings.get": { params: { cwd?: string }; result: GuiSettings };
    "settings.update": { params: { patch: GuiSettings }; result: GuiSettings };
}

export type Method = keyof Methods;
export type ParamsOf<M extends Method> = Methods[M]["params"];
export type ResultOf<M extends Method> = Methods[M]["result"];

export type ClientMessage = { id: number; method: Method; params: unknown };
export type ServerMessage = { id: number; result: unknown } | { id: number; error: { message: string; code?: string; folder?: string } } | { event: ServerEvent };
