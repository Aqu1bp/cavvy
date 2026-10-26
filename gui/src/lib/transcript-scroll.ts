export const TURN_PAGE = 40;
/**
 * A session opening at its end mounts its last turns first, about two screens of them, and the rest of what it shows
 * a few at a time after, between frames: building 40 rich turns at once cost a 100 ms frame on opening or switching to
 * a long session (measured).
 */
export const MORE_TURNS = 4;
/** At least this many turns go in first, whatever their estimated size. */
export const FIRST_TURNS_MIN = 2;

/** About how tall a turn is drawn (px), before it is: its prompt, its reply's text at a column's line length, its work folded. */
export function turnHeight(turn: { prompt?: { text: string }; blocks?: readonly { t: string; text?: string }[] }): number {
    let chars = 0;
    let tools = 0;
    for (const b of turn.blocks ?? []) {
        if (b.t === "text" && b.text) chars += b.text.length;
        else if (b.t === "tool") tools++;
    }
    const lines = Math.ceil(chars / 90) + (turn.prompt ? Math.ceil(turn.prompt.text.length / 70) : 0);
    return 60 + lines * 22 + (tools ? 32 : 0);
}

/**
 * How many turns to mount at first: opening at the end, the last ones that fill `screen` (px) twice over (at least
 * FIRST_TURNS_MIN, at most `shown`); elsewhere all `shown`.
 */
export function firstShown(heights: readonly number[], shown: number, atEnd: boolean, screen: number): number {
    if (!atEnd) return shown;
    let n = 0;
    let filled = 0;
    for (let i = heights.length - 1; i >= 0 && n < shown && (n < FIRST_TURNS_MIN || filled < 2 * screen); i--) {
        filled += heights[i]!;
        n++;
    }
    return Math.max(Math.min(shown, FIRST_TURNS_MIN), n);
}

/** On a turn far from the view (Transcript): it skips layout and paint until it comes near. */
export const FAR = "data-far";

export type ScrollAnchor = { turnId: string; offset: number; part?: string; partOffset?: number; row?: number; rowOffset?: number };
export type TranscriptPosition = {
    bottom: boolean;
    top: number;
    anchor?: ScrollAnchor;
    openWork: string[];
};

/** In-memory only: revisiting a session refreshes its place in the LRU. */
export function positionCache(limit = 20) {
    const entries = new Map<string, TranscriptPosition>();
    return {
        get(id: string) {
            const value = entries.get(id);
            if (value) { entries.delete(id); entries.set(id, value); }
            return value;
        },
        set(id: string, value: TranscriptPosition) {
            entries.delete(id);
            entries.set(id, value);
            while (entries.size > limit) entries.delete(entries.keys().next().value!);
        },
    };
}

export const transcriptPositions = positionCache();

/**
 * How many turns a session shows when it's opened again: its last page, or, left reading higher up, the pages down
 * from there (new turns may have pushed it out of its old page). Not every page it once showed: those cost layout and
 * memory for as long as it's open, and the turns above are a click away.
 */
export function restoredShown(ids: string[], saved?: TranscriptPosition) {
    const index = !saved?.bottom && saved?.anchor ? ids.indexOf(saved.anchor.turnId) : -1;
    const needed = index < 0 ? 0 : Math.ceil((ids.length - index) / TURN_PAGE) * TURN_PAGE;
    return Math.max(TURN_PAGE, needed);
}

/** The first of `n` items in order whose bottom (`bottomOf(i)`, growing with i) is below `top`; `n` if none is. */
export function firstBelow(n: number, bottomOf: (i: number) => number, top: number) {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (bottomOf(mid) > top) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}

export function anchoredTop(top: number, currentOffset: number, savedOffset: number) {
    return Math.max(0, top + currentOffset - savedOffset);
}

export function atBottom(top: number, height: number, viewport: number) {
    return height - top - viewport < 64;
}

/**
 * The turns to mount at first, as a window over the last `shown`: `shown` from the end, less `trimmed` at the very end.
 * Opening at the end (`anchor` undefined or not found): about two screens of the last turns (firstShown). Opening where
 * the turn at index `anchor` was being read: the turn above it, and it and the turns below it to about two screens; the rest goes in
 * after, below first, then above. `read` is how far into that turn the view's top was: the two screens count from there, so a
 * turn taller than them, read near its end, still brings the turns below it in view.
 */
export function firstWindow(heights: readonly number[], shown: number, anchor: number | undefined, screen: number, read = 0): { shown: number; trimmed: number } {
    const n = heights.length;
    if (anchor === undefined || anchor < 0 || anchor >= n) return { shown: firstShown(heights, shown, true, screen), trimmed: 0 };
    const start = Math.max(n - shown, Math.min(anchor, Math.max(0, anchor - 1)));
    let end = anchor + 1;
    let filled = Math.max(0, (heights[anchor] ?? 0) - Math.max(0, read));
    while (end < n && filled < 2 * screen) filled += heights[end++]!;
    return { shown: n - start, trimmed: n - end };
}
