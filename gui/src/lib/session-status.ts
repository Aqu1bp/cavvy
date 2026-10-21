import type { SessionState, SessionSummary } from "@shared/protocol";
import { duration } from "./format";

export function sessionStatus(s: SessionSummary, now: number): { text: string; tone: string } | undefined {
    if (s.status === "waiting") {
        const text = s.waitingKind === "permission" ? "Needs approval"
            : s.waitingKind === "plan" ? "Plan to review"
            : s.waitingKind === "question" || s.waitingKind === "secret" ? "Has a question" : "Needs you";
        return { text, tone: "warn" };
    }
    if (s.status === "running") {
        const ms = s.turnStartedAt === undefined ? 0 : Math.max(0, now - s.turnStartedAt);
        return { text: ms >= 1000 ? `Working ${duration(ms).replace(/ \d+s$/, "")}` : "Working", tone: "info" };
    }
    if (s.status === "error") return { text: "Stopped", tone: "err" };
    if (s.messages > 0) return { text: "Done", tone: "muted" };
    return undefined;
}

/** Stop (Esc) does something: a turn is running, or a goal of the loop here is between its turns (a check or a retry coming), which it pauses. */
export function canStop(s: Pick<SessionState, "busy" | "goal"> | undefined): boolean {
    if (!s) return false;
    return s.busy || (s.goal !== undefined && s.goal.judge !== "native" && s.goal.state !== "paused");
}
