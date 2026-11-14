// A theme's three colours become the window's whole palette: the custom properties tokens.css defines, worked out
// so every kind of text reaches WCAG AA on the theme's background. Colours the theme doesn't choose (diff green,
// warning amber, syntax) keep the scheme's own hues and are moved toward the text colour only as far as they must be.
//
// And the veil: how much of the window's colour lies over a scene so text reads on it. Measured from the scene's
// own pixels (the window samples them), not guessed.

import { BLACK, contrast, isLight, luminance, mix, over, parseHex, reach, rgba, toHex, WHITE, type Rgb } from "./color";
import type { Look, Scheme } from "./format";

/** What text must reach on the window. */
const AA = 4.5;
/**
 * What text that lies straight on a scene reaches on the plain background: a margin over AA, so a scene a little
 * off the background's tone needs a little veil, not all of it.
 */
const ON_SCENE = AA + 0.5;

/** The scheme's own colours for what a theme doesn't choose: tokens.css's values. */
const KEPT: Record<Scheme, Record<string, string>> = {
    light: {
        "--ok": "#0b5a30",
        "--warn": "#734300",
        "--danger": "#9b1c16",
        "--add-fg": "#11602f",
        "--del-fg": "#9c2622",
        "--syn-keyword": "#c2185b",
        "--syn-string": "#0b5a2b",
        "--syn-function": "#5b3fd0",
        "--syn-comment": "#6a6e76",
        "--syn-type": "#0b5fb0",
        "--plan": "#7c4dff",
        "--steer": "#7c4dff",
        "--auto": "#7b3e00",
        "--shell": "#055b52",
    },
    dark: {
        "--ok": "#74de9d",
        "--warn": "#ffc15c",
        "--danger": "#ffb0aa",
        "--add-fg": "#82dd9d",
        "--del-fg": "#ffb1ab",
        "--syn-keyword": "#ff8cbc",
        "--syn-string": "#8fe0a6",
        "--syn-function": "#b9a3ff",
        "--syn-comment": "#a6aab1",
        "--syn-type": "#6cb6ff",
        "--plan": "#a78bfa",
        "--steer": "#a78bfa",
        "--auto": "#f0a24a",
        "--shell": "#5eead4",
    },
};

/** The text colours that sit on the window itself: the veil is measured so each of them reads. */
export const WINDOW_TEXT = ["--fg", "--fg-2", "--fg-3", "--accent-text", "--ok", "--warn", "--danger"] as const;

export interface PaletteOptions {
    /** Settings → Appearance → Contrast: Increased. */
    high?: boolean;
    /** Settings → Appearance → Window: how much of the desktop shows through when the theme has no scene. */
    glass?: "glass" | "tinted" | "solid";
}

export interface Palette {
    /** Custom properties for <html>. */
    vars: Record<string, string>;
    /** The colours of the text that lies straight on the window, for measuring the veil. */
    text: Rgb[];
    background: Rgb;
}

const WIN_ALPHA = { glass: 0.8, tinted: 0.92, solid: 1 } as const;

export function palette(look: Look, scheme: Scheme, o: PaletteOptions = {}): Palette {
    const B = parseHex(look.colors.background);
    const T = parseHex(look.colors.text);
    const dark = scheme === "dark";
    // Light themes lift cards toward white, dark ones toward the text colour, as tokens.css does with white.
    const lift = dark ? T : WHITE;
    const ink = (share: number) => rgba(T, share);
    const fg2 = reach(mix(T, B, 0.84), B, AA + 1.5, T);
    const fg3 = reach(mix(T, B, o.high ? 0.82 : 0.7), B, AA + 0.7, T);
    const fg4 = mix(T, B, 0.45);
    const scened = Boolean(look.layers?.length);
    const vars: Record<string, string> = {
        // The window: with a scene, the scene is the window's ground (the backdrop draws it, and its veil); without,
        // the theme's colour over the desktop, as clear as Settings → Window says.
        "--win-tint": scened ? "transparent" : rgba(B, WIN_ALPHA[o.glass ?? "glass"]),
        "--win-wash": "none",
        "--tint-backdrop": scened ? "none" : `linear-gradient(${toHex(B)}, ${toHex(mix(B, dark ? BLACK : WHITE, 0.85))})`,
        "--backdrop": `linear-gradient(${toHex(B)}, ${toHex(B)})`,
        "--win-hi": dark ? rgba(T, 0.14) : rgba(WHITE, 0.7),
        "--sheet": toHex(B),
        "--sheet-2": ink(dark ? 0.06 : 0.05),
        "--card": rgba(lift, dark ? 0.07 : 0.6),
        "--card-stroke": ink(o.high ? 0.2 : dark ? 0.08 : 0.08),
        "--card-hi": rgba(lift, dark ? 0.06 : 0.7),
        "--well": dark ? rgba(BLACK, 0.26) : rgba(WHITE, 0.7),
        "--well-solid": toHex(mix(B, dark ? BLACK : WHITE, 0.82)),
        "--well-stroke": ink(dark ? 0.05 : 0.07),
        "--bubble": rgba(lift, dark ? 0.1 : 0.68),
        "--term-bg": dark ? rgba(BLACK, 0.2) : rgba(WHITE, 0.36),
        "--group": rgba(lift, dark ? 0.05 : 0.5),
        "--seg-on": dark ? rgba(T, 0.16) : "#ffffff",
        "--raised": rgba(lift, dark ? 0.05 : 0.7),
        "--ink": toHex(T),
        "--ink-fg": toHex(B),
        "--ink-hover": toHex(mix(T, B, 0.86)),
        "--fg": toHex(T),
        "--fg-2": toHex(fg2),
        "--fg-3": toHex(fg3),
        "--fg-4": toHex(fg4),
        "--line": ink(o.high ? 0.2 : dark ? 0.09 : 0.1),
        "--line-strong": ink(dark ? 0.16 : 0.18),
        "--hover": ink(dark ? 0.06 : 0.05),
        "--press": ink(dark ? 0.1 : 0.09),
        "--ctl": rgba(mix(B, lift, dark ? 0.9 : 0.75), dark ? 0.8 : 0.8),
        "--ctl-strong": rgba(mix(B, lift, dark ? 0.9 : 0.75), 0.94),
        "--ctl-stroke": ink(0.1),
        "--ctl-hi": dark ? rgba(T, 0.1) : rgba(WHITE, 0.95),
        "--ctl-lo": dark ? rgba(T, 0.02) : rgba(WHITE, 0.35),
        "--rail-sel": dark ? rgba(T, 0.1) : rgba(WHITE, 0.66),
        "--rail-sel-stroke": ink(dark ? 0.05 : 0.06),
        "--rail-float": rgba(B, 0.9),
        "--scrollbar": ink(dark ? 0.14 : 0.16),
    };
    const text: Rgb[] = [T, fg2, fg3];
    for (const [name, value] of Object.entries(KEPT[scheme])) {
        const c = reach(parseHex(value), B, (WINDOW_TEXT as readonly string[]).includes(name) ? ON_SCENE : AA, T);
        vars[name] = toHex(c);
        if (name === "--ok" || name === "--warn" || name === "--danger") text.push(c);
    }
    if (look.colors.accent) {
        const A = parseHex(look.colors.accent);
        vars["--accent"] = toHex(A);
        // Near-black where it reads, else pure black: a mid-tone accent can leave both white and near-black under AA.
        const nearBlack = parseHex("#0b0b10");
        const w = contrast(WHITE, A);
        const n = contrast(nearBlack, A);
        vars["--accent-ink"] = w >= AA && w >= n ? "#ffffff" : n >= AA ? "#0b0b10" : w >= AA ? "#ffffff" : "#000000";
        const accentText = reach(mix(A, T, dark ? 0.55 : 0.68), B, ON_SCENE, T);
        vars["--accent-text"] = toHex(accentText);
        text.push(accentText);
    }
    return { vars, text, background: B };
}

/**
 * How much of the background to lay over the scene so that every colour in `text` reaches AA on all but the brightest
 * (or darkest) sliver of it. `pixels`: the scene, sampled, as it's drawn behind the window. `floor`: the theme's own
 * least veil. Answers 0–0.96: never quite opaque, or the scene would be pointless.
 */
export function veilFor(text: Rgb[], background: Rgb, pixels: Rgb[], floor = 0, spare = 0.02): number {
    if (!pixels.length) return Math.max(floor, 0.5);
    // Contrast is a ratio of luminances: the text's are worked out once, each ground's once per try.
    const lums = text.map(luminance);
    const reads = (alpha: number) => {
        let bad = 0;
        const most = pixels.length * spare;
        for (const p of pixels) {
            const g = luminance(over(background, alpha, p));
            if (lums.some((t) => (Math.max(t, g) + 0.05) / (Math.min(t, g) + 0.05) < AA) && ++bad > most) return false;
        }
        return true;
    };
    if (reads(floor)) return floor;
    let lo = floor;
    let hi = 0.96;
    if (!reads(hi)) return hi;
    for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2;
        if (reads(mid)) hi = mid;
        else lo = mid;
    }
    return Math.ceil(hi * 100) / 100;
}

/** Whether the theme's background reads as a light window: decides which of the app's built-in hues it starts from. */
export const lightBackground = (hex: string) => isLight(parseHex(hex));

/**
 * The veil as a map: `cols` × `rows` cells over the scene, each as much as the pixels in and around it need (veilFor
 * on its own pixels, then the most of it and its eight neighbours). Drawn as a tiny image stretched over the stage,
 * which blends each cell into the next: between two cells' centres the blend is never below either one's own need,
 * because each holds the most its neighbours need too. Busy corners get covered; a calm sky stays clear.
 * `pixels` is row-major, `width` × `height`.
 */
export function veilMap(text: Rgb[], background: Rgb, pixels: Rgb[], width: number, height: number, cols: number, rows: number, floor = 0): number[] {
    const own: number[] = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const cell: Rgb[] = [];
            const x0 = Math.floor((c * width) / cols);
            const x1 = Math.floor(((c + 1) * width) / cols);
            const y0 = Math.floor((r * height) / rows);
            const y1 = Math.floor(((r + 1) * height) / rows);
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cell.push(pixels[y * width + x]!);
            own.push(veilFor(text, background, cell, floor));
        }
    }
    const out: number[] = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            let most = 0;
            for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                const rr = r + dr;
                const cc = c + dc;
                if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) most = Math.max(most, own[rr * cols + cc]!);
            }
            out.push(most);
        }
    }
    return out;
}
