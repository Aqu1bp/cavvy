import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MarkdownRenderer, settle } from "../gui/src/lib/markdown";
import { LAG_MS, lagFor, MAX_LAG_MS, nextGap, revealEnd, revealStep } from "../gui/src/lib/reveal";
import { TRAIL_MS, trailTier } from "../gui/src/lib/stream-dom";
import { Lexer, Marked } from "../gui/node_modules/marked/lib/marked.esm.js";

// A finished reply's render is kept by its text for every renderer, so one compared with it comes from a module of its own.
const { MarkdownRenderer: Fresh } = (await import("../gui/src/lib/markdown.ts?fresh")) as { MarkdownRenderer: typeof MarkdownRenderer };
const visible = (r: MarkdownRenderer, text: string, streaming = true) => r.segments(text, streaming).map((s) => s.kind === "html" ? { kind: s.kind, html: s.html } : { kind: s.kind, lang: s.lang, code: s.code, open: s.open });

test("incremental Markdown agrees with a fresh parse at every streamed character", () => {
    const cases = [
        "| - | - |\n    indented\n-",
        "~~~\n---\n~~~\n| - | - |\n    indented\n-",
        "> b\n--", "- b\n*a", "> a\n**", "\\\n<a>\n- b",
        "- a\n\n-", "- a\n\n- b", "> a\n\n> b", "    a\n\n    b",

        "# Heading\n\nFirst **bold** and *italic* paragraph.\n\nNext _paragraph_.\n\n",
        "Before\n\nHeading\n===\n\nAfter\n",
        "Before\n\n| a | b |\n| --- | --- |\n| x | y |\n\nAfter",
        "Before\n\n- one\n  continued\n\n- two\n  - nested\n\nAfter",
        "Before\n\n> quote\n>\n> more\n\nAfter",
        "Before\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter",
        "Before\n\n~~~js\ncode\n~~~\n\n    indented\n    code\n\nAfter",
        "Before\n\n<!-- html\n\nmore -->\n\nAfter",
        "Before\n\n<div>\ntext\n</div>\n\nAfter",
        "[later]\n\nParagraph\n\n[later]: https://example.com\n",
        // A definition inside a quote or a list counts too, as does one split over two lines.
        "[later]\n\nParagraph\n\n> [later]: https://example.com\n",
        "[later]\n\nParagraph\n\n- [later]: https://example.com\n",
        "[later]\n\nParagraph\n\n[later]:\nhttps://example.com\n",
        // Inline links, checkboxes and citations depend on nothing later in the text.
        "See [one](https://example.com/1) first.\n\nThen [two](https://example.com/2) and [three][].\n\n- [ ] todo\n- [x] done\n\nAs noted [1].\n\nThe end.",
        "Before\r\n\r\n- item\r\n\r\nAfter",
        "Before\n\n---\n\nAfter with https://example.com and `inline`.",
        "Before\n\n1. ordered\n2. second\n\n    code\n\nAfter",
        // Inline HTML carries state (e.g. an open <a>) across blank lines.
        "prefix <a>\n\nhttps://example.com",
        // What settle() holds back or closes while the reply streams.
        "Done.\n\nStreams **every event** and `inline` code, *em* and ~~gone~~.\n\n1. **Prompt** — `Composer`\n2. **Model call** — opens a stream\n   - text deltas\n   - tool calls\n\nAfter.",
        "Intro.\n\n## What each side owns\n\n| Part | Owns |\n| --- | --- |\n| Server | sessions |\n| GUI | scroll |\n\nThe end.",
        "Para.\n\n```ts\nconst a = `x`;\n```\n\n---\n\nSee docs and snake_case_names.",
        // A fence in a list item ends with the item: what's after isn't read as code still open.
        "- ```\n  code\n  ```\n\nAfter.\n\n- b",
        "1. ```ts\n  open\n\n- b",
        "- a\n  ```\n  open\n- b\n\nAfter.\n\n-",
    ];
    for (const sample of cases) {
        const incremental = new MarkdownRenderer();
        for (let i = 0; i <= sample.length; i++) {
            const text = sample.slice(0, i);
            expect(visible(incremental, text)).toEqual(visible(new MarkdownRenderer(), text));
        }
        expect(visible(incremental, sample, false)).toEqual(visible(new Fresh(), sample, false));
        // Edits, truncation and replacements must abandon the append cache.
        for (const edited of [sample.slice(0, 10), "replacement\n\n```ts\nx", sample]) {
            expect(visible(incremental, edited)).toEqual(visible(new MarkdownRenderer(), edited));
        }
    }
});

test("long Markdown lexes only the growing block on append, with safe full-parse fallback", () => {
    // Compile the real renderer with a counted lexer, keeping the parser intact.
    let chars = 0;
    class CountedMarked extends Marked {
        constructor(options: any) {
            super(options);
            const lexer = this.lexer.bind(this);
            this.lexer = (text: string, options?: any) => { chars += text.length; return lexer(text, options); };
        }
    }
    const source = readFileSync(process.env.MARKDOWN_BEFORE ?? new URL("../gui/src/lib/markdown.ts", import.meta.url), "utf8").replace(/^import .*;\n/gm, "").replace(/export /g, "");
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    // Renderer is used for plain escaping as well as by Marked.
    const { Renderer } = require("../gui/node_modules/marked/lib/marked.esm.js");
    const Counted = new Function("Marked", "Renderer", `${js}; return MarkdownRenderer;`)(CountedMarked, Renderer);
    const r = new Counted();
    // Enough that lexing the whole text on each update is far past the threshold below.
    // Under Bun, marked's block lexer takes quadratic time on long text, so no bigger than that.
    const paragraphs = 500;
    let text = Array.from({ length: paragraphs }, (_, i) => `Paragraph ${i}.\n\n`).join("");
    r.segments(text, true);
    chars = 0;
    const start = performance.now();
    for (let i = 0; i < 100; i++) { text += "word "; r.segments(text, true); }
    console.log(JSON.stringify({ paragraphs, updates: 100, lexedChars: chars, elapsedMs: performance.now() - start }));
    expect(chars).toBeLessThan(30_000); // About 25,000 chars; the old full lexer reads over 800,000.
    chars = 0;
    r.segments(text + "\n\n[ref]: https://example.com", true);
    expect(chars).toBeGreaterThan(text.length);
    // Links in the text don't change that: only a definition can reach back.
    const linked = new Counted();
    text = Array.from({ length: paragraphs }, (_, i) => `Paragraph [${i}](https://example.com/${i}).\n\n`).join("");
    linked.segments(text, true);
    chars = 0;
    for (let i = 0; i < 100; i++) { text += "word "; linked.segments(text, true); }
    expect(chars).toBeLessThan(30_000);
});

test("code that reads like a link definition, an open code block, and the end of the reply aren't lexed whole again", () => {
    let chars = 0;
    const lexer = Marked.prototype.lexer;
    Marked.prototype.lexer = function (this: unknown, src: string, ...rest: unknown[]) { chars += src.length; return (lexer as any).call(this, src, ...rest); } as any;
    const stream = (text: string) => {
        const r = new MarkdownRenderer();
        chars = 0;
        for (let at = 0, n = 0; at < text.length; at += 4 + (n++ * 7) % 37) r.segments(text.slice(0, at), true);
        r.segments(text, false);
        return chars / text.length;
    };
    try {
        const prose = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} says what it does and why, in a sentence or two.\n\n`).join("");
        // "]:" is in code all the time; it used to make every later update lex the whole reply.
        expect(stream("```ts\ninterface Bag {\n    [key: string]: number;\n}\n```\n\n" + prose)).toBeLessThan(5);
        expect(stream("```py\ndef f(x) -> dict[str, int]:\n    pass\n```\n\n" + prose)).toBeLessThan(5);
        // A long code block, written a few characters at a time.
        const code = "Here it is.\n\n```ts\n" + Array.from({ length: 300 }, (_, i) => `    const part${i} = input.slice(${i}).trim();\n`).join("") + "```\n\nDone.";
        expect(stream(code)).toBeLessThan(2);
        // A list, a quote and a table are closed by the text that starts after them.
        const blocks = Array.from({ length: 20 }, (_, i) => `- item ${i}\n- another\n\n> quoted ${i}\n\n| a | b |\n| --- | --- |\n| ${i} | x |\n\nText ${i}.\n\n`).join("");
        expect(stream(blocks)).toBeLessThan(6);
    } finally {
        Marked.prototype.lexer = lexer;
    }
});

test("a list's last item, one line of text, is lexed a piece at a time as it's written", () => {
    // Lexed whole with each chunk (as marked lexes an item), a list of long items was read 3.6 times a character.
    let chars = 0;
    const lexer = Marked.prototype.lexer;
    const lexInline = (Lexer as any).lexInline;
    Marked.prototype.lexer = function (this: unknown, src: string, ...rest: unknown[]) { chars += src.length; return (lexer as any).call(this, src, ...rest); } as any;
    (Lexer as any).lexInline = (src: string, options: unknown) => { chars += src.length; return lexInline(src, options); };
    try {
        const text = "The steps:\n\n" + Array.from({ length: 40 }, (_, i) => `- **Step ${i}**: read \`src/part${i}.ts\` and say what it changes and why, in a sentence that runs to a long line.\n`).join("") + "\nDone.";
        const r = new MarkdownRenderer();
        for (let at = 0, n = 0; at < text.length; at += 4 + (n++ * 7) % 37) r.segments(text.slice(0, at), true);
        expect(chars / text.length).toBeLessThan(1.7);
    } finally {
        Marked.prototype.lexer = lexer;
        (Lexer as any).lexInline = lexInline;
    }
});

/** How many times each character of `text` is lexed, streamed in uneven chunks and then finished. */
function lexedPerCharacter(text: string): { streamed: number; finished: number } {
    let chars = 0;
    const lexer = Marked.prototype.lexer;
    const lexInline = (Lexer as any).lexInline;
    Marked.prototype.lexer = function (this: unknown, src: string, ...rest: unknown[]) { chars += src.length; return (lexer as any).call(this, src, ...rest); } as any;
    (Lexer as any).lexInline = (src: string, options: unknown) => { chars += src.length; return lexInline(src, options); };
    try {
        const r = new MarkdownRenderer();
        for (let at = 0, n = 0; at < text.length; at += 4 + (n++ * 7) % 37) r.segments(text.slice(0, at), true);
        const streamed = chars;
        r.segments(text, false);
        return { streamed: streamed / text.length, finished: (chars - streamed) / text.length };
    } finally {
        Marked.prototype.lexer = lexer;
        (Lexer as any).lexInline = lexInline;
    }
}

test("a table's rows are lexed once each as they're written, without its header", () => {
    // Lexed with its header and the row before, each row was read about 4 times (5 with the finished reply's lex).
    const text = "Results:\n\n| Name | Value | Notes |\n|---|---|---|\n" + Array.from({ length: 60 }, (_, i) => `| row ${i} | ${i * 7} | \`code${i}\` and **bold** text |\n`).join("") + "\nDone.";
    expect(lexedPerCharacter(text).streamed).toBeLessThan(1.6);
});

test("a paragraph of many lines is lexed a piece at a time, not whole with each chunk", () => {
    // Lexed whole with each chunk, a 30-line paragraph was read 39 times a character.
    const text = Array.from({ length: 30 }, (_, i) => `Line ${i} of one long paragraph with **bold** words in it.`).join("\n") + "\n\nDone.";
    expect(lexedPerCharacter(text).streamed).toBeLessThan(1.5);
});

test("a finished reply isn't lexed again where its last update held nothing back", () => {
    // Its last block, a list or a table, was lexed once more when the reply finished.
    for (const text of ["The steps:\n\n" + Array.from({ length: 20 }, (_, i) => `- Step ${i} reads \`part${i}.ts\` and says why.`).join("\n"), "| a | b |\n|---|---|\n" + Array.from({ length: 30 }, (_, i) => `| ${i} | x${i} |`).join("\n") + "\n"]) {
        expect(lexedPerCharacter(text).finished).toBeLessThan(0.1);
    }
});

test("a paragraph over several lines streams as a fresh parse would, whatever its marks and the lines that end it", () => {
    const lines = ["Some words here", "more words *em", "and close* it", "with `code` in", "a **bold\nacross** lines", "trailing two  ", "trailing one ", "===", "---", "a | b", "--- | ---", "<div>", "<di", ">x quoted", "1. item", "1x not item", "12 apples", "- dash", "    indented", "", "# head", "```", "x_y_z words", "(paren start", "*a*"];
    const marks = ["`", "``", "`a", "a`", "*", "**", "***", "_", "__", "*a", "a*", "**a", "a**", "a*b", "word"];
    let seed = 3;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    for (let n = 0; n < 300; n++) {
        const line = () => (rand() < 0.4 ? ["Then", ...Array.from({ length: 2 + Math.floor(rand() * 8) }, () => pick(marks))].join(" ") : pick(rand() < 0.6 ? lines.slice(0, 7) : lines));
        const sample = Array.from({ length: 2 + Math.floor(rand() * 7) }, line).join("\n") + pick(["", "\n", "\n\nEnd.", " more"]);
        const incremental = new MarkdownRenderer();
        for (let i = 0; i <= sample.length; i += 1 + Math.floor(rand() * 5)) {
            const text = sample.slice(0, i);
            expect({ text, seen: visible(incremental, text) }).toEqual({ text, seen: visible(new Fresh(), text) });
        }
        visible(incremental, sample);
        expect({ sample, seen: visible(incremental, sample, false) }).toEqual({ sample, seen: visible(new Fresh(), sample, false) });
    }
}, 60_000);

test("a code block once closed isn't lexed again with what's written after it", () => {
    // Lexed with the block after it, a closed block was read once more for each block that followed a code block.
    let code = 0;
    const lexer = Marked.prototype.lexer;
    Marked.prototype.lexer = function (this: unknown, src: string, ...rest: unknown[]) {
        if (src.startsWith("```")) code += src.indexOf("```\n\n", 3) + 5;
        return (lexer as any).call(this, src, ...rest);
    } as any;
    try {
        const block = (i: number) => "```ts\n" + Array.from({ length: 8 }, (_, k) => `const part${i}_${k} = input.slice(${k}).trim();\n`).join("") + "```\n\n";
        const after = ["| a | b |\n| --- | --- |\n| 1 | 2 |\n\n", "Text after it, a sentence or two long.\n\n", "- an item\n- another\n\n", "## A heading\n\n"];
        const text = Array.from({ length: 20 }, (_, i) => block(i) + after[i % after.length]).join("");
        const r = new MarkdownRenderer();
        for (let at = 0, n = 0; at < text.length; at += 4 + (n++ * 7) % 37) r.segments(text.slice(0, at), true);
        const written = Array.from({ length: 20 }, (_, i) => block(i).length).reduce((a, b) => a + b, 0);
        expect(code / written).toBeLessThan(1.1);
    } finally {
        Marked.prototype.lexer = lexer;
    }
});

test("incremental Markdown agrees with a fresh parse on replies made of every kind of block", () => {
    const pieces = [
        "Para one.", "Para with *em* and `code`.", "# H1", "Setext\n===", "Setext two\n---", "---",
        "- a\n- b", "- a\n\n- b", "1. one\n2. two", "- a\n  continued", "- a\n\n  indented para", "- a\n    - deep\n- b",
        "> quote", "> q\nlazy", "> q\n>\n> more", "| a | b |\n| --- | --- |\n| 1 | 2 |",
        "    indented code", "```\nfence\n```", "```ts\nconst x: { [k: string]: number } = {};\n```", "~~~py\ndef f(x) -> dict[str, int]:\n    pass\n~~~", "```  ts  \nx\n```",
        "<div>\nhtml\n</div>", "<!-- c\n\nstill -->", "[ref]: https://example.com", "See [ref] and [x][ref].",
        "Text\n- list right after", "Text\n> quote right after", "  two-space para", "\tTabbed", "-", "1.", "#", ">",
    ];
    let seed = 1;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let n = 0; n < 250; n++) {
        const parts = Array.from({ length: 3 + Math.floor(rand() * 7) }, () => pieces[Math.floor(rand() * pieces.length)]!);
        const sample = parts.map((p, i) => p + (i < parts.length - 1 ? ["\n\n", "\n", "\n\n\n"][Math.floor(rand() * 3)] : "")).join("");
        const incremental = new MarkdownRenderer();
        for (let i = 0; i <= sample.length; i++) {
            const text = sample.slice(0, i);
            expect({ text, seen: visible(incremental, text) }).toEqual({ text, seen: visible(new MarkdownRenderer(), text) });
        }
        expect({ sample, seen: visible(incremental, sample, false) }).toEqual({ sample, seen: visible(new Fresh(), sample, false) });
    }
});

test("a long list written a character at a time renders as a fresh parse would, however its items read", () => {
    // Only a list's last item is lexed again as it grows (markdown.ts listTail): what's before it, its looseness and
    // where it ends must come out as the whole list lexed again would.
    const items = [
        "- a", "- **bold** item with `code`", "- [ ] task", "- [x] done task", "* star", "+ plus", "1. one", "2) paren", "10. ten",
        "- a\n  continued", "- a\nlazy line", "- a\n\n  second para", "- a\n  - nested\n  - more", "- a\n    - deep",
        "- a\n\n      indented code", "- ```\n  code\n  ```", "- ```ts\n  open fence", "- a\n  > quote", "- a\n  | t | u |\n  | - | - |\n  | 1 | 2 |",
        "- a\n  ```\n  open", "- a\n  ~~~\n  x\n  ~~~", "- a\n  - ```sh\n    nested", "- - -", "* * *", "-", "1.", "- # heading", "-   wide", "- a\n---", "- a\n===", "- <div>", "- see [x](https://example.com)",
    ];
    const joins = ["\n", "\n", "\n", "\n\n", "\n\n\n", "\n  ", "\n\nAfter.\n\n"];
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)]!;
    for (let n = 0; n < 300; n++) {
        // Mostly one kind of marker, as a list is written; sometimes another.
        const kind = pick(["- ", "* ", "1. ", "2) "]);
        const parts = Array.from({ length: 3 + Math.floor(rand() * 8) }, () => {
            const item = pick(items);
            return rand() < 0.7 ? item.replace(/^(?:[-*+]|\d+[.)]) /, kind) : item;
        });
        const sample = (rand() < 0.5 ? "Intro.\n\n" : "") + parts.map((p, i) => p + (i < parts.length - 1 ? (rand() < 0.75 ? "\n" : pick(joins)) : "")).join("");
        const incremental = new MarkdownRenderer();
        for (let i = 0; i <= sample.length; i++) {
            const text = sample.slice(0, i);
            expect({ text, seen: visible(incremental, text) }).toEqual({ text, seen: visible(new MarkdownRenderer(), text) });
        }
        expect({ sample, seen: visible(incremental, sample, false) }).toEqual({ sample, seen: visible(new Fresh(), sample, false) });
    }
}, 120_000);

test("a table written a character at a time renders as a fresh parse would, whatever its rows", () => {
    // Only a table's last row is lexed again as it grows, with its header (markdown.ts tableTail).
    const heads = ["| a | b |\n| --- | --- |", "| a | b | c |\n|:--|:-:|--:|", "a | b\n--- | ---", "| a |\n|---|", "| a | b |\n| - |"];
    const rows = ["| 1 | 2 |", "| **x** | `y` |", "| 1 | 2 | 3 | 4 |", "| 1 |", "1 | 2", "|  |  |", "| a \\| b | c |", "| [l](https://e.com) | x |", "| - | - |", "|", "| ``` | x |", "- item", "> q", "```", "# h", "    code"];
    const joins = ["\n", "\n", "\n", "\n", "\n\n", "\n\nAfter.\n\n"];
    let seed = 11;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)]!;
    for (let n = 0; n < 200; n++) {
        const parts = [pick(heads), ...Array.from({ length: 2 + Math.floor(rand() * 8) }, () => (rand() < 0.75 ? pick(rows.slice(0, 9)) : pick(rows)))];
        const sample = pick(["", "Intro.\n\n", "Intro.\n", "| x |\n\n", "- a\n\n"]) + parts.map((p, i) => p + (i < parts.length - 1 ? (i === 0 || rand() < 0.8 ? "\n" : pick(joins)) : "")).join("") + pick(["", "\n", "\n\nEnd."]);
        const incremental = new MarkdownRenderer();
        for (let i = 0; i <= sample.length; i++) {
            const text = sample.slice(0, i);
            expect({ text, seen: visible(incremental, text) }).toEqual({ text, seen: visible(new MarkdownRenderer(), text) });
        }
        expect({ sample, seen: visible(incremental, sample, false) }).toEqual({ sample, seen: visible(new Fresh(), sample, false) });
    }
}, 120_000);

test("a long paragraph written a word at a time renders as a fresh parse would, whatever its inline marks", () => {
    // What a line of a reply or of reasoning holds: a paragraph's words before the last space are rendered once, so
    // nothing written after may change how they read.
    const words = [
        "word", "another", "x", "1", "2024", "a.b", "end.", "(aside)", "—", "naïve", "日本語",
        "`code`", "``co`de``", "`a b`", "`open", "```", "``", "**bold**", "**two words**", "*em*", "_em_", "__strong__", "*", "**", "_", "__",
        "a*b*c", "snake_case_name", "_init_", "**open", "*open", "close**", "close*", "~~gone~~", "~single~", "~", "~~",
        "src/lib/markdown.ts:42", "./x.ts", "~/notes.md", "missing/file.ts", "https://example.com/a_b_c", "www.example.com", "me@example.com",
        "[link](https://example.com)", "[text]", "]", "[", "<b>", "<", ">", "a<b", "\\*", "\\", "&amp;", "&", "|", "a|b", "#", "1.", "-", "+",
        "!", "![img](x.png)", "\"quoted\"", "'single'",
    ];
    // Marks alone, densely: code spans of every length against each other, and emphasis of every kind.
    const marks = ["`", "``", "```", "`a", "a`", "``a", "a``", "`a b`", "*", "**", "***", "_", "__", "*a", "a*", "**a", "a**", "_a", "a_", "a", "b", "a*b", "a_b"];
    const known = new Set(["src/lib/markdown.ts", "./x.ts"]);
    const look = (p: string) => (known.has(p) ? `/repo/${p.replace(/^\.\//, "")}` : p.startsWith("missing/") ? null : undefined);
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    for (let n = 0; n < 400; n++) {
        const line = () => {
            const first = pick(["Then", "The", "Now", "**Note:**", "*Aside*", "`x`", "_why_", "2 things", "Ok"]);
            const from = n % 2 ? marks : words;
            return [first, ...Array.from({ length: 4 + Math.floor(rand() * 30) }, () => pick(from))].join(pick([" ", " ", " ", "  "]));
        };
        const sample = Array.from({ length: 1 + Math.floor(rand() * 3) }, line).join(pick(["\n\n", "\n\n", "\n"])) + pick(["", " ", "  ", "*", "`"]);
        for (const l of [undefined, look]) {
            const incremental = new MarkdownRenderer();
            const fresh = (text: string, streaming = true) => new Fresh().segments(text, streaming, l).map((s) => (s.kind === "html" ? s.html : s.code));
            for (let i = 0; i <= sample.length; i += 1 + Math.floor(rand() * 3)) {
                const text = sample.slice(0, i);
                expect({ text, seen: incremental.segments(text, true, l).map((s) => (s.kind === "html" ? s.html : s.code)) }).toEqual({ text, seen: fresh(text) });
            }
            expect({ sample, seen: incremental.segments(sample, false, l).map((s) => (s.kind === "html" ? s.html : s.code)) }).toEqual({ sample, seen: fresh(sample, false) });
        }
    }
}, 60_000);

/** What a reader would see of the non-code blocks: text with the tags taken out. */
const prose = (r: MarkdownRenderer, text: string) => r.segments(text, true).filter((s) => s.kind === "html").map((s) => (s as { html: string }).html.replace(/<code>[^<]*<\/code>/g, "").replace(/<[^>]+>/g, "")).join("\n");

test("a streaming reply never shows a marker as raw text on its way to being formatted", () => {
    const reply = [
        "The engine streams **every event** back, and `sendPrompt()` sends it.",
        "",
        "1. **Prompt** — `Composer` sends it",
        "2. **Model call** — the engine opens a stream to the provider",
        "   - text deltas append to the last block",
        "",
        "## What each side owns",
        "",
        "| Part | Owns |",
        "| --- | --- |",
        "| Server | sessions |",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "If a reply is cut off, *resume* picks it up.",
    ].join("\n");
    const r = new MarkdownRenderer();
    for (let i = 1; i <= reply.length; i++) {
        const seen = prose(r, reply.slice(0, i));
        expect({ i, seen, raw: /\*|`|\||^#|^\s*-\s*$|^\d+\s*$/m.test(seen) }).toEqual({ i, seen, raw: false });
        // A list item never reads as a heading on its way (a "-" under it is a setext underline until it has text).
        expect(r.segments(reply.slice(0, i), true).some((s) => s.kind === "html" && /<li>[^]*<h2/.test(s.html))).toBe(false);
    }
});

test("settle holds back what isn't readable yet and closes what's still open", () => {
    const cases: [string, string][] = [
        ["streams **every", "streams **every**"],
        ["streams **every event*", "streams **every event**"],
        ["streams **", "streams "],
        ["1. **Prompt** — `Compose", "1. **Prompt** — `Compose`"],
        ["text\n1", "text\n"],
        ["text\n   -", "text\n"],
        ["text\n   -\n", "text\n"],
        ["## ", ""],
        ["a\n\n| Part | Owns |", "a\n\n"],
        ["a\n\n| Part | Owns |\n| --- | -", "a\n\n"],
        ["a\n\n| Part | Owns |\n| --- | --- |\n| Ser", "a\n\n| Part | Owns |\n| --- | --- |\n"],
        ["a\n\n| Part | Owns |\n| --- | --- |\n| Server | x |\n", "a\n\n| Part | Owns |\n| --- | --- |\n| Server | x |\n"],
        ["```t", ""],
        ["```ts\ncode **not bold", "```ts\ncode **not bold"],
        ["```ts\ncode\n``", "```ts\ncode\n"],
        ["see [docs](https://exa", "see docs"],
        ["see [doc", "see doc"],
        ["snake_case_na", "snake_case_na"],
        ["a * b", "a * b"],
        ["Hello wor", "Hello wor"],
    ];
    for (const [text, want] of cases) expect({ text, got: settle(text) }).toEqual({ text, got: want });
});

test("reveal drains a burst at one speed by its deadline, never crawls, and stops at the end of a word", () => {
    // 140 characters waiting and 140ms to let them out: a seventh of them in a 16ms frame.
    expect(revealStep(140, 16, 0, 140).chars).toBe(16);
    // Halfway there, the same speed: the rest over what's left of the time (not a share of what's left).
    expect(revealStep(70, 16, 0, 70).chars).toBe(16);
    // The deadline passed (a frame came late): all of it.
    expect(revealStep(500, 16, 0, -5).chars).toBe(500);
    // A burst comes out evenly and is all out by its deadline.
    let backlog = 600, left = LAG_MS, carry = 0;
    const steps: number[] = [];
    while (backlog > 0) {
        const step = revealStep(backlog, 16, carry, left);
        steps.push(step.chars);
        backlog -= step.chars; carry = step.carry; left -= 16;
    }
    expect(steps.length).toBeLessThanOrEqual(Math.ceil(LAG_MS / 16));
    // (The last frame takes what's left: less.)
    const even = steps.slice(0, -1);
    expect(Math.max(...even) - Math.min(...even)).toBeLessThanOrEqual(1);
    expect(steps.at(-1)!).toBeLessThanOrEqual(even[0]!);
    // A little left: the minimum pace, the fraction carried to the next frame.
    const slow = revealStep(3, 16, 0, 1000);
    expect(slow.chars).toBe(1);
    expect(slow.carry).toBeGreaterThan(0.4);
    expect(revealStep(3, 16, slow.carry, 1000).chars).toBe(1);
    // Never more than is waiting.
    expect(revealStep(2, 64, 0.9, 1000)).toEqual({ chars: 2, carry: 0 });
    expect(revealEnd("The engine takes", 0, 5)).toBe(10);
    expect(revealEnd("The engine takes", 0, 3)).toBe(3);
    // A long word (a URL) comes in pieces.
    expect(revealEnd("x https://example.com/a/very/long/path", 0, 3)).toBe(19);
});

test("a stream that comes in bursts runs as far behind as they're apart, a steady one hardly at all", () => {
    // Text comes in on the clock's steps: steady, 50ms apart.
    let gap: number | undefined;
    for (let i = 0; i < 10; i++) gap = nextGap(gap, 50);
    expect(lagFor(gap)).toBe(LAG_MS);
    // A paragraph every half second: each one sweeps in over most of the wait for the next, no more than the most.
    gap = undefined;
    for (let i = 0; i < 10; i++) gap = nextGap(gap, 500);
    expect(lagFor(gap)).toBe(MAX_LAG_MS);
    // One long wait (a tool) doesn't hold the words after it back for long: steady again, the lag comes back down.
    gap = nextGap(gap, 60_000);
    expect(gap).toBeLessThanOrEqual(MAX_LAG_MS * 2);
    for (let i = 0; i < 12; i++) gap = nextGap(gap, 50);
    expect(lagFor(gap)).toBe(LAG_MS);
    expect(lagFor(undefined)).toBe(LAG_MS);
});

test("what just came out is drawn lighter by its age, then plain", () => {
    // A tier a step of the stream clock (50ms), the boundaries between steps.
    expect(TRAIL_MS).toEqual([25, 75, 125, 175, 225, 275, 325]);
    expect([0, 24, 25, 50, 75, 100, 150, 200, 250, 300, 325, 500].map(trailTier)).toEqual([0, 0, 1, 1, 2, 2, 3, 4, 5, 6, -1, -1]);
});

test("streamed text has no animation: the trail is static opacity, none with Reduce motion", () => {
    const css = readFileSync(new URL("../gui/src/styles/markdown.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/md-fresh/);
    expect(css).not.toMatch(/code\.fresh/);
    const trail = css.slice(css.indexOf("@media (prefers-reduced-motion: no-preference)"), css.indexOf("}\n}\n", css.indexOf("@media (prefers-reduced-motion: no-preference)")) + 4);
    expect([...trail.matchAll(/\.md-t(\d) \{\s*opacity: ([\d.]+);\s*\}/g)].map((m) => [m[1], Number(m[2])])).toEqual([["1", 0.12], ["2", 0.28], ["3", 0.45], ["4", 0.61], ["5", 0.75], ["6", 0.87], ["7", 0.95]]);
    // A run of plain words is as light in its colour, with no opacity of its own.
    expect([...trail.matchAll(/\[data-fresh="ink"\]\.md-t(\d) \{\s*opacity: 1;\s*color: color-mix\(in srgb, currentColor (\d+)%, transparent\);\s*\}/g)].map((m) => [m[1], Number(m[2]) / 100])).toEqual([["1", 0.12], ["2", 0.28], ["3", 0.45], ["4", 0.61], ["5", 0.75], ["6", 0.87], ["7", 0.95]]);
    expect(trail).not.toMatch(/animation|transition/);
    // Outside that media query nothing draws the tiers.
    expect(css.replace(trail, "")).not.toMatch(/md-t\d/);
});
