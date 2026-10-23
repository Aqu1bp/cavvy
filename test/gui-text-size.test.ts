// Settings → Appearance → Text size (12–18, default 14) scales the interface, not only the prose (#350).
// Sizes that sit with text are written calc(N * var(--sp)) (gui/src/styles/tokens.css): N px at 14,
// N × size / 14 px at another size. The window's frame (the traffic lights' line and the title bar on it,
// the rail's top row, the window's inset, resize handles, scrollbars) stays in px.
// These read the stylesheets. In WebKit (the app's WKWebView) every element's box was measured at 14 before
// and after the change, across the views, and none moved.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { parseRules } from "./helpers/contrast";
import { appearanceOf, PREF_DEFAULTS } from "../gui/src/state/prefs-core";
import { scaled, terminalFontSize } from "../gui/src/lib/text-size";

const dir = join(import.meta.dir, "../gui/src/styles");
const files = readdirSync(dir).filter((f) => f.endsWith(".css"));
const sheets = Object.fromEntries(files.map((f) => [f, parseRules(readFileSync(join(dir, f), "utf8"))]));
const decl = (file: string, selector: string, property: string) => sheets[file]!.findLast((r) => r.selectors.includes(selector) && r.decls.has(property))?.decls.get(property);

/** A declaration's value at a text size, for values made of px, 0 and calc(N * var(--sp)) only. */
function at(value: string | undefined, size: number): string {
    if (value === undefined) throw new Error("no such declaration");
    return value.replace(/calc\((-?[\d.]+) \* var\(--sp\)\)/g, (_m, n) => `${+scaled(Number(n), size).toFixed(3)}px`);
}

// Rows, controls and icons people read and click: their px at 14 (as before the change), and the same at 18.
const KEY: [file: string, selector: string, property: string, at14: string][] = [
    ["base.css", ".hb", "height", "28px"],
    ["base.css", ".btn", "height", "32px"],
    ["base.css", ".menu-item", "padding", "6px 8px"],
    ["base.css", '.toggle.on .toggle-knob', "transform", "translateX(15px)"],
    ["sidebar.css", ".side-search", "height", "32px"],
    ["sidebar.css", ".card-hit", "padding", "7px 10px 7px 8px"],
    ["composer.css", ".send", "width", "34px"],
    ["composer.css", ".uq-row", "height", "34px"],
    ["transcript.css", ".tool-line", "min-height", "26px"],
    ["transcript.css", ".acts-h", "min-height", "26px"],
    ["transcript.css", ".code-body", "padding", "10px 14px"],
    ["overlays.css", ".pal-row", "min-height", "38px"],
    ["toasts.css", ".toast", "min-height", "36px"],
    ["terminal.css", ".terminal-tab", "height", "28px"],
    ["tokens.css", ":root", "--radius-sm", "8px"],
];

test("--sp is a pixel at the text size: exactly 1px at 14", () => {
    expect(decl("tokens.css", ":root", "--sp")).toBe("calc(1px * var(--font-scale))");
    expect(decl("base.css", "html", "font-size")).toBe("calc(14px * var(--font-scale))");
    expect(appearanceOf(PREF_DEFAULTS, false).style["--font-scale"]).toBe("1");
    expect(Number(appearanceOf({ ...PREF_DEFAULTS, fontSize: 18 }, false).style["--font-scale"])).toBeCloseTo(18 / 14, 12);
});

for (const [file, selector, property, at14] of KEY) {
    test(`${selector} ${property}: ${at14} at 14, scaled at 18 and 12`, () => {
        const value = decl(file, selector, property);
        expect(at(value, 14)).toBe(at14);
        const want = (size: number) => at14.replace(/(-?[\d.]+)px/g, (_m, n) => `${+scaled(Number(n), size).toFixed(3)}px`);
        expect(at(value, 18)).toBe(want(18));
        expect(at(value, 12)).toBe(want(12));
    });
}

test("an icon drawn at size={14} is 14px at 14 and 18px at 18, but not on the window's top line", () => {
    // parseRules splits the selector at the comma inside :not().
    const rule = sheets["base.css"]!.find((r) => r.selectors[0] === ':where(svg[width="14"]:not(.side-top *');
    expect(rule?.selectors).toEqual([':where(svg[width="14"]:not(.side-top *', ".header .hb *))"]);
    expect([14, 18].map((size) => at(rule!.decls.get("width"), size))).toEqual(["14px", "18px"]);
    expect(at(rule!.decls.get("height"), 18)).toBe("18px");
});

test("the column is as wide at 14 as before and as many characters wide at 18", () => {
    const column = appearanceOf({ ...PREF_DEFAULTS, chatWidth: "default" }, false).style["--column-w"];
    expect(column).toBe("calc(736 * var(--sp))");
    expect(at(column, 14)).toBe("736px");
    expect(at(column, 18)).toBe(`${+scaled(736, 18).toFixed(3)}px`);
    // The first paint sets it the same way (gui/public/theme-boot.js).
    expect(readFileSync(join(import.meta.dir, "../gui/public/theme-boot.js"), "utf8")).toContain('"calc(" + (COLUMNS[p.chatWidth] || COLUMNS["default"]) + " * var(--sp))"');
});

test("the terminal's text follows in whole pixels: 12px at 14", () => {
    expect([12, 14, 16, 18].map(terminalFontSize)).toEqual([10, 12, 14, 15]);
});

// The window's frame, deliberately fixed: the traffic lights are native and don't scale.
const FRAME: [file: string, selector: string, property: string, value: string][] = [
    ["tokens.css", ":root", "--top-line", "34px"],
    ["tokens.css", ":root", "--header-h", "52px"],
    ["tokens.css", ":root", "--r-window", "16px"],
    ["tokens.css", ":root", "--r-sheet", "12px"],
    ["tokens.css", ":root", "--gutter", "8px"],
    ["shell.css", ".app", "--win-pad", "8px"],
    ["header.css", ".header .hb", "height", "28px"],
    ["header.css", ".cap", "height", "34px"],
    ["sidebar.css", ".side-top .hb", "width", "28px"],
    ["sidebar.css", ".side-top .hb", "height", "28px"],
    ["sidebar.css", ".resize-handle", "width", "6px"],
    ["overlays.css", ".find-bar.glass", "top", "58px"],
    ["overlays.css", ".find-bar.glass", "height", "38px"],
    ["base.css", "::-webkit-scrollbar", "width", "10px"],
];

for (const [file, selector, property, value] of FRAME) {
    test(`the frame stays put: ${selector} ${property} is ${value} at any size`, () => {
        expect(decl(file, selector, property)).toBe(value);
    });
}

// What a guard needs: every px length of 2 or more in a size, spacing or radius is the frame's.
const SIZING = /^(width|height|min-width|min-height|max-width|max-height|padding(-[a-z-]+)?|margin(-[a-z-]+)?|gap|row-gap|column-gap|top|right|bottom|left|inset(-[a-z-]+)?|border(-[a-z]+)*-radius|line-height|font-size|font|flex|flex-basis|grid-template-columns|grid-template-rows|grid-auto-rows|contain-intrinsic-size)$/;
/** Selectors whose sizes are the window's frame, or depend on it, by file. */
const FRAME_RULES: Record<string, RegExp> = {
    "base.css": /^(html|::-webkit-scrollbar.*)$/,
    "header.css": /^(\.header|\.header::before|\.header\.rail-off|\.header\.traffic\.rail-off|\[data-rail="overlay"\] \.header(\.traffic)?|\.bar-rail.*|\.header \.hb(\.diffchip)?|\.cap( \.sep)?)$/,
    "shell.css": /^(\[data-inspmode="float"\] \.insp|\.insp-resizer)$/,
    "sidebar.css": /^(\.side-top( \.hb)?|\.resize-handle(\.left)?)$/,
    "terminal.css": /^(\.terminal-resize|\.app\.tauri\.os-macos(\.rail-off|\[data-rail="overlay"\]) \.terminal-panel\.max \.terminal-toolbar)$/,
    "overlays.css": /^\.find-bar\.glass$/,
};

/** The px lengths in a value outside var() (a fallback there is another property's default). */
function fixedPx(value: string): number[] {
    let plain = "";
    for (let i = 0; i < value.length; ) {
        if (value.startsWith("var(", i)) {
            let depth = 0;
            for (; i < value.length; i++) {
                if (value[i] === "(") depth++;
                else if (value[i] === ")" && --depth === 0) break;
            }
            i++;
            plain += "0";
        } else plain += value[i++];
    }
    return [...plain.matchAll(/(?<![\w.#-])(-?\d+(?:\.\d+)?)px\b/g)].map((m) => Math.abs(Number(m[1]))).filter((n) => n > 1);
}

test("nothing that sits with text has a fixed px size (write calc(N * var(--sp)), or list it as the frame's here)", () => {
    const fixed: string[] = [];
    for (const [file, rules] of Object.entries(sheets)) {
        for (const r of rules) {
            for (const selector of r.selectors) {
                if (selector.startsWith("@") || /^(from|to|\d+%)$/.test(selector) || FRAME_RULES[file]?.test(selector)) continue;
                for (const [property, value] of r.decls) if (SIZING.test(property) && fixedPx(value).length) fixed.push(`${file}: ${selector} { ${property}: ${value} }`);
            }
        }
    }
    expect(fixed).toEqual([]);
});
