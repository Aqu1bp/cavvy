// Picking several sessions in the rail, as plain functions: clicks with and
// without modifiers, Shift+arrows, Select all, the one-list rule, and which
// actions a selection offers.
import { expect, test } from "bun:test";

const { bulkPlan, clickKind, clickSelect, extendSelect, NO_SELECTION, pruneSelection, railTargets, selectAll, sessionCount, sessionNames } = await import("../gui/src/lib/rail-select");
type RailList = "active" | "archived";

// As the rail shows them, across headings: a project's cards, another's, then Settled rows.
const order = ["a1", "a2", "b1", "b2", "s1", "s2"];
const active = (id: string): RailList | undefined => (order.includes(id) ? "active" : undefined);

test("a click's modifiers: Shift is a range; ⌘ toggles on a Mac, Ctrl elsewhere (Ctrl-click is a right click on a Mac)", () => {
    expect(clickKind({ shiftKey: true, metaKey: false, ctrlKey: false }, true)).toBe("range");
    expect(clickKind({ shiftKey: true, metaKey: true, ctrlKey: false }, true)).toBe("range");
    expect(clickKind({ shiftKey: false, metaKey: true, ctrlKey: false }, true)).toBe("toggle");
    expect(clickKind({ shiftKey: false, metaKey: false, ctrlKey: true }, true)).toBe("plain");
    expect(clickKind({ shiftKey: false, metaKey: false, ctrlKey: true }, false)).toBe("toggle");
    expect(clickKind({ shiftKey: false, metaKey: true, ctrlKey: false }, false)).toBe("plain");
    expect(clickKind({ shiftKey: false, metaKey: false, ctrlKey: false }, true)).toBe("plain");
});

test("a plain click clears the selection and anchors there", () => {
    const sel = { ids: ["a1", "a2", "b1"], anchor: "a1" };
    expect(clickSelect(sel, "b2", "plain", order, active)).toEqual({ ids: [], anchor: "b2" });
});

test("Shift-click selects from the anchor, either way round, across group headings", () => {
    // The anchor is the row last clicked plainly.
    const opened = clickSelect(NO_SELECTION, "a2", "plain", order, active);
    const down = clickSelect(opened, "s1", "range", order, active);
    expect(down).toEqual({ ids: ["a2", "b1", "b2", "s1"], anchor: "a2" });
    // A second Shift-click moves the far end, not the anchor.
    expect(clickSelect(down, "a1", "range", order, active)).toEqual({ ids: ["a1", "a2"], anchor: "a2" });
    // No anchor yet (or one no longer shown): the row itself.
    expect(clickSelect(NO_SELECTION, "b1", "range", order, active)).toEqual({ ids: ["b1"], anchor: "b1" });
    expect(clickSelect({ ids: [], anchor: "gone" }, "b1", "range", order, active)).toEqual({ ids: ["b1"], anchor: "b1" });
});

test("⌘-click adds a row or takes it out, and becomes the anchor", () => {
    let sel = clickSelect(NO_SELECTION, "a1", "toggle", order, active);
    expect(sel).toEqual({ ids: ["a1"], anchor: "a1" });
    sel = clickSelect(sel, "s2", "toggle", order, active);
    expect(sel).toEqual({ ids: ["a1", "s2"], anchor: "s2" });
    sel = clickSelect(sel, "a1", "toggle", order, active);
    expect(sel).toEqual({ ids: ["s2"], anchor: "a1" });
    // A range then starts from the row toggled last.
    expect(clickSelect(sel, "b1", "range", order, active).ids).toEqual(["a1", "a2", "b1"]);
});

test("one list at a time: a range skips the other list's rows, and ⌘-clicking one starts over", () => {
    // The active list can show an archived session that's open or waiting (and the archived list an active one).
    const mixed = ["x1", "a1", "a2", "x2", "a3"];
    const listOf = (id: string): RailList => (id.startsWith("x") ? "archived" : "active");
    const sel = clickSelect({ ids: [], anchor: "a1" }, "a3", "range", mixed, listOf);
    expect(sel.ids).toEqual(["a1", "a2", "a3"]);
    // ⌘-click on an archived one: a new selection of just it.
    const archived = clickSelect(sel, "x2", "toggle", mixed, listOf);
    expect(archived).toEqual({ ids: ["x2"], anchor: "x2" });
    // A Shift-click from an anchor in the other list starts at the row clicked.
    expect(clickSelect(archived, "a2", "range", mixed, listOf)).toEqual({ ids: ["a2"], anchor: "a2" });
    // Select all takes one list.
    expect(selectAll(mixed, "archived", listOf).ids).toEqual(["x1", "x2"]);
    expect(selectAll(mixed, "active", listOf).ids).toEqual(["a1", "a2", "a3"]);
});

test("Shift+arrows extend from the focused row; the anchor stays put; the ends stop", () => {
    let r = extendSelect(NO_SELECTION, "b1", 1, order, active)!;
    expect(r).toEqual({ sel: { ids: ["b1", "b2"], anchor: "b1" }, focus: "b2" });
    r = extendSelect(r.sel, r.focus, 1, order, active)!;
    expect(r.sel.ids).toEqual(["b1", "b2", "s1"]);
    // Back up past the anchor: the range flips.
    r = extendSelect(r.sel, "s1", -1, order, active)!;
    r = extendSelect(r.sel, r.focus, -1, order, active)!;
    r = extendSelect(r.sel, r.focus, -1, order, active)!;
    expect(r).toEqual({ sel: { ids: ["a2", "b1"], anchor: "b1" }, focus: "a2" });
    expect(extendSelect(r.sel, "a1", -1, order, active)).toBeUndefined();
    expect(extendSelect(r.sel, "s2", 1, order, active)).toBeUndefined();
    // Over a row of the other list to the next of its own.
    const listOf = (id: string): RailList => (id === "x" ? "archived" : "active");
    expect(extendSelect(NO_SELECTION, "a", 1, ["a", "x", "b"], listOf)?.sel.ids).toEqual(["a", "b"]);
});

test("rows the rail no longer shows leave the selection; an unchanged one is the same object", () => {
    const sel = { ids: ["a1", "b1", "s1"], anchor: "s1" };
    expect(pruneSelection(sel, order)).toBe(sel);
    expect(pruneSelection(sel, ["a1", "b1"])).toEqual({ ids: ["a1", "b1"], anchor: undefined });
});

test("keys act on the selection, else the focused row, else the open session", () => {
    expect(railTargets({ ids: ["a1", "b1"] }, "s1", "s2", order)).toEqual(["a1", "b1"]);
    expect(railTargets(NO_SELECTION, "s1", "s2", order)).toEqual(["s1"]);
    expect(railTargets(NO_SELECTION, undefined, "s2", order)).toEqual(["s2"]);
    // The open session counts only when the rail shows it.
    expect(railTargets(NO_SELECTION, undefined, "elsewhere", order)).toEqual([]);
});

test("a selection offers only what applies: Settle for ones in play, Back in play when all are settled, Restore for archived ones", () => {
    const s = (id: string, settled = false, archived = false) => ({ id, settled, archived });
    expect(bulkPlan([s("a"), s("b", true)])).toEqual({ list: "active", settle: ["a"], unsettle: [], archive: ["a", "b"], restore: [], delete: ["a", "b"] });
    expect(bulkPlan([s("a", true), s("b", true)])).toEqual({ list: "active", settle: [], unsettle: ["a", "b"], archive: ["a", "b"], restore: [], delete: ["a", "b"] });
    expect(bulkPlan([s("a", false, true), s("b", true, true)])).toEqual({ list: "archived", settle: [], unsettle: [], archive: [], restore: ["a", "b"], delete: ["a", "b"] });
});

test("counts and names for toasts and the dialog", () => {
    expect(sessionCount(1)).toBe("1 session");
    expect(sessionCount(5)).toBe("5 sessions");
    expect(sessionNames(["A"])).toBe("“A”");
    expect(sessionNames(["A", "B"])).toBe("“A” and “B”");
    expect(sessionNames(["A", "B", "C"])).toBe("“A”, “B” and “C”");
    expect(sessionNames(["A", "B", "C", "D", "E"])).toBe("“A”, “B” and 3 more");
});
