// A reply's code block skipped out of sight is sized by its lines (gui/src/lib/code-metrics.ts, transcript.css): as
// many as it's drawn with.
import { expect, test } from "bun:test";
import { linesOf } from "../gui/src/lib/code-metrics";

test("a code block's lines: none when empty, a last newline starting none", () => {
    expect(linesOf("")).toBe(0);
    expect(linesOf("a")).toBe(1);
    expect(linesOf("a\n")).toBe(1);
    expect(linesOf("\n")).toBe(1);
    expect(linesOf("a\nb")).toBe(2);
    expect(linesOf("\n\na")).toBe(3);
    expect(linesOf("a\n   ")).toBe(2);
});
