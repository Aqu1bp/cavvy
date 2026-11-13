// Actual text/surface combinations used by the GUI. Keep layers bottom first.
//
// The whole window is glass: --win-tint over whatever the desktop shows through. There is no single worst
// case for a translucent tint (white behind it hurts light text, black hurts dark text), so the reference
// desktop is a mid grey, #808080. With a Window tint, its wash lies over --win-tint: see washes().
// Everything else is laid over that: cards, wells inside cards, rows hovered and pressed, what floats.
import { cascade, contrast, parseRules, resolveColor, stack, type Root } from "./contrast";

export const AA = 4.5;
/** The window's glass over the reference desktop. */
export const GLASS_GROUND = "#808080 > --win-tint";
const G = GLASS_GROUND;
const on = (...layers: string[]) => [G, ...layers].join(" > ");
/** Straight on the glass (the rail, the title bar, the conversation's text), and its rows hovered and open. */
export const GLASS = [G, on("--hover"), on("--rail-hover"), on("--rail-sel"), on("--sheet-2"), on("--term-bg")];
/** Cards on the glass (a run of steps, a request, the composer), what you said, grouped settings, and rows in them. */
export const CARDS = [
    on("--card"), on("--card", "--hover"), on("--bubble"),
    on("--group"), on("--group", "--hover"), on("--raised"), on("--raised", "--hover"), on("--raised", "--accent-soft"),
];
/** Code and diffs: a well in a card or on the glass, and the opaque one a full diff uses. */
export const CODE = [on("--card", "--well"), on("--well"), "--well-solid"];
export const DIFF_CODE = [...CODE, ...["--add-bg", "--del-bg"].flatMap((tint) => [on("--card", "--well", tint), `--well-solid > ${tint}`])];
/** What floats for a moment (menus, popovers, dialogs, toasts), the drawer rail, and the window's opaque stand-in. */
export const FLOATING = [
    on("--ctl"), on("--ctl", "--hover"), on("--ctl-strong"), on("--ctl-strong", "--hover"),
    "#808080 > --rail-float", "#808080 > --rail-float > --rail-hover", "#808080 > --rail-float > --rail-sel",
    "--sheet", "--sheet > --hover",
];
const NEUTRAL = [...GLASS, ...CARDS, ...CODE, ...FLOATING];
const status = (soft: string) => [...GLASS, ...CARDS, ...FLOATING, on(soft), on("--card", soft)];
const diff = (kind: "add" | "del") => [
    ...GLASS, ...CARDS,
    on("--card", "--well", `--${kind}-bg`), `--well-solid > --${kind}-bg`,
    `--well-solid > color-mix(in srgb, var(--${kind}-bg-strong) 70%, transparent)`,
];
const SHIKI = ["foreground", "token-keyword", "token-string", "token-string-expression", "token-comment", "token-function", "token-constant", "token-parameter", "token-punctuation", "token-link"];

/** Token/expression and the composited layers behind it. */
export const TEXT: [string, string[]][] = [
    // A row or a button held down is there for a moment: its words, not every colour that can sit in one.
    ["--fg", [...NEUTRAL, on("--press"), on("--card", "--press"), on("--find"), on("--card", "--find"), on("--find-cur")]],
    ["--fg-2", NEUTRAL],
    ["--fg-3", NEUTRAL],
    ["--rail-fg", [...GLASS, ...FLOATING]],
    ["--rail-fg-2", [...GLASS, ...FLOATING]],
    ["--accent-text", [...GLASS, ...CARDS, ...FLOATING]],
    ["--accent-ink", ["--accent", "--accent-hover"]],
    // The one filled control, and a destructive button's words.
    ["--ink-fg", ["--ink", "--ink-hover"]],
    ["--sheet", ["--danger"]],
    ["--ok", status("--ok-soft")],
    ["--warn", [...status("--warn-soft"), on("--warn-bg"), on("--card", "--warn-bg")]],
    ["--danger", status("--danger-soft")],
    ["--shell", [...GLASS, ...CARDS, on("color-mix(in srgb, var(--shell) 14%, transparent)")]],
    ["--auto", [G, on("--card"), on("--auto-soft")]],
    ["--add-fg", diff("add")],
    ["--del-fg", diff("del")],
    ...SHIKI.map((name): [string, string[]] => [`--shiki-${name}`, DIFF_CODE]),
    // What you said: your words in the bubble (a shell line's is tinted).
    ["--fg", [on("--bubble", "color-mix(in srgb, var(--ok) 7%, transparent)")]],
    ["--fg-2", [on("--bubble", "color-mix(in srgb, var(--ok) 7%, transparent)")]],
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
