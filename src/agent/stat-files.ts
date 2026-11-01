// Turn snapshots' stat of every file (turn-snapshots.ts): on a worker thread (stat-worker.ts), so the server's own
// thread, which every session and the GUI's socket share, isn't held for it. Where there's no worker (a build that
// left it out, or CAVVY_STAT_WORKER=0), here, a few milliseconds at a time.

import { lstatSync, type Stats } from "fs";
import { Pace } from "../util/pace";

/** What's at a path. */
export const KIND = { missing: 0, file: 1, link: 2, dir: 3, other: 4, unreadable: 5 } as const;

export interface StatRequest {
    id: number;
    root: string;
    /** Names the tracked list: the same list, the same id (one per version of Git's index). */
    trackedId: string;
    /** Sent when the worker may not have it. */
    tracked?: string[];
    untracked: string[];
}

export type StatReply = { id: number; kinds?: Uint8Array; stamps?: Float64Array; missing?: boolean; error?: string };

/** For each path, tracked then untracked: its kind, and six stamp fields (device, inode, mode, size, mtime, ctime). */
export interface FileStats {
    kinds: Uint8Array;
    stamps: Float64Array;
}

/** undefined: not started yet; null: none to be had. */
let worker: Worker | null | undefined;
const waiting = new Map<number, (r: StatReply) => void>();
/** Tracked lists the worker was sent (it can let one go: it then says so, and is sent it again). */
const sent = new Set<string>();
let asked = 0;

function started(): Worker | undefined {
    if (worker !== undefined || process.env.CAVVY_STAT_WORKER === "0") return worker ?? undefined;
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
            // Gone (or never there): whatever it was asked is answered here instead, and so is the rest.
            worker = null;
            w.terminate();
            for (const [id, answer] of waiting) answer({ id, error: e.message || "The stat worker stopped." });
            waiting.clear();
        };
        worker = w;
    } catch {
        worker = null;
    }
    return worker ?? undefined;
}

function ask(w: Worker, req: Omit<StatRequest, "id">, deadline: number): Promise<StatReply> {
    const id = ++asked;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            waiting.delete(id);
            resolve({ id, error: "late" });
        }, Math.max(0, deadline - Date.now()));
        waiting.set(id, (r) => {
            clearTimeout(timer);
            resolve(r);
        });
        w.postMessage({ ...req, id });
    });
}

/** Every path's kind and stamp, tracked then untracked. Throws `late` when the deadline passes first. */
export async function statFiles(root: string, trackedId: string, tracked: string[], untracked: string[], deadline: number, inTime: () => void): Promise<FileStats> {
    const w = started();
    if (w) {
        let r = await ask(w, { root, trackedId, tracked: sent.has(trackedId) ? undefined : tracked, untracked }, deadline);
        if (r.missing) r = await ask(w, { root, trackedId, tracked, untracked }, deadline);
        if (r.kinds && r.stamps) {
            sent.add(trackedId);
            if (sent.size > 64) sent.delete(sent.values().next().value!);
            return { kinds: r.kinds, stamps: r.stamps };
        }
        if (r.error === "late") throw new Error("Snapshot exceeded its time budget (2 seconds by default).");
    }
    return statHere(root, tracked, untracked, inTime);
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
