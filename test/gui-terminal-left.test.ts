// A window's shells on a server, after the window is gone (the app quit and reopened): the next window to reach that
// server takes its tabs and the key they're its under there, once, while the server still keeps the shells
// (gui/src/lib/terminal.ts leaveTabs, takeLeftTabs, keyOn).
import { beforeEach, expect, test } from "bun:test";

const stores = () => {
    const make = () => {
        const m = new Map<string, string>();
        return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; }, clear: () => m.clear() };
    };
    return { session: make(), local: make() };
};
const s = stores();
Object.assign(globalThis, { sessionStorage: s.session, localStorage: s.local });
const { keyOn, leaveTabs, loadTabs, saveTabs, takeLeftTabs } = await import("../gui/src/lib/terminal");

const OLD = "a".repeat(32);
const NEW = "b".repeat(32);
const tabs = { tabs: [{ id: "t1", cwd: "/srv/app", number: 1, terminal: "t1" }], next: 2, open: true };
/** A new window: nothing of its own kept. */
const reopen = () => s.session.clear();

beforeEach(() => {
    s.session.clear();
    s.local.clear();
});

test("a window that goes leaves its server tabs; the next one takes them, once, and reaches that server by the old window's key", () => {
    saveTabs(tabs as never, "box");
    // This computer's own shells go with its Cavvy: nothing's left of them.
    saveTabs(tabs as never, "");
    leaveTabs(() => OLD, 1000);
    reopen();
    expect(keyOn("box", () => NEW)).toBe(NEW);
    takeLeftTabs("box", () => NEW, 2000);
    expect(loadTabs("box").tabs.map((t) => t.id)).toEqual(["t1"]);
    expect(keyOn("box", () => NEW)).toBe(OLD);
    expect(keyOn("lab", () => NEW)).toBe(NEW);
    expect(loadTabs("").tabs).toEqual([]);
    // Taken: another window opened after it gets none.
    reopen();
    takeLeftTabs("box", () => "c".repeat(32), 3000);
    expect([loadTabs("box").tabs.length, keyOn("box", () => "c".repeat(32))]).toEqual([0, "c".repeat(32)]);
});

test("not taken once the server would have let the shells go, nor by a window that has tabs there, nor by the same window after a reload", () => {
    saveTabs(tabs as never, "box");
    leaveTabs(() => OLD, 1000);
    reopen();
    takeLeftTabs("box", () => NEW, 1000 + 10 * 60_000 + 1);
    expect([loadTabs("box").tabs.length, keyOn("box", () => NEW), s.local.getItem("cavvy.terminals.left")]).toEqual([0, NEW, null]);
    // A window with its own tabs there keeps them, and its own key.
    saveTabs(tabs as never, "box");
    leaveTabs(() => OLD, 1000);
    saveTabs({ ...tabs, tabs: [{ ...tabs.tabs[0], id: "mine", terminal: "mine" }] } as never, "box");
    takeLeftTabs("box", () => NEW, 2000);
    expect([loadTabs("box").tabs.map((t) => t.id), keyOn("box", () => NEW)]).toEqual([["mine"], NEW]);
    // A reload: the window leaves word as it goes and is itself back, with what it had.
    s.session.clear();
    saveTabs(tabs as never, "box");
    leaveTabs(() => OLD, 1000);
    takeLeftTabs("box", () => OLD, 1500);
    expect([loadTabs("box").tabs.map((t) => t.id), keyOn("box", () => OLD), s.local.getItem("cavvy.terminals.left")]).toEqual([["t1"], OLD, null]);
});

test("what's left is read as carefully as what's saved: a key or tabs of another shape are not taken", () => {
    s.local.setItem("cavvy.terminals.left", JSON.stringify({ box: { key: "not-a-key", saved: tabs, at: 1000 }, lab: { key: OLD, saved: { tabs: "x" }, at: 1000 } }));
    takeLeftTabs("box", () => NEW, 1500);
    takeLeftTabs("lab", () => NEW, 1500);
    expect([keyOn("box", () => NEW), keyOn("lab", () => NEW), loadTabs("box").tabs.length, loadTabs("lab").tabs.length]).toEqual([NEW, NEW, 0, 0]);
});
