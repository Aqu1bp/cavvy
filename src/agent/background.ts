// A harness session's background work as one list (#219 §2): what agent CLIs
// report (Claude Code's background sub-agents, shells and monitors), the tasks
// the session delegated to other models, and its own background shells and
// monitors. It's held per session, not per turn or per Agent: a task outlives
// the turn that started it, and the model it ran under.
//
// The list is kept in the session log ({t:"bgtask"} lines, src/agent/session.ts).
// None of these outlive the harness process, so a task the log has as running
// when the session is opened again stopped when Harness quit: it's shown as
// such, and the agent is told with the next prompt.

import type { BackgroundTaskInfo } from "../backends/live/info";
import { APP_TITLE } from "../config/paths";
import { parseModelRef } from "../providers/types";
import type { BackgroundShell } from "../tools/types";
import type { DelegatedTask } from "./delegation";

export type { BackgroundTaskInfo } from "../backends/live/info";

/** Where the list is kept: the session log. */
export interface BackgroundLog {
    /** The tasks as the log last had them, by id. */
    readonly backgroundTasks: ReadonlyMap<string, BackgroundTaskInfo>;
    recordBackgroundTask(task: BackgroundTaskInfo): void;
}

/** What else runs in the session's background, beside what its CLIs report. */
export interface BackgroundSources {
    delegated?: readonly DelegatedTask[];
    shells?: ReadonlyMap<string, BackgroundShell>;
}

/** Ended tasks the CLIs reported, kept for the list (the oldest go first past this). */
const ENDED_KEPT = 50;

export class SessionBackground {
    /** What agent CLIs reported, by id. */
    private reported = new Map<string, BackgroundTaskInfo>();
    /** Running when the session was last open: they stopped when Harness quit, and the agent hasn't been told yet. */
    private lost: BackgroundTaskInfo[] = [];
    private listeners = new Set<() => void>();

    constructor(
        private log?: BackgroundLog,
        private now: () => number = Date.now,
    ) {
        for (const t of log?.backgroundTasks.values() ?? []) if (t.status === "running") this.lost.push({ ...t, status: "stopped", lost: true, endedAt: t.endedAt ?? this.now() });
    }

    /** A task an agent CLI reported: new, or changed. */
    report(task: BackgroundTaskInfo): void {
        const was = this.reported.get(task.id);
        const next: BackgroundTaskInfo = { ...was, ...task };
        if (next.status !== "running") next.endedAt ??= this.now();
        if (was && JSON.stringify(was) === JSON.stringify(next)) return;
        this.reported.delete(task.id);
        this.reported.set(task.id, next);
        const ended = [...this.reported.values()].filter((t) => t.status !== "running");
        for (const t of ended.slice(0, Math.max(0, ended.length - ENDED_KEPT))) this.reported.delete(t.id);
        this.changed();
    }

    /** One a CLI reported, by id. */
    get(id: string): BackgroundTaskInfo | undefined {
        const t = this.reported.get(id);
        return t && { ...t };
    }

    /** Every task the session knows of now: what CLIs reported, then its delegated tasks and shells. Oldest first. */
    list(src: BackgroundSources = {}): BackgroundTaskInfo[] {
        const all = new Map<string, BackgroundTaskInfo>();
        for (const t of this.reported.values()) all.set(t.id, { ...t });
        for (const t of src.delegated ?? []) all.set(t.id, delegatedInfo(t));
        for (const s of src.shells?.values() ?? []) all.set(s.id, shellInfo(s));
        return [...all.values()].sort((a, b) => a.startedAt - b.startedAt);
    }

    /**
     * What the session's views show: the tasks running now, and (until the agent is told with the next
     * prompt) those that stopped when Harness quit.
     */
    shown(src: BackgroundSources = {}): BackgroundTaskInfo[] {
        const running = this.list(src).filter((t) => t.status === "running");
        const ids = new Set(running.map((t) => t.id));
        return [...this.lost.filter((t) => !ids.has(t.id)).map((t) => ({ ...t })), ...running];
    }

    /** Keep the list in the session log: a line for each task that started, or ended since it was written running. */
    persist(src: BackgroundSources = {}): void {
        if (!this.log) return;
        for (const t of this.list(src)) {
            const was = this.log.backgroundTasks.get(t.id);
            if (!was && t.status !== "running") continue;
            if (was && JSON.stringify(was) === JSON.stringify(t)) continue;
            this.log.recordBackgroundTask(t);
        }
    }

    /** Tasks that stopped when Harness quit that the agent hasn't been told of: told now, so the log has them stopped. */
    takeLost(): BackgroundTaskInfo[] {
        const lost = this.lost.splice(0);
        for (const t of lost) {
            // Not if a newer task has its id (ids start again with each harness process).
            const logged = this.log?.backgroundTasks.get(t.id);
            if (logged?.status === "running" && logged.startedAt === t.startedAt) this.log!.recordBackgroundTask(t);
        }
        if (lost.length) this.changed();
        return lost;
    }

    /** Called when a CLI reports a task, or the lost ones are told. Returns the unsubscribe. */
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => void this.listeners.delete(listener);
    }

    private changed() {
        for (const l of [...this.listeners]) l();
    }
}

/** A delegated task (Task in the background, or a backend's delegate call) as a background task. */
export function delegatedInfo(t: DelegatedTask): BackgroundTaskInfo {
    return {
        id: t.id,
        provider: parseModelRef(t.model)?.provider ?? t.model,
        kind: "agent",
        label: t.description,
        ...(t.callId ? { toolUseId: t.callId } : {}),
        startedAt: t.startedAt,
        status: t.status === "running" ? "running" : t.status === "done" ? "done" : t.status === "failed" ? "failed" : "stopped",
        ...(t.status !== "running" && t.result ? { endedAt: t.startedAt + t.result.durationMs } : {}),
        stoppable: true,
    };
}

/** A background shell or monitor of the harness's own as a background task. */
export function shellInfo(s: BackgroundShell): BackgroundTaskInfo {
    return {
        id: s.id,
        provider: "harness",
        kind: s.monitor ? "monitor" : "shell",
        label: (s.monitor?.description ?? s.command).trim().split("\n")[0]!.slice(0, 200),
        startedAt: s.startedAt,
        status: s.exitCode === null ? "running" : s.exitCode === 0 ? "done" : "failed",
        stoppable: true,
    };
}

/** "background sub-agent: Review the diff". */
export function describeTask(t: Pick<BackgroundTaskInfo, "kind" | "label">): string {
    const kind = t.kind === "agent" ? "background sub-agent" : t.kind === "shell" ? "background command" : t.kind === "monitor" ? "monitor" : t.kind === "workflow" ? "workflow" : "background task";
    return `${kind}: ${t.label}`;
}

/** For the agent, with the next prompt: what stopped when Harness quit (as a backend's stopped work is said, agent.ts recordBackendTurn). */
export function lostNote(tasks: readonly BackgroundTaskInfo[]): string {
    return `These background tasks stopped when ${APP_TITLE} quit: ${tasks.map((t) => `${describeTask(t)} (${t.id})`).join("; ")}. They are no longer running and will not produce further results. Restart them only if still needed; do not wait for their old task IDs.`;
}
