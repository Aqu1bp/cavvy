// Whether anything in a folder has changed since a moment, without looking: a recursive watch of the folder (and of
// its Git dir, for its index), counting what changes. A turn snapshot (turn-snapshots.ts) takes the last capture again,
// starting nothing and reading nothing, when this saw no change since it and the turn wrote nothing itself. One watch
// for each folder, whoever needs it; a watch that can't be had (too many folders for the system's limit) or that fails
// says so, and every capture looks, as without one.

import { watch, type FSWatcher } from "fs";
import { relative } from "path";

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
    users = 0;

    constructor(readonly root: string, gitDir?: string) {
        try {
            this.watchers.push(watch(root, { recursive: true }, (_event, file) => this.seen(file ? String(file) : undefined)));
            // A linked worktree's Git dir is elsewhere: its index is what changes there.
            if (gitDir && relative(root, gitDir).startsWith("..")) this.watchers.push(watch(gitDir, (_event, file) => { if (String(file) === "index" || String(file) === "HEAD") this.bump(); }));
            for (const w of this.watchers) w.on("error", () => this.fail());
        } catch {
            this.fail();
        }
    }

    /** It saw everything since it began: no change can have gone unseen. */
    get healthy(): boolean {
        return !this.failed;
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
    }
}

const watches = new Map<string, FolderWatch>();

/** The watch of `root`, started for its first user; let go of with release when the last is done. */
export function acquireWatch(root: string, gitDir?: string): FolderWatch {
    let w = watches.get(root);
    if (!w || !w.healthy) {
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
