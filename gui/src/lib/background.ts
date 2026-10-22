// The session's background work, as the Background panel shows it: every
// task running in the background (an agent CLI's sub-agents, shells and
// monitors; tasks delegated to other models; Harness's own background shells
// and monitors), then those that finished since the session was opened (until
// cleared) and those that stopped when Harness quit. A server older than
// SessionState.backgroundTasks sends only its shells: the list is made from those.
// And where the news of one ending goes: a toast, or a desktop notification.

import type { BackgroundStopResult, BackgroundTaskInfo, SessionState } from "@shared/protocol";

type Shell = SessionState["shells"][number];

/** What the panel lists, as the server keeps it: running tasks, and finished ones until they're cleared. */
export function backgroundOf(state: Pick<SessionState, "backgroundTasks" | "shells"> | undefined): BackgroundTaskInfo[] {
    if (!state) return [];
    if (state.backgroundTasks) return state.backgroundTasks;
    return state.shells
        .filter((s) => s.running)
        .map((s) => ({ id: s.id, provider: "harness", kind: s.monitor ? "monitor" : "shell", label: s.monitor?.description ?? s.command, startedAt: s.startedAt, status: "running", stoppable: true }));
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

/** How many run now. */
export function runningCount(tasks: readonly BackgroundTaskInfo[]): number {
    return tasks.filter((t) => t.status === "running").length;
}

/** The kind, as a word for the row and its tooltip. */
export function kindName(t: Pick<BackgroundTaskInfo, "kind">): string {
    return t.kind === "agent" ? "Sub-agent" : t.kind === "shell" ? "Shell" : t.kind === "monitor" ? "Monitor" : t.kind === "workflow" ? "Workflow" : "Task";
}

/** Who runs it: the agent CLI's name, the delegated model's provider, or Harness. */
export function runnerName(t: Pick<BackgroundTaskInfo, "provider">, providers: readonly { id: string; name: string }[]): string {
    if (t.provider === "harness") return "Harness";
    return providers.find((p) => p.id === t.provider)?.name ?? t.provider;
}

/** "45s left", "12m left": a monitor's, at a glance. */
function timeLeft(ms: number): string {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return s < 60 ? `${s}s left` : `${Math.ceil(s / 60)}m left`;
}

/** The row's right-hand text: how long it's run (a monitor's time left), or how it ended and after how long. */
export function taskMeta(t: BackgroundTaskInfo, shells: readonly Shell[], at: number, duration: (ms: number) => string): string {
    if (t.lost) return "Stopped when Harness quit";
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
    const refused = all.length - ok - pending;
    if (!all.length) return { message: "Nothing was running", level: "info" };
    const parts = [ok ? `Stopped ${ok} task${ok === 1 ? "" : "s"}` : "", pending ? `${pending} didn't confirm yet` : "", refused ? `${refused} couldn't be stopped on ${refused === 1 ? "its" : "their"} own` : ""].filter(Boolean);
    return { message: parts.join("; "), level: pending || refused ? "warn" : "success" };
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
