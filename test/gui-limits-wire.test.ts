// Plan limits as the window gets them (src/server/timeline.ts fromWireLimits): the server sends every unset field as
// null (wireReplacer); read back, they're unset again, so the meter says nothing of what it wasn't told.

import { expect, test } from "bun:test";
import { fromWireLimits, wireReplacer } from "../src/server/timeline";
import { meterOf, windowLine } from "../gui/src/lib/limits";
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
