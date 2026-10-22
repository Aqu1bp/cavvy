// The Review pane's picked file (gui/src/lib/review-pick.ts): its name as shown, and its handle when that name hides
// a registered value. Requests carry the handle as one, never as a file name.
import { expect, test } from "bun:test";
import { findPick, pickKey, pickOf, pickParams } from "../gui/src/lib/review-pick";

const same = (a: string, b: string) => a === b;
const one = { path: "[REDACTED X].txt", pathToken: "git:one" };
const two = { path: "[REDACTED X].txt", pathToken: "git:two" };
const literal = { path: "[REDACTED X].txt" };
// A file literally named like a handle.
const named = { path: "git:one" };

test("a pick shows the name and asks by the handle; a file named like a handle is asked for by its name", () => {
    expect(pickOf(one)).toEqual({ path: "[REDACTED X].txt", token: "git:one" });
    expect(pickParams(pickOf(one))).toEqual({ pathToken: "git:one" });
    expect(pickParams(pickOf(named))).toEqual({ path: "git:one" });
    expect(pickParams(pickOf(literal))).toEqual({ path: "[REDACTED X].txt" });
});

test("files shown under one name stay apart: by handle, a literal name first, a turn card's name only when it's one file", () => {
    const files = [one, two, literal, named];
    expect(findPick(files, pickOf(two), same)).toBe(two);
    expect(findPick(files, pickOf(literal), same)).toBe(literal);
    expect(findPick(files, pickOf(named), same)).toBe(named);
    // A name without a handle (a turn card's): the literal file first, even with handled ones shown alike.
    expect(findPick([one, two, literal], { path: "[REDACTED X].txt" }, same)).toBe(literal);
    // One handled file shown so: that one. Two: neither, rather than a guess.
    expect(findPick([one, named], { path: "[REDACTED X].txt" }, same)).toBe(one);
    expect(findPick([one, two], { path: "[REDACTED X].txt" }, same)).toBeUndefined();
    expect(findPick([one], { path: "[REDACTED X].txt", token: "git:gone" }, same)).toBeUndefined();
    expect(new Set([one, two, literal, named].map((f) => pickKey(pickOf(f)))).size).toBe(4);
});
