// What differs, in a folder, from what Git's index records: read straight from the index file, one entry after
// another, each path stat'ed and compared with the stat the index kept (the rule `git status` uses), and the
// untracked paths git listed stat'ed too. Only what differs comes back, so a turn snapshot of a 100,000-file
// repository holds nothing of the files that haven't changed (turn-snapshots.ts). Runs on the stat worker
// (stat-worker.ts), or here where there's none. Nothing is read but the index and stats; nothing runs.

import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, type Stats } from "fs";

/** What's at a path (as stat-files.ts has it). */
export const AT = { missing: 0, file: 1, link: 2, dir: 3, other: 4, unreadable: 5 } as const;

export interface Differs {
    path: string;
    tracked: boolean;
    kind: number;
    /** Device, inode, mode, size, mtime, ctime (ms): its stamp, to know it again. */
    stamp: number[];
    /** A tracked entry that isn't a plain file to compare: a submodule, a conflict, one Git keeps aside (skip-worktree, assume-unchanged, intent-to-add). */
    special?: "gitlink" | "entry";
}

export interface IndexScan {
    /** The index can't be used this way (split or sparse, or unreadable): the caller does without it. */
    unusable?: string;
    differs: Differs[];
    /** Tracked paths not there (or not reachable through real folders). */
    gone: string[];
    /** The .gitattributes files the index tracks. */
    attributes: string[];
    /** What the index records (contentKey), not when or how it was written. */
    contentKey?: string;
    /** The trees of what the index records, as Git last worked them out (its cache-tree), when they're all still so. */
    cacheTree?: { root: string; trees: string[] };
}

/**
 * The index's cache-tree extension: each folder's path, its entry count (-1 when something in it changed since its
 * tree was worked out) and its subtrees' count, then its tree's id when it's valid. Only when the root's is.
 */
function cacheTreeOf(data: Buffer, hashBytes: number): { root: string; trees: string[] } | undefined {
    const trees: string[] = [];
    let pos = 0;
    while (pos < data.length) {
        const nul = data.indexOf(0, pos);
        const nl = data.indexOf(10, nul);
        if (nul < 0 || nl < 0) return undefined;
        const [entries] = data.toString("latin1", nul + 1, nl).split(" ");
        pos = nl + 1;
        if (Number(entries) < 0) {
            if (!trees.length) return undefined;
            continue;
        }
        if (pos + hashBytes > data.length) return undefined;
        trees.push(data.toString("hex", pos, pos + hashBytes));
        pos += hashBytes;
    }
    return trees.length ? { root: trees[0]!, trees } : undefined;
}

/**
 * What an index records, as a key: each entry's mode, id, flags and path (and its size, owner), not its stat times,
 * device or inode, which Git rewrites the index to refresh (git status does) though no file's content changed.
 */
class ContentKey {
    private words: Int32Array;
    /** Blanks each entry's stat fields (its first 24 bytes) in `bytes`, once nothing else reads them. */
    constructor(private bytes: Buffer) {
        this.words = new Int32Array(bytes.buffer, 0, bytes.buffer.byteLength >> 2);
    }
    add(start: number) {
        const at = this.bytes.byteOffset + start;
        if (at & 3) return void this.bytes.fill(0, start, start + 24);
        const w = at >> 2;
        this.words[w] = this.words[w + 1] = this.words[w + 2] = this.words[w + 3] = this.words[w + 4] = this.words[w + 5] = 0;
    }
    /** Of the entries, up to `end` (not the extensions after them: a commit rewrites the cached trees). */
    key(end: number): string {
        return Bun.hash(this.bytes.subarray(0, end)).toString(36);
    }
}

/** Where an entry's path ends (its NUL): its length is in its flags, unless it's 4095 bytes or more. */
function pathEnd(buf: Buffer, flags: number, from: number): number {
    const length = flags & 0xfff;
    return length < 0xfff && buf[from + length] === 0 ? from + length : buf.indexOf(0, from);
}

const MAGIC = 0x44495243;
const ASSUME_VALID = 0x8000, EXTENDED = 0x4000, STAGE = 0x3000;
const SKIP_WORKTREE = 0x4000, INTENT_TO_ADD = 0x2000;
const gone = (e: unknown) => ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException)?.code ?? "");

function varint(buf: Buffer, pos: number): [number, number] {
    let c = buf[pos++]!;
    let val = c & 127;
    while (c & 128) {
        val += 1;
        c = buf[pos++]!;
        val = val * 128 + (c & 127);
    }
    return [val, pos];
}

const kindOf = (st: Stats) => (st.isFile() ? AT.file : st.isSymbolicLink() ? AT.link : st.isDirectory() ? AT.dir : AT.other);
const stampOf = (st: Stats) => [st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs];

/**
 * `root`'s differences from its index (`indexFile`, ids of `hashBytes`). `msExact`: fs.Stats' millisecond times are
 * seconds × 1000 + nanoseconds / 1e6 here (git-index.ts msTimesExact); if not, every tracked file counts as differing.
 * `part`: the `k`th of `n` runs of the index's entries only (stat-files.ts runs them side by side, as git's
 * preload-index does): the first works out the content key, the last looks at the untracked paths.
 */
/** What a scan past its deadline throws. */
export const LATE = "late";

/** `deadline`: past it, it stops (throws LATE): nothing waits for what it would find. */
export function scanIndex(root: string, indexFile: string, hashBytes: number, untracked: readonly string[], msExact: boolean, part: { k: number; n: number } = { k: 0, n: 1 }, deadline?: number): IndexScan {
    const out: IndexScan = { differs: [], gone: [], attributes: [] };
    let buf: Buffer, written: Stats;
    try {
        written = lstatSync(indexFile);
        buf = readFileSync(indexFile);
    } catch {
        return { ...out, unusable: "unreadable" };
    }
    if (buf.length < 12 + hashBytes || buf.readUInt32BE(0) !== MAGIC) return { ...out, unusable: "unreadable" };
    const version = buf.readUInt32BE(4);
    if (version < 2 || version > 4) return { ...out, unusable: "version" };
    // The index's own time: an entry stamped at or after it may be racily clean.
    const indexMs = written.mtimeMs;
    const folders = new Map<string, boolean>();
    const inside = (rel: string): boolean => {
        const i = rel.lastIndexOf("/");
        if (i < 0) return true;
        const dir = rel.slice(0, i);
        let ok = folders.get(dir);
        if (ok === undefined) {
            let st: Stats | undefined;
            try { st = lstatSync(`${root}/${dir}`, { throwIfNoEntry: false }); } catch (e) { if (!gone(e)) throw e; }
            ok = !!st?.isDirectory() && inside(dir);
            folders.set(dir, ok);
        }
        return ok;
    };
    /** A path's stat: undefined when it isn't there, null when it can't be read. */
    const statOf = (path: string): Stats | undefined | null => {
        try {
            return inside(path) ? lstatSync(`${root}/${path}`, { throwIfNoEntry: false }) : undefined;
        } catch (e) {
            return gone(e) ? undefined : null;
        }
    };
    const count = buf.readUInt32BE(8);
    const end = buf.length - hashBytes;
    const content = part.k === 0 ? new ContentKey(buf) : undefined;
    const from = Math.floor((count * part.k) / part.n), to = Math.floor((count * (part.k + 1)) / part.n);
    let pos = 12;
    // A version 4 index's path is the last one's, cut and added to: built here, in place.
    let built = Buffer.alloc(4096), builtLength = 0;
    let last = "";
    let before = -1;
    for (let n = 0; n < count; n++) {
        // The last entry's stat fields are read: blanked for the content key.
        if (before >= 0) content?.add(before);
        const start = (before = pos);
        if (start + 40 + hashBytes + 2 > end) return { ...out, unusable: "unreadable" };
        const flags = buf.readUInt16BE(start + 40 + hashBytes);
        pos = start + 42 + hashBytes;
        let extended = 0;
        if (flags & EXTENDED) {
            if (version < 3) return { ...out, unusable: "unreadable" };
            extended = buf.readUInt16BE(pos);
            pos += 2;
        }
        let path: string;
        const mine = n >= from - 1 && n < to;
        if (version === 4) {
            const [strip, next] = varint(buf, pos);
            const nul = buf.indexOf(0, next);
            if (strip > builtLength || nul < 0 || nul >= end) return { ...out, unusable: "unreadable" };
            const length = builtLength - strip + nul - next;
            if (built.length < length) {
                const bigger = Buffer.alloc(length * 2);
                built.copy(bigger, 0, 0, builtLength - strip);
                built = bigger;
            }
            buf.copy(built, builtLength - strip, next, nul);
            builtLength = length;
            // Only this part's paths (and the one before, for a conflict's stages) are made strings.
            path = mine ? built.toString("utf-8", 0, length) : "";
            pos = nul + 1;
        } else {
            const nul = pathEnd(buf, flags, pos);
            if (nul < 0 || nul >= end) return { ...out, unusable: "unreadable" };
            path = mine ? buf.toString("utf-8", pos, nul) : "";
            pos = start + Math.floor((nul - start + 8) / 8) * 8;
        }
        // A conflict's stages are next to each other: the path once.
        const again = path === last;
        last = path;
        const mode = buf.readUInt32BE(start + 24);
        const kind = mode >>> 12;
        // A sparse index's folder entry stands for files that aren't listed.
        if (kind === 0o04) return { ...out, unusable: "sparse" };
        if (again || n < from || n >= to) continue;
        if (deadline !== undefined && (n & 1023) === 0 && Date.now() >= deadline) throw new Error(LATE);
        if (path === ".gitattributes" || path.endsWith("/.gitattributes")) out.attributes.push(path);
        const st = statOf(path);
        const special = kind === 0o16 ? "gitlink" : flags & (ASSUME_VALID | STAGE) || extended & (SKIP_WORKTREE | INTENT_TO_ADD) ? "entry" : undefined;
        if (st === null) { out.differs.push({ path, tracked: true, kind: AT.unreadable, stamp: [], special }); continue; }
        if (!st) {
            if (special) out.differs.push({ path, tracked: true, kind: AT.missing, stamp: [], special });
            else out.gone.push(path);
            continue;
        }
        if (special) { out.differs.push({ path, tracked: true, kind: kindOf(st), stamp: stampOf(st), special }); continue; }
        // As Git last recorded it: the same kind and executable bit, size, inode and times, written before the index was.
        const same = msExact
            && (kind === 0o10 ? st.isFile() && ((mode & 0o100) !== 0) === ((st.mode & 0o100) !== 0) : kind === 0o12 && st.isSymbolicLink())
            && buf.readUInt32BE(start + 8) * 1000 + buf.readUInt32BE(start + 12) / 1e6 === st.mtimeMs
            && buf.readUInt32BE(start) * 1000 + buf.readUInt32BE(start + 4) / 1e6 === st.ctimeMs
            && buf.readUInt32BE(start + 20) === st.ino % 2 ** 32 && buf.readUInt32BE(start + 36) === st.size % 2 ** 32
            && st.mtimeMs < indexMs;
        if (!same) out.differs.push({ path, tracked: true, kind: kindOf(st), stamp: stampOf(st) });
    }
    if (before >= 0) content?.add(before);
    // A split index keeps its entries in a shared file: what's here isn't all of them.
    for (let p = pos; p + 8 <= end;) {
        const signature = buf.toString("latin1", p, p + 4), size = buf.readUInt32BE(p + 4);
        if (signature === "link") return { ...out, unusable: "split" };
        if (signature === "TREE" && part.k === 0) out.cacheTree = cacheTreeOf(buf.subarray(p + 8, p + 8 + size), hashBytes);
        p += 8 + size;
    }
    out.contentKey = content?.key(pos);
    if (part.k !== part.n - 1) return out;
    for (const path of untracked) {
        const st = statOf(path);
        if (st === null) out.differs.push({ path, tracked: false, kind: AT.unreadable, stamp: [] });
        else if (st) out.differs.push({ path, tracked: false, kind: kindOf(st), stamp: stampOf(st) });
    }
    return out;
}

/**
 * Where each entry of an index file starts, kept by the worker once it's read one whole (scanPaths), with what it
 * found: while the file is the same one (git writes a new index and renames it over the old), a few paths are found by
 * binary search, a few small reads each, not by reading and parsing all of it again. Not for version 4 (each path is
 * written as a change to the last one's, so one can't be read alone), a split index or a sparse one.
 */
const offsetsByIndex = new Map<string, { stamp: string; offsets: Uint32Array; contentKey: string; cacheRoot?: string; specials: number; attributes: string[]; size: number; entriesEnd: number }>();

/** The index's extensions from `at` (where its entries end): its cache-tree's root, or that it's split. */
function extensionsOf(buf: Buffer, at: number, hashBytes: number): { cacheRoot?: string; split?: boolean } {
    const end = buf.length - hashBytes;
    let cacheRoot: string | undefined;
    for (let p = at; p + 8 <= end;) {
        const signature = buf.toString("latin1", p, p + 4), size = buf.readUInt32BE(p + 4);
        if (signature === "link") return { split: true };
        if (signature === "TREE") cacheRoot = cacheTreeOf(buf.subarray(p + 8, p + 8 + size), hashBytes)?.root;
        p += 8 + size;
    }
    return cacheRoot ? { cacheRoot } : {};
}
const MAX_OFFSET_TABLES = 32;
const statStamp = (st: Stats) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;

/** The entries named in `wanted` and those under any of them, read by offset; undefined to read the file whole. */
function entriesByOffset(fd: number, table: { offsets: Uint32Array }, hashBytes: number, wanted: ReadonlySet<string>, maxUnder: number): { entries: Map<string, Buffer>; under: string[] } | "wide" | undefined {
    const { offsets } = table;
    let chunk = Buffer.alloc(512);
    /** Entry `i`: its header (to its flags) and path. */
    const at = (i: number): { header: Buffer; path: Buffer } | undefined => {
        const start = offsets[i]!;
        let n = readSync(fd, chunk, 0, chunk.length, start);
        const flags = n >= 42 + hashBytes ? chunk.readUInt16BE(40 + hashBytes) : 0;
        const from = 42 + hashBytes + (flags & EXTENDED ? 2 : 0);
        let nul = chunk.indexOf(0, from);
        while ((nul < 0 || nul >= n) && n === chunk.length) {
            chunk = Buffer.alloc(chunk.length * 4);
            n = readSync(fd, chunk, 0, chunk.length, start);
            nul = chunk.indexOf(0, from);
        }
        if (nul < 0 || nul >= n) return undefined;
        return { header: Buffer.from(chunk.subarray(0, 44 + hashBytes)), path: Buffer.from(chunk.subarray(from, nul)) };
    };
    /** The first entry whose path is `target` or after it. */
    const lowerBound = (target: Buffer): number => {
        let lo = 0, hi = offsets.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            const e = at(mid);
            if (!e) return -1;
            if (Buffer.compare(e.path, target) < 0) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const entries = new Map<string, Buffer>();
    const under: string[] = [];
    for (const path of wanted) {
        const exact = Buffer.from(path, "utf-8");
        const i = lowerBound(exact);
        if (i < 0) return undefined;
        const e = i < offsets.length ? at(i) : undefined;
        // The first stage of a conflict is enough: any stage but 0 makes it special.
        if (e && e.path.equals(exact) && !entries.has(path)) entries.set(path, e.header);
        // What's under it, as a folder: the run of entries after "path/".
        const prefix = Buffer.from(`${path}/`, "utf-8");
        for (let j = lowerBound(prefix); j >= 0 && j < offsets.length; j++) {
            const u = at(j);
            if (!u) return undefined;
            if (u.path.length < prefix.length || !u.path.subarray(0, prefix.length).equals(prefix)) break;
            const name = u.path.toString("utf-8");
            if (entries.has(name)) continue;
            if (!wanted.has(name)) {
                if (under.length >= maxUnder) return "wide";
                under.push(name);
            }
            entries.set(name, u.header);
        }
    }
    return { entries, under };
}

/** A path's state against the index: Differs, plus what the index records for it (when it does). */
export interface PathState extends Differs {
    /** As the index records it, when that's what's on disk: its entry, to put back. */
    clean?: { mode: string; oid: string };
    /** The index has no entry for it (it's untracked, or ignored). */
    unknown?: boolean;
}

/**
 * Only `paths` of `root` against its index (`indexFile`): for each, whether it's as the index records it (with that
 * entry), differs (with its stamp), is gone, or isn't in the index at all. The index's entries under any of them (a
 * folder moved, removed or replaced names only itself) are looked at too, up to `maxUnder`: past it, `unusable`. The
 * index is read whole, but only these paths are stat'ed: a turn that changed a few files of a 100,000-file repository
 * looks at those.
 */
/**
 * `paths` (and what's under those that are folders in the index) against Git's index: each one's state. Also what the
 * whole index records (its content key), the tree Git last worked out for it, its .gitattributes files, and how many
 * entries are of a kind `git status` doesn't tell plainly (a conflict, a submodule, assume-unchanged, skip-worktree,
 * intent-to-add): read once whole, then by offset.
 */
export function scanPaths(root: string, indexFile: string, hashBytes: number, paths: readonly string[], msExact: boolean, maxUnder = 5000): { unusable?: string; states: PathState[]; contentKey?: string; cacheRoot?: string; specials?: number; attributes?: string[] } {
    let buf: Buffer, written: Stats;
    const wanted = new Set(paths);
    /** Each one's entry, up to its flags (its stat fields are blanked in the index's bytes for the content key). */
    let entries = new Map<string, Buffer>();
    /** Entries under a wanted path, in order. */
    let under: string[] = [];
    // The same index file as one read whole before: the entries by offset.
    const table = offsetsByIndex.get(indexFile);
    if (table) {
        let fd: number | undefined;
        try {
            fd = openSync(indexFile, "r");
            const st = fstatSync(fd);
            // Written again with the same entries (`git status` saving what it refreshed: only their stat fields differ),
            // asked only what it records: its entries where they were, their content key the same, without making
            // a path of each.
            if (statStamp(st) !== table.stamp && !wanted.size && st.size === table.size) {
                const buf = readFileSync(fd);
                if (buf.length === table.size && buf.readUInt32BE(8) === table.offsets.length) {
                    const content = new ContentKey(buf);
                    for (const o of table.offsets) content.add(o);
                    if (content.key(table.entriesEnd) === table.contentKey) {
                        const ext = extensionsOf(buf, table.entriesEnd, hashBytes);
                        if (ext.split) return { unusable: "split", states: [] };
                        table.stamp = statStamp(st);
                        table.cacheRoot = ext.cacheRoot;
                        return { states: [], contentKey: table.contentKey, ...(ext.cacheRoot ? { cacheRoot: ext.cacheRoot } : {}), specials: table.specials, attributes: table.attributes };
                    }
                }
            }
            if (statStamp(st) === table.stamp) {
                const found = entriesByOffset(fd, table, hashBytes, wanted, maxUnder);
                if (found === "wide") return { unusable: "wide", states: [] };
                if (found) return { states: pathStates(root, hashBytes, [...wanted, ...found.under], found.entries, st.mtimeMs, msExact), contentKey: table.contentKey, ...(table.cacheRoot ? { cacheRoot: table.cacheRoot } : {}), specials: table.specials, attributes: table.attributes };
            }
        } catch {
            // Read whole, below.
        } finally {
            if (fd !== undefined) closeSync(fd);
        }
        offsetsByIndex.delete(indexFile);
    }
    try {
        written = lstatSync(indexFile);
        buf = readFileSync(indexFile);
    } catch {
        return { unusable: "unreadable", states: [] };
    }
    if (buf.length < 12 + hashBytes || buf.readUInt32BE(0) !== MAGIC) return { unusable: "unreadable", states: [] };
    const version = buf.readUInt32BE(4);
    if (version < 2 || version > 4) return { unusable: "version", states: [] };
    // Most entries are none of these, told without making a string of their path: by its length and first and last
    // bytes (a wanted one has the same), and by its folder, worked out once for each (a folder's entries come together).
    const sig = (b: Buffer, from: number, to: number) => (to - from) * 65536 + b[from]! * 256 + b[to - 1]!;
    const sigs = new Set<number>();
    for (const p of wanted) {
        const b = Buffer.from(p, "utf-8");
        if (b.length) sigs.add(sig(b, 0, b.length));
    }
    let lastDir = Buffer.alloc(256), lastDirLength = -1, lastDirUnder = false;
    const dirUnder = (src: Buffer, from: number, to: number): boolean => {
        const length = to - from;
        if (length === lastDirLength && src.compare(lastDir, 0, length, from, to) === 0) return lastDirUnder;
        if (lastDir.length < length) lastDir = Buffer.alloc(length * 2);
        src.copy(lastDir, 0, from, to);
        lastDirLength = length;
        const dir = src.toString("utf-8", from, to);
        lastDirUnder = false;
        for (let i = dir.length; i > 0; i = dir.lastIndexOf("/", i - 1)) {
            if (wanted.has(dir.slice(0, i))) { lastDirUnder = true; break; }
        }
        return lastDirUnder;
    };
    const count = buf.readUInt32BE(8);
    const end = buf.length - hashBytes;
    const content = new ContentKey(buf);
    const offsets = version === 4 ? undefined : new Uint32Array(count);
    let pos = 12;
    // A version 4 index's path is the last one's, cut and added to: built here, in place.
    let built = Buffer.alloc(4096), builtLength = 0;
    let specials = 0;
    const attributes: string[] = [];
    const GITATTRIBUTES = Buffer.from(".gitattributes");
    for (let n = 0; n < count; n++) {
        const start = pos;
        if (offsets) offsets[n] = start;
        if (start + 42 + hashBytes > end) return { unusable: "unreadable", states: [] };
        const flags = buf.readUInt16BE(start + 40 + hashBytes);
        const extended = flags & EXTENDED ? buf.readUInt16BE(start + 42 + hashBytes) : 0;
        if (buf.readUInt32BE(start + 24) >>> 12 === 0o16 || flags & (ASSUME_VALID | STAGE) || extended & (SKIP_WORKTREE | INTENT_TO_ADD)) specials++;
        pos = start + 42 + hashBytes + (flags & EXTENDED ? 2 : 0);
        let src: Buffer, from: number, to: number;
        if (version === 4) {
            const [strip, next] = varint(buf, pos);
            const nul = buf.indexOf(0, next);
            if (strip > builtLength || nul < 0 || nul >= end) return { unusable: "unreadable", states: [] };
            const length = builtLength - strip + nul - next;
            if (built.length < length) {
                const bigger = Buffer.alloc(length * 2);
                built.copy(bigger, 0, 0, builtLength - strip);
                built = bigger;
            }
            buf.copy(built, builtLength - strip, next, nul);
            builtLength = length;
            [src, from, to] = [built, 0, length];
            pos = nul + 1;
        } else {
            const nul = pathEnd(buf, flags, pos);
            if (nul < 0 || nul >= end) return { unusable: "unreadable", states: [] };
            [src, from, to] = [buf, pos, nul];
            pos = start + Math.floor((nul - start + 8) / 8) * 8;
        }
        if (buf.readUInt32BE(start + 24) >>> 12 === 0o04) return { unusable: "sparse", states: [] };
        if (to - from >= 14 && src.compare(GITATTRIBUTES, 0, 14, to - 14, to) === 0 && (to - from === 14 || src[to - 15] === 0x2f)) attributes.push(src.toString("utf-8", from, to));
        const slash = to > from ? src.lastIndexOf(0x2f, to - 1) : -1;
        const inside = slash >= from && dirUnder(src, from, slash);
        if (inside || (to > from && sigs.has(sig(src, from, to)))) {
            const path = src.toString("utf-8", from, to);
            // The first stage of a conflict is enough: any stage but 0 makes it special.
            if (!entries.has(path) && (inside || wanted.has(path))) {
                if (!wanted.has(path)) {
                    if (under.length >= maxUnder) return { unusable: "wide", states: [] };
                    under.push(path);
                }
                entries.set(path, Buffer.from(buf.subarray(start, start + 44 + hashBytes)));
            }
        }
        content.add(start);
    }
    const contentKey = content.key(pos);
    const ext = extensionsOf(buf, pos, hashBytes);
    if (ext.split) return { unusable: "split", states: [] };
    const cacheRoot = ext.cacheRoot;
    if (offsets && buf.length < 2 ** 32) {
        if (offsetsByIndex.size >= MAX_OFFSET_TABLES) offsetsByIndex.delete(offsetsByIndex.keys().next().value!);
        offsetsByIndex.set(indexFile, { stamp: statStamp(written), offsets, contentKey, ...(cacheRoot ? { cacheRoot } : {}), specials, attributes, size: buf.length, entriesEnd: pos });
    }
    return { states: pathStates(root, hashBytes, [...wanted, ...under], entries, written.mtimeMs, msExact), contentKey, ...(cacheRoot ? { cacheRoot } : {}), specials, attributes };
}

/** Each path stat'ed, against its entry in the index (`entries`, by path), if it has one. */
function pathStates(root: string, hashBytes: number, paths: string[], entries: Map<string, Buffer>, indexMs: number, msExact: boolean): PathState[] {
    const states: PathState[] = [];
    for (const path of paths) {
        let st: Stats | undefined | null;
        try {
            // Every folder on the way a real one: a path through a link isn't there.
            const parts = path.split("/");
            let ok = true;
            for (let i = 1; i < parts.length && ok; i++) {
                const d = lstatSync(`${root}/${parts.slice(0, i).join("/")}`, { throwIfNoEntry: false });
                ok = !!d?.isDirectory();
            }
            st = ok ? lstatSync(`${root}/${path}`, { throwIfNoEntry: false }) : undefined;
        } catch (e) {
            st = gone(e) ? undefined : null;
        }
        const e = entries.get(path), o = 0;
        const stamp = st ? stampOf(st) : [];
        const kind = st === null ? AT.unreadable : !st ? AT.missing : kindOf(st);
        if (e === undefined) { states.push({ path, tracked: false, kind, stamp, unknown: true }); continue; }
        const flags = e.readUInt16BE(o + 40 + hashBytes);
        const extended = flags & EXTENDED ? e.readUInt16BE(o + 42 + hashBytes) : 0;
        const mode = e.readUInt32BE(o + 24);
        const special = mode >>> 12 === 0o16 ? "gitlink" : flags & (ASSUME_VALID | STAGE) || extended & (SKIP_WORKTREE | INTENT_TO_ADD) ? "entry" : undefined;
        const same = !special && st && msExact
            && (mode >>> 12 === 0o10 ? st.isFile() && ((mode & 0o100) !== 0) === ((st.mode & 0o100) !== 0) : mode >>> 12 === 0o12 && st.isSymbolicLink())
            && e.readUInt32BE(o + 8) * 1000 + e.readUInt32BE(o + 12) / 1e6 === st.mtimeMs
            && e.readUInt32BE(o) * 1000 + e.readUInt32BE(o + 4) / 1e6 === st.ctimeMs
            && e.readUInt32BE(o + 20) === st.ino % 2 ** 32 && e.readUInt32BE(o + 36) === st.size % 2 ** 32
            && st.mtimeMs < indexMs;
        states.push({ path, tracked: true, kind, stamp, special, clean: same ? { mode: mode.toString(8).padStart(6, "0"), oid: e.toString("hex", o + 40, o + 40 + hashBytes) } : undefined });
    }
    return states;
}
