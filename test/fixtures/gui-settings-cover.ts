import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer } from "../helpers/gui-render";
import { boundary } from "../helpers/render-boundary";
import { columnSteps, COLUMN_NARROW, COLUMN_SHORT } from "../../gui/src/lib/layout";

// Settings covers the session instead of replacing it: leaving Settings must not build the session
// view, the rail or the inspector again (in WebKit that rebuild took ~150ms for a 65-turn session).
test("opening and leaving Settings keeps the session view, rail and inspector mounted", () => {
    const [settingsTab, setSettingsTab] = solid.createSignal<string | undefined>(undefined);
    const handle = { view: { state: { cwd: "/project" }, agents: [] } };
    const appSource = readFileSync(new URL("../../gui/src/App.tsx", import.meta.url), "utf8");
    const builtins = new Set(["Show", "For", "Index", "Switch", "Match", "Dynamic", "Portal", "ErrorBoundary", "Suspense", "RenderBoundary"]);
    const tags = [...new Set([...appSource.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)].map((m) => m[1]!))].filter((tag) => !builtins.has(tag));
    const mounts: Record<string, number> = {};
    let blurred = 0;
    const composer = { closest: (sel: string) => (sel.includes("[data-covered]") && settingsTab() ? composer : null), blur: () => { blurred++; } };
    const App = component(appSource.slice(appSource.indexOf("export function App")), "App", {
        RenderBoundary: boundary(), app: { conn: "open", activeId: "session" }, handleFor: () => handle,
        prefs: { sidebar: true, panel: true }, isTauri: false, document: { activeElement: composer }, onMount() {}, setEnterSends() {}, actionOf: () => undefined, skipCovered() {},
        railDrag: () => undefined, columnSteps, COLUMN_NARROW, COLUMN_SHORT, shellLayout: () => ({ railMode: "dock", railShown: true, sheet: { w: 1100, h: 860 }, column: { w: 740, h: 860 }, inspector: { open: true, mode: "dock", width: 360, short: false, bottom: 8 }, terminal: { shown: false, height: 0, maximized: false, most: 560 } }),
        settingsTab, agentFocus: () => undefined, review: () => undefined, setAgentFocus() {}, setReview() {}, attentionCount: () => 0,
        ...Object.fromEntries(tags.map((tag) => [tag, () => { mounts[tag] = (mounts[tag] ?? 0) + 1; return node(tag); }])),
    });
    const root = node("root");
    const dispose = renderer.render(App, root);
    const find = (tag: string) => all(root).find((n) => n.tag === tag);
    const covered = () => all(root).find((n) => n.tag === "div" && n.props.class === "keep" && n.children.some((c) => all(c).some((d) => d.tag === "SessionView")));
    try {
        const view = find("SessionView");
        const rail = find("Sidebar");
        expect(view).toBeDefined();
        expect(rail).toBeDefined();
        const before = { ...mounts };
        expect(before.SessionView).toBe(1);

        setSettingsTab("general");
        expect(find("SettingsPage")).toBeDefined();
        expect(find("SettingsNav")).toBeDefined();
        // Still there, under Settings, marked covered and hidden from assistive tech.
        expect(find("SessionView")).toBe(view);
        expect(find("Sidebar")).toBe(rail);
        expect(covered()?.props["data-covered"]).toBe("");
        expect(covered()?.props["aria-hidden"]).toBe("true");
        // Focus in it (the composer) left, so typing doesn't edit or send a prompt out of sight.
        expect(blurred).toBe(1);

        setSettingsTab(undefined);
        expect(find("SettingsPage")).toBeUndefined();
        expect(find("SessionView")).toBe(view);
        expect(find("Sidebar")).toBe(rail);
        expect(covered()?.props["data-covered"]).toBeUndefined();
        // Nothing the session shows was built again on the round trip.
        expect(before.RightPanel).toBe(1);
        // (The inspector's column closes under Settings, so only its resizer comes back.)
        for (const tag of ["SessionView", "Sidebar", "RightPanel", "TerminalPanel"]) expect([tag, mounts[tag]]).toEqual([tag, 1]);
    } finally { dispose(); }
});

test("a menu of the covered session opened while Settings is up (a shortcut, say) closes at once", () => {
    const source = readFileSync(new URL("../../gui/src/components/ui/Popover.tsx", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
    const [tab, setTab] = solid.createSignal<string | undefined>("general");
    const [open, setOpen] = solid.createSignal(false);
    let closes = 0;
    const doc = { addEventListener() {}, removeEventListener() {} };
    const Popover = component(source, "Popover", {
        settingsTab: tab, document: doc, window: doc, requestAnimationFrame() {}, mountMenu: () => () => {}, placePopover: () => undefined, sp: (n: number) => n,
        renderer: { ...solid, ...renderer, Portal: (p: any) => p.children },
    });
    const covered = { closest: (sel: string) => (sel.includes(".settings-page") ? null : covered) };
    const root = node("root");
    const dispose = renderer.render(() => Popover({ get open() { return open(); }, onClose: () => { closes++; setOpen(false); }, anchor: () => covered, children: "menu" }), root);
    try {
        setOpen(true);
        expect(closes).toBe(1);
        // With Settings closed it stays open.
        setTab(undefined);
        setOpen(true);
        expect(closes).toBe(1);
        // And Settings opening over it closes it.
        setTab("general");
        expect(closes).toBe(2);
    } finally { dispose(); }
});

test("⌘F under Settings does nothing: neither the conversation's find nor the page's own (which would match the covered transcript)", () => {
    const appSource = readFileSync(new URL("../../gui/src/App.tsx", import.meta.url), "utf8");
    const builtins = new Set(["Show", "For", "Index", "Switch", "Match", "Dynamic", "Portal", "ErrorBoundary", "Suspense", "RenderBoundary"]);
    const tags = [...new Set([...appSource.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)].map((m) => m[1]!))].filter((tag) => !builtins.has(tag));
    const [settingsTab, setSettingsTab] = solid.createSignal<string | undefined>("general");
    const keys: ((e: any) => void)[] = [];
    let finds = 0;
    let dialogOpen = false;
    const App = component(appSource.slice(appSource.indexOf("export function App")), "App", {
        RenderBoundary: boundary(), app: { conn: "open", activeId: "session" }, handleFor: () => ({ view: { state: { cwd: "/project" }, agents: [] } }),
        prefs: { sidebar: true }, isTauri: false, document: { activeElement: null, querySelector: (sel: string) => (dialogOpen && sel === ".dialog-backdrop" ? {} : null) }, setEnterSends() {}, skipCovered() {}, warmUp() {}, setTimeout() {},
        window: { addEventListener: (type: string, fn: (e: any) => void) => type === "keydown" && keys.push(fn), removeEventListener() {} },
        actionOf: (e: any) => (e.key === "f" && e.metaKey ? "app:find" : undefined), openFind: () => { finds++; }, blocked: () => false, railOpen: () => false,
        railDrag: () => undefined, columnSteps, COLUMN_NARROW, COLUMN_SHORT, shellLayout: () => ({ railMode: "dock", railShown: true, sheet: { w: 1100, h: 860 }, column: { w: 740, h: 860 }, inspector: { open: false, mode: "dock", width: 360, short: false, bottom: 8 }, terminal: { shown: false, height: 0, maximized: false, most: 560 } }),
        settingsTab, agentFocus: () => undefined, review: () => undefined, setAgentFocus() {}, setReview() {}, attentionCount: () => 0,
        ...Object.fromEntries(tags.map((tag) => [tag, () => node(tag)])),
    });
    const root = node("root");
    const dispose = renderer.render(App, root);
    const press = () => {
        const e = { key: "f", metaKey: true, ctrlKey: false, altKey: false, target: null, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() {} };
        for (const fn of keys) fn(e);
        return e.defaultPrevented;
    };
    try {
        expect(keys.length).toBeGreaterThan(0);
        // Under Settings: the key is taken (no page find), and the conversation's find doesn't open.
        expect(press()).toBe(true);
        expect(finds).toBe(0);
        // With a dialog open in Settings too (it used to fall through to the page's find there).
        dialogOpen = true;
        expect(press()).toBe(true);
        dialogOpen = false;
        expect(finds).toBe(0);
        // Back in the session: the conversation's find.
        setSettingsTab(undefined);
        expect(press()).toBe(true);
        expect(finds).toBe(1);
    } finally { dispose(); }
});
