// A live session's background tasks: what its CLI reports of them, stop
// requests and whether they took, and what's left when the process goes away.
// Held per session, not per turn: a task outlives the turn that started it.

import type { BackgroundTaskInfo } from "./info";
import type { LiveClock } from "./types";

/**
 * How a stop went (as BackgroundStop): the stop ended the task (`stopped`), it had ended on its own (`ended`:
 * before the stop, or while it was asked and not taken), the CLI didn't say so in time (`timeout`: offer a
 * restart), the request failed, the task can't be stopped on its own, or there's no such task.
 */
export type StopResult = "stopped" | "timeout" | "failed" | "not_stoppable" | "unknown" | "ended";

interface PendingStop {
    promise: Promise<StopResult>;
    settle(r: StopResult): void;
    /** The CLI took the stop. */
    answered?: boolean;
    /** How the task ended, said before the CLI answered the stop (other than stopped): it counts if the stop doesn't go through. */
    held?: BackgroundTaskInfo["status"];
}

export class BackgroundTasks {
    private tasks = new Map<string, BackgroundTaskInfo>();
    private stops = new Map<string, PendingStop>();
    private listeners = new Set<() => void>();

    constructor(
        private clock: LiveClock,
        /** How long a stop may take to be confirmed. */
        private confirmMs: number,
    ) {}

    /**
     * A task the CLI reported: new, or changed. One that isn't running any more settles a stop asked of it.
     * One that ended and runs again (an id reused) is a new occurrence: nothing of the last one's end stays.
     */
    report(task: BackgroundTaskInfo): void {
        const was = this.tasks.get(task.id);
        const next = was && !(was.status !== "running" && task.status === "running") ? { ...was, ...task } : { ...task };
        if (next.status !== "running") next.endedAt ??= this.clock.now();
        this.tasks.set(task.id, next);
        const stop = this.stops.get(task.id);
        // Ended stopped: the stop took. Ended otherwise (done, failed) while it was asked: held until the CLI
        // answers the stop (#282): it took, or the task ended by itself and that's how it ended.
        if (stop && next.status !== "running" && (next.status === "stopped" || stop.answered)) stop.settle("stopped");
        else if (stop && next.status !== "running") stop.held = next.status;
        this.changed();
    }

    /** A task ended, by what the harness knows (the CLI said so in other words). */
    end(id: string, status: Exclude<BackgroundTaskInfo["status"], "running">): void {
        const t = this.tasks.get(id);
        if (t && t.status === "running") this.report({ ...t, status });
    }

    /**
     * Stop a task: `send` asks the CLI (none: the CLI can't stop one task). It counts as stopped
     * once the CLI reports the task not running (report()), or its process goes away (lose()). An end
     * other than stopped, said before the CLI answers the stop, is held: the stop refused, the task ended
     * by itself (`ended`, and that end stands); taken, it's stopped.
     */
    stop(id: string, send: (() => Promise<void>) | undefined): Promise<StopResult> {
        const t = this.tasks.get(id);
        if (!t) return Promise.resolve("unknown");
        if (t.status !== "running") return Promise.resolve("ended");
        if (!t.stoppable || !send) return Promise.resolve("not_stoppable");
        const pending = this.stops.get(id);
        if (pending) return pending.promise;
        let settle!: (r: StopResult) => void;
        let entry!: PendingStop;
        const promise = new Promise<StopResult>((resolve) => {
            // Unanswered in time: an end held meanwhile is how it ended (by itself); without one, a timeout.
            const timer = this.clock.setTimeout(() => settle(entry.held !== undefined && entry.held !== "stopped" ? "ended" : "timeout"), this.confirmMs);
            settle = (r) => {
                if (this.stops.get(id)?.promise !== promise) return;
                this.clock.clearTimeout(timer);
                this.stops.delete(id);
                resolve(r);
                this.changed();
            };
        });
        entry = { promise, settle };
        this.stops.set(id, entry);
        Promise.resolve()
            .then(send)
            .then(
                // It took: over once the CLI says the task ended (now, if it said so meanwhile).
                () => {
                    entry.answered = true;
                    if (entry.held !== undefined) settle("stopped");
                },
                // Refused: with an end held, it had ended by itself (that's why); else the stop failed.
                () => settle(entry.held !== undefined && entry.held !== "stopped" ? "ended" : "failed"),
            );
        return promise;
    }

    /** The process went away: whatever was running went with it (withProcess; `lost` is for Harness quitting, restore()). */
    lose(): void {
        const now = this.clock.now();
        let any = false;
        for (const t of this.tasks.values()) {
            if (t.status !== "running") continue;
            this.tasks.set(t.id, { ...t, status: "stopped", endedAt: now, withProcess: true });
            any = true;
        }
        // Unanswered stops: the process took the task with it, unless it had said it ended by itself first.
        for (const s of [...this.stops.values()]) s.settle(s.held === undefined || s.held === "stopped" ? "stopped" : "ended");
        if (any) this.changed();
    }

    get(id: string): BackgroundTaskInfo | undefined {
        const t = this.tasks.get(id);
        return t && { ...t };
    }

    running(): BackgroundTaskInfo[] {
        return this.snapshot().filter((t) => t.status === "running");
    }

    /** Every task, oldest first, as plain data (for the session log and the protocol). */
    snapshot(): BackgroundTaskInfo[] {
        return [...this.tasks.values()].map((t) => ({ ...t })).sort((a, b) => a.startedAt - b.startedAt);
    }

    /** Tasks from a snapshot (a session reopened): none of their processes is running now, so the running ones are lost. */
    restore(tasks: readonly BackgroundTaskInfo[]): void {
        for (const t of tasks) this.tasks.set(t.id, t.status === "running" ? { ...t, status: "stopped", endedAt: t.endedAt ?? this.clock.now(), lost: true } : { ...t });
        this.changed();
    }

    /** Called when a task starts, changes or ends, or a stop settles. Returns the unsubscribe. */
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    }

    private changed() {
        for (const l of [...this.listeners]) l();
    }
}
