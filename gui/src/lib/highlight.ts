// Syntax highlighting with Shiki, loaded on first use. Grammars are fetched
// one language at a time (each is its own chunk; only common languages are
// bundled), the regex engine is the pure-JS one (no WASM), and colors are CSS
// variables so every theme applies without highlighting again. Results are
// cached by language and code.

import type { HighlighterCore, ThemedToken } from "shiki/core";

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
const cache = new Map<string, string>();
const lineCache = new Map<string, string[]>();
const MAX_CACHE = 400;
/** Bigger inputs stay plain: highlighting them would stall the page. */
const MAX_CHARS = 200_000;

async function highlighter(): Promise<HighlighterCore> {
    core ??= (async () => {
        const [{ createHighlighterCore, createCssVariablesTheme }, { createJavaScriptRegexEngine }] = await Promise.all([import("shiki/core"), import("shiki/engine/javascript")]);
        const theme = createCssVariablesTheme({ name: "harness", variablePrefix: "--shiki-", variableDefaults: {}, fontStyle: true });
        return createHighlighterCore({ themes: [theme], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
    })();
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

function remember<T>(map: Map<string, T>, key: string, value: T): T {
    if (map.size >= MAX_CACHE) map.delete(map.keys().next().value!);
    map.set(key, value);
    return value;
}

/** Highlighted HTML (spans only, escaped by Shiki), or undefined to show it plain. */
export async function highlight(code: string, lang: string | undefined): Promise<string | undefined> {
    if (!lang || code.length > MAX_CHARS) return undefined;
    const key = `${lang}\u0000${code}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const id = await ensure(lang);
    if (!id) return undefined;
    const h = await highlighter();
    const html = h.codeToHtml(code, { lang: id, theme: "harness" });
    // Keep just the code: the <pre> is ours.
    const inner = html.replace(/^<pre[^>]*><code[^>]*>/, "").replace(/<\/code><\/pre>\s*$/, "");
    return remember(cache, key, inner);
}

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function tokenHtml(t: ThemedToken): string {
    const style: string[] = [];
    if (t.color) style.push(`color:${t.color}`);
    if (t.fontStyle && t.fontStyle & 1) style.push("font-style:italic");
    if (t.fontStyle && t.fontStyle & 2) style.push("font-weight:600");
    return style.length ? `<span style="${style.join(";")}">${escape(t.content)}</span>` : escape(t.content);
}

/** Each line highlighted on its own (for diffs), or undefined. */
export async function highlightLines(code: string, lang: string | undefined): Promise<string[] | undefined> {
    if (!lang || code.length > MAX_CHARS) return undefined;
    const key = `${lang}\u0000${code}`;
    const hit = lineCache.get(key);
    if (hit) return hit;
    const id = await ensure(lang);
    if (!id) return undefined;
    const h = await highlighter();
    const { tokens } = h.codeToTokens(code, { lang: id, theme: "harness" });
    return remember(
        lineCache,
        key,
        tokens.map((line) => line.map(tokenHtml).join("")),
    );
}

/** Start loading Shiki in the background (after first paint). */
export function warmUp() {
    void highlighter().catch(() => undefined);
}
