import { describe, expect, test } from "bun:test";
import { SelectList, box, diffSummary, formatDuration, fuzzyScore, renderDiff, renderFilePreview, resultLines, type SelectItem } from "../src/ui/components";
import { colorEnabled, stripAnsi, theme, width } from "../src/ui/ansi";
import { alsoRunInOtherColorMode } from "./helpers/color-mode";

const plain = (lines: string[]) => lines.map(stripAnsi);
const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join("\n") + "\n";

describe("renderDiff", () => {
    const before = lines(10);
    const after = before.replace("line2\n", "line2 changed\n").replace("line9\n", "") + "line11\n";

    test("shows removed and added lines with signs and old/new line numbers", () => {
        const out = plain(renderDiff("f.ts", before, after, 60));
        expect(out.map((l) => l.trimEnd())).toEqual([
            " 1  line1",
            " 2 - line2",
            " 2 + line2 changed",
            " 3  line3",
            " 4  line4",
            " 5  line5",
            " 6  line6",
            " 7  line7",
            " 8  line8",
            " 9 - line9",
            " 9  line10",
            "10 + line11",
        ]);
    });

    test("no changes", () => {
        expect(plain(renderDiff("f.ts", "a\n", "a\n", 60))).toEqual(["(no changes)"]);
    });

    test("distant hunks are separated and far-away context is omitted", () => {
        const a = lines(40);
        const b = a.replace("line3\n", "LINE3\n").replace("line35\n", "LINE35\n");
        const out = plain(renderDiff("f.txt", a, b, 60)).map((l) => l.trimEnd());
        expect(out.filter((l) => /^\s+\.\.\.$/.test(l))).toHaveLength(1);
        expect(out.some((l) => /^\s*3 - line3$/.test(l))).toBe(true);
        expect(out.some((l) => /^\s*35 \+ LINE35$/.test(l))).toBe(true);
        expect(out.some((l) => l.endsWith("line20"))).toBe(false);
        // 3 lines of context on each side
        expect(out.some((l) => /^\s*6  line6$/.test(l))).toBe(true);
        expect(out.some((l) => /^\s*7  line7$/.test(l))).toBe(false);
    });

    test("respects maxLines and reports how many lines were cut", () => {
        const full = renderDiff("f.ts", before, after, 60);
        const cut = plain(renderDiff("f.ts", before, after, 60, { maxLines: 3 }));
        expect(cut).toHaveLength(4);
        expect(cut.slice(0, 3)).toEqual(plain(full.slice(0, 3)));
        expect(cut[3]).toBe(`… +${full.length - 3} lines`);
        expect(renderDiff("f.ts", before, after, 60, { maxLines: 100 })).toEqual(full);
    });

    test("context option", () => {
        const a = lines(20);
        const b = a.replace("line10\n", "LINE10\n");
        const out = plain(renderDiff("f.txt", a, b, 60, { context: 1 })).map((l) => l.trimEnd());
        expect(out).toEqual([" 9  line9", "10 - line10", "10 + LINE10", "11  line11"]);
    });

    test("every line fits in cols - 1, even with very long lines", () => {
        const a = "short\n" + "x".repeat(300) + "\n" + "日本語".repeat(50) + "\n";
        const b = "short\n" + "y".repeat(300) + "\n" + "日本語".repeat(49) + "テ\n";
        for (const cols of [40, 80, 120]) {
            for (const l of renderDiff("f.txt", a, b, cols)) expect(width(l)).toBeLessThanOrEqual(cols - 1);
        }
    });

    test("tabs are expanded in changed lines", () => {
        const out = plain(renderDiff("f.go", "a\n\tb\n", "a\n\tc\n", 60));
        expect(out.some((l) => l.includes("-     b"))).toBe(true);
    });

    test("paired changed lines get word-level highlighting when colors are on", () => {
        const out = renderDiff("f.txt", "the quick fox\n", "the slow fox\n", 60);
        const wordAdd = theme.diffAddedWord("X").split("X")[0]!;
        const wordDel = theme.diffRemovedWord("X").split("X")[0]!;
        if (colorEnabled) {
            expect(out.some((l) => l.includes(wordAdd + "slow"))).toBe(true);
            expect(out.some((l) => l.includes(wordDel + "quick"))).toBe(true);
        } else expect(wordAdd).toBe("");
    });

    test("new file and deleted file", () => {
        expect(plain(renderDiff("f.txt", "", "a\nb\n", 60)).map((l) => l.trimEnd())).toEqual(["1 + a", "2 + b"]);
        expect(plain(renderDiff("f.txt", "a\nb\n", "", 60)).map((l) => l.trimEnd())).toEqual(["1 - a", "2 - b"]);
    });
});

describe("diffSummary", () => {
    test("counts additions and removals", () => {
        expect(diffSummary("a\n", "b\nc\n")).toBe("2 additions and 1 removal");
        expect(diffSummary("a\n", "a\nb\n")).toBe("1 addition");
        expect(diffSummary("a\nb\n", "a\n")).toBe("1 removal");
        expect(diffSummary("a", "a")).toBe("no changes");
    });
});

describe("renderFilePreview", () => {
    test("a trailing newline does not add an extra line", () => {
        expect(plain(renderFilePreview("a.ts", "a\nb\n", 40, 10))).toEqual(["1  a", "2  b"]);
        expect(plain(renderFilePreview("a.ts", "a\nb", 40, 10))).toEqual(["1  a", "2  b"]);
    });

    test("an intentional blank last line is kept", () => {
        expect(plain(renderFilePreview("a.ts", "a\n\n", 40, 10))).toEqual(["1  a", "2  "]);
    });

    test("maxLines truncation and remaining-line count", () => {
        expect(plain(renderFilePreview("a.txt", "1\n2\n3\n4\n5\n", 40, 3))).toEqual(["1  1", "2  2", "3  3", "… +2 lines"]);
    });

    test("line numbers are padded to the widest shown number", () => {
        const out = plain(renderFilePreview("a.txt", lines(12), 40, 20));
        expect(out[0]).toBe(" 1  line1");
        expect(out[11]).toBe("12  line12");
    });

    test("long lines are truncated to fit and tabs expanded", () => {
        const out = renderFilePreview("a.txt", "x".repeat(200) + "\n\tt\n", 40, 10);
        for (const l of out) expect(width(l)).toBeLessThanOrEqual(40);
        expect(stripAnsi(out[0]!).endsWith("…")).toBe(true);
        expect(stripAnsi(out[1]!)).toBe("2      t");
    });

    test("content is highlighted for known languages but the text is unchanged", () => {
        const out = renderFilePreview("a.ts", "const x = 1;\n", 40, 10);
        expect(stripAnsi(out[0]!)).toBe("1  const x = 1;");
        if (colorEnabled) expect(out[0]).toContain(theme.synKeyword("const"));
    });
});

describe("fuzzyScore", () => {
    test("empty query matches everything", () => {
        expect(fuzzyScore("", "anything")).toBeGreaterThan(0);
    });

    test("non-matches are negative", () => {
        expect(fuzzyScore("xyz", "model")).toBeLessThan(0);
        expect(fuzzyScore("ledom", "model")).toBeLessThan(0);
    });

    test("case-insensitive", () => {
        expect(fuzzyScore("MOD", "model")).toBe(fuzzyScore("mod", "model"));
        expect(fuzzyScore("mod", "MODEL")).toBe(fuzzyScore("mod", "model"));
    });

    test("prefix beats word-boundary beats mid-word substring beats subsequence", () => {
        const prefix = fuzzyScore("mod", "model");
        const boundary = fuzzyScore("mod", "set model");
        const middle = fuzzyScore("mod", "commodity");
        const subseq = fuzzyScore("mod", "my_old_dog");
        expect(prefix).toBeGreaterThan(boundary);
        expect(boundary).toBeGreaterThan(middle);
        expect(middle).toBeGreaterThan(subseq);
        expect(subseq).toBeGreaterThan(0);
    });

    test("word boundaries include / : . _ -", () => {
        for (const sep of ["/", ":", ".", "_", "-"]) {
            expect(fuzzyScore("mod", `x${sep}model`)).toBeGreaterThan(fuzzyScore("mod", "xxmodel"));
        }
    });

    test("contiguous subsequences beat scattered ones", () => {
        expect(fuzzyScore("abc", "xabxc")).toBeGreaterThan(fuzzyScore("abc", "axbxc"));
    });

    test("shorter texts win ties", () => {
        expect(fuzzyScore("mod", "model")).toBeGreaterThan(fuzzyScore("mod", "modelling-and-more"));
    });
});

describe("SelectList", () => {
    const items: SelectItem[] = [
        { label: "alpha", value: "a" },
        { label: "beta", value: "b", disabled: true },
        { label: "gamma", value: "g" },
        { label: "delta", value: "d", description: "the fourth letter" },
    ];

    function walk(list: SelectList, delta: number, n: number): string[] {
        const seen: string[] = [];
        for (let i = 0; i < n; i++) {
            seen.push(list.current()!.value);
            list.move(delta);
        }
        return seen;
    }

    test("move wraps around in both directions and skips disabled items", () => {
        expect(walk(new SelectList(items), 1, 6)).toEqual(["a", "g", "d", "a", "g", "d"]);
        expect(walk(new SelectList(items), -1, 6)).toEqual(["a", "d", "g", "a", "d", "g"]);
    });

    test("initial selection, clamped, and skipping a disabled initial item", () => {
        expect(new SelectList(items, { initial: 2 }).current()?.value).toBe("g");
        expect(new SelectList(items, { initial: 99 }).current()?.value).toBe("d");
        expect(new SelectList(items, { initial: 1 }).current()?.value).toBe("g");
        expect(new SelectList([{ label: "x", value: 1, disabled: true }, { label: "y", value: 2 }]).current()?.value).toBe(2);
    });

    test("an empty list is safe", () => {
        const l = new SelectList<string>([]);
        expect(l.current()).toBeUndefined();
        l.move(1);
        l.page(1, 10);
        l.toggle();
        expect(plain(l.render(40, 5))).toEqual(["  No matches"]);
    });

    test("page moves by a page and clamps at the ends", () => {
        const many = Array.from({ length: 30 }, (_, i) => ({ label: `item ${i}`, value: i }));
        const l = new SelectList(many);
        l.page(1, 10);
        expect(l.current()?.value).toBe(10);
        l.page(1, 100);
        expect(l.current()?.value).toBe(29);
        l.page(-1, 100);
        expect(l.current()?.value).toBe(0);
    });

    test("setQuery filters, ranks, and resets the selection", () => {
        const l = new SelectList(items, { initial: 3 });
        l.setQuery("ta");
        expect(l.filtered().map((x) => x.item.label)).toEqual(["beta", "delta"]);
        expect(l.index).toBe(1); // "beta" is disabled, so the first enabled match is selected
        l.setQuery("alp");
        expect(l.filtered().map((x) => x.item.label)).toEqual(["alpha"]);
        l.setQuery("al"); // substring in "alpha" ranks above the subsequence in "delta ... letter"
        expect(l.filtered().map((x) => x.item.label)).toEqual(["alpha", "delta"]);
        l.setQuery("");
        expect(l.filtered()).toHaveLength(4);
    });

    test("filter matches keywords, group and description, and ranks better matches first", () => {
        const l = new SelectList([
            { label: "Sonnet", value: "s", keywords: "claude fast" },
            { label: "Opus", value: "o", description: "most capable" },
            { label: "capable-ish", value: "c" },
        ]);
        l.setQuery("fast");
        expect(l.current()?.value).toBe("s");
        l.setQuery("capable");
        expect(l.filtered().map((x) => x.item.value)).toEqual(["c", "o"]); // label prefix beats description
    });

    test("no matches", () => {
        const l = new SelectList(items);
        l.setQuery("zzz");
        expect(l.current()).toBeUndefined();
        l.move(1);
        expect(plain(l.render(40, 5))).toEqual(["  No matches"]);
    });

    test("after filtering, the selection skips a disabled first match", () => {
        const l = new SelectList(items);
        l.setQuery("ta"); // matches beta (disabled) and delta
        expect(l.current()?.value).toBe("d");
    });

    test("multi-select toggle and selected() in original order", () => {
        const l = new SelectList(items, { multi: true });
        expect(l.selected()).toEqual([]);
        l.move(1);
        l.move(1); // alpha -> gamma -> delta
        l.toggle();
        l.move(1); // wraps to alpha
        l.toggle();
        expect(l.selected().map((x) => x.value)).toEqual(["a", "d"]);
        l.toggle();
        expect(l.selected().map((x) => x.value)).toEqual(["d"]);
    });

    test("multi-select remembers selections across filtering", () => {
        const l = new SelectList(items, { multi: true });
        l.setQuery("gam");
        l.toggle();
        l.setQuery("del");
        l.toggle();
        l.setQuery("");
        expect(l.selected().map((x) => x.value)).toEqual(["g", "d"]);
        const out = plain(l.render(40, 10));
        expect(out.some((x) => x.includes("◉ gamma"))).toBe(true);
        expect(out.some((x) => x.includes("○ alpha"))).toBe(true);
    });

    test("toggle and selected() are no-ops without multi", () => {
        const l = new SelectList(items);
        l.toggle();
        expect(l.selected()).toEqual([]);
    });

    describe("render", () => {
        const many = Array.from({ length: 30 }, (_, i) => ({ label: `item ${i}`, value: i, detail: `d${i}`, description: `desc ${i}` }));
        const rowsOf = (out: string[]) => plain(out).filter((l) => /item \d+/.test(l));
        const selectedRow = (out: string[]) => plain(out).find((l) => l.startsWith("❯ "));

        test("marks the selected row and keeps it visible while scrolling down and up", () => {
            const l = new SelectList(many);
            for (let i = 0; i < 30; i++) {
                const out = l.render(40, 5);
                expect(selectedRow(out)).toContain(`item ${i} `);
                expect(rowsOf(out).length).toBeLessThanOrEqual(5);
                l.move(1);
            }
            // wrapped back to the top
            expect(selectedRow(l.render(40, 5))).toContain("item 0 ");
            l.move(-1);
            for (let i = 29; i >= 0; i--) {
                expect(selectedRow(l.render(40, 5))).toContain(`item ${i} `);
                l.move(-1);
            }
        });

        test("respects maxRows and shows a position line when there are more items", () => {
            const l = new SelectList(many, { initial: 20 });
            const out = plain(l.render(40, 5));
            expect(rowsOf(out)).toHaveLength(5);
            expect(out).toHaveLength(6);
            expect(out[5]).toContain("21/30");
            expect(out[5]).toContain("more below");
            l.move(9);
            expect(plain(l.render(40, 5))[5]).not.toContain("more below");
        });

        test("maxRows below 3 still shows 3 rows", () => {
            const l = new SelectList(many);
            expect(rowsOf(l.render(40, 1))).toHaveLength(3);
        });

        test("no position line when everything fits", () => {
            const l = new SelectList(items);
            expect(plain(l.render(40, 10))).toHaveLength(4);
        });

        test("every line fits in cols - 1 with long labels, descriptions and details", () => {
            const long = [
                { label: "x".repeat(80), value: 1, description: "d".repeat(100), detail: "detail" },
                { label: "日本語".repeat(10), value: 2, description: "説明".repeat(30) },
                { label: "short", value: 3, detail: "a very long detail column ".repeat(4) },
            ];
            for (const cols of [20, 40, 80, 120]) {
                const l = new SelectList(long, { multi: true });
                for (const line of l.render(cols, 10, { numbers: true, current: (v) => v === 2 })) expect(width(line)).toBeLessThanOrEqual(cols - 1);
            }
        });

        test("descriptions, details, numbers and the current-value check mark", () => {
            const l = new SelectList([
                { label: "one", value: 1, description: "first", detail: "D1" },
                { label: "two", value: 2 },
            ]);
            const out = plain(l.render(40, 10, { numbers: true, current: (v) => v === 2 }));
            expect(out[0]!.startsWith("❯ 1. one")).toBe(true);
            expect(out[0]).toContain("first");
            expect(out[0]!.trimEnd().endsWith("D1")).toBe(true);
            expect(out[1]).toContain("2. two ✔");
        });

        test("group headers appear when the group changes, and not while filtering", () => {
            const l = new SelectList([
                { label: "a", value: 1, group: "G1" },
                { label: "b", value: 2, group: "G1" },
                { label: "c", value: 3, group: "G2" },
            ]);
            expect(plain(l.render(40, 10)).map((x) => x.trimEnd())).toEqual(["G1", "❯ a", "  b", "G2", "  c"]);
            l.setQuery("c");
            expect(plain(l.render(40, 10)).map((x) => x.trimEnd())).toEqual(["❯ c"]);
        });
    });
});

describe("box", () => {
    test("wraps content inside a titled frame that fits cols", () => {
        const out = box(["hello world this is a long line that wraps"], 20, (s) => s, "Title");
        expect(plain(out)).toEqual(["╭─ Title ──────────╮", "│ hello world this │", "│ is a long line   │", "│ that wraps       │", "╰──────────────────╯"]);
        for (const l of out) expect(width(l)).toBe(20);
    });
});

describe("resultLines / formatDuration", () => {
    test("resultLines shows the first lines and how many were hidden", () => {
        expect(plain(resultLines("a\nb\nc\nd\n\n", 40, 2))).toEqual(["  ⎿  a", "     b", "     … +2 lines (ctrl+o to expand)"]);
        for (const l of resultLines("x".repeat(200), 40, 5)) expect(width(l)).toBeLessThanOrEqual(40);
    });

    test("formatDuration", () => {
        expect(formatDuration(5_400)).toBe("5s");
        expect(formatDuration(65_000)).toBe("1m 5s");
        expect(formatDuration(3_700_000)).toBe("1h 1m");
    });
});

alsoRunInOtherColorMode(import.meta.path);
