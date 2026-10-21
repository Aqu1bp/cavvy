// Actual text/surface combinations used by the GUI. Keep layers bottom first:
// palette rows sit on dialogs, MCP cards on raised surfaces, and Changes
// selections/hover states on the inspector rather than on the window canvas.
import { cascade, contrast, parseRules, resolveColor, stack, type Root } from "./contrast";

export const AA = 4.5;
// "--sheet > --hover" also covers the lighter half-strength hover rows once used.
export const PANELS = ["--sheet", "--insp-bg", "--raised", "--sheet > --ctl-strong", "--sheet > --hover"];
export const ROWS = [
    "--insp-bg > --hover",
    "--sheet-2",
    "--raised > --hover",
    "--raised > --accent-soft",
    "--sheet > --ctl-strong > --hover",
];
export const CODE = ["--sheet-2"];
export const DIFF_CODE = [...CODE, "--sheet-2 > --add-bg", "--sheet-2 > --del-bg"];
const NEUTRAL = [...PANELS, ...ROWS];
const status = (soft: string) => [...PANELS, ...ROWS, `--sheet > ${soft}`, `--raised > ${soft}`];
const diff = (kind: "add" | "del") => [
    ...PANELS, ...ROWS,
    `--sheet-2 > --${kind}-bg`,
    `--sheet-2 > color-mix(in srgb, var(--${kind}-bg-strong) 70%, var(--sheet-2))`,
];
/** The redesign's sheet and what sits on it. Glass controls and menus (--ctl, --ctl-strong) are measured over the sheet. */
export const SHEET = [
    "--sheet", "--sheet-2", "--insp-bg", "--term-bg", "--group", "--seg-on",
    "--sheet > --hover", "--sheet-2 > --hover", "--group > --hover", "--insp-bg > --hover",
    "--sheet > --ctl", "--sheet > --ctl-strong", "--sheet > --ctl-strong > --hover", "--sheet-2 > --ctl-strong",
];
/**
 * The rail sits on the window glass, not the sheet: --win-tint over whatever
 * the desktop shows through. There is no single worst case for a translucent
 * tint (white behind it hurts light text, black hurts dark text), so the
 * reference desktop is a mid grey, #808080. With a Window tint, its wash lies
 * over --win-tint: see washes().
 */
export const GLASS = [
    "#808080 > --win-tint", "#808080 > --win-tint > --rail-hover", "#808080 > --win-tint > --rail-sel",
    "#808080 > --rail-float", "#808080 > --rail-float > --rail-hover", "#808080 > --rail-float > --rail-sel",
];
const SHEET_CODE = ["--sheet", "--sheet-2", "--insp-bg", "--term-bg", "--sheet > --add-bg", "--sheet > --del-bg", "--term-bg > --add-bg", "--term-bg > --del-bg"];
const SHIKI = ["foreground", "token-keyword", "token-string", "token-string-expression", "token-comment", "token-function", "token-constant", "token-parameter", "token-punctuation", "token-link"];

/** Token/expression and the opaque surface or composited layers behind it. */
export const TEXT: [string, string[]][] = [
    ["--fg", [...NEUTRAL, "--sheet > --find", "--sheet-2 > --find", "--raised > --find", "--raised > --hover > --find"]],
    ["--fg-2", NEUTRAL],
    ["--fg-3", NEUTRAL],
    ["--accent-text", [...PANELS, ...ROWS.slice(0, 2)]],
    ["--sheet", ["--danger"]],
    ["--ok", status("--ok-soft")],
    ["--warn", status("--warn-soft")],
    ["--danger", status("--danger-soft")],
    ["--shell", [...PANELS, "--insp-bg > color-mix(in srgb, var(--shell) 14%, transparent)", "color-mix(in srgb, var(--shell) 8%, var(--sheet-2))"]],
    ["--auto", ["--sheet", "--sheet > --auto-soft"]],
    ["--add-fg", diff("add")],
    ["--del-fg", diff("del")],
    ...SHIKI.map((name): [string, string[]] => [`--shiki-${name}`, [...DIFF_CODE, ...SHEET_CODE]]),

    // The redesign's sheet, glass controls and rail.
    ["--fg", [...SHEET, "--sheet > --press", "--sheet > --find", "--sheet-2 > --find", "--sheet > --find-cur"]],
    ["--fg-2", SHEET],
    ["--fg-3", SHEET],
    ["--accent-text", SHEET],
    ["--accent-ink", ["--accent", "--accent-hover"]],
    ["--rail-fg", GLASS],
    ["--rail-fg-2", GLASS],
    ["--ok", [...SHEET, "--sheet > color-mix(in srgb, var(--ok) 12%, transparent)"]],
    ["--warn", [...SHEET, "--sheet > --warn-bg", "--sheet-2 > --warn-bg"]],
    ["--danger", [...SHEET, "--sheet > color-mix(in srgb, var(--danger) 12%, transparent)"]],
    ["--add-fg", ["--sheet > --add-bg", "--sheet-2 > --add-bg", "--term-bg > --add-bg", "--sheet > --add-bg-strong"]],
    ["--del-fg", ["--sheet > --del-bg", "--sheet-2 > --del-bg", "--term-bg > --del-bg", "--sheet > --del-bg-strong"]],
];

/** Every declared theme and its actual light/dark scheme. */
export function themes(css: string): Root[] {
    return parseRules(css).flatMap((rule) => {
        const theme = rule.selectors.map((s) => /^\[data-theme="([^"]+)"\]$/.exec(s)?.[1]).find(Boolean);
        const scheme = rule.decls.get("color-scheme");
        return theme && (scheme === "light" || scheme === "dark") ? [{ theme, scheme }] : [];
    });
}

/** Values a token file declares for one attribute, e.g. every [data-glass="…"]. */
function declared(selectors: string[], attr: string): string[] {
    return [...new Set(selectors.flatMap((s) => [...s.matchAll(new RegExp(`\\[data-${attr}="([^"]+)"\\]`, "g"))].map((m) => m[1]!)))];
}

/**
 * Each theme as the app sets it up (clear tint, glass window, standard
 * contrast), then with every Window tint, Window and Contrast setting the
 * file declares, and with every custom accent declared for its scheme under
 * every tint and Window (the accent tint is made of the accent).
 */
export function configurations(css: string): Root[] {
    const selectors = parseRules(css).flatMap((r) => r.selectors);
    const tints = ["clear", ...declared(selectors, "tint").filter((t) => t !== "clear")];
    const glasses = ["glass", ...declared(selectors, "glass").filter((g) => g !== "glass")];
    const contrasts = ["standard", ...declared(selectors, "contrast").filter((c) => c !== "standard")];
    return themes(css).flatMap((theme) => {
        const root: Root = { ...theme, tint: "clear", glass: "glass", contrast: "standard" };
        const accents = new Set(selectors.flatMap((s) => {
            const match = /^\[data-scheme="([^"]+)"\]\[data-accent="([^"]+)"\]$/.exec(s);
            return match?.[1] === root.scheme ? [match[2]!] : [];
        }));
        return tints.flatMap((tint) => {
            const looks = glasses.flatMap((glass) => contrasts.map((contrast) => ({ ...root, tint, glass, contrast })));
            return [...looks, ...glasses.flatMap((glass) => [...accents].map((accent) => ({ ...root, tint, glass, accent })))];
        });
    });
}

export interface Measurement {
    token: string;
    surface: string;
    ratio: number;
}

/**
 * The Window tint's wash (tokens.css): radial blobs (--wash-1..3) over a
 * linear ground (--wash-top to --wash-end), all laid over --win-tint. Every
 * point of the window shows one ground stop, under at most one blob at full
 * strength, so those are the stacks measured. None with Clear.
 */
export function washes(vars: Map<string, string>): string[] {
    if (!vars.has("--wash-top")) return [];
    return ["--wash-top", "--wash-end"].flatMap((ground) => [ground, ...["--wash-1", "--wash-2", "--wash-3"].map((blob) => `${ground} > ${blob}`)]);
}

export function measure(css: string, root: Root): Measurement[] {
    const vars = cascade(parseRules(css), root);
    const color = (name: string) => resolveColor(name.startsWith("--") ? `var(${name})` : name, vars);
    const wash = washes(vars);
    // With a tint, nothing sits on the bare --win-tint: put each wash stack over it.
    const tinted = (surface: string) => (wash.length && surface.includes("--win-tint") ? wash.map((w) => surface.replace("--win-tint", `--win-tint > ${w}`)) : [surface]);
    return TEXT.flatMap(([token, surfaces]) => surfaces.flatMap(tinted).map((surface) => ({
        token,
        surface,
        ratio: contrast(color(token), stack(surface.split(" > ").map(color))),
    })));
}

/** One actionable worst case per token, avoiding hundreds of duplicate failures. */
export function failures(css: string, root: Root): string[] {
    const worst = new Map<string, Measurement>();
    for (const result of measure(css, root)) {
        if (result.ratio < AA && result.ratio < (worst.get(result.token)?.ratio ?? Infinity)) worst.set(result.token, result);
    }
    return [...worst.values()].map((m) => `${m.token} on ${m.surface}: ${m.ratio.toFixed(2)}:1`);
}
