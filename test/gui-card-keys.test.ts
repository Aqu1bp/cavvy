// A card that waits for an answer says "Deny Esc", and the composer has the keyboard whenever a session is opened:
// Esc there did nothing for the card (and, for a card another machine asks, stopped the whole turn).
import { expect, test } from "bun:test";
import { cardsKey, typingIn } from "../gui/src/lib/card-keys";

const el = (tagName: string, o: { value?: string; inside?: string; editable?: boolean } = {}) => ({ tagName, isContentEditable: Boolean(o.editable), value: o.value, closest: (selector: string) => (o.inside && selector.split(", ").includes(o.inside) ? {} : null) }) as never;

test("with nothing typed in, every key is the card's", () => {
    for (const key of ["1", "2", "Escape"]) {
        expect(cardsKey(key, null)).toBe(true);
        expect(cardsKey(key, el("BUTTON"))).toBe(true);
    }
});

test("Esc from the composer is the card's while nothing is typed in it; a number there never is", () => {
    const empty = el("TEXTAREA", { value: "", inside: ".composer" });
    expect(cardsKey("Escape", empty)).toBe(true);
    expect(cardsKey("1", empty)).toBe(false);
    // With a message begun, Esc is left alone too.
    expect(cardsKey("Escape", el("TEXTAREA", { value: "wait, ", inside: ".composer" }))).toBe(false);
});

test("typed anywhere else, no key is the card's: a terminal, another field, the find bar, a page", () => {
    for (const at of [el("TEXTAREA", { value: "" }), el("INPUT", { value: "" }), el("DIV", { editable: true }), el("BUTTON", { inside: ".find-bar" }), el("CANVAS", { inside: ".br-canvas" })]) {
        expect(typingIn(at)).toBe(true);
        for (const key of ["1", "Escape"]) expect(cardsKey(key, at)).toBe(false);
    }
});
