// Markdown for model output. Two rules beyond rendering:
//
// Safety: the text comes from a model that may have read hostile content, so
//   raw HTML is shown as text, links only open http(s)/mailto (and only through
//   the app, never navigating the window), and remote images are never
//   loaded: an image URL is a way to send data out the moment it's displayed.
//   A local image file is shown (wherever it is: mockups often live in /tmp):
//   the element carries no src, only data-image-file with the path as
//   written, and the caller fills it in with the file's bytes from the server
//   (which resolves it against the session's folder and checks it's an image).
//
// Speed: while a reply streams, it's split into top-level blocks and each
//   finished block's HTML is cached by its source, so only the block still
//   being written is rendered again on each update.
//
// Streaming: the end of a reply still being written is shown as it will
//   read once it's finished (see `settle`), so markers never flash as raw
//   text before snapping into place.
//
// File links: paths in the text (relative to the session's folder or absolute,
//   with an optional :line or :line:col), in inline code or as a link's target,
//   become links to open in the editor, but only once the server has said the
//   file exists inside the session's folders. Rendering never waits or fetches:
//   it takes what's known (`lookup`), renders unknown paths as plain text and
//   lists them in `pending`; the caller asks the server in a batch and renders
//   again. URLs never reach the path matcher (marked makes them links first,
//   and anything with a scheme is skipped), and fenced code is left alone.

import { Marked, Renderer, type Token, type Tokens } from "marked";

export function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeHref(href: string): string | undefined {
    const h = href.trim();
    if (/^(https?:\/\/|mailto:)/i.test(h)) return h;
    return undefined;
}

// ---------------------------------------------------------------------------
// File paths

export interface PathRef {
    path: string;
    line?: number;
    col?: number;
}

/** What's known about a path: its absolute path when it's a file in the session, null when not, undefined when not asked yet. */
export type PathLookup = (path: string) => string | null | undefined;

// A path: optional ~/ ./ ../ or /, then name/name/...; then :line[:col] or
// #Lline[Ccol], and an ignored range end after the line (:10-20, #L10-L20).
// The range end belongs to the line: without one, "-123" is part of the name
// (src/file-123), even where the path itself matches anything (link targets).
const POS = String.raw`(?::(\d{1,8})(?::(\d{1,6}))?(?:-\d{1,8})?|#L(\d{1,8})(?:C(\d{1,6}))?(?:-L?\d{1,8}(?:C\d{1,6})?)?)?$`;
const NAME = String.raw`[\p{L}\p{N}_@+.\-]`;
const NAME_SPACED = String.raw`[\p{L}\p{N}_@+.\- ]`;
const PATH_REF = new RegExp(String.raw`^((?:~\/|\.{1,2}\/|\/)?(?:${NAME}+\/)*${NAME}+)` + POS, "u");
const PATH_REF_SPACED = new RegExp(String.raw`^((?:~\/|\.{1,2}\/|\/)?(?:${NAME_SPACED}+\/)*${NAME_SPACED}+)` + POS, "u");
const PATH_REF_ANY = new RegExp(String.raw`^(.+?)` + POS, "su");

/**
 * A path reference, or undefined when `s` doesn't look like one. In prose
 * (and inline code, which may have spaces) it needs a slash or a file
 * extension; a link's target is a path by intent, so any name will do. None
 * may start with '-'.
 */
export function parsePathRef(s: string, kind: "prose" | "code" | "target" = "prose"): PathRef | undefined {
    const m = (kind === "prose" ? PATH_REF : kind === "code" ? PATH_REF_SPACED : PATH_REF_ANY).exec(s);
    if (!m) return undefined;
    const path = m[1]!;
    if (path.startsWith("-") || path.startsWith(" ") || path.endsWith(" ") || path.endsWith("/") || /[\u0000-\u001f\u007f]/.test(path)) return undefined;
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!name || name === "." || name === "..") return undefined;
    if (kind !== "target") {
        if (path.endsWith(".") || !/\p{L}/u.test(path)) return undefined;
        const hasExt = /[^.]\.\p{L}[\p{L}\p{N}]{0,9}$/u.test(name);
        if (!path.includes("/") && (!hasExt || path.length < 4)) return undefined;
    }
    const line = Number(m[2] ?? m[4]) || undefined;
    const col = line ? Number(m[3] ?? m[5]) || undefined : undefined;
    return { path, line, col };
}

/** A URL or anything else with a scheme ("C:" and "file.ts:12" aren't). */
const SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;
// Wrapping punctuation. Not _ or *: marked has already taken the emphasis, so
// any left are part of the name (_config.ts).
const LEAD = /^[(\[{"'<`]+/;
const TRAIL = /[)\]}"'>.,;:!?`]+$/;
/** Links per rendered block, at most: a wall of paths shouldn't mean a wall of lookups. */
const MAX_REFS = 200;

interface LinkContext {
    lookup: PathLookup;
    /** Every path looked up, and what was known about it then. */
    answers: Map<string, string | null | undefined>;
    refs: number;
    inLink: boolean;
}
let ctx: LinkContext | undefined;

/** The absolute path of a known file, or undefined (and noted as pending when not asked yet). */
function knownFile(ref: PathRef): string | undefined {
    if (!ctx || ctx.inLink || ctx.refs >= MAX_REFS) return undefined;
    ctx.refs++;
    const abs = ctx.lookup(ref.path);
    ctx.answers.set(ref.path, abs);
    return abs ?? undefined;
}

/** A link to a known file, or undefined (and noted as pending when not asked yet). */
function fileLink(ref: PathRef, inner: string): string | undefined {
    const abs = knownFile(ref);
    if (!abs) return undefined;
    const at = ref.line ? `:${ref.line}${ref.col ? `:${ref.col}` : ""}` : "";
    const pos = `${ref.line ? ` data-line="${ref.line}"` : ""}${ref.col ? ` data-col="${ref.col}"` : ""}`;
    return `<a class="md-file" data-file="${escapeHtml(abs)}"${pos} title="${escapeHtml(abs + at)}" role="link" tabindex="0">${inner}</a>`;
}

const plain = new Renderer();

/** Text with the paths in it linked; everything else escaped the way marked would. */
function linkifyText(text: string): string {
    let out = "";
    for (const part of text.split(/(\s+)/)) {
        const lead = LEAD.exec(part)?.[0] ?? "";
        const trail = TRAIL.exec(part.slice(lead.length))?.[0] ?? "";
        const core = part.slice(lead.length, part.length - trail.length);
        const ref = core && !SCHEME.test(core) && !core.includes("://") ? parsePathRef(core) : undefined;
        const link = ref && fileLink(ref, escapeHtml(core));
        out += link ? esc(lead) + link + esc(trail) : esc(part);
    }
    return out;
}

function esc(s: string): string {
    return s ? plain.text({ type: "text", raw: s, text: s }) : "";
}

/** A markdown link's target as a path: relative, absolute, or file://. */
function hrefPath(href: string): PathRef | undefined {
    const h = href.trim();
    if (!h || h.startsWith("#") || h.startsWith("//")) return undefined;
    try {
        if (/^file:/i.test(h)) {
            const u = new URL(h);
            if (u.hostname && u.hostname !== "localhost") return undefined;
            return parsePathRef(decodeURIComponent(u.pathname) + u.hash, "target");
        }
        if (SCHEME.test(h)) return undefined;
        return parsePathRef(decodeURI(h), "target");
    } catch {
        return undefined;
    }
}

/**
 * A table cell that's a number: "1,204", "41.2s", "-3", "12 %", "$4.50", "2.5 GB".
 * Not a version (0.42.1), a ratio (1/4), a date or a time.
 */
const NUMBER = /^[+\-−±~≈]?[$€£¥]?(?:\d{1,3}(?:[, ]\d{3})+|\d+)(?:\.\d+)?(?:\s?(?:%|×|[a-zA-Zµ]{1,3}))?$/;
/** Cells that say there's nothing there, which don't make a column any less numeric. */
const BLANK = /^(?:|-|–|—|n\/a)$/i;

/** Every cell with something in it is a number (emphasis and code marks aside), and at least one has. */
export function numericColumn(cells: readonly string[]): boolean {
    const filled = cells.map((c) => c.replace(/[*_`]/g, "").trim()).filter((c) => !BLANK.test(c));
    return filled.length > 0 && filled.every((c) => NUMBER.test(c));
}

const md = new Marked({ gfm: true, breaks: false, async: false });
md.use({
    renderer: {
        html({ text }: Tokens.HTML | Tokens.Tag) {
            return escapeHtml(text);
        },
        link({ href, title, tokens }: Tokens.Link) {
            // A link's own text isn't linked again: no links inside links.
            const outer = ctx?.inLink;
            if (ctx) ctx.inLink = true;
            const inner = this.parser.parseInline(tokens);
            if (ctx) ctx.inLink = Boolean(outer);
            const url = safeHref(href);
            if (!url) {
                const ref = hrefPath(href);
                return (ref && fileLink(ref, inner)) ?? inner;
            }
            return `<a href="${escapeHtml(url)}" data-external="1"${title ? ` title="${escapeHtml(title)}"` : ""} rel="noopener noreferrer">${inner}</a>`;
        },
        text(token: Tokens.Text | Tokens.Escape) {
            if (!ctx || token.type !== "text" || token.tokens || token.escaped) return false;
            return linkifyText(token.text);
        },
        codespan({ text }: Tokens.Codespan) {
            const ref = ctx && !ctx.inLink ? parsePathRef(text.trim(), "code") : undefined;
            return (ref && fileLink(ref, `<code>${escapeHtml(text)}</code>`)) ?? false;
        },
        image({ href, text }: Tokens.Image) {
            const url = safeHref(href);
            const label = escapeHtml(text || "image");
            if (url) return `<a class="md-image" href="${escapeHtml(url)}" data-external="1" title="Images aren't loaded automatically. Open ${escapeHtml(url)}">${label}</a>`;
            // Only with a session to read it from, and never inside a link (no links inside links).
            const ref = ctx && !ctx.inLink ? hrefPath(href) : undefined;
            return ref ? `<img class="md-img" data-image-file="${escapeHtml(ref.path)}" alt="${label}" title="${escapeHtml(ref.path)}">` : `<span class="md-image">${label}</span>`;
        },
        code({ text, lang }: Tokens.Code) {
            return `<pre class="md-pre"><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}>${escapeHtml(text)}</code></pre>`;
        },
        table(token: Tokens.Table) {
            // A column the reply didn't align itself, whose every cell is a number, is aligned at the right, header and all.
            const numeric = token.header.map((_, i) => !token.align[i] && numericColumn(token.rows.map((r) => r[i]?.text ?? "")));
            const cell = (c: Tokens.TableCell, i: number) => {
                const tag = c.header ? "th" : "td";
                const attrs = c.align ? ` align="${c.align}"` : numeric[i] ? ` class="num"` : "";
                return `<${tag}${attrs}>${this.parser.parseInline(c.tokens)}</${tag}>`;
            };
            // Wide tables scroll inside their own box instead of widening the page.
            const head = `<tr>${token.header.map(cell).join("")}</tr>`;
            const body = token.rows.map((r) => `<tr>${r.map(cell).join("")}</tr>`).join("");
            return `<div class="md-table"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
        },
        checkbox({ checked }: Tokens.Checkbox) {
            return `<span class="md-check${checked ? " on" : ""}" aria-hidden="true"></span>`;
        },
    },
});

/**
 * `answers`: each path the block looked up and what was known about it then
 * (undefined: not asked yet). It's rendered again when what's known about one
 * changes: answered, forgotten (files changed, another editor chosen), or failed.
 */
export type Segment = { kind: "html"; key: string; html: string; answers?: [string, string | null | undefined][] } | { kind: "code"; key: string; lang: string; code: string; open: boolean };

/** Renders one reply; keeps finished blocks between calls. */
export class MarkdownRenderer {
    private html = new Map<string, Segment>();
    private lexed?: { text: string; streaming: boolean; tokens: Token[] & { links?: unknown }; tailIndex: number; tailStart: number };
    private references = "";
    /** Paths in the last render that `lookup` didn't know. */
    pending = new Set<string>();
    /** The last render looked up paths, so a change in what's known may change it. */
    watching = false;
    /** Every path the last render looked up: what this reply has on screen. */
    paths = new Set<string>();

    private note(answers: Iterable<[string, string | null | undefined]>) {
        for (const [p, a] of answers) {
            this.watching = true;
            this.paths.add(p);
            if (a === undefined) this.pending.add(p);
        }
    }

    /** With `lookup`, paths to known files become links (see the top of this file). */
    segments(text: string, streaming: boolean, lookup?: PathLookup): Segment[] {
        this.pending = new Set();
        this.watching = false;
        this.paths = new Set();
        let tokens: Token[] & { links?: unknown };
        let relexedFrom = Infinity;
        try {
            // Rendered again with the same text when answers arrive: lex it once.
            const previous = this.lexed;
            if (previous?.text === text && previous.streaming === streaming) tokens = previous.tokens;
            else {
                // Freeze only across a blank line after a closed, stable block.
                // Adjacent blocks can change classification as markers arrive
                // (e.g. '> b\n--'), and lists/quotes can absorb lazy continuations.
                // Reference definitions can change earlier inline tokens, so any
                // '[' takes the conservative full-lexer path. Normalized source
                // (e.g. CRLF) and replacements also use the full lexer.
                // While streaming, only the tail is settled: frozen blocks are
                // closed, and settle() only changes the end of what it's given.
                const append = previous && previous.streaming === streaming && previous.tailStart >= 0 && text.startsWith(previous.text) && !text.includes("[");
                relexedFrom = append ? previous.tailIndex : 0;
                const from = append ? previous.tailStart : 0;
                const source = streaming ? settle(text.slice(from)) : text.slice(from);
                const tail = md.lexer(source);
                tokens = append ? Object.assign([...previous.tokens.slice(0, previous.tailIndex), ...tail], { links: tail.links }) : tail;
                const view = text.slice(0, from) + source;
                const raw = tokens.map((t) => t.raw).join("");
                let tailIndex = 0;
                let tailStart = raw === view ? 0 : -1;
                let offset = 0;
                let stable = false;
                // Leave at least the final non-space block mutable, even if it
                // currently ends in a blank line. Indented code, lists, quotes
                // and HTML remain mutable until a later stable block closes.
                let last = tokens.length - 1;
                while (last > 0 && tokens[last]?.type === "space") last--;
                for (let i = 0; tailStart >= 0 && i < last; i++) {
                    const t = tokens[i]!;
                    offset += t.raw.length;
                    if (t.type !== "space") stable = t.type === "paragraph" || t.type === "heading" || t.type === "hr" || (t.type === "code" && (t as Tokens.Code).codeBlockStyle !== "indented");
                    if (stable && raw.slice(offset - 2, offset) === "\n\n") {
                        tailIndex = i + 1;
                        tailStart = offset;
                    }
                }
                this.lexed = { text, streaming, tokens, tailIndex, tailStart };
            }
            // A late reference definition must also invalidate cached HTML.
            const references = JSON.stringify(tokens.links ?? {});
            if (references !== this.references) this.html.clear();
            this.references = references;
        } catch {
            return [{ kind: "html", key: "err", html: `<p>${escapeHtml(text)}</p>` }];
        }
        const out: Segment[] = [];
        const next = new Map<string, Segment>();
        tokens.forEach((t, i) => {
            if (t.type === "space" || t.type === "def") return;
            const last = i === tokens.length - 1;
            // The same source can change block kind as nearby markers arrive.
            const cacheKey = `${t.type}\0${t.raw}`;
            if (t.type === "code" && (t as Tokens.Code).codeBlockStyle !== "indented") {
                const c = t as Tokens.Code;
                const open = streaming && last && !/(`{3,}|~{3,})\s*$/.test(c.raw.trimEnd());
                const key = `c${i}`;
                const prev = this.html.get(cacheKey);
                const seg: Segment = prev?.kind === "code" && prev.open === open ? prev : { kind: "code", key, lang: (c.lang ?? "").split(/\s/)[0] ?? "", code: c.text, open };
                next.set(cacheKey, seg);
                out.push(seg);
                return;
            }
            const cached = this.html.get(cacheKey);
            const stale = lookup && cached?.kind === "html" && cached.answers?.some(([p, a]) => lookup(p) !== a);
            // Mutable tokens can change meaning without changing raw source
            // (e.g. indentation in a paragraph followed by a list marker).
            if (cached && !stale && i < relexedFrom) {
                if (cached.kind === "html") this.note(cached.answers ?? []);
                next.set(cacheKey, cached);
                out.push(cached);
                return;
            }
            let html: string;
            const answers = new Map<string, string | null | undefined>();
            ctx = lookup && { lookup, answers, refs: 0, inLink: false };
            try {
                html = md.parser(Object.assign([t], { links: tokens.links ?? {} }) as unknown as Token[]);
            } catch {
                html = `<p>${escapeHtml(t.raw)}</p>`;
            } finally {
                ctx = undefined;
            }
            this.note(answers);
            // Same HTML as before (nothing new known yet): same object, so the DOM stays.
            if (cached?.kind === "html" && cached.html === html) {
                cached.answers = [...answers];
                next.set(cacheKey, cached);
                out.push(cached);
                return;
            }
            const seg: Segment = { kind: "html", key: `h${i}:${t.raw.length}`, html, answers: [...answers] };
            next.set(cacheKey, seg);
            out.push(seg);
        });
        this.html = next;
        return out;
    }
}

// ---------------------------------------------------------------------------
// Streaming

/** A fence line: backticks can't appear in a backtick fence's info string. */
const FENCE = /^\s*(?:(`{3,})[^`]*|(~{3,}).*)$/;
/** A line that's only a marker so far: a list item, heading, quote or rule that hasn't said what it is yet. */
const BARE = /^\s*(?:[-*+]|\d{1,9}[.)]?|#{1,6}|>|[-=_*][-=_* ]*|`{1,2}|~{1,2})\s*$/;
const TABLE_ROW = /^\s*\|/;
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
/** What starts a line before its text: quote markers, a list marker, a task box. */
const LINE_PREFIX = /^\s*(?:>\s?)*(?:(?:[-*+]|\d{1,9}[.)])\s+)?(?:\[[ xX]\]\s+)?(?:#{1,6}\s+)?/;

/**
 * The end of a streaming reply as it will read once finished, so nothing
 * flashes as raw markdown and then snaps into place:
 *
 * - a line that's only a marker so far ("-", "1", "##", "---") waits for its text;
 * - a table waits for its header and delimiter row, then shows a row at a time;
 * - a code fence's opening line waits for its newline (the language is whole),
 *   and a closing fence for its last backtick;
 * - emphasis, strikethrough and inline code still open on the last line are
 *   closed (a marker with nothing after it yet waits), and a link still being
 *   written shows as its text.
 *
 * Only the end changes: the result is a prefix of `text` up to its last line,
 * so finished blocks before it lex the same.
 */
export function settle(text: string): string {
    const lines = text.split("\n");
    const starts: number[] = [];
    let at = 0;
    let fence: { char: string; len: number; line: number } | undefined;
    lines.forEach((line, i) => {
        starts.push(at);
        at += line.length + 1;
        const m = FENCE.exec(line);
        if (!m) return;
        const marker = m[1] ?? m[2]!;
        if (!fence) fence = { char: marker[0]!, len: marker.length, line: i };
        else if (marker[0] === fence.char && marker.length >= fence.len && line.trim() === marker) fence = undefined;
    });
    const last = lines.length - 1;
    const upTo = (line: number) => text.slice(0, starts[line]);
    if (fence) {
        // The opening line until its language is whole; a closing fence until its last backtick.
        if (fence.line === last) return upTo(last);
        const l = lines[last]!.trim();
        if (l && l.length < fence.len && [...l].every((c) => c === fence!.char)) return upTo(last);
        return text;
    }
    let end = lines.length;
    // A line that's only a marker (the last, or the one before a newline that just arrived).
    for (let k = 0; k < 2 && end > 0; k++) {
        const i = lines[end - 1] === "" && end > 1 && k === 0 ? end - 2 : end - 1;
        if (!BARE.test(lines[i]!) || !lines[i]!.trim()) break;
        end = i;
    }
    // A table: whole once the delimiter row is in, then complete rows only.
    const runEnd = end > 0 && lines[end - 1] === "" ? end - 1 : end;
    let t = runEnd;
    while (t > 0 && TABLE_ROW.test(lines[t - 1]!)) t--;
    if (t < runEnd) {
        const finished = runEnd < lines.length; // the run's last line has its newline
        const delimiter = runEnd - t >= 2 && DELIMITER.test(lines[t + 1]!) && lines[t + 1]!.includes("|") && (t + 2 < runEnd || finished);
        if (!delimiter) end = t;
        else if (!finished) end = runEnd - 1;
    }
    if (end < lines.length) return upTo(end);
    const start = starts[last]!;
    return text.slice(0, start) + closeInline(lines[last]!);
}

/** One line still being written, with its open inline markers closed. */
function closeInline(line: string): string {
    const prefix = LINE_PREFIX.exec(line)?.[0] ?? "";
    // Markers at the very end may be an opener with nothing after it yet, or half a closer.
    let body = line.slice(prefix.length).replace(/[*_~`]+$/, "");
    // A link still being written: its text for now.
    body = body.replace(/\[([^\]\n]*)\]\([^)\s]*$/, "$1").replace(/(^|[\s(])\[([^\]\n]*)\]?$/, "$1$2");
    const open: string[] = [];
    for (let i = 0; i < body.length; ) {
        const c = body[i]!;
        if (c === "\\") {
            i += 2;
            continue;
        }
        if (c === "`") {
            const run = /^`+/.exec(body.slice(i))![0];
            const close = body.indexOf(run, i + run.length);
            if (close < 0) {
                // Everything after an open code span is code.
                open.push(run);
                break;
            }
            i = close + run.length;
            continue;
        }
        if (c !== "*" && c !== "_" && c !== "~") {
            i++;
            continue;
        }
        let j = i;
        while (body[j] === c) j++;
        const run = body.slice(i, j);
        const before = body[i - 1] ?? " ";
        const after = body[j] ?? " ";
        i = j;
        if (c === "~" && run.length !== 2) continue;
        // snake_case isn't emphasis.
        if (c === "_" && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) continue;
        if (open.at(-1) === run && !/\s/.test(before)) open.pop();
        else if (!/\s/.test(after)) open.push(run);
    }
    if (!open.length) return prefix + body;
    // A closer must touch the text it closes.
    const code = open.at(-1)!.startsWith("`");
    return prefix + (code ? body : body.trimEnd()) + open.reverse().join("");
}

/** Markdown to HTML in one go (plans, summaries). */
export function renderMarkdown(text: string): string {
    try {
        return md.parse(text) as string;
    } catch {
        return `<p>${escapeHtml(text)}</p>`;
    }
}
