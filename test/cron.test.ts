import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CronError, describeCron, nextRun, parseCron } from "../src/util/cron";

// Local time throughout: these run in New York, which has both daylight-saving changes.
let tz: string | undefined;
beforeAll(() => {
    // By name, never deleted: in Bun, deleting TZ freezes the zone for the rest of the process.
    tz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env.TZ = "America/New_York";
});
afterAll(() => {
    process.env.TZ = tz;
});

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const local = (ms: number | undefined) => {
    if (ms === undefined) return "never";
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const next = (expr: string, from: number) => local(nextRun(parseCron(expr), from));

/** The next n runs, each after the one before. */
function runs(expr: string, from: number, n: number): string[] {
    const c = parseCron(expr);
    const out: string[] = [];
    let t = from;
    for (let i = 0; i < n; i++) {
        const r = nextRun(c, t);
        if (r === undefined) break;
        out.push(local(r));
        t = r;
    }
    return out;
}

describe("parseCron", () => {
    test("each field: lists, ranges, steps, names", () => {
        const c = parseCron("*/15 9-17 1,15 jan-mar mon-fri");
        expect([...c.minutes]).toEqual([0, 15, 30, 45]);
        expect([...c.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
        expect([...c.days]).toEqual([1, 15]);
        expect([...c.months]).toEqual([1, 2, 3]);
        expect([...c.weekdays]).toEqual([1, 2, 3, 4, 5]);
        expect(c.anyDay).toBe(false);
    });

    test("7 is Sunday; names in any case; a start with a step runs to the end", () => {
        expect([...parseCron("0 0 * * 7").weekdays]).toEqual([0]);
        expect([...parseCron("0 0 * * 5-7").weekdays].sort()).toEqual([0, 5, 6]);
        expect([...parseCron("0 0 * DEC Sun").months]).toEqual([12]);
        expect([...parseCron("5/20 * * * *").minutes]).toEqual([5, 25, 45]);
        expect([...parseCron("0 0-12/6 * * *").hours]).toEqual([0, 6, 12]);
    });

    test("macros", () => {
        expect(parseCron("@hourly").minutes).toEqual(new Set([0]));
        expect(parseCron("@daily").hours).toEqual(new Set([0]));
        expect([...parseCron("@weekly").weekdays]).toEqual([0]);
        expect(parseCron("@MONTHLY").days).toEqual(new Set([1]));
        expect(parseCron("@yearly").months).toEqual(new Set([1]));
    });

    test("extra whitespace is fine", () => {
        expect(parseCron("  0   9 * *   1-5 ").source).toBe("0 9 * * 1-5");
    });

    const bad: [string, RegExp][] = [
        ["", /empty/],
        ["* * * *", /5 fields.*has 4/],
        ["* * * * * *", /has 6/],
        ["60 * * * *", /minute 60 is out of range \(0-59\)/],
        ["* 24 * * *", /hour 24 is out of range/],
        ["* * 0 * *", /day of month 0 is out of range/],
        ["* * * 13 *", /month 13 is out of range/],
        ["* * * * 8", /day of week 8 is out of range/],
        ["*/0 * * * *", /step.*positive/],
        ["*/x * * * *", /step.*positive/],
        ["5-1 * * * *", /runs backwards/],
        ["1-2-3 * * * *", /isn't a valid range/],
        ["1,,2 * * * *", /empty list item/],
        ["abc * * * *", /"abc" isn't a valid minute/],
        ["* * * foo *", /"foo" isn't a valid month .*like feb/],
        ["@reboot", /Unknown cron shortcut/],
        ["0 0 30 2 *", /never runs: no chosen month has day 30/],
        ["0 0 31 4,6,9,11 *", /never runs/],
        ["1/2/3 * * * *", /more than one step/],
    ];
    for (const [expr, why] of bad) {
        test(`refuses ${JSON.stringify(expr)}`, () => {
            expect(() => parseCron(expr)).toThrow(CronError);
            expect(() => parseCron(expr)).toThrow(why);
        });
    }
});

describe("nextRun", () => {
    test("strictly after, to the next minute", () => {
        expect(next("* * * * *", at(2026, 10, 20, 9, 0))).toBe("2026-10-20 09:01");
        expect(next("* * * * *", at(2026, 10, 20, 9, 0) + 30_000)).toBe("2026-10-20 09:01");
        expect(next("0 9 * * *", at(2026, 10, 20, 9, 0))).toBe("2026-10-21 09:00");
        expect(next("0 9 * * *", at(2026, 10, 20, 8, 59))).toBe("2026-10-20 09:00");
    });

    test("steps and every few minutes", () => {
        expect(runs("*/5 * * * *", at(2026, 10, 20, 9, 2), 3)).toEqual(["2026-10-20 09:05", "2026-10-20 09:10", "2026-10-20 09:15"]);
        expect(runs("7 * * * *", at(2026, 10, 20, 23, 30), 2)).toEqual(["2026-10-21 00:07", "2026-10-21 01:07"]);
    });

    test("across a month and a year", () => {
        expect(next("0 0 1 * *", at(2026, 12, 15))).toBe("2027-01-01 00:00");
        expect(next("30 23 31 * *", at(2026, 11, 1))).toBe("2026-12-31 23:30");
        expect(next("0 12 * feb *", at(2026, 3, 1))).toBe("2027-02-01 12:00");
    });

    test("Feb 29 waits for a leap year", () => {
        expect(next("0 0 29 2 *", at(2026, 3, 1))).toBe("2028-02-29 00:00");
    });

    test("weekdays", () => {
        // 2026-10-23 is a Friday.
        expect(runs("0 9 * * 1-5", at(2026, 10, 23, 10), 2)).toEqual(["2026-10-26 09:00", "2026-10-27 09:00"]);
        expect(next("0 9 * * 0", at(2026, 10, 23))).toBe("2026-10-25 09:00");
    });

    test("both day fields restricted: either one matching counts", () => {
        // The 1st of the month, or any Monday. 2026-10-20 is a Tuesday.
        expect(runs("0 0 1 * 1", at(2026, 10, 20), 3)).toEqual(["2026-10-26 00:00", "2026-11-01 00:00", "2026-11-02 00:00"]);
    });

    test("only one day field restricted: just that one", () => {
        expect(next("0 0 15 * *", at(2026, 10, 20))).toBe("2026-11-15 00:00");
        expect(next("0 0 * * 3", at(2026, 10, 20))).toBe("2026-10-21 00:00");
    });

    test("one-shot pinned to a date", () => {
        expect(next("30 14 21 10 *", at(2026, 10, 20))).toBe("2026-10-21 14:30");
        // Past this year's: next year's.
        expect(next("30 14 19 10 *", at(2026, 10, 20))).toBe("2027-10-19 14:30");
    });

    test("spring forward: a time in the gap runs at the first minute after it, once", () => {
        // 2026-03-08 02:00 EST jumps to 03:00 EDT in New York.
        expect(runs("30 2 * * *", at(2026, 3, 7, 12), 3)).toEqual(["2026-03-08 03:00", "2026-03-09 02:30", "2026-03-10 02:30"]);
        // Every few minutes just carries on after the gap.
        expect(runs("*/20 * * * *", at(2026, 3, 8, 1, 30), 4)).toEqual(["2026-03-08 01:40", "2026-03-08 03:00", "2026-03-08 03:20", "2026-03-08 03:40"]);
        // A time after the gap isn't moved.
        expect(next("15 3 * * *", at(2026, 3, 8, 0))).toBe("2026-03-08 03:15");
    });

    test("fall back: a fixed time in the repeated hour runs once; intervals keep going", () => {
        // 2026-11-01 02:00 EDT goes back to 01:00 EST.
        const daily = runs("30 1 * * *", at(2026, 10, 31, 12), 2);
        expect(daily).toEqual(["2026-11-01 01:30", "2026-11-02 01:30"]);
        // Hourly at :30 runs in both 1 o'clocks, an hour apart.
        const c = parseCron("30 * * * *");
        const first = nextRun(c, at(2026, 11, 1, 0, 45))!;
        const second = nextRun(c, first)!;
        expect(local(first)).toBe("2026-11-01 01:30");
        expect(local(second)).toBe("2026-11-01 01:30");
        expect(second - first).toBe(3_600_000);
        expect(local(nextRun(c, second))).toBe("2026-11-01 02:30");
    });

    test("fall back: hourly by range, or every few minutes in a fixed hour, keeps running through the repeat", () => {
        const all = runs("0 0-23 * * *", at(2026, 11, 1, 0, 30), 3);
        expect(all).toEqual(["2026-11-01 01:00", "2026-11-01 01:00", "2026-11-01 02:00"]);
        const quarter = runs("*/15 1 * * *", at(2026, 11, 1, 0, 50), 8);
        expect(quarter.length).toBe(8);
        expect(quarter.every((r) => r.startsWith("2026-11-01 01:"))).toBe(true);
    });

    test("half-hour daylight saving (Lord Howe): a daily time in the repeated half hour runs once; one in the gap runs once after it", () => {
        process.env.TZ = "Australia/Lord_Howe";
        try {
            // 2026-04-05 02:00 LHDT (+11) goes back to 01:30 LHST (+10:30): 01:30-01:59 happen twice.
            const daily = parseCron("45 1 * * *");
            const first = nextRun(daily, at(2026, 4, 4, 12))!;
            expect(new Date(first).toISOString()).toBe("2026-04-04T14:45:00.000Z");
            const second = nextRun(daily, first)!;
            expect(local(second)).toBe("2026-04-06 01:45");
            // Hourly at :45 isn't a fixed time: it runs in both, half an hour apart.
            const hourly = parseCron("45 * * * *");
            const h2 = nextRun(hourly, first)!;
            expect(local(h2)).toBe("2026-04-05 01:45");
            expect(h2 - first).toBe(30 * 60_000);
            // 2026-10-04 02:00 LHST jumps to 02:30 LHDT: 02:15 runs at 02:30, once.
            expect(runs("15 2 * * *", at(2026, 10, 3, 12), 2)).toEqual(["2026-10-04 02:30", "2026-10-05 02:15"]);
        } finally {
            process.env.TZ = "America/New_York";
        }
    });

    test("never matching within 5 years: undefined", () => {
        // Feb 29 on a Monday only, restricted both ways, still matches Feb 29 or Mondays in Feb: fine.
        expect(nextRun(parseCron("0 0 29 2 1"), at(2026, 3, 1))).toBeDefined();
    });

    test("a scan is quick even for rare schedules", () => {
        const c = parseCron("0 0 29 2 *");
        const t0 = performance.now();
        for (let i = 0; i < 200; i++) nextRun(c, at(2026, 3, 1));
        expect((performance.now() - t0) / 200).toBeLessThan(5);
    });
});

describe("describeCron", () => {
    const cases: [string, string][] = [
        ["* * * * *", "every minute"],
        ["*/5 * * * *", "every 5 minutes"],
        ["7 * * * *", "hourly at :07"],
        ["3 */2 * * *", "every 2 hours at :03"],
        ["57 8 * * *", "daily at 8:57 AM"],
        ["0 13 * * 1-5", "weekdays at 1:00 PM"],
        ["0 0 * * 0,6", "weekends at 12:00 AM"],
        ["15 9 * * 1,3", "Mon, Wed at 9:15 AM"],
        ["0 9 1 * *", "monthly on day 1 at 9:00 AM"],
        ["*/7 * * * *", "*/7 * * * *"],
        ["0 9 * 1 *", "0 9 * 1 *"],
    ];
    for (const [expr, words] of cases) test(`${expr} → ${words}`, () => expect(describeCron(parseCron(expr))).toBe(words));
});
