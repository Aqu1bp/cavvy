// Codex on the live CLI layer (#219 PR 3): one `codex app-server` per harness
// session, started at its first turn and kept across turns (src/backends/live).
// The per-turn path in codex.ts (CodexTurn.run) is what agentCli.liveSessions
// false still runs; this reuses its protocol mapping (items, approvals, hooks,
// sub-agents, goals, the mode's policy) and changes who owns the process:
//
// - A turn of the harness's is one or more Codex turns, each a LiveCliSession
//   turn named by its Codex turn id: the prompt's, then a restart under a new
//   mode, a follow-up, or messages the user queued meanwhile.
// - Esc interrupts the turn (turn/interrupt, and its sub-agents' turns). The
//   app-server stays, and so do the background terminals its commands started.
// - A command still running when its turn ends is a background task of the
//   session (stop: thread/backgroundTerminals/terminate). When it ends after its
//   turn, Codex says nothing to the model, so the connection starts a turn that
//   tells it (codex.wakeOnBackgroundCommand), which the session adopts as a wake.
// - A turn Codex starts by itself (the goal's next) is a wake as well.
// - Plan limits come with turns; between them status reads go to the live
//   app-server (account/rateLimits/read).

import type { PermissionMode } from "../permissions/modes";
import type { ProviderDef } from "../providers/registry";
import type { PlanLimits } from "../server/protocol";
import { accountEnv } from "../providers/accounts";
import { APP_TITLE, APP_VERSION } from "../config/paths";
import { redact } from "../util/redact";
import { registerTools } from "../mcp/server";
import { accountPermissionConfig, accountPermissionProfile, watchAccountFolders } from "./account-permissions";
import { CODEX_CLI, extraArgs, requireCli, type JsonLinesProcess } from "./cli";
import { CODEX_HOOK_EVENTS, CODEX_HOOK_SERVER, codexHookArgs } from "./codex-hooks";
import { codexInput, pastedPrompt, type CodexSkill } from "./native-skills";
import { limitAccountLabel, resetSentence } from "./limits";
import { agentCli, type CliCapabilities } from "./defs";
import { LiveCliPool } from "./live/pool";
import { spawnFingerprint, type LiveCliSession, type LiveTurnResult, type LiveWake } from "./live/session";
import type { AgentCliAdapter, CliConnection, CliEvent, CliEventSink, LiveSettings, SpawnConfig, SpawnSpec } from "./live/types";
import type { BackgroundTaskInfo } from "./live/info";
import { liveDebug, liveDebugOn } from "./live/debug";
import type { BackendResult, BackendTurn, BackgroundStop, SessionHost, TurnSink } from "./types";
import type { AgentCliStatus } from "./index";
import {
    CODEX_CLIENT_NAME,
    CodexTurn,
    FAST_TIERS,
    LISTENER_NOTE,
    Rpc,
    answerOf,
    codexGoalCommand,
    codexPolicy,
    hookServerConfig,
    liveCodexRpcs,
    modeNote,
    modeSwitched,
    orchestratorConfig,
    parseAccount,
    untrustedArgs,
    withTimeout,
    type CodexBackend,
    type LimitOrdering,
    type OpenItem,
    type SubAgent,
    type TurnOutput,
} from "./codex";

/** How long finished background commands are gathered before a turn tells Codex (two ending together make one turn). */
const NOTE_SETTLE_MS = 50;
/** A background command the list no longer has, with no word of its end: taken as gone after this long. */
const UNLISTED_MS = 1000;
/** Output of a finished background command that goes to Codex, at most. */
const NOTE_OUTPUT_CHARS = 4000;

const clip = (s: string, n = 120) => {
    const one = s.trim().split("\n")[0]!;
    return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** What one Codex turn of a harness turn sends. */
interface Segment {
    kind: "prompt" | "compact";
    text: string;
    images: BackendTurn["images"];
    /** The user's message as typed, which `text` ends with (then `after`): its /name and $name are skills. */
    request?: string;
    after: string;
    /** Make the goal active once this turn has started. */
    activate?: boolean;
    /** The user's queued messages `text` carries: saved for the next turn if this one can't start. */
    queued?: string;
    /** The harness turn's first: its skills and a /goal command are read here. */
    first?: boolean;
    /**
     * turn/start is under way: from here its failure keeps `queued` (startSegment); before, the run does if the
     * segment never goes out (stopped first: LiveCliSession sends nothing once the signal is aborted).
     */
    started?: boolean;
    /** Why it's sent (HARNESS_DEBUG). */
    why: "prompt" | "compact" | "mode-restart" | "follow-up" | "unsent" | "queued" | "goal-under-mode";
}

/** What a Codex turn said and did, with how it failed. */
interface LiveOutput extends TurnOutput {
    failure?: string;
}

const newOutput = (): LiveOutput => ({ texts: [], actions: [], answer: { parts: [], last: "" } });

/** One turn of the harness's on a live app-server: the user's prompt (with what follows it), an adopted wake, or a compaction. */
export class LiveRun {
    /** Its Codex turns. */
    readonly turns = new Set<string>();
    readonly out: LiveOutput = newOutput();
    next: Segment;
    skills?: CodexSkill[];
    skillsRead = false;
    failure?: string;
    aborted = false;
    /** The connection it last ran on (a crash starts another). */
    conn?: CodexLiveConnection;
    stopSteering?: () => void;
    onAbort?: () => void;
    saidDeferred = false;

    constructor(
        readonly t: BackendTurn,
        readonly compact = false,
    ) {
        this.next = compact ? { kind: "compact", text: "", images: [], after: "", why: "compact" } : { kind: "prompt", text: t.prompt, images: t.images, request: t.request, after: t.requestAfter ?? "", first: true, why: "prompt" };
    }
}

/** A command still running when its turn ended: a background task until it ends. */
interface Terminal {
    itemId: string;
    /** Its thread (the session's, or the one it had before a fork). */
    threadId: string;
    processId: string;
    command: string;
    startedAt: number;
    ended?: boolean;
    /** The user asked for it to stop. */
    stopping?: boolean;
    unlisted?: ReturnType<typeof setTimeout>;
}

/** Something Codex should hear: with the next turn, or (`wake`) in a turn of its own. */
interface Note {
    text: string;
    label: string;
    wake: boolean;
}

/**
 * A live connection to one app-server: its thread, mapped as CodexTurn maps it, for every turn on it. Turn
 * events go to the LiveCliSession under the Codex turn they're in; background terminals and sub-agents still
 * working when their turn ends are reported as tasks.
 */
export class CodexLiveConnection extends CodexTurn {
    readonly done: Promise<void>;
    /** What the live session drives it with. */
    readonly cli: CliConnection;
    /** The harness turn on it now. */
    liveRun?: LiveRun;
    /** The run the app-server was opened for: it read the account already. */
    private accountReadFor?: LiveRun;
    /** The main thread's turn running now. */
    private mainTurn?: string;
    /** What turns not (yet) a run's said and did: Codex's own, or one of ours before turn/start answered. */
    private outs = new Map<string, LiveOutput>();
    private scratch: LiveOutput = newOutput();
    /** Main-thread turns that started while a prompt was being sent (the session holds their events). */
    private promptFlight?: string[];
    /** turn/starts of ours on their way: a wake's label waits for them. */
    private flights = new Set<Promise<void>>();
    /** Main-thread turns that started while a turn/start of ours was unanswered: whose they are waits for its answer. */
    private undecided: string[] = [];
    /** Turns started here to tell Codex something (host wakes), with what the wake row says. */
    private hostTurns = new Map<string, string>();
    private hostStarting = false;
    private hostFailures = 0;
    private terminals = new Map<string, Terminal>();
    /** Sub-agent threads still working after their turn ended. */
    private bgSubs = new Map<string, { stopping?: boolean }>();
    /** Each sub-agent thread's root turn on the main thread. */
    private subRoots = new Map<string, string>();
    private notes: Note[] = [];
    private noteTimer?: ReturnType<typeof setTimeout>;
    /** thread/backgroundTerminals/* work (they need experimentalApi). */
    private terminalsApi = true;
    private closing = false;
    private stopAccountWatch?: () => void;
    private compactWaiter?: (ref: string) => void;
    private tierNow?: string | null;
    private seq = 0;
    private accountPermissions?: Record<string, unknown>;
    /** What the thread was opened with: a fork in place takes the same. */
    private threadParams?: Record<string, unknown>;
    private readonly router: TurnSink;

    constructor(
        private adapter: CodexLiveAdapter,
        def: ProviderDef,
        t: BackendTurn,
        proc: JsonLinesProcess,
        private events: CliEventSink,
        private host: SessionHost,
        labels: Map<string, string>,
        limits: LimitOrdering,
    ) {
        super(def, t, labels, limits);
        this.rpc = new Rpc(proc, (m, p) => this.notified(m, p), (m, p) => this.onRequest(m, p), liveDebugOn() ? (dir, m) => this.debugRpc(dir, m) : undefined);
        this.done = this.rpc.done;
        void this.rpc.done.then(() => this.gone());
        liveCodexRpcs.set(this, { accountId: t.accountId ?? "default", rpc: this.rpc });
        const caps: CliCapabilities = agentCli("codex")!.caps;
        this.cli = {
            caps,
            done: this.done,
            open: (o) => this.open(o),
            prompt: () => this.prompt(),
            interrupt: (ref) => this.interruptTurn(ref),
            stopTask: (id) => this.stopTask(id),
            apply: () => this.apply(),
            close: () => this.close(),
        };
        this.router = {
            emit: (e) => this.route(e),
            drainQueued: (progress, live) => this.liveRun?.t.sink.drainQueued(progress, live) ?? [],
            undelivered: (texts) => this.liveRun?.t.sink.undelivered?.(texts),
            fromWake: (text) => this.liveRun?.t.sink.fromWake?.(text) ?? false,
            requestOf: (text) => this.liveRun?.t.sink.requestOf?.(text),
            diagnose: (paths) => this.liveRun?.t.sink.diagnose?.(paths) ?? Promise.resolve(undefined),
        };
    }

    // ---------------------------------------------------------------------
    // What the mapping (CodexTurn) reaches, redirected.

    /** Events go to the turn they're in; outside any turn, to the harness turn running (or, a notice, the session). */
    protected override get sink(): TurnSink {
        return this.router;
    }

    /** The session's host, as bound now (it outlives turns). */
    protected override get cliSession(): SessionHost {
        return this.host;
    }

    protected override output(): TurnOutput {
        const id = this.mainTurn;
        if (id && this.liveRun?.turns.has(id)) return this.liveRun.out;
        if (id) return this.outFor(id);
        return this.liveRun?.out ?? this.scratch;
    }

    /** A failure of a turn that isn't the run's goes with that turn (its wake shows it). */
    protected override fail(error: any, fallback: string) {
        const id = this.mainTurn;
        if (!id || this.liveRun?.turns.has(id)) return super.fail(error, fallback);
        this.outFor(id).failure = redact(String(error?.message ?? fallback));
        if (error?.codexErrorInfo === "usageLimitExceeded") {
            this.limitUpdates.revision++;
            if (!this.limits?.reached) this.noteLimits({ provider: this.def.id, accountId: this.t.accountId ?? "default", windows: [], reached: true, at: Date.now() }, true);
        }
    }

    protected override onItemStarted(item: any, sub?: SubAgent) {
        super.onItemStarted(item, sub);
        if (sub || item?.type !== "commandExecution" || typeof item.processId !== "string" || !item.processId) return;
        const open = this.items.get(String(item.id ?? ""));
        if (open) open.processId = item.processId;
    }

    protected override onItemCompleted(item: any, turn: string | undefined, sub?: SubAgent) {
        const term = sub ? undefined : this.terminals.get(String(item?.id ?? ""));
        if (term) return this.terminalEnded(term, item);
        super.onItemCompleted(item, turn, sub);
    }

    private route(e: Parameters<TurnSink["emit"]>[0]) {
        const ref = this.mainTurn;
        if (ref !== undefined) return this.events({ t: "turn_event", ref, event: e });
        // The harness turn running here (while the thread opens, the one it opens for).
        const run = this.liveRun ?? this.adapter.run;
        if (run) return run.t.sink.emit(e);
        if (e.type === "notice") return this.host.emitSession?.({ type: "notice", level: e.level, message: e.message });
        liveDebug("codex", "event dropped (no turn)", { type: e.type });
    }

    private outFor(id: string): LiveOutput {
        let o = this.outs.get(id);
        if (!o) {
            this.outs.set(id, (o = newOutput()));
            // Turns no run took: only the last few are kept.
            if (this.outs.size > 32) this.outs.delete(this.outs.keys().next().value!);
        }
        return o;
    }

    /** A turn becomes the run's: what it said so far goes with the run's. */
    private absorb(run: LiveRun, id: string) {
        run.turns.add(id);
        const o = this.outs.get(id);
        if (!o) return;
        this.outs.delete(id);
        run.out.texts.push(...o.texts);
        run.out.actions.push(...o.actions);
        if (o.answer.parts.length || o.answer.last) run.out.answer = o.answer;
        if (o.failure) this.failure ??= o.failure;
    }

    // ---------------------------------------------------------------------
    // CliConnection

    async initialize(): Promise<void> {
        // experimentalApi: thread/backgroundTerminals/list and /terminate need it (checked with 0.163).
        await withTimeout(this.rpc.request("initialize", { clientInfo: { name: CODEX_CLIENT_NAME, title: APP_TITLE, version: APP_VERSION }, capabilities: { experimentalApi: true } }), 30_000, "Codex didn't start (no answer to initialize)");
        this.rpc.notify("initialized");
    }

    /** How Codex is signed in now (it bills the plan or the API key), and the plan's limits. */
    private async readAccount(): Promise<void> {
        const account = parseAccount(await withTimeout(this.rpc.request("account/read", {}), 20_000, "Codex didn't answer account/read"));
        if (!account.type && account.requiresAuth) throw new Error(`Codex isn't signed in. In a terminal, run \`${CODEX_CLI.signIn}\`, then try again.`);
        this.billedToPlan = account.type === "chatgpt";
        if (this.billedToPlan) void this.readLimits();
    }

    /** Sign-in, the hooks Codex runs itself, MCP servers, and the thread: started, resumed or forked. */
    async open(o: { resumeId?: string; fork?: boolean; settings: LiveSettings }): Promise<{ sessionId: string }> {
        const t = this.t;
        await this.readAccount();
        this.accountReadFor = this.adapter.run;
        this.accountPermissions = accountPermissionConfig(t.additionalDirectories);
        this.nativeEvents = CODEX_HOOK_EVENTS.filter((e) => this.hooked(e));
        if (this.nativeEvents.length) {
            this.hookServer = registerTools(this.nativeEvents.map((e) => this.hookTool(e)));
            this.nativeHooks = await this.hooksTaken(t.cwd);
        }
        // The harness's skills are registered before the thread opens, so its first turn has them (as on the per-turn path).
        const run = this.adapter.run;
        if (run && !run.compact && !run.t.adopt && !run.skillsRead) {
            run.skills = await this.nativeSkills(t);
            run.skillsRead = true;
        }
        const startMode = this.host.mode();
        const model = o.settings.model.id === "default" ? undefined : o.settings.model.id;
        let orch = t.orchestrator;
        const overrides = await this.mcpOverrides(t.cwd, Boolean(t.readOnly), [orch?.name, this.nativeHooks ? CODEX_HOOK_SERVER : undefined].filter((n): n is string => Boolean(n)));
        if (typeof overrides === "string") throw new Error(overrides);
        const off = overrides.config;
        if (overrides.collisions.includes(CODEX_HOOK_SERVER)) {
            this.sink.emit({ type: "notice", level: "warn", message: `Codex already has a server named ${CODEX_HOOK_SERVER}; it is disabled, and ${APP_TITLE} runs your hooks the older way in this session${this.nativeEvents.includes("PreToolUse") ? ", asking about every command so your PreToolUse hooks see them" : ""}.` });
            this.nativeHooks = false;
        }
        const policy = codexPolicy(startMode, t.additionalDirectories, Boolean(t.readOnly), this.hooked("PreToolUse") && !this.nativeHooks);
        if (orch && overrides.collisions.includes(orch.name)) {
            this.sink.emit({ type: "notice", level: "warn", message: "Codex already has a server named harness; it is disabled and this session runs without Harness delegation to avoid merging server configurations." });
            orch = undefined;
        }
        const baseInstructions = [t.appendSystemPrompt, LISTENER_NOTE].filter(Boolean).join("\n\n") || undefined;
        const developerInstructions = [baseInstructions, orch?.instructions].filter(Boolean).join("\n\n") || undefined;
        let config: Record<string, unknown> | undefined = orch && !t.readOnly ? { ...off, mcp_servers: { ...off?.mcp_servers, ...(orchestratorConfig(orch).mcp_servers as Record<string, unknown>) } } : off;
        if (this.nativeHooks && this.hookServer) config = { ...config, mcp_servers: { ...(config?.mcp_servers as Record<string, unknown> | undefined), ...hookServerConfig(this.hookServer) } };
        if (this.accountPermissions) config = { ...config, ...this.accountPermissions };
        const fastTier = o.settings.fastMode && t.model.supportsFastMode ? t.model.fastModeTier : undefined;
        this.threadMode = startMode;
        const threadParams = { cwd: t.cwd, model, ...(fastTier ? { serviceTier: fastTier } : {}), approvalPolicy: policy.approvalPolicy, ...(this.accountPermissions ? { permissions: accountPermissionProfile(startMode, t.readOnly) } : { sandbox: policy.sandbox }), approvalsReviewer: policy.approvalsReviewer, developerInstructions, ...(config ? { config } : {}) };
        // A Codex that won't take the delegation server's config still gets its thread, without it.
        this.threadParams = threadParams;
        const thread = async (method: string, params: Record<string, unknown>) => {
            try {
                return await this.rpc.request(method, params);
            } catch (e) {
                // Never fall back by dropping account denies: fail closed instead.
                if (!orch || this.accountPermissions) throw e;
                const kept = this.nativeHooks && this.hookServer ? { ...off, mcp_servers: { ...off?.mcp_servers, ...hookServerConfig(this.hookServer) } } : off;
                this.threadParams = { ...threadParams, config: kept, developerInstructions: baseInstructions };
                const r = await this.rpc.request(method, { ...params, config: kept, developerInstructions: baseInstructions });
                this.sink.emit({ type: "notice", level: "warn", message: `Codex didn't accept ${APP_TITLE}'s delegation tools (${redact((e as Error).message).replace(/^Codex:\s*/, "")}); this session runs without them, preserving MCP restrictions.` });
                return r;
            }
        };
        if (o.resumeId) {
            try {
                // Shared with a forked session: a copy of it goes on (a new thread), never the thread itself.
                const r = await thread(o.fork ? "thread/fork" : "thread/resume", { ...threadParams, threadId: o.resumeId, excludeTurns: true });
                this.threadId = r?.thread?.id ?? (o.fork ? undefined : o.resumeId);
                if (!this.threadId || (o.fork && this.threadId === o.resumeId)) throw new Error("Codex didn't fork the thread");
                if (typeof r?.model === "string") this.threadModels.set(this.threadId, r.model);
                this.tierNow = r?.serviceTier;
            } catch (e) {
                // Codex refused it (gone, another folder's): the agent starts a new thread, with the conversation as
                // context. Not when the app-server went meanwhile (Esc while it resumed): the thread is fine.
                if (!this.rpc.closed && !this.closing) this.adapter.resumeFailed = redact((e as Error).message);
                throw e;
            }
        } else {
            const r = await thread("thread/start", threadParams);
            this.threadId = r?.thread?.id;
            if (!this.threadId) throw new Error("Codex didn't start a thread");
            if (typeof r?.model === "string") this.threadModels.set(this.threadId, r.model);
            this.tierNow = r?.serviceTier;
        }
        this.stopAccountWatch = watchAccountFolders(() => this.accountsChanged());
        liveDebug("codex", "thread open", { thread: this.threadId, how: o.resumeId ? (o.fork ? "fork" : "resume") : "start" });
        return { sessionId: this.threadId! };
    }

    /**
     * The thread is shared with a forked session now: a copy of it goes on here (thread/fork on this app-server),
     * never the thread itself. Its background terminals stay with the thread they were started in.
     */
    async forkThread(): Promise<void> {
        const from = this.threadId;
        const r: any = await withTimeout(this.rpc.request("thread/fork", { ...this.threadParams, threadId: from, excludeTurns: true }), 30_000, "Codex didn't fork the thread");
        const id: string | undefined = typeof r?.thread?.id === "string" ? r.thread.id : undefined;
        if (!id || id === from) throw new Error("Codex didn't fork the thread");
        this.threadId = id;
        if (typeof r?.model === "string") this.threadModels.set(id, r.model);
        this.tierNow = r?.serviceTier;
        this.goal = undefined;
        liveDebug("codex", "thread forked in place", { from, thread: id });
        this.events({ t: "session_id", id });
    }

    /** Send what the run's next Codex turn takes (its segment): the turn's id, or one ended at once (a /goal Codex answered). */
    async prompt(): Promise<{ ref: string }> {
        const run = this.adapter.run;
        if (!run) throw new Error("No turn to start");
        this.attach(run);
        const flight: string[] = [];
        this.promptFlight = flight;
        let settle!: () => void;
        const p = new Promise<void>((resolve) => (settle = resolve));
        this.flights.add(p);
        try {
            const r = await this.startSegment(run, run.next, flight);
            liveDebug("codex", "prompt sent", { thread: this.threadId, ref: r.ref, why: run.next.why });
            return r;
        } finally {
            if (this.promptFlight === flight) this.promptFlight = undefined;
            this.flights.delete(p);
            settle();
        }
    }

    /**
     * Interrupt a turn: it and its sub-agents' turns (turn/interrupt), and the goal pauses, as the user's stop
     * always paused it. Codex goes on running, and so do its background terminals.
     */
    async interruptTurn(ref: string): Promise<void> {
        liveDebug("codex", "interrupt", { thread: this.threadId, ref });
        if (this.threadId && this.goal?.status === "active")
            void withTimeout(this.rpc.request("thread/goal/set", { threadId: this.threadId, status: "paused" }), 2000, "").then(
                (r) => r?.goal && this.setGoal(r.goal),
                () => {},
            );
        for (const [thread, sub] of this.subs) if (sub.turnId && this.subRoots.get(thread) === ref) void this.rpc.request("turn/interrupt", { threadId: thread, turnId: sub.turnId }).catch(() => {});
        await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: ref }).catch(() => {});
    }

    /** Stop a background terminal (terminate, confirmed by its end or the list) or a sub-agent still working (its turn's interrupt). */
    async stopTask(id: string): Promise<void> {
        liveDebug("codex", "stop task", { thread: this.threadId, id });
        const term = this.terminals.get(id);
        if (term && !term.ended) {
            term.stopping = true;
            let r: any;
            try {
                r = await this.rpc.request("thread/backgroundTerminals/terminate", { threadId: term.threadId, processId: term.processId });
            } catch (e) {
                term.stopping = false;
                if (/experimentalApi/i.test((e as Error).message)) this.terminalsApi = false;
                throw e;
            }
            // Not terminated, having ended by itself first: the stop didn't end it (BackgroundStop "ended").
            if (term.ended && r?.terminated === false) throw new Error("The command had already ended");
            if (term.ended) return;
            // Terminated, or it had ended: the list says which once its end hasn't come.
            const listed = await this.listTerminals(term.threadId);
            if (!term.ended && listed && !listed.has(term.processId)) this.terminalGone(term, "stopped");
            return;
        }
        const sub = this.bgSubs.get(id);
        const turnId = this.subs.get(id)?.turnId;
        if (sub && turnId) {
            sub.stopping = true;
            await this.rpc.request("turn/interrupt", { threadId: id, turnId });
            return;
        }
        throw new Error(`Codex has no background task ${id} running`);
    }

    /** Per turn: turn/start carries the model, effort, speed and policy. */
    async apply(): Promise<"applied"> {
        return "applied";
    }

    /** Close stdin: the app-server exits (the session stops it if it doesn't). */
    async close(): Promise<void> {
        this.closing = true;
        this.rpc.proc.end();
    }

    // ---------------------------------------------------------------------
    // Runs

    /** A run starts on this connection: what a new CodexTurn starts with. */
    attach(run: LiveRun) {
        if (this.liveRun === run) return;
        this.liveRun = run;
        run.conn = this;
        this.t = run.t;
        this.aborted = run.aborted || run.t.signal.aborted;
        this.failure = run.failure;
        this.status = undefined;
        this.limitHit = false;
        this.limitNoted = false;
        this.followUp = undefined;
        this.followUps = 0;
        this.steering = Promise.resolve();
        this.unsteered = [];
        this.steerWaiting = false;
        this.restartFor = undefined;
        this.goalOnRestart = false;
        this.adopted = false;
        this.modeKilled = undefined;
        this.compacting = run.compact;
        this.turnId = undefined;
        run.onAbort = () => {
            run.aborted = true;
            this.aborted = true;
            this.goalWake?.();
        };
        run.t.signal.addEventListener("abort", run.onAbort, { once: true });
        // A message to steer with goes into the running turn as it's sent (turn/steer), not at its end.
        if (!run.compact) run.stopSteering = run.t.sink.onQueued?.(() => this.steerQueued());
    }

    /** A wake the session holds becomes this run's turn. */
    adoptWake(run: LiveRun, ref: string) {
        this.attach(run);
        this.turnId = ref;
        this.absorb(run, ref);
        // Codex's own turn runs under the thread's policy: a mode changed since restarts it (restartIfStale).
        this.turnMode = this.running.get(ref) ?? this.threadMode;
        this.adopted = true;
        // Stopped for the mode before it was taken: the goal goes on under the mode in a turn of its own (flushNotes, or this run's next).
        if (this.stoppedForMode.delete(ref)) this.restartFor = undefined;
        else if (!this.completedTurns.has(ref)) this.restartIfStale();
        if (this.steerWaiting) this.steerQueued();
        liveDebug("codex", "wake adopted", { thread: this.threadId, ref });
    }

    /** After one of the run's Codex turns: what the next one sends, or undefined when the run is over. */
    async nextSegment(run: LiveRun, r: LiveTurnResult): Promise<Segment | undefined> {
        this.turnId = undefined;
        // A command's PostToolUse hooks finish before the turn does (Codex can end it right after the command).
        if (this.hookRuns.size) await Promise.allSettled([...this.hookRuns]);
        this.adopted = false;
        if (r.reason === "error") {
            this.failure ??= r.error ?? "Codex stopped before the turn finished";
            return undefined;
        }
        if (this.aborted || run.aborted || run.compact) return undefined;
        const restart = this.restartFor;
        this.restartFor = undefined;
        if (restart) {
            // Stopped for the mode, not by the user: the goal goes on once the restarted turn has started.
            const activate = this.goalOnRestart;
            this.goalOnRestart = false;
            // A steer the interrupt beat goes in with it, not after the restarted turn.
            await this.steering;
            const queued = this.unsteered.length ? this.unsteered.splice(0).join("\n\n") : undefined;
            return { kind: "prompt", text: [modeSwitched(restart), queued].filter(Boolean).join("\n\n"), images: [], after: "", activate, queued, why: "mode-restart" };
        }
        // A steer on its way when the turn ended: whether Codex took it decides what's next.
        await this.steering;
        // Stopped meanwhile: one Codex refused stays unsent (detach saves it for the next turn), and the queue stays.
        if (this.aborted || run.aborted) return undefined;
        const followUp = this.followUp && this.followUps++ < 5 ? this.followUp : undefined;
        this.followUp = undefined;
        const why = followUp ? "follow-up" : this.unsteered.length ? "unsent" : "queued";
        const next = followUp ? [followUp] : this.unsteered.length ? this.unsteered.splice(0) : await run.t.sink.drainQueued(() => this.progress());
        if (!next.length) {
            // Paused for a mode change (before or while it ran): it goes on here, under the mode.
            if (this.goalPausedForMode && !this.aborted) return { kind: "prompt", text: modeSwitched(this.host.mode()), images: [], after: "", activate: true, why: "goal-under-mode" };
            return undefined;
        }
        // The user's words name skills; a watch's events (others' words, such as a PR comment) come after and don't.
        const typed = next.filter((x) => !run.t.sink.fromWake?.(x));
        const woke = next.filter((x) => run.t.sink.fromWake?.(x));
        const text = [...typed, ...woke].join("\n\n");
        // Nor does what a UserPromptSubmit hook added after them: what's scanned ends before the first.
        const cut = typed.findIndex((x) => (run.t.sink.requestOf?.(x) ?? x) !== x);
        const words = cut < 0 ? typed : [...typed.slice(0, cut), run.t.sink.requestOf!(typed[cut]!)!];
        const request = words.length ? words.join("\n\n") : undefined;
        return { kind: "prompt", text, images: [], request, after: request === undefined ? "" : text.slice(request.length), queued: text, why };
    }

    /** How the run went, as a BackendResult. */
    async result(run: LiveRun, r: LiveTurnResult): Promise<BackendResult> {
        // Codex's error may not say when the limit resets; its limits do.
        if (this.limitHit && !this.limits?.resetsAt && !this.aborted && !this.rpc.closed) await this.readLimits();
        const text = run.out.texts.join("\n\n");
        const answer = answerOf(run.out.answer) || undefined;
        const actions = run.out.actions;
        if (this.aborted || run.aborted) return { reason: "aborted", text, answer, actions };
        const failure = this.modeKilled ?? this.failure ?? (r.reason === "error" ? (r.error ?? "Codex stopped before the turn finished") : undefined);
        run.failure = failure;
        if (failure) return { reason: "error", text, answer, actions, error: this.limitHit ? `${limitAccountLabel(this.def.id, this.t.accountId)}: usage limit reached. ${resetSentence(this.limits?.resetsAt, "Codex")} Choose another account with /account or the plan meter, then send again.` : failure, ...(this.limitHit ? { limit: { resetsAt: this.limits?.resetsAt } } : {}) };
        return { reason: "done", text, answer, actions };
    }

    /** A segment's messages that never went out (the run was stopped before): saved for the next turn at detach. */
    keepUnsent(text: string) {
        this.unsteered.push(text);
    }

    /** The run is over: what it left goes to the next (messages it never sent), and finished commands may start a turn now. */
    async detach(run: LiveRun) {
        if (this.liveRun !== run) return;
        run.stopSteering?.();
        if (run.onAbort) run.t.signal.removeEventListener("abort", run.onAbort);
        const alive = !this.rpc.closed;
        // Ended with the goal still active by a stop or an error: it waits for the user, not for Codex.
        if (alive && this.threadId && this.goal?.status === "active" && (run.aborted || run.failure)) await withTimeout(this.rpc.request("thread/goal/set", { threadId: this.threadId, status: "paused" }), 2000, "").then((r) => this.setGoal(r?.goal), () => {});
        if (this.goalPausedForMode && (run.aborted || run.failure || !alive)) {
            // Stopped: the goal stays paused, and is shown so.
            this.goalPausedForMode = false;
            run.t.sink.emit({ type: "goal", goal: this.goal ?? null });
        }
        // Settled once Codex is gone (its pending requests fail): nothing records a prompt after the turn's end.
        await this.steering;
        // Recorded as sent but never taken (the turn failed or was stopped): saved for the next turn.
        if (this.unsteered.length) run.t.sink.undelivered?.(this.unsteered.splice(0));
        this.liveRun = undefined;
        this.aborted = false;
        this.failure = undefined;
        this.turnId = undefined;
        this.restartFor = undefined;
        this.compacting = false;
        this.flushNotesSoon();
    }

    /** A mode change (setMode): Codex's turns under another policy stop, and an idle goal goes on under the mode. */
    liveModeChanged() {
        this.modeChanged(this.host.mode());
        if (!this.liveRun && this.goalPausedForMode) this.flushNotesSoon();
    }

    /** What a wake's row says: known once the turn/start that may have started it has answered. */
    async wakeLabel(ref: string): Promise<string> {
        await Promise.all([...this.flights]);
        const host = this.hostTurns.get(ref);
        if (host) return host;
        const g = this.goal;
        return g?.status === "active" ? `Codex went on with the goal: ${clip(g.condition, 80)}` : "Codex started a turn of its own";
    }

    /** Background terminals and sub-agents running now. */
    runningTasks(): number {
        return [...this.terminals.values()].filter((t) => !t.ended).length + this.bgSubs.size;
    }

    // ---------------------------------------------------------------------

    private async startSegment(run: LiveRun, seg: Segment, flight: string[]): Promise<{ ref: string }> {
        this.status = undefined;
        this.adopted = false;
        if (seg.kind === "compact") return this.startCompact(run);
        const t = run.t;
        let { text, request, after } = seg;
        let activate = Boolean(seg.activate);
        if (seg.first) {
            // Every prompt, as each per-turn app-server did: the sign-in may have changed since (plan or API key), and the
            // plan's limits are read between turns (Codex pushes updates only inside them). Not again just after open.
            if (this.accountReadFor !== run) await this.readAccount();
            // The harness's skills go to Codex as a skills root of its own, so it lists them to its model and runs them itself.
            if (!run.skillsRead) {
                run.skills = await this.nativeSkills(t);
                run.skillsRead = true;
            }
            // /goal goes to Codex's own thread goal: answered here, or the text of the goal's first turn (made active once it has started).
            const goalCommand = codexGoalCommand(t.prompt);
            if (goalCommand) {
                const goalTurn = await this.goalCommand(goalCommand);
                if (!goalTurn) return this.answered();
                text = [t.goalContext, goalTurn.text].filter(Boolean).join("\n\n");
                request = undefined;
                after = "";
                activate = true;
            } else void this.readGoal();
        }
        // What Codex should hear that no turn of its own told it (finished commands, stops): put back if no turn takes them.
        const taken = this.takeNotes();
        if (taken.text) text = text ? `${taken.text}\n\n${text}` : taken.text;
        // Paused in Codex for a mode change: active again once this turn (under the mode) has started.
        if (this.goalPausedForMode) activate = true;
        const mode = this.host.mode();
        const policy = codexPolicy(mode, t.additionalDirectories, Boolean(t.readOnly), this.hooked("PreToolUse") && !this.nativeHooks);
        const note = modeNote(mode, Boolean(t.readOnly));
        const asked = run.skills ? codexInput(text, request, run.skills, t.skills, after) : { text: pastedPrompt(text, request, t.skills ?? [], after), items: [] };
        const input = [...this.input(note ? `${note}\n\n${asked.text}` : asked.text, seg.images), ...asked.items];
        const effort = t.effort && (!t.model.effortLevels || t.model.effortLevels.includes(t.effort)) ? t.effort : undefined;
        const model = t.model.id === "default" ? undefined : t.model.id;
        const serviceTier = this.serviceTier(t);
        this.turnMode = mode;
        // Queued and restarted turns explicitly request this model again, even after a reroute.
        if (model) this.threadModels.set(this.threadId!, model);
        let r: any;
        seg.started = true;
        for (let attempt = 0; ; attempt++) {
            // Not beside a turn of Codex's that was stopped for the mode and hasn't ended yet.
            await this.stoppedEnded();
            this.starting = true;
            this.startingThreadMode = this.threadMode;
            this.startingMode = mode;
            try {
                r = await this.rpc.request("turn/start", { threadId: this.threadId, input, cwd: t.cwd, model, effort, serviceTier, approvalPolicy: policy.approvalPolicy, ...(this.accountPermissions ? { permissions: accountPermissionProfile(mode, t.readOnly) } : { sandboxPolicy: policy.sandboxPolicy }), approvalsReviewer: policy.approvalsReviewer, summary: "auto" }).finally(() => (this.starting = false));
                break;
            } catch (e) {
                // Any turn that started meanwhile was Codex's own.
                this.settleStarted(undefined);
                // Refused for a turn of Codex's that's being stopped for the mode: again once it has ended.
                if (attempt === 0 && !this.aborted && [...this.stoppedForMode].some((id) => this.running.has(id))) continue;
                // Codex started the goal's next turn first (and so refused this one): the messages go into that one. Its
                // events were held for this prompt, so it's this run's turn from its start.
                const raced = flight.find((id) => !run.turns.has(id) && !this.ownTurns.has(id));
                if (raced) {
                    liveDebug("codex", "turn/start refused: Codex's own turn takes the prompt", { thread: this.threadId, turn: raced });
                    return this.claim(run, raced, text);
                }
                // Those that started meanwhile were Codex's own.
                this.decideStarted();
                // A turn of Codex's that started before (a wake): the message goes into it.
                const other = this.mainTurn && !run.turns.has(this.mainTurn) ? this.mainTurn : undefined;
                if (other && attempt < 2) {
                    try {
                        await this.rpc.request("turn/steer", { threadId: this.threadId, expectedTurnId: other, input: this.input(text, seg.images) });
                        liveDebug("codex", "turn/start refused: steered into the running turn", { thread: this.threadId, turn: other });
                        // To this run (the sink would put it in that turn, which the session shows later as a wake).
                        run.t.sink.emit({ type: "notice", level: "info", message: "Codex was already in a turn of its own, so your message went into that turn: its answer shows there." });
                        return this.answered();
                    } catch {
                        // It ended meanwhile: start one now.
                        continue;
                    }
                }
                // The messages this turn was for aren't lost with it: saved for the next turn, and the notes for the next prompt.
                if (seg.queued) this.unsteered.push(seg.queued);
                this.putBackNotes(taken);
                throw e;
            }
        }
        if (serviceTier !== undefined) this.tierNow = serviceTier ?? "default";
        const id: string | undefined = typeof r?.turn?.id === "string" ? r.turn.id : undefined;
        if (!id) throw new Error("Codex didn't start a turn");
        this.turnId = id;
        this.threadMode = mode;
        // Which turn that started meanwhile was this one: the others were Codex's own.
        this.settleStarted(id, mode);
        this.startedTurns = this.startedTurns.filter((x) => !this.stoppedForMode.has(x));
        this.turnsSeen.add(id);
        this.ownTurns.add(id);
        this.absorb(run, id);
        this.decideStarted();
        // The mode changed while it was starting: restarted under it, before anything goes into it.
        if (this.restartIfStale()) return { ref: id };
        // Sent while the turn was starting: it can take them now.
        if (this.steerWaiting) this.steerQueued();
        if (activate && !this.aborted) {
            const g = (await this.rpc.request("thread/goal/set", { threadId: this.threadId, status: "active" }))?.goal;
            this.goalPausedForMode = false;
            this.setGoal(g);
        }
        return { ref: id };
    }

    /** Codex's turn that refused the prompt's becomes the run's, with the prompt's words steered into it. */
    private async claim(run: LiveRun, id: string, text: string): Promise<{ ref: string }> {
        this.turnId = id;
        this.absorb(run, id);
        this.decideStarted();
        this.turnMode = this.running.get(id) ?? this.threadMode;
        this.adopted = true;
        const ended = this.completedTurns.get(id);
        if (ended !== undefined) {
            // Stopped as it started, for the mode: restarted under it, with the messages.
            if (this.stoppedForMode.delete(id)) {
                this.restartFor = this.host.mode();
                this.goalOnRestart = this.goal?.status === "active";
            }
            if (text) this.unsteered.push(text);
            return { ref: id };
        }
        if (this.restartIfStale()) {
            if (text) this.unsteered.push(text);
            return { ref: id };
        }
        if (text) await this.rpc.request("turn/steer", { threadId: this.threadId, expectedTurnId: id, input: this.input(text, []) }).catch(() => this.unsteered.push(text));
        if (this.steerWaiting) this.steerQueued();
        return { ref: id };
    }

    /** A prompt answered without a turn: its turn ends at once (held by the session until it has the ref). */
    private answered(): { ref: string } {
        const ref = `codex-answered-${++this.seq}`;
        this.events({ t: "turn_ended", ref, reason: "done" });
        return { ref };
    }

    /** Codex's own compaction of the thread: a turn of its own (0.163), or only thread/compacted (older ones). */
    private async startCompact(_run: LiveRun): Promise<{ ref: string }> {
        this.compacting = true;
        const started = new Promise<string>((resolve) => (this.compactWaiter = resolve));
        await this.rpc.request("thread/compact/start", { threadId: this.threadId });
        const gone = this.rpc.done.then(() => {
            throw new Error("Codex stopped while compacting");
        });
        return { ref: await Promise.race([started, gone]) };
    }

    private serviceTier(t: BackendTurn): string | null | undefined {
        // Fast is the catalog's tier for it. Standard sends nothing, except null to take a thread on a fast tier back off it.
        const fast = this.host.fastMode?.() ?? t.fastMode;
        const tier = fast && t.model.supportsFastMode ? t.model.fastModeTier : undefined;
        return tier ?? (typeof this.tierNow === "string" && FAST_TIERS.has(this.tierNow) ? null : undefined);
    }

    // ---------------------------------------------------------------------
    // Notifications

    private notified(method: string, p: any) {
        // A background command's end, whichever thread it's in now (a fork in place leaves it in the old one).
        if (method === "item/completed" && typeof p?.item?.id === "string") {
            const term = this.terminals.get(p.item.id);
            if (term) return this.terminalEnded(term, p.item);
        }
        const thread = typeof p?.threadId === "string" ? p.threadId : undefined;
        const main = !thread || !this.threadId || thread === this.threadId;
        if (method === "turn/started" && typeof p?.turn?.id === "string") {
            if (main) return this.mainStarted(p);
            this.subRoots.set(thread!, typeof p.turn.rootTurnId === "string" ? p.turn.rootTurnId : (this.mainTurn ?? ""));
        }
        if (method === "turn/completed" && typeof p?.turn?.id === "string" && main) return this.mainCompleted(p);
        if (method === "thread/compacted" && main && this.compactWaiter && !this.mainTurn) {
            // An older Codex compacts without a turn: the compaction's turn ends here.
            const w = this.compactWaiter;
            this.compactWaiter = undefined;
            const ref = `codex-compacted-${++this.seq}`;
            this.onNotification(method, p);
            this.events({ t: "turn_ended", ref, reason: "done" });
            return w(ref);
        }
        this.onNotification(method, p);
        if (method === "turn/completed" && thread && !main && this.bgSubs.has(thread)) this.subEnded(thread, p.turn?.status);
    }

    private mainStarted(p: any) {
        const id: string = p.turn.id;
        this.mainTurn = id;
        this.promptFlight?.push(id);
        if (this.compactWaiter) {
            const w = this.compactWaiter;
            this.compactWaiter = undefined;
            this.ownTurns.add(id);
            if (this.liveRun) this.absorb(this.liveRun, id);
            w(id);
        }
        const mine = this.liveRun?.turns.has(id) ?? false;
        // A turn/start of ours not answered yet: this may be its turn (Codex can announce it first), or one of
        // Codex's own. Told once the answer says, or the session would take the prompt's turn for a wake.
        if (this.starting && !mine) {
            this.undecided.push(id);
            liveDebug("codex", "turn started before turn/start answered", { thread: this.threadId, turn: id });
        } else this.announce(id);
        this.onNotification("turn/started", p);
    }

    /** A main-thread turn started: the run's, a host wake's, or Codex's own (a goal's). */
    private announce(id: string) {
        const origin = this.liveRun?.turns.has(id) ? "user" : this.hostTurns.has(id) ? "wake" : "goal";
        liveDebug("codex", "turn started", { thread: this.threadId, turn: id, origin, starting: this.starting });
        this.events({ t: "turn_started", ref: id, origin });
    }

    /** The turn/start is answered (or failed, or its turn claimed): the turns that started meanwhile are told as whose they are. */
    private decideStarted() {
        for (const id of this.undecided.splice(0)) this.announce(id);
    }

    private mainCompleted(p: any) {
        const id: string = p.turn.id;
        const status = typeof p.turn.status === "string" ? p.turn.status : "completed";
        this.running.delete(id);
        this.completedTurns.set(id, { status, ...(status === "failed" ? { error: p.turn.error } : {}) });
        if (this.completedTurns.size > 64) this.completedTurns.delete(this.completedTurns.keys().next().value!);
        // The turn's events still go to it until it's over.
        if (this.mainTurn === undefined) this.mainTurn = id;
        this.closeTurnItems(id);
        if (this.turnId === id) this.status = status;
        if (status === "failed") this.fail(p.turn?.error, "Codex reported a failed turn");
        const reason = status === "completed" ? "done" : status === "interrupted" ? "aborted" : status === "failed" ? "error" : "done";
        const error = status === "failed" ? (this.liveRun?.turns.has(id) ? this.failure : this.outs.get(id)?.failure) ?? redact(String(p.turn?.error?.message ?? "Codex reported a failed turn")) : undefined;
        liveDebug("codex", "turn completed", { thread: this.threadId, turn: id, status });
        this.events({ t: "turn_ended", ref: id, reason, ...(error ? { error } : {}) });
        if (this.mainTurn === id) this.mainTurn = undefined;
        this.flushNotesSoon();
    }

    /**
     * A turn is over: a command it left running (unified exec, a process of its own) goes on in the background,
     * as a sub-agent of it still working does; anything else open ended with it.
     */
    private closeTurnItems(turn: string) {
        const fresh: Terminal[] = [];
        for (const [id, it] of [...this.items]) {
            if (it.sub) continue;
            if (it.name === "Bash" && it.processId) {
                const term: Terminal = { itemId: id, threadId: this.threadId!, processId: it.processId, command: String(it.input.command ?? ""), startedAt: it.started };
                this.terminals.set(id, term);
                fresh.push(term);
                this.endItem(id, it, `Still running in the background (process ${it.processId}). ${APP_TITLE} lists it under Background, and Codex is told when it finishes.`, false, undefined, false, false);
                this.reportTerminal(term, "running");
                liveDebug("codex", "background terminal", { thread: this.threadId, turn, item: id, processId: it.processId });
                continue;
            }
            this.endItem(id, it, this.aborted ? "Interrupted by user" : "Codex stopped before this finished.", true);
        }
        for (const [thread, sub] of [...this.subs]) {
            // Done: one set going again in a later turn shows under that turn's call (its label is kept).
            if (!sub.turnId && !this.bgSubs.has(thread)) {
                this.subs.delete(thread);
                this.subRoots.delete(thread);
                continue;
            }
            if (!sub.turnId || sub.nested || this.bgSubs.has(thread) || this.subRoots.get(thread) !== turn) continue;
            this.bgSubs.set(thread, {});
            this.events({ t: "task", task: { id: thread, provider: this.def.id, kind: "agent", label: sub.label, toolUseId: sub.call, startedAt: Date.now(), status: "running", stoppable: true } });
            this.subEmit(sub, { type: "notice", level: "info", message: "Still working in the background." });
        }
        if (fresh.length && this.terminalsApi) void this.reconcile(fresh);
    }

    private reportTerminal(term: Terminal, status: BackgroundTaskInfo["status"]) {
        this.events({ t: "task", task: { id: term.itemId, provider: this.def.id, kind: "shell", label: clip(term.command, 200) || `process ${term.processId}`, toolUseId: term.itemId, startedAt: term.startedAt, status, stoppable: this.terminalsApi } });
    }

    /** Terminals the list doesn't have (they ended with their turn, unannounced): gone, once their end hasn't come. */
    private async reconcile(terms: Terminal[]) {
        const listed = await this.listTerminals(this.threadId);
        if (!listed) return;
        for (const term of terms) {
            if (term.ended || listed.has(term.processId)) continue;
            term.unlisted = setTimeout(() => {
                if (!term.ended) this.terminalGone(term, "stopped");
            }, UNLISTED_MS);
            term.unlisted.unref?.();
        }
    }

    private async listTerminals(threadId: string | undefined): Promise<Set<string> | undefined> {
        if (!threadId || this.rpc.closed) return undefined;
        try {
            const r: any = await withTimeout(this.rpc.request("thread/backgroundTerminals/list", { threadId }), 10_000, "Codex didn't list its background terminals");
            return new Set((Array.isArray(r?.data) ? r.data : []).map((d: any) => String(d?.processId ?? "")));
        } catch (e) {
            if (/experimentalApi/i.test((e as Error).message)) this.terminalsApi = false;
            return undefined;
        }
    }

    /** A background command ended (its item completed): the task says how, and Codex hears of it. */
    private terminalEnded(term: Terminal, item: any) {
        if (term.ended) return;
        term.ended = true;
        if (term.unlisted) clearTimeout(term.unlisted);
        const code = typeof item?.exitCode === "number" ? item.exitCode : undefined;
        const ok = item?.status === "completed" && (code ?? 0) === 0;
        // Asked to stop, it ended: stopped, unless it had finished by itself first.
        const status = ok ? "done" : term.stopping ? "stopped" : "failed";
        this.reportTerminal(term, status);
        const out = typeof item?.aggregatedOutput === "string" ? item.aggregatedOutput : "";
        const tail = out.length > NOTE_OUTPUT_CHARS ? `…${out.slice(-NOTE_OUTPUT_CHARS)}` : out;
        const what = `\`${clip(term.command, 300)}\``;
        const text = term.stopping && !ok
            ? `The user stopped the background command ${what} (process ${term.processId}).`
            : `The background command ${what} you started earlier (process ${term.processId}) has finished${code !== undefined ? ` with exit code ${code}` : item?.status === "failed" ? " (it failed)" : ""}.${tail.trim() ? ` The end of its output:\n${tail}` : " It printed nothing."}`;
        liveDebug("codex", "background terminal ended", { thread: this.threadId, item: term.itemId, status, stopping: Boolean(term.stopping) });
        // The user asked for it to stop: Codex hears with the next turn, and nothing starts one for it.
        this.addNote({ text: redact(text), label: `Background command finished: ${clip(term.command, 60)}`, wake: !term.stopping });
    }

    /** A terminal that's gone without an end of its own. */
    private terminalGone(term: Terminal, status: "stopped") {
        if (term.ended) return;
        term.ended = true;
        this.reportTerminal(term, status);
        liveDebug("codex", "background terminal gone", { thread: this.threadId, item: term.itemId });
    }

    private subEnded(thread: string, status: unknown) {
        const sub = this.bgSubs.get(thread);
        if (!sub) return;
        this.bgSubs.delete(thread);
        const s = this.subs.get(thread);
        this.events({ t: "task", task: { id: thread, provider: this.def.id, kind: "agent", label: s?.label ?? "Codex sub-agent", toolUseId: s?.call, startedAt: Date.now(), status: status === "completed" ? "done" : status === "interrupted" || sub.stopping ? "stopped" : "failed", stoppable: true } });
    }

    // ---------------------------------------------------------------------
    // Telling Codex: host wakes

    private addNote(n: Note) {
        this.notes.push(n);
        this.flushNotesSoon();
    }

    /** Notes for the next prompt, as one reminder (`text`), with what was taken for it, to put back if it isn't sent. */
    private takeNotes(): { text?: string; carried: string[]; notes: Note[] } {
        // What an earlier app-server of the session's left untold (its background work stopped with it) goes first.
        const carried = this.adapter.carried.splice(0);
        const notes = this.notes.splice(0);
        const texts = [...carried, ...notes.map((n) => n.text)];
        return { carried, notes, ...(texts.length ? { text: `<system-reminder>\n${texts.join("\n\n")}\n</system-reminder>` } : {}) };
    }

    /** Notes taken for a prompt that no turn took. */
    private putBackNotes(taken: { carried: string[]; notes: Note[] }) {
        this.adapter.carried.unshift(...taken.carried);
        this.keepNotes(taken.notes);
    }

    /** Notes not told after all: for this app-server's next turn, or, once it's going, the session's next one (carried). */
    private keepNotes(notes: Note[]) {
        if (!notes.length) return;
        if (this.closing) this.adapter.carried.push(...notes.map((n) => n.text));
        else this.notes.unshift(...notes);
    }

    private flushNotesSoon() {
        if (this.noteTimer || this.closing) return;
        this.noteTimer = setTimeout(() => {
            this.noteTimer = undefined;
            void this.flushNotes();
        }, NOTE_SETTLE_MS);
        this.noteTimer.unref?.();
    }

    /**
     * What Codex should hear: into the turn running now; with the run's next prompt while one is going; else, for
     * a finished command (codex.wakeOnBackgroundCommand) or a goal paused for a mode change, in a turn started
     * here, which the session adopts as a wake. Otherwise it waits for the next prompt.
     */
    private async flushNotes() {
        if (this.closing || this.rpc.closed || !this.threadId) return;
        if (this.mainTurn) {
            if (!this.notes.length) return;
            const turn = this.mainTurn;
            const notes = this.notes.splice(0);
            const text = `<system-reminder>\n${notes.map((n) => n.text).join("\n\n")}\n</system-reminder>`;
            try {
                await this.rpc.request("turn/steer", { threadId: this.threadId, expectedTurnId: turn, input: this.input(text, []) });
                liveDebug("codex", "notes steered into the running turn", { thread: this.threadId, turn, notes: notes.length });
            } catch {
                this.keepNotes(notes);
                this.flushNotesSoon();
            }
            return;
        }
        if (this.liveRun || this.starting || this.hostStarting) return;
        const wakeOn = this.adapter.t?.wakeOnBackgroundCommand !== false;
        const wake = wakeOn && this.notes.some((n) => n.wake);
        const goalGoesOn = this.goalPausedForMode;
        if (!wake && !goalGoesOn) {
            if (this.notes.length) liveDebug("codex", "notes wait for the next prompt", { thread: this.threadId, notes: this.notes.length, wakeOn });
            return;
        }
        await this.hostTurn(goalGoesOn);
    }

    /** Start a turn of the host's: the notes (and the goal going on under the mode), adopted by the session as a wake. */
    private async hostTurn(goalGoesOn: boolean) {
        const t = this.adapter.t;
        if (!t || this.hostFailures >= 3) return;
        const notes = this.notes.splice(0);
        const mode = this.host.mode();
        const text = [notes.length ? `<system-reminder>\n${notes.map((n) => n.text).join("\n\n")}\n</system-reminder>` : "", goalGoesOn ? modeSwitched(mode) : ""].filter(Boolean).join("\n\n");
        const label = notes.length === 1 ? notes[0]!.label : notes.length ? `${notes.length} background commands finished` : "Codex goes on with the goal under the new mode";
        const policy = codexPolicy(mode, t.additionalDirectories, Boolean(t.readOnly), this.hooked("PreToolUse") && !this.nativeHooks);
        const note = modeNote(mode, Boolean(t.readOnly));
        const effort = t.effort && (!t.model.effortLevels || t.model.effortLevels.includes(t.effort)) ? t.effort : undefined;
        const model = t.model.id === "default" ? undefined : t.model.id;
        const serviceTier = this.serviceTier(t);
        this.hostStarting = true;
        this.starting = true;
        this.startingThreadMode = this.threadMode;
        this.startingMode = mode;
        let settle!: () => void;
        const p = new Promise<void>((resolve) => (settle = resolve));
        this.flights.add(p);
        liveDebug("codex", "host wake: starting a turn", { thread: this.threadId, notes: notes.length, goalGoesOn });
        try {
            const r: any = await this.rpc.request("turn/start", { threadId: this.threadId, input: this.input(note ? `${note}\n\n${text}` : text, []), cwd: t.cwd, model, effort, serviceTier, approvalPolicy: policy.approvalPolicy, ...(this.accountPermissions ? { permissions: accountPermissionProfile(mode, t.readOnly) } : { sandboxPolicy: policy.sandboxPolicy }), approvalsReviewer: policy.approvalsReviewer, summary: "auto" });
            const id: string | undefined = typeof r?.turn?.id === "string" ? r.turn.id : undefined;
            if (!id) throw new Error("Codex didn't start a turn");
            if (serviceTier !== undefined) this.tierNow = serviceTier ?? "default";
            this.hostFailures = 0;
            this.ownTurns.add(id);
            this.turnsSeen.add(id);
            this.threadMode = mode;
            this.starting = false;
            this.settleStarted(id, mode);
            this.hostTurns.set(id, label);
            if (this.hostTurns.size > 32) this.hostTurns.delete(this.hostTurns.keys().next().value!);
            this.decideStarted();
            liveDebug("codex", "host wake: turn started", { thread: this.threadId, turn: id });
            if (goalGoesOn) {
                const g = (await this.rpc.request("thread/goal/set", { threadId: this.threadId, status: "active" }).catch(() => undefined))?.goal;
                this.goalPausedForMode = false;
                if (g) this.setGoal(g);
            }
        } catch (e) {
            this.starting = false;
            this.settleStarted(undefined);
            this.decideStarted();
            this.hostFailures++;
            // Refused (a turn of Codex's started first, say): the notes go into it, or with the next prompt.
            this.keepNotes(notes);
            liveDebug("codex", "host wake: turn/start failed", { thread: this.threadId, error: redact((e as Error).message) });
            if (this.mainTurn) this.flushNotesSoon();
        } finally {
            this.hostStarting = false;
            this.flights.delete(p);
            settle();
        }
    }

    // ---------------------------------------------------------------------

    /** Account folders changed: a turn running is stopped at once (its protections are stale); an idle app-server is restarted before the next. */
    private accountsChanged() {
        liveDebug("codex", "account folders changed", { thread: this.threadId, busy: Boolean(this.mainTurn || this.liveRun) });
        this.adapter.stale = true;
        if (this.mainTurn || this.liveRun) {
            this.failure = "Account folders changed while Codex was running. Send again to apply their updated protections.";
            void this.rpc.proc.kill();
        }
    }

    /** The app-server's output ended. */
    private gone() {
        this.closing = true;
        // What Codex hasn't been told yet (a command that finished, with no wake for it): the next app-server's first prompt.
        this.keepNotes(this.notes.splice(0));
        liveCodexRpcs.delete(this);
        if (this.noteTimer) clearTimeout(this.noteTimer);
        for (const term of this.terminals.values()) if (term.unlisted) clearTimeout(term.unlisted);
        for (const timer of this.modeKills) clearTimeout(timer);
        this.modeKills.clear();
        this.stopAccountWatch?.();
        this.hookServer?.close();
        this.compactWaiter = undefined;
        liveDebug("codex", "app-server gone", { thread: this.threadId, pid: this.rpc.proc.pid });
    }

    private debugRpc(dir: "in" | "out", m: any) {
        const p = m?.params ?? {};
        const item = p.item;
        liveDebug("codex-rpc", dir, {
            pid: this.rpc.proc.pid,
            ...(m?.method ? { method: m.method } : {}),
            ...(m?.id !== undefined ? { id: m.id } : {}),
            ...(m?.error ? { error: redact(String(m.error.message ?? "")) } : {}),
            ...(typeof p.threadId === "string" ? { thread: p.threadId } : {}),
            ...(typeof p.turnId === "string" ? { turn: p.turnId } : typeof p.expectedTurnId === "string" ? { turn: p.expectedTurnId } : typeof p.turn?.id === "string" ? { turn: p.turn.id, status: p.turn.status } : {}),
            ...(item && typeof item === "object" ? { item: { type: item.type, id: item.id, status: item.status, ...(item.processId ? { processId: item.processId } : {}) } } : {}),
            ...(typeof m?.result?.turn?.id === "string" ? { resultTurn: m.result.turn.id } : {}),
        });
    }
}

/** One harness session's Codex: how to start its app-server, and the connection to it. */
export class CodexLiveAdapter implements AgentCliAdapter {
    readonly def = agentCli("codex")!;
    /** The latest turn's: the session's settings, host and sink as they are now. */
    t?: BackendTurn;
    run?: LiveRun;
    conn?: CodexLiveConnection;
    /** Its thread couldn't be resumed (or forked): why. */
    resumeFailed?: string;
    /** Account folders changed while it was idle: restart before the next turn. */
    stale = false;
    /** The account and its protections the running app-server was started with. */
    accountKey?: string;
    /** For Codex with the next prompt: background work that stopped with an app-server of the session's (crashed, or restarted). */
    carried: string[] = [];

    constructor(private live: CodexLive) {}

    spawn(cfg: SpawnConfig): SpawnSpec {
        const id = this.live.providerDef.id;
        const bin = requireCli(id, CODEX_CLI);
        const hooks = CODEX_HOOK_EVENTS.filter((e) => cfg.hooks?.[e]?.length);
        const args = ["app-server", ...extraArgs(id), ...(cfg.trusted === false ? untrustedArgs(cfg.cwd) : []), ...(hooks.length ? codexHookArgs(hooks) : [])];
        const env = accountEnv(id, cfg.accountId, cfg.cwd);
        const o = cfg.orchestrator;
        // The thread's config, set when it's opened: a change needs a new app-server (and thread/resume).
        const thread = {
            readOnly: Boolean(cfg.readOnly),
            approvedMcpServers: cfg.approvedMcpServers ?? null,
            orchestrator: o ? { name: o.name, url: o.url, authorization: o.authorization, tools: o.tools, instructions: o.instructions, toolTimeoutSec: o.toolTimeoutSec } : null,
            appendSystemPrompt: cfg.appendSystemPrompt ?? null,
            additionalDirectories: cfg.additionalDirectories,
            hooks,
        };
        return { bin, args, cwd: cfg.cwd, env, fingerprint: spawnFingerprint({ bin, args, cwd: cfg.cwd, env, thread, account: accountKey(cfg) }) };
    }

    async connect(proc: JsonLinesProcess, events: CliEventSink, host: SessionHost): Promise<CliConnection> {
        const t = this.t;
        if (!t) throw new Error("Codex was started without a turn");
        const conn = new CodexLiveConnection(this, this.live.providerDef, t, proc, events, host, this.live.labels, this.live.limitOrdering(t.accountId));
        this.conn = conn;
        this.accountKey = accountKey(t);
        this.stale = false;
        this.resumeFailed = undefined;
        liveDebug("codex", "app-server started", { pid: proc.pid, session: t.sessionKey });
        await conn.initialize();
        return conn.cli;
    }

    async status(accountId: string | undefined, signal?: AbortSignal): Promise<{ status: AgentCliStatus; limits?: PlanLimits }> {
        const { checkAgentPlan } = await import("./index");
        return checkAgentPlan(this.live.providerDef.id, signal, accountId);
    }

    listModels(signal?: AbortSignal) {
        return this.live.backend.listModels(signal);
    }

    /** The account (CODEX_HOME) or its protections changed since the app-server started: it must be restarted, background work or not. */
    needsRestart(t: BackendTurn): boolean {
        return this.stale || (this.accountKey !== undefined && this.accountKey !== accountKey(t));
    }

    /** A wake the session holds goes to the host, labelled, to be adopted. */
    async forwardWake(w: LiveWake) {
        const label = (await this.conn?.wakeLabel(w.ref).catch(() => undefined)) ?? "Codex started a turn of its own";
        const host = this.t?.session;
        // Not the label: it has a command's text, or a goal's (the log keeps methods, ids and statuses only).
        liveDebug("codex", "wake", { ref: w.ref, origin: w.origin, adoptable: Boolean(host?.onWake) });
        host?.onWake?.({ provider: this.live.providerDef.id, ref: w.ref, label });
    }
}

/** The account a turn runs on, with the protections it gets: another needs another app-server. */
function accountKey(t: Pick<BackendTurn, "accountId" | "cwd" | "additionalDirectories">): string {
    try {
        return spawnFingerprint({ env: accountEnv("codex", t.accountId, t.cwd), protections: accountPermissionConfig(t.additionalDirectories) ?? null });
    } catch {
        return `${t.accountId ?? "default"}?`;
    }
}

const lives = new Map<string, CodexLive>();

/** Codex's live sessions (one per provider, kept across clients so idle app-servers are capped in one place). */
export function codexLive(backend: CodexBackend): CodexLive {
    let l = lives.get(backend.def.id);
    if (!l) lives.set(backend.def.id, (l = new CodexLive(backend)));
    l.backend = backend;
    return l;
}

/** Every live Codex session: for tests, to stop what they started. */
export async function shutdownCodexLive(): Promise<void> {
    await Promise.all([...lives.values()].map((l) => l.shutdown()));
}

export class CodexLive {
    readonly pool: LiveCliPool;
    /** Codex's sub-agents' labels by thread (the client's, kept across turns). */
    get labels(): Map<string, string> {
        return this.backend.labels;
    }
    private wired = new Map<LiveCliSession, () => void>();

    constructor(public backend: CodexBackend) {
        this.pool = new LiveCliPool(() => new CodexLiveAdapter(this));
    }

    get providerDef(): ProviderDef {
        return this.backend.def;
    }

    /** Limit snapshots' order across sessions of each account (the client's). */
    limitOrdering(accountId = "default"): LimitOrdering {
        return this.backend.limitOrdering(accountId);
    }

    /** This harness session's live session: made (and wired to its host) on first use. */
    session(key: string): LiveCliSession {
        const s = this.pool.session(key, this.providerDef.id);
        if (!this.wired.has(s)) this.wire(s);
        return s;
    }

    private wire(s: LiveCliSession) {
        const a = s.adapter as CodexLiveAdapter;
        const seen = new Map<string, string>();
        // The session's tasks (as the CLI reports them, and lost when its process goes) reach the harness's list.
        const offTasks = s.tasks.onChange(() => {
            for (const task of s.tasks.snapshot()) {
                const k = JSON.stringify(task);
                if (seen.get(task.id) === k) continue;
                seen.set(task.id, k);
                // Its app-server went (a crash, a restart): the thread, resumed by the next one, still has it running.
                if (task.withProcess && task.status === "stopped") {
                    a.carried.push(`Your ${task.kind === "agent" ? `background sub-agent "${task.label}"` : `background command \`${task.label}\``} (${task.id}) stopped when Codex's app-server stopped. It is no longer running and won't report back; start it again only if it's still needed.`);
                    liveDebug("codex", "background task lost with the app-server", { session: s.key, id: task.id });
                }
                a.t?.session.emitSession?.({ type: "background_task", task });
            }
        });
        const offWake = s.onWake((w) => void a.forwardWake(w));
        this.wired.set(s, () => {
            offTasks();
            offWake();
        });
    }

    /** A turn of this session's is running here: another one waits for it (it would take over its state). */
    private busy(t: BackendTurn): BackendResult | undefined {
        const s = this.pool.get(t.sessionKey, this.providerDef.id);
        if (!(s?.adapter as CodexLiveAdapter | undefined)?.run) return undefined;
        liveDebug("codex", "turn refused: another turn of the session is running", { session: t.sessionKey });
        return { reason: "error", text: "", actions: [], error: "Codex is already running a turn of this session." };
    }

    async runTurn(t: BackendTurn): Promise<BackendResult> {
        const refused = this.busy(t);
        if (refused) return refused;
        const { s, a } = await this.ready(t);
        const run = new LiveRun(t);
        return this.runOn(s, a, run);
    }

    /** Codex's own compaction of the thread, on the live app-server. */
    async compact(t: BackendTurn): Promise<BackendResult> {
        if (!t.resumeId) return { reason: "done", text: "", actions: [] };
        const refused = this.busy(t);
        if (refused) return refused;
        const s0 = this.pool.get(t.sessionKey, this.providerDef.id);
        const before = s0 ? (s0.adapter as CodexLiveAdapter).t : undefined;
        const { s, a } = await this.ready(t);
        try {
            return await this.runOn(s, a, new LiveRun(t, true));
        } finally {
            // Between turns, the session's host stays the last turn's (a compaction's refuses permissions and takes no wakes).
            if (before && a.t === t) {
                a.t = before;
                s.bind(before.session);
            }
        }
    }

    /** The session for a turn, after the restarts the turn needs: another thread than the live one, or another account. */
    private async ready(t: BackendTurn): Promise<{ s: LiveCliSession; a: CodexLiveAdapter }> {
        let s = this.session(t.sessionKey);
        let a = s.adapter as CodexLiveAdapter;
        if (!t.adopt) {
            const running = s.tasks.running().length;
            // The agent's view of the thread decides: a fresh one (rewound, account folder changed) or another one.
            if (s.sessionId && t.resumeId !== s.sessionId) {
                liveDebug("codex", "new thread for the session: releasing the old app-server", { session: t.sessionKey, live: s.sessionId, wanted: t.resumeId ?? null, tasks: running });
                a.t = t;
                await this.drop(t.sessionKey);
                s = this.session(t.sessionKey);
                a = s.adapter as CodexLiveAdapter;
                if (running) t.sink.emit({ type: "notice", level: "warn", message: `Codex starts a new thread for this session, so ${running === 1 ? "its background task" : `its ${running} background tasks`} stopped.` });
            } else if (t.forkSession && t.resumeId && s.sessionId === t.resumeId) {
                // Shared with a forked session: a copy of it goes on, never the thread itself. On this app-server
                // (its background work goes on); with none running, the next one forks it as it starts.
                let forked = false;
                if (s.state === "idle" && a.conn) forked = await a.conn.forkThread().then(() => true, () => false);
                if (!forked) {
                    a.t = t;
                    await this.drop(t.sessionKey);
                    s = this.session(t.sessionKey);
                    a = s.adapter as CodexLiveAdapter;
                    if (running) t.sink.emit({ type: "notice", level: "warn", message: `Codex starts a copy of this session's thread, so ${running === 1 ? "its background task" : `its ${running} background tasks`} stopped.` });
                }
            } else if (s.state !== "dead" && a.needsRestart(t)) {
                liveDebug("codex", "account changed: restarting the app-server", { session: t.sessionKey, tasks: running });
                a.t = t;
                await s.restart();
                if (running) t.sink.emit({ type: "notice", level: "warn", message: `Codex was restarted for the account's protections, so ${running === 1 ? "its background task" : `its ${running} background tasks`} stopped.` });
            }
        }
        a.t = t;
        return { s, a };
    }

    private async runOn(s: LiveCliSession, a: CodexLiveAdapter, run: LiveRun): Promise<BackendResult> {
        const t = run.t;
        a.run = run;
        try {
            return await this.drive(s, a, run);
        } finally {
            if (a.run === run) a.run = undefined;
            await run.conn?.detach(run);
        }
    }

    private async drive(s: LiveCliSession, a: CodexLiveAdapter, run: LiveRun): Promise<BackendResult> {
        const t = run.t;
        const error = (message: string, extra: Partial<BackendResult> = {}): BackendResult => ({ reason: "error", text: run.out.texts.join("\n\n"), actions: run.out.actions, error: message, ...extra });
        let r: LiveTurnResult;
        let first = true;
        for (;;) {
            if (first && t.adopt) {
                const conn = a.conn;
                if (!conn) return error("Codex's turn ended with its app-server, so there's nothing to take over.");
                s.bind(t.session);
                conn.adoptWake(run, t.adopt);
                try {
                    r = await s.adopt(t.adopt, t.sink, t.signal);
                } catch (e) {
                    return error(redact((e as Error).message));
                }
            } else {
                const settings: LiveSettings = { model: t.model, mode: t.mode, effort: t.effort, fastMode: t.fastMode };
                r = await s.runTurn({ text: run.next.text, images: run.next.images }, t.sink, t.signal, { spawn: t, settings, host: t.session });
                // Never sent (stopped first): the messages it carried go to the next turn.
                if (!run.next.started && run.next.queued) run.conn?.keepUnsent(run.next.queued);
            }
            first = false;
            if (r.deferred && !run.saidDeferred) {
                run.saidDeferred = true;
                t.sink.emit({ type: "notice", level: "info", message: `New Codex settings apply once its background work ends (${r.deferred.tasks} running). Stop it from Background to apply them now.` });
            }
            if (r.unanswered) t.sink.emit({ type: "notice", level: "warn", message: "Codex didn't confirm the stop in time. It's still running, and so is its background work; its turn may still be finishing." });
            if (a.resumeFailed && !t.signal.aborted) {
                const why = a.resumeFailed;
                a.resumeFailed = undefined;
                // The session's thread is gone: the next turn starts from scratch (the agent sends the conversation).
                await this.drop(t.sessionKey);
                return error(`Couldn't ${t.forkSession ? "fork" : "resume"} the Codex thread: ${why}`, { resumeFailed: true });
            }
            const conn = run.conn;
            // It never got as far as a turn (it couldn't start, or the turn was stopped before).
            if (!conn) {
                if (r.reason === "aborted" || t.signal.aborted) return { reason: "aborted", text: "", actions: [] };
                return error(r.error ?? "Codex didn't start");
            }
            const next = await conn.nextSegment(run, r);
            if (!next) return conn.result(run, r);
            run.next = next;
        }
    }

    async stopBackground(key: string, ids?: string[]): Promise<Record<string, BackgroundStop>> {
        const s = this.pool.get(key, this.providerDef.id);
        if (!s) return Object.fromEntries((ids ?? []).map((id) => [id, "unknown" as const]));
        return s.stopTasks(ids);
    }

    /**
     * Let a session's app-server go: what ran in it is reported stopped with it (withProcess), to the session's
     * host as of its last turn (a released session's agent no longer takes it: AgentBackendClient.release).
     */
    async drop(key: string): Promise<void> {
        const s = this.pool.get(key, this.providerDef.id);
        if (!s) return;
        await this.pool.release(key, this.providerDef.id);
        this.wired.get(s)?.();
        this.wired.delete(s);
    }

    release(key: string): Promise<void> {
        return this.drop(key);
    }

    /**
     * Live sessions turned off (agentCli.liveSessions) while an app-server is kept for the session: it goes before a
     * per-turn one runs, or it would go on beside it on the same thread (a finished command starting a turn there).
     */
    async leave(t: Pick<BackendTurn, "sessionKey" | "sink">): Promise<void> {
        const s = this.pool.get(t.sessionKey, this.providerDef.id);
        if (!s) return;
        const running = s.tasks.running().length;
        liveDebug("codex", "live sessions off: releasing the app-server", { session: t.sessionKey, tasks: running });
        await this.drop(t.sessionKey);
        if (running) t.sink.emit({ type: "notice", level: "warn", message: `Live sessions are off (agentCli.liveSessions), so Codex's app-server for this session was stopped, and ${running === 1 ? "its background task" : `its ${running} background tasks`} with it.` });
    }

    /** The user changed the mode: every live connection checks its turns against it. */
    setMode() {
        for (const s of this.pool.list()) (s.adapter as CodexLiveAdapter).conn?.liveModeChanged();
    }

    async shutdown(): Promise<void> {
        await this.pool.shutdownAll();
        for (const off of this.wired.values()) off();
        this.wired.clear();
    }
}

