// The desktop app's Browser pages are real ones, and a real page takes the window's keyboard when something in it is
// pressed or focused, whoever did it. The agent clicking in a page took the keyboard from the message box and the
// terminal: of 106 characters typed while it clicked, 17 arrived, and the rest pressed the page's buttons. On macOS
// the window doesn't even show it: the message box keeps its caret.
// The app says when a page holds the keyboard after the agent acted on it, and keeps the person's keys out of the page
// meanwhile (desktop-electron/src/browser-host.ts); gui/src/lib/page-focus.ts takes the keyboard back.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { AGAIN_MS, keepFocus, LEFT_MS, nextStep } from "../gui/src/lib/page-focus";
import { strayKeyEvents, strayTarget, tabbedIn } from "../desktop-electron/src/guest-input";

// The browser's side only: elements that take and lose focus, and a window that hears of it. With `keys` set, where the
// keys go too ("window", or the key of the page that has them), as measured on macOS (Electron 45): while a page has
// them, focusing that page's element, or the window's element that shows focused, changes nothing; focusing another
// element takes them there.
class El {
    isConnected = true;
    dataset: Record<string, string> = {};
    attrs = new Set<string>();
    calls: string[] = [];
    doc?: { activeElement: El | undefined; body: El; keys?: string };
    constructor(public tagName: string, key?: string) { if (key) this.dataset.key = key; }
    set tabIndex(_: number) { this.attrs.add("tabindex"); }
    hasAttribute(name: string) { return this.attrs.has(name); }
    removeAttribute(name: string) { this.attrs.delete(name); }
    focus() {
        this.calls.push("focus");
        const d = this.doc;
        if (!d) return;
        // The body is active with nothing focused, never shown focused: focusing it is a move like any other.
        if (d.keys && d.keys !== "window" && (this.dataset.key === d.keys || (d.activeElement === this && this !== d.body))) return;
        if (this === d.body && !this.attrs.has("tabindex")) return;
        d.activeElement = this;
        if (d.keys) d.keys = this.dataset.key ?? "window";
    }
    blur() { this.calls.push("blur"); if (this.doc?.activeElement === this) this.doc.activeElement = this.doc.body; }
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
    /** Another tab's page, in a pane (the person's, say) while the agent works in the first. */
    const other = new El("WEBVIEW", "tab-2");
    const doc = { activeElement: box as El | undefined, body, keys: undefined as string | undefined, addEventListener: on, removeEventListener: (type: string) => void offs.push(type), querySelectorAll: () => [view, other] };
    for (const el of [body, box, view, other]) el.doc = doc;
    const win = { document: doc, addEventListener: on, removeEventListener: (type: string) => void offs.push(type) };
    let tell: (e: any) => void = () => {};
    /** What keepFocus has put off, for the test to run: [what, how long after]. */
    const later: { fn: () => void; ms: number }[] = [];
    /** How many times the app was told the person is back in the window. */
    const backs = { n: 0 };
    const stop = keepFocus({ onBrowser: (fn) => ((tell = fn), () => void offs.push("bridge")), browserBack: () => void backs.n++ }, win as any, (fn, ms) => void later.push({ fn, ms }));
    const fire = (type: string, e: any) => { for (const fn of listeners[type] ?? []) fn({ stopImmediatePropagation() {}, preventDefault() {}, ...e }); };
    return {
        doc, box, view, other, body, win, stop, offs, fire, later, backs,
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
    // The page takes it again a moment later (it answers a press in steps): back without the app's word, though not
    // inside the blur event, while the window's focus is still moving.
    at(1020); p.taken();
    expect(p.box.calls).toEqual(["focus"]);
    p.run(0);
    expect(p.box.calls).toEqual(["focus", "focus"]);
    // Long after the app last said so, the window's focus going to a page isn't taken for the agent's doing.
    at(1021 + AGAIN_MS); p.taken();
    p.run(0);
    expect(p.box.calls).toEqual(["focus", "focus"]);
    // Nor once the window's focus has moved on by the time it would be, or the page has become theirs.
    const q = page();
    at(1000); q.tell({ type: "focused", key: "tab-1" });
    q.box.calls.length = 0;
    at(1010); q.taken();
    q.doc.activeElement = q.box;
    q.run(0);
    at(1020); q.taken();
    q.tell({ type: "person", key: "tab-1", press: true });
    q.run(0);
    expect(q.box.calls).toEqual([]);
});

test("where the window's focus never moved (macOS), it's moved off what shows focused and back, and the keys follow", () => {
    // The page has the keys; the window still shows the message box focused (seen on macOS when a page takes them again
    // just after they were taken back: an agent's double-click, or two clicks of its at once). Focusing the box again
    // changes nothing, and nor does focusing the page's element: 174 of 364 characters typed meanwhile went to the page.
    const p = page();
    p.doc.keys = "tab-1";
    at(1000); p.tell({ type: "focused", key: "tab-1" });
    expect(p.doc.keys).toBe("window");
    expect(p.doc.activeElement).toBe(p.box);
    expect([p.view.calls, p.box.calls]).toEqual([[], ["blur", "focus"]]);
    // Still the page's after that (it answered late): the same again, at the app's next word.
    p.doc.keys = "tab-1";
    at(1040); p.tell({ type: "focused", key: "tab-1" });
    expect(p.doc.keys).toBe("window");
    // Where the window's focus did go to the page's element, going back is enough.
    const q = page();
    q.doc.keys = "tab-1";
    at(1000); q.taken();
    at(1005); q.tell({ type: "focused", key: "tab-1" });
    expect([q.doc.keys, q.view.calls, q.box.calls]).toEqual(["window", [], ["focus"]]);
});

test("nothing had the window's focus: the page just loses it, so shortcuts go on working", () => {
    // Nothing had it, then the agent's press: the window shows the page's element focused, with the keys in the page.
    const p = page();
    p.doc.activeElement = p.view;
    p.doc.keys = "tab-1";
    at(1000); p.tell({ type: "focused", key: "tab-1" });
    expect([p.doc.keys, p.doc.activeElement, p.view.calls, p.box.calls]).toEqual(["window", p.body, [], []]);
    // The body takes focus for it, and is left as it was.
    expect(p.body.hasAttribute("tabindex")).toBe(false);
    // What lost focus long before isn't where the person is now; nor is something that's gone.
    const q = page();
    at(1000); q.fire("focusout", { target: q.box, relatedTarget: null });
    q.doc.activeElement = q.view;
    at(1001 + LEFT_MS); q.tell({ type: "focused", key: "tab-1" });
    expect([q.doc.activeElement, q.box.calls]).toEqual([q.body, []]);
    const r = page();
    at(1000); r.taken();
    r.box.isConnected = false;
    at(1005); r.tell({ type: "focused", key: "tab-1" });
    expect([r.doc.activeElement, r.box.calls]).toEqual([r.body, []]);
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
    expect(q.box.calls).toEqual(["blur", "focus"]);
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
    // Back in the window by a key: the app is told too (it can't see the window's focus), once.
    expect(t.backs.n).toBe(1);
    // Back in the window by a press: the agent's next click doesn't keep the keyboard, and the app is told.
    at(2000); p.fire("pointerdown", { target: p.box });
    expect(p.backs.n).toBe(1);
    p.fire("pointerdown", { target: p.box });
    expect(p.backs.n).toBe(1);
    p.doc.activeElement = p.box;
    at(2010); p.tell({ type: "focused", key: "tab-1" });
    expect(p.box.calls).toEqual(["blur", "focus"]);
    // Another tab's page isn't theirs because one is; and the keyboard goes back to the one that is.
    const s = page();
    at(1000); s.tell({ type: "person", key: "tab-2", press: true });
    at(1005); s.tell({ type: "focused", key: "tab-1" });
    expect(s.view.calls).toEqual([]);
    expect(s.other.calls).toEqual(["focus"]);
});

test("typing in a page while the agent clicks in another one, the keyboard goes back to the page being typed in", () => {
    // Measured on macOS before: of 136 characters typed in one session's page while the agent clicked in another
    // session's (not shown), 127 went to the message box, where the person had last been in the window.
    const p = page();
    at(1000); p.fire("focusin", { target: p.box });
    // A press of theirs in the other page: it has the keys, and the window shows its element focused.
    at(2000); p.tell({ type: "person", key: "tab-2", press: true });
    p.doc.activeElement = p.other;
    p.doc.keys = "tab-2";
    // The agent's press in the first page takes them.
    at(3000); p.doc.activeElement = p.view;
    p.doc.keys = "tab-1";
    p.fire("blur", { target: p.win });
    at(3001); p.tell({ type: "focused", key: "tab-1" });
    expect([p.doc.keys, p.doc.activeElement]).toEqual(["tab-2", p.other]);
    // Off the agent's page's element first, as it is off the window's own.
    expect([p.view.calls, p.box.calls]).toEqual([["blur"], []]);
    // The same where the window went on showing their page focused.
    const q = page();
    at(2000); q.tell({ type: "person", key: "tab-2", press: true });
    q.doc.activeElement = q.other;
    q.doc.keys = "tab-1";
    at(3001); q.tell({ type: "focused", key: "tab-1" });
    expect([q.doc.keys, q.doc.activeElement, q.other.calls]).toEqual(["tab-2", q.other, ["blur", "focus"]]);
    // Their keyboard was in a frame of their page (the app says so from their own keys and presses there): given back, it
    // would land on the page itself (measured on macOS and Linux: of 136 characters, 126 went to the page's top
    // document). So not given back: to nothing in the window (not where they last were in it: they weren't typing there).
    const f = page();
    at(1000); f.fire("focusin", { target: f.box });
    at(2000); f.tell({ type: "person", key: "tab-2", press: true });
    f.doc.activeElement = f.other;
    f.tell({ type: "framed", key: "tab-2", framed: true });
    f.doc.keys = "tab-1";
    at(3001); f.tell({ type: "focused", key: "tab-1" });
    expect([f.doc.keys, f.doc.activeElement, f.other.calls, f.box.calls]).toEqual(["window", f.body, ["blur"], []]);
    // They're in the window now: the app is told, so it doesn't count the page as theirs either.
    expect(f.backs.n).toBe(1);
    // Nor at the agent's next click, while they were last in the frame.
    f.doc.activeElement = f.view;
    f.doc.keys = "tab-1";
    at(3500); f.tell({ type: "focused", key: "tab-1" });
    expect([f.doc.keys, f.other.calls]).toEqual(["window", ["blur"]]);
    // Back in the page itself (a press there, or Tab into it): given back again.
    at(4000); f.tell({ type: "person", key: "tab-2", press: true, seq: 2 });
    f.tell({ type: "framed", key: "tab-2", framed: false });
    f.doc.activeElement = f.view;
    f.doc.keys = "tab-1";
    at(4100); f.tell({ type: "focused", key: "tab-1" });
    expect(f.doc.keys).toBe("tab-2");
    // The app says they left that page: the keyboard goes back to the window, and their page keeps what the agent did.
    const l = page();
    at(1000); l.fire("focusin", { target: l.box });
    at(2000); l.tell({ type: "person", key: "tab-2", press: true });
    l.tell({ type: "left", key: "tab-2" });
    l.doc.activeElement = l.other;
    l.doc.keys = "tab-2";
    at(3001); l.tell({ type: "focused", key: "tab-2" });
    expect([l.doc.keys, l.doc.activeElement]).toEqual(["window", l.box]);
    // A closed tab's mark is forgotten.
    f.tell({ type: "framed", key: "tab-2", framed: true });
    f.tell({ type: "destroy", key: "tab-2" });
    f.tell({ type: "person", key: "tab-2", press: true });
    f.doc.activeElement = f.view;
    f.doc.keys = "tab-1";
    at(4200); f.tell({ type: "focused", key: "tab-1" });
    expect(f.doc.keys).toBe("tab-2");
    // Once they're back in the window, it's where they are in the window again.
    at(4000); q.fire("pointerdown", { target: q.box });
    q.doc.activeElement = q.box;
    q.doc.keys = "tab-1";
    at(4010); q.tell({ type: "focused", key: "tab-1" });
    expect(q.doc.keys).toBe("window");
});

test("typing in a frame of a page the keyboard can't go back to, what the person types goes nowhere until they're back in the window", () => {
    // Measured on macOS: Tab from the Browser pane's address bar into a page whose first field is in a cross-site frame,
    // then another session's agent clicked in its own page. The keyboard went back to the pane's "New tab" button, the
    // last thing Tab passed: 136 letters typed did nothing, and Space or Enter would have opened a tab. On the message
    // box, Enter would send what was meant for the page (a password, say) to the agent; and with nothing focused, a
    // digit answers a waiting request and Escape stops the turn.
    const p = page();
    const button = new El("BUTTON");
    button.doc = p.doc;
    at(1000); p.fire("focusin", { target: button });
    p.doc.activeElement = button;
    // Tab into the page: the app says it's theirs, with the keyboard in a frame of it.
    at(1500); p.tell({ type: "person", key: "tab-2", press: true, seq: 1 });
    p.tell({ type: "framed", key: "tab-2", framed: true });
    p.doc.activeElement = p.other;
    p.doc.keys = "tab-2";
    // The agent's press in another page takes the keyboard; the window shows that page's element focused.
    const click = (ms: number) => {
        at(ms); p.doc.activeElement = p.view;
        p.doc.keys = "tab-1";
        p.tell({ type: "focused", key: "tab-1" });
    };
    click(3000);
    expect([p.doc.keys, p.doc.activeElement, button.calls, p.box.calls]).toEqual(["window", p.body, [], []]);
    const key = (k: string, mods: object = {}) => {
        const did = [false, false];
        p.fire("keydown", { key: k, ...mods, stopImmediatePropagation() { did[0] = true; }, preventDefault() { did[1] = true; } });
        return did;
    };
    for (const k of ["a", " ", "Enter", "1", "Escape", "Tab"]) expect([k, key(k)]).toEqual([k, [true, true]]);
    // Shortcuts go on working.
    expect(key("k", { metaKey: true })).toEqual([false, false]);
    expect(key("k", { ctrlKey: true })).toEqual([false, false]);
    // The same at the agent's next click, with no page counted as theirs now (the app was told).
    click(3500);
    expect([p.doc.keys, p.doc.activeElement, button.calls, key("1")]).toEqual(["window", p.body, [], [true, true]]);
    // Something of the window's taking focus by itself (a request's answer field) doesn't make their keys the window's.
    at(3600); p.fire("focusin", { target: p.box });
    p.doc.activeElement = p.box;
    expect(key("a")).toEqual([true, true]);
    // A press in the window does: keys are the window's again, and the agent's next click goes back to where they are.
    at(4000); p.fire("pointerdown", { target: p.box });
    p.run(0);
    expect(key("1")).toEqual([false, false]);
    click(4100);
    expect(p.doc.keys).toBe("window");
    expect(p.box.calls).toEqual(["focus"]);
    // So does a shortcut that moves the window's focus (to the message box, say).
    const q = page();
    at(1000); q.tell({ type: "person", key: "tab-2", press: true, seq: 1 });
    q.tell({ type: "framed", key: "tab-2", framed: true });
    q.doc.activeElement = q.view;
    at(2000); q.tell({ type: "focused", key: "tab-1" });
    at(3000); q.fire("keydown", { key: "l", metaKey: true });
    q.fire("focusin", { target: q.box });
    q.doc.activeElement = q.box;
    const did = [false];
    q.fire("keydown", { key: "a", stopImmediatePropagation() { did[0] = true; } });
    expect(did).toEqual([false]);
    // And their press in a page (the app says so): that page has the keyboard, and the window its keys as ever.
    const r = page();
    at(1000); r.tell({ type: "person", key: "tab-2", press: true, seq: 1 });
    r.tell({ type: "framed", key: "tab-2", framed: true });
    r.doc.activeElement = r.view;
    at(2000); r.tell({ type: "focused", key: "tab-1" });
    at(3000); r.tell({ type: "person", key: "tab-2", press: true, seq: 2 });
    r.doc.activeElement = r.body;
    const done = [false];
    r.fire("keydown", { key: "1", stopImmediatePropagation() { done[0] = true; } });
    expect(done).toEqual([false]);
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
    expect([q.view.calls, q.box.calls]).toEqual([[], ["focus"]]);
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
    expect(p.box.calls).toEqual(["blur", "focus"]);
    p.stop();
    expect(p.offs.sort()).toEqual(["blur", "bridge", "focusin", "focusout", "keydown", "keydown", "keypress", "keyup", "pointerdown"]);
});

test("the steps themselves", () => {
    const [page, body, box, button] = ["page", "body", "box", "button"];
    // In the page's element: to where the person was (what just lost focus, else where they last put it), or nowhere.
    expect(nextStep({ active: page, page, body, left: box })).toEqual({ from: undefined, to: box });
    expect(nextStep({ active: page, page, body, left: undefined })).toEqual({ from: undefined, to: undefined });
    // Something of the window's shows focused: off it and back onto it.
    expect(nextStep({ active: box, page, body, left: undefined })).toEqual({ from: box, to: box });
    expect(nextStep({ active: button, page, body, left: box })).toEqual({ from: button, to: button });
    // Nothing does: to where the person was.
    expect(nextStep({ active: body, page, body, left: box })).toEqual({ from: undefined, to: box });
    expect(nextStep({ active: null, page, body, left: undefined })).toEqual({ from: undefined, to: undefined });
    // Another page the person put the keyboard in: back to it, whatever else shows focused.
    const mine = "mine";
    expect(nextStep({ active: page, page, body, left: box, theirs: mine })).toEqual({ from: page, to: mine });
    expect(nextStep({ active: mine, page, body, left: box, theirs: mine })).toEqual({ from: mine, to: mine });
    // Another page's element showing focused that isn't theirs (any more): off it, to where they were in the window.
    expect(nextStep({ active: mine, page, body, left: box, isPage: (e) => e === mine })).toEqual({ from: mine, to: box });
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
    expect(host).toMatch(/private theirs\(tab: Tab\) \{[^]*?tab\.theirs = true;[^]*?this\.toGui\(\{ type: "person", key: tab\.key, press: true, seq: tab\.theirsSeq \}\);/);
    // Never the agent's own keys, nor a page the person put the keyboard in.
    expect(host).toContain("if (tab.agentKeys || tab.theirs || Date.now() - tab.agentAt > STRAY_KEY_MS) return false;");
    // Kept until the window has the keyboard again, then sent in order.
    expect(host).toContain("if (!tab.wc.isDestroyed() && tab.wc.focusedFrame && Date.now() - since < STRAY_WAIT_MS) return this.sendStray(tab, since);");
    // Kept for as long as the pages' layer is up, which only the desktop app loads.
    expect(readFileSync(join(import.meta.dir, "../gui/src/components/BrowserHostLayer.tsx"), "utf8")).toContain("onCleanup(keepFocus(electron!));");
    expect(readFileSync(join(import.meta.dir, "../gui/src/App.tsx"), "utf8")).toContain('if (isElectron) void import("./components/BrowserHostLayer")');
});

test("keys a page took for the agent go to the page the person is typing in, if it has the keyboard again", () => {
    // Typed in one page while the agent clicked in another, a key that reached the agent's page in that moment was sent
    // to the window, which let it go (its focus is on the person's page): 2 of 136 characters were lost that way.
    const mine = { page: "theirs", theirs: true, framed: false, held: true };
    expect(strayTarget([{ page: "agent's other", theirs: false, framed: false, held: false }, mine])).toBe("theirs");
    // Not a page of theirs whose own document doesn't have the keyboard (the window does, or a frame of it), nor one
    // that isn't theirs, nor one they were typing in a frame of: the keyboard doesn't go back to the frame.
    expect(strayTarget([{ ...mine, held: false }])).toBeUndefined();
    expect(strayTarget([{ ...mine, theirs: false }])).toBeUndefined();
    expect(strayTarget([{ ...mine, framed: true }])).toBeUndefined();
    // What happens to them in the app itself: test/electron-browser-host-focus.test.ts.
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
    const tab = { had: false, has: true, agentInputs: 0, agentAt: 400, keyAt: 1000, quietMs: 500 };
    expect(tabbedIn(tab)).toBe(true);
    // Tab moved the window's focus somewhere else, or the page already had the keyboard.
    expect(tabbedIn({ ...tab, has: false })).toBe(false);
    expect(tabbedIn({ ...tab, had: true })).toBe(false);
    // A page that was theirs before, which they left by a key and Tab back into, is said to be theirs again: the GUI
    // let go of that when they left, and without the word took the keyboard from them at the agent's next click
    // (test/electron-browser-host-focus.test.ts).
    // The agent pressed in the page since the key, or was in the middle of it: that takes the keyboard too.
    expect(tabbedIn({ ...tab, agentAt: 1010 })).toBe(false);
    expect(tabbedIn({ ...tab, agentInputs: 1 })).toBe(false);
    // Or just before it: a page takes the keyboard for a press more than once, and a moment late. Tab in the terminal
    // 60ms after the agent's click, with the page taking the keyboard again 10ms later, made the page theirs for good.
    expect(tabbedIn({ ...tab, agentAt: 940 })).toBe(false);
    expect(tabbedIn({ ...tab, agentAt: 500 })).toBe(false);
    expect(tabbedIn({ ...tab, agentAt: 499 })).toBe(true);
});
