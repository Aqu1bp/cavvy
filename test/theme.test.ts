// A theme is a few choices (gui/src/lib/theme.ts), and the palette worked out from them has to read:
// every built-in theme, and any recipe at all, must pass the app's contrast matrix (the one
// test/contrast.test.ts holds tokens.css to), with every Window, Window tint, Contrast and accent
// setting. And tokens.css must hold exactly what the default recipe gives.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { configurations, failures } from "./helpers/contrast-matrix";
import { DEFAULT_THEME, derive, parseRecipe, themeCss, THEMES, type ThemeRecipe } from "../gui/src/lib/theme";
import { withPalettes } from "../scripts/theme-tokens";

const CSS = readFileSync(resolve(import.meta.dir, "../gui/src/styles/tokens.css"), "utf8");

/** tokens.css as the window has it with a theme applied: the theme's palettes after the file's own. */
const themed = (recipe: ThemeRecipe) => `${CSS}\n${themeCss(recipe).replaceAll("{", " {\n").replaceAll(";", ";\n").replaceAll("}", "}\n")}`;

/** Every failure of a recipe, across every setting the file declares. */
function unreadable(recipe: ThemeRecipe, every = true): string[] {
    const css = themed(recipe);
    const looks = configurations(css).filter((c) => every || (c.tint === "clear" && !c.accent));
    return looks.flatMap((root) => failures(css, root).map((f) => `${root.theme}/${root.tint}/${root.glass}/${root.contrast}/${root.accent ?? "theme"}: ${f}`));
}

/** The same sequence every run. */
function seeded(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe("themes", () => {
    test("tokens.css holds what the default theme gives", () => {
        expect(withPalettes(CSS)).toBe(CSS);
        expect(THEMES[0]).toBe(DEFAULT_THEME);
    });

    for (const theme of THEMES) {
        test(`${theme.name}: text reads on its surfaces with every setting`, () => {
            expect(unreadable(theme)).toEqual([]);
        });
    }

    test("any recipe reads: 300 drawn at random, extremes included", () => {
        const random = seeded(20261111);
        const hexOf = () => `#${Math.floor(random() * 0xffffff).toString(16).padStart(6, "0")}`;
        const edge = ["#000000", "#ffffff", "#ffff00", "#00ff00", "#ff0000", "#0000ff", "#808080", "#00ffff", "#ff00ff"];
        const recipes: ThemeRecipe[] = [
            ...edge.flatMap((accent) => [0, 1].map((tint) => ({ hue: 90, tint, accent }))),
            ...[...Array(300)].map(() => ({ hue: random() * 360, tint: random() < 0.2 ? Math.round(random()) : random(), accent: hexOf() })),
        ];
        const bad = recipes.flatMap((r) => unreadable(r, false).slice(0, 2).map((f) => `${JSON.stringify(r)} ${f}`));
        expect(bad.slice(0, 12)).toEqual([]);
    }, 120_000);

    test("a recipe reads under every Window, tint, Contrast and accent too: 24 drawn at random", () => {
        const random = seeded(7);
        const recipes: ThemeRecipe[] = [...Array(24)].map(() => ({ hue: random() * 360, tint: random(), accent: `#${Math.floor(random() * 0xffffff).toString(16).padStart(6, "0")}` }));
        expect(recipes.flatMap((r) => unreadable(r).slice(0, 2).map((f) => `${JSON.stringify(r)} ${f}`)).slice(0, 12)).toEqual([]);
    }, 120_000);

    test("a theme declares every colour the default does, and nothing else", () => {
        const names = (scheme: "light" | "dark") => Object.keys(derive(DEFAULT_THEME, scheme));
        for (const theme of THEMES.slice(1)) for (const scheme of ["light", "dark"] as const) expect(Object.keys(derive(theme, scheme))).toEqual(names(scheme));
        expect(names("light")).toEqual(names("dark"));
    });

    test("a saved or imported recipe is taken only when it is one", () => {
        expect(parseRecipe({ hue: 400, tint: 3, accent: "FF8800", shape: "round", typeface: "mono", extra: 1 })).toEqual({ hue: 40, tint: 1, accent: "#ff8800", shape: "round", typeface: "mono" });
        expect(parseRecipe({ hue: 10, tint: 0.5, accent: "#12345" })).toBeUndefined();
        expect(parseRecipe({ hue: "10", tint: 0.5, accent: "#123456" })).toBeUndefined();
        expect(parseRecipe({ hue: NaN, tint: 0.5, accent: "#123456" })).toBeUndefined();
        expect(parseRecipe({ hue: 10, tint: 0.5, accent: "red; } body { display: none" })).toBeUndefined();
        expect(parseRecipe({ hue: 10, tint: 0.5, accent: "#123456", shape: "blob" })).toEqual({ hue: 10, tint: 0.5, accent: "#123456" });
        expect(parseRecipe(null)).toBeUndefined();
    });
});
