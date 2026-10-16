// Appearance and UI preferences: per device, in localStorage (the same key
// public/theme-boot.js reads before the first paint).

import { createEffect, createRoot, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { setNativeTheme } from "../lib/platform";

export type ThemeId = "light" | "paper" | "dark" | "midnight" | "dusk" | "contrast";
export type AccentId = "blue" | "indigo" | "violet" | "pink" | "red" | "orange" | "green" | "teal" | "graphite";

export const THEMES: { id: ThemeId; name: string; scheme: "light" | "dark"; swatch: [string, string, string, string] }[] = [
    { id: "light", name: "Light", scheme: "light", swatch: ["#f8f8f8", "#ffffff", "#1d1d1f", "#2f6bff"] },
    { id: "paper", name: "Paper", scheme: "light", swatch: ["#f6f2eb", "#fffdf9", "#2b2520", "#c4572a"] },
    { id: "dark", name: "Dark", scheme: "dark", swatch: ["#131315", "#1c1c1f", "#ececee", "#6e9bff"] },
    { id: "midnight", name: "Midnight", scheme: "dark", swatch: ["#0a0e18", "#111827", "#e3e9f6", "#7c9dff"] },
    { id: "dusk", name: "Dusk", scheme: "dark", swatch: ["#15121d", "#1e1a29", "#e9e4f4", "#c4a7e7"] },
    { id: "contrast", name: "High contrast", scheme: "dark", swatch: ["#000000", "#000000", "#ffffff", "#5cb2ff"] },
];

export const ACCENTS: { id: AccentId; name: string; color: string }[] = [
    { id: "blue", name: "Blue", color: "#2f6bff" },
    { id: "indigo", name: "Indigo", color: "#4f46e5" },
    { id: "violet", name: "Violet", color: "#7c3aed" },
    { id: "pink", name: "Pink", color: "#db2777" },
    { id: "red", name: "Red", color: "#dc2626" },
    { id: "orange", name: "Orange", color: "#ea580c" },
    { id: "green", name: "Green", color: "#16a34a" },
    { id: "teal", name: "Teal", color: "#0d9488" },
    { id: "graphite", name: "Graphite", color: "#52525b" },
];

export interface Prefs {
    theme: ThemeId | "system";
    lightTheme: ThemeId;
    darkTheme: ThemeId;
    /** Unset: the theme's own accent. */
    accent?: AccentId;
    density: "comfortable" | "compact";
    fontSize: number;
    sidebar: boolean;
    panel: boolean;
    groupBy: "date" | "project";
    /** The sidebar's Settled list is open. */
    settledOpen: boolean;
    /** Enter sends (shift+enter for a newline); otherwise mod+enter sends. */
    enterSends: boolean;
    notifications: boolean;
    /** Tool activity starts expanded. */
    expandActivity: boolean;
    showThinking: boolean;
    sidebarWidth: number;
    /** The docked review pane. */
    reviewWidth: number;
    /** Model refs, in the order they were starred. */
    favoriteModels: string[];
    chatWidth: "narrow" | "default" | "wide";
    /** How panels and menus open and close. */
    motion: "instant" | "quick" | "smooth";
}

export const CHAT_WIDTHS: Record<Prefs["chatWidth"], number> = { narrow: 640, default: 736, wide: 880 };

const KEY = "harness.prefs";
const DEFAULTS: Prefs = {
    theme: "system",
    lightTheme: "light",
    darkTheme: "dark",
    density: "comfortable",
    fontSize: 14,
    sidebar: true,
    panel: false,
    groupBy: "date",
    settledOpen: true,
    enterSends: true,
    notifications: true,
    expandActivity: false,
    showThinking: true,
    sidebarWidth: 260,
    reviewWidth: 720,
    favoriteModels: [],
    chatWidth: "default",
    motion: "instant",
};

export { DEFAULTS as PREF_DEFAULTS };

function load(): Prefs {
    try {
        return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>) };
    } catch {
        return { ...DEFAULTS };
    }
}

export const [prefs, setPrefs] = createStore<Prefs>(load());

const media = typeof matchMedia !== "undefined" ? matchMedia("(prefers-color-scheme: dark)") : undefined;
const [systemDark, setSystemDark] = createSignal(media?.matches ?? false);
media?.addEventListener("change", (e) => setSystemDark(e.matches));

/** The theme actually showing. */
export function activeTheme(): ThemeId {
    if (prefs.theme !== "system") return prefs.theme;
    return systemDark() ? prefs.darkTheme : prefs.lightTheme;
}

createRoot(() => {
    createEffect(() => {
        const d = document.documentElement;
        const theme = activeTheme();
        d.dataset.theme = theme;
        const scheme = THEMES.find((t) => t.id === theme)?.scheme ?? "light";
        d.dataset.scheme = scheme;
        void setNativeTheme(scheme);
        if (prefs.accent) d.dataset.accent = prefs.accent;
        else delete d.dataset.accent;
        d.dataset.density = prefs.density;
        d.style.setProperty("--font-scale", String(prefs.fontSize / 14));
        d.style.setProperty("--sidebar-w", `${prefs.sidebarWidth}px`);
        d.style.setProperty("--review-w", `${prefs.reviewWidth}px`);
        d.style.setProperty("--column-w", `${CHAT_WIDTHS[prefs.chatWidth] ?? 736}px`);
        d.dataset.motion = prefs.motion;
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
