// Claude Code's /goal, as its session transcript records it. In -p mode Claude Code reports
// its goal as it goes (active_goal) only in its own remote sessions (CLAUDE_CODE_REMOTE, checked
// with 2.1.305), so the harness reads the goal_status entries Claude Code writes to the
// transcript instead, the ones its own --resume restores the goal from:
//   set        { sentinel: true, met: false, condition }
//   not met    { met: false, condition, reason }
//   met        { met: true, condition, reason, iterations, durationMs, tokens }
//   impossible { met: false, failed: true, condition, reason, iterations, ... }
//   cleared    { sentinel: true, met: true, condition }
// Read-only, like src/server/cli-sessions.ts: the file is only ever opened for reading.

import { closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import type { NativeGoal } from "../agent/goal";
import { redact } from "../util/redact";

/** At most this much of a transcript is read when it's first found (a long resumed session): its newest part. */
const FIRST_READ = 16 * 1024 * 1024;

/** How far each transcript has been read, and where its goal stood there: the next turn goes on from it. */
const readSoFar = new Map<string, { offset: number; goal: NativeGoal | null }>();

/** <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<folder>/<session>.jsonl, if it's there yet. */
export function claudeTranscriptFile(configDir: string | undefined, cwd: string, sessionId: string): string | undefined {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return undefined;
    const projects = join(configDir ? resolve(configDir) : join(homedir(), ".claude"), "projects");
    const names = new Set([folderName(resolve(cwd))]);
    try {
        names.add(folderName(realpathSync(cwd)));
    } catch {
        // gone: its given path only
    }
    let all: string[];
    try {
        all = readdirSync(projects);
    } catch {
        return undefined;
    }
    for (const dir of all) {
        // Cut to 200 characters plus a hash when longer.
        if (![...names].some((n) => dir === n || (n.length > 200 && dir.startsWith(n.slice(0, 200))))) continue;
        const file = join(projects, dir, `${sessionId}.jsonl`);
        try {
            const fd = openSync(file, "r");
            closeSync(fd);
            return file;
        } catch {
            // not in this one
        }
    }
    return undefined;
}

const folderName = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

/**
 * Follows one turn's transcript. What was there before the turn began (a resumed session's) is where the goal
 * stood, reported once if it's still set (Claude Code carries it on); what's written since is reported as it comes.
 */
export class ClaudeGoalWatch {
    private file?: string;
    private offset = 0;
    private rest = "";
    private goal: NativeGoal | null = null;
    /** What was before the turn changed the goal, and hasn't been reported yet. */
    private unreported = false;

    constructor(
        private locate: () => string | undefined,
        /** When the turn began, ms: entries older than this are where it stood. */
        private since: number,
        private report: (g: NativeGoal | null) => void,
    ) {}

    /** Whether the transcript has been found (until it is, Claude Code's own active_goal reports are used). */
    get found(): boolean {
        return this.file !== undefined;
    }

    poll() {
        if (!this.file) {
            this.file = this.locate();
            if (!this.file) return;
            // Read before (an earlier turn): on from there, with where the goal stood then.
            const known = readSoFar.get(this.file);
            if (known) {
                this.offset = known.offset;
                this.goal = known.goal;
                this.unreported = Boolean(known.goal);
            }
        }
        let fd: number;
        try {
            fd = openSync(this.file, "r");
        } catch {
            return;
        }
        try {
            const size = fstatSync(fd).size;
            if (size < this.offset) {
                // Rewritten: read again from the start.
                this.offset = 0;
                this.rest = "";
                this.goal = null;
            }
            if (this.offset === 0 && size > FIRST_READ) this.offset = size - FIRST_READ;
            if (size === this.offset) return this.flush();
            const buf = Buffer.alloc(size - this.offset);
            let read = 0;
            while (read < buf.length) {
                const n = readSync(fd, buf, read, buf.length - read, this.offset + read);
                if (n <= 0) break;
                read += n;
            }
            this.offset += read;
            const lines = (this.rest + buf.subarray(0, read).toString("utf8")).split("\n");
            this.rest = lines.pop() ?? "";
            for (const line of lines) if (line.includes('"goal_status"')) this.entry(line);
            this.flush();
            readSoFar.set(this.file, { offset: this.offset - Buffer.byteLength(this.rest), goal: this.goal });
        } finally {
            closeSync(fd);
        }
    }

    private entry(line: string) {
        let e: any;
        try {
            e = JSON.parse(line);
        } catch {
            return;
        }
        const a = e?.type === "attachment" ? e.attachment : undefined;
        if (a?.type !== "goal_status" || typeof a.condition !== "string" || !a.condition.trim()) return;
        const at = Date.parse(e.timestamp);
        const live = !(at < this.since);
        if (live) this.flush();
        const reason = typeof a.reason === "string" && a.reason.trim() ? redact(a.reason) : undefined;
        const turns = typeof a.iterations === "number" ? a.iterations : undefined;
        const same = this.goal?.condition === a.condition ? this.goal : undefined;
        const base = { provider: "claude-code" as const, condition: a.condition, since: same?.since ?? (Number.isFinite(at) ? at : Date.now()) };
        let next: NativeGoal | null;
        if (a.sentinel) next = a.met ? null : { ...base, status: "active", turns: 0 };
        else if (a.failed) next = { ...base, status: "failed", turns: turns ?? (same?.turns ?? 0) + 1, ...(reason ? { lastReason: reason } : {}) };
        else if (a.met) next = { ...base, status: "complete", turns: turns ?? (same?.turns ?? 0) + 1, ...(reason ? { lastReason: reason } : {}) };
        else next = { ...base, status: "active", turns: (same?.turns ?? 0) + 1, ...(reason ? { lastReason: reason } : {}) };
        if (live) this.report(next);
        else this.unreported = true;
        // Met or judged impossible: Claude Code has dropped it.
        this.goal = next && (next.status === "complete" || next.status === "failed") ? null : next;
    }

    /** Where the goal stood before the turn, once: only a goal still set is news. */
    private flush() {
        if (!this.unreported) return;
        this.unreported = false;
        if (this.goal) this.report(this.goal);
    }
}
