// What's known about paths named in agent text, per session: each path's
// absolute path when it's a file in the session's folders, or null. Asked of
// the server in batches; kept for the session, so each path is asked once.
//
// Two rules keep that from turning into a loop of requests:
// - Replies on screen hold the paths they show, and only paths nothing holds
//   are evicted (oldest first), so a reply never finds its own answers gone
//   and asks again.
// - A "missing" answer is kept until something may have created files (a tool
//   call's edit landed, or a turn ended: forgetMissing), not on a timer, so a
//   path that never appears is asked about once per such event at most.
// No Solid or RPC here, so it can be tested on its own (see state/filelinks.ts).

export interface PathCacheOptions {
    /** Asks the server which paths are files: their absolute paths, or null. */
    ask(sessionId: string, paths: string[]): Promise<(string | null)[]>;
    /** Paths kept per session before unheld ones are evicted. */
    max?: number;
    /** Paths per request (the server takes at most 200). */
    batch?: number;
}

export class PathCache {
    private known = new Map<string, Map<string, string | null>>();
    private asking = new Map<string, Set<string>>();
    private held = new Map<string, Map<string, number>>();
    private listeners = new Set<() => void>();
    private max: number;
    private batch: number;

    constructor(private o: PathCacheOptions) {
        this.max = o.max ?? 5000;
        this.batch = Math.min(o.batch ?? 200, 200);
    }

    /** Called when answers arrive or are forgotten: replies that wait on paths look again. */
    onChange(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    private changed() {
        for (const fn of this.listeners) fn();
    }

    private map(sessionId: string): Map<string, string | null> {
        let m = this.known.get(sessionId);
        if (!m) this.known.set(sessionId, (m = new Map()));
        return m;
    }

    lookup(sessionId: string): (path: string) => string | null | undefined {
        return (path) => this.known.get(sessionId)?.get(path);
    }

    /** A reply on screen holds the paths it shows; call the returned function when it no longer does. */
    hold(sessionId: string, paths: Iterable<string>): () => void {
        const h = this.held.get(sessionId) ?? new Map<string, number>();
        this.held.set(sessionId, h);
        const list = [...new Set(paths)];
        for (const p of list) h.set(p, (h.get(p) ?? 0) + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            for (const p of list) {
                const n = (h.get(p) ?? 1) - 1;
                if (n > 0) h.set(p, n);
                else h.delete(p);
            }
        };
    }

    size(sessionId: string): number {
        return this.known.get(sessionId)?.size ?? 0;
    }

    async resolve(sessionId: string, paths: Iterable<string>): Promise<void> {
        const m = this.map(sessionId);
        const busy = this.asking.get(sessionId) ?? new Set<string>();
        this.asking.set(sessionId, busy);
        const todo = [...new Set(paths)].filter((p) => !m.has(p) && !busy.has(p));
        if (!todo.length) return;
        for (const p of todo) busy.add(p);
        const batches: string[][] = [];
        for (let i = 0; i < todo.length; i += this.batch) batches.push(todo.slice(i, i + this.batch));
        await Promise.all(
            batches.map(async (batch) => {
                let found: (string | null)[] = [];
                try {
                    found = await this.o.ask(sessionId, batch);
                } catch {
                    // the session closed, or the server is gone: not links, until files change
                }
                batch.forEach((p, i) => (m.set(p, found[i] ?? null), busy.delete(p)));
            }),
        );
        this.evict(sessionId);
        this.changed();
    }

    /** Files may have been created: missing answers are dropped, and replies showing those paths ask again. */
    forgetMissing(sessionId: string) {
        const m = this.known.get(sessionId);
        if (!m) return;
        let any = false;
        for (const [p, abs] of m) if (abs === null) (m.delete(p), (any = true));
        if (any) this.changed();
    }

    /** Over the limit: drop the oldest answers no reply on screen holds, down to three quarters of it. */
    private evict(sessionId: string) {
        const m = this.known.get(sessionId);
        if (!m || m.size <= this.max) return;
        const held = this.held.get(sessionId);
        const target = Math.floor(this.max * 0.75);
        for (const p of m.keys()) {
            if (m.size <= target) break;
            if (!held?.has(p)) m.delete(p);
        }
    }
}

/** Whether these ops may have created files: an edit's diff arrived, or a turn ended. */
export function mayCreateFiles(ops: { op: string; patch?: unknown }[]): boolean {
    return ops.some((o) => {
        const patch = o.patch as Record<string, unknown> | undefined;
        if (o.op === "turn.patch") return patch?.status !== undefined && patch.status !== "running";
        if (o.op === "block.patch" || o.op === "agent.block.patch") return patch?.diff !== undefined;
        return false;
    });
}
