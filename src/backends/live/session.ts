// One agent CLI process kept for a harness session (#219 §1). It starts at the
// session's first turn and serves every turn after it, and it stays between
// turns, so the background work it started runs on after the turn that
// started it. It's replaced only when it must be: it exited, it was reaped
// while idle, its spawn settings changed with nothing in the background, or
// someone asked (restart()). Interrupting a turn never stops it.
//
// Nothing here knows a CLI's protocol: the adapter's connection reports what
// happens as CliEvents, and this routes them. A turn's events go to its sink
// until the turn_ended that names its ref. A turn the CLI starts by itself (a
// wake: a background task's report, a goal's next step) is held, its events
// with it, until the runtime adopts it (onWake, adopt).

import { createHash } from "crypto";
import type { TurnEndReason } from "../../agent/agent";
import type { Usage } from "../../providers/types";
import { JsonLinesProcess, cliMessage, stopTiming } from "../cli";
import { BackgroundTasks, type StopResult } from "./tasks";
import type { AgentCliAdapter, CliConnection, CliEvent, LiveClock, LiveSettings, SessionHost, SpawnConfig, SpawnSpec, TurnInput, TurnSink } from "./types";

/** After the process exits, how long its output may stay quiet before it's no longer read (a child of it may hold it open). */
export const EXIT_DRAIN_MS = 2000;

/**
 * starting: its process is being started, before its session is open; idle: between turns (background
 * work may be running); busy: a prompt's turn is running; stopping: its process is being stopped; dead: no
 * process (not started yet, reaped, stopped or exited): the next turn starts one.
 */
export type LiveState = "starting" | "idle" | "busy" | "stopping" | "dead";

export interface LiveOptions {
    /** An idle process with nothing in the background is stopped after this long. */
    idleMs: number;
    /** After an interrupt, how long the turn may take to end before it's ended here (the process stays). */
    interruptMs: number;
    /** How long a background task's stop may take to be confirmed. */
    stopConfirmMs: number;
    /** After asking the CLI to finish, before terminating it. */
    stopGraceMs: number;
    clock: LiveClock;
}

export const realClock: LiveClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function liveOptions(o: Partial<LiveOptions> = {}): LiveOptions {
    return { idleMs: 15 * 60_000, interruptMs: stopTiming.interruptMs, stopConfirmMs: 5000, stopGraceMs: 3000, clock: realClock, ...o };
}

/** A fingerprint of spawn settings: equal for equal values, whatever the order of their keys. */
export function spawnFingerprint(parts: unknown): string {
    return createHash("sha256").update(stableJson(parts)).digest("hex");
}

function stableJson(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
    if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
    }
    return JSON.stringify(v) ?? "null";
}

export interface LiveTurnResult {
    /** The turn's ref; none when it ended before it had one (its prompt was never taken). */
    ref?: string;
    reason: TurnEndReason;
    error?: string;
    usage?: Usage;
    limit?: { resetsAt?: number };
    /** Every prompt the turn answered: its own, and steering messages folded into it. */
    answers?: string[];
    /** The CLI didn't end the turn within interruptMs of the interrupt: it was ended here, and the CLI may still be on it. */
    unanswered?: boolean;
    /** The spawn settings changed while background work ran: this turn ran on the old process, and the new settings wait for it. */
    deferred?: { tasks: number };
}

/** A turn the CLI started by itself, waiting to be adopted. */
export interface LiveWake {
    ref: string;
    origin: "wake" | "goal";
}

interface Turn {
    ref?: string;
    origin: "user" | "wake" | "goal";
    sink?: TurnSink;
    /** Events from before it had a sink (a wake not adopted yet) or a ref (its prompt still being sent). */
    held: CliEvent[];
    result?: LiveTurnResult;
    resolve?: (r: LiveTurnResult) => void;
    /** Its ref, once its prompt is sent (undefined if that failed). */
    refKnown?: Promise<string | undefined>;
    interrupting?: boolean;
    timer?: unknown;
    /** Its stand-in in `abandoned`: it was ended here before its prompt was taken. */
    abandonedAs?: string;
}

export class LiveCliSession {
    readonly tasks: BackgroundTasks;
    private _state: LiveState = "dead";
    private proc?: JsonLinesProcess;
    private conn?: CliConnection;
    /** Which process events and exits count: each start and stop moves it on. */
    private generation = 0;
    private fingerprint?: string;
    /** As the running process has them. */
    private settings?: LiveSettings;
    private cliSessionId?: string;
    private host?: SessionHost;
    /** A turn is being prepared or run (runTurn). */
    private claimed = false;
    private turn?: Turn;
    private wakes = new Map<string, Turn>();
    /** The CLI said it will start a turn to report something, and hasn't yet. */
    private wakeDue = false;
    private unseenWakes: LiveWake[] = [];
    private wakeListeners = new Set<(w: LiveWake) => void>();
    private eventListeners = new Set<(e: CliEvent) => void>();
    private quietWaiters = new Set<() => void>();
    /** Refs of turns ended here after an interrupt went unanswered, until the CLI ends them. */
    private abandoned = new Set<string>();
    /** Stand-ins in `abandoned` for turns whose prompt the CLI hadn't taken yet. */
    private untaken = 0;
    /** The last few refs the CLI ended that were no turn's here. */
    private endedElsewhere = new Set<string>();
    private stale = false;
    private stopping?: Promise<void>;
    /** A settings change the running process hasn't answered yet: the next waits for it. */
    private applying?: Promise<unknown>;
    private closed = false;
    private idleTimer?: unknown;
    private _lastActive: number;
    private _error?: string;
    /** Calls the host bound now, so the connection keeps one across rebinding. */
    private readonly hostProxy = new Proxy({} as SessionHost, {
        get: (_, k) => {
            const h = this.host as Record<PropertyKey, unknown> | undefined;
            const v = h?.[k];
            return typeof v === "function" ? v.bind(h) : v;
        },
    });

    constructor(
        /** The harness session (or child agent) it serves. */
        readonly key: string,
        readonly adapter: AgentCliAdapter,
        private o: LiveOptions & { onChange?(s: LiveCliSession): void } = liveOptions(),
    ) {
        this.tasks = new BackgroundTasks(o.clock, o.stopConfirmMs);
        this.tasks.onChange(() => this.changed());
        this._lastActive = o.clock.now();
    }

    get provider(): string {
        return this.adapter.def.id;
    }
    get state(): LiveState {
        return this._state;
    }
    /** The running process's pid. */
    get pid(): number | undefined {
        return this.proc?.pid;
    }
    /** The CLI's own session id, as its process last reported it; later processes resume it. */
    get sessionId(): string | undefined {
        return this.cliSessionId;
    }
    /** The last turn's spawn settings wait for background work to end (offer "Restart now"). */
    get staleConfig(): boolean {
        return this.stale;
    }
    /** An interrupt went unanswered and the CLI hasn't ended that turn since (offer a restart). */
    get unresponsive(): boolean {
        return this.abandoned.size > 0;
    }
    /** Why the last process ended, when it wasn't asked to. */
    get error(): string | undefined {
        return this._error;
    }
    get lastActive(): number {
        return this._lastActive;
    }

    /** Nothing in the background: no running task, no turn the CLI started by itself going or due. */
    quiet(): boolean {
        return this.background() === 0;
    }

    /**
     * Idle with nothing in the background, and no turn the CLI may still be on (an interrupt it didn't
     * answer): the process may be stopped and started again later at no loss.
     */
    reapable(): boolean {
        return this._state === "idle" && !this.claimed && this.abandoned.size === 0 && this.quiet();
    }

    /** What runs in the background: running tasks, turns the CLI started by itself, and a report it said it will start. */
    private background(): number {
        return this.tasks.running().length + [...this.wakes.values()].filter((w) => !w.result).length + (this.wakeDue ? 1 : 0);
    }

    /** Use this host from now on (the session's Agent changed). runTurn binds its own. */
    bind(host: SessionHost): void {
        this.host = host;
    }

    /**
     * Run a prompt as a turn: start the process if there's none (or restart it for new spawn settings, when
     * nothing runs in the background), apply the settings, send the prompt, and pass the turn's events to
     * `sink` until it ends. Aborting `signal` interrupts the turn; before the prompt is sent, it ends the turn
     * at once (a process still starting is stopped). One at a time. A process that can't be started (or exits
     * while starting) ends the turn with an error; an adapter that can't say how to start one (the CLI isn't
     * installed) throws. Closing the session meanwhile ends it aborted, and starts nothing.
     */
    async runTurn(input: TurnInput, sink: TurnSink, signal: AbortSignal, o: { spawn: SpawnConfig; settings: LiveSettings; host: SessionHost }): Promise<LiveTurnResult> {
        if (this.closed) throw new Error(`This ${this.adapter.def.name} session was closed`);
        if (this.claimed) throw new Error(`${this.adapter.def.name} is already running a turn`);
        this.claimed = true;
        this.host = o.host;
        this.touch();
        this.changed();
        try {
            let deferred: { tasks: number } | undefined;
            try {
                deferred = await this.prepare(o.spawn, o.settings, signal);
            } catch (e) {
                if (e instanceof Stopped || (e instanceof StartError && (this.closed || signal.aborted))) return { reason: "aborted" };
                if (e instanceof StartError) return { reason: "error", error: e.message };
                throw e;
            }
            if (signal.aborted) return { reason: "aborted" };
            const r = await this.prompt(input, sink, signal);
            return deferred ? { ...r, deferred } : r;
        } finally {
            this.claimed = false;
            this.touch();
            this.changed();
        }
    }

    /** Called with each turn the CLI starts by itself; those started before any listener come to the first. Returns the unsubscribe. */
    onWake(listener: (w: LiveWake) => void): () => void {
        this.wakeListeners.add(listener);
        for (const w of this.unseenWakes.splice(0)) listener(w);
        return () => void this.wakeListeners.delete(listener);
    }

    /** Take a turn the CLI started by itself: its events so far, then the rest, go to `sink` until it ends. */
    async adopt(ref: string, sink: TurnSink, signal: AbortSignal): Promise<LiveTurnResult> {
        const w = this.wakes.get(ref);
        if (!w || w.sink) throw new Error(`No turn ${ref} to adopt`);
        w.sink = sink;
        for (const e of w.held.splice(0)) if (e.t === "turn_event") sink.emit(e.event);
        const onAbort = () => void this.interrupt(ref);
        signal.addEventListener("abort", onAbort, { once: true });
        try {
            if (signal.aborted) onAbort();
            return await new Promise<LiveTurnResult>((resolve) => (w.result ? resolve(w.result) : (w.resolve = resolve)));
        } finally {
            signal.removeEventListener("abort", onAbort);
            this.wakes.delete(ref);
            this.changed();
        }
    }

    /** Session-wide events: tasks, limits, the goal, the CLI's commands, and turn events that belong to no turn. Returns the unsubscribe. */
    onEvent(listener: (e: CliEvent) => void): () => void {
        this.eventListeners.add(listener);
        return () => void this.eventListeners.delete(listener);
    }

    /**
     * Interrupt a turn (the prompt's, or a wake's by its ref). The process and its background work stay. If
     * the CLI doesn't end the turn within interruptMs, it's ended here as aborted (unanswered) and the
     * session counts as unresponsive.
     */
    async interrupt(ref?: string): Promise<void> {
        const turn = ref === undefined || this.turn?.ref === ref ? this.turn : this.wakes.get(ref);
        if (!turn || turn.result || turn.interrupting) return;
        turn.interrupting = true;
        const gen = this.generation;
        // The deadline runs from now, whether or not the CLI has taken the prompt yet.
        turn.timer = this.o.clock.setTimeout(() => {
            if (turn.result) return;
            // Not taken yet: it's held under a stand-in until its ref comes (prompt()).
            this.abandoned.add(turn.ref ?? (turn.abandonedAs = `?${++this.untaken}`));
            this.finish(turn, { ref: turn.ref, reason: "aborted", unanswered: true });
        }, this.o.interruptMs);
        const r = turn.ref ?? (await turn.refKnown);
        if (r && gen === this.generation) await this.conn?.interrupt(r).catch(() => {});
    }

    /** Stop background tasks: these, or every running one. */
    async stopTasks(ids?: string[]): Promise<Record<string, StopResult>> {
        const conn = this.conn;
        const targets = ids ?? this.tasks.running().map((t) => t.id);
        const results = await Promise.all(targets.map((id) => this.tasks.stop(id, conn?.stopTask ? () => conn.stopTask!(id) : undefined)));
        return Object.fromEntries(targets.map((id, i) => [id, results[i]!]));
    }

    /**
     * Once nothing runs in the background (no task, no turn the CLI started by itself): for a run with no
     * later turn to take reports (-p, a sub-agent). False when `signal` aborted first.
     */
    async whenQuiet(signal?: AbortSignal): Promise<boolean> {
        while (!this.quiet()) {
            if (signal?.aborted) return false;
            await new Promise<void>((resolve) => {
                // Whichever comes first lets go of both.
                const settle = () => {
                    this.quietWaiters.delete(settle);
                    signal?.removeEventListener("abort", settle);
                    resolve();
                };
                this.quietWaiters.add(settle);
                signal?.addEventListener("abort", settle, { once: true });
            });
        }
        return !signal?.aborted;
    }

    /**
     * Stop the process and what runs under it: a running turn ends (aborted), background tasks are lost.
     * The next turn starts it again, resuming the CLI's session.
     */
    stop(): Promise<void> {
        return (this.stopping ??= this.stopProcess().finally(() => (this.stopping = undefined)));
    }

    /** Stop, and take no more turns (the pool let it go). */
    close(): Promise<void> {
        this.closed = true;
        return this.stop();
    }

    /** For a user's "Restart": as stop(), and the next turn takes the current spawn settings. */
    restart(): Promise<void> {
        return this.stop();
    }

    /**
     * Have a process ready for a turn, with its settings. Starts over when the process goes meanwhile (stopped,
     * restarted, exited); throws Stopped once the session is closed or the turn aborted.
     */
    private async prepare(cfg: SpawnConfig, settings: LiveSettings, signal: AbortSignal): Promise<{ tasks: number } | undefined> {
        for (;;) {
            if (this.closed || signal.aborted) throw new Stopped();
            if (this.stopping) {
                await this.stopping;
                continue;
            }
            if (this.applying) {
                // A change the CLI hasn't answered (its turn was aborted): nothing overtakes it.
                await untilAborted(this.applying, signal);
                continue;
            }
            // Once the CLI has a session of its own, a new process resumes that (a fork is forked once).
            const c = this.cliSessionId ? { ...cfg, resumeId: this.cliSessionId, forkSession: false } : cfg;
            const spec = this.adapter.spawn(c);
            const proc = this.proc;
            const conn = this.conn;
            if (!proc || !conn) {
                await this.start(spec, settings, { resumeId: c.resumeId, fork: c.forkSession }, signal);
                return undefined;
            }
            const gen = this.generation;
            let deferred: { tasks: number } | undefined;
            let restart = false;
            if (spec.fingerprint !== this.fingerprint) {
                if (this.background()) deferred = { tasks: this.background() };
                else restart = true;
            }
            const changed = restart ? undefined : settingsChange(this.settings, settings);
            if (changed) {
                const r = await this.applySettings(proc, conn, changed, signal);
                // The process went meanwhile: start over.
                if (gen !== this.generation) continue;
                if (r === "applied") this.settings = settings;
                else if (this.background()) deferred ??= { tasks: this.background() };
                else restart = true;
            }
            if (restart) {
                // Through stop(), so a close meanwhile waits for it too.
                await this.stop();
                continue;
            }
            this.stale = deferred !== undefined;
            return deferred;
        }
    }

    /** Change the running process's settings: "restart" when it can't, or exits meanwhile. Throws Stopped when the turn is aborted first. */
    private async applySettings(proc: JsonLinesProcess, conn: CliConnection, changed: Partial<LiveSettings>, signal: AbortSignal): Promise<"applied" | "restart"> {
        const answer = Promise.race([conn.apply(changed).catch(() => "restart" as const), proc.exited.then(() => "restart" as const)]);
        const applying: Promise<unknown> = (this.applying = answer.finally(() => {
            if (this.applying === applying) this.applying = undefined;
        }));
        try {
            return await untilAborted(answer, signal);
        } catch (e) {
            // What the CLI took of them isn't known: the next turn sends them all.
            if (proc === this.proc) this.settings = undefined;
            throw e;
        }
    }

    private async start(spec: SpawnSpec, settings: LiveSettings, resume: { resumeId?: string; fork?: boolean }, signal: AbortSignal): Promise<void> {
        let proc: JsonLinesProcess;
        try {
            proc = new JsonLinesProcess(spec.bin, spec.args, { cwd: spec.cwd, env: spec.env });
        } catch (e) {
            // Not even spawned (no such binary or folder): still no process.
            throw new StartError(`${this.adapter.def.name} couldn't start: ${e instanceof Error ? e.message : String(e)}`);
        }
        const gen = ++this.generation;
        this._state = "starting";
        this._error = undefined;
        this.fingerprint = spec.fingerprint;
        this.settings = undefined;
        this.stale = false;
        this.proc = proc;
        const exited = proc.exited.then(async (code) => {
            await Promise.race([proc.stderrEnded, Bun.sleep(EXIT_DRAIN_MS)]);
            throw new StartError(this.exitMessage(proc, code));
        });
        exited.catch(() => {});
        // Stopped (or closed) while starting: what's started here is let go.
        const current = () => {
            if (gen !== this.generation) throw this.closed ? new Stopped() : new StartError(`${this.adapter.def.name} was stopped while starting`);
        };
        try {
            const conn = await untilAborted(Promise.race([this.adapter.connect(proc, (e) => gen === this.generation && this.route(e), this.hostProxy), exited]), signal);
            current();
            this.conn = conn;
            const { sessionId } = await untilAborted(Promise.race([conn.open({ ...resume, settings }), exited]), signal);
            current();
            this.settings = settings;
            this.noteSessionId(sessionId);
            void this.watch(proc, conn, gen);
            this._state = "idle";
        } catch (e) {
            if (gen === this.generation) {
                this.detach();
                this._state = "dead";
            }
            await proc.kill();
            throw e instanceof StartError || e instanceof Stopped ? e : new StartError(e instanceof Error ? e.message : String(e));
        }
    }

    /** Until the process exits on its own: then whatever ran in it is gone. */
    private async watch(proc: JsonLinesProcess, conn: CliConnection, gen: number) {
        const code = await proc.exited;
        await Promise.race([Promise.all([conn.done.catch(() => {}), proc.stderrEnded]), Bun.sleep(EXIT_DRAIN_MS)]);
        if (gen !== this.generation) return;
        this.detach(this.exitMessage(proc, code));
        this._state = "dead";
        this.changed();
    }

    private async stopProcess(): Promise<void> {
        const proc = this.proc;
        if (!proc) return;
        const conn = this.conn;
        this.detach();
        this._state = "stopping";
        this.changed();
        if (conn) await Promise.race([conn.close().catch(() => {}), Bun.sleep(this.o.stopGraceMs)]);
        await proc.stop(this.o.stopGraceMs);
        if (!this.proc) this._state = "dead";
        this.changed();
    }

    /** The process is no longer this session's: its turns end (an error when it went by itself), its tasks are lost. */
    private detach(error?: string) {
        this.generation++;
        this.proc = undefined;
        this.conn = undefined;
        this.fingerprint = undefined;
        this.settings = undefined;
        this.stale = false;
        this.abandoned.clear();
        this.endedElsewhere.clear();
        this.applying = undefined;
        this.wakeDue = false;
        this._error = error;
        const reason: TurnEndReason = error === undefined ? "aborted" : "error";
        for (const t of [this.turn, ...this.wakes.values()]) if (t && !t.result) this.finish(t, { ref: t.ref, reason, ...(error === undefined ? {} : { error }) });
        this.tasks.lose();
    }

    private exitMessage(proc: JsonLinesProcess, code: number): string {
        return `${this.adapter.def.name} stopped: ${cliMessage(proc.stderr()) || `exit code ${code}`}`;
    }

    private async prompt(input: TurnInput, sink: TurnSink, signal: AbortSignal): Promise<LiveTurnResult> {
        const conn = this.conn;
        // Stopped since it was readied.
        if (!conn) return { reason: "aborted" };
        const gen = this.generation;
        const turn: Turn = { origin: "user", sink, held: [] };
        const done = new Promise<LiveTurnResult>((resolve) => (turn.resolve = resolve));
        let known!: (ref: string | undefined) => void;
        turn.refKnown = new Promise((resolve) => (known = resolve));
        this.turn = turn;
        this._state = "busy";
        const onAbort = () => void this.interrupt();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
            conn.prompt(input).then(
                ({ ref }) => {
                    turn.ref = ref;
                    known(ref);
                    // Gone with its process if that went meanwhile.
                    if (gen !== this.generation) return;
                    // Ended here before the CLI took it (an unanswered interrupt): the CLI may be on it now, unless it ended it already.
                    if (turn.abandonedAs !== undefined) {
                        this.abandoned.delete(turn.abandonedAs);
                        if (!this.endedElsewhere.has(ref)) this.abandoned.add(ref);
                        this.changed();
                    }
                    // Held while it was sent: those that named no turn were this one's, whichever turn runs now.
                    for (const e of turn.held.splice(0)) this.route(e.t === "turn_event" && e.ref === undefined ? { ...e, ref } : e);
                },
                (e) => {
                    known(undefined);
                    if (turn.abandonedAs !== undefined && this.abandoned.delete(turn.abandonedAs)) this.changed();
                    this.finish(turn, { reason: "error", error: e instanceof Error ? e.message : String(e) });
                    // Held while it was sent; not taken, so it had none of them: those that named no turn are no turn's.
                    if (gen === this.generation) for (const e of turn.held.splice(0)) e.t === "turn_event" && e.ref === undefined ? this.emitSession(e) : this.route(e);
                },
            );
            if (signal.aborted) onAbort();
            return await done;
        } finally {
            signal.removeEventListener("abort", onAbort);
            if (this.turn === turn) this.turn = undefined;
            if (this._state === "busy") this._state = "idle";
        }
    }

    private route(e: CliEvent) {
        switch (e.t) {
            case "task":
                this.touch();
                if (e.wakeDue) this.wakeDue = true;
                this.tasks.report(e.task);
                return this.emitSession(e);
            case "session_id":
                return this.noteSessionId(e.id);
            case "limits":
            case "goal":
            case "commands":
                return this.emitSession(e);
        }
        const user = this.turn;
        // Its prompt is still being sent: what may be its own waits until it's taken. A turn the CLI started by
        // itself, and what names one, isn't.
        if (user && user.ref === undefined && !user.result && !this.notPrompted(e)) return void user.held.push(e);
        // A turn started or ended: a report that was due is in it. Told once the turn is in place, so
        // nothing sees the session quiet between the report's due and its turn.
        const reported = e.t !== "turn_event" && this.wakeDue;
        if (reported) this.wakeDue = false;
        try {
            this.routeTurn(e);
        } finally {
            if (reported) this.changed();
        }
    }

    private routeTurn(e: Extract<CliEvent, { t: "turn_started" | "turn_event" | "turn_ended" }>) {
        const user = this.turn;
        if (e.t === "turn_started") {
            if ((user && answers(user, e.ref, e.answers)) || this.wakes.has(e.ref) || this.abandoned.has(e.ref) || e.origin === "user") return;
            return this.startWake(e.ref, e.origin);
        }
        const turn = this.turnFor(e);
        if (!turn) {
            if (e.t !== "turn_ended") return this.emitSession(e);
            // A turn ended here after an unanswered interrupt: the CLI is done with it now.
            const was = this.abandoned.size;
            for (const r of [e.ref, ...(e.answers ?? [])]) {
                if (this.abandoned.delete(r)) continue;
                // Maybe one whose prompt is still being acknowledged: remember a few.
                this.endedElsewhere.add(r);
                if (this.endedElsewhere.size > 16) this.endedElsewhere.delete(this.endedElsewhere.values().next().value!);
            }
            if (this.abandoned.size !== was) this.changed();
            return;
        }
        if (e.t === "turn_event") return void (turn.sink ? turn.sink.emit(e.event) : turn.held.push(e));
        this.finish(turn, { ref: turn.ref, reason: e.reason, error: e.error, usage: e.usage, limit: e.limit, answers: e.answers });
    }

    /** A turn the CLI started by itself, or an event that names one known here (or one ended here unanswered). */
    private notPrompted(e: Extract<CliEvent, { t: "turn_started" | "turn_event" | "turn_ended" }>): boolean {
        if (e.t === "turn_started") return e.origin !== "user";
        return e.ref !== undefined && (this.wakes.has(e.ref) || this.abandoned.has(e.ref));
    }

    private turnFor(e: Extract<CliEvent, { t: "turn_event" | "turn_ended" }>): Turn | undefined {
        const user = this.turn && !this.turn.result ? this.turn : undefined;
        if (e.ref === undefined) {
            if (user) return user;
            const going = [...this.wakes.values()].filter((w) => !w.result);
            return going.length === 1 ? going[0] : undefined;
        }
        if (user && answers(user, e.ref, e.t === "turn_ended" ? e.answers : undefined)) return user;
        return this.wakes.get(e.ref);
    }

    private startWake(ref: string, origin: "wake" | "goal") {
        this.wakes.set(ref, { ref, origin, held: [] });
        this.touch();
        const w = { ref, origin };
        if (this.wakeListeners.size) for (const l of [...this.wakeListeners]) l(w);
        else this.unseenWakes.push(w);
        this.changed();
    }

    private finish(turn: Turn, r: LiveTurnResult) {
        if (turn.result) return;
        const result = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) as unknown as LiveTurnResult;
        turn.result = result;
        if (turn.timer !== undefined) this.o.clock.clearTimeout(turn.timer);
        turn.resolve?.(result);
        this.touch();
        this.changed();
    }

    private noteSessionId(id: string | undefined) {
        if (!id || id === this.cliSessionId) return;
        this.cliSessionId = id;
        this.host?.sessionId(id);
    }

    private emitSession(e: CliEvent) {
        for (const l of [...this.eventListeners]) l(e);
    }

    private touch() {
        this._lastActive = this.o.clock.now();
    }

    /** Something changed: the idle timer, whenQuiet and the pool look again. */
    private changed() {
        const reapable = this.reapable();
        if (!reapable && this.idleTimer !== undefined) {
            this.o.clock.clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        } else if (reapable && this.idleTimer === undefined) {
            this.idleTimer = this.o.clock.setTimeout(() => {
                this.idleTimer = undefined;
                if (this.reapable()) void this.stop();
            }, this.o.idleMs);
        }
        if (this.quiet()) {
            for (const w of [...this.quietWaiters]) w();
        }
        this.o.onChange?.(this);
    }
}

/** A process that couldn't be started, or exited while starting: the turn ends with it as its error. */
class StartError extends Error {}

/** The turn was aborted, or the session closed, before its prompt was sent: the turn ends aborted. */
class Stopped extends Error {}

/** `p`, unless `signal` aborts first: then Stopped. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new Stopped());
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new Stopped());
        signal.addEventListener("abort", onAbort, { once: true });
        p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
}

function answers(turn: Turn, ref: string, refs: string[] | undefined): boolean {
    return turn.ref !== undefined && (turn.ref === ref || Boolean(refs?.includes(turn.ref)));
}

/** What changed from `was` to `now`, or undefined when nothing did. */
function settingsChange(was: LiveSettings | undefined, now: LiveSettings): Partial<LiveSettings> | undefined {
    if (!was) return now;
    const out: Partial<LiveSettings> = {};
    if (was.model.provider !== now.model.provider || was.model.id !== now.model.id) out.model = now.model;
    if (was.mode !== now.mode) out.mode = now.mode;
    if (was.effort !== now.effort) out.effort = now.effort;
    if (Boolean(was.fastMode) !== Boolean(now.fastMode)) out.fastMode = now.fastMode;
    return Object.keys(out).length ? out : undefined;
}
