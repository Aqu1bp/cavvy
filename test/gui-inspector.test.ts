// The inspector: the diff reader's resize rule (lib/inspector.ts), and its controls rendered
// (fixtures/gui-inspector.ts: real Solid reactivity in an in-memory DOM).
import { expect, test } from "bun:test";
import { CHANGE, dirOf, fitTabs, nameOf, REVIEW_MAX, REVIEW_MIN, reviewDragWidth, reviewWidthRange, tabName } from "../gui/src/lib/inspector";

test("dragging the reader's edge moves from the width shown, within its bounds", () => {
    // Left (negative dx) widens it, right narrows it, from the width shown.
    expect(reviewDragWidth(640, -10)).toBe(650);
    expect(reviewDragWidth(640, 25)).toBe(615);
    expect(reviewDragWidth(640, 0)).toBe(640);
    expect(reviewDragWidth(640, 0.4)).toBe(640);
    expect(reviewDragWidth(500, 400)).toBe(REVIEW_MIN);
    expect(reviewDragWidth(1100, -400)).toBe(REVIEW_MAX);
});

test("the handle's range: from its least width to the most the layout lets it dock at", () => {
    // A 1400px sheet keeps the conversation 480px: up to 920.
    expect(reviewWidthRange(640, 1400)).toEqual({ min: REVIEW_MIN, max: 920 });
    // A very wide sheet: the reader's own cap.
    expect(reviewWidthRange(860, 3000)).toEqual({ min: REVIEW_MIN, max: REVIEW_MAX });
    // Shown wider than a drag could make it (the layout's share), or narrower than its least: the range takes it in.
    expect(reviewWidthRange(700, 1100)).toEqual({ min: REVIEW_MIN, max: 700 });
    expect(reviewWidthRange(400, 1100)).toEqual({ min: 400, max: 620 });
});

test("file names, folders and git's letters", () => {
    expect(nameOf("gui/src/lib/a.ts")).toBe("a.ts");
    expect(dirOf("gui/src/lib/a.ts")).toBe("gui/src/lib/");
    expect(nameOf("README.md")).toBe("README.md");
    expect(dirOf("README.md")).toBe("");
    expect(dirOf("../other/b.ts")).toBe("../other/");
    expect(Object.fromEntries(Object.entries(CHANGE).map(([k, v]) => [k, v.letter]))).toEqual({ added: "A", modified: "M", deleted: "D", untracked: "U", renamed: "R", typechange: "T" });
});

test("the side panel's tabs give way in steps: roomy labels, tight labels, labels without the count of files, then icons", () => {
    const tried: string[] = [];
    // Every tab holds its content at full padding: labels, roomy, and nothing else is laid out.
    expect(fitTabs((fit) => (tried.push(fit), false))).toBe("full");
    expect(tried).toEqual(["full"]);
    // Labels and counts still fit with tight padding.
    expect(fitTabs((fit) => fit === "full")).toBe("tight");
    // Then the count of files goes before the labels do.
    expect(fitTabs((fit) => fit === "full" || fit === "tight")).toBe("lean");
    // Only when the labels alone are cut do the tabs turn to icons.
    expect(fitTabs((fit) => fit !== "icons")).toBe("icons");
    // Even cut as icons, icons are the last step (not tried, nothing narrower to fall back to).
    tried.length = 0;
    expect(fitTabs((fit) => (tried.push(fit), true))).toBe("icons");
    expect(tried).toEqual(["full", "tight", "lean"]);
});

test("a tab's name says its count, which may be hidden or shown as an icon's badge", () => {
    expect(tabName("Changes")).toBe("Changes");
    expect(tabName("Changes", "12 files")).toBe("Changes, 12 files");
    expect(tabName("Agents", "4 running", "a sub-agent needs you")).toBe("Agents, 4 running, a sub-agent needs you");
    expect(tabName("Agents", undefined, "a sub-agent needs you")).toBe("Agents, a sub-agent needs you");
    expect(tabName("Commands", false, "")).toBe("Commands");
});

test("the reader's handle, its layout switch and the side panel's Changes pane", () => {
    // In a browser-conditions process, so Solid's renderer and signals are the same copy.
    const result = Bun.spawnSync([process.execPath, "--no-env-file", "--conditions=browser", "test", new URL("./fixtures/gui-inspector.ts", import.meta.url).pathname], { timeout: 15000 });
    expect({ code: result.exitCode, output: result.stderr.toString() }).toMatchObject({ code: 0 });
});
