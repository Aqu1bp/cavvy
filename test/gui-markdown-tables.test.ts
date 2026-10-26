// Tables in the GUI's markdown (gui/src/lib/markdown.ts): a column whose every
// cell is a number is marked .num (aligned right, header and all, by
// markdown.css); a column the reply aligned itself keeps that alignment.

import { describe, expect, test } from "bun:test";

const { MarkdownRenderer, numericColumn } = await import("../gui/src/lib/markdown");

function html(text: string): string {
    return new MarkdownRenderer()
        .segments(text, false)
        .map((s) => (s.kind === "html" ? s.html : ""))
        .join("");
}

/** Each row's cells as `tag.class|align:text`. */
function cells(out: string): string[][] {
    return [...out.matchAll(/<tr>(.*?)<\/tr>/g)].map((row) =>
        [...row[1]!.matchAll(/<(th|td)((?: [a-z]+="[^"]*")*)>(.*?)<\/\1>/g)].map(([, tag, attrs, body]) => {
            const cls = /class="([^"]*)"/.exec(attrs!)?.[1];
            const align = /align="([^"]*)"/.exec(attrs!)?.[1];
            return `${tag}${cls ? `.${cls}` : ""}${align ? `|${align}` : ""}:${body}`;
        }),
    );
}

describe("numeric columns", () => {
    test("counts, times, percentages, money and sizes are numbers", () => {
        for (const c of [["62", "1,204", "-3"], ["41.2s", "39.8 s", "120ms"], ["12%", "+4 %"], ["$4.50", "€1,200"], ["2.5 GB", "512KB"], ["1\u202f204"]]) expect(numericColumn(c)).toBe(true);
    });

    test("versions, ratios, dates, times of day and words aren't", () => {
        for (const c of [["0.42.1"], ["1/4"], ["2026-10-22"], ["10:30"], ["pass"], ["v2"], ["12 files"], ["#123"], ["62", "n/a", "yes"]]) expect(numericColumn(c)).toBe(false);
    });

    test("empty cells and dashes don't count against a column, but a column needs a number", () => {
        expect(numericColumn(["62", "", "—", "-", "n/a", "61"])).toBe(true);
        expect(numericColumn(["", "—"])).toBe(false);
        expect(numericColumn([])).toBe(false);
    });

    test("emphasis and code marks around a number leave it a number", () => {
        expect(numericColumn(["**62**", "`1,204`", "_3_"])).toBe(true);
    });
});

describe("rendered tables", () => {
    test("a numeric column is .num in its header and every cell; the others are left alone", () => {
        const out = html(["| Shard | Files | Time | Result |", "| --- | --- | --- | --- |", "| 1/4 | 62 | 41.2s | pass |", "| 2/4 | 61 | 39.8s | pass |"].join("\n"));
        expect(cells(out)).toEqual([
            ["th:Shard", "th.num:Files", "th.num:Time", "th:Result"],
            ["td:1/4", "td.num:62", "td.num:41.2s", "td:pass"],
            ["td:2/4", "td.num:61", "td.num:39.8s", "td:pass"],
        ]);
        expect(out.startsWith('<div class="md-table"><table><thead>')).toBe(true);
    });

    test("the reply's own alignment wins, and isn't doubled with .num", () => {
        const out = html(["| Name | Count | Note |", "| :--- | :---: | ---: |", "| a | 1 | x |"].join("\n"));
        expect(cells(out)).toEqual([
            ["th|left:Name", "th|center:Count", "th|right:Note"],
            ["td|left:a", "td|center:1", "td|right:x"],
        ]);
    });

    test("cells keep their inline markdown, and a short row's missing cell is still a cell", () => {
        const out = html(["| What | Size |", "| --- | --- |", "| **bold** `code` | 12 |", "| [link](https://example.com) | |"].join("\n"));
        const rows = cells(out);
        expect(rows[1]![0]).toBe("td:<strong>bold</strong> <code>code</code>");
        expect(rows[1]![1]).toBe("td.num:12");
        expect(rows[2]![0]).toContain('<a href="https://example.com"');
        expect(rows[2]![1]).toBe("td.num:");
    });
});
