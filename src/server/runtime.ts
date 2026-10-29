// One live session in the GUI server: the agent, its tools and permissions,
// and the session's timeline, kept up to date from the agent's events and
// sent to every GUI window that has the session open. The terminal app does
// the same work in ui/app.ts; this is its counterpart without a terminal.

import { NO_SCHEDULES, SessionSchedules, type ScheduleAction } from "../agent/schedule-host";
import { CRON_TOOLS, jobLine } from "../agent/schedule-tools";
import type { ScheduledJob } from "../agent/schedule";
import { GIT_TOOL_HEADINGS } from "../tools/git-tools";
import { BROWSER_TOOL_HEADINGS } from "../tools/browser-tools";
import { BrowserSession } from "../browser/session";
import { SimulatorSession } from "../simulator/session";
import { SIMULATOR_TOOL_HEADINGS } from "../tools/simulator-tools";
import { WakeQueue, WatcherMap, formatWakes, stopWatchers, wakeDisplay, type Wake } from "../agent/wakes";
import { turnDuration } from "./duration";
import { existsSync, readFileSync } from "fs";
import { basename, join } from "path";
import { Agent, type Admission, type Admitted, type AgentEvent, type PermissionRequest, type PermissionResponse, type TurnEndReason } from "../agent/agent";
import { backendsIn, canonical, FileHistory, promptNotes, resetToolState, rewindTargets, untrackedChangesNote, type RestoreItem } from "../agent/checkpoints";
import { beforeFork, forkCut, forkTargets } from "../agent/fork";
import { fireHooks, type HookEvent } from "../agent/hooks";
import { backgroundWork, canAnswerOneOff, GoalController, goalClearedNotice, limitedCodexGoal, loopGoalDropped, nativeGoalBack, nativeGoalEnd, nativeGoalLeft, nativeGoals, nativeGoalStatus, nativeGoalView, parseGoalCommand, queuedGoalSet, sessionTokens, type NativeGoal } from "../agent/goal";
import { sessionHookServices, sessionStartHooks } from "../agent/session-hooks";
import { Session, type TurnNotice } from "../agent/session";
import { buildSystemPrompt } from "../agent/system-prompt";
import { INIT_PROMPT, reviewPrompt } from "../commands/index";
import { expandCommand, pluginCommandFor, slashCommand } from "../commands/custom";
import { addPermissionRule, updateSettings, EFFORT_LEVELS, type Effort, type Settings } from "../config/settings";
import { MODE_INFO, PERMISSION_MODES, type PermissionMode } from "../permissions/modes";
import { PermissionChecker } from "../permissions/checker";
import { AutoClassifier, REVIEW_REQUEST, reviewText, type ReviewStage } from "../permissions/classifier";
import { toolPath } from "../permissions/rules";
import { BUILTIN_TOOLS, offered } from "../tools/index";
import { skillTool } from "../tools/skill-tool";
import { formatSkill, skillMentions, withSkills } from "../agent/skills";
import { cliRunsSkills } from "../backends/native-skills";
import { loadsPluginsNatively, onlyPluginHooks, runsPluginCommand, sessionHookSettings, withoutPluginHooks } from "../plugins/native";
import { childEnv, killAllShells, runShell } from "../tools/bash";
import { stoppedMonitorNote } from "../tools/monitor";
import type { Sampler, Tool, ToolResult, ToolState } from "../tools/types";
import { isShellTool } from "../tools/types";
import { availableSearchBackend, formatHits, searchWeb } from "../tools/web-tools";
import { clientFor, defaultModelFrom, lookupModel, resolveModelInfo, reviewTarget, smallModelFor } from "../providers/models";
import { costOf } from "../providers/pricing";
import { isAgentBackend, type BackendWake, type BackgroundStop } from "../backends/types";
import { SessionBackground } from "../agent/background";
import { getProvider, resolveBaseUrl } from "../providers/registry";
import { agentCli, steersMidTurn, type AttachmentKind } from "../backends/defs";
import { claudeCompactAt, cliCompactSetting, cavvyCompactAt, modelKeys } from "../backends/compact-at";
import { account, accountSwitch, removedAccount, removedAccountNote, switchHow } from "../providers/accounts";
import { attachmentsNote, readsPdf } from "../providers/files";
import { continuationGroups, modelRef, parseModelRef, textOf, toolCallsOf, assistantText, type AttachedPart, type Message, type ModelInfo, type ProviderClient, type ToolCallPart, type UserContent } from "../providers/types";
import { expandMentions } from "../ui/mentions";
import { expandMcpMentions, findMcpMentions } from "../mcp/mentions";
import type { McpAsker } from "../mcp/elicitation";
import { notifyAfterMs } from "../ui/notify";
import { displayPath } from "../util/files";
import { gitBranch } from "../util/git";
import { redact, redactPrefix, lineRedactor } from "../util/redact";
import { redactedReport } from "../lsp/diagnostics";
import { trustedByUser } from "../config/trust";
import { attachedLabel, attachedPrompt, toWire } from "./attachments";
import { followUpDefault, loadQueue, saveQueue, type FollowUp } from "../agent/queue-store";
import { RpcError } from "./rpc-error";
import { fileDiff, textOf as bufText, trimInput } from "./diffs";
import { gitChanges } from "./git-changes";
import { GitHandles, redactedError } from "./git-handles";
import { sessionWorktree, sessionWorktrees, workingWorktree } from "./session-worktrees";
import { excludeManagedWorktrees, mainCheckoutOf } from "./worktrees";
import { gitPublishInfo, gitPublish, gitPrState } from "./git-publish";
import { COMMIT_MESSAGE_SYSTEM, gitCommit, gitCommitPrompt } from "./git-commit";
import { AGENT_KEPT, agentFromCall, agentHead, agentStep, agentsFromTurns, cutOffPrompt, INTERRUPTED, isPrompt, runsAgent, promptKey, promptText, liveNotice, noticeBlock, readSegments, replay, resultPatch, shownStep, STEERING, toolBlockFromCall, UiLog, withoutActionsNote, type AgentHead, type ToolMeta } from "./history";
import { TurnSnapshots } from "../agent/turn-snapshots";
import { IdleCompactTimer } from "../agent/idle-compact";
import type {
    AgentRun,
    BackgroundTaskInfo,
    Block,
    ChangesInfo,
    GitChangesInfo,
    SessionWorktreeInfo,
    GitCommitHead,
    GitCommitInfo,
    GitCommitMessageInfo,
    GitPublishRequest,
    GitPrInfo,
    GitScope,
    EffortLevel,
    Interaction,
    InteractionResponse,
    ModelSummary,
    PermissionInteraction,
    PlanLink,
    PlanRef,
    QueuedMode,
    RewindPlanInfo,
    RewindTargetInfo,
    SessionOp,
    SessionSnapshot,
    SessionState,
    WorkingIn,
    ToolBlock,
    ToolCategoryId,
    Turn,
    TurnStatus,
    WireFile,
    NoticeData,
    StoppedTask,
} from "./protocol";
import { applyOp, coalesce, findBlock, findTurn, type SessionView } from "./timeline";
import { planTitle } from "./plans";
import type { Engine, Workspace } from "./engine";
import { MCP_SERVER_NAME } from "../agent/delegation";
import { SecretStore, secretValueError } from "../agent/secrets";

/** How often streamed output goes out to the GUI. */
const FLUSH_MS = 24;

interface Pending {
    interaction: Interaction;
    resolve: (r: InteractionResponse | undefined) => void;
}

interface Queued {
    id: number;
    text: string;
    attachments?: AttachedPart[];
    /** Sent as a message even though it starts with a /word. */
    literal?: boolean;
    /** Join the running turn at its next step, or wait for it to end. */
    mode: FollowUp;
    /** Restored after a restart: it waits for the user (Send now) rather than run on its own. */
    held?: boolean;
    /** With attachments, on its way into the running turn: it stays queued until that has it (steerAttached). */
    sending?: boolean;
    /** Its UserPromptSubmit hooks went ("go"), with what they added: not run again, should it go as a prompt of its own. */
    admitted?: { context?: string };
    /** Held because the account this session used for this CLI (its provider id) was removed: picking one sends it (#410). */
    account?: string;
}

const ALL_KINDS: readonly AttachmentKind[] = ["image", "text", "pdf"];
const KIND_NAMES: Record<AttachmentKind, string> = { image: "images", text: "text files", pdf: "PDFs" };

/**
 * Why a message can't join the running turn (it runs once the turn ends), or undefined when it can, read as
 * dispatch reads it: a command or `!command` gets a turn of its own, and so does one carrying an attachment of a
 * kind what runs the turn can't take mid-turn (`kinds`, CliCapabilities.steersAttachments): the whole message.
 */
function waitsFor(q: Queued, kinds: readonly AttachmentKind[], who: string): string | undefined {
    const cant = [...new Set((q.attachments ?? []).map((a) => (a.type === "image" ? "image" : a.kind)))].filter((k) => !kinds.includes(k));
    if (cant.length) return `${who} can't take ${cant.map((k) => KIND_NAMES[k]).join(" or ")} in a running turn: this runs once it ends.`;
    if (q.literal) return undefined;
    const t = q.text.trim();
    return t.startsWith("!") || (t.startsWith("/") && !t.startsWith("//")) ? "Commands can't join a running turn: they run after it." : undefined;
}

/** A slash command or `!command`, as dispatch reads it: the server runs it, so it isn't sent as a prompt. */
function isCommand(q: Queued): boolean {
    if (q.literal) return false;
    const t = q.text.trim();
    return (t.startsWith("!") && !q.attachments?.length) || (t.startsWith("/") && !t.startsWith("//"));
}

/** A call whose result is its sub-agent's report: a Task's, or a Skill's that ran (a failed one's says why it didn't). */
function reportsAgent(name: string, isError: boolean | undefined): boolean {
    return name === "Task" || (name === "Skill" && !isError);
}

/** The slash commands the server runs itself (the GUI runs the others). */
const SERVER_COMMANDS = new Set(["compact", "init", "review", "loop", "schedules", "goal", "trust"]);

/** A session title as it's stored: one line, 120 characters at most ("" if there's nothing left). */
export function cleanTitle(title: string): string {
    return title.replace(/\s+/g, " ").trim().slice(0, 120);
}

/** A first message that's only a greeting, a thanks, a yes or a test: nothing to name a session after. */
const SMALL_TALK = /^(h(i+|ello|ey+|iya|owdy)|yo|sup|hola|greetings|good (morning|afternoon|evening|day)|thanks?( you)?( so much| a lot)?|thx|ty|ok(ay)?|k|cool|nice|great|yes|no|yep|nope|sure|test(ing)?|ping|hm+|\?+)(\s+(there|all|everyone|again|claude|cavvy|buddy|friend|mate))?[\s!.?,:)(]*$/i;

/**
 * A prompt with the GUI's review comments (<review_comment> blocks, see gui/src/lib/review-comments.ts)
 * said in words: each comment's text, without its markup and the lines it quotes. For titles.
 */
export function reviewGist(prompt: string): string {
    return prompt.includes("<review_comment ") ? prompt.replace(/<review_comment [^>]*>\n([\s\S]*?)\n\n`{3,}diff\n[\s\S]*?<\/review_comment>/g, "$1") : prompt;
}

/** Whether a prompt says enough to name the session after (a later one is tried if not). */
export function titleWorthy(prompt: string): boolean {
    const t = prompt.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    return t.replace(/[^\p{L}\p{N}]/gu, "").length >= 3 && !SMALL_TALK.test(t);
}

/** Title requests per session, failures included: a model that can't give one isn't asked forever. */
const TITLE_TRIES = 3;

/**
 * A title made from the prompt itself, for when no model gives one: its
 * first line that says something, cut at a word to 60 characters.
 */
export function promptTitle(prompt: string): string | undefined {
    const line = prompt
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
        .split("\n")
        // A link reads as where it goes: no scheme or www (and no "Https" once capitalized below).
        .map((l) => l.replace(/^[\s#>*-]+/, "").replace(/\bhttps?:\/\/(www\.)?/gi, "").replace(/\s+/g, " ").trim())
        .find((l) => /[\p{L}\p{N}]/u.test(l));
    if (!line) return undefined;
    let t = line;
    if (t.length > 60) {
        const cut = t.slice(0, 60);
        const space = cut.lastIndexOf(" ");
        t = `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
    } else t = t.replace(/[\s./]+$/, "");
    // A plain first word starts it in capitals, as a model's title would; not a path or a name like `src/x`.
    return /^\p{Ll}[\p{L}']*(?=[\s,:;!?]|$)/u.test(t) ? t[0]!.toUpperCase() + t.slice(1) : t;
}

/** How long closing waits for a turn to stop on its own before noting the interrupt for it (changeable for tests). */
export const closeTiming = { turnMs: 3000 };

export function modelSummary(m: ModelInfo): ModelSummary {
    const p = getProvider(m.provider);
    return {
        ref: modelRef(m),
        provider: m.provider,
        providerName: p?.name,
        id: m.id,
        name: m.name ?? m.id,
        contextWindow: m.contextWindow,
        maxOutput: m.maxOutput,
        pricing: m.pricing,
        pricingEstimated: m.pricingEstimated,
        supportsImages: m.supportsImages,
        supportsPdf: readsPdf(m),
        supportsReasoning: m.supportsReasoning,
        effortLevels: m.effortLevels,
        supportsFastMode: m.supportsFastMode,
        deprecated: m.deprecated,
        ...(steersMidTurn(m.provider) ? {} : { steers: false as const }),
    };
}

export class Runtime {
    readonly session: Session;
    /** The session's /goal (src/agent/goal.ts). */
    readonly goal: GoalController;
    /** A turn ended with something queued; if what was queued starts no turn, the goal goes on from that end (settleGoal). */
    private goalOwed?: { reason: TurnEndReason; from: number; goal: boolean; startedAt: number };
    readonly toolState: ToolState;

    /** The session's tabs in the project's browser. */
    get browser(): BrowserSession {
        return this.toolState.browser!;
    }

    /** The session's simulator. */
    get simulator(): SimulatorSession {
        return this.toolState.simulator!;
    }
    readonly checker: PermissionChecker;
    readonly classifier: AutoClassifier;
    /** The reviewModel the reviewer's verdicts came from. */
    private reviewer: string | undefined;
    agent?: Agent;
    model?: ModelInfo;
    /** The model an agent CLI served for the model asked for ("claude-opus-5-5" for "opus"), from its usage. */
    private servedModel?: string;
    client?: ProviderClient;
    mode: PermissionMode;
    /** The mode it was in before it last entered plan mode (unknown when it started in plan mode). */
    modeBeforePlan?: PermissionMode;
    effort?: Effort;
    busy = false;
    lastActive = Date.now();
    /** Ready once a model has been chosen (or none could be). */
    ready: Promise<void>;

    private view: SessionView;
    private batch = 0;
    private outbox: SessionOp[] = [];
    private flushTimer?: ReturnType<typeof setTimeout>;
    private abort?: AbortController;
    private queued: Queued[] = [];
    private queueSeq = 0;
    /** Compacts a long conversation left idle before its prompt cache expires (src/agent/idle-compact.ts). */
    readonly idleCompact = new IdleCompactTimer({
        plan: (now) => this.agent?.idleCompactPlan(now) ?? null,
        // Not on a CLI account that was removed (#410): nothing runs there.
        ready: () => this.idle && !this.closed && !this.drafting.size && !this.queued.length && !this.needsAccount(),
        run: () => void this.compact(undefined, { idle: true }).catch((e) => this.engine.log(`session ${this.id}: idle compaction: ${(e as Error).message}`)),
    });
    /** The compaction running is an idle one: a message sent meanwhile cancels it and runs. */
    private idleCompacting = false;
    /** Settles when the idle compaction running has ended. */
    private idleDone?: Promise<void>;
    /** Windows with a message being written here: the user is back, so it doesn't compact while idle. */
    private drafting = new Set<object>();

    /** A window has an unsent message in this session's input box, or no longer has one. */
    setDrafting(window: object, present: boolean) {
        if (present) return void this.drafting.add(window);
        if (!this.drafting.delete(window) || this.drafting.size) return;
        // Cleared (or the window went away) without sending: compact as planned, if it's still in time.
        if (this.idle && !this.closed) this.idleCompact.arm();
    }

    /** The user is back (a rewind, a switch, a commit): an idle compaction stops, and what they asked for goes ahead. */
    /** An idle compaction is running: what the user does next takes over from it. */
    get compactingWhileIdle(): boolean {
        return this.idleCompacting;
    }
    async yieldIdleCompaction() {
        if (!this.idleCompacting) return;
        this.abort?.abort();
        await this.idleDone;
    }
    private pending = new Map<string, Pending>();
    /** Plan requests answered by taking the plan to another session. */
    private handoffs = new Set<string>();
    private ui: UiLog;
    /** Compactions so far: the transcript segment new prompts belong to. */
    private segment = 0;
    private ids = 0;
    /** A title request is running or got one; cleared when it failed, so a later prompt tries again. */
    private titleAsked = false;
    private titleTries = 0;
    /** The first prompt a title was asked about: the one to name the session after when no model will. */
    private titleFrom?: string;
    private shellTimer?: ReturnType<typeof setInterval>;
    private switching?: Promise<unknown>;
    /** Reserve this session while committing or publishing. */
    private committing = false;
    private commitDone?: Promise<unknown>;
    private commitAbort?: AbortController;
    /** The title being asked for: closing the session stops it (on a CLI, its process). */
    private titleAbort?: AbortController;
    /** Being closed: it starts nothing more and sends nothing more (the session may be open again by then). */
    private closed = false;
    /** /loop, cron jobs and the resume after a usage limit (src/agent/schedule.ts). */
    readonly schedules: SessionSchedules;
    /** The next turn is a schedule's ("every 10m"), not the user's. */
    private scheduledLabel?: string;
    /** The scheduled prompt starting is the resume after a usage limit (it picks a paused goal up again). */
    private scheduledResume = false;
    /** The rewind last shown: restoring does what it showed, or nothing if the conversation moved on. */
    private rewindShown?: { id: string; index: number; message: Message; count: number; plan?: RestoreItem[] };

    // What the current turn is building
    private turnId?: string;
    /** Where the running turn's messages start (its prompt, and what was sent meanwhile, from here on). */
    private runStart?: number;
    /** The running turn's prompt attachments, shown before its message is in the session (the system prompt may still be built). */
    private pendingPrompt?: { seg: number; index: number; attachments?: AttachedPart[] };
    private turnStartedAt = 0;
    /** Settles when the running turn has ended (and written how). */
    private turnDone?: Promise<void>;
    private openText?: string;
    private continuationText?: { id: string; prefix: string };
    private openThinking?: string;
    /** Blocks from the model response being streamed (dropped if it's retried). */
    private responseBlocks: string[] = [];
    /** The turn each of those is in: a message steered in while the response streamed starts a turn of its own (drainedTurn). */
    private responseTurn = new Map<string, string>();
    /**
     * The turn each steer of the run started, by the agent's id for it (drainQueued): one the CLI never took comes back
     * (unsteered) before the run is over (a backend decides first). Let go with the run.
     */
    private steeredTurns = new Map<number, string>();
    /** Tool call id -> the turn its block is in. */
    private toolTurn = new Map<string, string>();
    /** Background shell id -> the description of the call that started it, whole (a block's input is cut). */
    private shellDescriptions = new Map<string, string>();
    /** Each sub-agent's label (how its permission prompts name it) and its open text block while it writes. */
    private agentLabels = new Map<string, string>();
    private agentText = new Map<string, string>();
    /** Turns Claude Code or Codex answered, and the transcript segment each is in: the log keeps their steps and sub-agents (the transcript only their text). */
    private backendTurns = new Map<string, number>();
    /** Where in the log each such turn's steps go: its prompt's place, and which prompt it is. */
    private stepsAt = new Map<string, { seg: number; index: number; prompt: string }>();
    /** Their steps changed since they were written (turn id → block ids), and what was written of each (its JSON). */
    private stepsDirty = new Map<string, Set<string>>();
    private stepsLogged = new Map<string, Map<string, string>>();
    /** Their sub-agents, likewise ("" for the sub-agent itself), and what was written of each field and step. */
    private agentsDirty = new Map<string, Set<string>>();
    private agentsLogged = new Map<string, { head: Map<string, string>; blocks: Map<string, string> }>();
    /** The log's record of the turn running now (where it started): its end goes there, a steering message's turn's too. */
    private uiTurn?: { seg: number; index: number; at: number; prompt?: string };
    /** The mode it was left in, when that isn't the one it reopened in (bypass, not chosen again): the model is told. */
    private leftIn?: PermissionMode;

    constructor(
        private engine: Engine,
        readonly ws: Workspace,
        session: Session,
        opts: { mode?: PermissionMode; resumed: boolean },
    ) {
        this.session = session;
        // Opened from disk: last active when it last worked, not now. Opening it isn't work: it keeps its place in the sidebar.
        if (opts.resumed) this.lastActive = session.workedAt ?? session.writtenAt ?? this.lastActive;
        // Capture new-session defaults so changing Home settings cannot change an open chat’s speed.
        // A chat from before speeds were saved keeps it in memory: opening one doesn't write to it.
        if (session.fastMode === undefined) {
            if (opts.resumed) session.fastMode = Boolean(ws.settings.fastMode);
            else session.setFastMode(Boolean(ws.settings.fastMode));
        }
        this.ui = new UiLog(session.path, session.meta.id, opts.resumed);
        // A reopened session keeps the mode it was left in (bypass only when chosen again) and the effort chosen for it.
        const left = opts.resumed && this.ui.state.mode && PERMISSION_MODES.includes(this.ui.state.mode) ? this.ui.state.mode : undefined;
        this.mode = (left !== "bypassPermissions" ? left : undefined) ?? opts.mode ?? ws.settings.permissions?.defaultMode ?? "default";
        if (this.mode === "bypassPermissions" && !this.bypassAllowed()) this.mode = "default";
        if (left && left !== this.mode) this.leftIn = left;
        const effort = opts.resumed ? this.ui.state.effort : undefined;
        if (effort && EFFORT_LEVELS.includes(effort)) this.effort = effort;
        // Secrets live as long as the session is loaded: unloading it (closed, or idle with no window on it) drops them.
        this.toolState = { cwd: ws.cwd, projectRoot: ws.cwd, fileState: new Map(), todos: [], shells: new Map(), secrets: new SecretStore(), wakes: new WakeQueue(), watchers: new WatcherMap(), background: new SessionBackground(session) };
        // The worktree the agent moved to, if it's still one.
        this.workingIn = session.workdir ? this.worktreeAt(session.workdir) : undefined;
        this.placeAgent(parseModelRef(session.model ?? "")?.provider);
        this.toolState.background!.onChange(() => this.syncBackground());
        // The browser exists from the start, so the window hears of the first page the agent opens (it makes no process until then).
        this.toolState.browser = new BrowserSession({ root: ws.cwd, settings: () => this.settings(), refuse: (url, approved) => this.checker.urlRefusal(url, approved) });
        this.toolState.browser.onChange(() => this.engine.sendBrowser(this.id, this.browser.state()));
        // So does the simulator, so the window hears when the agent starts or uses one (it starts nothing until then).
        this.toolState.simulator = new SimulatorSession({ settings: () => this.settings() });
        this.toolState.simulator.onChange(() => this.engine.sendSimulator(this.id, this.simulator.state()));
        this.toolState.secrets!.onChange(() => this.setState({ secrets: this.toolState.secrets!.names() }));
        this.schedules = new SessionSchedules({
            session: () => this.session,
            settings: () => this.settings(),
            idle: () => this.schedulable(),
            identity: () => this.limitIdentity(),
            run: (prompt, job, label) => this.runScheduled(prompt, job, label),
            notice: (text, level) => this.notice(text, level),
            resumeShown: true,
            changed: () => {
                if (this.view) this.setState({ schedules: this.schedules.scheduler.info() });
                this.engine.sessionChanged(this);
            },
        });
        this.toolState.scheduler = this.schedules.scheduler;
        (this.toolState.watchers as WatcherMap).onChange = () => {
            if (!this.closed) this.setState({ watches: (this.toolState.watchers as WatcherMap).info() });
        };
        this.toolState.wakes!.onReady(() => this.wake());
        this.checker = new PermissionChecker(() => this.settings(), ws.cwd);
        this.classifier = new AutoClassifier(undefined);
        this.reviewer = ws.settings.reviewModel;
        if (opts.resumed) resetToolState(this.toolState, session.messages);

        const segments = opts.resumed ? readSegments(session.path) : [{ messages: [] }];
        this.segment = segments.length - 1;
        // Its last turn was cut off (the server stopped or died before it could end): the history says so now, as a stop would have.
        if (opts.resumed && cutOffPrompt(this.ui, this.segment, session.messages, session.notices) !== undefined) session.push({ role: "user", content: [{ type: "text", text: INTERRUPTED }], meta: { kind: "interrupt" } });
        const turns = opts.resumed ? replay({ segments, current: session.messages, currentNotices: session.notices, ui: this.ui, meta: (c) => this.toolMeta(c), newId: () => this.newId() }) : [];
        this.view = { state: this.initialState(), turns, agents: agentsFromTurns(turns, session.model, this.ui.agents) };
        // Messages that were waiting when the server stopped: back in the queue, held until the user sends them (those
        // held for an account, until one is picked: #410).
        if (opts.resumed) {
            this.queued = loadQueue(session.path, session.meta.id).map((q) => ({ ...q, id: ++this.queueSeq, held: true }));
            if (this.queued.length) Object.assign(this.view.state, this.queueState());
        }
        this.goal = new GoalController({
            session,
            tokens: () => sessionTokens(session),
            canJudge: () => this.helperAnswers(),
            judge: (system, prompt, signal) => this.complete(system, prompt, signal),
            backgroundRunning: () => backgroundWork(this.agent?.delegatedTasks, this.toolState.shells),
            idle: () => !this.busy && !this.nextQueued() && !this.switching && !this.committing && !this.closed,
            notice: (text, level) => {
                this.session.recordNotice(level, text);
                this.notice(text, level);
            },
            changed: () => this.goalChanged(),
            alert: (kind, text) => this.engine.notify(this, kind, text.replace(/^[◎✓✗] /, "").split("\n")[0]!),
            startTurn: (prompt, display) => void this.startTurn(prompt, { display, kind: "command", goal: true }).catch((e) => this.notice(redact((e as Error).message), "error")),
        });
        // A reopened session's goal waits, paused, for the user's next message (or /goal resume).
        if (opts.resumed) this.goal.restore(session.goal);
        this.view.state.goal = this.goal.view();
        this.goalLive = true;
        this.ready = this.track(this.initModel());
        // Saved schedules come back once there's a model to run them with.
        void this.ready.then(() => !this.closed && this.schedules.restore(), () => undefined);
        const warn = (msg: string, level: "info" | "warn" = "warn") => this.notice(msg, level);
        const services = sessionHookServices({ session: () => this.session, warn, complete: (s, p, sig) => this.complete(s, p, sig), mcpTools: () => this.ws.mcp.tools() });
        // The plugins' own wait for the model: on Claude Code, it runs them itself.
        const source = opts.resumed ? "resume" : "startup";
        void sessionStartHooks(withoutPluginHooks(this.settings()), session, source, this.toolState.cwd, warn, services);
        void this.ready.then(() => {
            if (this.closed || loadsPluginsNatively(this.agent?.model.provider)) return;
            const plugins = onlyPluginHooks(this.settings());
            if (!plugins.hooks?.SessionStart?.length && !plugins.hooks?.InstructionsLoaded?.length) return;
            // The first prompt waits for these too.
            const before = session.hooksStarting;
            void sessionStartHooks(plugins, session, source, this.toolState.cwd, warn, services);
            if (before) session.hooksStarting = Promise.all([before, session.hooksStarting]).then(() => {});
        }, () => undefined);
    }

    get id(): string {
        return this.session.meta.id;
    }

    get status(): SessionState["status"] {
        return this.view.state.status;
    }

    get waitingKind(): Interaction["kind"] | undefined {
        return this.status === "waiting" ? this.view.state.interactions[0]?.kind : undefined;
    }

    get sidebarTurnStartedAt(): number | undefined {
        // Between a goal's turns it's working too: since the check (or wait) began.
        if (!this.busy) return this.goalShowsRunning ? this.view.state.activity?.since : undefined;
        // Queued prompts can start a new visible turn within one agent.run().
        const turn = this.turnId ? findTurn(this.view, this.turnId) : undefined;
        return turn?.startedAt ?? this.view.state.activity?.since;
    }

    /** The last task's result, including an interrupted run after reopening. */
    get lastTurnStatus(): TurnStatus | undefined {
        return this.view.turns.at(-1)?.status;
    }

    get title(): string | undefined {
        return this.view.state.title;
    }

    /** The first prompt, for sessions without a title. */
    firstPrompt(): string | undefined {
        const text = this.view.turns.find((t) => t.prompt)?.prompt?.text;
        return text === undefined ? undefined : reviewGist(text);
    }

    private newId(): string {
        return `b${(++this.ids).toString(36)}`;
    }

    settings(): Settings {
        const s = this.ws.settings;
        return this.effort ? { ...s, effort: this.effort } : s;
    }

    bypassAllowed(): boolean {
        return this.engine.bypassAllowed(this.ws.cwd);
    }

    /** The model has heard from this session: a switch now is news to it. Before, it's where the session starts. */
    private get conversationStarted(): boolean {
        return this.session.messages.length > 0 || Boolean(this.agent?.busy) || (this.agent?.delegatedTasks ?? []).some((t) => t.status === "running");
    }

    private initialState(): SessionState {
        const branch = gitBranch(this.ws.cwd);
        return {
            id: this.id,
            cwd: this.ws.cwd,
            projectName: basename(this.ws.cwd) || this.ws.cwd,
            title: this.session.title,
            createdAt: this.session.meta.createdAt,
            persisted: existsSync(this.session.path),
            trusted: this.ws.trusted,
            branch,
            ...(this.workingIn ? { workingIn: this.workingIn } : {}),
            mode: this.mode,
            accounts: { "claude-code": this.session.accountId("claude-code"), codex: this.session.accountId("codex") },
            bypassAllowed: this.bypassAllowed(),
            effort: this.settings().effort,
            fastMode: this.fastModeEnabled(),
            status: "idle",
            busy: false,
            contextTokens: this.lastContext(),
            cost: this.session.cost,
            costUnknown: this.session.costUnknown,
            ...this.tokenTotals(),
            todos: this.toolState.todos.map((t) => ({ ...t })),
            queued: [],
            queueIds: [],
            queuedAttached: [],
            interactions: [],
            mcp: this.ws.mcpStatus(),
            filesChanged: this.filesChanged(),
            shells: [],
            watches: [],
            backgroundTasks: this.toolState.background?.shown() ?? [],
            plan: this.planRef(this.latestPlan()),
            planLinks: [...this.session.planLinks],
            ...(this.session.meta.forkOf ? { forkOf: { id: this.session.meta.forkOf.id, title: this.session.meta.forkOf.title } } : {}),
            secrets: this.toolState.secrets?.names() ?? [],
            schedules: [],
        };
    }

    /** A scheduled prompt may start now: nothing running (an idle compaction gives way), waiting on the user, or being set up. */
    private schedulable(): boolean {
        // A goal between its turns (checking, retrying, waiting on background work) goes first: scheduled prompts wait for it.
        // Nor while the session's CLI account is gone (#410): they run once the user picks another.
        return !this.closed && (!this.busy || this.idleCompacting) && !this.pending.size && !this.switching && !this.committing && !this.queued.length && !this.goal.pending() && Boolean(this.agent) && !this.needsAccount();
    }

    private runScheduled(prompt: string, job: ScheduledJob, label: string): Promise<unknown> {
        const start = () => {
            this.scheduledLabel = label;
            this.scheduledResume = job.kind === "resume";
            // Codex stopped its goal at the limit: the resume makes it active again, for Codex to go on with.
            return this.dispatch(job.kind === "resume" && limitedCodexGoal(this.nativeGoal) ? "/goal resume" : prompt);
        };
        // An idle compaction stops: the prompt runs on the cache that's still warm, not alongside it.
        return (this.idleCompacting ? this.yieldIdleCompaction().then(start) : start())
            .catch((e) => this.notice(redact((e as Error).message), "error"))
            .finally(() => {
                this.scheduledLabel = undefined;
                this.scheduledResume = false;
            });
    }

    /** session.schedule: one of the composer's schedule buttons. */
    scheduleAction(scheduleId: string, action: ScheduleAction): boolean {
        return Boolean(this.schedules.act(scheduleId, action));
    }

    /**
     * Picks up again by itself once the limit that stopped the last turn resets, as that turn's end would have had it
     * (the user called it off, or has it turned off). By the limit the session kept with its card, so it holds after a
     * restart; refused once a message has come since, on another account, or with no reset time.
     */
    resumeAfterLimit() {
        const n = this.session.notices.findLast((x) => x.level === "error" && x.limit);
        const l = n?.limit;
        if (!n || !l || this.session.messages.slice(n.index).some((m) => m.role === "user")) throw new RpcError("No turn is waiting on a usage limit", "invalid");
        if (this.model?.provider !== l.provider || this.session.accountId(l.provider) !== l.accountId) throw new RpcError("The session is on another account or model now", "invalid");
        if (l.resetsAt === undefined) throw new RpcError("When the limit resets isn't known: send a message once it has", "invalid");
        const why = this.schedules.resumeAfter(l.resetsAt);
        if (why) throw new RpcError(why, "invalid");
    }

    /** What a message steering the running turn can carry: anything for API models, what an agent CLI takes mid-turn. */
    private steerKinds(): readonly AttachmentKind[] {
        const provider = this.agent?.model.provider ?? this.model?.provider ?? "";
        return getProvider(provider)?.kind === "agent" ? (agentCli(provider)?.caps.steersAttachments ?? []) : ALL_KINDS;
    }

    /** Why this queued message can't join the running turn, or undefined when it can (see waitsFor). */
    private waits(q: Queued): string | undefined {
        const provider = this.agent?.model.provider ?? this.model?.provider ?? "";
        const who = getProvider(provider)?.name ?? this.model?.name ?? "This model";
        // An agent CLI that takes nothing mid-turn: every message waits for the turn's end.
        if (!steersMidTurn(provider)) return `${who} can't take messages in a running turn: this runs once it ends.`;
        return waitsFor(q, this.steerKinds(), who);
    }

    /** Claude Code or Codex: an agent backend runs this session's turns. */
    private backendModel(): boolean {
        return getProvider(this.model?.provider ?? "")?.kind === "agent";
    }

    /** How full the context was when the session was left, if nothing has happened to it since (in a terminal, say). */
    private lastContext(): number {
        const s = this.ui.state;
        return s.contextTokens !== undefined && s.messages === this.session.messages.length ? s.contextTokens : 0;
    }

    /** The log's note of the mode, effort and context, for opening the session again. Not before the session is on disk: a new one may never be. */
    private recordState(opts: { force?: boolean } = {}) {
        if (!opts.force && !existsSync(this.session.path)) return;
        const s = this.ui.state;
        const state = { mode: this.mode, effort: this.effort, contextTokens: this.view.state.contextTokens, messages: this.session.messages.length };
        if (s.mode === state.mode && s.effort === state.effort && s.contextTokens === state.contextTokens && s.messages === state.messages) return;
        this.ui.write({ t: "state", ...state });
    }

    // What the log keeps of turns Claude Code or Codex answered, as they're
    // shown: each step and each sub-agent's, written when it's new or has
    // changed (at most once a flush), so a turn cut off part way keeps what
    // it did. What's still being written (text streaming in, a call's input)
    // waits until it's done, or the turn or session ends.

    /** Which prompt the running turn's record is of, once it's in the history: one sent at its place later isn't taken for it. */
    private notePrompt() {
        const t = this.uiTurn;
        const m = t && !t.prompt ? this.session.messages[t.index] : undefined;
        if (!t || m?.role !== "user") return;
        t.prompt = promptKey(m);
        this.ui.write({ t: "turn", ...t });
    }

    /** A view change to note for the log, if it's of such a turn or sub-agent. */
    private noteStep(o: SessionOp) {
        const mark = (dirty: Map<string, Set<string>>, key: string, id: string) => {
            let ids = dirty.get(key);
            if (!ids) dirty.set(key, (ids = new Set()));
            ids.add(id);
        };
        const ofBackend = (agentId: string) => {
            const a = this.view.agents.find((x) => x.id === agentId);
            return Boolean(a && this.backendTurns.has(a.turnId));
        };
        switch (o.op) {
            // (A block inside another, a sub-agent's call in its row, changes that one.)
            case "block":
                if (this.backendTurns.has(o.turnId)) mark(this.stepsDirty, o.turnId, o.parent ?? o.block.id);
                break;
            case "block.patch":
                if (this.backendTurns.has(o.turnId)) mark(this.stepsDirty, o.turnId, o.parent ?? o.blockId);
                break;
            case "block.remove":
            case "append":
                if (this.backendTurns.has(o.turnId)) mark(this.stepsDirty, o.turnId, o.blockId);
                break;
            case "agent":
                if (!this.backendTurns.has(o.agent.turnId)) break;
                mark(this.agentsDirty, o.agent.id, "");
                for (const b of o.agent.blocks) mark(this.agentsDirty, o.agent.id, b.id);
                break;
            case "agent.patch":
                if (ofBackend(o.id)) mark(this.agentsDirty, o.id, "");
                break;
            case "agent.block":
                if (ofBackend(o.id)) mark(this.agentsDirty, o.id, o.block.id);
                break;
            case "agent.block.patch":
            case "agent.append":
                if (ofBackend(o.id)) mark(this.agentsDirty, o.id, o.blockId);
                break;
        }
    }

    /** What changed since into the log; `all`: what's still being written too (the turn or the session is ending). */
    private syncSteps(all = false) {
        for (const turnId of [...this.stepsDirty.keys()]) this.syncTurn(turnId, all);
        for (const id of [...this.agentsDirty.keys()]) this.syncAgent(id, all);
    }

    /** Where a backend's turn's steps go in the log; none until its prompt is in the history. */
    private stepsPlace(turnId: string, turn: Turn): { seg: number; index: number; prompt: string } | undefined {
        const known = this.stepsAt.get(turnId);
        if (known) return known;
        const seg = this.backendTurns.get(turnId);
        // Where its prompt went, a wake's too (it has no index: it isn't one to rewind to).
        const index = turn.pos?.index;
        // Its prompt, unless the history was compacted since (it's out of reach of rewind then).
        const prompt = seg === this.segment && index !== undefined ? this.session.messages[index] : undefined;
        if (seg === undefined || index === undefined || prompt?.role !== "user" || !isPrompt(prompt)) return undefined;
        const at = { seg, index, prompt: promptKey(prompt) };
        this.stepsAt.set(turnId, at);
        return at;
    }

    private syncTurn(turnId: string, all = false) {
        const ids = this.stepsDirty.get(turnId);
        if (!ids) return;
        const turn = findTurn(this.view, turnId);
        // Gone (rebuilt after a rewind): nothing of it to write.
        if (!turn) return void this.stepsDirty.delete(turnId);
        const at = this.stepsPlace(turnId, turn);
        if (!at) {
            if (all) this.stepsDirty.delete(turnId);
            return;
        }
        let logged = this.stepsLogged.get(turnId);
        if (!logged) this.stepsLogged.set(turnId, (logged = new Map()));
        for (const id of [...ids]) {
            const i = turn.blocks.findIndex((b) => b.id === id);
            const b = turn.blocks[i];
            if (b && !all && (b.id === this.openText || b.id === this.openThinking || (b.t === "tool" && b.status === "streaming"))) continue;
            ids.delete(id);
            if (!b) {
                if (logged.delete(id)) this.ui.write({ t: "step", ...at, drop: id });
                continue;
            }
            const step = shownStep(b);
            const json = step && JSON.stringify(step);
            if (!step || logged.get(id) === json) continue;
            logged.set(id, json!);
            let after: string | null = null;
            for (let j = i - 1; j >= 0; j--) {
                if (shownStep(turn.blocks[j]!)) {
                    after = turn.blocks[j]!.id;
                    break;
                }
            }
            this.ui.write({ t: "step", ...at, block: step, after });
        }
        if (!ids.size) this.stepsDirty.delete(turnId);
    }

    private syncAgent(id: string, all = false) {
        const ids = this.agentsDirty.get(id);
        if (!ids) return;
        const a = this.view.agents.find((x) => x.id === id);
        if (!a) {
            this.agentsDirty.delete(id);
            this.agentsLogged.delete(id);
            return;
        }
        let logged = this.agentsLogged.get(id);
        if (!logged) this.agentsLogged.set(id, (logged = { head: new Map(), blocks: new Map() }));
        if (ids.delete("")) {
            const head = agentHead(a);
            const patch: AgentHead = {};
            for (const [k, v] of Object.entries(head)) {
                const json = JSON.stringify(v);
                if (json !== undefined && logged.head.get(k) !== json) {
                    logged.head.set(k, json);
                    (patch as Record<string, unknown>)[k] = v;
                }
            }
            // What it no longer has (a report, once it runs again).
            for (const k of [...logged.head.keys()]) {
                if ((head as Record<string, unknown>)[k] !== undefined) continue;
                logged.head.delete(k);
                (patch as Record<string, unknown>)[k] = null;
            }
            if (Object.keys(patch).length) this.ui.write({ t: "agent", id, head: patch });
        }
        // The log keeps its latest AGENT_KEPT steps: an older one changing (a long call ending) isn't written.
        const kept = a.blocks.length - AGENT_KEPT;
        for (const bid of [...ids]) {
            const i = a.blocks.findIndex((b) => b.id === bid);
            const b = a.blocks[i];
            if (b && !all && (this.agentText.get(id) === bid || (b.t === "tool" && b.status === "streaming"))) continue;
            ids.delete(bid);
            if (!b || i < kept) continue;
            const step = agentStep(b);
            const json = JSON.stringify(step);
            if (logged.blocks.get(bid) === json) continue;
            logged.blocks.set(bid, json);
            this.ui.write({ t: "agent", id, block: step, after: a.blocks[i - 1]?.id ?? null });
        }
        // What was written of steps the log no longer keeps needn't be remembered.
        if (logged.blocks.size > AGENT_KEPT) {
            const tail = new Set(a.blocks.slice(-AGENT_KEPT).map((b) => b.id));
            for (const bid of [...logged.blocks.keys()]) if (!tail.has(bid)) logged.blocks.delete(bid);
        }
        if (!ids.size) this.agentsDirty.delete(id);
    }

    /** A backend's turn is over (or is being cut off): all of it into the log, its sub-agents too, as they are now. */
    private syncTurnAll(turnId: string) {
        this.syncTurn(turnId, true);
        for (const a of this.view.agents) if (a.turnId === turnId) this.syncAgent(a.id, true);
    }

    private tokenTotals() {
        let tokensIn = 0;
        let tokensOut = 0;
        for (const { usage } of this.session.usageByModel.values()) {
            tokensIn += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
            tokensOut += usage.outputTokens;
        }
        return { tokensIn, tokensOut };
    }

    private filesChanged(): number {
        try {
            return new Set([...(FileHistory.for(this.session)?.originals().map((f) => f.path) ?? []), ...(TurnSnapshots.for(this.session, this.ws.cwd)?.changedPaths() ?? [])]).size;
        } catch {
            return 0;
        }
    }

    // -----------------------------------------------------------------------
    // Sending ops

    snapshot(): SessionSnapshot {
        this.flush();
        return { state: structuredClone(this.view.state), turns: structuredClone(this.view.turns), agents: structuredClone(this.view.agents), seq: this.batch };
    }

    private op(o: SessionOp) {
        applyOp(this.view, structuredClone(o));
        this.noteStep(o);
        this.outbox.push(o);
        if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
    }

    /** Where this session compacts on its own, in tokens of context (SessionState.compactAt). */
    private compactAt(): number | undefined {
        const m = this.model;
        if (!m) return undefined;
        const window = m.contextWindow;
        // An agent that can't compact (an ACP agent's): never, here.
        if (agentCli(m.provider)?.caps.compact === "none") return undefined;
        if (m.provider === "claude-code" || m.provider === "codex") {
            const setting = cliCompactSetting(m.provider, this.session.accountId(m.provider), this.cliProject(), modelKeys(m, this.servedModel));
            if (m.provider === "claude-code") return claudeCompactAt(window, setting, m.maxOutput);
            return setting && window ? Math.min(setting, window) : setting;
        }
        const s = this.settings();
        if (s.autoCompact === false || !window) return undefined;
        return Math.floor(cavvyCompactAt(window, m.maxOutput, s.autoCompactThreshold));
    }

    /** Where an agent CLI's turn runs and whether it reads that project's settings, as its turns do (Agent.backendTurn). */
    private cliProject(): { cwd: string; trusted: boolean } {
        const cwd = this.agent?.cliCwd ?? this.ws.cwd;
        const now = Date.now();
        // Trust is read from disk: again at most every few seconds, or as soon as the folder changes.
        const hit = this.cliProjectSeen;
        if (hit && hit.cwd === cwd && now - hit.at < 5_000) return hit;
        let trusted = false;
        try {
            trusted = this.agent?.cliProjectTrusted() ?? false;
        } catch {
            trusted = false;
        }
        this.cliProjectSeen = { cwd, trusted, at: now };
        return this.cliProjectSeen;
    }
    private cliProjectSeen?: { cwd: string; trusted: boolean; at: number };

    private setState(patch: Partial<SessionState>) {
        // Where it compacts follows the model, its account, the model served, the folder and the settings, any of
        // which a patch may follow (a settings reload patches MCP state): checked with each, from cached reads.
        if (this.view && !("compactAt" in patch)) {
            const at = this.compactAt();
            if (at !== this.view?.state.compactAt) patch = { ...patch, compactAt: at };
        }
        this.op({ op: "state", patch });
    }

    flush() {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
        // Into the log as it's shown (while it's being closed too, until the log is let go of).
        this.syncSteps();
        if (!this.outbox.length || this.closed) return;
        const ops = coalesce(this.outbox);
        this.outbox = [];
        this.batch++;
        this.engine.sendOps(this.id, this.batch, ops);
    }

    private setStatus(status: SessionState["status"]) {
        if (this.view.state.status === status) return;
        this.setState({ status });
        this.engine.sessionChanged(this);
    }

    private activity(label: string, detail?: string) {
        const cur = this.view.state.activity;
        if (cur?.label === label && cur.detail === detail) return;
        // A retry during an idle compaction is still one: the GUI keeps what takes over from it enabled.
        this.setState({ activity: { label, since: cur?.label === label ? cur.since : Date.now(), detail, ...(this.idleCompacting ? { idle: true } : {}) } });
    }

    // -----------------------------------------------------------------------
    // Model

    /** The model being set up (as it opens, or switched), if it is. */
    get modelSetup(): Promise<unknown> | undefined {
        return this.switching;
    }

    private track<T>(p: Promise<T>): Promise<T> {
        const t = p.finally(() => {
            if (this.switching === t) this.switching = undefined;
        });
        this.switching = t;
        return t;
    }

    private async initModel() {
        const candidates = [this.session.model, this.ws.settings.model ?? this.engine.fallbackModel].filter((r): r is string => Boolean(r && parseModelRef(r)));
        for (const ref of new Set(candidates)) {
            if (await this.setModel(ref, { quiet: true })) {
                if (this.session.model && ref !== this.session.model) this.notice(`This session used ${this.session.model}, which isn't available now; using ${ref}.`, "warn");
                return;
            }
        }
        let listings = this.engine.listings;
        let pick = defaultModelFrom(listings);
        if (!pick) {
            listings = await this.engine.refreshListings();
            pick = defaultModelFrom(listings);
        }
        if (pick && (await this.setModel(modelRef(pick), { quiet: true }))) return;
        this.setState({ model: undefined });
    }

    /** The user picked a model: a prompt sent while it's being set up waits, and starts with it. */
    switchModel(ref: string, opts: { persist?: boolean } = {}): Promise<boolean> {
        // After the one under way (the session's own, as it opens), so this one has the last word.
        const before = this.switching;
        return this.track((async () => {
            if (before) await before.catch(() => undefined);
            return this.setModel(ref, opts);
        })());
    }

    /** The model and, for a CLI, its account: what a resume waiting for a usage limit belongs to. */
    private limitIdentity(): string {
        return this.model ? `${modelRef(this.model)}|${this.session.accountId(this.model.provider)}` : "";
    }

    async setAccount(provider: string, id: string) {
        if (this.busy) throw new RpcError("Switch accounts once this response is done, or interrupt it first.", "busy");
        const selected = account(provider, id);
        const had = this.session.backends.get(provider)?.id;
        // Already this one (added again under the same id, #410): what waited for an account goes now.
        if (!this.session.setAccount(provider, selected.id)) return this.releaseForAccount(provider);
        this.schedules.cancelLimitResume("account");
        // The new account hasn't read the history: an idle compaction planned on the earlier one's cache would read it all afresh.
        if (this.agent?.accountChanged(provider)) this.idleCompact.disarm();
        // Another account may serve the alias as another model: known again from its first usage.
        this.servedModel = undefined;
        this.setState({ accounts: { "claude-code": this.session.accountId("claude-code"), codex: this.session.accountId("codex") } });
        const name = getProvider(provider)?.name ?? provider;
        const how = switchHow(had, this.session.backends.get(provider)?.id, this.session.messages.length > 0);
        // One line between turns; where the CLI's model list comes from is the model picker's to say (#426).
        const switched = accountSwitch(provider, selected, name, how, had !== undefined && how !== "native");
        let line: TurnNotice | undefined;
        if (switched) {
            const r = this.session.recordSwitch(switched);
            this.switchNotice(r.notice, r.merged);
            line = r.notice;
        }
        // The CLI's process for this session is signed in as the earlier account: it goes now, with its background
        // work, so no turn it starts by itself (a report) can be taken over under the new account. Turns it started
        // that are waiting to be taken over, or that it starts while it's let go of, aren't (dropAdopt, #408).
        // Counted: a second switch meanwhile can finish first (nothing left to let go of), and this one's still going.
        let stopped: StoppedTask[] = [];
        this.releasing.set(provider, (this.releasing.get(provider) ?? 0) + 1);
        try {
            for (const w of this.adopts.filter((w) => w.provider === provider)) this.dropAdopt(w);
            stopped = (await this.agent?.releaseAccountProcess(provider)) ?? [];
        } finally {
            const left = (this.releasing.get(provider) ?? 1) - 1;
            if (left) this.releasing.set(provider, left);
            else this.releasing.delete(provider);
        }
        // Said under this switch's line while it's the latest; else (a prompt came meanwhile, or another switch's
        // line is said since) a line of their own, which says no switch: never this one's again (Session.recordStopped).
        if (stopped.length) {
            const r = this.session.recordStopped(line, { provider, cli: name, tasks: stopped });
            this.switchNotice(r.notice, r.merged);
        }
        this.releaseForAccount(provider);
    }

    // -----------------------------------------------------------------------
    // A removed CLI account (#410): nothing runs on an account the user didn't choose.

    /** The session's model is a CLI, and the account this session selected for it was removed: the CLI and the account's id. */
    private removedAccount(): { provider: string; id: string } | undefined {
        const provider = this.model?.provider;
        const id = provider ? removedAccount(provider, this.session.accountId(provider)) : undefined;
        return provider && id ? { provider, id } : undefined;
    }

    /**
     * Nothing may run until the user picks an account for the session's CLI: its account was removed, or messages are
     * held for one (even if it's back, added again under its id: picking it sends them first).
     */
    private needsAccount(): { provider: string; id: string } | undefined {
        const gone = this.removedAccount();
        if (gone) return gone;
        const provider = this.model?.provider;
        return provider && this.queued.some((q) => q.account === provider) ? { provider, id: this.session.accountId(provider) } : undefined;
    }

    /** What the server runs itself, with no model (a `!command`, /loop, /schedules, /trust): it needs no account. */
    private runsHere(q: { text: string; literal?: boolean; attachments?: AttachedPart[] }): boolean {
        if (q.literal) return false;
        const t = q.text.trim();
        return (t.startsWith("!") && !q.attachments?.length) || /^\/(loop|schedules|trust)(?=\s|$)/i.test(t);
    }

    /**
     * The session's CLI account was removed: `q` (a message about to go) and what waits behind it are held, not
     * stored or sent, until the user picks an account for the CLI (releaseForAccount sends them then). The GUI's
     * model picker opens on its accounts (accountNeeded). `say`: the notice that asks for one.
     */
    private holdForAccount(gone: { provider: string; id: string }, q?: Omit<Queued, "id" | "mode">, say = true) {
        if (q) this.queued.push({ ...q, id: ++this.queueSeq, mode: "queue" });
        // Held since a restart, they wait for the user as they did; the rest wait for the account.
        for (const x of this.queued) if (!x.held || x.account) Object.assign(x, { held: true, account: gone.provider });
        this.queueUpdated();
        if (say) this.notice(removedAccountNote(getProvider(gone.provider)?.name ?? gone.provider, gone.id), "warn");
    }

    /** An account was picked for `provider`'s CLI (setAccount): the messages held for one go now, in order, each once. */
    private releaseForAccount(provider: string) {
        if (this.closed || this.model?.provider !== provider || this.removedAccount()) return;
        const held = this.queued.filter((q) => q.account === provider);
        if (!held.length) {
            // What waited for it meanwhile (a watch's events, a schedule) can go now.
            this.toolState.wakes?.poke();
            this.schedules.poke();
            return;
        }
        this.releaseHeld(held);
    }

    /**
     * Messages held for an account go, in order, each once: the first now (the session is busy at once, so what's
     * sent next waits behind them), the rest as queued ones do.
     */
    private releaseHeld(held: Queued[]) {
        for (const q of held) {
            q.held = undefined;
            q.account = undefined;
        }
        this.queueUpdated();
        // Busy (a message sent while the switch let the CLI go): they run when its turn ends, as queued ones do.
        if (!this.busy) void this.runQueued(false);
    }

    /** Why a message held for an account waits (Queued.account), for the queue's row. */
    private heldWhy(q: Queued): string {
        const provider = q.account!;
        const name = getProvider(provider)?.name ?? provider;
        const id = removedAccount(provider, this.session.accountId(provider));
        return id ? removedAccountNote(name, id) : `Held when this session's ${name} account was removed. Send it now, edit it or remove it.`;
    }

    /** Switch models. Returns false when the provider can't be used. */
    async setModel(ref: string, opts: { quiet?: boolean; persist?: boolean } = {}): Promise<boolean> {
        const parsed = parseModelRef(ref);
        const def = parsed && getProvider(parsed.provider);
        if (!parsed || !def) {
            if (!opts.quiet) this.notice(`Unknown model "${ref}"`, "error");
            return false;
        }
        let client: ProviderClient;
        try {
            client = await clientFor(parsed.provider);
        } catch (e) {
            if (!opts.quiet) this.notice(redact((e as Error).message), "error");
            return false;
        }
        let info = this.engine.listings.find((l) => l.provider.id === parsed.provider)?.models.find((m) => m.id === parsed.id) ?? resolveModelInfo(ref);
        if (!info) return false;
        if (!info.contextWindow && def.kind !== "anthropic") info = (await lookupModel(ref).catch(() => undefined)) ?? info;
        // The model it was on, if the conversation has begun (none to tell of before the first prompt).
        const prev = this.conversationStarted ? this.model : undefined;
        this.model = info;
        this.servedModel = undefined;
        this.client = client;
        this.schedules.cancelLimitResume("model");
        // A CLI's own goal stays with that CLI: another provider doesn't carry it on, and it pauses there (#412). The
        // pause goes on while the agent takes the new model, never with the agent still on the CLI's (waited on below).
        const leaving = this.switchNativeGoal(this.agent?.model.provider, info);
        // Nor does the loop's go on with a CLI, which keeps goals of its own (and gets /goal and the tab's buttons).
        if (nativeGoals(info.provider)) {
            const dropped = this.goal.clear();
            const said = dropped && loopGoalDropped(dropped, info.provider);
            if (said) {
                this.session.recordNotice("info", said);
                this.notice(said, "info");
            }
        }
        this.classifier.setComplete((system, prompt, signal, o) => this.complete(system, prompt, signal, o));
        if (!this.agent) this.makeAgent();
        else {
            this.agent.setModel(info, client);
            this.agent.options.nativeWebSearch = this.nativeSearch();
            if (prev) this.agent.noteModelChange(modelRef(prev), info);
            // Before it, a note still queued (one a rewind to the start kept) would be about another model.
            else this.agent.dropStateNote("model");
        }
        await leaving;
        if (opts.persist) {
            try {
                updateSettings("user", this.ws.cwd, (s) => (s.model = ref));
                this.engine.reloadSettings();
            } catch (e) {
                this.notice(`Switched for this session only. ${redact((e as Error).message)}`, "warn");
            }
        }
        this.setState({ model: modelSummary(info), effort: this.settings().effort, fastMode: this.fastModeEnabled() });
        // A CLI whose account this session used was removed (#410): asked for now, and what's held waits for it.
        const gone = this.removedAccount();
        const held = this.queued.filter((q) => q.account);
        if (gone) {
            for (const q of held) q.account = gone.provider;
            if (held.length) this.queueUpdated();
            if (!opts.quiet) this.notice(removedAccountNote(def.name, gone.id, false), "warn");
        } else if (held.length && !opts.quiet) {
            // The user picked a model that runs without that account: where they chose to run, so what was held for
            // an account goes there now, once each, in order. Not as the session opens (quiet), on whatever model
            // it could open with: that isn't the user's choice, and they stay held.
            this.notice(`Sending ${held.length === 1 ? "the message" : `the ${held.length} messages`} held for an account to ${info.name ?? info.id}.`);
            this.releaseHeld(held);
        }
        return true;
    }

    /** The model's details arrived (listings refreshed). */
    refreshModelInfo() {
        if (!this.model) return;
        const m = this.engine.listings.find((l) => l.provider.id === this.model!.provider)?.models.find((x) => x.id === this.model!.id);
        if (!m) return;
        this.model = m;
        if (this.agent) this.agent.model = m;
        this.setState({ model: modelSummary(m), fastMode: this.fastModeEnabled() });
    }

    /** A provider's key changed: rebuild the client, or deselect the model when the key is gone. */
    async keyChanged(providerId: string) {
        if (this.model?.provider !== providerId) {
            if (!this.model) await this.track(this.initModel());
            return;
        }
        try {
            this.client = await clientFor(providerId);
            this.agent?.setModel(this.model, this.client);
        } catch {
            this.model = undefined;
            this.client = undefined;
            // What it delegated stops with it.
            void this.agent?.dispose();
            this.agent = undefined;
            this.setState({ model: undefined });
            await this.track(this.initModel());
        }
    }

    private nativeSearch(): boolean {
        if (!this.model) return false;
        const def = getProvider(this.model.provider);
        const pref = this.settings().webSearch ?? "auto";
        return def?.kind === "anthropic" && /^https:\/\/api\.anthropic\.com$/.test(resolveBaseUrl(def)) && (pref === "auto" || pref === "anthropic");
    }

    /** One-shot completion on a cheap model (reviewer, titles, page summaries), or the session's own with `main`. */
    async complete(system: string, prompt: string, signal?: AbortSignal, opts?: { main?: boolean; review?: ReviewStage; target?: { model: ModelInfo; client: ProviderClient }; maxTokens?: number; stopped?: (reason: string | undefined) => void }): Promise<string> {
        let model = this.model!;
        let client = this.client!;
        if (opts?.target) ({ model, client } = opts.target);
        else if (opts?.review) {
            // The reviewer, or with none the session's own model.
            const r = await reviewTarget(this.settings().reviewModel);
            if (r) ({ model, client } = r);
        } else if (opts?.main) {
            // the session's own model
        } else ({ model, client } = await this.smallTarget());
        // Stopped while the model was being picked (the session closed): a CLI would still start for it.
        signal?.throwIfAborted();
        const res = await client.stream(
            // On Claude Code or Codex, through the session's account, not the CLI's default.
            { model, system, messages: [{ role: "user", content: [{ type: "text", text: redact(prompt) }] }], tools: [], maxTokens: opts?.maxTokens ?? 2048, effort: "low", lightweight: true, signal, account: this.session.accountId(model.provider), ...(opts?.review ? REVIEW_REQUEST[opts.review] : {}) },
            () => {},
        );
        if (res.usage) {
            const c = costOf(res.usage, model);
            this.session.recordUsage(modelRef(model), res.usage, c.usd, c.unknown);
            this.setState({ cost: this.session.cost, costUnknown: this.session.costUnknown, ...this.tokenTotals() });
        }
        opts?.stopped?.(res.stopReason);
        return opts?.review ? reviewText(res) : textOf(res);
    }

    /** Whether one-off requests (the /goal check) have a model that answers them: not Claude Code or Codex, which run whole turns only. */
    private helperAnswers(): boolean {
        return canAnswerOneOff(this.settings().smallModel, this.model?.provider);
    }

    /** A goal check or retry is coming: the session isn't free for other automatic prompts (scheduled ones). */
    goalPending(): boolean {
        return this.goal.pending();
    }

    /** Set once the constructor is done: before, the state is built, not patched. */
    private goalLive = false;

    /** The sidebar says Working between a goal's turns (a check, a retry), not Done. */
    private goalShowsRunning = false;

    /** Claude Code's or Codex's own goal, as it last reported it (src/agent/goal.ts NativeGoal). */
    private nativeGoal?: NativeGoal;
    /** After the running turn has been stopped: the /goal command that stopped it (clear, pause), sent to the CLI then. */
    private afterStop?: string;

    /** /goal goes to the session's agent CLI (Claude Code, Codex) rather than the loop here. */
    private nativeGoals(): boolean {
        return nativeGoals(this.agent?.model.provider ?? this.model?.provider);
    }

    private goalView() {
        return this.goal.view() ?? (this.nativeGoal ? nativeGoalView(this.nativeGoal, this.busy) : undefined);
    }

    /** The CLI's goal changed: shown, and its end said (Codex says when it's met; Claude Code says so itself). */
    private nativeGoalReported(g: NativeGoal | null) {
        const end = g && nativeGoalEnd(g);
        if (end) {
            // Said once, as it ends: Codex still reports a met goal at the start of later runs.
            if (this.nativeGoal?.condition === g!.condition) {
                const level = g!.status === "failed" ? "warn" : "info";
                this.session.recordNotice(level, end);
                this.notice(end, level);
            }
            g = null;
        }
        this.nativeGoal = g ?? undefined;
        this.goalChanged();
    }

    /** A CLI's goal paused as the session switched away from that CLI (#412): shown again, with how to go on, back on it. */
    private goalLeft?: NativeGoal;

    /**
     * The model switched from provider `from` to `to`. A CLI's own goal stays with that CLI: another provider doesn't
     * carry it on, and one going on pauses there, so the CLI starts no turns of its own for it while the session is on
     * another model (its background work goes on). Back on that CLI, a goal left paused shows again, and how to go on is said.
     */
    private async switchNativeGoal(from: string | undefined, to: ModelInfo) {
        const had = this.nativeGoal;
        if (had && had.provider !== to.provider) this.nativeGoalReported(null);
        const left = this.goalLeft;
        if (left && left.provider === to.provider) {
            this.goalLeft = undefined;
            this.nativeGoalReported(left);
            const message = nativeGoalBack(left);
            this.session.recordNotice("info", message);
            this.notice(message, "info");
        }
        if (from && from !== to.provider && nativeGoals(from) && this.agent) {
            const name = getProvider(from)?.name ?? from;
            let paused: NativeGoal | undefined;
            try {
                paused = await this.agent.pauseNativeGoal(from);
            } catch (e) {
                const message = `Couldn't pause ${name}'s goal (${redact((e as Error).message)}). ${name} may go on with it by itself; its turns aren't taken up while this session is on another model.`;
                this.session.recordNotice("warn", message);
                this.notice(message, "warn");
            }
            if (paused) {
                const background = this.agent.backgroundTasks().filter((t) => t.provider === from && t.status === "running").length;
                const message = nativeGoalLeft(paused, background);
                this.session.recordNotice("info", message);
                this.notice(message, "info");
            }
            const kept = paused ?? (had?.provider === from && had.status === "paused" ? had : undefined);
            if (kept) this.goalLeft = kept;
        }
    }

    private goalChanged() {
        if (this.closed || !this.goalLive) return;
        const view = this.goalView();
        this.setState({ goal: view });
        if (this.busy) {
            this.goalShowsRunning = false;
            return;
        }
        const label = view?.state === "checking" ? "Checking the goal" : view?.state === "waiting" ? (view.retryAt ? "Retrying after an error" : "Waiting for background tasks") : undefined;
        if (label && this.goal.pending()) {
            this.goalShowsRunning = true;
            this.activity(label);
            this.setStatus("running");
        } else if (this.goalShowsRunning && !this.goal.pending()) {
            this.goalShowsRunning = false;
            this.setState({ activity: undefined });
            this.setStatus("idle");
        }
    }

    /**
     * /goal on Claude Code or Codex: their own goals. What needs no turn is answered here (the goal as last
     * reported while one runs; Claude Code has no pause); a clear or pause mid-turn stops the turn and is sent
     * after; the rest goes to the CLI as a turn. False: it's sent as it is.
     */
    private nativeGoalCommand(text: string, args: string): boolean {
        const c = parseGoalCommand(args);
        if (c.kind === "invalid") throw new RpcError(c.message, "invalid");
        const claude = this.nativeGoal?.provider === "claude-code" || (this.agent?.model.provider ?? this.model?.provider) === "claude-code";
        if (claude && (c.kind === "pause" || c.kind === "resume")) {
            this.notice(c.kind === "pause" ? "Claude Code's goals don't pause: stop the turn (it carries on with your next message), or /goal clear." : "Claude Code carries on with the goal when you send a message.");
            return true;
        }
        if (!this.busy) return false;
        if (c.kind === "status") {
            this.notice(nativeGoalStatus(this.nativeGoal, true));
            return true;
        }
        if (c.kind === "clear" || c.kind === "pause") {
            this.afterStop = text;
            this.interrupt();
            return true;
        }
        return false;
    }

    /** /goal: answered at once, even while a turn runs (it isn't queued). */
    private async goalCommand(args: string, attachments?: AttachedPart[]) {
        const c = parseGoalCommand(args);
        if (c.kind !== "set" && attachments?.length) throw new RpcError("Only /goal <condition> takes attachments.");
        switch (c.kind) {
            case "invalid":
                throw new RpcError(c.message, "invalid");
            case "status": {
                const v = this.goal.view();
                const last = this.goal.last;
                if (v) return this.notice(`◎ Goal (${v.state}): ${v.condition}${v.lastReason ? `\nLast check: ${v.lastReason}` : ""}`);
                if (last && last.result !== "cleared") return this.notice(`${last.result === "met" ? "✓ Last goal achieved" : "✗ Last goal judged impossible"}: ${last.condition}`);
                return this.notice("No goal set. /goal <condition> keeps working, turn after turn, until the condition holds.");
            }
            case "clear": {
                const was = this.goal.clear();
                // A new goal sent mid-turn waits in the queue: cleared with it, not set after.
                const dropped = this.queued.filter((q) => !q.literal && queuedGoalSet(q.text) !== undefined);
                if (dropped.length) {
                    this.queued = this.queued.filter((q) => !dropped.includes(q));
                    this.queueUpdated();
                }
                return this.notice(goalClearedNotice(was, dropped.map((q) => queuedGoalSet(q.text)!)));
            }
            case "pause":
                if (!this.goal.active) return this.notice("No goal set");
                this.goal.pause("Paused with /goal pause. /goal resume continues it.");
                return;
            case "resume":
                if (!this.goal.active) return this.notice("No goal set. /goal <condition> sets one.");
                this.goal.resume();
                return;
            case "set": {
                if (!this.agent) await this.ready.catch(() => undefined);
                if (!this.agent) throw new RpcError("No model is selected. Add an API key in Settings → Providers, then pick a model.");
                const { prompt, display } = this.goal.set(c.condition);
                if (!this.helperAnswers()) this.notice(`No model besides ${this.model?.name ?? "this one"} can check the goal, so it reports for itself each turn. Set a small model on another provider in Settings for an independent check.`);
                void this.startTurn(prompt, { display, kind: "command", attachments, goal: true }).catch((e) => this.notice(redact((e as Error).message), "error"));
                return;
            }
        }
    }

    /** MCP sampling: the session's own model, the server's token limit, and why it stopped. */
    private sampler(): Sampler {
        return async (system, prompt, signal, maxTokens) => {
            let stopReason: string | undefined;
            const text = await this.complete(system, prompt, signal, { main: true, maxTokens, stopped: (r) => (stopReason = r) });
            return { text, model: this.model ? modelRef(this.model) : "unknown", stopReason };
        };
    }

    /** Who answers one-off requests (titles, summaries): smallModel, else a small model of the session's provider, else its own. */
    private async smallTarget(): Promise<{ model: ModelInfo; client: ProviderClient }> {
        let model = this.model!;
        let client = this.client!;
        const smallRef = this.settings().smallModel;
        if (smallRef) {
            const p = parseModelRef(smallRef);
            if (p) {
                try {
                    client = await clientFor(p.provider);
                    model = resolveModelInfo(smallRef) ?? model;
                } catch {
                    // the main model it is
                }
            }
        } else {
            const small = smallModelFor(model.provider, this.engine.listings);
            if (small) model = small;
        }
        return { model, client };
    }

    tools(): Tool<any>[] {
        const native = this.nativeSearch();
        const off = this.settings().webSearch === "off";
        const skill = skillTool(this.ws.skills);
        return [...BUILTIN_TOOLS.filter((t) => !(t.name === "WebSearch" && (native || off)) && offered(t, this.settings())), ...(skill ? [skill] : []), ...CRON_TOOLS, ...this.ws.mcp.tools()];
    }

    private toolMeta(call: ToolCallPart): ToolMeta {
        const tool = BUILTIN_TOOLS.find((t) => t.name === call.name) ?? CRON_TOOLS.find((t) => t.name === call.name) ?? (call.name === "Skill" ? (skillTool(this.ws.skills) as Tool<any> | undefined) : undefined) ?? this.ws.mcp.tools().find((t) => t.name === call.name);
        let title = call.name;
        try {
            if (tool) title = tool.title(call.input ?? {});
        } catch {
            // the bare name
        }
        return { title, category: (tool?.category ?? (call.name.startsWith("mcp__") ? "mcp" : undefined)) as ToolCategoryId | undefined };
    }

    /**
     * Where an agent on `provider` starts while the session is in another worktree. Claude Code keeps its folder with its
     * session and goes back to a worktree it entered as it resumes, from where it was started: the session's folder. Any
     * other agent works in the folder Cavvy gives it: the worktree.
     */
    private placeAgent(provider: string | undefined) {
        if (this.workingIn) this.toolState.cwd = provider === "claude-code" ? this.ws.cwd : this.workingIn.path;
    }

    private makeAgent() {
        if (!this.model || !this.client) return;
        // Tasks the old one delegated stop with it.
        void this.agent?.dispose();
        this.placeAgent(this.model.provider);
        this.agent = new Agent({
            session: this.session,
            trusted: () => this.ws.trusted,
            skills: () => this.ws.freshSkills(),
            model: this.model,
            client: this.client,
            settings: () => this.settings(),
            approvedMcpServers: () => this.ws.mcp.approvedServers(),
            checker: this.checker,
            classifier: this.classifier,
            tools: () => this.tools(),
            mode: { get: () => this.mode, set: (m) => this.setMode(m, { fromAgent: true }) },
            toolState: this.toolState,
            nativeWebSearch: this.nativeSearch(),
            // Which models Claude Code and Codex can delegate to.
            listings: () => this.engine.listings,
            host: {
                emit: (e) => this.onEvent(e),
                askPermission: (req) => this.askPermission(req),
                saveRules: (rules, scope) => {
                    try {
                        for (const r of rules) addPermissionRule(scope, this.ws.cwd, "allow", r);
                    } catch (e) {
                        this.notice(`Allowed for this session only; the rule wasn't saved. ${redact((e as Error).message)}`, "warn");
                    }
                    this.ws.reload();
                },
                ui: {
                    askQuestion: (q, options, multi) => this.askQuestion(q, options, multi),
                    approvePlan: (plan) => this.approvePlan(plan),
                    requestSecret: (name, purpose, signal) => this.requestSecret(name, purpose, signal),
                },
                drainQueued: (record, admit, id) => this.drainQueued(record, admit, id),
                drainWaiting: (record) => this.drainWaiting(record),
                unsteered: (steers) => this.unsteered(steers),
                wake: (w) => this.adoptWake(w),
                backgroundChanged: () => this.syncBackground(),
                // A task's end is a notice of the window's (notifyBackground), not a line in the transcript too.
                announcesBackgroundEnds: true,
            },
            helpers: {
                complete: (s, p, sig) => this.complete(s, p, sig),
                sample: this.sampler(),
                webSearch: async (query, signal) => {
                    const backend = await availableSearchBackend(this.settings().webSearch);
                    if (!backend) throw new Error("Web search is turned off (settings.webSearch = off)");
                    return formatHits(query, await searchWeb(query, backend, signal));
                },
                resolveModel: async (ref) => {
                    const p = parseModelRef(ref);
                    if (!p) return undefined;
                    try {
                        const client = await clientFor(p.provider);
                        const model = resolveModelInfo(ref);
                        return model ? { model, client } : undefined;
                    } catch {
                        return undefined;
                    }
                },
            },
        });
        if (this.session.model === undefined && this.model) this.session.setModel(modelRef(this.model));
        // Left in bypass, it opened in another mode: the model hears of it, as of any switch.
        if (this.leftIn) this.agent.noteModeChange(this.leftIn, this.mode);
        this.leftIn = undefined;
    }

    // -----------------------------------------------------------------------
    // Modes and settings

    /** Returns false when the change was refused. */
    setMode(m: PermissionMode, opts: { fromAgent?: boolean } = {}): boolean {
        if (m === "bypassPermissions" && this.mode !== m && !this.bypassAllowed()) {
            this.notice("Bypass mode is off. Start the GUI with --dangerously-skip-permissions, or set permissions.allowBypass in your user settings, to enable it.", "error");
            return false;
        }
        const from = this.mode;
        this.mode = m;
        if (m === "plan" && from !== "plan") this.modeBeforePlan = from;
        if (!opts.fromAgent && this.agent && from !== m) {
            // Before the first prompt only plan mode is news: the model has to know it may only plan. Any other
            // mode is where the session starts, so a note still queued (of plan mode, or one a rewind to the start kept) goes.
            if (!this.conversationStarted) this.agent.dropStateNote("mode");
            if (this.conversationStarted || m === "plan") this.agent.noteModeChange(from, m);
        }
        this.setState({ mode: m, bypassAllowed: this.bypassAllowed() });
        this.recordState();
        return true;
    }

    fastModeEnabled(): boolean {
        return Boolean(this.model?.supportsFastMode && (this.session.fastMode ?? this.settings().fastMode));
    }

    setFastMode(enabled: boolean) {
        if (enabled && !this.model?.supportsFastMode) throw new Error("Fast mode is not available for this model/backend. Refresh the model list to check for updates.");
        if (this.busy) throw new Error("Change speed once this response is done, or interrupt it first.");
        this.session.setFastMode(enabled);
        this.setState({ fastMode: this.fastModeEnabled() });
    }

    setEffort(e: EffortLevel) {
        this.effort = e;
        this.setState({ effort: e });
        this.recordState();
    }

    rename(title: string) {
        // Shown and listed as it is: a key in the prompt it was made from stays out (on disk it's redacted anyway).
        const t = cleanTitle(redact(title));
        // A title still being made when it was closed.
        if (!t || this.closed) return;
        this.session.setTitle(t);
        this.setState({ title: t });
        this.engine.sessionChanged(this);
    }

    workspaceChanged() {
        // Another reviewer's verdicts don't stand for the one now chosen.
        if (this.ws.settings.reviewModel !== this.reviewer) {
            this.reviewer = this.ws.settings.reviewModel;
            this.classifier.clearCache();
        }
        this.setState({ mcp: this.ws.mcpStatus(), bypassAllowed: this.bypassAllowed() });
    }

    // -----------------------------------------------------------------------
    // Timeline building

    notice(text: string, level: "info" | "warn" | "error" = "info", data?: NoticeData) {
        const turn = this.currentTurn();
        this.closeOpen();
        this.op({ op: "block", turnId: turn.id, block: liveNotice(this.newId(), level, text, data) });
    }

    /**
     * An account switch's notice (or the tasks one stopped), as the session kept it: when it took the place of the
     * switch before it (`merged`), that switch's line says it, where it is. The session's rule decides, not what's
     * shown since: a notice that isn't kept (a status line) doesn't split a run of switches live either, so a
     * reopened session shows the same lines (#426).
     */
    private switchNotice(n: TurnNotice, merged: boolean) {
        const provider = n.account?.provider;
        const at = merged && provider ? this.lastSwitchBlock(provider) : undefined;
        if (at) {
            this.op({ op: "block.patch", turnId: at.turnId, blockId: at.blockId, patch: { text: n.text, account: n.account } });
            return;
        }
        const turn = this.currentTurn();
        this.closeOpen();
        this.op({ op: "block", turnId: turn.id, block: noticeBlock(n, this.newId()) });
    }

    /** The line of the latest switch on `provider` the transcript shows: the one a merged switch says itself in. */
    private lastSwitchBlock(provider: string): { turnId: string; blockId: string } | undefined {
        for (let i = this.view.turns.length - 1; i >= 0; i--) {
            const t = this.view.turns[i]!;
            if (t.archived) return undefined;
            for (let j = t.blocks.length - 1; j >= 0; j--) {
                const b = t.blocks[j]!;
                if (b.t === "notice" && b.account?.provider === provider) return { turnId: t.id, blockId: b.id };
            }
        }
        return undefined;
    }

    /** The turn output goes to: the running one, or a new one without a prompt. */
    private currentTurn(): Turn {
        const t = this.turnId ? findTurn(this.view, this.turnId) : undefined;
        if (t) return t;
        const last = this.view.turns[this.view.turns.length - 1];
        if (last && !last.prompt && !last.archived && !last.imported) return last;
        const turn: Turn = { id: this.newId(), blocks: [], status: "done", startedAt: Date.now() };
        this.op({ op: "turn", turn });
        return findTurn(this.view, turn.id)!;
    }

    private addBlock(block: Block): string {
        const turn = this.currentTurn();
        this.op({ op: "block", turnId: turn.id, block });
        return turn.id;
    }

    private patchBlock(blockId: string, patch: Partial<Block>, turnId = this.toolTurn.get(blockId) ?? this.turnId) {
        if (turnId) this.op({ op: "block.patch", turnId, blockId, patch });
    }

    private blockIn(turnId: string | undefined, id: string): Block | undefined {
        const t = turnId ? findTurn(this.view, turnId) : undefined;
        return t ? findBlock(t, id) : undefined;
    }

    /** Ends the text or thinking block being streamed. */
    private closeOpen() {
        if (this.openThinking) {
            const b = this.blockIn(this.turnId, this.openThinking);
            if (b?.t === "thinking" && b.startedAt) this.patchBlock(b.id, { durationMs: Date.now() - b.startedAt });
        }
        this.openText = undefined;
        this.openThinking = undefined;
    }

    /** It did work: it goes up the sidebar, and its file says so (Session.worked). */
    private worked(at: number) {
        this.lastActive = at;
        this.session.worked(at);
    }

    private onEvent(e: AgentEvent) {
        // An idle compaction isn't the user's doing: the session doesn't move up the sidebar for it.
        if (!this.idleCompacting) this.worked(Date.now());
        switch (e.type) {
            case "activity":
                if (e.text) this.activity(e.text);
                else this.setState({ activity: undefined });
                break;
            case "request_start": {
                this.closeOpen();
                const previous = e.continuation ? this.currentTurn().blocks.findLast((b) => b.t === "text") : undefined;
                const prefix = e.continuation ? assistantText(this.session.messages) : "";
                this.continuationText = previous?.t === "text" && prefix && previous.text === prefix ? { id: previous.id, prefix } : undefined;
                this.responseBlocks = [];
                this.responseTurn.clear();
                this.activity("Thinking");
                this.notePrompt();
                break;
            }
            case "text": {
                if (this.continuationText) {
                    this.closeOpen();
                    this.openText = this.continuationText.id;
                    this.op({ op: "append", turnId: this.turnId!, blockId: this.openText, field: "text", text: redact(e.text) });
                    this.activity("Writing");
                    break;
                }
                if (!this.openText) {
                    this.closeOpen();
                    const id = this.newId();
                    this.responseTurn.set(id, this.addBlock({ t: "text", id, text: "" }));
                    this.openText = id;
                    this.responseBlocks.push(id);
                    this.activity("Writing");
                }
                this.op({ op: "append", turnId: this.turnId ?? this.currentTurn().id, blockId: this.openText, field: "text", text: redact(e.text) });
                break;
            }
            case "thinking": {
                if (!this.openThinking) {
                    this.closeOpen();
                    const id = this.newId();
                    this.responseTurn.set(id, this.addBlock({ t: "thinking", id, text: "", startedAt: Date.now() }));
                    this.openThinking = id;
                    this.responseBlocks.push(id);
                    // Keep the continued answer after its reasoning, visible outside the work fold.
                    const answer = this.continuationText && this.blockIn(this.turnId, this.continuationText.id);
                    if (answer) {
                        this.op({ op: "block.remove", turnId: this.turnId!, blockId: answer.id });
                        this.op({ op: "block", turnId: this.turnId!, block: answer });
                    }
                    this.activity("Thinking");
                }
                this.op({ op: "append", turnId: this.turnId ?? this.currentTurn().id, blockId: this.openThinking, field: "text", text: redact(e.text) });
                break;
            }
            case "tool_call_start": {
                this.closeOpen();
                const meta = this.toolMeta({ type: "tool_call", id: e.id, name: e.name, input: {} });
                const turnId = this.addBlock({ t: "tool", id: e.id, name: e.name, title: e.name, category: meta.category, status: "streaming", receiving: 0, ...(runsAgent(e.name) ? { agent: true } : {}) });
                this.toolTurn.set(e.id, turnId);
                this.responseBlocks.push(e.id);
                // Its input is still arriving: "Writing Write" read as a typo.
                this.activity(`Preparing ${e.name}`);
                break;
            }
            case "tool_call_delta": {
                const b = this.blockIn(this.toolTurn.get(e.id), e.id);
                if (b?.t === "tool") this.patchBlock(e.id, { receiving: (b.receiving ?? 0) + e.partial.length });
                break;
            }
            case "server_tool": {
                this.closeOpen();
                if (e.name === "web_search") {
                    const id = this.newId();
                    this.addBlock({ t: "tool", id, name: "WebSearch", title: `Web search${e.detail ? `: ${e.detail}` : ""}`, category: "network", status: "ok", summary: "Searched the web" });
                } else if (e.name === "web_search_result") {
                    const turn = this.currentTurn();
                    const last = [...turn.blocks].reverse().find((b) => b.t === "tool" && b.name === "WebSearch");
                    if (last) this.patchBlock(last.id, { output: redact(e.detail).slice(0, 4000) }, turn.id);
                }
                break;
            }
            case "assistant":
                this.finishResponse(e.message);
                break;
            case "tool_start": {
                const turnId = this.toolTurn.get(e.call.id);
                const patch: Partial<ToolBlock> = {
                    title: e.title,
                    category: e.tool?.category as ToolCategoryId | undefined,
                    input: trimInput(e.call.input),
                    status: "running",
                    startedAt: Date.now(),
                    receiving: undefined,
                    ...this.jobOf(e.call),
                };
                if (turnId && this.blockIn(turnId, e.call.id)) this.patchBlock(e.call.id, patch, turnId);
                else {
                    const b = toolBlockFromCall(e.call, this.toolMeta(e.call));
                    this.toolTurn.set(e.call.id, this.addBlock({ ...b, ...patch } as ToolBlock));
                }
                // A sub-agent's call reads as what it's doing, not as Task(…).
                if (runsAgent(e.call.name)) this.activity("Agent working", String((e.call.input as { description?: unknown })?.description ?? ""));
                else this.activity(e.title);
                break;
            }
            case "tool_progress": {
                const turnId = this.toolTurn.get(e.id);
                if (turnId) this.op({ op: "append", turnId, blockId: e.id, field: "progress", text: redact(e.text) });
                break;
            }
            case "tool_approved":
                this.patchBlock(e.id, { approval: e.reason, sandboxed: e.sandboxed });
                break;
            case "tool_end":
                this.toolEnded(e.call, e.result, e.durationMs, e.title);
                break;
            case "notice":
                this.notice(e.message, e.level, e.data);
                break;
            case "retry": {
                // The partial response is thrown away and asked for again.
                const turnId = this.turnId;
                if (this.continuationText) this.patchBlock(this.continuationText.id, { text: this.continuationText.prefix }, turnId);
                if (turnId) for (const id of this.responseBlocks) this.op({ op: "block.remove", turnId: this.responseTurn.get(id) ?? turnId, blockId: id });
                this.responseBlocks = [];
                this.responseTurn.clear();
                this.openText = this.openThinking = undefined;
                this.activity(`Retrying in ${Math.ceil(e.delayMs / 1000)}s · Stop to cancel`, `${e.reason.slice(0, 160)} (attempt ${e.attempt})`);
                break;
            }
            case "usage": {
                if (e.usage.resolvedModel) this.servedModel = parseModelRef(e.usage.resolvedModel)?.id ?? this.servedModel;
                // A backend says its context window with its usage (Claude Code's models list none): the ring can show now.
                const window = this.model?.contextWindow !== this.view.state.model?.contextWindow && this.model ? { model: modelSummary(this.model) } : {};
                this.setState({ contextTokens: e.contextTokens, cost: this.session.cost, costUnknown: this.session.costUnknown, ...this.tokenTotals(), ...window });
                break;
            }
            case "compact_start":
                if (!e.idle) this.activity("Compacting conversation");
                break;
            case "compact_end":
                this.compacted(e.summary, e.idle, e.kept);
                break;
            case "limits":
                this.engine.limitsReported(e.limits, e.partial);
                break;
            case "subagent":
                // A sub-agent on an agent CLI reports the same account's limits.
                if (e.event.type === "limits") this.engine.limitsReported(e.event.limits, e.event.partial);
                else this.subagentEvent(e.parentId, e.label, e.event);
                break;
            case "goal":
                // Not from a CLI the session has switched away from (its goal paused there as the switch went through).
                if (e.goal && e.goal.provider !== this.model?.provider) break;
                this.nativeGoalReported(e.goal);
                break;
            case "cli_commands":
                this.engine.cliCommandsReported(e.provider, this.ws.cwd, e.names);
                break;
            case "cwd":
                this.followCwd(e.cwd);
                break;
            case "turn_end":
                this.closeOpen();
                this.endTurn(e.reason);
                break;
        }
    }

    /** The finished model response: its text is the redacted copy the session stored. */
    private finishResponse(msg: { content: { type: string; text?: string }[]; stopReason?: string }) {
        this.closeOpen();
        const turnId = this.turnId;
        if (!turnId) return;
        let texts = msg.content.filter((p) => p.type === "text").map((p) => p.text ?? "");
        if (this.continuationText) {
            this.patchBlock(this.continuationText.id, { text: this.continuationText.prefix + texts.join("") }, turnId);
            texts = [];
            this.continuationText = undefined;
        }
        // Each where it was streamed: the turn before one a message steered in meanwhile started (its words are that turn's).
        const at = (id: string) => this.responseTurn.get(id) ?? turnId;
        let streamed = this.responseBlocks.map((id) => this.blockIn(at(id), id)).filter((b): b is Block => b?.t === "text");
        const cutOffText = msg.stopReason === "max_tokens" && !msg.content.some((p) => p.type === "tool_call");
        if (cutOffText && texts.length) {
            texts = [texts.join("")];
            // Keep an answer that may continue in one Markdown block, after its reasoning.
            const first = streamed[0];
            for (const b of streamed) this.op({ op: "block.remove", turnId: at(b.id), blockId: b.id });
            if (first) this.op({ op: "block", turnId: at(first.id), block: first });
            streamed = first ? [first] : [];
        }
        streamed.forEach((b, i) => {
            const text = i === streamed.length - 1 ? texts.slice(i).join("") : texts[i];
            if (text === undefined || !text || (!text.trim() && !cutOffText)) this.op({ op: "block.remove", turnId: at(b.id), blockId: b.id });
            else if (b.t === "text" && b.text !== text) this.patchBlock(b.id, { text }, at(b.id));
        });
        // Text the provider didn't stream (some send it all at the end).
        if (!streamed.length) for (const t of texts) if (t.trim() || (t && cutOffText)) this.addBlock({ t: "text", id: this.newId(), text: t });
        for (const id of this.responseBlocks) {
            const b = this.blockIn(at(id), id);
            if (b?.t === "thinking" && !b.text.trim()) this.op({ op: "block.remove", turnId: at(id), blockId: id });
        }
        this.responseBlocks = [];
        this.responseTurn.clear();
        // Its calls have arrived whole. Those not started yet wait their turn (a call runs after the one before it finishes), or, cut off or declined, never run.
        const notRun = msg.stopReason === "max_tokens" || msg.stopReason === "context_window_exceeded" || msg.stopReason === "refusal";
        for (const part of msg.content) {
            if (part.type !== "tool_call") continue;
            const call = part as unknown as ToolCallPart;
            const at = this.toolTurn.get(call.id);
            const b = this.blockIn(at, call.id);
            if (b?.t !== "tool" || b.status !== "streaming") continue;
            if (notRun) this.patchBlock(call.id, { status: "error", summary: "Not run", receiving: undefined }, at);
            else this.patchBlock(call.id, { status: "queued", title: this.toolMeta(call).title, input: trimInput(call.input), receiving: undefined, ...this.jobOf(call) }, at);
        }
    }

    /** A Bash call that started a background shell: what it said it was, for the calls that check on it. */
    private noteShell(call: ToolCallPart, summary: string | undefined) {
        const shell = call.name === "Bash" ? /^Running in background as (\S+)$/.exec(summary ?? "")?.[1] : undefined;
        const description = (call.input as { description?: unknown } | undefined)?.description;
        if (shell && typeof description === "string" && description.trim()) this.shellDescriptions.set(shell, description);
    }

    /** For a call about a background shell: the shell, as the call that started it described it. */
    private jobOf(call: ToolCallPart): Pick<ToolBlock, "job"> {
        if (call.name !== "BashOutput" && call.name !== "KillShell") return {};
        const input = (call.input ?? {}) as Record<string, unknown>;
        const id = String(input.bash_id ?? input.shell_id ?? "");
        const shell = this.toolState.shells.get(id);
        if (!shell) return {};
        // Redacted whole, before it's cut: a secret registered since, across the cut, would otherwise show its first part.
        const d = shell.monitor?.description ?? this.shellDescriptions.get(id);
        const label = redact(d ?? shell.command).trim().split("\n")[0]!.slice(0, 120);
        return { job: { label, startedAt: shell.startedAt } };
    }

    private toolEnded(call: ToolCallPart, result: ToolResult, durationMs: number, title?: string) {
        const turnId = this.toolTurn.get(call.id);
        if (!turnId || !this.blockIn(turnId, call.id)) {
            const b = toolBlockFromCall(call, this.toolMeta(call));
            this.toolTurn.set(call.id, this.addBlock(b));
        }
        const d = result.display;
        const shown = d?.body !== undefined ? d.body : result.content;
        const patch: Partial<ToolBlock> = { ...resultPatch(redact(shown || (result.isError ? result.content : "")), result.isError, runsAgent(call.name)), durationMs, progress: undefined };
        // What it did was only known at its end (a backend's web search): its title and input say so now.
        if (title) Object.assign(patch, { title, input: trimInput(call.input) });
        if (/^The user declined/.test(result.content)) patch.status = "denied";
        if (d?.summary) patch.summary = d.summary;
        if (result.images?.length) patch.images = result.images.length;
        // A new file (Write says "Wrote", an Edit with an empty old_string "Created"): no "before" side.
        if (d?.diff) patch.diff = fileDiff(d.diff.path, d.diff.before === "" && /^(Created|Wrote)\b/.test(d.summary ?? "") ? null : d.diff.before, d.diff.after);
        if (d?.diagnostics) patch.diagnostics = redactedReport(d.diagnostics);
        this.patchBlock(call.id, patch, this.toolTurn.get(call.id));
        this.noteShell(call, d?.summary);
        const b = this.blockIn(this.toolTurn.get(call.id), call.id) as ToolBlock | undefined;
        this.ui.write({ t: "tool", id: call.id, summary: patch.summary, diff: patch.diff, diagnostics: patch.diagnostics, durationMs, approval: b?.approval, sandboxed: b?.sandboxed, images: patch.images, job: b?.job, at: Date.now() });
        if (call.name === "TodoWrite") this.setState({ todos: this.toolState.todos.map((t) => ({ ...t })) });
        // A Task's result is its sub-agent's report (a delegated task's comes when it settles), and so is a Skill's
        // that ran as its own agent (Claude Code may say it ended first, with no report) unless it failed or was declined:
        // that result is Claude Code's refusal, not the skill's. One still working (Claude Code's in the background) only
        // says it started: its report comes when it ends.
        const sub = reportsAgent(call.name, result.isError) ? this.view.agents.find((a) => a.id === call.id) : undefined;
        if (sub && sub.status !== "running" && sub.status !== "waiting") this.agentPatch(call.id, { report: redact(withoutActionsNote(result.content)) });
        if (patch.diff || b?.category === "edit") this.setState({ filesChanged: this.filesChanged() });
        this.syncShells();
    }

    private compacted(summary: string, idle?: boolean, kept?: boolean) {
        const current = this.turnId;
        // Claude Code or Codex compacting its own context leaves this session's history as it is.
        if (!this.backendModel()) {
            this.segment++;
            if (this.runStart !== undefined) this.runStart = 0;
            // The running turn's prompt went on after the summary (not a reminder the compaction kept): it's there now.
            const moved = kept && current && this.session.messages[1] && isPrompt(this.session.messages[1]) ? 1 : undefined;
            // Everything before is out of the model's context now (and out of /rewind's reach).
            for (const t of this.view.turns) {
                if (t.id === current) {
                    if (moved !== undefined) this.movePrompt(t, moved);
                    else if (t.prompt?.index !== undefined) this.op({ op: "turn.patch", turnId: t.id, patch: { prompt: { ...t.prompt, index: undefined } } });
                    continue;
                }
                if (!t.archived) this.op({ op: "turn.patch", turnId: t.id, patch: { archived: true, prompt: t.prompt ? { ...t.prompt, index: undefined } : undefined } });
            }
        }
        if (current) this.addBlock({ t: "compact", id: this.newId(), summary: redact(summary), auto: true });
        else {
            // A backend-only marker has no place in the unchanged transcript;
            // giving it this segment's position would intercept earlier search hits.
            const turn: Turn = { id: this.newId(), blocks: [{ t: "compact", id: this.newId(), summary: redact(summary), auto: false, ...(idle ? { idle: true } : {}) }], status: "done", startedAt: Date.now(), ...(!this.backendModel() ? { pos: { seg: this.segment, index: -1 } } : {}) };
            this.op({ op: "turn", turn });
        }
        this.setState({ contextTokens: 0 });
        this.recordState();
    }

    /**
     * The running turn's prompt, kept by a compaction, is at `index` of the new
     * segment: its turn, the log's record of it, and its attachments are found
     * there, and it can be rewound to as before (replay shows it there, once).
     */
    private movePrompt(t: Turn, index: number) {
        const pos = { seg: this.segment, index };
        this.op({ op: "turn.patch", turnId: t.id, patch: { pos, ...(t.prompt?.index !== undefined ? { prompt: { ...t.prompt, index } } : {}) } });
        if (this.pendingPrompt) this.pendingPrompt = { ...this.pendingPrompt, ...pos };
        if (!this.uiTurn) return;
        const { prompt, ...start } = { ...this.uiTurn, ...pos };
        this.uiTurn = { ...start, ...(prompt ? { prompt } : {}) };
        // Started afresh there (the turn that started last), then which prompt it is, if that's known yet.
        this.ui.write({ t: "turn", ...start });
        if (prompt) this.ui.write({ t: "turn", ...start, prompt });
    }

    // What it does shows on its own (an AgentRun): the call's row opens it, so the row carries none of it.
    private subagentEvent(parentId: string, label: string, e: AgentEvent) {
        if (e.type === "subagent") return this.nestedAgentEvent(parentId, e);
        this.trackAgent(parentId, label, e);
    }

    /**
     * What a sub-agent's own sub-agent does (a delegated Codex task's spawn,
     * say): an agent of its own, under its parent, from the call in the
     * parent's activity that started it. Its label (the parent's, then its
     * own) is the one its permission prompts come with.
     */
    private nestedAgentEvent(parentId: string, e: Extract<AgentEvent, { type: "subagent" }>): void {
        if (e.event.type === "subagent") return this.nestedAgentEvent(e.parentId, e.event);
        this.trackAgent(e.parentId, e.label, e.event, parentId);
    }

    // -----------------------------------------------------------------------
    // Sub-agents: the bar above the input and each one's activity

    private agentPatch(id: string, patch: Partial<Omit<AgentRun, "id" | "blocks">>) {
        this.op({ op: "agent.patch", id, patch });
    }

    /** A sub-agent's run, from its call: in a turn, or (a sub-agent's own) in its parent's activity, on its parent's model unless the call names one. */
    private startAgent(id: string, parent?: string, label?: string): AgentRun | undefined {
        const own = this.model && modelRef(this.model);
        if (parent === undefined) {
            const turnId = this.toolTurn.get(id);
            const call = turnId ? this.blockIn(turnId, id) : undefined;
            if (!turnId || call?.t !== "tool") return undefined;
            const run = agentFromCall(call, turnId, own);
            // A call that isn't one of the agent tools can still run a sub-agent (Claude Code's Skill, for a skill
            // that runs as its own agent, as /code-review does): its row is then that agent's, its steps a click away.
            if (!call.agent && call.name === "Skill") this.op({ op: "block.patch", turnId, blockId: id, patch: { agent: true } });
            // Claude Code's SendMessage resuming a sub-agent an earlier process started (#458): its run is that call's, named as the CLI names the agent, with what it was sent.
            const resumed = call.name === "SendMessage" ? { description: label ? redact(label) : run.description, prompt: typeof call.input?.message === "string" ? call.input.message : run.prompt } : {};
            this.op({ op: "agent", agent: { ...run, ...resumed, startedAt: Date.now() } });
        } else {
            const p = this.view.agents.find((x) => x.id === parent);
            const call = p?.blocks.find((b) => b.id === id);
            if (!p || call?.t !== "tool") return undefined;
            const run = agentFromCall(call, p.turnId, own);
            this.op({ op: "agent", agent: { ...run, parentId: p.id, model: run.model ?? p.model, startedAt: Date.now() } });
        }
        return this.view.agents.find((x) => x.id === id);
    }

    private trackAgent(id: string, label: string, e: AgentEvent, parent?: string) {
        let a = this.view.agents.find((x) => x.id === id);
        if (!a || a.replayed) {
            a = this.startAgent(id, parent, label);
            if (!a) return;
        }
        this.agentLabels.set(id, label);
        if (!a.taskId) {
            const task = this.agent?.delegatedTasks.find((t) => t.callId === id);
            if (task) this.agentPatch(id, { taskId: task.id, effort: task.effort, ...(a.model || !this.model || task.model === modelRef(this.model) ? {} : { model: task.model }) });
        }
        // A new turn of one that had ended (Codex's, messaged after it answered): it's running again, and its next answer is its report.
        if (e.type === "request_start" && a.endedAt !== undefined && a.status !== "running" && a.status !== "waiting") {
            this.agentText.delete(id);
            this.agentPatch(id, { status: "running", endedAt: undefined, report: undefined, turnAfter: a.blocks.at(-1)?.id ?? a.turnAfter });
        }
        switch (e.type) {
            case "activity":
                this.agentPatch(id, { activity: e.text });
                break;
            case "request_start":
            case "thinking":
                if (a.activity !== "Thinking" && a.status === "running") this.agentPatch(id, { activity: "Thinking" });
                break;
            case "text": {
                let blockId = this.agentText.get(id);
                if (!blockId) {
                    blockId = this.newId();
                    this.agentText.set(id, blockId);
                    this.op({ op: "agent.block", id, block: { t: "text", id: blockId, text: "" } });
                }
                this.op({ op: "agent.append", id, blockId, field: "text", text: redact(e.text) });
                if (a.activity !== "Writing") this.agentPatch(id, { activity: "Writing" });
                break;
            }
            case "assistant":
                if (e.answer?.trim()) this.agentPatch(id, { report: e.answer.trim() });
                break;
            case "tool_call_start":
                this.agentText.delete(id);
                this.agentPatch(id, { activity: `Preparing ${e.name}` });
                break;
            case "tool_start": {
                this.agentText.delete(id);
                const block: ToolBlock = { ...toolBlockFromCall(e.call, { title: e.title, category: e.tool?.category as ToolCategoryId | undefined }), startedAt: Date.now(), ...this.jobOf(e.call) };
                this.op({ op: "agent.block", id, block });
                this.agentPatch(id, { toolCount: a.toolCount + 1, activity: e.title });
                break;
            }
            case "tool_progress":
                this.op({ op: "agent.append", id, blockId: e.id, field: "progress", text: redact(e.text) });
                break;
            case "tool_approved":
                this.op({ op: "agent.block.patch", id, blockId: e.id, patch: { approval: e.reason, sandboxed: e.sandboxed } });
                break;
            case "tool_end": {
                const d = e.result.display;
                const shown = d?.body !== undefined ? d.body : e.result.content;
                const patch: Partial<ToolBlock> = { ...resultPatch(redact(shown || (e.result.isError ? e.result.content : "")), e.result.isError, runsAgent(e.call.name)), durationMs: e.durationMs, progress: undefined };
                if (e.title) Object.assign(patch, { title: e.title, input: trimInput(e.call.input) });
                if (d?.summary) patch.summary = d.summary;
                if (d?.diff) patch.diff = fileDiff(d.diff.path, d.diff.before === "" && /^(Created|Wrote)\b/.test(d.summary ?? "") ? null : d.diff.before, d.diff.after);
                if (d?.diagnostics) patch.diagnostics = redactedReport(d.diagnostics);
                this.op({ op: "agent.block.patch", id, blockId: e.call.id, patch });
                this.noteShell(e.call, d?.summary);
                // Its own sub-agent's call: the result is that one's report, as a Task's (or a Skill's) in a turn is (one still working only says it started).
                const sub = reportsAgent(e.call.name, e.result.isError) ? this.view.agents.find((x) => x.id === e.call.id && x.parentId === id) : undefined;
                if (sub && sub.status !== "running" && sub.status !== "waiting") this.agentPatch(sub.id, { report: redact(withoutActionsNote(e.result.content)) });
                break;
            }
            case "notice":
                this.agentText.delete(id);
                this.op({ op: "agent.block", id, block: liveNotice(this.newId(), e.level, e.message, e.data) });
                break;
            case "retry":
                this.agentPatch(id, { activity: `Retrying: ${redact(e.reason)}` });
                break;
            case "usage":
                this.agentPatch(id, { tokens: a.tokens + e.usage.inputTokens + e.usage.outputTokens + (e.usage.cacheReadTokens ?? 0) });
                break;
            case "turn_end":
                this.agentEnded(id, e.reason);
                break;
        }
    }

    private agentEnded(id: string, reason: TurnEndReason) {
        this.agentText.delete(id);
        const a = this.view.agents.find((x) => x.id === id);
        if (!a) return;
        // Said in its latest turn (not an answer of an earlier one, when this one gave none). Gone from the list: all of it is.
        const from = a.turnAfter ? a.blocks.findIndex((b) => b.id === a.turnAfter) + 1 : 0;
        const said = a.blocks.slice(from).reverse().find((b) => b.t === "text" && b.text.trim());
        const status: AgentRun["status"] = reason === "aborted" ? "stopped" : reason === "done" || reason === "max_turns" ? "done" : "failed";
        // Its last word is its report; one ending again (Claude Code saying so twice) takes the later.
        const report = (a.report === undefined || a.endedAt !== undefined) && said?.t === "text" ? said.text : undefined;
        this.agentPatch(id, { status, endedAt: Date.now(), activity: undefined, ...(report !== undefined ? { report } : {}) });
        this.syncAgent(id, true);
        // Its steps are written; what's kept of them to compare against can go.
        this.agentsLogged.get(id)?.blocks.clear();
        // One that outlived its turn changed that turn's row of it (what it did, its result) since the turn ended.
        if (a.turnId !== this.turnId) this.syncTurn(a.turnId, true);
        // A delegated task's result (its report, and why it ended) comes once it settles.
        const task = a.taskId ? this.agent?.delegatedTasks.find((t) => t.id === a.taskId) : undefined;
        if (task)
            void task.settled.then(() => {
                if (!task.result) return;
                this.agentPatch(id, { report: redact(withoutActionsNote(task.result.report)), status: task.status === "cancelled" ? "stopped" : task.status === "failed" ? "failed" : "done" });
                this.syncAgent(id, true);
            });
    }

    /** The running sub-agent a permission request comes from: by its tool call, or by the label it asks with. */
    private agentAsking(req: PermissionRequest): AgentRun | undefined {
        const live = this.view.agents.filter((a) => a.status === "running" || a.status === "waiting");
        if (req.callId) {
            const byCall = live.find((a) => a.blocks.some((b) => b.id === req.callId));
            if (byCall) return byCall;
        }
        return req.agentLabel ? live.find((a) => this.agentLabels.get(a.id) === req.agentLabel) : undefined;
    }

    /** Stop a delegated task by its sub-agent's id, or every one still running. Task sub-agents stop with the turn. */
    stopAgent(agentId?: string): number {
        if (!this.agent) return 0;
        // Only those still running: one that already ended keeps its own outcome.
        const running = this.agent.delegatedTasks.filter((t) => t.status === "running").map((t) => t.id);
        const taskId = agentId ? this.view.agents.find((x) => x.id === agentId)?.taskId : undefined;
        this.toolState.background?.stoppedByUser(agentId ? (taskId && running.includes(taskId) ? [taskId] : []) : running);
        if (!agentId) return this.agent.stopDelegated();
        const a = this.view.agents.find((x) => x.id === agentId);
        if (!a?.taskId) throw new Error(a ? "This sub-agent stops with the turn: interrupt it (Esc) to stop it." : "No such sub-agent.");
        return this.agent.stopDelegated(a.taskId);
    }

    private turnSnapshotFloor?: number;

    private latestCheckpoint(): number | undefined {
        for (let i = this.session.messages.length - 1; i >= 0; i--) {
            const m = this.session.messages[i]!;
            if (m.role === "user" && m.meta?.checkpoint !== undefined) return m.meta.checkpoint;
        }
        return undefined;
    }

    private snapshotId(): number | undefined {
        const id = this.latestCheckpoint();
        return id !== this.turnSnapshotFloor ? id : undefined;
    }

    private endTurn(reason: TurnEndReason) {
        const turnId = this.turnId;
        if (!turnId) return;
        const turn = findTurn(this.view, turnId);
        // A call whose work goes on in the background (a sub-agent the CLI keeps running past the turn): it ends when that does.
        const background = new Set((this.agent?.backgroundTasks() ?? []).flatMap((t) => (t.status === "running" && t.toolUseId ? [t.toolUseId] : [])));
        // Tool calls that never finished (interrupted, or not run after a denial).
        for (const b of turn?.blocks ?? []) {
            if (b.t === "tool" && b.status === "running" && background.has(b.id)) continue;
            if (b.t === "tool" && (b.status === "running" || b.status === "streaming" || b.status === "queued" || b.status === "awaiting")) {
                this.patchBlock(b.id, { status: reason === "aborted" ? "error" : "error", summary: reason === "aborted" ? "Interrupted" : "Not run", progress: undefined, receiving: undefined }, turnId);
                // Never ended, so never recorded: what it was about is kept for a reopen all the same.
                if (b.job) this.ui.write({ t: "tool", id: b.id, job: b.job, at: Date.now() });
            }
        }
        const status: TurnStatus = reason;
        const end = Date.now();
        this.op({ op: "turn.patch", turnId, patch: { status, endedAt: end, snapshotId: this.snapshotId() } });
        // What it did, then that it ended.
        this.syncTurnAll(turnId);
        this.stepsLogged.delete(turnId);
        if (this.uiTurn) this.ui.write({ t: "turn", ...this.uiTurn, end, status });
        this.uiTurn = undefined;
        this.recordState();
        // The turn may have switched branches, here or in the worktree it works in.
        this.showWorkingIn(this.workingIn && this.worktreeAt(this.workingIn.path));
    }

    /** The other worktree the agent works in (SessionState.workingIn), as last shown. */
    private workingIn?: WorkingIn;

    /** The folders the session is open in: its own, and the worktree its agent works in, if it moved to one. */
    get folders(): string[] {
        return this.workingIn ? [this.ws.cwd, this.workingIn.path] : [this.ws.cwd];
    }
    /** The folder the agent last said it works in (AgentEvent cwd): Claude Code says so at each turn's start. */
    private reportedCwd?: string;

    /**
     * The other worktree of the session's repository `folder` is in, as the header shows it; undefined for the session's own.
     * `exclude`: one in .claude/worktrees (where Claude Code's EnterWorktree makes them) is kept out of the main checkout's
     * changes, as Cavvy's own are; other sessions there would list it as a new file.
     */
    private worktreeAt(folder: string, o: { exclude?: boolean } = {}): WorkingIn | undefined {
        if (folder === this.ws.cwd) return undefined;
        const w = workingWorktree(this.ws.cwd, folder);
        if (w?.managed && o.exclude) {
            try {
                excludeManagedWorktrees(mainCheckoutOf(this.ws.cwd));
            } catch {
                // Not excluded: it shows as a new folder there, as before.
            }
        }
        return w && { path: w.path, ...(w.branch ? { branch: w.branch } : {}), ...(w.detached && w.head ? { head: w.head } : {}) };
    }

    /** The agent works in `cwd` now: in another worktree of the session's repository, or not. Only a change is looked into. */
    private followCwd(cwd: string) {
        if (cwd === this.reportedCwd) return;
        this.reportedCwd = cwd;
        this.showWorkingIn(this.worktreeAt(cwd, { exclude: true }));
    }

    /** The worktree the agent works in (none: the session's own folder), kept with the session, and the branches the header shows. */
    private showWorkingIn(w: WorkingIn | undefined) {
        if (this.closed) return;
        this.workingIn = w;
        this.session.setWorkdir(w?.path);
        const patch: Partial<SessionState> = {};
        if (JSON.stringify(w) !== JSON.stringify(this.view.state.workingIn)) patch.workingIn = w;
        const branch = gitBranch(this.ws.cwd);
        if (branch !== this.view.state.branch) patch.branch = branch;
        if (Object.keys(patch).length) this.setState(patch);
    }

    // -----------------------------------------------------------------------
    // Interactions

    private interact(interaction: Interaction): Promise<InteractionResponse | undefined> {
        interaction.since ??= Date.now();
        return new Promise((resolve) => {
            this.pending.set(interaction.id, { interaction, resolve });
            this.setState({ interactions: [...this.pendingList()] });
            this.setStatus("waiting");
            if (interaction.kind === "secret") return this.engine.notify(this, "question", `Asks you for ${interaction.name}`);
            const kind = interaction.kind;
            // A sub-agent's request says whose it is: the session's own agent didn't ask.
            const asker = kind === "permission" && interaction.agentLabel ? `Sub-agent "${interaction.agentLabel}" wants` : "Wants";
            this.engine.notify(this, kind, kind === "permission" ? `${asker} to ${interaction.heading.toLowerCase()}` : kind === "question" ? interaction.question : "Plan ready for your review");
        });
    }

    private pendingList(): Interaction[] {
        return [...this.pending.values()].map((p) => p.interaction);
    }

    respond(interactionId: string, r: InteractionResponse) {
        if (!r || typeof r !== "object") throw new RpcError("response must be an object");
        const p = this.pending.get(interactionId);
        if (!p) throw new RpcError("That request was already answered or has expired.", "expired");
        if (p.interaction.kind !== r.kind) throw new RpcError("The answer doesn't match the request.");
        // A bad value stays in the card for the user to fix; the message never quotes it.
        if (p.interaction.kind === "secret" && r.kind === "secret" && r.value !== undefined) {
            const bad = secretValueError(r.value, p.interaction.name);
            if (bad) throw new RpcError(bad, "bad_secret");
            r = { kind: "secret", value: r.value };
        }
        // Only what was offered: "always" isn't, for a dangerous command.
        if (p.interaction.kind === "permission" && r.kind === "permission" && !p.interaction.options.some((o) => o.id === r.choice)) throw new RpcError("That isn't one of the choices offered.");
        this.settle(interactionId, r);
    }

    private settle(id: string, r: InteractionResponse | undefined) {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        this.setState({ interactions: this.pendingList() });
        if (!this.pending.size) this.setStatus(this.busy ? "running" : "idle");
        else this.engine.sessionChanged(this);
        p.resolve(r);
        // A question answered between turns (a plan handed off, say) may leave it idle.
        if (!this.pending.size) queueMicrotask(() => this.schedules.poke());
    }

    /** The sub-agent itself, or for a sub-agent's own, the one at the top it runs under (a delegated task, say). */
    private outermost(agentId: string): AgentRun | undefined {
        let a = this.view.agents.find((x) => x.id === agentId);
        for (let depth = 0; a?.parentId && depth < 8; depth++) a = this.view.agents.find((x) => x.id === a!.parentId);
        return a;
    }

    /** Permission prompts of an agent CLI's background sub-agents (PermissionRequest.background), by interaction id. */
    private backgroundAsks = new Set<string>();

    /**
     * Answer what's pending with nothing. At a turn's end, a delegated task still running keeps asking: it outlives
     * the turn. `keepBackground` (a turn's end, Esc): so does an agent CLI's background sub-agent.
     */
    private cancelInteractions(opts: { keepDelegated?: boolean; keepBackground?: boolean } = {}) {
        for (const [id, p] of [...this.pending]) {
            if (opts.keepBackground && this.backgroundAsks.has(id)) continue;
            const agentId = p.interaction.kind === "permission" ? p.interaction.agentId : undefined;
            // A delegated task's own sub-agent asks for the task.
            const agent = agentId ? this.outermost(agentId) : undefined;
            if (opts.keepDelegated && agent?.taskId && (agent.status === "running" || agent.status === "waiting")) continue;
            this.settle(id, undefined);
        }
    }

    private async askPermission(req: PermissionRequest): Promise<PermissionResponse> {
        const { tool, input, decision } = req;
        const suggestions = decision.suggestions ?? [];
        const projectName = basename(this.ws.cwd);
        const it: PermissionInteraction = {
            kind: "permission",
            id: this.newId(),
            toolId: req.callId,
            toolName: tool.name,
            category: tool.category as ToolCategoryId,
            title: req.title,
            heading: "Use a tool",
            options: [{ id: "yes", label: "Allow once" }],
            dangerous: decision.dangerous,
            reason: decision.reason ? redact(decision.reason) : undefined,
            classifierReason: req.classifierReason ? redact(req.classifierReason) : undefined,
            plain: req.summary ? redact(req.summary) : undefined,
            plainLabel: req.summary ? "AI summary" : undefined,
            agentLabel: req.agentLabel,
        };
        if (decision.grant) it.options.push({ id: "session", label: `Allow \`${redact(decision.grant.label)}\` for the session` });
        if (req.preview?.summary) it.summary = redact(req.preview.summary);
        if (isShellTool(tool.name)) {
            it.heading = tool.name === "Monitor" ? "Watch a command's output" : req.secrets?.length ? "Run a shell command with secrets" : "Run a shell command";
            it.command = redact(String(input.command ?? ""));
            if (input.description) it.description = redact(String(input.description));
            if (req.secrets?.length) it.secrets = [...req.secrets];
            if (decision.sandbox && Array.isArray(input.allowedHosts)) it.hosts = input.allowedHosts.map(String);
            if (!decision.dangerous && suggestions.length) {
                const label = suggestions.map((s) => s.replace(/^Bash\((.*?)(:\*)?\)$/, "$1")).join(", ");
                it.options.push({ id: "always", label: `Always allow \`${label}\` in ${projectName}` });
            }
        } else if (tool.category === "edit") {
            const p = toolPath(tool.name, input) ?? "";
            const abs = p.startsWith("/") ? p : join(this.toolState.cwd, p);
            const exists = existsSync(abs);
            it.heading = tool.name === "Write" ? (exists ? "Overwrite a file" : "Create a file") : tool.name === "NotebookEdit" ? "Edit a notebook" : "Edit a file";
            it.path = displayPath(abs, this.ws.cwd);
            const diff = req.preview?.diff;
            if (diff) it.diff = fileDiff(it.path, diff.before === "" && !exists ? null : redact(diff.before), redact(diff.after));
            if (decision.offerAcceptEdits) it.options.push({ id: "session-edits", label: "Allow all edits this session" });
            else if (suggestions.length) it.options.push({ id: "always", label: `Allow edits in ${suggestions[0]!.replace(/^Edit\(\/?(.*?)\/\*\*\)$/, "$1")} this session` });
        } else if (tool.category === "read") {
            it.heading = "Read outside the workspace";
            it.path = toolPath(tool.name, input) ?? "";
            if (suggestions.length) it.options.push({ id: "always", label: `Allow reading ${suggestions[0]!.replace(/^Read\(\/?(.*?)\/\*\*\)$/, "$1")} this session` });
        } else if (tool.name === "WebFetch") {
            it.heading = "Fetch a web page";
            it.url = String(input.url ?? "");
            if (input.prompt) it.description = redact(String(input.prompt).slice(0, 300));
            if (suggestions.length) it.options.push({ id: "always", label: `Always allow ${suggestions[0]!.replace(/^WebFetch\(domain:(.*)\)$/, "$1")}` });
        } else if (SIMULATOR_TOOL_HEADINGS[tool.name]) {
            // What it does ("Start iPhone 17", "Simulator: tap e4") heads the prompt where the preview says.
            it.heading = req.preview?.summary ? redact(req.preview.summary) : SIMULATOR_TOOL_HEADINGS[tool.name]!;
        } else if (BROWSER_TOOL_HEADINGS[tool.name]) {
            it.heading = BROWSER_TOOL_HEADINGS[tool.name]!;
            if (tool.name === "BrowserNavigate") it.url = String(input.url ?? "");
            else if (req.preview?.summary) it.description = redact(req.preview.summary);
            if (req.preview?.body) it.command = redact(req.preview.body);
            if (suggestions.length) it.options.push({ id: "always", label: tool.name === "BrowserNavigate" ? `Always allow ${suggestions[0]!.replace(/^WebFetch\(domain:(.*)\)$/, "$1")}` : `Always allow ${tool.name} in ${projectName}` });
        } else if (GIT_TOOL_HEADINGS[tool.name]) {
            it.heading = GIT_TOOL_HEADINGS[tool.name]!;
            if (req.preview?.body) it.command = redact(req.preview.body);
            if (req.preview?.summary) it.description = redact(req.preview.summary);
            if (suggestions.length) it.options.push({ id: "always", label: `Always allow ${tool.name} in ${projectName}` });
        } else if (tool.category === "mcp") {
            it.heading = "Use an MCP tool";
            it.json = redact(JSON.stringify(input, null, 2)).slice(0, 6000);
            if (suggestions.length) it.options.push({ id: "always", label: `Always allow ${tool.name} in ${projectName}` });
        }
        it.options.push({ id: "no", label: "Deny" });
        // A sub-agent stopped while this was put together asks nothing.
        if (req.signal?.aborted) return { allow: false };
        if (req.callId && this.blockIn(this.toolTurn.get(req.callId), req.callId)) this.patchBlock(req.callId, { status: "awaiting" });
        const asking = this.agentAsking(req);
        // A sub-agent's call: its row in that agent's view, which waits too.
        const subCall = asking && req.callId ? this.view.agents.find((a) => a.id === asking.id)?.blocks.find((b) => b.t === "tool" && b.id === req.callId) : undefined;
        const patchSubCall = (patch: Partial<ToolBlock>) => subCall && asking && this.op({ op: "agent.block.patch", id: asking.id, blockId: subCall.id, patch });
        if (asking) {
            it.agentId = asking.id;
            this.agentPatch(asking.id, { status: "waiting", activity: "Waiting for approval" });
            patchSubCall({ status: "awaiting" });
        }
        // Withdrawn when its sub-agent is stopped.
        const withdraw = () => this.settle(it.id, undefined);
        req.signal?.addEventListener("abort", withdraw, { once: true });
        if (req.background) this.backgroundAsks.add(it.id);
        const answer = await this.interact(it).finally(() => {
            req.signal?.removeEventListener("abort", withdraw);
            this.backgroundAsks.delete(it.id);
        });
        if (asking && this.view.agents.find((a) => a.id === asking.id)?.status === "waiting") this.agentPatch(asking.id, { status: "running", activity: req.title });
        const choice = answer?.kind === "permission" && !req.signal?.aborted ? answer.choice : "no";
        // Approved, it starts now: the time it shows running (a wait's countdown) doesn't count the time it waited for the answer.
        const after: Partial<ToolBlock> = req.signal?.aborted ? { status: "error", summary: "Interrupted" } : choice === "no" ? { status: "denied" } : { status: "running", startedAt: Date.now() };
        patchSubCall(after);
        if (req.signal?.aborted) return { allow: false };
        if (req.callId && this.blockIn(this.toolTurn.get(req.callId), req.callId)) this.patchBlock(req.callId, after);
        switch (choice) {
            case "yes":
                return { allow: true };
            case "session":
                return { allow: true, grant: true };
            case "always":
                return { allow: true, rules: suggestions, scope: tool.category === "read" || tool.category === "edit" ? "session" : "local" };
            case "session-edits":
                return { allow: true, setMode: "acceptEdits" };
            default: {
                const feedback = answer?.kind === "permission" ? answer.feedback?.trim() : undefined;
                return { allow: false, feedback: feedback || undefined };
            }
        }
    }

    private runningTool(name: string): string | undefined {
        const turn = this.turnId ? findTurn(this.view, this.turnId) : undefined;
        return [...(turn?.blocks ?? [])].reverse().find((b) => b.t === "tool" && b.name === name && b.status === "running")?.id;
    }

    /** How what MCP servers ask for (forms, sampling) reaches the user outside a tool call: @-mentions, prompts. */
    mcpAsker(): McpAsker {
        return {
            askQuestion: (q, opts, multi) => this.askQuestion(q, opts, multi),
            sample: this.sampler(),
            warn: (m) => this.notice(m, "warn"),
        };
    }

    private async askQuestion(question: string, options: { label: string; description?: string }[], multi: boolean): Promise<string[] | undefined> {
        const toolId = this.runningTool("AskUserQuestion");
        if (toolId) this.patchBlock(toolId, { status: "awaiting" });
        const r = await this.interact({ kind: "question", id: this.newId(), toolId, question: redact(question), options: options.map((o) => ({ label: redact(o.label), description: o.description && redact(o.description) })), multi });
        if (toolId) this.patchBlock(toolId, { status: "running" });
        return r?.kind === "question" && r.answers?.length ? r.answers : undefined;
    }

    /** The value goes straight back to the tool, which keeps it in the session's store: nothing here holds on to it. */
    private async requestSecret(name: string, purpose: string, signal: AbortSignal): Promise<string | undefined> {
        const toolId = this.runningTool("RequestSecret") ?? this.runningTool(`mcp__${MCP_SERVER_NAME}__request_secret`);
        if (toolId) this.patchBlock(toolId, { status: "awaiting" });
        const id = this.newId();
        const withdraw = () => this.settle(id, undefined);
        signal.addEventListener("abort", withdraw, { once: true });
        try {
            const r = await this.interact({ kind: "secret", id, toolId, name, purpose: redact(purpose) });
            return r?.kind === "secret" ? r.value : undefined;
        } finally {
            signal.removeEventListener("abort", withdraw);
            if (toolId) this.patchBlock(toolId, { status: "running" });
        }
    }

    forgetSecret(name: string) {
        if (!this.toolState.secrets?.forget(name)) throw new RpcError("This session doesn't hold a secret by that name.", "not_found");
    }

    private async approvePlan(plan: string): Promise<{ approved: boolean; mode?: PermissionMode; feedback?: string; handoff?: boolean }> {
        const toolId = this.runningTool("ExitPlanMode");
        if (toolId) this.patchBlock(toolId, { status: "awaiting" });
        const id = this.newId();
        // Kept in the session file, so it can still be saved or taken to a worktree once the card is gone.
        const stored = this.session.addPlan(toolId ?? id, plan);
        this.setState({ plan: this.planRef(stored) });
        const r = await this.interact({ kind: "plan", id, toolId, plan: stored.text });
        if (toolId) this.patchBlock(toolId, { status: "running" });
        if (this.handoffs.delete(id)) {
            // Stop the source turn for every backend, and return queued input to the
            // composer instead of dispatching it in the original working directory.
            this.abort?.abort();
            return { approved: false, feedback: r?.kind === "plan" ? r.feedback : undefined, handoff: true };
        }
        if (r?.kind !== "plan") return { approved: false };
        return { approved: r.approved, mode: r.mode, feedback: r.feedback };
    }

    private planRef(p: { id: string; text: string; at: number } | undefined): PlanRef | undefined {
        return p && { id: p.id, title: planTitle(p.text) || "Plan", at: p.at };
    }

    /** The plan presented last: one waiting on the card, else the last one recorded, else (older sessions) the last ExitPlanMode call. */
    private latestPlan(): { id: string; text: string; at: number; interactionId?: string } | undefined {
        const pending = [...this.pending.values()].map((p) => p.interaction).filter((i) => i.kind === "plan").at(-1);
        if (pending?.kind === "plan") return { id: pending.toolId ?? pending.id, text: pending.plan, at: Date.now(), interactionId: pending.id };
        const stored = this.session.plans.at(-1);
        if (stored) return stored;
        const calls = this.session.messages.flatMap((m) => (m.role === "assistant" ? toolCallsOf(m) : [])).filter((c) => c.name === "ExitPlanMode" && typeof c.input?.plan === "string");
        const last = calls.at(-1);
        return last && { id: last.id, text: redact(String(last.input.plan)), at: 0 };
    }

    /**
     * A plan of this session's, by its id (the ExitPlanMode call's, or its request's), or the latest. The
     * redacted text the card showed; `interactionId` while it's still waiting for an answer.
     */
    planText(ref?: string): { id: string; text: string; interactionId?: string } | undefined {
        if (!ref) return this.latestPlan();
        for (const p of this.pending.values()) {
            const it = p.interaction;
            if (it.kind === "plan" && (it.toolId === ref || it.id === ref)) return { id: it.toolId ?? it.id, text: it.plan, interactionId: it.id };
        }
        const stored = this.session.plans.find((p) => p.id === ref);
        if (stored) return stored;
        const find = (messages: Message[]) => {
            for (const m of messages) {
                if (m.role !== "assistant") continue;
                const call = toolCallsOf(m).find((c) => c.id === ref && c.name === "ExitPlanMode" && typeof c.input?.plan === "string");
                if (call) return { id: call.id, text: redact(String(call.input.plan)) };
            }
            return undefined;
        };
        // From before a compaction, it's still in the transcript file.
        return find(this.session.messages) ?? readSegments(this.session.path).reduce<{ id: string; text: string } | undefined>((hit, seg) => hit ?? find(seg.messages), undefined);
    }

    /** Answer a waiting plan card without approving it: the plan is carried out elsewhere, so this turn stops, still in plan mode. */
    handOffPlan(interactionId: string, note: string): boolean {
        const p = this.pending.get(interactionId);
        if (p?.interaction.kind !== "plan") return false;
        this.handoffs.add(interactionId);
        this.settle(interactionId, { kind: "plan", approved: false, feedback: redact(note) });
        return true;
    }

    addPlanLink(link: PlanLink) {
        this.session.addPlanLink(link);
        this.setState({ planLinks: [...this.session.planLinks] });
    }

    // -----------------------------------------------------------------------
    // Prompts

    /** `id`: what the agent knows the steer they make by (AgentHost.unsteered). */
    private drainQueued(record?: () => void, admit?: (text: string, attachments?: readonly AttachedPart[]) => Promise<Admitted>, id?: number): (string | Admitted)[] | Promise<Admitted[]> {
        // Messages to steer with; queued ones, held ones, commands, and those with images or files where the turn can't take them wait for their own turn.
        const steering = () => this.queued.filter((q) => q.mode === "steer" && !q.held && !q.sending && !this.waits(q));
        // An API model's request takes them all at once, attachments too.
        const provider = this.agent?.model.provider ?? this.model?.provider ?? "";
        if (getProvider(provider)?.kind !== "agent") {
            const take = steering();
            if (!take.length) return [];
            return admit ? this.admitQueued(take, admit, steering, record, id) : this.steerWith(take, record, id);
        }
        // An agent CLI's, in the queue's order: those with only words as they always have, up to one with attachments,
        // which goes alone once they've gone. Nothing passes one on its way (Queued.sending).
        const inOrder = () => {
            const out: Queued[] = [];
            for (const q of this.queued) {
                if (q.sending) break;
                if (q.mode !== "steer" || q.held || this.waits(q)) continue;
                if (q.attachments?.length) return out.length ? out : [q];
                out.push(q);
            }
            return out;
        };
        const take = inOrder();
        if (!take.length) return [];
        if (take[0]!.attachments?.length) return this.steerAttached(take[0]!, record, admit, id);
        return admit ? this.admitQueued(take, admit, inOrder, record, id) : this.steerWith(take, record, id);
    }

    /**
     * One with attachments steers alone, and only once what runs the turn has it (Admitted.transaction): until
     * then it stays in the queue (on disk too), marked as on its way so no other drain takes it. Taken out of the
     * queue and recorded when it's accepted; left there, attachments and all, if it's refused (Codex refused its
     * turn/steer, or the turn ended or stopped first), to go as a prompt of its own after the run (or back to the
     * composer, after an interrupt). Its hooks run first, as the others' do.
     */
    private async steerAttached(q: Queued, record?: () => void, admit?: (text: string, attachments?: readonly AttachedPart[]) => Promise<Admitted>, id?: number): Promise<Admitted[]> {
        q.sending = true;
        // Its hooks run once: a second try (refused the first time) goes on what they said then.
        const a: Admitted = q.admitted ? { text: q.text, admission: "go", ...q.admitted } : admit ? await admit(q.text, q.attachments) : { text: q.text, admission: "go" };
        if (admit && a.admission === "go") q.admitted = a.context ? { context: a.context } : {};
        if (a.admission !== "go" || !this.queued.includes(q) || q.held) {
            q.sending = undefined;
            // One a hook blocked goes back to the composer, to change or drop (the hook's warning says why).
            if (a.admission === "blocked" && this.queued.includes(q)) {
                this.queued = this.queued.filter((x) => x !== q);
                this.queueUpdated();
                this.engine.draft(this, q.text, q.attachments ?? []);
            }
            return [];
        }
        let open = true;
        const transaction = {
            accepted: () => {
                if (!open) return false;
                open = false;
                q.sending = undefined;
                // The session is being let go of: it stays queued (on disk), to go once it's reopened.
                if (this.closed) return false;
                this.steerWith([q], record, id);
                // What waited behind it can go now.
                if (this.queued.some((x) => x.mode === "steer" && !x.held && !this.waits(x))) queueMicrotask(() => this.agent?.queueChanged());
                return true;
            },
            refused: () => {
                open = false;
                q.sending = undefined;
            },
        };
        return [{ ...a, attachments: q.attachments, transaction }];
    }

    /**
     * Their UserPromptSubmit hooks run while they stay in the queue (on disk too): an interrupt meanwhile hands
     * them back to the composer. One a hook blocks goes back to the composer now, to change or drop (the hook's
     * warning says why); the rest go.
     */
    private async admitQueued(take: Queued[], admit: (text: string, attachments?: readonly AttachedPart[]) => Promise<Admitted>, steering: () => Queued[], record?: () => void, id?: number): Promise<Admitted[]> {
        const blocked: Queued[] = [];
        const admitted = new Map<Queued, Admitted>();
        for (const q of take) {
            // With what's attached: its hooks read a long paste as what the user wrote, as a prompt's do.
            const a = await admit(q.text, q.attachments);
            if (a.admission === "stopped") return [];
            if (a.admission === "blocked") blocked.push(q);
            else admitted.set(q, a);
        }
        const back = blocked.filter((q) => this.queued.includes(q));
        if (back.length) {
            this.queued = this.queued.filter((q) => !back.includes(q));
            this.queueUpdated();
            this.engine.draft(this, back.map((q) => q.text).join("\n\n"), back.flatMap((q) => q.attachments ?? []));
        }
        // One the user took out or held meanwhile doesn't go.
        const still = steering();
        const go = take.filter((q) => admitted.has(q) && still.includes(q));
        this.steerWith(go, record, id);
        // Each with what its own hooks added (two alike are still two), and what's attached to it.
        return go.map((q) => ({ ...admitted.get(q)!, ...(q.attachments?.length ? { attachments: q.attachments } : {}) }));
    }

    /** Taken out of the queue to steer with: each one's text, or with what's attached, the text and that (its hooks ran already, or there are none). */
    private steerWith(take: Queued[], record?: () => void, id?: number): (string | Admitted)[] {
        if (!take.length) return [];
        this.queued = this.queued.filter((q) => !take.includes(q));
        this.queueUpdated();
        const attachments = take.flatMap((q) => q.attachments ?? []);
        // What the agent CLI said before them goes first, so their prompt's place in the session is where it lands.
        record?.();
        const turn = this.drainedTurn(take.map((q) => q.text).filter((t) => t.trim()).join("\n\n"), attachments);
        if (id !== undefined) this.steeredTurns.set(id, turn.id);
        // Prepared as a sent prompt's are: the user hears what the model may not take (said in their turn).
        this.attachmentWarnings(attachments, (text, level) => this.notice(text, level));
        // An agent CLI's turn: one with attachments that waited for these (it goes alone, after them) can go next.
        if (getProvider(this.agent?.model.provider ?? this.model?.provider ?? "")?.kind === "agent" && this.queued.some((q) => q.attachments?.length && q.mode === "steer" && !q.held && !q.sending && !this.waits(q))) queueMicrotask(() => this.agent?.queueChanged());
        return take.map((q) => (q.attachments?.length ? { text: q.text, admission: "go" as const, attachments: q.attachments } : q.text));
    }

    /**
     * The agent CLI is between its turns, waiting only on its background work (Claude Code's): nothing is
     * mid-step, so the first queued message goes now as a prompt of its own, whatever its mode, with what's
     * attached. Commands and `!commands` wait: the server runs them (a custom command expands, /compact
     * compacts), and only once the run is over. Held ones wait for the user.
     */
    private async drainWaiting(steps: { record(): void; admit(parts: UserContent[], display: string): Promise<Admission> }): Promise<{ parts: UserContent[]; display: string } | undefined> {
        const q = this.queued.find((x) => !x.held && !x.sending && !isCommand(x));
        if (!q) return undefined;
        // It stays in the queue (on disk too) while it's prepared and its hooks run: an interrupt meanwhile
        // hands it back to the composer as it is, attachments and place included.
        const signal = this.abort?.signal ?? new AbortController().signal;
        // Prepared as a sent prompt is (startTurn); what it uses and attaches is said in its turn, once it has one.
        const said: [string, "info" | "warn"][] = [];
        const parts = await this.preparePrompt(q.text, { attachments: q.attachments }, signal, (text, level) => void said.push([text, level]));
        const admitted = signal.aborted ? "stopped" : await steps.admit(parts, q.text);
        if (admitted === "stopped" || signal.aborted) return undefined;
        // The user took it out or held it meanwhile: it doesn't go, and the next one is tried, through its own hooks.
        if (q.held || !this.queued.includes(q)) return this.drainWaiting(steps);
        this.queued = this.queued.filter((x) => x !== q);
        this.queueUpdated();
        // A hook blocked it (the hook's warning says so): the turn that's waiting stays the one its output goes to.
        if (admitted === "blocked") return undefined;
        // What the CLI said before it goes first, so the prompt's place in the session is where it lands.
        steps.record();
        const turn = this.drainedTurn(q.text, q.attachments, true);
        const images = parts.filter((p): p is AttachedPart => p.type === "image");
        if (images.length) this.op({ op: "turn.patch", turnId: turn.id, patch: { prompt: { ...turn.prompt!, ...attachedPrompt(images) } } });
        for (const [text, level] of said) this.notice(text, level);
        return { parts, display: q.text };
    }

    /**
     * Drained messages start a turn in the UI: the open one ends, and this one shows `text` as its prompt,
     * with what's attached. `own`: a prompt of its own whatever came before it (never with tool results).
     */
    private drainedTurn(text: string, attachments?: AttachedPart[], own = false): Turn {
        // After tool calls they ride along with the results; otherwise they're a prompt of their own.
        const last = this.session.messages[this.session.messages.length - 1];
        const steering = !own && last?.role === "assistant" && toolCallsOf(last).length > 0;
        this.closeOpen();
        const prev = this.turnId;
        if (prev) {
            const end = Date.now();
            this.op({ op: "turn.patch", turnId: prev, patch: { status: "done", endedAt: end, snapshotId: this.snapshotId() } });
            if (this.uiTurn) this.ui.write({ t: "turn", ...this.uiTurn, end, status: "done" });
            this.syncTurnAll(prev);
            this.stepsLogged.delete(prev);
        }
        this.turnSnapshotFloor = this.latestCheckpoint();
        const turn: Turn = { id: this.newId(), prompt: { text, ...attachedPrompt(attachments), ...(steering ? {} : { index: this.session.messages.length }), ...(own ? {} : { steered: true }) }, blocks: [], status: "running", startedAt: Date.now(), pos: { seg: this.segment, index: this.session.messages.length } };
        this.op({ op: "turn", turn });
        if (prev && this.backendTurns.has(prev)) this.backendTurns.set(turn.id, this.segment);
        this.turnId = turn.id;
        // After a finished answer they start a turn of their own: the one before can be forked now. (Claude
        // Code and Codex take them in the middle of theirs, before its answer is recorded: it's still running.)
        if (!steering && last?.role === "assistant") this.runStart = this.session.messages.length;
        // Where it starts: its own prompt, or the tool results it rides along with.
        this.uiTurn = { seg: this.segment, index: this.session.messages.length, at: turn.startedAt! };
        this.ui.write({ t: "turn", ...this.uiTurn });
        this.worked(turn.startedAt!);
        this.engine.sessionChanged(this);
        return turn;
    }

    /**
     * Messages steered in that the agent CLI never took (AgentHost.unsteered; Esc withdrew them): their turns go, what
     * streamed under them back to the turn before (which ends as they did), and they go back to the composer, as
     * sent, after what's typed there. Those it hands back, by id: only those whose turns it still has.
     */
    private unsteered(steers: { id: number; texts: string[]; attachments: AttachedPart[] }[]): number[] {
        if (this.closed) return [];
        const back = new Set<number>();
        for (const { id } of [...steers].reverse()) {
            const turnId = this.steeredTurns.get(id);
            this.steeredTurns.delete(id);
            const at = this.view.turns.findIndex((t) => t.id === turnId);
            const turn = this.view.turns[at];
            const prev = at > 0 ? this.view.turns[at - 1] : undefined;
            if (!turn) continue;
            back.add(id);
            if (prev) {
                for (const b of turn.blocks) this.op({ op: "block", turnId: prev.id, block: b });
                for (const m of [this.toolTurn, this.responseTurn]) for (const [k, v] of m) if (v === turn.id) m.set(k, prev.id);
                for (const a of this.view.agents) if (a.turnId === turn.id) this.op({ op: "agent.patch", id: a.id, patch: { turnId: prev.id } });
                this.op({ op: "turn.patch", turnId: prev.id, patch: { status: turn.status, endedAt: turn.endedAt } });
            }
            this.op({ op: "turn.remove", turnId: turn.id });
            const rec = prev?.pos && prev.startedAt !== undefined ? { seg: prev.pos.seg, index: prev.pos.index, at: prev.startedAt } : undefined;
            if (this.turnId === turn.id) {
                this.turnId = prev?.id;
                this.uiTurn = rec;
            }
        }
        const given = steers.filter((s) => back.has(s.id));
        if (given.length) this.engine.draft(this, given.flatMap((s) => s.texts).filter((t) => t.trim()).join("\n\n"), given.flatMap((s) => s.attachments), true);
        return given.map((s) => s.id);
    }

    /**
     * A message from the GUI: a prompt, a slash command, or `!command`. Queued while busy: to steer
     * the running turn with or to wait for its end (`mode`, else the followUpBehavior setting).
     */
    async send(text: string, attachments?: AttachedPart[], literal = false, mode?: FollowUp): Promise<{ queued: boolean }> {
        // Another switch can start while it waits for one.
        while (this.switching) await this.switching.catch(() => undefined);
        this.checkCommitting();
        if (this.closed) throw new Error("This session was closed.");
        // No await between this check and queueing/dispatch: a switch must not change the model we checked.
        this.checkPdfs(attachments);
        const trimmed = text.trim();
        if (!trimmed && !attachments?.length) return { queued: false };
        this.toolState.wakes?.resume();
        // These answer here and send nothing to the model, so what's attached would be lost: the message stays in the box.
        const bare = literal || !attachments?.length ? undefined : trimmed.match(/^\/(compact|loop|schedules|trust)(?=\s|$)/i)?.[1]?.toLowerCase();
        if (bare) throw new RpcError(`/${bare} doesn't take attachments. Send them in a message of their own.`, "no_attachments");
        // A mistyped command isn't sent to the model; the GUI offers to send it as a message.
        const unknown = literal ? undefined : this.unknownCommand(text);
        if (unknown) throw new RpcError(`Unknown command /${unknown}`, "unknown_command");
        // /goal answers at once, even mid-turn; only a new goal waits its turn in the queue, with what's attached.
        const goal = literal ? undefined : trimmed.match(/^\/goal(?:\s+([\s\S]*))?$/i);
        if (goal && this.nativeGoals()) {
            if (attachments?.length && parseGoalCommand(goal[1] ?? "").kind !== "set") throw new RpcError("Only /goal <condition> takes attachments.");
            if (this.nativeGoalCommand(trimmed, goal[1] ?? "")) return { queued: false };
        } else if (goal && !(this.busy && parseGoalCommand(goal[1] ?? "").kind === "set")) {
            await this.goalCommand(goal[1] ?? "", attachments);
            return { queued: false };
        }
        if (this.busy) {
            const q: Queued = { id: ++this.queueSeq, text, attachments, literal: literal || undefined, mode: mode ?? followUpDefault(this.settings().followUpBehavior) };
            this.queued.push(q);
            this.queueUpdated();
            if (q.mode === "steer" && !this.waits(q)) this.agent?.queueChanged();
            // Back before an idle compaction is done: it stops, and this runs on the cache that's still warm.
            if (this.idleCompacting) this.abort?.abort();
            return { queued: true };
        }
        const message = { text, attachments, literal: literal || undefined };
        const gone = this.runsHere(message) ? undefined : this.needsAccount();
        if (gone) {
            this.holdForAccount(gone, message);
            return { queued: true };
        }
        void this.dispatch(text, attachments, literal).catch((e) => this.notice(redact((e as Error).message), "error"));
        return { queued: false };
    }

    /** A PDF the session's model can't read is refused before it's sent. */
    private checkPdfs(attachments: AttachedPart[] | undefined) {
        const pdf = attachments?.find((p) => p.type === "file" && p.kind === "pdf");
        if (pdf && this.model && !readsPdf(this.model)) throw new RpcError(`${this.model.name ?? this.model.id} can't read PDFs. Remove ${pdf.name}, or switch to a model that can.`, "pdf_unsupported");
    }

    /** The /name a message starts with when it names no command this server or the project has. */
    unknownCommand(text: string): string | undefined {
        const c = slashCommand(text);
        if (!c || SERVER_COMMANDS.has(c.name) || this.ws.commands.some((x) => x.name === c.name) || pluginCommandFor(this.ws.commands, c.name) || this.ws.freshSkills().some((s) => s.userInvocable && s.name === c.name)) return undefined;
        // An MCP server's prompt.
        if (c.name.startsWith("mcp__") && this.ws.mcp.promptCommands().some((p) => p.command === c.name)) return undefined;
        // One the session's agent CLI runs itself (Claude Code's /code-review, a skill).
        const provider = this.agent?.model.provider;
        const commands = this.engine.cliCommands(provider, this.ws.cwd);
        // Until this workspace has reported its skills, let Claude Code resolve them.
        if ((provider === "claude-code" && commands === undefined) || commands?.has(c.name)) return undefined;
        return c.name;
    }

    /** /trust: the folder trusted by the user (saved), not for this session only; that turns on what needs it (diagnostics after edits). */
    private async trustCommand() {
        const cwd = this.ws.cwd;
        if (trustedByUser(cwd)) return this.notice(`You've trusted ${cwd}.`);
        await this.engine.trustProject(cwd, true);
        this.notice(trustedByUser(cwd) ? `Trusted ${cwd}. Diagnostics after edits are on for it.` : `Trusted ${cwd} for this run only.`, trustedByUser(cwd) ? "info" : "warn");
    }

    /** `admitted`: its UserPromptSubmit hooks went already, with what they added (Queued.admitted). */
    private async dispatch(text: string, attachments?: AttachedPart[], literal = false, admitted?: { context?: string }) {
        if (literal) return this.startTurn(text, { attachments, admitted });
        const trimmed = text.trim();
        if (trimmed.startsWith("!") && !attachments?.length) return this.runUserShell(trimmed.slice(1).trim());
        if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
            const [, name = "", args = ""] = trimmed.match(/^\/(\S+)\s*([\s\S]*)$/) ?? [];
            const cmd = name.toLowerCase();
            if (cmd === "compact") return void (await this.compact(args.trim() || undefined));
            if (cmd === "loop") {
                const r = this.schedules.loop(args);
                return this.notice(r.text, r.level ?? "info");
            }
            if (cmd === "schedules") {
                const r = this.schedules.manage(args) ?? { text: this.scheduleList() };
                return this.notice(r.text, r.level ?? "info");
            }
            if (cmd === "goal") return this.nativeGoals() ? this.startTurn(trimmed, { display: trimmed, kind: "command", attachments }) : this.goalCommand(args, attachments);
            if (cmd === "trust") return this.trustCommand();
            if (cmd === "init") return this.startTurn(INIT_PROMPT, { display: "/init", kind: "command", attachments });
            if (cmd === "review") return this.startTurn(reviewPrompt(args.trim()), { display: `/review${args.trim() ? ` ${args.trim()}` : ""}`, kind: "command", attachments });
            const skill = this.ws.skills.find((s) => s.userInvocable && s.name === cmd);
            const provider = this.agent?.model.provider;
            // A bare name finds a plugin's command only when nothing else has it: a command, a skill, or one of the agent CLI's own.
            const custom = this.ws.commands.find((c) => c.name === cmd) ?? (skill || this.engine.cliCommands(provider, this.ws.cwd)?.has(cmd) ? undefined : pluginCommandFor(this.ws.commands, cmd));
            // Claude Code loads the plugins itself, so it runs their commands (by full name) with its own handling.
            if (custom?.source === "plugin" && runsPluginCommand(provider, custom.name, this.engine.cliCommands(provider, this.ws.cwd))) return this.startTurn(`/${custom.name}${args.trim() ? ` ${args.trim()}` : ""}`, { display: trimmed, attachments });
            if (custom) return this.startTurn(expandCommand(custom.body, args.trim()), { display: trimmed, kind: "command", attachments });
            const about = skill && `${skill.description}${args.trim() ? `: ${args.trim()}` : ""}`;
            // Claude Code and Codex run skills themselves, with their own handling (allowed-tools and the rest): they're sent the /name.
            if (skill && cliRunsSkills(provider)) return this.startTurn(trimmed, { attachments, about });
            if (skill) {
                const body = formatSkill(skill, args.trim());
                if (body === undefined) return this.notice(`The ${skill.name} skill is gone: ${skill.file} can't be read.`, "error");
                return this.startTurn(body, { display: trimmed, kind: "command", attachments, mentionsIn: args.trim(), about });
            }
            if (cmd.startsWith("mcp__") && this.ws.mcp.promptCommands().some((p) => p.command === cmd)) return this.runMcpPrompt(cmd, args, trimmed, attachments);
        }
        return this.startTurn(text, { attachments, admitted });
    }

    /** An MCP server's prompt as a slash command: fetched (it may ask the user something first), then sent as the prompt. */
    private async runMcpPrompt(command: string, args: string, display: string, attachments?: AttachedPart[]) {
        // Busy while it's fetched, as a turn is: a message sent meanwhile queues, and Stop cancels it.
        this.busy = true;
        const ac = (this.abort = new AbortController());
        this.setState({ busy: true, status: "running", activity: { label: `Getting /${command}`, since: Date.now() } });
        let r: { text: string; images: AttachedPart[] } | undefined;
        try {
            r = await this.ws.mcp.runPrompt(command, args.trim(), this.mcpAsker(), ac.signal);
            if (ac.signal.aborted) r = undefined;
        } catch (e) {
            if (!ac.signal.aborted) this.notice(redact((e as Error).message), "error");
        } finally {
            this.busy = false;
            this.abort = undefined;
            this.setState({ busy: false, activity: undefined });
            this.setStatus(this.pending.size ? "waiting" : "idle");
        }
        if (!r) {
            // The message goes back to the composer, as an interrupted one does, with what was queued after it.
            const back = [{ text: display, attachments }, ...this.queued];
            this.queued = [];
            if (back.length > 1) this.queueUpdated();
            this.engine.draft(this, back.map((q) => q.text).filter((t) => t.trim()).join("\n\n"), back.flatMap((q) => q.attachments ?? []));
            return;
        }
        // What the server wrote isn't the user's: only the arguments they typed attach files or resources.
        return this.startTurn(r.text, { display, kind: "command", attachments: [...(attachments ?? []), ...r.images], mentionsIn: args });
    }

    /** `about`: what to name the session after, when the text sent isn't the best guide (a skill's instructions). */
    /** `mentionsIn`: the part of `text` the user wrote, whose @mentions attach files and MCP resources (a skill's or an MCP prompt's text is sent as written). */
    /** `goal`: a turn the goal started (src/agent/goal.ts). */
    /** `adopt`: a wake turn its agent CLI started by itself (AgentHost.wake): nothing is sent, the turn takes its events. */
    async startTurn(text: string, opts: { display?: string; kind?: "prompt" | "command" | "wake"; attachments?: AttachedPart[]; about?: string; mentionsIn?: string; wakes?: Wake[]; goal?: boolean; adopt?: BackendWake; admitted?: { context?: string } } = {}) {
        // The user's own turn overtakes a pending goal check, and a paused goal picks up after it. A scheduled prompt
        // leaves a paused goal paused; the resume after a usage limit is the exception, as in Claude Code.
        // A watch's events don't either: they aren't the user's.
        if (!opts.goal && opts.kind !== "wake" && (!this.scheduledLabel || this.scheduledResume)) this.goal.userTurn();
        // This turn's end decides for the goal.
        this.goalOwed = undefined;
        if (!this.agent) {
            await this.ready.catch(() => undefined);
            if (this.closed) return;
            if (!this.agent) {
                this.notice("No model is selected. Add an API key in Settings → Providers, then pick a model.", "error");
                return;
            }
        }
        // The session's CLI account was removed (#410): nothing is stored or sent. A message of the user's that gets
        // here (a command's prompt) waits for an account as one sent does; a watch's events go back in their queue.
        const gone = opts.adopt ? undefined : this.needsAccount();
        if (gone) {
            if (opts.wakes) return void this.toolState.wakes?.requeue(opts.wakes);
            if (!opts.goal && !this.scheduledLabel && opts.kind !== "wake") return this.holdForAccount(gone, { text: opts.display ?? text, attachments: opts.attachments });
            return this.notice(removedAccountNote(getProvider(gone.provider)?.name ?? gone.provider, gone.id, false), "warn");
        }
        this.checkCommitting();
        const agent = this.agent;
        this.busy = true;
        // A CLI's goal shows as waiting for the user while no turn runs: a turn starting (the goal's next, Codex's
        // own, adopted here) makes it active again (#431). The goal's own events may not come until the turn ends.
        if (this.nativeGoal) this.goalChanged();
        this.idleCompact.disarm();
        const scheduled = this.scheduledLabel;
        this.scheduledLabel = undefined;
        // The user's own turn: a resume waiting for the usage limit isn't needed.
        if (!scheduled) this.schedules.userSent();
        let settled!: () => void;
        this.turnDone = new Promise<void>((r) => (settled = r));
        const ac = (this.abort = new AbortController());
        this.turnStartedAt = Date.now();
        this.worked(this.turnStartedAt);
        const display = opts.display ?? text;
        const index = this.session.messages.length;
        this.turnSnapshotFloor = this.latestCheckpoint();
        // No imagesKey yet: @mentioned images join the prompt's own once mentions are expanded below.
        const attached = attachedPrompt(opts.attachments, false);
        const turn: Turn = {
            id: this.newId(),
            prompt: { text: display, ...attached, ...(opts.kind === "command" ? { command: true } : {}), ...(scheduled ? { scheduled } : {}), ...(opts.kind === "wake" ? { wake: true } : { index }) },
            blocks: [],
            status: "running",
            startedAt: this.turnStartedAt,
            pos: { seg: this.segment, index },
        };
        this.op({ op: "turn", turn });
        this.turnId = turn.id;
        this.runStart = index;
        this.pendingPrompt = { seg: this.segment, index };
        if (this.backendModel()) this.backendTurns.set(turn.id, this.segment);
        this.responseBlocks = [];
        this.responseTurn.clear();
        this.uiTurn = { seg: this.segment, index, at: this.turnStartedAt };
        this.ui.write({ t: "turn", ...this.uiTurn });
        // The mode and effort it's sent with, once the session is going to be on disk.
        if (this.ui.state.mode !== this.mode || this.ui.state.effort !== this.effort) this.recordState({ force: true });
        this.setState({ busy: true, status: "running", activity: { label: "Thinking", since: this.turnStartedAt } });
        this.engine.sessionChanged(this);
        // The prompt's bubble goes out now, not with the next batch: the user is waiting to see it.
        this.flush();
        // A command's own text says more than "/init"; a greeting says nothing, so a later prompt names it.
        // A goal's turns are about its condition, not the instructions around it.
        const about = opts.about ?? (opts.goal ? (this.goal.condition ?? display) : reviewGist(opts.kind === "command" ? text : display));
        if (opts.kind !== "wake" && !this.session.title && !this.titleAsked && this.titleTries < TITLE_TRIES && titleWorthy(about)) void this.generateTitle(about);

        let reason: TurnEndReason | undefined;
        try {
            if (!this.session.meta.system) await this.freezeSystemPrompt(ac.signal);
            if (ac.signal.aborted) {
                // Nothing was sent: a message goes back to the input box; events go back in their queue.
                if (opts.wakes) this.toolState.wakes?.requeue(opts.wakes);
                // The CLI's own turn goes on without it: nothing is put back.
                else if (!opts.adopt) this.engine.draft(this, display, opts.attachments);
                reason = "aborted";
                this.endTurn("aborted");
            } else {
                const parts = await this.preparePrompt(text, opts, ac.signal);
                // The images as they'll be kept, mentioned ones too: what promptImages returns, so what the key is of.
                const images = parts.filter((p): p is AttachedPart => p.type === "image");
                this.pendingPrompt = { seg: this.segment, index, attachments: images };
                if (images.length) this.op({ op: "turn.patch", turnId: turn.id, patch: { prompt: { ...turn.prompt!, ...attachedPrompt(images) } } });
                reason = await agent.run(parts, { signal: ac.signal, display, kind: opts.kind, ...(opts.adopt ? { adopt: opts.adopt } : {}), admitted: opts.admitted });
            }
        } catch (e) {
            const message = `Unexpected error: ${redact((e as Error).message)}`;
            this.session.recordNotice("error", message);
            this.notice(message, "error");
            reason = "error";
            this.endTurn("error");
        } finally {
            this.busy = false;
            this.abort = undefined;
            this.runStart = undefined;
            this.pendingPrompt = undefined;
            this.cancelInteractions({ keepDelegated: true, keepBackground: true });
            this.closeOpen();
            this.turnId = undefined;
            // Nothing the run steered in comes back once it's over (AgentHost.unsteered).
            this.steeredTurns.clear();
            this.setState({ busy: false, filesChanged: this.filesChanged(), activity: undefined, persisted: existsSync(this.session.path), todos: this.toolState.todos.map((t) => ({ ...t })) });
            this.setStatus(reason === "error" ? "error" : this.pending.size ? "waiting" : "idle");
            // A CLI's goal shows as waiting for the user once its turn is over.
            if (this.nativeGoal) this.goalChanged();
            this.flush();
            this.engine.sessionChanged(this);
            settled();
        }
        const elapsed = Date.now() - this.turnStartedAt;
        const notify = () => {
            if (reason && reason !== "aborted" && (reason === "error" || elapsed >= notifyAfterMs(this.settings()))) {
                this.engine.notify(this, reason === "error" ? "error" : "done", reason === "error" ? "Stopped with an error" : `Finished in ${turnDuration(elapsed)}`);
            }
        };
        // While a goal keeps going its turns don't each notify: the goal says when it stops (GoalHost.alert).
        if (!(this.goal.active && this.goal.view()?.state !== "paused")) notify();
        if (reason && !this.closed) this.schedules.turnEnded(reason, agent.limitStop);
        const queued = Boolean(this.nextQueued());
        if (ac.signal.aborted) void this.goal.afterTurn("aborted", index, Boolean(opts.goal));
        // What was queued goes first. If none of it is a turn (a !command, /compact), the goal takes this turn's end after it.
        else if (queued && reason) this.goalOwed = { reason, from: index, goal: Boolean(opts.goal), startedAt: this.turnStartedAt };
        await this.runQueued(ac.signal.aborted);
        // Nothing the user sent is waiting: the goal decides whether another turn starts.
        if (!ac.signal.aborted && !queued && reason && !this.closed) await this.goal.afterTurn(reason, index, Boolean(opts.goal), this.turnStartedAt);
        this.schedules.poke();
        // Nothing followed it: from here the conversation is idle.
        if (!this.busy && !this.closed) this.idleCompact.arm();
    }

    /**
     * A prompt as it's sent: $names bring their skills, @mentions attach files and MCP resources (not a wake's:
     * it quotes outside text), then what was attached to it. The user is told what was used and attached.
     */
    private async preparePrompt(text: string, opts: { kind?: "prompt" | "command" | "wake"; attachments?: AttachedPart[]; mentionsIn?: string }, signal: AbortSignal, say: (text: string, level: "info" | "warn") => void = (t, l) => this.notice(t, l)): Promise<UserContent[]> {
        const roots = [this.ws.cwd, ...(this.settings().permissions?.additionalDirectories ?? [])];
        // $name brings that skill's instructions along; the transcript keeps what was typed.
        const skills = opts.kind === "command" || opts.kind === "wake" ? [] : skillMentions(text, this.ws.skills);
        // A wake quotes outside text (PR comments): its @words are not files or MCP resources to attach.
        const scan = opts.kind === "wake" ? "" : (opts.mentionsIn ?? text);
        const { parts, attached, notices } = opts.kind === "wake" ? { parts: [{ type: "text" as const, text }], attached: [], notices: [] } : await expandMentions(scan, this.toolState, roots, this.checker);
        // Claude Code and Codex are sent the $name, and load the skill themselves.
        parts[0] = { type: "text", text: skills.length && !cliRunsSkills(this.agent?.model.provider) ? withSkills(text, skills) : text };
        if (skills.length) say(`Using ${skills.length === 1 ? "skill" : "skills"} ${skills.map((s) => s.name).join(", ")}`, "info");
        const res = await expandMcpMentions(scan, this.ws.mcp, this.mcpAsker(), signal);
        parts.push(...res.parts);
        attached.push(...res.attached);
        notices.push(...res.notices);
        for (const n of notices) say(n, "warn");
        if (attached.length) say(`Attached ${attached.join(", ")}`, "info");
        if (opts.attachments?.length) {
            this.attachmentWarnings(opts.attachments, say);
            parts.push(...opts.attachments);
        }
        return parts;
    }

    /** What the session's model may not take of what's attached to a prompt, or to a message steering a turn. */
    private attachmentWarnings(attachments: readonly AttachedPart[], say: (text: string, level: "info" | "warn") => void) {
        if (this.model?.supportsImages === false && attachments.some((a) => a.type === "image")) say(`${this.model.name ?? this.model.id} can't read images: it's told one was attached, not what's in it.`, "warn");
        // Checked when it was sent; the model may have changed while it waited in the queue.
        if (this.model && !readsPdf(this.model) && attachments.some((a) => a.type === "file" && a.kind === "pdf")) say(`${this.model.name ?? this.model.id} can't read PDFs: it's told one was attached, not what's in it.`, "warn");
    }

    /** The queue ran dry without starting a turn: the goal goes on from the turn that ended before it (or pauses, if it was stopped). */
    private async settleGoal(aborted: boolean) {
        const owed = this.goalOwed;
        if (!owed || this.busy || this.nextQueued() || this.closed) return;
        this.goalOwed = undefined;
        if (aborted) return this.goal.afterTurn("aborted", owed.from, owed.goal);
        await this.goal.afterTurn(owed.reason, owed.from, owed.goal, owed.startedAt);
    }

    /** /schedules in the GUI: the composer shows them too, with buttons. */
    private scheduleList(): string {
        const jobs = this.schedules.scheduler.list();
        if (!jobs.length) return NO_SCHEDULES;
        return ["Schedules (pause, run or delete them above the message box):", ...jobs.map((j) => `• ${jobLine(j)}`)].join("\n");
    }

    /** After a turn, a `!command` or a compaction: the next message sent meanwhile, or all of them back to the input box after an interrupt. */
    private async runQueued(aborted: boolean) {
        if (this.closed) return;
        if (aborted) {
            this.returnQueued();
            await this.settleGoal(true);
            // The /goal clear or pause that stopped the turn: now the CLI gets it.
            const after = this.afterStop;
            this.afterStop = undefined;
            if (after) await this.dispatch(after).catch((e) => this.notice(redact((e as Error).message), "error"));
            // A turn its agent CLI started by itself runs whatever the user stopped: it's taken now.
            if (this.adopts.length) this.wake();
            return;
        }
        const next = this.nextQueued();
        // Nothing the user sent is waiting: the goal decides whether another turn starts; then events a watch raised meanwhile can have theirs.
        if (!next) {
            await this.settleGoal(false);
            if (this.adopts.length) return this.wake();
            return this.toolState.wakes?.poke();
        }
        // The session's CLI account was removed meanwhile (#410): it waits for one, with what's behind it.
        const gone = this.runsHere(next) ? undefined : this.needsAccount();
        if (gone) {
            this.holdForAccount(gone);
            return this.settleGoal(false);
        }
        this.queued = this.queued.filter((q) => q !== next);
        this.queueUpdated();
        await this.dispatch(next.text, next.attachments, next.literal, next.admitted).catch((e) => this.notice(redact((e as Error).message), "error"));
        // Something that failed before it could hand on to the queue.
        await this.settleGoal(false);
    }

    /** After an interrupt, unsent messages go back to the input box instead of running. */
    private returnQueued() {
        if (!this.queued.length) return;
        const text = this.queued.map((q) => q.text).filter((t) => t.trim()).join("\n\n");
        this.engine.draft(this, text, this.queued.flatMap((q) => q.attachments ?? []));
        this.queued = [];
        this.queueUpdated();
    }

    /** What runs when the turn ends: the first message that isn't held. */
    nextQueued(): Queued | undefined {
        return this.queued.find((q) => !q.held && !q.sending);
    }

    private queueState() {
        return {
            queued: this.queued.map((q) => q.text),
            queueIds: this.queued.map((q) => q.id),
            queuedAttached: this.queued.map((q) => attachedLabel(q.attachments)),
            queuedModes: this.queued.map((q): QueuedMode => (q.held ? "held" : this.waits(q) ? "turn" : q.mode)),
            queuedWhy: this.queued.map((q) => (q.account ? this.heldWhy(q) : (this.waits(q) ?? ""))),
            // Messages wait for an account for the session's CLI (#410): the GUI asks for one.
            // Until one is picked: the account may be back (added again under its id), and picking it sends them.
            accountNeeded: this.queued.find((q) => q.account && q.account === this.model?.provider)?.account,
        };
    }

    /** Shown, and saved beside the transcript so a restart doesn't lose it. */
    private queueUpdated() {
        this.setState(this.queueState());
        if (this.session.persisted) saveQueue(this.session.path, this.id, this.queued.map(({ text, mode, attachments, literal, account }) => ({ text, mode, attachments, literal, ...(account ? { account } : {}) })));
    }

    /**
     * "Send now": a queued message steers the running turn instead of waiting
     * for its end; one held since a restart runs now (or, while a turn runs,
     * steers it or waits for it). False when it isn't in the queue any more.
     */
    sendQueuedNow(queueId: number): { sent: boolean; started?: boolean } | Promise<{ sent: boolean; started?: boolean }> {
        // After a model switch, as send() waits for one.
        if (this.switching) return this.switching.catch(() => undefined).then(() => this.sendQueuedNow(queueId));
        const q = this.queued.find((x) => x.id === queueId);
        if (!q) return { sent: false };
        if (!this.busy) {
            // What send() checks, before it leaves the queue: a refused one stays there.
            this.checkCommitting();
            if (this.closed) throw new Error("This session was closed.");
            this.checkPdfs(q.attachments);
            // The session's CLI account was removed (#410): it stays, held for one, and the user is told why.
            const gone = this.runsHere(q) ? undefined : this.needsAccount();
            if (gone) {
                // One held since a restart too: the user sent it, so it goes once they pick an account.
                Object.assign(q, { held: true, account: gone.provider });
                this.holdForAccount(gone, undefined, false);
                throw new RpcError(removedAccountNote(getProvider(gone.provider)?.name ?? gone.provider, gone.id), "account_removed");
            }
            this.queued = this.queued.filter((x) => x !== q);
            this.queueUpdated();
            void this.dispatch(q.text, q.attachments, q.literal, q.admitted).catch((e) => this.notice(redact((e as Error).message), "error"));
            return { sent: true, started: true };
        }
        const why = this.waits(q);
        if (why) {
            if (!q.held) throw new RpcError(why, "not_steerable");
            q.held = undefined;
            this.queueUpdated();
            return { sent: true };
        }
        q.held = undefined;
        q.mode = "steer";
        this.queueUpdated();
        this.agent?.queueChanged();
        return { sent: true };
    }

    /** Move a queued message to position `to` (0 is next). False when it isn't in the queue any more. */
    moveQueued(queueId: number, to: number): boolean {
        const i = this.queued.findIndex((q) => q.id === queueId);
        if (i < 0) return false;
        const [q] = this.queued.splice(i, 1);
        this.queued.splice(Math.max(0, Math.min(this.queued.length, Math.trunc(to))), 0, q!);
        this.queueUpdated();
        return true;
    }

    /** Out of the queue, by its id (a message the queue has moved past isn't there any more). */
    dequeue(queueId: number): Queued | undefined {
        const i = this.queued.findIndex((q) => q.id === queueId);
        if (i < 0) return undefined;
        // On its way into the turn: whether it goes is the CLI's to say, in a moment (taken out then, or left here).
        if (this.queued[i]!.sending) throw new RpcError("This message is going into the running turn right now. Edit or remove it once it has gone in, or comes back.", "sending");
        const [q] = this.queued.splice(i, 1);
        this.queueUpdated();
        return q;
    }

    /** Events a tool asked to be woken for (a watched PR): a turn of their own when nothing else is going on. */
    private wake() {
        // Looked at again later: the turns a CLI started itself (adopts) are looked for here, not in the
        // WakeQueue, whose poke does nothing without events of its own.
        const again = () => (this.adopts.length ? this.wake() : this.toolState.wakes?.poke());
        // An idle compaction stops: the wake runs on the cache that's still warm, not after a summary nobody asked for.
        if (this.idleCompacting) return void this.yieldIdleCompaction().then(again);
        // Busy or with messages queued, the turn's end looks again (runQueued). Messages held back (after a stop or
        // a restart) don't hold up a CLI's own turn: it's running already, whatever the user sends next.
        if (this.closed || this.busy || (this.adopts.length ? this.nextQueued() : this.queued.length)) return;
        // The session's CLI account was removed (#410): nothing runs until the user picks another (releaseForAccount looks again).
        if (this.needsAccount()) return;
        // A model switch, a commit, the agent still starting, a goal between its turns (it goes first, as with
        // scheduled prompts): look again in a moment.
        if (this.switching || this.commitDone || !this.agent || this.goal.pending()) {
            const t = setTimeout(again, 1000);
            t.unref?.();
            return;
        }
        // A turn an agent CLI started by itself goes first: it's running already, its events held until it's taken.
        const adopt = this.adopts.shift();
        if (adopt) {
            const label = adopt.label?.trim() || `${getProvider(adopt.provider)?.name ?? adopt.provider} reported back`;
            // One answering the user's message (sent at once on Esc) is their prompt; others are wakes.
            void this.startTurn(label, { display: label, kind: adopt.prompt ? "prompt" : "wake", adopt }).catch((e) => this.notice(redact((e as Error).message), "error"));
            return;
        }
        const wakes = this.toolState.wakes!.takeForTurn();
        if (!wakes.length) return;
        void this.startTurn(formatWakes(wakes), { display: wakeDisplay(wakes), kind: "wake", wakes }).catch((e) => this.notice(redact((e as Error).message), "error"));
    }

    /** Turns agent CLIs started by themselves, waiting for the session to be free to adopt them (wake). */
    private adopts: BackendWake[] = [];

    /** Agent CLIs whose process for this session an account change is letting go of (setAccount), with how many such releases are under way. */
    private releasing = new Map<string, number>();

    /** An agent CLI started a turn by itself: it becomes a wake turn of this session's, when it's free. */
    adoptWake(w: BackendWake) {
        if (this.closed) return;
        // From the process an account change is letting go of: not taken over under the new account.
        if (this.releasing.has(w.provider)) return this.dropAdopt(w);
        this.adopts.push(w);
        this.wake();
    }

    /**
     * A turn a CLI started by itself, in the process an account change lets go of (#408): it isn't taken over. What
     * it reported is shown and told to the model (Agent.dropAdopt), as when the session can't take one over (#305).
     * One answering the user's message, sent at once on Esc, was taken out of the queue then: the message goes back
     * to the message box, as one an interrupt kept from going does (returnQueued).
     */
    private dropAdopt(w: BackendWake) {
        this.adopts = this.adopts.filter((x) => x !== w);
        if (!w.prompt) return void this.agent?.dropAdopt(w);
        if (!w.label?.trim()) return;
        this.engine.draft(this, w.label, []);
        const message = `${getProvider(w.provider)?.name ?? w.provider} was restarted for the account change before it answered your message. It's back in the message box, to send again.`;
        this.session.recordNotice("warn", message);
        this.notice(message, "warn");
    }

    interrupt() {
        // Stopped by the user: what watches wake it again only once they send something.
        if (this.abort) this.toolState.wakes?.pause();
        // Esc stops the answer: a background sub-agent's prompt isn't the answer's.
        this.cancelInteractions({ keepBackground: true });
        if (this.abort) {
            // Esc with a message sent meanwhile: a backend that can sends it at once in place of the turn it stops
            // (Claude Code's send-now, which spares its background sub-agents); its turn comes back as the user's.
            // Only with the first Esc: once the stop is under way, nothing would send another.
            // Not one naming an MCP resource (@server:uri): sent now, it would go as typed, without the resource,
            // which only a prompt of Cavvy's attaches.
            const servers = [...this.ws.mcp.servers.keys()];
            const q = this.abort.signal.aborted ? undefined : this.queued.find((x) => !x.held && !isCommand(x) && !x.attachments?.length && x.text.trim() && !findMcpMentions(x.text, servers).length);
            if (q && this.agent?.sendNow(q.text)) {
                this.queued = this.queued.filter((x) => x !== q);
                this.queueUpdated();
            }
            this.abort.abort();
            this.activity("Interrupting");
        } else {
            // Between goal turns (a check or a retry coming), stop pauses the goal.
            if (this.goal.pending()) this.goal.pause("Stopped. It continues after your next message, or /goal resume.");
            this.returnQueued();
        }
    }

    private async freezeSystemPrompt(signal: AbortSignal) {
        // Give MCP servers a moment so their instructions make it into the prompt.
        const connecting = () => [...this.ws.mcp.servers.values()].some((s) => s.status === "connecting" || s.status === "pending");
        if (connecting()) {
            this.activity("Connecting MCP servers");
            const until = Date.now() + 5000;
            while (connecting() && Date.now() < until && !signal.aborted) await new Promise((r) => setTimeout(r, 100));
        }
        if (signal.aborted) return;
        // Stopped (or closed) while its git snapshot is read: the turn ends now, not when git is done; the prompt is built again next time.
        let stop!: () => void;
        const stopped = new Promise<undefined>((r) => signal.addEventListener("abort", (stop = () => r(undefined)), { once: true }));
        try {
            const system = await Promise.race([buildSystemPrompt({ cwd: this.ws.cwd, model: this.model!, append: this.ws.mcp.instructions() || undefined, signal }), stopped]);
            if (system !== undefined && !signal.aborted && !this.closed) this.session.setSystem(system);
        } finally {
            signal.removeEventListener("abort", stop);
        }
    }

    private async generateTitle(prompt: string) {
        if (!this.client) return;
        this.titleAsked = true;
        this.titleTries++;
        // Redacted before it's cut or capitalized: then a key in it no longer looks like one.
        this.titleFrom ??= redact(prompt);
        let title: string | undefined;
        // Claude Code and Codex answer it as a one-off (backends/one-off.ts), on their light model.
        try {
            const raw = await this.complete(
                "You name coding-assistant sessions for a sidebar. Reply with only the title: 2 to 6 words, sentence case, no quotes, no trailing punctuation. Describe the task, not the user.",
                // Cut after redacting, so a registered value crossing the cut can't leave a prefix.
                redactPrefix(prompt, 3000),
                // A CLI starts a process of its own for it: a few seconds more than an API call.
                AbortSignal.any([AbortSignal.timeout(45_000), (this.titleAbort = new AbortController()).signal]),
            );
            title = raw
                .replace(/<[^>]*>/g, "")
                .split("\n")
                .map((l) => l.trim())
                .find(Boolean)
                ?.replace(/^(session\s+)?(title|name):\s*/i, "")
                .replace(/^["'`*#\s]+|["'`*.\s]+$/g, "")
                .slice(0, 60);
            // Not a title: the prompt said back, or a paragraph.
            if (title && title.split(/\s+/).length > 10) {
                this.engine.log(`session ${this.id}: the title it got was the prompt said back, or a paragraph`);
                title = undefined;
            }
        } catch (e) {
            this.engine.log(`session ${this.id}: no title (try ${this.titleTries} of ${TITLE_TRIES}): ${(e as Error).message}`);
        }
        // The last try failed too: the first prompt that said something names it.
        if (!title && this.titleTries >= TITLE_TRIES) title = promptTitle(this.titleFrom);
        if (title && !this.session.title) this.rename(title);
        // Until one comes, the sidebar shows the first prompt; a later prompt asks again.
        else if (!title) this.titleAsked = false;
    }

    /** `!command` from the input box: the user runs it themselves; the model sees it with the next prompt. */
    private async runUserShell(command: string) {
        if (!command) return;
        this.busy = true;
        this.idleCompact.disarm();
        const ac = (this.abort = new AbortController());
        const turn: Turn = { id: this.newId(), prompt: { text: `!${command}` }, blocks: [], status: "running", startedAt: Date.now() };
        this.op({ op: "turn", turn });
        this.turnId = turn.id;
        const blockId = this.newId();
        this.op({ op: "block", turnId: turn.id, block: { t: "shell", id: blockId, command, output: "", running: true } });
        this.setState({ busy: true, status: "running", activity: { label: "Running", since: Date.now(), detail: command.slice(0, 80) } });
        this.worked(turn.startedAt!);
        this.engine.sessionChanged(this);
        this.flush();
        let status: TurnStatus = "done";
        const lines = lineRedactor();
        try {
            const res = await runShell({
                command,
                cwd: this.toolState.cwd,
                timeoutMs: 120_000,
                signal: ac.signal,
                env: childEnv(this.settings().env),
                // Line by line (the rest comes with the full output at the end).
                onData: (chunk) => {
                    const ready = lines(chunk);
                    if (ready) this.op({ op: "append", turnId: turn.id, blockId, field: "output", text: ready });
                },
            });
            const out = redact(res.output.replace(/\s+$/, ""));
            this.op({ op: "block.patch", turnId: turn.id, blockId, patch: { output: out.slice(-24_000) || "(no output)", exitCode: res.exitCode, running: false } });
            if (res.newCwd && res.newCwd !== this.toolState.cwd) {
                const from = this.toolState.cwd;
                this.toolState.cwd = res.newCwd;
                void this.agent?.cwdChanged(from);
            }
            if (res.aborted) status = "aborted";
            const text = `<bash-input>${command}</bash-input>\n<bash-stdout>${out.slice(0, 20_000)}</bash-stdout>${res.exitCode ? `\n<bash-exit-code>${res.exitCode}</bash-exit-code>` : ""}`;
            this.agent?.addReminder(`The user ran a shell command themselves (output shown to them):\n${text}`);
        } catch (e) {
            status = "error";
            this.op({ op: "block.patch", turnId: turn.id, blockId, patch: { output: redact((e as Error).message), running: false, exitCode: null } });
        } finally {
            this.op({ op: "turn.patch", turnId: turn.id, patch: { status, endedAt: Date.now() } });
            this.busy = false;
            this.abort = undefined;
            this.turnId = undefined;
            this.setState({ busy: false, activity: undefined });
            this.setStatus("idle");
            this.flush();
        }
        await this.runQueued(ac.signal.aborted);
        if (!this.busy && !this.closed) this.idleCompact.arm();
    }

    async compact(instructions?: string, opts: { idle?: boolean } = {}) {
        const idle = Boolean(opts.idle);
        // On the model being switched to, as a prompt would be.
        while (this.switching) await this.switching.catch(() => undefined);
        this.checkCommitting();
        if (this.closed) throw new Error("This session was closed.");
        // A /compact of the user's own takes over from an idle one.
        if (!idle) await this.yieldIdleCompaction();
        if (this.busy) throw new Error("Wait for the current response to finish, or interrupt it first.");
        if (!this.agent) throw new Error("No model is selected.");
        if (this.session.messages.length < 2) throw new Error("Nothing to compact yet.");
        this.idleCompact.disarm();
        this.busy = true;
        this.idleCompacting = idle;
        let done!: () => void;
        if (idle) this.idleDone = new Promise<void>((r) => (done = r));
        const ac = (this.abort = new AbortController());
        const activity = idle ? { label: "Compacting while idle", since: Date.now(), detail: "The prompt cache is about to expire. Send a message to cancel.", idle: true } : { label: "Compacting conversation", since: Date.now() };
        // Idle, it isn't "working" in the sidebar: nothing the user started.
        this.setState(idle ? { busy: true, activity } : { busy: true, status: "running", activity });
        // Not the user's doing: the session doesn't move up the sidebar for it.
        if (!idle) this.worked(Date.now());
        this.engine.sessionChanged(this);
        try {
            await this.agent.compact({ auto: idle, signal: ac.signal, instructions, idle });
        } catch (e) {
            if (!ac.signal.aborted) {
                // An idle one leaves the conversation as it was: worth a word, not an alarm.
                if (idle) this.notice(`Couldn't compact while idle: ${redact((e as Error).message)}. The conversation is unchanged.`, "warn");
                else this.notice(`Compaction failed: ${redact((e as Error).message)}`, "error");
            }
        } finally {
            this.busy = false;
            this.idleCompacting = false;
            this.abort = undefined;
            this.setState({ busy: false, activity: undefined });
            if (!idle) this.setStatus("idle");
            done?.();
        }
        // Not awaited: session.compact answers once the compaction is done, not after the next turn.
        // An idle compaction a message cancelled runs that message rather than handing it back.
        void this.runQueued(ac.signal.aborted && !(idle && this.queued.length));
    }

    // -----------------------------------------------------------------------
    // Rewind and changes

    rewindTargets(): RewindTargetInfo[] {
        const history = FileHistory.for(this.session);
        return rewindTargets(this.session.messages)
            .reverse()
            .map((t) => ({ index: t.index, text: t.text, tracked: Boolean(history && t.checkpoint !== undefined), files: history && t.checkpoint !== undefined ? history.filesIn(t.checkpoint).length : 0, ...(t.backends.length ? { backends: t.backends } : {}), ...(this.beforeFork(t.index) ? { forked: true } : {}) }));
    }

    /** A prompt this session was forked with: the files changed before the fork are in the original's history, not here. */
    private beforeFork(index: number): boolean {
        return beforeFork(this.session.meta, this.session.messages[index], index);
    }

    // -----------------------------------------------------------------------
    // Forking

    /**
     * Where a fork from the turn of the prompt at `index` ends (session.fork),
     * checked against what the window showed: that turn (by id, which is new
     * once a rewind rebuilds the timeline) with this prompt and its text.
     */
    forkPoint(index: unknown, text: string, turnId: string): number {
        if (typeof index !== "number" || !Number.isInteger(index)) throw new RpcError("index must be an integer");
        if (!forkTargets(this.session.messages).some((t) => t.index === index)) throw new RpcError("That isn't one of this conversation's prompts (one from before a compaction can't be forked from).");
        if (this.runStart !== undefined && index >= this.runStart) throw new RpcError("That turn is still running. Fork from it once it's done, or interrupt it first.", "busy");
        const shown = this.view.turns.find((t) => t.id === turnId);
        const shownIndex = shown?.imported ? shown.pos?.index : shown?.prompt?.index;
        if (!shown || shown.archived || shownIndex !== index || shown.prompt?.text !== text) throw new RpcError("The conversation changed since this was shown; nothing was forked.", "stale");
        return Math.min(forkCut(this.session.messages, index), this.runStart ?? Infinity);
    }

    /** Notes that were pending at a fork's cut: they went out with the prompt there (as a rewind to it would queue them again). */
    notesAt(cut: number): string[] {
        const next = this.session.messages[cut];
        return next?.role === "user" ? promptNotes(next) : [];
    }

    /** Just forked: the notes pending at the cut go with the first prompt here, and so does the mode it has now. */
    forkedFrom(notes: string[]) {
        // A fork must keep its selected mode on reopen even with the default effort.
        this.recordState();
        if (!this.agent) return;
        for (const n of notes) this.agent.addReminder(n);
        if (this.mode === "plan") this.agent.noteModeChange("default", "plan");
        else this.agent.addReminder(`The permission mode is "${MODE_INFO[this.mode].label}": ${MODE_INFO[this.mode].description}`);
    }

    private target(index: number) {
        const t = rewindTargets(this.session.messages).find((x) => x.index === index);
        if (!t) throw new Error("That prompt can't be rewound to (it may have been compacted).");
        return t;
    }

    rewindPlan(index: number): RewindPlanInfo {
        const t = this.target(index);
        const history = FileHistory.for(this.session);
        const plan = history && t.checkpoint !== undefined ? history.plan(t.checkpoint) : undefined;
        const root = canonical(this.ws.cwd);
        const rel = (p: string) => displayPath(p, root);
        const planId = this.newId();
        this.rewindShown = { id: planId, index, message: this.session.messages[index]!, count: this.session.messages.length, plan };
        const backends = backendsIn(this.session.messages, index);
        return {
            index,
            planId,
            ...(this.beforeFork(index) ? { forked: true } : {}),
            ...(backends.length ? { backends } : {}),
            tracked: Boolean(plan),
            restore: (plan ?? []).filter((i) => i.action !== "skip").map((i) => ({ path: rel(i.path), action: i.action as "write" | "delete", outside: Boolean(i.outside) })),
            skipped: (plan ?? []).filter((i) => i.action === "skip").map((i) => ({ path: rel(i.path), reason: i.reason ?? "" })),
        };
    }

    /**
     * Restore what rewindPlan showed (`planId`), as the terminal's /rewind does:
     * a file changed since then is left alone (it fails, with the reason), and
     * nothing happens if the conversation moved on.
     */
    rewind(index: number, planId: string, code: boolean, conversation: boolean): { restored: string[]; failed: { path: string; error: string }[]; text: string; images?: { mediaType: string; data: string }[]; files?: WireFile[] } {
        this.checkCommitting();
        if (this.busy) throw new Error("Wait for the current response to finish, or interrupt it first.");
        const t = this.target(index);
        const shown = this.rewindShown;
        // A turn since (one running when it was shown, say) may have changed files the plan doesn't know about.
        if (!shown || shown.id !== planId || shown.index !== index || this.session.messages[index] !== shown.message || this.session.messages.length !== shown.count) {
            throw new Error("The conversation changed since this was shown; nothing was rewound. Open Rewind again.");
        }
        this.rewindShown = undefined;
        // What the prompt carried goes back to the box with its text: a pasted text exists nowhere else.
        const attached = shown.message.role === "user" ? shown.message.content.filter((p): p is AttachedPart => p.type === "image" || p.type === "file") : [];
        const history = FileHistory.for(this.session);
        const plan = shown.plan;
        const backends = backendsIn(this.session.messages, index);
        const restore = plan?.filter((i) => i.action !== "skip") ?? [];
        const skipped = plan?.filter((i) => i.action === "skip") ?? [];
        const root = canonical(this.ws.cwd);
        const rel = (p: string) => displayPath(p, root);
        let restored: string[] = [];
        let failed: { path: string; error: string }[] = [];
        let rewindConversation = conversation;
        if (code && restore.length) {
            const r = history!.restore(restore);
            restored = r.done.map(rel);
            failed = r.failed.map((f) => ({ path: rel(f.path), error: f.error }));
            const done = new Set(r.done);
            for (const p of [...this.toolState.fileState.keys()]) if (done.has(canonical(p))) this.toolState.fileState.delete(p);
            if (conversation && failed.length) rewindConversation = false;
            if (!rewindConversation && r.done.length) this.agent?.addReminder(`The user restored these files to how they were before an earlier prompt (/rewind), undoing the changes made to them since. Read them again before editing them:\n${restored.map((p) => `- ${p}`).join("\n")}`);
        }
        if (rewindConversation) {
            if (this.agent) this.agent.rewind(index);
            else {
                this.session.rewind(index);
                resetToolState(this.toolState, this.session.messages);
                this.classifier.clearCache();
            }
            const kept = [...(code ? [] : restore), ...skipped];
            if (kept.length) this.agent?.addReminder(`The user rewound the conversation to an earlier point (/rewind), but these files weren't restored and still have changes made after that point:\n${kept.map((it) => `- ${rel(it.path)}`).join("\n")}`);
            // What a backend changed was never tracked: all of it is still there.
            if (backends.length) this.agent?.addReminder(untrackedChangesNote(backends, restored));
            this.rebuild();
        }
        this.setState({ filesChanged: this.filesChanged(), todos: this.toolState.todos.map((x) => ({ ...x })), contextTokens: 0 });
        this.recordState();
        this.flush();
        this.engine.sessionChanged(this);
        return { restored, failed, text: t.text, ...toWire(attached) };
    }

    /** The timeline again from the transcript (after a rewind). */
    private rebuild() {
        const segments = readSegments(this.session.path);
        const turns = replay({ segments: segments.length ? segments : [{ messages: [] }], current: this.session.messages, currentNotices: this.session.notices, ui: this.ui, meta: (c) => this.toolMeta(c), newId: () => this.newId() });
        // Sub-agents whose calls are still there keep what was seen of them (their turns have new ids).
        const agents = agentsFromTurns(turns, this.model && modelRef(this.model), this.ui.agents).map((r) => {
            const live = this.view.agents.find((a) => a.id === r.id && !a.replayed);
            // One still working goes on being logged under its turn's new id.
            if (live && this.backendTurns.has(live.turnId)) this.backendTurns.set(r.turnId, this.segment);
            return live ? { ...live, turnId: r.turnId } : r;
        });
        // And the ones each kept one started of its own (its call is in that one's activity), in its turn.
        for (const a of this.view.agents) {
            const up = a.parentId ? agents.find((x) => x.id === a.parentId && !x.replayed) : undefined;
            if (up && !agents.some((x) => x.id === a.id)) agents.push({ ...a, turnId: up.turnId });
        }
        this.op({ op: "reset", turns, agents });
    }

    /**
     * What git says changed in the session's folder, whoever changed it; or, with `worktree`, in another
     * worktree of its repository (only one `git worktree list` reports: never any other folder).
     */
    async gitChanges(req: { scope: GitScope; base?: string; baseToken?: string; path?: string; pathToken?: string; turnId?: number; worktree?: string }): Promise<GitChangesInfo> {
        const { worktree, pathToken, baseToken, ...rest } = req;
        let other: { real: string; gitDir: string } | undefined;
        if (worktree !== undefined) {
            const w = await sessionWorktree(this.ws.cwd, worktree);
            if (!w.current) {
                // Turns are snapshots of the session's own folder.
                if (rest.scope === "turn" || rest.scope === "last-turn") throw new RpcError("Turns are recorded for this session's own folder only.", "invalid");
                other = w;
            }
        }
        // Names shown redacted come back as handles, for the folder they were listed in.
        const root = other?.real ?? this.ws.cwd;
        if (pathToken !== undefined) rest.path = this.gitHandles.resolve("path", root, pathToken);
        if (baseToken !== undefined) rest.base = this.gitHandles.resolve("ref", root, baseToken);
        try {
            const info = other ? await gitChanges(other.real, { scope: rest.scope, base: rest.base, path: rest.path }, undefined, { gitDir: other.gitDir }) : await gitChanges(this.ws.cwd, rest, TurnSnapshots.for(this.session, this.ws.cwd));
            return this.gitHandles.shown(info, root);
        } catch (e) {
            throw redactedError(e);
        }
    }

    /** Names this session showed redacted in Git changes, by their handles (GitHandles). */
    readonly gitHandles = new GitHandles();

    /** The files to commit: as named, and by handle (in the session's own folder). */
    private gitPaths(paths: string[], tokens: string[] = []): string[] {
        return [...paths, ...tokens.map((t) => this.gitHandles.resolve("path", this.ws.cwd, t))];
    }

    /** The worktrees of the session's repository, for the diff reader to look at. */
    worktrees(): Promise<SessionWorktreeInfo[]> {
        return sessionWorktrees(this.ws.cwd);
    }

    /** Its sub-agents, as the GUI has them. */
    get agentRuns(): readonly AgentRun[] {
        return this.view.agents;
    }

    private checkCommitting() {
        if (this.committing) throw new RpcError("Wait for the commit to finish before starting more work.", "busy");
    }

    private checkGitCommit(action = "committing") {
        if (!this.ws.trusted) throw new RpcError(action === "committing" ? "Trust this folder before committing: Git commits run the repository's hooks." : "Trust this folder before publishing: Git transports can run configured programs.", "needs_trust", this.ws.cwd);
        if (this.closed) throw new RpcError("This session was closed.", "busy");
        if (!this.settled(false)) throw new RpcError(`This session is still working. Wait for its responses, questions, shells, and tasks to finish before ${action}.`, "busy");
    }

    async gitCommit(paths: string[], message: string, expectedHead?: GitCommitHead, pathTokens?: string[]): Promise<GitCommitInfo> {
        await this.yieldIdleCompaction();
        this.checkGitCommit();
        const files = this.gitPaths(paths, pathTokens);
        let head = expectedHead;
        if (head?.branchToken !== undefined) {
            const { branchToken, ...rest } = head;
            head = { ...rest, branch: this.gitHandles.resolve("ref", this.ws.cwd, branchToken) };
        }
        this.committing = true;
        this.commitAbort = new AbortController();
        const done = gitCommit(this.ws.cwd, files, message, { expectedHead: head, signal: this.commitAbort.signal });
        this.commitDone = done;
        try {
            const info = await done;
            return { ...info, subject: redact(info.subject), ...(info.branch !== undefined ? { branch: redact(info.branch) } : {}) };
        } catch (e) {
            throw redactedError(e);
        } finally {
            this.committing = false;
            this.commitDone = undefined;
            this.commitAbort = undefined;
        }
    }

    async gitPublishInfo() {
        // ws.trusted may be implicit. git-publish audits transport config and
        // requires trustedByUser before any repository-controlled network helper.
        this.checkGitCommit("publishing");
        return gitPublishInfo(this.ws.cwd);
    }

    private prRead?: { at: number; promise: Promise<{ pr?: GitPrInfo }> };
    gitPrState() {
        if (!this.ws.trusted || this.closed) return Promise.resolve({});
        if (!this.prRead || Date.now() - this.prRead.at >= 60_000) {
            this.prRead = { at: Date.now(), promise: gitPrState(this.ws.cwd).then((pr) => ({ pr })) };
        }
        return this.prRead.promise;
    }

    async gitPublish(request: GitPublishRequest) {
        await this.yieldIdleCompaction();
        this.checkGitCommit("publishing");
        this.committing = true;
        this.commitAbort = new AbortController();
        const done = gitPublish(this.ws.cwd, request, this.commitAbort.signal);
        this.commitDone = done;
        try {
            const result = await done;
            this.prRead = { at: Date.now(), promise: Promise.resolve(result) };
            return result;
        } finally {
            this.committing = false;
            this.commitDone = undefined;
            this.commitAbort = undefined;
        }
    }

    async gitCommitMessage(paths: string[], pathTokens?: string[]): Promise<GitCommitMessageInfo> {
        await this.ready;
        this.checkGitCommit();
        const files = this.gitPaths(paths, pathTokens);
        if (!this.model || !this.client) throw new RpcError("Set a small model in Settings to generate messages.", "no_model");
        const target = await this.smallTarget();
        if (isAgentBackend(target.client)) throw new RpcError("Set a small model from another provider in Settings to generate messages.", "no_model");
        // The prompt redacts what it shows the model, names included.
        const prompt = await gitCommitPrompt(this.ws.cwd, files).catch((e) => { throw redactedError(e); });
        const message = await this.complete(COMMIT_MESSAGE_SYSTEM, prompt, AbortSignal.timeout(30_000), { target });
        if (!message.trim()) throw new RpcError("The model returned an empty commit message. Try again or write your own.");
        return { message, model: modelRef(target.model) };
    }

    changes(): ChangesInfo {
        const history = FileHistory.for(this.session);
        if (!history) return { files: [], added: 0, removed: 0, tracked: false };
        const root = canonical(this.ws.cwd);
        const files = [];
        let added = 0;
        let removed = 0;
        for (const o of history.originals()) {
            const rel = displayPath(o.path, root);
            if (o.skipped) {
                files.push({ path: rel, status: "modified" as const, added: 0, removed: 0, hunks: [], note: `No saved copy (${o.skipped})` });
                continue;
            }
            const beforeBuf = o.hash ? history.savedCopy(o.hash) : null;
            if (o.hash && !beforeBuf) {
                files.push({ path: rel, status: "modified" as const, added: 0, removed: 0, hunks: [], note: "The saved copy is missing" });
                continue;
            }
            let afterBuf: Buffer | null = null;
            try {
                afterBuf = existsSync(o.path) ? readFileSync(o.path) : null;
            } catch {
                afterBuf = null;
            }
            if (beforeBuf === null && afterBuf === null) continue;
            if (beforeBuf && afterBuf && beforeBuf.equals(afterBuf)) continue;
            const before = beforeBuf === null ? null : bufText(beforeBuf);
            const after = afterBuf === null ? null : bufText(afterBuf);
            if (before === undefined || after === undefined) {
                files.push({ path: rel, status: beforeBuf === null ? ("added" as const) : afterBuf === null ? ("deleted" as const) : ("modified" as const), added: 0, removed: 0, hunks: [], note: "Binary file" });
                continue;
            }
            const d = fileDiff(rel, before === null ? null : redact(before), after === null ? null : redact(after));
            added += d.added;
            removed += d.removed;
            files.push(d);
        }
        files.sort((a, b) => a.path.localeCompare(b.path));
        return { files, added, removed, tracked: true };
    }

    toolOutput(toolId: string): string {
        const find = (messages: Message[]) => {
            for (const m of messages) {
                if (m.role !== "user") continue;
                for (const p of m.content) if (p.type === "tool_result" && p.toolCallId === toolId) return p.content;
            }
            return undefined;
        };
        // From before a compaction, it's still in the transcript file (and still shown).
        const out = find(this.session.messages) ?? readSegments(this.session.path).reduce<string | undefined>((hit, seg) => hit ?? find(seg.messages), undefined);
        if (out === undefined) throw new Error("That output is no longer in the conversation.");
        return redact(out);
    }

    /** The images of the prompt at `pos` (Turn.pos), from before a compaction too. */
    promptImages(seg: number, index: number): { mediaType: string; data: string }[] {
        const messages = seg === this.segment ? this.session.messages : readSegments(this.session.path)[seg]?.messages;
        const m = messages?.[index];
        const pending = this.pendingPrompt;
        const parts = m?.role === "user" ? m.content : pending && pending.seg === seg && pending.index === index ? (pending.attachments ?? []) : undefined;
        if (!parts) throw new RpcError("That prompt is no longer in the conversation.", "not_found");
        return toWire(parts.filter((p): p is AttachedPart => p.type === "image")).images ?? [];
    }

    exportMarkdown(): string {
        const out: string[] = [`# ${this.session.title ?? "Session"} (${this.id})`, "", `- Directory: ${this.ws.cwd}`, `- Model: ${this.session.model ?? "?"}`, `- Exported: ${new Date().toISOString()}`, ""];
        for (const group of continuationGroups(this.session.messages)) {
            const msg = group[0]!;
            if (msg.role === "user") {
                const kind = msg.meta?.kind ?? "prompt";
                if (kind === "tool_results") {
                    for (const p of msg.content) if (p.type === "tool_result") out.push(`<details><summary>Result: ${p.toolName}${p.isError ? " (error)" : ""}</summary>`, "", "```", p.content.slice(0, 4000), "```", "</details>", "");
                    // A message the user steered with rides along with the results, with what was attached to it.
                    const steered = msg.content.flatMap((p) => (p.type === "text" && p.text.startsWith(STEERING) ? [p.text.slice(STEERING.length).trim()] : []));
                    const note = steered.length ? attachmentsNote(msg.content) : "";
                    if (steered.length) out.push("## User", "", ...steered, ...(note ? ["", `*${note}*`] : []), "");
                    continue;
                }
                const t = promptText(msg);
                const note = attachmentsNote(msg.content);
                if (t || note) out.push(kind === "summary" ? "## Summary of earlier conversation" : "## User", "", ...(t ? [t] : []), ...(note ? [`*${note}*`] : []), "");
            } else {
                const t = group.map(textOf).join("").trim();
                if (t) out.push("## Assistant", "", t, "");
                for (const part of group) for (const p of part.content) if (p.type === "tool_call") out.push(`**${p.name}** \`${JSON.stringify(p.input).slice(0, 300)}\``, "");
            }
        }
        return redact(out.join("\n"));
    }

    // -----------------------------------------------------------------------
    // Background shells

    private syncShells() {
        const shells = [...this.toolState.shells.values()].map((s) => ({
            id: s.id,
            command: redact(s.command).slice(0, 300),
            running: s.exitCode === null,
            exitCode: s.exitCode,
            startedAt: s.startedAt,
            ...(s.monitor ? { monitor: { description: redact(s.monitor.description), events: s.monitor.events, expiresAt: s.monitor.expiresAt } } : {}),
        }));
        const same = JSON.stringify(shells) === JSON.stringify(this.view.state.shells);
        if (!same) this.setState({ shells });
        this.syncBackground();
        const running = shells.some((s) => s.running);
        if (running && !this.shellTimer) this.shellTimer = setInterval(() => this.syncShells(), 2000);
        else if (!running && this.shellTimer) {
            clearInterval(this.shellTimer);
            this.shellTimer = undefined;
        }
    }

    /**
     * The session's background work as one list (src/agent/background.ts): kept in the session log, and
     * what's running (or stopped when Cavvy quit, until the agent's told) shown in the Background panel.
     */
    private syncBackground() {
        const bg = this.toolState.background;
        if (!bg || this.closed) return;
        const src = { delegated: this.agent?.delegatedTasks, shells: this.toolState.shells };
        // One that ended on its own is news, in this window or as a notification (the GUI decides which). Not with
        // the agentCli.liveSessions kill switch off: a delegated task's end is a transcript line then, as before.
        const news = bg.sync(src);
        if (this.settings().agentCli?.liveSessions !== false) for (const t of news) this.engine.notifyBackground(this, { ...t, label: redact(t.label).slice(0, 300) });
        const tasks = bg.shown(src).map((t) => ({ ...t, label: redact(t.label).slice(0, 300) }));
        if (JSON.stringify(tasks) !== JSON.stringify(this.view.state.backgroundTasks ?? [])) this.setState({ backgroundTasks: tasks });
        this.endAgentsGone(tasks);
    }

    /**
     * A sub-agent whose background task went with its CLI's process (it exited, or was stopped or restarted) before
     * the CLI said the agent ended: nothing of it runs any more, so its run is over too, stopped (#461 review).
     * Its calls still open never got a result.
     */
    private endAgentsGone(tasks: readonly BackgroundTaskInfo[]) {
        for (const t of tasks) {
            if (t.kind !== "agent" || t.status !== "stopped" || !(t.withProcess || t.lost) || !t.toolUseId) continue;
            const a = this.view.agents.find((x) => x.id === t.toolUseId && !x.replayed && (x.status === "running" || x.status === "waiting") && (t.endedAt === undefined || x.startedAt <= t.endedAt));
            if (!a) continue;
            for (const b of a.blocks) if (b.t === "tool" && (b.status === "running" || b.status === "streaming" || b.status === "queued" || b.status === "awaiting")) this.op({ op: "agent.block.patch", id: a.id, blockId: b.id, patch: { status: "error", summary: "Stopped with its process", progress: undefined } });
            this.agentEnded(a.id, "aborted");
        }
    }

    /** Restart the session's agent CLI process (/tasks restart): it didn't answer a stop, or new settings wait for its background work. */
    async restartCli(): Promise<void> {
        if (!(await this.agent?.restartBackend())) throw new RpcError("This session has no agent CLI process to restart.", "invalid");
        this.notice("Restarted the agent CLI's process. What it ran in the background was stopped.", "info");
        this.syncShells();
    }

    /** Stop background work from the panel or /tasks stop: these tasks, or every one running. How each went. */
    async stopBackground(ids?: string[]): Promise<Record<string, BackgroundStop>> {
        const agent = this.agent;
        const stop = async () => {
            if (agent) return agent.stopBackground(ids);
            // No agent (no model yet): only its shells can be running.
            const results: Record<string, BackgroundStop> = {};
            for (const id of ids ?? [...this.toolState.shells.values()].filter((s) => s.exitCode === null).map((s) => s.id)) {
                const sh = this.toolState.shells.get(id);
                // One that already ended (or whose process is already gone) keeps its own outcome.
                results[id] = !sh ? "unknown" : sh.exitCode !== null || (await sh.kill()) === "gone" ? "ended" : "stopped";
            }
            return results;
        };
        // The user's own stop: no notice when one it stopped ends (but one it couldn't stop ends as it ends).
        const asked = ids ?? (this.view.state.backgroundTasks ?? []).filter((t) => t.status === "running").map((t) => t.id);
        const bg = this.toolState.background;
        try {
            return bg ? await bg.userStop(asked, stop) : await stop();
        } finally {
            this.syncShells();
        }
    }

    /** The user cleared the finished tasks from the Background panel. */
    clearBackground() {
        this.toolState.background?.clearEnded();
        this.syncBackground();
    }

    /** The user stopped a watch from the panel: the agent hears of it with their next message. */
    stopWatch(watchId: string) {
        const w = this.toolState.watchers?.get(watchId);
        if (!w) throw new RpcError("That watch has already ended.", "not_found");
        w.stop();
        this.toolState.watchers!.delete(watchId);
        this.agent?.addReminder(`The user stopped watching ${w.label}. Don't watch it again unless they ask.`);
    }

    /** Watching something (a pull request): kept loaded so the watch goes on with no window open. */
    get watching(): boolean {
        // Or news from one is still to be told: closing would drop it.
        return Boolean(this.toolState.watchers?.size || this.toolState.wakes?.size);
    }

    async killShell(shellId: string) {
        const sh = this.toolState.shells.get(shellId);
        if (!sh) throw new Error(`No background shell ${shellId}`);
        // Not one that already ended: it keeps its own outcome.
        if (sh.exitCode === null) this.toolState.background?.stoppedByUser([shellId]);
        // The agent may be counting on it to wake it: it hears it was stopped with the next message.
        if (sh.monitor && sh.exitCode === null) this.agent?.addReminder(stoppedMonitorNote(sh));
        await sh.kill();
        this.syncShells();
    }

    // -----------------------------------------------------------------------

    private async hook(event: HookEvent, payload: Record<string, unknown>, signal?: AbortSignal, settings = sessionHookSettings(this.settings(), this.agent?.model.provider)): Promise<void> {
        await fireHooks(settings, event, { session_id: this.id, ...payload }, this.toolState.cwd, (msg, level = "warn") => this.notice(msg, level), signal);
    }

    /** Nothing running, waiting for the user, or still to be delivered to the model: closing it loses nothing. */
    get idle(): boolean {
        return this.settled(true);
    }

    /** Idle, except that running monitors may be left out: they watch, and a commit needn't wait out their half hour. */
    private settled(monitors: boolean): boolean {
        if (this.busy || this.committing || this.nextQueued() || this.pending.size || this.switching || this.goal.pending()) return false;
        if ([...this.toolState.shells.values()].some((s) => s.exitCode === null && (monitors || !s.monitor))) return false;
        // What an agent CLI runs in the background (Claude Code's sub-agents, shells, monitors): closing the session would stop it.
        if ((this.agent?.backgroundTasks() ?? []).some((t) => t.status === "running" && (monitors || t.kind !== "monitor"))) return false;
        return !(this.agent?.delegatedTasks ?? []).some((t) => t.status === "running" || !t.delivered);
    }

    /** Schedules run only while it's loaded: one that will run keeps it open with no window on it (it isn't busy, though). */
    get scheduled(): boolean {
        const s = this.schedules.scheduler;
        return s.active > 0 || s.list().some((j) => j.due);
    }

    /** SessionEnd hooks and background shells, when the server stops or the session is closed. */
    async close() {
        this.schedules.dispose();
        this.goal.dispose();
        this.idleCompact.disarm();
        this.abort?.abort();
        this.commitAbort?.abort();
        this.titleAbort?.abort();
        this.cancelInteractions();
        this.toolState.secrets?.clear();
        stopWatchers(this.toolState);
        this.toolState.wakes?.dispose();
        if (this.shellTimer) clearInterval(this.shellTimer);
        this.flush();
        // What's still going (a turn being interrupted, sub-agents delegated past their turn) as far as it got.
        // How it ends is written too, if that's before the session is let go of.
        this.syncSteps(true);
        this.closed = true;
        // Delegated tasks still running stop with the session.
        // Commit cancellation kills its process group and removes the index lock.
        // Wait for that bounded cleanup, including reconciliation if HEAD advanced.
        const commit = this.commitDone?.catch(() => undefined);
        const ending = Promise.all([
            this.hook("SessionEnd", { reason: "exit" }, AbortSignal.timeout(5000)),
            // Its live CLI processes too, and what they run in the background.
            this.agent?.dispose(),
            killAllShells({ state: this.toolState }),
            this.toolState.lsp?.dispose(),
            this.toolState.browser?.dispose(),
            this.toolState.simulator?.dispose(),
            commit,
        ]);
        try {
            // A turn still running notes how it stopped (the interrupt, what it was retrying) before the file is let go.
            const turn = this.turnDone;
            if (turn && !(await Promise.race([turn.then(() => true), Bun.sleep(closeTiming.turnMs).then(() => false)]))) {
                // Still stopping (the server's own exit doesn't wait long enough for a CLI backend's): noted for it,
                // and the file let go now, so what it writes when it does stop isn't recorded after that.
                await this.agent?.noteStopped();
                // Its log too (noting the stop ended the turn there): another process may have the session next.
                this.ui.close();
                this.session.release();
            }
            await ending;
        } finally {
            await this.agent?.turnSnapshots?.stop();
            await commit;
            this.ui.close();
            this.session.release();
        }
    }
}
