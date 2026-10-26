// The Browser pane's rules (lib/browser.ts): where a frame is drawn and how a point in the box maps back to the page,
// what a person's mouse and keyboard become as inputs, and what the pane says of who drives. The component draws on a
// canvas, which needs a browser; these are what it feeds with events and sizes.
import { describe, expect, test } from "bun:test";
import type { BrowserState, BrowserTabInfo } from "../src/server/protocol";
import { addressOf, agentOpened, currentTab, isPasteKey, isReleaseKey, keyInput, modifiersOf, mouseInput, pagePoint, paneSize, paneStatus, placeFrame, resized, tabLabel, wheelInput, wheelPixels } from "../gui/src/lib/browser";

const tab = (over: Partial<BrowserTabInfo> = {}): BrowserTabInfo => ({ id: 1, title: "", url: "http://localhost:3000/", loading: false, owner: "agent", canGoBack: false, canGoForward: false, crashed: false, ...over });
const state = (over: Partial<BrowserState> = {}): BrowserState => ({ status: "ready", tabs: [tab()], active: 1, ...over });
const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

describe("where the page is drawn", () => {
    test("a frame is as large as fits the box, centred, with bars at the sides it doesn't fill", () => {
        // the same shape fills it
        expect(placeFrame({ width: 400, height: 300 }, { width: 800, height: 600 })).toEqual({ x: 0, y: 0, width: 400, height: 300 });
        // a frame wider than the box's shape: bars above and below
        expect(placeFrame({ width: 400, height: 400 }, { width: 800, height: 400 })).toEqual({ x: 0, y: 100, width: 400, height: 200 });
        // a taller one: bars at the sides
        expect(placeFrame({ width: 400, height: 300 }, { width: 200, height: 300 })).toEqual({ x: 100, y: 0, width: 200, height: 300 });
        // a small frame is scaled up to the box, not left small
        expect(placeFrame({ width: 400, height: 300 }, { width: 100, height: 75 })).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    });

    test("nothing is placed for an empty box or frame", () => {
        const empty = { x: 0, y: 0, width: 0, height: 0 };
        expect(placeFrame({ width: 0, height: 300 }, { width: 100, height: 100 })).toEqual(empty);
        expect(placeFrame({ width: 300, height: 300 }, { width: 100, height: 0 })).toEqual(empty);
        expect(placeFrame({ width: -1, height: 300 }, { width: 100, height: 100 })).toEqual(empty);
    });

    test("the pane's size asked of the page is whole pixels, and a pixel of rounding isn't a resize", () => {
        expect(paneSize({ width: 412.7, height: 300.2 })).toEqual({ width: 412, height: 300 });
        expect(resized(undefined, { width: 400, height: 300 })).toBe(true);
        expect(resized({ width: 400, height: 300 }, { width: 401, height: 299 })).toBe(false);
        expect(resized({ width: 400, height: 300 }, { width: 402, height: 300 })).toBe(true);
        expect(resized({ width: 400, height: 300 }, { width: 400, height: 298 })).toBe(true);
    });
});

describe("a point in the box, in the page", () => {
    const frame = { width: 800, height: 600 };

    test("is scaled by how the frame was drawn", () => {
        const place = placeFrame({ width: 400, height: 300 }, frame);
        expect(pagePoint({ x: 0, y: 0 }, place, frame)).toEqual({ x: 0, y: 0 });
        expect(pagePoint({ x: 200, y: 150 }, place, frame)).toEqual({ x: 400, y: 300 });
        expect(pagePoint({ x: 100, y: 75 }, place, frame)).toEqual({ x: 200, y: 150 });
    });

    test("accounts for the bars: a point on one is nowhere, one beside it is the page's edge", () => {
        // 200x400 frame in a 400x400 box: drawn 200 wide, 100 from the left
        const tall = { width: 200, height: 400 };
        const place = placeFrame({ width: 400, height: 400 }, tall);
        expect(place).toEqual({ x: 100, y: 0, width: 200, height: 400 });
        expect(pagePoint({ x: 50, y: 200 }, place, tall)).toBeUndefined();
        expect(pagePoint({ x: 350, y: 200 }, place, tall)).toBeUndefined();
        expect(pagePoint({ x: 100, y: 200 }, place, tall)).toEqual({ x: 0, y: 200 });
        expect(pagePoint({ x: 150, y: 100 }, place, tall)).toEqual({ x: 50, y: 100 });
    });

    test("never lands past the page's last pixel", () => {
        const place = placeFrame({ width: 400, height: 300 }, frame);
        expect(pagePoint({ x: 400, y: 300 }, place, frame)).toEqual({ x: 799, y: 599 });
    });

    test("is nowhere when nothing is drawn", () => {
        expect(pagePoint({ x: 5, y: 5 }, { x: 0, y: 0, width: 0, height: 0 }, frame)).toBeUndefined();
    });

    test("holds for a page whose size isn't the box's multiple (a frame from before the pane was resized)", () => {
        const odd = { width: 1000, height: 500 };
        const place = placeFrame({ width: 300, height: 300 }, odd);
        expect(place).toEqual({ x: 0, y: 75, width: 300, height: 150 });
        expect(pagePoint({ x: 150, y: 150 }, place, odd)).toEqual({ x: 500, y: 250 });
        expect(pagePoint({ x: 150, y: 50 }, place, odd)).toBeUndefined();
    });
});

describe("what a person's mouse and wheel send", () => {
    test("modifiers are the bits the browser takes", () => {
        expect(modifiersOf(none)).toBe(0);
        expect(modifiersOf({ ...none, altKey: true })).toBe(1);
        expect(modifiersOf({ ...none, ctrlKey: true })).toBe(2);
        expect(modifiersOf({ ...none, metaKey: true })).toBe(4);
        expect(modifiersOf({ ...none, shiftKey: true })).toBe(8);
        expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
    });

    test("a mouse event carries the page point, the button and how many clicks in a row", () => {
        expect(mouseInput("down", { x: 10, y: 20 }, { ...none, button: 0, buttons: 1, detail: 1 })).toEqual({ kind: "mouse", type: "down", x: 10, y: 20, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
        expect(mouseInput("up", { x: 10, y: 20 }, { ...none, button: 2, buttons: 0, detail: 2, shiftKey: true })).toEqual({ kind: "mouse", type: "up", x: 10, y: 20, button: "right", buttons: 0, clickCount: 2, modifiers: 8 });
        expect(mouseInput("down", { x: 0, y: 0 }, { ...none, button: 1, buttons: 4, detail: 1 })).toMatchObject({ button: "middle" });
    });

    test("a pointer moving has no click count of zero, and a button the page has no name for is left out", () => {
        const move = mouseInput("move", { x: 1, y: 2 }, { ...none, button: 0, buttons: 0, detail: 0 });
        expect(move).toMatchObject({ type: "move", clickCount: 1, buttons: 0 });
        expect(mouseInput("down", { x: 1, y: 2 }, { ...none, button: 4, buttons: 16, detail: 1 })).not.toHaveProperty("button");
    });

    test("the wheel is counted in pixels whatever unit it turns in", () => {
        expect(wheelPixels({ deltaX: 3, deltaY: 40, deltaMode: 0 }, 600)).toEqual({ x: 3, y: 40 });
        expect(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 600)).toEqual({ x: 0, y: 48 });
        expect(wheelPixels({ deltaX: 0, deltaY: -1, deltaMode: 2 }, 600)).toEqual({ x: 0, y: -600 });
        expect(wheelInput({ x: 5, y: 6 }, { x: 0, y: 48 }, { ...none, ctrlKey: true })).toEqual({ kind: "wheel", x: 5, y: 6, deltaX: 0, deltaY: 48, modifiers: 2 });
    });
});

describe("what a person's keyboard sends", () => {
    test("a key is its key, its physical code and the modifiers held", () => {
        expect(keyInput("down", { ...none, key: "a", code: "KeyA" })).toEqual({ kind: "key", type: "down", key: "a", code: "KeyA", modifiers: 0 });
        expect(keyInput("up", { ...none, key: "Enter", code: "Enter", shiftKey: true, metaKey: true })).toEqual({ kind: "key", type: "up", key: "Enter", code: "Enter", modifiers: 12 });
    });

    test("keys that aren't keys, and an input method's, are not sent", () => {
        expect(keyInput("down", { ...none, key: "Dead", code: "KeyE" })).toBeUndefined();
        expect(keyInput("down", { ...none, key: "Process", code: "KeyA" })).toBeUndefined();
        expect(keyInput("down", { ...none, key: "Unidentified", code: "" })).toBeUndefined();
        expect(keyInput("down", { ...none, key: "", code: "KeyA" })).toBeUndefined();
        expect(keyInput("down", { ...none, key: "a", code: "KeyA", isComposing: true })).toBeUndefined();
    });

    test("Shift+Escape alone gives the keyboard back; every other key is the page's", () => {
        expect(isReleaseKey({ key: "Escape", shiftKey: true, ctrlKey: false, metaKey: false, altKey: false })).toBe(true);
        expect(isReleaseKey({ key: "Escape", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
        expect(isReleaseKey({ key: "Escape", shiftKey: true, ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
        expect(isReleaseKey({ key: "Tab", shiftKey: true, ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    });

    test("the paste shortcut is left to the paste event, which has the text", () => {
        expect(isPasteKey({ key: "v", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(true);
        expect(isPasteKey({ key: "V", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false })).toBe(true);
        expect(isPasteKey({ key: "v", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false })).toBe(false);
        // Ctrl+Shift+V is paste-without-formatting somewhere, and a shortcut of the page's elsewhere: not the plain one
        expect(isPasteKey({ key: "v", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe(false);
        expect(isPasteKey({ key: "c", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe(false);
    });
});

describe("what the pane says", () => {
    test("a tab is named by its title, else where it is, else that it's new", () => {
        expect(tabLabel({ title: "Fixture shop", url: "http://localhost:3000/" })).toBe("Fixture shop");
        expect(tabLabel({ title: "", url: "http://localhost:3000/a/b?c=1" })).toBe("localhost:3000");
        expect(tabLabel({ title: "", url: "about:blank" })).toBe("New tab");
        expect(tabLabel({ title: "", url: "" })).toBe("New tab");
        expect(tabLabel({ title: "", url: "not a url" })).toBe("not a url");
    });

    test("the address bar shows the page's address, and nothing for a blank page", () => {
        expect(addressOf("http://localhost:3000/x")).toBe("http://localhost:3000/x");
        expect(addressOf("about:blank")).toBe("");
    });

    test("who drives is the current tab's owner; with no tab the browser's own state is what there is to say", () => {
        expect(paneStatus(undefined)).toBe("idle");
        expect(paneStatus(state())).toBe("agent");
        expect(paneStatus(state({ tabs: [tab({ owner: "human" })] }))).toBe("human");
        expect(paneStatus(state({ tabs: [tab({ owner: "none" })] }))).toBe("free");
        expect(paneStatus({ status: "idle", tabs: [] })).toBe("idle");
        expect(paneStatus({ status: "starting", tabs: [] })).toBe("starting");
        expect(paneStatus({ status: "crashed", tabs: [], error: "gone" })).toBe("crashed");
        expect(paneStatus({ status: "unavailable", tabs: [], error: "no Chrome" })).toBe("unavailable");
        // a tab that isn't the current one doesn't speak for it
        expect(paneStatus({ status: "ready", tabs: [tab({ id: 2, owner: "human" })], active: 1 })).toBe("idle");
    });

    test("the current tab is the one active names", () => {
        const two = state({ tabs: [tab({ id: 1 }), tab({ id: 2, title: "Second" })], active: 2 });
        expect(currentTab(two)?.title).toBe("Second");
        expect(currentTab(state({ active: undefined }))).toBeUndefined();
        expect(currentTab(undefined)).toBeUndefined();
    });

    test("the agent opening a page is a first tab of its own appearing", () => {
        expect(agentOpened(undefined, state())).toBe(true);
        expect(agentOpened({ status: "idle", tabs: [] }, state())).toBe(true);
        // more tabs, or tabs already there, are not news
        expect(agentOpened(state(), state({ tabs: [tab(), tab({ id: 2 })] }))).toBe(false);
        // a page the person opened is not the agent's
        expect(agentOpened({ status: "idle", tabs: [] }, state({ tabs: [tab({ owner: "human" })] }))).toBe(false);
        expect(agentOpened(state(), { status: "idle", tabs: [] })).toBe(false);
    });
});
