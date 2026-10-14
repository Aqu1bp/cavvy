// Small, dependency-free syntax highlighter for code blocks and file
// previews. A single-pass scanner per line with carried state for block
// comments and multi-line strings. Good enough to read, not a parser.

import { theme } from "./ansi";

interface LangSpec {
    keywords: Set<string>;
    types?: Set<string>;
    literals?: Set<string>;
    line?: string[];
    block?: [string, string][];
    strings: string[];
    /** Strings that may span lines (Python triple quotes, JS template). */
    multiline?: string[];
    /** Treat $var / ${...} etc. as variables (shell). */
    vars?: boolean;
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const C_LIKE_LIT = words("true false null nullptr NULL nil undefined this self super");

const LANGS: Record<string, LangSpec> = {
    js: {
        keywords: words(
            "async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static switch throw try typeof var void while with yield as satisfies enum implements interface keyof namespace private protected public readonly declare type abstract override infer is unique module",
        ),
        types: words("string number boolean any unknown never object symbol bigint void Promise Array Record Map Set Partial Readonly"),
        literals: C_LIKE_LIT,
        line: ["//"],
        block: [["/*", "*/"]],
        strings: ['"', "'", "`"],
        multiline: ["`"],
    },
    py: {
        keywords: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case"),
        types: words("int float str bool list dict set tuple bytes object type None"),
        literals: words("True False None self cls"),
        line: ["#"],
        strings: ['"""', "'''", '"', "'"],
        multiline: ['"""', "'''"],
    },
    go: {
        keywords: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
        types: words("bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any"),
        literals: words("true false nil iota"),
        line: ["//"],
        block: [["/*", "*/"]],
        strings: ['"', "'", "`"],
        multiline: ["`"],
    },
    rust: {
        keywords: words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type unsafe use where while"),
        types: words("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Self"),
        literals: words("true false self Some None Ok Err"),
        line: ["//"],
        block: [["/*", "*/"]],
        strings: ['"'],
    },
    c: {
        keywords: words(
            "auto break case catch class const constexpr continue default delete do else enum explicit extern for friend goto if inline mutable namespace new noexcept operator private protected public register return sizeof static struct switch template throw try typedef typename union using virtual volatile while abstract final override package import extends implements interface instanceof synchronized throws transient var val fun when object companion data sealed lateinit internal suspend in is out by init get set where yield async await foreach lock readonly ref sealed unsafe",
        ),
        types: words("void int char short long float double signed unsigned bool size_t string String Integer Boolean List Map Set Object Unit Any"),
        literals: C_LIKE_LIT,
        line: ["//"],
        block: [["/*", "*/"]],
        strings: ['"', "'"],
    },
    rb: {
        keywords: words("alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return then undef unless until when while yield require require_relative attr_accessor attr_reader private protected public"),
        literals: words("true false nil self"),
        line: ["#"],
        strings: ['"', "'"],
    },
    php: {
        keywords: words("abstract and array as break case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include instanceof insteadof interface isset list match namespace new or print private protected public readonly require return static switch throw trait try unset use var while yield"),
        literals: words("true false null this self parent"),
        line: ["//", "#"],
        block: [["/*", "*/"]],
        strings: ['"', "'"],
        vars: true,
    },
    swift: {
        keywords: words("associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch is rethrows throw throws try async await some any"),
        types: words("Int Double Float String Bool Character Array Dictionary Set Optional Void"),
        literals: words("true false nil self Self super"),
        line: ["//"],
        block: [["/*", "*/"]],
        strings: ['"'],
    },
    sh: {
        keywords: words("if then else elif fi case esac for while until do done in function select time return exit export local readonly declare unset shift source alias set trap break continue eval exec"),
        literals: words("true false"),
        line: ["#"],
        strings: ['"', "'"],
        vars: true,
    },
    sql: {
        keywords: words(
            "select from where and or not insert into values update set delete create table drop alter add column index primary key foreign references join left right inner outer full on as group by order having limit offset distinct union all case when then else end is null like in between exists with returning default unique constraint view trigger begin commit rollback transaction asc desc",
        ),
        types: words("int integer bigint smallint text varchar char boolean bool date timestamp timestamptz numeric decimal real float double serial uuid json jsonb blob"),
        literals: words("true false null"),
        line: ["--"],
        block: [["/*", "*/"]],
        strings: ["'", '"'],
    },
    json: { keywords: new Set(), literals: words("true false null"), strings: ['"'] },
    yaml: { keywords: new Set(), literals: words("true false null yes no on off ~"), line: ["#"], strings: ['"', "'"] },
    toml: { keywords: new Set(), literals: words("true false"), line: ["#"], strings: ['"""', '"', "'"], multiline: ['"""'] },
    css: { keywords: words("@media @import @keyframes @font-face @supports !important"), line: [], block: [["/*", "*/"]], strings: ['"', "'"] },
    html: { keywords: new Set(), block: [["<!--", "-->"]], strings: ['"', "'"] },
    lua: { keywords: words("and break do else elseif end for function goto if in local not or repeat return then until while"), literals: words("true false nil self"), line: ["--"], strings: ['"', "'"] },
};

const ALIASES: Record<string, string> = {
    javascript: "js", jsx: "js", ts: "js", tsx: "js", typescript: "js", mjs: "js", cjs: "js", mts: "js", cts: "js", vue: "js", svelte: "js",
    python: "py", py3: "py", pyw: "py",
    golang: "go",
    rs: "rust",
    cpp: "c", "c++": "c", cc: "c", cxx: "c", h: "c", hpp: "c", hh: "c", java: "c", kt: "c", kotlin: "c", kts: "c", cs: "c", csharp: "c", scala: "c", dart: "c", groovy: "c", gradle: "c", m: "c", mm: "c", objc: "c", zig: "c",
    ruby: "rb", rake: "rb", gemspec: "rb",
    bash: "sh", zsh: "sh", shell: "sh", console: "sh", fish: "sh", ksh: "sh", dockerfile: "sh", docker: "sh", makefile: "sh", make: "sh", mk: "sh", ps1: "sh", powershell: "sh", env: "sh", dotenv: "sh",
    yml: "yaml",
    jsonc: "json", json5: "json", ipynb: "json",
    scss: "css", sass: "css", less: "css",
    xml: "html", svg: "html", htm: "html", xhtml: "html", plist: "html",
    psql: "sql", mysql: "sql", sqlite: "sql", pgsql: "sql",
};

export function langFromPath(path: string): string | undefined {
    const base = path.split("/").pop()?.toLowerCase() ?? "";
    if (base === "dockerfile" || base.startsWith("dockerfile.")) return "sh";
    if (base === "makefile" || base === "gnumakefile") return "sh";
    if (base.startsWith(".env") || base === ".bashrc" || base === ".zshrc" || base === ".profile") return "sh";
    const ext = base.includes(".") ? base.split(".").pop()! : "";
    return normalizeLang(ext);
}

export function normalizeLang(lang: string | undefined): string | undefined {
    if (!lang) return undefined;
    const l = lang.toLowerCase().trim();
    if (l === "diff" || l === "patch") return "diff";
    if (l === "md" || l === "markdown") return undefined;
    if (LANGS[l]) return l;
    return ALIASES[l];
}

export class Highlighter {
    private spec?: LangSpec;
    private lang?: string;
    /** Open block comment end token or multiline string delimiter. */
    private state: { kind: "comment" | "string"; end: string } | undefined;

    constructor(lang: string | undefined) {
        this.lang = normalizeLang(lang);
        this.spec = this.lang && this.lang !== "diff" ? LANGS[this.lang] : undefined;
    }

    line(src: string): string {
        if (this.lang === "diff") return diffLine(src);
        const spec = this.spec;
        if (!spec) return src;
        let out = "";
        let i = 0;
        const n = src.length;
        if (this.state) {
            // Strings honour backslash escapes (an escaped backtick doesn't close a template literal).
            const end = this.state.kind === "comment" ? src.indexOf(this.state.end) : unescapedIndexOf(src, this.state.end);
            const style = this.state.kind === "comment" ? theme.synComment : theme.synString;
            if (end < 0) return style(src);
            out += style(src.slice(0, end + this.state.end.length));
            i = end + this.state.end.length;
            this.state = undefined;
        }
        while (i < n) {
            const rest = src.slice(i);
            // line comment
            const lc = spec.line?.find((t) => rest.startsWith(t) && (t !== "#" || this.lang !== "css"));
            if (lc) {
                out += theme.synComment(rest);
                break;
            }
            // block comment
            const bc = spec.block?.find(([s]) => rest.startsWith(s));
            if (bc) {
                const end = rest.indexOf(bc[1], bc[0].length);
                if (end < 0) {
                    out += theme.synComment(rest);
                    this.state = { kind: "comment", end: bc[1] };
                    break;
                }
                out += theme.synComment(rest.slice(0, end + bc[1].length));
                i += end + bc[1].length;
                continue;
            }
            // strings
            const q = spec.strings.find((s) => rest.startsWith(s));
            if (q) {
                let j = q.length;
                let closed = false;
                while (j < rest.length) {
                    if (rest[j] === "\\" && q !== "'''" && !(this.lang === "sh" && q === "'")) {
                        j += 2;
                        continue;
                    }
                    if (rest.startsWith(q, j)) {
                        j += q.length;
                        closed = true;
                        break;
                    }
                    j++;
                }
                const text = rest.slice(0, Math.min(j, rest.length));
                // JSON keys look nicer in a different color
                if (this.lang === "json" && closed && /^\s*:/.test(rest.slice(j))) out += theme.synFunc(text);
                else out += theme.synString(text);
                if (!closed && spec.multiline?.includes(q)) this.state = { kind: "string", end: q };
                i += text.length;
                continue;
            }
            const c = src[i]!;
            // numbers
            if (/[0-9]/.test(c) && (i === 0 || !/[\w$]/.test(src[i - 1]!))) {
                const m = rest.match(/^(0x[0-9a-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?)[a-zA-Z]*/);
                if (m) {
                    out += theme.synNumber(m[0]);
                    i += m[0].length;
                    continue;
                }
            }
            // shell / php variables
            if (spec.vars && c === "$") {
                const m = rest.match(/^\$(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@#?*!$-])/);
                if (m) {
                    out += theme.synType(m[0]);
                    i += m[0].length;
                    continue;
                }
            }
            // identifiers / keywords
            if (/[A-Za-z_$]/.test(c) || (this.lang === "css" && /[@!]/.test(c))) {
                const m = rest.match(this.lang === "css" ? /^[@!]?[A-Za-z_$][\w$-]*/ : /^[A-Za-z_$][\w$?-]*/);
                if (m) {
                    let w = m[0];
                    // don't swallow hyphens except in css/sh-style words
                    if (this.lang !== "css" && this.lang !== "sh" && this.lang !== "yaml") w = w.replace(/-.*$/, "").replace(/\?$/, this.lang === "rb" ? "?" : "");
                    if (!w) w = c;
                    const lw = this.lang === "sql" ? w.toLowerCase() : w;
                    const after = src.slice(i + w.length);
                    if (spec.keywords.has(lw)) out += theme.synKeyword(w);
                    else if (spec.literals?.has(lw)) out += theme.synNumber(w);
                    else if (spec.types?.has(lw) || (/^[A-Z][a-z0-9]/.test(w) && this.lang !== "sql")) out += theme.synType(w);
                    else if (/^\s*\(/.test(after)) out += theme.synFunc(w);
                    else if (this.lang === "yaml" && /^\s*:/.test(after) && out.replace(/\x1b\[[0-9;]*m/g, "").trim() === "") out += theme.synFunc(w);
                    else out += w;
                    i += w.length;
                    continue;
                }
            }
            // html/xml tags
            if (this.lang === "html" && c === "<") {
                const m = rest.match(/^<\/?[A-Za-z][\w:-]*/);
                if (m) {
                    out += theme.synKeyword(m[0]);
                    i += m[0].length;
                    continue;
                }
            }
            out += c;
            i++;
        }
        return out;
    }
}

function diffLine(src: string): string {
    if (src.startsWith("+++") || src.startsWith("---")) return theme.heading(src);
    if (src.startsWith("+")) return theme.diffAddedFg(src);
    if (src.startsWith("-")) return theme.diffRemovedFg(src);
    if (src.startsWith("@@")) return theme.info(src);
    return src;
}

export function highlightCode(code: string, lang: string | undefined): string[] {
    const h = new Highlighter(lang);
    return code.split("\n").map((l) => h.line(l));
}

function unescapedIndexOf(s: string, delim: string, from = 0): number {
    for (let k = from; k < s.length; k++) {
        if (s[k] === "\\") {
            k++;
            continue;
        }
        if (s.startsWith(delim, k)) return k;
    }
    return -1;
}
