import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "../src/server/protocol";
import { isSnoozed, sidebarEntries, sidebarIds } from "../gui/src/lib/session-order";
import { customProblem, fromLocalInput, localInput, nextMorning, snoozeChoices } from "../gui/src/lib/snooze";
import { wakeTime } from "../gui/src/lib/format";

const HOUR = 3_600_000;
const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("snooze times, in the window's time zone", () => {
    test("in the afternoon: an hour, 6 pm, tomorrow 9 am, Monday 9 am", () => {
        // A Wednesday.
        const now = at(2026, 11, 18, 14, 30);
        expect(snoozeChoices(now).map((c) => [c.label, c.at])).toEqual([
            ["1 hour", now + HOUR],
            ["Tonight", at(2026, 11, 18, 18)],
            ["Tomorrow morning", at(2026, 11, 19, 9)],
            ["Next week", at(2026, 11, 23, 9)],
        ]);
    });

    test("tonight is 9 pm once 6 pm is under 2 hours away, and isn't offered later; on a Monday, next week is the Monday after; Sunday's is the next day", () => {
        const pick = (now: number, label: string) => snoozeChoices(now).find((c) => c.label === label)?.at;
        expect(pick(at(2026, 11, 18, 16), "Tonight")).toBe(at(2026, 11, 18, 18));
        // 5:11 pm: 6 pm would come before "1 hour" is up.
        expect(pick(at(2026, 11, 18, 17, 11), "Tonight")).toBe(at(2026, 11, 18, 21));
        expect(pick(at(2026, 11, 18, 19), "Tonight")).toBe(at(2026, 11, 18, 21));
        expect(pick(at(2026, 11, 18, 19, 15), "Tonight")).toBeUndefined();
        expect(snoozeChoices(at(2026, 11, 18, 23, 30)).map((c) => c.label)).toEqual(["1 hour", "Tomorrow morning", "Next week"]);
        expect(pick(at(2026, 11, 23, 10), "Next week")).toBe(at(2026, 11, 30, 9));
        expect(pick(at(2026, 11, 22, 10), "Next week")).toBe(at(2026, 11, 23, 9));
    });

    test("in the small hours: this morning and this evening, in order; from 7 am, the day's own", () => {
        // A Thursday.
        const now = at(2026, 11, 26, 0, 30);
        expect(snoozeChoices(now).map((c) => [c.label, c.at])).toEqual([
            ["1 hour", now + HOUR],
            ["This morning", at(2026, 11, 26, 9)],
            ["This evening", at(2026, 11, 26, 18)],
            ["Next week", at(2026, 11, 30, 9)],
        ]);
        expect(snoozeChoices(at(2026, 11, 26, 7)).map((c) => c.label)).toEqual(["1 hour", "This morning", "This evening", "Next week"]);
        expect(snoozeChoices(at(2026, 11, 26, 7, 1)).map((c) => c.label)).toEqual(["1 hour", "Tonight", "Tomorrow morning", "Next week"]);
        // The day is the label's: the hint is the time alone.
        const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        expect(snoozeChoices(now).slice(1, 3).map((c) => c.hint)).toEqual([time(at(2026, 11, 26, 9)), time(at(2026, 11, 26, 18))]);
        // Custom… starts at the next morning the menu offers.
        expect(nextMorning(now)).toBe(at(2026, 11, 26, 9));
        expect(nextMorning(at(2026, 11, 26, 7, 1))).toBe(at(2026, 11, 27, 9));
    });

    test("over the end of a month", () => {
        expect(snoozeChoices(at(2026, 11, 30, 12))[2]!.at).toBe(at(2026, 12, 1, 9));
    });

    test("when it wakes, in words: one way in the row, its tooltip, the menu and the toast", () => {
        const now = at(2026, 11, 18, 14, 30);
        const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        expect(wakeTime(at(2026, 11, 18, 18), now)).toBe(time(at(2026, 11, 18, 18)));
        expect(wakeTime(at(2026, 11, 19, 9), now)).toBe(`Tomorrow ${time(at(2026, 11, 19, 9))}`);
        expect(wakeTime(at(2026, 11, 19, 9), now, true)).toBe(`tomorrow ${time(at(2026, 11, 19, 9))}`);
        expect(wakeTime(at(2026, 11, 23, 9), now)).toBe(`${new Date(at(2026, 11, 23, 9)).toLocaleDateString([], { weekday: "short" })} ${time(at(2026, 11, 23, 9))}`);
        expect(wakeTime(at(2026, 12, 25, 9), now)).toBe(`${new Date(at(2026, 12, 25, 9)).toLocaleDateString([], { month: "short", day: "numeric" })}, ${time(at(2026, 12, 25, 9))}`);
        // The menu says it the same, but for the day Tomorrow morning names already.
        expect(snoozeChoices(now).map((c) => c.hint)).toEqual([wakeTime(now + HOUR, now), wakeTime(at(2026, 11, 18, 18), now), time(at(2026, 11, 19, 9)), wakeTime(at(2026, 11, 23, 9), now)]);
    });

    test("a custom time: the field's format both ways, and what's refused", () => {
        const t = at(2026, 11, 19, 9, 5);
        expect(localInput(t)).toBe("2026-11-19T09:05");
        expect(fromLocalInput("2026-11-19T09:05")).toBe(t);
        expect(fromLocalInput("")).toBeUndefined();
        const now = at(2026, 11, 18, 14);
        expect(customProblem(undefined, now)).toBe("Choose a date and time.");
        expect(customProblem(now - 1, now)).toBe("Choose a time in the future.");
        expect(customProblem(now + 400 * 24 * HOUR, now)).toBe("Choose a time within a year.");
        expect(customProblem(t, now)).toBeUndefined();
    });
});

const row = (id: string, o: Partial<SessionSummary> = {}): SessionSummary => ({
    id, cwd: "/p", projectName: "p", title: id, createdAt: 1, updatedAt: 1, messages: 1, status: "idle", pinned: false, archived: false, settled: false, live: false, ...o,
});
const opts = { groupBy: "date" as const, archived: false, settledOpen: true, cards: 25, settled: 25, archive: 25 };

describe("the Snoozed shelf", () => {
    const sessions = [
        row("awake", { updatedAt: 5 }),
        row("later", { snoozedUntil: 300 }),
        row("sooner", { snoozedUntil: 200, settled: true }),
        row("settled", { settled: true }),
        // Waiting on you: back in the list, whatever the server says.
        row("asks", { snoozedUntil: 100, status: "waiting" }),
    ];

    test("snoozed ones leave the list (and Settled) for Snoozed, folded, above Settled", () => {
        const entries = sidebarEntries(sessions, [], opts);
        expect(entries.map((e) => e.kind)).toEqual(["card", "card", "snoozed", "settled", "row"]);
        expect(sidebarIds(entries)).toEqual(["asks", "awake", "settled"]);
        expect(isSnoozed(sessions[4]!)).toBe(false);
    });

    test("open, the next to wake first; folded, the open one still shows", () => {
        expect(sidebarIds(sidebarEntries(sessions, [], { ...opts, snoozedOpen: true }))).toEqual(["asks", "awake", "sooner", "later", "settled"]);
        expect(sidebarIds(sidebarEntries(sessions, [], { ...opts, activeId: "later" }))).toEqual(["asks", "awake", "later", "settled"]);
    });
});
