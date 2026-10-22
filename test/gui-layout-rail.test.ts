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

