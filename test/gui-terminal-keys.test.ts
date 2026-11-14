// With the terminal open, a session that waits for an answer was opened (another project's, or after a reload) and
// its terminal took the keyboard: the card's number keys and Esc went to the shell. A terminal takes the keyboard
// when the user asks for it (lib/terminal-keys.ts); one that came into view by itself leaves it to the card.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cardArrived, terminalAsked, terminalTakesKeys, terminalUsed } from "../gui/src/lib/terminal-keys";

/** As much of a terminal's element as the rule looks at. */
function screen() {
    const attrs = new Map<string, string>();
    const el = {
        blurred: 0,
        /** The panel is maximized over the conversation. */
        max: false,
        contains: (other: unknown) => other === el,
        setAttribute: (name: string, value: string) => void attrs.set(name, value),
        getAttribute: (name: string) => attrs.get(name) ?? null,
        removeAttribute: (name: string) => void attrs.delete(name),
        closest: (selector: string) => (selector === ".terminal-panel.max" ? (el.max ? {} : null) : attrs.has(selector.slice(1, -1)) ? el : null),
        blur: () => {
            el.blurred++;
            page.activeElement = null;
        },
    };
    return el;
}
/** The window: what has the keyboard, and the card there is (if any), which may be out of sight. */
const page: { activeElement: unknown; card: boolean; seen: boolean; querySelector: (s: string) => unknown } = {
    activeElement: null,
    card: false,
    seen: true,
    querySelector: (s) => (s === ".itab" && page.card ? { closest: () => null, checkVisibility: () => page.seen } : null),
};
/** The terminal focuses itself where the rule lets it, as components/TerminalPanel.tsx does. */
const comesIntoView = (el: ReturnType<typeof screen>) => {
    const took = terminalTakesKeys(el as unknown as HTMLElement);
    if (took) page.activeElement = el;
    return took;
};

const real = { document: (globalThis as any).document, now: performance.now };
let now = 100_000;
beforeEach(() => {
    (globalThis as any).document = page;
    performance.now = () => now;
    page.activeElement = null;
    page.card = false;
    page.seen = true;
    now += 100_000;
});
afterEach(() => {
    (globalThis as any).document = real.document;
    performance.now = real.now;
});

test("a terminal that comes into view by itself leaves the keyboard to a card that waits", () => {
    const el = screen();
    page.card = true;
    expect(comesIntoView(el)).toBe(false);
    expect(page.activeElement).toBe(null);
    // Not to one that can't be seen (the terminal maximized over it, Settings over it): its keys are off.
    page.seen = false;
    expect(comesIntoView(el)).toBe(true);
});

test("opened by the user, it takes the keyboard even from a waiting card, and keeps it when another card arrives", () => {
    const el = screen();
    page.card = true;
    terminalAsked();
    now += 300; // its shell attached
    expect(comesIntoView(el)).toBe(true);
    cardArrived();
    expect(el.blurred).toBe(0);
});

test("with no card it takes the keyboard as before; a card arriving in the moment after gets the keyboard back", () => {
    const el = screen();
    expect(comesIntoView(el)).toBe(true);
    now += 800; // the session's card, a little after its terminal
    page.card = true;
    cardArrived();
    expect(el.blurred).toBe(1);
});

test("past that moment the terminal is the user's, used or not: a card arriving while they read doesn't take the keys", () => {
    const el = screen();
    expect(comesIntoView(el)).toBe(true);
    now += 20 * 60_000;
    page.card = true;
    cardArrived();
    expect(el.blurred).toBe(0);
    // Nor a later one.
    cardArrived();
    expect(el.blurred).toBe(0);
});

test("once typed, clicked or scrolled in, it's the user's: a card arriving at once doesn't take the keyboard from it", () => {
    const el = screen();
    expect(comesIntoView(el)).toBe(true);
    terminalUsed(el as unknown as HTMLElement);
    // Its shell attaching after that asks again: nothing changes for a terminal that has the keyboard.
    expect(comesIntoView(el)).toBe(true);
    page.card = true;
    cardArrived();
    expect(el.blurred).toBe(0);
});

test("a terminal maximized over the conversation keeps the keyboard from a card it covers", () => {
    const el = screen();
    el.max = true;
    expect(comesIntoView(el)).toBe(true);
    page.card = true;
    cardArrived();
    expect(el.blurred).toBe(0);
});

test("asking for a terminal wears off: one shown by itself later doesn't take a card's keys", () => {
    const el = screen();
    terminalAsked();
    now += 5000;
    page.card = true;
    expect(comesIntoView(el)).toBe(false);
});
