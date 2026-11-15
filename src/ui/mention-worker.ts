// A worker thread with a part of a big project's paths, for @-mention completion (mention-shards.ts): the server's own
// thread, which every session and the windows share, neither indexes nor searches them (a keystroke scored up to
// 180 ms of a million files there). Each indexes its part of git's listing, in memory they all read, and answers with
// its best, which the server puts together (path-index.ts merged).

import { MAX_INDEXED, PathIndex } from "./path-index";

declare const self: Worker;

export type ShardRequest =
    /** Part `part` of `parts` of a listing, indexed in place of the one there was (as it was: kept). */
    | { id: number; t: "take"; listing: SharedArrayBuffer; part: number; parts: number }
    | { id: number; t: "find"; query: string; limit: number };

export type ShardReply =
    | { id: number; t: "taken" }
    | { id: number; t: "found"; top: ReturnType<PathIndex["top"]> };

const NL = 10;

let index = new PathIndex();
/** The bytes the index was made from, hashed, and where they were: the same again, it's kept. */
let madeFrom: { from: number; to: number; hash: number | bigint } | undefined;

/** Where part `part` of `parts` of `bytes` starts: at a line's start, the first at or after its share. */
function partStart(bytes: Uint8Array, part: number, parts: number): number {
    if (part <= 0) return 0;
    if (part >= parts) return bytes.length;
    const at = Math.floor((bytes.length * part) / parts);
    if (at === 0 || bytes[at - 1] === NL) return at;
    const nl = bytes.indexOf(NL, at);
    return nl < 0 ? bytes.length : nl + 1;
}

async function take(r: Extract<ShardRequest, { t: "take" }>): Promise<ShardReply> {
    const bytes = new Uint8Array(r.listing);
    const from = partStart(bytes, r.part, r.parts);
    const to = partStart(bytes, r.part + 1, r.parts);
    // Copied out of the shared memory (read once, then let go of with the listing).
    const own = bytes.slice(from, to);
    const hash = Bun.hash(own);
    if (madeFrom && madeFrom.from === from && madeFrom.to === to && madeFrom.hash === hash) return { id: r.id, t: "taken" };
    // How many files come before it: its paths' places among all of them (PathIndex.take's `first`).
    let first = 0;
    for (let i = bytes.indexOf(NL); i >= 0 && i < from; i = bytes.indexOf(NL, i + 1)) first++;
    const files = new TextDecoder().decode(own).split("\n").filter(Boolean);
    const kept = Math.max(0, Math.min(files.length, MAX_INDEXED - first));
    const next = new PathIndex();
    // A slice at a time: what's asked meanwhile is answered from the index there was.
    await next.take(kept < files.length ? files.slice(0, kept) : files, { first, slice: () => new Promise((r) => setImmediate(r)) });
    index = next;
    madeFrom = { from, to, hash };
    return { id: r.id, t: "taken" };
}

self.onmessage = async (e: MessageEvent<ShardRequest>) => {
    const r = e.data;
    const reply = r.t === "take" ? await take(r) : { id: r.id, t: "found" as const, top: index.top(r.query, r.limit) };
    self.postMessage(reply);
};
