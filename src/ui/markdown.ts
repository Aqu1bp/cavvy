// Terminal markdown renderer, line-oriented so it can stream: each complete
// source line renders as soon as it arrives, except fenced code (highlighted
// incrementally) and tables (buffered until the table ends, to size columns).
// Line breaks inside paragraphs are kept, which reads better in a terminal.

import { bold, dim, italic, strike, underline, theme, width, wrapLine, truncate, padEnd, stripAnsi } from "./ansi";
import { Highlighter } from "./highlight";
import { redact } from "../util/redact";

const OSC8 = ["iTerm.app", "WezTerm", "vscode", "ghostty", "Hyper"].includes(process.env.TERM_PROGRAM ?? "") || Boolean(process.env.KITTY_WINDOW_ID) || Boolean(process.env.WT_SESSION) || Boolean(process.env.VTE_VERSION);

function link(text: string, url: string): string {
    const styled = theme.link(underline(text));
    if (OSC8 && /^https?:\/\//.test(url)) return `\x1b]8;;${url}\x1b\\${styled}\x1b]8;;\x1b\\`;
    if (stripAnsi(text) === url) return styled;
    return `${styled} ${theme.subtle(`(${url})`)}`;
}

/** Inline markdown: code spans, bold, italic, strike, links. */
export function inline(src: string): string {
    const slots: string[] = [];
    const hold = (s: string) => `\u0000${slots.push(s) - 1}\u0000`;
    let s = src;
    // escapes
    s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_, c) => hold(c));
    // code spans (``x`` or `x`)
    s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => hold(theme.code(code.replace(/^ (.*) $/, "$1"))));
    // images and links
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => hold(link(`[image: ${alt || "image"}]`, url)));
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, text, url) => hold(link(inline(text), url)));
    s = s.replace(/<(https?:\/\/[^>\s]+)>/g, (_, url) => hold(link(url, url)));
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"*_])/g, (_, pre, url) => pre + hold(link(url, url)));
    // emphasis
    s = s.replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, (_, _m, t) => bold(italic(t)));
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, (_, t) => bold(t));
    s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, (_, pre, t) => pre + bold(t));
    s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, (_, pre, t) => pre + italic(t));
    s = s.replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, (_, pre, t) => pre + italic(t));
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, (_, t) => strike(t));
    // restore held pieces (they may nest)
    for (let i = 0; i < 4 && s.includes("\u0000"); i++) s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[Number(n)] ?? "");
    return s;
}

const BULLETS = ["•", "◦", "▪"];
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

function splitRow(line: string): string[] {
    let t = line.trim();
    if (t.startsWith("|")) t = t.slice(1);
    if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
    const cells: string[] = [];
    let cur = "";
    let inCode = false;
    for (let i = 0; i < t.length; i++) {
        const c = t[i]!;
        if (c === "\\" && t[i + 1] === "|") {
            cur += "|";
            i++;
            continue;
        }
        if (c === "`") inCode = !inCode;
        if (c === "|" && !inCode) {
            cells.push(cur.trim());
            cur = "";
        } else cur += c;
    }
    cells.push(cur.trim());
    return cells;
}

export function renderTable(rows: string[], cols: number): string[] {
    const header = splitRow(rows[0]!);
    const aligns = splitRow(rows[1]!).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
    const body = rows.slice(2).map(splitRow);
    const n = Math.max(header.length, ...body.map((r) => r.length));
    const all = [header, ...body].map((r) => Array.from({ length: n }, (_, i) => inline(r[i] ?? "")));
    const natural = Array.from({ length: n }, (_, i) => Math.max(3, ...all.map((r) => width(r[i]!))));
    // borders: n+1 bars, plus 2 padding per cell
    const avail = Math.max(n * 4, cols - (n + 1) - n * 2);
    const widths = [...natural];
    let total = widths.reduce((a, b) => a + b, 0);
    while (total > avail) {
        const maxW = Math.max(...widths);
        if (maxW <= 6) break;
        const idx = widths.indexOf(maxW);
        widths[idx] = maxW - 1;
        total--;
    }
    const line = (l: string, m: string, r: string) => theme.subtle(l + widths.map((w) => "─".repeat(w + 2)).join(m) + r);
    const fmtRow = (cells: string[], isHeader: boolean) => {
        const wrapped = cells.map((c, i) => wrapLine(isHeader ? bold(c) : c, widths[i]!));
        const h = Math.max(...wrapped.map((w) => w.length));
        const out: string[] = [];
        for (let li = 0; li < h; li++) {
            const parts = wrapped.map((w, i) => {
                const text = truncate(w[li] ?? "", widths[i]!);
                const pad = widths[i]! - width(text);
                const a = aligns[i] ?? "left";
                if (a === "right") return " ".repeat(pad) + text;
                if (a === "center") return " ".repeat(Math.floor(pad / 2)) + text + " ".repeat(Math.ceil(pad / 2));
                return text + " ".repeat(pad);
            });
            out.push(theme.subtle("│") + parts.map((p) => ` ${p} `).join(theme.subtle("│")) + theme.subtle("│"));
        }
        return out;
    };
    const out = [line("┌", "┬", "┐"), ...fmtRow(all[0]!, true), line("├", "┼", "┤")];
    for (let r = 1; r < all.length; r++) out.push(...fmtRow(all[r]!, false));
    out.push(line("└", "┴", "┘"));
    return out;
}

/** Stateful line renderer. Feed complete source lines; get rendered lines back. */
export class MarkdownRenderer {
    private fence?: { char: string; len: number; hl: Highlighter; indent: number };
    private table?: string[];
    private candidate?: string;
    private lastBlank = true;

    constructor(public cols: number) {}

    get inCodeBlock(): boolean {
        return Boolean(this.fence);
    }

    line(src: string): string[] {
        const out: string[] = [];
        if (this.candidate !== undefined) {
            const cand = this.candidate;
            this.candidate = undefined;
            if (TABLE_SEP.test(src) && src.includes("-")) {
                this.table = [cand, src];
                return out;
            }
            out.push(...this.render(cand));
        }
        if (this.table) {
            if (src.includes("|") && src.trim()) {
                this.table.push(src);
                return out;
            }
            out.push(...renderTable(this.table, this.cols));
            this.table = undefined;
            this.lastBlank = false; // so the blank line after a table is kept
        }
        if (!this.fence && src.includes("|") && !FENCE.test(src) && /\S\s*\|\s*\S|^\s*\|/.test(src)) {
            this.candidate = src;
            return out;
        }
        out.push(...this.render(src));
        return out;
    }

    /** Finish any buffered table/candidate. */
    flush(): string[] {
        const out: string[] = [];
        if (this.candidate !== undefined) {
            out.push(...this.render(this.candidate));
            this.candidate = undefined;
        }
        if (this.table) {
            out.push(...renderTable(this.table, this.cols));
            this.table = undefined;
            this.lastBlank = false; // so the blank line after a table is kept
        }
        this.fence = undefined;
        return out;
    }

    /** Preview of a partial (not yet complete) line, without changing state. */
    preview(partial: string): string[] {
        const out: string[] = [];
        if (this.candidate !== undefined) out.push(...wrapLine(inline(this.candidate), this.cols));
        if (this.table) for (const r of this.table) out.push(...wrapLine(theme.subtle(r), this.cols));
        if (!partial) return out;
        if (this.fence) return [...out, ...hardWrap(theme.code(partial), this.cols)];
        return [...out, ...wrapLine(inline(partial), this.cols)];
    }

    private render(src: string): string[] {
        const cols = this.cols;
        if (this.fence) {
            const m = src.match(/^\s*(`{3,}|~{3,})\s*$/);
            if (m && m[1]![0] === this.fence.char && m[1]!.length >= this.fence.len) {
                this.fence = undefined;
                this.lastBlank = false;
                return [];
            }
            const line = this.fence.indent ? src.replace(new RegExp(`^ {0,${this.fence.indent}}`), "") : src;
            return hardWrap(this.fence.hl.line(line.replace(/\t/g, "    ")), cols);
        }
        const f = src.match(FENCE);
        if (f) {
            this.fence = { char: f[2]![0]!, len: f[2]!.length, hl: new Highlighter(f[3] || undefined), indent: f[1]!.length };
            return [];
        }
        if (!src.trim()) {
            if (this.lastBlank) return [];
            this.lastBlank = true;
            return [""];
        }
        this.lastBlank = false;
        const h = src.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
        if (h) {
            const level = h[1]!.length;
            const text = inline(h[2]!);
            const styled = level === 1 ? bold(underline(theme.heading(text))) : level === 2 ? bold(theme.heading(text)) : bold(text);
            return wrapLine(styled, cols);
        }
        if (HR.test(src)) return [theme.subtle("─".repeat(Math.min(cols, 80)))];
        const q = src.match(/^\s*((?:>\s?)+)(.*)$/);
        if (q) {
            const depth = (q[1]!.match(/>/g) ?? []).length;
            const prefix = theme.subtle("│ ".repeat(depth));
            return wrapLine(italic(theme.muted(inline(q[2]!))), cols - depth * 2).map((l) => prefix + l);
        }
        const li = src.match(LIST);
        if (li) {
            const indent = li[1]!.replace(/\t/g, "    ").length;
            const depth = Math.floor(indent / 2);
            let marker = li[2]!;
            let text = li[3]!;
            const task = text.match(/^\[([ xX])\]\s+(.*)$/);
            if (task) {
                marker = task[1] === " " ? "☐" : theme.success("☒");
                text = task[2]!;
            } else if (/^[-*+]$/.test(marker)) marker = BULLETS[depth % BULLETS.length]!;
            const lead = " ".repeat(depth * 2) + marker + " ";
            const hang = " ".repeat(width(lead));
            const lines = wrapLine(inline(text), Math.max(10, cols - width(lead)));
            return lines.map((l, i) => (i === 0 ? lead : hang) + l);
        }
        const lead = src.match(/^(\s*)/)![1]!.replace(/\t/g, "    ");
        const body = inline(src.trimStart());
        return wrapLine(lead + body, cols, lead.slice(0, Math.min(lead.length, 8)));
    }
}

function hardWrap(line: string, cols: number): string[] {
    if (width(line) <= cols) return [line];
    // Code: wrap at the column, not at spaces.
    const out: string[] = [];
    let rest = line;
    for (let i = 0; i < 200 && width(rest) > cols; i++) {
        const head = truncate(rest, cols, "");
        out.push(head);
        const visible = stripAnsi(head).length;
        // drop `visible` visible chars from rest while keeping escapes
        rest = dropVisible(rest, visible);
    }
    out.push(rest);
    return out;
}

function dropVisible(s: string, n: number): string {
    let i = 0;
    let seen = 0;
    let esc = "";
    while (i < s.length && seen < n) {
        if (s[i] === "\x1b") {
            const m = s.slice(i).match(/^\x1b\[[0-9;?]*[ -/]*[@-~]|^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/);
            if (m) {
                esc += m[0];
                i += m[0].length;
                continue;
            }
        }
        const cp = s.codePointAt(i)!;
        i += cp > 0xffff ? 2 : 1;
        seen++;
    }
    return esc + s.slice(i);
}

/** Render a complete markdown document. */
export function renderMarkdown(md: string, cols: number): string[] {
    const r = new MarkdownRenderer(cols);
    const out: string[] = [];
    for (const line of md.replace(/\r\n?/g, "\n").split("\n")) out.push(...r.line(line));
    out.push(...r.flush());
    while (out.length && out[out.length - 1] === "") out.pop();
    while (out.length && out[0] === "") out.shift();
    return out;
}

/**
 * Streaming wrapper: push deltas, take committed lines as they complete.
 * Each source line is redacted before it is rendered or wrapped, so a key
 * the model repeats never reaches the terminal (deltas can split a key; lines can't).
 */
export class MarkdownStream {
    private buf = "";
    private r: MarkdownRenderer;
    private emitted = 0;

    constructor(cols: number) {
        this.r = new MarkdownRenderer(cols);
    }

    get hasContent(): boolean {
        return this.emitted > 0 || this.buf.trim().length > 0;
    }

    push(delta: string): string[] {
        // A CRLF can be split across deltas: hold a trailing \r until we see what follows.
        let b = this.buf + delta;
        const hold = b.endsWith("\r");
        if (hold) b = b.slice(0, -1);
        this.buf = b.replace(/\r\n?/g, "\n") + (hold ? "\r" : "");
        const out: string[] = [];
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, nl);
            this.buf = this.buf.slice(nl + 1);
            out.push(...this.r.line(redact(line)));
        }
        return this.trimLeading(out);
    }

    pending(): string[] {
        return this.r.preview(redact(this.buf));
    }

    finish(): string[] {
        const out: string[] = [];
        if (this.buf) out.push(...this.r.line(redact(this.buf.replace(/\r$/, ""))));
        this.buf = "";
        out.push(...this.r.flush());
        while (out.length && out[out.length - 1] === "") out.pop();
        return this.trimLeading(out);
    }

    private trimLeading(lines: string[]): string[] {
        if (this.emitted === 0) {
            while (lines.length && lines[0] === "") lines.shift();
        }
        this.emitted += lines.length;
        return lines;
    }
}

export { padEnd, dim };
