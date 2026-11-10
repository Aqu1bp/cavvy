// The Review pane's picked file (gui/src/lib/review-pick.ts): its name as shown, and its handle when that name hides
// a registered value. Requests carry the handle as one, never as a file name.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { findPick, pickGone, pickKey, pickOf, pickParams } from "../gui/src/lib/review-pick";

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

test("a refreshed list is the same files: the reader's stacked cards, keyed as picks are, keep their place", () => {
    const before = [one, two, literal, named];
    const after = before.map((f) => ({ ...f }));
    expect(after.map((f) => pickKey(pickOf(f)))).toEqual(before.map((f) => pickKey(pickOf(f))));
    // A file asked for that the list doesn't hold (past its 300) is none of them: the reader fetches it by itself.
    expect(findPick(after, { path: "src/elsewhere.ts" }, same)).toBeUndefined();
    expect(findPick(after, pickOf(two), same)).toBe(after[1]);
});

test("a picked file that leaves the list (committed, discarded, undone) is no longer asked for", () => {
    // Opened in the reader, then committed: it was fetched by itself and shown above the files that still had changes
    // as "sum.js: This file has no changes in this view. Try again".
    const view = JSON.stringify(["s1", "uncommitted", null, null, null, pickKey({ path: "sum.js" })]);
    // The list held it in this view, and has loaded again without it: let go of.
    expect(pickGone(view, view, false, false)).toBe(true);
    // Still listed, or the list still loading (it keeps showing the last one meanwhile): kept.
    expect(pickGone(view, view, true, false)).toBe(false);
    expect(pickGone(view, view, false, true)).toBe(false);
    // Never listed: a file asked for from a turn's card that the list doesn't hold (past its 300, or with no changes
    // in this view) is still fetched by itself, and says so.
    expect(pickGone(undefined, view, false, false)).toBe(false);
    // Listed in another view (the branch's, another turn's): not this one's to let go of.
    expect(pickGone(JSON.stringify(["s1", "branch", "main", null, null, pickKey({ path: "sum.js" })]), view, false, false)).toBe(false);
    // Nothing picked.
    expect(pickGone(view, undefined, false, false)).toBe(false);
    // The reader lets go once, so asking for the same file again afterwards is a new asking.
    const pane = readFileSync(join(import.meta.dir, "../gui/src/components/ReviewPane.tsx"), "utf8");
    expect(pane).toMatch(/if \(listedPick\(\)\) held = key;\s*else if \(pickGone\(held, key, false, git\.loading\)\) \{\s*held = undefined;\s*setPicked\(undefined\);/);
});
