// The palette's message search past the server's budget (gui/src/lib/search.ts):
// it asks again while the answer is partial and the query is the same, a few
// times at most, and says when it stopped with sessions unread.

import { describe, expect, test } from "bun:test";
import { searchRounds, SEARCH_ROUNDS, type SearchProgress } from "../gui/src/lib/search";
import type { SessionSearchHit, SessionSearchResult } from "../src/server/protocol";

const hit = (id: string) => ({ id }) as SessionSearchHit;

function server(answers: SessionSearchResult[]) {
    let calls = 0;
    return {
        ask: async () => answers[Math.min(calls++, answers.length - 1)]!,
        calls: () => calls,
    };
}

describe("palette message search", () => {
    test("a partial answer is asked again until it's whole, showing each one", async () => {
        const s = server([
            { hits: [], partial: true },
            { hits: [hit("a")], partial: true },
            { hits: [hit("a"), hit("b")], partial: false },
        ]);
        const shown: SearchProgress[] = [];
        await searchRounds(s.ask, () => true, (p) => shown.push(p));
        expect(s.calls()).toBe(3);
        expect(shown.map((p) => [p.hits.length, p.more, p.incomplete])).toEqual([
            [0, true, false],
            [1, true, false],
            [2, false, false],
        ]);
    });

    test("a whole answer is asked once", async () => {
        const s = server([{ hits: [hit("a")], partial: false }]);
        const shown: SearchProgress[] = [];
        await searchRounds(s.ask, () => true, (p) => shown.push(p));
        expect(s.calls()).toBe(1);
        expect(shown).toEqual([{ hits: [hit("a")], more: false, incomplete: false }]);
    });

    test("still partial after the last round: said to be incomplete, not asked again", async () => {
        const s = server([{ hits: [], partial: true }]);
        const shown: SearchProgress[] = [];
        await searchRounds(s.ask, () => true, (p) => shown.push(p));
        expect(s.calls()).toBe(SEARCH_ROUNDS);
        expect(shown.at(-1)).toEqual({ hits: [], more: false, incomplete: true });
        expect(shown.slice(0, -1).every((p) => p.more && !p.incomplete)).toBe(true);
    });

    test("another query, or a newer search on the server, ends it without showing anything", async () => {
        let current = true;
        const s = server([{ hits: [hit("old")], partial: true }]);
        const shown: SearchProgress[] = [];
        const done = searchRounds(
            async () => {
                const r = await s.ask();
                current = false; // typed on while it was asked
                return r;
            },
            () => current,
            (p) => shown.push(p),
        );
        await done;
        expect(s.calls()).toBe(1);
        expect(shown).toEqual([]);
        const stale = server([{ hits: [], partial: true, stale: true }]);
        await searchRounds(stale.ask, () => true, (p) => shown.push(p));
        expect(stale.calls()).toBe(1);
        expect(shown).toEqual([]);
    });
});
