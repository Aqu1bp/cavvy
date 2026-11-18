// A search on the user's own computer, for its windows, looks on the servers it's connected to as well: each is asked
// the same search at the same time as this machine's own, and what it found is said to be its (machine).

import type { SessionSearchHit, SessionSearchResult } from "./protocol";

/** How long a search waits for a server's answer: one slower than this is left out (the window's search asks again). */
export const FAR_SEARCH_MS = 1_000;

/** What a search can ask a server (servers/watch.ts MachineWatch.ask). */
export interface SearchAsk {
    ask(method: "sessions.search", params: Record<string, unknown>): Promise<unknown>;
}

/** What each server found, by its name; one that didn't answer in time, or in a shape a search answers in, found nothing and leaves the search partial. */
export function searchServers(servers: Map<string, SearchAsk>, params: { query: string; limit: number; archived?: boolean }, ms = FAR_SEARCH_MS): Promise<{ hits: SessionSearchHit[]; partial: boolean }[]> {
    return Promise.all(
        [...servers].map(async ([name, w]) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const r = (await Promise.race([
                    w.ask("sessions.search", { query: params.query, limit: params.limit, ...(params.archived === undefined ? {} : { archived: params.archived }) }),
                    new Promise((_, no) => (timer = setTimeout(() => no(new Error("slow")), ms))),
                ])) as Partial<SessionSearchResult> | undefined;
                const hits = Array.isArray(r?.hits) ? r.hits.filter((h) => h && typeof h.id === "string" && typeof h.at === "number").map((h) => ({ ...h, machine: name })) : [];
                return { hits, partial: !r || r.stale === true || r.partial === true };
            } catch {
                return { hits: [], partial: true };
            } finally {
                clearTimeout(timer);
            }
        }),
    );
}

/** This machine's hits and the servers', newest first, at most `limit`. */
export function withServers(here: SessionSearchResult, there: { hits: SessionSearchHit[]; partial: boolean }[], limit: number): SessionSearchResult {
    if (!there.length) return here;
    return { partial: here.partial || there.some((t) => t.partial), hits: [...here.hits, ...there.flatMap((t) => t.hits)].sort((a, b) => b.at - a.at).slice(0, limit) };
}
