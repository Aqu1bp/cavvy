import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer } from "../helpers/gui-render";
import { boundary } from "../helpers/render-boundary";

// Settings covers the session instead of replacing it: leaving Settings must not build the session
// view, the rail or the inspector again (in WebKit that rebuild took ~150ms for a 65-turn session).
test("opening and leaving Settings keeps the session view, rail and inspector mounted", () => {
    const [settingsTab, setSettingsTab] = solid.createSignal<string | undefined>(undefined);
    const handle = { view: { state: { cwd: "/project" }, agents: [] } };
    const appSource = readFileSync(new URL("../../gui/src/App.tsx", import.meta.url), "utf8");
    const builtins = new Set(["Show", "For", "Index", "Switch", "Match", "Dynamic", "Portal", "ErrorBoundary", "Suspense", "RenderBoundary"]);
    const tags = [...new Set([...appSource.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)].map((m) => m[1]!))].filter((tag) => !builtins.has(tag));
    const mounts: Record<string, number> = {};
    const App = component(appSource.slice(appSource.indexOf("export function App")), "App", {
        RenderBoundary: boundary(), app: { conn: "open", activeId: "session" }, handleFor: () => handle,
        prefs: { sidebar: true, panel: true }, isTauri: false, document: {}, onMount() {}, setEnterSends() {}, actionOf: () => undefined, skipCovered() {},
        railDrag: () => undefined, shellLayout: () => ({ railMode: "dock", railShown: true, sheet: { w: 1100, h: 860 }, inspector: { open: true, mode: "dock", width: 360, short: false, bottom: 8 }, terminal: { shown: false, height: 0, maximized: false, most: 560 } }),
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
