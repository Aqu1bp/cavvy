import { expect, test } from "bun:test";
import { pickOption } from "../gui/src/lib/question-pick";

test("one question, nothing picked, typed or attached: a click sends that option", () => {
    expect(pickOption("SAML", { reviewing: false, picked: [] })).toEqual({ send: ["SAML"] });
});

test("with something typed or attached, a click picks (one at a time) and a second click unpicks", () => {
    expect(pickOption("SAML", { reviewing: true, picked: [] })).toEqual({ picked: ["SAML"] });
    expect(pickOption("OIDC", { reviewing: true, picked: ["SAML"] })).toEqual({ picked: ["OIDC"] });
    expect(pickOption("SAML", { reviewing: true, picked: ["SAML"] })).toEqual({ picked: [] });
});

test("a pick still held after the attachments are removed: clicking it unpicks it, clicking another moves it, nothing is sent", () => {
    expect(pickOption("SAML", { reviewing: false, picked: ["SAML"] })).toEqual({ picked: [] });
    expect(pickOption("OIDC", { reviewing: false, picked: ["SAML"] })).toEqual({ picked: ["OIDC"] });
    // Unpicked, with nothing attached: the next click is the answer again.
    expect(pickOption("OIDC", { reviewing: false, picked: [] })).toEqual({ send: ["OIDC"] });
});

test("several may be picked: a click adds or removes one, never sends", () => {
    expect(pickOption("a", { multi: true, reviewing: false, picked: [] })).toEqual({ picked: ["a"] });
    expect(pickOption("b", { multi: true, reviewing: false, picked: ["a"] })).toEqual({ picked: ["a", "b"] });
    expect(pickOption("a", { multi: true, reviewing: true, picked: ["a", "b"] })).toEqual({ picked: ["b"] });
});
