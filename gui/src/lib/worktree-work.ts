// The diff reader's worktree picker: which Harness sessions work in each
// worktree (by their folder; the server says which sub-agents do, see
// src/server/worktree-agents.ts), and the reader's choice of worktree, with
// the views each worktree has.

import type { SessionSummary, WorktreeAgent } from "@shared/protocol";
import { normalPath, worktreeOf } from "@shared/worktree-agents";
import type { ReviewScope } from "../state/changes";

export interface WorktreeWork {
    /** Harness sessions in it: running ones first, then the latest. */
    sessions: { id: string; title: string; running: boolean }[];
    /** Sub-agents working in it now. */
    agents: WorktreeAgent[];
}

/**
 * What's working in each worktree (keyed by its path as listed): the sessions whose folder is in it
 * (not `self`, nor set-aside ones unless running), and the sub-agents the server found in it.
 */
export function worktreeWork(
    worktrees: { path: string; agents?: WorktreeAgent[] }[],
    sessions: Pick<SessionSummary, "id" | "cwd" | "title" | "status" | "settled" | "updatedAt">[],
    o: { home?: string; self?: string } = {},
): Map<string, WorktreeWork> {
    const byNormal = new Map<string, string>();
    for (const w of worktrees) {
        const n = normalPath(w.path, o.home);
        if (n && !byNormal.has(n)) byNormal.set(n, w.path);
    }
    const normals = [...byNormal.keys()];
    const out = new Map<string, WorktreeWork>(worktrees.map((w) => [w.path, { sessions: [], agents: w.agents ?? [] }]));
    const active = (s: { status: string }) => s.status === "running" || s.status === "waiting";
    const ordered = [...sessions].sort((a, b) => Number(active(b)) - Number(active(a)) || b.updatedAt - a.updatedAt);
    for (const s of ordered) {
        if (s.id === o.self || (s.settled && !active(s))) continue;
        const cwd = normalPath(s.cwd, o.home);
        const w = cwd && worktreeOf(cwd, normals);
        if (w) out.get(byNormal.get(w)!)!.sessions.push({ id: s.id, title: s.title || "New session", running: active(s) });
    }
    return out;
}

// ---------------------------------------------------------------------------
// The reader's choice

/**
 * What the diff reader shows: the session's own folder (no `worktree`) or another worktree of its
 * repository, the view and base there, and the session's own view and base, kept while away.
 */
export interface ReviewPlace {
    worktree?: string;
    scope: ReviewScope;
    base?: string;
    own?: { scope: ReviewScope; base?: string };
}

/** The views another worktree has: Git's. Turns and Harness's edits are the session's own folder's. */
export const OTHER_WORKTREE_SCOPES: ReadonlySet<ReviewScope> = new Set(["uncommitted", "branch"]);

/**
 * Looking at `worktree` (undefined: the session's own folder). Another worktree opens on its branch,
 * against its base, committed or not, since agents commit as they go; going back to the session's
 * folder brings back the view it had.
 */
export function pickWorktree(cur: ReviewPlace, worktree: string | undefined): ReviewPlace {
    if (worktree === cur.worktree) return cur;
    const own = cur.worktree === undefined ? { scope: cur.scope, base: cur.base } : cur.own;
    if (worktree === undefined) return { scope: own?.scope ?? "uncommitted", base: own?.base };
    return { worktree, scope: "branch", own };
}

/** A view picked: another worktree takes only Git's (the others are disabled there, but just in case). */
export function pickScope(cur: ReviewPlace, scope: ReviewScope): ReviewPlace {
    if (cur.worktree !== undefined && !OTHER_WORKTREE_SCOPES.has(scope)) return cur;
    return { ...cur, scope };
}

/**
 * Back to the session's own folder when the worktree looked at is gone: no longer listed, its folder
 * missing, or now the session's own. `listed` undefined (not known yet) changes nothing.
 */
export function keepWorktree(cur: ReviewPlace, listed: { path: string; exists: boolean; prunable?: string; current: boolean }[] | undefined): ReviewPlace {
    if (cur.worktree === undefined || !listed) return cur;
    const w = listed.find((x) => x.path === cur.worktree);
    return w && w.exists && w.prunable === undefined && !w.current ? cur : pickWorktree(cur, undefined);
}
