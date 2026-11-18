// A search on the user's computer looks on its servers too (src/server/far-search.ts): each server's hits say it's
// theirs, and one that's slow or answers oddly is left out, the search saying it's partial.
import { expect, test } from "bun:test";
import { FAR_SEARCH_MS, searchServers, withServers } from "../src/server/far-search";

const hit = (id: string, at: number) => ({ id, title: id, cwd: `/p/${id}`, projectName: "p", archived: false, seg: 0, index: 0, role: "user" as const, snippet: "…migration…", at });

test("each server is asked the same search, and its hits are said to be its; this machine's and theirs together, newest first", async () => {
    const asked: [string, unknown][] = [];
    const box = { ask: async (m: string, p: unknown) => (asked.push(["box", p]), { hits: [hit("b1", 30), hit("b2", 5)], partial: false }) };
    const lab = { ask: async (m: string, p: unknown) => (asked.push(["lab", p]), { hits: [hit("l1", 20)], partial: false }) };
    const there = await searchServers(new Map([["box", box], ["lab", lab]]), { query: "migration", limit: 3 });
    expect(asked).toEqual([["box", { query: "migration", limit: 3 }], ["lab", { query: "migration", limit: 3 }]]);
    const merged = withServers({ hits: [hit("m1", 25)], partial: false }, there, 3);
    expect(merged.hits.map((h) => [h.id, h.machine])).toEqual([["b1", "box"], ["m1", undefined], ["l1", "lab"]]);
    expect(merged.partial).toBe(false);
});

test("a server that's stuck, fails, answers stale or in another shape finds nothing; one whose own search ran out of time is asked again", async () => {
    const waited: (number | undefined)[] = [];
    const slow = { ask: (_m: string, _p: unknown, ms?: number) => (waited.push(ms), Promise.reject(new Error("box didn't answer."))) };
    const failing = { ask: () => Promise.reject(new Error("went away")) };
    const stale = { ask: async () => ({ hits: [hit("old", 9)], partial: true, stale: true }) };
    const shapeless = { ask: async () => ({}) };
    const odd = { ask: async () => ({ hits: [{ id: "x", at: 3 }, null, { ...hit("far", 1), at: 1e20 }, { ...hit("bent", 1), match: [1] }, hit("ok", 1)], partial: false }) };
    const behind = { ask: async () => ({ hits: [hit("b", 2)], partial: true }) };
    const there = await searchServers(new Map<string, any>([["slow", slow], ["failing", failing], ["stale", stale], ["shapeless", shapeless], ["odd", odd], ["behind", behind]]), { query: "x", limit: 5 }, 50);
    // The server's connection gives up on it in that time, freeing its place for other calls.
    expect(waited).toEqual([50]);
    expect(there.map((t) => [t.hits.map((h) => h.id), t.partial])).toEqual([[[], false], [[], false], [[], false], [[], false], [["ok"], false], [["b"], true]]);
    expect(withServers({ hits: [hit("m1", 2)], partial: false }, there.slice(0, 5), 5).partial).toBe(false);
    expect(withServers({ hits: [hit("m1", 2)], partial: false }, there, 5).partial).toBe(true);
    const alone = { hits: [hit("m1", 2)], partial: false };
    expect(withServers(alone, [], 5)).toBe(alone);
});

test("a server is given its own search's time and the way back: a slow but working one's hits are in", async () => {
    let given: number | undefined;
    const slow = { ask: (_m: string, _p: unknown, ms?: number) => ((given = ms), Bun.sleep(1200).then(() => ({ hits: [hit("late", 4)], partial: false }))) };
    const there = await searchServers(new Map([["box", slow]]), { query: "x", limit: 5 });
    expect(given).toBe(FAR_SEARCH_MS);
    expect(FAR_SEARCH_MS).toBeGreaterThan(2_500);
    expect(there[0]!.hits.map((h) => [h.id, h.machine])).toEqual([["late", "box"]]);
});

test("a slow server doesn't hold what this machine found: it's answered at once as part of it, and the next asking brings the server's", async () => {
    const { isolate } = await import("./helpers/isolate");
    const iso = isolate();
    const { Engine } = await import("../src/server/engine");
    const engine = new Engine({});
    const client = { subs: new Set<string>(), send() {} };
    engine.clients.add(client as never);
    let asked = 0;
    const hit = { id: "s1", title: "t", cwd: "/srv/app", projectName: "app", snippet: "needle here", seg: 0, index: 0, at: 5, role: "user", archived: false };
    const slow = { ask: async () => (asked++, await Bun.sleep(900), { hits: [hit], partial: false }) };
    (engine as any).serverLinks = { connectedServers: () => new Map([["box", slow]]) };
    try {
        const started = Date.now();
        const first = (await engine.handle(client as never, "sessions.search", { query: "needle", limit: 20 })) as { hits: unknown[]; partial: boolean };
        // This machine's own (none here) without the server's 900 ms, and said to be part of the answer.
        expect([first.hits, first.partial, Date.now() - started < 800]).toEqual([[], true, true]);
        const second = (await engine.handle(client as never, "sessions.search", { query: "needle", limit: 20 })) as { hits: { id: string; machine?: string }[]; partial: boolean };
        expect([second.hits.map((h) => [h.machine, h.id]), second.partial, asked]).toEqual([[["box", "s1"]], false, 1]);
        // A quick server is in the first answer.
        (engine as any).serverLinks = { connectedServers: () => new Map([["box", { ask: async () => ({ hits: [hit], partial: false }) }]]) };
        const quick = (await engine.handle(client as never, "sessions.search", { query: "needle two", limit: 20 })) as { hits: unknown[]; partial: boolean };
        expect([quick.hits.length, quick.partial]).toEqual([1, false]);
    } finally {
        (engine as any).serverLinks = undefined;
        await engine.stop();
        iso.cleanup();
    }
});
