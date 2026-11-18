// Snoozed sessions: what the GUI's store (engine.ts GuiStore) keeps for them, which are due to wake, and the one
// timer that wakes them. Times are the server's clock; the window works out "tonight" or "Monday 9 am" in its own
// time zone and sends the moment.

/** A snoozed session, by its id in the store. */
export interface SnoozeEntry {
    /** When it wakes by itself. */
    until: number;
    /** Snoozed while a turn ran: it wakes when that turn ends, before its time. */
    turn?: true;
}

export interface SnoozeStore {
    snoozed?: Record<string, SnoozeEntry>;
    /** Woken (by its time, or early because it needs you) and not opened since: its row says so. */
    woke?: string[];
}

/** The furthest ahead a session can be snoozed. */
export const MAX_SNOOZE_MS = 366 * 24 * 3600_000;

/** Checked by the window's clock, a minute's leeway for one a little behind the server's. */
export function checkSnoozeUntil(until: unknown, now: number): number | undefined {
    if (typeof until !== "number" || !Number.isFinite(until)) return undefined;
    if (until < now - 60_000 || until > now + MAX_SNOOZE_MS) return undefined;
    return Math.max(until, now);
}

/** The sessions whose time has come. */
export function dueWakes(store: SnoozeStore, now: number): string[] {
    return Object.entries(store.snoozed ?? {})
        .filter(([, e]) => e.until <= now)
        .map(([id]) => id);
}

/** When the next one wakes by itself; undefined: none is snoozed. */
export function nextWake(store: SnoozeStore): number | undefined {
    let next: number | undefined;
    for (const e of Object.values(store.snoozed ?? {})) if (next === undefined || e.until < next) next = e.until;
    return next;
}

/** The store after `id` wakes: not snoozed, and marked woke when `mark` (it's back by itself, not by the user's hand). */
export function woken(store: SnoozeStore, id: string, mark: boolean): void {
    if (store.snoozed?.[id]) {
        const { [id]: _, ...rest } = store.snoozed;
        store.snoozed = rest;
    }
    const woke = (store.woke ?? []).filter((x) => x !== id);
    store.woke = mark ? [...woke, id] : woke;
}

/** The store with nothing kept for `id` (deleted, archived, or sent to). */
export function forget(store: SnoozeStore, id: string): void {
    woken(store, id, false);
}

/**
 * One timer for the next thing due. A laptop's sleep stops the clock timers run by, so a far-off moment is checked
 * again at least every `maxDelayMs`: a session snoozed until tomorrow 9 am wakes within that of 9 am, whenever the
 * machine was asleep.
 */
export class Alarm {
    private timer?: ReturnType<typeof setTimeout>;
    /** What it's set for. */
    at?: number;

    constructor(
        private o: {
            now: () => number;
            fire: () => void;
            maxDelayMs: number;
            setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
            clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
        },
    ) {}

    /** Set for `at` (undefined: nothing due), replacing what was set; checked again after `maxDelayMs` at most (default: the alarm's). */
    arm(at: number | undefined, maxDelayMs = this.o.maxDelayMs) {
        this.stop();
        this.at = at;
        if (at === undefined) return;
        const delay = Math.max(0, Math.min(at - this.o.now(), maxDelayMs));
        const fire = () => {
            this.timer = undefined;
            this.o.fire();
        };
        this.timer = this.o.setTimer ? this.o.setTimer(fire, delay) : setTimeout(fire, delay);
        (this.timer as { unref?: () => void }).unref?.();
    }

    /** Due now (a timer held back by sleep, say). */
    due(): boolean {
        return this.at !== undefined && this.at <= this.o.now();
    }

    stop() {
        if (this.timer !== undefined) (this.o.clearTimer ?? clearTimeout)(this.timer);
        this.timer = undefined;
        this.at = undefined;
    }
}
