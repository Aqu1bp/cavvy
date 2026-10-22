export const TURN_PAGE = 40;

/** On a turn far from the view (Transcript): it skips layout and paint until it comes near. */
export const FAR = "data-far";

export type ScrollAnchor = { turnId: string; offset: number; part?: string; partOffset?: number };
export type TranscriptPosition = {
    shown: number;
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

/** New turns may have pushed the saved anchor outside its old page. */
export function restoredShown(ids: string[], saved?: TranscriptPosition) {
    const index = !saved?.bottom && saved?.anchor ? ids.indexOf(saved.anchor.turnId) : -1;
    const needed = index < 0 ? 0 : Math.ceil((ids.length - index) / TURN_PAGE) * TURN_PAGE;
    return Math.max(TURN_PAGE, saved?.shown ?? 0, needed);
}

export function anchoredTop(top: number, currentOffset: number, savedOffset: number) {
    return Math.max(0, top + currentOffset - savedOffset);
}

export function atBottom(top: number, height: number, viewport: number) {
    return height - top - viewport < 64;
}
