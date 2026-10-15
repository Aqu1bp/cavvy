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

import { Marked, type Token, type Tokens } from "marked";

export function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeHref(href: string): string | undefined {
    const h = href.trim();
    if (/^(https?:\/\/|mailto:)/i.test(h)) return h;
    return undefined;
}

const md = new Marked({ gfm: true, breaks: false, async: false });
md.use({
    renderer: {
        html({ text }: Tokens.HTML | Tokens.Tag) {
            return escapeHtml(text);
        },
        link({ href, title, tokens }: Tokens.Link) {
            const inner = this.parser.parseInline(tokens);
            const url = safeHref(href);
            if (!url) return inner;
            return `<a href="${escapeHtml(url)}" data-external="1"${title ? ` title="${escapeHtml(title)}"` : ""} rel="noopener noreferrer">${inner}</a>`;
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

export type Segment = { kind: "html"; key: string; html: string } | { kind: "code"; key: string; lang: string; code: string; open: boolean };

/** Renders one reply; keeps finished blocks between calls. */
export class MarkdownRenderer {
    private html = new Map<string, Segment>();

    segments(text: string, streaming: boolean): Segment[] {
        let tokens: Token[] & { links?: unknown };
        try {
            tokens = md.lexer(text);
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
            if (cached) {
                next.set(t.raw, cached);
                out.push(cached);
                return;
            }
            let html: string;
            try {
                html = md.parser(Object.assign([t], { links: tokens.links ?? {} }) as unknown as Token[]);
            } catch {
                html = `<p>${escapeHtml(t.raw)}</p>`;
            }
            const seg: Segment = { kind: "html", key: `h${i}:${t.raw.length}`, html };
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
