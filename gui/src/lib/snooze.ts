// The times a session can be snoozed until, worked out in the window's own time zone (a server may be in another):
// the server is sent the moment. Used by the row menu's Snooze (components/RowExtras.tsx), loaded with it.

const HOUR = 3_600_000;

export interface SnoozeChoice {
    label: string;
    at: number;
    /** When, beside it: the time, and the day where the label doesn't say it. */
    hint: string;
}

/** `days` from `now`'s day, at `hour` o'clock. */
function dayAt(now: number, days: number, hour: number): number {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
}

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** 1 hour; tonight at 6 pm (3 hours on when that's past); tomorrow at 9 am; next Monday at 9 am. */
export function snoozeChoices(now: number): SnoozeChoice[] {
    const today = new Date(now);
    const choice = (label: string, at: number, day = false) => ({ label, at, hint: day ? `${new Date(at).toLocaleDateString([], { weekday: "short" })} ${time(at)}` : time(at) });
    return [
        choice("1 hour", now + HOUR),
        choice("Tonight", today.getHours() < 18 ? dayAt(now, 0, 18) : now + 3 * HOUR),
        choice("Tomorrow morning", dayAt(now, 1, 9)),
        // Monday is day 1: from a Monday, the next one.
        choice("Next week", dayAt(now, (8 - today.getDay()) % 7 || 7, 9), true),
    ];
}

/** When it wakes, in words: "6:00 PM", "Tomorrow 9:00 AM", "Mon 9:00 AM", or "Nov 25, 9:00 AM". */
export function wakesText(at: number, now: number): string {
    const t = time(at);
    const days = Math.round((dayAt(at, 0, 0) - dayAt(now, 0, 0)) / (24 * HOUR));
    if (days === 0) return t;
    if (days === 1) return `Tomorrow ${t}`;
    const day = new Date(at).toLocaleDateString([], days > 0 && days < 7 ? { weekday: "short" } : { month: "short", day: "numeric" });
    return `${day}${days > 0 && days < 7 ? "" : ","} ${t}`;
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
