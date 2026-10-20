// Each session's review comments, waiting in its composer until they're sent.
// Kept in this browser's storage so they survive a reload, like the draft text:
// no longer than 30 days, and never one whose text looks like a secret (that
// one stays in this tab only).

import { createRoot, createSignal } from "solid-js";
import { matchesSecretPattern } from "../../../src/util/secret-patterns";
import type { ReviewComment } from "../lib/review-comments";

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
    if (v === undefined) secrets.set(c, (v = /\bsk-[A-Za-z0-9_-]{20,}/.test(c.text + c.snippet) || matchesSecretPattern(c.text) || matchesSecretPattern(c.snippet)));
    return v;
};
const ref = (r: unknown) => !!r && typeof r === "object" && ((r as { side?: unknown }).side === "old" || (r as { side?: unknown }).side === "new") && Number.isInteger((r as { line?: unknown }).line);
const valid = (c: unknown): c is ReviewComment => {
    const x = c as Partial<ReviewComment> | null;
    return !!x && typeof x.id === "string" && typeof x.path === "string" && typeof x.text === "string" && typeof x.snippet === "string" && Number.isFinite(x.created) && ref(x.start) && ref(x.end);
};

export function createReviewCommentStore(storage: () => Storage | undefined, now = Date.now) {
    return createRoot(() => {
        const [all, setAll] = createSignal<ReadonlyMap<string, readonly ReviewComment[]>>(new Map());
        let timer: ReturnType<typeof setTimeout> | undefined;

        /** Sessions changed here and not yet written: what this window writes, and keeps over another's. */
        const dirty = new Set<string>();

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
        /** Storage's comments, with this window's unwritten changes and its tab-only (secret-looking) comments kept. */
        function load() {
            let remote: Map<string, readonly ReviewComment[]>;
            try {
                remote = read(storage());
            } catch {
                return;
            }
            const local = all();
            for (const id of new Set([...local.keys(), ...remote.keys()])) {
                const mine = local.get(id) ?? EMPTY;
                if (dirty.has(id)) {
                    if (mine.length) remote.set(id, mine);
                    else remote.delete(id);
                    continue;
                }
                const theirs = remote.get(id) ?? EMPTY;
                const hidden = mine.filter((c) => secret(c) && !theirs.some((t) => t.id === c.id));
                if (hidden.length) remote.set(id, [...theirs, ...hidden].sort((a, b) => a.created - b.created));
            }
            setAll(remote);
        }
        function flush() {
            clearTimeout(timer);
            timer = undefined;
            if (!dirty.size) return;
            try {
                const target = storage();
                if (!target) return;
                // Only the sessions changed here: another window's writes to the rest stand.
                const merged = read(target);
                for (const id of dirty) {
                    const list = (all().get(id) ?? EMPTY).filter((c) => !secret(c) && now() - c.created < MAX_AGE);
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
                dirty.clear();
            } catch { /* Quota or private mode: they stay in this tab, and are tried again on the next change. */ }
        }
        const change = (id: string, f: (list: readonly ReviewComment[]) => readonly ReviewComment[]) => {
            setAll((old) => {
                const next = new Map(old);
                const list = f(old.get(id) ?? EMPTY);
                if (list.length) next.set(id, list);
                else next.delete(id);
                return next;
            });
            dirty.add(id);
            clearTimeout(timer);
            timer = setTimeout(flush, 250);
        };
        load();

        return {
            list: (id: string | undefined): readonly ReviewComment[] => (id ? (all().get(id) ?? EMPTY) : EMPTY),
            add(id: string, c: ReviewComment) {
                change(id, (list) => [...list, c].slice(-MAX_PER_SESSION));
            },
            /** Puts back comments from a message returned to the box, after any still waiting. */
            restore(id: string, comments: readonly ReviewComment[]) {
                if (comments.length) change(id, (list) => [...list, ...comments].slice(-MAX_PER_SESSION));
            },
            edit(id: string, commentId: string, text: string) {
                const t = text.trim();
                if (t) change(id, (list) => list.map((c) => (c.id === commentId ? { ...c, text: t } : c)));
            },
            remove(id: string, commentIds: readonly string[]) {
                const gone = new Set(commentIds);
                change(id, (list) => list.filter((c) => !gone.has(c.id)));
            },
            load,
            /** Another window wrote: take its version, keeping this one's changes still to be written. */
            refresh: load,
            flush,
        };
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
