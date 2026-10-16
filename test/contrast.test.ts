// Every GUI theme's text colors must reach WCAG AA (4.5:1) on the surfaces
// that text sits on. Ratios are computed from tokens.css itself, so a new
// theme, or a token nudged back toward the background, fails here.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { cascade, contrast, over, parseRules, resolveColor, stack } from "./helpers/contrast";
import { AA, configurations, failures, measure, themes } from "./helpers/contrast-matrix";

const CSS = readFileSync(resolve(import.meta.dir, "../gui/src/styles/tokens.css"), "utf8");
describe("WCAG contrast of GUI text tokens", () => {
    test("finds all six themes with their schemes", () => {
        expect(themes(CSS).map((t) => `${t.theme}/${t.scheme}`)).toEqual(["light/light", "paper/light", "dark/dark", "midnight/dark", "dusk/dark", "contrast/dark"]);
    });

    test("includes custom accents in both schemes", () => {
        for (const theme of ["light", "dark"]) {
            expect(configurations(CSS).filter((c) => c.theme === theme).map((c) => c.accent)).toEqual([
                undefined, "blue", "indigo", "violet", "pink", "red", "orange", "green", "teal", "graphite",
            ]);
        }
    });

    for (const root of configurations(CSS)) {
        test(`${root.theme}/${root.accent ?? "default"}: text reaches ${AA}:1 on its surfaces`, () => {
            expect(failures(CSS, root)).toEqual([]);
        });
    }

    test("a text token lowered back toward the background fails", () => {
        // The pre-fix light --fg-subtle, appended so it wins the cascade.
        const lowered = `${CSS}\n[data-theme="light"] { --fg-subtle: #a1a1a6; }`;
        const result = measure(lowered, { theme: "light", scheme: "light" }).find((m) => m.token === "--fg-subtle" && m.surface === "--bg");
        expect(result?.ratio).toBeCloseTo(2.57, 2);
        expect(failures(lowered, { theme: "light", scheme: "light" }).some((f) => f.startsWith("--fg-subtle on "))).toBe(true);
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

// A passing token is not enough if an entire card/turn is faded afterwards.
// Reintroducing the old .75/.55 opacity must fail even with the new tokens.
for (const [file, selector, surface] of [
    ["layout.css", ".card.rec", "--bg-sidebar"],
    ["transcript.css", ".turn.archived", "--bg"],
] as const) {
    test(`${selector}: group opacity preserves secondary-text contrast`, () => {
        const rules = parseRules(readFileSync(resolve(import.meta.dir, `../gui/src/styles/${file}`), "utf8"));
        const opacity = Number(rules.filter((r) => r.selectors.includes(selector) && r.decls.has("opacity")).at(-1)?.decls.get("opacity") ?? 1);
        for (const root of themes(CSS)) {
            const vars = cascade(parseRules(CSS), root);
            const bg = resolveColor(`var(${surface})`, vars);
            for (const token of ["--fg-muted", "--fg-subtle"]) {
                const text = over(resolveColor(`var(${token})`, vars), bg);
                expect(contrast({ ...text, a: opacity }, bg)).toBeGreaterThanOrEqual(AA);
            }
        }
    });
}
