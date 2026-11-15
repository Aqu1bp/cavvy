// @-mention completion over a project's files (src/ui/mentions.ts FileIndex): what it offers, in its order, is what
// scoring every path with fuzzyScore and sorting them gave, however it gets there (a mask passes paths over, a query
// typed on from the last looks only where that one was found).
import { expect, test } from "bun:test";
import { FileIndex } from "../src/ui/mentions";
import { fuzzyScore } from "../src/ui/components";

/** What search did before: every path scored, all of them sorted (but a path the query isn't in at all, which it offered). */
function reference(dirs: string[], files: string[], query: string, limit: number): string[] {
    const q = query.replace(/^\.\//, "");
    const scored: { p: string; s: number }[] = [];
    for (const p of [...dirs, ...files]) {
        const base = p.replace(/\/$/, "").split("/").pop() ?? p;
        const b = fuzzyScore(q, base);
        const s = Math.max(fuzzyScore(q, p), b >= 0 ? b + 50 : -1);
        if (s > 0) scored.push({ p, s: s - p.length * 0.05 });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, limit).map((x) => x.p);
}

function index(files: string[]) {
    const idx = new FileIndex("/nonexistent");
    void (idx as any).take(files);
    // Listed: not again.
    (idx as any).builtAt = Date.now();
    return idx;
}

test("it offers what scoring every path did, in the same order, typed on or asked afresh", () => {
    let seed = 9;
    const r = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    const words = ["src", "Lib", "components", "Server", "agent", "tools", "util", "test", "README", "index", "main", "app.config", "a_b", "x-y", "ünï", "café"];
    const files = Array.from({ length: 3000 }, (_, i) => {
        const parts = Array.from({ length: 1 + Math.floor(r() * 4) }, () => words[Math.floor(r() * words.length)]!);
        return `${parts.join("/")}/${words[Math.floor(r() * words.length)]}${i % 7 ? "" : " copy"}.${["ts", "md", "json"][i % 3]}`;
    });
    const dirs = [...new Set(files.flatMap((f) => f.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/") + "/")))];
    const idx = index(files);
    expect((idx as any).paths.slice(0, dirs.length).sort()).toEqual([...dirs].sort());
    const queries = ["s", "sr", "src", "src/", "src/c", "src/co", "srv", "Serv", "server", "mai", "main.", "main.t", "./ind", "ap", "app.c", "a_", "x-", "ün", "café", "zzz", "comp ts", "/", "md", "ME", "e", "", "2", "29", "copy"];
    for (const limit of [12, 8, 1]) {
        for (const q of queries) {
            // Asked afresh, and typed one letter at a time (each a search, as the composer asks).
            const fresh = index(files);
            const want = reference(dirs.filter((d) => (fresh as any).paths.includes(d)).sort((a, b) => (fresh as any).paths.indexOf(a) - (fresh as any).paths.indexOf(b)), files, q, limit);
            expect([q, limit, fresh.search(q, limit)]).toEqual([q, limit, want]);
            for (let k = 1; k <= q.length; k++) idx.search(q.slice(0, k), limit);
            expect([q, limit, "typed", idx.search(q, limit)]).toEqual([q, limit, "typed", want]);
        }
    }
});

test("a repository of a million files is all in it, and a keystroke doesn't score every path", () => {
    const files = Array.from({ length: 1_000_000 }, (_, i) => `pkg${i % 997}/src/module${i % 13}/file_${i}.ts`);
    const idx = index(files);
    expect(idx.search("file_999999", 12)[0]).toBe(`pkg${999999 % 997}/src/module${999999 % 13}/file_999999.ts`);
    // Nothing it's in: nothing offered (not every folder).
    expect(idx.search("zzz", 12)).toEqual([]);
});
