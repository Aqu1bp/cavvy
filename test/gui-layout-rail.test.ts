import { afterEach, expect, test } from "bun:test";
import { toggleSidebar } from "../gui/src/state/actions";
import { prefs, setPrefs } from "../gui/src/state/prefs";
import { railOpen, setRailOpen, setShellLayout, shellLayout } from "../gui/src/state/ui";
import { windowLayout } from "../gui/src/lib/layout";

const at = (w: number, h: number) => windowLayout({
    win: { w, h }, rail: prefs.sidebar, railOpen: railOpen(), railWidth: 260, panel: false, review: false, split: false,
    reviewBase: 720, inspectorWidth: 360, terminalShown: false, terminalPreferred: 260, terminalMax: false, dock: 0,
});
const initial = shellLayout();

afterEach(() => {
    setShellLayout(initial);
    setRailOpen(false);
    setPrefs("sidebar", true);
});

test("toggling the sidebar on a wide window hides and shows the docked rail (the preference)", () => {
    setShellLayout(at(1360, 880));
    toggleSidebar();
    expect(prefs.sidebar).toBe(false);
    expect(railOpen()).toBe(false);
    toggleSidebar();
    expect(prefs.sidebar).toBe(true);
});

test("toggling the sidebar below 900px opens and closes the drawer, leaving the preference alone", () => {
    setShellLayout(at(720, 480));
    expect(shellLayout().railMode).toBe("overlay");
    toggleSidebar();
    expect(railOpen()).toBe(true);
    expect(prefs.sidebar).toBe(true);
    toggleSidebar();
    expect(railOpen()).toBe(false);
    expect(prefs.sidebar).toBe(true);
    // A rail hidden on a wide window still opens as a drawer on a narrow one.
    setPrefs("sidebar", false);
    toggleSidebar();
    expect(railOpen()).toBe(true);
    expect(prefs.sidebar).toBe(false);
    expect(at(720, 480).railShown).toBe(true);
});

// --rail-w is registered as not inherited (shell.css), so every element between .win (where it's set)
// and the sidebar (which sizes itself by it) must inherit it explicitly, or the sidebar falls back to
// 260px while its grid column keeps the saved width, leaving a gap.
test("every element between .win and the sidebar passes the rail's width on", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const gui = join(import.meta.dir, "../gui/src");
    const css = ["styles/shell.css", "styles/sidebar.css"].map((f) => readFileSync(join(gui, f), "utf8")).join("\n");
    const inherits = (cls: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].some(([, sel, body]) => sel!.split(",").some((s) => new RegExp(`\\.${cls}(?![\\w-])`).test(s)) && /--rail-w:\s*inherit/.test(body!));
    const app = readFileSync(join(gui, "App.tsx"), "utf8");
    const between = app.slice(app.indexOf('class="win"'), app.indexOf("<Sidebar"));
    const classes = [...between.matchAll(/<div class="([\w-]+)/g)].map((m) => m[1]!)// Siblings on the way, not ancestors of the sidebar.
        .filter((c) => !["win-drag", "rail-scrim", "settings-host"].includes(c));
    expect(classes).toEqual(["win-rail", "keep"]);
    for (const c of [...classes, "sidebar"]) expect([c, inherits(c)]).toEqual([c, true]);
});
