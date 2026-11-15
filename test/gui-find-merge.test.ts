// Find's count with turns the window has folded (Turn.folded): those the server counts, the rest the window, all in
// the turns' order (gui/src/lib/find.ts allMatches).
import { expect, test } from "bun:test";
import { allMatches } from "../gui/src/lib/find";
import type { Turn } from "../src/server/protocol";

const turn = (id: string, text: string, folded = false): Turn => ({ id, status: "done", startedAt: 1, prompt: { text }, blocks: [], ...(folded ? { folded: true as const } : {}) });

test("matches come in the turns' order, folded ones' from the server, the window's own counted here", () => {
    // t0 and t1 the window hasn't; t2 it has whole, t3 folded, t4 whole.
    const turns = [turn("t2", "apple"), turn("t3", "(folded)", true), turn("t4", "apple apple")];
    const there = [
        { turnId: "t0", part: "prompt", n: 0 },
        { turnId: "t1", part: "prompt", n: 0 },
        // In the folded turn, where the window can't count it.
        { turnId: "t3", part: "c", n: 0 },
        { turnId: "t3", part: "c", n: 1 },
    ];
    expect(allMatches(turns, "apple", there)).toEqual([
        { turnId: "t0", part: "prompt", n: 0 },
        { turnId: "t1", part: "prompt", n: 0 },
        { turnId: "t2", part: "prompt", n: 0 },
        { turnId: "t3", part: "c", n: 0 },
        { turnId: "t3", part: "c", n: 1 },
        { turnId: "t4", part: "prompt", n: 0 },
        { turnId: "t4", part: "prompt", n: 1 },
    ]);
    // The folded turn come in whole since: counted here, the server's count of it dropped.
    const whole = [turns[0]!, turn("t3", "no fruit"), turns[2]!];
    expect(allMatches(whole, "apple", there).map((m) => m.turnId)).toEqual(["t0", "t1", "t2", "t4", "t4"]);
    // Nothing from the server: the window's own.
    expect(allMatches(turns, "apple", []).map((m) => m.turnId)).toEqual(["t2", "t4", "t4"]);
});
