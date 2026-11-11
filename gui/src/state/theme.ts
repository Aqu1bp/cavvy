// Using a theme: its palettes are worked out here (lib/theme.ts), once, and saved with the preferences,
// so startup only applies them (public/theme-boot.js, state/prefs.ts). Loaded with Settings → Appearance,
// and at startup only when a saved palette was made by an older derive().

import { batch } from "solid-js";
import { DEFAULT_THEME, parseRecipe, themeCss, THEMES, type Theme } from "../lib/theme";
import { LOOK_VERSION, prefs, setPrefs } from "./prefs";

export const allThemes = (): Theme[] => [...THEMES, ...prefs.customThemes];
export const isCustom = (id: string) => prefs.customThemes.some((t) => t.id === id);
export const currentTheme = (): Theme => allThemes().find((t) => t.id === prefs.look) ?? DEFAULT_THEME;

/** Use `theme` from now on. The default clears the choice: tokens.css already is it. */
export function useTheme(theme: Theme) {
    const plain = theme.id === DEFAULT_THEME.id;
    batch(() => {
        setPrefs("look", plain ? undefined : theme.id);
        setPrefs("lookCss", plain ? undefined : themeCss(theme));
        setPrefs("lookShape", theme.shape);
        setPrefs("lookFace", theme.typeface);
        setPrefs("lookVersion", plain ? undefined : LOOK_VERSION);
    });
}

/** A saved palette from an older derive(), worked out again. */
export function refreshLook() {
    if (prefs.look) useTheme(currentTheme());
}

/** A name no other theme has: "Name", then "Name 2", "Name 3". */
function freeName(name: string, but?: string): string {
    const taken = new Set(allThemes().filter((t) => t.id !== but).map((t) => t.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`;
}

/** A theme of your own, starting from `from`, in use at once. */
export function newTheme(from: Theme, name = `${from.name} copy`): Theme {
    const theme: Theme = { hue: from.hue, tint: from.tint, accent: from.accent, shape: from.shape, typeface: from.typeface, id: `custom-${Date.now().toString(36)}`, name: freeName(name) };
    batch(() => {
        setPrefs("customThemes", [...prefs.customThemes, theme]);
        useTheme(theme);
    });
    return theme;
}

/** A change to one of your themes; the window follows when it's the one in use. */
export function editTheme(id: string, change: Partial<Omit<Theme, "id">>) {
    const at = prefs.customThemes.findIndex((t) => t.id === id);
    if (at < 0) return;
    const next = { ...prefs.customThemes[at]!, ...change };
    if (change.name !== undefined) next.name = freeName(change.name.trim() || "Untitled", id);
    batch(() => {
        setPrefs("customThemes", prefs.customThemes.map((t, i) => (i === at ? next : t)));
        if (prefs.look === id) useTheme(next);
    });
}

/** Removes one of your themes: the default takes its place if it was in use. Gives it back, to undo with. */
export function deleteTheme(id: string): Theme | undefined {
    const theme = prefs.customThemes.find((t) => t.id === id);
    if (!theme) return undefined;
    batch(() => {
        if (prefs.look === id) useTheme(DEFAULT_THEME);
        setPrefs("customThemes", prefs.customThemes.filter((t) => t.id !== id));
    });
    return theme;
}

export function restoreTheme(theme: Theme) {
    batch(() => {
        setPrefs("customThemes", [...prefs.customThemes.filter((t) => t.id !== theme.id), theme]);
        useTheme(theme);
    });
}

/** A theme as text, to keep or pass on: its name and choices, nothing worked out. */
export function themeText(theme: Theme): string {
    const { id: _id, ...rest } = theme;
    return JSON.stringify({ cavvyTheme: 1, ...rest });
}

/** The theme in `text` (what themeText writes), added to yours and in use; undefined when it isn't one. */
export function importTheme(text: string): Theme | undefined {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return undefined;
    }
    const recipe = parseRecipe(value);
    if (!recipe) return undefined;
    const name = (value as { name?: unknown }).name;
    return newTheme({ ...recipe, id: "", name: "" }, typeof name === "string" && name.trim() ? name.trim().slice(0, 40) : "Imported theme");
}
