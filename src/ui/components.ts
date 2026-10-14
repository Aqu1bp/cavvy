// Reusable UI pieces: spinner, diff view, select lists, boxes, tool lines.

import { bold, dim, inverse, padEnd, theme, truncate, width, wrapLine, stripAnsi } from "./ansi";
import { diffLines, hunks, diffStats, type DiffOp } from "../util/diff";
import { Highlighter, langFromPath } from "./highlight";

export const SPINNER_FRAMES = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

export const SPINNER_VERBS = [
    "Thinking", "Working", "Pondering", "Reasoning", "Crafting", "Cooking", "Brewing", "Tinkering", "Computing", "Mulling",
    "Considering", "Deliberating", "Synthesizing", "Assembling", "Untangling", "Wrangling", "Noodling", "Percolating", "Conjuring", "Forging",
];

export function formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ---------------------------------------------------------------------------
// Diffs

function charDiff(a: string, b: string): [number, number, number, number] {
    // common prefix/suffix; the middle is what changed
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let s = 0;
    while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    return [p, a.length - s, p, b.length - s];
}

/** Colored diff with line numbers, for edits and write previews. */
export function renderDiff(path: string, before: string, after: string, cols: number, opts: { maxLines?: number; context?: number } = {}): string[] {
    const ops = diffLines(before, after);
    const hs = hunks(ops, opts.context ?? 3);
    if (!hs.length) return [theme.muted("(no changes)")];
    const maxNo = Math.max(...ops.map((o) => Math.max(o.oldNo ?? 0, o.newNo ?? 0)));
    const nw = String(maxNo).length;
    const lang = langFromPath(path);
    const hlOld = new Highlighter(lang);
    const hlNew = new Highlighter(lang);
    const out: string[] = [];
    const bodyW = Math.max(10, cols - nw - 3);
    hs.forEach((h, hi) => {
        if (hi > 0) out.push(theme.subtle(" ".repeat(nw) + " ..."));
        const lines = h.ops;
        for (let i = 0; i < lines.length; i++) {
            const op = lines[i]!;
            if (op.type === "equal") {
                hlOld.line(op.line);
                const text = hlNew.line(op.line);
                out.push(theme.subtle(String(op.newNo ?? "").padStart(nw)) + "  " + truncate(text, bodyW));
                continue;
            }
            // pair consecutive del/add runs for word-level highlighting
            const dels: DiffOp[] = [];
            const adds: DiffOp[] = [];
            let j = i;
            while (j < lines.length && lines[j]!.type === "del") dels.push(lines[j++]!);
            while (j < lines.length && lines[j]!.type === "add") adds.push(lines[j++]!);
            i = j - 1;
            const paired = dels.length === adds.length && dels.length <= 8;
            const fmt = (op: DiffOp, other: DiffOp | undefined) => {
                const isAdd = op.type === "add";
                const bgLine = isAdd ? theme.diffAdded : theme.diffRemoved;
                const bgWord = isAdd ? theme.diffAddedWord : theme.diffRemovedWord;
                const no = String((isAdd ? op.newNo : op.oldNo) ?? "").padStart(nw);
                const sign = isAdd ? "+" : "-";
                let body = op.line.replace(/\t/g, "    ");
                if (paired && other) {
                    const o = other.line.replace(/\t/g, "    ");
                    const [s1, e1] = isAdd ? charDiff(o, body).slice(2) as [number, number] : charDiff(body, o).slice(0, 2) as [number, number];
                    if (e1 - s1 < body.length * 0.8 && e1 > s1) body = body.slice(0, s1) + bgWord(body.slice(s1, e1)) + bgLine(body.slice(e1));
                }
                (isAdd ? hlNew : hlOld).line(op.line);
                const raw = `${no} ${sign} ${body}`;
                return bgLine(padEnd(truncate(raw, cols - 1), cols - 1));
            };
            dels.forEach((d, k) => out.push(fmt(d, paired ? adds[k] : undefined)));
            adds.forEach((a, k) => out.push(fmt(a, paired ? dels[k] : undefined)));
        }
    });
    if (opts.maxLines && out.length > opts.maxLines) {
        const extra = out.length - opts.maxLines;
        return [...out.slice(0, opts.maxLines), theme.subtle(`… +${extra} lines`)];
    }
    return out;
}

export function diffSummary(before: string, after: string): string {
    const st = diffStats(diffLines(before, after));
    const parts: string[] = [];
    if (st.added) parts.push(`${st.added} addition${st.added === 1 ? "" : "s"}`);
    if (st.removed) parts.push(`${st.removed} removal${st.removed === 1 ? "" : "s"}`);
    return parts.join(" and ") || "no changes";
}

/** Highlighted preview of new file content. */
export function renderFilePreview(path: string, content: string, cols: number, maxLines: number): string[] {
    const hl = new Highlighter(langFromPath(path));
    // A trailing newline ends the last line; it doesn't start a new one.
    const lines = content.replace(/\n$/, "").split("\n");
    const nw = String(Math.min(lines.length, maxLines)).length;
    const out = lines.slice(0, maxLines).map((l, i) => theme.subtle(String(i + 1).padStart(nw)) + "  " + truncate(hl.line(l.replace(/\t/g, "    ")), cols - nw - 3));
    if (lines.length > maxLines) out.push(theme.subtle(`… +${lines.length - maxLines} lines`));
    return out;
}

// ---------------------------------------------------------------------------
// Boxes

export function box(lines: string[], cols: number, color: (s: string) => string, title?: string): string[] {
    const inner = Math.max(10, cols - 4);
    const top = title ? color("╭─ ") + bold(title) + color(" " + "─".repeat(Math.max(0, inner - width(title) - 1)) + "╮") : color("╭" + "─".repeat(inner + 2) + "╮");
    const out = [top];
    for (const l of lines) {
        for (const w of wrapLine(l, inner)) out.push(color("│") + " " + padEnd(truncate(w, inner), inner) + " " + color("│"));
    }
    out.push(color("╰" + "─".repeat(inner + 2) + "╯"));
    return out;
}

// ---------------------------------------------------------------------------
// Select list

export interface SelectItem<T = string> {
    label: string;
    value: T;
    description?: string;
    /** Right-aligned detail column. */
    detail?: string;
    /** Group header shown above this item when it changes. */
    group?: string;
    disabled?: boolean;
    /** Extra text matched by the filter but not shown. */
    keywords?: string;
}

export function fuzzyScore(query: string, text: string): number {
    if (!query) return 1;
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    const idx = t.indexOf(q);
    if (idx >= 0) return 1000 - idx - t.length * 0.01 + (idx === 0 || /[\s/:._-]/.test(t[idx - 1] ?? "") ? 200 : 0);
    // subsequence match
    let ti = 0;
    let score = 0;
    let last = -2;
    for (const c of q) {
        const found = t.indexOf(c, ti);
        if (found < 0) return -1;
        score += found === last + 1 ? 5 : 1;
        last = found;
        ti = found + 1;
    }
    return score;
}

export class SelectList<T = string> {
    index = 0;
    query = "";
    private scroll = 0;
    multi?: Set<number>;

    constructor(
        public items: SelectItem<T>[],
        opts: { initial?: number; multi?: boolean } = {},
    ) {
        this.index = Math.max(0, Math.min(opts.initial ?? 0, items.length - 1));
        if (opts.multi) this.multi = new Set();
        this.skipDisabled(1);
    }

    filtered(): { item: SelectItem<T>; i: number }[] {
        const all = this.items.map((item, i) => ({ item, i }));
        if (!this.query) return all;
        return all
            .map((x) => ({ ...x, s: fuzzyScore(this.query, `${x.item.label} ${x.item.keywords ?? ""} ${x.item.group ?? ""} ${x.item.description ?? ""}`) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s);
    }

    setQuery(q: string) {
        this.query = q;
        this.index = 0;
        this.scroll = 0;
        this.skipDisabled(1);
    }

    private skipDisabled(dir: 1 | -1) {
        const f = this.filtered();
        let guard = 0;
        while (f[this.index]?.item.disabled && guard++ < f.length) this.index = (this.index + dir + f.length) % f.length;
    }

    move(delta: number) {
        const n = this.filtered().length;
        if (!n) return;
        this.index = (((this.index + delta) % n) + n) % n;
        this.skipDisabled(delta >= 0 ? 1 : -1);
    }

    page(delta: number, pageSize: number) {
        const n = this.filtered().length;
        if (!n) return;
        this.index = Math.max(0, Math.min(n - 1, this.index + delta * pageSize));
        this.skipDisabled(delta >= 0 ? 1 : -1);
    }

    current(): SelectItem<T> | undefined {
        return this.filtered()[this.index]?.item;
    }

    toggle() {
        if (!this.multi) return;
        const cur = this.filtered()[this.index];
        if (!cur) return;
        if (this.multi.has(cur.i)) this.multi.delete(cur.i);
        else this.multi.add(cur.i);
    }

    selected(): SelectItem<T>[] {
        if (!this.multi) return [];
        return [...this.multi].sort((a, b) => a - b).map((i) => this.items[i]!);
    }

    render(cols: number, maxRows: number, opts: { numbers?: boolean; current?: (v: T) => boolean } = {}): string[] {
        const f = this.filtered();
        if (!f.length) return [theme.muted("  No matches")];
        // keep the selection visible
        const rowsAvail = Math.max(3, maxRows);
        if (this.index < this.scroll) this.scroll = this.index;
        if (this.index >= this.scroll + rowsAvail) this.scroll = this.index - rowsAvail + 1;
        const visible = f.slice(this.scroll, this.scroll + rowsAvail);
        const out: string[] = [];
        const labelW = Math.min(Math.max(...visible.map((x) => width(x.item.label))) + 2, Math.floor(cols * 0.6));
        let lastGroup: string | undefined = this.scroll > 0 ? f[this.scroll - 1]?.item.group : undefined;
        visible.forEach((x, vi) => {
            const absolute = this.scroll + vi;
            const { item } = x;
            if (!this.query && item.group && item.group !== lastGroup) {
                out.push(theme.muted(bold(item.group)));
                lastGroup = item.group;
            }
            const sel = absolute === this.index;
            const pointer = sel ? theme.permission("❯ ") : "  ";
            const num = opts.numbers ? `${absolute + 1}. ` : "";
            const check = this.multi ? (this.multi.has(x.i) ? theme.success("◉ ") : "○ ") : "";
            const isCur = opts.current?.(item.value) ? theme.success(" ✔") : "";
            const label = sel ? theme.permission(item.label) : item.disabled ? theme.subtle(item.label) : item.label;
            let line = pointer + num + check + padEnd(label + isCur, labelW);
            const restW = cols - width(line) - 1;
            if (item.description && restW > 10) line += theme.muted(truncate(item.description, restW - (item.detail ? width(item.detail) + 2 : 0)));
            if (item.detail) {
                const gap = cols - 1 - width(line) - width(item.detail);
                line += gap > 0 ? " ".repeat(gap) + theme.muted(item.detail) : "";
            }
            out.push(truncate(line, cols - 1));
        });
        if (f.length > rowsAvail) out.push(theme.subtle(`  ${this.index + 1}/${f.length}  ↑↓ to move${this.scroll + rowsAvail < f.length ? " · more below" : ""}`));
        return out;
    }
}

// ---------------------------------------------------------------------------
// Transcript lines

export const BULLET = "⏺";

export function toolLine(title: string, state: "running" | "ok" | "error" | "denied", blink = true): string {
    const dot = state === "running" ? (blink ? theme.muted(BULLET) : " ") : state === "ok" ? theme.success(BULLET) : state === "denied" ? theme.warning(BULLET) : theme.error(BULLET);
    const m = title.match(/^([\w-]+(?:\s-\s[^()]+)?)\(([\s\S]*)\)$/);
    const t = m ? bold(m[1]!) + theme.muted("(") + m[2] + theme.muted(")") : bold(title);
    return `${dot} ${t}`;
}

export function resultLines(text: string, cols: number, maxLines: number, style: (s: string) => string = theme.muted): string[] {
    const lines = text.replace(/\s+$/, "").split("\n");
    const out: string[] = [];
    const shown = lines.slice(0, maxLines);
    shown.forEach((l, i) => {
        const prefix = i === 0 ? "  ⎿  " : "     ";
        out.push(prefix + style(truncate(l, cols - 6)));
    });
    if (lines.length > maxLines) out.push("     " + theme.subtle(`… +${lines.length - maxLines} lines (ctrl+o to expand)`));
    return out;
}

export function indentLines(lines: string[], prefix = "     "): string[] {
    return lines.map((l) => prefix + l);
}

export function plain(s: string): string {
    return stripAnsi(s);
}

export { inverse, dim };
