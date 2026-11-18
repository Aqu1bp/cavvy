// The file finder's small rules (gui/src/lib/file-view.ts): a line typed after a path, and a path as an @-mention.

import { describe, expect, test } from "bun:test";

const { withLine, mentionOf } = await import("../gui/src/lib/file-view");

describe("withLine", () => {
    test("a line (and a column) after the path", () => {
        expect(withLine("src/a.ts:12")).toEqual({ query: "src/a.ts", line: 12 });
        expect(withLine("a.ts:12:4")).toEqual({ query: "a.ts", line: 12 });
    });

    test("no line: the query as it is", () => {
        expect(withLine("src/a.ts")).toEqual({ query: "src/a.ts" });
        expect(withLine(":12")).toEqual({ query: ":12" });
        expect(withLine("a.ts:x")).toEqual({ query: "a.ts:x" });
    });
});

describe("mentionOf", () => {
    test("quoted when it has a space, as the @ menu writes it", () => {
        expect(mentionOf("src/a.ts")).toBe("@src/a.ts");
        expect(mentionOf("dir with space/a b.ts")).toBe('@"dir with space/a b.ts"');
    });
});
