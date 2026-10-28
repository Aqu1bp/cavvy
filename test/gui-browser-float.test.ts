// The floating browser's size (gui/src/lib/browser-float.ts): how far it can grow, and how a drag or a key resizes it.

import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { clampFloat, dragWidth, floatHost, floatMax, floatShown, keyWidth, FLOAT_MIN, PAGE_RATIO } from "../gui/src/lib/browser-float";

const state = { agentTab: true, closed: false, elsewhere: false, kept: false, busy: false, lingering: false, hovered: false, usedThisTurn: true };

test("untouched, it shows while the turn runs and a moment after, and stays while the pointer is on it", () => {
    expect(floatShown({ ...state, busy: true })).toBe(true);
    expect(floatShown({ ...state, lingering: true })).toBe(true);
    expect(floatShown({ ...state, hovered: true })).toBe(true);
    expect(floatShown(state)).toBe(false);
    // Not for a page from an earlier turn.
    expect(floatShown({ ...state, busy: true, usedThisTurn: false })).toBe(false);
});

test("once used, it stays past the turn (and the next, browser or not), until it's closed or the page shows elsewhere", () => {
    expect(floatShown({ ...state, kept: true })).toBe(true);
    expect(floatShown({ ...state, kept: true, busy: true, usedThisTurn: false })).toBe(true);
    expect(floatShown({ ...state, kept: true, closed: true })).toBe(false);
    expect(floatShown({ ...state, kept: true, elsewhere: true })).toBe(false);
    expect(floatShown({ ...state, kept: true, agentTab: false })).toBe(false);
});

const room = { w: 900, h: 700, chromeW: 10, chromeH: 39 };

test("it grows only as far as its room: the stage's width, clear of the composer, and the agent's page at its own size", () => {
    // Its height is the chrome's and the page's (which keeps its shape).
    expect(floatMax({ ...room, h: 400 })).toBeCloseTo(10 + (400 - 39) / PAGE_RATIO);
    expect(floatMax({ ...room, h: 2000 })).toBe(900);
    expect(floatMax({ w: 3000, h: 3000, chromeW: 10, chromeH: 39 })).toBe(1290);
});

test("a width is kept within its bounds, and never under the least even where the room is smaller", () => {
    expect(clampFloat(500.4, 900)).toBe(500);
    expect(clampFloat(1200, 900)).toBe(900);
    expect(clampFloat(100, 900)).toBe(FLOAT_MIN);
    expect(clampFloat(500, 200)).toBe(FLOAT_MIN);
});

test("dragging: the left edge by its travel left, the bottom by its travel down, the corner whichever went further out", () => {
    expect(dragWidth(400, "left", -100, 0)).toBe(500);
    expect(dragWidth(400, "left", 0, 300)).toBe(400);
    expect(dragWidth(400, "bottom", -50, 100)).toBe(400 + 100 / PAGE_RATIO);
    expect(dragWidth(400, "corner", -100, 10)).toBe(500);
    expect(dragWidth(400, "corner", -10, 100)).toBe(400 + 100 / PAGE_RATIO);
    // Back toward the top right, it shrinks.
    expect(dragWidth(400, "corner", 60, -20)).toBe(400 - 20 / PAGE_RATIO);
});

test("the arrow keys on its handle: left and down grow it, right and up shrink it", () => {
    expect(keyWidth(400, "ArrowLeft")).toBe(440);
    expect(keyWidth(400, "ArrowDown")).toBe(440);
    expect(keyWidth(400, "ArrowRight")).toBe(360);
    expect(keyWidth(400, "ArrowUp")).toBe(360);
    expect(keyWidth(400, "Enter")).toBeUndefined();
});

test("the bar names the page's host after its title, unless the title is the host", () => {
    expect(floatHost("http://127.0.0.1:4173/status", "Acme status")).toBe("127.0.0.1:4173");
    expect(floatHost("https://example.com/", "example.com")).toBeUndefined();
    expect(floatHost("about:blank", "New tab")).toBeUndefined();
});

test("the page sits inside the card's frame, rounded concentrically, so the card's edge is the only one at its corners", () => {
    const css = readFileSync(new URL("../gui/src/styles/browser.css", import.meta.url), "utf8");
    const inner = "border-radius: calc(var(--radius-md) - var(--br-float-inset));";
    expect(css).toContain(`.br-host-tab.shown.fit {\n    pointer-events: none;\n    ${inner}`);
    expect(css).toMatch(/\.br-float-page \{[^}]*border-radius: calc\(var\(--radius-md\) - var\(--br-float-inset\)\);/);
    expect(css).toMatch(/\.br-float-card \{[^}]*padding: 0 var\(--br-float-inset\) var\(--br-float-inset\);/);
});
