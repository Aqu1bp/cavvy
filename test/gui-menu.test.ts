import { afterEach, expect, test } from "bun:test";
import { menuIndex, menuOf, menuTypeahead, mountMenu, ownSubmenu, rowMenuKey } from "../gui/src/lib/menu";
import { placeSubmenu } from "../gui/src/lib/submenu";
import { os } from "../gui/src/lib/platform";

const paletteModifier = os === "macos" ? { metaKey: true } : { ctrlKey: true };
const otherModifier = os === "macos" ? { ctrlKey: true } : { metaKey: true };

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
    let clickListener: ((e: any) => void) | undefined;
    const panel = Object.assign(node("Panel"), {
        ownerDocument: doc,
        addEventListener(_name: string, handler: any) { clickListener = handler; },
        removeEventListener(_name: string, handler: any) { if (clickListener === handler) clickListener = undefined; },
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
    const click = (target: any) => {
        const e = {
            target, defaultPrevented: false, stopped: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.stopped = true; },
        };
        clickListener?.(e);
        return e;
    };
    return { doc, trigger, panel, items, key, click, dispose, node,
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

test("a click on a row marked aria-disabled is stopped before it can pick the row; enabled rows click through", () => {
    const f = fixture(); f.tick();
    const off = { closest: (sel: string) => (sel === '[aria-disabled="true"]' ? off : null) };
    const on = { closest: () => null };
    const blocked = f.click(off);
    expect(blocked.defaultPrevented).toBe(true);
    expect(blocked.stopped).toBe(true);
    const allowed = f.click(on);
    expect(allowed.defaultPrevented).toBe(false);
    expect(allowed.stopped).toBe(false);
    f.dispose();
    // Unmounted, the panel no longer filters clicks.
    expect(f.click(off).stopped).toBe(false);
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

test("find goes through to App, which decides what it does (nothing under Settings): the menu closes", () => {
    const f = fixture(); f.tick();
    const find = f.key("f", paletteModifier);
    expect(find.stopped).toBe(false);
    expect(f.closes).toBe(1);
});

test("Settings goes through to App too: the menu closes", () => {
    const f = fixture(); f.tick();
    const settings = f.key(",", paletteModifier);
    expect(settings.stopped).toBe(false);
    expect(f.closes).toBe(1);
});

test("global shortcuts stay inside the menu except the command palette, find and Settings", () => {
    const f = fixture(); f.tick();
    expect(f.key("n", { metaKey: true }).stopped).toBe(true);
    const composing = f.key("Escape", { isComposing: true });
    expect(composing.defaultPrevented).toBe(false);
    expect(composing.stopped).toBe(true);
    const legacyIme = f.key("Escape", { keyCode: 229 });
    expect(legacyIme.defaultPrevented).toBe(false);
    expect(legacyIme.stopped).toBe(true);
    expect(f.closes).toBe(0);
    expect(f.key("k", paletteModifier).stopped).toBe(false);
    expect(f.closes).toBe(1);
    expect(f.doc.activeElement).toBe(f.trigger);
});

for (const kind of ["menu", "dialog"] as const) {
    test(`${kind}: only the platform palette shortcut dismisses the panel`, () => {
        const f = fixture(kind); f.tick();
        const focused = f.doc.activeElement;
        // On macOS Ctrl+K is native kill-line editing in the model search field.
        // On other platforms Meta+K likewise is not App's palette shortcut.
        const edit = f.key("k", otherModifier);
        expect(f.closes).toBe(0);
        expect(f.doc.activeElement).toBe(focused);
        expect(edit.defaultPrevented).toBe(false);
        expect(edit.stopped).toBe(true);

        const alt = f.key("k", { ...paletteModifier, altKey: true });
        expect(f.closes).toBe(0);
        expect(alt.defaultPrevented).toBe(false);
        expect(alt.stopped).toBe(true);

        const palette = f.key("k", paletteModifier);
        expect(f.closes).toBe(1);
        expect(f.doc.activeElement).toBe(f.trigger);
        expect(palette.defaultPrevented).toBe(false);
        expect(palette.stopped).toBe(false);
    });
}

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

// A menu with an item that opens a submenu (components/ui/Submenu.tsx), the submenu's panel outside the menu's (a portal):
// the item hears "submenu" events, as the component does, and opens or closes it.
function submenuFixture() {
    const f = fixture();
    const more = f.node("More", {
        getAttribute(name: string) { return name === "aria-haspopup" ? "menu" : null; },
        heard: [] as { open: boolean; focus?: boolean }[],
        dispatchEvent(e: CustomEvent<{ open: boolean; focus?: boolean }>) {
            this.heard.push(e.detail);
            if (e.detail.open) {
                release = ownSubmenu(sub as any, more as any);
                subItems[0]!.focus();
            } else release();
            return true;
        },
    });
    let release = () => {};
    const sub: any = f.node("Sub", { querySelectorAll: () => subItems, contains: (el: any) => subItems.includes(el) });
    const subItems = [f.node("One"), f.node("Two")].map((n) => Object.assign(n, { closest: (sel: string) => (sel === "[data-submenu]" ? sub : null) }));
    f.items.push(more);
    const contains = f.panel.contains;
    f.panel.contains = (el: any) => el === more || contains(el);
    return Object.assign(f, { more, sub, subItems });
}

test("a submenu: Right or Enter opens it on its first item, its keys move in it, Left and Escape go back to its item", () => {
    for (const open of ["ArrowRight", "Enter", " "]) {
        const f = submenuFixture(); f.tick();
        f.key("End");
        expect(f.doc.activeElement).toBe(f.more);
        f.key(open);
        expect(f.more.heard.at(-1)).toEqual({ open: true, focus: true });
        expect(f.more.clicks).toBe(0);
        expect(f.doc.activeElement).toBe(f.subItems[0]);
        expect(menuOf(f.panel as any, f.subItems[1])).toBe(f.sub);
        f.key("ArrowDown"); expect(f.doc.activeElement).toBe(f.subItems[1]);
        f.key("ArrowDown"); expect(f.doc.activeElement).toBe(f.subItems[0]);
        f.key("t"); expect(f.doc.activeElement).toBe(f.subItems[1]);
        f.key("Enter"); expect(f.subItems[1]!.clicks).toBe(1);
        // Back to the item that opened it, the menu still open.
        f.key(open === "ArrowRight" ? "ArrowLeft" : "Escape");
        expect(f.more.heard.at(-1)).toEqual({ open: false, focus: false });
        expect(f.doc.activeElement).toBe(f.more);
        expect(f.closes).toBe(0);
        expect(menuOf(f.panel as any, f.subItems[1])).toBeUndefined();
        // Then Escape closes the menu.
        f.key("Escape");
        expect(f.closes).toBe(1);
        f.dispose();
    }
});

test("Left and Right do nothing on an item without a submenu; Tab from a submenu closes the whole menu", () => {
    const f = submenuFixture(); f.tick();
    f.key("ArrowRight"); f.key("ArrowLeft");
    expect(f.doc.activeElement).toBe(f.items[2]);
    expect(f.closes).toBe(0);
    f.key("End"); f.key("ArrowRight");
    expect(f.doc.activeElement).toBe(f.subItems[0]);
    f.key("Tab");
    expect(f.closes).toBe(1);
});

test("a submenu goes beside its menu: on the right, on the left where the right has no room, inside the window", () => {
    const o = { width: 200, height: 180, pad: 5, vw: 1280, vh: 800 };
    // The sidebar's menu, at the window's left edge: on its right, level with its item.
    expect(placeSubmenu({ top: 300 }, { left: 10, right: 250 }, o)).toEqual({ left: 252, top: 295, width: 200, maxHeight: 784, side: "right" });
    // At the right edge: on the left.
    expect(placeSubmenu({ top: 300 }, { left: 1000, right: 1240 }, o)).toMatchObject({ left: 798, side: "left" });
    // Near the bottom: up so it's all in the window.
    expect(placeSubmenu({ top: 760 }, { left: 10, right: 250 }, o).top).toBe(800 - 8 - 180);
    // A window too narrow for either side: inside it all the same.
    const narrow = placeSubmenu({ top: 10 }, { left: 8, right: 300 }, { ...o, vw: 400 });
    expect(narrow.left).toBeGreaterThanOrEqual(8);
    expect(narrow.left + narrow.width).toBeLessThanOrEqual(392);
    // Taller than the window: it scrolls inside, from the top.
    expect(placeSubmenu({ top: 300 }, { left: 10, right: 250 }, { ...o, height: 2000 })).toMatchObject({ top: 8, maxHeight: 784 });
});
