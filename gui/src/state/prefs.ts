// Appearance and UI preferences: per device, in localStorage (the same key
// public/theme-boot.js reads before the first paint).

import { createEffect, createRoot, createSignal } from "solid-js";
import { createStore } from "solid-js/store";

export type ThemeId = "light" | "paper" | "dark" | "midnight" | "dusk" | "contrast";
export type AccentId = "blue" | "indigo" | "violet" | "pink" | "red" | "orange" | "green" | "teal" | "graphite";

export const THEMES: { id: ThemeId; name: string; scheme: "light" | "dark"; swatch: [string, string, string, string] }[] = [
    { id: "light", name: "Light", scheme: "light", swatch: ["#ffffff", "#f7f7f5", "#1c1c1f", "#2f6bff"] },
    { id: "paper", name: "Paper", scheme: "light", swatch: ["#fbf9f5", "#f3eee6", "#2b2520", "#c4572a"] },
    { id: "dark", name: "Dark", scheme: "dark", swatch: ["#161618", "#111113", "#ededef", "#6e9bff"] },
    { id: "midnight", name: "Midnight", scheme: "dark", swatch: ["#0c111d", "#090d17", "#e3e9f6", "#7c9dff"] },
    { id: "dusk", name: "Dusk", scheme: "dark", swatch: ["#1a1724", "#15121e", "#e9e4f4", "#c4a7e7"] },
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
    panelTab: "changes" | "plan" | "context";
    groupBy: "date" | "project";
    /** Enter sends (shift+enter for a newline); otherwise mod+enter sends. */
    enterSends: boolean;
    notifications: boolean;
    /** Tool activity starts expanded. */
    expandActivity: boolean;
    showThinking: boolean;
    sidebarWidth: number;
    panelWidth: number;
}

const KEY = "harness.prefs";
const DEFAULTS: Prefs = {
    theme: "system",
    lightTheme: "light",
    darkTheme: "dark",
    density: "comfortable",
    fontSize: 14,
    sidebar: true,
    panel: false,
    panelTab: "changes",
    groupBy: "date",
    enterSends: true,
    notifications: true,
    expandActivity: false,
    showThinking: true,
    sidebarWidth: 268,
    panelWidth: 440,
};

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
        d.dataset.scheme = THEMES.find((t) => t.id === theme)?.scheme ?? "light";
        if (prefs.accent) d.dataset.accent = prefs.accent;
        else delete d.dataset.accent;
        d.dataset.density = prefs.density;
        d.style.setProperty("--font-scale", String(prefs.fontSize / 14));
        d.style.setProperty("--sidebar-w", `${prefs.sidebarWidth}px`);
        d.style.setProperty("--panel-w", `${prefs.panelWidth}px`);
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
