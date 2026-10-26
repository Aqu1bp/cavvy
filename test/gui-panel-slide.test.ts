// Opening or closing a panel (the rail, the inspector, the terminal) slides the window's tracks
// (shell.css). With a long conversation each slide froze the window: every frame laid out the
// whole conversation again, WebKit restyled all of it whenever the column's size changed (it was
// a query container), and the terminal fitted and resized its shell every frame.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { columnSteps, COLUMN_NARROW, COLUMN_SHORT, heldSizes, tracks, windowLayout } from "../gui/src/lib/layout";
import { parseRules } from "./helpers/contrast";

const gui = join(import.meta.dir, "../gui/src");
const read = (path: string) => readFileSync(join(gui, path), "utf8");
const styles = readdirSync(join(gui, "styles")).filter((f) => f.endsWith(".css"));

const base = {
    win: { w: 1360, h: 880 }, rail: true, railOpen: false, railWidth: 260, panel: false, review: false, split: false,
    reviewBase: 720, inspectorWidth: 360, terminalShown: false, terminalPreferred: 260, terminalMax: false, dock: 140,
};

test("the conversation column isn't a query container: its size changing doesn't restyle all of it", () => {
    for (const file of styles) {
        const css = read(`styles/${file}`).replace(/\/\*[\s\S]*?\*\//g, "");
        expect({ file, queries: css.match(/@container main\b/g) }).toEqual({ file, queries: null });
        // cqh/cqw measured the column; what's left of the cq units measures a small container of its own.
        expect({ file, units: css.match(/\d(cqh|cqw|cqb)\b/g) }).toEqual({ file, units: null });
    }
    const main = parseRules(read("styles/shell.css")).filter((r) => r.selectors.includes(".main"));
    for (const rule of main) for (const property of ["container", "container-type", "container-name"]) expect(rule.decls.has(property)).toBe(false);
    // What took its place: the steps of its size, which App.tsx sets on it.
    expect(read("App.tsx")).toMatch(/<main class="main" data-narrow=\{narrow\(\)\} data-short=\{short\(\)\}>/);
});

test("the column's size steps stand for the queries they replaced, at the same sizes", () => {
    const used = (attr: string) => new Set(styles.flatMap((f) => [...read(`styles/${f}`).matchAll(new RegExp(`:where\\(\\.main\\[data-${attr}~="(\\d+)"\\]\\)`, "g"))].map((m) => Number(m[1]))));
    expect([...used("narrow")].sort()).toEqual([...COLUMN_NARROW].sort());
    expect([...used("short")].sort()).toEqual([...COLUMN_SHORT].sort());
    // `max-width: 700px` held at 700px and below.
    expect(columnSteps(701, COLUMN_NARROW)).toBe("");
    expect(columnSteps(700, COLUMN_NARROW)).toBe("700");
    expect(columnSteps(600, COLUMN_NARROW)).toBe("700 640 600");
    expect(columnSteps(300, COLUMN_SHORT)).toBe("600 560 360");
});

test("the column is the sheet less a docked inspector and the terminal's row, and waits behind a maximized terminal at its size", () => {
    expect(windowLayout(base).column).toEqual({ w: 1092, h: 864 });
    expect(windowLayout({ ...base, rail: false }).column).toEqual({ w: 1344, h: 864 });
    expect(windowLayout({ ...base, panel: true }).column).toEqual({ w: 732, h: 864 });
    // A floating inspector is over the column, not beside it.
    expect(windowLayout({ ...base, win: { w: 1024, h: 700 }, panel: true }).column.w).toBe(756);
    expect(windowLayout({ ...base, terminalShown: true }).column).toEqual({ w: 1092, h: 604 });
    expect(windowLayout({ ...base, terminalShown: true, terminalMax: true }).column).toEqual({ w: 1092, h: 604 });
});

test("the tracks change when a panel opens or closes, not when the window resizes the column alone", () => {
    const key = (o: Partial<typeof base>) => tracks(windowLayout({ ...base, ...o }));
    expect(key({ rail: false })).not.toBe(key({}));
    expect(key({ panel: true })).not.toBe(key({}));
    expect(key({ terminalShown: true })).not.toBe(key({}));
    expect(key({ terminalShown: true, terminalMax: true })).not.toBe(key({ terminalShown: true }));
    expect(key({ win: { w: 1500, h: 1000 } })).toBe(key({}));
    // The rail as a drawer, and a floating inspector, move over the sheet: its tracks stay.
    expect(key({ win: { w: 800, h: 700 }, railOpen: true })).toBe(key({ win: { w: 800, h: 700 } }));
    expect(key({ win: { w: 1024, h: 700 }, panel: true })).toBe(key({ win: { w: 1024, h: 700 } }));
});

test("while the tracks slide, the conversation and the terminal hold one size that covers both ends", () => {
    const at = (o: Partial<typeof base>) => windowLayout({ ...base, ...o });
    // The inspector opening: the conversation at the width it ends at, from the width it was.
    expect(heldSizes(undefined, at({}), at({ panel: true }))).toEqual({ column: { w: 732, h: 864 }, from: { w: 1092, h: 864 }, to: { w: 732, h: 864 }, sheetWidth: 1092, terminal: 0 });
    // The terminal opening: the conversation as tall as it was, the terminal as tall as it'll be.
    expect(heldSizes(undefined, at({}), at({ terminalShown: true }))).toMatchObject({ column: { w: 1092, h: 864 }, terminal: 260 });
    // Closing it: as tall as it'll be.
    expect(heldSizes(undefined, at({ terminalShown: true }), at({}))).toMatchObject({ column: { w: 1092, h: 864 }, terminal: 260 });
    // The rail opening with the terminal open: the terminal as wide as the sheet was.
    expect(heldSizes(undefined, at({ rail: false, terminalShown: true }), at({ terminalShown: true }))).toMatchObject({ sheetWidth: 1344, column: { w: 1092 } });
    // Another slide on the way keeps what's held covering where it went.
    const held = heldSizes(undefined, at({}), at({ terminalShown: true }));
    expect(heldSizes(held, at({ terminalShown: true }), at({ terminalShown: true, terminalMax: true }))).toMatchObject({ column: { h: 864 }, terminal: 864 });
});

test("the slide moves the held boxes, not the layout: they're sized with properties that don't inherit, and laid out once", () => {
    // Custom properties set on the held boxes would restyle everything under them each time they change.
    const transcript = read("components/Transcript.tsx");
    expect(transcript).toContain('<div class="transcript-hold" ref={box} classList={{ held: !!hold() }} style={hold()}>');
    expect(transcript).toMatch(/return held && \{ width: `\$\{held\.column\.w\}px`, height: `\$\{held\.column\.h\}px`, top: /);
    expect(transcript).toContain("box.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: \"none\" }], { duration: Number(duration), easing })");
    const rules = parseRules(read("styles/transcript.css"));
    expect(rules.find((r) => r.selectors.includes(".transcript-hold.held"))?.decls.get("inset")).toBe("auto");
    const terminal = parseRules(read("styles/terminal.css")).find((r) => r.selectors.includes(".terminal-panel.held"));
    expect([terminal?.decls.get("justify-self"), terminal?.decls.get("align-self")]).toEqual(["start", "start"]);
    // The hold ends with the slide itself, not a guess at its length.
    expect(read("App.tsx")).toContain("Promise.allSettled(sliding.map((a) => a.finished))");
});

test("the slide itself looks as it did: the tracks still ease over --dur-panel, and not under reduced motion", () => {
    const shell = parseRules(read("styles/shell.css"));
    const decl = (selector: string, property: string) => shell.find((r) => r.selectors.includes(selector) && r.decls.has(property))?.decls.get(property);
    expect(decl(".win", "transition")).toContain("grid-template-columns var(--dur-panel) var(--ease)");
    expect(decl(".sheet", "transition")).toBe("grid-template-columns var(--dur-panel) var(--ease), grid-template-rows var(--dur-panel) var(--ease)");
    expect(read("styles/shell.css")).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.win,\s*\.win-rail,\s*\.rail-scrim,\s*\.sheet,\s*\.insp\s*\{\s*transition: none;/);
});
