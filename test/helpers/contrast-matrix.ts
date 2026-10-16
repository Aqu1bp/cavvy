// Actual text/surface combinations used by the GUI. Keep layers bottom first:
// palette rows sit on dialogs, MCP cards on elevated surfaces, and Changes
// selections/hover states on the sidebar rather than on the window canvas.
import { cascade, contrast, parseRules, resolveColor, stack, type Root } from "./contrast";

export const AA = 4.5;
export const PANELS = ["--bg", "--bg-sidebar", "--bg-card", "--bg-panel", "--bg-elev", "--bg > --glass", "--bg > --pop", "--bg > --bg-subtle"];
export const ROWS = [
    "--bg-sidebar > --bg-hover",
    "--bg-sidebar > --bg-active",
    "--bg-sidebar > --bg-active > --bg-active",
    "--bg-elev > --bg-hover",
    "--bg-elev > --bg-subtle",
    "--bg-elev > --accent-soft",
    "--bg > --pop > --bg-hover",
];
export const CODE = ["--bg > --bg-code", "--bg-panel > --bg-code"];
export const DIFF_CODE = [...CODE, "--bg-panel > --bg-code > --add-bg", "--bg-panel > --bg-code > --del-bg"];
const NEUTRAL = [...PANELS, ...ROWS, "--bg-input", ...CODE, "--bg > --bg-hover", "--bg-user"];
const status = (soft: string) => [...PANELS, ...ROWS, `--bg > ${soft}`, `--bg-elev > ${soft}`];
const diff = (kind: "add" | "del") => [
    ...PANELS, ...ROWS, ...CODE,
    `--bg-panel > --bg-code > --${kind}-bg`,
    `--bg-panel > --bg-code > color-mix(in srgb, var(--${kind}-bg-strong) 70%, var(--bg-code))`,
];
const SHIKI = ["foreground", "token-keyword", "token-string", "token-string-expression", "token-comment", "token-function", "token-constant", "token-parameter", "token-punctuation", "token-link"];

/** Token/expression and the opaque surface or composited layers behind it. */
export const TEXT: [string, string[]][] = [
    ["--fg", [...NEUTRAL, "--bg > --find-bg", "--bg-user > --find-bg", "--bg-elev > --find-bg", "--bg-elev > --bg-hover > --find-bg"]],
    ["--fg-prose", [...PANELS, "--bg > --bg-code"]],
    ["--fg-muted", NEUTRAL],
    ["--fg-subtle", [...NEUTRAL, "--bg-panel > --bg-code > --bg-subtle"]],
    ["--link", PANELS],
    ["--accent-text", PANELS],
    ["--accent-fg", ["--accent", "--accent-hover", "--find-current-bg"]],
    ["--fg-inverse", ["--danger"]],
    ["--success", status("--success-soft")],
    ["--warning", status("--warning-soft")],
    ["--danger", status("--danger-soft")],
    ["--info", ["--bg-sidebar", ...ROWS.slice(0, 3)]],
    ["--shell", [...PANELS, "--bg-sidebar > color-mix(in srgb, var(--shell) 14%, transparent)", "color-mix(in srgb, var(--shell) 8%, var(--bg-user))"]],
    ["--auto", ["--bg", "--bg > --auto-soft"]],
    ["--add-fg", diff("add")],
    ["--del-fg", diff("del")],
    ...SHIKI.map((name): [string, string[]] => [`--shiki-${name}`, DIFF_CODE]),
];

/** Every declared theme and its actual light/dark scheme. */
export function themes(css: string): Root[] {
    return parseRules(css).flatMap((rule) => {
        const theme = rule.selectors.map((s) => /^\[data-theme="([^"]+)"\]$/.exec(s)?.[1]).find(Boolean);
        const scheme = rule.decls.get("color-scheme");
        return theme && (scheme === "light" || scheme === "dark") ? [{ theme, scheme }] : [];
    });
}

/** Include the default and every custom accent declared for each theme's scheme. */
export function configurations(css: string): Root[] {
    const selectors = parseRules(css).flatMap((r) => r.selectors);
    return themes(css).flatMap((root) => {
        const accents = new Set(selectors.flatMap((s) => {
            const match = /^\[data-scheme="([^"]+)"\]\[data-accent="([^"]+)"\]$/.exec(s);
            return match?.[1] === root.scheme ? [match[2]!] : [];
        }));
        return [root, ...[...accents].map((accent) => ({ ...root, accent }))];
    });
}

export interface Measurement {
    token: string;
    surface: string;
    ratio: number;
}

export function measure(css: string, root: Root): Measurement[] {
    const vars = cascade(parseRules(css), root);
    const color = (name: string) => resolveColor(name.startsWith("--") ? `var(${name})` : name, vars);
    return TEXT.flatMap(([token, surfaces]) => surfaces.map((surface) => ({
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
