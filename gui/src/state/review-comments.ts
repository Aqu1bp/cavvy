// Each session's review comments, waiting in its composer until they're sent.
// Kept in this browser's storage so they survive a reload, like the draft text:
// no longer than 30 days, and never one whose text looks like a secret (that
// one stays in this tab only).

import { createRoot, createSignal } from "solid-js";
import { matchesSecretPattern } from "../../../src/util/secret-patterns";
import { AROUND, type ReviewComment } from "../lib/review-comments";

export const REVIEW_COMMENTS_KEY = "harness.reviewComments.v1";
export const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
/** Per session; the oldest go first past it. */
export const MAX_PER_SESSION = 200;
const MAX_SESSIONS = 100;
const MAX_CHARS = 1_000_000;
const EMPTY: readonly ReviewComment[] = Object.freeze([]);
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

const secrets = new WeakMap<ReviewComment, boolean>();
/** Checked once per comment (each edit is a new object), not on every write. */
const secret = (c: ReviewComment) => {
    let v = secrets.get(c);
    if (v === undefined) {
        const all = [c.text, c.snippet, ...(c.before ?? []), ...(c.after ?? [])].join("\n");
        secrets.set(c, (v = /\bsk-[A-Za-z0-9_-]{20,}/.test(all) || matchesSecretPattern(all)));
    }
    return v;
};
const ref = (r: unknown) => !!r && typeof r === "object" && ((r as { side?: unknown }).side === "old" || (r as { side?: unknown }).side === "new") && Number.isInteger((r as { line?: unknown }).line);
const valid = (c: unknown): c is ReviewComment => {
    const x = c as Partial<ReviewComment> | null;
    const lines = (l: unknown) => l === undefined || (Array.isArray(l) && l.length <= AROUND && l.every((s) => typeof s === "string"));
    return !!x && typeof x.id === "string" && typeof x.path === "string" && typeof x.text === "string" && typeof x.snippet === "string" && Number.isFinite(x.created) && ref(x.start) && ref(x.end) && lines(x.before) && lines(x.after);
};

export function createReviewCommentStore(storage: () => Storage | undefined, now = Date.now) {
    return createRoot(() => {
        const [all, setAll] = createSignal<ReadonlyMap<string, readonly ReviewComment[]>>(new Map());
        let timer: ReturnType<typeof setTimeout> | undefined;

        /**
         * What this window changed and hasn't written, per session and per comment: added or edited
         * ones by id, and the ids it deleted. Applied over what's in storage, so another window's
         * comments for the same session stand.
         */
        const pending = new Map<string, { put: Map<string, ReviewComment>; gone: Set<string> }>();
        const ops = (id: string) => {
            let p = pending.get(id);
            if (!p) pending.set(id, (p = { put: new Map(), gone: new Set() }));
            return p;
        };
        function apply(id: string, list: readonly ReviewComment[]): readonly ReviewComment[] {
            const p = pending.get(id);
            if (!p) return list;
            const out = list.filter((c) => !p.gone.has(c.id)).map((c) => p.put.get(c.id) ?? c);
            for (const c of p.put.values()) if (!list.some((t) => t.id === c.id)) out.push(c);
            return out.slice(-MAX_PER_SESSION);
        }

        function read(target: Storage | undefined): Map<string, readonly ReviewComment[]> {
            const out = new Map<string, readonly ReviewComment[]>();
            try {
                const raw = target?.getItem(REVIEW_COMMENTS_KEY);
                const saved: unknown = raw && raw.length <= MAX_CHARS ? JSON.parse(raw) : undefined;
                if (saved && typeof saved === "object") for (const [id, list] of Object.entries(saved as Record<string, unknown>)) {
                    if (!Array.isArray(list)) continue;
                    const kept = list.filter((c): c is ReviewComment => valid(c) && now() - c.created < MAX_AGE && !secret(c));
                    if (kept.length) out.set(id, kept.slice(-MAX_PER_SESSION));
                }
            } catch { /* Unreadable storage counts as empty. */ }
            return out;
        }
        /** What this window shows: storage's comments, its unwritten changes, and its tab-only (secret-looking) ones. */
        function view(remote: Map<string, readonly ReviewComment[]>) {
            const local = all();
            const out = new Map<string, readonly ReviewComment[]>();
            for (const id of new Set([...local.keys(), ...remote.keys(), ...pending.keys()])) {
                const list = apply(id, remote.get(id) ?? EMPTY);
                const mine = local.get(id) ?? EMPTY;
                const hidden = mine.filter((c) => secret(c) && !pending.get(id)?.gone.has(c.id) && !list.some((t) => t.id === c.id));
                const at = (c: ReviewComment) => mine.findIndex((m) => m.id === c.id);
                const both = hidden.length ? [...list, ...hidden].sort((a, b) => a.created - b.created || at(a) - at(b)) : list;
                if (both.length) out.set(id, both);
            }
            return out;
        }
        function load() {
            let remote: Map<string, readonly ReviewComment[]>;
            try {
                remote = read(storage());
            } catch {
                return;
            }
            setAll(view(remote));
        }
        function flush() {
            clearTimeout(timer);
            timer = undefined;
            if (!pending.size) return;
            try {
                const target = storage();
                if (!target) return;
                // Only the comments changed here: another window's, in these sessions or others, stand.
                const merged = read(target);
                for (const id of pending.keys()) {
                    const list = apply(id, merged.get(id) ?? EMPTY).filter((c) => !secret(c) && now() - c.created < MAX_AGE);
                    if (list.length) merged.set(id, list);
                    else merged.delete(id);
                }
                const entries = [...merged].sort((a, b) => a[1].at(-1)!.created - b[1].at(-1)!.created).slice(-MAX_SESSIONS);
                // Drop whole sessions, oldest first, rather than cut a comment.
                const sizes = entries.map(([id, list]) => JSON.stringify(id).length + JSON.stringify(list).length + 2);
                let total = sizes.reduce((a, b) => a + b, 2);
                while (total > MAX_CHARS && entries.length) {
                    entries.shift();
                    total -= sizes.shift()!;
                }
                if (entries.length) target.setItem(REVIEW_COMMENTS_KEY, JSON.stringify(Object.fromEntries(entries)));
                else target.removeItem(REVIEW_COMMENTS_KEY);
                pending.clear();
                // Another window's comments this one hadn't heard of yet show here too.
                setAll(view(new Map(entries)));
            } catch { /* Quota or private mode: they stay in this tab, and are tried again on the next change. */ }
        }
        const changed = () => {
            clearTimeout(timer);
            timer = setTimeout(flush, 250);
        };
        const put = (id: string, comments: readonly ReviewComment[]) => {
            const p = ops(id);
            for (const c of comments) {
                p.gone.delete(c.id);
                p.put.set(c.id, c);
            }
            const ids = new Set(comments.map((c) => c.id));
            setAll((old) => new Map(old).set(id, [...(old.get(id) ?? EMPTY).filter((c) => !ids.has(c.id)), ...comments].slice(-MAX_PER_SESSION)));
            changed();
        };
        load();

        const api = {
            list: (id: string | undefined): readonly ReviewComment[] => (id ? (all().get(id) ?? EMPTY) : EMPTY),
            add(id: string, c: ReviewComment) {
                put(id, [c]);
            },
            /** Puts back comments from a message returned to the box, after any still waiting. */
            restore(id: string, comments: readonly ReviewComment[]) {
                if (comments.length) put(id, comments);
            },
            edit(id: string, commentId: string, text: string) {
                const t = text.trim();
                const c = all().get(id)?.find((c) => c.id === commentId);
                if (!t || !c) return;
                const next = { ...c, text: t };
                const p = ops(id);
                p.put.set(c.id, next);
                setAll((old) => new Map(old).set(id, (old.get(id) ?? EMPTY).map((x) => (x.id === c.id ? next : x))));
                changed();
            },
            remove(id: string, commentIds: readonly string[]) {
                const gone = new Set(commentIds);
                const p = ops(id);
                for (const g of gone) {
                    p.put.delete(g);
                    p.gone.add(g);
                }
                setAll((old) => {
                    const next = new Map(old);
                    const list = (old.get(id) ?? EMPTY).filter((c) => !gone.has(c.id));
                    if (list.length) next.set(id, list);
                    else next.delete(id);
                    return next;
                });
                changed();
            },
            /** Takes out comments that went with a message, unless they've changed since: an edit made meanwhile wasn't sent. */
            removeSent(id: string, sent: readonly ReviewComment[]) {
                const current = new Map((all().get(id) ?? EMPTY).map((c) => [c.id, c]));
                const same = sent.filter((c) => {
                    const now = current.get(c.id);
                    return now && now.text === c.text && now.snippet === c.snippet && now.path === c.path;
                });
                if (same.length) api.remove(id, same.map((c) => c.id));
            },
            load,
            /** Another window wrote: take its version, keeping this one's changes still to be written. */
            refresh: load,
            flush,
        };
        return api;
    });
}

export const reviewComments = createReviewCommentStore(() => (typeof window === "undefined" ? undefined : window.localStorage));
if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", reviewComments.flush);
    window.addEventListener("pagehide", reviewComments.flush);
    // Another window's comments for the same sessions.
    window.addEventListener("storage", (e) => {
        if (e.key === REVIEW_COMMENTS_KEY || e.key === null) reviewComments.refresh();
    });
}

let n = 0;
export const newCommentId = () => `rc-${Date.now().toString(36)}-${(n++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
