// The parts of the preferences with no side effects: their shape, defaults,
// the migration of older saved preferences, and how they're shown on <html>.
// public/theme-boot.js repeats migratePrefs and applyAppearance in plain JS so
// the first paint is right; test/gui-prefs.test.ts keeps the two in step.

export type Scheme = "system" | "light" | "dark";
export type AccentId = "blue" | "indigo" | "violet" | "pink" | "red" | "orange" | "green" | "teal" | "graphite";
/** Settings → Appearance → Window: how much of the desktop shows through. */
export type GlassId = "glass" | "tinted" | "solid";
export type ContrastId = "standard" | "high";

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
    contrast: ContrastId;
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
    contrast: "standard",
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
    terminalHeight: 260,
    reviewWidth: 720,
    favoriteModels: [],
    chatWidth: "default",
    motion: "instant",
};

const SCHEMES: readonly string[] = ["system", "light", "dark"];
const GLASSES: readonly string[] = ["glass", "tinted", "solid"];
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
    if (!ACCENTS.some((a) => a.id === out.accent)) delete out.accent;
    return out as Partial<Prefs>;
}

/** What applyAppearance writes to: <html>, or a stand-in in tests. */
export interface AppearanceTarget {
    dataset: Record<string, string | undefined>;
    style: { setProperty(name: string, value: string): void };
}

/** Shows the preferences on <html>; returns the scheme showing. */
export function applyAppearance(d: AppearanceTarget, p: Prefs, systemDark: boolean): "light" | "dark" {
    const theme = p.scheme === "system" ? (systemDark ? "dark" : "light") : p.scheme;
    d.dataset.theme = theme;
    d.dataset.scheme = theme;
    d.dataset.glass = p.glass;
    d.dataset.contrast = p.contrast;
    if (p.accent) d.dataset.accent = p.accent;
    else delete d.dataset.accent;
    d.dataset.density = p.density;
    d.dataset.motion = p.motion;
    d.style.setProperty("--font-scale", String(p.fontSize / 14));
    d.style.setProperty("--sidebar-w", `${p.sidebarWidth}px`);
    d.style.setProperty("--review-w", `${p.reviewWidth}px`);
    d.style.setProperty("--column-w", `${CHAT_WIDTHS[p.chatWidth] ?? CHAT_WIDTHS.default}px`);
    return theme;
}
