// Moving the desktop window (gui/src/lib/window-drag.ts): a press on the window's top strip moves
// it in every state, whatever lies on the strip, unless the press lands on something that takes it.
// The element stacks below are what the WebKit app hit-tests at the top right in each state
// (document.elementFromPoint over the top strip, issue #365); before this, each was a dead spot.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { installWindowDrag, movesWindow, stripEnd, takesPress, type DragRule, type PressTarget } from "../gui/src/lib/window-drag";
import { parseRules } from "./helpers/contrast";

const root = join(import.meta.dir, "..");

/** A stand-in element: "tag.class.class" with attributes and (Solid's) delegated handlers. */
type Fake = PressTarget & { classes: string[]; parentElement?: Fake; [key: string]: unknown };
function el(spec: string, o: { attrs?: Record<string, string>; on?: string[]; parent?: Fake } = {}): Fake {
    const [tag, ...classes] = spec.split(".");
    const attrs = o.attrs ?? {};
    const node: Fake = {
        tagName: tag!.toUpperCase(),
        classes,
        parentElement: o.parent,
        getAttribute: (n) => attrs[n] ?? null,
        hasAttribute: (n) => n in attrs,
    };
    for (const type of o.on ?? []) node[`$$${type}`] = () => {};
    return node;
}
/** The composed path of a press on the last of a chain of specs (outermost first), as an event gives it. */
function path(...specs: (string | Fake)[]): Fake[] {
    let parent: Fake | undefined;
    for (const s of specs) parent = typeof s === "string" ? el(s, { parent }) : ((s.parentElement = parent), s);
    const out: Fake[] = [];
    for (let e = parent; e; e = e.parentElement) out.push(e);
    return out;
}
const shell = ["html", "body", "div.app", "div.win"];
const strip = 60;
const rule: DragRule = { strip, selectable: (e) => (e as Fake).classes.includes("selectable") };
const moves = (p: unknown[], y = 30) => movesWindow([...p, { nodeType: 9 }, { window: true }], y, rule);

test("the empty top strip moves the window in every state, whatever is laid over it", () => {
    const stacks: Record<string, Fake[]> = {
        "title bar": path(...shell, "div.sheet", "main.main", "div.keep", "header.header"),
        "title bar, around the tool capsule": path(...shell, "div.sheet", "main.main", "div.keep", "header.header", "div.bar-end", "div.cap.glass"),
        "title bar, the branch": path(...shell, "div.sheet", "main.main", "div.keep", "header.header", "nav.crumbs", "span.br", "span.truncate"),
        "the rail's top row": path(...shell, "div.win-rail", "div.keep", "aside.sidebar", "div.side-top", "span.grow"),
        "side panel open: around Changes | Plan": path(...shell, "div.sheet", "div.insp", "aside.panel", "div.insp-h", "div.segmented.seg-md"),
        "diff reader open: its head's name column": path(...shell, "div.sheet", "div.insp", "section.review", "div.rv-h", "div.nm"),
        "diff reader open: around its layout switch": path(...shell, "div.sheet", "div.insp", "section.review", "div.rv-h", "div.segmented.seg-sm"),
        "terminal maximized: its toolbar": path(...shell, "div.sheet", "section.terminal-panel.max", "div.terminal-toolbar"),
        "terminal maximized: the folder in its toolbar": path(...shell, "div.sheet", "section.terminal-panel.max", "div.terminal-toolbar", "span.terminal-cwd.truncate"),
        "terminal maximized: beside its tabs": path(...shell, "div.sheet", "section.terminal-panel.max", "div.terminal-toolbar", "div.terminal-tabs"),
        "Settings: the page beside its column": path(...shell, "div.sheet", "main.main", "div.settings-host", "div.settings-page"),
        "Settings: its heading": path(...shell, "div.sheet", "main.main", "div.settings-host", "div.settings-page", "div.set-in", "div.set-top", "h2"),
        "a toast on the top line": path("html", "body", "div.app", "div.toasts", "div.toast-region", "div.toast.glass.success", "span.toast-msg"),
        "Home": path(...shell, "div.sheet", "main.main", "div.keep", "div.home", "div.home-col"),
        "not connected": path("html", "body", "div", "div.app", "div.splash"),
    };
    for (const [state, p] of Object.entries(stacks)) expect({ state, moves: moves(p) }).toEqual({ state, moves: true });
});

test("what takes a press keeps it: controls, focusable and draggable things, and anything with a press handler", () => {
    const header = ["html", "body", "div.app", "div.win", "div.sheet", "main.main", "div.keep", "header.header"];
    const kept: Record<string, Fake[]> = {
        "a title bar button": path(...header, "div.bar-end", "div.cap", "button.hb"),
        "its icon": path(...header, "div.bar-end", "div.cap", "button.hb", "svg", "path"),
        "the rename field": path(...header, "nav.crumbs", "input.title-input"),
        "a link": path(...header, "a"),
        "a tab by role": path(...header, el("div", { attrs: { role: "tab" } })),
        "a focusable resizer": path(...header, el("div.terminal-resize", { attrs: { role: "separator", tabindex: "0" } })),
        "something editable": path(...header, el("div", { attrs: { contenteditable: "true" } })),
        "a draggable row": path(...header, el("div", { attrs: { draggable: "true" } })),
        "the title (double-click renames)": path(...header, "nav.crumbs", el("h1.ttl-h", { on: ["dblclick"] })),
        "the rail's resize handle": path("html", "body", "div.app", "div.win", "div.win-rail", "aside.sidebar", el("div.resize-handle", { on: ["pointerdown"] })),
        "the drawer's scrim (a click closes it)": path("html", "body", "div.app", "div.win", el("div.rail-scrim", { on: ["click"] })),
        "inside something listening for clicks": path(...header, el("div.chip", { on: ["mousedown"] }), "span"),
        "marked off": path(...header, el("div", { attrs: { "data-window-drag": "off" } }), "span"),
        "selectable text": path(...header, "div.nm", "b.selectable"),
    };
    for (const [what, p] of Object.entries(kept)) expect({ what, moves: moves(p) }).toEqual({ what, moves: false });
    expect(takesPress(el("div", { attrs: { tabindex: "-1" } }))).toBe(false);
    expect(takesPress(el("div", { attrs: { contenteditable: "false" } }))).toBe(false);
});

test("below the strip only the window's frame moves it; the strip ends where the press is", () => {
    const text = path("html", "body", "div.app", "div.win", "div.sheet", "main.main", "div.keep", "div.stage", "div.transcript-wrap");
    expect(moves(text, strip - 1)).toBe(true);
    expect(moves(text, strip)).toBe(false);
    expect(moves(text, 400)).toBe(false);
    const frame = path("html", "body", "div.app", "div.win", el("div.win-drag", { attrs: { "data-window-drag": "" } }));
    expect(moves(frame, 870)).toBe(true);
    expect(movesWindow([], 10, rule)).toBe(false);
});

test("the strip ends as far below the traffic lights' line as the window's inset is above it, and it covers the title bar and the rail's top row", () => {
    const css = (file: string) => parseRules(readFileSync(join(root, "gui/src/styles", file), "utf8"));
    const decl = (rules: ReturnType<typeof css>, selector: string, property: string) => rules.findLast((r) => r.selectors.includes(selector) && r.decls.has(property))?.decls.get(property);
    const px = (v: string | undefined) => Number(/^(\d+(?:\.\d+)?)px$/.exec(v ?? "")?.[1] ?? NaN);
    const tokens = css("tokens.css");
    const line = px(decl(tokens, ":root", "--top-line"));
    const pad = px(decl(css("shell.css"), ".app", "--win-pad"));
    const end = stripEnd(line, pad);
    // From the window's inset down, the strip is centred on the lights' line.
    expect((pad + end) / 2).toBe(line);
    // The rail's top row: win-pad down, 2 × (line − win-pad) tall (sidebar.css .side-top).
    expect(pad + 2 * (line - pad)).toBe(end);
    for (const selector of [":root", '[data-density="compact"]']) {
        const header = px(decl(tokens, selector, "--header-h"));
        expect({ selector, covered: pad + header <= end }).toEqual({ selector, covered: true });
    }
});

/** A window stand-in: its listeners, and presses dispatched to them. */
function fakeWindow() {
    const on: Record<string, ((e: MouseEvent) => void)[]> = {};
    const win = {
        addEventListener: (type: string, f: (e: MouseEvent) => void) => void (on[type] ??= []).push(f),
        removeEventListener: (type: string, f: (e: MouseEvent) => void) => void (on[type] = (on[type] ?? []).filter((g) => g !== f)),
    };
    const fire = (type: "mousedown" | "mouseup", p: Fake[], o: { x?: number; y?: number; detail?: number; button?: number; ctrlKey?: boolean; defaultPrevented?: boolean } = {}) => {
        const e = { type, button: o.button ?? 0, detail: o.detail ?? 1, ctrlKey: o.ctrlKey ?? false, clientX: o.x ?? 500, clientY: o.y ?? 30, defaultPrevented: o.defaultPrevented ?? false, composedPath: () => p, preventDefault() { e.defaultPrevented = true; } };
        for (const f of on[type] ?? []) f(e as unknown as MouseEvent);
        return e;
    };
    return { win, fire, listeners: () => Object.values(on).flat().length };
}
const toolbar = path(...shell, "div.sheet", "section.terminal-panel.max", "div.terminal-toolbar");
const button = path(...shell, "div.sheet", "section.terminal-panel.max", "div.terminal-toolbar", "button.hb");

function installed(mac: boolean) {
    const w = fakeWindow();
    const calls: string[] = [];
    const remove = installWindowDrag({ invoke: (cmd) => (calls.push(cmd), Promise.resolve()), mac, target: w.win as unknown as Window, rule: () => rule });
    return { ...w, calls, remove };
}

test("a press on the strip starts the move at once and takes no focus or selection; on a control, nothing happens", () => {
    const { fire, calls } = installed(true);
    const down = fire("mousedown", toolbar);
    expect(calls).toEqual(["plugin:window|start_dragging"]);
    expect(down.defaultPrevented).toBe(true);
    const onButton = fire("mousedown", button);
    expect(onButton.defaultPrevented).toBe(false);
    fire("mousedown", toolbar, { button: 2 });
    fire("mousedown", toolbar, { ctrlKey: true });
    fire("mousedown", toolbar, { defaultPrevented: true });
    fire("mousedown", toolbar, { detail: 3 });
    expect(calls).toEqual(["plugin:window|start_dragging"]);
});

test("macOS: a double press on the strip zooms on release, only if the pointer didn't move; never on a control", () => {
    const { fire, calls } = installed(true);
    fire("mousedown", toolbar, { detail: 2, x: 500 });
    expect(calls).toEqual([]);
    fire("mouseup", toolbar, { detail: 2, x: 500 });
    expect(calls).toEqual(["plugin:window|internal_toggle_maximize"]);
    fire("mousedown", toolbar, { detail: 2, x: 500 });
    fire("mouseup", toolbar, { detail: 2, x: 504 });
    fire("mousedown", button, { detail: 2 });
    fire("mouseup", button, { detail: 2 });
    // A release without its press (one that started elsewhere) zooms nothing.
    fire("mouseup", toolbar, { detail: 2 });
    expect(calls).toEqual(["plugin:window|internal_toggle_maximize"]);
});

test("elsewhere a double press toggles maximize at once; removing the listener stops it all", () => {
    const { fire, calls, remove, listeners } = installed(false);
    fire("mousedown", toolbar, { detail: 2 });
    expect(calls).toEqual(["plugin:window|internal_toggle_maximize"]);
    remove();
    expect(listeners()).toBe(0);
    fire("mousedown", toolbar);
    expect(calls).toEqual(["plugin:window|internal_toggle_maximize"]);
});

test("the app may start the move: its capability allows start_dragging", () => {
    const cap = JSON.parse(readFileSync(join(root, "desktop/src-tauri/capabilities/default.json"), "utf8"));
    expect(cap.windows).toContain("main");
    expect(cap.permissions).toContain("core:window:allow-start-dragging");
});

test("the GUI has no Tauri drag regions left (Tauri's script would start a second move), and the frame is marked", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) walk(p);
            else if (/\.(tsx?|css|html)$/.test(name)) files.push(p);
        }
    };
    walk(join(root, "gui/src"));
    const marked = files.filter((f) => /data-tauri-drag-region\s*[=>/ ]/.test(readFileSync(f, "utf8")));
    expect(marked).toEqual([]);
    const app = readFileSync(join(root, "gui/src/App.tsx"), "utf8");
    expect(app).toMatch(/<div class="win-drag" data-window-drag \/>/);
    expect(app).toMatch(/installWindowDrag\(/);
});
