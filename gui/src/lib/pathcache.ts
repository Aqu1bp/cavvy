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
// - A request that fails (the connection dropped, the session closed) answers
//   nothing: its paths wait, unlinked, until the connection comes back
//   (retryFailed), rather than being asked again on the next render.
// - A view rebuilt from a fresh snapshot (reconnect, reopen) may have missed
//   the ops that created files, so its missing answers are dropped (sawSnapshot).
// Answers depend on the chosen editor (what it would open as a project isn't
// linked), so another one, from wherever it's set, drops them all (editorIs).
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
    private failed = new Map<string, Set<string>>();
    /** Bumped by forget(): answers to requests made before it aren't kept. */
    private generation = 0;
    /** The chosen editor as last seen; unset until the settings are first read. */
    private editor?: { id: string | undefined };
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

    private set(map: Map<string, Set<string>>, sessionId: string): Set<string> {
        let s = map.get(sessionId);
        if (!s) map.set(sessionId, (s = new Set()));
        return s;
    }

    async resolve(sessionId: string, paths: Iterable<string>): Promise<void> {
        const m = this.map(sessionId);
        const busy = this.set(this.asking, sessionId);
        const failed = this.set(this.failed, sessionId);
        const todo = [...new Set(paths)].filter((p) => !m.has(p) && !busy.has(p) && !failed.has(p));
        if (!todo.length) return;
        for (const p of todo) busy.add(p);
        const gen = this.generation;
        const batches: string[][] = [];
        for (let i = 0; i < todo.length; i += this.batch) batches.push(todo.slice(i, i + this.batch));
        let answered = false;
        await Promise.all(
            batches.map(async (batch) => {
                let found: (string | null)[] | undefined;
                try {
                    found = await this.o.ask(sessionId, batch);
                } catch {
                    // Not an answer: wait for the connection to come back (retryFailed).
                }
                for (const p of batch) busy.delete(p);
                // Asked before forget(): under the old editor, so the replies ask again.
                if (gen !== this.generation) return void (answered = true);
                if (!found) return void batch.forEach((p) => this.set(this.failed, sessionId).add(p));
                const live = this.map(sessionId);
                batch.forEach((p, i) => live.set(p, found[i] ?? null));
                answered = true;
            }),
        );
        if (!answered) return;
        this.evict(sessionId);
        this.changed();
    }

    /** The connection came back: paths whose requests failed are asked again by the replies showing them. */
    retryFailed() {
        const any = [...this.failed.values()].some((s) => s.size > 0);
        this.failed.clear();
        if (any) this.changed();
    }

    /** A session's view was rebuilt from a snapshot: ops that created files may have been missed. */
    sawSnapshot(sessionId: string) {
        this.forgetMissing(sessionId);
    }

    /**
     * The chosen editor, each time the settings say: the first value is where
     * it starts, the same one again changes nothing, and another drops every answer.
     */
    editorIs(id: string | undefined) {
        const changed = this.editor !== undefined && this.editor.id !== id;
        this.editor = { id };
        if (changed) this.forget();
    }

    /** Every answer may differ (another editor): all are dropped and replies on screen ask again. */
    forget() {
        this.generation++;
        this.known.clear();
        this.failed.clear();
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
