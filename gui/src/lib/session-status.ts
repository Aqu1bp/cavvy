import type { SessionState, SessionSummary } from "@shared/protocol";
import { duration } from "./format";

export function sessionStatus(s: SessionSummary, now: number): { text: string; tone: string } | undefined {
    if (s.status === "waiting") {
        const text = s.waitingKind === "permission" ? "Needs approval"
            : s.waitingKind === "plan" ? "Plan to review"
            : s.waitingKind === "question" || s.waitingKind === "secret" ? "Has a question"
            : s.waitingKind === "signin" ? "Needs a sign-in"
            : s.waitingKind === "confirm" ? "Needs your OK" : "Needs you";
        return { text, tone: "warn" };
    }
    if (s.status === "running") {
        const ms = s.turnStartedAt === undefined ? 0 : Math.max(0, now - s.turnStartedAt);
        // By the minute: it's a row's tooltip and spoken label, worked out each second (by the second, each working row's
        // two labels changed each second: restyled, and read out again).
        return { text: ms >= 60_000 ? `Working ${duration(ms).replace(/ \d+s$/, "")}` : "Working", tone: "info" };
    }
    if (s.status === "error") return { text: "Stopped", tone: "err" };
    // Its last turn never finished (stopped, or cut off when Cavvy quit): not done.
    if (s.messages > 0) return s.stopped ? { text: "Stopped", tone: "muted" } : { text: "Done", tone: "muted" };
    return undefined;
}

/** Stop (Esc) does something: a turn is running, or a goal of the loop here is between its turns (a check or a retry coming), which it pauses. */
export function canStop(s: Pick<SessionState, "busy" | "goal"> | undefined): boolean {
    if (!s) return false;
    return s.busy || (s.goal !== undefined && s.goal.judge !== "native" && s.goal.state !== "paused");
}
