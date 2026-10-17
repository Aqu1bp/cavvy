// File links in the GUI's markdown (gui/src/lib/markdown.ts): which text
// becomes a link, that URLs and code are left alone, and that a path is a
// link only once it's known to be a file.

import { describe, expect, test } from "bun:test";

const { MarkdownRenderer, parsePathRef } = await import("../gui/src/lib/markdown");

const ROOT = "/Users/me/proj";
const FILES = new Set(["src/server/engine.ts", "README.md", "/Users/me/proj/src/a.ts", "src/My File.ts", "./src/a.ts", "_config.ts", "config.ts", "src/café.ts", "Makefile", "src/file", "src/file-123", "src/file-L123", "/Users/me/proj/logs/run-42"]);
/** Known files resolve; "missing/..." is known missing; anything else isn't asked yet. */
const lookup = (p: string) => (FILES.has(p) ? (p.startsWith("/") ? p : `${ROOT}/${p.replace(/^\.\//, "")}`) : p.startsWith("missing/") ? null : undefined);

/** `l` null: no session, so no lookup at all. */
function render(text: string, l: ((p: string) => string | null | undefined) | null = lookup) {
    const r = new MarkdownRenderer();
    const segs = r.segments(text, false, l ?? undefined);
    return { html: segs.map((s) => (s.kind === "html" ? s.html : `<pre>${s.code}</pre>`)).join(""), pending: [...r.pending], segs, r };
}

describe("path references", () => {
    test(":line, :line:col, #L forms and ranges", () => {
        expect(parsePathRef("src/server/engine.ts:780")).toEqual({ path: "src/server/engine.ts", line: 780, col: undefined });
        expect(parsePathRef("src/a.ts:12:4")).toEqual({ path: "src/a.ts", line: 12, col: 4 });
        expect(parsePathRef("src/a.ts#L9")).toEqual({ path: "src/a.ts", line: 9, col: undefined });
        expect(parsePathRef("src/a.ts:10-20")).toEqual({ path: "src/a.ts", line: 10, col: undefined });
        expect(parsePathRef("/abs/x.ts")).toEqual({ path: "/abs/x.ts", line: undefined, col: undefined });
        expect(parsePathRef("../other-repo/x")).toMatchObject({ path: "../other-repo/x" });
        expect(parsePathRef("~/notes.md")).toMatchObject({ path: "~/notes.md" });
    });

    test("underscores and unicode are part of the name", () => {
        expect(render("Edit _config.ts now").html).toContain(`data-file="${ROOT}/_config.ts"`);
        expect(render("Edit _config.ts now").html).not.toContain(`data-file="${ROOT}/config.ts"`);
        expect(render("see src/café.ts:3").html).toContain(`data-file="${ROOT}/src/café.ts" data-line="3"`);
    });

    test("words that aren't paths", () => {
        for (const s of ["e.g", "v1.2.3", "hello", "1.5", "-rf", "--goto", "a.b", "src/", "...", "foo()", "it."]) expect(parsePathRef(s)).toBeUndefined();
    });
});

describe("linkifying replies", () => {
    test("a path with a line becomes a link at that line; sentence punctuation stays outside", () => {
        const { html } = render("The bug is in src/server/engine.ts:780.");
        expect(html).toContain(`<a class="md-file" data-file="${ROOT}/src/server/engine.ts" data-line="780" title="${ROOT}/src/server/engine.ts:780" role="link" tabindex="0">src/server/engine.ts:780</a>.`);
    });

    test(":line:col and absolute paths", () => {
        expect(render("see /Users/me/proj/src/a.ts:3:14 now").html).toContain(`data-file="/Users/me/proj/src/a.ts" data-line="3" data-col="14"`);
    });

    test("inside backticks the code is wrapped in the link", () => {
        const { html } = render("Open `src/server/engine.ts:780` and `README.md`.");
        expect(html).toContain(`data-line="780" title="${ROOT}/src/server/engine.ts:780" role="link" tabindex="0"><code>src/server/engine.ts:780</code></a>`);
        expect(html).toContain(`<code>README.md</code></a>`);
        // Spaces are fine where the whole code span is the path.
        expect(render("`src/My File.ts:2`").html).toContain(`data-file="${ROOT}/src/My File.ts" data-line="2"`);
    });

    test("in parentheses and lists", () => {
        expect(render("(see README.md)").html).toContain(`(see <a class="md-file" data-file="${ROOT}/README.md"`);
        expect(render("- src/server/engine.ts\n- README.md\n").html.match(/md-file/g)).toHaveLength(2);
    });

    test("URLs aren't touched, and their paths aren't asked about", () => {
        for (const text of ["See https://example.com/src/server/engine.ts:780 for it", "ftp://host/src/server/engine.ts", "www.example.com/README.md", "mailto:me@x.io"]) {
            const { html, pending } = render(text);
            expect(html).not.toContain("md-file");
            expect(pending).toEqual([]);
        }
        expect(render("https://example.com/README.md").html).toContain(`href="https://example.com/README.md" data-external="1"`);
    });

    test("fenced code isn't linked", () => {
        const { html, pending } = render("```\nsrc/server/engine.ts:780\n```\n");
        expect(html).not.toContain("md-file");
        expect(pending).toEqual([]);
    });

    test("missing files aren't linked; unknown ones are plain text until asked about", () => {
        const missing = render("Look at missing/thing.ts:4");
        expect(missing.html).not.toContain("md-file");
        expect(missing.pending).toEqual([]);
        const unknown = render("Look at lib/other.ts:4 and `lib/b.ts`");
        expect(unknown.html).not.toContain("md-file");
        expect(unknown.html).toContain("lib/other.ts:4");
        expect(unknown.pending.sort()).toEqual(["lib/b.ts", "lib/other.ts"]);
    });

    test("without a session (no lookup), nothing is linked or asked", () => {
        const { html, pending } = render("src/server/engine.ts:780", null);
        expect(html).not.toContain("md-file");
        expect(pending).toEqual([]);
    });

    test("text around a path is escaped as before", () => {
        const { html } = render("a <b> & src/server/engine.ts \"q\"");
        expect(html).toContain("a &lt;b&gt; &amp; <a class=\"md-file\"");
        expect(html).toContain("&quot;q&quot;");
    });
});

describe("markdown links to files", () => {
    test("a relative target, with #L or :line, and a file:// URL", () => {
        expect(render("[the engine](src/server/engine.ts#L780)").html).toContain(`data-file="${ROOT}/src/server/engine.ts" data-line="780" title="${ROOT}/src/server/engine.ts:780" role="link" tabindex="0">the engine</a>`);
        expect(render("[a](./src/a.ts:5)").html).toContain(`data-file="${ROOT}/src/a.ts" data-line="5"`);
        expect(render("[a](file:///Users/me/proj/src/a.ts#L2)").html).toContain(`data-file="/Users/me/proj/src/a.ts" data-line="2"`);
        expect(render("[spaced](<src/My File.ts>)").html).toContain(`data-file="${ROOT}/src/My File.ts"`);
    });

    test("a link's target is a path by intent: no extension needed, unicode fine", () => {
        expect(render("[build](Makefile)").html).toContain(`data-file="${ROOT}/Makefile"`);
        expect(render("[m](src/café.ts)").html).toContain(`data-file="${ROOT}/src/café.ts"`);
        expect(render("[m](src/caf%C3%A9.ts)").html).toContain(`data-file="${ROOT}/src/café.ts"`);
        // Prose still needs a slash or an extension.
        expect(render("run Makefile").pending).toEqual([]);
    });

    test("a name ending in -123 or -L123 keeps it: a range end needs a line before it", () => {
        expect(parsePathRef("src/file-123", "target")).toEqual({ path: "src/file-123", line: undefined, col: undefined });
        expect(parsePathRef("src/file-L123", "target")).toEqual({ path: "src/file-L123", line: undefined, col: undefined });
        expect(parsePathRef("src/file-123:7", "target")).toEqual({ path: "src/file-123", line: 7, col: undefined });
        expect(parsePathRef("src/file-L123#L7-L9", "target")).toEqual({ path: "src/file-L123", line: 7, col: undefined });
        expect(parsePathRef("src/a.ts:10-20", "target")).toEqual({ path: "src/a.ts", line: 10, col: undefined });
        expect(parsePathRef("src/a.ts#L3C2-L9C1", "target")).toEqual({ path: "src/a.ts", line: 3, col: 2 });
        // src/file exists too: the link must not open it.
        expect(render("[log](src/file-123)").html).toContain(`data-file="${ROOT}/src/file-123" title="${ROOT}/src/file-123"`);
        expect(render("[log](src/file-L123)").html).toContain(`data-file="${ROOT}/src/file-L123" title="${ROOT}/src/file-L123"`);
        expect(render("[log](src/file-123:5)").html).toContain(`data-file="${ROOT}/src/file-123" data-line="5"`);
        expect(render("[log](file:///Users/me/proj/logs/run-42)").html).toContain(`data-file="/Users/me/proj/logs/run-42" title="/Users/me/proj/logs/run-42"`);
        expect(render("[log](file:///Users/me/proj/logs/run-42#L8)").html).toContain(`data-file="/Users/me/proj/logs/run-42" data-line="8"`);
        for (const t of ["[log](src/file-123)", "[log](src/file-L123)"]) expect(render(t).html).not.toContain(`data-file="${ROOT}/src/file"`);
    });

    test("other schemes stay plain; http(s) stays external", () => {
        for (const href of ["javascript:alert(1)", "data:text/html,x", "vscode://file/x", "file://evil.example.com/etc/passwd"]) {
            const { html } = render(`[x](${href})`);
            expect(html).not.toContain("<a ");
        }
        expect(render("[x](https://e.com/a.ts)").html).toContain(`data-external="1"`);
    });

    test("no links inside links", () => {
        const { html } = render("[src/server/engine.ts](https://github.com/x/y)");
        expect(html.match(/<a /g)).toHaveLength(1);
        expect(html).toContain("data-external");
    });
});

describe("re-rendering as answers arrive", () => {
    test("a block with unknown paths renders again once they're known; a settled block keeps its object", () => {
        const known = new Map<string, string | null>();
        const l = (p: string) => known.get(p);
        const r = new MarkdownRenderer();
        const text = "First lib/x.ts here.\n\nSecond paragraph, no paths.";
        const a = r.segments(text, false, l);
        expect([...r.pending]).toEqual(["lib/x.ts"]);
        expect(a[0]!.kind === "html" && a[0]!.answers).toEqual([["lib/x.ts", undefined]]);
        // Nothing new known: same objects, so the DOM isn't replaced; still waiting on lib/x.ts.
        const b = r.segments(text, false, l);
        expect(b[0]).toBe(a[0]!);
        expect(b[1]).toBe(a[1]!);
        expect([...r.pending]).toEqual(["lib/x.ts"]);
        known.set("lib/x.ts", "/p/lib/x.ts");
        const c = r.segments(text, false, l);
        expect(c[0]).not.toBe(a[0]!);
        expect(c[0]!.kind === "html" && c[0]!.html).toContain(`data-file="/p/lib/x.ts"`);
        expect(c[1]).toBe(a[1]!);
        expect([...r.pending]).toEqual([]);
        // A linked path is still watched: the answer can be dropped (another editor chosen).
        expect(r.watching).toBe(true);
        expect(r.segments(text, false, l)[0]).toBe(c[0]!);
        known.delete("lib/x.ts");
        const d = r.segments(text, false, l);
        expect(d[0]).not.toBe(c[0]!);
        expect((d[0] as { html: string }).html).not.toContain("md-file");
        expect([...r.pending]).toEqual(["lib/x.ts"]);
    });

    test("a path found missing is looked at again once that answer is forgotten", () => {
        const known = new Map<string, string | null | undefined>([["lib/new.ts", null]]);
        const l = (p: string) => known.get(p);
        const r = new MarkdownRenderer();
        const text = "Created lib/new.ts.";
        const a = r.segments(text, false, l);
        expect([...r.pending]).toEqual([]);
        expect(r.watching).toBe(true);
        expect(r.segments(text, false, l)[0]).toBe(a[0]!);
        known.set("lib/new.ts", undefined); // forgotten: files may have been created
        r.segments(text, false, l);
        expect([...r.pending]).toEqual(["lib/new.ts"]);
        known.set("lib/new.ts", "/p/lib/new.ts");
        expect((r.segments(text, false, l)[0] as { html: string }).html).toContain(`data-file="/p/lib/new.ts"`);
    });

    test("a reply without paths doesn't watch for answers", () => {
        const r = new MarkdownRenderer();
        r.segments("Just words, and https://example.com/a.ts.", false, lookup);
        expect(r.watching).toBe(false);
    });

    test("rendering a block again from the same tokens doesn't duplicate task checkboxes", () => {
        const known = new Map<string, string | null>();
        const l = (p: string) => known.get(p);
        const r = new MarkdownRenderer();
        const text = "- [x] done lib/y.ts\n- [ ] todo\n";
        r.segments(text, false, l);
        known.set("lib/y.ts", "/p/lib/y.ts");
        const html = (r.segments(text, false, l)[0] as { html: string }).html;
        expect(html.match(/md-check/g)).toHaveLength(2);
        expect(html).toContain(`data-file="/p/lib/y.ts"`);
    });
});

describe("images", () => {
    const IMAGES = new Set(["mock.png", "/Users/me/proj/shot.png"]);
    const withImages = (p: string) => (IMAGES.has(p) ? (p.startsWith("/") ? p : `${ROOT}/${p}`) : lookup(p));

    test("a known file in the session is an image with no src: the caller fills it in", () => {
        const { html } = render("![the mockup](mock.png)", withImages);
        expect(html).toContain(`<img class="md-img" data-image-file="${ROOT}/mock.png" alt="the mockup"`);
        expect(html).not.toContain("src=");
        expect(render("![](file:///Users/me/proj/shot.png)", withImages).html).toContain(`data-image-file="/Users/me/proj/shot.png"`);
    });

    test("an unknown path is a label until it's known, and is asked about", () => {
        const r = render("![preview](other.png)", withImages);
        expect(r.html).toContain(`<span class="md-image">preview</span>`);
        expect(r.pending).toEqual(["other.png"]);
        expect(render("![preview](missing/x.png)", withImages).html).toContain(`<span class="md-image">preview</span>`);
    });

    test("remote images are never loaded, and nothing is shown without a session", () => {
        const remote = render("![x](https://example.com/a.png)", withImages).html;
        expect(remote).not.toContain("<img");
        expect(remote).toContain(`class="md-image" href="https://example.com/a.png" data-external="1"`);
        expect(render("![x](mock.png)", null).html).not.toContain("<img");
    });

    test("an image inside a link stays a label (no links inside links)", () => {
        expect(render("[![x](mock.png)](https://example.com)", withImages).html).not.toContain("<img");
    });

    test("alt text and paths are escaped", () => {
        const html = render(`![a"><script>](mock.png)`, withImages).html;
        expect(html).not.toContain("<script>");
    });
});
