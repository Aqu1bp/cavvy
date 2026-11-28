// Drawn tooltips (gui/src/components/ui/Tooltip.tsx): what they say, their keys as chips, and where they go.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { keysOf, placeTip, splitTip, tip, TIP_DELAY, TIP_SKIP } from "../gui/src/lib/tip";

test("a shortcut in brackets at the end becomes key chips, one per key", () => {
    expect(splitTip("Toggle the sidebar (⌘B)")).toEqual({ label: "Toggle the sidebar", keys: ["⌘", "B"] });
    expect(splitTip("Close (Esc)")).toEqual({ label: "Close", keys: ["Esc"] });
    expect(splitTip("Go to line (Ctrl+G)")).toEqual({ label: "Go to line", keys: ["Ctrl", "G"] });
    expect(splitTip("Previous (Shift+Enter)")).toEqual({ label: "Previous", keys: ["Shift", "Enter"] });
    expect(splitTip("Next (→)")).toEqual({ label: "Next", keys: ["→"] });
    expect(splitTip("Search (⌘⇧F)")).toEqual({ label: "Search", keys: ["⌘", "⇧", "F"] });
});

test("words in brackets stay words", () => {
    for (const text of ["Pause the goal (it stops after this step)", "Copy path (⌥-click: full path)", "Permission mode: Ask (⇧Tab cycles)", "3 calls (2 failed)", "Archive"]) expect(splitTip(text)).toEqual({ label: text });
});

test("tip() gives the props, the keys as one chip each", () => {
    expect(tip("New chat", "⌘+N")).toEqual({ "data-tip": "New chat", "data-keys": "⌘ N" });
    expect(tip("New chat", ["⌘", "N"])).toEqual({ "data-tip": "New chat", "data-keys": "⌘ N" });
    expect(tip("Archive")).toEqual({ "data-tip": "Archive" });
    expect(tip("Archive", undefined)).toEqual({ "data-tip": "Archive" });
    expect(keysOf("⌘K  ⌘P")).toEqual(["⌘", "K", "⌘", "P"]);
});

test("it goes 6 px under the element, centred, and stays 8 px inside the window", () => {
    const r = (left: number, top: number, width = 28, height = 28) => ({ left, top, width, right: left + width, bottom: top + height });
    expect(placeTip(r(100, 100), 60, 24, 1200, 800)).toEqual({ left: 84, top: 134, side: "bottom" });
    expect(placeTip(r(2, 100), 60, 24, 1200, 800).left).toBe(8);
    expect(placeTip(r(1190, 100, 10), 60, 24, 1200, 800).left).toBe(1200 - 8 - 60);
    // No room below: above it, 6 px away.
    expect(placeTip(r(100, 760), 60, 24, 1200, 800)).toEqual({ left: 84, top: 760 - 6 - 24, side: "top" });
});

test("the design's timing, with one set of listeners and nothing left behind", () => {
    expect([TIP_DELAY, TIP_SKIP]).toEqual([450, 200]);
    const source = readFileSync(new URL("../gui/src/components/ui/Tooltip.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("setInterval");
    expect(source).not.toContain("requestAnimationFrame");
    // Every listener added is removed on cleanup, and the label is removed when it hides.
    expect(source).toContain("for (const [type, fn] of listeners) doc.removeEventListener(type, fn, on);");
    expect(source).toContain("shown.box.remove();");
    expect(source).toContain("shown.gone.disconnect();");
    expect(readFileSync(new URL("../gui/src/main.tsx", import.meta.url), "utf8")).toContain("<Tooltips />");
});
