// The times a session can be snoozed until, worked out in the window's own time zone (a server may be in another):
// the server is sent the moment. Used by the row menu's Snooze (components/RowExtras.tsx), loaded with it.

import { clock, wakeTime } from "./format";

const HOUR = 3_600_000;

export interface SnoozeChoice {
    label: string;
    at: number;
    /** When, beside it, as its row will say it (wakeTime): the day too where the label doesn't say it. */
    hint: string;
}

/** `days` from `now`'s day, at `hour` o'clock. */
function dayAt(now: number, days: number, hour: number): number {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
}

/** The next 9 am that's 2 hours away or more: this morning's in the small hours, else tomorrow's. Custom… starts at it. */
export function nextMorning(now: number): number {
    const morning = dayAt(now, 0, 9);
    return morning - now >= 2 * HOUR ? morning : dayAt(now, 1, 9);
}

/**
 * 1 hour; tonight at 6 pm, or 9 pm once 6 pm is under 2 hours away (none later in the evening: it would come too soon
 * after "1 hour", or after midnight); tomorrow at 9 am; next Monday at 9 am. In the small hours (9 am 2 hours away or
 * more), the day ahead is the one a person still calls tomorrow: this morning at 9 am and this evening at 6 pm instead.
 */
export function snoozeChoices(now: number): SnoozeChoice[] {
    const today = new Date(now);
    const choice = (label: string, at: number, dayNamed = false) => ({ label, at, hint: dayNamed ? clock(at) : wakeTime(at, now) });
    const nextWeek = choice("Next week", dayAt(now, (8 - today.getDay()) % 7 || 7, 9));
    const morning = nextMorning(now);
    if (morning === dayAt(now, 0, 9)) return [choice("1 hour", now + HOUR), choice("This morning", morning, true), choice("This evening", dayAt(now, 0, 18), true), nextWeek];
    const tonight = [18, 21].map((h) => dayAt(now, 0, h)).find((at) => at - now >= 2 * HOUR);
    return [
        choice("1 hour", now + HOUR),
        ...(tonight ? [choice("Tonight", tonight)] : []),
        choice("Tomorrow morning", morning, true),
        // Monday is day 1: from a Monday, the next one.
        nextWeek,
    ];
}

/** A datetime-local field's value for a moment (its own format: local time, to the minute). */
export function localInput(at: number): string {
    const d = new Date(at);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The moment a datetime-local field names; undefined when it's empty or not a time. */
export function fromLocalInput(value: string): number | undefined {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
    if (!m) return undefined;
    const at = new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!).getTime();
    return Number.isFinite(at) ? at : undefined;
}

/** What's wrong with a custom time, if anything: in the past, or more than a year on (the server's limit). */
export function customProblem(at: number | undefined, now: number): string | undefined {
    if (at === undefined) return "Choose a date and time.";
    if (at <= now) return "Choose a time in the future.";
    if (at > now + 365 * 24 * HOUR) return "Choose a time within a year.";
    return undefined;
}
