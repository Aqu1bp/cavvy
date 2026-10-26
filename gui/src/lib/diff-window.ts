// Drawing only the part of a long diff that's in view (blocks/DiffView): the rows' heights, measured
// once drawn and guessed until then, and which rows to draw.

/** Each row's height: measured once it's been drawn, `estimate`d until then; offsets summed when asked. */
export class Heights {
    private known: Float64Array;
    private sums: Float64Array | undefined;
    constructor(
        readonly count: number,
        private estimate: (i: number) => number,
    ) {
        this.known = new Float64Array(count).fill(Number.NaN);
    }
    /** Forget what was measured (a new width rewraps every row). */
    reset(estimate?: (i: number) => number) {
        if (estimate) this.estimate = estimate;
        this.known.fill(Number.NaN);
        this.sums = undefined;
    }
    /** Guesses changed (a line's height measured for the first time): sums again. */
    invalidate() {
        this.sums = undefined;
    }
    height(i: number): number {
        const h = this.known[i]!;
        return Number.isNaN(h) ? this.estimate(i) : h;
    }
    measured(i: number): boolean {
        return !Number.isNaN(this.known[i]!);
    }
    /** True when it changed what the offsets add up to. */
    set(i: number, h: number): boolean {
        const before = this.height(i);
        this.known[i] = h;
        if (Math.abs(before - h) < 0.01) return false;
        this.sums = undefined;
        return true;
    }
    private prefix(): Float64Array {
        if (!this.sums) {
            const s = new Float64Array(this.count + 1);
            for (let i = 0; i < this.count; i++) s[i + 1] = s[i]! + this.height(i);
            this.sums = s;
        }
        return this.sums;
    }
    /** Where row `i` starts (`count`: the end). */
    offset(i: number): number {
        return this.prefix()[Math.max(0, Math.min(this.count, i))]!;
    }
    total(): number {
        return this.offset(this.count);
    }
    /** The row at `y` (clamped to the first and last). */
    indexAt(y: number): number {
        const s = this.prefix();
        let lo = 0;
        let hi = this.count - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (s[mid]! <= y) lo = mid;
            else hi = mid - 1;
        }
        return Math.max(0, lo);
    }
}

/** The rows from `top` to `bottom` (px from the first row's top), `over` px more either way. */
export function rowsIn(h: Heights, top: number, bottom: number, over: number): [number, number] {
    if (!h.count) return [0, -1];
    const lo = h.indexAt(Math.max(0, top - over));
    const hi = Math.max(lo, h.indexAt(Math.max(0, bottom + over)));
    return [lo, hi];
}

/** Ranges of rows (inclusive), sorted and joined where they touch or overlap. */
export function joinRanges(ranges: readonly (readonly [number, number])[]): [number, number][] {
    const sorted = ranges.filter(([a, b]) => b >= a).map(([a, b]): [number, number] => [a, b]).sort((x, y) => x[0] - y[0]);
    const out: [number, number][] = [];
    for (const r of sorted) {
        const last = out[out.length - 1];
        if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
        else out.push(r);
    }
    return out;
}

/** How wide a line reads in a monospace font: tabs to the next stop, wide characters as two. */
export function columns(text: string, tab = 8): number {
    let n = 0;
    for (const ch of text) {
        if (ch === "\t") n += tab - (n % tab);
        else {
            const c = ch.codePointAt(0)!;
            n += c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)) ? 2 : 1;
        }
    }
    return n;
}

/** The `n` widest lines, so a box holding just them is as wide as all of them would be. */
export function widest(texts: readonly string[], n = 3): string[] {
    const top: { w: number; t: string }[] = [];
    for (const t of texts) {
        // A line can't be wider than twice its length in columns (tabs aside): skip the measuring when it can't win.
        if (top.length === n && t.length * 2 < top[n - 1]!.w && !t.includes("\t")) continue;
        const w = columns(t);
        if (top.length < n || w > top[n - 1]!.w) {
            top.push({ w, t });
            top.sort((a, b) => b.w - a.w);
            if (top.length > n) top.pop();
        }
    }
    return top.map((x) => x.t);
}

/**
 * How many lines `text` takes wrapped at `cols` columns, roughly as the browser wraps code (pre-wrap,
 * overflow-wrap: anywhere): at spaces and after hyphens where it can, mid-word where it must.
 */
export function wrappedLines(text: string, cols: number): number {
    if (cols <= 0 || text.length <= cols) return 1;
    let lines = 1;
    let at = 0;
    // Each piece ends at a break opportunity: after a run of spaces, or after a hyphen.
    for (const piece of text.match(/[^\s-]*-|[^\s-]*\s+|[^\s-]+/g) ?? []) {
        const w = columns(piece);
        // Spaces at the end of a line hang past it.
        const ink = columns(piece.trimEnd());
        if (at + ink <= cols) {
            at += w;
            continue;
        }
        if (at > 0) {
            lines++;
            at = 0;
        }
        // Wider than a line: cut where the line ends.
        if (ink > cols) {
            lines += Math.ceil(ink / cols) - 1;
            at = ink % cols || cols;
            at += w - ink;
        } else at = w;
    }
    return lines;
}
