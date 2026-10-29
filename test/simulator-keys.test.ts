// Keys for the simulator's hardware keyboard (src/simulator/keys.ts): text typed key by key, presses with modifiers,
// and the GUI's keys by KeyboardEvent.code.
import { describe, expect, test } from "bun:test";
import { keyOfChar, strokesForPress, strokesForText, usageOfCode } from "../src/simulator/keys";

const SHIFT = 0xe1;

describe("typing text", () => {
    test("letters, digits and punctuation go key by key, Shift held for capitals and shifted symbols", () => {
        expect(strokesForText("a")).toEqual([[0x04, true], [0x04, false]]);
        expect(strokesForText("A")).toEqual([[SHIFT, true], [0x04, true], [0x04, false], [SHIFT, false]]);
        expect(strokesForText("1!")).toEqual([[0x1e, true], [0x1e, false], [SHIFT, true], [0x1e, true], [0x1e, false], [SHIFT, false]]);
        expect(keyOfChar("0")).toEqual({ usage: 0x27, shift: false });
        expect(keyOfChar("?")).toEqual({ usage: 0x38, shift: true });
        expect(keyOfChar("\n")).toEqual({ usage: 0x28, shift: false });
    });

    test("a line break is Enter, also from Windows line endings", () => {
        expect(strokesForText("a\r\nb")!.filter(([, down]) => down).map(([u]) => u)).toEqual([0x04, 0x28, 0x05]);
    });

    test("text a US keyboard can't type has no strokes (it's pasted instead)", () => {
        expect(strokesForText("café")).toBeUndefined();
        expect(strokesForText("👍")).toBeUndefined();
    });
});

describe("pressing a key", () => {
    test("by KeyboardEvent.code, by short name, or a letter; modifiers held around it and released in reverse", () => {
        expect(strokesForPress("Enter")).toEqual([[0x28, true], [0x28, false]]);
        expect(strokesForPress("return")).toEqual([[0x28, true], [0x28, false]]);
        expect(strokesForPress("ArrowDown")).toEqual([[0x51, true], [0x51, false]]);
        expect(strokesForPress("Meta+A")).toEqual([[0xe3, true], [0x04, true], [0x04, false], [0xe3, false]]);
        expect(strokesForPress("v", ["Meta", "Shift"])).toEqual([[0xe3, true], [0xe1, true], [0x19, true], [0x19, false], [0xe1, false], [0xe3, false]]);
    });

    test("a key or modifier the simulator has none of is refused", () => {
        expect(() => strokesForPress("Hyper")).toThrow(/no key "Hyper"/);
        expect(() => strokesForPress("Fn+A")).toThrow(/Unknown modifier "Fn"/);
        expect(() => strokesForPress("")).toThrow(/needs a key/);
    });

    test("the GUI's keys map by code; unknown codes map to nothing", () => {
        expect(usageOfCode("KeyZ")).toBe(0x1d);
        expect(usageOfCode("Digit0")).toBe(0x27);
        expect(usageOfCode("ShiftLeft")).toBe(SHIFT);
        expect(usageOfCode("F12")).toBe(0x45);
        expect(usageOfCode("MediaPlayPause")).toBeUndefined();
    });
});
