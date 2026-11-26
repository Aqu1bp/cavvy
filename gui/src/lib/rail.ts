// What the session rail shows, as plain functions of the server's data (no DOM,
// so they're tested from test/): a row's status glyph, the counts on its group
// headings, the sessions that need you, and the plans in its footer.

import type { SessionSummary } from "@shared/protocol";
import type { SidebarEntry } from "./session-order";

/** The glyph at the start of a row: working, waiting for you, finished since you looked, stopped, or quiet. */
export type RailGlyph = "running" | "waiting" | "done" | "error" | "new" | "idle";

export function railGlyph(s: Pick<SessionSummary, "status" | "messages">, unread: boolean): RailGlyph {
    if (s.status === "running") return "running";
    if (s.status === "waiting") return "waiting";
    if (s.status === "error") return "error";
    if (unread) return "done";
    return s.messages > 0 ? "idle" : "new";
}

/**
 * Sessions under each project heading, keyed by the heading's entry key. A run
 * counts each of its sessions; the count stops at the next heading, so Settled
 * and "Show more" don't add to the last project. A folded project counts its
 * folded sessions.
 */
export function groupCounts(entries: readonly SidebarEntry[]): Map<string, number> {
    const counts = new Map<string, number>();
    let group: string | undefined;
    for (const e of entries) {
        if (e.kind === "project") {
            group = e.key;
            // A folded project counts the sessions folded under it.
            counts.set(group, e.collapsed ? e.ids?.length ?? 0 : 0);
        } else if (e.kind === "settled" || e.kind === "snoozed" || e.kind === "archived" || e.kind === "needs") group = undefined;
        else if (group && (e.kind === "card" || e.kind === "row")) counts.set(group, counts.get(group)! + 1);
        else if (group && e.kind === "run") counts.set(group, counts.get(group)! + e.ids.length);
    }
    return counts;
}

/**
 * Sessions waiting on you, but the one in front of you (its request card is
 * already there): the latest first. They're pinned at the top of the rail, or
 * in the title bar while the rail is hidden, until they're answered. `beside`: in a
 * split, the other session on screen (state/split.ts besideInFront), left out too.
 */
export function needsYou<T extends Pick<SessionSummary, "id" | "status" | "updatedAt">>(sessions: readonly T[], inFront?: string, beside?: string): T[] {
    return sessions.filter((s) => s.status === "waiting" && s.id !== inFront && s.id !== beside).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

/**
 * Where the sessions that need you show: pinned at the top of the rail when
 * it's shown; while it's hidden ("title"), only as a dot on the title bar's
 * button that shows it. Settings covers both (its own list takes the rail's
 * place, its page the title bar's): its top line has them, the open one too,
 * since Settings covers its request as well.
 */
export function needsPlace(o: { railShown: boolean; settings: boolean }): "rail" | "title" | "settings" {
    return o.settings ? "settings" : o.railShown ? "rail" : "title";
}

/**
 * The session whose request is in front of you, so Needs you leaves it out: the
 * open one, but not under Settings, nor while one of its sub-agents' views is
 * open (that shows only the sub-agent's own requests; opening it from Needs you
 * leaves the view: state/actions.ts openWaiting).
 */
export function inFront(o: { activeId?: string; settings: boolean; agentFocus?: string }): string | undefined {
    return o.settings || o.agentFocus ? undefined : o.activeId;
}

/** What a waiting session asks of you, for its row under Needs you. */
export function asking(s: Pick<SessionSummary, "waitingKind">): string {
    switch (s.waitingKind) {
        case "permission": return "Wants your approval";
        case "plan": return "Plan ready for review";
        case "question": return "Has a question for you";
        case "secret": return "Asks for a secret";
        case "signin": return "Needs you to sign in";
        case "confirm": return "Needs your OK";
        default: return "Waiting for your answer";
    }
}

/**
 * A row under Needs you: what it asks, while it does. Answered while the rail
 * holds still (the pointer on it), it says so until the row goes.
 */
export function needsRowLine(s: Pick<SessionSummary, "status" | "waitingKind">): string {
    return s.status === "waiting" ? asking(s) : "Answered";
}

/** The title bar's Needs you, in words: "Fix the build needs you: Wants your approval", "3 sessions need you". */
export function needsLine(waiting: readonly Pick<SessionSummary, "title" | "waitingKind">[]): string {
    const [one] = waiting;
    if (waiting.length === 1 && one) return `${one.title} needs you: ${asking(one)}`;
    return `${waiting.length} sessions need you`;
}
