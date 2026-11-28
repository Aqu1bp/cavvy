// Where Tab goes at a dialog's edges (gui/src/lib/focus-trap.ts): it stays in
// the dialog, from its first and last items and from anything in it that isn't
// one (the dialog box, or a wrapper focused when it opened).

import { afterEach, describe, expect, test } from "bun:test";
import { focusMoved, takeFocus, tabWrap } from "../gui/src/lib/focus-trap";

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

// A field that comes once a dialog has loaded (takeFocus) takes the keyboard from what the dialog gave it first, never
// from where the user has put it.
describe("a field that comes later", () => {
    const before = (globalThis as { document?: unknown }).document;
    afterEach(() => void ((globalThis as { document?: unknown }).document = before));
    /** A dialog with Cancel in its footer and a field; `at` is what has the keyboard. */
    function dialog() {
        const doc = { body: {} as object, activeElement: null as object | null };
        const parents = new Map<object, object>();
        const node = (parent?: object): Record<string, unknown> => {
            const n: Record<string, unknown> = {
                isConnected: true,
                focus: () => void (doc.activeElement = n),
                closest: (sel: string) => {
                    for (let at: object | undefined = n; at; at = parents.get(at)) if ((at as { is?: string }).is === sel) return at;
                    return null;
                },
                contains: (other: object) => {
                    for (let at: object | undefined = other; at; at = parents.get(at)) if (at === n) return true;
                    return false;
                },
            };
            if (parent) parents.set(n, parent);
            return n;
        };
        const box = Object.assign(node(), { is: '[role="dialog"]' });
        const footer = Object.assign(node(box), { is: ".dialog-actions" });
        const cancel = node(footer), close = node(box), title = node(box);
        (globalThis as { document?: unknown }).document = doc;
        return { doc, box, cancel, close, title };
    }

    test("from the button the dialog gave it, or from nothing", () => {
        const d = dialog();
        (d.cancel.focus as () => void)();
        takeFocus(d.title as never);
        expect(d.doc.activeElement).toBe(d.title);
        d.doc.activeElement = d.doc.body;
        takeFocus(d.close as never);
        expect(d.doc.activeElement).toBe(d.close);
    });

    test("not once the user has moved it (Tab, a click), even onto the same button", () => {
        const d = dialog();
        (d.cancel.focus as () => void)();
        focusMoved(d.box as never);
        takeFocus(d.title as never);
        expect(d.doc.activeElement).toBe(d.cancel);
    });

    test("not from a field in the dialog", () => {
        const d = dialog();
        const other = d.close;
        (other.focus as () => void)();
        takeFocus(d.title as never);
        expect(d.doc.activeElement).toBe(other);
    });
});
