// The diff reader's stacked files (components/ReviewPane): which files have one side (a new or
// deleted file's diff gets one line-number column, and stays unified side by side), what the view
// menu offers and calls each view, how tall a file not drawn yet is guessed to be, which file is
// under the top of the view (its header is the stuck one), and how far the scroll moves to keep
// what's in view in place when files above it change height.

import type { DiffHunk, GitFileDiff } from "@shared/protocol";
import type { ReviewScope } from "../state/changes";
import type { ReviewPlace } from "./worktree-work";
import { OTHER_WORKTREE_SCOPES } from "./worktree-work";

/**
 * One side: a new, untracked or deleted file, every line of it that side's. Git's change wins over the
 * edit tools' status; a line of the other side (or context) keeps both columns, so no number is lost.
 */
export function oneSided(f: { status: "added" | "modified" | "deleted"; change?: GitFileDiff["change"]; hunks: Pick<DiffHunk, "lines">[] }): boolean {
    const ch = f.change ?? f.status;
    const side = ch === "added" || ch === "untracked" ? "add" : ch === "deleted" ? "del" : undefined;
    return side !== undefined && f.hunks.every((h) => h.lines.every((l) => l.t === side));
}

/** The four views: the button's label, the menu's line about each, and the longer note as its title. */
export const VIEWS: Record<Exclude<ReviewScope, "turn">, { label: string; desc: string; note: string }> = {
    uncommitted: {
        label: "Uncommitted",
        desc: "Everything since the last commit, whoever changed it",
        note: "Everything that differs from the last commit: staged, unstaged and untracked files, whoever changed them.",
    },
    branch: {
        label: "Branch",
        desc: "Everything on this branch since it left its base",
        note: "Everything on this branch since it left its base, committed or not.",
    },
    "last-turn": {
        label: "Last turn",
        desc: "What the last recorded turn changed",
        note: "The last recorded turn’s start and end snapshots. Ignored files are excluded. Changes from other sessions in this folder are included.",
    },
    harness: {
        label: "Harness edits",
        desc: "Only Harness's own edit tools, this session",
        note: "Only what Harness's own edit tools changed in this session. Shell commands and Claude Code or Codex edits aren't included.",
    },
};

/** A recorded turn as git's answer lists it, oldest first. */
export type RecordedTurn = { id: number; prompt: string; startedAt: number; endedAt?: number };

/** "Uncommitted", …, or "Turn 2": a turn by its place in the session (oldest first, as the list comes). */
export function viewLabel(scope: ReviewScope, turnId?: number, turns?: readonly RecordedTurn[]): string {
    if (scope !== "turn") return VIEWS[scope].label;
    const i = turns?.findIndex((t) => t.id === turnId) ?? -1;
    return i < 0 ? "Turn" : `Turn ${i + 1}`;
}

export interface ViewItem {
    scope: Exclude<ReviewScope, "turn">;
    label: string;
    desc: string;
    note: string;
    on: boolean;
    /** Why it can't be picked here. */
    disabled?: string;
}

export interface TurnItem {
    id: number;
    label: string;
    prompt: string;
    startedAt: number;
    on: boolean;
    disabled?: string;
}

/**
 * The view menu's Changes and Recorded turns. Another worktree has Git's views only (turns and Harness
 * edits are the session's own folder's); outside a Git repository Harness edits is all there is. The
 * turn under way (the last, not ended, while the session works) shows its changes once it ends.
 */
export function viewMenu(o: { place: ReviewPlace; turnId?: number; repo: boolean; reason?: string; turns?: readonly RecordedTurn[]; busy: boolean; branch?: string; base?: string }): { views: ViewItem[]; turns: TurnItem[] } {
    const away = o.place.worktree !== undefined;
    const shown: ReviewScope = !o.repo && !away ? "harness" : o.place.scope;
    const views = (Object.keys(VIEWS) as ViewItem["scope"][]).map((scope): ViewItem => {
        const v = VIEWS[scope];
        const desc = scope === "branch" && o.branch && o.base ? `Everything on ${o.branch} since it left ${o.base}` : v.desc;
        const disabled = away && !OTHER_WORKTREE_SCOPES.has(scope) ? "Turns and Harness edits are this session's own folder's. Pick This session under Worktree to see them." : !o.repo && !away && scope !== "harness" ? (o.reason ?? "This folder isn't in a Git repository.") : undefined;
        return { scope, label: v.label, desc, note: v.note, on: shown === scope, ...(disabled ? { disabled } : {}) };
    });
    const list = !o.repo || away ? [] : (o.turns ?? []);
    const turns = list
        .map((t, i): TurnItem => {
            const running = o.busy && i === list.length - 1 && t.endedAt === undefined;
            return { id: t.id, label: `Turn ${i + 1}`, prompt: t.prompt, startedAt: t.startedAt, on: shown === "turn" && o.turnId === t.id, ...(running ? { disabled: "Running: its changes show when it ends" } : {}) };
        })
        .reverse();
    return { views, turns };
}

/**
 * The rows DiffView draws for a file: its lines, and a header for each hunk after the file's top. Hunks still
 * to come (a deferred file) are guessed from its counts, with a hunk's worth of context, or as a screenful
 * when the list didn't count them: files waiting for theirs aren't all drawn (and fetched) at once.
 */
export const DEFERRED_ROWS = 24;
export function stackRows(f: { hunks: Pick<DiffHunk, "oldStart" | "lines">[]; added?: number; removed?: number; deferred?: boolean }): number {
    if (!f.hunks.length) return f.added || f.removed ? (f.added ?? 0) + (f.removed ?? 0) + 6 : f.deferred ? DEFERRED_ROWS : 0;
    return f.hunks.reduce((n, h, i) => n + h.lines.length + (i > 0 || h.oldStart > 1 ? 1 : 0), 0);
}

/** Folding animates the file's height; past this many rows it's instant (each frame would lay out every row). */
export const FOLD_SMOOTH_ROWS = 400;
export const foldsSmoothly = (rows: number) => rows <= FOLD_SMOOTH_ROWS;

/** The last of `n` files (tops in order) starting at or above `y`; -1 when none does. */
export function cardAt(n: number, topOf: (i: number) => number, y: number): number {
    let lo = 0;
    let hi = n - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (topOf(mid) <= y) {
            found = mid;
            lo = mid + 1;
        } else hi = mid - 1;
    }
    return found;
}

/**
 * How far to scroll so the view stays on what it showed when files change height: the sum of the changes
 * of files that ended at or above the view's top. Their tops are taken after the change, in order; the file
 * the view is in keeps its own rows in place (DiffView), and files below don't move it.
 */
export function anchorShift(changes: readonly { top: number; before: number; after: number }[], scrollTop: number): number {
    let shift = 0;
    for (const c of changes) {
        const was = c.top - shift;
        if (was + c.before <= scrollTop + 0.5) shift += c.after - c.before;
    }
    return shift;
}
