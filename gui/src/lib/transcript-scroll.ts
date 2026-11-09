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

/** Each turn's height, looked up as it's needed (opening a long session needs only its last few): an array, or a turn's by index. */
export type Heights = { readonly length: number; at(i: number): number | undefined };
const heightAt = (h: Heights, i: number) => h.at(i) ?? 0;

/** turnHeight of each of `turns`, worked out only for those asked about. */
export function lazyHeights(turns: readonly Parameters<typeof turnHeight>[0][]): Heights {
    const known = new Map<number, number>();
    return {
        length: turns.length,
        at(i) {
            let h = known.get(i);
            if (h === undefined) known.set(i, (h = turnHeight(turns[i]!)));
            return h;
        },
    };
}

/**
 * How many turns to mount at first: opening at the end, the last ones that fill `screen` (px) twice over (at least
 * FIRST_TURNS_MIN, at most `shown`); elsewhere all `shown`.
 */
export function firstShown(heights: Heights, shown: number, atEnd: boolean, screen: number): number {
    if (!atEnd) return shown;
    let n = 0;
    let filled = 0;
    for (let i = heights.length - 1; i >= 0 && n < shown && (n < FIRST_TURNS_MIN || filled < 2 * screen); i--) {
        filled += heightAt(heights, i);
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
    /** The same turns as keys that find them again in the session read in anew (placedAgain); set by keyed(). */
    keys?: { anchor?: TurnKey; part?: number; work: TurnKey[] };
};

type Place = { seg: number; index: number };
/** What a turn is to be found again by (Turn, or a test's few fields of one). */
export type KeyTurn = { id: string; pos?: Place; startedAt?: number; prompt?: unknown; blocks?: readonly { t: string; id: string }[] };

/**
 * A turn, as it can be found again once the server reads its session in anew (it let it go, or restarted): turn ids are
 * the server's, numbered as it reads the session, and the same id can then be another turn, or none. Where its message is
 * in the session (pos), when it started, and what it starts with don't change.
 */
export type TurnKey = {
    id: string;
    pos?: Place;
    at?: number;
    /** "prompt", or what its first block is. */
    kind: string;
    /** Its place, or the place of the nearest turn before it that has one: session.turns' `through`, to bring it back. */
    near?: Place;
};

const samePlace = (a?: Place, b?: Place) => a === b || (!!a && !!b && a.seg === b.seg && a.index === b.index);
/** `a` is before `b` in the session. */
export const placeBefore = (a: Place, b: Place) => a.seg < b.seg || (a.seg === b.seg && a.index < b.index);
const kindOf = (t: KeyTurn) => (t.prompt ? "prompt" : (t.blocks?.[0]?.t ?? ""));

export function turnKey(turns: readonly KeyTurn[], i: number): TurnKey {
    const t = turns[i]!;
    let near: Place | undefined;
    for (let j = i; j >= 0 && !near; j--) near = turns[j]!.pos;
    return { id: t.id, kind: kindOf(t), ...(t.pos ? { pos: t.pos } : {}), ...(t.startedAt !== undefined ? { at: t.startedAt } : {}), ...(near ? { near } : {}) };
}

function isKey(t: KeyTurn, k: TurnKey) {
    if (!samePlace(t.pos, k.pos) || kindOf(t) !== k.kind) return false;
    if (t.startedAt !== undefined && k.at !== undefined) return t.startedAt === k.at;
    // Nothing else tells turns with no place apart: only its own id, unchanged.
    return k.pos !== undefined || t.id === k.id;
}

/** The turn `k` is of, among `turns`; none when it isn't there, or two could be it. */
export function keyedTurn<T extends KeyTurn>(turns: readonly T[], k: TurnKey): T | undefined {
    let found: T | undefined;
    let both = false;
    for (const t of turns) {
        if (!isKey(t, k)) continue;
        if (found) both = true;
        if (!found || t.id === k.id) found = t;
    }
    return both && found?.id !== k.id ? undefined : found;
}

/** `p`, with what finds its turns again (keys), from `turns` as they are now. */
export function keyed(turns: readonly KeyTurn[], p: TranscriptPosition): TranscriptPosition {
    let at: Map<string, number> | undefined;
    const index = (id: string) => (at ??= new Map(turns.map((t, i) => [t.id, i]))).get(id);
    const a = p.anchor ? index(p.anchor.turnId) : undefined;
    const part = a === undefined || !p.anchor?.part ? -1 : (turns[a]!.blocks?.findIndex((b) => b.id === p.anchor!.part) ?? -1);
    const work = p.openWork.flatMap((id) => {
        const i = index(id);
        return i === undefined ? [] : [turnKey(turns, i)];
    });
    return { ...p, keys: { ...(a !== undefined ? { anchor: turnKey(turns, a) } : {}), ...(part >= 0 ? { part } : {}), work } };
}

/**
 * `p` (saved with keyed()) on `turns`, which may be numbered anew: its turns by their ids now. The place read, if its
 * turn isn't among them, goes: the session opens at its end. A block it was read at is kept only if it's still that
 * block (its id, at its index): block ids are numbered anew too.
 */
export function placedAgain(turns: readonly KeyTurn[], p: TranscriptPosition): TranscriptPosition {
    const k = p.keys;
    if (!k) return p;
    const openWork = k.work.flatMap((w) => keyedTurn(turns, w)?.id ?? []);
    if (!p.anchor || p.bottom) return { bottom: p.bottom, top: p.top, openWork };
    const a = k.anchor && keyedTurn(turns, k.anchor);
    if (!a) return { bottom: true, top: p.top, openWork };
    let anchor: ScrollAnchor = { ...p.anchor, turnId: a.id };
    const part = anchor.part;
    // "prompt", a work log by its index: not ids. A block's id, in a turn numbered anew, or no longer at its index
    // (the blocks before it were): another block's, maybe.
    const byId = part !== undefined && part !== "prompt" && !part.startsWith("worklog:");
    if (byId && (a.id !== p.anchor.turnId || (k.part !== undefined && a.blocks?.[k.part]?.id !== part))) {
        const { part: _p, partOffset: _o, row: _r, rowOffset: _ro, ...rest } = anchor;
        anchor = rest;
    }
    return { bottom: p.bottom, top: p.top, anchor, openWork };
}

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
export function firstWindow(heights: Heights, shown: number, anchor: number | undefined, screen: number, read = 0): { shown: number; trimmed: number } {
    const n = heights.length;
    if (anchor === undefined || anchor < 0 || anchor >= n) return { shown: firstShown(heights, shown, true, screen), trimmed: 0 };
    const start = Math.max(n - shown, Math.min(anchor, Math.max(0, anchor - 1)));
    let end = anchor + 1;
    let filled = Math.max(0, heightAt(heights, anchor) - Math.max(0, read));
    while (end < n && filled < 2 * screen) filled += heightAt(heights, end++);
    return { shown: n - start, trimmed: n - end };
}
