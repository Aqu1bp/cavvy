import type { SessionSummary } from "@shared/protocol";

/**
 * A machine's sessions as another machine's window lists them: those in play (not archived, not set aside), the
 * ones waiting for the user first, then the working, then the most recent. As src/servers/watch.ts orders a server's.
 */
export function inPlay<S extends Pick<SessionSummary, "status" | "archived" | "settled" | "updatedAt">>(sessions: Iterable<S>): S[] {
    const rank = (s: S) => (s.status === "waiting" ? 0 : s.status === "running" ? 1 : 2);
    return [...sessions].filter((s) => !s.archived && !s.settled).sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
}
