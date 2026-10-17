import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MarkdownRenderer } from "../gui/src/lib/markdown";
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
    let text = Array.from({ length: 2000 }, (_, i) => `Paragraph ${i}.\n\n`).join("");
    r.segments(text, true);
    chars = 0;
    const start = performance.now();
    for (let i = 0; i < 100; i++) { text += "word "; r.segments(text, true); }
    console.log(JSON.stringify({ paragraphs: 2000, updates: 100, lexedChars: chars, elapsedMs: performance.now() - start }));
    expect(chars).toBeLessThan(30_000); // 25,250 chars; the old full lexer reads >3 million.
    chars = 0;
    r.segments(text + "\n\n[ref]: https://example.com", true);
    expect(chars).toBeGreaterThan(text.length);
});
