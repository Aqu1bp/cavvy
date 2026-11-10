// The desktop app's Browser pages are real ones, and a real page takes the window's focus when something in it is
// pressed or focused, whoever did it. The agent clicking in a page took the keyboard from the message box and the
// terminal: of 106 characters typed while it clicked, 17 arrived, and the rest pressed the page's buttons.
// gui/src/lib/page-focus.ts gives the focus back; the app says who acted (desktop-electron/src/browser-host.ts).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { AGENT_FOCUS_MS, agentTookFocus, keepFocus, PERSON_AFTER_MS } from "../gui/src/lib/page-focus";

// The browser's side only: elements that take and lose focus, and a window that hears of it.
class El {
    isConnected = true;
    dataset: Record<string, string> = {};
    calls: string[] = [];
    constructor(public tagName: string, key?: string) { if (key) this.dataset.key = key; }
    focus() { this.calls.push("focus"); }
    blur() { this.calls.push("blur"); }
}
const real = (globalThis as any).HTMLElement;
beforeAll(() => { (globalThis as any).HTMLElement = El; });
afterAll(() => { (globalThis as any).HTMLElement = real; });

function page() {
    const listeners: Record<string, ((e: any) => void)[]> = {};
    const on = (type: string, fn: (e: any) => void) => void (listeners[type] ??= []).push(fn);
    const offs: string[] = [];
    const doc = { activeElement: undefined as El | undefined, addEventListener: on, removeEventListener: (type: string) => void offs.push(type) };
    const win = { document: doc, addEventListener: on, removeEventListener: (type: string) => void offs.push(type) };
    let tell: (e: any) => void = () => {};
    const stop = keepFocus({ onBrowser: (fn) => ((tell = fn), () => void offs.push("bridge")) }, win as any);
    const box = new El("TEXTAREA");
    const view = new El("WEBVIEW", "tab-1");
    return {
        box, view, tell, stop, offs,
        /** A page takes the window's focus from `from`: what the window hears, in the order it hears it. */
        taken(from: El | undefined, by = view) {
            if (from) for (const fn of listeners.focusout ?? []) fn({ target: from, relatedTarget: null });
            doc.activeElement = by;
            for (const fn of listeners.blur ?? []) fn({ target: win });
        },
        focusIn(el: El) { for (const fn of listeners.focusin ?? []) fn({ target: el }); },
    };
}
const at = (ms: number) => void (performance.now = () => ms);
const now = performance.now;
afterAll(() => { performance.now = now; });

test("a page that takes focus just after the agent acted on it gives it back to where the person was", () => {
    const p = page();
    at(1000); p.tell({ type: "agent", key: "tab-1" });
    at(1030); p.taken(p.box);
    expect(p.box.calls).toEqual(["focus"]);
    expect(p.view.calls).toEqual([]);
    // Again on the agent's next press, and for as long after it as a busy page may take to act on one.
    at(2000); p.tell({ type: "agent", key: "tab-1" });
    at(2000 + AGENT_FOCUS_MS); p.taken(p.box);
    expect(p.box.calls).toEqual(["focus", "focus"]);
});

test("nothing had focus in the window: the page just loses it, so shortcuts go on working", () => {
    const p = page();
    at(1000); p.tell({ type: "agent", key: "tab-1" });
    at(1010); p.taken(undefined);
    expect(p.view.calls).toEqual(["blur"]);
    // What lost focus to something else in the window earlier isn't where the person is now.
    const q = page();
    at(1000); q.tell({ type: "agent", key: "tab-1" });
    q.taken(q.box); q.focusIn(new El("INPUT"));
    q.box.calls.length = 0;
    at(1020); q.taken(undefined);
    expect([q.box.calls, q.view.calls]).toEqual([[], ["blur"]]);
    // Nor an element that's gone since.
    const r = page();
    at(1000); r.tell({ type: "agent", key: "tab-1" });
    r.box.isConnected = false;
    at(1010); r.taken(r.box);
    expect([r.box.calls, r.view.calls]).toEqual([[], ["blur"]]);
});

test("the person's own click in a page keeps the keyboard there", () => {
    // No agent at work.
    const p = page();
    at(1000); p.taken(p.box);
    expect([p.box.calls, p.view.calls]).toEqual([[], []]);
    // The agent acted, but a while ago.
    at(2000); p.tell({ type: "agent", key: "tab-1" });
    at(2001 + AGENT_FOCUS_MS); p.taken(p.box);
    expect(p.box.calls).toEqual([]);
    // The agent is at work and the person presses in the page: theirs.
    at(4000); p.tell({ type: "agent", key: "tab-1" });
    at(4010); p.tell({ type: "person", key: "tab-1" });
    at(4012); p.taken(p.box);
    expect(p.box.calls).toEqual([]);
    // Another tab's agent isn't this tab's.
    at(5000); p.tell({ type: "agent", key: "tab-2" });
    at(5010); p.taken(p.box);
    expect(p.box.calls).toEqual([]);
    // Focus leaving the window for anything else (another app) is none of this.
    at(6000); p.tell({ type: "agent", key: "tab-1" });
    at(6010); p.taken(p.box, new El("BODY"));
    expect(p.box.calls).toEqual([]);
});

test("the person's press and the agent's come together: the page is theirs once the app says so", () => {
    const p = page();
    at(1000); p.tell({ type: "agent", key: "tab-1" });
    // The page's focus is heard of before the person's press is: sent back, then given to them.
    at(1010); p.taken(p.box);
    expect(p.box.calls).toEqual(["focus"]);
    at(1010 + PERSON_AFTER_MS); p.tell({ type: "person", key: "tab-1" });
    expect(p.view.calls).toEqual(["focus"]);
    // And it stays theirs when it takes focus again for that.
    at(1300); p.taken(p.box);
    expect(p.box.calls).toEqual(["focus"]);
    // Too late to be the same press: not given.
    const q = page();
    at(1000); q.tell({ type: "agent", key: "tab-1" });
    at(1010); q.taken(q.box);
    at(1011 + PERSON_AFTER_MS); q.tell({ type: "person", key: "tab-1" });
    expect(q.view.calls).toEqual([]);
});

test("a closed tab is forgotten, and stopping stops listening", () => {
    const p = page();
    at(1000); p.tell({ type: "agent", key: "tab-1" });
    p.tell({ type: "destroy", key: "tab-1" });
    at(1010); p.taken(p.box);
    expect(p.box.calls).toEqual([]);
    p.stop();
    expect(p.offs.sort()).toEqual(["blur", "bridge", "focusin", "focusout"]);
});

test("the rule itself", () => {
    expect(agentTookFocus(1000, undefined, undefined)).toBe(false);
    expect(agentTookFocus(1000, 990, undefined)).toBe(true);
    expect(agentTookFocus(1000, 1000 - AGENT_FOCUS_MS, undefined)).toBe(true);
    expect(agentTookFocus(1000, 999 - AGENT_FOCUS_MS, undefined)).toBe(false);
    expect(agentTookFocus(1000, 990, 980)).toBe(true);
    expect(agentTookFocus(1000, 990, 990)).toBe(false);
    expect(agentTookFocus(1000, 990, 995)).toBe(false);
});

test("the app says when the agent acts on a tab, before and after the page takes the command, and when the person uses one", () => {
    const host = readFileSync(join(import.meta.dir, "../desktop-electron/src/browser-host.ts"), "utf8");
    const acting = host.slice(host.indexOf("const acting = input ||"), host.indexOf("switch (cmd.method)", host.indexOf("const acting = input ||")));
    // Told before the command goes to the page (the focus it takes must find the GUI knowing), and again after.
    expect(acting.indexOf("acted();")).toBeGreaterThan(0);
    expect(acting.indexOf("acted();")).toBeLessThan(acting.indexOf("await sendToTab("));
    expect(acting.lastIndexOf("acted();")).toBeGreaterThan(acting.indexOf("} finally {"));
    expect(acting).toContain('if (acting) this.toGui({ type: "agent", key: tab.key });');
    // A press, a key or a scroll of the person's in the page, never the agent's own input.
    const person = host.slice(host.indexOf("const person = (type: string) => {"), host.indexOf('wc.on("before-input-event"'));
    expect(person).toContain("if (tab.agentInputs > 0 || !PERSON_INPUT.has(type)) return;");
    expect(person).toContain('this.toGui({ type: "person", key });');
    // Loaded with the pages' layer, which only the desktop app has.
    expect(readFileSync(join(import.meta.dir, "../gui/src/components/BrowserHostLayer.tsx"), "utf8")).toContain('import("../lib/page-focus")');
});
