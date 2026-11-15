// Appearance and UI preferences: per device, in localStorage (the same key
// public/theme-boot.js reads before the first paint). The shape, defaults and
// migration live in prefs-core.ts.

import { createEffect, createRoot, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { setNativeTheme } from "../lib/platform";
import { scaled } from "../lib/text-size";
import { appearanceOf, migratePrefs, PREF_DEFAULTS, showAppearance, type Appearance, type Prefs } from "./prefs-core";

export { ACCENTS, CHAT_WIDTHS, PREF_DEFAULTS, type AccentId, type ContrastId, type GlassId, type Prefs, type Scheme, type TintId } from "./prefs-core";

const KEY = "cavvy.prefs";

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

/** `n` px at text size 14, at the text size showing: what calc(n * var(--sp)) is in CSS (tokens.css). */
export const sp = (n: number) => scaled(n, prefs.fontSize);

/** The one scheme the theme showing is made for (state/theme.ts): the window follows it while it shows. theme-boot.js puts it on <html> before the first paint. */
const bootForced = () => {
    // Read where there's a page: the state's also loaded without one (tests, the terminal's shared code).
    const v = typeof document === "undefined" ? undefined : document.documentElement?.dataset?.themeOnly;
    return v === "light" || v === "dark" ? v : undefined;
};
export const [forcedScheme, setForcedScheme] = createSignal<"light" | "dark" | undefined>(bootForced());

/** The scheme of the theme on screen, while one is (state/theme.ts): the window turns light or dark with its crossfade, not before. */
export const [heldScheme, setHeldScheme] = createSignal<"light" | "dark" | undefined>(undefined);

/** What Settings needs to know of the theme showing (state/theme.ts sets it): kept here so Settings doesn't load the theme code. */
export const [themeTraits, setThemeTraits] = createSignal<{ name: string; scened: boolean; accent: boolean } | undefined>(undefined);

/** The scheme the window's own setting asks for, whatever a theme makes it. */
export function chosenScheme(): "light" | "dark" {
    return prefs.scheme === "system" ? (systemDark() ? "dark" : "light") : prefs.scheme;
}

/** The scheme actually showing. */
export function activeTheme(): "light" | "dark" {
    return forcedScheme() ?? chosenScheme();
}

createRoot(() => {
    // Only what changed goes to <html> (a write there can restyle the whole window), and the
    // native window hears only of a change of scheme (each time is a call to the app).
    let shown: Appearance | undefined;
    createEffect(() => {
        const next = appearanceOf(prefs, systemDark(), forcedScheme() ?? heldScheme());
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
