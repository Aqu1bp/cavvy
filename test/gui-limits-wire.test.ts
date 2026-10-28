// Plan limits as the window gets them (src/server/timeline.ts fromWireLimits): the server sends every unset field as
// null (wireReplacer); read back, they're unset again, so the meter says nothing of what it wasn't told.

import { expect, test } from "bun:test";
import { fromWireLimits, wireReplacer } from "../src/server/timeline";
import { liftsAt, meterOf, windowCaption, windowLine } from "../gui/src/lib/limits";
import type { PlanLimits } from "../src/server/protocol";

const now = Date.UTC(2026, 9, 28, 9, 0);
const overWire = (l: PlanLimits) => JSON.parse(JSON.stringify(l, wireReplacer)) as PlanLimits;

test("a limit restored after a restart (no percentage) reads as reached, not as null%", () => {
    const limits: PlanLimits = { provider: "claude-code", accountId: "default", windows: [{ id: "five_hour", label: "5-hour", usedPercent: undefined, resetsAt: now + 3_600_000, reached: true }], reached: true, resetsAt: now + 3_600_000, credits: undefined, at: now - 60_000 };
    const wire = overWire(limits);
    expect(wire.windows[0]!.usedPercent).toBeNull();
    // As it came off the wire, the meter said "5-hour null% reached".
    expect(windowLine(meterOf(wire, now)!.windows[0]!)).toContain("null%");

    const back = fromWireLimits(wire);
    expect("usedPercent" in back.windows[0]!).toBe(false);
    expect("credits" in back).toBe(false);
    const meter = meterOf(back, now)!;
    expect(meter.reached).toBe(true);
    expect(windowLine(meter.windows[0]!)).toStartWith("5-hour reached · resets ");
});

test("a window with no reset time isn't taken for one that has reset (which read as an old report)", () => {
    const limits: PlanLimits = { provider: "codex", accountId: "default", windows: [{ id: "codex:primary", label: "5-hour", usedPercent: 40, resetsAt: undefined }], at: now - 60_000 };
    expect(meterOf(overWire(limits), now)!.asOf).toBeDefined();
    const meter = meterOf(fromWireLimits(overWire(limits)), now)!;
    expect(meter.asOf).toBeUndefined();
    expect(windowLine(meter.windows[0]!)).toBe("5-hour 40%");
});

test("Usage's caption for a window: its percentage, or Reached when it's reached and wasn't given one", () => {
    expect(windowCaption({ pct: 100, reached: true, resets: "3:40 PM, in 1h 6m" })).toBe("100% reached, resets 3:40 PM, in 1h 6m");
    expect(windowCaption({ pct: 38, reached: false, resets: "Fri" })).toBe("38%, resets Fri");
    expect(windowCaption({ reached: true, resets: "3:40 PM, in 1h 6m" })).toBe("Reached, resets 3:40 PM, in 1h 6m");
    expect(windowCaption({ reached: false })).toBe("Not reported");
});

test("a reached plan's summary says when it lifts, unless its one reached window already does", () => {
    const at = "3:40 PM, in 1h 6m";
    const fiveHour = { label: "5-hour", pct: 100, reached: true, resets: at };
    const weekly = { label: "Weekly", pct: 38, reached: false, resets: "Fri" };
    expect(liftsAt({ resets: at, windows: [fiveHour, weekly] })).toBeUndefined();
    // Two reached: the plan lifts with the later one, which the summary says.
    expect(liftsAt({ resets: "Fri 9:00 AM, in 2d", windows: [fiveHour, { ...weekly, pct: 100, reached: true, resets: "Fri 9:00 AM, in 2d" }] })).toBe("Fri 9:00 AM, in 2d");
    // Reached with no window to show it (credits, say).
    expect(liftsAt({ resets: at, windows: [weekly] })).toBe(at);
    expect(liftsAt({ resets: undefined, windows: [fiveHour] })).toBeUndefined();
});
