// FileChanged hooks: watch the files they name and run them when one changes
// on disk, whatever changed it (a tool, a script, another program).
//
// The watch list is the FileChanged matchers split on "|" (file names in the
// project folder, as Claude Code has it), plus the paths hooks return as
// watchPaths (SessionStart, CwdChanged, FileChanged), which replace the last
// such list. The parent folders are watched, so a file that doesn't exist yet
// (or is deleted and made again, as editors save) is still seen.

import { existsSync, watch, type FSWatcher } from "fs";
import { dirname, isAbsolute, join } from "path";
import { fileMatcherNames } from "./hooks";

export type FileEvent = "change" | "add" | "unlink";

/** How long a burst of writes to one file is waited out before its hooks run. */
const SETTLE_MS = 100;

export class FileWatchHooks {
    private watchers = new Map<string, FSWatcher>();
    /** Absolute paths watched, and whether each existed when last seen. */
    private files = new Map<string, boolean>();
    private dynamic: string[] = [];
    private configured: string[] = [];
    private timers = new Map<string, ReturnType<typeof setTimeout>>();
    private closed = false;

    constructor(
        private root: string,
        private fire: (path: string, event: FileEvent) => void,
    ) {}

    /** The FileChanged matchers in settings: their names are watched in the project folder. */
    setConfigured(matchers: (string | undefined)[]) {
        // Only names and paths: a pattern (`^\\.env`) matches what's watched but names nothing to watch.
        const names = matchers.flatMap((m) => fileMatcherNames(m) ?? []);
        const next = [...new Set(names.map((n) => (isAbsolute(n) ? n : join(this.root, n))))];
        if (next.join("\0") === this.configured.join("\0")) return;
        this.configured = next;
        this.sync();
    }

    /** A hook's watchPaths: replaces the last list a hook gave. */
    setDynamic(paths: string[]) {
        this.dynamic = [...new Set(paths.filter((p) => isAbsolute(p)))];
        this.sync();
    }

    get watched(): string[] {
        return [...this.files.keys()];
    }

    private sync() {
        if (this.closed) return;
        const want = new Set([...this.configured, ...this.dynamic]);
        for (const f of [...this.files.keys()]) if (!want.has(f)) this.files.delete(f);
        for (const f of want) if (!this.files.has(f)) this.files.set(f, existsSync(f));
        const dirs = new Set([...want].map((f) => dirname(f)));
        for (const [d, w] of this.watchers) {
            if (dirs.has(d)) continue;
            w.close();
            this.watchers.delete(d);
        }
        for (const d of dirs) {
            if (this.watchers.has(d) || !existsSync(d)) continue;
            try {
                const w = watch(d, { persistent: false }, (_, name) => this.seen(d, name));
                w.on("error", () => {
                    w.close();
                    this.watchers.delete(d);
                });
                this.watchers.set(d, w);
            } catch {
                // a folder that can't be watched: its files just aren't seen
            }
        }
    }

    private seen(dir: string, name: string | Buffer | null) {
        // Without a name (some platforms), any watched file in the folder may have changed.
        const candidates = name ? [join(dir, name.toString())] : [...this.files.keys()].filter((f) => dirname(f) === dir);
        for (const f of candidates) {
            if (!this.files.has(f)) continue;
            clearTimeout(this.timers.get(f));
            this.timers.set(
                f,
                setTimeout(() => {
                    this.timers.delete(f);
                    if (this.closed || !this.files.has(f)) return;
                    const before = this.files.get(f)!;
                    const now = existsSync(f);
                    this.files.set(f, now);
                    if (!before && !now) return;
                    this.fire(f, !before ? "add" : !now ? "unlink" : "change");
                }, SETTLE_MS),
            );
        }
    }

    close() {
        this.closed = true;
        for (const w of this.watchers.values()) w.close();
        this.watchers.clear();
        for (const t of this.timers.values()) clearTimeout(t);
        this.timers.clear();
    }
}

