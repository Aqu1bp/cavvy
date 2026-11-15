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

/** Its paths, in its order. */
const pathsOf = (idx: FileIndex): string[] => Array.from({ length: (idx as any).index.size }, (_, i) => (idx as any).index.path(i));

function index(files: string[]) {
    const idx = new FileIndex("/nonexistent");
    void (idx as any).take(files);
    // Listed: not again.
    (idx as any).builtAt = Date.now();
    return idx;
}

test("it offers what scoring every path did, in the same order, typed on or asked afresh, made at once or in slices", async () => {
    let seed = 9;
    const r = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    const words = ["src", "Lib", "components", "Server", "agent", "tools", "util", "test", "README", "index", "main", "app.config", "a_b", "x-y", "ünï", "café"];
    const files = Array.from({ length: 3000 }, (_, i) => {
        const parts = Array.from({ length: 1 + Math.floor(r() * 4) }, () => words[Math.floor(r() * words.length)]!);
        return `${parts.join("/")}/${words[Math.floor(r() * words.length)]}${i % 7 ? "" : " copy"}.${["ts", "md", "json"][i % 3]}`;
    });
    const dirs = [...new Set(files.flatMap((f) => f.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/") + "/")))];
    const idx = index(files);
    expect(pathsOf(idx).slice(0, dirs.length).sort()).toEqual([...dirs].sort());
    // Made in slices (as the server's are, and a worker's): each character's best, and each two's, worked out ahead.
    const sliced = new FileIndex("/nonexistent");
    await (sliced as any).take(files, () => Promise.resolve());
    (sliced as any).builtAt = Date.now();
    const queries = ["s", "sr", "src", "src/", "src/c", "src/co", "srv", "Serv", "server", "mai", "main.", "main.t", "./ind", "ap", "app.c", "a_", "x-", "ün", "café", "zzz", "comp ts", "/", "md", "ME", "e", "", "2", "29", "copy"];
    for (const limit of [12, 8, 1]) {
        for (const q of queries) {
            // Asked afresh, and typed one letter at a time (each a search, as the composer asks).
            const fresh = index(files);
            const order = new Map(pathsOf(fresh).map((p, i) => [p, i]));
            const want = reference(dirs.filter((d) => order.has(d)).sort((a, b) => order.get(a)! - order.get(b)!), files, q, limit);
            expect([q, limit, fresh.search(q, limit)]).toEqual([q, limit, want]);
            expect([q, limit, "sliced", sliced.search(q, limit)]).toEqual([q, limit, "sliced", want]);
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

// A big project's paths on worker threads (mention-shards.ts), each with a part of them: what they offer together is
// what one index of all of them offers, in its order (folders split between parts included).
test("on workers, each with a part of the paths, it offers what one index of them all does", async () => {
    const { MentionShards, mentionSharding } = await import("../src/ui/mention-shards");
    const { PathIndex } = await import("../src/ui/path-index");
    let seed = 5;
    const r = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    const words = ["src", "Lib", "components", "Server", "index", "main", "a_b", "x-y", "ünï", "café", "test"];
    const files = Array.from({ length: 4000 }, (_, i) => {
        const parts = Array.from({ length: 1 + Math.floor(r() * 4) }, () => words[Math.floor(r() * words.length)]!);
        return `${parts.join("/")}/${words[Math.floor(r() * words.length)]}_${i}.${["ts", "md"][i % 2]}`;
    });
    const one = new PathIndex();
    void one.take(files);
    const listing = new TextEncoder().encode(files.join("\n") + "\n");
    const saved = { ...mentionSharding };
    for (const parts of [2, 3, 4]) {
        Object.assign(mentionSharding, { perPart: Math.ceil(listing.length / parts), most: parts });
        const shards = new MentionShards();
        try {
            expect(await shards.take(listing)).toBe(true);
            for (const limit of [12, 5, 1]) {
                for (const q of ["s", "src", "src/", "lib/c", "serv", "main_", "_4", "x-", "ün", "café/", "md", "e", "", "zzz", "/", "index/main"]) {
                    expect([parts, limit, q, await shards.search(q, limit)]).toEqual([parts, limit, q, one.find(q, limit)]);
                }
            }
            // The same listing again: each part kept as it was, and the same offered.
            expect(await shards.take(listing)).toBe(true);
            expect(await shards.search("src", 12)).toEqual(one.find("src", 12));
        } finally {
            shards.stop();
        }
    }
    Object.assign(mentionSharding, saved);
}, 60_000);

test("a project's index on workers lists it with git and finds in it, and here again once they're let go of", async () => {
    const { mentionSharding } = await import("../src/ui/mention-shards");
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("fs");
    const { join } = await import("path");
    const { tmpdir } = await import("os");
    const root = mkdtempSync(join(tmpdir(), "cavvy-mention-shards-"));
    const saved = { ...mentionSharding };
    try {
        for (const d of ["src/server", "src/gui", "docs"]) mkdirSync(join(root, d), { recursive: true });
        for (const f of ["src/server/engine.ts", "src/server/find.ts", "src/gui/app.tsx", "docs/plan.md", "README.md"]) writeFileSync(join(root, f), "x");
        Bun.spawnSync(["git", "init", "-q"], { cwd: root });
        // Any listing goes to workers, two of them.
        Object.assign(mentionSharding, { from: 0, perPart: 40, most: 2 });
        const idx = new FileIndex(root);
        expect(await idx.searchSoon("find", 12)).toEqual(["src/server/find.ts"]);
        expect((idx as any).shards?.parts).toBe(2);
        expect(await idx.searchSoon("src/s", 3)).toEqual(["src/server/", "src/server/find.ts", "src/server/engine.ts"]);
        // Its workers stopped (one failing does the same): indexed here, and the same offered.
        (idx as any).shards.stop();
        expect(await idx.searchSoon("src/s", 3)).toEqual(["src/server/", "src/server/find.ts", "src/server/engine.ts"]);
        expect((idx as any).shards).toBeUndefined();
        idx.dispose();
    } finally {
        Object.assign(mentionSharding, saved);
        rmSync(root, { recursive: true, force: true });
    }
}, 60_000);

// Made from git's listing as it came (on a worker: no string for each path), it's the same index as made from its paths.
test("made from the listing's bytes, it's what it is made from its paths", async () => {
    const { PathIndex } = await import("../src/ui/path-index");
    let seed = 13;
    const r = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    const words = ["src", "Lib", "components", "Server", "index", "main", "a_b", "x-y", "ünï", "café", "test", "/lead"];
    const files = Array.from({ length: 3000 }, (_, i) => {
        const parts = Array.from({ length: Math.floor(r() * 4) }, () => words[Math.floor(r() * words.length)]!);
        return `${parts.join("/")}${parts.length ? "/" : ""}${words[Math.floor(r() * words.length)]}_${i}${i % 9 ? "" : " copy"}.${["ts", "MD"][i % 2]}`;
    });
    const listing = new TextEncoder().encode(files.join("\n") + "\n\n");
    for (const o of [{}, { first: 7, slice: () => Promise.resolve() }]) {
        const made = new PathIndex();
        await made.take(files, o);
        const fromBytes = new PathIndex();
        await fromBytes.takeBytes(listing, o);
        const all = (x: any) => Array.from({ length: x.size }, (_, i) => [x.path(i), x.keys?.[i]]);
        expect(all(fromBytes)).toEqual(all(made));
        for (const q of ["s", "src", "src/", "lib/c", "serv", "_4", "x-", "ün", "café/", "md", "e", "", "/", "/l", "copy", "zz"]) {
            for (const limit of [12, 3]) expect([q, limit, fromBytes.top(q, limit)]).toEqual([q, limit, made.top(q, limit)]);
        }
    }
});
