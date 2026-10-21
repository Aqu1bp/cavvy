import { expect, test } from "bun:test";
import { columns, Heights, joinRanges, rowsIn, widest, wrappedLines } from "../gui/src/lib/diff-window";
import { highlightLineChunks, highlightLines } from "../gui/src/lib/highlight-core";

test("heights: guesses until measured, offsets sum both, and the row at a point", () => {
    const h = new Heights(5, (i) => (i === 2 ? 30 : 20));
    expect([0, 1, 2, 3, 4, 5].map((i) => h.offset(i))).toEqual([0, 20, 40, 70, 90, 110]);
    expect(h.set(1, 25)).toBe(true);
    expect(h.set(1, 25)).toBe(false);
    expect(h.measured(1)).toBe(true);
    expect(h.offset(2)).toBe(45);
    expect(h.total()).toBe(115);
    expect([0, 19, 20, 44.9, 45, 114, 500].map((y) => h.indexAt(y))).toEqual([0, 0, 1, 1, 2, 4, 4]);
    h.reset((i) => 10 + i);
    expect(h.measured(1)).toBe(false);
    expect(h.total()).toBe(60);
});

test("rows in view: the rows from top to bottom, with some either way", () => {
    const h = new Heights(1000, () => 20);
    expect(rowsIn(h, 0, 400, 0)).toEqual([0, 20]);
    expect(rowsIn(h, 2000, 2400, 200)).toEqual([90, 130]);
    expect(rowsIn(h, -500, -100, 0)).toEqual([0, 0]);
    expect(rowsIn(new Heights(0, () => 20), 0, 400, 100)).toEqual([0, -1]);
});

test("ranges join where they touch or overlap, in order", () => {
    expect(joinRanges([[10, 20], [3, 3], [21, 25], [5, 4], [18, 19], [40, 41]])).toEqual([[3, 3], [10, 25], [40, 41]]);
});

test("widest lines by columns: tabs to the next stop, wide characters as two", () => {
    expect(columns("ab\tc")).toBe(9);
    expect(columns("日本")).toBe(4);
    expect(widest(["short", "a much longer line here", "\t\t\tx", "日本語日本語日本語日本語"], 2)).toEqual(["\t\t\tx", "日本語日本語日本語日本語"]);
    expect(widest([], 3)).toEqual([]);
});

test("wrapped lines: at spaces and hyphens where it can, mid-word where it must", () => {
    expect(wrappedLines("", 10)).toBe(1);
    expect(wrappedLines("0123456789", 10)).toBe(1);
    expect(wrappedLines("aaaa bbbb cccc", 10)).toBe(2);
    expect(wrappedLines("aaaa-bbbb-cccc", 10)).toBe(2);
    expect(wrappedLines("x".repeat(25), 10)).toBe(3);
    expect(wrappedLines("ab " + "x".repeat(25), 10)).toBe(4);
});

test("highlighting in parts gives the lines one pass would, the first part early", async () => {
    // A block comment and a template string across the parts' seams: the grammar's state carries over.
    const lines = Array.from({ length: 1000 }, (_, i) => (i % 97 === 5 ? "/* open" : i % 97 === 9 ? "close */" : i % 53 === 3 ? "const s = `" : i % 53 === 7 ? "`;" : `const v${i} = f(${i}, "s");`));
    const code = lines.join("\n");
    // Warm: the first line a grammar ever tokenizes can run out of its time limit while the regexes compile.
    await highlightLines("const warm = 1;", "ts");
    const whole = await highlightLines(code, "ts");
    expect(whole?.length).toBe(1000);
    const parts: [number, number][] = [];
    const got: string[] = [];
    // A different text (a trailing space), so the cache doesn't answer.
    const done = await highlightLineChunks(`${code} `, "ts", (from, html) => {
        parts.push([from, html.length]);
        got.splice(from, html.length, ...html);
    }, () => false);
    expect(done).toBe(true);
    expect(parts[0]).toEqual([0, 80]);
    expect(parts.length).toBeGreaterThan(2);
    expect(got.slice(0, 999)).toEqual(whole!.slice(0, 999));
    // Stopped part way: no more parts, and nothing cached.
    let n = 0;
    expect(await highlightLineChunks(`${code}  `, "ts", () => n++, () => n >= 1)).toBe(false);
    expect(n).toBe(1);
});

test("highlighting in parts reads CRLF lines as one pass does: a heredoc closing at a part's last line closes", async () => {
    // A Ruby heredoc opening on line 71 and closing on line 80, the first part's last line.
    const lines = Array.from({ length: 100 }, (_, i) => (i === 70 ? "x = <<~EOF" : i > 70 && i < 79 ? `  text ${i}` : i === 79 ? "EOF" : `y${i} = ${i}`));
    const code = lines.join("\r\n");
    await highlightLines("warm = 1", "ruby");
    const whole = await highlightLines(code, "ruby");
    const got: string[] = [];
    // A different last line, so the cache doesn't answer.
    await highlightLineChunks(`${code} `, "ruby", (from, html) => got.splice(from, html.length, ...html), () => false);
    expect(got).toHaveLength(100);
    expect(got.slice(0, 99)).toEqual(whole!.slice(0, 99));
});
