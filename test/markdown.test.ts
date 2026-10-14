import { describe, expect, test } from "bun:test";
import { MarkdownStream, renderMarkdown } from "../src/ui/markdown";
import { colorEnabled, stripAnsi, width } from "../src/ui/ansi";
import { alsoRunInOtherColorMode } from "./helpers/color-mode";

const md = (src: string, cols = 60) => renderMarkdown(src, cols).map(stripAnsi);

/** Stream `src` in fixed-size deltas, calling pending() between pushes. */
function stream(src: string, chunk: number, cols = 60): { lines: string[]; pendingCalls: number } {
    const s = new MarkdownStream(cols);
    const out: string[] = [];
    let pendingCalls = 0;
    for (let i = 0; i < src.length; i += chunk) {
        out.push(...s.push(src.slice(i, i + chunk)));
        s.pending();
        pendingCalls++;
    }
    out.push(...s.finish());
    return { lines: out, pendingCalls };
}

describe("headings", () => {
    test("all levels render their text without the hashes", () => {
        expect(md("# Title\n## Sub\n### Third\n#### Four\n##### Five\n###### Six")).toEqual(["Title", "Sub", "Third", "Four", "Five", "Six"]);
    });

    test("closing hashes and surrounding spaces are removed", () => {
        expect(md("## Closed ##")).toEqual(["Closed"]);
        expect(md("   # Indented")).toEqual(["Indented"]);
    });

    test("a hash without a space is not a heading", () => {
        expect(md("#hashtag")).toEqual(["#hashtag"]);
    });

    test("headings are bold when colors are on", () => {
        const [h] = renderMarkdown("# Title", 60);
        if (colorEnabled) expect(h).toContain("\x1b[1m");
        else expect(h).toBe("Title");
    });

    test("inline markdown inside headings is rendered", () => {
        expect(md("## Use `code` **now**")).toEqual(["Use code now"]);
    });
});

describe("lists", () => {
    test("bullets change with nesting depth", () => {
        expect(md("- one\n- two\n  - nested\n    - deeper\n      - deepest")).toEqual(["• one", "• two", "  ◦ nested", "    ▪ deeper", "      • deepest"]);
    });

    test("*, + and - are all bullets", () => {
        expect(md("* star\n+ plus\n- dash")).toEqual(["• star", "• plus", "• dash"]);
    });

    test("ordered lists keep their numbers and delimiter", () => {
        expect(md("1. first\n2. second\n10. tenth\n1) paren")).toEqual(["1. first", "2. second", "10. tenth", "1) paren"]);
    });

    test("long items wrap with a hanging indent", () => {
        const lines = md("- the quick brown fox jumps over the lazy dog", 20);
        expect(lines[0]!.startsWith("• ")).toBe(true);
        for (const l of lines.slice(1)) expect(l.startsWith("  ")).toBe(true);
        expect(lines.join(" ").replace(/[•]/g, "").replace(/\s+/g, " ").trim()).toBe("the quick brown fox jumps over the lazy dog");
        for (const l of renderMarkdown("- the quick brown fox jumps over the lazy dog", 20)) expect(width(l)).toBeLessThanOrEqual(20);
    });

    test("inline markdown inside list items", () => {
        expect(md("- **bold** and `code`")).toEqual(["• bold and code"]);
    });
});

describe("task lists", () => {
    test("unchecked and checked boxes", () => {
        expect(md("- [ ] todo\n- [x] done\n- [X] Done too")).toEqual(["☐ todo", "☒ done", "☒ Done too"]);
    });

    test("nested task items keep their indentation", () => {
        expect(md("- [ ] parent\n  - [x] child")).toEqual(["☐ parent", "  ☒ child"]);
    });
});

describe("blockquotes", () => {
    test("quote bars per depth", () => {
        expect(md("> quoted text\n> > nested quote\n>no space")).toEqual(["│ quoted text", "│ │ nested quote", "│ no space"]);
    });

    test("long quotes wrap and every line keeps the bar", () => {
        const lines = md("> " + "word ".repeat(20).trim(), 30);
        expect(lines.length).toBeGreaterThan(1);
        for (const l of lines) expect(l.startsWith("│ ")).toBe(true);
        for (const l of renderMarkdown("> " + "word ".repeat(20).trim(), 30)) expect(width(l)).toBeLessThanOrEqual(30);
    });
});

describe("inline formatting", () => {
    test("code spans drop the backticks, including double-backtick spans", () => {
        expect(md("Use `code` and ``a ` b`` here")).toEqual(["Use code and a ` b here"]);
    });

    test("markdown inside code spans is literal", () => {
        expect(md("`**not bold**` and `_x_`")).toEqual(["**not bold** and _x_"]);
    });

    test("bold, italic, strike and combinations drop their markers", () => {
        expect(md("**bold** and *italic* and _under_ and __strong__ and ~~strike~~ and ***both***")).toEqual([
            "bold and italic and under and strong and strike and both",
        ]);
    });

    test("styling is applied when colors are on", () => {
        const [line] = renderMarkdown("**b** *i* ~~s~~", 60);
        if (colorEnabled) {
            expect(line).toContain("\x1b[1m");
            expect(line).toContain("\x1b[3m");
            expect(line).toContain("\x1b[9m");
        } else expect(line).toBe("b i s");
    });

    test("intraword underscores and arithmetic asterisks are left alone", () => {
        expect(md("snake_case_word and 2*3*4 and file_name.txt")).toEqual(["snake_case_word and 2*3*4 and file_name.txt"]);
    });

    test("backslash escapes", () => {
        expect(md("a \\*not italic\\* b \\`tick\\`")).toEqual(["a *not italic* b `tick`"]);
    });
});

describe("links", () => {
    test("inline links show the text and the URL (or an OSC 8 hyperlink)", () => {
        const [raw] = renderMarkdown("A [link](https://example.com) here", 80);
        const text = stripAnsi(raw!);
        if (raw!.includes("\x1b]8;;https://example.com")) expect(text).toBe("A link here");
        else expect(text).toBe("A link (https://example.com) here");
    });

    test("autolinks and bare URLs", () => {
        const text = md("<https://auto.link> and https://bare.example.com/path.", 100)[0]!;
        expect(text).toContain("https://auto.link");
        expect(text).not.toContain("<https://");
        expect(text).toContain("https://bare.example.com/path");
        expect(text.endsWith("path.")).toBe(true); // trailing punctuation is not part of the URL
    });

    test("a link whose text is its URL is not repeated", () => {
        expect(md("[https://e.com](https://e.com)", 80)).toEqual(["https://e.com"]);
    });

    test("images render as a placeholder", () => {
        expect(md("![alt text](img.png)", 80)[0]).toContain("[image: alt text]");
    });

    test("relative links show the target in parentheses", () => {
        expect(md("see [docs](./README.md)", 80)).toEqual(["see docs (./README.md)"]);
    });
});

describe("fenced code blocks", () => {
    test("code lines are rendered verbatim without the fences", () => {
        expect(md("```ts\nconst x = 1;\nfunction f() {}\n```\nafter")).toEqual(["const x = 1;", "function f() {}", "after"]);
    });

    test("code is syntax-highlighted when colors are on", () => {
        const lines = renderMarkdown("```ts\nconst x = 1;\n```", 60);
        expect(stripAnsi(lines[0]!)).toBe("const x = 1;");
        if (colorEnabled) expect(lines[0]).toContain("\x1b[");
    });

    test("tilde fences and indentation inside code", () => {
        expect(md("~~~py\ndef f():\n    return 1\n~~~")).toEqual(["def f():", "    return 1"]);
    });

    test("markdown syntax inside code is not interpreted", () => {
        expect(md("```\n# not a heading\n- not a list\n**not bold**\n| a | b |\n|---|---|\n```")).toEqual(["# not a heading", "- not a list", "**not bold**", "| a | b |", "|---|---|"]);
    });

    test("a shorter or different fence does not close the block", () => {
        expect(md("````\n```\nstill code\n````\nafter")).toEqual(["```", "still code", "after"]);
        expect(md("```\n~~~\nstill code\n```")).toEqual(["~~~", "still code"]);
    });

    test("an unterminated fence renders the rest as code", () => {
        expect(md("```\nunterminated code\n# still code")).toEqual(["unterminated code", "# still code"]);
    });

    test("long code lines are hard-wrapped at the column, not at spaces", () => {
        const lines = renderMarkdown("```\n" + "abc def ".repeat(10) + "\n```", 20);
        for (const l of lines) expect(width(l)).toBeLessThanOrEqual(20);
        expect(lines.map(stripAnsi).join("")).toBe("abc def ".repeat(10));
    });

    test("tabs in code are expanded", () => {
        expect(md("```\n\tindented\n```")).toEqual(["    indented"]);
    });

    test("blank lines inside code are kept", () => {
        expect(md("```\na\n\n\nb\n```")).toEqual(["a", "", "", "b"]);
    });
});

describe("tables", () => {
    const table = "| Name | Value |\n|------|------:|\n| a | 1 |\n| bb | 22 |";

    test("renders with box-drawing borders", () => {
        expect(md(table)).toEqual([
            "┌──────┬───────┐",
            "│ Name │ Value │",
            "├──────┼───────┤",
            "│ a    │     1 │",
            "│ bb   │    22 │",
            "└──────┴───────┘",
        ]);
    });

    test("center alignment and inline markdown in cells", () => {
        const lines = md("| left | mid |\n|:-----|:---:|\n| `x` | **y** |");
        expect(lines[3]).toBe("│ x    │  y  │");
    });

    test("cells wrap to fit the width, and every row has the same width", () => {
        const long = "| col | other |\n|---|---|\n| a fairly long cell that has to wrap onto several lines | text here |";
        const linked = "| col | other |\n|---|---|\n| [link](https://example.com/very/long/path/that/is/long) | text here |";
        for (const src of [long, linked]) {
            const lines = renderMarkdown(src, 30);
            const widths = lines.map(width);
            expect(new Set(widths).size).toBe(1);
            expect(widths[0]).toBeLessThanOrEqual(30);
        }
        const wrapped = md(long, 30);
        expect(wrapped.length).toBeGreaterThan(6);
        const column = (i: number) => wrapped.slice(3, -1).map((r) => r.split("│")[i]!.trim()).filter(Boolean).join(" ");
        expect(column(1)).toBe("a fairly long cell that has to wrap onto several lines");
        expect(column(2)).toBe("text here");
    });

    test("a pipe without a separator row is a paragraph", () => {
        expect(md("a | b not a table")).toEqual(["a | b not a table"]);
        expect(md("| a | b |\nplain")).toEqual(["| a | b |", "plain"]);
    });

    test("escaped pipes and pipes in code spans stay in the cell", () => {
        const lines = md("| a | b |\n|---|---|\n| x \\| y | `p|q` |");
        expect(lines[3]).toBe("│ x | y │ p|q │");
    });

    test("ragged rows get empty cells", () => {
        const lines = md("| a | b | c |\n|---|---|---|\n| 1 |");
        expect(lines[3]).toBe("│ 1   │     │     │");
    });

    test("the blank line after a table is kept, like after any other block", () => {
        expect(md(`${table}\n\nafter table`)).toEqual([
            "┌──────┬───────┐",
            "│ Name │ Value │",
            "├──────┼───────┤",
            "│ a    │     1 │",
            "│ bb   │    22 │",
            "└──────┴───────┘",
            "",
            "after table",
        ]);
    });
});

describe("horizontal rules and blank lines", () => {
    test("---, *** and ___ are rules of min(cols, 80) width", () => {
        expect(md("a\n\n---\n\nb", 40)).toEqual(["a", "", "─".repeat(40), "", "b"]);
        expect(md("***", 100)).toEqual(["─".repeat(80)]);
        expect(md("_ _ _", 30)).toEqual(["─".repeat(30)]);
    });

    test("runs of blank lines collapse to one; leading and trailing blanks are trimmed", () => {
        expect(md("\n\npara one\npara two\n\n\n\nafter\n\n")).toEqual(["para one", "para two", "", "after"]);
    });

    test("line breaks inside a paragraph are kept", () => {
        expect(md("line one\nline two")).toEqual(["line one", "line two"]);
    });

    test("CRLF input renders like LF input", () => {
        expect(md("# T\r\n\r\n- a\r\n- b\r\n")).toEqual(md("# T\n\n- a\n- b\n"));
    });

    test("paragraphs wrap to cols", () => {
        for (const l of renderMarkdown("word ".repeat(50), 33)) expect(width(l)).toBeLessThanOrEqual(33);
    });

    test("indented paragraph lines keep their indent on wrapped lines", () => {
        const lines = md("    indented para line that is long enough to wrap around the terminal width of forty", 40);
        expect(lines.length).toBeGreaterThan(1);
        for (const l of lines) expect(l.startsWith("    ")).toBe(true);
    });
});

describe("MarkdownStream", () => {
    const doc = [
        "# Hello *world*",
        "",
        "Some *text* with `code` that is long enough to wrap around at least once in a narrow terminal.",
        "and a second line.",
        "",
        "```ts",
        "const a = 1; // comment",
        "/* multi",
        "line */ let b = `tmpl",
        "still template`;",
        "```",
        "",
        "| h1 | h2 |",
        "|----|---:|",
        "| c1 | 22 |",
        "| longer cell | x |",
        "",
        "- item one",
        "  - nested [link](https://example.com)",
        "- [x] task",
        "",
        "> quote",
        "",
        "---",
        "",
        "End.",
    ].join("\n");

    test.each([1, 2, 3, 5, 7, 13, 64, 10_000])("streaming in %i-char deltas matches renderMarkdown", (n) => {
        const whole = renderMarkdown(doc, 50).map(stripAnsi);
        expect(stream(doc, n, 50).lines.map(stripAnsi)).toEqual(whole);
    });

    test("streaming matches renderMarkdown for a document ending in a table and one ending inside a code fence", () => {
        for (const src of ["text\n\n| a | b |\n|---|---|\n| 1 | 2 |", "intro\n```py\ndef f():\n    pass", "para\n"]) {
            for (const n of [1, 4, 9]) expect(stream(src, n).lines.map(stripAnsi)).toEqual(md(src));
        }
    });

    test("a delta that splits a line emits nothing until the newline arrives", () => {
        const s = new MarkdownStream(50);
        expect(s.push("Hello wor")).toEqual([]);
        expect(s.hasContent).toBe(true);
        expect(s.push("ld\nnext").map(stripAnsi)).toEqual(["Hello world"]);
        expect(s.finish().map(stripAnsi)).toEqual(["next"]);
    });

    test("a delta that splits a code fence marker", () => {
        const s = new MarkdownStream(50);
        expect(s.push("``")).toEqual([]);
        expect(s.push("`ts\nconst a")).toEqual([]);
        expect(s.push(" = 1;\n``").map(stripAnsi)).toEqual(["const a = 1;"]);
        expect(s.push("`\nafter\n").map(stripAnsi)).toEqual(["after"]);
        expect(s.finish()).toEqual([]);
    });

    test("pending() previews the partial line without consuming it", () => {
        const s = new MarkdownStream(50);
        s.push("Some **bold");
        expect(s.pending().map(stripAnsi)).toEqual(["Some **bold"]);
        s.push("** text");
        expect(s.pending().map(stripAnsi)).toEqual(["Some bold text"]);
        expect(s.pending().map(stripAnsi)).toEqual(["Some bold text"]); // idempotent
        expect(s.finish().map(stripAnsi)).toEqual(["Some bold text"]);
    });

    test("pending() inside a code block shows the partial code line", () => {
        const s = new MarkdownStream(50);
        s.push("```ts\nconst a");
        expect(s.pending().map(stripAnsi)).toEqual(["const a"]);
    });

    test("pending() shows a buffered table candidate until the table is complete", () => {
        const s = new MarkdownStream(50);
        expect(s.push("| a | b |\n")).toEqual([]);
        expect(s.pending().map(stripAnsi)).toEqual(["| a | b |"]);
        expect(s.push("|---|---|\n| 1 | 2 |\n")).toEqual([]);
        expect(s.pending().map(stripAnsi)).toEqual(["| a | b |", "|---|---|", "| 1 | 2 |"]);
        expect(s.finish().map(stripAnsi)).toEqual(["┌─────┬─────┐", "│ a   │ b   │", "├─────┼─────┤", "│ 1   │ 2   │", "└─────┴─────┘"]);
    });

    test("pending() is empty when nothing is buffered", () => {
        const s = new MarkdownStream(50);
        expect(s.pending()).toEqual([]);
        s.push("done\n");
        expect(s.pending()).toEqual([]);
    });

    test("finish() flushes the trailing partial line and trims trailing blanks", () => {
        const s = new MarkdownStream(50);
        s.push("last line without newline");
        expect(s.finish().map(stripAnsi)).toEqual(["last line without newline"]);
        const t = new MarkdownStream(50);
        expect(t.finish()).toEqual([]);
        expect(t.hasContent).toBe(false);
    });

    test("leading blank lines are not emitted", () => {
        const s = new MarkdownStream(50);
        expect(s.push("\n\n\nhello\n").map(stripAnsi)).toEqual(["hello"]);
    });

    test("CRLF inside one delta is treated as one newline", () => {
        const s = new MarkdownStream(50);
        expect(s.push("a\r\nb\r\n").map(stripAnsi)).toEqual(["a", "b"]);
    });

    test("a CRLF split across two deltas is still one newline", () => {
        const s = new MarkdownStream(50);
        const out = [...s.push("a\r"), ...s.push("\nb\r\n"), ...s.finish()];
        expect(out.map(stripAnsi)).toEqual(["a", "b"]);
    });
});

alsoRunInOtherColorMode(import.meta.path);
