// Standard 5-field cron (minute hour day-of-month month day-of-week) in the
// machine's local time zone, as Claude Code's CronCreate takes it. Fields take
// `*`, lists, ranges and steps; months and weekdays take names; 7 is Sunday;
// @hourly, @daily, @weekly, @monthly and @yearly stand for the usual lines.
// When both day fields are restricted, a day matching either counts (classic
// cron). Around daylight saving: a fixed time in the spring-forward gap runs
// at the first minute after it, and one in the repeated fall-back hour runs once.

export interface Cron {
    /** The expression as given (trimmed, single-spaced). */
    source: string;
    minutes: Set<number>;
    hours: Set<number>;
    days: Set<number>;
    months: Set<number>;
    weekdays: Set<number>;
    /** The field was `*` (or `*` with a step that covers everything). */
    anyDay: boolean;
    anyWeekday: boolean;
    anyHour: boolean;
    /** The minute field has a `*` in it (every minute, or a step): not one fixed time. */
    anyMinute: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const MACROS: Record<string, string> = {
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
    "@monthly": "0 0 1 * *",
    "@weekly": "0 0 * * 0",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@hourly": "0 * * * *",
};

interface FieldSpec {
    name: string;
    min: number;
    max: number;
    names?: string[];
    /** Where names start counting (months are 1-based). */
    nameBase?: number;
}

const FIELDS: FieldSpec[] = [
    { name: "minute", min: 0, max: 59 },
    { name: "hour", min: 0, max: 23 },
    { name: "day of month", min: 1, max: 31 },
    { name: "month", min: 1, max: 12, names: MONTHS, nameBase: 1 },
    // 7 is Sunday too; folded into 0 below.
    { name: "day of week", min: 0, max: 7, names: WEEKDAYS, nameBase: 0 },
];

export class CronError extends Error {}

function value(s: string, f: FieldSpec): number {
    const lower = s.toLowerCase();
    const named = f.names?.indexOf(lower) ?? -1;
    if (named >= 0) return named + (f.nameBase ?? 0);
    if (!/^\d+$/.test(s)) throw new CronError(`"${s}" isn't a valid ${f.name}${f.names ? ` (use ${f.min}-${f.max} or a name like ${f.names[1]})` : ` (use ${f.min}-${f.max})`}.`);
    const n = Number(s);
    if (n < f.min || n > f.max) throw new CronError(`${f.name} ${n} is out of range (${f.min}-${f.max}).`);
    return n;
}

function field(text: string, f: FieldSpec): { set: Set<number>; any: boolean } {
    const set = new Set<number>();
    let any = false;
    for (const part of text.split(",")) {
        if (!part) throw new CronError(`The ${f.name} field "${text}" has an empty list item.`);
        const [range, stepText, extra] = part.split("/");
        if (extra !== undefined) throw new CronError(`"${part}" has more than one step.`);
        let step = 1;
        if (stepText !== undefined) {
            if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new CronError(`The step in "${part}" must be a positive whole number.`);
            step = Number(stepText);
        }
        let lo: number;
        let hi: number;
        if (range === "*" || range === "?") {
            lo = f.min;
            hi = f.name === "day of week" ? 6 : f.max;
            if (step === 1) any = true;
        } else if (range!.includes("-")) {
            const [a, b, more] = range!.split("-");
            if (more !== undefined || !a || !b) throw new CronError(`"${range}" isn't a valid range.`);
            lo = value(a, f);
            hi = value(b, f);
            if (lo > hi) throw new CronError(`The range "${range}" runs backwards.`);
        } else {
            lo = value(range!, f);
            // "5/15": from 5 to the end, every 15.
            hi = stepText !== undefined ? f.max : lo;
        }
        for (let n = lo; n <= hi; n += step) set.add(f.name === "day of week" && n === 7 ? 0 : n);
    }
    return { set, any };
}

/** Parses a cron expression; throws CronError saying what's wrong. */
export function parseCron(expr: string): Cron {
    const trimmed = expr.trim().replace(/\s+/g, " ");
    if (!trimmed) throw new CronError("The cron expression is empty.");
    const expanded = trimmed.startsWith("@") ? MACROS[trimmed.toLowerCase()] : trimmed;
    if (!expanded) throw new CronError(`Unknown cron shortcut ${trimmed} (use @hourly, @daily, @weekly, @monthly or @yearly).`);
    const parts = expanded.split(" ");
    if (parts.length !== 5) throw new CronError(`A cron expression has 5 fields (minute hour day-of-month month day-of-week); "${trimmed}" has ${parts.length}.`);
    const [mi, h, d, mo, w] = parts.map((p, i) => field(p, FIELDS[i]!));
    const cron: Cron = {
        source: trimmed,
        minutes: mi!.set,
        hours: h!.set,
        days: d!.set,
        months: mo!.set,
        weekdays: w!.set,
        anyDay: d!.any,
        anyWeekday: w!.any,
        anyHour: h!.any,
        anyMinute: parts[0]!.includes("*"),
    };
    // Feb 30, Apr 31: a day that no chosen month has.
    if (cron.anyWeekday && !cron.anyDay) {
        const longest = Math.max(...[...cron.months].map((m) => [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!));
        if (Math.min(...cron.days) > longest) throw new CronError(`"${trimmed}" never runs: no chosen month has day ${Math.min(...cron.days)}.`);
    }
    return cron;
}

function dayMatches(c: Cron, d: Date): boolean {
    return daysMatch(c, d.getDate(), d.getDay());
}

/** Both day fields restricted: either matching counts; one `*`: only the other one. */
function daysMatch(c: Cron, date: number, weekday: number): boolean {
    const dom = c.days.has(date);
    const dow = c.weekdays.has(weekday);
    if (c.anyDay && c.anyWeekday) return true;
    if (c.anyDay) return dow;
    if (c.anyWeekday) return dom;
    return dom || dow;
}

/** Wall-clock fields as one number of minutes, for comparing local times. */
function wall(d: Date): number {
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()) / 60_000;
}

/** A wall-clock minute (from wall()) matches, ignoring whether it exists locally. */
function wallMatches(c: Cron, w: number): boolean {
    const u = new Date(w * 60_000);
    if (!c.months.has(u.getUTCMonth() + 1) || !c.minutes.has(u.getUTCMinutes()) || !c.hours.has(u.getUTCHours())) return false;
    return daysMatch(c, u.getUTCDate(), u.getUTCDay());
}

const MINUTE = 60_000;
/** Scans give up after this many steps (years of skipping); parseCron already refuses what never runs. */
const MAX_STEPS = 20_000;

/** The first time after `after` (ms) the expression matches, or undefined if none within ~5 years. */
export function nextRun(c: Cron, after: number): number | undefined {
    let t = Math.floor(after / MINUTE) * MINUTE + MINUTE;
    const limit = after + 5 * 366 * 24 * 3_600_000;
    for (let i = 0; i < MAX_STEPS && t <= limit; i++) {
        const d = new Date(t);
        // Clocks jumped forward between the previous minute and this one: a time in the gap runs now.
        const prevWall = wall(new Date(t - MINUTE));
        const nowWall = wall(d);
        if (nowWall - prevWall > 1 && nowWall - prevWall <= 180) {
            for (let w = prevWall + 1; w < nowWall; w++) if (wallMatches(c, w)) return t;
        }
        if (!c.months.has(d.getMonth() + 1)) {
            t = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
            continue;
        }
        if (!dayMatches(c, d)) {
            t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
            continue;
        }
        if (!c.hours.has(d.getHours())) {
            t += (60 - d.getMinutes()) * MINUTE;
            continue;
        }
        if (!c.minutes.has(d.getMinutes())) {
            t += MINUTE;
            continue;
        }
        // The repeated stretch after clocks go back (an hour, or half an hour on Lord Howe): a fixed
        // time (not every few minutes, not every hour) already ran that much earlier.
        if (!c.anyMinute && c.hours.size < 24) {
            const back = new Date(t).getTimezoneOffset() - new Date(t - 3 * 3_600_000).getTimezoneOffset();
            if (back > 0 && wall(new Date(t - back * MINUTE)) === nowWall) {
                t += MINUTE;
                continue;
            }
        }
        return t;
    }
    return undefined;
}

const pad = (n: number) => String(n).padStart(2, "0");

function clock(h: number, m: number): string {
    const hour = h % 12 === 0 ? 12 : h % 12;
    return `${hour}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
}

function only<T>(s: Set<T>): T | undefined {
    return s.size === 1 ? [...s][0] : undefined;
}

/** A step that covers the field evenly from its start: "*\/5" → 5. */
function evenStep(s: Set<number>, min: number, max: number): number | undefined {
    const v = [...s].sort((a, b) => a - b);
    if (v.length < 2 || v[0] !== min) return undefined;
    const step = v[1]! - v[0]!;
    if (v.some((x, i) => x !== min + i * step)) return undefined;
    // Even all the way round: */7 leaves a 4-minute gap at the hour, so it isn't "every 7 minutes".
    return (max - min + 1) % step === 0 && v.length === (max - min + 1) / step ? step : undefined;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** In words, for the common shapes ("every 5 minutes", "weekdays at 9:03 AM"); otherwise the expression. */
export function describeCron(c: Cron): string {
    const everyDay = c.anyDay && c.anyWeekday && c.months.size === 12;
    const allMinutes = c.minutes.size === 60;
    if (everyDay && c.anyHour) {
        if (allMinutes) return "every minute";
        const step = evenStep(c.minutes, 0, 59);
        if (step) return `every ${step} minutes`;
        const m = only(c.minutes);
        if (m !== undefined) return `hourly at :${pad(m)}`;
    }
    if (everyDay && !c.anyHour) {
        const step = evenStep(c.hours, 0, 23);
        const m = only(c.minutes);
        if (step && m !== undefined) return `every ${step} hours at :${pad(m)}`;
    }
    const h = only(c.hours);
    const m = only(c.minutes);
    if (h === undefined || m === undefined || c.months.size !== 12) return c.source;
    const at = clock(h, m);
    if (everyDay) return `daily at ${at}`;
    if (c.anyDay) {
        const days = [...c.weekdays].sort((a, b) => a - b);
        if (days.join() === "1,2,3,4,5") return `weekdays at ${at}`;
        if (days.join() === "0,6") return `weekends at ${at}`;
        return `${days.map((d) => DAY_NAMES[d]!.slice(0, 3)).join(", ")} at ${at}`;
    }
    if (c.anyWeekday) {
        const d = only(c.days);
        if (d !== undefined) return `monthly on day ${d} at ${at}`;
    }
    return c.source;
}
