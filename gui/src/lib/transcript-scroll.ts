export const TURN_PAGE = 40;

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
