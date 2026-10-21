// Appearance and UI preferences: per device, in localStorage (the same key
// public/theme-boot.js reads before the first paint). The shape, defaults and
// migration live in prefs-core.ts.

import { createEffect, createRoot, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { setNativeTheme } from "../lib/platform";
import { appearanceOf, migratePrefs, PREF_DEFAULTS, showAppearance, type Appearance, type Prefs } from "./prefs-core";

export { ACCENTS, CHAT_WIDTHS, PREF_DEFAULTS, type AccentId, type ContrastId, type GlassId, type Prefs, type Scheme, type TintId } from "./prefs-core";

const KEY = "harness.prefs";

function load(): Prefs {
    let saved: unknown;
    try {
        saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    } catch {
        saved = {};
    }
    return { ...PREF_DEFAULTS, ...migratePrefs(saved) };
}

export const [prefs, setPrefs] = createStore<Prefs>(load());

const media = typeof matchMedia !== "undefined" ? matchMedia("(prefers-color-scheme: dark)") : undefined;
const [systemDark, setSystemDark] = createSignal(media?.matches ?? false);
media?.addEventListener("change", (e) => setSystemDark(e.matches));

/** The scheme actually showing. */
export function activeTheme(): "light" | "dark" {
    return prefs.scheme === "system" ? (systemDark() ? "dark" : "light") : prefs.scheme;
}

createRoot(() => {
    // Only what changed goes to <html> (a write there can restyle the whole window), and the
    // native window hears only of a change of scheme (each time is a call to the app).
    let shown: Appearance | undefined;
    createEffect(() => {
        const next = appearanceOf(prefs, systemDark());
        showAppearance(document.documentElement, next, shown);
        if (next.theme !== shown?.theme) void setNativeTheme(next.theme);
        shown = next;
    });
    // Saved once for a run of changes in one go (a reset, say), with the last of them.
    let snapshot: string | undefined;
    createEffect(() => {
        const queued = snapshot !== undefined;
        snapshot = JSON.stringify(prefs);
        if (queued) return;
        queueMicrotask(() => {
            const saving = snapshot!;
            snapshot = undefined;
            try {
                localStorage.setItem(KEY, saving);
            } catch {
                // private mode: preferences last for this window only
            }
        });
    });
});
