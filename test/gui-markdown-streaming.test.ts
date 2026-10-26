import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MarkdownRenderer, settle } from "../gui/src/lib/markdown";
import { LAG_MS, revealEnd, revealStep } from "../gui/src/lib/reveal";
import { Marked } from "../gui/node_modules/marked/lib/marked.esm.js";

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
        "Before\r\n\r\n- item\r\n\r\nAfter",
        "Before\n\n---\n\nAfter with https://example.com and `inline`.",
        "Before\n\n1. ordered\n2. second\n\n    code\n\nAfter",
        // Inline HTML carries state (e.g. an open <a>) across blank lines.
        "prefix <a>\n\nhttps://example.com",
        // What settle() holds back or closes while the reply streams.
        "Done.\n\nStreams **every event** and `inline` code, *em* and ~~gone~~.\n\n1. **Prompt** — `Composer`\n2. **Model call** — opens a stream\n   - text deltas\n   - tool calls\n\nAfter.",
        "Intro.\n\n## What each side owns\n\n| Part | Owns |\n| --- | --- |\n| Server | sessions |\n| GUI | scroll |\n\nThe end.",
        "Para.\n\n```ts\nconst a = `x`;\n```\n\n---\n\nSee docs and snake_case_names.",
    ];
    for (const sample of cases) {
        const incremental = new MarkdownRenderer();
        for (let i = 0; i <= sample.length; i++) {
            const text = sample.slice(0, i);
            expect(visible(incremental, text)).toEqual(visible(new MarkdownRenderer(), text));
        }
        expect(visible(incremental, sample, false)).toEqual(visible(new MarkdownRenderer(), sample, false));
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
});

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
