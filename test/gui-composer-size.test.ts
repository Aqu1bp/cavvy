import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseRules } from "./helpers/contrast";
import { cubicBezier, expandedDown, expandedHeight, FOOT_GAP, growFrames, KEEP, KEEP_MIN } from "../gui/src/lib/composer-size";
import { loadKeymap } from "../src/keybindings/core";

// The composer's text (gui/src/lib/composer-size.ts, composer.css): a modest height that scrolls, and the large size
// the expand button opens. Composer.tsx's own handling is in fixtures/composer-controls.ts.

const css = parseRules(readFileSync(join(import.meta.dir, "../gui/src/styles/composer.css"), "utf8"));
const decl = (selector: string, property: string) => css.findLast((r) => r.selectors.includes(selector) && r.decls.has(property))?.decls.get(property);

test("the text stops at seven lines of its own size (or less in a short column), and only the large size lifts that", () => {
    // It was 30% of the column alone: a tall window let a draft take a third of it.
    expect(decl(".composer textarea", "max-height")).toBe("min(calc(7lh + 2px), calc(var(--column-h, 100vh) * 0.3))");
    expect(decl(".composer.expanded textarea", "max-height")).toBe("none");
});

test("the large size leaves the column's top 30% (at least 160px) clear: the title bar and the conversation's end", () => {
    // A 1000px column from y=0, the composer's top at 700 with 150px of text: it grows by 400 to land at 300.
    expect(expandedHeight({ text: 150, top: 700, columnTop: 0, column: 1000, least: 150 })).toBe(550);
    // Measured again once open, it stays put.
    expect(expandedHeight({ text: 550, top: 300, columnTop: 0, column: 1000, least: 150 })).toBe(550);
    // Something above it in the dock (the Up next tray) takes room from the text, not from what's kept clear.
    expect(expandedHeight({ text: 550, top: 220, columnTop: 0, column: 1000, least: 150 })).toBe(470);
    // Short columns keep KEEP_MIN; the column's own offset counts.
    expect(expandedHeight({ text: 100, top: 400, columnTop: 40, column: 450, least: 100 })).toBe(100 + 400 - (40 + KEEP_MIN));
    expect(KEEP * 1000).toBe(300);
    // Never smaller than it was before it opened.
    expect(expandedHeight({ text: 150, top: 250, columnTop: 0, column: 1000, least: 150 })).toBe(150);
});

test("Home's grows down to just above the page's foot", () => {
    expect(expandedDown({ text: 150, bottom: 500, pageBottom: 800, least: 150 })).toBe(150 + 300 - FOOT_GAP);
    expect(expandedDown({ text: 426, bottom: 776, pageBottom: 800, least: 150 })).toBe(426);
    expect(expandedDown({ text: 150, bottom: 790, pageBottom: 800, least: 150 })).toBe(150);
});

test("growFrames draws the box at the eased height and scales its content back to its own size", () => {
    const { box, content } = growFrames(200, 500, 10);
    const scale = (k: Keyframe) => Number(/scaleY\(([\d.e-]+)\)/.exec(String(k.transform))![1]);
    expect(box).toHaveLength(11);
    expect(scale(box[0]!)).toBeCloseTo(200 / 500, 6);
    expect(scale(box.at(-1)!)).toBe(1);
    for (let i = 0; i < box.length; i++) expect(scale(box[i]!) * scale(content[i]!)).toBeCloseTo(1, 9);
    // Eased out: most of the way there early, never past it.
    const drawn = box.map((k) => scale(k) * 500);
    for (let i = 1; i < drawn.length; i++) expect(drawn[i]!).toBeGreaterThanOrEqual(drawn[i - 1]!);
    expect(drawn[3]!).toBeGreaterThan(200 + 0.5 * 300);
    // Closing: drawn taller than it's laid out, coming down to it.
    const shut = growFrames(500, 200, 4).box.map(scale);
    expect(shut[0]).toBeCloseTo(2.5, 6);
    expect(shut.at(-1)).toBe(1);
});

test("cubicBezier follows CSS's curve", () => {
    expect(cubicBezier(0, 0, 1, 1, 0.37)).toBeCloseTo(0.37, 6);
    expect(cubicBezier(0.2, 0.8, 0.2, 1, 0)).toBeCloseTo(0, 6);
    expect(cubicBezier(0.2, 0.8, 0.2, 1, 1)).toBeCloseTo(1, 6);
    expect(cubicBezier(0.2, 0.8, 0.2, 1, 0.5)).toBeGreaterThan(0.85);
});

test("Mod+Shift+E opens and closes it, in the input box, without clashing with another key", () => {
    for (const [os, keys] of [["macos", "shift+cmd+e"], ["linux", "ctrl+shift+e"]] as const) {
        const km = loadKeymap(undefined, "gui", os);
        expect(km.issues).toEqual([]);
        expect(km.keysOf.get("chat:expand")).toEqual([keys]);
        // Nothing else has it, in the box or anywhere.
        for (const ctx of ["Chat", "Global"]) expect([...(km.table.get(ctx as never)?.entries() ?? [])].filter(([k]) => k === keys).map(([, a]) => a)).toEqual(ctx === "Chat" ? ["chat:expand"] : []);
    }
    // The terminal app has no such box.
    expect(loadKeymap(undefined, "tui", "macos").keysOf.get("chat:expand") ?? []).toEqual([]);
});
