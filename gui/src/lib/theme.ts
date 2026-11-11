// A theme is a few choices; every colour in the app is worked out from them.
//
// derive() turns a recipe into the palette tokens.css declares for one scheme: surfaces as steps of
// lightness in the theme's own hue, then each text colour moved just far enough from the surfaces it
// sits on to read (WCAG AA, 4.5:1). So a theme can't be made unreadable, whatever is picked.
// test/theme.test.ts checks that against the app's contrast matrix for the built-in themes and for
// recipes drawn at random, and that tokens.css holds exactly what the default recipe gives
// (scripts/theme-tokens.ts writes it).
//
// No DOM here: state/theme.ts applies a theme, Settings → Appearance edits one.

export type Scheme = "light" | "dark";
export type Shape = "sharp" | "soft" | "round";
export type Typeface = "system" | "mono" | "serif";

export interface ThemeRecipe {
    /** The neutrals' hue, in degrees (OKLCH): 250 is the cool grey of the default. */
    hue: number;
    /** How much of that hue the neutrals carry, 0 (pure grey) to 1. */
    tint: number;
    /** The accent, as #rrggbb: nudged lighter or darker per scheme only as far as its label needs to read. */
    accent: string;
    shape?: Shape;
    typeface?: Typeface;
}

export interface Theme extends ThemeRecipe {
    id: string;
    name: string;
}

export const DEFAULT_THEME: Theme = { id: "cavvy", name: "Cavvy", hue: 262, tint: 0.3, accent: "#2a6bff" };

/** The built-in looks. The first is what tokens.css holds; the rest are worked out when picked. */
export const THEMES: Theme[] = [
    DEFAULT_THEME,
    { id: "graphite", name: "Graphite", hue: 262, tint: 0, accent: "#5b5f6b" },
    { id: "paper", name: "Paper", hue: 78, tint: 0.62, accent: "#c2572b", typeface: "serif" },
    { id: "midnight", name: "Midnight", hue: 275, tint: 1, accent: "#8b7bff" },
    { id: "fjord", name: "Fjord", hue: 228, tint: 0.85, accent: "#3a9fc8" },
    { id: "forest", name: "Forest", hue: 152, tint: 0.7, accent: "#1f9d62" },
    { id: "rose", name: "Rosé", hue: 8, tint: 0.6, accent: "#d6447a" },
    { id: "solar", name: "Solar", hue: 92, tint: 0.9, accent: "#b7791f" },
    { id: "terminal", name: "Terminal", hue: 150, tint: 0.35, accent: "#22a559", shape: "sharp", typeface: "mono" },
];

// ---- Colour ----------------------------------------------------------------

type Rgb = [number, number, number];
interface Rgba { r: number; g: number; b: number; a: number }

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function oklchToLinear(L: number, C: number, h: number): Rgb {
    const a = C * Math.cos((h * Math.PI) / 180);
    const b = C * Math.sin((h * Math.PI) / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

/** An OKLCH colour as sRGB, its chroma lowered until it fits the gamut (so lightness and hue hold). */
function oklch(L: number, C: number, h: number): Rgba {
    const fits = (c: number) => oklchToLinear(L, c, h).every((v) => v >= -0.0005 && v <= 1.0005);
    let c = C;
    if (!fits(c)) {
        let lo = 0;
        let hi = C;
        for (let i = 0; i < 18; i++) {
            const mid = (lo + hi) / 2;
            if (fits(mid)) lo = mid;
            else hi = mid;
        }
        c = lo;
    }
    const [r, g, b] = oklchToLinear(L, c, h).map((v) => Math.round(clamp(toGamma(clamp(v))) * 255)) as Rgb;
    return { r, g, b, a: 1 };
}

function toOklch(c: Rgba): { L: number; C: number; h: number } {
    const [r, g, b] = [c.r, c.g, c.b].map((v) => toLinear(v / 255)) as Rgb;
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, C: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

export function parseHex(hex: string): Rgba | undefined {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return undefined;
    const n = parseInt(m[1]!, 16);
    return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: 1 };
}

const hex = (c: Rgba) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
const alpha = (c: Rgba, a: number): Rgba => ({ ...c, a });
const css = (c: Rgba) => (c.a >= 1 ? hex(c) : `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${+c.a.toFixed(3)})`);

/** `top` laid over an opaque `under`. */
function over(top: Rgba, under: Rgba): Rgba {
    return { r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 };
}

const stack = (layers: Rgba[]) => layers.reduce((under, top) => over(top, under));
const mix = (a: Rgba, b: Rgba, share: number): Rgba => ({ r: a.r * share + b.r * (1 - share), g: a.g * share + b.g * (1 - share), b: a.b * share + b.b * (1 - share), a: 1 });

function luminance(c: Rgba): number {
    const [r, g, b] = [c.r, c.g, c.b].map((v) => toLinear(v / 255)) as Rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast of two opaque colours. */
export function contrast(a: Rgba, b: Rgba): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
}

/** What the app asks of text (WCAG AA), with a little kept in hand for rounding to 8 bits. */
const AA = 4.5;
const SAFE = AA + 0.12;

/**
 * The colour at chroma `C` and hue `h` nearest lightness `from` that reads on every one of `grounds`,
 * looking away from them (darker in light, lighter in dark). `on` gives the grounds for a candidate
 * where they depend on the colour itself (a tint of it laid under it).
 */
function readable(from: number, C: number, h: number, dark: boolean, on: (c: Rgba) => Rgba[], want = SAFE): Rgba {
    const ok = (L: number) => {
        const c = oklch(L, C, h);
        return on(c).every((g) => contrast(c, g) >= want);
    };
    if (ok(from)) return oklch(from, C, h);
    let near = from;
    let far = dark ? 1 : 0;
    for (let i = 0; i < 22; i++) {
        const mid = (near + far) / 2;
        if (ok(mid)) far = mid;
        else near = mid;
    }
    return oklch(far, C, h);
}

// ---- The palette -----------------------------------------------------------

/** Hues that mean something, the same in every theme: only their lightness follows the scheme. */
const HUE = { ok: 152, warn: 72, danger: 26, plan: 292, auto: 55, shell: 186, keyword: 355, string: 150, fn: 292, type: 250 };

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
/** The desktop the contrast test puts behind the window's glass. */
const DESK: Rgba = { r: 128, g: 128, b: 128, a: 1 };

/** The palette of one scheme, as tokens.css declares it: custom property name → value. */
export function derive(recipe: ThemeRecipe, scheme: Scheme): Record<string, string> {
    const dark = scheme === "dark";
    const h = ((recipe.hue % 360) + 360) % 360;
    const t = clamp(recipe.tint);
    // Neutrals: a surface carries a little of the hue, ink more, and the darkest surfaces of a dark theme the most.
    const n = (L: number, strength: number) => oklch(L, t * strength, h);
    const surface = (L: number) => n(L, dark ? 0.03 : 0.014 + (1 - L) * 0.25);

    const sheet = surface(dark ? 0.212 : 0.992);
    const sheet2 = surface(dark ? 0.25 : 0.964);
    const bubble = surface(dark ? 0.272 : 0.95);
    const inspBg = surface(dark ? 0.225 : 0.98);
    const termBg = surface(dark ? 0.187 : 0.975);
    const group = surface(dark ? 0.24 : 0.967);
    const segOn = dark ? surface(0.31) : n(1, 0);
    const raised = dark ? sheet2 : segOn;
    const winBase = dark ? n(0.165, 0.032) : surface(0.958);
    const ink = dark ? WHITE : n(0.22, 0.05);

    const fg = n(dark ? 0.945 : 0.215, dark ? 0.012 : 0.03);
    const fg2 = n(dark ? 0.79 : 0.4, dark ? 0.018 : 0.03);
    const line = alpha(ink, dark ? 0.075 : 0.085);
    const lineStrong = alpha(ink, dark ? 0.14 : 0.16);
    const hover = alpha(ink, dark ? 0.055 : 0.045);
    const press = alpha(ink, dark ? 0.095 : 0.08);

    const ctl = alpha(dark ? surface(0.28) : n(1, 0), dark ? 0.66 : 0.7);
    const ctlStrong = alpha(dark ? surface(0.285) : n(1, 0), dark ? 0.9 : 0.88);
    const winTint = alpha(winBase, 0.6);
    const railFloat = alpha(dark ? surface(0.235) : winBase, dark ? 0.86 : 0.84);
    const railSel = alpha(WHITE, dark ? 0.1 : 0.66);
    const railHover = alpha(WHITE, dark ? 0.055 : 0.34);

    // Every surface text sits on, as the app layers them (test/helpers/contrast-matrix.ts).
    const sheets = [sheet, sheet2, inspBg, termBg, group, segOn, raised, bubble];
    const layered = [
        ...sheets,
        ...[sheet, sheet2, group, inspBg, raised].map((s) => over(hover, s)),
        over(press, sheet),
        over(ctl, sheet),
        over(ctlStrong, sheet),
        over(ctlStrong, sheet2),
        stack([sheet, ctlStrong, hover]),
    ];
    const glass = [
        over(winTint, DESK),
        stack([DESK, winTint, railHover]),
        stack([DESK, winTint, railSel]),
        over(railFloat, DESK),
        stack([DESK, railFloat, railHover]),
        stack([DESK, railFloat, railSel]),
    ];
    const text = (from: number, C: number, hue: number, extra: (c: Rgba) => Rgba[] = () => []) => readable(from, C, hue, dark, (c) => [...layered, ...extra(c)]);
    const soft = (c: Rgba, share: number, grounds: Rgba[]) => grounds.map((g) => over(alpha(c, share), g));

    // A selected row is a wash of the accent, whichever one is picked: the theme's own, or the palest (dark) or deepest
    // (light) of Settings' nine.
    const washed = (accents: Rgba[]) => accents.map((a) => over(alpha(a, 0.12), raised));
    const fg3 = text(dark ? 0.68 : 0.53, t * (dark ? 0.02 : 0.03), h, () => washed([parseHex(dark ? "#d4d4d8" : "#3f3f46")!, parseHex(recipe.accent) ?? WHITE]));
    const fg3Hi = n(dark ? 0.78 : 0.42, 0.03);
    const fg4 = n(dark ? 0.47 : 0.72, 0.025);
    const railFg = n(dark ? 0.955 : 0.22, 0.03);
    const railFg2 = readable(dark ? 0.86 : 0.37, t * 0.03, h, dark, () => glass);

    // The accent keeps its hue and colourfulness; its lightness moves only as far as it must for its label
    // to read on it (in white, else in ink) and for itself to read as text: links and the selected tab are
    // the accent mixed toward --fg (tokens.css, --accent-text).
    const picked = toOklch(parseHex(recipe.accent) ?? parseHex(DEFAULT_THEME.accent)!);
    const accentAt = (L: number) => oklch(clamp(L), picked.C, picked.h);
    const hoverOf = (c: Rgba) => mix(c, BLACK, 0.88);
    const asText = (c: Rgba) => mix(c, fg, dark ? 0.55 : 0.82);
    const inkLabel = n(0.16, 0.03);
    const works = (c: Rgba, label: Rgba) => contrast(label, c) >= SAFE && contrast(label, hoverOf(c)) >= SAFE && layered.every((g) => contrast(asText(c), g) >= SAFE);
    const start = clamp(picked.L, dark ? 0.5 : 0.36, dark ? 0.86 : 0.68);
    let [accent, accentInk, moved] = [accentAt(dark ? 0.7 : 0.45), dark ? inkLabel : WHITE, Infinity];
    for (const label of [WHITE, inkLabel]) {
        for (const step of [-0.004, 0.004]) {
            for (let i = 0; i < 250; i++) {
                const L = start + i * step;
                if (L < 0 || L > 1 || i * 0.004 >= moved) break;
                if (!works(accentAt(L), label)) continue;
                [accent, accentInk, moved] = [accentAt(L), label, i * 0.004];
                break;
            }
        }
    }

    // Status and code colours: a fixed hue each, as colourful as the scheme takes, read on every surface
    // and on their own soft fills.
    const tone = (hue: number, L: number, C: number, share = 0.12) => text(L, C, hue, (c) => soft(c, share, [sheet, sheet2, raised]));
    const ok = tone(HUE.ok, dark ? 0.8 : 0.5, dark ? 0.15 : 0.13);
    const warn = text(dark ? 0.84 : 0.52, dark ? 0.13 : 0.12, HUE.warn, (c) => [...soft(c, 0.12, [sheet, sheet2, raised]), ...soft(oklch(0.82, 0.15, HUE.warn), dark ? 0.13 : 0.16, [sheet, sheet2])]);
    const danger = tone(HUE.danger, dark ? 0.74 : 0.52, dark ? 0.17 : 0.19);
    const plan = tone(HUE.plan, dark ? 0.76 : 0.52, dark ? 0.14 : 0.2);
    const auto = tone(HUE.auto, dark ? 0.79 : 0.52, dark ? 0.14 : 0.14);
    const shell = text(dark ? 0.85 : 0.47, dark ? 0.12 : 0.09, HUE.shell, (c) => [over(alpha(c, 0.14), inspBg), mix(c, sheet2, 0.08)]);

    const addBg = dark ? alpha(oklch(0.62, 0.17, HUE.ok), 0.16) : oklch(0.955, 0.035, HUE.ok);
    const addStrong = dark ? alpha(oklch(0.62, 0.17, HUE.ok), 0.34) : oklch(0.9, 0.07, HUE.ok);
    const delBg = dark ? alpha(oklch(0.64, 0.2, HUE.danger), 0.15) : oklch(0.955, 0.028, HUE.danger);
    const delStrong = dark ? alpha(oklch(0.64, 0.2, HUE.danger), 0.32) : oklch(0.895, 0.06, HUE.danger);
    const codeGrounds = [sheet, sheet2, inspBg, termBg];
    const diffText = (hue: number, bg: Rgba, strong: Rgba, C: number) =>
        text(dark ? 0.82 : 0.46, C, hue, () => [...codeGrounds.map((g) => over(bg, g)), over(strong, sheet), over(alpha(mix(over(strong, sheet2), sheet2, 0.7), 1), sheet2)]);
    const addFg = diffText(HUE.ok, addBg, addStrong, dark ? 0.14 : 0.12);
    const delFg = diffText(HUE.danger, delBg, delStrong, dark ? 0.13 : 0.16);
    // Code sits on the sheet, on a code block, and on a diff's added and removed lines.
    const code = (hue: number, L: number, C: number) => readable(L, C, hue, dark, () => [...codeGrounds, ...[sheet, sheet2, termBg].flatMap((g) => [over(addBg, g), over(delBg, g)])]);
    const find = alpha(oklch(0.86, 0.17, 88), dark ? 0.28 : 0.38);
    const findCur = alpha(oklch(0.78, 0.17, 62), dark ? 0.52 : 0.7);
    const fgSafe = readable(toOklch(fg).L, toOklch(fg).C, h, dark, () => [...layered, over(find, sheet), over(find, sheet2), over(findCur, sheet), stack([raised, hover, find])]);

    const shade = (a: number) => css(alpha(dark ? BLACK : n(0.2, 0.06), a));
    const glow = (a: number) => css(alpha(WHITE, a));
    const blob = (L: number, C: number, hue: number) => hex(oklch(L, C, hue));
    const backdrop = dark
        ? `radial-gradient(60% 55% at 12% 8%, ${blob(0.3, 0.05 + t * 0.03, h + 40)} 0%, transparent 62%), radial-gradient(55% 60% at 90% 16%, ${blob(0.29, 0.06 + t * 0.03, h - 14)} 0%, transparent 64%), radial-gradient(70% 60% at 60% 100%, ${blob(0.27, 0.05 + t * 0.03, h + 80)} 0%, transparent 66%), linear-gradient(160deg, ${blob(0.2, 0.02, h + 30)}, ${blob(0.17, 0.03, h)})`
        : `radial-gradient(60% 55% at 12% 8%, ${blob(0.92, 0.035 + t * 0.02, h + 40)} 0%, transparent 62%), radial-gradient(55% 60% at 90% 16%, ${blob(0.9, 0.04 + t * 0.02, h - 14)} 0%, transparent 64%), radial-gradient(70% 60% at 60% 100%, ${blob(0.91, 0.03 + t * 0.02, h + 80)} 0%, transparent 66%), linear-gradient(160deg, ${blob(0.94, 0.015, h + 30)}, ${blob(0.9, 0.025, h)})`;

    return {
        "color-scheme": scheme,
        "--win-base": hex(winBase),
        "--win-stroke": css(alpha(BLACK, dark ? 0.6 : 0.22)),
        "--win-hi": glow(dark ? 0.14 : 0.7),
        "--backdrop": backdrop,

        "--sheet": hex(sheet),
        "--sheet-2": hex(sheet2),
        "--bubble": hex(bubble),
        "--insp-bg": hex(inspBg),
        "--term-bg": hex(termBg),
        "--group": hex(group),
        "--seg-on": hex(segOn),
        "--raised": dark ? "var(--sheet-2)" : "var(--seg-on)",
        "--sheet-shadow": dark ? `0 0 0 0.5px ${glow(0.09)}, inset 0 1px 0 ${glow(0.045)}, 0 18px 44px -16px ${shade(0.7)}` : `0 0 0 0.5px ${shade(0.1)}, 0 1px 2px ${shade(0.04)}, 0 14px 36px -16px ${shade(0.26)}`,

        "--fg": hex(fgSafe),
        "--fg-2": hex(fg2),
        "--fg-3": hex(fg3),
        "--fg-3-hi": hex(fg3Hi),
        "--fg-4": hex(fg4),
        "--line": css(line),
        "--line-hi": css(alpha(ink, dark ? 0.16 : 0.18)),
        "--line-strong": css(lineStrong),
        "--hover": css(hover),
        "--press": css(press),

        "--ctl": css(ctl),
        "--ctl-strong": css(ctlStrong),
        "--ctl-stroke": css(alpha(ink, dark ? 0.1 : 0.09)),
        "--ctl-hi": glow(dark ? 0.13 : 0.95),
        "--ctl-lo": glow(dark ? 0.03 : 0.35),
        "--ctl-shadow": dark ? `0 1px 1px ${shade(0.3)}, 0 14px 32px -10px ${shade(0.65)}` : `0 1px 1px ${shade(0.04)}, 0 10px 28px -10px ${shade(0.2)}`,
        "--pop-shadow": dark ? `0 0 0 0.5px ${glow(0.11)}, 0 24px 56px -12px ${shade(0.78)}` : `0 0 0 0.5px ${shade(0.12)}, 0 18px 48px -12px ${shade(0.28)}`,
        "--sheen": `linear-gradient(180deg, ${glow(dark ? 0.07 : 0.55)}, ${glow(0)} 46%)`,

        "--rail-fg": hex(railFg),
        "--rail-fg-2": hex(railFg2),
        "--rail-sel": css(railSel),
        "--rail-sel-stroke": glow(dark ? 0.14 : 0.9),
        "--rail-hover": css(railHover),
        "--rail-float": css(railFloat),

        "--accent": hex(accent),
        "--accent-ink": hex(accentInk),

        "--ok": hex(ok),
        "--warn": hex(warn),
        "--warn-bg": css(alpha(oklch(0.82, 0.15, HUE.warn), dark ? 0.13 : 0.16)),
        "--danger": hex(danger),
        "--add-bg": css(addBg),
        "--add-bg-strong": css(addStrong),
        "--add-fg": hex(addFg),
        "--del-bg": css(delBg),
        "--del-bg-strong": css(delStrong),
        "--del-fg": hex(delFg),
        "--find": css(find),
        "--find-cur": css(findCur),

        "--syn-keyword": hex(code(HUE.keyword, dark ? 0.78 : 0.5, dark ? 0.15 : 0.2)),
        "--syn-string": hex(code(HUE.string, dark ? 0.84 : 0.44, dark ? 0.13 : 0.12)),
        "--syn-function": hex(code(HUE.fn, dark ? 0.8 : 0.47, dark ? 0.12 : 0.2)),
        "--syn-comment": hex(code(h, dark ? 0.67 : 0.53, t * 0.02)),
        "--syn-type": hex(code(HUE.type, dark ? 0.77 : 0.48, dark ? 0.12 : 0.16)),

        "--plan": hex(plan),
        "--steer": hex(plan),
        "--auto": hex(auto),
        "--shell": hex(shell),
        "--stop": hex(oklch(dark ? 0.64 : 0.61, 0.21, HUE.danger)),
        "--shadow-sm": `0 1px 2px ${shade(dark ? 0.3 : 0.05)}`,
        "--scrollbar": css(alpha(ink, dark ? 0.13 : 0.16)),
    };
}

/** What a theme changes besides colour: the corners of controls, and the typeface. */
export function shapeOf(recipe: ThemeRecipe): Record<string, string> {
    const shape = recipe.shape ?? "soft";
    const face = recipe.typeface ?? "system";
    return { "data-shape": shape, "data-face": face };
}

/** A recipe from anything: saved prefs, an imported file. Undefined when it isn't one. */
export function parseRecipe(value: unknown): ThemeRecipe | undefined {
    const v = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
    if (!v || typeof v.hue !== "number" || typeof v.tint !== "number" || typeof v.accent !== "string" || !Number.isFinite(v.hue) || !Number.isFinite(v.tint) || !parseHex(v.accent)) return undefined;
    const shape = v.shape === "sharp" || v.shape === "soft" || v.shape === "round" ? v.shape : undefined;
    const typeface = v.typeface === "system" || v.typeface === "mono" || v.typeface === "serif" ? v.typeface : undefined;
    return { hue: ((v.hue % 360) + 360) % 360, tint: clamp(v.tint), accent: `#${/^#?([0-9a-f]{6})$/i.exec(v.accent.trim())![1]!.toLowerCase()}`, ...(shape ? { shape } : {}), ...(typeface ? { typeface } : {}) };
}

/** Both schemes of a theme as a stylesheet over tokens.css's own palettes. */
export function themeCss(recipe: ThemeRecipe): string {
    const block = (scheme: Scheme) => `[data-theme="${scheme}"]{${Object.entries(derive(recipe, scheme)).map(([k, v]) => `${k}:${v}`).join(";")}}`;
    return block("light") + block("dark");
}
