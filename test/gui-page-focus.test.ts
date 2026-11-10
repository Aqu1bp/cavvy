// The desktop app's Browser pages are real ones, and a real page takes the window's keyboard when something in it is
// pressed or focused, whoever did it. The agent clicking in a page took the keyboard from the message box and the
// terminal: of 106 characters typed while it clicked, 17 arrived, and the rest pressed the page's buttons. On macOS
// the window doesn't even show it: the message box keeps its caret.
// The app says when a page holds the keyboard after the agent acted on it, and keeps the person's keys out of the page
// meanwhile (desktop-electron/src/browser-host.ts); gui/src/lib/page-focus.ts takes the keyboard back.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { AGAIN_MS, ENTERED_MS, keepFocus, LEFT_MS, nextStep, STEP_MS } from "../gui/src/lib/page-focus";
import { strayKeyEvents, tabbedIn } from "../desktop-electron/src/guest-input";

// The browser's side only: elements that take and lose focus, and a window that hears of it.
class El {
    isConnected = true;
    dataset: Record<string, string> = {};
    calls: string[] = [];
    doc?: { activeElement: El | undefined; body: El };
    constructor(public tagName: string, key?: string) { if (key) this.dataset.key = key; }
    focus() { this.calls.push("focus"); if (this.doc) this.doc.activeElement = this; }
    blur() { this.calls.push("blur"); if (this.doc) this.doc.activeElement = this.doc.body; }
}
const real = (globalThis as any).HTMLElement;
beforeAll(() => { (globalThis as any).HTMLElement = El; });
afterAll(() => { (globalThis as any).HTMLElement = real; });
const now = performance.now;
const at = (ms: number) => void (performance.now = () => ms);
afterAll(() => { performance.now = now; });

function page() {
    const listeners: Record<string, ((e: any) => void)[]> = {};
    const on = (type: string, fn: (e: any) => void) => void (listeners[type] ??= []).push(fn);
    const offs: string[] = [];
    const body = new El("BODY");
    const box = new El("TEXTAREA");
    const view = new El("WEBVIEW", "tab-1");
    const doc = { activeElement: box as El | undefined, body, addEventListener: on, removeEventListener: (type: string) => void offs.push(type), querySelectorAll: () => [view] };
    for (const el of [body, box, view]) el.doc = doc;
    const win = { document: doc, addEventListener: on, removeEventListener: (type: string) => void offs.push(type) };
    let tell: (e: any) => void = () => {};
    /** What keepFocus has put off, for the test to run: [what, how long after]. */
    const later: { fn: () => void; ms: number }[] = [];
    const stop = keepFocus({ onBrowser: (fn) => ((tell = fn), () => void offs.push("bridge")) }, win as any, (fn, ms) => void later.push({ fn, ms }));
    const fire = (type: string, e: any) => { for (const fn of listeners[type] ?? []) fn({ stopImmediatePropagation() {}, preventDefault() {}, ...e }); };
    return {
        doc, box, view, body, win, stop, offs, fire, later,
        /** Runs what was put off for `ms`, as its time comes. */
        run(ms: number) { for (const l of later.splice(0)) if (l.ms === ms) l.fn(); else later.push(l); },
        tell: (e: any) => tell(e),
        /** The page takes the window's focus with the keys (where the window hears of it): the box loses it to nothing, then the window blurs. */
        taken() {
            fire("focusout", { target: box, relatedTarget: null });
            doc.activeElement = view;
            fire("blur", { target: win });
        },
    };
}

test("where the window's focus went to the page with the keys, it's moved back to where the person was", () => {
    const p = page();
    at(1000); p.taken();
    // Nothing yet: the app hasn't said the agent is at it (the person's own press in a page looks the same here).
    expect(p.box.calls).toEqual([]);
    at(1005); p.tell({ type: "focused", key: "tab-1" });
    expect(p.box.calls).toEqual(["focus"]);
    expect(p.doc.activeElement).toBe(p.box);
    // The page takes it again a moment later (it answers a press in steps): back at once, without the app's word.
    at(1020); p.taken();
    expect(p.box.calls).toEqual(["focus", "focus"]);
    // Long after the app last said so, the window's focus going to a page isn't taken for the agent's doing.
    at(1021 + AGAIN_MS); p.taken();
    expect(p.box.calls).toEqual(["focus", "focus"]);
});

test("where the window's focus never moved (macOS), it goes to the page first and back from there, a moment apart", () => {
    const p = page();
    // The page has the keys; the window still shows the message box focused. Focusing that again would change nothing.
    at(1000); p.tell({ type: "focused", key: "tab-1" });
    expect([p.view.calls, p.box.calls]).toEqual([["focus"], []]);
    // The app's next word comes too soon after: the page is still taking it.
    at(1000 + STEP_MS - 1); p.tell({ type: "focused", key: "tab-1" });
    expect([p.view.calls, p.box.calls]).toEqual([["focus"], []]);
    // Then back to where it was.
    at(1000 + STEP_MS); p.tell({ type: "focused", key: "tab-1" });
    expect([p.view.calls, p.box.calls]).toEqual([["focus"], ["focus"]]);
    expect(p.doc.activeElement).toBe(p.box);
    // Still the page's after that (it answered late): the same two steps again.
    at(1200); p.tell({ type: "focused", key: "tab-1" });
    at(1240); p.tell({ type: "focused", key: "tab-1" });
    expect([p.view.calls, p.box.calls]).toEqual([["focus", "focus"], ["focus", "focus"]]);
    // The app's last look brought the first step, so no word of its brings the second: taken here, a while after.
    const q = page();
    at(1320); q.tell({ type: "focused", key: "tab-1" });
    expect([q.view.calls, q.box.calls]).toEqual([["focus"], []]);
    at(1320 + ENTERED_MS); q.run(ENTERED_MS);
    expect([q.view.calls, q.box.calls]).toEqual([["focus"], ["focus"]]);
    expect(q.doc.activeElement).toBe(q.box);
    // Not when the app's word did bring it, nor once the window's focus is elsewhere (it would go into the page again), nor after stopping.
    at(1200 + ENTERED_MS); p.run(ENTERED_MS);
    expect([p.view.calls, p.box.calls]).toEqual([["focus", "focus"], ["focus", "focus"]]);
    const r = page();
    at(1000); r.tell({ type: "focused", key: "tab-1" });
    r.doc.activeElement = r.body;
    at(1000 + ENTERED_MS); r.run(ENTERED_MS);
    expect([r.view.calls, r.box.calls]).toEqual([["focus"], []]);
    const t = page();
    at(1000); t.tell({ type: "focused", key: "tab-1" });
    t.stop();
    at(1000 + ENTERED_MS); t.run(ENTERED_MS);
    expect([t.view.calls, t.box.calls]).toEqual([["focus"], []]);
});

test("nothing had the window's focus: the page just loses it, so shortcuts go on working", () => {
    const p = page();
    p.doc.activeElement = p.body;
    at(1000); p.tell({ type: "focused", key: "tab-1" });
    at(1040); p.tell({ type: "focused", key: "tab-1" });
    expect([p.view.calls, p.box.calls]).toEqual([["focus", "blur"], []]);
    // What lost focus long before isn't where the person is now; nor is something that's gone.
    const q = page();
    at(1000); q.fire("focusout", { target: q.box, relatedTarget: null });
    q.doc.activeElement = q.view;
    at(1001 + LEFT_MS); q.tell({ type: "focused", key: "tab-1" });
    expect([q.view.calls, q.box.calls]).toEqual([["blur"], []]);
    const r = page();
    at(1000); r.taken();
    r.box.isConnected = false;
    at(1005); r.tell({ type: "focused", key: "tab-1" });
    expect([r.view.calls, r.box.calls]).toEqual([["blur"], []]);
});

test("a page the person put the keyboard in themselves keeps it, until they're back in the window", () => {
    const p = page();
    // A press of theirs in the page.
    at(1000); p.tell({ type: "person", key: "tab-1", press: true });
    p.doc.activeElement = p.view;
    at(1010); p.tell({ type: "focused", key: "tab-1" });
    at(1050); p.tell({ type: "focused", key: "tab-1" });
    at(1060); p.taken();
    expect([p.view.calls, p.box.calls]).toEqual([[], []]);
    // Keys of theirs in a page aren't a press: typed while the agent held it, they'd say the page was theirs.
    const q = page();
    at(1000); q.tell({ type: "person", key: "tab-1", press: false });
    at(1005); q.tell({ type: "focused", key: "tab-1" });
    expect(q.view.calls).toEqual(["focus"]);
    // Escape (to stop the turn) just before the agent's click lands doesn't make the page theirs: only the app's word does.
    const r = page();
    at(1000); r.fire("keydown", { key: "Escape" });
    at(1100); r.taken();
    at(1105); r.tell({ type: "focused", key: "tab-1" });
    expect(r.box.calls).toEqual(["focus"]);
    // Back in the window by a key (Shift+Tab out of the page): the agent's next click doesn't keep the keyboard either.
    const t = page();
    at(1000); t.tell({ type: "person", key: "tab-1", press: true });
    t.doc.activeElement = t.view;
    at(1500); t.fire("focusin", { target: t.box, relatedTarget: null });
    t.doc.activeElement = t.box;
    at(2000); t.taken();
    at(2005); t.tell({ type: "focused", key: "tab-1" });
    expect(t.box.calls).toEqual(["focus"]);
    // Back in the window by a press: the agent's next click doesn't keep the keyboard.
    at(2000); p.fire("pointerdown", { target: p.box });
    p.doc.activeElement = p.box;
    at(2010); p.tell({ type: "focused", key: "tab-1" });
    expect(p.view.calls).toEqual(["focus"]);
    // Another tab's page isn't theirs because one is.
    const s = page();
    at(1000); s.tell({ type: "person", key: "tab-2", press: true });
    at(1005); s.tell({ type: "focused", key: "tab-1" });
    expect(s.view.calls).toEqual(["focus"]);
});

test("with nothing remembered as just left, the keyboard goes back to where the person last put it", () => {
    // macOS, a page taking it twice in a millisecond: the second time nothing had "just lost focus" to go back to,
    // and the keys stayed in the page until the app's next word 40ms later.
    const p = page();
    at(1000); p.fire("focusin", { target: p.box });
    p.doc.activeElement = p.view;
    at(5000); p.tell({ type: "focused", key: "tab-1" });
    expect([p.view.calls, p.box.calls]).toEqual([[], ["focus"]]);
    // Entered from nowhere (the window's focus was on nothing): still back to where they were.
    const q = page();
    at(1000); q.fire("focusin", { target: q.box });
    q.doc.activeElement = q.body;
    at(5000); q.tell({ type: "focused", key: "tab-1" });
    at(5040); q.tell({ type: "focused", key: "tab-1" });
    expect([q.view.calls, q.box.calls]).toEqual([["focus"], ["focus"]]);
});

test("where the person is loses the window's focus to nothing while the agent is at a page: it's theirs again", () => {
    // Seen once on macOS: 576ms after an agent press the message box lost focus to nothing, with no press or key of
    // the person's, and 32 typed keys landed on nothing until the agent's next click.
    const p = page();
    at(1000); p.fire("focusin", { target: p.box });
    at(2000); p.tell({ type: "focused", key: "tab-1" });
    p.box.calls.length = 0; p.view.calls.length = 0;
    p.doc.activeElement = p.body;
    at(2300); p.fire("focusout", { target: p.box, relatedTarget: null });
    p.run(0);
    expect(p.box.calls).toEqual(["focus"]);
    // Their own press or Escape took it away: left alone. So is it with no agent at work, or when something else has it by then.
    for (const own of ["pointerdown", "keydown"]) {
        const q = page();
        at(1000); q.fire("focusin", { target: q.box });
        at(2000); q.tell({ type: "focused", key: "tab-1" });
        q.box.calls.length = 0;
        at(2290); q.fire(own, { key: "Escape", target: q.body });
        q.doc.activeElement = q.body;
        q.run(0);
        at(2300); q.fire("focusout", { target: q.box, relatedTarget: null });
        q.run(0);
        expect([own, q.box.calls]).toEqual([own, []]);
    }
    const r = page();
    at(1000); r.fire("focusin", { target: r.box });
    r.doc.activeElement = r.body;
    at(9000); r.fire("focusout", { target: r.box, relatedTarget: null });
    r.run(0);
    expect(r.box.calls).toEqual([]);
});

test("a closed tab is forgotten, and stopping stops listening", () => {
    const p = page();
    at(1000); p.tell({ type: "person", key: "tab-1", press: true });
    p.tell({ type: "destroy", key: "tab-1" });
    at(1010); p.tell({ type: "focused", key: "tab-1" });
    expect(p.view.calls).toEqual(["focus"]);
    p.stop();
    expect(p.offs.sort()).toEqual(["blur", "bridge", "focusin", "focusout", "keydown", "keydown", "keypress", "keyup", "pointerdown"]);
});

test("the steps themselves", () => {
    const [page, body, box] = ["page", "body", "box"];
    // In the page's element: back to where it was (what was remembered on entering, else what just lost focus).
    expect(nextStep({ active: page, page, body, left: box, entered: undefined, now: 1000 })).toEqual({ do: "back", to: box });
    expect(nextStep({ active: page, page, body, left: undefined, entered: { from: box, at: 900 }, now: 1000 })).toEqual({ do: "back", to: box });
    expect(nextStep({ active: page, page, body, left: undefined, entered: undefined, now: 1000 })).toEqual({ do: "back", to: undefined });
    // Entered a moment ago: not yet.
    expect(nextStep({ active: page, page, body, left: box, entered: { from: box, at: 1000 - STEP_MS + 1 }, now: 1000 })).toEqual({ do: "wait" });
    // Elsewhere in the window: into the page first, remembering where from (nowhere, from the body).
    expect(nextStep({ active: box, page, body, left: undefined, entered: undefined, now: 1000 })).toEqual({ do: "enter", from: box });
    expect(nextStep({ active: body, page, body, left: box, entered: undefined, now: 1000 })).toEqual({ do: "enter", from: undefined });
    expect(nextStep({ active: null, page, body, left: undefined, entered: undefined, now: 1000 })).toEqual({ do: "enter", from: undefined });
});

test("a key the page was sent while it held the keyboard for the agent is typed in the window as it was typed", () => {
    // A letter: the key, then its character.
    expect(strayKeyEvents({ type: "keyDown", key: "a" })).toEqual([{ type: "rawKeyDown", keyCode: "a", modifiers: [] }, { type: "char", keyCode: "a", modifiers: [] }]);
    expect(strayKeyEvents({ type: "keyDown", key: "A", shift: true })).toEqual([{ type: "rawKeyDown", keyCode: "A", modifiers: ["shift"] }, { type: "char", keyCode: "A", modifiers: ["shift"] }]);
    expect(strayKeyEvents({ type: "keyUp", key: "a" })).toEqual([{ type: "keyUp", keyCode: "a", modifiers: [] }]);
    // Enter makes a carriage return; a key that makes no character is just the key, by Electron's name for it.
    expect(strayKeyEvents({ type: "keyDown", key: "Enter" })).toEqual([{ type: "rawKeyDown", keyCode: "Enter", modifiers: [] }, { type: "char", keyCode: "\r", modifiers: [] }]);
    expect(strayKeyEvents({ type: "keyDown", key: "Backspace" })).toEqual([{ type: "rawKeyDown", keyCode: "Backspace", modifiers: [] }]);
    expect(strayKeyEvents({ type: "keyDown", key: "ArrowUp" })).toEqual([{ type: "rawKeyDown", keyCode: "Up", modifiers: [] }]);
    // A shortcut types nothing.
    expect(strayKeyEvents({ type: "keyDown", key: "b", meta: true })).toEqual([{ type: "rawKeyDown", keyCode: "b", modifiers: ["meta"] }]);
    expect(strayKeyEvents({ type: "keyDown", key: ".", control: true })).toEqual([{ type: "rawKeyDown", keyCode: ".", modifiers: ["control"] }]);
});

test("the app looks at who holds the keyboard as each thing the agent does goes to a page and once it's answered, and keeps the person's keys for the window", () => {
    const host = readFileSync(join(import.meta.dir, "../desktop-electron/src/browser-host.ts"), "utf8");
    const acting = host.slice(host.indexOf("const acting = input ||"), host.indexOf("switch (cmd.method)", host.indexOf("const acting = input ||")));
    // Looked at as the command goes (a busy page takes a while to answer), and again after its answer.
    expect(acting.indexOf("if (acting) this.watchHeld(tab);")).toBeGreaterThan(acting.indexOf("const sent = sendToTab("));
    expect(acting.indexOf("if (acting) this.watchHeld(tab);")).toBeLessThan(acting.indexOf("await sent"));
    expect(acting.lastIndexOf("if (acting) this.watchHeld(tab);")).toBeGreaterThan(acting.indexOf("} finally {"));
    expect(host).toMatch(/if \(tab\.closed \|\| tab\.wc\.isDestroyed\(\) \|\| !tab\.wc\.focusedFrame\) return;\s*tab\.heldAt = Date\.now\(\);\s*this\.toGui\(\{ type: "focused", key: tab\.key \}\);/);
    // Tab isn't what gave a page the keyboard soon after the agent acted on it or it was found with the keyboard for the agent.
    expect(host).toContain("const agentAt = Math.max(tab.agentAt, tab.heldAt ?? 0);");
    // A key reaching the page: the window's if it strayed there, else the person using the page. A press makes the page
    // theirs, and so does Tab into it from the window; the GUI is told either way.
    expect(host).toMatch(/wc\.on\("before-input-event", \(e, input\) => \{[^}]*if \(this\.strayKey\(tab, input\)\) return e\.preventDefault\(\);\s*person\(input\.type\);\s*if \(tab\.agentInputs === 0\) this\.tabKey\(input\);/);
    expect(host).toContain('if (type === "mouseDown") this.theirs(tab);');
    expect(host).toContain('gui.on("before-input-event", (_e, input) => this.tabKey(input));');
    expect(host).toMatch(/private theirs\(tab: Tab\) \{\s*tab\.theirs = true;\s*this\.toGui\(\{ type: "person", key: tab\.key, press: true \}\);/);
    // Never the agent's own keys, nor a page the person put the keyboard in.
    expect(host).toContain("if (tab.agentKeys || tab.theirs || Date.now() - tab.agentAt > STRAY_KEY_MS) return false;");
    // Kept until the window has the keyboard again, then sent in order.
    expect(host).toContain("if (!tab.wc.isDestroyed() && tab.wc.focusedFrame && Date.now() - since < STRAY_WAIT_MS) return this.sendStray(tab, since);");
    // Kept for as long as the pages' layer is up, which only the desktop app loads.
    expect(readFileSync(join(import.meta.dir, "../gui/src/components/BrowserHostLayer.tsx"), "utf8")).toContain("onCleanup(keepFocus(electron!));");
    expect(readFileSync(join(import.meta.dir, "../gui/src/App.tsx"), "utf8")).toContain('if (isElectron) void import("./components/BrowserHostLayer")');
});

test("a key that reaches the window while its focus is in a page goes no further", () => {
    // Kept for the window and sent on after the wait with the keyboard never taken back, such keys reached whatever
    // answers keys with nothing focused: Escape stopped the turn, and a digit answered a waiting approval.
    const p = page();
    const key = (type: string) => { const did = [false, false]; p.fire(type, { key: "1", stopImmediatePropagation() { did[0] = true; }, preventDefault() { did[1] = true; } }); return did; };
    p.doc.activeElement = p.view;
    for (const type of ["keydown", "keypress", "keyup"]) expect([type, key(type)]).toEqual([type, [true, true]]);
    // With the window's focus on something of its own (or on nothing), a key is the window's as ever.
    p.doc.activeElement = p.box;
    expect(key("keydown")).toEqual([false, false]);
    p.doc.activeElement = p.body;
    expect(key("keydown")).toEqual([false, false]);
});

test("Tab from the window into a page makes it the person's, unless the agent took the keyboard there meanwhile", () => {
    const tab = { had: false, has: true, theirs: false, agentInputs: 0, agentAt: 400, keyAt: 1000, quietMs: 500 };
    expect(tabbedIn(tab)).toBe(true);
    // Tab moved the window's focus somewhere else, or the page already had the keyboard, or is theirs already.
    expect(tabbedIn({ ...tab, has: false })).toBe(false);
    expect(tabbedIn({ ...tab, had: true })).toBe(false);
    expect(tabbedIn({ ...tab, theirs: true })).toBe(false);
    // The agent pressed in the page since the key, or was in the middle of it: that takes the keyboard too.
    expect(tabbedIn({ ...tab, agentAt: 1010 })).toBe(false);
    expect(tabbedIn({ ...tab, agentInputs: 1 })).toBe(false);
    // Or just before it: a page takes the keyboard for a press more than once, and a moment late. Tab in the terminal
    // 60ms after the agent's click, with the page taking the keyboard again 10ms later, made the page theirs for good.
    expect(tabbedIn({ ...tab, agentAt: 940 })).toBe(false);
    expect(tabbedIn({ ...tab, agentAt: 500 })).toBe(false);
    expect(tabbedIn({ ...tab, agentAt: 499 })).toBe(true);
});
