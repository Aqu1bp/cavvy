import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "../src/server/protocol";
import { isSnoozed, sidebarEntries, sidebarIds } from "../gui/src/lib/session-order";
import { customProblem, fromLocalInput, localInput, snoozeChoices } from "../gui/src/lib/snooze";
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

    test("past 6 pm, tonight is three hours on; on a Monday, next week is the Monday after; Sunday's is the next day", () => {
        const evening = at(2026, 11, 18, 19, 15);
        expect(snoozeChoices(evening)[1]!.at).toBe(evening + 3 * HOUR);
        // Under 2 hours before 6 pm: 3 hours on, after "1 hour", not before it.
        const late = at(2026, 11, 18, 17) + 11 * 60_000;
        expect(snoozeChoices(late)[1]!.at).toBe(late + 3 * HOUR);
        expect(snoozeChoices(at(2026, 11, 18, 16))[1]!.at).toBe(at(2026, 11, 18, 18));
        expect(snoozeChoices(at(2026, 11, 23, 10))[3]!.at).toBe(at(2026, 11, 30, 9));
        expect(snoozeChoices(at(2026, 11, 22, 10))[3]!.at).toBe(at(2026, 11, 23, 9));
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
