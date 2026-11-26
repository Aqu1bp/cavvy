// The file finder's small rules (gui/src/lib/file-view.ts): a line typed after a path, and a path as an @-mention.

import { describe, expect, test } from "bun:test";

const { withLine, mentionOf, viewFile } = await import("../gui/src/lib/file-view");
const { closeReview, review, setReview } = await import("../gui/src/state/ui");

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

describe("viewFile", () => {
    test("opened over the diff reader, closing it goes back to the reader; otherwise it closes", () => {
        setReview({ path: "src/a.ts", scope: "uncommitted" } as never);
        viewFile("src/b.ts", 3);
        expect(review()?.file).toEqual({ path: "src/b.ts", line: 3 });
        // A second file from the viewer still goes back to the same reader.
        viewFile("src/c.ts");
        closeReview();
        expect(review()).toEqual({ path: "src/a.ts", scope: "uncommitted" } as never);
        closeReview();
        expect(review()).toBeUndefined();
        viewFile("src/b.ts");
        closeReview();
        expect(review()).toBeUndefined();
    });
});
