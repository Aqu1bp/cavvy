// A card that waits for an answer says "Deny Esc", and the composer has the keyboard whenever a session is opened:
// Esc there did nothing for the card (and, for a card another machine asks, stopped the whole turn).
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { cardsKey, typingIn } from "../gui/src/lib/card-keys";

const el = (tagName: string, o: { value?: string; inside?: string | string[]; editable?: boolean } = {}) => ({ tagName, isContentEditable: Boolean(o.editable), value: o.value, closest: (selector: string) => (selector.split(", ").some((s) => [o.inside ?? []].flat().includes(s)) ? {} : null) }) as never;

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
    // With a message begun, Esc isn't the card's (nor the turn's: components/Composer.tsx).
    expect(cardsKey("Escape", el("TEXTAREA", { value: "wait, ", inside: ".composer" }))).toBe(false);
    // The card's own field (what to do instead) is in the composer too: Esc there closes the field, empty or not.
    expect(cardsKey("Escape", el("TEXTAREA", { value: "", inside: [".composer", ".itab"] }))).toBe(false);
    // And the composer leaves Esc alone while the session asks something, so it never stops the turn in the card's place.
    const composer = readFileSync(new URL("../gui/src/components/Composer.tsx", import.meta.url), "utf8");
    expect(composer).toContain("if (!canStop(st()) || (p.sessionId && busy() && !working())) return;");
});

test("typed anywhere else, no key is the card's: a terminal, another field, the find bar, a page", () => {
    for (const at of [el("TEXTAREA", { value: "" }), el("INPUT", { value: "" }), el("DIV", { editable: true }), el("BUTTON", { inside: ".find-bar" }), el("CANVAS", { inside: ".br-canvas" })]) {
        expect(typingIn(at)).toBe(true);
        for (const key of ["1", "Escape"]) expect(cardsKey(key, at)).toBe(false);
    }
});
