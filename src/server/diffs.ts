// File diffs in the GUI's shape (hunks with line numbers), kept small enough
// to send over the socket.

import { diffLines, hunks } from "../util/diff";
import type { DiffHunk, FileDiff } from "./protocol";

/** Lines of hunks sent per file; the rest is summarized. */
const MAX_LINES = 1500;
/** Longest line sent; minified files would otherwise blow up a message. */
const MAX_LINE_CHARS = 2000;
/** Bigger inputs aren't diffed at all. */
export const MAX_DIFF_INPUT = 2 * 1024 * 1024;

export function fileDiff(path: string, before: string | null, after: string | null, opts: { context?: number; maxLines?: number } = {}): FileDiff {
    const status: FileDiff["status"] = before === null ? "added" : after === null ? "deleted" : "modified";
    const a = before ?? "";
    const b = after ?? "";
    if (a.length + b.length > MAX_DIFF_INPUT) return { path, status, added: 0, removed: 0, hunks: [], note: "Too large to show" };
    const ops = diffLines(a, b);
    let added = 0;
    let removed = 0;
    for (const o of ops) {
        if (o.type === "add") added++;
        else if (o.type === "del") removed++;
    }
    const max = opts.maxLines ?? MAX_LINES;
    const out: DiffHunk[] = [];
    let lines = 0;
    let truncated = false;
    for (const h of hunks(ops, opts.context ?? 3)) {
        if (lines >= max) {
            truncated = true;
            break;
        }
        const room = max - lines;
        const hl = h.ops.slice(0, room).map((o) => ({
            t: o.type === "equal" ? ("ctx" as const) : o.type === "add" ? ("add" as const) : ("del" as const),
            text: o.line.length > MAX_LINE_CHARS ? `${o.line.slice(0, MAX_LINE_CHARS)}…` : o.line,
            a: o.oldNo,
            b: o.newNo,
        }));
        if (hl.length < h.ops.length) truncated = true;
        lines += hl.length;
        out.push({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: hl });
    }
    return { path, status, added, removed, hunks: out, ...(truncated ? { truncated } : {}) };
}

/** Text from bytes, or undefined when it looks binary. */
export function textOf(buf: Uint8Array | undefined | null): string | undefined {
    if (!buf) return undefined;
    const n = Math.min(buf.length, 8000);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return undefined;
    return Buffer.from(buf).toString("utf-8");
}

/** Long string values cut, so a Write of a 5 MB file doesn't travel to the GUI with every update. */
export function trimInput(input: unknown, max = 4000): Record<string, unknown> | undefined {
    if (!input || typeof input !== "object") return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v.length > max ? `${v.slice(0, max)}\n… (${v.length - max} more characters)` : v;
        else if (Array.isArray(v) || (v && typeof v === "object")) {
            const s = JSON.stringify(v);
            out[k] = s.length > max * 2 ? `${s.slice(0, max)}… (truncated)` : v;
        } else out[k] = v;
    }
    return out;
}

export function truncateText(s: string, max: number): { text: string; truncated: boolean } {
    if (s.length <= max) return { text: s, truncated: false };
    const head = Math.floor(max * 0.6);
    const tailLen = max - head;
    return { text: `${s.slice(0, head)}\n\n… ${s.length - max} characters omitted …\n\n${s.slice(s.length - tailLen)}`, truncated: true };
}
