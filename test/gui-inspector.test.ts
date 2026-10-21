// The inspector: the diff reader's resize rule (lib/inspector.ts), and its controls rendered
// (fixtures/gui-inspector.ts: real Solid reactivity in an in-memory DOM).
import { expect, test } from "bun:test";
import { CHANGE, dirOf, nameOf, REVIEW_MAX, REVIEW_MIN, reviewDragWidth } from "../gui/src/lib/inspector";

test("dragging the reader's edge moves from the width shown, within its bounds", () => {
    // Left (negative dx) widens it, right narrows it, from the width shown.
    expect(reviewDragWidth(640, -10)).toBe(650);
    expect(reviewDragWidth(640, 25)).toBe(615);
    expect(reviewDragWidth(640, 0)).toBe(640);
    expect(reviewDragWidth(640, 0.4)).toBe(640);
    expect(reviewDragWidth(500, 400)).toBe(REVIEW_MIN);
    expect(reviewDragWidth(1100, -400)).toBe(REVIEW_MAX);
});

test("file names, folders and git's letters", () => {
    expect(nameOf("gui/src/lib/a.ts")).toBe("a.ts");
    expect(dirOf("gui/src/lib/a.ts")).toBe("gui/src/lib/");
    expect(nameOf("README.md")).toBe("README.md");
    expect(dirOf("README.md")).toBe("");
    expect(dirOf("../other/b.ts")).toBe("../other/");
    expect(Object.fromEntries(Object.entries(CHANGE).map(([k, v]) => [k, v.letter]))).toEqual({ added: "A", modified: "M", deleted: "D", untracked: "U", renamed: "R", typechange: "T" });
});

test("the reader's handle, its layout switch and the side panel's Changes pane", () => {
    // In a browser-conditions process, so Solid's renderer and signals are the same copy.
    const result = Bun.spawnSync([process.execPath, "--no-env-file", "--conditions=browser", "test", new URL("./fixtures/gui-inspector.ts", import.meta.url).pathname], { timeout: 15000 });
    expect({ code: result.exitCode, output: result.stderr.toString() }).toMatchObject({ code: 0 });
});
