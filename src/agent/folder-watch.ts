// Whether anything in a folder has changed since a moment, without looking: a recursive watch of the folder (and of
// its Git dir, for its index), counting what changes. A turn snapshot (turn-snapshots.ts) takes the last capture again,
// starting nothing and reading nothing, when this saw no change since it and the turn wrote nothing itself. One watch
// for each folder, whoever needs it; a watch that can't be had (too many folders for the system's limit) or that fails
// says so, and every capture looks, as without one.
//
// The watches are kept on a worker thread (stat-worker.ts): starting one walks every folder of the repository on Linux
// (seconds in a big one, on a busy machine), which would hold up every session on the server's thread. One isn't
// relied on until it's started (`ready`), and `settle` waits for what it saw to come over.

import { watch, type FSWatcher } from "fs";
import { relative } from "path";

type WatchReply = { wid: number; seen?: (string | null)[]; ready?: true; failed?: true; synced?: number };

/** The worker the watches are kept on; null: none to be had (they're kept on this thread then). */
let host: Worker | null | undefined;
const hosted = new Map<number, FolderWatch>();
let nextId = 0;

function watchHost(): Worker | undefined {
    if (host !== undefined || process.env.CAVVY_STAT_WORKER === "0") return host ?? undefined;
    try {
        // Built into one binary, this module's url is the binary's, at the root of src/ (as stat-files.ts finds it).
        const bundled = !import.meta.path.endsWith("folder-watch.ts");
        const w = new Worker(new URL(bundled ? "./agent/stat-worker.ts" : "./stat-worker.ts", import.meta.url).href);
        w.unref();
        w.onmessage = (e: MessageEvent<WatchReply>) => hosted.get(e.data.wid)?.fromHost(e.data);
        w.onerror = () => {
            host = null;
            w.terminate();
            for (const fw of [...hosted.values()]) fw.fromHost({ wid: -1, failed: true });
        };
        host = w;
    } catch {
        host = null;
    }
    return host ?? undefined;
}

/** Paths kept, at most, between captures: past this many, the next capture looks at everything. */
const MAX_KEPT = 20_000;

export class FolderWatch {
    /** Changes seen so far: a capture notes it, and a later one finds it moved if anything changed in between. */
    gen = 0;
    /** When the last change was seen (ms): events can arrive a moment after the change. */
    lastAt = 0;
    /** Each path that changed (relative to the folder), with the count when it last did. */
    private changes = new Map<string, number>();
    /** Changes before this count weren't kept (too many): a capture from before it looks at everything. */
    private floor = 0;
    private watchers: FSWatcher[] = [];
    private failed = false;
    private started = false;
    private listeners = new Set<() => void>();
    /** On the worker: its id there, and the settles waiting for it to answer. */
    private wid?: number;
    private syncs = new Map<number, () => void>();
    private syncSeq = 0;
    /** Settles once it's started, or has failed. */
    readonly ready: Promise<void>;
    private readied!: () => void;
    users = 0;

    /** `f` after each change it sees (it should only take note: it's called for every event); undone by what it returns. */
    onChange(f: () => void): () => void {
        this.listeners.add(f);
        return () => void this.listeners.delete(f);
    }

    constructor(readonly root: string, gitDir?: string) {
        this.ready = new Promise((r) => (this.readied = r));
        const worker = watchHost();
        if (worker) {
            this.wid = ++nextId;
            hosted.set(this.wid, this);
            worker.postMessage({ watch: "open", wid: this.wid, root, gitDir });
            return;
        }
        this.started = true;
        this.readied();
        try {
            this.watchers.push(watch(root, { recursive: true }, (_event, file) => this.seen(file ? String(file) : undefined)));
            // A linked worktree's Git dir is elsewhere: its index is what changes there.
            if (gitDir && relative(root, gitDir).startsWith("..")) this.watchers.push(watch(gitDir, (_event, file) => { if (String(file) === "index" || String(file) === "HEAD") this.bump(); }));
            for (const w of this.watchers) w.on("error", () => this.fail());
        } catch {
            this.fail();
        }
    }

    /** It's started and saw everything since: no change can have gone unseen. */
    get healthy(): boolean {
        return this.started && !this.failed;
    }

    /** It failed (or its worker went): one started again is needed. Not yet started isn't failed. */
    get broken(): boolean {
        return this.failed;
    }

    /** What the worker says. */
    fromHost(m: WatchReply) {
        if (m.seen) for (const f of m.seen) this.seen(f ?? undefined);
        if (m.ready && !this.failed) {
            // Whatever was taken before counts as before it: looked at again whole.
            this.started = true;
            this.bump();
            this.forget();
            this.readied();
        }
        if (m.failed) this.fail();
        if (m.synced !== undefined) {
            this.syncs.get(m.synced)?.();
            this.syncs.delete(m.synced);
        }
    }

    /**
     * Once what changed up to now has come in: events arrive a moment after a change (`ms`, as the system delivers
     * them), and from the worker, a moment after that.
     */
    settle(ms: number): Promise<void> {
        if (this.wid === undefined || this.failed || !host) return new Promise((r) => setTimeout(r, ms));
        const seq = ++this.syncSeq;
        return new Promise<void>((r) => {
            // A worker that doesn't answer is as good as gone: without it, nothing more is relied on.
            const timer = setTimeout(() => {
                this.syncs.delete(seq);
                this.fail();
                r();
            }, 30_000);
            timer.unref?.();
            this.syncs.set(seq, () => {
                clearTimeout(timer);
                r();
            });
            host!.postMessage({ watch: "sync", wid: this.wid, seq, waitMs: ms });
        });
    }

    private seen(file: string | undefined) {
        // Inside .git, only the index and HEAD say anything about the folder's files (objects, logs and refs don't).
        if (file && (file === ".git" || file.startsWith(".git/"))) {
            if (file === ".git/index" || file === ".git/HEAD") this.bump();
            return;
        }
        this.bump();
        // A change with no name says nothing of where: everything from here is looked at.
        if (!file) return this.forget();
        this.changes.set(file, this.gen);
        if (this.changes.size > MAX_KEPT) this.forget();
    }

    private bump() {
        this.gen++;
        this.lastAt = Date.now();
        for (const f of this.listeners) f();
    }

    private forget() {
        this.changes.clear();
        this.floor = this.gen;
    }

    /** The paths that changed after count `gen`; undefined when that can't be told (too many, or one with no name). */
    changedSince(gen: number): string[] | undefined {
        if (gen < this.floor) return undefined;
        const out: string[] = [];
        for (const [path, at] of this.changes) if (at > gen) out.push(path);
        return out;
    }

    private fail() {
        this.failed = true;
        this.close();
    }

    close() {
        for (const w of this.watchers) {
            try { w.close(); } catch {}
        }
        this.watchers = [];
        if (this.wid !== undefined && hosted.delete(this.wid)) host?.postMessage({ watch: "close", wid: this.wid });
        for (const done of this.syncs.values()) done();
        this.syncs.clear();
        this.readied();
    }
}

const watches = new Map<string, FolderWatch>();

/** The watch of `root`, started for its first user; let go of with release when the last is done. */
export function acquireWatch(root: string, gitDir?: string): FolderWatch {
    let w = watches.get(root);
    if (!w || w.broken) {
        w?.close();
        w = new FolderWatch(root, gitDir);
        watches.set(root, w);
    }
    w.users++;
    return w;
}

export function releaseWatch(w: FolderWatch) {
    if (--w.users > 0) return;
    w.close();
    if (watches.get(w.root) === w) watches.delete(w.root);
}
