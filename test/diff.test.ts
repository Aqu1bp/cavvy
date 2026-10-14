import { describe, expect, test } from "bun:test";
import { diffLines, diffStats, hunks, unifiedDiff, type DiffOp } from "../src/util/diff";

/** Same splitting rule as diff.ts: a trailing newline ends the last line. */
function splitLines(s: string): string[] {
    if (s === "") return [];
    const l = s.split("\n");
    if (l[l.length - 1] === "") l.pop();
    return l;
}

const oldSide = (ops: DiffOp[]) => ops.filter((o) => o.type !== "add").map((o) => o.line);
const newSide = (ops: DiffOp[]) => ops.filter((o) => o.type !== "del").map((o) => o.line);

function rng(seed: number) {
    let s = seed >>> 0;
    return () => (s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32;
}

/** Random text over a tiny line alphabet, so there are many repeats and matches. */
function randomText(r: () => number, maxLines: number, alphabet = ["a", "b", "c", "d", ""]): string {
    const n = Math.floor(r() * (maxLines + 1));
    const ls = Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)]!);
    return ls.length ? ls.join("\n") + (r() < 0.7 ? "\n" : "") : "";
}

function mutate(r: () => number, text: string): string {
    const ls = splitLines(text);
    const edits = Math.floor(r() * 5);
    for (let e = 0; e < edits; e++) {
        const at = Math.floor(r() * (ls.length + 1));
        const kind = r();
        if (kind < 0.33) ls.splice(at, 0, `new${e}`);
        else if (kind < 0.66) ls.splice(at, 1);
        else if (at < ls.length) ls[at] = `changed${e}`;
    }
    return ls.length ? ls.join("\n") + "\n" : "";
}

function lcs(a: string[], b: string[]): number {
    const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    return dp[0]![0]!;
}

/** Apply a unified diff to `old` using standard (GNU) hunk-header semantics. */
function applyUnified(old: string, patch: string): string[] {
    const src = splitLines(old);
    if (!patch) return src;
    const lines = patch.split("\n");
    expect(lines[0]).toMatch(/^--- a\//);
    expect(lines[1]).toMatch(/^\+\+\+ b\//);
    const out: string[] = [];
    let pos = 0; // next unread line of src (0-based)
    let i = 2;
    while (i < lines.length) {
        const m = lines[i]!.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/);
        if (!m) throw new Error(`bad hunk header: ${lines[i]}`);
        const [oldStart, oldLines, , newLines] = m.slice(1).map(Number) as [number, number, number, number];
        // For an empty old range the start is the line *after which* to insert.
        const begin = oldLines === 0 ? oldStart : oldStart - 1;
        while (pos < begin) out.push(src[pos++]!);
        i++;
        let seenOld = 0;
        let seenNew = 0;
        while (i < lines.length && !lines[i]!.startsWith("@@")) {
            const l = lines[i]!;
            const body = l.slice(1);
            if (l[0] === " ") {
                expect(src[pos]).toBe(body);
                out.push(body);
                pos++;
                seenOld++;
                seenNew++;
            } else if (l[0] === "-") {
                expect(src[pos]).toBe(body);
                pos++;
                seenOld++;
            } else if (l[0] === "+") {
                out.push(body);
                seenNew++;
            } else throw new Error(`bad patch line: ${JSON.stringify(l)}`);
            i++;
        }
        expect(seenOld).toBe(oldLines);
        expect(seenNew).toBe(newLines);
    }
    while (pos < src.length) out.push(src[pos++]!);
    return out;
}

describe("diffLines", () => {
    test("a changed line in the middle", () => {
        expect(diffLines("a\nb\nc\n", "a\nx\nc\n")).toEqual([
            { type: "equal", line: "a", oldNo: 1, newNo: 1 },
            { type: "del", line: "b", oldNo: 2 },
            { type: "add", line: "x", newNo: 2 },
            { type: "equal", line: "c", oldNo: 3, newNo: 3 },
        ]);
    });

    test("identical texts are all equal ops", () => {
        const ops = diffLines("a\nb\n", "a\nb\n");
        expect(ops.every((o) => o.type === "equal")).toBe(true);
        expect(ops).toHaveLength(2);
    });

    test("empty to content and content to empty", () => {
        expect(diffLines("", "a\nb\n")).toEqual([
            { type: "add", line: "a", newNo: 1 },
            { type: "add", line: "b", newNo: 2 },
        ]);
        expect(diffLines("a\nb\n", "")).toEqual([
            { type: "del", line: "a", oldNo: 1 },
            { type: "del", line: "b", oldNo: 2 },
        ]);
        expect(diffLines("", "")).toEqual([]);
    });

    test("a missing trailing newline is not a change", () => {
        expect(diffLines("a\nb", "a\nb\n").every((o) => o.type === "equal")).toBe(true);
    });

    test("an added blank line is a change", () => {
        expect(diffStats(diffLines("a\n", "a\n\n"))).toEqual({ added: 1, removed: 0 });
    });

    test("insertions and deletions at the start and end", () => {
        expect(newSide(diffLines("b\nc\n", "a\nb\nc\nd\n"))).toEqual(["a", "b", "c", "d"]);
        expect(diffStats(diffLines("a\nb\nc\nd\n", "b\nc\n"))).toEqual({ added: 0, removed: 2 });
    });

    test("line numbers increase by one on each side", () => {
        const ops = diffLines("a\nb\nc\nd\ne\n", "a\nx\nc\ny\nz\ne\n");
        const olds = ops.filter((o) => o.oldNo !== undefined).map((o) => o.oldNo);
        const news = ops.filter((o) => o.newNo !== undefined).map((o) => o.newNo);
        expect(olds).toEqual([1, 2, 3, 4, 5]);
        expect(news).toEqual([1, 2, 3, 4, 5, 6]);
        for (const o of ops) {
            if (o.type === "add") expect(o.oldNo).toBeUndefined();
            if (o.type === "del") expect(o.newNo).toBeUndefined();
        }
    });

    test("round trip and minimality on random inputs", () => {
        const r = rng(1234);
        for (let n = 0; n < 400; n++) {
            const a = randomText(r, 25);
            const b = r() < 0.5 ? randomText(r, 25) : mutate(r, a);
            const ops = diffLines(a, b);
            expect(oldSide(ops)).toEqual(splitLines(a));
            expect(newSide(ops)).toEqual(splitLines(b));
            // Myers gives a shortest edit script: n + m - 2 * LCS edits.
            const A = splitLines(a);
            const B = splitLines(b);
            const st = diffStats(ops);
            expect(st.added + st.removed).toBe(A.length + B.length - 2 * lcs(A, B));
        }
    });

    test("very different large inputs fall back to delete-all/add-all and still round-trip", () => {
        const a = Array.from({ length: 1600 }, (_, i) => `a${i}`).join("\n");
        const b = Array.from({ length: 1600 }, (_, i) => `b${i}`).join("\n");
        const t0 = performance.now();
        const ops = diffLines(a, b);
        expect(performance.now() - t0).toBeLessThan(3000);
        expect(oldSide(ops)).toEqual(splitLines(a));
        expect(newSide(ops)).toEqual(splitLines(b));
    });

    test("a small edit in a large file is fast and exact", () => {
        const base = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
        const changed = [...base];
        changed[10000] = "edited";
        changed.splice(15000, 0, "inserted");
        const ops = diffLines(base.join("\n"), changed.join("\n"));
        expect(diffStats(ops)).toEqual({ added: 2, removed: 1 });
    });
});

describe("hunks", () => {
    const big = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n") + "\n";

    test("no changes, no hunks", () => {
        expect(hunks(diffLines(big, big))).toEqual([]);
    });

    test("a single change gets `context` lines on each side", () => {
        const hs = hunks(diffLines(big, big.replace("l10\n", "L10\n")), 3);
        expect(hs).toHaveLength(1);
        expect(hs[0]).toMatchObject({ oldStart: 7, oldLines: 7, newStart: 7, newLines: 7 });
        expect(hs[0]!.ops.map((o) => o.line)).toEqual(["l7", "l8", "l9", "l10", "L10", "l11", "l12", "l13"]);
    });

    test("context is clipped at the file edges", () => {
        const hs = hunks(diffLines(big, big.replace("l1\n", "L1\n")), 3);
        expect(hs[0]).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4 });
    });

    test("changes within 2*context lines merge into one hunk, farther ones split", () => {
        const near = big.replace("l5\n", "L5\n").replace("l11\n", "L11\n"); // 5 equal lines between
        expect(hunks(diffLines(big, near), 3)).toHaveLength(1);
        const far = big.replace("l5\n", "L5\n").replace("l13\n", "L13\n"); // 7 equal lines between
        const hs = hunks(diffLines(big, far), 3);
        expect(hs).toHaveLength(2);
        expect(hs.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
            [2, 7, 2, 7],
            [10, 7, 10, 7],
        ]);
    });

    test("hunks never overlap and cover every change", () => {
        const r = rng(77);
        for (let n = 0; n < 200; n++) {
            const a = randomText(r, 40);
            const b = mutate(r, a);
            const ops = diffLines(a, b);
            for (const ctx of [0, 1, 3]) {
                const hs = hunks(ops, ctx);
                const covered = hs.flatMap((h) => h.ops);
                expect(new Set(covered).size).toBe(covered.length);
                expect(covered.filter((o) => o.type !== "equal")).toEqual(ops.filter((o) => o.type !== "equal"));
            }
        }
    });

    test("insertions shift the new-side start of later hunks", () => {
        const b = big.replace("l2\n", "l2\nNEW1\nNEW2\n").replace("l25\n", "L25\n");
        const hs = hunks(diffLines(big, b), 3);
        expect(hs).toHaveLength(2);
        expect(hs[1]).toMatchObject({ oldStart: 22, newStart: 24 });
    });
});

describe("diffStats", () => {
    test("counts adds and dels", () => {
        expect(diffStats(diffLines("a\nb\nc\n", "a\nx\ny\n"))).toEqual({ added: 2, removed: 2 });
        expect(diffStats(diffLines("a\n", "a\n"))).toEqual({ added: 0, removed: 0 });
        expect(diffStats([])).toEqual({ added: 0, removed: 0 });
    });
});

describe("unifiedDiff", () => {
    test("headers and hunk format", () => {
        expect(unifiedDiff("f.txt", "a\nb\nc\n", "a\nx\nc\n")).toBe(["--- a/f.txt", "+++ b/f.txt", "@@ -1,3 +1,3 @@", " a", "-b", "+x", " c"].join("\n"));
    });

    test("identical texts give an empty string", () => {
        expect(unifiedDiff("f", "same\n", "same\n")).toBe("");
    });

    test("two separate hunks", () => {
        const a = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
        const b = a.replace("l3\n", "L3\n").replace("l25\n", "L25\n");
        const patch = unifiedDiff("f", a, b);
        expect(patch.split("\n").filter((l) => l.startsWith("@@"))).toEqual(["@@ -1,6 +1,6 @@", "@@ -22,7 +22,7 @@"]);
        expect(applyUnified(a, patch)).toEqual(splitLines(b));
    });

    test("round trip: applying the patch to the old text gives the new text", () => {
        const r = rng(4321);
        for (let n = 0; n < 300; n++) {
            const a = randomText(r, 30, ["a", "b", "c", "d", "e", "f"]);
            const b = r() < 0.3 ? randomText(r, 30) : mutate(r, a);
            // A zero-length side only appears for empty files at context >= 1,
            // which is covered by the bug test below.
            if (!splitLines(a).length || !splitLines(b).length) continue;
            for (const ctx of [1, 3]) expect(applyUnified(a, unifiedDiff("f", a, b, ctx))).toEqual(splitLines(b));
        }
    });

    test("zero-length ranges use the line before the change as their start (GNU/git convention)", () => {
        // New file: old side is empty.
        expect(unifiedDiff("f", "", "x\ny\n").split("\n")[2]).toBe("@@ -0,0 +1,2 @@");
        // Deleted content: new side is empty.
        expect(unifiedDiff("f", "x\ny\n", "").split("\n")[2]).toBe("@@ -1,2 +0,0 @@");
        // Pure insertion with no context, after old line 2.
        expect(unifiedDiff("f", "a\nb\nc\nd\n", "a\nb\nNEW\nc\nd\n", 0).split("\n")[2]).toBe("@@ -2,0 +3,1 @@");
        // Pure deletion with no context of old line 5: new side starts after new line 4.
        expect(unifiedDiff("f", "1\n2\n3\n4\n5\n6\n", "1\n2\n3\n4\n6\n", 0).split("\n")[2]).toBe("@@ -5,1 +4,0 @@");
        // ...so the patches apply.
        const r = rng(9);
        for (let n = 0; n < 200; n++) {
            const a = randomText(r, 20);
            const b = mutate(r, a);
            expect(applyUnified(a, unifiedDiff("f", a, b, 0))).toEqual(splitLines(b));
        }
    });
});
