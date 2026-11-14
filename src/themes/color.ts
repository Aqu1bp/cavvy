// The colour arithmetic a theme needs: reading a hex colour, mixing two the way CSS color-mix() does in sRGB, laying
// a translucent colour over another, and WCAG 2 contrast. Shared by the window (which applies a theme) and the tools
// (which check one before it's saved), so both measure the same thing.

export interface Rgb {
    r: number;
    g: number;
    b: number;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHex(s: unknown): s is string {
    return typeof s === "string" && HEX.test(s.trim());
}

/** #rgb or #rrggbb; throws on anything else. */
export function parseHex(s: string): Rgb {
    const t = s.trim();
    if (!HEX.test(t)) throw new Error(`not a colour: ${s}`);
    const h = t.length === 4 ? [...t.slice(1)].map((c) => c + c).join("") : t.slice(1);
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

const byte = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

export function toHex(c: Rgb): string {
    return `#${[c.r, c.g, c.b].map((n) => byte(n).toString(16).padStart(2, "0")).join("")}`;
}

/** The colour as rgba() with `alpha`, for CSS. */
export function rgba(c: Rgb, alpha: number): string {
    return `rgba(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)}, ${Math.round(alpha * 1000) / 1000})`;
}

/** `a` with `share` (0–1) of it and the rest `b`: color-mix(in srgb, a share, b). */
export function mix(a: Rgb, b: Rgb, share: number): Rgb {
    return { r: a.r * share + b.r * (1 - share), g: a.g * share + b.g * (1 - share), b: a.b * share + b.b * (1 - share) };
}

/** `top` at `alpha` laid over `under`: what a browser draws (it blends in sRGB). */
export const over = (top: Rgb, alpha: number, under: Rgb): Rgb => mix(top, under, alpha);

function channel(v: number): number {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(c: Rgb): number {
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

export function contrast(a: Rgb, b: Rgb): number {
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number];
    return (x + 0.05) / (y + 0.05);
}

/** Whether text on `c` reads as on a light ground: it's nearer white than black by contrast. */
export const isLight = (c: Rgb) => contrast(c, BLACK) > contrast(c, WHITE);

export const WHITE: Rgb = { r: 255, g: 255, b: 255 };
export const BLACK: Rgb = { r: 0, g: 0, b: 0 };

/**
 * `c` moved toward `toward` just enough to reach `ratio` against `bg` (in steps of 2%), keeping as much of its own
 * hue as it can. `toward` is the theme's text colour: the one that's sure to read.
 */
export function reach(c: Rgb, bg: Rgb, ratio: number, toward: Rgb): Rgb {
    if (contrast(c, bg) >= ratio) return c;
    for (let k = 0.02; k <= 1; k += 0.02) {
        const m = mix(toward, c, k);
        if (contrast(m, bg) >= ratio) return m;
    }
    return toward;
}
