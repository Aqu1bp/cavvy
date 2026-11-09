// Opening or closing a panel (the rail, the inspector, the terminal) slides the window's tracks
// (shell.css). With a long conversation each slide froze the window: every frame laid out the
// whole conversation again, WebKit restyled all of it whenever the column's size changed (it was
// a query container), and the terminal fitted and resized its shell every frame.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { columnSteps, COLUMN_NARROW, COLUMN_SHORT, heldSizes, tracks, windowLayout } from "../gui/src/lib/layout";
import { barMove } from "../gui/src/lib/bar-glide";
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
    expect(windowLayout({ ...base, rail: false }).column).toEqual({ w: 1360, h: 880 });
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
    expect(heldSizes(undefined, at({ rail: false, terminalShown: true }), at({ terminalShown: true }))).toMatchObject({ sheetWidth: 1360, column: { w: 1092 } });
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

// ---- What's drawn through a slide moves one way, once ----------------------------------------------------------

test("the conversation is drawn from where its left edge was, not from half the widths' difference", () => {
    // Narrower than its full width at one end, the column isn't centred the same at both: by half the difference its
    // left edge jumped 19px one way as the side panel opened at 1400px, then slid the other.
    const transcript = read("components/Transcript.tsx");
    expect(transcript).toContain("columnLeft = content!.offsetLeft;");
    expect(transcript).toContain("drawn + (slide && content && columnLeft !== undefined ? columnLeft - content.offsetLeft : (held.from.w - held.to.w) / 2)");
    // A second press part way through: from where the first slide had drawn it, not from where it was headed.
    expect(transcript).toContain('moving?.playState === "running" ? new DOMMatrixReadOnly(getComputedStyle(box).transform).m41 : 0;');
});

test("hiding the rail takes the sheet to the window's edges, and the conversation is held at that size", () => {
    // The model had the sheet inset 8px with the rail hidden, where shell.css draws none: held 16px too small each
    // way, the conversation snapped 8px across and 16px down as the slide ended (and back as the next began).
    const at = (o: Partial<typeof base>) => windowLayout({ ...base, ...o });
    expect(at({ rail: false }).sheet).toEqual({ w: base.win.w, h: base.win.h });
    expect(heldSizes(undefined, at({}), at({ rail: false })).column).toEqual({ w: base.win.w, h: base.win.h });
    expect(heldSizes(undefined, at({ rail: false }), at({})).column).toEqual({ w: 1092, h: base.win.h });
});

test("the title bar's parts glide to their new places with the rail's slide; new ones stay where they end up", () => {
    // Before the title: nothing with the rail showing, its two buttons and the project with it hidden.
    const shown = (left: number) => ({ left, shown: true });
    const gone = { left: 0, shown: false };
    // The title, 215px further along the bar once the buttons and the project are before it: drawn from where it was.
    expect(barMove(shown(16), shown(231), -260)).toBe(-215);
    expect(barMove(shown(231), shown(16), 260)).toBe(215);
    // The buttons, new: where they end up in the window from the start (the bar travels 260px to the left under them).
    expect(barMove(gone, shown(12), -260)).toBe(-260);
    expect(barMove(undefined, shown(12), -260)).toBe(-260);
    // Gone, or not moved: left alone.
    expect(barMove(shown(12), gone, 260)).toBeUndefined();
    expect(barMove(shown(16), shown(16.2), -260)).toBeUndefined();
    expect(barMove(gone, shown(12), 0)).toBeUndefined();

    // Read before the rail changes, moved once its slide has begun, and forgotten if no slide comes (animations off).
    const actions = read("state/actions.ts");
    expect(actions.indexOf("railChange();")).toBeGreaterThan(0);
    expect(actions.indexOf("railChange();")).toBeLessThan(actions.indexOf('setPrefs("sidebar", !prefs.sidebar);'));
    const header = read("components/Header.tsx");
    expect(header).toContain("onCleanup(beforeRailChange(() => {");
    expect(header).toContain("forgetting = requestAnimationFrame(() => (was = undefined));");
    expect(header).toContain("glides = glideBar(bar, parts(), before.parts, slide, left - before.left);");
    expect(read("lib/bar-glide.ts")).toContain("el.animate([{ transform: `translateX(${dx}px)` }, { transform: \"none\" }], options)");
});

test("the title bar keeps to the top line through the slide: its top padding eases as the window's inset does", () => {
    // Over --dur (380ms) while the inset closed over --dur-panel (160ms), the title and the tools dipped 3px and came back.
    const header = parseRules(read("styles/header.css")).find((r) => r.selectors.includes(".header") && r.decls.has("transition"));
    expect(header?.decls.get("transition")).toBe("padding-top var(--dur-panel) var(--ease)");
    const win = parseRules(read("styles/shell.css")).find((r) => r.selectors.includes(".win") && r.decls.has("transition"));
    expect(win?.decls.get("transition")).toContain("padding var(--dur-panel) var(--ease)");
});

test("the Browser pane's page keeps its size while the panels slide, and takes its box's once they've stopped", () => {
    // A real page (the desktop app's) resized on every frame of a slide held the window up each time: with a busy
    // page, three or four stalls of 55 to 80ms in a 160ms slide. One resize, after it.
    const pane = read("components/BrowserPane.tsx");
    expect(pane).toContain("createEffect(on(() => panelHold()?.slide, (slide) => {\n                page = slide ? page ?? last : undefined;\n                follow.kick();");
    expect(pane).toContain('setShownBrowser({ targetId: t.targetId, box: shown, by: "pane", ...(page ? { page } : {}) });');
    const host = read("components/BrowserHostLayer.tsx");
    expect(host).toContain("const size = box && !shown.fit ? (shown.page ?? { width: box.width, height: box.height }) : AGENT_SIZE;");
    // The app hears of a size only when it changes: once per slide.
    expect(host).toContain("if (key !== reported) {");
});
