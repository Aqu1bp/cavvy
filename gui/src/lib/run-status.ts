import type { RunOutcome, SessionStatus } from "@shared/protocol";

/** Current activity wins over a previous outcome when a run session is resumed. */
export function runStatus(status: SessionStatus, outcome?: RunOutcome): { word: string; tone: string } {
    if (status === "running") return { word: "working", tone: "running" };
    if (status === "waiting") return { word: "needs you", tone: "waiting" };
    if (status === "error" || outcome === "stopped") return { word: "stopped", tone: "stopped" };
    return { word: "done", tone: "done" };
}
