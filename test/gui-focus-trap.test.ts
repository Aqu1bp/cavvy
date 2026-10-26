// Where Tab goes at a dialog's edges (gui/src/lib/focus-trap.ts): it stays in
// the dialog, from its first and last items and from anything in it that isn't
// one (the dialog box, or a wrapper focused when it opened).

import { expect, test } from "bun:test";
import { tabWrap } from "../gui/src/lib/focus-trap";

const [first, middle, last, box, outside] = ["first", "middle", "last", "box", "outside"];
const items = [first, middle, last];

test("between items, Tab is left to the browser", () => {
    expect(tabWrap(items, first, true, false)).toBeUndefined();
    expect(tabWrap(items, middle, true, true)).toBeUndefined();
});

test("past the last, back to the first; before the first, round to the last", () => {
    expect(tabWrap(items, last, true, false)).toBe(first);
    expect(tabWrap(items, first, true, true)).toBe(last);
});

test("from something in the dialog that isn't an item, as from the box", () => {
    expect(tabWrap(items, box, true, true)).toBe(last);
    expect(tabWrap(items, box, true, false)).toBe(first);
});

test("from outside the dialog, back into it", () => {
    expect(tabWrap(items, outside, false, false)).toBe(first);
    expect(tabWrap(items, null, false, true)).toBe(last);
});
