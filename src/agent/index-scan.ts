// What differs, in a folder, from what Git's index records: read straight from the index file, one entry after
// another, each path stat'ed and compared with the stat the index kept (the rule `git status` uses), and the
// untracked paths git listed stat'ed too. Only what differs comes back, so a turn snapshot of a 100,000-file
// repository holds nothing of the files that haven't changed (turn-snapshots.ts). Runs on the stat worker
// (stat-worker.ts), or here where there's none. Nothing is read but the index and stats; nothing runs.

import { lstatSync, readFileSync, type Stats } from "fs";

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
 */
export function scanIndex(root: string, indexFile: string, hashBytes: number, untracked: readonly string[], msExact: boolean): IndexScan {
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
    let pos = 12;
    let prev: Buffer = Buffer.alloc(0);
    let last = "";
    for (let n = 0; n < count; n++) {
        const start = pos;
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
        if (version === 4) {
            const [strip, next] = varint(buf, pos);
            if (strip > prev.length) return { ...out, unusable: "unreadable" };
            const nul = buf.indexOf(0, next);
            if (nul < 0 || nul >= end) return { ...out, unusable: "unreadable" };
            prev = Buffer.concat([prev.subarray(0, prev.length - strip), buf.subarray(next, nul)]);
            path = prev.toString("utf-8");
            pos = nul + 1;
        } else {
            const nul = buf.indexOf(0, pos);
            if (nul < 0 || nul >= end) return { ...out, unusable: "unreadable" };
            path = buf.toString("utf-8", pos, nul);
            pos = start + Math.floor((nul - start + 8) / 8) * 8;
        }
        // A conflict's stages are next to each other: the path once.
        const again = path === last;
        last = path;
        if (again) continue;
        const mode = buf.readUInt32BE(start + 24);
        const kind = mode >>> 12;
        // A sparse index's folder entry stands for files that aren't listed.
        if (kind === 0o04) return { ...out, unusable: "sparse" };
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
    // A split index keeps its entries in a shared file: what's here isn't all of them.
    for (let p = pos; p + 8 <= end;) {
        if (buf.toString("latin1", p, p + 4) === "link") return { ...out, unusable: "split" };
        p += 8 + buf.readUInt32BE(p + 4);
    }
    for (const path of untracked) {
        const st = statOf(path);
        if (st === null) out.differs.push({ path, tracked: false, kind: AT.unreadable, stamp: [] });
        else if (st) out.differs.push({ path, tracked: false, kind: kindOf(st), stamp: stampOf(st) });
    }
    return out;
}
