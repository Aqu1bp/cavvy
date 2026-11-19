// What an unseen browser tab does next (desktop-electron/src/tab-rest.ts): frozen once idle, but one playing sound only
// hidden, so it goes on playing without being drawn.
import { expect, test } from "bun:test";
import { BUSY_ASLEEP_PERCENT, nextRest, REST_AFTER_MS, type TabLook } from "../desktop-electron/src/tab-rest";

const idle: TabLook = { rest: "awake", closed: false, unfreezable: false, onScreen: false, idleMs: REST_AFTER_MS, loading: false, audible: false, cpuPercent: 0 };

test("a quiet tab unseen and unused for a while is frozen", () => {
    expect(nextRest(idle)).toBe("freeze");
    expect(nextRest({ ...idle, idleMs: REST_AFTER_MS - 1 })).toBe("none");
});

test("one playing sound is only hidden, once, and frozen when it goes quiet", () => {
    expect(nextRest({ ...idle, audible: true })).toBe("hide");
    expect(nextRest({ ...idle, audible: true, rest: "hidden" })).toBe("none");
    expect(nextRest({ ...idle, audible: false, rest: "hidden" })).toBe("freeze");
});

test("a hidden tab playing sound isn't put back to sleep for being busy", () => {
    expect(nextRest({ ...idle, audible: true, rest: "hidden", cpuPercent: 40 })).toBe("none");
});

test("on screen, closed, loading or refused freezing: left alone", () => {
    for (const t of [{ onScreen: true }, { closed: true }, { loading: true }, { unfreezable: true }]) {
        expect(nextRest({ ...idle, ...t })).toBe("none");
        expect(nextRest({ ...idle, audible: true, ...t })).toBe("none");
    }
});

test("a frozen tab drawn again is put back to sleep; a still one is left", () => {
    expect(nextRest({ ...idle, rest: "frozen", cpuPercent: BUSY_ASLEEP_PERCENT + 0.5 })).toBe("resleep");
    expect(nextRest({ ...idle, rest: "frozen", cpuPercent: 0.2 })).toBe("none");
    expect(nextRest({ ...idle, rest: "frozen", cpuPercent: 50, onScreen: true })).toBe("none");
});

test("the wait can be shortened for checks", () => {
    expect(nextRest({ ...idle, idleMs: 600 }, 500)).toBe("freeze");
    expect(nextRest({ ...idle, idleMs: 400 }, 500)).toBe("none");
});
