// The desktop window's drag strip (gui/src/styles/base.css). Chromium cuts a hole in it wherever a control's box
// lies, whether or not the control shows there: rows scrolled out of sight under the strip, or a bar another page
// covers, left spots that look empty and don't move the window. Measured with real presses on the Electron window:
// with the sidebar's list scrolled, none of the strip above it moved the window.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(import.meta.dir, "..", path), "utf8");

test("what only passes under the drag strip unseen cuts no hole in it", () => {
    const rule = /\.app\.electron :is\(button[^{]*\{[^}]*no-drag/.exec(read("gui/src/styles/base.css"))?.[0] ?? "";
    // Scrolled content: the sidebar's list, the side panel's and the diff reader's body, a Settings page under its bar.
    expect(rule).toContain(":not(:is(.side-list, .insp-body, .set-in > :not(.set-top)) *)");
    // Covered: the title bar under Settings.
    expect(rule).toContain(':not([data-settings="on"] .header *)');
});

test("the drag strip's rule names those parts as their components do", () => {
    expect(read("gui/src/components/Sidebar.tsx")).toContain('class="side-list"');
    expect(read("gui/src/components/RightPanel.tsx")).toContain('class="insp-body panel-scroll"');
    expect(read("gui/src/components/ReviewPane.tsx")).toContain('class="insp-body rv-body"');
    const settings = read("gui/src/components/Settings.tsx");
    expect(settings).toContain('<div class="set-in">');
    expect(settings).toContain('<div class="set-top">');
    expect(read("gui/src/App.tsx")).toContain('data-settings={settingsTab() ? "on" : "off"}');
});

test("the strip ends no lower than the bars those lists start under, at any text size", () => {
    // The bars shrink with the text size (--sp) and the strip's own height doesn't: at text size 12 the side panel's
    // first row showed 7px into the strip, with no hole, so a press on it moved the window.
    const scaled = (css: string, selector: string) => Number(new RegExp(`\\n${selector} \\{[^}]*?\\n    height: calc\\((\\d+) \\* var\\(--sp\\)\\);`).exec(css)?.[1]);
    const cap = Number(/\.app\.electron::before \{[^}]*max-height: calc\(var\(--win-pad, 8px\) \+ (\d+) \* var\(--sp\)\);/.exec(read("gui/src/styles/base.css"))?.[1]);
    expect(cap).toBe(52);
    expect(scaled(read("gui/src/styles/panel.css"), "\\.insp-h")).toBeGreaterThanOrEqual(cap);
    expect(scaled(read("gui/src/styles/review.css"), "\\.rv-h")).toBeGreaterThanOrEqual(cap);
    expect(scaled(read("gui/src/styles/settings.css"), "\\.set-top")).toBeGreaterThanOrEqual(cap);
});
