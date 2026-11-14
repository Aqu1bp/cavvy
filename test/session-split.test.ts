import { expect, test } from "bun:test";
import { splitPair } from "../gui/src/lib/session-split";
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
