// The GUI protocol: what Cavvy server and the GUI say to each other over
// the WebSocket. Shared by both sides, so it must stay pure TypeScript: no
// Bun, Node or DOM imports (the GUI bundles this file).
//
// Requests:  client -> { id, method, params }      server -> { id, result } | { id, error }
// Events:    server -> { event }                   (session timelines, sidebar updates, notifications)

import type { DiagnosticReport } from "../lsp/diagnostics";
import type { BackgroundTaskInfo } from "../backends/live/info";

export type { BackgroundTaskInfo } from "../backends/live/info";

/**
 * How a request to stop a background task went: stopped by it, not confirmed in time, refused, can't be stopped
 * alone, no such task, or it had already ended on its own (it keeps its own outcome).
 */
export type BackgroundStopResult = "stopped" | "timeout" | "failed" | "not_stoppable" | "unknown" | "ended";
import type { McpApprovalInfo, McpListInfo, McpServerInfo, McpServerStatus } from "../mcp/info";
import type { PluginListing, PluginScope } from "../plugins/info";

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

/** "queued": the call has fully arrived and waits for another call in its response to finish before it runs. */
export type ToolStatus = "streaming" | "queued" | "running" | "awaiting" | "ok" | "error" | "denied";

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
    /** What the language server found after an edit. */
    diagnostics?: DiagnosticReport;
    images?: number;
    /** Live output while it runs (a shell command's tail). */
    progress?: string;
    /** Characters of input received while the model writes the call. */
    receiving?: number;
    /** The background shell a BashOutput or KillShell call is about: what it runs, and since when. */
    job?: { label: string; startedAt: number };
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

export interface NoticeBlock extends NoticeData {
    t: "notice";
    id: string;
    level: "info" | "warn" | "error";
    /** What it says (under `title`, when it has one). Plain text; `code` in backticks reads as code. */
    text: string;
    /** One short line each, folded under the text (TurnNotice.details). */
    details?: string[];
}

/**
 * What a notice is, beyond its text (#426), so it's drawn as what it is rather than as a sentence. Every field is
 * optional: a notice from before these (a plain string) is an info line, a warning or an error by its level.
 */
export interface NoticeData {
    /** What the notice shows, where it isn't the message as said (a titled warning's body; Codex's words, without "Codex: "). */
    text?: string;
    /** The agent CLI that said it ("claude-code", "codex"): its logo is the icon, in place of a "Codex:" prefix. */
    source?: string;
    /** A short title (a warning's pill, an error card's sentence): `text` is then what folds under it. */
    title?: string;
    /** A link the CLI gave with it (its docs). */
    link?: string;
    /** An account switch: one line between turns. */
    account?: NoticeAccount;
    /**
     * Tasks a switch's restart stopped, said after its line was no longer the latest (a message came since): a line
     * of their own, which switches nothing.
     */
    stopped?: NoticeStopped;
    /** A plan limit: reached (warn), on credits (warn, `credits`), or stopping the turn (error). */
    limit?: NoticeLimit;
}

/** A background task an account switch's restart stopped. */
export interface StoppedTask {
    /** Its description (Claude Code's Bash `description`), or its command, cut short (Codex's have no description). */
    label: string;
    /** The whole command, when it isn't the label. */
    command?: string;
}

/**
 * A session's switch to another account of an agent CLI. Switches with no message between them are one notice,
 * the latest (Session.recordSwitch), with every task they stopped.
 */
export interface NoticeAccount {
    provider: string;
    /** The CLI's name ("Claude Code"). */
    cli: string;
    /** The account's display name. */
    name: string;
    /**
     * native: the same CLI session goes on, resumed natively (the account shares its history). returned: the earlier
     * thread this account finds is picked up again. handoff: a new thread is handed the conversation.
     */
    how: "native" | "returned" | "handoff";
    /** A handoff from a native session the new account can't resume. */
    dropped?: true;
    stopped?: StoppedTask[];
}

/** Background tasks an account switch's restart stopped, on a line of their own (NoticeData.stopped). */
export interface NoticeStopped {
    provider: string;
    /** The CLI's name ("Claude Code"). */
    cli: string;
    tasks: StoppedTask[];
}

/** A plan limit an account of an agent CLI reached. */
export interface NoticeLimit {
    provider: string;
    accountId: string;
    /** The account's display name. */
    name: string;
    /** The window that's reached ("5-hour", "Weekly"), when known. */
    window?: string;
    /** When it resets (ms), when known. */
    resetsAt?: number;
    /** Past it, turns go on, billed to credits. */
    credits?: true;
}

/** "resumed", "new thread": how a switch's conversation goes on, in a word. */
export function switchWord(how: NoticeAccount["how"]): string {
    return how === "handoff" ? "new thread" : "resumed";
}

/** What a switch's word means, for its tooltip and a screen reader. */
export function switchMeaning(a: NoticeAccount): string {
    const said =
        a.how === "native"
            ? "Same session, resumed: this account shares its history."
            : a.how === "returned"
              ? "Its earlier thread on this account is picked up again, with what happened since."
              : `New thread: this conversation was handed over${a.dropped ? " (this account doesn't share the earlier thread)" : ""}.`;
    return `Switched to ${a.cli} · ${a.name}. ${said}`;
}

/** The tasks a switch stopped, for a tooltip: each by its description, then its command (Codex's are their command). */
export function stoppedTasksTip(provider: string, tasks: StoppedTask[]): string {
    const line = (t: StoppedTask) => (provider === "codex" ? `$ ${t.command ?? t.label}` : t.command ? `${t.label}\n  $ ${t.command}` : t.label);
    return ["Stopped by the switch's restart:", ...tasks.map(line)].join("\n");
}

/** A switch as one line of text (the terminal, a copy, find): "Codex · Second · resumed", then what it stopped. */
export function accountNoticeText(a: NoticeAccount): string {
    const line = `${a.cli} · ${a.name} · ${switchWord(a.how)}`;
    const stopped = a.stopped ?? [];
    if (!stopped.length) return line;
    return `${line}\n${stoppedText(stopped)}`;
}

/** What a switch stopped, in a line: "Stopped: <its description>", or "3 tasks stopped". */
export function stoppedText(tasks: StoppedTask[]): string {
    return tasks.length === 1 ? `Stopped: ${tasks[0]!.label}` : `${tasks.length} tasks stopped`;
}

/**
 * A CLI's model catalog (its models, and their effort and speed options) is listed by its starting account only:
 * said where a session on another account picks a model.
 */
export function catalogSentence(cli: string, source: string, selected: string): string {
    return `${cli}'s model list, with each model's effort and speed options, comes from its starting account (${source}); ${selected} may not offer all of them.`;
}

export interface CompactBlock {
    t: "compact";
    id: string;
    summary: string;
    auto: boolean;
    /** Compacted while idle, before the prompt cache expired. */
    idle?: boolean;
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
    /** A hash of the images (session.promptImages has them): the same key, the same images. Turn ids aren't kept across a reopen. */
    imagesKey?: string;
    files?: FileChip[];
    /** Started by a slash command (/init, /review, custom commands). */
    command?: boolean;
    /** Started by a schedule, not the user: what it is ("Scheduled (every 10m)"). */
    scheduled?: string;
    /** Started by an event the agent asked to be woken for (a watched pull request, a monitor), not by the user. */
    wake?: boolean;
    /** Position of the prompt in the session's messages, when it can be rewound to. */
    index?: number;
    /**
     * Sent while a turn ran and joined it at its next step: the turn before ended for it, and this one carries
     * on its work (the GUI keeps their work open together until the last of them ends).
     */
    steered?: boolean;
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
    id: "yes" | "session" | "always" | "session-edits" | "no";
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
    /** One plain-English line on what the action does and what makes it risky, written by a model; shown above the command. */
    plain?: string;
    /** How to label `plain` so it isn't taken for the command itself ("AI summary"). */
    plainLabel?: string;
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

/** One MCP resource as the composer's @ menu shows it; `mention` is what goes after the @. */
export interface McpResourceInfo {
    server: string;
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mention: string;
}

export interface McpStatus {
    name: string;
    status: McpServerStatus;
    tools: number;
    /** Resources (and templates) and prompts it offers, when it offers any. */
    resources?: number;
    prompts?: number;
    error?: string;
    source: "settings" | "project";
    /** A project server's approval (no fingerprint: session.mcp has that). */
    approval?: McpApprovalInfo;
}

/** The latest plan the session presented (ExitPlanMode), answered or not: its id is the tool call's (or the request's). */
export interface PlanRef {
    id: string;
    title: string;
    at: number;
}

/**
 * A plan taken to a new worktree, recorded in both sessions: in the planning
 * session as "to" (where it went), in the new one as "from" (where it came from).
 */
export interface PlanLink {
    role: "from" | "to";
    /** The other session's id. */
    session: string;
    /** The planning session's title, when the link was made. */
    title?: string;
    /** The planning session's folder. */
    folder: string;
    /** The new worktree. */
    path: string;
    branch: string;
    /** What the branch started from, as the user named it (the commit when they didn't). */
    base?: string;
    at: number;
    /** The plan it carried out: the planning session's ExitPlanMode call (PlanRef.id). Missing from older links. */
    plan?: string;
}
export type { McpApprovalInfo, McpListInfo, McpServerInfo, McpServerStatus };

/**
 * A queued message: "steer" joins the running turn at its next step, "queue" waits for it to end,
 * "turn" must wait (images, files, commands), "held" waits for the user: it came back after a restart, or the
 * session's CLI account was removed (queuedWhy says so; picking an account sends it).
 */
export type QueuedMode = "steer" | "queue" | "turn" | "held";

/** What a message sent while a turn runs does (the followUpBehavior setting, or the opposite key). */
export type FollowUpMode = "steer" | "queue";
/** A schedule as a list shows it (src/agent/schedule.ts keeps the jobs). */
export interface ScheduleInfo {
    id: string;
    kind: "loop" | "cron" | "resume";
    prompt: string;
    /** "every 10m", "weekdays at 9:00 AM", "once, Tue 21 Oct, 2:30 PM". */
    when: string;
    recurring: boolean;
    durable: boolean;
    paused: boolean;
    nextAt?: number;
    expiresAt?: number;
    lastRunAt?: number;
    runs: number;
    /** Came due while the session was busy: runs as soon as it isn't. */
    due: boolean;
}

/** A /goal set in the session (src/agent/goal.ts): it keeps working, turn after turn, until a check finds the condition holds. */
export interface GoalState {
    condition: string;
    /** active: working or about to; checking: the check is running; waiting: on background tasks or a retry; paused: until the user's next message. */
    state: "active" | "checking" | "waiting" | "paused";
    /** When it was set (or restored), ms. */
    since: number;
    /** Turns checked so far. */
    turns: number;
    /** Tokens spent since it was set. */
    tokens: number;
    /** The last check's reason. */
    lastReason?: string;
    /** Why it's paused or waiting. */
    note?: string;
    /** When a retry is due (waiting), ms. */
    retryAt?: number;
    /** Who checks: a separate model, the working model's own report, or the agent CLI's own /goal (Claude Code, Codex). */
    judge: "model" | "self" | "native";
    /** judge "native": the CLI that keeps the goal ("Claude Code"), and whether it can be paused (Codex's can). */
    by?: string;
    canPause?: boolean;
}

export interface SessionState {
    accounts?: Record<string, string>;
    /**
     * The CLI (its provider id) whose account this session used was removed, and messages wait for the user to pick
     * another (#410): the model picker opens on its accounts. Unset once one is picked, or nothing waits.
     */
    accountNeeded?: string;
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
    activity?: { label: string; since: number; detail?: string; /** An idle compaction: what the user does next takes over from it. */ idle?: boolean };
    contextTokens: number;
    /**
     * Context, in tokens, at which this session compacts on its own: an agent CLI's auto-compact setting for
     * this model and account (Claude Code's /autocompact window, Codex's model_auto_compact_token_limit), or
     * Cavvy's own threshold. Absent when compaction is off here, or the CLI decides.
     */
    compactAt?: number;
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
    /** What each queued message will do (missing from older servers: all "steer"). */
    queuedModes?: QueuedMode[];
    /** Why each queued message can't join a running turn ("" when it can): a command, or what it carries. */
    queuedWhy?: string[];
    interactions: Interaction[];
    mcp: McpStatus[];
    /** Files this session's edit tools changed (the Changes panel). */
    filesChanged: number;
    /** Background shells started by the agent. */
    shells: { id: string; command: string; running: boolean; exitCode: number | null; startedAt: number; /** Started by Monitor: its lines wake the agent. */ monitor?: { description: string; events: number; expiresAt: number } }[];
    /** What the agent is watching in the background (pull requests): each wakes it when there's news. */
    watches?: WatchInfo[];
    /**
     * The session's background work, whoever runs it: an agent CLI's background sub-agents, shells and monitors,
     * the tasks it delegated to other models, and Cavvy's own background shells and monitors. Running ones,
     * and those that stopped when Cavvy quit (lost) until the agent is told. Missing from older servers.
     */
    backgroundTasks?: BackgroundTaskInfo[];
    plan?: PlanRef;
    planLinks?: PlanLink[];
    /** Forked from this session (its title then). */
    forkOf?: { id: string; title: string };
    /** The names of the secrets the user gave this session (never their values). */
    secrets: string[];
    /** Its schedules (/loop, cron jobs, the resume after a usage limit), soonest first as the server keeps them. */
    schedules: ScheduleInfo[];
    /** The session's /goal, while one is set. */
    goal?: GoalState;
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
    /** The first pending request, including sessions no client has open. */
    waitingKind?: Interaction["kind"];
    /** Start of the visible turn, independent of its current tool or activity. */
    turnStartedAt?: number;
    pinned: boolean;
    archived: boolean;
    /** Set aside: done with for now, listed apart from the sessions still in play. */
    settled: boolean;
    /** The model it last used ("provider:id"). */
    model?: string;
    /** Loaded in the server right now. */
    live: boolean;
    /** Started with other models from one prompt (runs.start). */
    run?: RunMember;
}

export type RunOutcome = "working" | "done" | "stopped";

/** A session's place in a run: which run, and which of its models it is. */
export interface RunMember {
    id: string;
    /** The prompt's start, as the run's sessions are grouped under. */
    label: string;
    /** The folder it was started from. */
    cwd: string;
    model: string;
    modelName: string;
    /** Latest result, kept when the session unloads or the server restarts. */
    outcome?: RunOutcome;
}

/** How a provider is paid for: the user's plan (Claude Code, Codex), on this machine, or per token through a key. */
export type Billing = "plan" | "local" | "api";

/** The same prompt to 2-4 models, each in a new worktree of `path`'s repository from its HEAD. */
export interface StartRunParams {
    path: string;
    /** "provider:id" refs. */
    models: string[];
    text: string;
    images?: { mediaType: string; data: string }[];
    files?: WireFile[];
    mode?: PermissionModeId;
    /** The user agreed to more than two paid-API models. */
    confirmPaid?: boolean;
}

/** One per model, in the order asked: started, or why not (with the worktree, when one was made). */
export type RunResult =
    | { model: string; modelName: string; ok: true; sessionId: string; branch: string; path: string }
    | { model: string; modelName: string; ok: false; error: string; branch?: string; path?: string };

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
    /** The Cavvy session that already holds it. */
    cavvyId?: string;
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
    /** Ones already in Cavvy not listed (they have a limit of their own). */
    moreInCavvy: number;
}

export interface CliSessionsList {
    sources: CliSourceInfo[];
    /** Both sources, newest first; ones already in Cavvy have `cavvyId` (and don't count toward the limit). */
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
    /** Inside <main worktree>/.claude/worktrees/, where Cavvy creates them and may remove them. */
    managed: boolean;
}

/** A sub-agent working in a worktree, by the paths its recent tool calls name. */
export interface WorktreeAgent {
    id: string;
    /** The session whose sub-agent it is. */
    sessionId: string;
    description: string;
    /** Waiting for an answer (a permission), not running. */
    waiting: boolean;
}

/** One of a session's repository's worktrees, as the diff reader lists them to look at. */
export interface SessionWorktreeInfo extends WorktreeInfo {
    /** The running sub-agents of the sessions loaded in the server that work in it. */
    agents?: WorktreeAgent[];
    /** What `ahead` counts from: the branch the Branch view compares with by default. */
    base?: string;
    /** Commits on its HEAD that `base` doesn't have. */
    ahead?: number;
    /** When its HEAD commit was made (ms since the epoch). */
    committedAt?: number;
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
    /** Run the project's setup script in the new worktree (the dialog's choice); nothing runs when it's absent. */
    setup?: boolean;
    /** The exact setup preview accepted at Create time; setup is skipped if it no longer matches. */
    setupScript?: Pick<ProjectScript, "id" | "command">;
}

export interface CreateWorktreeResult {
    path: string;
    branch: string;
    /** The setup script may start, once, from this window: scripts.run with `setup: ticket`, soon. */
    setup?: { ticket: string; script: ProjectScript };
    /** Setup was asked for but won't run, and why (the worktree was created all the same). */
    setupError?: string;
}

/** What the New worktree dialog says about the setup script. */
export interface SetupInfo {
    /** The repository's main checkout: trusting it lets the setup script run. */
    main: string;
    /** The script marked to run in each worktree created from the GUI, if any. */
    script?: ProjectScript;
    /** Trusted by the user (not only for having nothing to protect). */
    trusted: boolean;
}

/** The modes a plan can be carried out in: the plan card's Approve choices. */
export const IMPLEMENT_MODES = ["acceptEdits", "default", "auto"] as const;
export type ImplementMode = (typeof IMPLEMENT_MODES)[number];

/** A session's plan, and what the plan dialogs start from. */
export interface PlanInfo {
    /** What session.implementPlan and session.savePlan take as `toolId`. */
    id: string;
    plan: string;
    title: string;
    /** Still waiting for an answer on the plan card. */
    pending: boolean;
    cwd: string;
    /** Set when the session's folder is in a Git repository. */
    git?: {
        /** The main worktree's root: new worktrees go in <main>/.claude/worktrees/. */
        main: string;
        /** A free branch name made from the plan's title. */
        branch: string;
        /** The folder's current branch, or its commit when detached. */
        base: string;
    };
    /** Why there's no worktree to make, when there isn't. */
    notGit?: string;
    mode: ImplementMode;
    /** Why that mode was picked, in a few words. */
    modeWhy: string;
    /** Where Save plan writes by default (a free name). */
    savePath: string;
    /** The Cavvy home, the other folder (with the session's) plans may be saved in. */
    home: string;
}

export interface ImplementPlanParams {
    id: string;
    /** PlanInfo.id; the latest plan when omitted. */
    toolId?: string;
    branch: string;
    base?: string;
    folder?: string;
    mode: ImplementMode;
    /** A managed worktree an earlier attempt made (on `branch`), to start the session in instead of making one. */
    resume?: string;
}

/** The worktree, and the new session in it; `failed` when the worktree was made but the session couldn't start. */
export interface ImplementPlanResult {
    path: string;
    branch: string;
    sessionId?: string;
    failed?: { message: string; code?: string; folder?: string };
}

/** Whether archiving a session can also remove the managed worktree it works in. */
export interface ArchiveOffer {
    /** None: the session isn't in a managed worktree, and archives as it always has. */
    worktree?: { path: string; branch?: string; main: string };
    removable: boolean;
    /** Why the worktree would be kept. */
    reason?: string;
}

export type ArchiveResult =
    /** `kept`: why the worktree stays. `closed`: the server closed the session (the window should let go of it). */
    | { archived: true; removed: boolean; kept?: string; code?: string; worktree?: string; main?: string; closed?: boolean }
    /** Nothing done yet: these ignored files would be deleted (removal needs `confirm` as deleteIgnored). */
    | { archived: false; ignored: string[]; total: number; confirm: string };

export interface AccountInfo {
    invalid?: boolean;
    id: string;
    name: string;
    folder: string;
    managed: boolean;
    signedIn?: boolean;
    description?: string;
    email?: string;
    plan?: string;
    /** Signed in with an API key: usage is billed to that key, so there's no plan to show. */
    apiKey?: boolean;
    /** A Cavvy-made account's folder keeps some entries of its own instead of linking Default's. */
    sharing?: string;
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
    billing: Billing;
    models: ModelSummary[];
}

/** Account ids are local metadata, independent of a CLI's private account identity. */
export const planLimitKey = (provider: string, accountId = "default") => JSON.stringify([provider, accountId]);

export interface CommandInfo {
    name: string;
    description: string;
    args?: string;
    custom?: boolean;
    /** A skill (SKILL.md): runs as /name, and $name mentions it in a prompt. */
    skill?: boolean;
    /** Answered without the model (/compact, /loop): a message with attachments is refused, as they'd be lost. */
    noAttachments?: boolean;
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
    /**
     * Only on a window of another metered limit than the plan's own (a Codex model's): whether
     * that limit's credits carry turns past it (PlanLimits.credits is the plan's own). False
     * stops there, whatever the plan's credits.
     */
    credits?: boolean;
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
    /**
     * Past a reached limit, turns go on, billed to credits: Codex's credits, Claude Code's extra
     * usage. False when the CLI said they won't (none, or a turn stopped on the limit anyway);
     * absent when it didn't say. A flag only: no balance or amount is ever kept.
     */
    credits?: boolean;
    /** When it was reported (ms). */
    at: number;
}

/**
 * A reached limit that turns go on past, using credits: the plan's credits
 * carry them, and no reached window (`reachedNow`, by index: the meter's own
 * view of which still are) is another limit's that has none.
 */
export function usingCredits(l: PlanLimits, reached: boolean, reachedNow: (i: number) => boolean = (i) => Boolean(l.windows[i]?.reached)): boolean {
    return reached && l.credits === true && !l.windows.some((w, i) => w.credits === false && reachedNow(i));
}

/** The ranges the Usage view offers, in days. */
export const USAGE_DAYS = [1, 7, 30, 90] as const;
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

export type UsageSource = "claude-code" | "codex" | "api";
export interface UsageCostTypes { input: number; cacheRead: number; cacheWrite: number; output: number; unallocated: number }
export interface UsageTotals {
    inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
    cost: number; planEquivalent: number; unknown: boolean;
    costByType: UsageCostTypes; cacheSavings: number;
}
export interface UsageSourceRow extends UsageTotals { source: UsageSource; label: string; sessions: number }
export interface UsageBucket extends UsageTotals {
    at: number; sessions: number;
    sources: Record<UsageSource, UsageTotals>;
}
export interface UsageAccountRow extends UsageRow { source: UsageSource; accountId: string }
/** Sparse detail for source/provider/model/account within each UTC hour or day. */
export interface UsageDetailBucket extends UsageAccountRow { at: number }

export interface UsageSummary {
    days: UsageDays;
    /** Start of the range (ms). */
    since: number;
    rows: UsageRow[];
    /** The rows added up (sessions apart: one can use several models). */
    totals: UsageTotals;
    sources: UsageSourceRow[];
    accounts: UsageAccountRow[];
    interval: "hour" | "day";
    series: UsageBucket[];
    buckets: UsageDetailBucket[];
    /** Existing #26 reports; also available via limits.get. */
    limits: PlanLimits[];
    /** Sessions with any usage in the range. */
    sessions: number;
    /** Records from before usage was dated, placed at their session's last activity. */
    approxDated: number;
    /** Legacy alias-only records lacking a recorded historical concrete model; may be unpriced. */
    approxPriced?: number;
    /** Why not everything was read (too many sessions, too much to read in time). */
    truncated?: string;
}

/** A commit on main the installed desktop app doesn't have yet. */
export interface AppUpdateChange {
    hash: string;
    subject: string;
}

/** Whether the desktop app, built from a checkout (scripts/update-desktop.ts), is behind origin/main, and its update if one is running. */
export interface AppUpdateInfo {
    /** Why this copy can't update itself (not the installed desktop app, no record of the checkout it came from); nothing else is set. */
    unavailable?: string;
    /** The installed build's commit, short. */
    installed?: string;
    /** main's latest commit when last checked, short. */
    latest?: string;
    /** main has something the installed build doesn't. */
    available: boolean;
    /** Changes on main since the installed build, newest first: the first 20 of `behind`. */
    changes: AppUpdateChange[];
    behind: number;
    /** What's odd about the installed build, when there's no plain list: built with uncommitted changes, or from a branch. */
    note?: string;
    checkedAt?: number;
    checking: boolean;
    /** An update running: since when, and the last line it printed. `restarting`: built and installed, Cavvy restarts next. */
    updating?: { startedAt: number; line: string; restarting: boolean };
    /** The last check failed (couldn't fetch main, say): the rest is as of the fetch before. */
    error?: string;
    /** The last update failed, or installed without the app restarting: what happened. Cleared when one starts. */
    failed?: string;
    /** The last update's output. */
    log?: string;
}

export interface RewindTargetInfo {
    index: number;
    text: string;
    /** Files Cavvy's own tools changed answering it. */
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
    /** `path` hides a registered value: send this instead of it to act on the file. */
    pathToken?: string;
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
    /** `branchToken`: the branch's name hides a registered value; send it (GitCommitHead) instead of the name. */
    head?: { branch?: string; sha?: string; branchToken?: string };
    /** Branch scope: the base branch and the commit this branch left it at. */
    base?: { ref: string; sha: string; refToken?: string };
    /** Branches to compare with, most recently changed first (local and remote, capped). */
    bases: string[];
    /** Beside `bases`, when a name there hides a registered value: its handle (send it as `baseToken`), else null. */
    baseTokens?: (string | null)[];
    /** What Cavvy treats as the main branch. */
    defaultBase?: string;
    defaultBaseToken?: string;
    /** Changed files not listed; `moreAtLeast` when even the count was cut short. */
    more: number;
    moreAtLeast?: boolean;
    /** A turn's: the other worktrees of the repository it worked in (TurnPlace), as they were when it ended. */
    places?: TurnPlace[];
}

/**
 * Another worktree of the session's repository that a turn worked in (it changed, or appeared, during the
 * turn): its branch against the main branch, committed or not, as the diff reader shows it there, when the
 * turn ended. Counts are missing when they couldn't be read in time.
 */
export interface TurnPlace {
    /** The worktree's folder, as `git worktree list` gives it. */
    path: string;
    branch?: string;
    /** The branch it's compared with. */
    base?: string;
    files?: number;
    added?: number;
    removed?: number;
    /** Commits on it since it left the base. */
    commits?: number;
    /** The files with the most lines changed, the most first. `pathToken`: the name hides a registered value (GitFileDiff.pathToken). */
    top?: { path: string; change: "added" | "modified" | "deleted"; added: number; removed: number; pathToken?: string }[];
}

/** A confirmation snapshot; the server rechecks the destination and HEAD before publishing. */
export interface GitPublishInfo {
    fingerprint: string;
    branch: string;
    remote: string;
    target: string;
    destination: string;
    ahead?: number;
    behind?: number;
    hasUpstream: boolean;
    base?: string;
    protected: boolean;
    defaultUnknown: boolean;
    gh: boolean;
    prError?: string;
    title: string;
    body: string;
    compareUrl?: string;
    pr?: GitPrInfo;
}
export interface GitPublishRequest {
    fingerprint: string;
    action: "push" | "pr";
    confirmProtected?: boolean;
    base?: string;
    title?: string;
    body?: string;
    draft?: boolean;
}
export interface WatchInfo {
    id: string;
    /** "pull-request". */
    kind: string;
    label: string;
    url?: string;
    detail?: string;
}

export interface GitPrInfo {
    number: number;
    url: string;
    title: string;
    state: "open" | "draft" | "merged" | "closed";
    checks: number;
}

export interface GitCommitHead {
    branch?: string;
    /** Instead of `branch`, when its name was shown redacted (GitChangesInfo.head.branchToken). */
    branchToken?: string;
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
    /** Compact long conversations left idle (true, the default: one-hour caches; "always": five-minute ones too). */
    idleCompaction?: boolean | "always";
    webSearch?: string;
    /** The Browser tools and pane (false turns them off; true, the default, is stored as unset). */
    browser?: boolean;
    allowBypass?: boolean;
    /** A message sent while a turn runs: steer it (default) or wait for it to end. */
    followUpBehavior?: FollowUpMode;
    /** "Open files with": an id from the server's editor list (src/server/editors.ts). */
    editor?: string;
}

/** An editor Cavvy knows, and whether it's on this machine (the server's). */
export interface EditorInfo {
    id: string;
    name: string;
    installed: boolean;
    /** It can open a file at a line (an app found only as a bundle can't). */
    lines: boolean;
}

// ---------------------------------------------------------------------------
// Project scripts: named shell commands per project, kept in the Cavvy home
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
    /** Typed into a new terminal tab of each worktree created from the GUI (one script per project at most); only ever `true`. */
    runOnWorktreeCreate?: boolean;
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
// The browser (src/browser): a session's tabs, seen and driven from the GUI's Browser pane.

/** The modifier keys held during an input, as the bits of a BrowserInput's `modifiers` (Input.dispatchKeyEvent's). */
export const BROWSER_MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;

/** What a person did in the pane, in the page's CSS pixels. */
export type BrowserInput =
    /** `buttons`: MouseEvent.buttons (left 1, right 2, middle 4) held after the event. */
    | { kind: "mouse"; type: "move" | "down" | "up"; x: number; y: number; button?: "left" | "middle" | "right"; buttons?: number; clickCount?: number; modifiers?: number }
    | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
    | { kind: "key"; type: "down" | "up"; key: string; code: string; modifiers?: number }
    /** Text as it is (a paste, an input method's result), not keys. */
    | { kind: "text"; text: string };

/** Who drove a tab last: the agent, the person watching, or neither yet. Neither keeps the other out. */
export type BrowserOwner = "agent" | "human" | "none";

export interface BrowserTabInfo {
    id: number;
    title: string;
    url: string;
    loading: boolean;
    owner: BrowserOwner;
    canGoBack: boolean;
    canGoForward: boolean;
    crashed: boolean;
    /** The browser's own id for the tab: the desktop app shows that view of it in the pane (browser/host.ts). */
    targetId?: string;
    /** A confirm or prompt waiting for an answer. */
    dialog?: { type: string; message: string; defaultPrompt?: string };
}

/**
 * Where a session's browser stands. `idle`: nothing started yet (it starts with the first page).
 * `unavailable`: there's no browser to start, and `error` says how to fix that. `crashed`: it ended unexpectedly;
 * the next page starts a new one.
 */
export interface BrowserState {
    status: "idle" | "starting" | "ready" | "unavailable" | "crashed";
    error?: string;
    tabs: BrowserTabInfo[];
    active?: number;
}

/** What the pane's address bar and tab strip can ask for. */
export type BrowserCommand = "goto" | "back" | "forward" | "reload" | "new_tab" | "switch_tab" | "close_tab";

// ---------------------------------------------------------------------------
// Events

export type ServerEvent =
    /** A session's browser changed: its tabs, who drives them, or whether it runs (sent to the windows that have the session open). */
    | { type: "browser.state"; sessionId: string; state: BrowserState }
    /**
     * A frame of the current tab, for a window watching it (browser.watch), sent after it acknowledges receipt of the last (browser.ack).
     * `data`: a JPEG frame, base64 on the legacy RPC connection; `width` and `height`: the page's size in CSS pixels, which a click's coordinates are in.
     */
    | { type: "browser.frame"; sessionId: string; frameId: string; tab: number; data: string; width: number; height: number }
    /**
     * `pos`: where in the shell's output this ends (the window gives it back to
     * terminal.attach). `reset`: the window's screen is to be reset before `data`,
     * which replays all the output kept.
     */
    | { type: "terminal.data"; id: string; data: string; pos: number; reset?: boolean }
    | { type: "terminal.exit"; id: string; exitCode: number }
    /** Another connection with this window's key (a copy of the window) attached the terminal: it's shown there now. */
    | { type: "terminal.moved"; id: string }
    | { type: "session.ops"; sessionId: string; seq: number; ops: SessionOp[] }
    | { type: "sessions.upsert"; session: SessionSummary }
    | { type: "sessions.remove"; id: string }
    /** Its runtime was closed under the window (a delete that failed): open it again for a fresh snapshot, keeping the draft and view. */
    | { type: "session.reload"; sessionId: string }
    | {
          type: "notify";
          sessionId: string;
          /** background: a background task ended on its own (task says which, and how). */
          kind: "done" | "permission" | "question" | "plan" | "error" | "background";
          title: string;
          body: string;
          /** Names what it's about: one notification per tag (a background task's). */
          tag?: string;
          task?: { id: string; outcome: "done" | "failed" | "stopped" };
      }
    | { type: "toast"; level: "info" | "warn" | "error"; message: string }
    /** What goes back into the session's input box (unsent messages after an interrupt, a rewound prompt). */
    | { type: "draft"; sessionId: string; text: string; images?: { mediaType: string; data: string }[]; files?: WireFile[] }
    | { type: "models.changed" }
    /** A project's scripts changed (in any window); `project` is ProjectScripts.project. */
    | { type: "scripts.changed"; project: string }
    /** An agent CLI reported where the user's plan stands. */
    | { type: "limits"; limits: PlanLimits }
    /** The keybindings file was saved, created or deleted. */
    | { type: "keybindings.changed"; keybindings: KeybindingsFile }
    /** The desktop app's update state changed: a check finished, an update started, moved on or ended. */
    | { type: "app.update"; info: AppUpdateInfo };

// ---------------------------------------------------------------------------
// Requests

/** The project script a terminal was opened to run, which names its tab. */
export interface TerminalScript {
    id: string;
    name: string;
}

/** Safe display/selector metadata only: commands, environments and login output stay off persistence. */
export interface TerminalLogin {
    provider: string;
    accountId: string;
    name: string;
}

/** One of the window's terminals. `exitCode`: its shell has exited (it's kept, with its output, until closed). */
export interface TerminalInfo {
    id: string;
    cwd: string;
    script?: TerminalScript;
    login?: TerminalLogin;
    exitCode?: number;
}

/**
 * The keybindings file as it is on disk (`text` undefined: there's none).
 * Each window builds its own keymap from it: what `mod` means depends on the
 * computer the window runs on.
 */
export interface KeybindingsFile {
    path: string;
    text?: string;
    /** It exists but couldn't be read. */
    error?: string;
}

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
    /** The session's browser: where it stands, with its tabs. It starts with the first page, not with this. */
    "browser.state": { params: { id: string }; result: BrowserState };
    /**
     * The window shows the session's current tab, in a pane of this size (CSS pixels; `scale`: device pixels per CSS pixel):
     * the page takes that size, and frames come as browser.frame until browser.unwatch. Another call with a new size resizes.
     */
    "browser.watch": { params: { id: string; width: number; height: number; scale: number }; result: BrowserState };
    "browser.unwatch": { params: { id: string }; result: null };
    /** The window has received this frame; decoding independently retains only the latest waiting picture. */
    "browser.ack": { params: { id: string; frameId: string }; result: null };
    /** What the person did in the pane; the agent is told of it (a pointer only moving isn't). */
    "browser.input": { params: { id: string; tab?: number; input: BrowserInput }; result: null };
    /** The address bar and the tab strip: the person opening or leaving a page drives the tab. */
    "browser.command": { params: { id: string; command: BrowserCommand; url?: string; tab?: number }; result: BrowserState };
    /** The person answers a confirm or prompt the page is showing. */
    "browser.dialog": { params: { id: string; accept: boolean; text?: string; tab?: number }; result: null };
    /** After scripts.run, once the window has sent what was typed while it opened: the script's command may be typed now. */
    "terminal.arm": { params: { id: string }; result: null };
    /**
     * Terminals belong to a window: its connection presents the window's key (a
     * WebSocket subprotocol, "window.<32 hex digits>"), and only a connection
     * with that key reaches them. They keep running for a while when it goes.
     */
    "terminal.list": { params: Record<string, never>; result: TerminalInfo[] };
    /**
     * Takes the window's terminal on this connection (after a reload or a
     * reconnect). What it printed since `have` (the last terminal.data's `pos`)
     * comes first, as terminal.data, ahead of this reply; without `have`, or if
     * that much is no longer kept, all of what is, with `reset`.
     */
    /** Login terminals clear the screen and never replay output, regardless of `have`. */
    "terminal.attach": { params: { id: string; have?: number }; result: TerminalInfo };
    hello: { params: { client?: string }; result: HelloResult };
    "keybindings.get": { params: Record<string, never>; result: KeybindingsFile };
    /** Creates the keybindings file from the template when there's none; true when it did. */
    "keybindings.create": { params: Record<string, never>; result: { created: boolean; path: string } };
    "scripts.list": { params: { cwd: string }; result: ProjectScripts };
    /** Creates a script, or updates the one with `id`. */
    "scripts.save": { params: { cwd: string; id?: string; name: string; command: string; icon?: ScriptIcon | null; runOnWorktreeCreate?: boolean }; result: ProjectScript };
    "scripts.delete": { params: { cwd: string; id: string }; result: null };
    /** Every script's id, in the new order. */
    "scripts.reorder": { params: { cwd: string; ids: string[] }; result: ProjectScripts };
    /**
     * Opens terminal `id` in `cwd`; the stored script's command is typed into it once the window arms it (terminal.arm) and the shell is reading.
     * `setup`: the ticket projects.createWorktree gave this window, to run the setup script in the new worktree (once).
     */
    "scripts.run": { params: { id: string; cwd: string; script: string; cols: number; rows: number; setup?: string }; result: { id: string; cwd: string; script: ProjectScript } };
    /** The setup script of the repository `cwd` is in, and whether it may run there. */
    "scripts.setupInfo": { params: { cwd: string }; result: SetupInfo };
    "sessions.list": { params: { limit?: number; archived?: boolean }; result: SessionSummary[] };
    /** Prompts and replies in every session containing `query` (literal, any case, 2–200 characters). `archived` limits it to archived (true) or other (false) sessions. */
    "sessions.search": { params: { query: string; limit?: number; archived?: boolean }; result: SessionSearchResult };
    "session.create": { params: { cwd: string; model?: string; mode?: PermissionModeId }; result: SessionSnapshot };
    "session.open": { params: { id: string }; result: SessionSnapshot };
    "session.close": { params: { id: string }; result: null };
    /** `literal`: send a leading /word as a message. Unknown commands fail with `unknown_command`, so clients keep the draft. */
    /** `mode`: what it does if a turn is running (default: the followUpBehavior setting). */
    "session.send": { params: { id: string; text: string; images?: { mediaType: string; data: string }[]; files?: WireFile[]; literal?: boolean; mode?: FollowUpMode }; result: { queued: boolean } };
    "session.interrupt": { params: { id: string }; result: null };
    "session.respond": { params: { id: string; interactionId: string; response: InteractionResponse }; result: null };
    "session.setModel": { params: { id: string; ref: string; persist?: boolean }; result: null };
    "session.setMode": { params: { id: string; mode: PermissionModeId }; result: null };
    "session.setFastMode": { params: { id: string; enabled: boolean }; result: null };
    /** The window's input box for the session has an unsent message (`present`), or no longer has: one being written holds off compacting while idle. */
    "session.draft": { params: { id: string; present: boolean; /** The Rewind dialog open on it, rather than a message being written. */ dialog?: boolean }; result: null };
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
    /**
     * `worktree`: another worktree of the session's repository to look at (a path `session.worktrees` lists);
     * any other folder is refused. Turn scopes are the session's own folder's only.
     */
    /** `pathToken` / `baseToken`: handles from an earlier listing (GitFileDiff.pathToken, baseTokens), instead of `path` / `base`. */
    "session.gitChanges": { params: { id: string; scope: GitScope; base?: string; baseToken?: string; path?: string; pathToken?: string; turnId?: number; worktree?: string }; result: GitChangesInfo };
    /** The worktrees of the repository the session's folder is in (none outside one), with their branch's lead on the main branch. */
    "session.worktrees": { params: { id: string }; result: SessionWorktreeInfo[] };
    "session.gitPublishInfo": { params: { id: string }; result: GitPublishInfo };
    "session.gitPublish": { params: { id: string } & GitPublishRequest; result: { pr?: GitPrInfo } };
    "session.gitPrState": { params: { id: string }; result: { pr?: GitPrInfo } };
    /** `pathTokens`: files whose names were shown redacted (GitFileDiff.pathToken), with `paths` for the rest. */
    "session.gitCommit": { params: { id: string; paths: string[]; pathTokens?: string[]; message: string; expectedHead?: GitCommitHead }; result: GitCommitInfo };
    "session.gitCommitMessage": { params: { id: string; paths: string[]; pathTokens?: string[] }; result: GitCommitMessageInfo };
    "session.pin": { params: { id: string; pinned: boolean }; result: null };
    /**
     * With `removeWorktree`, the managed worktree the session works in goes too (its branch stays), when nothing
     * would be lost; otherwise it's kept and `kept` says why. Ignored files wait for `deleteIgnored`, as with
     * projects.removeWorktree, and the session isn't archived until then.
     */
    "session.archive": { params: { id: string; archived: boolean; removeWorktree?: boolean; deleteIgnored?: string }; result: ArchiveResult | null };
    "session.archiveOffer": { params: { id: string }; result: ArchiveOffer };
    "session.planInfo": { params: { id: string; toolId?: string }; result: PlanInfo };
    /** A managed worktree on a new branch, and a new session there working on the plan; the plan card is answered so the planning session stops. */
    "session.implementPlan": { params: ImplementPlanParams; result: ImplementPlanResult };
    /** Writes the plan as Markdown, in the session's folder or the Cavvy home; an existing file only with `replace`. */
    "session.savePlan": { params: { id: string; toolId?: string; path?: string; replace?: boolean }; result: { path: string } };
    "session.settle": { params: { id: string; settled: boolean }; result: null };
    /** Moves its files to the trash (sessions.remove follows); session.restore puts them back for a week. */
    "session.delete": { params: { id: string }; result: null };
    "session.restore": { params: { id: string }; result: null };
    "session.killShell": { params: { id: string; shellId: string }; result: null };
    /** Stop background tasks (SessionState.backgroundTasks) by id, or every one running: how each went. */
    "session.stopBackground": { params: { id: string; ids?: string[] }; result: { results: Record<string, BackgroundStopResult> } };
    /** Clear the finished tasks from the Background panel. */
    "session.clearBackground": { params: { id: string }; result: null };
    /** Restart the session's agent CLI process (/tasks restart): what it runs in the background stops. */
    "session.restartCli": { params: { id: string }; result: null };
    "session.stopWatch": { params: { id: string; watchId: string }; result: null };
    /** New shells no longer get this secret. */
    "session.forgetSecret": { params: { id: string; name: string }; result: null };
    /** Stop a delegated task (by its sub-agent's id), or every one still running. Task sub-agents stop with the turn. */
    "session.stopAgent": { params: { id: string; agentId?: string }; result: { stopped: number } };
    "session.export": { params: { id: string }; result: { markdown: string } };
    "session.toolOutput": { params: { id: string; toolId: string }; result: { output: string } };
    /** The images a prompt carried, by its turn's `pos` (TurnPrompt only says how many). */
    "session.promptImages": { params: { id: string; seg: number; index: number }; result: { images: { mediaType: string; data: string }[] } };
    /** One of the session's schedules: pause, resume, run now, or delete. `found` false: it's gone already. */
    "session.schedule": { params: { id: string; scheduleId: string; action: "pause" | "resume" | "run" | "delete" }; result: { found: boolean } };
    /** By the message's id (queueIds). With `edit`, the message comes back to put in the input box, images and files too. */
    "session.dequeue": { params: { id: string; queueId: number; edit?: boolean }; result: { removed: boolean; text?: string; images?: { mediaType: string; data: string }[]; files?: WireFile[] } };
    /** "Send now": steer the running turn with it, or run it now if none is running. `sent` false: it had already gone. */
    "session.sendQueuedNow": { params: { id: string; queueId: number }; result: { sent: boolean; started?: boolean } };
    /** Move a queued message to position `to` (0 runs next). */
    "session.moveQueued": { params: { id: string; queueId: number; to: number }; result: { moved: boolean } };
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
    /** Import one into a Cavvy session (or open the one that already holds it). */
    "cliSessions.import": { params: { cwd: string; source: string; id: string }; result: SessionSnapshot };
    "projects.recent": { params: Record<string, never>; result: ProjectInfo[] };
    "projects.inspect": { params: { path: string }; result: ProjectInfo };
    "projects.worktrees": { params: { path: string }; result: WorktreeInfo[] };
    /** `git worktree add -b`, with the repository's hooks off. */
    "projects.createWorktree": { params: CreateWorktreeParams; result: CreateWorktreeResult };
    /**
     * `git worktree remove` without --force, for a managed worktree; its branch is kept. `path` is any folder in
     * the repository. With ignored files in it, nothing happens until `deleteIgnored` is the `confirm` it returned.
     */
    "projects.removeWorktree": { params: { path: string; worktree: string; deleteIgnored?: string }; result: RemoveWorktreeResult };
    /**
     * Refused with "confirm_paid" for more than two paid-API models without `confirmPaid`, "needs_trust" (its
     * `folder`) when the repository's Git config needs trust, and "needs_project_trust" when the new worktrees'
     * project configuration does; nothing is created then.
     */
    "runs.start": { params: StartRunParams; result: { runId: string; results: RunResult[] } };
    "projects.trust": { params: { path: string; trust: boolean }; result: ProjectInfo };
    "projects.forget": { params: { path: string }; result: null };
    "fs.mentions": { params: { cwd: string; query: string }; result: string[] };
    "fs.dirs": { params: { path: string }; result: { path: string; parent?: string; dirs: string[] } };
    /** The editors Cavvy knows, and the one chosen in settings. */
    "editors.list": { params: Record<string, never>; result: { editors: EditorInfo[]; selected?: string } };
    /**
     * Open a file (at a line) or a project folder in the chosen editor, on the
     * server's machine. The path is resolved against the session's folder (or
     * `cwd`, a project open in Cavvy) and must be inside its workspace roots.
     */
    /** `gitToken`: a file a Git listing showed redacted (GitFileDiff.pathToken), instead of `path`. */
    "fs.open": { params: { sessionId?: string; cwd?: string; path?: string; gitToken?: string; line?: number; col?: number; folder?: boolean }; result: { editor: string } };
    /** Which of these paths (from agent text) are files inside the session's roots: each one's absolute path, or null. At most 200. */
    "fs.exists": { params: { sessionId?: string; cwd?: string; paths: string[] }; result: (string | null)[] };
    /** A PNG, JPEG, GIF or WebP file anywhere on this machine (judged by its bytes; a relative path is the session's), for showing an image the model's reply names. */
    "fs.image": { params: { sessionId?: string; cwd?: string; path: string }; result: { mediaType: string; data: string } };
    /** Uses the cwd's default provider unless given; an optional command name is checked before creating a session. */
    "commands.list": { params: { cwd: string; provider?: string; command?: string }; result: CommandInfo[] };
    /** Plugins and marketplaces, with each plugin's state for `cwd`'s folder (without one: the user's own settings only). */
    "plugins.list": { params: { cwd?: string }; result: PluginsInfo };
    /** Change plugins or marketplaces. Fetching (git, npm) happens before it answers; every open folder reloads after. */
    "plugins.action": { params: PluginActionParams; result: PluginsInfo & { message: string } };
    /** A plugin maker's logo: their GitHub account's avatar (fetched by the server, as the GUI loads no outside images), or null. */
    "plugins.logo": { params: { owner: string }; result: { mediaType: string; data: string } | null };
    "settings.get": { params: { cwd?: string }; result: GuiSettings };
    "settings.update": { params: { patch: GuiSettings }; result: GuiSettings };
    /** The agent CLIs' plan limits known so far: the last ones saved before the server started, then any newer report. */
    "limits.get": { params: Record<string, never>; result: PlanLimits[] };
    /** Tokens and cost per provider and model, from the session transcripts. */
    "usage.summary": { params: { days: UsageDays }; result: UsageSummary };
    /** Whether the desktop app is behind origin/main, as of the last check. */
    "app.update.get": { params: Record<string, never>; result: AppUpdateInfo };
    /** Fetch origin/main now and compare it with the installed build. */
    "app.update.check": { params: Record<string, never>; result: AppUpdateInfo };
    /** Build and install main (scripts/update-desktop.ts), then restart the app. It runs on its own: progress comes as app.update events. */
    "app.update.start": { params: Record<string, never>; result: AppUpdateInfo };
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
    /**
     * Start signing in to a remote server (OAuth): answers with the link to
     * open once it's ready. The sign-in finishes in the browser; the server's
     * status follows in session events, and a failure comes as a notice.
     */
    "session.mcpSignIn": { params: { id: string; name: string }; result: { url: string } };
    /** Forget a remote server's stored sign-in; it asks to sign in again. */
    "session.mcpSignOut": { params: { id: string; name: string }; result: McpListInfo };
    /** Connected servers' resources matching `query`, for the composer's @ menu. */
    "session.mcpResources": { params: { id: string; query: string }; result: McpResourceInfo[] };
}

export type Method = keyof Methods;

export type { PluginInfo, PluginListing, PluginScope, MarketplaceInfo as PluginMarketplaceInfo } from "../plugins/info";

export interface PluginsInfo extends PluginListing {
    /** The folder the states are for, and whether its project settings count. */
    cwd?: string;
    trusted: boolean;
}

export type PluginActionParams =
    | { action: "install"; id: string; scope: PluginScope; cwd?: string }
    | { action: "uninstall" | "enable" | "disable"; id: string; scope?: PluginScope; cwd?: string }
    | { action: "update"; id?: string; cwd?: string }
    | { action: "marketplaceAdd"; source: string; cwd?: string }
    | { action: "marketplaceRemove" | "marketplaceUpdate"; name: string; cwd?: string };
export type ParamsOf<M extends Method> = Methods[M]["params"];
export type ResultOf<M extends Method> = Methods[M]["result"];

export type ClientMessage = { id: number; method: Method; params: unknown };
export type ServerMessage = { id: number; result: unknown } | { id: number; error: { message: string; code?: string; folder?: string } } | { event: ServerEvent };
