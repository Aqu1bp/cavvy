// Settling sessions left idle (Settings → General, "Settle idle sessions after"): which are due, and when the next
// one will be. The engine (engine.ts sweep) settles them with the same timer that wakes snoozed ones (snooze.ts).

const DAY = 24 * 3600_000;

/** What the setting may be: off, or a number of days. */
export const AUTO_SETTLE_DAYS = [0, 1, 3, 7, 14] as const;
/** Unset: a week. Settling is undone with one click (Back in play, or sending to it), so a week errs on tidy. */
export const DEFAULT_AUTO_SETTLE_DAYS = 7;

/** The setting as it's applied: one of AUTO_SETTLE_DAYS, the default for anything else. */
export function autoSettleDays(v: unknown): number {
    return AUTO_SETTLE_DAYS.includes(v as (typeof AUTO_SETTLE_DAYS)[number]) ? (v as number) : DEFAULT_AUTO_SETTLE_DAYS;
}

export interface SettleStore {
    /** Never settled by itself (its row menu's Never auto-settle). */
    neverSettle?: string[];
    /** When each was last brought back by hand (Back in play, restored) or woke from a snooze: its idle time starts again there. */
    inPlay?: Record<string, number>;
    /** Settled because its pull request merged or closed: that's done once, so Back in play sticks. */
    prSettled?: string[];
}

/** A session as the sweep sees it. */
export interface SettleCandidate {
    id: string;
    updatedAt: number;
    status: "idle" | "running" | "waiting" | "error";
    pinned: boolean;
    settled: boolean;
    archived: boolean;
    snoozedUntil?: number;
    /** A turn, a queued message or a question in it right now. */
    busy?: boolean;
    /** On a window's screen right now. */
    shown?: boolean;
}

/** Whether it may be settled by itself at all: not pinned, working, waiting for you, snoozed, or kept in play. */
export function settleable(s: SettleCandidate, store: SettleStore): boolean {
    return !s.settled && !s.archived && !s.pinned && !s.busy && s.status !== "running" && s.status !== "waiting" && s.snoozedUntil === undefined && !store.neverSettle?.includes(s.id);
}

/** Those idle `days` or more (and not on screen), and when the next of the rest will be. */
export function settleDue(list: readonly SettleCandidate[], store: SettleStore, days: number, now: number): { due: string[]; next?: number } {
    if (!days) return { due: [] };
    const due: string[] = [];
    let next: number | undefined;
    for (const s of list) {
        if (!settleable(s, store)) continue;
        const at = Math.max(s.updatedAt, store.inPlay?.[s.id] ?? 0) + days * DAY;
        // One on screen is looked at again a while on.
        const when = at <= now && s.shown ? now + 3600_000 : at;
        if (when <= now) due.push(s.id);
        else next = next === undefined ? when : Math.min(next, when);
    }
    return { due, next };
}

/** `id` was brought back into play now: its idle time starts again. Entries older than the longest setting go. */
export function notePlay(store: SettleStore, id: string, now: number) {
    const keep = Object.entries(store.inPlay ?? {}).filter(([k, at]) => k !== id && now - at < 15 * DAY);
    store.inPlay = Object.fromEntries([...keep, [id, now]]);
}

/** Nothing kept for `id` (deleted). */
export function forgetPlay(store: SettleStore, id: string) {
    if (store.inPlay?.[id] !== undefined) {
        const { [id]: _, ...rest } = store.inPlay;
        store.inPlay = rest;
    }
    if (store.neverSettle?.includes(id)) store.neverSettle = store.neverSettle.filter((x) => x !== id);
    if (store.prSettled?.includes(id)) store.prSettled = store.prSettled.filter((x) => x !== id);
}
