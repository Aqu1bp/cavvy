// A big project's paths for @-mention completion on worker threads (mention-worker.ts), each with a part of them,
// searched side by side: on the server's own thread a keystroke scored up to 180 ms of a million files, and held every
// session's replies with it (scripts/mention-bench.ts has what it takes on workers).

import { availableParallelism } from "os";
import type { ShardReply, ShardRequest } from "./mention-worker";
import { merged } from "./path-index";

/**
 * `from`: a listing this long (in bytes, about 50,000 files) or longer is indexed on workers; a shorter one is quick
 * where it is, and a worker costs memory of its own. `perPart`: how much of it a worker takes, at most `most` workers.
 * (Tests set them low.)
 */
export const mentionSharding = {
    from: 2 * 1024 * 1024,
    perPart: 8 * 1024 * 1024,
    // A core left for the server's own thread and one more: on 4 cores, 3 workers indexing held it 5-10 ms at a time
    // (waiting for a core: it had nothing to do), 2 didn't.
    most: Math.max(1, Math.min(4, availableParallelism() - 2)),
};

/** A request, before it's numbered. */
type Asked = ShardRequest extends infer R ? (R extends ShardRequest ? Omit<R, "id"> : never) : never;

/** How much of the listing is copied into the workers' memory at a time, so the copy never holds the server. */
const COPY_CHUNK = 1024 * 1024;

export class MentionShards {
    private workers: Worker[] = [];
    /** Workers with an index made (from the latest listing they were all given). */
    private parts = 0;
    private seq = 0;
    private waiting = new Map<number, { answer: (r: ShardReply) => void; fail: (e: Error) => void; w: Worker }>();
    /** A worker stopped: none of them is used again (the caller indexes the paths itself). */
    broken = false;

    private spawn(): Worker {
        // Built into one binary (bun build --compile, with the worker as an entry point of its own), this module's url is
        // the binary's, at the root of src/; run from source, it's this file's.
        const bundled = !import.meta.path.endsWith("mention-shards.ts");
        const w = new Worker(new URL(bundled ? "./ui/mention-worker.ts" : "./mention-worker.ts", import.meta.url).href);
        // It never keeps the process alive by itself.
        w.unref();
        w.onmessage = (e: MessageEvent<ShardReply>) => {
            this.waiting.get(e.data.id)?.answer(e.data);
            this.waiting.delete(e.data.id);
        };
        w.onerror = (e) => this.stop(new Error(e.message || "A file index worker stopped."));
        return w;
    }

    private ask<T extends ShardReply["t"]>(w: Worker, request: Asked): Promise<Extract<ShardReply, { t: T }>> {
        if (this.broken) return Promise.reject(new Error("The file index workers stopped."));
        const id = ++this.seq;
        return new Promise((answer, fail) => {
            this.waiting.set(id, { answer: answer as (r: ShardReply) => void, fail, w });
            w.postMessage({ ...request, id });
        });
    }

    /** Indexed from git's `listing` (each part kept as it was where it's the same): false when it couldn't be. */
    async take(listing: Uint8Array): Promise<boolean> {
        try {
            const parts = Math.max(1, Math.min(mentionSharding.most, Math.ceil(listing.length / mentionSharding.perPart)));
            const shared = new SharedArrayBuffer(listing.length);
            const into = new Uint8Array(shared);
            for (let at = 0; at < listing.length; at += COPY_CHUNK) {
                into.set(listing.subarray(at, at + COPY_CHUNK), at);
                if (at + COPY_CHUNK < listing.length) await new Promise((r) => setImmediate(r));
            }
            while (this.workers.length < parts) this.workers.push(this.spawn());
            // Fewer parts than before: the ones not needed go once the others have theirs (searches meanwhile have
            // every part of the listing before), and what they still owed fails rather than never coming.
            await Promise.all(this.workers.slice(0, parts).map((w, part) => this.ask<"taken">(w, { t: "take", listing: shared, part, parts })));
            this.parts = parts;
            for (const w of this.workers.splice(parts)) this.end(w);
            return true;
        } catch {
            return false;
        }
    }

    /** The paths that best match `query`, best first, as one index of them all would have them. */
    async search(query: string, limit: number): Promise<string[]> {
        if (this.broken) throw new Error("The file index workers stopped.");
        const found = await Promise.all(this.workers.slice(0, this.parts).map((w) => this.ask<"found">(w, { t: "find", query, limit })));
        return merged(found.flatMap((r) => r.top), limit);
    }

    /** One worker let go of: what it hadn't answered fails. */
    private end(w: Worker) {
        w.terminate();
        for (const [id, x] of this.waiting) {
            if (x.w !== w) continue;
            this.waiting.delete(id);
            x.fail(new Error("That part of the file index was let go of."));
        }
    }

    /** Its workers let go of. */
    stop(e = new Error("The file index was let go of.")) {
        this.broken = true;
        for (const w of this.workers) w.terminate();
        this.workers = [];
        this.parts = 0;
        for (const { fail } of this.waiting.values()) fail(e);
        this.waiting.clear();
    }
}
