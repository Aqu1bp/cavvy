// The parts of the preferences with no side effects: their shape, defaults,
// the migration of older saved preferences, and how they're shown on <html>.
// public/theme-boot.js repeats migratePrefs, appearanceOf and showAppearance in plain JS so
// the first paint is right; test/gui-prefs.test.ts keeps the two in step.

export type Scheme = "system" | "light" | "dark";
export type AccentId = "blue" | "indigo" | "violet" | "pink" | "red" | "orange" | "green" | "teal" | "graphite";
/** Settings → Appearance → Window: how much of the desktop shows through. */
export type GlassId = "glass" | "tinted" | "solid";
export type ContrastId = "standard" | "high";
/** Settings → Appearance → Window tint: the colour laid on the glass behind the rail. */
export type TintId = "clear" | "ocean" | "accent";

export const ACCENTS: { id: AccentId; name: string; color: string }[] = [
    { id: "blue", name: "Blue", color: "#2a6bff" },
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
    scheme: Scheme;
    /** Unset: blue, the default. */
    accent?: AccentId;
    glass: GlassId;
    tint: TintId;
    contrast: ContrastId;
    density: "comfortable" | "compact";
    fontSize: number;
    sidebar: boolean;
    panel: boolean;
    groupBy: "date" | "project";
    /** The sidebar's Settled list is open. */
    settledOpen: boolean;
    /** Grouped by project: the projects (by path) whose sessions are folded under their heading. */
    collapsedProjects: string[];
    /** Enter sends (shift+enter for a newline); otherwise mod+enter sends. */
    enterSends: boolean;
    notifications: boolean;
    /** Tool activity starts expanded. */
    expandActivity: boolean;
    showThinking: boolean;
    sidebarWidth: number;
    terminalHeight: number;
    /** The docked review pane. */
    reviewWidth: number;
    /** Model refs, in the order they were starred. */
    favoriteModels: string[];
    chatWidth: "narrow" | "default" | "wide";
    /** How panels and menus open and close. */
    motion: "instant" | "quick" | "smooth";
}

export const CHAT_WIDTHS: Record<Prefs["chatWidth"], number> = { narrow: 640, default: 736, wide: 880 };

export const PREF_DEFAULTS: Prefs = {
    scheme: "system",
    glass: "glass",
    tint: "clear",
    contrast: "standard",
    density: "comfortable",
    fontSize: 14,
    sidebar: true,
    panel: false,
    groupBy: "date",
    settledOpen: true,
    collapsedProjects: [],
    enterSends: true,
    notifications: true,
    expandActivity: false,
    showThinking: true,
    sidebarWidth: 260,
    terminalHeight: 260,
    reviewWidth: 720,
    favoriteModels: [],
    chatWidth: "default",
    // "instant" came from t3code; new installs get quick panels. Saved prefs keep their value (they're stored whole).
    motion: "quick",
};

const SCHEMES: readonly string[] = ["system", "light", "dark"];
const GLASSES: readonly string[] = ["glass", "tinted", "solid"];
const TINTS: readonly string[] = ["clear", "ocean", "accent"];
const CONTRASTS: readonly string[] = ["standard", "high"];

/**
 * Saved preferences in today's shape. The six named themes became a scheme
 * plus Contrast: light and paper are light, dark, midnight and dusk are dark,
 * high contrast is dark with Contrast on high, and system stays system. The
 * per-scheme theme choices (lightTheme, darkTheme) are dropped. Unknown
 * appearance values are left out, so the defaults apply; everything else
 * passes through untouched.
 */
export function migratePrefs(saved: unknown): Partial<Prefs> {
    const p = saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
    const { theme, lightTheme: _light, darkTheme: _dark, ...out } = p;
    if (!SCHEMES.includes(out.scheme as string)) {
        delete out.scheme;
        if (theme === "light" || theme === "paper") out.scheme = "light";
        else if (theme === "dark" || theme === "midnight" || theme === "dusk" || theme === "contrast") out.scheme = "dark";
        else if (theme === "system") out.scheme = "system";
    }
    if (!CONTRASTS.includes(out.contrast as string)) {
        delete out.contrast;
        if (theme === "contrast") out.contrast = "high";
    }
    if (!GLASSES.includes(out.glass as string)) delete out.glass;
    if (!TINTS.includes(out.tint as string)) delete out.tint;
    if (!ACCENTS.some((a) => a.id === out.accent)) delete out.accent;
    // Folded projects: a list of paths, or the default (none).
    if ("collapsedProjects" in out && !(Array.isArray(out.collapsedProjects) && out.collapsedProjects.every((c) => typeof c === "string"))) delete out.collapsedProjects;
    return out as Partial<Prefs>;
}

/** What showAppearance writes to: <html>, or a stand-in in tests. */
export interface AppearanceTarget {
    dataset: Record<string, string | undefined>;
    style: { setProperty(name: string, value: string): void };
}

/** How the preferences show on <html>: its data attributes (undefined: none), its custom properties, and the scheme showing. */
export interface Appearance {
    theme: "light" | "dark";
    dataset: Record<string, string | undefined>;
    style: Record<string, string>;
}

export function appearanceOf(p: Prefs, systemDark: boolean): Appearance {
    const theme = p.scheme === "system" ? (systemDark ? "dark" : "light") : p.scheme;
    return {
        theme,
        dataset: { theme, scheme: theme, glass: p.glass, tint: p.tint, contrast: p.contrast, accent: p.accent, density: p.density, motion: p.motion },
        style: {
            "--font-scale": String(p.fontSize / 14),
            "--sidebar-w": `${p.sidebarWidth}px`,
            "--review-w": `${p.reviewWidth}px`,
            "--column-w": `${CHAT_WIDTHS[p.chatWidth] ?? CHAT_WIDTHS.default}px`,
        },
    };
}

/**
 * Writes `next` to <html>: all of it, or with `before` (what's there now) only what differs. Each
 * write to <html> can restyle the whole window, so a change of one preference writes only its own.
 */
export function showAppearance(d: AppearanceTarget, next: Appearance, before?: Appearance): void {
    for (const [key, value] of Object.entries(next.dataset)) {
        if (before && before.dataset[key] === value) continue;
        if (value === undefined) delete d.dataset[key];
        else d.dataset[key] = value;
    }
    for (const [name, value] of Object.entries(next.style)) {
        if (before?.style[name] !== value) d.style.setProperty(name, value);
    }
}
