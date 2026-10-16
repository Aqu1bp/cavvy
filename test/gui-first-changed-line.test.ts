// "Open in editor" from a diff opens at the first changed line, not at the
// hunk's start (which includes context above the change). Diffs come from the
// server's own fileDiff, the way tool blocks get them.

import { afterAll, describe, expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { fileDiff } = await import("../src/server/diffs");
const { firstChangedLine } = await import("../gui/src/lib/format");

afterAll(() => iso.cleanup());

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
const text = (l: string[]) => l.join("\n") + "\n";

describe("firstChangedLine", () => {
    test("an edit on line 4 opens at 4, not at the context above it", () => {
        const before = lines(20);
        const after = [...before];
        after[3] = "changed";
        const d = fileDiff("src/auth/index.ts", text(before), text(after));
        expect(d.hunks[0]!.newStart).toBe(1);
        expect(firstChangedLine(d)).toBe(4);
    });

    test("an insertion: the first added line", () => {
        const before = lines(20);
        const after = [...before.slice(0, 10), "new a", "new b", ...before.slice(10)];
        expect(firstChangedLine(fileDiff("a.ts", text(before), text(after)))).toBe(11);
    });

    test("a removal: where the removed text was", () => {
        const before = lines(20);
        const after = [...before.slice(0, 7), ...before.slice(9)];
        expect(firstChangedLine(fileDiff("a.ts", text(before), text(after)))).toBe(8);
    });

    test("several hunks: the first one's change", () => {
        const before = lines(60);
        const after = [...before];
        after[29] = "x";
        after[49] = "y";
        expect(firstChangedLine(fileDiff("a.ts", text(before), text(after)))).toBe(30);
    });

    test("a new file opens at 1; everything removed opens at 1; no hunks, no line", () => {
        expect(firstChangedLine(fileDiff("a.ts", null, "a\nb\n"))).toBe(1);
        expect(firstChangedLine(fileDiff("a.ts", "a\nb\n", ""))).toBe(1);
        expect(firstChangedLine({ hunks: [] })).toBeUndefined();
        expect(firstChangedLine(undefined)).toBeUndefined();
    });
});
