// A worker thread that stats a repository's files for turn snapshots (stat-files.ts), so the server's own thread,
// which every session and the GUI's socket share, isn't spent on a hundred thousand syscalls a capture.
//
// It's sent a root and the lists of paths to look at (the tracked ones once per version of Git's index, kept here
// by id), and answers with each path's kind and stamp, in arrays handed over rather than copied.

import { lstatSync, readdirSync, unlinkSync, watch, writeFileSync, type FSWatcher, type Stats } from "fs";
import { join, relative } from "path";
import { KIND, type StatRequest, type StatReply, type IndexRequest, type PathsRequest } from "./stat-files";
import { LATE, scanIndex, scanPaths } from "./index-scan";

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

/**
 * Folder watches (folder-watch.ts), on a worker of their own: starting a recursive one walks every folder (seconds in
 * a big repository, on Linux), which the server's thread would otherwise spend. What each sees is sent in batches,
 * and everything seen before a `sync` is sent before its answer.
 */
type WatchRequest = { watch: "open"; wid: number; root: string; gitDir?: string } | { watch: "close"; wid: number } | { watch: "sync"; wid: number; seq: number; waitMs: number };
/**
 * A sync's marker: a file put in the folder's own Git dir, seen by its watch like any change, and after everything
 * changed before it (a watch's events come in order). Its event is the sync's answer, rather than a wait that may be
 * too short for a busy Mac's FSEvents. Gone again at once.
 */
const MARK = "cavvy-watch-sync-";
/** A marker's event not come by then: the watch isn't relied on (what it saw may be incomplete). */
const MARK_LIMIT_MS = 2000;
/**
 * On a Mac a watch's stream comes alive a moment after it's made, and what changes before then is never told: not
 * late, gone (measured on Bun 1.4.4: a write just after the watch is made is never reported in about one start in ten,
 * though the watch reports what comes after). A watch is ready once a marker's event shows it's live, or, with nowhere
 * to put one, this long after it's made.
 */
const LIVE_WAIT_MS = 250;
/** A marker written before the stream was live may never be told either: another this often until one is. */
const LIVE_RETRY_MS = 50;
type Watch = { watchers: FSWatcher[]; seen: (string | null)[]; markDir?: string; marks: Map<string, () => void> };
const watches = new Map<number, Watch>();
let flushing: ReturnType<typeof setTimeout> | undefined;

function flushSeen(only?: number) {
    for (const [wid, w] of watches) {
        if ((only !== undefined && wid !== only) || !w.seen.length) continue;
        self.postMessage({ wid, seen: w.seen });
        w.seen = [];
    }
}

function onWatch(r: WatchRequest) {
    if (r.watch === "close") {
        for (const x of watches.get(r.wid)?.watchers ?? []) try { x.close(); } catch {}
        watches.delete(r.wid);
        return;
    }
    if (r.watch === "sync") {
        const w = watches.get(r.wid);
        const answer = (late = false) => {
            flushSeen(r.wid);
            self.postMessage({ wid: r.wid, synced: r.seq, ...(late ? { late: true } : {}) });
        };
        // No Git dir of its own to mark in (a linked worktree, a plain folder): as long as the server's thread would
        // have waited for events to arrive, and what's arrived by then goes first.
        if (!w?.markDir) return void setTimeout(answer, r.waitMs);
        const name = `${MARK}${process.pid}-${r.wid}-${r.seq}`;
        const limit = setTimeout(() => {
            if (w.marks.delete(name)) answer(true);
            try { unlinkSync(join(w.markDir!, name)); } catch {}
        }, MARK_LIMIT_MS);
        w.marks.set(name, () => {
            clearTimeout(limit);
            try { unlinkSync(join(w.markDir!, name)); } catch {}
            answer();
        });
        try {
            writeFileSync(join(w.markDir, name), "");
        } catch {
            clearTimeout(limit);
            w.marks.delete(name);
            setTimeout(answer, r.waitMs);
        }
        return;
    }
    const w: Watch = { watchers: [], seen: [], marks: new Map() };
    try {
        if (lstatSync(join(r.root, ".git"), { throwIfNoEntry: false })?.isDirectory()) {
            w.markDir = join(r.root, ".git");
            // One a stopped process left (it ended between writing and removing it): gone, as it would have been.
            for (const f of readdirSync(w.markDir)) {
                if (!f.startsWith(MARK)) continue;
                const st = lstatSync(join(w.markDir, f), { throwIfNoEntry: false });
                if (st && Date.now() - st.mtimeMs > MARK_LIMIT_MS) try { unlinkSync(join(w.markDir, f)); } catch {}
            }
        }
    } catch {}
    watches.set(r.wid, w);
    const saw = (file: string | null) => {
        if (!watches.has(r.wid)) return;
        const mark = file?.startsWith(`.git/${MARK}`) ? file.slice(5) : undefined;
        if (mark !== undefined) {
            // Everything before it has been seen: the sync waiting on it is answered (its removal is let pass).
            w.marks.get(mark)?.();
            w.marks.delete(mark);
            return;
        }
        w.seen.push(file);
        flushing ??= setTimeout(() => {
            flushing = undefined;
            flushSeen();
        }, 20);
    };
    const failed = () => {
        for (const x of w.watchers) try { x.close(); } catch {}
        if (watches.delete(r.wid)) self.postMessage({ wid: r.wid, failed: true });
    };
    try {
        w.watchers.push(watch(r.root, { recursive: true }, (_event, file) => saw(file ? String(file) : null)));
        // A linked worktree's Git dir is elsewhere: its index and HEAD are what change there (sent as the folder's own).
        if (r.gitDir && relative(r.root, r.gitDir).startsWith("..")) w.watchers.push(watch(r.gitDir, (_event, file) => { if (String(file) === "index" || String(file) === "HEAD") saw(".git/index"); }));
        for (const x of w.watchers) x.on("error", failed);
    } catch {
        return failed();
    }
    const ready = () => {
        if (watches.has(r.wid)) self.postMessage({ wid: r.wid, ready: true });
    };
    if (process.platform !== "darwin") return ready();
    if (!w.markDir) return void setTimeout(ready, LIVE_WAIT_MS);
    const started = Date.now(), names: string[] = [];
    let done = false;
    const finish = (then: () => void) => {
        if (done) return;
        done = true;
        for (const name of names) {
            w.marks.delete(name);
            try { unlinkSync(join(w.markDir!, name)); } catch {}
        }
        then();
    };
    const mark = () => {
        if (done || !watches.has(r.wid)) return;
        if (Date.now() - started > MARK_LIMIT_MS) return finish(failed);
        const name = `${MARK}${process.pid}-${r.wid}-live-${names.length}`;
        names.push(name);
        w.marks.set(name, () => finish(ready));
        try {
            writeFileSync(join(w.markDir!, name), "");
        } catch {
            return finish(() => setTimeout(ready, LIVE_WAIT_MS));
        }
        setTimeout(mark, LIVE_RETRY_MS);
    };
    mark();
}

self.onmessage = (e: MessageEvent<StatRequest | IndexRequest | PathsRequest | WatchRequest>) => {
    if ("watch" in e.data) return onWatch(e.data);
    let reply: StatReply;
    try {
        const r = e.data;
        // Asked of a busy worker and nothing waits for it now: not done, so what's asked after it isn't held up too.
        if (r.deadline !== undefined && Date.now() >= r.deadline) throw new Error(LATE);
        reply = "paths" in r ? { id: r.id, paths: scanPaths(r.root, r.indexFile, r.hashBytes, r.paths, r.msExact) }
            : "indexFile" in r ? { id: r.id, scan: scanIndex(r.root, r.indexFile, r.hashBytes, r.untracked, r.msExact, r.part, r.deadline) } : stat(r);
    } catch (err) {
        reply = { id: e.data.id, error: String((err as Error)?.message ?? err) };
    }
    // Handed over, not copied.
    self.postMessage(reply, { transfer: reply.kinds && reply.stamps ? [reply.kinds.buffer as ArrayBuffer, reply.stamps.buffer as ArrayBuffer] : [] });
};
