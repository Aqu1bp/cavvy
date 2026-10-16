// Markdown for model output. Two rules beyond rendering:
//
// Safety: the text comes from a model that may have read hostile content, so
//   raw HTML is shown as text, links only open http(s)/mailto (and only through
//   the app, never navigating the window), and images are never loaded: a
//   remote image URL is a way to send data out the moment it's displayed.
//
// Speed: while a reply streams, it's split into top-level blocks and each
//   finished block's HTML is cached by its source, so only the block still
//   being written is rendered again on each update.
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
// #Lline[Ccol], and an ignored range end (:10-20, #L10-L20).
const POS = String.raw`(?::(\d{1,8})(?::(\d{1,6}))?|#L(\d{1,8})(?:C(\d{1,6}))?)?(?:-L?\d{1,8})?$`;
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
    pending: Set<string>;
    /** Every path looked up and not linked (not asked yet, or not a file then). */
    unlinked: Set<string>;
    refs: number;
    inLink: boolean;
}
let ctx: LinkContext | undefined;

/** A link to a known file, or undefined (and noted as pending when not asked yet). */
function fileLink(ref: PathRef, inner: string): string | undefined {
    if (!ctx || ctx.inLink || ctx.refs >= MAX_REFS) return undefined;
    ctx.refs++;
    const abs = ctx.lookup(ref.path);
    if (abs === undefined) ctx.pending.add(ref.path);
    if (!abs) return ctx.unlinked.add(ref.path), undefined;
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
            return url ? `<a class="md-image" href="${escapeHtml(url)}" data-external="1" title="Images aren't loaded automatically. Open ${escapeHtml(url)}">${label}</a>` : `<span class="md-image">${label}</span>`;
        },
        code({ text, lang }: Tokens.Code) {
            return `<pre class="md-pre"><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}>${escapeHtml(text)}</code></pre>`;
        },
        table(token: Tokens.Table) {
            // Wide tables scroll inside their own box instead of widening the page.
            const head = `<tr>${token.header.map((c) => this.tablecell(c)).join("")}</tr>`;
            const body = token.rows.map((r) => `<tr>${r.map((c) => this.tablecell(c)).join("")}</tr>`).join("");
            return `<div class="md-table"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
        },
        checkbox({ checked }: Tokens.Checkbox) {
            return `<span class="md-check${checked ? " on" : ""}" aria-hidden="true"></span>`;
        },
    },
});

/**
 * `pending`: the block has paths not asked about yet. `unlinked`: the paths it
 * didn't link; it's rendered again when what's known about one changes (asked,
 * or a missing file's answer expired).
 */
export type Segment = { kind: "html"; key: string; html: string; pending?: boolean; unlinked?: string[] } | { kind: "code"; key: string; lang: string; code: string; open: boolean };

/** Renders one reply; keeps finished blocks between calls. */
export class MarkdownRenderer {
    private html = new Map<string, Segment>();
    private lexed?: { text: string; tokens: Token[] & { links?: unknown } };
    /** Paths in the last render that `lookup` didn't know. */
    pending = new Set<string>();
    /** The last render left paths unlinked, so new answers may change it. */
    watching = false;

    /** With `lookup`, paths to known files become links (see the top of this file). */
    segments(text: string, streaming: boolean, lookup?: PathLookup): Segment[] {
        this.pending = new Set();
        this.watching = false;
        let tokens: Token[] & { links?: unknown };
        try {
            // Rendered again with the same text when answers arrive: lex it once.
            tokens = this.lexed?.text === text ? this.lexed.tokens : md.lexer(text);
            this.lexed = { text, tokens };
        } catch {
            return [{ kind: "html", key: "err", html: `<p>${escapeHtml(text)}</p>` }];
        }
        const out: Segment[] = [];
        const next = new Map<string, Segment>();
        tokens.forEach((t, i) => {
            if (t.type === "space" || t.type === "def") return;
            const last = i === tokens.length - 1;
            if (t.type === "code" && (t as Tokens.Code).codeBlockStyle !== "indented") {
                const c = t as Tokens.Code;
                const open = streaming && last && !/(`{3,}|~{3,})\s*$/.test(c.raw.trimEnd());
                const key = `c${i}`;
                const prev = this.html.get(c.raw);
                const seg: Segment = prev?.kind === "code" && prev.open === open ? prev : { kind: "code", key, lang: (c.lang ?? "").split(/\s/)[0] ?? "", code: c.text, open };
                next.set(c.raw, seg);
                out.push(seg);
                return;
            }
            const cached = this.html.get(t.raw);
            const stale = lookup && cached?.kind === "html" && cached.unlinked?.some((p) => lookup(p) !== null);
            if (cached && !stale) {
                if (cached.kind === "html" && cached.unlinked?.length) this.watching = true;
                next.set(t.raw, cached);
                out.push(cached);
                return;
            }
            let html: string;
            const pending = new Set<string>();
            const unlinked = new Set<string>();
            ctx = lookup && { lookup, pending, unlinked, refs: 0, inLink: false };
            try {
                html = md.parser(Object.assign([t], { links: tokens.links ?? {} }) as unknown as Token[]);
            } catch {
                html = `<p>${escapeHtml(t.raw)}</p>`;
            } finally {
                ctx = undefined;
            }
            for (const p of pending) this.pending.add(p);
            if (unlinked.size) this.watching = true;
            // Same HTML as before (nothing new known yet): same object, so the DOM stays.
            if (cached?.kind === "html" && cached.html === html) {
                cached.pending = pending.size > 0;
                cached.unlinked = [...unlinked];
                next.set(t.raw, cached);
                out.push(cached);
                return;
            }
            const seg: Segment = { kind: "html", key: `h${i}:${t.raw.length}`, html, pending: pending.size > 0, unlinked: [...unlinked] };
            next.set(t.raw, seg);
            out.push(seg);
        });
        this.html = next;
        return out;
    }
}

/** Markdown to HTML in one go (plans, summaries). */
export function renderMarkdown(text: string): string {
    try {
        return md.parse(text) as string;
    } catch {
        return `<p>${escapeHtml(text)}</p>`;
    }
}
