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

test("at a small text size, what shows in the strip from under a shorter bar still cuts its hole", () => {
    // The side panel's and the reader's bars shrink with the text size (--sp) and the strip doesn't: at text size 12
    // the panel's first row shows 7px into the strip. Its rows are no holes, so the body's own box is one.
    const css = read("gui/src/styles/base.css");
    expect(css).toMatch(/:not\(\[data-settings="on"\] \.header \*\),\n\.app\.electron \.insp-body,\n\.app\.electron \.br-host-tab\.shown \{\s*-webkit-app-region: no-drag;/);
    expect(read("gui/src/components/ReviewPane.tsx")).toContain('class="insp-body rv-body"');
    // Settings' bar is kept as tall as the title bar it covers, which the strip never ends below.
    expect(/\n\.set-top \{[^}]*\n    min-height: var\(--header-h\);/.test(read("gui/src/styles/settings.css"))).toBe(true);
    // The strip itself keeps its height: capped to the shorter bars, the title bar's last 7px stopped moving the window.
    expect(/\.app\.electron::before \{[^}]*max-height/.test(css)).toBe(false);
});

test("a browser's page no pane shows is no hole in the strip, and a hole is its own box only", () => {
    // Such a page is laid out at the window's corner at the agent's size (1280 by 800), clipped to a pixel. As a
    // hole, with the page inside it one too (the property is inherited), it took the strip from under the whole
    // window while the agent used its browser: 15% of the strip's points moved the window, by real presses.
    const css = read("gui/src/styles/base.css");
    expect(css).not.toMatch(/\.app\.electron \.br-host-tab[,\s]*\{/);
    expect(css).toMatch(/\.app\.electron :is\(\.insp-body, \.br-host-tab\) > \* \{\s*-webkit-app-region: initial;/);
    // Chromium reads any value but `drag` as `no-drag` (measured in Electron 45: `none` on a child computes to
    // `no-drag`), so nothing here may say `none`.
    expect(css).not.toMatch(/app-region:\s*none/);
    const layer = read("gui/src/components/BrowserHostLayer.tsx");
    expect(layer).toContain('wrap.classList.toggle("shown", box !== undefined);');
    expect(layer).toContain('return <div ref={wrap} class="br-host-tab" />;');
});
