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

export class PathIndex {
    /** Folders (with their "/"), then files: as they're offered, in this order on a tie. */
    private paths: string[] = [];
    private lower: string[] = [];
    /** Where each path's last part starts, and its end (a folder's "/" isn't part of it). */
    private baseFrom = new Uint32Array(0);
    private baseEnd = new Uint32Array(0);
    private masks = new Uint32Array(0);
    /** The most each path can score (by its length alone): one that can't beat the best found yet isn't scored. */
    private most = new Float64Array(0);
    /** Each path's place among all of a project's paths, when this has a part of them (take's `first`). */
    private keys?: Float64Array;

    get size(): number {
        return this.paths.length;
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
        for (let k = 0; k < files.length; k++) {
            const f = files[k]!;
            for (let end = f.lastIndexOf("/"); end > 0; end = f.lastIndexOf("/", end - 1)) {
                const d = f.slice(0, end + 1);
                if (dirs.has(d)) break;
                fresh.push(d);
            }
            for (let j = fresh.length - 1; j >= 0; j--) {
                const d = fresh[j]!;
                dirs.add(d);
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
        const n = paths.length;
        const lower = new Array<string>(n);
        const baseFrom = new Uint32Array(n);
        const baseEnd = new Uint32Array(n);
        const masks = new Uint32Array(n);
        const most = new Float64Array(n);
        const keys = keyed ? new Float64Array(n) : undefined;
        for (let i = 0; i < n; i++) {
            const p = paths[i]!;
            const l = p.toLowerCase();
            lower[i] = l === p ? p : l;
            const end = p.endsWith("/") ? p.length - 1 : p.length;
            baseEnd[i] = end;
            baseFrom[i] = p.lastIndexOf("/", end - 1) + 1;
            masks[i] = charMask(l);
            // Found at the start of its name, at a word's start (scoreIn), less what its length costs (find).
            most[i] = Math.max(1250 - (end - baseFrom[i]!) * 0.01, 1200 - l.length * 0.01) - p.length * 0.05;
            if (keys) keys[i] = i < dirKeys.length ? dirKeys[i]! : FOLDERS_END + first + (i - dirKeys.length);
            const waiting = pause(i);
            if (waiting) await waiting;
        }
        Object.assign(this, { paths, lower, baseFrom, baseEnd, masks, most, keys });
    }

    /** The paths that best match `query`, best first. */
    find(query: string, limit: number): string[] {
        return this.top(query, limit).map((x) => x.p);
    }

    /** The same, each with its score and its place on a tie (merged puts several parts' together). */
    top(query: string, limit: number): Scored[] {
        const q = query.replace(/^\.\//, "").toLowerCase();
        const need = charMask(q);
        // The best `limit`, best first; a later one only above an equal one if better (as a stable sort leaves them).
        const best: { i: number; s: number }[] = [];
        for (let i = 0; i < this.paths.length; i++) {
            // Can't beat the last of the best, whatever it scores: not scored.
            if (best.length === limit && this.most[i]! <= best[limit - 1]!.s) continue;
            if ((this.masks[i]! & need) !== need) continue;
            const t = this.lower[i]!;
            // Its name first (by 50), if it's there: a path it isn't in at all isn't offered (it was, at 49, above
            // ones it was in with letters between).
            const base = scoreIn(q, t, this.baseFrom[i]!, this.baseEnd[i]!);
            const s = Math.max(scoreIn(q, t, 0, t.length), base >= 0 ? base + 50 : -1);
            if (s <= 0) continue;
            const score = s - this.paths[i]!.length * 0.05;
            if (best.length === limit && score <= best[limit - 1]!.s) continue;
            let at = best.length;
            while (at > 0 && best[at - 1]!.s < score) at--;
            best.splice(at, 0, { i, s: score });
            if (best.length > limit) best.pop();
        }
        return best.map((b) => ({ p: this.paths[b.i]!, s: b.s, k: this.keys ? this.keys[b.i]! : b.i }));
    }
}
