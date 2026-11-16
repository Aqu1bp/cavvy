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

/** A finished reply as rendered: its blocks, and the reference definitions they were rendered with. */
type Rendered = { out: Segment[]; references: string; chars: number };
/**
 * Finished replies rendered lately, by their text, the last used last: one shown again (a session switched back to, a
 * page of turns read again) is what it was, not lexed and rendered anew (a 60 KB reply: 12 ms of a switch's 67,
 * measured). Only its blocks are kept, not the lexer's tokens (four times the reply, measured): a block whose paths are
 * known differently since is rendered again from the reply lexed anew.
 */
const done = { linked: new Map<string, Rendered>(), plain: new Map<string, Rendered>() };
let doneChars = 0;
/**
 * What's kept, in characters: the replies (their keys), their blocks' HTML and code, and SEGMENT_CHARS a block. Full,
 * about 6 MB more than none kept (forty 60 KB replies: 11.0 MB retained against 4.8, measured in V8).
 */
const DONE_CHARS = 2_000_000;
const SEGMENT_CHARS = 64;

const sizeOf = (text: string, out: readonly Segment[]) => out.reduce((n, s) => n + SEGMENT_CHARS + (s.kind === "html" ? s.html.length : s.code.length), text.length);

/** Kept for its views that look paths up (`linked`: those that are files become links), or for those that don't. */
function keep(kept: Map<string, Rendered>, text: string, r: Rendered) {
    const had = kept.get(text);
    if (had) {
        kept.delete(text);
        doneChars -= had.chars;
    }
    if (r.chars > DONE_CHARS / 4) return;
    kept.set(text, r);
    doneChars += r.chars;
    order.set(r, ++used);
    // The least lately used first, of either.
    while (doneChars > DONE_CHARS) {
        const p = done.plain.entries().next().value;
        const l = done.linked.entries().next().value;
        const [map, entry] = !l || (p && order.get(p[1])! < order.get(l[1])!) ? [done.plain, p!] : [done.linked, l];
        map.delete(entry[0]);
        doneChars -= entry[1].chars;
    }
}
/** When each was last kept or used (for eviction across both maps). */
const order = new WeakMap<Rendered, number>();
let used = 0;

/** Whether each of `out`'s blocks is rendered with what `lookup` knows now. */
function fresh(out: readonly Segment[], lookup?: PathLookup): boolean {
    if (!lookup) return true;
    for (const s of out) if (s.kind === "html" && s.answers?.some(([p, a]) => lookup(p) !== a)) return false;
    return true;
}

/** The blocks of `out` by what they were rendered from (as segments() keys them), with `tokens` that reply lexed. */
function byToken(tokens: Token[], out: readonly Segment[]): Map<string, Segment> {
    const map = new Map<string, Segment>();
    let j = 0;
    for (const t of tokens) {
        if (t.type === "space" || t.type === "def") continue;
        const s = out[j++];
        if (!s) return new Map();
        map.set(`${t.type}\0${t.raw}`, s);
    }
    return j === out.length ? map : new Map();
}

/** Renders one reply; keeps finished blocks between calls. */
export class MarkdownRenderer {
    private html = new Map<string, Segment>();
    lexed?: { text: string; streaming: boolean; tokens: Token[] & { links?: unknown }; tailIndex: number; tailStart: number; line?: OpenLine; list?: OpenList };
    private references = "";
    /** The open paragraph's block, rendered by `appendLine` rather than by marked: its token and what it renders as. */
    private ready?: { token: Token; html: string; answers: [string, string | null | undefined][] };
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
        this.ready = undefined;
        // A finished reply rendered before (by this view or another): as it was, where nothing it shows is known
        // differently since; else from its blocks, those that are rendered again.
        const kept = lookup ? done.linked : done.plain;
        const was = streaming ? undefined : kept.get(text);
        if (was && fresh(was.out, lookup)) {
            for (const seg of was.out) if (seg.kind === "html") this.note(seg.answers ?? []);
            keep(kept, text, was);
            return was.out;
        }
        if (was && this.lexed?.text !== text) {
            try {
                const lexed = md.lexer(text);
                this.lexed = { text, streaming: false, tokens: lexed, tailIndex: 0, tailStart: -1 };
                this.html = byToken(lexed, was.out);
                this.references = was.references;
            } catch { /* lexed again below, as any other */ }
        }
        try {
            // Rendered again with the same text when answers arrive: lex it once.
            const previous = this.lexed;
            const appendedLine = previous?.text !== text ? this.appendLine(previous, text, streaming, lookup) : undefined;
            if (previous?.text === text && previous.streaming === streaming) tokens = previous.tokens;
            else if (appendedLine) {
                tokens = appendedLine;
                relexedFrom = previous!.tailIndex;
            } else {
                // Freeze only across a blank line after a closed, stable block.
                // Adjacent blocks can change classification as markers arrive
                // (e.g. '> b\n--'), and lists/quotes can absorb lazy continuations.
                // A reference definition can change earlier inline tokens, so a
                // reply that has one (what's frozen had, or the tail just lexed
                // has) takes the full lexer: by what the lexer found, not by
                // "]:" in the text, which code has all the time ("[key: string]:",
                // "dict[str, int]:") and which made every later update lex the
                // whole reply. Normalized source (e.g. CRLF) and replacements also
                // use the full lexer.
                // While streaming, only the tail is settled: frozen blocks are
                // closed, and settle() only changes the end of what it's given,
                // so the last render (no longer streaming) keeps them too.
                // Its one-line paragraph finished (a blank line after it): kept as rendered, not lexed again (endLine).
                const base = streaming && previous?.line ? (this.endLine(previous, text, lookup) ?? previous) : previous;
                const append = base && (base.streaming === streaming || base.streaming) && base.tailStart >= 0 && !hasLinks(base.tokens) && text.startsWith(base.text);
                let from = append ? base.tailStart : 0;
                // The tail ends in a list or a table: only its last item or row is lexed again (listTail, tableTail).
                const spliced = append && streaming ? (base.list?.head !== undefined ? tableTail(base, text) : listTail(base, text)) : undefined;
                let source = spliced ? spliced.source : streaming ? settle(text.slice(from)) : text.slice(from);
                let tail = spliced?.tail ?? ((streaming && openFence(source)) || (streaming ? lexOnce(source) : md.lexer(source)));
                if (append && hasLinks(tail)) {
                    from = 0;
                    source = streaming ? settle(text) : text;
                    tail = md.lexer(source);
                }
                const appended = append && from > 0;
                relexedFrom = appended ? base.tailIndex : 0;
                tokens = appended ? Object.assign([...base.tokens.slice(0, base.tailIndex), ...tail], { links: tail.links }) : tail;
                // What's frozen was checked when it was lexed: only the tail is looked at again.
                const at = (k: number) => (k < from ? text[k] : source[k - from]);
                let tailIndex = appended ? base.tailIndex : 0;
                // Where the tail starts holds whether or not its tokens add up to what was lexed (a list's last line
                // ends in a space, its raw in a newline): only new freezes need the tokens' offsets.
                const exact = tail.map((t) => t.raw).join("") === source;
                let tailStart = from;
                let offset = from;
                // A freeze comes after a stable block, so the tail starts after one.
                let stable = appended;
                // Leave at least the final non-space block mutable, even if it
                // currently ends in a blank line. Indented code, lists, quotes
                // and tables are closed by a blank line and then a line that
                // starts with text (it can't be indented into them, or be lazily
                // continued, and the same list's marker would have joined it):
                // what's written after can't reach back past it. HTML remains
                // mutable until a later stable block closes.
                let closable = false;
                let last = tokens.length - 1;
                while (last > 0 && tokens[last]?.type === "space") last--;
                // A fence closed in what's written (not by settle()), then a blank line: nothing after it can change it,
                // so it's frozen now rather than lexed again with the block after it.
                const upto = closedFence(tokens[last]) && text.startsWith(source, from) ? tokens.length : last;
                for (let i = tailIndex; exact && i < upto; i++) {
                    const t = tokens[i]!;
                    offset += t.raw.length;
                    if (t.type !== "space") {
                        stable = t.type === "paragraph" || t.type === "heading" || t.type === "hr" || (t.type === "code" && (t as Tokens.Code).codeBlockStyle !== "indented");
                        closable = t.type === "list" || t.type === "blockquote" || t.type === "table" || t.type === "code";
                    }
                    const next = at(offset);
                    if ((stable || (closable && next !== undefined && next !== " " && next !== "\t" && next !== "\n" && next !== "\r")) && at(offset - 2) === "\n" && at(offset - 1) === "\n") {
                        tailIndex = i + 1;
                        tailStart = offset;
                    }
                }
                // The reply ends in a paragraph of one line, the only block not yet settled: words appended to it are
                // rendered as they come rather than the line lexed again with each (appendLine).
                const open = exact && tailIndex === tokens.length - 1 && tokens[tailIndex]!.type === "paragraph" && !hasLinks(tokens) && OPEN_LINE.test(text.slice(tailStart, tailStart + 3)) && !/[\r\n]/.test(text.slice(tailStart));
                const was = append && base?.list?.from === tailStart ? base.list : undefined;
                const list = streaming && !hasLinks(tokens) ? (openList(text, tokens, tailIndex, tailStart, last, was) ?? openTable(text, tokens, tailIndex, tailStart, last, was)) : undefined;
                const line = (spliced as { line?: ItemLine } | undefined)?.line;
                if (list && line && list.at === line.at && list.head === undefined) list.line = line;
                this.lexed = { text, streaming, tokens, tailIndex, tailStart, ...(open ? { line: { start: tailStart, frozen: tailStart, scan: tailStart, open: [], html: "", inline: [], answers: new Map(), refs: 0, linked: Boolean(lookup), dead: false } } : {}), ...(list ? { list } : {}) };
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
            if (t === this.ready?.token) {
                const { html, answers } = this.ready;
                this.note(answers);
                const cached = this.html.get(cacheKey);
                const seg: Segment = cached?.kind === "html" && cached.html === html ? Object.assign(cached, { answers }) : { kind: "html", key: `h${i}:${t.raw.length}`, html, answers };
                next.set(cacheKey, seg);
                out.push(seg);
                return;
            }
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
        if (!streaming && this.lexed?.text === text) keep(kept, text, { out, references: this.references, chars: sizeOf(text, out) });
        return out;
    }

    /**
     * The reply's last paragraph, one line, with more written on the same line: its tokens, the paragraph's rendered by
     * this (`ready`) rather than lexed again whole. What's before the last space that nothing open spans (no emphasis
     * or code span still open, nothing that can reach past it) renders the same whatever follows, so it's rendered
     * once, a piece at a time; only what's after is rendered with each update. Undefined: not that, lexed as usual.
     */
    private appendLine(previous: MarkdownRenderer["lexed"], text: string, streaming: boolean, lookup?: PathLookup): (Token[] & { links?: unknown }) | undefined {
        const line = previous?.line;
        if (!previous || !line || (!streaming && !previous.streaming) || (streaming && !previous.streaming) || line.linked !== Boolean(lookup) || !text.startsWith(previous.text)) return undefined;
        if (text.indexOf("\n", previous.text.length) >= 0 || text.indexOf("\r", previous.text.length) >= 0) return undefined;
        if (lookup) for (const [p, a] of line.answers) if (lookup(p) !== a) return undefined;
        const next: OpenLine = { ...line, open: [...line.open], answers: new Map(line.answers) };
        if (!next.dead) {
            const freeze = freezePoint(next, text);
            const piece = text.slice(next.frozen, freeze);
            // settle() closes what it reads as open over the whole line: none of it may be open after this piece either.
            if (piece && openMarkers(piece).length) next.dead = true;
            else if (piece) {
                const answers = new Map<string, string | null | undefined>();
                ctx = lookup && { lookup, answers, refs: next.refs, inLink: false };
                try {
                    const inline = md.Lexer.lexInline(piece, md.defaults);
                    next.html += md.Parser.parseInline(inline, md.defaults);
                    next.inline = next.inline.concat(inline);
                    if (ctx) next.refs = ctx.refs;
                } catch {
                    return undefined;
                } finally {
                    ctx = undefined;
                }
                for (const [p, a] of answers) next.answers.set(p, a);
                next.frozen = freeze;
            }
        }
        const rest = text.slice(next.frozen);
        const live = streaming ? closeInline(rest, false) : rest;
        const answers = new Map(next.answers);
        let html: string;
        ctx = lookup && { lookup, answers, refs: next.refs, inLink: false };
        let inline: Token[];
        try {
            const tail = md.Lexer.lexInline(live, md.defaults);
            html = `<p>${next.html}${md.Parser.parseInline(tail, md.defaults)}</p>\n`;
            inline = next.inline.concat(tail);
        } catch {
            return undefined;
        } finally {
            ctx = undefined;
        }
        const raw = text.slice(next.start, next.frozen) + live;
        // Its words as rendered: rendered again from them when an answer changes (a path found to be a file).
        const token = { type: "paragraph", raw, text: raw, tokens: inline } as Tokens.Paragraph;
        const tokens = Object.assign([...previous.tokens.slice(0, previous.tailIndex), token], { links: previous.tokens.links });
        this.ready = { token, html, answers: [...answers] };
        this.lexed = { text, streaming, tokens, tailIndex: previous.tailIndex, tailStart: previous.tailStart, line: next };
        return tokens;
    }

    /**
     * The reply's last paragraph, one line, finished: a blank line after it, so nothing written after can change it.
     * What `previous` would be with it lexed whole and frozen, its tokens what's rendered for good of it (OpenLine) and
     * the rest of it read once; else undefined. What's after it is then lexed as any tail is.
     */
    private endLine(previous: NonNullable<MarkdownRenderer["lexed"]>, text: string, lookup?: PathLookup): MarkdownRenderer["lexed"] {
        const line = previous.line!;
        if (!previous.streaming || line.linked !== Boolean(lookup) || !text.startsWith(previous.text)) return undefined;
        const end = text.indexOf("\n", line.start);
        if (end < 0 || !/^\n[ \t]*\n/.test(text.slice(end, end + 64)) || text.slice(line.start, end).includes("\r")) return undefined;
        if (lookup) for (const [p, a] of line.answers) if (lookup(p) !== a) return undefined;
        const answers = new Map(line.answers);
        let inline: Token[];
        let html: string;
        ctx = lookup && { lookup, answers, refs: line.refs, inLink: false };
        try {
            const rest = md.Lexer.lexInline(text.slice(line.frozen, end), md.defaults);
            html = `<p>${line.html}${md.Parser.parseInline(rest, md.defaults)}</p>\n`;
            inline = line.inline.concat(rest);
        } catch {
            return undefined;
        } finally {
            ctx = undefined;
        }
        const raw = text.slice(line.start, end);
        const token = { type: "paragraph", raw, text: raw, tokens: inline } as Tokens.Paragraph;
        // Rendered already: as the segment for it, which segments() takes as it takes any block lexed before.
        this.html.set(`paragraph\0${raw}`, { kind: "html", key: `h${previous.tailIndex}:${raw.length}`, html, answers: [...answers] });
        const tokens = Object.assign([...previous.tokens.slice(0, previous.tailIndex), token], { links: previous.tokens.links });
        return { text: text.slice(0, end), streaming: true, tokens, tailIndex: previous.tailIndex + 1, tailStart: end };
    }
}

/**
 * Reads a line being written (`text`) on from `next.scan` to its last space: where what's before it renders the same
 * whatever follows (returned), with what's open there and how far it's read moved on in `next`. Nothing past a
 * character that can reach back over what follows is frozen (`dead`).
 */
function freezePoint(next: { frozen: number; scan: number; open: string[]; dead: boolean }, text: string): number {
    // Read up to the last space: a run of markers before it has what follows it.
    let end = text.length;
    while (end > next.scan && !/\s/.test(text[end - 1]!)) end--;
    let freeze = next.frozen;
    for (let i = next.scan; i < end; ) {
        const c = text[i]!;
        if (REACHES.test(c)) {
            next.dead = true;
            break;
        }
        if (c === "`") {
            let j = i;
            while (text[j] === "`") j++;
            const run = j - i;
            // Its end: the next run of exactly as many (marked's code span), before the last space.
            let close = -1;
            for (let k = j; k < end; ) {
                if (text[k] !== "`") { k++; continue; }
                let m = k;
                while (text[m] === "`") m++;
                if (m - k === run) { close = m; break; }
                k = m;
            }
            if (close < 0 || close > end) break;
            i = close;
            next.scan = i;
            continue;
        }
        if (c === "*" || c === "_") {
            let j = i;
            while (text[j] === c) j++;
            const run = text.slice(i, j);
            const before = text[i - 1] ?? " ";
            const after = text[j] ?? " ";
            i = j;
            next.scan = i;
            if (c === "_" && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) continue;
            if (next.open.at(-1) === run && !/\s/.test(before)) next.open.pop();
            else if (!/\s/.test(after)) next.open.push(run);
            continue;
        }
        i++;
        next.scan = i;
        if (/\s/.test(c) && !next.open.length) freeze = i;
    }
    return freeze;
}

/**
 * A reply's last paragraph while it's one line: what of it is rendered for good (`frozen`, as `html`), and how far it's
 * been read for where that can move to (`scan`, with the emphasis still `open` there).
 */
interface OpenLine {
    start: number;
    frozen: number;
    scan: number;
    open: string[];
    html: string;
    /** What `html` was rendered from. */
    inline: Token[];
    answers: Map<string, string | null | undefined>;
    /** Paths looked up so far in the paragraph (MAX_REFS a block). */
    refs: number;
    linked: boolean;
    /** Something that can reach back over what follows it (a link, raw HTML, an escape, a tilde): no more is frozen. */
    dead: boolean;
}

/**
 * A line that's a paragraph however it goes on: it can't become a list, heading, quote, fence, table, HTML or a break by
 * more being written on it.
 */
const OPEN_LINE = /^(?:\p{L}|[*_]{1,2}\p{L}|`[^`]|\d+[^\d.)])/u;

/** Characters whose meaning can reach past the next space to what's written after (links, HTML, escapes, strikes). */
const REACHES = /[[\]<\\~]/;

/**
 * A streaming reply's tail that ends in a list: where its last item starts (`at`), so what's appended is lexed from
 * there rather than from the list's start (or what's before it in the tail). Only the last item grows, or new ones
 * follow it.
 */
interface OpenList {
    /** The tail's start, which settle() reads from. */
    from: number;
    /** The list's index in the tokens, and where it starts. */
    index: number;
    start: number;
    at: number;
    /** What settle() has read from `from` to `at`: a fence open there, and the list isn't lexed from `at`. */
    scan: Scan;
    /** A table's instead: its header and delimiter rows, lexed with its last row (`at`) and what follows. */
    head?: string;
    /** Its last item while that's one line of text: lexed a piece at a time (itemLine). */
    line?: ItemLine;
}

/** A list's last item while it's one line of text: its marker's end (`body`), and its text lexed for good so far. */
interface ItemLine {
    at: number;
    body: number;
    frozen: number;
    scan: number;
    open: string[];
    inline: Token[];
    dead: boolean;
}
/** An item's line: its marker and the spaces after it (up to four: more and its text is indented code). */
const ITEM_MARKER = /^(?:[-*+]|\d{1,9}[.)]) {1,4}(?! )/;
/** A fence settle() reads as open; `within`: opened in a list item, it ends with the item, at a line indented less. */
type Fence = { char: string; len: number; within?: number };
/** What settle() reads line by line: the fence open, and the columns the text of the list items it's in starts at. */
type Scan = { fence?: Fence; items?: readonly number[] };
/** A list item's line: its marker, and the spaces after it (more than four: the text starts one after the marker). */
const ITEM = /^(\s*(?:[-*+]|\d{1,9}[.)]))( *)/;

/** What settle() reads after `line`, from `scan` before it. */
function scanLine(line: string, scan: Scan): Scan {
    let { fence, items = [] } = scan;
    const indent = line.length - line.trimStart().length;
    // A line indented less than an item's text ends the item, and a fence in it (a list's next item, or anything else).
    if (line.trim()) {
        if (fence?.within !== undefined && indent < fence.within) fence = undefined;
        if (!fence) while (items.length && indent < items.at(-1)!) items = items.slice(0, -1);
    }
    const m = FENCE.exec(line);
    if (m) {
        const marker = m[2] ?? m[3]!;
        if (fence) return marker[0] === fence.char && marker.length >= fence.len && line.trim() === marker ? { items } : { fence, items };
        // Opened after an item's marker, or indented into the item it's in: it ends with the item.
        const within = m[1] ? line.indexOf(marker) : items.at(-1);
        return { fence: { char: marker[0]!, len: marker.length, ...(within !== undefined ? { within } : {}) }, items: m[1] ? [...items, within!] : items };
    }
    if (fence) return { fence, items };
    const li = ITEM.exec(line);
    if (li && line.trim()) items = [...items, li[1]!.length + (li[2]!.length > 4 || li[2]!.length === line.length - li[1]!.length ? 1 : li[2]!.length)];
    return { fence, items };
}

/** What settle() reads after `lines` (each ending in a newline), from `scan`. */
function scanLines(lines: string, scan: Scan): Scan {
    for (const line of lines.split("\n")) scan = scanLine(line, scan);
    return scan;
}

/** Where `tokens` (lexed from `text` at `from`) ends in a list to lex from its last item next time, if it does. */
function openList(text: string, tokens: Token[], tailIndex: number, from: number, last: number, was: OpenList | undefined): OpenList | undefined {
    const list = tokens[last];
    if (list?.type !== "list" || last < tailIndex) return undefined;
    const items = (list as Tokens.List).items;
    if (!items.length) return undefined;
    let start = from;
    for (let k = tailIndex; k < last; k++) start += tokens[k]!.raw.length;
    let at = start;
    for (let k = 0; k < items.length - 1; k++) at += items[k]!.raw.length;
    // Its items as they are in the text (the tail's tokens may not add up where it ends: a list's last line ending
    // in a space, its raw in a newline).
    const raw = list.raw;
    if (!raw.startsWith(items.at(-1)!.raw, at - start) || text.slice(start, at) !== raw.slice(0, at - start)) return undefined;
    // settle() from `at` reads what it reads from `from`: no fence open there, and that item's first line not a bare
    // marker (which settle() holds back, and a table run before it).
    const scan = scanTo(text, from, at, was);
    const first = text.slice(at, text.indexOf("\n", at) + 1 || undefined).replace(/\n$/, "");
    // An item it's in (by settle()'s reading) that its line doesn't end: settle() from `at` wouldn't know of it.
    const indent = first.length - first.trimStart().length;
    return { from, index: last, start, at: scan.fence || scan.items?.some((c) => c <= indent) || BARE.test(first) || !first.trim() ? Infinity : at, scan };
}

/** What settle() reads from `from` to `at`: on from what it read to an earlier mark, where there's one. */
function scanTo(text: string, from: number, at: number, was: OpenList | undefined): Scan {
    return was && was.at <= at && was.at !== Infinity ? scanLines(text.slice(was.at, at), was.scan) : scanLines(text.slice(from, at), {});
}

/**
 * Where `tokens` ends in a table to lex from its last row next time, with its header and delimiter rows, if it does:
 * one whose rows (and header) all start with "|", which is how settle() finds a table, and with no such line before.
 */
function openTable(text: string, tokens: Token[], tailIndex: number, from: number, last: number, was: OpenList | undefined): OpenList | undefined {
    const table = tokens[last] as Tokens.Table | undefined;
    if (table?.type !== "table" || last < tailIndex || !table.rows.length) return undefined;
    let start = from;
    for (let k = tailIndex; k < last; k++) start += tokens[k]!.raw.length;
    const raw = table.raw;
    const body = raw.replace(/\n+$/, "");
    const lines = body.split("\n");
    if (lines.length !== table.rows.length + 2 || !lines.every((l) => TABLE_ROW.test(l))) return undefined;
    const at = start + body.length - lines.at(-1)!.length;
    if (text.slice(start, at) !== raw.slice(0, at - start)) return undefined;
    const before = start > from ? text.slice(text.lastIndexOf("\n", start - 2) + 1, start - 1) : "";
    const scan = scanTo(text, from, at, was);
    const head = `${lines[0]}\n${lines[1]}\n`;
    return { from, index: last, start, at: scan.fence || scan.items?.length || TABLE_ROW.test(before) ? Infinity : at, scan, head };
}

/** The tail of `previous` with `text` appended, its table's last row on lexed again (OpenList): as listTail. */
function tableTail(previous: NonNullable<MarkdownRenderer["lexed"]>, text: string): { source: string; tail: Token[] & { links?: unknown } } | undefined {
    const mark = previous.list;
    if (!mark || mark.at === Infinity || mark.from !== previous.tailStart || mark.head === undefined) return undefined;
    const prior = previous.tokens[mark.index] as Tokens.Table;
    const settled = settle(mark.head + text.slice(mark.at));
    if (!settled.startsWith(mark.head)) return undefined;
    const lexed = lexOnce(settled);
    const head = lexed[0] as Tokens.Table | undefined;
    if (head?.type !== "table" || head.header.length !== prior.header.length || hasLinks(lexed)) return undefined;
    const raw = text.slice(mark.start, mark.at) + head.raw.slice(mark.head.length);
    const table: Tokens.Table = { ...head, header: prior.header, raw, rows: [...prior.rows.slice(0, -1), ...head.rows] };
    const tail = Object.assign([...previous.tokens.slice(previous.tailIndex, mark.index), table, ...lexed.slice(1)], { links: lexed.links });
    return { source: text.slice(previous.tailStart, mark.at) + settled.slice(mark.head.length), tail };
}

/**
 * The last streaming tail lexed, and its tokens: one whose settled text is as it was (what's appended held back, as a
 * table's unfinished row or a bare marker is) isn't lexed again.
 */
let lastLexed: { source: string; tokens: Token[] & { links?: unknown } } | undefined;
function lexOnce(source: string): Token[] & { links?: unknown } {
    if (lastLexed?.source === source) return lastLexed.tokens;
    const tokens = md.lexer(source);
    lastLexed = { source, tokens };
    return tokens;
}

/** marked's: an item that ends in a blank line, and a blank line in one, make its list loose. */
const DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const ANY_LINE = /\n.*\n/;

/**
 * The tail of `previous` with `text` appended, its list's last item lexed again (OpenList) and the earlier ones as
 * they were: the same tokens the tail lexed whole would be. Undefined where they mightn't be: lexed whole.
 */
function listTail(previous: NonNullable<MarkdownRenderer["lexed"]>, text: string): { source: string; tail: Token[] & { links?: unknown }; line?: ItemLine } | undefined {
    const mark = previous.list;
    if (!mark || mark.at === Infinity || mark.from !== previous.tailStart) return undefined;
    const prior = previous.tokens[mark.index] as Tokens.List;
    const settled = settle(text.slice(mark.at));
    const fast = itemLine(previous, mark, prior, text, settled);
    if (fast) return fast;
    const lexed = lexOnce(settled);
    const head = lexed[0] as Tokens.List | undefined;
    if (head?.type !== "list" || head.ordered !== prior.ordered || hasLinks(lexed)) return undefined;
    const items = prior.items.slice(0, -1);
    // Loose as marked reads it over the whole list: an item before another ending in a blank line, or one with a
    // blank line in it. Looser or tighter than it was: every item renders differently, lexed whole.
    const loose = head.loose || items.some((it) => DOUBLE_BLANK.test(it.raw) || it.tokens.some((t) => t.type === "space" && ANY_LINE.test(t.raw)));
    if (loose !== prior.loose) return undefined;
    // Loose only by the items before: these as marked makes them then (a task's box goes elsewhere: lexed whole).
    if (loose && !head.loose) {
        if (head.items.some((it) => it.task)) return undefined;
        for (const it of head.items) {
            it.loose = true;
            for (const t of it.tokens) if (t.type === "text") t.type = "paragraph";
        }
    }
    const list: Tokens.List = { ...head, loose, start: prior.start, raw: text.slice(mark.start, mark.at) + head.raw, items: [...items, ...head.items] };
    const tail = Object.assign([...previous.tokens.slice(previous.tailIndex, mark.index), list, ...lexed.slice(1)], { links: lexed.links });
    // Its last item one line of text: from now, lexed a piece at a time as it grows (itemLine).
    const item = head.items.length === 1 ? head.items[0]! : undefined;
    const marker = ITEM_MARKER.exec(settled)?.[0];
    const plain = item && marker && !loose && !item.task && item.tokens.length === 1 && item.tokens[0]!.type === "text" && !/[\n\r\t]/.test(settled) && OPEN_LINE.test(settled.slice(marker.length)) && item.text === settled.slice(marker.length).trimEnd();
    const body = mark.at + (marker?.length ?? 0);
    return { source: text.slice(previous.tailStart, mark.at) + settled, tail, ...(plain ? { line: { at: mark.at, body, frozen: body, scan: body, open: [], inline: [], dead: false } } : {}) };
}

/**
 * The tail of `previous` with `text` appended, where its list's last item was one line of text and still is: that
 * item's text lexed as a paragraph's last line is (appendLine), what of it nothing written after can change lexed once
 * (freezePoint), and the item made as marked makes one, from one of a single character with the same marker and the
 * same spaces after (how they're trimmed is marked's). Undefined: lexed as usual.
 */
function itemLine(previous: NonNullable<MarkdownRenderer["lexed"]>, mark: OpenList, prior: Tokens.List, text: string, settled: string): { source: string; tail: Token[] & { links?: unknown }; line: ItemLine } | undefined {
    const was = mark.line;
    if (!was || was.at !== mark.at || !previous.streaming || !text.startsWith(previous.text) || /[\n\r\t]/.test(settled)) return undefined;
    const marker = settled.slice(0, was.body - was.at);
    const body = settled.slice(marker.length);
    const trimmed = body.trimEnd();
    if (ITEM_MARKER.exec(settled)?.[0] !== marker || !OPEN_LINE.test(trimmed)) return undefined;
    const next: ItemLine = { ...was, open: [...was.open] };
    const end = was.body + trimmed.length;
    try {
        if (!next.dead && text.slice(was.at, end) === settled.slice(0, end - was.at)) {
            const freeze = freezePoint(next, text.slice(0, end));
            const piece = text.slice(next.frozen, freeze);
            if (piece && openMarkers(piece).length) next.dead = true;
            else if (piece) {
                next.inline = next.inline.concat(md.Lexer.lexInline(piece, md.defaults));
                next.frozen = freeze;
            }
        }
        const shapeLexed = lexOnce(`${marker}x${body.slice(trimmed.length)}`);
        const shape = shapeLexed[0] as Tokens.List | undefined;
        const one = shape?.type === "list" && shape.items.length === 1 ? shape.items[0]! : undefined;
        if (!shape || !one || one.raw !== `${marker}x` || one.task || one.loose || shape.loose || prior.loose || shape.ordered !== prior.ordered || hasLinks(shapeLexed)) return undefined;
        const inline = next.inline.concat(md.Lexer.lexInline(settled.slice(next.frozen - was.at, end - was.at), md.defaults));
        const item: Tokens.ListItem = { ...one, raw: marker + trimmed, text: trimmed, tokens: [{ type: "text", raw: trimmed, text: trimmed, tokens: inline } as Tokens.Text] };
        const list: Tokens.List = { ...shape, start: prior.start, raw: text.slice(mark.start, mark.at) + marker + trimmed + shape.raw.slice(marker.length + 1), items: [...prior.items.slice(0, -1), item] };
        const tail = Object.assign([...previous.tokens.slice(previous.tailIndex, mark.index), list, ...shapeLexed.slice(1)], { links: shapeLexed.links });
        return { source: text.slice(previous.tailStart, mark.at) + settled, tail, line: next };
    } catch {
        return undefined;
    }
}

function hasLinks(tokens: { links?: unknown }): boolean {
    for (const _ in (tokens.links ?? {}) as object) return true;
    return false;
}

const OPEN_FENCE = /^(`{3,}|~{3,})([^\n]*)\n/;
const ANY_PUNCTUATION = /\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g;

/**
 * A streaming tail that's a code fence still open (no closing line yet), as the lexer would read it, without lexing it:
 * all the rest is the code. A long one was lexed whole again with every update. Undefined for anything else, which
 * the lexer reads.
 */
export function openFence(source: string): (Token[] & { links: Record<string, never> }) | undefined {
    const m = OPEN_FENCE.exec(source);
    if (!m) return undefined;
    const fence = m[1]!;
    const info = m[2]!;
    if (fence[0] === "`" && info.includes("`")) return undefined;
    const rest = source.slice(m[0].length);
    // A closing line anywhere (a fence, then more fence characters and spaces): the lexer decides what follows.
    const close = new RegExp(`^ {0,3}${fence}[~\`]* *$`, "m");
    if (close.test(rest)) return undefined;
    const lang = info ? info.trim().replace(ANY_PUNCTUATION, "$1") : info;
    const text = rest.endsWith("\n") ? rest.slice(0, -1) : rest;
    return Object.assign([{ type: "code", raw: source, lang, text } as Tokens.Code as Token], { links: {} });
}

// ---------------------------------------------------------------------------
// Streaming

/** A fence line: backticks can't appear in a backtick fence's info string. */
/** A fence line, after any quote and list markers ("- ```ts" opens one in a list item). */
const FENCE = /^\s*(?:>\s?\s*)*(?:((?:[-*+]|\d{1,9}[.)])\s+)\s*(?:>\s?\s*)*)?(?:(`{3,})[^`]*|(~{3,}).*)$/;
/** A line that's only a marker so far: a list item, heading, quote or rule that hasn't said what it is yet. */
/** A fenced code block closed by its own fence (as long as its opening one, of the same character). */
function closedFence(t: Token | undefined): boolean {
    if (t?.type !== "code" || (t as Tokens.Code).codeBlockStyle === "indented") return false;
    const lines = t.raw.replace(/\n+$/, "").split("\n");
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0]!)?.[1];
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines.at(-1)!)?.[1];
    return lines.length > 1 && open !== undefined && close !== undefined && close[0] === open[0] && close.length >= open.length;
}
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
    let fence: (Fence & { line: number }) | undefined;
    let scan: Scan = {};
    lines.forEach((line, i) => {
        starts.push(at);
        at += line.length + 1;
        const was = scan.fence;
        scan = scanLine(line, scan);
        fence = scan.fence && (scan.fence === was ? fence : { ...scan.fence, line: i });
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

/** One line still being written, with its open inline markers closed. `atStart`: from the line's start (else from after a space in it). */
function closeInline(line: string, atStart = true): string {
    const prefix = atStart ? (LINE_PREFIX.exec(line)?.[0] ?? "") : "";
    // Markers at the very end may be an opener with nothing after it yet, or half a closer.
    let body = line.slice(prefix.length).replace(/[*_~`]+$/, "");
    // A link still being written: its text for now.
    body = body.replace(/\[([^\]\n]*)\]\([^)\s]*$/, "$1").replace(/(^|[\s(])\[([^\]\n]*)\]?$/, "$1$2");
    const open = openMarkers(body);
    if (!open.length) return prefix + body;
    // A closer must touch the text it closes.
    const code = open.at(-1)!.startsWith("`");
    return prefix + (code ? body : body.trimEnd()) + open.reverse().join("");
}

/** The inline markers `body` leaves open, innermost last, as closeInline reads them. */
function openMarkers(body: string): string[] {
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
    return open;
}

/** Markdown to HTML in one go (plans, summaries). */
export function renderMarkdown(text: string): string {
    try {
        return md.parse(text) as string;
    } catch {
        return `<p>${escapeHtml(text)}</p>`;
    }
}

/** What replies hold, for warmMarkdown: each kind of block and inline mark, paths and links. */
const WARM_SAMPLE = `Here's how a turn moves through it — the server owns the session; the window is a view of it.

## How a turn runs

The engine takes the prompt, calls the model and streams **every event** back, as _it happens_. See \`src/server/session.ts:42\`, \`sendPrompt()\` and [the docs](https://example.com/docs).

1. **Prompt** — the composer sends it
2. **Model call** — a stream to the provider
   - text deltas append to the last block
   - tool calls become cards, each with *its own* status
3. **Tools**: run in the folder (\`~/.cavvy/sessions\`, ./src/index.ts)

### The append path

- [x] streamed
- [ ] saved

> A turn interrupted keeps what it did.
> Resume picks it up.

\`\`\`ts
function onDelta(turn: Turn, delta: string) {
    const last = turn.blocks.at(-1);
    if (last?.t === "text") last.text += delta;
}
\`\`\`

\`\`\`
plain output
\`\`\`

| Part | Owns | Lines |
| --- | :--- | ---: |
| Server | sessions, turns | 120 |
| GUI | scroll, panels | 48 |

---

Done: ~~nothing~~ everything passes (12/12), see https://example.com and src/lib/markdown.ts#L10.`;

/**
 * Renders a sample reply once, to be called when the app is idle after it starts. The first reply a window shows is
 * otherwise also the first time the lexer's patterns are compiled and its code runs, about ten times slower than after:
 * measured, most of the first long session's opening.
 */
export function warmMarkdown() {
    try {
        new MarkdownRenderer().segments(WARM_SAMPLE, false);
    } catch { /* a sample that doesn't render costs only the warming */ }
}
