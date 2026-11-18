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

test("a server that's slow, fails or answers oddly finds nothing, and the search says it's partial; with no server it's this machine's alone", async () => {
    const slow = { ask: () => new Promise<unknown>(() => {}) };
    const failing = { ask: () => Promise.reject(new Error("went away")) };
    const odd = { ask: async () => ({ hits: [{ id: 7 }, null, hit("ok", 1)] }) };
    const started = Date.now();
    const there = await searchServers(new Map<string, any>([["slow", slow], ["failing", failing], ["odd", odd]]), { query: "x", limit: 5 }, 50);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(there.map((t) => [t.hits.map((h) => h.id), t.partial])).toEqual([[[], true], [[], true], [["ok"], false]]);
    expect(withServers({ hits: [hit("m1", 2)], partial: false }, there, 5).partial).toBe(true);
    const alone = { hits: [hit("m1", 2)], partial: false };
    expect(withServers(alone, [], 5)).toBe(alone);
});
