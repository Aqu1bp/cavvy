// Git's index file, read directly (no git process, nothing it runs): each tracked path's blob id and the stat Git
// recorded for it when it last read the file. A file whose stat still matches has exactly that blob, the rule
// `git status` itself uses, so a snapshot can take its id without reading or hashing the file.
//
// Versions 2, 3 and 4 (path compression). A split index (its entries live in another file), a sparse one, or
// anything unexpected reads as no index at all: the caller then asks git, and reads files as it would without one.

import { lstatSync, type BigIntStats } from "fs";
import { Pace } from "../util/pace";

const MAGIC = 0x44495243; // "DIRC"
const ASSUME_VALID = 0x8000, EXTENDED = 0x4000, STAGE = 0x3000;
const SKIP_WORKTREE = 0x4000, INTENT_TO_ADD = 0x2000;

export interface GitIndex {
    /** Each path's entry, by its offset into `buf` (a path in conflict: its last stage's). */
    readonly at: Map<string, number>;
    /** Every path once, in the index's order: what `ls-files --cached` lists. */
    readonly paths: string[];
    readonly buf: Buffer;
    readonly hashBytes: number;
    /** When the index was written, in nanoseconds: an entry stamped at or after it may be racily clean. */
    readonly writtenNs: bigint;
    /** The same, as seconds and the nanoseconds past them. */
    readonly writtenS: number;
    readonly writtenNsPart: number;
}

/** v4's offset-encoded varint (git's varint.c). */
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

/** Undefined for a split index, a sparse one (folders as entries) or anything unexpected. */
export async function parseIndex(buf: Buffer, hashBytes: number, writtenNs: bigint): Promise<GitIndex | undefined> {
    const pace = new Pace();
    if (buf.length < 12 + hashBytes || buf.readUInt32BE(0) !== MAGIC) return undefined;
    const version = buf.readUInt32BE(4);
    if (version < 2 || version > 4) return undefined;
    const count = buf.readUInt32BE(8);
    const at = new Map<string, number>();
    const paths: string[] = [];
    const end = buf.length - hashBytes;
    let pos = 12;
    // v4 strips a number of bytes (not characters) from the path before.
    let prev: Buffer = Buffer.alloc(0);
    let last = "";
    for (let i = 0; i < count; i++) {
        if ((i & 1023) === 1023 && pace.due) await pace.rest();
        const start = pos;
        const fixed = 40 + hashBytes; // ten 32-bit stat fields, the id
        if (start + fixed + 2 > end) return undefined;
        const flags = buf.readUInt16BE(start + fixed);
        pos = start + fixed + 2;
        if (flags & EXTENDED) {
            if (version < 3) return undefined;
            pos += 2;
        }
        // A sparse index's folder entry stands for files that aren't listed.
        if (buf.readUInt32BE(start + 24) >>> 12 === 0o04) return undefined;
        let path: string;
        if (version === 4) {
            const [strip, next] = varint(buf, pos);
            if (strip > prev.length) return undefined;
            const nul = buf.indexOf(0, next);
            if (nul < 0 || nul >= end) return undefined;
            prev = Buffer.concat([prev.subarray(0, prev.length - strip), buf.subarray(next, nul)]);
            path = prev.toString("utf-8");
            pos = nul + 1;
        } else {
            const nul = buf.indexOf(0, pos);
            if (nul < 0 || nul >= end) return undefined;
            path = buf.toString("utf-8", pos, nul);
            // Padded with 1–8 NULs to a multiple of 8 bytes from the entry's start.
            pos = start + Math.floor((nul - start + 8) / 8) * 8;
        }
        // A conflict's stages are next to each other: the path once.
        if (path !== last) paths.push(path);
        last = path;
        at.set(path, start);
    }
    // A split index keeps its entries in a shared file: what's here isn't all of them.
    for (let p = pos; p + 8 <= end;) {
        const sig = buf.toString("latin1", p, p + 4);
        const size = buf.readUInt32BE(p + 4);
        if (sig === "link") return undefined;
        p += 8 + size;
    }
    return { at, paths, buf, hashBytes, writtenNs, writtenS: Number(writtenNs / 1_000_000_000n), writtenNsPart: Number(writtenNs % 1_000_000_000n) };
}

/** The mode an entry stages, as `ls-files --stage` writes it ("100644"). */
export function modeOf(index: GitIndex, path: string): string | undefined {
    const o = index.at.get(path);
    return o === undefined ? undefined : index.buf.readUInt32BE(o + 24).toString(8).padStart(6, "0");
}

const u32 = (n: bigint) => Number(n & 0xffffffffn);

/** A stat as a capture has it (stat-files.ts): times in milliseconds, as fs.Stats gives them. */
export interface MsStat { kind: "file" | "link" | "other"; mode: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }

/**
 * Whether fs.Stats' millisecond times are exactly seconds × 1000 + nanoseconds / 1e6 here (so an index's recorded
 * times can be compared with them as they are), checked on a real file; if not, cleanBlob's nanoseconds are used.
 * Known once a file was looked at whole: not from one that isn't there (a new repository has no index yet), nor
 * one written between the two looks at it.
 */
let msExact: boolean | undefined;
export function msTimesExact(sample: string): boolean {
    if (msExact !== undefined) return msExact;
    const at = (t: bigint) => Number(t / 1_000_000_000n) * 1000 + Number(t % 1_000_000_000n) / 1e6;
    for (let tries = 0; tries < 3; tries++) {
        let before, ms, after;
        try {
            before = lstatSync(sample, { bigint: true });
            ms = lstatSync(sample);
            after = lstatSync(sample, { bigint: true });
        } catch {
            return false;
        }
        if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) continue;
        return (msExact = at(after.mtimeNs) === ms.mtimeMs && at(after.ctimeNs) === ms.ctimeMs);
    }
    return false;
}

/**
 * cleanBlob, from a stat in milliseconds (where msTimesExact): the same fields compared, but owner (which can't
 * change what a file holds), with each of the index's times as fs.Stats would have it.
 */
export function cleanBlobMs(index: GitIndex, path: string, st: MsStat): string | undefined {
    const o = index.at.get(path);
    if (o === undefined) return undefined;
    const b = index.buf;
    const flags = b.readUInt16BE(o + 40 + index.hashBytes);
    if (flags & (ASSUME_VALID | STAGE)) return undefined;
    if (flags & EXTENDED && b.readUInt16BE(o + 42 + index.hashBytes) & (SKIP_WORKTREE | INTENT_TO_ADD)) return undefined;
    const mode = b.readUInt32BE(o + 24);
    const kind = mode >>> 12;
    if (kind === 0o10) {
        if (st.kind !== "file" || ((mode & 0o100) !== 0) !== ((st.mode & 0o100) !== 0)) return undefined;
    } else if (kind === 0o12) {
        if (st.kind !== "link") return undefined;
    } else return undefined;
    const mtimeS = b.readUInt32BE(o + 8), mtimeNs = b.readUInt32BE(o + 12);
    if (mtimeS * 1000 + mtimeNs / 1e6 !== st.mtimeMs) return undefined;
    if (b.readUInt32BE(o) * 1000 + b.readUInt32BE(o + 4) / 1e6 !== st.ctimeMs) return undefined;
    if (b.readUInt32BE(o + 20) !== st.ino % 2 ** 32 || b.readUInt32BE(o + 36) !== st.size % 2 ** 32) return undefined;
    // Racily clean: written in the same instant as the index, the file could have changed without its stat showing it.
    if (mtimeS > index.writtenS || (mtimeS === index.writtenS && mtimeNs >= index.writtenNsPart)) return undefined;
    return b.toString("hex", o + 40, o + 40 + index.hashBytes);
}

/**
 * The blob id Git recorded for `path` if the file on disk is still the one it recorded (every stat field it keeps
 * agrees, and the entry isn't racily clean), with the same kind and executable bit. Otherwise undefined.
 */
export function cleanBlob(index: GitIndex, path: string, st: BigIntStats): string | undefined {
    const o = index.at.get(path);
    if (o === undefined) return undefined;
    const b = index.buf;
    // Only plain stage-0 entries Git keeps current: not conflicts, assume-unchanged, skip-worktree or intent-to-add.
    const flags = b.readUInt16BE(o + 40 + index.hashBytes);
    if (flags & (ASSUME_VALID | STAGE)) return undefined;
    if (flags & EXTENDED && b.readUInt16BE(o + 42 + index.hashBytes) & (SKIP_WORKTREE | INTENT_TO_ADD)) return undefined;
    const mode = b.readUInt32BE(o + 24);
    const kind = mode >>> 12;
    // Regular files and symlinks only (not gitlinks), of the same kind and executable bit as on disk.
    if (kind === 0o10) {
        if (!st.isFile() || ((mode & 0o100) !== 0) !== ((Number(st.mode) & 0o100) !== 0)) return undefined;
    } else if (kind === 0o12) {
        if (!st.isSymbolicLink()) return undefined;
    } else return undefined;
    const ctimeS = b.readUInt32BE(o), ctimeNs = b.readUInt32BE(o + 4);
    const mtimeS = b.readUInt32BE(o + 8), mtimeNs = b.readUInt32BE(o + 12);
    if (mtimeS !== u32(st.mtimeNs / 1_000_000_000n) || mtimeNs !== Number(st.mtimeNs % 1_000_000_000n)) return undefined;
    if (ctimeS !== u32(st.ctimeNs / 1_000_000_000n) || ctimeNs !== Number(st.ctimeNs % 1_000_000_000n)) return undefined;
    if (b.readUInt32BE(o + 20) !== u32(st.ino) || b.readUInt32BE(o + 36) !== u32(st.size)) return undefined;
    if (b.readUInt32BE(o + 28) !== u32(st.uid) || b.readUInt32BE(o + 32) !== u32(st.gid)) return undefined;
    // Racily clean: written in the same instant as the index, the file could have changed without its stat showing it.
    if (BigInt(mtimeS) * 1_000_000_000n + BigInt(mtimeNs) >= index.writtenNs) return undefined;
    return b.toString("hex", o + 40, o + 40 + index.hashBytes);
}
