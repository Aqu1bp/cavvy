// Settings → Appearance → Text size (12–18): sizes are written at 14, the default, and follow the
// text from there. In CSS that's calc(N * var(--sp)) (tokens.css); these are the same in script.

/** `n` px at text size 14, at text size `size`. */
export const scaled = (n: number, size: number) => (n * size) / 14;

/** The terminal's text: 12px at 14, in whole pixels so its cells stay crisp. */
export const terminalFontSize = (size: number) => Math.round(scaled(12, size));
