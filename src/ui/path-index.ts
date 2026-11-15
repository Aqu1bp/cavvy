// A project's paths, as @-mention completion searches them (mentions.ts FileIndex), and on worker threads for a big
// repository (mention-worker.ts): nothing here but the paths, so a worker loads only this.

/** Most paths a project's index keeps (git ls-files, or a walk): a repository of a million files is all in it. */
export const MAX_INDEXED = 2_000_000;
/** How long building an index works before it lets whatever else shares its thread get on. */
const SLICE_MS = 8;

/** A bit for each kind of character a path has, so a query with one it hasn't is passed over without scoring. */
function charMask(s: string): number {
    let m = 0;
    for (let i = 0; i < s.length; i++) m |= charBit(s.charCodeAt(i));
    return m;
}
function charBit(c: number): number {
    if (c >= 97 && c <= 122) return 1 << (c - 97);
    if (c >= 48 && c <= 57) return 1 << 26;
    if (c === 47) return 1 << 27;
    if (c === 46) return 1 << 28;
    if (c === 95) return 1 << 29;
    if (c === 45) return 1 << 30;
    return 1 << 31;
}
/** Where a word starts in a path (/[\s/:._-]/), by character code below 128. */
const BOUNDARY = (() => {
    const t = new Uint8Array(128);
    for (let c = 0; c < 128; c++) t[c] = /[\s/:._-]/.test(String.fromCharCode(c)) ? 1 : 0;
    return t;
})();
/** Whitespace above 127 /\s/ counts too: a word starts after it. */
const isBoundary = (c: number) => (c < 128 ? BOUNDARY[c] === 1 : /\s/.test(String.fromCharCode(c)));

/**
 * fuzzyScore(q, t.slice(from, end)), for `q` and `t` lower-cased already, without making the slice: as fuzzyScore scores
 * it (a substring first, by where it is; else each character in order).
 */
function scoreIn(q: string, t: string, from: number, end: number): number {
    if (!q) return 1;
    const len = end - from;
    const at = t.indexOf(q, from);
    if (at >= 0 && at + q.length <= end) {
        const idx = at - from;
        return 1000 - idx - len * 0.01 + (idx === 0 || isBoundary(t.charCodeAt(at - 1)) ? 200 : 0);
    }
    let ti = from;
    let score = 0;
    let last = -2;
    for (const c of q) {
        const found = t.indexOf(c, ti);
        if (found < 0 || found >= end) return -1;
        score += found - from === last + 1 ? 5 : 1;
        last = found - from;
        ti = found + 1;
    }
    return score;
}

/** A path found, its score, and where it comes among all of a project's paths on a tie (PathIndex.top). */
export interface Scored {
    p: string;
    s: number;
    k: number;
}

/** A file's place among a project's paths: after every folder (FOLDERS_END), in the order they were listed. */
const FOLDERS_END = 2 ** 45;
/** A folder's: by the first file listed in it, and shallowest first. */
const folderKey = (firstFile: number, depth: number) => firstFile * 4096 + Math.min(depth, 4095);

/** The best of `scored` (from each part of a project's paths: PathIndex.top), as all of them in one index would be. */
export function merged(scored: Scored[], limit: number): string[] {
    // A folder in more than one part: its place is its first file's, the earliest.
    const at = new Map<string, Scored>();
    for (const x of scored) {
        const had = at.get(x.p);
        if (!had || x.k < had.k) at.set(x.p, x);
    }
    return [...at.values()].sort((a, b) => b.s - a.s || a.k - b.k).slice(0, limit).map((x) => x.p);
}

const NL = 10;
const NON_ASCII = /[^\x00-\x7f]/;

/** fuzzyScore's second way (scoreIn: each character in order), of `q`'s character codes in `t` from `from` to `end`. */
function inOrder(q: Uint8Array, t: Uint8Array, from: number, end: number): number {
    let ti = from;
    let score = 0;
    let last = -2;
    for (let j = 0; j < q.length; j++) {
        const c = q[j]!;
        let found = -1;
        for (let k = ti; k < end; k++) {
            if (t[k] === c) {
                found = k;
                break;
            }
        }
        if (found < 0) return -1;
        score += found - from === last + 1 ? 5 : 1;
        last = found - from;
        ti = found + 1;
    }
    return score;
}

/** Where `q` is first in `t` from `from`, wholly before `end`: -1 if it isn't (a name is short: looked through here). */
function indexIn(q: Uint8Array, t: Uint8Array, from: number, end: number): number {
    const c = q[0]!;
    for (let k = from, last = end - q.length; k <= last; k++) {
        if (t[k] !== c) continue;
        let j = 1;
        while (j < q.length && t[k + j] === q[j]) j++;
        if (j === q.length) return k;
    }
    return -1;
}

/** How many paths each character keeps as its best (PathIndex.singles): more asked for, they're searched for. */
const SINGLES = 32;

type Best = { i: number; s: number }[];

/** `score` among `list`'s best SINGLES, the paths coming in order: one only above an equal one if better. */
function keep(list: Best, i: number, score: number) {
    if (list.length === SINGLES && score <= list[SINGLES - 1]!.s) return;
    let at = list.length;
    while (at > 0 && list[at - 1]!.s < score) at--;
    list.splice(at, 0, { i, s: score });
    if (list.length > SINGLES) list.pop();
}

/**
 * Each ASCII character's best paths, and each pair of them side by side (PathIndex.singles, pairs), as top scores a
 * query of it where it's in a path as it is: where it's first in the path, and in its name (by 50 more), less a
 * twentieth of the path's length; the earlier on a tie. One pass over the paths' bytes.
 */
async function firstsOf(singles: Best[], pairs: (Best | undefined)[], lower: Uint8Array, start: Uint32Array, baseFrom: Uint32Array, baseEnd: Uint32Array, len: Uint32Array, wide: Map<number, unknown>, pause: (k: number) => Promise<void> | undefined) {
    const full = new Int32Array(128 * 128).fill(-1);
    const base = new Int32Array(128 * 128).fill(-1);
    const fullOne = new Int32Array(128).fill(-1);
    const baseOne = new Int32Array(128).fill(-1);
    const met: number[] = [];
    const metOne: number[] = [];
    const pair = new Uint8Array(2);
    for (let i = 0; i < len.length; i++) {
        if (wide.has(i)) continue;
        const from = start[i]!;
        const length = len[i]!;
        const end = from + length;
        const bFrom = from + baseFrom[i]!;
        const bEnd = from + baseEnd[i]!;
        const bLen = bEnd - bFrom;
        for (let k = from; k < end; k++) {
            const c = lower[k]!;
            if (fullOne[c]! < 0) {
                fullOne[c] = k;
                metOne.push(c);
            }
            const inBase = k >= bFrom && k < bEnd;
            if (inBase && baseOne[c]! < 0) baseOne[c] = k;
            if (k + 1 >= end) continue;
            const p = c * 128 + lower[k + 1]!;
            if (full[p]! < 0) {
                full[p] = k;
                met.push(p);
            }
            if (inBase && k + 1 < bEnd && base[p]! < 0) base[p] = k;
        }
        const scored = (h: number, hb: number, ql: number, q?: Uint8Array) => {
            const idx = h - from;
            const whole = 1000 - idx - length * 0.01 + (idx === 0 || isBoundary(lower[h - 1]!) ? 200 : 0);
            let name = -1;
            if (hb >= 0) name = 1000 - (hb - bFrom) - bLen * 0.01 + (hb === bFrom || isBoundary(lower[hb - 1]!) ? 200 : 0);
            // Not side by side in its name, but in order (a path of nearly a thousand characters): as top scores it.
            else if (q && whole < 5 * ql + 50) name = inOrder(q, lower, bFrom, bEnd);
            return Math.max(whole, name >= 0 ? name + 50 : -1) - length * 0.05;
        };
        for (const c of metOne) {
            keep(singles[c]!, i, scored(fullOne[c]!, baseOne[c]!, 1));
            fullOne[c] = -1;
            baseOne[c] = -1;
        }
        for (const p of met) {
            pair[0] = p >> 7;
            pair[1] = p & 127;
            keep((pairs[p] ??= []), i, scored(full[p]!, base[p]!, 2, pair));
            full[p] = -1;
            base[p] = -1;
        }
        met.length = 0;
        metOne.length = 0;
        const waiting = pause(i);
        if (waiting) await waiting;
    }
}

export class PathIndex {
    /**
     * Each path lower-cased, a line each, as bytes: found in by the engine's own search, with no string to reach for
     * each path (at a million files that was most of a keystroke). A path with a character beyond ASCII (lower-cased,
     * its length can change) has an empty line here, and is in `wide` instead.
     */
    private lower = Buffer.alloc(0);
    /** The same as written: what's offered. */
    private written = Buffer.alloc(0);
    /** Where each path's line starts (and, at n, where the last ends). */
    private start = new Uint32Array(1);
    /** Where each path's last part starts in it, and ends (a folder's "/" isn't part of it). */
    private baseFrom = new Uint32Array(0);
    private baseEnd = new Uint32Array(0);
    private masks = new Uint32Array(0);
    /** The most each path can score (by its length alone): one that can't beat the best found yet isn't looked in. */
    private most = new Float64Array(0);
    /** Each path's length. */
    private len = new Uint32Array(0);
    /** Those beyond ASCII, by their place: as written, and lower-cased. */
    private wide = new Map<number, { p: string; l: string }>();
    /** Each path's place among all of a project's paths, when this has a part of them (take's `first`). */
    private keys?: Float64Array;
    /**
     * For each character (lower-cased ASCII), the paths it's best in, best first, at most SINGLES: what a query of that
     * one character offers (the first keystroke after "@"), worked out in one pass over the paths as they're indexed.
     */
    private singles: Best[] = [];
    /** The same for each two characters side by side (by the first's code times 128, and the second's). */
    private pairs: (Best | undefined)[] = [];

    get size(): number {
        return this.len.length;
    }

    private path(i: number): string {
        return this.wide.get(i)?.p ?? this.written.toString("latin1", this.start[i]!, this.start[i]! + this.len[i]!);
    }

    /**
     * The index of `files` (and the folders they're in). `slice`: a slice of SLICE_MS at a time, the rest after (the
     * server's: a million paths took seconds); none, all at once. `first`: these are a project's listed files from
     * this one on (a part of them, on a worker of its own: mention-worker.ts), and top says where each comes among all.
     */
    async take(files: string[], o: { slice?: () => Promise<void>; first?: number } = {}) {
        let since = performance.now();
        // A promise only when it's time to let the thread get on (awaited then, and only then: without slices it all
        // runs before take returns).
        const pause = (k: number): Promise<void> | undefined => {
            if (!o.slice || k % 512 || performance.now() - since < SLICE_MS) return undefined;
            return o.slice().then(() => void (since = performance.now()));
        };
        const keyed = o.first !== undefined;
        const first = o.first ?? 0;
        // Each file's folders, up from its own until one is there already (its parents are, then), put in shallowest
        // first: in the order they were offered in (a tie keeps it).
        const dirs = new Set<string>();
        const dirKeys: number[] = [];
        const fresh: string[] = [];
        let bytes = 0;
        for (let k = 0; k < files.length; k++) {
            const f = files[k]!;
            bytes += f.length + 1;
            for (let end = f.lastIndexOf("/"); end > 0; end = f.lastIndexOf("/", end - 1)) {
                const d = f.slice(0, end + 1);
                if (dirs.has(d)) break;
                fresh.push(d);
            }
            for (let j = fresh.length - 1; j >= 0; j--) {
                const d = fresh[j]!;
                dirs.add(d);
                bytes += d.length + 1;
                if (keyed) {
                    let depth = 0;
                    for (let c = d.indexOf("/"); c >= 0; c = d.indexOf("/", c + 1)) depth++;
                    dirKeys.push(folderKey(first + k, depth));
                }
            }
            fresh.length = 0;
            const waiting = pause(k);
            if (waiting) await waiting;
        }
        const paths = [...dirs, ...files];
        dirs.clear();
        const n = paths.length;
        const lower = Buffer.allocUnsafe(bytes);
        const written = Buffer.allocUnsafe(bytes);
        const start = new Uint32Array(n + 1);
        const baseFrom = new Uint32Array(n);
        const baseEnd = new Uint32Array(n);
        const masks = new Uint32Array(n);
        const most = new Float64Array(n);
        const len = new Uint32Array(n);
        const wide = new Map<number, { p: string; l: string }>();
        const keys = keyed ? new Float64Array(n) : undefined;
        let at = 0;
        for (let i = 0; i < n; i++) {
            const p = paths[i]!;
            start[i] = at;
            len[i] = p.length;
            const end = p.endsWith("/") ? p.length - 1 : p.length;
            baseEnd[i] = end;
            baseFrom[i] = p.lastIndexOf("/", end - 1) + 1;
            // Found at the start of its name, at a word's start (scoreIn), less what its length costs (top). (A path's
            // length lower-cased is its own but beyond ASCII, where it's its string's.)
            if (NON_ASCII.test(p)) {
                const l = p.toLowerCase();
                wide.set(i, { p, l });
                masks[i] = charMask(l);
                most[i] = Math.max(1250 - (end - baseFrom[i]!) * 0.01, 1200 - l.length * 0.01) - p.length * 0.05;
            } else {
                // Lower-cased as bytes: no string made for it (a million of them, all garbage the thread collects).
                written.write(p, at, "latin1");
                let m = 0;
                for (let k = at, e = at + p.length; k < e; k++) {
                    let c = written[k]!;
                    if (c >= 65 && c <= 90) c += 32;
                    lower[k] = c;
                    m |= charBit(c);
                }
                masks[i] = m;
                most[i] = Math.max(1250 - (end - baseFrom[i]!) * 0.01, 1200 - p.length * 0.01) - p.length * 0.05;
                at += p.length;
            }
            lower[at] = NL;
            written[at] = NL;
            at++;
            if (keys) keys[i] = i < dirKeys.length ? dirKeys[i]! : FOLDERS_END + first + (i - dirKeys.length);
            const waiting = pause(i);
            if (waiting) await waiting;
        }
        start[n] = at;
        // (None worked out: none used.)
        const singles: Best[] = o.slice ? Array.from({ length: 128 }, () => []) : [];
        const pairs: (Best | undefined)[] = o.slice ? new Array(128 * 128) : [];
        // Made a slice at a time (on a worker, or the server's in the background): with a second to spare, as a million
        // paths took. Without slices, someone's waiting (the terminal's first search): a query searches them all.
        if (o.slice) await firstsOf(singles, pairs, lower, start, baseFrom, baseEnd, len, wide, pause);
        Object.assign(this, { lower: lower.subarray(0, at), written: written.subarray(0, at), start, baseFrom, baseEnd, masks, most, len, wide, keys, singles, pairs });
    }

    /** The paths that best match `query`, best first. */
    find(query: string, limit: number): string[] {
        return this.top(query, limit).map((x) => x.p);
    }

    /**
     * The same, each with its score and its place on a tie (merged puts several parts' together): as fuzzyScore scores
     * each path and its last part (by 50 more), less a twentieth of its length, best first, the earlier on a tie.
     */
    top(query: string, limit: number): Scored[] {
        const q = query.replace(/^\.\//, "").toLowerCase();
        const n = this.len.length;
        const best: { i: number; s: number }[] = [];
        const worst = () => (best.length === limit ? best[limit - 1]!.s : -Infinity);
        const consider = (i: number, score: number) => {
            if (best.length === limit && score <= best[limit - 1]!.s && !(score === best[limit - 1]!.s && i < best[limit - 1]!.i)) return;
            let at = best.length;
            while (at > 0 && (best[at - 1]!.s < score || (best[at - 1]!.s === score && best[at - 1]!.i > i))) at--;
            best.splice(at, 0, { i, s: score });
            if (best.length > limit) best.pop();
        };
        // In a path's string (one beyond ASCII), as before.
        const scoreWide = (i: number, w: { l: string }) => {
            const base = scoreIn(q, w.l, this.baseFrom[i]!, this.baseEnd[i]!);
            const s = Math.max(scoreIn(q, w.l, 0, w.l.length), base >= 0 ? base + 50 : -1);
            if (s > 0) consider(i, s - this.len[i]! * 0.05);
        };
        // One character, or two: as worked out when it was indexed (where it's in a path as it is), and those beyond
        // ASCII scored now. Two only when the last of them beats what's in a path only in order (5 + 1 + 50).
        const known = NON_ASCII.test(q) ? undefined : q.length === 1 ? this.singles[q.charCodeAt(0)] : q.length === 2 ? this.pairs[q.charCodeAt(0) * 128 + q.charCodeAt(1)] : undefined;
        if (known && limit <= SINGLES && (q.length === 1 || (known.length >= limit && known[limit - 1]!.s > 56))) {
            for (const b of known) consider(b.i, b.s);
            for (const [i, w] of this.wide) scoreWide(i, w);
        } else if (!q) {
            // Every path scores 1, its name 1 + 50: the shortest first.
            for (let i = 0; i < n; i++) if (best.length < limit || 51 - this.len[i]! * 0.05 >= worst()) consider(i, 51 - this.len[i]! * 0.05);
        } else if (NON_ASCII.test(q)) {
            // Only in a path beyond ASCII.
            for (const [i, w] of this.wide) scoreWide(i, w);
        } else {
            const lower = this.lower;
            const ql = q.length;
            const qb = Buffer.from(q, "latin1");
            const need = charMask(q);
            // Where it's in a path: each path's first, found by the engine's search from the next path that could be
            // among the best (without looking in those that can't, by their length, or haven't its characters), on to
            // where it is (none spans two paths: no line break in it).
            for (let i = 0; i < n; i++) {
                if (best.length === limit) {
                    const w = best[limit - 1]!.s;
                    while (i < n && (this.most[i]! < w || (this.masks[i]! & need) !== need)) i++;
                } else {
                    while (i < n && (this.masks[i]! & need) !== need) i++;
                }
                if (i >= n) break;
                const h = lower.indexOf(qb, this.start[i]!);
                if (h < 0) break;
                while (this.start[i + 1]! <= h) i++;
                if (best.length === limit && this.most[i]! < best[limit - 1]!.s) continue;
                const from = this.start[i]!;
                const length = this.len[i]!;
                const idx = h - from;
                const full = 1000 - idx - length * 0.01 + (idx === 0 || isBoundary(lower[h - 1]!) ? 200 : 0);
                // Its name: where it's first at or after where the name starts, if that's in the name; else in order.
                const bFrom = from + this.baseFrom[i]!;
                const bEnd = from + this.baseEnd[i]!;
                const hb = h >= bFrom ? h : indexIn(qb, lower, bFrom, bEnd);
                const bLen = bEnd - bFrom;
                let base = -1;
                if (hb >= 0 && hb + ql <= bEnd) base = 1000 - (hb - bFrom) - bLen * 0.01 + (hb === bFrom || isBoundary(lower[hb - 1]!) ? 200 : 0);
                else if (full < 5 * ql + 50) base = inOrder(qb, lower, bFrom, bEnd);
                consider(i, Math.max(full, base >= 0 ? base + 50 : -1) - length * 0.05);
            }
            for (const [i, w] of this.wide) scoreWide(i, w);
            // Where it's only in order (fuzzyScore's second way): at most 5 a character and 50 for the name, so only
            // looked for while that could still be among the best.
            const most = 5 * (ql - 1) + 1 + 50;
            if (worst() < most) {
                // The next place it's in a path, as the paths are gone through: those it's in were scored above.
                let next = lower.indexOf(qb, 0);
                for (let i = 0; i < n; i++) {
                    if (this.wide.has(i) || (this.masks[i]! & need) !== need) continue;
                    const length = this.len[i]!;
                    if (most - length * 0.05 < worst()) continue;
                    const from = this.start[i]!;
                    if (next >= 0 && next < from) next = lower.indexOf(qb, from);
                    if (next >= from && next < from + length) continue;
                    const base = inOrder(qb, lower, from + this.baseFrom[i]!, from + this.baseEnd[i]!);
                    const s = Math.max(inOrder(qb, lower, from, from + length), base >= 0 ? base + 50 : -1);
                    if (s > 0) consider(i, s - length * 0.05);
                }
            }
        }
        return best.map((b) => ({ p: this.path(b.i), s: b.s, k: this.keys ? this.keys[b.i]! : b.i }));
    }
}
