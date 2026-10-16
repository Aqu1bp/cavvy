import { afterEach, expect, test } from "bun:test";
import { menuIndex, menuTypeahead, mountMenu, rowMenuKey } from "../gui/src/lib/menu";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

// A minimal document adapter exercises the production event controller without
// requiring a browser or replacing its navigation/focus/activation logic.
function fixture(kind: "menu" | "dialog" = "menu") {
    let listener: ((e: any) => void) | undefined;
    let frame: (() => void) | undefined;
    const oldRequest = globalThis.requestAnimationFrame;
    const oldCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: () => void) => { frame = cb; return 1; }) as any;
    globalThis.cancelAnimationFrame = (() => { frame = undefined; }) as any;
    cleanups.push(() => { globalThis.requestAnimationFrame = oldRequest; globalThis.cancelAnimationFrame = oldCancel; });
    const body = {};
    const doc = {
        body, activeElement: body as any,
        addEventListener(_name: string, handler: any) { listener = handler; },
        removeEventListener(_name: string, handler: any) { if (listener === handler) listener = undefined; },
    };
    const node = (label: string, extra: Record<string, any> = {}) => ({
        textContent: label, tabIndex: 0, isConnected: true, disabled: false, hidden: false,
        checked: false, clicks: 0, scrolls: 0,
        matches() { return this.disabled; },
        getClientRects() { return this.hidden ? [] : [{}]; },
        getAttribute(name: string) { return name === "aria-checked" && this.checked ? "true" : null; },
        querySelector() { return null; },
        focus() { doc.activeElement = this; },
        click() { this.clicks++; },
        scrollIntoView() { this.scrolls++; },
        ...extra,
    });
    const trigger = node("Trigger");
    const items = [node("Alpha"), node("Disabled", { disabled: true }), node("Bravo", { checked: true }), node("Beta"), node("Hidden", { hidden: true })];
    const panel = Object.assign(node("Panel"), {
        ownerDocument: doc,
        querySelectorAll: () => items,
        contains: (el: any) => el === panel || items.includes(el),
    });
    let closes = 0;
    let handled = 0;
    let dispose = () => {};
    trigger.focus();
    dispose = mountMenu(panel as any, {
        kind, close: () => { closes++; dispose(); }, returnFocus: () => trigger as any,
        initialFocus: kind === "dialog" ? () => items[0] as any : undefined,
        onKeyDown: kind === "dialog" ? () => { handled++; } : undefined,
    });
    cleanups.push(dispose);
    const key = (key: string, extra: Record<string, any> = {}) => {
        const e = {
            key, target: doc.activeElement, defaultPrevented: false, stopped: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.stopped = true; }, ...extra,
        };
        listener?.(e);
        return e;
    };
    return { doc, trigger, panel, items, key, dispose, node,
        tick: () => frame?.(), get closes() { return closes; }, get handled() { return handled; },
    };
}

test("navigation wraps and handles empty menus", () => {
    expect(menuIndex(0, -1, "ArrowDown")).toBe(-1);
    expect(menuIndex(3, -1, "ArrowUp")).toBe(2);
    expect(menuIndex(3, -1, "ArrowDown")).toBe(0);
    expect(menuIndex(3, 2, "ArrowDown")).toBe(0);
    expect(menuIndex(3, 0, "ArrowUp")).toBe(2);
    expect(menuIndex(3, 1, "Home")).toBe(0);
    expect(menuIndex(3, 1, "End")).toBe(2);
});

test("typeahead cycles matching initials, builds prefixes, ignores case and resets", () => {
    const search = menuTypeahead();
    const labels = ["Apple", "Blueberry", "Blackberry", "Pear"];
    expect(search(labels, 0, "b", 1000)).toBe(1);
    expect(search(labels, 1, "b", 1100)).toBe(2);
    expect(search(labels, 2, "B", 2000)).toBe(1);
    expect(search(labels, 1, "l", 2100)).toBe(1);
    expect(search(labels, 1, "a", 2200)).toBe(2);
    expect(search(labels, 2, "z", 4000)).toBe(-1);
    expect(search([], -1, "a", 5000)).toBe(-1);
});

test("opening focuses the checked item and keys skip disabled/hidden items", () => {
    const f = fixture(); f.tick();
    expect(f.doc.activeElement).toBe(f.items[2]);
    f.key("ArrowDown"); expect(f.doc.activeElement).toBe(f.items[3]);
    f.key("ArrowDown"); expect(f.doc.activeElement).toBe(f.items[0]);
    f.key("ArrowUp"); expect(f.doc.activeElement).toBe(f.items[3]);
    f.key("Home"); expect(f.doc.activeElement).toBe(f.items[0]);
    f.key("End"); expect(f.doc.activeElement).toBe(f.items[3]);
    f.key("b"); expect(f.doc.activeElement).toBe(f.items[2]);
    expect(f.items[2]!.scrolls).toBeGreaterThan(0);
});

for (const activation of ["Enter", " "]) test(`${JSON.stringify(activation)} activates the focused enabled item exactly once`, () => {
    const f = fixture(); f.tick();
    const e = f.key(activation);
    expect(e.defaultPrevented).toBe(true);
    expect(e.stopped).toBe(true);
    expect(f.items.map((i) => i.clicks)).toEqual([0, 0, 1, 0, 0]);
});

test("Escape closes, returns focus and cannot reach a global interrupt handler", () => {
    const f = fixture(); f.tick();
    const e = f.key("Escape");
    expect(f.closes).toBe(1);
    expect(f.doc.activeElement).toBe(f.trigger);
    expect(e.defaultPrevented).toBe(true);
    expect(e.stopped).toBe(true);
    f.key("Enter"); expect(f.items[2]!.clicks).toBe(0);
});

for (const shiftKey of [false, true]) test(`Tab ${shiftKey ? "backward" : "forward"} closes before native navigation from the trigger`, () => {
    const f = fixture(); f.tick();
    const e = f.key("Tab", { shiftKey });
    expect(f.closes).toBe(1);
    expect(f.doc.activeElement).toBe(f.trigger);
    expect(e.defaultPrevented).toBe(false);
});

test("searchable picker traps Tab in both directions and delegates search keys", () => {
    const f = fixture("dialog"); f.tick();
    expect(f.doc.activeElement).toBe(f.items[0]);
    expect(f.key("Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(f.doc.activeElement).toBe(f.items[3]);
    f.key("Tab"); expect(f.doc.activeElement).toBe(f.items[0]);
    expect(f.key("a").defaultPrevented).toBe(false);
    expect(f.handled).toBe(1);
    expect(f.closes).toBe(0);
});

test("global shortcuts stay inside the menu except the command palette", () => {
    const f = fixture(); f.tick();
    expect(f.key("n", { metaKey: true }).stopped).toBe(true);
    const composing = f.key("Escape", { isComposing: true });
    expect(composing.defaultPrevented).toBe(false);
    expect(composing.stopped).toBe(true);
    const legacyIme = f.key("Escape", { keyCode: 229 });
    expect(legacyIme.defaultPrevented).toBe(false);
    expect(legacyIme.stopped).toBe(true);
    expect(f.closes).toBe(0);
    expect(f.key("k", { metaKey: true }).stopped).toBe(false);
    expect(f.closes).toBe(1);
    expect(f.doc.activeElement).toBe(f.trigger);
});

test("closing before the focus frame cancels stale focus; dismissal preserves another focused control", () => {
    const f = fixture(); f.dispose();
    const next = f.node("Dialog field"); next.focus();
    f.tick();
    expect(f.doc.activeElement).toBe(next);
    f.dispose(); expect(f.doc.activeElement).toBe(next);
});

test("empty menu focuses its panel and remains dismissible", () => {
    const f = fixture(); f.items.length = 0; f.tick();
    expect(f.doc.activeElement).toBe(f.panel);
    f.key("ArrowDown"); expect(f.doc.activeElement).toBe(f.panel);
    f.key("Escape"); expect(f.doc.activeElement).toBe(f.trigger);
});

for (const key of ["ContextMenu", "F10"]) test(`${key} opens a row menu but preserves rename input context menus`, () => {
    let opens = 0;
    let prevented = false;
    const e = { key, shiftKey: key === "F10", target: { closest: () => null }, preventDefault() { prevented = true; }, stopPropagation() {} };
    rowMenuKey(e as any, () => opens++);
    expect(opens).toBe(1); expect(prevented).toBe(true);
    rowMenuKey({ ...e, target: { closest: () => ({}) } } as any, () => opens++);
    expect(opens).toBe(1);
    rowMenuKey({ ...e, key: "F10", shiftKey: false } as any, () => opens++);
    expect(opens).toBe(1);
});
