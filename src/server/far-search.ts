// A search on the user's own computer, for its windows, looks on the servers it's connected to as well: each is asked
// the same search at the same time as this machine's own, and what it found is said to be its (machine).

import type { SessionSearchHit, SessionSearchResult } from "./protocol";

/**
 * How long a search waits for a server's answer: its own search's time limit (search.ts, 2.5 s) and the way there and
 * back. A server slower than that is stuck: it's left out.
 */
export const FAR_SEARCH_MS = 3_000;

/** What a search can ask a server (servers/watch.ts MachineWatch.ask): `ms`, how long it waits. */
export interface SearchAsk {
    ask(method: "sessions.search", params: Record<string, unknown>, ms?: number): Promise<unknown>;
}

/** A hit as a window shows one: every field it reads, of its kind. */
function isHit(h: unknown): h is SessionSearchHit {
    const x = h as Record<string, unknown> | null;
    return (
        !!x &&
        typeof x === "object" &&
        ["id", "title", "cwd", "projectName", "snippet"].every((k) => typeof x[k] === "string") &&
        ["seg", "index"].every((k) => typeof x[k] === "number") &&
        // A time a date can be made of.
        typeof x.at === "number" &&
        Number.isFinite(new Date(x.at).getTime()) &&
        (x.role === "user" || x.role === "assistant") &&
        typeof x.archived === "boolean" &&
        (x.match === undefined || (Array.isArray(x.match) && x.match.length === 2 && x.match.every((n) => Number.isInteger(n) && n >= 0)))
    );
}

/**
 * What each server found, by its name. One that doesn't answer in time, or answers in another shape, found nothing;
 * the search is partial only when a server's own search ran out of time (asked again, it goes on from there).
 */
export function searchServers(servers: Map<string, SearchAsk>, params: { query: string; limit: number; archived?: boolean }, ms = FAR_SEARCH_MS): Promise<{ hits: SessionSearchHit[]; partial: boolean }[]> {
    return Promise.all(
        [...servers].map(async ([name, w]) => {
            const r = (await w.ask("sessions.search", { query: params.query, limit: params.limit, ...(params.archived === undefined ? {} : { archived: params.archived }) }, ms).catch(() => undefined)) as Partial<SessionSearchResult> | undefined;
            if (!r || typeof r !== "object" || r.stale === true || !Array.isArray(r.hits)) return { hits: [], partial: false };
            return { hits: r.hits.filter(isHit).map((h) => ({ ...h, machine: name })), partial: r.partial === true };
        }),
    );
}

/** This machine's hits and the servers', newest first, at most `limit`. */
export function withServers(here: SessionSearchResult, there: { hits: SessionSearchHit[]; partial: boolean }[], limit: number): SessionSearchResult {
    if (!there.length) return here;
    return { partial: here.partial || there.some((t) => t.partial), hits: [...here.hits, ...there.flatMap((t) => t.hits)].sort((a, b) => b.at - a.at).slice(0, limit) };
}
