// The session's background work, as the side panel's Agents and Commands tabs
// show it: every task running in the background (an agent CLI's sub-agents,
// shells and monitors; tasks delegated to other models; Cavvy's own
// background shells and monitors), then those that finished since the session
// was opened (until cleared) and those that stopped when Cavvy quit. A server
// older than SessionState.backgroundTasks sends only its shells: the list is
// made from those. The Agents tab lists them with the session's sub-agents,
// each agent once (agentRows). And where the news of one ending goes: a toast,
// or a desktop notification.

import type { AgentRun, BackgroundStopResult, BackgroundTaskInfo, SessionState } from "@shared/protocol";
import { agentProvider } from "./agent-marks";

type Shell = SessionState["shells"][number];

/** What the panel lists, as the server keeps it: running tasks, and finished ones until they're cleared. */
export function backgroundOf(state: Pick<SessionState, "backgroundTasks" | "shells"> | undefined): BackgroundTaskInfo[] {
    if (!state) return [];
    if (state.backgroundTasks) return state.backgroundTasks;
    return state.shells
        .filter((s) => s.running)
        .map((s) => ({ id: s.id, provider: "cavvy", kind: s.monitor ? "monitor" : "shell", label: s.monitor?.description ?? s.command, startedAt: s.startedAt, status: "running", stoppable: true }));
}

/** The server calls a stop needs: the RPCs it uses, as Rpc.call has them (a test passes its own). */
type StopCall = {
    (method: "session.stopBackground", params: { id: string; ids?: string[] }): Promise<{ results: Record<string, BackgroundStopResult> }>;
    (method: "session.killShell", params: { id: string; shellId: string }): Promise<null>;
};

/**
 * Stop these tasks, or every running one, and how each went. A server without SessionState.backgroundTasks
 * has no session.stopBackground: its rows are its shells, stopped one by one with session.killShell.
 */
export async function stopTasks(call: StopCall, sessionId: string, state: Pick<SessionState, "backgroundTasks" | "shells"> | undefined, ids?: string[]): Promise<Record<string, BackgroundStopResult>> {
    if (state?.backgroundTasks || !state) return (await call("session.stopBackground", { id: sessionId, ids })).results;
    const shellIds = ids ?? backgroundOf(state).filter((t) => t.status === "running").map((t) => t.id);
    const out: Record<string, BackgroundStopResult> = {};
    await Promise.all(
        shellIds.map(async (shellId) => {
            out[shellId] = await call("session.killShell", { id: sessionId, shellId }).then(
                () => "stopped" as const,
                () => "failed" as const,
            );
        }),
    );
    return out;
}

/** The finished ones, most recent first. */
export function finishedOf(tasks: readonly BackgroundTaskInfo[]): BackgroundTaskInfo[] {
    return tasks.filter((t) => t.status !== "running").sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
}

/** The kind, as a word for the row and its tooltip. */
export function kindName(t: Pick<BackgroundTaskInfo, "kind">): string {
    return t.kind === "agent" ? "Sub-agent" : t.kind === "shell" ? "Shell" : t.kind === "monitor" ? "Monitor" : t.kind === "workflow" ? "Workflow" : "Task";
}

/** Who runs it: the agent CLI's name, the delegated model's provider, or Cavvy. */
export function runnerName(t: Pick<BackgroundTaskInfo, "provider">, providers: readonly { id: string; name: string }[]): string {
    if (t.provider === "cavvy") return "Cavvy";
    return providers.find((p) => p.id === t.provider)?.name ?? t.provider;
}

/** "45s left", "12m left": a monitor's, at a glance. */
function timeLeft(ms: number): string {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return s < 60 ? `${s}s left` : `${Math.ceil(s / 60)}m left`;
}

/** The row's right-hand text: how long it's run (a monitor's time left), or how it ended and after how long. `runner`: who ran it (runnerName). */
export function taskMeta(t: BackgroundTaskInfo, shells: readonly Shell[], at: number, duration: (ms: number) => string, runner = "its process"): string {
    if (t.lost) return "Stopped when Cavvy quit";
    if (t.withProcess && t.status === "stopped") return `Stopped with ${runner}`;
    if (t.status !== "running") return `${t.status === "done" ? "Done" : t.status === "failed" ? "Failed" : "Stopped"} · ${duration(Math.max(0, (t.endedAt ?? t.startedAt) - t.startedAt))}`;
    const monitor = t.kind === "monitor" ? shells.find((s) => s.id === t.id)?.monitor : undefined;
    if (monitor) return timeLeft(monitor.expiresAt - at);
    return duration(Math.max(0, at - t.startedAt));
}

/** What a stop request came to, for a toast: how many stopped, and what couldn't be. */
export function stopOutcome(results: Record<string, BackgroundStopResult>): { message: string; level: "success" | "warn" | "info" } {
    const all = Object.values(results);
    const ok = all.filter((r) => r === "stopped").length;
    const pending = all.filter((r) => r === "timeout").length;
    // Ended on its own before the stop could (the list was a moment old): it keeps its own outcome.
    const ended = all.filter((r) => r === "ended").length;
    const refused = all.length - ok - pending - ended;
    if (!all.length) return { message: "Nothing was running", level: "info" };
    const parts = [ok ? `Stopped ${ok} task${ok === 1 ? "" : "s"}` : "", ended ? `${ended} had already ended` : "", pending ? `${pending} didn't confirm yet` : "", refused ? `${refused} couldn't be stopped on ${refused === 1 ? "its" : "their"} own` : ""].filter(Boolean);
    return { message: parts.join("; "), level: pending || refused ? "warn" : ok ? "success" : "info" };
}

/**
 * Where the news that a background task ended goes. In view (the window focused on its session): a toast
 * there. Otherwise a desktop notification, if they're on, as for a turn's other notices; each task's once.
 */
export function noticeRoute(o: { focused: boolean; active: boolean; notifications: boolean; seen: boolean }): "toast" | "desktop" | "none" {
    if (o.seen) return "none";
    if (o.focused && o.active) return "toast";
    return o.notifications ? "desktop" : "none";
}

/** How long a session's task endings are gathered into one desktop notification. */
export const COALESCE_MS = 800;

/**
 * Task endings close together as one notification's text. The desktop app's notifications can't replace one
 * another on macOS (tauri-plugin-notification ignores the id there), so several at once would pile up.
 */
export function combineEnded(bodies: readonly string[]): string {
    if (bodies.length <= 1) return bodies[0] ?? "";
    const shown = bodies.slice(0, 3);
    return [`${bodies.length} background tasks ended:`, ...shown, ...(bodies.length > shown.length ? [`and ${bodies.length - shown.length} more`] : [])].join("\n");
}

// ---------------------------------------------------------------------------
// The side panel's Agents and Commands tabs: the background tasks and the session's sub-agents (AgentRun) as one
// list of rows, each sub-agent once. A background sub-agent's task and its run are the same agent: an agent CLI's
// task names the call that launched it (toolUseId), and that call's id is the run's (Claude Code's Task call, Codex's
// spawn, Cavvy's delegate call). A delegated task is also its run's taskId.

/** The tabs background work is listed in: sub-agents (and tasks given to other models), and commands. */
export type WorkTab = "agents" | "commands";

/** A shell or monitor is a command; a sub-agent, a workflow or another task is an agent's. */
export const tabOf = (t: Pick<BackgroundTaskInfo, "kind">): WorkTab => (t.kind === "shell" || t.kind === "monitor" ? "commands" : "agents");

/** A row: a sub-agent (its run, and the background tasks that are it), or a background task of its own. */
export interface WorkRow {
    /** Unique among the rows: the run's id, else the task's. */
    key: string;
    kind: BackgroundTaskInfo["kind"];
    label: string;
    /** The run's while it runs or waits; running while any of its tasks does; else how it ended. */
    status: AgentRun["status"];
    startedAt: number;
    endedAt?: number;
    /** The sub-agent's run, which a click opens. */
    agent?: AgentRun;
    /** The background tasks it is: one, or none (a sub-agent of the turn's own); a Codex spawn can start more than one thread. */
    tasks: BackgroundTaskInfo[];
    /** The row it sits under: the sub-agent whose call started it. */
    parent?: string;
}

const runLive = (s: AgentRun["status"]) => s === "running" || s === "waiting";
export const rowLive = (r: Pick<WorkRow, "status">) => runLive(r.status);

function taskRow(t: BackgroundTaskInfo): WorkRow {
    return { key: `task:${t.id}`, kind: t.kind, label: t.label, status: t.status, startedAt: t.startedAt, ...(t.endedAt !== undefined ? { endedAt: t.endedAt } : {}), tasks: [t] };
}

/**
 * The Agents tab's rows: every sub-agent once, with the background tasks that are it, then the agent tasks that
 * have no run (a CLI's sub-agent it listed without a call here, one delegated without a call). A task whose
 * launching call isn't known yet (Claude Code can list one before it ties it to its call) goes with the one
 * running sub-agent of its label that has no task, when exactly one has it.
 */
export function agentRows(tasks: readonly BackgroundTaskInfo[], agents: readonly AgentRun[]): WorkRow[] {
    const byId = new Map(agents.map((a) => [a.id, a]));
    // A delegated task's id is used again once the session's Agent is made anew (task-1, …): a run has the task
    // only if it started before the run ended. Of those, the latest run.
    const byTask = (t: BackgroundTaskInfo) => agents.filter((a) => a.taskId === t.id && (a.endedAt === undefined || t.startedAt <= a.endedAt)).at(-1);
    const of = new Map<string, BackgroundTaskInfo[]>();
    const loose: BackgroundTaskInfo[] = [];
    for (const t of tasks) {
        if (tabOf(t) !== "agents") continue;
        const a = (t.toolUseId !== undefined ? byId.get(t.toolUseId) : undefined) ?? byTask(t);
        if (a) of.set(a.id, [...(of.get(a.id) ?? []), t]);
        else loose.push(t);
    }
    const unmatched: BackgroundTaskInfo[] = [];
    for (const t of loose) {
        const guess = t.toolUseId === undefined && t.status === "running" ? agents.filter((a) => runLive(a.status) && !of.has(a.id) && a.description === t.label) : [];
        const rivals = loose.filter((x) => x.toolUseId === undefined && x.status === "running" && x.label === t.label);
        if (guess.length === 1 && rivals.length === 1) of.set(guess[0]!.id, [t]);
        else unmatched.push(t);
    }
    const rows = agents.map((a): WorkRow => {
        const own = of.get(a.id) ?? [];
        const running = own.some((t) => t.status === "running");
        const status = runLive(a.status) ? a.status : running ? "running" : a.status;
        const endedAt = runLive(status) ? undefined : (a.endedAt ?? own.find((t) => t.endedAt !== undefined)?.endedAt);
        // A workflow (or another kind of task) that has a run stays that kind.
        const kind = own.find((t) => t.kind !== "agent")?.kind ?? "agent";
        return { key: a.id, kind, label: a.description || own[0]?.label || "Sub-agent", status, startedAt: a.startedAt, ...(endedAt !== undefined ? { endedAt } : {}), agent: a, tasks: own, ...(a.parentId && byId.has(a.parentId) ? { parent: a.parentId } : {}) };
    });
    return [...rows, ...unmatched.map(taskRow)];
}

/** The Commands tab's rows: the shells and monitors, whoever runs them. */
export function commandRows(tasks: readonly BackgroundTaskInfo[]): WorkRow[] {
    return tasks.filter((t) => tabOf(t) === "commands").map(taskRow);
}

/** What a row's Stop stops: its running tasks that can stop (session.stopBackground), else a delegated run (session.stopAgent). */
export function stopTarget(r: WorkRow): { tasks: string[] } | { agent: string } | undefined {
    if (!rowLive(r)) return undefined;
    const tasks = r.tasks.filter((t) => t.status === "running" && t.stoppable).map((t) => t.id);
    if (tasks.length) return { tasks };
    if (r.agent && runLive(r.agent.status) && r.agent.taskId) return { agent: r.agent.id };
    return undefined;
}

/** A row where it's listed: how far in it sits, under its parent. */
export interface Placed {
    row: WorkRow;
    depth: number;
}

/** A tab's rows as it lists them: what runs, then a fold of what finished; and its counts. */
export interface WorkSection {
    /** Those running (or with one running under them), oldest first, each with its own under it. */
    running: Placed[];
    /** The rest, most recent first. */
    finished: Placed[];
    /** How many run now, at any depth: the tab's count. */
    live: number;
    /** How many of the finished failed. */
    failed: number;
    /** Running rows (not under another) that Stop all would stop: it shows for more than one. */
    stoppable: number;
}

/** How deep the rows go: deeper ones sit at this depth. */
const MAX_DEPTH = 8;

/**
 * The rows grouped for the tab. `held`: the rows (not under another) that were in Finished when the pointer
 * came onto the list. While it's there they stay in Finished and the rest stay where they are, so a row
 * doesn't slide away from under a click as another one ends; the list catches up when it leaves.
 */
export function workSection(rows: readonly WorkRow[], held?: ReadonlySet<string>): WorkSection {
    const keys = new Set(rows.map((r) => r.key));
    const under = new Map<string, WorkRow[]>();
    for (const r of rows) if (r.parent && keys.has(r.parent)) under.set(r.parent, [...(under.get(r.parent) ?? []), r]);
    const tree = (r: WorkRow, depth = 0): Placed[] => [{ row: r, depth }, ...(under.get(r.key) ?? []).flatMap((c) => tree(c, Math.min(depth + 1, MAX_DEPTH)))];
    const tops = rows.filter((r) => !r.parent || !keys.has(r.parent));
    const anyLive = (r: WorkRow): boolean => rowLive(r) || (under.get(r.key) ?? []).some(anyLive);
    const done = (r: WorkRow) => (held ? held.has(r.key) : !anyLive(r));
    const running = tops.filter((r) => !done(r)).sort((a, b) => a.startedAt - b.startedAt);
    const finished = tops.filter(done).sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
    const fin = finished.flatMap((r) => tree(r));
    return {
        running: running.flatMap((r) => tree(r)),
        finished: fin,
        live: rows.filter(rowLive).length,
        failed: fin.filter((p) => p.row.status === "failed").length,
        stoppable: running.filter((r) => stopTarget(r)).length,
    };
}

/** What Stop all stops in a tab: every running row's own target, its tasks together. */
export function stopAllOf(rows: readonly WorkRow[]): { tasks: string[]; agents: string[] } {
    const tasks: string[] = [];
    const agents: string[] = [];
    for (const r of rows) {
        const t = stopTarget(r);
        if (t && "tasks" in t) tasks.push(...t.tasks);
        else if (t) agents.push(t.agent);
    }
    return { tasks, agents };
}

/** Where the composer's background count (and /tasks) opens the panel: on Agents if a sub-agent runs, else Commands. */
export function workTabFor(tasks: readonly BackgroundTaskInfo[], agents: readonly AgentRun[]): WorkTab {
    return agentRows(tasks, agents).some(rowLive) ? "agents" : "commands";
}

/**
 * The key a row is cleared by: its own, when it started (a CLI can use a task id again), and when it ended. A run
 * that goes on again (Codex's, messaged after it answered) keeps its id and start: its next end is news again.
 */
export const clearKey = (r: Pick<WorkRow, "key" | "startedAt" | "endedAt">) => `${r.key}@${r.startedAt}-${r.endedAt ?? ""}`;

/** The row's right-hand text: how long it's run (a monitor's time left), "Needs you", or how it ended and after how long. */
export function rowMeta(r: WorkRow, shells: readonly Shell[], at: number, duration: (ms: number) => string, runner?: string): string {
    if (r.status === "waiting") return "Needs you";
    // A task of its own says it as the Background list did; so does a sub-agent's task that ended without a word from its CLI.
    const odd = r.agent && !rowLive(r) ? r.tasks.find((t) => t.lost || (t.withProcess && t.status === "stopped")) : undefined;
    const task = r.agent ? odd : r.tasks[0];
    if (task) return taskMeta(task, shells, at, duration, runner);
    if (rowLive(r)) return duration(Math.max(0, at - r.startedAt));
    return `${r.status === "done" ? "Done" : r.status === "failed" ? "Failed" : "Stopped"} · ${duration(Math.max(0, (r.endedAt ?? r.startedAt) - r.startedAt))}`;
}

/** The colour of that text. */
export function rowTone(r: WorkRow): "warn" | "err" | "ok" | "" {
    if (r.status === "waiting" || r.tasks.some((t) => !rowLive(r) && (t.lost || (t.withProcess && t.status === "stopped")))) return "warn";
    return r.status === "failed" ? "err" : r.status === "done" ? "ok" : "";
}

/** Every finished row with a background task in it is cleared (`cleared`: by clearKey): the server's list of finished tasks can go too. */
export function endedAllCleared(rows: readonly WorkRow[], cleared: ReadonlySet<string>): boolean {
    return rows.every((r) => rowLive(r) || !r.tasks.length || cleared.has(clearKey(r)));
}

/** Who runs a row: its task's runner (an agent CLI, or a delegated model's provider), else its run's model's provider, else the session's. Cavvy's own commands: none. */
export function rowProvider(r: WorkRow, own?: string, agents: readonly AgentRun[] = []): string | undefined {
    const t = r.tasks.find((x) => x.provider !== "cavvy");
    if (t) return t.provider;
    return r.agent ? agentProvider(r.agent, own, agents) : undefined;
}
