// Which sessions have a turn running, kept on disk by a Cavvy that others reach (a server's: src/servers/host.ts), so
// that after it stops and starts again (an update, a reboot, a crash) those sessions carry on by themselves
// (Engine.resumeWorking). A session is in it from its turn's start to its end; a Cavvy that's stopping leaves it as
// it is, so what was cut off is still there to read. Stopping a server on purpose (`cavvy servers stop`) removes
// the file: what was stopped on purpose stays stopped.
//
// Beside the list, when each session was last carried on by itself, for a while: how often that may happen is capped.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname } from "path";

export interface WorkingEntry {
    cwd: string;
}

/** Carried on by itself at most this many times within RESUME_WINDOW_MS. */
export const MAX_RESTART_RESUMES = 3;
export const RESUME_WINDOW_MS = 3_600_000;

const SESSION_ID = /^[\w.-]{1,120}$/;

export class WorkingIndex {
    private sessions = new Map<string, WorkingEntry>();
    /**
     * When Cavvy carried each session on by itself after a restart, lately. Kept apart from the list: a turn's end
     * takes a session off the list, and a session that keeps bringing Cavvy down between turns still counts.
     */
    private carried = new Map<string, number[]>();

    constructor(
        private file: string,
        private now: () => number = Date.now,
    ) {
        try {
            const v = JSON.parse(readFileSync(file, "utf-8")) as { sessions?: Record<string, unknown>; carried?: Record<string, unknown> };
            for (const [id, e] of Object.entries(v.sessions ?? {})) {
                const x = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
                if (!SESSION_ID.test(id) || typeof x.cwd !== "string" || !x.cwd) continue;
                this.sessions.set(id, { cwd: x.cwd });
            }
            for (const [id, at] of Object.entries(v.carried ?? {})) {
                if (!SESSION_ID.test(id) || !Array.isArray(at)) continue;
                const times = this.recent(at.filter((t): t is number => typeof t === "number" && Number.isFinite(t)));
                if (times.length) this.carried.set(id, times);
            }
        } catch {
            // none kept, or not readable: nothing to carry on
        }
    }

    private recent(times: number[]): number[] {
        const now = this.now();
        return times.filter((t) => now - t < RESUME_WINDOW_MS).slice(-MAX_RESTART_RESUMES);
    }

    /** What was working when this was read (when the Cavvy before this one stopped). */
    entries(): [string, WorkingEntry][] {
        return [...this.sessions];
    }

    started(id: string, cwd: string) {
        if (this.sessions.get(id)?.cwd === cwd) return;
        this.sessions.set(id, { cwd });
        this.save();
    }

    ended(id: string) {
        if (this.sessions.delete(id)) this.save();
    }

    /**
     * Notes one more carrying-on by itself: "go". "capped" when it has had its share for now: it's taken off the
     * list, and left alone. "gone" when it isn't on the list any more (its turn ended since the list was read).
     */
    resume(id: string): "go" | "capped" | "gone" {
        if (!this.sessions.has(id)) return "gone";
        const times = this.recent(this.carried.get(id) ?? []);
        if (times.length >= MAX_RESTART_RESUMES) {
            this.carried.set(id, times);
            this.ended(id);
            return "capped";
        }
        this.carried.set(id, [...times, this.now()]);
        this.save();
        return "go";
    }

    /** Best effort: a list that can't be written means sessions that don't carry on, as before there was one. */
    private save() {
        try {
            for (const [id, at] of this.carried) {
                const times = this.recent(at);
                if (times.length) this.carried.set(id, times);
                else this.carried.delete(id);
            }
            if (!this.sessions.size && !this.carried.size) return rmSync(this.file, { force: true });
            mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
            const tmp = `${this.file}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify({ v: 1, sessions: Object.fromEntries(this.sessions), carried: Object.fromEntries(this.carried) }) + "\n", { mode: 0o600 });
            renameSync(tmp, this.file);
        } catch {
            // see above
        }
    }
}
