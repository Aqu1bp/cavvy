// Claude Code on the live CLI layer (#219 PR 4): one `claude -p` process per
// Cavvy session (src/backends/live), kept between turns, so what Claude Code
// runs in the background (sub-agents, shells, monitors) outlives the turn that
// started it, and reports in a turn Claude Code starts by itself (a wake).
//
// A turn is what answers a prompt we sent: it starts at the system/init that
// names the prompt's uuid (user_message_uuids) and ends at the result that
// names it. A system/init that names none of ours is a wake; its result has
// origin task-notification. Steering messages fold into the turn (the result
// names them all); one the CLI runs as a turn of its own is still that turn.
//
// Esc never stops the process. Claude Code's plain `interrupt` also stops its
// background sub-agents (docs/cli-protocol-probes.md, Q2), so with any running
// it sends a message to stand in for the turn ("the carrier") and asks for it
// at once (interrupt send_now): the turn stops, the carrier runs next, and the
// sub-agents live on. The carrier is the message the user sent meanwhile, or
// else CARRIER_COMMAND, whose turn is hidden. Probed on Claude Code 2.1.304,
// where send_now is marked @internal (interrupt_send_now_v1): without it Esc
// sends the plain interrupt and says the sub-agents stop.
//
// The agentCli.liveSessions setting turns this off: then claude-code.ts runs
// one process per turn, as before.

import { createHash, randomUUID } from "crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readlinkSync, readSync, realpathSync, writeFileSync, type Stats } from "fs";
import { basename, dirname, join } from "path";
import type { HookConfig } from "../config/settings";
import { cavvyHome } from "../config/paths";
import { backendMatcher, claudeCodeHookOutput, type HookEvent } from "../agent/hooks";
import type { AgentEvent, TurnEndReason } from "../agent/agent";
import { formatSkill } from "../agent/skills";
import { accountEnv } from "../providers/accounts";
import { signInAdvice } from "./account-login";
import type { ProviderDef } from "../providers/registry";
import type { ModelInfo, Usage } from "../providers/types";
import type { PlanLimits } from "../server/protocol";
import type { ToolDisplay } from "../tools/types";
import { knownSecrets, redact, redactPrefix } from "../util/redact";
import { cliCommandNames } from "../commands/custom";
import { ClaudeGoalWatch, claudeTranscriptFile } from "./claude-goal";
import { CLAUDE_CLI, cliMessage, requireCli, type JsonLinesProcess } from "./cli";
import { agentCli, type AgentCliDef, type CliCapabilities } from "./defs";
import type { AgentCliStatus } from "./index";
import { cliNotice } from "./notice-data";
import { creditsNote, limitAccountLabel, limitNews, limitNotice, limitStopOf, limitStopReport, mergeLimits, parseClaudeRateLimit, resetPhrase, resetSentence } from "./limits";
import { liveDebug } from "./live/debug";
import { LiveCliPool } from "./live/pool";
import { EXIT_DRAIN_MS, PromptRefused, spawnFingerprint, type LiveCliSession, type LiveOptions, type LiveTurnResult } from "./live/session";
import type { AgentCliAdapter, CliConnection, CliEvent, CliEventSink, LiveSettings, SpawnConfig, SpawnSpec, TurnInput } from "./live/types";
import type { BackgroundTaskInfo } from "./live/info";
import { CLAUDE_PREFIX, claudeNames, claudePrompt, forClaudeCode, skillFolder } from "./native-skills";
import type { BackendResult, BackendTurn, BackgroundStop, SessionHost, SteerMessage, TurnSink } from "./types";
import type { ImagePart, PdfPart } from "../providers/types";
import { servedBrowserTool } from "../tools/browser-tools";
import {
    DECLINED,
    LAUNCH_END,
    MODES,
    attachTiming,
    claudeArgs,
    claudeConfigDir,
    claudeGoal,
    claudeVersionAtLeast,
    describeBackground,
    endedBadly,
    handedBack,
    mediaBlocks,
    requestId,
    resultDisplay,
    resultText,
    splitPreamble,
    titleFor,
    toCavvy,
    type PendingTool,
} from "./claude-code";

/**
 * The message Esc sends in place of the turn it stops when no message of the user's is waiting: a command Claude
 * Code answers itself, with no model call. `/effort` with no level only prints how to use it (one line) and
 * changes nothing; `/cost` works too but prints the account's usage. Probed on 2.1.304 as the send_now carrier
 * (test/fixtures/protocol/claude-q2-b-sendnow-effort.jsonl): the turn stopped, the background Agent finished.
 */
export const CARRIER_COMMAND = "/effort";

/** The live path's waits (changeable for tests). */
export const liveTiming = {
    /** For the carrier to be queued by Claude Code before it's asked for at once. */
    carrierQueuedMs: 3000,
    /** For a control request's answer. */
    controlMs: 10_000,
    /** For the answer to withdrawing a steering message on Esc, which waits for it. */
    withdrawMs: 2000,
    /** After a background task's notification, for the turn that reports it; then the session counts as quiet again. */
    wakeDueMs: 15_000,
    /** A background shell or monitor that leaves Claude Code's list without a word on how it ended: ended after this. */
    unlistedMs: 3000,
    /** How often a turn's /goal is looked at in its transcript. */
    goalPollMs: 400,
    /** A session's process with nothing running or in the background: stopped after this (resumed at the next turn). */
    idleMs: 15 * 60_000,
    /** A stopped background task: confirmed by Claude Code's notification within this, or the stop timed out. */
    stopConfirmMs: 5000,
};

/**
 * The end of a background command's output its report has (#430): with the report's first line, within what the session
 * shows and tells the model of a report it can't take over (WAKE_REPORT_CHARS, 4000), which cuts a longer one at its end.
 */
const REPORT_OUTPUT_CHARS = 3000;
/** How much of the end of a command's output file is read for that (bytes): well past it, so redaction sees what it cuts. */
const OUTPUT_READ_BYTES = 64 * 1024;

/**
 * A folder's name under Claude Code's temporary folder, as 2.1.304 makes it: its path, each other character a "-"; past
 * 200 characters, cut there, with "-" and the path's hash (Java's String.hashCode, in base 36). The path in NFC
 * first, as it takes its cwd: a folder named with a decomposed "é" is the composed one's.
 */
export function claudePathSlug(raw: string): string {
    const path = raw.normalize("NFC");
    const slug = path.replace(/[^a-zA-Z0-9]/g, "-");
    if (slug.length <= 200) return slug;
    let h = 0;
    for (let i = 0; i < path.length; i++) h = ((h << 5) - h + path.charCodeAt(i)) | 0;
    return `${slug.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

/**
 * The folder Claude Code writes a session's background commands' output to, worked out as 2.1.304 does (not taken from
 * a path it names): <CLAUDE_CODE_TMPDIR, else /tmp>/claude-<uid>/<the folder's real path, as claudePathSlug>/<session>/
 * tasks. Undefined when it can't be, or its root isn't a folder of the user's own.
 */
function taskOutputDir(cwd: string, sessionId: string | undefined): string | undefined {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!sessionId || !/^[A-Za-z0-9-]+$/.test(sessionId) || uid === undefined) return undefined;
    try {
        const root = join(realpathSync(process.env.CLAUDE_CODE_TMPDIR || "/tmp"), `claude-${uid}`);
        const st = lstatSync(root);
        if (!st.isDirectory() || st.uid !== uid) return undefined;
        return join(root, claudePathSlug(realpathSync(cwd)), sessionId, "tasks");
    } catch {
        return undefined;
    }
}

/**
 * Where an open file is now, as the system says (not as the path it was opened by says): macOS answers the real path of
 * /dev/fd/N (Bun's realpath asks F_GETPATH), Linux has /proc/self/fd/N. Undefined elsewhere, or when it can't be told.
 */
function openedPath(fd: number): string | undefined {
    try {
        if (process.platform === "darwin") return realpathSync(`/dev/fd/${fd}`);
        if (process.platform === "linux") return readlinkSync(`/proc/self/fd/${fd}`);
    } catch {}
    return undefined;
}

/**
 * The end of a background command's output file, from Claude Code's task-output folder only (#430 review): undefined
 * (the summary stands) unless the file opened is a regular file of the user's with no other name, at that very path
 * (not a symlink, a hard link to another file, or one reached through a folder that's a link: the command can repoint
 * its own output file or folder before it ends, and Claude Code's own reads guard against that). Opened without waiting
 * (O_NONBLOCK), so a FIFO put there can't hold up the event loop. `partial`: its last OUTPUT_READ_BYTES only.
 */
export function outputTail(dir: string, taskId: string): { text: string; partial: boolean } | undefined {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return undefined;
    const path = join(dir, `${taskId}.output`);
    const uid = process.getuid?.();
    const plain = (st: Stats) => st.isFile() && st.nlink === 1 && st.uid === uid;
    let fd: number | undefined;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const st = fstatSync(fd);
        if (!plain(st)) return undefined;
        // The file opened is the one at the path (no folder on the way swapped for a link while it was opened).
        const named = lstatSync(path);
        if (!plain(named) || named.dev !== st.dev || named.ino !== st.ino || openedPath(fd) !== path) return undefined;
        const n = Math.min(st.size, OUTPUT_READ_BYTES);
        const buf = Buffer.alloc(n);
        readSync(fd, buf, 0, n, st.size - n);
        return { text: buf.toString("utf8"), partial: n < st.size };
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

/** Wake refs, unique in Cavvy process: a session keeps an unadopted wake across a restart of its CLI process. */
let wakeRefs = 0;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Cavvy's agents for --agents, in a file named by what's in it: the same agents, the same arguments (and spawn fingerprint). */
function agentsFileFor(agents: Record<string, unknown>): string {
    const json = JSON.stringify(agents);
    const dir = join(cavvyHome(), "cache", "claude-agents");
    const path = join(dir, `${createHash("sha256").update(json).digest("hex").slice(0, 16)}.json`);
    if (!existsSync(path)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(path, json, { mode: 0o600 });
    }
    return path;
}

/** What a wake reporting this task is called. */
function dueLabel(t: BackgroundTaskInfo, ended: "done" | "failed" | "stopped"): string {
    return `${t.kind === "agent" ? "Background sub-agent" : t.kind === "monitor" ? "Monitor" : "Background command"} ${ended === "failed" ? "failed" : "finished"}: ${t.label}`;
}

/** An end said again otherwise (done, then failed): a revised outcome. A stop's is final, and nothing is revised to one. */
function revises(was: Pick<BackgroundTaskInfo, "status">, now: Pick<BackgroundTaskInfo, "status">): boolean {
    return was.status !== "running" && was.status !== "stopped" && now.status !== "running" && now.status !== "stopped" && now.status !== was.status;
}

function taskKind(type: string, agent: boolean): BackgroundTaskInfo["kind"] {
    if (agent || type === "local_agent") return "agent";
    if (type === "local_bash") return "shell";
    if (type.startsWith("monitor")) return "monitor";
    if (type.includes("workflow")) return "workflow";
    return "other";
}

interface PromptInfo {
    /** Cavvy turn it belongs to (its own uuid for a prompt; the turn it steers for a steering message). */
    ref: string;
    kind: "prompt" | "steer" | "carrier";
    state: "sent" | "queued" | "started" | "done" | "cancelled";
    /**
     * command_lifecycle said it started: it's in Claude Code's transcript. A "cancelled" after that doesn't mean it
     * was dropped (2.1.304 says it of a prompt whose turn was stopped: claude-2.1.304-sendnow-effort.jsonl).
     */
    taken?: boolean;
    /**
     * command_lifecycle said cancelled before it started: Claude Code dropped it. Final: a withdrawal goes by it,
     * whatever its answer says, or when none came (withdrawSteers).
     */
    dropped?: boolean;
    /** A carrier whose turn isn't shown (CARRIER_COMMAND). */
    hidden?: boolean;
    /** The user's message, for a carrier that is one. */
    text?: string;
    /** A steering message's messages as the host drained them: handed back (TurnSink.undelivered) if Claude Code drops it untaken. */
    parts?: SteerMessage[];
    onQueued?: () => void;
}

/** A message to steer the running turn with, as the backend drained it (LiveTurnConfig.steer). */
export interface LiveSteer {
    text: string;
    synthetic?: boolean;
    images?: ImagePart[];
    documents?: PdfPart[];
    settle?: (sent: boolean) => Promise<void>;
    /** The drained messages it joins. */
    parts?: SteerMessage[];
}

/** The turn Claude Code is in now. */
interface CliTurn {
    ref: string;
    kind: "user" | "wake" | "hidden";
}

/** What the backend tells a connection about the turn under way. */
export interface LiveTurnConfig {
    /** The turn's settings (spawn settings, the orchestrator, hooks…). */
    t: BackendTurn;
    /**
     * Messages to steer the running turn with, taken from the queue as they're sent: the user's together (their
     * images and files with them), a watch's events apart. `settle`: told once the write is done whether it went, for
     * those with attachments, which are the queue's until then (SteerMessage.settle, #299). `live`: whether they can
     * still go (checked before they're taken); `recording`: called just before what the turn said so far is recorded
     * ahead of them.
     */
    steer?: (o: { live: () => boolean; recording: () => void }) => Promise<LiveSteer[]>;
    /** Drained messages Claude Code dropped before it took them (Esc): the next turn is told of them (TurnSink.undelivered). */
    undelivered?: (messages: SteerMessage[]) => void;
    /** A message to steer with was sent before Claude Code began the turn (or its process was up): it goes once the turn starts. */
    steerWanted?: boolean;
    /** A context block to go before the prompt's text (the conversation so far, beside a /goal). */
    context?: string;
}

/** One Claude Code process, spoken to over stream-json. */
export class ClaudeConnection implements CliConnection {
    caps: CliCapabilities;
    readonly done: Promise<void>;
    /** Claude Code can stop a turn for a waiting message without stopping its sub-agents (interrupt send_now). */
    sendNowCap = false;
    /** Steering messages are acknowledged by uuid (2.1.301 on): they can go mid-turn. */
    private midTurnInput = false;
    /**
     * A turn's system/init names the prompts it answers (user_message_uuids): 2.1.304's always does (each probe in
     * test/fixtures/protocol), so one that names none is a turn Claude Code started by itself, never a waiting prompt's.
     */
    private namesPrompts = false;
    /**
     * Claude Code said, as it resumed, what an earlier process left behind (#311). It takes a turn of its own for each
     * report at once, before any prompt's, with no model call (2.1.304: test/fixtures/protocol/claude-311-c2-resume.jsonl,
     * #429). Those turns are hidden (the notice said it), until a turn of ours starts.
     */
    private leftBehind = false;
    private initialized?: Promise<void>;
    private ended = false;
    private controls = new Map<string, (r: Record<string, any> | undefined) => void>();
    private prompts = new Map<string, PromptInfo>();
    /** Each Cavvy turn's prompts not answered yet. */
    private outstanding = new Map<string, Set<string>>();
    /** Each Cavvy turn's prompts answered so far. */
    private answeredBy = new Map<string, string[]>();
    /** Cavvy turns being interrupted. */
    private stopping = new Set<string>();
    /**
     * Prompts Esc withdraws or withdrew before Claude Code started them: stopped if it starts one anyway. In from before
     * the withdrawal is asked for until Claude Code says it dropped it (or it starts), with its record, which outlives its
     * turn here: what Claude Code says of it after the turn's end is still read (onLifecycle).
     */
    private withdrawn = new Map<string, PromptInfo>();
    /** Esc's withdrawals of messages to steer with, under way: no prompt goes before they're done (settled). */
    private cleaning = new Set<Promise<void>>();
    /** Stopped for a message Claude Code wouldn't withdraw (withdrawKept): it takes no more prompts. */
    private retired = false;
    /**
     * Cavvy turns Esc stopped after Claude Code took their prompt, before its system/init (#424): stopped as that
     * comes (startTurn), with the message to send in its place (sendNow), if any.
     */
    private stopOnStart = new Map<string, string | undefined>();
    private cur?: CliTurn;
    /**
     * The turn's own calls Claude Code is running (from their tool_use to their tool_result). A message written then
     * goes in with their result; one written while none runs goes "now", which cuts what the model is writing (2.1.310:
     * test/fixtures/protocol/claude-steer-immediate.jsonl). "now" while a call runs would end the turn after it instead.
     */
    private inTool = new Set<string>();
    /** Steering, one drain and write at a time, in the order asked for. */
    private steering: Promise<void> = Promise.resolve();
    /** Cavvy turns whose messages are being taken from the queue: the end of their turn waits for them (heldEnds). */
    private draining = new Set<string>();
    /** A turn's end that came while its messages were being taken: it ends once none were, or they continue it. */
    private heldEnds = new Map<string, TurnEndReason>();
    /** Cavvy turns Esc is withdrawing steering messages of (how many withdrawals): their end waits for it (withdrawing). */
    private withdrawals = new Map<string, number>();
    /** The end of each of those that came meanwhile (endTurn's arguments). */
    private endsAfterWithdrawal = new Map<string, [ref: string, reason: TurnEndReason, error?: string, limit?: { resetsAt?: number; window?: string }, refused?: boolean]>();
    /** Frames wait while a steer is recorded and written, so what Claude Code said before it stays before it. */
    private gate?: Promise<void>;
    /** The prompt command_lifecycle said started, before its system/init. */
    private startedUuid?: string;
    /** What each wake is about, for its row; and whether it answers a message of the user's. */
    readonly wakeInfo = new Map<string, { label?: string; prompt?: boolean; report?: string }>();
    /** A report Claude Code will start a turn for, said by a task_notification while no turn ran. */
    /** Reports Claude Code said it will start a turn for, oldest first: each wake takes the first. */
    private dues: { label?: string; report?: string; timer: ReturnType<typeof setTimeout>; task: BackgroundTaskInfo }[] = [];
    /** The message the user sent while the turn ran, to send at once in its place on Esc (sendNow). */
    followUp?: string;
    private hookAbort = new AbortController();
    private hookCallbacks = new Map<string, { event: HookEvent; hook: HookConfig }>();
    private mcpKey?: string;
    private goals?: ClaudeGoalWatch;
    private goalTimer?: ReturnType<typeof setInterval>;
    private sessionId?: string;

    // Per CLI turn.
    private failure?: string;
    private diagnostic?: string;
    private signedOut = false;
    private limitHit = false;
    private reachedNoted = false;
    private billedToPlan = false;
    private resolvedModel?: string;
    private contextTokens?: number;
    private limits?: PlanLimits;
    private fastModeNotice?: string;
    private fastModeObserved = false;

    // What Claude Code runs, across turns (a background sub-agent's call outlives its turn).
    private tools = new Map<string, PendingTool>();
    private streamingTools = new Map<number, string>();
    private agentLabels = new Map<string, string>();
    /** Bash calls' commands, by call: a background one's task says its description, and its command goes with it. */
    private bashCommands = new Map<string, string>();
    private liveAgents = new Set<string>();
    private endedAgents = new Map<string, TurnEndReason>();
    private subTools = new Map<string, PendingTool & { parent: string }>();
    private reports = new Map<string, string>();
    private backgroundAgents = new Set<string>();
    private launched = new Set<string>();
    private closedLaunches = new Map<string, PendingTool & { reason: TurnEndReason; ended: number }>();
    private lastWords = new Map<string, string>();
    private agentTokens = new Map<string, number>();
    private agentTypes = new Map<string, string>();
    /** Background tasks, by Claude Code's task id. */
    private tasks = new Map<string, BackgroundTaskInfo>();
    /** Task ids by the call that launched them. */
    private taskOf = new Map<string, string>();
    /** Each sub-agent's task id, and the Agent call it runs as: the task Claude Code starts when SendMessage resumes it is that one's (#458). */
    private agentOfTask = new Map<string, string>();
    /** A call that resumed a sub-agent (SendMessage), or a call an earlier process started it with, and the call it runs as here. */
    private resumedBy = new Map<string, string>();
    /** Sub-agents this process didn't start, resumed by a SendMessage call they run as here: by task id. */
    private strangers = new Map<string, string>();
    /** Each background command (by task id) and the file Claude Code writes its output to, for its report (#430). */
    private commands = new Map<string, { command?: string; file?: string }>();
    /** Tasks that left Claude Code's list without a word on how they ended. */
    private unlisted = new Map<string, ReturnType<typeof setTimeout>>();
    /**
     * Started to resume a session, and no turn begun yet: a task Claude Code says ended now is one an earlier process
     * left behind (it says so of each as it resumes, before any turn). Never one of this process's own (#311).
     */
    private resuming: boolean;

    constructor(
        private proc: JsonLinesProcess,
        private events: CliEventSink,
        private host: SessionHost,
        private def: { id: string; name: string; caps: CliCapabilities },
        /** The turn under way (or the last one): its settings, steering and context. */
        private turn: () => LiveTurnConfig,
        /** What each CLI session had spent (by account:session id): a resumed session's totals include it. */
        private spending: Map<string, number>,
        /** The plan-limit statuses each account was last told of (the backend's: a new process doesn't tell them again). */
        private limitSeen: Map<string, string>,
        /** Started with --resume (a fork too): what an earlier process left behind is said first. */
        resumed = false,
    ) {
        this.caps = { ...def.caps, live: { model: true, effort: true, mode: "control" } };
        this.resuming = resumed;
        this.done = this.read();
    }

    private get cfg(): BackendTurn {
        return this.turn().t;
    }

    /** Send initialize (registering Cavvy's hooks) and wait for its answer. Rejects when the CLI ends first (a session it can't resume). */
    initialize(): Promise<void> {
        return (this.initialized ??= (async () => {
            const r = await this.control({ subtype: "initialize", ...this.hookRegistration() }, Number.POSITIVE_INFINITY);
            if (!r) throw new Error(this.failure ?? `${this.def.name} ended before it answered`);
            if (r.subtype !== "success") throw new Error(`${this.def.name}: ${String(r.error ?? "initialize failed")}`);
            const res = r.response ?? {};
            this.midTurnInput = claudeVersionAtLeast(res.claude_code_version, 301);
            this.namesPrompts = claudeVersionAtLeast(res.claude_code_version, 304);
            this.noteCapabilities(res.capabilities);
            liveDebug("claude", "initialized", { version: res.claude_code_version, sendNow: this.sendNowCap, pid: this.proc.pid });
            if (!this.midTurnInput) this.emit({ type: "notice", level: "info", message: "This Claude Code version has no verified mid-turn input acknowledgements. Queued messages will be delivered when its current turn ends." });
        })());
    }

    async open(o: { resumeId?: string; fork?: boolean; settings: LiveSettings }): Promise<{ sessionId: string }> {
        await this.initialize();
        await this.attach();
        // A new session's id comes with its first turn (system/init); a resumed one keeps its own.
        return { sessionId: o.fork ? "" : (o.resumeId ?? "") };
    }

    async prompt(input: TurnInput): Promise<{ ref: string }> {
        // Nothing is written until sendUser: a failure up to there never reached Claude Code.
        try {
            await this.attach();
        } catch (e) {
            throw new PromptRefused(e instanceof Error ? e.message : String(e));
        }
        if (!(await this.settled()) || this.ended) throw new PromptRefused(`${this.def.name} has exited`);
        const uuid = randomUUID();
        const context = this.turn().context;
        // The text goes last: Claude Code reads a /command only from the last block (what's before it goes along with it).
        const content = [...mediaBlocks(input.images, input.documents ?? []), ...(context ? [{ type: "text", text: context }] : []), { type: "text", text: input.text }];
        this.prompts.set(uuid, { ref: uuid, kind: "prompt", state: "sent" });
        this.outstanding.set(uuid, new Set([uuid]));
        this.answeredBy.set(uuid, []);
        void this.sendUser(uuid, content, input.synthetic);
        liveDebug("claude", "prompt", { uuid, chars: input.text.length, images: input.images.length });
        return { ref: uuid };
    }

    /**
     * Once what Esc withdrew is settled: each message confirmed dropped or taken, or the process stopped for one that
     * isn't (withdrawKept). Whether this process can take a prompt (LiveCliSession.prepare starts a new one if not).
     */
    async settled(): Promise<boolean> {
        while (this.cleaning.size) await Promise.all(this.cleaning);
        return !this.retired;
    }

    /** Esc's withdrawal of messages to steer with: prompts wait for it (settled). */
    private cleanup(work: Promise<void>): Promise<void> {
        const done: Promise<void> = work
            .then(() => this.withdrawnRunEnded())
            .catch((e) => liveDebug("claude", "withdrawal failed", { error: redact((e as Error).message) }))
            .finally(() => void this.cleaning.delete(done));
        this.cleaning.add(done);
        return done;
    }

    /**
     * Until no message Esc withdrew is one Claude Code started as a turn of its own (taken, still in `withdrawn` till
     * that turn's result): startTurn stops it with an interrupt the next prompt mustn't meet. Or the process ended;
     * still running past the wait, it's stopped (settled then says it can't take a prompt).
     */
    private async withdrawnRunEnded(): Promise<void> {
        const deadline = Date.now() + liveTiming.controlMs;
        const running = () => [...this.withdrawn.values()].some((p) => p.taken);
        while (!this.ended && Date.now() < deadline && running()) await Bun.sleep(50);
        if (this.ended || this.retired || !running()) return;
        liveDebug("claude", "withdrawn message's turn not over after Esc: stopping Claude Code");
        this.emit({ type: "notice", level: "warn", message: `${this.def.name} didn't stop a message sent to steer the turn you stopped, which it had started, so its process was stopped, with its background work.` });
        this.retired = true;
        await this.proc.kill();
    }

    /**
     * Esc's message to send now, as a turn of its own once nothing Esc withdrew can be stopped into it; with the
     * process stopped for one (withdrawKept, withdrawnRunEnded), or gone, the next turn is told of it.
     */
    private async sendFollowUp(followUp: string, cfg: LiveTurnConfig): Promise<void> {
        await this.withdrawnRunEnded();
        if (this.retired || this.ended) cfg.undelivered?.([{ text: followUp, images: [], documents: [] }]);
        else this.sendCarrier(followUp);
    }

    /** The turn Claude Code runs is being stopped (an interrupt is under way). */
    stoppingNow(): boolean {
        return this.cur !== undefined && this.stopping.has(this.cur.ref);
    }

    /**
     * Esc on a turn (a prompt's, or an adopted wake's). Never sent when the turn isn't the one Claude Code runs:
     * a prompt it hasn't started is withdrawn instead (unstartedPrompt); one already answered is left alone.
     */
    async interrupt(ref: string): Promise<void> {
        this.stopping.add(ref);
        const followUp = this.followUp;
        this.followUp = undefined;
        if (this.cur?.ref !== ref) {
            const waiting = [...this.prompts.entries()].filter(([, p]) => p.ref === ref && (p.state === "sent" || p.state === "queued"));
            liveDebug("claude", "interrupt: not running", { ref, waiting: waiting.length, held: this.heldEnds.has(ref) });
            if (!waiting.length) {
                // Its turn is over, held open only while messages to steer with are taken: it ends stopped, and they don't go.
                if (this.heldEnds.delete(ref)) this.endTurn(ref, "aborted");
                return;
            }
            const own = waiting.find(([uuid, p]) => uuid === ref && p.kind === "prompt");
            if (own) return this.unstartedPrompt(ref, own[1], followUp);
            // Steering messages still to come as a turn of their own (the turn they were for has ended): withdrawn, and
            // the turn ends here. Its prompt reached Claude Code before them. Those it says it dropped, the next turn is told of.
            const cfg = this.turn();
            for (const [, p] of waiting) p.state = "cancelled";
            return this.cleanup(
                this.withdrawing(ref, async () => {
                    const unsure = await this.withdrawSteers(waiting, cfg);
                    this.endTurn(ref, "aborted");
                    await this.withdrawKept(ref, undefined, unsure, cfg);
                    if (followUp) await this.sendFollowUp(followUp, cfg);
                }),
            );
        }
        // Messages written to steer it that Claude Code hasn't taken yet: an interrupt keeps them, to run after it
        // (2.1.310: claude-steer-immediate.jsonl, case d). Withdrawn first; the next turn is told of them.
        const untaken = [...this.prompts.entries()].filter(([, p]) => p.ref === ref && p.kind === "steer" && !p.taken && (p.state === "sent" || p.state === "queued"));
        return untaken.length ? this.cleanup(this.withdrawing(ref, () => this.stopRunning(ref, followUp, untaken))) : this.stopRunning(ref, followUp, untaken);
    }

    /**
     * Esc's withdrawal of a turn's steering messages (`work`): the turn doesn't end before it's settled, so every one
     * Claude Code dropped is handed back (TurnSink.undelivered) before the run is over, and nothing the user sends
     * next is stored before it. Bounded: its controls time out (withdrawMs, controlMs), and one Claude Code won't drop
     * has its process stopped (withdrawKept).
     */
    private async withdrawing(ref: string, work: () => Promise<void>): Promise<void> {
        this.withdrawals.set(ref, (this.withdrawals.get(ref) ?? 0) + 1);
        try {
            await work();
        } finally {
            const left = (this.withdrawals.get(ref) ?? 1) - 1;
            if (left) this.withdrawals.set(ref, left);
            else {
                this.withdrawals.delete(ref);
                const end = this.endsAfterWithdrawal.get(ref);
                this.endsAfterWithdrawal.delete(ref);
                if (end) this.endTurn(...end);
            }
        }
    }

    /** Esc on the turn Claude Code runs, after withdrawing the messages to steer it that it hasn't taken (`untaken`). */
    private async stopRunning(ref: string, followUp: string | undefined, untaken: [string, PromptInfo][]): Promise<void> {
        const cfg = this.turn();
        let unsure: [string, PromptInfo][] = [];
        if (untaken.length) {
            unsure = await this.withdrawSteers(untaken, cfg);
            // Its turn ended meanwhile: stopped as one that isn't running is, and what Claude Code may still have is
            // withdrawn again (or its process stopped).
            if (this.cur?.ref !== ref) {
                await this.interrupt(ref);
                await this.withdrawKept(ref, undefined, unsure, cfg);
                if (followUp !== undefined) await this.sendFollowUp(followUp, cfg);
                return;
            }
        }
        const agents = this.runningAgents();
        if (this.sendNowCap && (followUp !== undefined || agents.length)) {
            const r = await this.sendNow(ref, followUp);
            if (r === "stopped" || this.cur?.ref !== ref) return this.withdrawKept(ref, undefined, unsure, cfg);
            liveDebug("claude", "interrupt: send_now didn't stop it", { ref, r });
        }
        if (this.cur?.ref !== ref) return this.withdrawKept(ref, undefined, unsure, cfg);
        const left = this.runningAgents();
        if (left.length) {
            // A plain interrupt stops the background sub-agents too (Claude Code 2.1.304): the user's Esc stopped them.
            for (const t of left) this.escStopped.add(t.id);
            const what = describeBackground(left.map((t) => ({ agent: true, label: t.label })));
            const why = this.sendNowCap ? "Claude Code couldn't stop the turn on its own" : "this Claude Code version can't stop a turn without them";
            this.emit({ type: "notice", level: "warn", message: `Stopped ${what} when you pressed Esc (${why}). ${left.length === 1 ? "It won't" : "They won't"} report back. Background commands and monitors keep running.` });
        }
        liveDebug("claude", "interrupt", { ref, agents: left.length });
        const stopped = this.control({ subtype: "interrupt" }).then((r) => this.withdrawKept(ref, r, unsure, cfg));
        // Esc's withdrawal lasts until what the interrupt kept is settled too.
        if (untaken.length) await stopped;
    }

    /**
     * Esc on a turn whose prompt Claude Code hasn't begun a turn for (no system/init yet). Whether its session has the
     * prompt decides how the turn ends (#424):
     * - taken (command_lifecycle said it started, or it's too late to withdraw it: cancel_async_message answered
     *   `cancelled: false`): it's in Claude Code's transcript, and the system/init naming its session is on its way.
     *   The turn is stopped as that comes (startTurn) and ends with its result, as one stopped after its start does,
     *   so its session is known and the prompt counts as delivered. Ended here instead, it would leave the prompt
     *   in a session Cavvy doesn't know of, and the next prompt would bring it again as context;
     * - dropped (`cancelled: true`, or its lifecycle said cancelled, not started: onLifecycle, at once, whenever the
     *   answer comes): never in its transcript, so the turn ends refused (LiveTurnResult.refused), and the prompt goes
     *   again with the next;
     * - not known (no answer, an older Claude Code): withdrawn as before, stopped unseen if it starts after all,
     *   and counted as delivered.
     */
    private async unstartedPrompt(ref: string, p: PromptInfo, followUp: string | undefined): Promise<void> {
        this.stopOnStart.set(ref, followUp);
        if (p.taken) {
            liveDebug("claude", "interrupt: taken, stopping it as it starts", { ref });
            return;
        }
        const r = await this.control({ subtype: "cancel_async_message", message_uuid: ref });
        const cancelled: unknown = r?.subtype === "success" ? r.response?.cancelled : undefined;
        liveDebug("claude", "interrupt: withdraw", { ref, cancelled, state: p.state });
        // Its turn started meanwhile (and is being stopped), or ended (Claude Code exited, or its lifecycle said it
        // dropped the prompt: onLifecycle).
        if (!this.stopOnStart.has(ref) || this.cur?.ref === ref || p.state === "started" || p.state === "done") return;
        // Taken meanwhile (started): stopped as its turn starts, whatever the answer.
        if (p.taken) return;
        if (cancelled === true) return this.endWithdrawn(ref, p, true);
        if (cancelled !== false) this.endWithdrawn(ref, p, false);
    }

    /**
     * A turn Esc withdrew the prompt of (unstartedPrompt) ends: refused when Claude Code said it dropped the prompt;
     * otherwise (not known) delivered, and the prompt is stopped unseen if it starts after all.
     */
    private endWithdrawn(ref: string, p: PromptInfo, dropped: boolean) {
        const followUp = this.stopOnStart.get(ref);
        this.stopOnStart.delete(ref);
        p.state = "cancelled";
        if (!dropped) this.withdrawn.set(ref, p);
        this.endTurn(ref, "aborted", undefined, undefined, dropped);
        if (followUp) this.sendCarrier(followUp);
    }

    /** Send a message in place of the running turn, and ask for it at once: how Claude Code answered. */
    private async sendNow(ref: string, followUp: string | undefined): Promise<string | undefined> {
        const uuid = this.sendCarrier(followUp);
        const p = this.prompts.get(uuid)!;
        const queued = await new Promise<boolean>((resolve) => {
            if (p.state !== "sent") return resolve(true);
            const timer = setTimeout(() => resolve(false), liveTiming.carrierQueuedMs);
            p.onQueued = () => {
                clearTimeout(timer);
                resolve(true);
            };
        });
        if (!queued || this.cur?.ref !== ref) {
            liveDebug("claude", "send_now: carrier not queued", { ref, uuid, queued });
            return undefined;
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            const r = await this.control({ subtype: "interrupt", send_now: true, message_uuid: uuid });
            const said = r?.subtype === "success" ? String(r.response?.send_now ?? "") : undefined;
            liveDebug("claude", "send_now", { ref, uuid, said, attempt });
            if (said === "stopped") return said;
            // Taken without stopping the turn (it wasn't under way yet): once more, in a moment.
            if (said === "delivering" && attempt === 0 && this.cur?.ref === ref) {
                await Bun.sleep(300);
                continue;
            }
            return said;
        }
        return undefined;
    }

    /** A carrier: the user's message (its turn is adopted as theirs), or CARRIER_COMMAND (its turn hidden). */
    private sendCarrier(text: string | undefined): string {
        const uuid = randomUUID();
        this.prompts.set(uuid, { ref: uuid, kind: "carrier", state: "sent", hidden: text === undefined, text });
        void this.sendUser(uuid, [{ type: "text", text: text ?? CARRIER_COMMAND }]);
        liveDebug("claude", "carrier", { uuid, followUp: text !== undefined });
        return uuid;
    }

    async stopTask(id: string): Promise<void> {
        liveDebug("claude", "stop_task", { id });
        const r = await this.control({ subtype: "stop_task", task_id: id });
        // Success says nothing (it comes for an unknown id too): the task's own notification does.
        if (r?.subtype !== "success") throw new Error(String(r?.error ?? "stop_task failed"));
    }

    async apply(s: Partial<LiveSettings>): Promise<"applied" | "restart"> {
        const ok = (r: Record<string, any> | undefined) => r?.subtype === "success";
        const model: ModelInfo = s.model ?? this.cfg.model;
        liveDebug("claude", "apply", { model: s.model?.id, effort: s.effort, mode: s.mode, fastMode: s.fastMode });
        if (s.model && !ok(await this.control({ subtype: "set_model", model: s.model.id }))) return "restart";
        const flags: Record<string, unknown> = {};
        if ("effort" in s) {
            // No effort (or one this model doesn't have) can't be set back on a running process.
            if (!s.effort || (model.effortLevels && !model.effortLevels.includes(s.effort))) return "restart";
            flags.effortLevel = s.effort;
        }
        if ("fastMode" in s) flags.fastMode = Boolean(s.fastMode && model.supportsFastMode);
        if (Object.keys(flags).length && !ok(await this.control({ subtype: "apply_flag_settings", settings: flags }))) return "restart";
        if (s.mode && !ok(await this.control({ subtype: "set_permission_mode", mode: MODES[s.mode] }))) return "restart";
        return "applied";
    }

    /** Cavvy's mode changed: Claude Code takes it now, between turns too (its background sub-agents follow it). */
    setMode(mode: Parameters<SessionHost["setMode"]>[0]): void {
        void this.control({ subtype: "set_permission_mode", mode: MODES[mode] });
    }

    async close(): Promise<void> {
        this.hookAbort.abort();
        this.proc.end();
    }

    /** Whether a running Claude Code turn is one of Cavvy's (a prompt's or an adopted wake's), so Esc has something to stop. */
    running(): boolean {
        return Boolean(this.cur && this.cur.kind !== "hidden");
    }

    // ---- reading

    private async read(): Promise<void> {
        try {
            for await (const m of this.proc.messages({ quietAfterExitMs: EXIT_DRAIN_MS })) {
                while (this.gate) await this.gate;
                try {
                    await this.onFrame(m);
                } catch (e) {
                    liveDebug("claude", "frame failed", { type: m.type, error: redact((e as Error).message) });
                }
            }
        } finally {
            this.ended = true;
            this.hookAbort.abort();
            clearInterval(this.goalTimer);
            for (const d of this.dues) clearTimeout(d.timer);
            for (const t of this.unlisted.values()) clearTimeout(t);
            for (const resolve of [...this.controls.values()]) resolve(undefined);
            this.controls.clear();
            liveDebug("claude", "output ended", { pid: this.proc.pid });
        }
    }

    private async onFrame(m: Record<string, any>) {
        switch (m.type) {
            case "control_request":
                void this.onControlRequest(m);
                return;
            case "control_response": {
                const r = m.response ?? {};
                this.reportFastMode(r.response ?? {});
                const id = String(r.request_id ?? "");
                const resolve = this.controls.get(id);
                this.controls.delete(id);
                resolve?.(r);
                return;
            }
            case "command_lifecycle":
                return this.onLifecycle(m);
            case "system":
                return this.onSystem(m);
            case "stream_event":
                if (!m.parent_tool_use_id) this.onStreamEvent(m.event ?? {});
                return;
            case "assistant":
                return this.onAssistant(m);
            case "user":
                if (m.parent_tool_use_id) return this.onSubToolResults(m);
                this.onToolResults(m);
                if (Array.isArray(m.message?.content)) for (const b of m.message.content) if (b?.type === "tool_result") this.inTool.delete(String(b.tool_use_id));
                // A step ended: what a host that doesn't say when it queues (TurnSink.onQueued) has waiting goes now.
                // Awaited, so the timeline keeps the order they were delivered in.
                if (this.cur && this.cur.kind !== "hidden" && Array.isArray(m.message?.content) && m.message.content.some((b: any) => b?.type === "tool_result")) await this.steerSoon();
                return;
            case "rate_limit_event":
                return this.onRateLimit(m.rate_limit_info ?? {});
            case "active_goal":
                this.goals?.poll();
                if (!this.goals?.found) this.emit({ type: "goal", goal: claudeGoal(m.value) });
                return;
            case "result":
                return this.onResult(m);
        }
    }

    /**
     * The user sent a message to steer with (TurnSink.onQueued), or a step ended: what's queued goes to Claude Code
     * now, in order, one drain at a time. A turn of the user's that hasn't started yet takes it once it does.
     */
    steerSoon(): Promise<void> {
        const next = this.steering.then(() => this.steerOnce());
        this.steering = next.catch((e) => liveDebug("claude", "steer failed", { error: redact((e as Error).message) }));
        return this.steering;
    }

    /**
     * Messages the user sent while the turn runs, to Claude Code as they're sent, taken into the turn at its next step
     * (2.1.310: claude-steer-immediate.jsonl). While one of its calls runs, a plain message goes in with that call's
     * result (case a). Otherwise it goes "now", which cuts what the model is writing (its words so far kept) and runs
     * the message at once, as a turn of Claude Code's own that's still this one (cases b, f). A watch's events never
     * cut the model off: they wait for a step, or for the turn's end.
     */
    private async steerOnce() {
        const cfg = this.turn();
        const steer = cfg.steer;
        if (!steer || !this.midTurnInput || this.ended) return;
        const cur = this.cur;
        if (!cur || cur.kind === "hidden") {
            cfg.steerWanted = true;
            return;
        }
        cfg.steerWanted = false;
        const ref = cur.ref;
        if (this.stopping.has(ref)) return;
        if (!this.outstanding.has(ref)) this.outstanding.set(ref, new Set());
        // At most 64 unanswered at once, as many as a result names.
        if (this.outstanding.get(ref)!.size >= 64) return;
        let release: (() => void) | undefined;
        // What came before them is recorded before them: nothing after it is read until they're written.
        const recording = () => void (this.gate ??= new Promise<void>((r) => (release = r)));
        this.draining.add(ref);
        try {
            const taken = await steer({ live: () => !this.ended && !this.stopping.has(ref) && this.turnOn(ref), recording });
            if (!taken.length) return;
            if (this.ended || this.stopping.has(ref) || !this.turnOn(ref)) {
                // Stopped or gone once they were taken: those with attachments stay queued; the rest (in the transcript
                // already) the next turn is told of, rather than them vanishing.
                for (const m of taken) await m.settle?.(false);
                const told = taken.filter((m) => !m.settle).flatMap((m) => m.parts ?? []);
                if (told.length) cfg.undelivered?.(told);
                return;
            }
            // Into the turn that runs; when it ended meanwhile (its end held), Claude Code runs them as a turn of their own.
            const now = this.cur?.ref === ref && !this.inTool.size;
            // One with attachments is recorded once it's written (settle): what Claude Code says to it is read after that.
            if (taken.some((m) => m.settle)) recording();
            const pending = this.outstanding.get(ref)!;
            const writes = taken.map((m) => {
                const uuid = randomUUID();
                this.prompts.set(uuid, { ref, kind: "steer", state: "sent", ...(m.parts ? { parts: m.parts } : {}) });
                pending.add(uuid);
                const priority = now && !m.synthetic ? "now" : undefined;
                liveDebug("claude", "steer", { ref, uuid, priority, media: (m.images?.length ?? 0) + (m.documents?.length ?? 0) });
                // Their images and files first, as a prompt's; the text last (none when there are no words).
                const content = [...mediaBlocks(m.images ?? [], m.documents ?? []), ...(m.text ? [{ type: "text", text: m.text }] : [])];
                return this.sendUser(uuid, content, m.synthetic, priority).then((sent) => {
                    if (!sent) {
                        this.prompts.delete(uuid);
                        pending.delete(uuid);
                    }
                    return sent;
                });
            });
            const sent = await Promise.all(writes);
            // Written whole to its stdin: one with attachments is the host's to record now; not, it stays queued.
            for (const [i, m] of taken.entries()) await m.settle?.(sent[i]!);
        } finally {
            this.draining.delete(ref);
            this.gate = undefined;
            release?.();
            this.endHeld(ref);
        }
    }

    /** Whether a Cavvy turn is still on: Claude Code runs it, or it waits for what's to come in it. */
    private turnOn(ref: string): boolean {
        return this.cur?.ref === ref || this.heldEnds.has(ref) || this.outstanding.has(ref);
    }

    /** A turn whose end was held while messages were taken: it ends now, unless they went (then they continue it). */
    private endHeld(ref: string) {
        const reason = this.heldEnds.get(ref);
        if (reason === undefined || this.draining.has(ref)) return;
        this.heldEnds.delete(ref);
        const left = [...(this.outstanding.get(ref) ?? [])].some((id) => {
            const s = this.prompts.get(id)?.state;
            return s === "sent" || s === "queued";
        });
        if (left) liveDebug("claude", "turn: result, steering written as it ended", { ref });
        else this.endTurn(ref, reason);
    }

    /**
     * Steering messages Claude Code hasn't taken, withdrawn (cancel_async_message, which 2.1.310 does for a queued
     * one: claude-steer-immediate.jsonl, case d). In `withdrawn` before it's asked, so one that starts a turn
     * meanwhile, even once its own turn has ended, is stopped unseen (startTurn), never taken for a wake. Those it
     * says it dropped (its answer, or its lifecycle, which is final) are handed back, once, for the next turn. The
     * rest, which it may still run and haven't started, are returned, and stay in `withdrawn`.
     */
    private async withdrawSteers(list: [string, PromptInfo][], cfg: LiveTurnConfig): Promise<[string, PromptInfo][]> {
        for (const [uuid, p] of list) this.withdrawn.set(uuid, p);
        const answers = await Promise.all(list.map(([uuid]) => this.control({ subtype: "cancel_async_message", message_uuid: uuid }, liveTiming.withdrawMs)));
        const dropped: SteerMessage[] = [];
        const unsure: [string, PromptInfo][] = [];
        list.forEach(([uuid, p], i) => {
            const r = answers[i];
            if (!p.dropped && (r?.subtype !== "success" || r.response?.cancelled !== true)) {
                // Taken meanwhile: in the turn, which the interrupt stops, or stopped as it started (startTurn).
                if (!p.taken) unsure.push([uuid, p]);
                return;
            }
            p.state = "cancelled";
            this.withdrawn.delete(uuid);
            this.outstanding.get(p.ref)?.delete(uuid);
            dropped.push(...(p.parts ?? []));
            p.parts = undefined;
        });
        liveDebug("claude", "steering withdrawn", { asked: list.length, dropped: dropped.length, unsure: unsure.length });
        if (dropped.length) cfg.undelivered?.(dropped);
        return unsure;
    }

    /**
     * After Esc's interrupt (`r`, its answer): steering messages of the turn's Claude Code still has (its answer's
     * still_queued) or didn't say it dropped would run after the stop (claude-steer-immediate.jsonl, case d), as a
     * turn nobody asked for. Withdrawn again; one it still doesn't drop, and hasn't started (startTurn stops that one),
     * Claude Code is stopped for, so it never runs. It counts as delivered (Claude Code may have it): not sent again.
     */
    private async withdrawKept(ref: string, r: Record<string, any> | undefined, unsure: [string, PromptInfo][], cfg: LiveTurnConfig) {
        const queued: unknown[] | undefined = Array.isArray(r?.response?.still_queued) ? r.response.still_queued : undefined;
        const kept = queued ? unsure.filter(([uuid]) => queued.includes(uuid)) : unsure;
        for (const uuid of queued ?? []) {
            const p = typeof uuid === "string" ? this.prompts.get(uuid) : undefined;
            if (p?.kind === "steer" && p.ref === ref && !kept.some(([u]) => u === uuid)) kept.push([uuid as string, p]);
        }
        if (!kept.length) return;
        const left = (await this.withdrawSteers(kept, cfg)).filter(([uuid]) => this.withdrawn.has(uuid));
        if (!left.length || this.ended) return;
        liveDebug("claude", "steering kept after Esc: stopping Claude Code", { ref, left: left.length });
        this.emit({ type: "notice", level: "warn", message: `${this.def.name} didn't withdraw a message sent to steer the turn you stopped, so its process was stopped before it could run it, with its background work.` });
        this.retired = true;
        await this.proc.kill();
    }

    private onLifecycle(m: Record<string, any>) {
        const uuid = String(m.command_uuid ?? "");
        // One being withdrawn is followed past its turn's end.
        const p = this.prompts.get(uuid) ?? this.withdrawn.get(uuid);
        if (!p) return;
        // Dropped before it started: it won't start, and that's final (withdrawSteers).
        if (m.state === "cancelled" && !p.taken) {
            p.dropped = true;
            this.withdrawn.delete(uuid);
        }
        switch (m.state) {
            case "queued":
                if (p.state === "sent") p.state = "queued";
                p.onQueued?.();
                p.onQueued = undefined;
                break;
            case "started":
                this.startedUuid = uuid;
                p.taken = true;
                // A steering message taken into the turn that runs (with a call's result), its own or another (a wake
                // Claude Code started as it was written): answered with it, whether or not its result names it
                // (2.1.310's doesn't name a synthetic one: claude-synthetic-steer.jsonl).
                if (p.kind === "steer" && this.cur && this.cur.kind !== "hidden" && (p.state === "sent" || p.state === "queued")) {
                    p.state = "started";
                    // In the turn: Esc's interrupt stops it with that, nothing to withdraw.
                    this.withdrawn.delete(uuid);
                }
                break;
            case "completed":
                // Taken into a turn not its own: over now (that turn's result may not name it), and so may its own turn be.
                if (p.kind === "steer" && this.cur?.ref !== p.ref && p.state === "started") {
                    p.state = "done";
                    this.outstanding.get(p.ref)?.delete(uuid);
                    this.settleWaiting(p.ref);
                }
                break;
            case "cancelled":
                // Claude Code dropped it (the turn it waited for was stopped, or it was withdrawn).
                if (p.state === "sent" || p.state === "queued") {
                    // Esc withdrew the turn's own prompt (unstartedPrompt), and it never started: never in its
                    // transcript, so refused now, whenever the withdrawal's answer comes (#435 review).
                    if (uuid === p.ref && p.kind === "prompt" && this.stopOnStart.has(uuid) && !p.taken) return this.endWithdrawn(uuid, p, true);
                    p.state = "cancelled";
                    this.settleWaiting(p.ref);
                }
                break;
        }
    }

    /** Which prompts of ours a system/init or result names. */
    private ours(m: Record<string, any>): string[] {
        return [m.user_message_uuid, ...(Array.isArray(m.user_message_uuids) ? m.user_message_uuids : [])].filter((x): x is string => typeof x === "string" && this.prompts.has(x));
    }

    /** A turn begins: a prompt of ours (or a carrier), or one Claude Code starts by itself. */
    private onInit(m: Record<string, any>) {
        this.startTurn(m);
        // It runs these itself when one is the prompt (/context, a skill): they aren't mistyped commands.
        // Not Cavvy's own skills (cavvy:name): the menus have those already.
        const names = cliCommandNames(m.slash_commands)?.filter((n) => !n.startsWith(CLAUDE_PREFIX));
        if (names) this.emit({ type: "cli_commands", provider: this.def.id, names });
    }

    private startTurn(m: Record<string, any>) {
        const named = Array.isArray(m.user_message_uuids) ? m.user_message_uuids.filter((x: unknown): x is string => typeof x === "string") : [];
        // Withdrawn on Esc but started anyway: stopped now, as Esc would have, and not shown.
        const withdrawn = named.find((u: string) => this.withdrawn.has(u)) ?? (this.startedUuid && this.withdrawn.has(this.startedUuid) ? this.startedUuid : undefined);
        if (withdrawn) {
            this.startedUuid = undefined;
            // Left in `withdrawn` until its result: Esc's cleanup waits for that (withdrawnRunEnded).
            this.cur = { ref: withdrawn, kind: "hidden" };
            liveDebug("claude", "turn: withdrawn prompt started; stopping it", { uuid: withdrawn });
            void this.interruptHidden();
            return;
        }
        let uuids = this.ours(m);
        // An older Claude Code names none: the one command_lifecycle said started, else the oldest still waiting, unless a report is due.
        if (!uuids.length && !Array.isArray(m.user_message_uuids) && !this.namesPrompts) {
            const started = this.startedUuid && this.prompts.has(this.startedUuid) ? this.startedUuid : undefined;
            const waiting = [...this.prompts.entries()].find(([, p]) => p.state === "sent" || p.state === "queued")?.[0];
            const pick = started ?? (this.dues.length ? undefined : waiting);
            if (pick) uuids = [pick];
        }
        this.startedUuid = undefined;
        for (const u of uuids) this.prompts.get(u)!.state = "started";
        this.resetTurnState(m);
        // One of Claude Code's own for what an earlier process left behind: no model call, nothing to show (#429).
        if (uuids.length) this.leftBehind = false;
        else if (this.leftBehind) {
            this.cur = { ref: `left-behind-${++wakeRefs}`, kind: "hidden" };
            liveDebug("claude", "turn: report of what was left behind (hidden)", { ref: this.cur.ref });
            return;
        }
        const first = uuids.length ? this.prompts.get(uuids[0]!)! : undefined;
        if (first?.kind === "carrier") {
            if (first.hidden) {
                this.cur = { ref: uuids[0]!, kind: "hidden" };
                liveDebug("claude", "turn: carrier (hidden)", { uuid: uuids[0] });
                return;
            }
            // The user's message, sent in place of the turn Esc stopped: theirs, adopted as a wake.
            this.startWake(uuids[0]!, { label: first.text, prompt: true });
            return;
        }
        if (first) {
            const ref = first.ref;
            this.cur = { ref, kind: this.wakeInfo.has(ref) ? "wake" : "user" };
            this.startGoalWatch();
            liveDebug("claude", "turn: started", { ref, uuids, continued: first.kind === "steer" });
            if (first.kind === "prompt") {
                this.events({ t: "turn_started", ref, origin: "user", answers: uuids });
                this.stillDue();
            }
            // Esc came after Claude Code took the prompt, before this (unstartedPrompt): stopped now, as on a running turn.
            if (this.stopOnStart.has(ref)) {
                this.followUp = this.stopOnStart.get(ref);
                this.stopOnStart.delete(ref);
                liveDebug("claude", "turn: started after Esc; stopping it", { ref });
                void this.interrupt(ref);
            } else if (this.turn().steerWanted) void this.steerSoon();
            return;
        }
        this.startWake(`wake-${++wakeRefs}`, { label: this.dues[0]?.label, ...(this.dues[0]?.report ? { report: this.dues[0].report } : {}) });
    }

    private startWake(ref: string, info: { label?: string; prompt?: boolean; report?: string }) {
        const due = this.dues.shift();
        if (due) clearTimeout(due.timer);
        this.wakeInfo.set(ref, info);
        this.cur = { ref, kind: "wake" };
        this.startGoalWatch();
        liveDebug("claude", "turn: wake", { ref, prompt: info.prompt });
        this.events({ t: "turn_started", ref, origin: "wake" });
        this.stillDue();
        if (this.turn().steerWanted) void this.steerSoon();
    }

    /** A prompt started after Esc withdrew it: stopped (sparing the sub-agents) without showing it. */
    private async interruptHidden() {
        const ref = this.cur?.ref;
        if (!ref) return;
        if (this.sendNowCap && this.runningAgents().length) {
            const r = await this.sendNow(ref, undefined);
            if (r === "stopped" || this.cur?.ref !== ref) return;
        }
        if (this.cur?.ref === ref) void this.control({ subtype: "interrupt" });
    }

    private resetTurnState(m: Record<string, any>) {
        this.inTool.clear();
        this.failure = undefined;
        this.diagnostic = undefined;
        this.signedOut = false;
        this.limitHit = false;
        this.reachedNoted = false;
        this.limits = undefined;
        this.contextTokens = undefined;
        if (typeof m.session_id === "string" && m.session_id && m.session_id !== this.sessionId) {
            this.sessionId = m.session_id;
            this.events({ t: "session_id", id: m.session_id });
        }
        // No API key behind it: the turn runs on the user's plan, not per-token billing.
        this.billedToPlan = m.apiKeySource === "none";
        if (typeof m.model === "string") this.resolvedModel = m.model;
        this.noteCapabilities(m.capabilities);
    }

    private noteCapabilities(caps: unknown) {
        if (Array.isArray(caps)) this.sendNowCap = caps.includes("interrupt_send_now_v1");
    }

    private startGoalWatch() {
        clearInterval(this.goalTimer);
        const env = (() => {
            try {
                return accountEnv(this.def.id, this.cfg.accountId, this.cfg.cwd);
            } catch {
                return {} as Record<string, string>;
            }
        })();
        const cwd = this.cfg.cwd;
        this.goals = new ClaudeGoalWatch(() => (this.sessionId ? claudeTranscriptFile(env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR, cwd, this.sessionId) : undefined), Date.now(), (goal) => this.emit({ type: "goal", goal }));
        this.goalTimer = setInterval(() => this.goals?.poll(), liveTiming.goalPollMs);
    }

    private onResult(m: Record<string, any>) {
        clearInterval(this.goalTimer);
        this.goals?.poll();
        this.reportFastMode(m);
        const turn = this.cur;
        this.cur = undefined;
        this.inTool.clear();
        const ids = [m.user_message_uuid, ...(Array.isArray(m.user_message_uuids) ? m.user_message_uuids : [])].filter((x): x is string => typeof x === "string" && x !== "");
        if (turn?.kind === "hidden") {
            liveDebug("claude", "turn: hidden ended", { ref: turn.ref });
            for (const id of [turn.ref, ...ids]) {
                // Over, with any other withdrawn message it took (withdrawnRunEnded no longer waits for them).
                this.withdrawn.delete(id);
                const p = this.prompts.get(id);
                if (p) p.state = "done";
            }
            return;
        }
        this.recordUsage(m, Boolean(turn && turn.kind === "user"));
        const failure = this.failureOf(m);
        if (!turn) {
            // A result with no turn: an error before one started (a session it can't resume) ends the prompt waiting.
            const waiting = [...this.prompts.entries()].find(([, p]) => p.kind === "prompt" && (p.state === "sent" || p.state === "queued"));
            liveDebug("claude", "result with no turn", { subtype: m.subtype, waiting: waiting?.[0] });
            if (!waiting) {
                this.failure ??= failure;
                return;
            }
            waiting[1].state = "done";
            return this.endTurn(waiting[1].ref, "error", failure ?? `${this.def.name} ended the turn with ${m.subtype}`);
        }
        const ref = turn.ref;
        // Its own calls that never got a result are over (not a background sub-agent's launch: that ends with it), and a
        // sub-agent working under one in the foreground with it: a skill's says nothing more once its turn is stopped.
        for (const [id, p] of this.tools) {
            if (this.launched.has(id)) continue;
            if (this.liveAgents.has(id) && !this.backgroundAgents.has(id)) this.endAgent(id, this.stopping.has(ref) ? "aborted" : "error");
            this.endTool(id, p, this.stopping.has(ref) ? "Interrupted by user" : `${this.def.name} stopped before this finished.`, true);
        }
        const reason: TurnEndReason = this.stopping.has(ref) ? "aborted" : m.subtype === "error_max_turns" ? "max_turns" : m.subtype !== "success" || m.is_error ? "error" : "done";
        const answered = this.answeredBy.get(ref) ?? [];
        const pending = this.outstanding.get(ref);
        if (pending) {
            const named = ids.filter((id) => pending.has(id));
            // An older Claude Code names none for a prompt's turn: it answered them all. A wake's result names none
            // (no message of the user's started it): what was steered into it comes as a turn of its own after.
            for (const id of named.length || ids.length || turn.kind !== "user" ? named : [...pending]) {
                pending.delete(id);
                answered.push(id);
                const p = this.prompts.get(id);
                if (p) p.state = "done";
            }
            // Taken into this turn and not named by its result (a synthetic one): answered with it all the same.
            for (const id of [...pending]) {
                const p = this.prompts.get(id);
                if (p?.kind !== "steer" || p.state !== "started") continue;
                pending.delete(id);
                p.state = "done";
            }
        } else answered.push(...ids);
        this.answeredBy.set(ref, answered);
        // A steering message written as its own turn ended, taken into a turn Claude Code started meanwhile (a wake's):
        // answered there, so its own turn has nothing more to wait for.
        for (const id of ids) {
            const p = this.prompts.get(id);
            if (!p || p.ref === ref || p.kind !== "steer" || p.state === "done" || p.state === "cancelled") continue;
            p.state = "done";
            this.outstanding.get(p.ref)?.delete(id);
            this.settleWaiting(p.ref);
        }
        // A steering message Claude Code runs as a turn of its own after this one: still this Cavvy turn.
        const left = [...(pending ?? [])].filter((id) => {
            const s = this.prompts.get(id)?.state;
            return s === "sent" || s === "queued";
        });
        if (left.length && reason !== "aborted" && reason !== "error") {
            liveDebug("claude", "turn: result, steering still to come", { ref, left });
            return;
        }
        // Messages to steer it with are being taken from the queue as it ends: they'll continue it, or it ends then (endHeld).
        if (this.draining.has(ref) && reason !== "aborted" && reason !== "error") {
            liveDebug("claude", "turn: result while steering is taken", { ref });
            this.heldEnds.set(ref, reason);
            return;
        }
        this.endTurn(ref, reason, reason === "error" ? failure : undefined, reason === "error" && this.limitHit ? limitStopOf(this.limits, this.limits?.reached ? this.limits.resetsAt : undefined) : undefined);
    }

    /** Cavvy turn is over: once only. `refused`: its prompt never reached Claude Code's session (unstartedPrompt). */
    private endTurn(ref: string, reason: TurnEndReason, error?: string, limit?: { resetsAt?: number; window?: string }, refused = false) {
        // Esc is withdrawing its steering messages: it ends once that's settled (withdrawing), as it ends now.
        if (this.withdrawals.has(ref)) {
            if (this.endsAfterWithdrawal.has(ref)) return;
            this.endsAfterWithdrawal.set(ref, [ref, reason, error, limit, refused]);
            // Claude Code has ended it: the stop was answered, and what's left is bounded (withdrawing).
            this.events({ t: "turn_ending", ref });
            return;
        }
        this.stopOnStart.delete(ref);
        this.heldEnds.delete(ref);
        const answers = this.answeredBy.get(ref) ?? [ref];
        for (const id of this.outstanding.get(ref) ?? []) {
            const p = this.prompts.get(id);
            // Steering messages it never took: Claude Code drops them with the turn (cancelled), or runs them later as a turn of their own.
            if (p && (p.state === "sent" || p.state === "queued")) p.state = "cancelled";
        }
        this.outstanding.delete(ref);
        this.answeredBy.delete(ref);
        this.stopping.delete(ref);
        for (const [id, p] of this.prompts) if (p.ref === ref && (p.state === "done" || p.state === "cancelled" || p.state === "started")) this.prompts.delete(id);
        liveDebug("claude", "turn: ended", { ref, reason, ...(error === undefined ? {} : { error: redact(error) }) });
        this.events({ t: "turn_ended", ref, answers: answers.length ? answers : [ref], reason, ...(error ? { error } : {}), ...(limit ? { limit } : {}), ...(refused ? { refused } : {}) });
        this.stillDue();
    }

    /** A steering message dropped while its turn waited for it: the turn ends once nothing else is to come. */
    private settleWaiting(ref: string) {
        if (this.cur?.ref === ref) return;
        const pending = this.outstanding.get(ref);
        if (!pending) return;
        const left = [...pending].filter((id) => {
            const s = this.prompts.get(id)?.state;
            return s === "sent" || s === "queued" || s === "started";
        });
        if (!left.length && (this.answeredBy.get(ref)?.length ?? 0) > 0) this.endTurn(ref, this.stopping.has(ref) ? "aborted" : "done");
    }

    private failureOf(m: Record<string, any>): string | undefined {
        if (m.subtype === "success" && !m.is_error) return undefined;
        const errs = Array.isArray(m.errors) ? m.errors.filter((x: unknown) => typeof x === "string") : [];
        let failure = this.failure ?? redact(errs.join("; ") || (typeof m.result === "string" && m.result) || `${this.def.name} ended the turn with ${m.subtype}`);
        if (this.signedOut) failure = `${this.def.name} isn't signed in, or its sign-in expired. ${signInAdvice(this.def.id, this.cfg.accountId)}`;
        return failure && this.diagnostic && !failure.includes(this.diagnostic) ? `${failure} ${this.diagnostic}` : failure;
    }

    /** A result's tokens and spend; `ours`: it answers a prompt of ours (a report turn that made no request counts nothing). */
    private recordUsage(m: Record<string, any>, ours: boolean) {
        const u = m.usage ?? {};
        const total = typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined;
        const sid = typeof m.session_id === "string" ? m.session_id : this.sessionId;
        const spentKey = sid ? `${this.cfg.accountId ?? "default"}:${sid}` : undefined;
        const before = spentKey ? this.spending.get(spentKey) : undefined;
        // Each result's total_cost_usd includes the session's earlier ones: what's new is this result's.
        const spent = total === undefined ? undefined : before === undefined ? total : Math.max(0, total - before);
        if (total !== undefined && spentKey) this.spending.set(spentKey, Math.max(total, before ?? 0));
        const usage: Usage = {
            inputTokens: Number(u.input_tokens ?? 0),
            outputTokens: Number(u.output_tokens ?? 0),
            cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
            cacheWriteTokens: Number(u.cache_creation_input_tokens ?? 0),
            ...(u.cache_creation && typeof u.cache_creation === "object" ? { cacheWrite1hTokens: Number(u.cache_creation.ephemeral_1h_input_tokens ?? 0) } : {}),
            cost: this.billedToPlan && !this.fastModeObserved ? 0 : spent,
            billing: this.billedToPlan && !this.fastModeObserved ? "plan" : "api",
        };
        const nothing = !ours && !usage.inputTokens && !usage.outputTokens && !usage.cacheReadTokens && !usage.cacheWriteTokens && !spent;
        if (nothing) return;
        const mixedPlanCost = this.billedToPlan && this.fastModeObserved && m.fast_mode_state !== "on";
        if (mixedPlanCost) {
            this.emit({ type: "notice", level: "info", message: "Claude Code changed speed during this turn. The displayed cost is its total estimate; the share covered by your plan is not reported." });
            usage.costEstimated = true;
        }
        const models = Object.keys(m.modelUsage ?? {});
        const served = models.length === 1 ? models[0] : models.find((id) => id === this.resolvedModel);
        if (served) usage.resolvedModel = `${this.def.id}:${served}`;
        const window = Object.values((m.modelUsage ?? {}) as Record<string, { contextWindow?: number }>).find((x) => typeof x?.contextWindow === "number")?.contextWindow;
        this.host.usage(usage, { contextTokens: this.contextTokens, contextWindow: window });
    }

    private reportFastMode(m: Record<string, any>) {
        if (m.fast_mode_state === "on") this.fastModeObserved = true;
        if (!this.cfg.fastMode || typeof m.fast_mode_state !== "string" || m.fast_mode_state === "on") return;
        const reason = typeof m.fast_mode_disabled_reason === "string" ? m.fast_mode_disabled_reason.replace(/_/g, " ") : m.fast_mode_state;
        if (reason === this.fastModeNotice) return;
        this.fastModeNotice = reason;
        this.emit({ type: "notice", level: "warn", message: `Claude Code is not using fast mode (${reason}). Account, organization settings or capacity can limit availability.` });
    }

    // ---- background tasks

    /** Background sub-agents the user's Esc stopped with a plain interrupt: their end is theirs. */
    private escStopped = new Set<string>();

    private runningAgents(): BackgroundTaskInfo[] {
        return [...this.tasks.values()].filter((t) => t.status === "running" && t.kind === "agent");
    }

    private reportTask(task: BackgroundTaskInfo, wakeDue?: boolean) {
        // Stopped by the plain interrupt of the user's Esc: theirs, no news to them.
        if (task.status === "stopped" && this.escStopped.delete(task.id)) task = { ...task, byUser: true };
        else if (task.status !== "running") this.escStopped.delete(task.id);
        const was = this.tasks.get(task.id);
        // One that ended stays ended, unless Claude Code lists it again (an id reused), or says it ended otherwise.
        if (was && was.status !== "running" && task.status !== "running" && !revises(was, task)) return;
        this.tasks.set(task.id, task);
        this.events({ t: "task", task, ...(wakeDue === undefined ? {} : { wakeDue }) });
    }

    private taskRunning(id: string, o: { type?: string; label?: string; toolUseId?: string; agent?: boolean }) {
        const was = this.tasks.get(id);
        const running = was?.status === "running" ? was : undefined;
        // A sub-agent's task listed again before its task_started says so (resumed, #458): its Agent call's.
        const toolUseId = o.toolUseId ?? running?.toolUseId ?? this.agentOfTask.get(id);
        const agent = Boolean(o.agent || (toolUseId && this.agentLabels.has(toolUseId)));
        const command = toolUseId ? this.bashCommands.get(toolUseId) : undefined;
        const task: BackgroundTaskInfo = {
            id,
            provider: this.def.id,
            kind: running && !o.type && !agent ? running.kind : taskKind(o.type ?? "", agent),
            // Redacted whole, then cut: a secret across the cut would leave a piece of itself unredacted.
            label: redact(o.label || running?.label || (toolUseId ? this.agentLabels.get(toolUseId) : undefined) || "background task").slice(0, 300),
            ...(command ? { command: redact(command).slice(0, 2000) } : {}),
            ...(toolUseId ? { toolUseId } : {}),
            startedAt: running?.startedAt ?? Date.now(),
            status: "running",
            stoppable: this.caps.stopTask,
        };
        if (toolUseId) this.taskOf.set(toolUseId, id);
        if (running && JSON.stringify(running) === JSON.stringify(task)) return;
        this.reportTask(task);
    }

    private taskEnded(id: string, status: Exclude<BackgroundTaskInfo["status"], "running">, wakeDue?: boolean) {
        const t = this.tasks.get(id);
        const timer = this.unlisted.get(id);
        if (timer) clearTimeout(timer);
        this.unlisted.delete(id);
        if (!t) return;
        // Said to have ended, then to have ended otherwise (a sub-agent done, then failed after all): so it did (#282).
        if (t.status !== "running") {
            if (revises(t, { status })) this.reportTask({ ...t, status });
            return;
        }
        this.reportTask({ ...t, status, endedAt: Date.now() }, wakeDue);
    }

    /**
     * Claude Code said a background task ended while no turn ran: it starts one with the report, which the
     * session waits for. Several at once each get a turn, one after another (as 2.1.304 runs them).
     */
    private reportDue(task: BackgroundTaskInfo, label: string | undefined, report?: string) {
        const was = this.dues.find((d) => d.task.id === task.id);
        if (was) clearTimeout(was.timer);
        const timer = setTimeout(() => {
            const i = this.dues.findIndex((d) => d.timer === timer);
            if (i < 0) return;
            this.dues.splice(i, 1);
            liveDebug("claude", "wake didn't come", { task: task.id, left: this.dues.length });
            // The session's flag is one for all of them: cleared only once none is due.
            if (!this.dues.length) this.events({ t: "task", task: this.tasks.get(task.id) ?? task, wakeDue: false });
        }, liveTiming.wakeDueMs);
        if (was) Object.assign(was, { label, report, timer, task });
        else this.dues.push({ label, report, timer, task });
    }

    /** A report that won't come after all (the notification went to a sub-agent). */
    private dropDue(id: string) {
        const i = this.dues.findIndex((d) => d.task.id === id);
        if (i < 0) return;
        clearTimeout(this.dues[i]!.timer);
        this.dues.splice(i, 1);
        if (!this.dues.length) this.events({ t: "task", task: this.tasks.get(id)!, wakeDue: false });
    }

    /** A turn started or ended, which the session takes as the report it waited for: the next one due is still to come. */
    private stillDue() {
        const next = this.dues[0];
        if (next) this.events({ t: "task", task: this.tasks.get(next.task.id) ?? next.task, wakeDue: true });
    }

    private onSystem(m: Record<string, any>) {
        this.reportFastMode(m);
        switch (m.subtype) {
            case "init":
                // A turn begins (each starts with one): from here on, what ends is this process's own.
                this.resuming = false;
                return this.onInit(m);
            case "background_tasks_changed": {
                if (!Array.isArray(m.tasks)) return;
                const listed = new Set<string>();
                for (const t of m.tasks) {
                    const id = typeof t?.task_id === "string" ? t.task_id : "";
                    if (!id) continue;
                    listed.add(id);
                    const timer = this.unlisted.get(id);
                    if (timer) clearTimeout(timer);
                    this.unlisted.delete(id);
                    this.taskRunning(id, { type: String(t.task_type ?? ""), label: typeof t.description === "string" ? t.description : "" });
                }
                // One that left the list: its notification usually follows; a shell or monitor without one has ended all the same.
                for (const t of this.tasks.values()) {
                    if (t.status !== "running" || listed.has(t.id) || t.kind === "agent" || this.unlisted.has(t.id)) continue;
                    this.unlisted.set(t.id, setTimeout(() => this.taskEnded(t.id, "done"), liveTiming.unlistedMs));
                }
                return;
            }
            case "task_started": {
                const toolUseId = String(m.tool_use_id ?? "");
                const taskId = typeof m.task_id === "string" ? m.task_id : undefined;
                if (taskId && typeof m.subagent_type === "string") this.agentTypes.set(taskId, m.subagent_type);
                if (taskId && toolUseId && !this.agentLabels.has(toolUseId) && this.resumedAgent(taskId, toolUseId, m)) return;
                if (taskId && this.agentLabels.has(toolUseId) && !this.agentOfTask.has(taskId)) this.agentOfTask.set(taskId, toolUseId);
                if (m.is_backgrounded === true && this.agentLabels.has(toolUseId)) this.backgroundAgents.add(toolUseId);
                if (taskId && toolUseId) this.taskOf.set(toolUseId, taskId);
                if (taskId && m.is_backgrounded === true) this.taskRunning(taskId, { type: typeof m.task_type === "string" ? m.task_type : undefined, label: typeof m.description === "string" ? m.description : undefined, toolUseId: toolUseId || undefined });
                this.agentStarted(toolUseId);
                return;
            }
            case "task_updated": {
                const id = typeof m.task_id === "string" ? m.task_id : "";
                const patch = m.patch ?? {};
                if (!id) return;
                if (patch.is_backgrounded === true) this.taskRunning(id, {});
                if (patch.status === "completed") this.taskEnded(id, "done");
                else if (patch.status === "failed") this.taskEnded(id, "failed");
                else if (patch.status === "killed" || patch.status === "stopped") this.taskEnded(id, "stopped");
                return;
            }
            case "task_progress":
                this.agentUsage(this.agentCall(String(m.tool_use_id ?? "")), m.usage);
                return;
            case "task_notification":
                return this.onTaskNotification(m);
            case "api_retry": {
                const delay = Number(m.retry_delay_ms ?? m.delay_ms ?? 0);
                const why = [m.error_status, typeof m.error === "string" ? m.error : m.error?.message].filter(Boolean).join(" ");
                this.emit({ type: "retry", attempt: Number(m.attempt ?? 1), delayMs: delay, reason: why || "Claude Code is retrying the request" });
                return;
            }
            case "compact_boundary":
                this.emit({ type: "notice", level: "info", message: "Claude Code compacted its context." });
                return;
            case "informational":
                if (typeof m.content === "string" && m.content.trim()) {
                    const level = m.level === "warning" ? "warn" : m.level === "error" ? "error" : "info";
                    this.emit({ type: "notice", level, message: m.content, data: cliNotice(this.def.id, level, m.content) });
                }
                return;
        }
    }

    private onTaskNotification(m: Record<string, any>) {
        const taskId = typeof m.task_id === "string" ? m.task_id : "";
        const status = typeof m.status === "string" ? m.status : "";
        const summary = typeof m.summary === "string" ? m.summary.trim() : "";
        const known = taskId ? this.tasks.get(taskId) : undefined;
        // Not every notification names the call (one for a stop may not): the task's own does. A resumed sub-agent's
        // names the SendMessage call that resumed it: it's its Agent call's (#458).
        const toolUseId = this.agentCall(String(m.tool_use_id ?? known?.toolUseId ?? ""));
        const ended: Exclude<BackgroundTaskInfo["status"], "running"> = status === "completed" ? "done" : status === "failed" ? "failed" : "stopped";
        // Reported in a turn Claude Code starts by itself, when none runs (not for a stop: none follows that).
        const reports = Boolean(known && !this.cur && (status === "completed" || status === "failed") && m.owned_by_subagent !== true);
        if (taskId) this.taskEnded(taskId, ended);
        if (reports && known) {
            // What it reported, for the wake (shown and told if the session can't take it over, #305): a command's output (#430).
            const said = (typeof m.handback_report?.text === "string" ? m.handback_report.text : undefined) ?? (toolUseId ? this.lastWords.get(toolUseId) : undefined) ?? (known.kind === "shell" ? this.commandReport(taskId, m, summary) : undefined) ?? (summary || undefined);
            this.reportDue(known, dueLabel(known, ended), said?.trim() ? redact(said.trim()) : undefined);
            liveDebug("claude", "report due", { task: taskId, due: this.dues.length });
            this.events({ t: "task", task: this.tasks.get(taskId)!, wakeDue: true });
        } else if (taskId) this.dropDue(taskId);
        if (taskId) this.commands.delete(taskId);
        if (!this.agentLabels.has(toolUseId)) {
            // One an earlier process left behind (stopped with it), said as the session is resumed. Not a command of this
            // process's that ended (a foreground one stopped by Esc, a sub-agent's that failed): its own row says so (#311).
            // Claude Code then takes a turn of its own for it: this notice is all the user sees of it (#429).
            if (this.resuming && !known && m.owned_by_subagent !== true && (status === "stopped" || status === "failed")) {
                this.leftBehind = true;
                if (summary) this.emit({ type: "notice", level: "info", message: `Claude Code: ${summary}.` });
            }
            return;
        }
        const background = this.backgroundAgents.has(toolUseId);
        let report = typeof m.handback_report?.text === "string" ? m.handback_report.text : undefined;
        // In the background its report goes to the main agent in a turn of its own: what it said last.
        if (report === undefined && background && status === "completed") report = this.lastWords.get(toolUseId) ?? (summary || undefined);
        this.agentStarted(toolUseId);
        this.agentUsage(toolUseId, m.usage);
        this.endAgent(toolUseId, status === "completed" ? "done" : status === "failed" ? "error" : "aborted", report);
    }

    // ---- what Claude Code says and does (as ClaudeTurn maps it)

    /** An event of the turn running now (a hidden one shows nothing); between turns, the session's. */
    private emit(e: AgentEvent) {
        if (this.cur?.kind === "hidden") {
            // The carrier's own steps show nothing. Background work's (a sub-agent's steps, report and end, its launch
            // call's end) isn't the carrier's: the session's, as between turns.
            if (this.ofBackground(e)) this.events({ t: "turn_event", event: e });
            return;
        }
        this.events({ t: "turn_event", ...(this.cur ? { ref: this.cur.ref } : {}), event: e });
    }

    /** A sub-agent's event, or one of the call that launched it. */
    private ofBackground(e: AgentEvent): boolean {
        if (e.type === "subagent") return true;
        return (e.type === "tool_start" || e.type === "tool_end") && (this.agentLabels.has(e.call.id) || this.closedLaunches.has(e.call.id));
    }

    private onStreamEvent(e: Record<string, any>) {
        switch (e.type) {
            case "message_start":
                this.emit({ type: "request_start" });
                break;
            case "content_block_start":
                if (e.content_block?.type === "tool_use") {
                    this.streamingTools.set(e.index, e.content_block.id);
                    this.emit({ type: "tool_call_start", id: e.content_block.id, name: toCavvy(String(e.content_block.name ?? ""), {}).name });
                }
                break;
            case "content_block_delta": {
                const d = e.delta ?? {};
                if (d.type === "text_delta" && d.text) this.emit({ type: "text", text: d.text });
                else if (d.type === "thinking_delta" && d.thinking) this.emit({ type: "thinking", text: d.thinking });
                else if (d.type === "input_json_delta" && d.partial_json) {
                    const id = this.streamingTools.get(e.index);
                    if (id) this.emit({ type: "tool_call_delta", id, partial: d.partial_json });
                }
                break;
            }
        }
    }

    private onAssistant(m: Record<string, any>) {
        const msg = m.message ?? {};
        const blocks: any[] = Array.isArray(msg.content) ? msg.content : [];
        const parent = this.parentOf(m);
        if (parent) {
            const label = this.agentLabels.get(parent) ?? "sub-agent";
            this.agentStarted(parent);
            const over = this.endedAgents.has(parent);
            for (const b of blocks) {
                if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) this.lastWords.set(parent, b.text);
                if (b?.type !== "tool_use") continue;
                if (b.name === "SubagentHandback") {
                    const fresh = typeof b.input?.message === "string" && this.report(parent, b.input.message);
                    const was = this.endedAgents.get(parent);
                    if (fresh && over && was !== undefined) this.emit({ type: "subagent", parentId: parent, label, event: { type: "turn_end", reason: was } });
                    continue;
                }
                if (over) continue;
                const { name, input } = toCavvy(b.name, b.input ?? {});
                const title = titleFor(name, input);
                this.subTools.set(b.id, { name, input, title, started: Date.now(), parent });
                this.emit({ type: "subagent", parentId: parent, label, event: { type: "tool_start", call: { type: "tool_call", id: b.id, name, input }, title } });
            }
            return;
        }
        if (msg.usage) {
            const u = msg.usage;
            const tokens = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0) + Number(u.output_tokens ?? 0);
            if (tokens && tokens !== this.contextTokens && this.cur?.kind !== "hidden") this.host.context?.(tokens);
            this.contextTokens = tokens;
        }
        if (m.error) {
            this.onAssistantError(String(m.error));
            const detail = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
            if (detail.trim()) this.diagnostic = redact(detail);
            return;
        }
        for (const b of blocks) {
            if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
                this.emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: b.text }], provider: this.def.id, model: this.cfg.model.id } });
            } else if (b?.type === "tool_use" && typeof b.id === "string") {
                const { name, input } = toCavvy(b.name, b.input ?? {});
                const title = titleFor(name, input);
                this.tools.set(b.id, { name, input, title, started: Date.now() });
                if (this.cur) this.inTool.add(b.id);
                if (b.name === "Agent" || b.name === "Task") this.agentLabels.set(b.id, String(input.description ?? input.subagent_type ?? "sub-agent"));
                // A skill can run as its own agent (/code-review does): one only if its steps come (task_started, its messages).
                if (b.name === "Skill") this.agentLabels.set(b.id, String(input.skill ?? "skill"));
                if (b.name === "Bash" && typeof b.input?.command === "string") {
                    this.bashCommands.set(b.id, b.input.command);
                    if (this.bashCommands.size > 100) this.bashCommands.delete(this.bashCommands.keys().next().value!);
                }
                this.emit({ type: "tool_start", call: { type: "tool_call", id: b.id, name, input }, title });
            }
        }
    }

    private onAssistantError(error: string) {
        if (error === "authentication_failed") {
            this.signedOut = true;
            this.failure = `Claude Code isn't signed in, or its sign-in expired. ${signInAdvice(this.def.id, this.cfg.accountId)}`;
        } else if (error === "rate_limit") {
            this.limitHit = true;
            this.noteLimits(limitStopReport(this.def.id, this.cfg.accountId ?? "default"), true);
            this.failure = this.limitFailure();
        } else if (error === "billing_error") this.failure = "Claude Code reported a billing problem with the account it's signed in to.";
        else this.failure = `Claude Code reported an error: ${error}`;
    }

    private onToolResults(m: Record<string, any>) {
        const blocks: any[] = (Array.isArray(m.message?.content) ? m.message.content : []).filter((b: any) => b?.type === "tool_result");
        for (const b of blocks) {
            const p = this.tools.get(b.tool_use_id);
            if (!p) continue;
            let content = resultText(b.content);
            if (p.name === "Task") {
                // Its result names the sub-agent (agentId: its task's id), for one whose task_started didn't come.
                const agentId = m.tool_use_result?.agentId;
                if (typeof agentId === "string" && agentId && !this.agentOfTask.has(agentId)) this.agentOfTask.set(agentId, b.tool_use_id);
                const background = m.tool_use_result?.status === "async_launched";
                if (background) {
                    this.backgroundAgents.add(b.tool_use_id);
                    this.agentStarted(b.tool_use_id);
                    const taskId = this.taskOf.get(b.tool_use_id);
                    // Its task (listed with its task id): a sub-agent in the background, by the call that launched it.
                    if (taskId) this.taskRunning(taskId, { agent: true, toolUseId: b.tool_use_id });
                    const was = this.endedAgents.get(b.tool_use_id);
                    if (was === undefined) {
                        // Its call is open while the sub-agent works, and ends with it (with its report, and how long it ran).
                        this.launched.add(b.tool_use_id);
                        continue;
                    }
                    content = this.reports.get(b.tool_use_id) ?? LAUNCH_END[was] ?? content;
                    this.closedLaunches.set(b.tool_use_id, { ...p, reason: was, ended: Date.now() });
                    this.endTool(b.tool_use_id, p, content, endedBadly(was));
                    continue;
                }
                const report = handedBack(m);
                if (!this.endedAgents.has(b.tool_use_id)) this.endAgent(b.tool_use_id, b.is_error ? "error" : "done", report);
                else if (report) this.report(b.tool_use_id, report, true);
                content = this.reports.get(b.tool_use_id) || content;
            }
            // A skill that ran as its own agent: Claude Code says nothing more of it than its call's result, which ends it,
            // with what it returned; declined while it worked, it was stopped, not failed.
            // Ended already (Claude Code said so first): what it returned is still its report.
            if (p.name === "Skill" && this.liveAgents.has(b.tool_use_id)) this.endAgent(b.tool_use_id, b.is_error ? (DECLINED.test(content) ? "aborted" : "error") : "done", b.is_error ? undefined : content);
            else if (p.name === "Skill" && this.endedAgents.has(b.tool_use_id) && !b.is_error) this.report(b.tool_use_id, content, true);
            // A command now in the background: what it runs, and the file its output goes to (its result says, as 2.1.304's does).
            const bg = blocks.length === 1 ? m.tool_use_result?.backgroundTaskId : undefined;
            if (typeof bg === "string" && bg) {
                this.commands.set(bg, { command: typeof p.input.command === "string" ? p.input.command : undefined, file: /Output is being written to: (\S+?\.output)\b/.exec(content)?.[1] });
                if (this.commands.size > 64) this.commands.delete(this.commands.keys().next().value!);
            }
            const structured = blocks.length === 1 && !b.is_error ? resultDisplay(p, m.tool_use_result, this.cfg.cwd) : undefined;
            this.endTool(b.tool_use_id, p, content, Boolean(b.is_error), structured);
        }
    }

    /**
     * A background command's report, as Codex's says it (#430): the command, how it ended, and the end of its output,
     * from the file Claude Code writes it to, in its task-output folder (outputTail). The file the notification (or the
     * call that started it) names must be that one. Undefined when there's no such file to read: the summary stands.
     */
    private commandReport(id: string, m: Record<string, any>, summary: string): string | undefined {
        const known = this.commands.get(id);
        const dir = taskOutputDir(this.cfg.cwd, this.sessionId);
        const named = (typeof m.output_file === "string" && m.output_file) || known?.file;
        if (!dir || !named || basename(named) !== `${id}.output`) return undefined;
        try {
            if (realpathSync(dirname(named)) !== dir) return undefined;
        } catch {
            return undefined;
        }
        const out = outputTail(dir, id);
        if (out === undefined) return undefined;
        // Each redacted whole, then cut: a secret across the cut would leave a piece of itself unredacted.
        let clean = redact(out.text);
        if (out.partial) {
            // Read from part way, a secret the read starts in isn't recognised: what's left of a known one (all its lines)
            // is within the first of them as long as the longest, and of a known-format key (one line) within the first
            // line. Kept: what the whole read redacts to after the line break past both (a secret across it left out whole).
            const at = out.text.indexOf("\n", Math.max(0, ...knownSecrets().map((s) => s.length)));
            if (at < 0) return undefined;
            clean = clean.slice(redactPrefix(out.text, at + 1).length);
        }
        clean = clean.trimEnd();
        const tail = clean.length > REPORT_OUTPUT_CHARS ? `…${clean.slice(-REPORT_OUTPUT_CHARS)}` : clean;
        const command = known?.command ? redact(known.command).trim() : undefined;
        const what = command ? `\`${command.length > 300 ? `${command.slice(0, 300)}…` : command}\`` : `"${this.tasks.get(id)?.label ?? "background command"}"`;
        const code = /exit code (-?\d+)/.exec(summary)?.[1];
        const ended = m.status === "failed" ? "failed" : "finished";
        return `The background command ${what} ${ended}${code === undefined ? "" : ` with exit code ${code}`}.${tail.trim() ? ` The end of its output:\n${tail}` : " It printed nothing."}`;
    }

    private onSubToolResults(m: Record<string, any>) {
        this.agentStarted(this.parentOf(m) ?? "");
        const blocks: any[] = (Array.isArray(m.message?.content) ? m.message.content : []).filter((b: any) => b?.type === "tool_result");
        for (const b of blocks) {
            const p = this.subTools.get(b.tool_use_id);
            if (!p) continue;
            const content = (p.name === "Task" && (this.reports.get(b.tool_use_id) || (blocks.length === 1 && handedBack(m)))) || resultText(b.content);
            const structured = blocks.length === 1 && !b.is_error ? resultDisplay(p, m.tool_use_result, this.cfg.cwd) : undefined;
            this.endSubTool(b.tool_use_id, p, content, Boolean(b.is_error), structured);
        }
    }

    private endSubTool(id: string, p: PendingTool & { parent: string }, content: string, isError: boolean, display?: ToolDisplay) {
        this.subTools.delete(id);
        const label = this.agentLabels.get(p.parent) ?? "sub-agent";
        this.emit({ type: "subagent", parentId: p.parent, label, event: { type: "tool_end", call: { type: "tool_call", id, name: p.name, input: p.input }, result: { content, isError, display }, durationMs: Date.now() - p.started } });
    }

    private report(parent: string, text: string, replace = false): boolean {
        const had = this.reports.get(parent);
        if (!text.trim() || (had !== undefined && (!replace || had.trim() === text.trim()))) return false;
        this.reports.set(parent, text);
        if (this.liveAgents.has(parent) || this.endedAgents.has(parent)) this.emit({ type: "subagent", parentId: parent, label: this.agentLabels.get(parent) ?? "sub-agent", event: { type: "text", text } });
        const p = this.closedLaunches.get(parent);
        if (p) this.relaunchEnd(parent, p, text);
        return true;
    }

    private agentUsage(id: string, u: unknown) {
        const total = Number((u as { total_tokens?: unknown } | undefined)?.total_tokens);
        if (!Number.isFinite(total) || !(this.liveAgents.has(id) || this.endedAgents.has(id))) return;
        const had = this.agentTokens.get(id) ?? 0;
        if (total <= had) return;
        this.agentTokens.set(id, total);
        this.emit({ type: "subagent", parentId: id, label: this.agentLabels.get(id) ?? "sub-agent", event: { type: "usage", usage: { inputTokens: total - had, outputTokens: 0 }, cost: { usd: 0, estimated: true, unknown: true }, contextTokens: total } });
    }

    private closeLaunch(id: string, reason: TurnEndReason) {
        const closed = this.closedLaunches.get(id);
        if (closed) {
            if (endedBadly(closed.reason) === endedBadly(reason)) return;
            closed.reason = reason;
            this.relaunchEnd(id, closed, this.reports.get(id) ?? LAUNCH_END[reason] ?? LAUNCH_END.aborted!);
            return;
        }
        const p = this.tools.get(id);
        if (!p || !this.launched.delete(id)) return;
        this.closedLaunches.set(id, { ...p, reason, ended: Date.now() });
        this.endTool(id, p, this.reports.get(id) ?? LAUNCH_END[reason] ?? LAUNCH_END.aborted!, endedBadly(reason));
    }

    private relaunchEnd(id: string, p: PendingTool & { reason: TurnEndReason; ended: number }, content: string) {
        this.emit({ type: "tool_end", call: { type: "tool_call", id, name: p.name, input: p.input }, result: { content, isError: endedBadly(p.reason) }, durationMs: p.ended - p.started });
    }

    private agentStarted(id: string) {
        if (this.agentLabels.has(id) && !this.endedAgents.has(id)) this.liveAgents.add(id);
    }

    /** The call a sub-agent runs as here, for a call that resumed it (SendMessage) or one an earlier process started it with. */
    private agentCall(id: string): string {
        return this.resumedBy.get(id) ?? id;
    }

    /**
     * The sub-agent a message of a sub-agent's is from: the call it runs as here. Claude Code 2.1.304 tags a resumed
     * one's messages with the Agent call that first started it (parent_tool_use_id) and its task id (agent_id).
     */
    private parentOf(m: Record<string, any>): string | undefined {
        const raw = typeof m.parent_tool_use_id === "string" && m.parent_tool_use_id ? m.parent_tool_use_id : undefined;
        if (!raw) return undefined;
        const agentId = typeof m.agent_id === "string" ? m.agent_id : undefined;
        // Started by a call an earlier process made (resumed from the session's transcript): it runs as the SendMessage call here.
        const stranger = agentId ? this.strangers.get(agentId) : undefined;
        if (stranger && raw !== stranger && !this.agentLabels.has(raw) && !this.subTools.has(raw) && !this.resumedBy.has(raw)) this.resumedBy.set(raw, stranger);
        return this.agentCall(raw);
    }

    /**
     * A sub-agent Claude Code starts again: SendMessage to one that had finished (#458). As 2.1.304 says it, its
     * task_started has the task id it ran with before (the agent's id) and the SendMessage call's id, not its Agent
     * call's. It's that sub-agent going on: running again, its steps and report its run's, its task its row's. One this
     * process didn't start (it was resumed from an earlier process's transcript) runs as that SendMessage call. False:
     * not a sub-agent resumed.
     */
    private resumedAgent(taskId: string, callId: string, m: Record<string, any>): boolean {
        let agent = this.agentOfTask.get(taskId);
        if (agent === undefined || !this.agentLabels.has(agent)) {
            if (m.task_type !== "local_agent" || m.owned_by_subagent === true || !this.tools.has(callId)) return false;
            agent = callId;
            this.agentLabels.set(agent, typeof m.description === "string" && m.description.trim() ? m.description : "sub-agent");
            this.agentOfTask.set(taskId, agent);
            this.strangers.set(taskId, agent);
        } else this.resumedBy.set(callId, agent);
        const background = m.is_backgrounded === true;
        if (!this.liveAgents.has(agent)) {
            // What it said, reported and used before is its earlier run's; its launch's row keeps that run's result.
            for (const kept of [this.reports, this.lastWords, this.agentTokens, this.closedLaunches, this.endedAgents]) kept.delete(agent);
            if (background) this.backgroundAgents.add(agent);
            else this.backgroundAgents.delete(agent);
            this.liveAgents.add(agent);
            this.emit({ type: "subagent", parentId: agent, label: this.agentLabels.get(agent)!, event: { type: "request_start" } });
        }
        if (background) this.taskRunning(taskId, { type: typeof m.task_type === "string" ? m.task_type : undefined, label: typeof m.description === "string" ? m.description : undefined, toolUseId: agent });
        return true;
    }

    private endAgent(id: string, reason: TurnEndReason, report?: string) {
        const live = this.liveAgents.delete(id);
        const was = this.endedAgents.get(id);
        if (!live && was === undefined) {
            if (report) this.report(id, report, true);
            this.closeLaunch(id, reason);
            return;
        }
        this.endedAgents.set(id, reason);
        const reported = report ? this.report(id, report, true) : false;
        if (!live && !reported && reason === was) return;
        for (const [sub, p] of this.subTools) if (p.parent === id) this.endSubTool(sub, p, reason === "done" ? "Claude Code didn't report a result for this." : "Stopped with the sub-agent.", true);
        this.closeLaunch(id, reason);
        this.emit({ type: "subagent", parentId: id, label: this.agentLabels.get(id) ?? "sub-agent", event: { type: "turn_end", reason } });
    }

    private endTool(id: string, p: PendingTool, content: string, isError: boolean, display?: ToolDisplay) {
        this.tools.delete(id);
        this.emit({ type: "tool_end", call: { type: "tool_call", id, name: p.name, input: p.input }, result: { content, isError, display }, durationMs: Date.now() - p.started });
    }

    private noteLimits(limits: PlanLimits, partial: boolean) {
        this.limits = mergeLimits(this.limits, limits, partial);
        this.events({ t: "limits", limits, partial });
    }

    private limitFailure(): string {
        return `${limitAccountLabel(this.def.id, this.cfg.accountId)}: usage limit reached. ${resetSentence(this.limits?.resetsAt, "Claude Code")} Choose another account with /account or the plan meter, then send again.`;
    }

    private onRateLimit(info: Record<string, any>) {
        const parsed = parseClaudeRateLimit(info, Date.now(), this.cfg.accountId ?? "default");
        if (parsed) this.noteLimits(parsed.limits, parsed.partial);
        const w = parsed?.limits.windows.find((x) => x.id === info.rateLimitType);
        const news = typeof info.status === "string" && limitNews(this.limitSeen, `${this.cfg.accountId ?? "default"}:${String(info.rateLimitType ?? "")}`, info.status, w?.resetsAt);
        if (info.status !== "rejected" && info.status !== "allowed_warning") return;
        const which = w ? `${w.label.charAt(0).toLowerCase()}${w.label.slice(1)} ` : "";
        if (info.status === "rejected") {
            if (this.limitHit) this.failure = this.limitFailure();
            if (this.reachedNoted) return;
            this.reachedNoted = true;
            // On extra usage it isn't a stop: the turn goes on, and it costs.
            const credits = creditsNote(this.limits, "extra usage");
            this.emit({ type: "notice", level: "warn", message: `${limitAccountLabel(this.def.id, this.cfg.accountId)}: ${which}usage limit reached${credits}. ${resetSentence(this.limits?.resetsAt, "Claude Code")}`, data: { source: this.def.id, limit: limitNotice(this.def.id, this.cfg.accountId, this.limits, { window: w?.label, credits: Boolean(credits) }) } });
        } else if (news) this.emit({ type: "notice", level: "info", message: `${limitAccountLabel(this.def.id, this.cfg.accountId)}: close to the ${which}usage limit.${w?.resetsAt ? ` It resets ${resetPhrase(w.resetsAt)}.` : ""}`, data: { source: this.def.id } });
    }

    // ---- control

    /** False when it didn't go: Claude Code's stdin is gone (known once the write is done: JsonLinesProcess.send). */
    /** `priority` "now": taken at once, cutting what the model is writing (see steerOnce). */
    private sendUser(uuid: string, content: unknown[], synthetic = false, priority?: "now"): Promise<boolean> {
        return this.proc.send({ type: "user", uuid, message: { role: "user", content }, parent_tool_use_id: null, session_id: this.sessionId ?? "", ...(synthetic ? { isSynthetic: true } : {}), ...(priority ? { priority } : {}) });
    }

    /** Send a control request; its answer, or undefined when none comes (the CLI went away, or `timeoutMs` passed). */
    private control(request: Record<string, unknown>, timeoutMs = liveTiming.controlMs): Promise<Record<string, any> | undefined> {
        if (this.ended) return Promise.resolve(undefined);
        const id = requestId();
        if (request.subtype !== "initialize") liveDebug("claude", "control", { subtype: request.subtype });
        return new Promise((resolve) => {
            const timer = Number.isFinite(timeoutMs)
                ? setTimeout(() => {
                      this.controls.delete(id);
                      liveDebug("claude", "control: no answer", { subtype: request.subtype });
                      resolve(undefined);
                  }, timeoutMs)
                : undefined;
            this.controls.set(id, (r) => {
                clearTimeout(timer);
                if (request.subtype !== "initialize") liveDebug("claude", "control: answer", { subtype: request.subtype, ok: r?.subtype });
                resolve(r);
            });
            this.proc.send({ type: "control_request", request_id: id, request });
        });
    }

    /** Cavvy's MCP server for delegation: set when it's new or its tools changed, before a prompt goes. */
    private async attach() {
        const o = this.cfg.orchestrator;
        const servers = o && !this.cfg.readOnly
            ? {
                  [o.name]: {
                      type: "http",
                      url: o.url,
                      headers: { Authorization: o.authorization },
                      timeout: o.toolTimeoutSec * 1000,
                      alwaysLoad: true,
                      tools: o.tools.map((name) => ({ name, permission_policy: "always_allow" })),
                  },
              }
            : {};
        const key = JSON.stringify(servers);
        if (key === (this.mcpKey ?? "{}")) return;
        this.mcpKey = key;
        const r = await this.control({ subtype: "mcp_set_servers", servers }, attachTiming.timeoutMs);
        const names = Object.keys(servers);
        // CLI errors may echo arbitrary env/header values; names and static reasons only.
        const failed = !r || r.subtype !== "success" ? names : names.filter((name) => r.response?.errors?.[name]);
        if (failed.length) {
            // Tried again with the next prompt.
            this.mcpKey = undefined;
            this.emit({ type: "notice", level: "warn", message: `Claude Code ${!r ? "timed out waiting for" : "couldn't connect to"} MCP servers: ${failed.map((name) => redact(name)).join(", ")}.` });
        }
    }

    private hookRegistration(): { hooks?: Record<string, { matcher?: string; hookCallbackIds: string[]; timeout?: number }[]> } {
        const hooksCfg = this.cfg.hooks;
        if (!hooksCfg || !this.host.hookHandler) return {};
        const hooks: Record<string, { matcher?: string; hookCallbackIds: string[]; timeout?: number }[]> = {};
        let n = 0;
        for (const [event, list] of Object.entries(hooksCfg) as [HookEvent, HookConfig[]][]) {
            const called = list.filter((hook) => hook.type !== "prompt");
            if (!called.length) continue;
            hooks[event] = called.map((hook) => {
                const id = `cavvy_${n++}`;
                this.hookCallbacks.set(id, { event, hook });
                return { ...(hook.matcher ? { matcher: backendMatcher(event, hook.matcher) } : {}), hookCallbackIds: [id], timeout: hook.timeout ?? 60 };
            });
        }
        return n ? { hooks } : {};
    }

    private async onControlRequest(m: Record<string, any>) {
        const req = m.request ?? {};
        const reply = (response: Record<string, unknown>) => this.proc.send({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });
        if (req.subtype === "hook_callback") {
            const cb = this.hookCallbacks.get(String(req.callback_id ?? ""));
            const handler = this.host.hookHandler;
            if (!cb || !handler) return reply({});
            const input: Record<string, unknown> = req.input && typeof req.input === "object" ? req.input : {};
            // Cavvy's browser tools run the hooks themselves, as BrowserAct and the rest: this CLI's run would be a second one.
            if (servedBrowserTool(this.cfg.orchestrator?.name, input.tool_name)) return reply({});
            // The session's signal, not a turn's: a background sub-agent's hooks run between turns too.
            const r = await handler(cb.event, cb.hook, input, this.hookAbort.signal).catch(() => undefined);
            reply(r ? claudeCodeHookOutput(cb.event, r) : {});
            return;
        }
        if (req.subtype !== "can_use_tool") {
            this.proc.send({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: `${String(req.subtype)} isn't supported by this host` } });
            return;
        }
        try {
            reply({ ...(await this.permission(req)), toolUseID: req.tool_use_id });
        } catch (e) {
            reply({ behavior: "deny", message: `The permission check failed: ${redact((e as Error).message)}`, interrupt: true, toolUseID: req.tool_use_id });
        }
    }

    private async permission(req: Record<string, any>): Promise<Record<string, unknown>> {
        const raw: Record<string, unknown> = req.input && typeof req.input === "object" ? req.input : {};
        if (req.tool_name === "AskUserQuestion") {
            const qs: any[] = Array.isArray(raw.questions) ? raw.questions : [];
            const questions = qs.map((q) => ({
                question: String(q?.question ?? ""),
                header: typeof q?.header === "string" ? q.header : undefined,
                options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({ label: String(o?.label ?? ""), description: typeof o?.description === "string" ? o.description : undefined })),
                multiSelect: Boolean(q?.multiSelect),
            }));
            const answers = await this.host.askQuestions(questions);
            if (!answers) return { behavior: "deny", message: "The user dismissed the question without answering.", interrupt: true };
            return { behavior: "allow", updatedInput: { ...raw, answers: Object.fromEntries(questions.map((q, i) => [q.question, (answers[i] ?? []).join(", ")])) } };
        }
        if (req.tool_name === "ExitPlanMode") {
            const r = await this.host.approvePlan(String(raw.plan ?? ""));
            if (r.approved) {
                const mode = r.mode ?? "default";
                this.host.setMode(mode);
                return { behavior: "allow", updatedInput: raw, updatedPermissions: [{ type: "setMode", mode: MODES[mode], destination: "session" }] };
            }
            const fb = r.feedback?.trim();
            if (r.handoff) return { behavior: "deny", message: `The user is carrying out this plan in another session instead. ${fb ?? ""} Don't continue it here.`, interrupt: true };
            return fb ? { behavior: "deny", message: `The user wants changes to the plan:\n${fb}` } : { behavior: "deny", message: "The user rejected the plan. Wait for them to say how to proceed.", interrupt: true };
        }
        const own = this.cfg.orchestrator;
        if (own && own.tools.some((t) => req.tool_name === `mcp__${own.name}__${t}`)) return { behavior: "allow", updatedInput: raw };
        const { name, input } = toCavvy(String(req.tool_name ?? ""), raw);
        const reason = typeof req.decision_reason === "string" && req.decision_reason.trim() ? req.decision_reason : undefined;
        const agentType = typeof req.agent_id === "string" ? this.agentTypes.get(req.agent_id) : undefined;
        // One of a background sub-agent's (its task is running in the background): not the turn's to withdraw.
        const background = typeof req.agent_id === "string" && this.tasks.get(req.agent_id)?.status === "running";
        liveDebug("claude", "permission", { tool: name, between: !this.cur, agent: req.agent_id });
        const a = await this.host.permission({ toolName: name, input, title: titleFor(name, input), reason, callId: typeof req.tool_use_id === "string" ? req.tool_use_id : undefined, ...(agentType ? { agentType } : {}), ...(background ? { background: true } : {}) });
        if (a.allow) return { behavior: "allow", updatedInput: a.updatedInput ?? raw, ...(a.mode ? { updatedPermissions: [{ type: "setMode", mode: MODES[a.mode], destination: "session" }] } : {}) };
        return { behavior: "deny", message: a.message, interrupt: a.stop };
    }
}

/** How a live session's process is started, and spoken to: one per Cavvy session, as each has its own turn settings. */
class ClaudeCliAdapter implements AgentCliAdapter {
    readonly def: AgentCliDef;
    /** The turn under way, or the last one (set before each). */
    current?: LiveTurnConfig;
    conn?: ClaudeConnection;
    /** The account (claudeAccountKey) the last process was started with, kept after it ends. */
    accountKey?: string;

    constructor(
        private provider: ProviderDef,
        private spending: Map<string, number>,
        private limitSeen: Map<string, string>,
        private statusOf: (accountId: string | undefined, signal?: AbortSignal) => Promise<{ status: AgentCliStatus }>,
        private models: (signal?: AbortSignal) => Promise<ModelInfo[]>,
    ) {
        const base = agentCli("claude-code")!;
        this.def = { ...base, id: provider.id, name: provider.name };
    }

    spawn(cfg: SpawnConfig): SpawnSpec {
        const bin = requireCli(this.def.id, CLAUDE_CLI);
        const env = accountEnv(this.def.id, cfg.accountId, cfg.cwd);
        const t = cfg as BackendTurn;
        const { pluginDir } = claudeSkills(this.def.id, t);
        const agentsPath = cfg.agents && Object.keys(cfg.agents).length && !cfg.readOnly ? agentsFileFor(cfg.agents) : undefined;
        const o = { pluginDir, agentsPath, append: [cfg.appendSystemPrompt] };
        const { args } = claudeArgs(this.def.id, cfg, o);
        // Without what changes on a running process (the model, effort, mode and fast mode) and the session it resumes.
        // Nor the account folders' deny rules: adding or removing an account restarts nothing (#375); a new process has them.
        const fixed = claudeArgs(this.def.id, { ...cfg, model: { ...cfg.model, id: "default", effortLevels: undefined, supportsFastMode: false }, effort: undefined, mode: "default", fastMode: false, resumeId: undefined, forkSession: false }, { ...o, accountDenies: false }).args;
        const fingerprint = spawnFingerprint({ bin, args: fixed, cwd: cfg.cwd, env, hooks: cfg.hooks ?? null });
        return { bin, args, cwd: cfg.cwd, env, fingerprint };
    }

    async connect(proc: JsonLinesProcess, events: CliEventSink, host: SessionHost, resume?: { resumeId?: string }): Promise<CliConnection> {
        const t = this.current?.t;
        if (t) this.accountKey = claudeAccountKey(this.def.id, t);
        const conn = new ClaudeConnection(proc, events, host, this.def, () => this.current!, this.spending, this.limitSeen, Boolean(resume?.resumeId));
        this.conn = conn;
        liveDebug("claude", "spawned", { pid: proc.pid });
        await conn.initialize();
        return conn;
    }

    status(accountId: string | undefined, signal?: AbortSignal) {
        return this.statusOf(accountId, signal);
    }

    listModels(signal?: AbortSignal) {
        return this.models(signal);
    }
}

/** The account a turn runs on, as its home's environment: another needs another process. */
function claudeAccountKey(provider: string, t: Pick<BackendTurn, "accountId" | "cwd">): string {
    try {
        return spawnFingerprint({ env: accountEnv(provider, t.accountId, t.cwd) });
    } catch {
        return `${t.accountId ?? "default"}?`;
    }
}

/** Cavvy's skills Claude Code doesn't read itself, as a plugin of their own; and the name it runs each by. */
function claudeSkills(provider: string, t: Pick<BackendTurn, "skills" | "cwd" | "trusted" | "accountId">): { pluginDir?: string; names: Map<string, string> } {
    const configDir = t.skills?.length ? claudeConfigDir(provider, t as BackendTurn) : undefined;
    const plugged = t.skills?.length ? forClaudeCode(t.skills, t.cwd, t.trusted, configDir) : [];
    const pluginDir = skillFolder(plugged, { plugin: true });
    const names = claudeNames(t.skills ?? [], pluginDir ? plugged : [], t.cwd, t.trusted, configDir);
    return { pluginDir, names };
}

/** Collects a turn's text and actions for its BackendResult, passing its events on. */
export class TurnRecord {
    private texts: string[] = [];
    private actions: string[] = [];
    private ended = new Set<string>();
    /** The reply being written (its words so far: its assistant frame isn't in yet), and how much of it a take had. */
    private writing = "";
    private writingTaken = 0;
    /** Calls under way, by id: their titles. */
    private running = new Map<string, string>();
    any = false;
    readonly sink: TurnSink;

    constructor(private inner: TurnSink) {
        this.sink = {
            ...inner,
            emit: (e) => {
                if (e.type === "request_start") {
                    this.writing = "";
                    this.writingTaken = 0;
                } else if (e.type === "text") this.writing += e.text;
                else if (e.type === "assistant") {
                    let text = e.message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
                    // Its start went before a message steered in while it was written (take): the rest goes after it.
                    if (this.writingTaken && text.startsWith(this.writing.slice(0, this.writingTaken))) text = text.slice(this.writingTaken);
                    this.writing = "";
                    this.writingTaken = 0;
                    if (text.trim()) this.texts.push(text);
                    this.any = true;
                } else if (e.type === "tool_start") this.running.set(e.call.id, titleFor(e.call.name, (e.call.input ?? {}) as Record<string, unknown>));
                else if (e.type === "tool_end" && !this.ended.has(e.call.id)) {
                    this.ended.add(e.call.id);
                    this.running.delete(e.call.id);
                    this.actions.push(titleFor(e.call.name, (e.call.input ?? {}) as Record<string, unknown>));
                    this.any = true;
                }
                inner.emit(e);
            },
        };
    }

    /**
     * What it said and did since this was last taken. `inFlight`: for a message steered in now, which Claude Code
     * takes after them: with the words of the reply being written and the calls under way.
     */
    take(inFlight = false): BackendResult {
        if (inFlight) {
            const words = this.writing.slice(this.writingTaken);
            if (words.trim()) this.texts.push(words);
            this.writingTaken = this.writing.length;
            for (const [id, title] of this.running) {
                this.ended.add(id);
                this.actions.push(title);
            }
            this.running.clear();
        }
        return { reason: "done", text: this.texts.splice(0).join("\n\n"), actions: this.actions.splice(0) };
    }
}

/** Claude Code's live sessions (one per Cavvy session) for a ClaudeCodeBackend. */
export class ClaudeLive {
    readonly pool: LiveCliPool;
    /** The host each session's last turn bound: wakes and session events go to it. */
    private hosts = new Map<string, SessionHost>();
    private bound = new Set<LiveCliSession>();

    constructor(
        private provider: ProviderDef,
        shared: { spending: Map<string, number>; limitSeen: Map<string, string> },
        statusOf: (accountId: string | undefined, signal?: AbortSignal) => Promise<{ status: AgentCliStatus }>,
        models: (signal?: AbortSignal) => Promise<ModelInfo[]>,
        o: Partial<LiveOptions> & { maxIdle?: number } = {},
    ) {
        // An adapter per session (the pool makes one with each): it's told what turn is under way.
        this.pool = new LiveCliPool(() => new ClaudeCliAdapter(provider, shared.spending, shared.limitSeen, statusOf, models), { idleMs: liveTiming.idleMs, stopConfirmMs: liveTiming.stopConfirmMs, ...o });
    }

    get(key: string): LiveCliSession | undefined {
        return this.pool.get(key, this.provider.id);
    }

    private adapter(key: string): ClaudeCliAdapter | undefined {
        return this.get(key)?.adapter as ClaudeCliAdapter | undefined;
    }

    async runTurn(t: BackendTurn): Promise<BackendResult> {
        const key = t.sessionKey;
        let live = this.pool.session(key, this.provider.id);
        // Another CLI session than the one running (rewound, forked from, a fresh start after the account changed or
        // the old one couldn't be resumed): the old process goes, and what runs under it.
        if (!t.adopt && live.sessionId && t.resumeId !== live.sessionId) {
            const tasks = live.tasks.running().length;
            liveDebug("claude", "session changed: releasing", { key, was: live.sessionId, now: t.resumeId, tasks });
            await this.release(key);
            if (tasks) t.sink.emit({ type: "notice", level: "warn", message: `Claude Code's earlier session was let go: ${plural(tasks, "background task")} stopped with it.` });
            live = this.pool.session(key, this.provider.id);
        }
        // The same CLI session on another account (one sharing its history, #377): never on the process signed in as
        // the one it was switched from, even with background work running (which a restart would otherwise wait for).
        // Let go, not restarted: a fresh one resumes it, and says so if the new account's CLI can't (resumeFailed).
        const was = this.adapter(key)?.accountKey;
        const otherAccount = was !== undefined && was !== claudeAccountKey(this.provider.id, t);
        // A turn the earlier account's process started by itself is never taken over under another account's session
        // (the switch lets that process go: Runtime.setAccount). Refused before anything is bound or drained, so a
        // message waiting to be steered into it goes with the next turn instead, on the new account.
        if (t.adopt && otherAccount) {
            liveDebug("claude", "wake from another account's process: not taken", { key, ref: t.adopt });
            return { reason: "error", text: "", actions: [], error: "Claude Code's turn ran on the account this session switched from, so it isn't taken over." };
        }
        if (!t.adopt && otherAccount) {
            const tasks = live.tasks.running().length;
            liveDebug("claude", "account changed: releasing", { key, id: live.sessionId, tasks });
            await this.release(key);
            if (tasks) t.sink.emit({ type: "notice", level: "warn", message: `Claude Code was restarted for the account change: ${plural(tasks, "background task")} stopped.` });
            live = this.pool.session(key, this.provider.id);
        }
        // A copy of this session was forked off (/fork): its CLI session is to be forked, not continued in place (the
        // copy forks it later, and would see what's added here). With nothing in the background the process goes and
        // the next one forks it; with work running that would stop it, so the turn goes on in place.
        if (!t.adopt && t.forkSession && live.sessionId && t.resumeId === live.sessionId && live.state !== "dead") {
            const quiet = live.quiet();
            liveDebug("claude", quiet ? "fork asked: releasing to fork" : "fork asked with background work running: continuing in place", { key, id: live.sessionId, tasks: live.tasks.running().length });
            if (quiet) {
                await this.release(key);
                live = this.pool.session(key, this.provider.id);
            }
        }
        const adapter = this.adapter(key)!;
        this.hosts.set(key, t.session);
        this.watch(key, live);
        const rec = new TurnRecord(t.sink);
        const { names } = claudeSkills(this.provider.id, t);
        // What Cavvy put before the user's words goes in a block of its own before theirs (see textBlocks).
        const { preamble, text: prompt } = splitPreamble(claudePrompt(t.prompt, t.request, t.skills ?? [], names, formatSkill, t.requestAfter), t.preamble);
        adapter.current = {
            t,
            context: t.goalContext ?? preamble,
            steer: async ({ live, recording }) => {
                // What the turn said and did up to now, the reply it's writing and the calls it's running too: Claude
                // Code takes the message after them.
                const queued = await rec.sink.drainQueued(() => (recording(), rec.take(true)), live);
                // One with attachments (settle) is the user's, whatever its words.
                const fromWake = (m: SteerMessage) => !m.settle && Boolean(rec.sink.fromWake?.(m.text));
                const typed = queued.filter((m) => !fromWake(m));
                const woke = queued.filter(fromWake);
                const settles = typed.flatMap((m) => (m.settle ? [m.settle.bind(m)] : []));
                return [
                    ...(typed.length
                        ? [{
                              text: typed.map((m) => m.text).filter(Boolean).join("\n\n"),
                              images: typed.flatMap((m) => m.images),
                              documents: typed.flatMap((m) => m.documents),
                              parts: typed,
                              ...(settles.length ? { settle: async (sent: boolean) => void (await Promise.all(settles.map((s) => s(sent)))) } : {}),
                          }]
                        : []),
                    ...(woke.length ? [{ text: woke.map((m) => m.text).join("\n\n"), synthetic: true, parts: woke }] : []),
                ];
            },
            undelivered: (messages) => rec.sink.undelivered?.(messages),
            // What was sent to steer with before this subscribed (below) goes once the turn starts.
            steerWanted: true,
        };
        // A message to steer with goes to Claude Code as it's sent, not at the next step (Codex's turn/steer does the same).
        const stopSteering = t.sink.onQueued?.(() => {
            if (adapter.current?.t !== t) return;
            adapter.current.steerWanted = true;
            void this.adapter(key)?.conn?.steerSoon();
        });
        let r: LiveTurnResult;
        try {
            if (t.adopt) {
                live.bind(t.session);
                r = await live.adopt(t.adopt, rec.sink, t.signal).catch((e) => ({ reason: "error" as const, error: (e as Error).message }));
            } else {
                r = await live.runTurn({ text: prompt, images: t.images, documents: t.documents, synthetic: t.synthetic }, rec.sink, t.signal, { spawn: t, settings: { model: t.model, mode: t.mode, effort: t.effort, fastMode: t.fastMode }, host: t.session });
            }
        } finally {
            stopSteering?.();
        }
        if (adapter.current?.t === t) adapter.current = { t };
        liveDebug("claude", "turn result", { key, ref: r.ref, reason: r.reason, unanswered: r.unanswered, deferred: r.deferred });
        if (r.unanswered) t.sink.emit({ type: "notice", level: "warn", message: "Claude Code didn't answer the stop in time. The turn ended here; its process is kept, with what it runs in the background. If it stays busy, restart it with /tasks restart (that stops its background work)." });
        if (r.deferred) t.sink.emit({ type: "notice", level: "info", message: `New Claude Code settings apply once its background work ends (${plural(r.deferred.tasks, "task")} running). /tasks restart applies them now, stopping it.` });
        const out = rec.take();
        const error = r.error;
        const resumeFailed = Boolean(t.resumeId && !t.adopt && r.reason === "error" && !live.sessionId && /no conversation found|session.{0,40}(not found|doesn't exist|does not exist)/i.test(error ?? ""));
        if (r.reason === "error") return { ...out, reason: "error", error: resumeFailed ? `Couldn't resume the Claude Code session: ${error}` : (error ?? "Claude Code stopped with an error."), resumeFailed, ...(r.limit ? { limit: r.limit } : {}), ...(r.refused && !t.adopt ? { refused: true } : {}) };
        if (r.reason === "done" && !rec.any && !t.adopt && !t.prompt.trimStart().startsWith("/")) t.sink.emit({ type: "notice", level: "warn", message: "Claude Code ended the turn without a reply." });
        return { ...out, reason: r.reason, ...(r.refused && !t.adopt ? { refused: true } : {}) };
    }

    /** Each live session's wakes and session-level events, to the host its last turn bound. */
    private watch(key: string, live: LiveCliSession) {
        if (this.bound.has(live)) return;
        this.bound.add(live);
        live.onWake((w) => {
            const info = this.adapter(key)?.conn?.wakeInfo.get(w.ref);
            liveDebug("claude", "wake → host", { key, ref: w.ref, prompt: info?.prompt });
            this.hosts.get(key)?.onWake?.({ provider: this.provider.id, ref: w.ref, ...(info?.label ? { label: info.label } : {}), ...(info?.prompt ? { prompt: true } : {}), ...(info?.report ? { report: info.report } : {}) });
        });
        live.onEvent((e: CliEvent) => {
            const host = this.hosts.get(key);
            if (!host) return;
            // The process's own account: after a switch, what it still reports is that account's (the next turn replaces it).
            if (e.t === "task") host.emitSession?.({ type: "background_task", task: e.task, accountId: live.account });
            else if (e.t === "turn_event") host.emitSession?.({ type: "event", event: e.event });
            else if (e.t === "limits") host.limits?.(e.limits, e.partial);
        });
    }

    async stopBackground(key: string, ids?: string[]): Promise<Record<string, BackgroundStop>> {
        const live = this.get(key);
        if (!live) return Object.fromEntries((ids ?? []).map((id) => [id, "unknown" as const]));
        return live.stopTasks(ids);
    }

    sendNow(key: string, text: string): boolean {
        const conn = this.adapter(key)?.conn;
        const live = this.get(key);
        // Not while one waits to go, or the running turn is being stopped already (its interrupt took what was waiting).
        if (!conn || !live || live.state !== "busy" || !conn.sendNowCap || !conn.running() || conn.followUp !== undefined || conn.stoppingNow()) return false;
        conn.followUp = text;
        liveDebug("claude", "sendNow", { key, chars: text.length });
        return true;
    }

    /** The user's permission mode changed: each running process takes its session's now. */
    setMode() {
        for (const [key, host] of this.hosts) {
            const live = this.get(key);
            const conn = this.adapter(key)?.conn;
            if (conn && live && live.state !== "dead" && live.state !== "stopping") conn.setMode(host.mode());
        }
    }

    async restart(key: string): Promise<void> {
        await this.get(key)?.restart();
    }

    /** What a wake turn no session takes over said (AgentBackendClient.wakeReport), from whichever process has it. */
    async wakeReport(ref: string): Promise<string | undefined> {
        const live = this.pool.list().find((s) => s.hasWake(ref));
        // However long its turn takes: what it says late isn't dropped.
        const text = await live?.wakeText(ref);
        return text?.trim() ? redact(text.trim()) : undefined;
    }

    async release(key: string): Promise<void> {
        liveDebug("claude", "release", { key, tasks: this.get(key)?.tasks.running().length ?? 0 });
        const live = this.get(key);
        // Its host still hears what stops with it (its background tasks, stopped with the process).
        await this.pool.release(key, this.provider.id);
        if (live) this.bound.delete(live);
        if (!this.get(key)) this.hosts.delete(key);
    }

    async shutdown(): Promise<void> {
        await this.pool.shutdownAll();
    }
}
