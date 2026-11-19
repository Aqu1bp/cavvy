// Syntax highlighting with Shiki, loaded on first use. Grammars are fetched
// one language at a time (each is its own chunk; only common languages are
// bundled), the regex engine is the pure-JS one (no WASM), and colors are CSS
// variables so every theme applies without highlighting again. Results are
// cached by language and code.

import type { GrammarState, HighlighterCore, ThemedToken } from "shiki/core";

type Grammar = () => Promise<{ default: unknown[] }>;

const GRAMMARS: Record<string, Grammar> = {
    "typescript": () => import("shiki/langs/typescript.mjs"),
    "tsx": () => import("shiki/langs/tsx.mjs"),
    "javascript": () => import("shiki/langs/javascript.mjs"),
    "jsx": () => import("shiki/langs/jsx.mjs"),
    "json": () => import("shiki/langs/json.mjs"),
    "jsonc": () => import("shiki/langs/jsonc.mjs"),
    "json5": () => import("shiki/langs/json5.mjs"),
    "markdown": () => import("shiki/langs/markdown.mjs"),
    "mdx": () => import("shiki/langs/mdx.mjs"),
    "python": () => import("shiki/langs/python.mjs"),
    "rust": () => import("shiki/langs/rust.mjs"),
    "go": () => import("shiki/langs/go.mjs"),
    "ruby": () => import("shiki/langs/ruby.mjs"),
    "java": () => import("shiki/langs/java.mjs"),
    "kotlin": () => import("shiki/langs/kotlin.mjs"),
    "swift": () => import("shiki/langs/swift.mjs"),
    "c": () => import("shiki/langs/c.mjs"),
    "cpp": () => import("shiki/langs/cpp.mjs"),
    "csharp": () => import("shiki/langs/csharp.mjs"),
    "php": () => import("shiki/langs/php.mjs"),
    "shellscript": () => import("shiki/langs/shellscript.mjs"),
    "powershell": () => import("shiki/langs/powershell.mjs"),
    "bat": () => import("shiki/langs/bat.mjs"),
    "yaml": () => import("shiki/langs/yaml.mjs"),
    "toml": () => import("shiki/langs/toml.mjs"),
    "html": () => import("shiki/langs/html.mjs"),
    "css": () => import("shiki/langs/css.mjs"),
    "scss": () => import("shiki/langs/scss.mjs"),
    "less": () => import("shiki/langs/less.mjs"),
    "sql": () => import("shiki/langs/sql.mjs"),
    "vue": () => import("shiki/langs/vue.mjs"),
    "svelte": () => import("shiki/langs/svelte.mjs"),
    "astro": () => import("shiki/langs/astro.mjs"),
    "lua": () => import("shiki/langs/lua.mjs"),
    "elixir": () => import("shiki/langs/elixir.mjs"),
    "zig": () => import("shiki/langs/zig.mjs"),
    "dart": () => import("shiki/langs/dart.mjs"),
    "scala": () => import("shiki/langs/scala.mjs"),
    "graphql": () => import("shiki/langs/graphql.mjs"),
    "proto": () => import("shiki/langs/proto.mjs"),
    "xml": () => import("shiki/langs/xml.mjs"),
    "ini": () => import("shiki/langs/ini.mjs"),
    "hcl": () => import("shiki/langs/hcl.mjs"),
    "terraform": () => import("shiki/langs/terraform.mjs"),
    "nix": () => import("shiki/langs/nix.mjs"),
    "r": () => import("shiki/langs/r.mjs"),
    "julia": () => import("shiki/langs/julia.mjs"),
    "haskell": () => import("shiki/langs/haskell.mjs"),
    "ocaml": () => import("shiki/langs/ocaml.mjs"),
    "clojure": () => import("shiki/langs/clojure.mjs"),
    "erlang": () => import("shiki/langs/erlang.mjs"),
    "dockerfile": () => import("shiki/langs/dockerfile.mjs"),
    "make": () => import("shiki/langs/make.mjs"),
    "diff": () => import("shiki/langs/diff.mjs"),
    "perl": () => import("shiki/langs/perl.mjs"),
    "objective-c": () => import("shiki/langs/objective-c.mjs"),
    "prisma": () => import("shiki/langs/prisma.mjs"),
    "solidity": () => import("shiki/langs/solidity.mjs"),
    "cmake": () => import("shiki/langs/cmake.mjs"),
    "latex": () => import("shiki/langs/latex.mjs"),
    "regexp": () => import("shiki/langs/regexp.mjs"),
};

let core: Promise<HighlighterCore> | undefined;
const loading = new Map<string, Promise<boolean>>();
/** A cache of results by key, kept to MAX_CACHE entries and MAX_CACHE_CHARS characters (key and HTML), oldest first out. */
type Cache<T> = { map: Map<string, { value: T; chars: number }>; chars: number };
const cache: Cache<string> = { map: new Map(), chars: 0 };
const lineCache: Cache<string[]> = { map: new Map(), chars: 0 };
const MAX_CACHE = 400;
/** For each cache. HTML runs about 12 times its code: a few long diffs, or many short blocks. */
const MAX_CACHE_CHARS = 4_000_000;
/** Bigger inputs stay plain: highlighting them would stall the page. */
const MAX_CHARS = 200_000;

async function highlighter(): Promise<HighlighterCore> {
    core ??= (async () => {
        const [{ createHighlighterCore, createCssVariablesTheme }, { createJavaScriptRegexEngine }] = await Promise.all([import("shiki/core"), import("shiki/engine/javascript")]);
        const theme = createCssVariablesTheme({ name: "cavvy", variablePrefix: "--shiki-", variableDefaults: {}, fontStyle: true });
        return createHighlighterCore({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
    })().catch((error) => {
        // Chunk loading can fail transiently. Keep successful initialization shared,
        // but let a boundary Retry (or the next block) attempt initialization again.
        core = undefined;
        throw error;
    });
    return core;
}

const ALIASES: Record<string, string> = {
    sh: "shellscript", bash: "shellscript", zsh: "shellscript", shell: "shellscript", console: "shellscript", fish: "shellscript",
    ts: "typescript", mts: "typescript", cts: "typescript", js: "javascript", mjs: "javascript", cjs: "javascript", py: "python", rs: "rust",
    yml: "yaml", md: "markdown", rb: "ruby", kt: "kotlin", cs: "csharp", "c#": "csharp", "c++": "cpp", hpp: "cpp", h: "c", ps1: "powershell",
    ex: "elixir", exs: "elixir", tf: "terraform", hs: "haskell", ml: "ocaml", clj: "clojure", erl: "erlang", objc: "objective-c",
    sol: "solidity", tex: "latex", docker: "dockerfile", makefile: "make", patch: "diff", golang: "go", htm: "html", xhtml: "html", svg: "xml",
};

/** The grammar for `lang`, loaded; undefined when there's none. */
async function ensure(lang: string): Promise<string | undefined> {
    const h = await highlighter();
    const want = (ALIASES[lang.toLowerCase()] ?? lang.toLowerCase()).trim();
    const load = GRAMMARS[want];
    if (!load) return undefined;
    if (h.getLoadedLanguages().includes(want)) return want;
    let p = loading.get(want);
    if (!p) {
        p = load()
            .then((m) => h.loadLanguage(...(m.default as Parameters<HighlighterCore["loadLanguage"]>)))
            .then(() => true)
            .catch(() => false);
        loading.set(want, p);
    }
    return (await p) ? want : undefined;
}

function remember<T>(cache: Cache<T>, key: string, value: T, chars: number): T {
    const had = cache.map.get(key);
    if (had) {
        cache.map.delete(key);
        cache.chars -= had.chars;
    }
    chars += key.length;
    // Too big to keep at all: nothing's let go of for it.
    if (chars > MAX_CACHE_CHARS) return value;
    for (const [k, v] of cache.map) {
        if (cache.map.size < MAX_CACHE && cache.chars + chars <= MAX_CACHE_CHARS) break;
        cache.map.delete(k);
        cache.chars -= v.chars;
    }
    cache.map.set(key, { value, chars });
    cache.chars += chars;
    return value;
}

/** Highlighted HTML (spans only, escaped by Shiki), or undefined to show it plain. */
export async function highlight(code: string, lang: string | undefined): Promise<string | undefined> {
    if (!lang || code.length > MAX_CHARS) return undefined;
    const key = `${lang}\u0000${code}`;
    const hit = cache.map.get(key);
    if (hit) return hit.value;
    const id = await ensure(lang);
    if (!id) return undefined;
    const h = await highlighter();
    const html = h.codeToHtml(code, { lang: id, theme: "cavvy" });
    // Keep just the code: the <pre> is ours. Each token's style as classes (see tokenHtml).
    const inner = html
        .replace(/^<pre[^>]*><code[^>]*>/, "")
        .replace(/<\/code><\/pre>\s*$/, "")
        .replace(/<span style="([^"]*)">/g, (span, style: string) => {
            const decl = Object.fromEntries(style.split(";").filter(Boolean).map((d) => d.split(":").map((x) => x.trim()) as [string, string]));
            const known = Object.keys(decl).every((k) => k === "color" || k === "font-style" || k === "font-weight");
            const cls = known && tokenClass(decl.color, (decl["font-style"] === "italic" ? 1 : 0) | (decl["font-weight"] ? 2 : 0));
            return cls === undefined || cls === false ? span : cls ? `<span class="${cls}">` : "<span>";
        });
    return remember(cache, key, inner, inner.length);
}

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A token's look as classes (sk-* in tokens.css) rather than a style of its own: elements with the same classes share
 * a style, where each inline style is parsed and kept for its span alone (a 12 KB reply with code: 680 spans, each its
 * own parsed style and computed style, kept for as long as the reply is on the page; measured in Chrome's heap).
 * Undefined: a color that isn't one of the theme's variables, left as a style.
 */
function tokenClass(color: string | undefined, fontStyle: number): string | undefined {
    const names: string[] = [];
    if (color) {
        const v = /^var\(--shiki-(?:token-)?([a-z-]+)\)$/.exec(color)?.[1];
        if (!v || !TOKEN_COLORS.has(v)) return undefined;
        names.push(`sk-${v}`);
    }
    if (fontStyle & 1) names.push("sk-i");
    if (fontStyle & 2) names.push("sk-b");
    return names.join(" ");
}
/** The theme's colors (tokens.css: --shiki-foreground and --shiki-token-*). */
const TOKEN_COLORS = new Set(["foreground", "keyword", "string", "string-expression", "comment", "function", "constant", "parameter", "punctuation", "link"]);

function tokenHtml(t: ThemedToken): string {
    const cls = tokenClass(t.color, t.fontStyle ?? 0);
    if (cls !== undefined) return cls ? `<span class="${cls}">${escape(t.content)}</span>` : escape(t.content);
    const style: string[] = [];
    if (t.color) style.push(`color:${t.color}`);
    if (t.fontStyle && t.fontStyle & 1) style.push("font-style:italic");
    if (t.fontStyle && t.fontStyle & 2) style.push("font-weight:600");
    return style.length ? `<span style="${style.join(";")}">${escape(t.content)}</span>` : escape(t.content);
}

/** Each line highlighted on its own (for diffs), or undefined. */
export async function highlightLines(code: string, lang: string | undefined): Promise<string[] | undefined> {
    let out: string[] | undefined;
    await highlightLineChunks(code, lang, (from, lines) => (out = from ? [...(out ?? []), ...lines] : lines), () => false, Infinity);
    return out;
}

/** The first part of a stream: about a screenful, so the top of a long diff is colored at once. */
const FIRST_CHUNK = 80;
const CHUNK = 400;
/**
 * Lines past this length are shown plain: an unbounded minified line can hold the tokenizer for its whole
 * time limit. Above the server's own cut (2,000 characters a diff line), so its diffs stay colored.
 */
const MAX_LINE = 4000;

/**
 * Each line highlighted on its own, handed over a part at a time (`emit(from, lines)`), the grammar's
 * state carried from one part to the next so the colors are the same as in one go. Between parts, other
 * messages (a cancel) get a turn; `stopped` ends it early. False when it stays plain.
 */
export async function highlightLineChunks(code: string, lang: string | undefined, emit: (from: number, lines: string[]) => void, stopped: () => boolean, first = FIRST_CHUNK): Promise<boolean> {
    if (!lang || code.length > MAX_CHARS) return false;
    const key = `${lang}\u0000${code}`;
    const hit = lineCache.map.get(key);
    if (hit) {
        emit(0, hit.value);
        return true;
    }
    const id = await ensure(lang);
    if (!id || stopped()) return false;
    const h = await highlighter();
    // Split as Shiki splits (a CRLF ends a line too), so a part's last line carries no stray \r into the grammar's state.
    const lines = code.split(/\r?\n/);
    const out: string[] = [];
    let state: GrammarState | undefined;
    for (let i = 0; i < lines.length; ) {
        const n = i ? CHUNK : first;
        const { tokens, grammarState } = h.codeToTokens(lines.slice(i, i + n).join("\n"), { lang: id, theme: "cavvy", tokenizeMaxLineLength: MAX_LINE, ...(state ? { grammarState: state } : {}) });
        state = grammarState;
        const html = tokens.map((line) => line.map(tokenHtml).join(""));
        emit(i, html);
        for (const l of html) out.push(l);
        i += n;
        if (i < lines.length) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (stopped()) return false;
        }
    }
    let chars = 0;
    for (const l of out) chars += l.length;
    remember(lineCache, key, out, chars);
    return true;
}

/** Code blocks being written: where each has got to in its grammar and how much it has had. */
const writing = new Map<number, { state?: GrammarState; chars: number }>();

/**
 * The HTML of the lines just finished in a block being written (`stream`; `lines` each end in a newline), a box for each
 * (.code-lit.lines). The grammar picks up where the last lines left it, so each line is read once however long the block
 * grows. Undefined: it stays plain.
 */
export async function highlightMore(stream: number, lines: string, lang: string | undefined): Promise<string | undefined> {
    const was = writing.get(stream) ?? { chars: 0 };
    const chars = was.chars + lines.length;
    if (!lang || chars > MAX_CHARS) return void writing.delete(stream);
    writing.set(stream, was);
    const id = await ensure(lang);
    if (!id) return void writing.delete(stream);
    const h = await highlighter();
    // As Shiki splits them (a CRLF ends a line too): the last line carries no stray \r into the grammar's state.
    const { tokens, grammarState } = h.codeToTokens(lines.replace(/\r?\n$/, ""), { lang: id, theme: "cavvy", ...(was.state ? { grammarState: was.state } : {}) });
    // Ended while it waited for its grammar: it isn't kept.
    if (writing.has(stream)) writing.set(stream, { state: grammarState, chars });
    return tokens.map((line) => `<span class="line">${line.map(tokenHtml).join("")}\n</span>`).join("");
}

export function endWriting(stream: number) {
    writing.delete(stream);
}

/** Start loading Shiki in the background (after first paint). */
export function warmUp() {
    void highlighter().catch(() => undefined);
}
