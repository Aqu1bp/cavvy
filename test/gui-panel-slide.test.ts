// Opening or closing a panel (the rail, the inspector, the terminal) slides the window's tracks
// (shell.css). With a long conversation each slide froze the window: every frame laid out the
// whole conversation again, WebKit restyled all of it whenever the column's size changed (it was
// a query container), and the terminal fitted and resized its shell every frame.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { columnSteps, COLUMN_NARROW, COLUMN_SHORT, heldSizes, tracks, windowLayout } from "../gui/src/lib/layout";
import { pageCorners, pageFrame, shownBox } from "../gui/src/lib/page-follow";
import { INSPECTOR_MOVES } from "../gui/src/lib/layout";
import { pageSizer, SETTLE_MS } from "../gui/src/lib/page-size";
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
    expect(windowLayout(base).column).toEqual({ w: 1100, h: 880 });
    expect(windowLayout({ ...base, rail: false }).column).toEqual({ w: 1360, h: 880 });
    expect(windowLayout({ ...base, panel: true }).column).toEqual({ w: 740, h: 880 });
    // A floating inspector is over the column, not beside it.
    expect(windowLayout({ ...base, win: { w: 1024, h: 700 }, panel: true }).column.w).toBe(764);
    expect(windowLayout({ ...base, terminalShown: true }).column).toEqual({ w: 1100, h: 620 });
    expect(windowLayout({ ...base, terminalShown: true, terminalMax: true }).column).toEqual({ w: 1100, h: 620 });
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
    expect(heldSizes(undefined, at({}), at({ panel: true }))).toEqual({ column: { w: 740, h: 880 }, from: { w: 1100, h: 880 }, to: { w: 740, h: 880 }, sheetWidth: 1100, terminal: 0 });
    // The terminal opening: the conversation as tall as it was, the terminal as tall as it'll be.
    expect(heldSizes(undefined, at({}), at({ terminalShown: true }))).toMatchObject({ column: { w: 1100, h: 880 }, terminal: 260 });
    // Closing it: as tall as it'll be.
    expect(heldSizes(undefined, at({ terminalShown: true }), at({}))).toMatchObject({ column: { w: 1100, h: 880 }, terminal: 260 });
    // The rail opening with the terminal open: the terminal as wide as the sheet was.
    expect(heldSizes(undefined, at({ rail: false, terminalShown: true }), at({ terminalShown: true }))).toMatchObject({ sheetWidth: 1360, column: { w: 1100 } });
    // Another slide on the way keeps what's held covering where it went.
    const held = heldSizes(undefined, at({}), at({ terminalShown: true }));
    expect(heldSizes(held, at({ terminalShown: true }), at({ terminalShown: true, terminalMax: true }))).toMatchObject({ column: { h: 880 }, terminal: 880 });
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
    // The model's sheet is what shell.css draws, with the rail and without it (no inset either way): held at any
    // other size, the conversation snapped across and down as the slide ended (and back as the next began).
    const at = (o: Partial<typeof base>) => windowLayout({ ...base, ...o });
    expect(at({ rail: false }).sheet).toEqual({ w: base.win.w, h: base.win.h });
    expect(heldSizes(undefined, at({}), at({ rail: false })).column).toEqual({ w: base.win.w, h: base.win.h });
    expect(heldSizes(undefined, at({ rail: false }), at({})).column).toEqual({ w: 1100, h: base.win.h });
});

test("what the rail's hiding puts before the title opens with the slide, so the title moves to its place in step with it", () => {
    // Shown and hidden at once, the rail's two buttons and the project pushed the title 215px one way while the bar
    // slid the other. Each is a box of one column, 0fr while the rail shows, that opens over the slide's time.
    const header = parseRules(read("styles/header.css"));
    const decls = (selector: string) => header.filter((r) => r.selectors.includes(selector)).reduce((all, r) => new Map([...all, ...r.decls]), new Map<string, string>());
    const slide = parseRules(read("styles/shell.css")).find((r) => r.selectors.includes(".win") && r.decls.has("transition"))!.decls.get("transition")!;
    expect(slide).toContain("grid-template-columns var(--dur-panel) var(--ease)");
    for (const box of [".bar-rail", ".proj-box"]) {
        const closed = decls(box);
        const open = decls(`.header.rail-off ${box}`);
        expect([box, closed.get("display"), closed.get("grid-template-columns"), open.get("grid-template-columns")]).toEqual([box, "grid", "0fr", "1fr"]);
        // As a drawer's bar too (below 900px the rail is over the sheet, and its buttons are always in the bar).
        expect(header.some((r) => r.selectors.includes(`[data-rail="overlay"] .header ${box}`) && r.selectors.includes(`.header.rail-off ${box}`))).toBe(true);
        // Over the slide's own time and easing; unseen and out of the tab order while closed, but only once it has closed.
        expect(closed.get("transition")).toBe("grid-template-columns var(--dur-panel) var(--ease), margin-right var(--dur-panel) var(--ease), visibility 0s linear var(--dur-panel)");
        expect([closed.get("visibility"), open.get("visibility"), open.get("transition-delay")]).toEqual(["hidden", "inherit", "0s"]);
    }
    // What's in each box keeps its own width and is cut by it: a box of no width takes none.
    expect([decls(".bar-rail-in").get("min-width"), decls(".bar-rail-in").get("overflow")]).toEqual(["0", "hidden"]);
    // The buttons' focus ring reaches 4px past them (2px wide, 2px off: base.css), so the box that cuts them is that
    // much larger all round, without taking more room in the bar.
    const ring = parseRules(read("styles/base.css")).find((r) => r.selectors.some((sel) => sel.includes(":focus-visible")) && r.decls.has("outline-offset"));
    expect([ring?.decls.get("outline")?.split(" ")[0], ring?.decls.get("outline-offset")]).toEqual(["2px", "2px"]);
    expect([decls(".bar-rail-in").get("padding"), decls(".bar-rail-in").get("margin")]).toEqual(["4px", "-4px"]);
    expect([decls(".proj").get("min-width"), decls(".proj").get("overflow"), decls(".proj .truncate").get("flex")]).toEqual(["0", "hidden", "none"]);
    // Closed, a box takes back the gap that would follow it: the bar's (12px), the crumbs' (10).
    expect(decls(".header").get("gap")).toBe("12px");
    expect([decls(".bar-rail").get("margin-right"), decls(".header.rail-off .bar-rail").get("margin-right")]).toEqual(["-12px", "0"]);
    expect(decls(".crumbs").get("gap")).toBe("calc(10 * var(--sp))");
    expect([decls(".proj-box").get("margin-right"), decls(".header.rail-off .proj-box").get("margin-right")]).toEqual(["calc(-10 * var(--sp))", "calc(-6 * var(--sp))"]);
    // The boxes are in the bar whether the rail shows or not.
    const bar = read("components/Header.tsx");
    expect(bar).toMatch(/<div class="bar-rail">\s*<div class="bar-rail-in">/);
    expect(bar).toMatch(/<span class="proj-box">\s*<button class="proj"/);
});

test("the title bar keeps to the top line through the slide: its padding eases as the window's inset does", () => {
    // Over --dur (380ms) while the inset closed over --dur-panel (160ms), the title and the tools dipped 3px and came back.
    const header = parseRules(read("styles/header.css")).find((r) => r.selectors.includes(".header") && r.decls.has("transition"));
    expect(header?.decls.get("transition")).toBe("padding var(--dur-panel) var(--ease)");
    const win = parseRules(read("styles/shell.css")).find((r) => r.selectors.includes(".win") && r.decls.has("transition"));
    expect(win?.decls.get("transition")).toContain("padding var(--dur-panel) var(--ease)");
});

test("the Browser pane's page keeps its size while the panels slide, and takes its box's once they've stopped", () => {
    // A real page (the desktop app's) resized on every frame of a slide held the window up each time: with a busy
    // page, three or four stalls of 55 to 80ms in a 160ms slide. One resize, after it.
    const sizer = pageSizer();
    const box = (width: number, height: number) => ({ width, height });
    expect(sizer.frame(0, box(354, 746), false)).toEqual(box(354, 746));
    // The sidebar hiding: the box grows a little each frame, the page stays as it is.
    for (let t = 16; t <= 160; t += 16) expect(sizer.frame(t, box(354, 746 + t / 10), true)).toEqual(box(354, 746));
    // Over: the box's size, in one step.
    expect(sizer.frame(176, box(354, 762), false)).toEqual(box(354, 762));
    // A slide that cuts another short keeps the size the page has, not the box's part way.
    expect(sizer.frame(192, box(354, 700), true)).toEqual(box(354, 762));
    expect(sizer.frame(208, box(354, 640), true)).toEqual(box(354, 762));
    expect(sizer.frame(224, box(354, 502), false)).toEqual(box(354, 502));

    // Drawn in no more of the box than it fills, nor than shows: where the box has grown past the page, the pane shows.
    expect(pageFrame(box(354, 762), box(354, 746))).toEqual(box(354, 746));
    expect(pageFrame(box(354, 502), box(354, 746))).toEqual(box(354, 502));
    expect(pageFrame(box(110, 762), box(354, 762))).toEqual(box(110, 762));
    const host = read("components/BrowserHostLayer.tsx");
    expect(host).toContain("const size = box && !shown.fit ? (shown.page ?? { width: box.width, height: box.height }) : AGENT_SIZE;");
    expect(host).toContain("const frame = shown?.frame ?? box;");
});

test("a page that keeps up follows its box as an edge is dragged; one that doesn't waits for the box to settle", () => {
    const box = (width: number) => ({ width, height: 700 });
    // Keeping up (a frame every 16ms): the page is the box's size on every frame.
    const quick = pageSizer();
    for (let i = 0; i <= 40; i++) expect(quick.frame(i * 16, box(400 + i), false)).toEqual(box(400 + i));
    // Not keeping up: each frame after a resize comes 70ms late. The second such frame, the page stops following.
    const slow = pageSizer();
    expect(slow.frame(0, box(400), false)).toEqual(box(400));
    expect(slow.frame(16, box(403), false)).toEqual(box(403));
    expect(slow.frame(16 + 70, box(406), false)).toEqual(box(406));
    expect(slow.frame(16 + 140, box(409), false)).toEqual(box(406));
    // The drag goes on, at the window's own pace now: nothing resizes the page.
    for (let t = 172; t <= 500; t += 16) expect(slow.frame(t, box(409 + t), false)).toEqual(box(406));
    // Let go (the box unchanged for SETTLE_MS): the page takes the box's size.
    expect(slow.frame(516, box(909), false)).toEqual(box(406));
    expect(slow.frame(516 + SETTLE_MS - 1, box(909), false)).toEqual(box(406));
    expect(slow.frame(516 + SETTLE_MS + 1, box(909), false)).toEqual(box(909));
    // And follows again from there, until it's late again.
    expect(slow.frame(700, box(912), false)).toEqual(box(912));
    // One late frame alone (the window's own work, say) doesn't stop it.
    const once = pageSizer();
    once.frame(0, box(400), false);
    once.frame(16, box(403), false);
    expect(once.frame(90, box(406), false)).toEqual(box(406));
    expect(once.frame(106, box(409), false)).toEqual(box(409));
    // A tab going away starts afresh.
    slow.reset();
    expect(slow.frame(1000, box(300), true)).toEqual(box(300));
});

test("a floating panel that docks is drawn in its column's place while the column opens under it", () => {
    // Left to the column (0 wide as the slide begins), it went to the sheet's right edge and slid back in.
    const app = read("App.tsx");
    expect(app).toContain("setInspectorDocking(docksInPlace(from, to));");
    expect(app).toContain('data-inspdocking={inspectorDocking() ? "on" : undefined}');
    // Over with the slide, or at once when nothing slides (animations off).
    expect(app).toMatch(/const rest = \(\) => \{\s*setPanelHold\(undefined\);\s*setInspectorDocking\(false\);/);
    expect(app).toContain("if (!sliding.length) return rest();");
    const rule = parseRules(read("styles/shell.css")).find((r) => r.selectors.includes('[data-inspdocking="on"][data-inspmode="dock"] .insp'));
    expect([rule?.decls.get("grid-column"), rule?.decls.get("justify-self"), rule?.decls.get("width")]).toEqual(["1 / 3", "end", "var(--insp-w)"]);
});

test("the side panel keeps what's in it until it has slid shut", () => {
    // Emptied as it was told to close, a blank panel slid away. And never unmounted and mounted again on the way.
    const app = read("App.tsx");
    expect(app).toContain("const [panelGone, setPanelGone] = createSignal(!prefs.panel);");
    expect(app).toContain("const panelKept = () => Boolean((prefs.panel || !panelGone()) && stage() && !agent() && !openingScreen());");
    expect(app).toContain('moving([".sheet", ".insp"], (p) => INSPECTOR_MOVES.includes(p))');
    // What it waits for is what shell.css moves a closing panel by: were one renamed there, nothing would be waited for.
    const shell = parseRules(read("styles/shell.css"));
    const transition = (selector: string) => shell.find((r) => r.selectors.includes(selector) && r.decls.has("transition"))?.decls.get("transition") ?? "";
    expect(INSPECTOR_MOVES).toEqual(["grid-template-columns", "transform"]);
    expect(transition(".sheet")).toContain(`${INSPECTOR_MOVES[0]} var(--dur-panel)`);
    expect(transition('[data-inspmode="float"] .insp')).toContain(`${INSPECTOR_MOVES[1]} var(--dur-panel)`);
});

test("a shut side panel isn't drawn once it has closed, so a change of layout while it's shut doesn't show", () => {
    // Opening the sidebar narrowed the sheet and floated the shut panel: its slide out of the way crossed the
    // conversation as a grey card. It goes at once from sight once its own slide is over, by opacity (not inherited).
    const shell = parseRules(read("styles/shell.css"));
    const rule = (selector: string) => shell.find((r) => r.selectors.includes(selector))?.decls;
    expect(rule('[data-insp="off"] .insp')?.get("opacity")).toBe("0");
    expect(rule('[data-insp="off"] .insp')?.get("transition")).toBe("opacity 0s linear var(--dur-panel)");
    const float = rule('[data-insp="off"][data-inspmode="float"] .insp')?.get("transition") ?? "";
    expect(float).toContain(`${INSPECTOR_MOVES[1]} var(--dur-panel)`);
    expect(float).toContain("opacity 0s linear var(--dur-panel)");
    expect(shell.some((r) => r.selectors.some((s) => s.includes(".insp")) && r.decls.has("visibility") && r.selectors.some((s) => s.includes('data-insp="off"')))).toBe(false);
});

test("the Browser page is drawn no further than what shows of its box, and sized by the whole box", () => {
    // The page isn't inside the sheet (it's laid over the window), so nothing cut it as its panel slid: opening or
    // closing, it was drawn across the window's margin, past the sheet's edge.
    const sheet = { left: 260, top: 8, right: 1392, bottom: 892 };
    const box = { left: 1039, top: 126, right: 1393, bottom: 892 };
    // At rest: the box, in whole pixels, shown as far as the sheet goes.
    expect(shownBox(box, { within: [{ left: 1032, top: 8, right: 1392, bottom: 892 }, sheet] })).toEqual({ box: { x: 1039, y: 126, width: 354, height: 766 }, seen: { width: 353, height: 766 } });
    // Opening or closing, docked: the panel's column is narrower than what's in it, which runs past its right edge.
    // The page keeps the box's size (it isn't laid out for the sliver that shows) and is drawn in the sliver.
    expect(shownBox({ ...box, left: 1289, right: 1643 }, { within: [{ left: 1282, top: 8, right: 1392, bottom: 892 }, sheet] })).toEqual({ box: { x: 1289, y: 126, width: 354, height: 766 }, seen: { width: 103, height: 766 } });
    // Floating, the panel itself slides off the sheet: the sheet cuts it.
    expect(shownBox({ left: 1200, top: 126, right: 1560, bottom: 600 }, { within: [{ left: 1200, top: 62, right: 1560, bottom: 622 }, sheet] })).toEqual({ box: { x: 1200, y: 126, width: 360, height: 474 }, seen: { width: 192, height: 474 } });
    // None of it shows: not shown at all.
    expect(shownBox({ ...box, left: 1400, right: 1754 }, { within: [{ left: 1391, top: 8, right: 1392, bottom: 892 }, sheet] })).toBeUndefined();
    expect(shownBox({ ...box, left: 1039, right: 1039 }, {})).toBeUndefined();
    // As before: to 8px above a dialog at the box's foot, and right of the panel's edge handle where it's over the box.
    expect(shownBox(box, { dialogTop: 700 })).toEqual({ box: { x: 1039, y: 126, width: 354, height: 566 }, seen: { width: 354, height: 566 } });
    expect(shownBox({ ...box, left: 1032 }, { handle: { left: 1032, top: 8, right: 1038, bottom: 892 } })?.box).toEqual({ x: 1038, y: 126, width: 355, height: 766 });
    expect(shownBox(box, { handle: { left: 700, top: 8, right: 706, bottom: 892 } })?.box.x).toBe(1039);
    // The pane loads this only where there's a page to place (the desktop app), and tells it when a slide begins or ends.
    const pane = read("components/BrowserPane.tsx");
    expect(pane).toContain('void import("../lib/page-follow").then((m) => {');
    expect(pane).toContain("() => !!panelHold()?.slide");
});

test("the Browser page is rounded where it lies in a rounded corner of its panel or the sheet", () => {
    // Square, and laid over the window: in a floating panel its bottom corners covered the panel's rounded ones.
    const panel = { left: 724, top: 62, right: 1084, bottom: 622, bottomLeft: 12, bottomRight: 12 };
    const sheet = { left: 260, top: 8, right: 1092, bottom: 742, bottomLeft: 14, bottomRight: 14 };
    // Filling the floating panel's foot: both bottom corners take its radius.
    expect(pageCorners({ left: 724, top: 180, right: 1084, bottom: 622 }, [panel, sheet])).toBe("0 0 12px 12px");
    // Right of the panel's edge handle (6px in): the left corner is that much further from the curve.
    expect(pageCorners({ left: 730, top: 180, right: 1084, bottom: 622 }, [panel, sheet])).toBe("0 0 12px 6px");
    // Docked, at the sheet's own rounded corner (the rail showing): the right one only.
    const docked = { left: 732, top: 8, right: 1092, bottom: 742, bottomLeft: 0, bottomRight: 0 };
    expect(pageCorners({ left: 738, top: 126, right: 1092, bottom: 742 }, [docked, sheet])).toBe("0 0 14px 0px");
    // Above the terminal, a dialog, or a sheet with square corners (no rail beside it): square.
    expect(pageCorners({ left: 738, top: 126, right: 1092, bottom: 480 }, [docked, sheet])).toBeUndefined();
    expect(pageCorners({ left: 738, top: 126, right: 1092, bottom: 742 }, [docked, { ...sheet, bottomRight: 0 }])).toBeUndefined();
    // Cut short of the panel's right edge (the page keeping a narrower size): only as round as the curve reaches it.
    expect(pageCorners({ left: 724, top: 180, right: 1080, bottom: 622 }, [panel])).toBe("0 0 8px 12px");
    expect(pageCorners({ left: 724, top: 180, right: 1060, bottom: 622 }, [panel])).toBe("0 0 0px 12px");
    // The layer draws it so; the floating view keeps its own rounding (it sets none here).
    const host = read("components/BrowserHostLayer.tsx");
    expect(host).toContain('wrap.style.borderRadius = shown?.corners ?? "";');
});

test("the title bar's parts for a hidden sidebar are hidden with the bar, behind the maximized terminal", () => {
    // Open, they said `visibility: visible`, which showed them through the hidden bar: pressable over the terminal's
    // own bar, reached by Shift+Tab from it, and a hole in the window's drag strip.
    const css = readFileSync(join(import.meta.dir, "../gui/src/styles/header.css"), "utf8");
    const open = (part: string) => new RegExp(`\\.header\\.rail-off \\.${part},\\s*\\[data-rail="overlay"\\] \\.header \\.${part} \\{[^}]*\\}`).exec(css)?.[0] ?? "";
    for (const part of ["bar-rail", "proj-box"]) {
        expect(open(part)).toContain("visibility: inherit;");
        expect(open(part)).not.toContain("visibility: visible");
    }
    expect(readFileSync(join(import.meta.dir, "../gui/src/styles/shell.css"), "utf8")).toMatch(/\[data-tmax="on"\] \.main,\s*\[data-tmax="on"\] \.insp \{\s*visibility: hidden;/);
});
