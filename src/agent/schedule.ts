// Prompts that run later, in the session that scheduled them: /loop's
// intervals, cron jobs the model (or the user) sets up, and the turn that picks
// up again when a plan's usage limit resets. A job only fires while its
// session is idle; one that comes due while it's busy runs once, as soon as it
// isn't. Nothing is polled: one timer is set for the next job due (at most a
// minute ahead, so sleep and clock changes are noticed), and none at all
// without jobs.

import { randomBytes } from "crypto";
import { CronError, describeCron, nextRun, parseCron, type Cron } from "../util/cron";
import type { ScheduleInfo } from "../server/protocol";

export type { ScheduleInfo };
export type ScheduleKind = ScheduleInfo["kind"];


export interface ScheduledJob {
    id: string;
    kind: ScheduleKind;
    prompt: string;
    /** cron jobs: the expression. */
    cron?: string;
    /** loops: the interval. */
    everyMs?: number;
    /** resume and one-shot cron jobs: false. */
    recurring: boolean;
    /** Saved with the session; back when it's opened again. */
    durable?: boolean;
    createdAt: number;
    /** Recurring jobs stop after this. */
    expiresAt?: number;
    /** When it runs next (while paused: when it would have). */
    nextAt?: number;
    paused?: boolean;
    lastRunAt?: number;
    runs: number;
    /** Came due while the session was busy: runs as soon as it isn't. */
    due?: boolean;
    /** When it came due, so jobs waiting together run in that order. */
    dueAt?: number;
}

export const MAX_JOBS = 50;
export const RECURRING_TTL_MS = 7 * 24 * 3_600_000;
export const MIN_INTERVAL_MS = 60_000;
export const MAX_INTERVAL_MS = 7 * 24 * 3_600_000;
export const DEFAULT_LOOP_MS = 10 * 60_000;
/** The timer never sleeps longer than this, so a laptop waking up or a clock change is noticed within it. */
export const MAX_SLEEP_MS = 60_000;
/** A one-shot that came due while the app was closed runs when the session opens if it's no later than this. */
export const LATE_ONE_SHOT_MS = 24 * 3_600_000;
export const MAX_PROMPT = 20_000;

export interface Clock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        (t as { unref?: () => void }).unref?.();
        return t;
    },
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface SchedulerHost {
    /** Whether a prompt can start now: no turn, dialog, question or goal continuation in the way. */
    idle(): boolean;
    /** Start the job's prompt as a turn (the host shows it as scheduled). */
    fire(job: ScheduledJob): void;
    /** The jobs changed (added, removed, ran, paused): save the durable ones, refresh what shows them. */
    changed?(jobs: ScheduledJob[]): void;
    notice?(text: string, level?: "info" | "warn"): void;
}

export type AddSpec =
    | { kind: "loop"; prompt: string; everyMs: number; runNow?: boolean }
    | { kind: "cron"; prompt: string; cron: string; recurring?: boolean; durable?: boolean }
    | { kind: "resume"; prompt: string; at: number };

function newJobId(): string {
    return randomBytes(4).toString("hex");
}

/** "5m", "2h", "1d", "90s" (rounded up to whole minutes); undefined if it isn't one. */
export function parseInterval(text: string): number | undefined {
    const m = text.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/);
    if (!m) return undefined;
    const n = Number(m[1]);
    const unit = m[2]![0];
    const ms = n * (unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
    if (!Number.isFinite(ms) || ms <= 0) return undefined;
    return Math.ceil(ms / 60_000) * 60_000;
}

/** "10m", "2h", "1h 30m", "1d". */
export function intervalText(ms: number): string {
    const mins = Math.round(ms / 60_000);
    if (mins < 60) return `${mins}m`;
    if (mins % 1440 === 0) return `${mins / 1440}d`;
    const h = Math.floor(mins / 60);
    return mins % 60 ? `${h}h ${mins % 60}m` : `${h}h`;
}

/**
 * /loop's arguments: `[interval] <prompt>`, or `<prompt> every <interval>`.
 * The interval defaults to 10 minutes.
 */
export function parseLoopArgs(args: string): { everyMs: number; prompt: string } | { error: string } {
    const text = args.trim();
    if (!text) return { error: "Usage: /loop [interval] <prompt>, e.g. /loop 5m check the deploy (the interval defaults to 10m)." };
    let everyMs: number | undefined;
    let prompt = text;
    const lead = text.match(/^(\S+)\s+([\s\S]+)$/);
    const leadMs = lead ? parseInterval(lead[1]!) : undefined;
    const trail = text.match(/^([\s\S]+?)\s+every\s+(\S+(?:\s*(?:s|m|h|d|sec|min|mins|minutes?|hours?|days?))?)$/i);
    const trailMs = trail ? parseInterval(trail[2]!) : undefined;
    if (leadMs !== undefined) {
        everyMs = leadMs;
        prompt = lead![2]!.trim();
    } else if (trailMs !== undefined) {
        everyMs = trailMs;
        prompt = trail![1]!.trim();
    } else if (parseInterval(text) !== undefined) {
        return { error: "Say what to run after the interval, e.g. /loop 5m check the deploy." };
    }
    everyMs ??= DEFAULT_LOOP_MS;
    if (everyMs < MIN_INTERVAL_MS) everyMs = MIN_INTERVAL_MS;
    if (everyMs > MAX_INTERVAL_MS) return { error: `The longest interval is ${intervalText(MAX_INTERVAL_MS)}. For something less often, ask for a schedule (cron) instead.` };
    if (prompt.length > MAX_PROMPT) return { error: `The prompt is too long (at most ${MAX_PROMPT} characters).` };
    return { everyMs, prompt };
}

/** "every 10m", "weekdays at 9:00 AM", "once, Tue 21 Oct 2:30 PM", "when your usage limit resets". */
export function describeJob(job: ScheduledJob, at: (ms: number) => string = shortTime): string {
    if (job.kind === "loop") return `every ${intervalText(job.everyMs ?? DEFAULT_LOOP_MS)}`;
    if (job.kind === "resume") return "when your usage limit resets";
    if (!job.recurring) return job.nextAt ? `once, ${at(job.nextAt)}` : "once";
    try {
        return describeCron(parseCron(job.cron ?? ""));
    } catch {
        return job.cron ?? "";
    }
}

/** "4:40 PM" today, else "Tue 21 Oct, 9:00 AM" (local time). */
export function shortTime(ms: number, now = Date.now()): string {
    const d = new Date(ms);
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (d.toDateString() === new Date(now).toDateString()) return time;
    return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${time}`;
}

export function scheduleInfo(job: ScheduledJob): ScheduleInfo {
    return {
        id: job.id,
        kind: job.kind,
        prompt: job.prompt,
        when: describeJob(job),
        recurring: job.recurring,
        durable: Boolean(job.durable),
        paused: Boolean(job.paused),
        nextAt: job.nextAt,
        expiresAt: job.expiresAt,
        lastRunAt: job.lastRunAt,
        runs: job.runs,
        due: Boolean(job.due),
    };
}

/** A job as read back from a session file, or undefined if it isn't a usable one. */
export function validJob(j: unknown): ScheduledJob | undefined {
    const x = j as Partial<ScheduledJob> | null;
    if (!x || typeof x !== "object" || typeof x.id !== "string" || !/^[0-9a-f]{1,16}$/.test(x.id) || typeof x.prompt !== "string" || !x.prompt.trim() || x.prompt.length > MAX_PROMPT) return undefined;
    if (x.kind !== "cron" && x.kind !== "loop" && x.kind !== "resume") return undefined;
    if (typeof x.createdAt !== "number") return undefined;
    if (x.kind === "cron") {
        if (typeof x.cron !== "string") return undefined;
        try {
            parseCron(x.cron);
        } catch {
            return undefined;
        }
    }
    if (x.kind === "loop" && (typeof x.everyMs !== "number" || x.everyMs < MIN_INTERVAL_MS || x.everyMs > MAX_INTERVAL_MS)) return undefined;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    return {
        id: x.id,
        kind: x.kind,
        prompt: x.prompt,
        ...(x.cron !== undefined ? { cron: x.cron } : {}),
        ...(x.everyMs !== undefined ? { everyMs: x.everyMs } : {}),
        recurring: x.recurring !== false && x.kind !== "resume",
        durable: x.durable === true || undefined,
        createdAt: x.createdAt,
        expiresAt: num(x.expiresAt),
        nextAt: num(x.nextAt),
        paused: x.paused === true || undefined,
        lastRunAt: num(x.lastRunAt),
        runs: num(x.runs) ?? 0,
    };
}

export class Scheduler {
    private jobs: ScheduledJob[] = [];
    private timer: unknown;
    private timerAt?: number;
    private crons = new Map<string, Cron>();
    private disposed = false;
    /** Wakes of the timer, for measuring what an idle scheduler costs. */
    wakes = 0;

    constructor(
        private host: SchedulerHost,
        private clock: Clock = realClock,
    ) {}

    list(): ScheduledJob[] {
        return this.jobs.map((j) => ({ ...j }));
    }

    info(): ScheduleInfo[] {
        return this.jobs.map(scheduleInfo);
    }

    get size(): number {
        return this.jobs.length;
    }

    /** Jobs that will run without anyone asking again (not paused). */
    get active(): number {
        return this.jobs.filter((j) => !j.paused).length;
    }

    /** The soonest run of any job that isn't paused. */
    get nextAt(): number | undefined {
        let next: number | undefined;
        // A due job waits for the session, not for a time.
        for (const j of this.jobs) if (!j.paused && !j.due && j.nextAt !== undefined && (next === undefined || j.nextAt < next)) next = j.nextAt;
        return next;
    }

    get(id: string): ScheduledJob | undefined {
        const j = this.find(id);
        return j && { ...j };
    }

    private find(id: string): ScheduledJob | undefined {
        const key = id.trim().toLowerCase();
        return this.jobs.find((j) => j.id === key);
    }

    private cronOf(job: ScheduledJob): Cron {
        let c = this.crons.get(job.cron!);
        if (!c) {
            c = parseCron(job.cron!);
            this.crons.set(job.cron!, c);
        }
        return c;
    }

    /** When the job runs next after `after`, or undefined when it won't again. */
    private following(job: ScheduledJob, after: number): number | undefined {
        if (job.kind === "loop") return after + job.everyMs!;
        if (job.kind === "cron") return nextRun(this.cronOf(job), after);
        return undefined;
    }

    /** Adds a job; throws (CronError or Error) with a message for the user or model when it can't be. */
    add(spec: AddSpec): ScheduledJob {
        if (this.disposed) throw new Error("This session is closed.");
        const prompt = spec.prompt.trim();
        if (!prompt) throw new Error("The prompt is empty.");
        if (prompt.length > MAX_PROMPT) throw new Error(`The prompt is too long (at most ${MAX_PROMPT} characters).`);
        const now = this.clock.now();
        // A new resume replaces the old one (there's only ever one limit to wait for).
        if (spec.kind === "resume") this.jobs = this.jobs.filter((j) => j.kind !== "resume");
        if (this.jobs.length >= MAX_JOBS) throw new Error(`This session already has ${MAX_JOBS} schedules. Delete some first (/schedules).`);
        let job: ScheduledJob;
        if (spec.kind === "loop") {
            if (!(spec.everyMs >= MIN_INTERVAL_MS && spec.everyMs <= MAX_INTERVAL_MS)) throw new Error(`The interval must be between ${intervalText(MIN_INTERVAL_MS)} and ${intervalText(MAX_INTERVAL_MS)}.`);
            job = { id: newJobId(), kind: "loop", prompt, everyMs: spec.everyMs, recurring: true, createdAt: now, expiresAt: now + RECURRING_TTL_MS, nextAt: spec.runNow ? now : now + spec.everyMs, runs: 0 };
        } else if (spec.kind === "cron") {
            const cron = parseCron(spec.cron);
            const next = nextRun(cron, now);
            if (next === undefined) throw new CronError(`"${cron.source}" doesn't run in the next five years.`);
            const recurring = spec.recurring !== false;
            job = { id: newJobId(), kind: "cron", prompt, cron: cron.source, recurring, ...(spec.durable ? { durable: true } : {}), createdAt: now, ...(recurring ? { expiresAt: now + RECURRING_TTL_MS } : {}), nextAt: next, runs: 0 };
        } else {
            job = { id: newJobId(), kind: "resume", prompt, recurring: false, createdAt: now, nextAt: Math.max(spec.at, now), runs: 0 };
        }
        while (this.jobs.some((j) => j.id === job.id)) job.id = newJobId();
        this.jobs.push(job);
        // Not run from in here, even when it's due now: whoever added it says so first.
        this.update(false);
        return { ...job };
    }

    remove(id: string): ScheduledJob | undefined {
        const j = this.find(id);
        if (!j) return undefined;
        this.jobs = this.jobs.filter((x) => x !== j);
        this.update();
        return j;
    }

    /** Removes every job of a kind (all of them without one); returns how many. */
    clear(kind?: ScheduleKind): number {
        const before = this.jobs.length;
        this.jobs = kind ? this.jobs.filter((j) => j.kind !== kind) : [];
        const n = before - this.jobs.length;
        if (n) this.update();
        return n;
    }

    setPaused(id: string, paused: boolean): ScheduledJob | undefined {
        const j = this.find(id);
        if (!j) return undefined;
        if (Boolean(j.paused) === paused) return { ...j };
        j.paused = paused || undefined;
        j.due = undefined;
        j.dueAt = undefined;
        if (!paused) {
            // From now: no burst of what it would have run meanwhile.
            const now = this.clock.now();
            if (!j.recurring && j.nextAt !== undefined && j.nextAt <= now) {
                // A one-shot whose time passed while paused runs now (its next match could be a year away).
                j.due = true;
                j.dueAt = now;
            } else if (j.nextAt === undefined || j.nextAt <= now) j.nextAt = j.kind === "loop" ? now + j.everyMs! : j.kind === "cron" ? this.following(j, now) : now;
        }
        this.update();
        return { ...j };
    }

    /** Runs a job now (as soon as the session is idle), whatever its schedule says. */
    runNow(id: string): ScheduledJob | undefined {
        const j = this.find(id);
        if (!j) return undefined;
        j.due = true;
        j.dueAt = this.clock.now();
        // Soon, not from in here: whoever asked says so first.
        this.update(false);
        return { ...j };
    }

    /**
     * Jobs saved with a session, as it opens again. A recurring job picks up at
     * its next run (what it would have run while the app was closed is
     * skipped); a one-shot that came due runs now if it's under a day late.
     */
    restore(saved: ScheduledJob[]) {
        const now = this.clock.now();
        const notes: string[] = [];
        for (const raw of saved) {
            const j = validJob(raw);
            if (!j || !j.durable || this.jobs.some((x) => x.id === j.id)) continue;
            if (this.jobs.length >= MAX_JOBS) break;
            if (j.recurring && j.expiresAt !== undefined && j.expiresAt <= now) {
                notes.push(`The schedule "${clip(j.prompt)}" expired while ${appClosed} and was removed.`);
                continue;
            }
            // Saved without its next run (that changes every run): from now.
            if (j.recurring) j.nextAt = j.paused ? undefined : this.following(j, now);
            else if (j.nextAt !== undefined && j.nextAt <= now && !j.paused) {
                if (now - j.nextAt <= LATE_ONE_SHOT_MS) {
                    j.due = true;
                    j.dueAt = j.nextAt;
                    notes.push(`"${clip(j.prompt)}" was due ${shortTime(j.nextAt, now)} while ${appClosed}; running it now.`);
                } else {
                    notes.push(`"${clip(j.prompt)}" was due ${shortTime(j.nextAt, now)} while ${appClosed} and was dropped (more than a day late).`);
                    continue;
                }
            }
            this.jobs.push(j);
        }
        for (const n of notes) this.host.notice?.(n, "info");
        this.update();
    }

    /** The session may be idle now (a turn ended, a dialog closed): run what's due. */
    poke() {
        if (this.disposed) return;
        this.tick();
    }

    dispose() {
        this.disposed = true;
        if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
        this.timer = undefined;
        this.timerAt = undefined;
    }

    private tick() {
        const now = this.clock.now();
        let changed = false;
        for (const j of [...this.jobs]) {
            if (j.paused) continue;
            const expired = j.recurring && j.expiresAt !== undefined && j.expiresAt <= now;
            if (j.nextAt !== undefined && j.nextAt <= now) {
                if (!j.due) j.dueAt = j.nextAt;
                j.due = true;
                // A one-shot keeps its time until it runs, so one saved while it waits still runs when the session opens again.
                j.nextAt = expired ? undefined : j.recurring ? this.following(j, now) : j.nextAt;
                changed = true;
            }
            if (expired && !j.due) {
                this.jobs = this.jobs.filter((x) => x !== j);
                this.host.notice?.(`The schedule "${clip(j.prompt)}" (${describeJob(j)}) expired after 7 days and was removed.`, "info");
                changed = true;
            }
        }
        if (this.host.idle()) {
            // Run now (from the user) runs even a paused job.
            const next = this.jobs.filter((j) => j.due).sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))[0];
            if (next) {
                next.due = undefined;
                next.dueAt = undefined;
                next.runs++;
                next.lastRunAt = now;
                // A loop waits its whole interval after a run, however late that run was.
                if (next.kind === "loop" && next.nextAt !== undefined) next.nextAt = now + next.everyMs!;
                const fired = { ...next };
                const expired = next.recurring && next.expiresAt !== undefined && next.expiresAt <= now;
                // A one-shot is done once it runs; a recurring job on its last run is too.
                if (!next.recurring || expired || next.nextAt === undefined) {
                    this.jobs = this.jobs.filter((x) => x !== next);
                    if (expired) this.host.notice?.(`The schedule "${clip(next.prompt)}" (${describeJob(next)}) reached its 7-day limit; this is its last run.`, "info");
                }
                this.update(false);
                this.host.fire(fired);
                return;
            }
        }
        if (changed) this.update(false);
        else this.arm();
    }

    private update(tick = true) {
        this.host.changed?.(this.list());
        if (tick) this.tick();
        else this.arm();
    }

    /** One timer, for the soonest job (or a minute, whichever comes first); none without jobs to wait for. */
    private arm() {
        if (this.disposed) return;
        const now = this.clock.now();
        const next = this.nextAt;
        // Due jobs wait for poke() from the host; the timer still checks in case it never comes.
        const waiting = this.jobs.some((j) => j.due);
        if (next === undefined && !waiting) {
            if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
            this.timer = undefined;
            this.timerAt = undefined;
            return;
        }
        // Due and nothing in the way: right away (busy, the host's poke() will do).
        const at = waiting && this.host.idle() ? now : Math.min(next ?? Infinity, now + MAX_SLEEP_MS);
        if (this.timer !== undefined && this.timerAt === at) return;
        if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
        this.timerAt = at;
        this.timer = this.clock.setTimeout(() => {
            this.timer = undefined;
            this.timerAt = undefined;
            this.wakes++;
            this.tick();
        }, Math.max(0, at - now));
    }
}

const appClosed = "the app was closed";

function clip(s: string, n = 50): string {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export { clip as clipPrompt };
