// Turn snapshots' stat of every file (turn-snapshots.ts): on a worker thread (stat-worker.ts), so the server's own
// thread, which every session and the GUI's socket share, isn't held for it. Where there's no worker (a build that
// left it out, or CAVVY_STAT_WORKER=0), here, a few milliseconds at a time.

import { constants, lstatSync, type Stats } from "fs";
import { open } from "fs/promises";
import { loadavg } from "os";
import { Pace } from "../util/pace";
import { INDEX_OPEN, scanIndex, scanPaths, type IndexScan } from "./index-scan";

/** What's at a path. */
export const KIND = { missing: 0, file: 1, link: 2, dir: 3, other: 4, unreadable: 5 } as const;

export interface StatRequest {
    id: number;
    /** When nothing waits for the answer any more (Date.now()). */
    deadline?: number;
    root: string;
    /** Names the tracked list: the same list, the same id (one per version of Git's index). */
    trackedId: string;
    /** Sent when the worker may not have it. */
    tracked?: string[];
    untracked: string[];
}

/** A folder's differences from its Git index (index-scan.ts), worked out on the worker. */
export interface IndexRequest {
    id: number;
    /** When nothing waits for the answer any more (Date.now()). */
    deadline?: number;
    root: string;
    indexFile: string;
    hashBytes: number;
    untracked: string[];
    msExact: boolean;
    /** Only the `k`th of `n` runs of its entries (index-scan.ts scanIndex). */
    part?: { k: number; n: number };
    /** The index as read once for every part (readShared); else each reads it. */
    shared?: SharedIndexBytes;
}

/**
 * Git's index file, read once for all the parts of a scan: how many of the parts after the first are through with it
 * (an Int32 at 0, which the first waits for: index-scan.ts SharedIndex), then its `length` bytes from SHARED_AT.
 */
export interface SharedIndexBytes {
    sab: SharedArrayBuffer;
    length: number;
    mtimeMs: number;
}
export const SHARED_AT = 8;

/** Only some paths of a folder against its Git index (index-scan.ts scanPaths). */
export interface PathsRequest {
    id: number;
    /** When nothing waits for the answer any more (Date.now()). */
    deadline?: number;
    root: string;
    indexFile: string;
    hashBytes: number;
    paths: string[];
    msExact: boolean;
}

export type StatReply = { id: number; kinds?: Uint8Array; stamps?: Float64Array; missing?: boolean; error?: string; scan?: IndexScan; paths?: ReturnType<typeof scanPaths> };

/** For each path, tracked then untracked: its kind, and six stamp fields (device, inode, mode, size, mtime, ctime). */
export interface FileStats {
    kinds: Uint8Array;
    stamps: Float64Array;
}

/** undefined: not started yet (or let go of, idle); null: none to be had. */
let worker: Worker | null | undefined;
/**
 * The worker and the lookups worker are let go of after this long with nothing asked of them, and started again when
 * next needed: the worker is sent its tracked lists again, the lookups worker reads each index whole once more.
 */
let idleMs = 60_000;
/** What's been asked of each worker and not answered yet. */
const asking = new Map<Worker, number>();
const idleTimers = new Map<Worker, ReturnType<typeof setTimeout>>();
/** More workers, for a big index's scan to run side by side (scanIndexFiles); let go when idle (HELPERS_IDLE_MS). */
let helpers: Worker[] = [];
let helpersIdle: ReturnType<typeof setTimeout> | undefined;
const HELPERS_IDLE_MS = 30_000;
/** Index entries for each worker a scan runs on, at least, and at most this many workers. */
let entriesPerWorker = 25_000;
const MAX_WORKERS = 4;
const waiting = new Map<number, (r: StatReply) => void>();
/** Each folder's tracked list the worker was last sent, by id (it can let one go: it then says so, and is sent it again). */
const sent = new Map<string, string>();
let asked = 0;

/** A stat worker; `gone` when it stops (whatever it was asked is answered here instead). */
function spawn(gone: (w: Worker) => void): Worker | undefined {
    try {
        // Built into one binary (bun build --compile, with the worker as an entry point of its own), this module's url
        // is the binary's, at the root of src/; run from source, it's this file's.
        const bundled = !import.meta.path.endsWith("stat-files.ts");
        const w = new Worker(new URL(bundled ? "./agent/stat-worker.ts" : "./stat-worker.ts", import.meta.url).href);
        // It never keeps the process alive by itself.
        w.unref();
        w.onmessage = (e: MessageEvent<StatReply>) => {
            waiting.get(e.data.id)?.(e.data);
            waiting.delete(e.data.id);
        };
        w.onerror = (e) => {
            gone(w);
            clearTimeout(idleTimers.get(w));
            idleTimers.delete(w);
            asking.delete(w);
            w.terminate();
            for (const [id, answer] of waiting) answer({ id, error: e.message || "The stat worker stopped." });
            waiting.clear();
        };
        return w;
    } catch {
        return undefined;
    }
}

function started(): Worker | undefined {
    if (worker !== undefined || process.env.CAVVY_STAT_WORKER === "0") return worker ?? undefined;
    worker = spawn(() => { worker = null; }) ?? null;
    return worker ?? undefined;
}

/**
 * A worker of its own for looking a few paths up (scanIndexPaths, ~1 ms by offset): never behind another session's
 * whole scan of a big repository (seconds) on the worker those run on.
 */
let lookups: Worker | null | undefined;
function lookupWorker(): Worker | undefined {
    if (lookups !== undefined || process.env.CAVVY_STAT_WORKER === "0") return lookups ?? undefined;
    lookups = spawn(() => { lookups = null; }) ?? null;
    return lookups ?? undefined;
}

/** `w` was asked something (+1) or answered (-1): the worker or the lookups one, asked nothing for idleMs, is let go of. */
function asks(w: Worker, by: 1 | -1) {
    const n = (asking.get(w) ?? 0) + by;
    clearTimeout(idleTimers.get(w));
    idleTimers.delete(w);
    if (n > 0) return void asking.set(w, n);
    asking.delete(w);
    if (w !== worker && w !== lookups) return;
    const timer = setTimeout(() => {
        idleTimers.delete(w);
        if (asking.has(w)) return;
        if (w === worker) {
            worker = undefined;
            sent.clear();
        } else if (w === lookups) lookups = undefined;
        else return;
        w.terminate();
    }, idleMs);
    timer.unref?.();
    idleTimers.set(w, timer);
}

/** For tests: how long a worker is kept idle, a scan's entries for each worker, and which workers are running now. */
export function statWorkersForTests(set: { idleMs?: number; entriesPerWorker?: number } = {}): { stat: boolean; lookups: boolean } {
    idleMs = set.idleMs ?? idleMs;
    entriesPerWorker = set.entriesPerWorker ?? entriesPerWorker;
    return { stat: !!worker, lookups: !!lookups };
}

/** Up to `n` workers to run side by side (the first is the one every capture uses), as many as could be started. */
function pool(n: number): Worker[] {
    const first = started();
    if (!first) return [];
    while (helpers.length < n - 1) {
        const w = spawn((gone) => { helpers = helpers.filter((h) => h !== gone); });
        if (!w) break;
        helpers.push(w);
    }
    if (helpersIdle) clearTimeout(helpersIdle);
    helpersIdle = setTimeout(() => {
        for (const h of helpers) h.terminate();
        helpers = [];
        helpersIdle = undefined;
    }, HELPERS_IDLE_MS);
    helpersIdle.unref?.();
    return [first, ...helpers.slice(0, n - 1)];
}

function ask(w: Worker, req: Omit<StatRequest, "id"> | Omit<IndexRequest, "id"> | Omit<PathsRequest, "id">, deadline: number): Promise<StatReply> {
    const id = ++asked;
    asks(w, 1);
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            waiting.delete(id);
            asks(w, -1);
            resolve({ id, error: "late" });
        }, Math.max(0, deadline - Date.now()));
        waiting.set(id, (r) => {
            clearTimeout(timer);
            asks(w, -1);
            resolve(r);
        });
        w.postMessage({ ...req, id, deadline });
    });
}

/** Every path's kind and stamp, tracked then untracked. Throws `late` when the deadline passes first. */
export async function statFiles(root: string, trackedId: string, tracked: string[], untracked: string[], deadline: number, inTime: () => void): Promise<FileStats> {
    const w = started();
    if (w) {
        let r = await ask(w, { root, trackedId, tracked: tracked.length && sent.get(root) === trackedId ? undefined : tracked, untracked }, deadline);
        if (r.missing) r = await ask(w, { root, trackedId, tracked, untracked }, deadline);
        if (r.kinds && r.stamps) {
            if (tracked.length) {
                sent.delete(root);
                sent.set(root, trackedId);
                if (sent.size > 64) sent.delete(sent.keys().next().value!);
            }
            return { kinds: r.kinds, stamps: r.stamps };
        }
        if (r.error === "late") throw new Error("Snapshot exceeded its time budget (2 seconds by default).");
    }
    return statHere(root, tracked, untracked, inTime);
}

/** Entries Git's index file says it has (0 when it can't be read, or isn't a file: a pipe would never answer). */
async function entriesIn(indexFile: string): Promise<number> {
    try {
        const f = await open(indexFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            if (!(await f.stat()).isFile()) return 0;
            const head = Buffer.alloc(12);
            const { bytesRead } = await f.read(head, 0, 12, 0);
            return bytesRead === 12 ? head.readUInt32BE(8) : 0;
        } finally {
            await f.close();
        }
    } catch {
        return 0;
    }
}

/**
 * Git's index file read into memory the workers share (laid out as SharedIndexBytes says), and its time as it was
 * read; undefined when it can't be read, or isn't a file.
 */
async function readShared(indexFile: string): Promise<SharedIndexBytes | undefined> {
    try {
        const f = await open(indexFile, INDEX_OPEN);
        try {
            const st = await f.stat();
            // Its entries' offsets are kept in 32 bits (index-scan.ts).
            if (!st.isFile() || st.size >= 2 ** 32 - SHARED_AT) return undefined;
            const sab = new SharedArrayBuffer(SHARED_AT + st.size);
            const into = Buffer.from(sab, SHARED_AT, st.size);
            let length = 0;
            while (length < st.size) {
                const { bytesRead } = await f.read(into, length, st.size - length, length);
                if (!bytesRead) break;
                length += bytesRead;
            }
            return { sab, length, mtimeMs: st.mtimeMs };
        } finally {
            await f.close();
        }
    } catch {
        return undefined;
    }
}

/**
 * `root`'s differences from its Git index (index-scan.ts), on the worker, or for a big index on several side by side
 * while the machine has cores to spare, each taking a run of its entries (stat calls are most of it, and the system
 * takes them in parallel); here, all at once, where there's none.
 */
export async function scanIndexFiles(root: string, indexFile: string, hashBytes: number, untracked: string[], msExact: boolean, deadline: number): Promise<IndexScan> {
    // Side by side only with cores to spare: run so, stat calls cost a little more each, which a busy machine pays for.
    const spare = Math.floor(navigator.hardwareConcurrency - (loadavg()[0] ?? 0));
    const want = Math.min(MAX_WORKERS, Math.max(1, spare), Math.ceil((await entriesIn(indexFile)) / entriesPerWorker));
    const ws = want > 1 ? pool(want) : [started()].filter((w): w is Worker => !!w);
    if (ws.length) {
        const n = ws.length;
        // Several: the index read once, here, for all of them (a million-file one is over 100 MB), not by each.
        const shared = n > 1 ? await readShared(indexFile) : undefined;
        const replies = await Promise.all(ws.map((w, k) => ask(w, { root, indexFile, hashBytes, untracked: k === n - 1 ? untracked : [], msExact, part: { k, n }, ...(shared ? { shared } : {}) }, deadline)));
        if (replies.some((r) => r.error === "late")) throw new Error("Snapshot exceeded its time budget (2 seconds by default).");
        if (replies.every((r) => r.scan)) {
            const scans = replies.map((r) => r.scan!);
            const unusable = scans.find((sc) => sc.unusable)?.unusable;
            return { ...(unusable ? { unusable } : {}), differs: scans.flatMap((sc) => sc.differs), gone: scans.flatMap((sc) => sc.gone), attributes: scans.flatMap((sc) => sc.attributes), contentKey: scans[0]!.contentKey, cacheTree: scans[0]!.cacheTree };
        }
    }
    return scanIndex(root, indexFile, hashBytes, untracked, msExact);
}

/** Only `paths` against the index (scanPaths), on the worker; here where there's none. */
export async function scanIndexPaths(root: string, indexFile: string, hashBytes: number, paths: string[], msExact: boolean, deadline: number): Promise<ReturnType<typeof scanPaths>> {
    const w = lookupWorker();
    if (w) {
        const r = await ask(w, { root, indexFile, hashBytes, paths, msExact }, deadline);
        if (r.paths) return r.paths;
        if (r.error === "late") throw new Error("Snapshot exceeded its time budget (2 seconds by default).");
    }
    return scanPaths(root, indexFile, hashBytes, paths, msExact);
}

const gone = (e: unknown) => ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException)?.code ?? "");

/** As the worker does, on this thread, giving the event loop its turn every few milliseconds. */
export async function statHere(root: string, tracked: string[], untracked: string[], inTime: () => void): Promise<FileStats> {
    const n = tracked.length + untracked.length;
    const kinds = new Uint8Array(n);
    const stamps = new Float64Array(n * 6);
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
    const pace = new Pace();
    for (let i = 0; i < n; i++) {
        if ((i & 255) === 255) {
            inTime();
            if (pace.due) await pace.rest();
        }
        const path = i < tracked.length ? tracked[i]! : untracked[i - tracked.length]!;
        let st: Stats | undefined;
        try {
            st = inside(path) ? lstatSync(`${root}/${path}`, { throwIfNoEntry: false }) : undefined;
        } catch (e) {
            kinds[i] = gone(e) ? KIND.missing : KIND.unreadable;
            continue;
        }
        if (!st) { kinds[i] = KIND.missing; continue; }
        kinds[i] = st.isFile() ? KIND.file : st.isSymbolicLink() ? KIND.link : st.isDirectory() ? KIND.dir : KIND.other;
        const o = i * 6;
        stamps[o] = st.dev;
        stamps[o + 1] = st.ino;
        stamps[o + 2] = st.mode;
        stamps[o + 3] = st.size;
        stamps[o + 4] = st.mtimeMs;
        stamps[o + 5] = st.ctimeMs;
    }
    return { kinds, stamps };
}
