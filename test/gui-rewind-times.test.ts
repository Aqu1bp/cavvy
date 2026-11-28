// The Rewind list's times (gui/src/lib/rewind-times.ts): as under each prompt, to the second only where the entry next
// to it would read the same.

import { expect, test } from "bun:test";
import { promptTime } from "../gui/src/lib/format";
import { promptTimeSeconds, rewindTimes } from "../gui/src/lib/rewind-times";

const now = new Date(2026, 10, 18, 12, 30).getTime();
const at = (h: number, m: number, s = 0, day = 18, year = 2026) => new Date(year, 10, day, h, m, s).getTime();

test("prompts sent in the same minute read to the second; the others as in the conversation", () => {
    const list = [at(12, 18, 5), at(12, 17, 40), at(12, 17, 22), at(12, 17, 3), at(11, 2)];
    const times = rewindTimes(list, now);
    expect(times[0]).toBe(promptTime(list[0]!, now));
    expect(times.slice(1, 4)).toEqual(list.slice(1, 4).map((ms) => promptTimeSeconds(ms, now)));
    expect(new Set(times.slice(1, 4)).size).toBe(3);
    expect(times[4]).toBe(promptTime(list[4]!, now));
    expect(times[1]).not.toBe(promptTime(list[1]!, now));
});

test("entries without a time are skipped, and don't count as neighbours", () => {
    const list = [at(12, 17, 40), undefined, at(12, 17, 3)];
    expect(rewindTimes(list, now)).toEqual([promptTime(list[0]!, now), undefined, promptTime(list[2]!, now)]);
});

test("on another day, the day stays with the seconds", () => {
    const list = [at(9, 5, 10, 17), at(9, 5, 50, 17)];
    const times = rewindTimes(list, now);
    expect(times[0]).toBe(promptTimeSeconds(list[0]!, now));
    expect(times[0]).toContain(new Intl.DateTimeFormat(undefined, { month: "short" }).format(list[0]!));
    expect(times[0]).not.toBe(times[1]);
});
