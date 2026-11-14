import { expect, test } from "bun:test";
import { splitPair, clampSplitRatio } from "../gui/src/lib/session-split";
test("a third session replaces only the last addition", () => {
    const pair = splitPair("first", "second");
    expect(pair).toEqual(["first", "second"]);
    expect(splitPair("second", "third", pair)).toEqual(["first", "third"]);
});
test("dropping either visible session is a no-op", () => {
    expect(splitPair("first", "first")).toBeUndefined();
    const pair = splitPair("first", "second");
    expect(splitPair("first", "first", pair)).toBe(pair);
    expect(splitPair("second", "second", pair)).toBe(pair);
    expect(splitPair("second", "first", pair)).toBe(pair);
});

test("divider keeps room for both chats and recovers at narrow widths", () => {
    expect(clampSplitRatio(0.1, 1000)).toBe(0.32);
    expect(clampSplitRatio(0.9, 1000)).toBeCloseTo(0.68);
    expect(clampSplitRatio(0.6, 1000)).toBe(0.6);
    expect(clampSplitRatio(0.9, 600)).toBe(0.5);
    expect(clampSplitRatio(0.7, 0)).toBe(0.5);
    expect(clampSplitRatio(NaN, 1000)).toBe(0.5);
});
