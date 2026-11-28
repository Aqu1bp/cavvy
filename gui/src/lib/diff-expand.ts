// The lines a diff leaves out, around and between its hunks, shown on request (the review pane's FileCard).
// A diff's hunks keep a few lines of context; the rest of the file, unchanged, is a gap: before each hunk,
// and after the last one when the file's length is known. Opening one fetches the file once, with every
// line as context (session.gitChanges `full`), and puts that gap's lines back between the hunks either side,
// which then read as one.

import type { DiffHunk, DiffLine } from "@shared/protocol";

type Diff = { hunks: DiffHunk[]; lines?: number; truncated?: boolean };

/** One hidden run, by the hunk it comes before (`at` = the number of hunks: after the last). Lines numbered in each side, inclusive. */
export interface Gap {
    at: number;
    newFrom: number;
    oldFrom: number;
    count: number;
}

/** The first line a hunk covers in a side, or (an empty range, numbered by the line before) the line after it. */
const firstOf = (start: number, n: number) => (n ? start : start + 1);
/** The line after a hunk in a side. */
const afterOf = (start: number, n: number) => (n ? start + n : start + 1);

/** The hidden runs of a diff that has any lines in them, in order. */
export function gaps(d: Diff): Gap[] {
    const out: Gap[] = [];
    const n = d.hunks.length;
    if (!n) return out;
    for (let at = 0; at <= n; at++) {
        const prev = d.hunks[at - 1];
        const next = d.hunks[at];
        const newFrom = prev ? afterOf(prev.newStart, prev.newLines) : 1;
        const oldFrom = prev ? afterOf(prev.oldStart, prev.oldLines) : 1;
        // After the last hunk of a diff cut short: hunks were left out there, not unchanged lines.
        const newTo = next ? firstOf(next.newStart, next.newLines) - 1 : d.truncated ? undefined : d.lines;
        if (newTo === undefined || newTo < newFrom) continue;
        out.push({ at, newFrom, oldFrom, count: newTo - newFrom + 1 });
    }
    return out;
}

/** What gaps(…) of a diff are: the same hunks in the same places. A diff fetched again that changed starts closed. */
export function shapeOf(d: Diff): string {
    return `${d.lines ?? ""}|${d.hunks.map((h) => `${h.oldStart},${h.oldLines},${h.newStart},${h.newLines}`).join(" ")}`;
}

export interface Expanded {
    hunks: DiffHunk[];
    /** For each hunk shown and after the last (hunks.length + 1 entries): the gap still hidden before it, if any. */
    before: (Gap | undefined)[];
}

/**
 * The diff with the gaps in `open` (by their `at`) shown, from `full` (the same file with every line as context).
 * A gap whose lines `full` doesn't have as they were numbered (the file changed since; or `full` was cut short)
 * stays hidden, and is in `stale`.
 */
export function expand(d: Diff, full: Diff | undefined, open: ReadonlySet<number>): Expanded & { stale: number[] } {
    const byNew = new Map<number, DiffLine>();
    for (const h of full?.hunks ?? []) for (const l of h.lines) if (l.t === "ctx" && l.b !== undefined) byNew.set(l.b, l);
    const all = gaps(d);
    const stale: number[] = [];
    const hunks: DiffHunk[] = [];
    const before: (Gap | undefined)[] = [];
    /** The hunk being built: its lines, and the original hunk when it's that alone. */
    let cur: { lines: DiffLine[]; only?: DiffHunk; parts: number } | undefined;
    let pending: Gap | undefined;
    const close = () => {
        if (!cur) return;
        hunks.push(cur.parts === 1 && cur.only ? cur.only : header(cur.lines));
        cur = undefined;
    };
    const add = (lines: DiffLine[], only?: DiffHunk) => {
        if (!cur) {
            before.push(pending);
            pending = undefined;
            cur = { lines: [], only, parts: 0 };
        }
        cur.lines.push(...lines);
        cur.parts++;
        if (!only) cur.only = undefined;
    };
    for (let at = 0; at <= d.hunks.length; at++) {
        const gap = all.find((g) => g.at === at);
        let lines: DiffLine[] | undefined;
        if (gap && open.has(at)) {
            lines = [];
            for (let i = 0; i < gap.count; i++) {
                const l = byNew.get(gap.newFrom + i);
                if (!l || l.a !== gap.oldFrom + i) {
                    lines = undefined;
                    stale.push(at);
                    break;
                }
                lines.push(l);
            }
        }
        if (gap && lines) add(lines);
        else if (gap) {
            close();
            pending = gap;
        }
        const h = d.hunks[at];
        if (h) add(h.lines, h);
    }
    close();
    before.push(pending);
    return { hunks, before, stale };
}

/** A hunk's numbers, from its lines (each of a merged hunk's sides has at least its context). */
function header(lines: DiffLine[]): DiffHunk {
    const old = lines.filter((l) => l.t !== "add");
    const now = lines.filter((l) => l.t !== "del");
    return { oldStart: old[0]?.a ?? 0, oldLines: old.length, newStart: now[0]?.b ?? 0, newLines: now.length, lines };
}
