// Every GUI palette's text colors must reach WCAG AA (4.5:1) on the surfaces
// that text sits on, with every Window tint (clear, ocean, accent), Window
// (glass, tinted, solid), Contrast and accent setting. Ratios are computed from tokens.css itself, so a new
// palette, or a token nudged back toward the background, fails here.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { cascade, contrast, over, parseRules, resolveColor, stack } from "./helpers/contrast";
import { AA, configurations, failures, GLASS_GROUND, measure, themes } from "./helpers/contrast-matrix";

const CSS = readFileSync(resolve(import.meta.dir, "../gui/src/styles/tokens.css"), "utf8");

// The owner's decision, 2026-11-28 ("just make it look like the mock entirely"): the remix design's own secondary
// text, status, diff, comment and accent colours, though some fall below AA on some surfaces. Only these are relaxed,
// and only at standard Contrast: primary text (--fg, --fg-2, --rail-fg, --ink-fg) stays at AA everywhere, and with
// Contrast on Increased every token does (tokens.css raises these there). DESIGN pins their values to the design's,
// so they can't drift lower unnoticed.
const RELAXED = ["--fg-3", "--accent-text", "--accent-ink", "--ok", "--warn", "--danger", "--add-fg", "--del-fg", "--shiki-token-comment"];
const relaxed = (root: { contrast?: string }, failure: string) => root.contrast !== "high" && RELAXED.some((t) => failure.startsWith(`${t} on `));
const DESIGN: Record<"light" | "dark", Record<string, string>> = {
    light: { "--fg-3": "#8a857c", "--ok": "#1c8651", "--warn": "#a86200", "--danger": "#c7372a", "--add-fg": "#17703f", "--del-fg": "#b0281c", "--syn-comment": "#979187", "--accent-text": "#2444c4", "--accent-ink": "#ffffff" },
    dark: { "--fg-3": "#86817a", "--ok": "#52c48c", "--warn": "#f0b04a", "--danger": "#ff7b69", "--add-fg": "#6fd3a0", "--del-fg": "#ff9384", "--syn-comment": "#7a756e", "--accent-text": "#a6b7ff", "--accent-ink": "#10142a" },
};
describe("WCAG contrast of GUI text tokens", () => {
    test("finds the two palettes with their schemes", () => {
        expect(themes(CSS).map((t) => `${t.theme}/${t.scheme}`)).toEqual(["light/light", "dark/dark"]);
    });

    test("includes custom accents in both schemes", () => {
        for (const theme of ["light", "dark"]) {
            expect(configurations(CSS).filter((c) => c.theme === theme && c.tint === "clear" && c.glass === "glass" && c.contrast === "standard").map((c) => c.accent)).toEqual([
                undefined, "blue", "indigo", "violet", "pink", "red", "orange", "green", "teal", "graphite",
            ]);
        }
    });

    test("includes every Window and Contrast setting in both schemes", () => {
        for (const theme of ["light", "dark"]) {
            expect(configurations(CSS).filter((c) => c.theme === theme && c.tint === "clear" && !c.accent).map((c) => `${c.glass}/${c.contrast}`)).toEqual([
                "glass/standard", "glass/high", "tinted/standard", "tinted/high", "solid/standard", "solid/high",
            ]);
        }
    });

    test("includes every Window tint with every Window and accent, in both schemes", () => {
        for (const theme of ["light", "dark"]) {
            const looks = configurations(CSS).filter((c) => c.theme === theme);
            for (const tint of ["clear", "ocean", "accent"]) {
                for (const glass of ["glass", "tinted", "solid"]) {
                    expect(looks.filter((c) => c.tint === tint && c.glass === glass && c.accent).map((c) => c.accent)).toEqual([
                        "blue", "indigo", "violet", "pink", "red", "orange", "green", "teal", "graphite",
                    ]);
                }
            }
        }
    });

    test("measures the window's text over each stop of a tint's wash, laid over the window tint", () => {
        for (const tint of ["ocean", "accent"]) {
            const rail = measure(CSS, { theme: "dark", scheme: "dark", tint, glass: "glass", contrast: "standard" }).filter((m) => m.token === "--rail-fg-2");
            const surfaces = rail.map((m) => m.surface);
            for (const ground of ["--wash-top", "--wash-end"]) {
                expect(surfaces).toContain(`#808080 > --win-tint > ${ground} > --rail-sel`);
                for (const blob of ["--wash-1", "--wash-2", "--wash-3"]) expect(surfaces).toContain(`#808080 > --win-tint > ${ground} > ${blob} > --rail-hover`);
            }
            expect(surfaces).not.toContain("#808080 > --win-tint");
            // The drawer rail has its own ground, over the window: no wash.
            expect(surfaces).toContain("#808080 > --rail-float");
        }
    });

    test("a tint whose wash is too strong for the text on it fails", () => {
        // The mockup's raw Ocean blue, without the light tint the mockup lays over it.
        const strong = `${CSS}\n[data-tint="ocean"][data-theme="light"] { --wash-3: rgba(61, 111, 216, 0.75); }`;
        const root = { theme: "light", scheme: "light" as const, tint: "ocean", glass: "glass", contrast: "standard" };
        expect(failures(CSS, root).filter((f) => !relaxed(root, f))).toEqual([]);
        expect(failures(strong, root).some((f) => f.startsWith("--rail-fg-2 on ") && f.includes("--wash-3"))).toBe(true);
    });

    test("measures the window's text over the window tint on a mid-grey desktop", () => {
        const rail = measure(CSS, { theme: "dark", scheme: "dark", glass: "glass", contrast: "standard" }).filter((m) => m.token === "--rail-fg-2");
        expect(rail.map((m) => m.surface)).toContain("#808080 > --win-tint");
    });

    for (const root of configurations(CSS)) {
        test(`${root.theme}/${root.tint}/${root.glass}/${root.contrast}/${root.accent ?? "default"}: text reaches ${AA}:1 on its surfaces`, () => {
            expect(failures(CSS, root).filter((f) => !relaxed(root, f))).toEqual([]);
        });
    }

    test("the relaxed tokens are the design's own values, and only they are relaxed", () => {
        for (const scheme of ["light", "dark"] as const) {
            const vars = cascade(parseRules(CSS), { theme: scheme, scheme, contrast: "standard" });
            for (const [name, value] of Object.entries(DESIGN[scheme])) expect(`${scheme} ${name} ${vars.get(name)}`).toBe(`${scheme} ${name} ${value}`);
        }
        // Primary text is never relaxed: a lowered --fg fails at standard Contrast.
        const lowered = `${CSS}\n[data-theme="light"] { --fg: #a1a1a6; }`;
        const root = { theme: "light", scheme: "light" as const, contrast: "standard" };
        expect(failures(lowered, root).filter((f) => !relaxed(root, f)).some((f) => f.startsWith("--fg on "))).toBe(true);
        // With Contrast on Increased, nothing is.
        expect(relaxed({ contrast: "high" }, "--fg-3 on #808080 > --win-tint: 3.00:1")).toBe(false);
    });

    test("a text token lowered back toward the background fails", () => {
        // The pre-fix light --fg-3, appended so it wins the cascade.
        const lowered = `${CSS}\n[data-theme="light"] { --fg-3: #a1a1a6; }`;
        const result = measure(lowered, { theme: "light", scheme: "light" }).find((m) => m.token === "--fg-3" && m.surface === GLASS_GROUND);
        expect(result?.ratio).toBeLessThan(2.5);
        expect(failures(lowered, { theme: "light", scheme: "light" }).some((f) => f.startsWith("--fg-3 on "))).toBe(true);
    });

    test("a color syntax it can't read fails instead of passing", () => {
        const lowered = `${CSS}\n[data-theme="light"] { --fg-3: rgb(161 161 166); }`;
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
    ["sidebar.css", ".card.rec", GLASS_GROUND],
    ["transcript.css", ".turn.archived", GLASS_GROUND],
] as const) {
    test(`${selector}: group opacity preserves secondary-text contrast`, () => {
        const rules = parseRules(readFileSync(resolve(import.meta.dir, `../gui/src/styles/${file}`), "utf8"));
        const opacity = Number(rules.filter((r) => r.selectors.includes(selector) && r.decls.has("opacity")).at(-1)?.decls.get("opacity") ?? 1);
        for (const root of themes(CSS)) {
            const vars = cascade(parseRules(CSS), root);
            const bg = stack(surface.split(" > ").map((layer) => resolveColor(layer.startsWith("--") ? `var(${layer})` : layer, vars)));
            // --fg-3 is relaxed at standard Contrast (RELAXED above): the fade mustn't take --fg-2 below AA.
            for (const token of ["--fg-2"]) {
                const text = over(resolveColor(`var(${token})`, vars), bg);
                expect(contrast({ ...text, a: opacity }, bg)).toBeGreaterThanOrEqual(AA);
            }
        }
    });
}
