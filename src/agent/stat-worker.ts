// A worker thread that stats a repository's files for turn snapshots (stat-files.ts), so the server's own thread,
// which every session and the GUI's socket share, isn't spent on a hundred thousand syscalls a capture.
//
// It's sent a root and the lists of paths to look at (the tracked ones once per version of Git's index, kept here
// by id), and answers with each path's kind and stamp, in arrays handed over rather than copied.

import { lstatSync, type Stats } from "fs";
import { KIND, type StatRequest, type StatReply, type IndexRequest, type PathsRequest } from "./stat-files";
import { scanIndex, scanPaths } from "./index-scan";

declare const self: Worker;

/** Tracked lists by id, the latest few: a session's capture sends its list once per version of the index. */
const lists = new Map<string, string[]>();

const gone = (e: unknown) => ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException)?.code ?? "");

function stat(req: StatRequest): StatReply {
    if (req.tracked) {
        lists.delete(req.trackedId);
        lists.set(req.trackedId, req.tracked);
        while (lists.size > 16) lists.delete(lists.keys().next().value!);
    }
    const tracked = lists.get(req.trackedId);
    if (!tracked) return { id: req.id, missing: true };
    const n = tracked.length + req.untracked.length;
    const kinds = new Uint8Array(n);
    const stamps = new Float64Array(n * 6);
    // Every folder on the way a real folder, not a link that could lead out of the repository.
    const folders = new Map<string, boolean>();
    const inside = (rel: string): boolean => {
        const i = rel.lastIndexOf("/");
        if (i < 0) return true;
        const dir = rel.slice(0, i);
        let ok = folders.get(dir);
        if (ok === undefined) {
            let st: Stats | undefined;
            try { st = lstatSync(`${req.root}/${dir}`, { throwIfNoEntry: false }); } catch (e) { if (!gone(e)) throw e; }
            ok = !!st?.isDirectory() && inside(dir);
            folders.set(dir, ok);
        }
        return ok;
    };
    for (let i = 0; i < n; i++) {
        const path = i < tracked.length ? tracked[i]! : req.untracked[i - tracked.length]!;
        let st: Stats | undefined;
        try {
            st = inside(path) ? lstatSync(`${req.root}/${path}`, { throwIfNoEntry: false }) : undefined;
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
    return { id: req.id, kinds, stamps };
}

self.onmessage = (e: MessageEvent<StatRequest | IndexRequest | PathsRequest>) => {
    let reply: StatReply;
    try {
        const r = e.data;
        reply = "paths" in r ? { id: r.id, paths: scanPaths(r.root, r.indexFile, r.hashBytes, r.paths, r.msExact) }
            : "indexFile" in r ? { id: r.id, scan: scanIndex(r.root, r.indexFile, r.hashBytes, r.untracked, r.msExact, r.part) } : stat(r);
    } catch (err) {
        reply = { id: e.data.id, error: String((err as Error)?.message ?? err) };
    }
    // Handed over, not copied.
    self.postMessage(reply, { transfer: reply.kinds && reply.stamps ? [reply.kinds.buffer as ArrayBuffer, reply.stamps.buffer as ArrayBuffer] : [] });
};
