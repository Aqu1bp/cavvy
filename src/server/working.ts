// Which sessions have a turn running, kept on disk by a Cavvy that others reach (a server's: src/servers/host.ts), so
// that after it stops and starts again (an update, a reboot, a crash) those sessions carry on by themselves
// (Engine.resumeWorking). A session is in it from its turn's start to its end; a Cavvy that's stopping leaves it as
// it is, so what was cut off is still there to read. Stopping a server on purpose (`cavvy servers stop`) removes
// the file: what was stopped on purpose stays stopped.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname } from "path";

export interface WorkingEntry {
    cwd: string;
    /** When Cavvy carried it on by itself after a restart: too many in an hour and it's left alone (a session that keeps bringing Cavvy down). */
    resumed?: number[];
}

/** Carried on by itself at most this many times within RESUME_WINDOW_MS. */
export const MAX_RESTART_RESUMES = 3;
export const RESUME_WINDOW_MS = 3_600_000;

export class WorkingIndex {
    private sessions = new Map<string, WorkingEntry>();

    constructor(private file: string) {
        try {
            const v = JSON.parse(readFileSync(file, "utf-8")) as { sessions?: Record<string, unknown> };
            for (const [id, e] of Object.entries(v.sessions ?? {})) {
                const x = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
                if (!/^[\w.-]{1,120}$/.test(id) || typeof x.cwd !== "string" || !x.cwd) continue;
                const resumed = Array.isArray(x.resumed) ? x.resumed.filter((t): t is number => typeof t === "number" && Number.isFinite(t)).slice(-MAX_RESTART_RESUMES) : [];
                this.sessions.set(id, { cwd: x.cwd, ...(resumed.length ? { resumed } : {}) });
            }
        } catch {
            // none kept, or not readable: nothing to carry on
        }
    }

    /** What was working when this was read (when the Cavvy before this one stopped). */
    entries(): [string, WorkingEntry][] {
        return [...this.sessions];
    }

    started(id: string, cwd: string) {
        const had = this.sessions.get(id);
        if (had?.cwd === cwd) return;
        this.sessions.set(id, { ...had, cwd });
        this.save();
    }

    ended(id: string) {
        if (this.sessions.delete(id)) this.save();
    }

    /** Notes one more carrying-on by itself. False when it has had its share for now: it's taken out, and left alone. */
    resume(id: string, now = Date.now()): boolean {
        const e = this.sessions.get(id);
        if (!e) return false;
        const recent = (e.resumed ?? []).filter((t) => now - t < RESUME_WINDOW_MS);
        if (recent.length >= MAX_RESTART_RESUMES) {
            this.ended(id);
            return false;
        }
        e.resumed = [...recent, now];
        this.save();
        return true;
    }

    /** Best effort: a list that can't be written means sessions that don't carry on, as before there was one. */
    private save() {
        try {
            if (!this.sessions.size) return rmSync(this.file, { force: true });
            mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
            const tmp = `${this.file}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify({ v: 1, sessions: Object.fromEntries(this.sessions) }) + "\n", { mode: 0o600 });
            renameSync(tmp, this.file);
        } catch {
            // see above
        }
    }
}
