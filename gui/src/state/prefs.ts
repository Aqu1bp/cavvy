// Appearance and UI preferences: per device, in localStorage (the same key
// public/theme-boot.js reads before the first paint). The shape, defaults and
// migration live in prefs-core.ts.

import { createEffect, createRoot, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { setNativeTheme } from "../lib/platform";
import { applyAppearance, migratePrefs, PREF_DEFAULTS, type Prefs } from "./prefs-core";

export { ACCENTS, CHAT_WIDTHS, PREF_DEFAULTS, type AccentId, type ContrastId, type GlassId, type Prefs, type Scheme } from "./prefs-core";

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
    createEffect(() => {
        void setNativeTheme(applyAppearance(document.documentElement, prefs, systemDark()));
    });
    createEffect(() => {
        const snapshot = JSON.stringify(prefs);
        try {
            localStorage.setItem(KEY, snapshot);
        } catch {
            // private mode: preferences last for this window only
        }
    });
});
