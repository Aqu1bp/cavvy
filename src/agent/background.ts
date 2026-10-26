// A Cavvy session's background work as one list (#219 §2): what agent CLIs
// report (Claude Code's background sub-agents, shells and monitors), the tasks
// the session delegated to other models, and its own background shells and
// monitors. It's held per session, not per turn or per Agent: a task outlives
// the turn that started it, and the model it ran under.
//
// The list is kept in the session log ({t:"bgtask"} lines, src/agent/session.ts).
// None of these outlive Cavvy process, so a task the log has as running
// when the session is opened again stopped when Cavvy quit: it's shown as
// such, and the agent is told with the next prompt.

import type { BackgroundStop } from "../backends/types";
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
/** Tasks that ended while the session was open, shown under the running ones until cleared (the oldest go first past this). */
const RECENT_KEPT = 20;

export class SessionBackground {
    /** What agent CLIs reported, by id. */
    private reported = new Map<string, BackgroundTaskInfo>();
    /** Running when the session was last open: they stopped when Cavvy quit, and the agent hasn't been told yet. */
    private lost: BackgroundTaskInfo[] = [];
    /** The user cleared the finished ones from the list (the lost ones too, though the agent is still told of those). */
    private lostCleared = false;
    /** Running as last looked at (sync), by id and start (taskKey): ids start again (a rebuilt Agent's task-1). */
    private live = new Map<string, BackgroundTaskInfo>();
    /** Ended since the session was opened, oldest first: listed until cleared. */
    private recent: BackgroundTaskInfo[] = [];
    /**
     * Stopped by the user, by id, with the start of the task they stopped (undefined until a look finds it): their
     * end is no news, and however it ended (a killed shell's exit code), they were stopped. A later task with
     * the same id (a rebuilt Agent's task-1) isn't theirs.
     */
    private byUser = new Map<string, number | undefined>();
    /** The user asked these to stop, and the answer hasn't come: an end meanwhile is held until it does. */
    private stopping = new Set<string>();
    /** Ends held while their stop was pending, by id. */
    private held = new Map<string, BackgroundTaskInfo>();
    /** The user's stop wasn't confirmed in time (by id, with the task's start): ending stopped, it was theirs; ending any other way, it's news. */
    private unconfirmed = new Map<string, number | undefined>();
    /** Ends a stop that didn't go through let go: news at the next look (sync). */
    private released: BackgroundTaskInfo[] = [];
    /** Shells running when this session was bound that another session started (one terminal runs on across /new and /resume): not this session's. */
    private foreign = new Set<string>();
    private listeners = new Set<() => void>();

    /**
     * `carried`: the shells running when the session is bound, where they outlive a session switch (the TUI's
     * /new and /resume). Those its log has are its own again, still running or not; the rest aren't its.
     */
    constructor(
        private log?: BackgroundLog,
        private now: () => number = Date.now,
        carried?: ReadonlyMap<string, BackgroundShell>,
    ) {
        const own = new Set<string>();
        for (const t of log?.backgroundTasks.values() ?? []) {
            const shell = carried?.get(t.id);
            if (shell && shell.startedAt === t.startedAt) own.add(shellKey(shell));
            else if (t.status === "running") this.lost.push({ ...t, status: "stopped", lost: true, endedAt: t.endedAt ?? this.now() });
        }
        for (const s of carried?.values() ?? []) if (s.exitCode === null && !own.has(shellKey(s))) this.foreign.add(shellKey(s));
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
        // Not one a call is waiting on: that's the turn's own work, as a foreground sub-agent is.
        for (const t of src.delegated ?? []) if (!t.foreground) all.set(t.id, delegatedInfo(t));
        for (const s of src.shells?.values() ?? []) if (!this.foreign.has(shellKey(s))) all.set(s.id, shellInfo(s));
        for (const t of all.values()) if (t.status === "failed" && this.stoppedBy(t)) all.set(t.id, { ...t, status: "stopped" });
        return [...all.values()].sort((a, b) => a.startedAt - b.startedAt);
    }

    /**
     * What the session's views show: the tasks running now; those that ended since the session was opened,
     * until the user clears them; and (until the agent is told with the next prompt, or they're cleared)
     * those that stopped when Cavvy quit.
     */
    shown(src: BackgroundSources = {}): BackgroundTaskInfo[] {
        const running = this.list(src).filter((t) => t.status === "running");
        const ids = new Set(running.map((t) => t.id));
        const lost = this.lostCleared ? [] : this.lost.filter((t) => !ids.has(t.id));
        const ended = this.recent.filter((t) => !ids.has(t.id));
        return [...lost, ...ended, ...running].map((t) => ({ ...t }));
    }

    /**
     * Look at the list now: keep it in the log, and note what ended since the last look. The tasks that ended
     * on their own (done, failed, or stopped by something other than the user's Stop), for a notice.
     */
    sync(src: BackgroundSources = {}): BackgroundTaskInfo[] {
        this.persist(src);
        const tasks = this.list(src);
        const all = new Map(tasks.map((t) => [t.id, t]));
        const byKey = new Map(tasks.map((t) => [taskKey(t), t]));
        // The user's stops answered before a look found the task: theirs is the one listed now.
        for (const [id, at] of this.byUser) if (at === undefined && all.has(id)) this.byUser.set(id, all.get(id)!.startedAt);
        for (const [id, at] of this.unconfirmed) if (at === undefined && all.has(id)) this.unconfirmed.set(id, all.get(id)!.startedAt);
        const news: BackgroundTaskInfo[] = [];
        // A copy: one a call now waits on is put back as it's looked at (a Map would come to it again).
        for (const [key, was] of [...this.live]) {
            const id = was.id;
            const now = byKey.get(key);
            if (now?.status === "running") continue;
            this.live.delete(key);
            // A delegated task a call now waits on: the turn's own work for now, listed again when the wait ends.
            if (!now && src.delegated?.some((d) => d.id === id && d.foreground && d.startedAt === was.startedAt)) {
                this.live.set(key, was);
                continue;
            }
            if (!now) {
                // Taken out of its list while running (the agent's KillShell removes the shell it stops; a rebuilt
                // Agent's delegated tasks go with the old one): it was stopped. Kept so in the log, or reopening
                // would say Cavvy's quitting stopped it.
                const ended: BackgroundTaskInfo = { ...was, status: "stopped", endedAt: this.now() };
                const logged = this.log?.backgroundTasks.get(id);
                if (logged?.status === "running" && logged.startedAt === was.startedAt) this.log!.recordBackgroundTask(ended);
                this.recent = [...this.recent.filter((t) => taskKey(t) !== key), ended].slice(-RECENT_KEPT);
                continue;
            }
            // A shell doesn't say when it ended: about now (it's looked at every few seconds while one runs).
            const ended = now.endedAt === undefined ? { ...now, endedAt: this.now() } : now;
            this.recent = [...this.recent.filter((t) => taskKey(t) !== key), ended].slice(-RECENT_KEPT);
            // Its stop not answered yet: whether this end is the user's depends on the answer.
            if (this.stopping.has(id)) this.held.set(id, ended);
            else if (this.unconfirmed.has(id) && matches(this.unconfirmed.get(id), ended)) {
                this.unconfirmed.delete(id);
                if (ended.status === "stopped") this.byUser.set(id, ended.startedAt);
                else news.push(ended);
            } else if (!this.stoppedBy(ended) && !ended.byUser) news.push(ended);
        }
        // One that ended and is now said to have ended otherwise (a sub-agent said to be done, then to have
        // failed): the list says so, and it's news again (the notice's tag has the outcome).
        this.recent = this.recent.map((t) => {
            const now = byKey.get(taskKey(t));
            if (!now || now.status === "running" || now.status === t.status) return t;
            const revised = { ...now, endedAt: now.endedAt ?? t.endedAt };
            // Its stop still pending: the answer decides whether this is news (held, as an end is), even if the end
            // it revises was told before the stop (a Stop from a list a moment old).
            if (this.stopping.has(t.id)) this.held.set(t.id, revised);
            else if (!this.stoppedBy(t) && !now.byUser) news.push(revised);
            return revised;
        });
        // An end held for a stop's answer follows the list itself, not the finished ones shown (Clear finished
        // may have taken it from those): a refused stop lets go the outcome it came to.
        for (const [id, h] of this.held) {
            const now = byKey.get(taskKey(h));
            if (now && now.status !== "running" && now.status !== h.status) this.held.set(id, { ...now, endedAt: now.endedAt ?? h.endedAt });
        }
        for (const t of tasks) if (t.status === "running") this.live.set(taskKey(t), t);
        return [...news, ...this.released.splice(0)];
    }

    /** The user's Stop is what ended this task (not another with its id). */
    private stoppedBy(t: Pick<BackgroundTaskInfo, "id" | "startedAt">): boolean {
        return this.byUser.has(t.id) && matches(this.byUser.get(t.id), t);
    }

    /** The running task with this id, as last looked at. */
    private running(id: string): BackgroundTaskInfo | undefined {
        return [...this.live.values()].findLast((t) => t.id === id);
    }

    /** The user stopped these, and it's certain to go through (a delegated task's abort, a shell's kill): when they end, it's no news. */
    stoppedByUser(ids: readonly string[]): void {
        for (const id of ids) {
            const t = this.running(id);
            if (t) this.byUser.set(id, t.startedAt);
        }
    }

    /**
     * The user's stop (the panel, /tasks stop): `stop` asks for it, and says how each went. Only those that
     * stopped count as the user's; one that couldn't be stopped, or whose stop was refused, ends as it ends
     * (news, as any other), and one whose stop wasn't confirmed in time is the user's only if it ends stopped.
     */
    async userStop(ids: readonly string[], stop: () => Promise<Record<string, BackgroundStop>>): Promise<Record<string, BackgroundStop>> {
        const asked = ids.filter((id) => !this.stopping.has(id));
        for (const id of asked) this.stopping.add(id);
        let results: Record<string, BackgroundStop> = {};
        try {
            results = await stop();
            return results;
        } finally {
            for (const id of asked) this.answered(id, results[id]);
            // What a stop that didn't go through let go is news now; one that did may now say stopped, not failed.
            this.changed();
        }
    }

    private answered(id: string, r: BackgroundStop | undefined) {
        this.stopping.delete(id);
        const held = this.held.get(id);
        this.held.delete(id);
        const startedAt = held?.startedAt ?? this.running(id)?.startedAt ?? this.reported.get(id)?.startedAt;
        if (r === "stopped" || (r === "timeout" && held?.status === "stopped")) {
            this.byUser.set(id, startedAt);
            // A killed shell's exit code said it failed: it was stopped.
            if (held?.status === "failed") this.recent = this.recent.map((t) => (t.id === id && t.startedAt === held.startedAt && t.status === "failed" ? { ...t, status: "stopped" } : t));
        } else if (r === "timeout" && !held) this.unconfirmed.set(id, startedAt);
        // Not stopped by it (refused, can't be, or it had ended on its own, "ended"): it ended as it ended, and that's news.
        else if (held) this.released.push(held);
    }

    /** The user cleared the finished tasks from the list. */
    clearEnded(): void {
        if (!this.recent.length && (this.lostCleared || !this.lost.length)) return;
        this.recent = [];
        this.lostCleared = true;
        this.changed();
    }

    /** Keep the list in the session log: a line for each task that started, or ended since it was written running. */
    persist(src: BackgroundSources = {}): void {
        if (!this.log) return;
        for (const t of this.list(src)) {
            const was = this.log.backgroundTasks.get(t.id);
            if (!was && t.status !== "running") continue;
            // Its stop not answered yet: how it ended is written once the answer says (a killed shell's exit code isn't a failure).
            if (this.stopping.has(t.id) && t.status !== "running") continue;
            if (was && JSON.stringify(was) === JSON.stringify(t)) continue;
            this.log.recordBackgroundTask(t);
        }
    }

    /** Tasks that stopped when Cavvy quit that the agent hasn't been told of: told now, so the log has them stopped. */
    takeLost(): BackgroundTaskInfo[] {
        const lost = this.lost.splice(0);
        for (const t of lost) {
            // Not if a newer task has its id (ids start again with each Cavvy process).
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

/** A task by its id and start: ids start again (a shell's with each Cavvy process, a delegated task's with each Agent). */
function taskKey(t: Pick<BackgroundTaskInfo, "id" | "startedAt">): string {
    return `${t.id}@${t.startedAt}`;
}

/** Whether a start noted for an id (undefined: not known yet, so any) is this task's. */
function matches(at: number | undefined, t: Pick<BackgroundTaskInfo, "startedAt">): boolean {
    return at === undefined || at === t.startedAt;
}

/** A shell by its id and start: ids start again with each Cavvy process. */
function shellKey(s: Pick<BackgroundShell, "id" | "startedAt">): string {
    return `${s.id}@${s.startedAt}`;
}

/**
 * Leaving the session while its shells run on (the TUI's /new and /resume): they're no longer followed here,
 * so its log has them stopped. Otherwise, reopened in another process after they ended, the session would say
 * Cavvy's quitting stopped them; opened again in this one while they run, they're its own again.
 */
export function leaveShells(log: BackgroundLog, shells: ReadonlyMap<string, BackgroundShell>, now = Date.now()): void {
    for (const s of shells.values()) {
        const t = log.backgroundTasks.get(s.id);
        if (s.exitCode === null && t?.status === "running" && t.startedAt === s.startedAt) log.recordBackgroundTask({ ...t, status: "stopped", endedAt: now });
    }
}

/**
 * Leaving the session (the TUI's /new and /resume) with an Agent that's replaced: the delegated tasks it runs stop
 * with it, after the log is left. Its log has them stopped now, or reopening would say Cavvy's quitting stopped them.
 */
export function leaveDelegated(log: BackgroundLog, tasks: readonly DelegatedTask[], now = Date.now()): void {
    for (const d of tasks) {
        const t = log.backgroundTasks.get(d.id);
        if (d.status === "running" && t?.status === "running" && t.startedAt === d.startedAt) log.recordBackgroundTask({ ...t, status: "stopped", endedAt: now });
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

/** A background shell or monitor of Cavvy's own as a background task. */
export function shellInfo(s: BackgroundShell): BackgroundTaskInfo {
    return {
        id: s.id,
        provider: "cavvy",
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

/** One line for a notice that a task ended: "Background sub-agent finished: Map auth (2m 5s)". */
export function endedText(t: BackgroundTaskInfo): string {
    const what = describeTask(t);
    const [kind, ...rest] = what.split(": ");
    const how = t.status === "done" ? "finished" : t.status === "failed" ? "failed" : t.withProcess ? "stopped with its process" : t.lost ? `stopped when ${APP_TITLE} quit` : "was stopped";
    const ms = (t.endedAt ?? t.startedAt) - t.startedAt;
    return `${kind![0]!.toUpperCase()}${kind!.slice(1)} ${how}: ${rest.join(": ")}${ms > 0 ? ` (${span(ms)})` : ""}`;
}

/** "45s", "2m 5s", "1h 3m". */
function span(ms: number): string {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** For the agent, with the next prompt: what stopped when Cavvy quit (as a backend's stopped work is said, agent.ts recordBackendTurn). */
export function lostNote(tasks: readonly BackgroundTaskInfo[]): string {
    return `These background tasks stopped when ${APP_TITLE} quit: ${tasks.map((t) => `${describeTask(t)} (${t.id})`).join("; ")}. They are no longer running and will not produce further results. Restart them only if still needed; do not wait for their old task IDs.`;
}
