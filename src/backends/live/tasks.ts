// A live session's background tasks: what its CLI reports of them, stop
// requests and whether they took, and what's left when the process goes away.
// Held per session, not per turn: a task outlives the turn that started it.

import type { BackgroundTaskInfo } from "./info";
import type { LiveClock } from "./types";

/**
 * How a stop went: the task is no longer running (`stopped`, whatever its end), the CLI
 * didn't say so in time (`timeout`: offer a restart), the request failed, the task can't
 * be stopped on its own, or there's no such task.
 */
export type StopResult = "stopped" | "timeout" | "failed" | "not_stoppable" | "unknown";

export class BackgroundTasks {
    private tasks = new Map<string, BackgroundTaskInfo>();
    private stops = new Map<string, { promise: Promise<StopResult>; settle(r: StopResult): void }>();
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
        if (next.status !== "running") this.stops.get(task.id)?.settle("stopped");
        this.changed();
    }

    /** A task ended, by what the harness knows (the CLI said so in other words). */
    end(id: string, status: Exclude<BackgroundTaskInfo["status"], "running">): void {
        const t = this.tasks.get(id);
        if (t && t.status === "running") this.report({ ...t, status });
    }

    /**
     * Stop a task: `send` asks the CLI (none: the CLI can't stop one task). It counts as stopped
     * once the CLI reports the task not running (report()), or its process goes away (lose()).
     */
    stop(id: string, send: (() => Promise<void>) | undefined): Promise<StopResult> {
        const t = this.tasks.get(id);
        if (!t) return Promise.resolve("unknown");
        if (t.status !== "running") return Promise.resolve("stopped");
        if (!t.stoppable || !send) return Promise.resolve("not_stoppable");
        const pending = this.stops.get(id);
        if (pending) return pending.promise;
        let settle!: (r: StopResult) => void;
        const promise = new Promise<StopResult>((resolve) => {
            const timer = this.clock.setTimeout(() => settle("timeout"), this.confirmMs);
            settle = (r) => {
                if (this.stops.get(id)?.promise !== promise) return;
                this.clock.clearTimeout(timer);
                this.stops.delete(id);
                resolve(r);
                this.changed();
            };
        });
        this.stops.set(id, { promise, settle });
        Promise.resolve().then(send).catch(() => settle("failed"));
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
        for (const s of [...this.stops.values()]) s.settle("stopped");
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
