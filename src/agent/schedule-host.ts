// What the terminal app and the GUI server do the same way around a
// session's Scheduler: saving durable jobs with the session (and in the index
// the GUI server reopens them from), /loop and /schedules, and picking up
// again by itself when a plan's usage limit resets.

import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { ensureDir, paths } from "../config/paths";
import type { Settings } from "../config/settings";
import { resetPhrase } from "../backends/limits";
import { clipPrompt, describeJob, intervalText, parseLoopArgs, realClock, Scheduler, shortTime, type Clock, type ScheduledJob } from "./schedule";
import type { Session } from "./session";

export const RESUME_PROMPT = "Your usage limit has reset. Continue where you left off.";
/** After the reset, so a clock a little off (or a limit counted a little late) doesn't hit it again. */
export const RESUME_DELAY_MS = 60_000;
/** Resumes in a row that hit the limit again before giving up. */
export const MAX_RESUMES = 3;

// ---------------------------------------------------------------------------
// The index of sessions with durable schedules, so the GUI server can reopen
// them when it starts. Only a hint: the session file is what counts.

export interface IndexEntry {
    cwd: string;
    at: number;
}

function indexFile(): string {
    return join(paths.home(), "schedules.json");
}

export function readScheduleIndex(): Record<string, IndexEntry> {
    try {
        const file = indexFile();
        if (!existsSync(file)) return {};
        const data = JSON.parse(readFileSync(file, "utf-8")) as { sessions?: Record<string, IndexEntry> };
        const out: Record<string, IndexEntry> = {};
        for (const [id, e] of Object.entries(data.sessions ?? {})) {
            if (/^[\w-]{1,80}$/.test(id) && e && typeof e.cwd === "string" && typeof e.at === "number") out[id] = { cwd: e.cwd, at: e.at };
        }
        return out;
    } catch {
        return {};
    }
}

/** Notes (or forgets) that a session has durable schedules. Best effort. */
export function noteScheduleIndex(sessionId: string, cwd: string, has: boolean) {
    try {
        const all = readScheduleIndex();
        if (has === Boolean(all[sessionId]) && (!has || all[sessionId]!.cwd === cwd)) return;
        if (has) all[sessionId] = { cwd, at: Date.now() };
        else delete all[sessionId];
        ensureDir(paths.home());
        const file = indexFile();
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ version: 1, sessions: all }, null, 2) + "\n", { mode: 0o600 });
        renameSync(tmp, file);
    } catch {
        // The schedules are still saved with the session; it just isn't reopened by itself.
    }
}

// ---------------------------------------------------------------------------

export interface ScheduleHostOptions {
    session: () => Session;
    settings: () => Settings;
    /** Nothing in the way of a new turn. */
    idle: () => boolean;
    /** Start the prompt as a turn; `label` says it's scheduled ("every 10m"). Settles once it's over (or never started). */
    run: (prompt: string, job: ScheduledJob, label: string) => Promise<unknown> | void;
    notice: (text: string, level?: "info" | "warn") => void;
    /** After any change, for the UI. */
    changed?: () => void;
    clock?: Clock;
    /** False in tests: no index file. */
    index?: boolean;
}

export const NO_SCHEDULES = 'No schedules. /loop 5m <prompt> runs one every 5 minutes, or ask for one ("every weekday at 9, run the tests").';

export type ScheduleAction = "pause" | "resume" | "run" | "delete";

export class SessionSchedules {
    readonly scheduler: Scheduler;
    /** A scheduled prompt is being started or run: the next waits for it, even before the host says it's busy. */
    private running = false;
    /** Resumes since a turn last finished: they stop after MAX_RESUMES. */
    private resumes = 0;
    private clock: Clock;

    constructor(private o: ScheduleHostOptions) {
        this.clock = o.clock ?? realClock;
        this.scheduler = new Scheduler(
            {
                idle: () => !this.running && o.idle(),
                fire: (job) => this.fire(job),
                changed: (jobs) => this.save(jobs),
                notice: (text, level) => o.notice(text, level),
            },
            this.clock,
        );
    }

    /** The session's saved schedules, as it opens (or is switched to). */
    restore() {
        const saved = this.o.session().schedules;
        if (saved.length) this.scheduler.restore(saved);
    }

    /** Another conversation in the same window (/clear, /resume): this one's schedules stop, its saved ones stay saved. */
    switchSession() {
        // Not saved: clearing them here mustn't empty what the old session keeps.
        this.switching = true;
        try {
            this.scheduler.clear();
        } finally {
            this.switching = false;
        }
        this.resumes = 0;
        this.restore();
        this.o.changed?.();
    }

    private switching = false;

    private save(jobs: ScheduledJob[]) {
        if (!this.switching) {
            const session = this.o.session();
            session.setSchedules(jobs);
            if (this.o.index !== false && session.persisted) noteScheduleIndex(session.meta.id, session.meta.cwd, jobs.some((j) => j.durable && !j.paused));
        }
        this.o.changed?.();
    }

    private fire(job: ScheduledJob) {
        if (job.kind === "resume") this.resumes++;
        const label = job.kind === "resume" ? "Resuming after the usage limit reset" : `Scheduled (${describeJob(job)})`;
        this.running = true;
        let run: Promise<unknown> | void;
        try {
            run = this.o.run(job.prompt, job, label);
        } finally {
            // Over already (or failed to start): nothing to wait for.
            if (!run) this.running = false;
        }
        if (run)
            void run
                .catch(() => undefined)
                .finally(() => {
                    this.running = false;
                    this.poke();
                });
    }

    /** The session may be idle now. */
    poke() {
        this.scheduler.poke();
    }

    /** The user sent something themselves: a resume waiting for the limit isn't needed any more. */
    userSent() {
        this.resumes = 0;
        if (this.scheduler.clear("resume")) this.o.notice("The automatic resume is cancelled: you sent a message yourself.");
    }

    /**
     * A turn ended. One that stopped on the plan's usage limit with a known
     * reset time picks up again a minute after it (unless that's turned off,
     * or it has already tried MAX_RESUMES times in a row).
     */
    turnEnded(reason: string, limit: { resetsAt?: number } | undefined) {
        if (reason === "done") this.resumes = 0;
        if (reason !== "error" || !limit) return;
        if (this.o.settings().autoResume === false) return;
        const now = this.clock.now();
        if (limit.resetsAt === undefined) {
            this.o.notice("It won't continue by itself: the reset time isn't known. Send a message when the limit resets.", "info");
            return;
        }
        if (limit.resetsAt <= now) {
            this.o.notice("It won't continue by itself: the limit is still reached after the time it was to reset. Send a message to try again.", "info");
            return;
        }
        if (this.resumes >= MAX_RESUMES) {
            this.o.notice(`It didn't continue by itself: it already tried ${MAX_RESUMES} times and hit the limit again each time.`, "warn");
            return;
        }
        const at = limit.resetsAt + RESUME_DELAY_MS;
        try {
            this.scheduler.add({ kind: "resume", prompt: RESUME_PROMPT, at });
            this.o.notice(`It continues by itself ${resetPhrase(at, now)}. /schedules cancels that (or send something before then).`);
        } catch (e) {
            this.o.notice(`It won't continue by itself: ${(e as Error).message}`, "warn");
        }
    }

    // -----------------------------------------------------------------------
    // Commands (the terminal's and the GUI's /loop and /schedules)

    /** /loop [interval] <prompt> | stop | (nothing: what's looping). Returns what to tell the user. */
    loop(args: string): { text: string; level?: "info" | "warn" | "error" } {
        const a = args.trim();
        if (/^(stop|off|cancel|clear)$/i.test(a)) {
            const n = this.scheduler.clear("loop");
            return { text: n ? `Stopped ${n === 1 ? "the loop" : `${n} loops`}.` : "No loops are running." };
        }
        if (!a) {
            const loops = this.scheduler.list().filter((j) => j.kind === "loop");
            if (!loops.length) return { text: "Usage: /loop [interval] <prompt>, e.g. /loop 5m check the deploy. It runs now and then every interval (10m if you don't say). /loop stop stops it." };
            return { text: ["Loops:", ...loops.map((j) => `  ${describeJob(j)}: ${clipPrompt(j.prompt, 60)}${j.paused ? " (paused)" : ""}`), "/loop stop stops them; /schedules pauses or deletes one."].join("\n") };
        }
        const parsed = parseLoopArgs(a);
        if ("error" in parsed) return { text: parsed.error, level: "error" };
        if (/^\/loop(\s|$)/i.test(parsed.prompt)) return { text: "A loop can't run /loop.", level: "error" };
        try {
            const job = this.scheduler.add({ kind: "loop", prompt: parsed.prompt, everyMs: parsed.everyMs, runNow: true });
            return { text: `Looping every ${intervalText(parsed.everyMs)}: ${clipPrompt(job.prompt, 60)}. It stops after 7 days, with /loop stop, or from /schedules.` };
        } catch (e) {
            return { text: (e as Error).message, level: "error" };
        }
    }

    /** /schedules with arguments: pause|resume|delete|run <id>, or clear. Undefined: no arguments (the caller shows the list). */
    manage(args: string): { text: string; level?: "info" | "warn" | "error" } | undefined {
        const a = args.trim();
        if (!a) return undefined;
        if (/^clear$/i.test(a)) {
            const n = this.scheduler.clear();
            return { text: n ? `Deleted ${n} schedule${n === 1 ? "" : "s"}.` : "No schedules." };
        }
        const m = a.match(/^(pause|resume|delete|remove|rm|run)\s+(\S+)$/i);
        if (!m) return { text: "Usage: /schedules [pause|resume|delete|run <id> | clear]", level: "error" };
        const [, verb, id] = m;
        const v = verb!.toLowerCase();
        const idle = this.o.idle();
        const j = this.act(id!, v === "remove" || v === "rm" ? "delete" : (v as ScheduleAction));
        if (!j) return { text: `No schedule ${id}.`, level: "error" };
        const what = `${describeJob(j)}: ${clipPrompt(j.prompt, 50)}`;
        return { text: v === "pause" ? `Paused ${what}` : v === "resume" ? `Resumed ${what}${j.nextAt ? `; next ${shortTime(j.nextAt)}` : ""}` : v === "run" ? `Running ${what}${idle ? "" : " once the current turn ends"}` : `Deleted ${what}` };
    }

    /** One schedule's pause, resume, run now or delete; undefined when there's no such schedule. */
    act(id: string, action: ScheduleAction): ScheduledJob | undefined {
        const s = this.scheduler;
        return action === "pause" || action === "resume" ? s.setPaused(id, action === "pause") : action === "run" ? s.runNow(id) : s.remove(id);
    }

    dispose() {
        this.scheduler.dispose();
    }
}
