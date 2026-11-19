// Message search from the palette, carried on past the server's budget: the
// server keeps what it has read, so asking the same thing again reads on
// from where it stopped.

import type { SessionSearchHit, SessionSearchResult } from "@shared/protocol";

/** Answers asked for at most while the server says it read only part of the sessions. */
export const SEARCH_ROUNDS = 4;

export interface SearchProgress {
    hits: SessionSearchHit[];
    /** Still reading older sessions: another answer is on its way. */
    more: boolean;
    /** It stopped with sessions not read: the hits may not be all of them. */
    incomplete: boolean;
    /** What's on its way is the servers' (these are this machine's own), not older sessions read here. */
    servers?: boolean;
}

/**
 * Asks until an answer is whole or the rounds run out, handing each one to
 * `show`. Stops, showing nothing more, once `current()` is false (another
 * query) or the server says a newer search replaced it.
 */
export async function searchRounds(ask: (rest?: boolean) => Promise<SessionSearchResult>, current: () => boolean, show: (p: SearchProgress) => void, rounds = SEARCH_ROUNDS): Promise<void> {
    for (let i = 1; i <= rounds; i++) {
        let r = await ask();
        if (!current() || r.stale) return;
        // This machine's own, its servers still to answer: shown meanwhile (the first time: later, what's shown
        // already has the servers'), and the rest asked for. That's the same round.
        if (r.pending) {
            if (i === 1) show({ hits: r.hits, more: true, incomplete: false, servers: true });
            r = await ask(true);
            if (!current() || r.stale) return;
        }
        const again = r.partial && i < rounds;
        show({ hits: r.hits, more: again, incomplete: r.partial && !again });
        if (!again) return;
    }
}
