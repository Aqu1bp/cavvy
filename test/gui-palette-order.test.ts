import { expect, test } from "bun:test";
import { entryScore, groupSections, keepSelection, messagesShown } from "../gui/src/lib/palette-order";

const ORDER = ["Sessions", "Messages", "Actions"];
const e = (id: string, section: string) => ({ id, section });

test("results are grouped as sessions, messages, then actions, best match first inside each", () => {
    const scored = [e("a1", "Actions"), e("s1", "Sessions"), e("a2", "Actions"), e("s2", "Sessions"), e("m1", "Messages")];
    expect(groupSections(scored, ORDER).map((x) => x.id)).toEqual(["s1", "s2", "m1", "a1", "a2"]);
});

test("each section shows once, and sections not named follow in the order they first appear", () => {
    const scored = [e("t1", "Theme"), e("a1", "Actions"), e("p1", "Projects"), e("t2", "Theme"), e("s1", "Sessions")];
    const out = groupSections(scored, ORDER);
    expect(out.map((x) => x.id)).toEqual(["s1", "a1", "t1", "t2", "p1"]);
    const headings = out.map((x) => x.section).filter((s, i, all) => s !== all[i - 1]);
    expect(headings).toEqual(["Sessions", "Actions", "Theme", "Projects"]);
});

test("the input isn't changed", () => {
    const scored = [e("a1", "Actions"), e("s1", "Sessions")];
    groupSections(scored, ORDER);
    expect(scored.map((x) => x.id)).toEqual(["a1", "s1"]);
});

test("a new query selects the first row", () => {
    expect(keepSelection([e("a", ""), e("b", "")], [e("b", ""), e("a", "")], 1, true)).toBe(0);
    expect(keepSelection(undefined, [e("a", "")], 3, false)).toBe(0);
});

test("message hits arriving above the selection don't move it off its entry", () => {
    const before = [e("s1", "Sessions"), e("a1", "Actions"), e("a2", "Actions")];
    const after = [e("s1", "Sessions"), e("m1", "Messages"), e("m2", "Messages"), e("a1", "Actions"), e("a2", "Actions")];
    expect(keepSelection(before, after, 2, false)).toBe(4);
});

test("when the selected entry is gone, the selection stays in place, inside the list", () => {
    const before = [e("a", ""), e("b", ""), e("c", "")];
    expect(keepSelection(before, [e("a", ""), e("c", "")], 1, false)).toBe(1);
    expect(keepSelection(before, [e("a", "")], 2, false)).toBe(0);
    expect(keepSelection(before, [], 2, false)).toBe(0);
});

test("message hits: the first three when other results follow, all when asked or when they're all there is", () => {
    expect(messagesShown(12, 4, false)).toBe(3);
    expect(messagesShown(12, 4, true)).toBe(12);
    expect(messagesShown(12, 0, false)).toBe(12);
    // One more than three isn't worth a "Show more" row.
    expect(messagesShown(4, 4, false)).toBe(4);
    expect(messagesShown(2, 4, false)).toBe(2);
    expect(messagesShown(0, 4, false)).toBe(0);
});

test("an action's shortcut is searched too: '⌘ N' finds New session", () => {
    const newSession = { label: "New session", kbd: "⌘ N" };
    const settings = { label: "Settings", kbd: "⌘ ," };
    expect(entryScore("⌘ N", newSession)).toBeGreaterThan(0);
    expect(entryScore("⌘ N", newSession)).toBeGreaterThan(entryScore("⌘ N", settings));
    // The label still counts most, then keywords, then what's beside it.
    expect(entryScore("new", newSession)).toBeGreaterThan(entryScore("new", { label: "Open", keywords: "new" }));
    expect(entryScore("acme", { label: "Fix login", end: "acme · 2h" })).toBeGreaterThan(0);
    expect(entryScore("zzz", newSession)).toBe(0);
});
