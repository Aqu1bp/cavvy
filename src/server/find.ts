// Find in a conversation, for the turns a window hasn't been sent: a long session's window has its last turns, and
// Find loaded all the rest into it to count them (98 MB of a 100,000-item session). Here they're counted where they
// are, by the window's own code (gui/src/lib/find-text.ts: the text each part shows, as the page shows it), so the
// count is the one the window would make, and only the matches go to it.

import { foldedParts, matchesIn, MAX_MATCHES, setEntityDecoder } from "../../gui/src/lib/find-text";
import { decodeHTML } from "../../gui/src/lib/entity-decoder";
import type { SessionFindMatch, Turn } from "./protocol";

export { MAX_MATCHES };

// No page here to read character references: the table a page reads them by.
setEntityDecoder(decodeHTML);

/**
 * Each turn's parts as Find searches them, kept with what they were worked out from: a long session has thousands of
 * replies, each rendered to be searched, and that's done again only for a turn that's changed since. (A session's own:
 * it lets go of them once Find isn't used for a while, 30 MB for 100,000 items.)
 */
export type FindCache = WeakMap<Turn, { stamp: string; parts: { part: string; folded: string }[] }>;
const searched: FindCache = new WeakMap();

/** What a turn's parts depend on, cheaply: a turn that changed (a block added, text streamed in, a status) differs. */
function stampOf(t: Turn): string {
    let s = `${t.status}:${t.prompt?.text.length ?? -1}:${t.blocks.length}`;
    for (const b of t.blocks) {
        const r = b as { text?: string; status?: string; summary?: string; output?: string; title?: string; command?: string };
        s += `|${b.id}:${r.status ?? ""}:${r.text?.length ?? 0}:${r.summary?.length ?? 0}:${r.output?.length ?? 0}:${r.title?.length ?? 0}:${r.command?.length ?? 0}`;
        // A notice can read by the time ("resets in 2h": lib/notices.ts noticeReads): worked out again each minute.
        if (b.t === "notice") s += `@${Math.floor(Date.now() / 60_000)}`;
    }
    return s;
}

function partsOf(t: Turn, whole: (t: Turn) => Turn = (x) => x, stamped?: (t: Turn) => string | undefined, cache = searched) {
    const stamp = stamped?.(t) ?? stampOf(t);
    const had = cache.get(t);
    if (had?.stamp === stamp) return had.parts;
    const parts = foldedParts(whole(t));
    cache.set(t, { stamp, parts });
    return parts;
}

/** How long Find works before it lets the server get on with the rest (other sessions streaming, the windows' calls). */
const SLICE_MS = 8;

/**
 * Where `query` appears in `turns` before the one with id `before` (all of them without it), in order, at most
 * MAX_MATCHES. An empty query finds nothing, but works out what's searched: Find asks it as it opens, so the first
 * words typed don't wait for every reply of a long session to be rendered (0.6-1.1 s for 100,000 items; 34-64 ms after).
 *
 * A slice at a time, never holding the server longer than SLICE_MS: worked out at once, a 100,000-item session held
 * it 2.3 s (an M5), and every other session's replies with it. Undefined once `stale` says another query took its
 * place (the window counts only the latest).
 */
export async function findBefore(
    turns: readonly Turn[],
    query: string,
    o: { before?: string; also?: ReadonlySet<string>; whole?: (t: Turn) => Turn; stamped?: (t: Turn) => string | undefined; stale?: () => boolean; cache?: FindCache } = {},
): Promise<SessionFindMatch[] | undefined> {
    // `whole`: a turn kept as its head, whole (the session's store has its blocks); `stamped`: what it is, for it.
    const parts = (t: Turn) => partsOf(t, o.whole, o.stamped, o.cache);
    const end = o.before === undefined ? turns.length : turns.findIndex((t) => t.id === o.before);
    if (end < 0) return [];
    // As they are now: turns that come in meanwhile are the window's to count. And `also`, after them (those a window
    // was sent folded: it hasn't what it would count in them).
    const scope = o.also?.size ? turns.filter((t, i) => i < end || o.also!.has(t.id)) : turns.slice(0, end);
    const out: SessionFindMatch[] = [];
    let since = performance.now();
    for (const t of scope) {
        if (performance.now() - since > SLICE_MS) {
            await new Promise((r) => setImmediate(r));
            if (o.stale?.()) return undefined;
            since = performance.now();
        }
        if (!query) {
            parts(t);
            continue;
        }
        for (const m of matchesIn([t], parts, query)) {
            out.push(t.pos ? { ...m, pos: t.pos } : m);
            if (out.length >= MAX_MATCHES) return out;
        }
    }
    return out;
}
