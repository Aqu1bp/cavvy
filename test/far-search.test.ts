// A search on the user's computer looks on its servers too (src/server/far-search.ts): each server's hits say it's
// theirs, and one that's slow or answers oddly is left out, the search saying it's partial.
import { expect, test } from "bun:test";
import { searchServers, withServers } from "../src/server/far-search";

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

test("a server that fails, answers stale or in another shape finds nothing; one that's slow, or whose own search ran out of time, is asked again", async () => {
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
    expect(there.map((t) => [t.hits.map((h) => h.id), t.partial])).toEqual([[[], true], [[], false], [[], false], [[], false], [["ok"], false], [["b"], true]]);
    expect(withServers({ hits: [hit("m1", 2)], partial: false }, there.slice(1, 5), 5).partial).toBe(false);
    expect(withServers({ hits: [hit("m1", 2)], partial: false }, there, 5).partial).toBe(true);
    const alone = { hits: [hit("m1", 2)], partial: false };
    expect(withServers(alone, [], 5)).toBe(alone);
});
