// The review pane's hidden lines (gui/src/lib/diff-expand.ts): which runs a diff leaves out, and the diff with some
// of them put back from the whole file.
import { describe, expect, test } from "bun:test";
import { expand, gaps, shapeOf } from "../gui/src/lib/diff-expand";
import { fileDiff } from "../src/server/diffs";

const text = (n: number, change: (i: number) => string | undefined = () => undefined) => Array.from({ length: n }, (_, i) => change(i + 1) ?? `line ${i + 1}`).join("\n") + "\n";
const before = text(100);
const after = text(100, (i) => (i === 20 ? "line twenty" : i === 80 ? "line eighty" : undefined));
const shown = { ...fileDiff("f.txt", before, after), lines: 100 };
const full = fileDiff("f.txt", before, after, { context: Number.MAX_SAFE_INTEGER, maxLines: 20_000 });

describe("hidden lines", () => {
    test("the runs before, between and after the hunks", () => {
        expect(shown.hunks.map((h) => [h.newStart, h.newLines])).toEqual([[17, 7], [77, 7]]);
        expect(gaps(shown)).toEqual([
            { at: 0, newFrom: 1, oldFrom: 1, count: 16 },
            { at: 1, newFrom: 24, oldFrom: 24, count: 53 },
            { at: 2, newFrom: 84, oldFrom: 84, count: 17 },
        ]);
        // The file's length unknown: nothing after the last hunk.
        expect(gaps({ hunks: shown.hunks }).map((g) => g.at)).toEqual([0, 1]);
        // A hunk at the top and bottom of the file leaves nothing there.
        const whole = fileDiff("g.txt", "a\n", "b\n");
        expect(gaps({ ...whole, lines: 1 })).toEqual([]);
    });

    test("nothing open: the diff as it was, each hunk with the run before it", () => {
        const r = expand(shown, undefined, new Set());
        expect(r.hunks).toEqual(shown.hunks);
        expect(r.before.map((g) => g?.at)).toEqual([0, 1, 2]);
        expect(r.stale).toEqual([]);
    });

    test("opening the run between two hunks joins them into one", () => {
        const r = expand(shown, full, new Set([1]));
        expect(r.hunks.length).toBe(1);
        expect(r.hunks[0]).toMatchObject({ oldStart: 17, oldLines: 67, newStart: 17, newLines: 67 });
        expect(r.hunks[0]!.lines.filter((l) => l.t !== "ctx").map((l) => l.text)).toEqual(["line 20", "line twenty", "line 80", "line eighty"]);
        expect(r.before.map((g) => g?.at)).toEqual([0, 2]);
        // Every line, in order, numbered without a break.
        const news = r.hunks[0]!.lines.flatMap((l) => (l.b === undefined ? [] : [l.b]));
        expect(news).toEqual(Array.from({ length: 67 }, (_, i) => 17 + i));
    });

    test("opening the top and the end: the file from its first line to its last", () => {
        const r = expand(shown, full, new Set([0, 2]));
        expect(r.hunks.map((h) => [h.newStart, h.newLines])).toEqual([[1, 23], [77, 24]]);
        expect(r.before.map((g) => g?.at)).toEqual([undefined, 1, undefined]);
        expect(r.hunks[1]!.lines.at(-1)).toMatchObject({ text: "line 100", a: 100, b: 100 });
    });

    test("a run the whole file doesn't have as it was numbered stays hidden", () => {
        const moved = fileDiff("f.txt", before, "new first line\n" + after, { context: Number.MAX_SAFE_INTEGER });
        const r = expand(shown, moved, new Set([1]));
        expect(r.stale).toEqual([1]);
        expect(r.hunks).toEqual(shown.hunks);
    });

    test("a refreshed diff with other hunks has another shape", () => {
        const other = fileDiff("f.txt", before, text(100, (i) => (i === 50 ? "fifty" : undefined)));
        expect(shapeOf(shown)).not.toBe(shapeOf({ ...other, lines: 100 }));
        expect(shapeOf(shown)).toBe(shapeOf({ ...fileDiff("f.txt", before, after), lines: 100 }));
    });
});
