// The GUI protocol: what the harness server and the GUI say to each other over
// the WebSocket. Shared by both sides, so it must stay pure TypeScript: no
// Bun, Node or DOM imports (the GUI bundles this file).
//
// Requests:  client -> { id, method, params }      server -> { id, result } | { id, error }
// Events:    server -> { event }                   (session timelines, sidebar updates, notifications)

import type { McpApprovalInfo, McpListInfo, McpServerInfo, McpServerStatus } from "../mcp/info";

export const PROTOCOL_VERSION = 1;

/**
 * What a message can carry besides images. The composer refuses a file over
 * these before sending; the server checks every one again. The total keeps a
 * message's base64 (4/3 of the bytes, about 27 MB) well inside the
 * WebSocket's 48 MB, and a PDF stays under the request size Anthropic takes
 * (32 MB) even resent with the rest of the conversation.
 */
export const ATTACH_LIMITS = {
    textBytes: 512 * 1024,
    pdfBytes: 10 * 1024 * 1024,
    files: 10,
    totalBytes: 20 * 1024 * 1024,
    nameChars: 120,
};

// Lives in src/util because provider serializers use it too and cannot import server code.
export { MEDIA_BUDGET, base64Size } from "../util/media";

/** A paste longer than this (characters or lines) becomes a "Pasted text" attachment instead of filling the box. */
export const LONG_PASTE = { chars: 4000, lines: 80 };

/** A file as it travels: its bytes and the name it was given. The server decides what it is. */
export interface WireFile {
    name: string;
    data: string /* base64 */;
    /** Pasted into the box rather than a file. */
    pasted?: boolean;
}

/** What a prompt shows of an attached file: never its contents. */
export interface FileChip {
    name: string;
    kind: "text" | "pdf";
    size: number;
    lines?: number;
    pasted?: boolean;
}

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
    /** No longer sent: what a sub-agent does is its AgentRun's, which the call's row opens. */
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
    /** A sub-agent's own sub-agent (a delegated Codex task's, say): the agent whose activity has the call that started it. */
    parentId?: string;
    description: string;
    /** "general-purpose", "explore", or a custom agent type. */
    agentType: string;
    /** provider:model, when it isn't the session's own. */
    model?: string;
    effort?: EffortLevel;
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
    /** From before the session was reopened: nothing of it runs. Only its call and result are known, unless a backend's turn ran it (then its steps are kept too). */
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
    files?: FileChip[];
    /** Started by a slash command (/init, /review, custom commands). */
    command?: boolean;
    /** Position of the prompt in the session's messages, when it can be rewound to. */
    index?: number;
}

export interface Turn {
    id: string;
    /** Stable file-history checkpoint whose raw snapshots describe this turn. */
    snapshotId?: number;
    prompt?: TurnPrompt;
    blocks: Block[];
    status: TurnStatus;
    startedAt?: number;
    endedAt?: number;
    /** Before the last compaction: shown, but no longer in the model's context. */
    archived?: boolean;
    /** From a Claude Code or Codex session started elsewhere: shown, can't be rewound to. */
    imported?: boolean;
    /**
     * Where the message that started it sits in the session file: its segment
     * (compactions before it) and position there. Kept after a compaction, unlike
     * prompt.index; a search hit finds its turn by it.
     */
    pos?: { seg: number; index: number };
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
    /** The secrets a command gets in its environment (run_with_secrets), by name. */
    secrets?: string[];
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

/** The agent asks the user to type in a secret (RequestSecret). `name` and `purpose` are the model's words. */
export interface SecretInteraction {
    kind: "secret";
    id: string;
    toolId?: string;
    /** The environment variable it becomes. */
    name: string;
    purpose: string;
}

export type Interaction = PermissionInteraction | QuestionInteraction | PlanInteraction | SecretInteraction;

export type InteractionResponse =
    | { kind: "permission"; choice: PermissionOption["id"]; feedback?: string }
    | { kind: "question"; answers?: string[] }
    | { kind: "plan"; approved: boolean; mode?: PermissionModeId; feedback?: string }
    /** No value: declined. The value goes to the session's memory and nowhere else. */
    | { kind: "secret"; value?: string };

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
    supportsPdf?: boolean;
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
    status: McpServerStatus;
    tools: number;
    error?: string;
    source: "settings" | "project";
    /** A project server's approval (no fingerprint: session.mcp has that). */
    approval?: McpApprovalInfo;
}

export type { McpApprovalInfo, McpListInfo, McpServerInfo, McpServerStatus };

export interface SessionState {
    accounts?: Record<string, string>;
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
    /** What each queued message carries besides its text ("report.log, 1 image"), "" for nothing. */
    queuedAttached?: string[];
    interactions: Interaction[];
    mcp: McpStatus[];
    /** Files this session's edit tools changed (the Changes panel). */
    filesChanged: number;
    /** Background shells started by the agent. */
    shells: { id: string; command: string; running: boolean; exitCode: number | null; startedAt: number }[];
    /** Forked from this session (its title then). */
    forkOf?: { id: string; title: string };
    /** The names of the secrets the user gave this session (never their values). */
    secrets: string[];
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

/** A message that matched a search of every session's text. */
export interface SessionSearchHit {
    id: string;
    title: string;
    cwd: string;
    projectName: string;
    archived: boolean;
    /** The segment (compactions before it) and position of the matched message, as Turn.pos has them. */
    seg: number;
    index: number;
    role: "user" | "assistant";
    /** A short stretch of the message around the match, redacted. */
    snippet: string;
    /** Where the match is in the snippet (absent when redaction swallowed it). */
    match?: [number, number];
    /** When the matched message's turn started, or the session's last change when that isn't known. */
    at: number;
}

/**
 * Lower case that keeps every position where it was ("İ" stays as it is
 * rather than turning into two characters) and doesn't depend on the letters
 * around it, so where a match is found in the folded text is where it is in
 * the original. Server search and the GUI's find bar both match with it.
 */
export function foldCase(s: string): string {
    let l = s.toLowerCase();
    if (l.length !== s.length) {
        l = "";
        for (const ch of s) {
            const x = ch.toLowerCase();
            l += x.length === ch.length ? x : ch;
        }
    }
    // Σ lowers to ς at the end of a word and σ elsewhere: "ΟΣ" in "ΟΣΑ" must still match.
    return l.includes("ς") ? l.replace(/ς/g, "σ") : l;
}

export interface SessionSearchResult {
    hits: SessionSearchHit[];
    /** The time or size budget ran out before every session was read. */
    partial: boolean;
    /** A newer search from the same window replaced this one; its hits are dropped. */
    stale?: boolean;
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

export interface AccountInfo {
    id: string;
    name: string;
    folder: string;
    managed: boolean;
    signedIn?: boolean;
    description?: string;
    email?: string;
    plan?: string;
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
        accounts?: AccountInfo[];
        defaultAccount?: string;
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

/** Account ids are local metadata, independent of a CLI's private account identity. */
export const planLimitKey = (provider: string, accountId = "default") => JSON.stringify([provider, accountId]);

export interface CommandInfo {
    name: string;
    description: string;
    args?: string;
    custom?: boolean;
}

/** One window of a plan's usage limits (five hours, a week), as an agent CLI reported it. */
export interface LimitWindow {
    /** Stable key: Claude Code's window name (five_hour), Codex's limit and slot (codex:primary). */
    id: string;
    /** "5-hour", "Weekly". */
    label: string;
    /** 0-100; absent when the CLI didn't say. */
    usedPercent?: number;
    /** When it resets (ms since the epoch), when known. */
    resetsAt?: number;
    reached?: boolean;
}

/** Where the user's plan stands with an agent CLI (Claude Code, Codex): per account, not per session. */
export interface PlanLimits {
    provider: string;
    /** Local account id; omitted reports belong to the default account. */
    accountId?: string;
    windows: LimitWindow[];
    /** The CLI said a limit is reached (true) or that it isn't (false); absent when it didn't say. */
    reached?: boolean;
    /** When the reached limit resets (ms), when known. */
    resetsAt?: number;
    /** When it was reported (ms). */
    at: number;
}

/** The ranges the Usage view offers, in days. */
export const USAGE_DAYS = [1, 7, 30] as const;
export type UsageDays = (typeof USAGE_DAYS)[number];

/** Tokens and cost of one provider's model over the range. */
export interface UsageRow {
    provider: string;
    providerName: string;
    /** The model id within the provider. */
    model: string;
    /** On a subscription (an agent CLI on its plan): the cost is what the API would have charged. */
    plan: boolean;
    sessions: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** USD, estimated from list prices (or as the provider reported it); the known part only. */
    cost: number;
    /** API-equivalent USD for usage covered by a plan (included in cost). */
    planEquivalent: number;
    /** Some of it had no known price: cost leaves that out (it isn't free). */
    unknown: boolean;
}

export interface UsageSummary {
    days: UsageDays;
    /** Start of the range (ms). */
    since: number;
    rows: UsageRow[];
    /** The rows added up (sessions apart: one can use several models). */
    totals: Pick<UsageRow, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "cost" | "planEquivalent" | "unknown">;
    /** Sessions with any usage in the range. */
    sessions: number;
    /** Records from before usage was dated, placed at their session's last activity. */
    approxDated: number;
    /** Alias-only records priced using today's model listing rather than a recorded concrete model. */
    approxPriced?: number;
    /** Why not everything was read (too many sessions, too much to read in time). */
    truncated?: string;
}

export interface RewindTargetInfo {
    index: number;
    text: string;
    /** Files Harness's own tools changed answering it. */
    files: number;
    tracked: boolean;
    /** From before this session was forked: files changed then are restored from the original session, not here. */
    forked?: boolean;
    /** Agent backends that answered it (Claude Code, Codex): what they changed isn't tracked, so it isn't in `files`. */
    backends?: string[];
}

export interface RewindPlanInfo {
    index: number;
    /** Passed back to session.rewind, which restores exactly this plan (or refuses if the conversation moved on). */
    planId: string;
    restore: { path: string; action: "write" | "delete"; outside: boolean }[];
    skipped: { path: string; reason: string }[];
    tracked: boolean;
    /** From before the fork: `restore` has only what this session changed since. */
    forked?: boolean;
    /** Agent backends that answered since then: their changes to files aren't in `restore`, and rewinding leaves them. */
    backends?: string[];
}

export interface ChangesInfo {
    files: FileDiff[];
    added: number;
    removed: number;
    tracked: boolean;
}

/** Uncommitted: the working tree against HEAD. Branch: against where this branch left its base. */
export type GitScope = "uncommitted" | "branch" | "last-turn" | "turn";

export interface GitFileDiff extends FileDiff {
    /** What git would call it. Renames are exact ones (the same content under a new name). */
    change: "added" | "modified" | "deleted" | "untracked" | "renamed" | "typechange";
    /** A rename's old path. */
    from?: string;
    /** Not a plain file: a symbolic link (its target is diffed), a submodule, a repository inside this one, or a new folder of many files. */
    kind?: "link" | "submodule" | "repo" | "folder";
    /** Hunks left out to keep the reply small; ask again with this path to get them. */
    deferred?: boolean;
    /** Git runs this filter driver on the file; its diff, if any, is of the form stored in git. */
    filter?: string;
}

/** What git says changed in a session's folder, whoever changed it. */
export interface GitChangesInfo extends ChangesInfo {
    files: GitFileDiff[];
    /** false: not a Git repository (or Git can't read it); `reason` says why. */
    repo: boolean;
    reason?: string;
    scope: GitScope;
    turns?: { id: number; prompt: string; startedAt: number; endedAt?: number }[];
    turnId?: number;
    /** Both snapshot trees were available for comparison; an empty diff is authoritative. */
    snapshotAvailable?: boolean;
    incomplete?: boolean;
    notes?: string[];
    head?: { branch?: string; sha?: string };
    /** Branch scope: the base branch and the commit this branch left it at. */
    base?: { ref: string; sha: string };
    /** Branches to compare with, most recently changed first (local and remote, capped). */
    bases: string[];
    /** What Harness treats as the main branch. */
    defaultBase?: string;
    /** Changed files not listed; `moreAtLeast` when even the count was cut short. */
    more: number;
    moreAtLeast?: boolean;
}

export interface GitCommitHead {
    branch?: string;
    detached: boolean;
    /** Full commit SHA, required for a detached HEAD snapshot. */
    sha?: string;
}

export interface GitCommitInfo {
    hash: string;
    subject: string;
    branch?: string;
}

export interface GitCommitMessageInfo {
    message: string;
    model: string;
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
    /** Its runtime was closed under the window (a delete that failed): open it again for a fresh snapshot, keeping the draft and view. */
    | { type: "session.reload"; sessionId: string }
    | { type: "notify"; sessionId: string; kind: "done" | "permission" | "question" | "plan" | "error"; title: string; body: string }
    | { type: "toast"; level: "info" | "warn" | "error"; message: string }
    /** What goes back into the session's input box (unsent messages after an interrupt, a rewound prompt). */
    | { type: "draft"; sessionId: string; text: string; images?: { mediaType: string; data: string }[]; files?: WireFile[] }
    | { type: "models.changed" }
    /** A project's scripts changed (in any window); `project` is ProjectScripts.project. */
    | { type: "scripts.changed"; project: string }
    /** An agent CLI reported where the user's plan stands. */
    | { type: "limits"; limits: PlanLimits };

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
    "terminal.open": { params: { id: string; cwd: string; cols: number; rows: number; login?: { provider: string; accountId: string } }; result: { id: string; cwd: string } };
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
    /** Prompts and replies in every session containing `query` (literal, any case, 2–200 characters). `archived` limits it to archived (true) or other (false) sessions. */
    "sessions.search": { params: { query: string; limit?: number; archived?: boolean }; result: SessionSearchResult };
    "session.create": { params: { cwd: string; model?: string; mode?: PermissionModeId }; result: SessionSnapshot };
    "session.open": { params: { id: string }; result: SessionSnapshot };
    "session.close": { params: { id: string }; result: null };
    /** `literal`: send a leading /word as a message. Unknown commands fail with `unknown_command`, so clients keep the draft. */
    "session.send": { params: { id: string; text: string; images?: { mediaType: string; data: string }[]; files?: WireFile[]; literal?: boolean }; result: { queued: boolean } };
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
    /** `text` and what the prompt carried (images, files) go back to the input box, as with an edited queued message. */
    "session.rewind": { params: { id: string; index: number; planId: string; code: boolean; conversation: boolean }; result: { restored: string[]; failed: { path: string; error: string }[]; text: string; images?: { mediaType: string; data: string }[]; files?: WireFile[] } };
    /** A new session with the conversation up to the end of the turn of the prompt at `index` (TurnPrompt.index, or Turn.pos.index for imported prompts), which the window showed as turn `turn` with `text`. */
    "session.fork": { params: { id: string; index: number; text: string; turn: string }; result: SessionSnapshot };
    "session.changes": { params: { id: string }; result: ChangesInfo };
    "session.gitChanges": { params: { id: string; scope: GitScope; base?: string; path?: string; turnId?: number }; result: GitChangesInfo };
    "session.gitCommit": { params: { id: string; paths: string[]; message: string; expectedHead?: GitCommitHead }; result: GitCommitInfo };
    "session.gitCommitMessage": { params: { id: string; paths: string[] }; result: GitCommitMessageInfo };
    "session.pin": { params: { id: string; pinned: boolean }; result: null };
    "session.archive": { params: { id: string; archived: boolean }; result: null };
    "session.settle": { params: { id: string; settled: boolean }; result: null };
    /** Moves its files to the trash (sessions.remove follows); session.restore puts them back for a week. */
    "session.delete": { params: { id: string }; result: null };
    "session.restore": { params: { id: string }; result: null };
    "session.killShell": { params: { id: string; shellId: string }; result: null };
    /** New shells no longer get this secret. */
    "session.forgetSecret": { params: { id: string; name: string }; result: null };
    /** Stop a delegated task (by its sub-agent's id), or every one still running. Task sub-agents stop with the turn. */
    "session.stopAgent": { params: { id: string; agentId?: string }; result: { stopped: number } };
    "session.export": { params: { id: string }; result: { markdown: string } };
    "session.toolOutput": { params: { id: string; toolId: string }; result: { output: string } };
    /** By the message's id (queueIds). With `edit`, the message comes back to put in the input box, images and files too. */
    "session.dequeue": { params: { id: string; queueId: number; edit?: boolean }; result: { removed: boolean; text?: string; images?: { mediaType: string; data: string }[]; files?: WireFile[] } };
    "models.list": { params: { refresh?: boolean }; result: ProviderModels[] };
    "session.setAccount": { params: { id: string; provider: string; accountId: string }; result: null };
    "accounts.list": { params: { provider: string; refresh?: boolean }; result: AccountInfo[] };
    "accounts.add": { params: { provider: string; id: string; name: string; folder?: string }; result: AccountInfo };
    "accounts.rename": { params: { provider: string; id: string; name: string }; result: null };
    "accounts.remove": { params: { provider: string; id: string; confirmedFolder: string }; result: null };
    "accounts.setDefault": { params: { provider: string; id: string }; result: null };
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
    /** Uses the cwd's default provider unless given; an optional command name is checked before creating a session. */
    "commands.list": { params: { cwd: string; provider?: string; command?: string }; result: CommandInfo[] };
    "settings.get": { params: { cwd?: string }; result: GuiSettings };
    "settings.update": { params: { patch: GuiSettings }; result: GuiSettings };
    /** The agent CLIs' plan limits known so far (since the server started). */
    "limits.get": { params: Record<string, never>; result: PlanLimits[] };
    /** Tokens and cost per provider and model, from the session transcripts. */
    "usage.summary": { params: { days: UsageDays }; result: UsageSummary };
    /**
     * The session's folder's MCP servers, read again from settings and
     * .mcp.json (so what the terminal's /mcp did shows), each with what it
     * runs. With `name`, just that one, in full.
     */
    "session.mcp": { params: { id: string; name?: string }; result: McpListInfo };
    /** Approve a project server for exactly the configuration `fingerprint` names. If it changed since, nothing is saved: `approved` is false, with the fresh list. */
    "session.mcpApprove": { params: { id: string; name: string; fingerprint: string }; result: { approved: boolean; list: McpListInfo } };
    "session.mcpReject": { params: { id: string; name: string }; result: McpListInfo };
    "session.mcpRevoke": { params: { id: string; name: string }; result: McpListInfo };
    /** Read its configuration again and start it afresh, if it may run (a changed .mcp.json server asks again instead). */
    "session.mcpReconnect": { params: { id: string; name: string }; result: McpListInfo };
}

export type Method = keyof Methods;
export type ParamsOf<M extends Method> = Methods[M]["params"];
export type ResultOf<M extends Method> = Methods[M]["result"];

export type ClientMessage = { id: number; method: Method; params: unknown };
export type ServerMessage = { id: number; result: unknown } | { id: number; error: { message: string; code?: string; folder?: string } } | { event: ServerEvent };
