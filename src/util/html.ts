// Small HTML -> Markdown-ish text converter for WebFetch. Not a full parser;
// good enough to make documentation pages readable for a model.

const ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    copy: "©",
    reg: "®",
    trade: "™",
    laquo: "«",
    raquo: "»",
    lsquo: "‘",
    rsquo: "’",
    ldquo: "“",
    rdquo: "”",
    bull: "•",
    middot: "·",
    times: "×",
    rarr: "→",
    larr: "←",
};

/** Error bodies from proxies and gateways are often HTML pages: keep the gist (title or heading), not the markup. */
export function plainErrorText(body: string): string {
    const s = body.trim();
    if (!/<(?:!doctype|html|head|body|title|h1)\b/i.test(s)) return s;
    const picked = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? s.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
    const raw = picked ?? s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
    const text = decodeEntities(raw.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 200);
    // Keep a short prefix like the SDK's "502 " before the markup.
    const lead = s.slice(0, s.indexOf("<")).trim();
    const prefix = lead && lead.length < 80 && !text.startsWith(lead) ? `${lead} ` : "";
    return `${prefix}${text || "error"} (HTML error page)`;
}

export function decodeEntities(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === "#") {
            const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            // fromCodePoint throws past U+10FFFF; leave a malformed entity as written.
            return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
    });
}

function attr(tag: string, name: string): string | undefined {
    const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    return m ? (m[2] ?? m[3] ?? m[4]) : undefined;
}

export function htmlToMarkdown(html: string, baseUrl?: string): { title?: string; text: string } {
    let s = html;
    const title = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
    s = s.replace(/<!--[\s\S]*?-->/g, "");
    s = s.replace(/<(script|style|noscript|svg|iframe|template|head|canvas|form)\b[\s\S]*?<\/\1>/gi, "");
    // Prefer the main content region when the page marks one.
    const main = s.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? s.match(/<article\b[\s\S]*?<\/article>/i)?.[0];
    if (main && main.length > 500) s = main;
    s = s.replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi, "");

    // Code blocks first so their content is preserved verbatim.
    const codeBlocks: string[] = [];
    s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
        const lang = inner.match(/class="[^"]*language-([\w-]+)/i)?.[1] ?? "";
        const code = decodeEntities(inner.replace(/<[^>]+>/g, ""));
        codeBlocks.push("\n```" + lang + "\n" + code.replace(/\n+$/, "") + "\n```\n");
        return `\u0000CODE${codeBlocks.length - 1}\u0000`;
    });

    s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "").trim()}\n\n`);
    s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs: string, t: string) => {
        const text = t.replace(/<[^>]+>/g, "").trim();
        let href = attr(`<a ${attrs}>`, "href");
        if (!href || href.startsWith("#") || href.startsWith("javascript:") || !text) return text;
        if (baseUrl) {
            try {
                href = new URL(href, baseUrl).toString();
            } catch {
                // keep as is
            }
        }
        return `[${text}](${href})`;
    });
    s = s.replace(/<img\b([^>]*)>/gi, (_m, attrs: string) => {
        const alt = attr(`<img ${attrs}>`, "alt");
        return alt ? `[image: ${alt}]` : "";
    });
    s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
    s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
    s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, t: string) => "`" + t.replace(/<[^>]+>/g, "") + "`");
    s = s.replace(/<li\b[^>]*>/gi, "\n- ");
    s = s.replace(/<\/(ul|ol)>/gi, "\n");
    s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, t: string) => "\n" + t.replace(/<[^>]+>/g, "").trim().split("\n").map((l) => `> ${l}`).join("\n") + "\n");
    s = s.replace(/<\/(td|th)>/gi, " | ");
    s = s.replace(/<tr\b[^>]*>/gi, "\n| ");
    s = s.replace(/<br\s*\/?>/gi, "\n");
    s = s.replace(/<hr\b[^>]*>/gi, "\n---\n");
    s = s.replace(/<\/(p|div|section|header|table|dl|dt|dd|figure|figcaption|details|summary)>/gi, "\n\n");
    s = s.replace(/<[^>]+>/g, "");
    s = decodeEntities(s);
    s = s.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n");
    s = s.replace(/\u0000CODE(\d+)\u0000/g, (_m, i: string) => codeBlocks[Number(i)] ?? "");
    return { title: title ? decodeEntities(title) : undefined, text: s.trim() };
}
