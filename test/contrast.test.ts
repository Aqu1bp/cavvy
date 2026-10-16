// Every GUI theme's text colors must reach WCAG AA (4.5:1) on the surfaces
// that text sits on. Ratios are computed from tokens.css itself, so a new
// theme, or a token nudged back toward the background, fails here.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { cascade, contrast, parseRules, resolveColor, stack, type Root } from "./helpers/contrast";

const CSS = readFileSync(resolve(import.meta.dir, "../gui/src/styles/tokens.css"), "utf8");
const AA = 4.5;

// Surfaces as layers, bottom first: a translucent token is measured over what it sits on.
const PANELS = ["--bg", "--bg-sidebar", "--bg-card", "--bg-panel", "--bg-elev", "--bg > --glass", "--bg > --pop", "--bg > --bg-subtle"];
// Neutral text also sits in inputs, code and diffs, and on chips and kbd (--bg-hover at rest).
const NEUTRAL = [...PANELS, "--bg-input", "--bg > --bg-code", "--bg > --bg-hover"];
const status = (soft: string) => [...PANELS, `--bg > ${soft}`, `--bg-elev > ${soft}`];
const diff = (bg: string) => ["--bg", "--bg-sidebar", "--bg > --bg-subtle", "--bg > --bg-code", `--bg > --bg-code > ${bg}`];

/** Each token used as a text color, and the surfaces it is used on. */
const TEXT: [string, string[]][] = [
    ["--fg", [...NEUTRAL, "--bg-user"]],
    ["--fg-prose", NEUTRAL],
    ["--fg-muted", [...NEUTRAL, "--bg-user"]],
    ["--fg-subtle", NEUTRAL],
    ["--link", PANELS],
    ["--accent-text", PANELS],
    ["--accent-fg", ["--bg > --accent"]],
    ["--success", status("--success-soft")],
    ["--warning", status("--warning-soft")],
    ["--danger", status("--danger-soft")],
    ["--auto", ["--bg", "--bg > --auto-soft"]],
    ["--add-fg", diff("--add-bg")],
    ["--del-fg", diff("--del-bg")],
];

/** Each theme block in the file, with the scheme it declares. */
function themes(css: string): Root[] {
    return parseRules(css).flatMap((rule) => {
        const theme = rule.selectors.map((s) => /^\[data-theme="([^"]+)"\]$/.exec(s)?.[1]).find(Boolean);
        const scheme = rule.decls.get("color-scheme");
        return theme && (scheme === "light" || scheme === "dark") ? [{ theme, scheme }] : [];
    });
}

function measure(css: string, root: Root) {
    const vars = cascade(parseRules(css), root);
    const color = (name: string) => resolveColor(`var(${name})`, vars);
    return TEXT.flatMap(([token, surfaces]) =>
        surfaces.map((surface) => ({ token, surface, ratio: contrast(color(token), stack(surface.split(" > ").map(color))) })),
    );
}

const failures = (css: string, root: Root) =>
    measure(css, root)
        .filter((m) => m.ratio < AA)
        .map((m) => `${m.token} on ${m.surface}: ${m.ratio.toFixed(2)}:1`);

describe("WCAG contrast of GUI text tokens", () => {
    test("finds all six themes with their schemes", () => {
        expect(themes(CSS).map((t) => `${t.theme}/${t.scheme}`)).toEqual(["light/light", "paper/light", "dark/dark", "midnight/dark", "dusk/dark", "contrast/dark"]);
    });

    for (const root of themes(CSS)) {
        test(`${root.theme}: every text token reaches ${AA}:1 on its surfaces`, () => {
            expect(failures(CSS, root)).toEqual([]);
        });
    }

    test("a text token lowered back toward the background fails", () => {
        // The pre-fix light --fg-subtle, appended so it wins the cascade.
        const lowered = `${CSS}\n[data-theme="light"] { --fg-subtle: #a1a1a6; }`;
        expect(failures(lowered, { theme: "light", scheme: "light" })).toContain("--fg-subtle on --bg: 2.57:1");
    });

    test("a color syntax it can't read fails instead of passing", () => {
        const lowered = `${CSS}\n[data-theme="light"] { --fg-subtle: rgb(161 161 166); }`;
        expect(() => failures(lowered, { theme: "light", scheme: "light" })).toThrow("unsupported");
    });

    test("measures what the WCAG definition gives", () => {
        const vars = new Map<string, string>();
        const c = (v: string) => resolveColor(v, vars);
        expect(contrast(c("#000000"), c("#ffffff"))).toBeCloseTo(21, 5);
        expect(contrast(c("#777777"), c("#ffffff"))).toBeCloseTo(4.48, 2);
        // Translucent layers composite before measuring: 50% black over white is sRGB 0.5, 0.214 linear: 1.05 / 0.264.
        expect(contrast(c("#ffffff"), stack([c("#ffffff"), c("color-mix(in srgb, #000000 50%, transparent)")]))).toBeCloseTo(3.98, 2);
    });
});
