// SessionView (components/Panes.tsx) rendered with real Solid reactivity in an in-memory DOM (run by
// gui-layout-sizes.test.ts): the composer dock's measured height reaches the transcript as its
// `dock` prop, which sets it on the boxes that keep room for the dock and gives it to find
// (gui-transcript-scroll checks that side). --dock-h isn't inherited, so nothing else carries it.
// A sub-agent's view (Agents.tsx AgentView) gives the window its dock the same way.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer } from "../helpers/gui-render";

const between = (path: string, from: string, to: string) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    return source.slice(source.indexOf(from), source.indexOf(to));
};

test("the composer dock's measured height is the transcript's dock prop, and the window's", () => {
    const observed: { cb: () => void; targets: any[] }[] = [];
    let transcript: { dock?: number } | undefined;
    const windowDock: (number | undefined)[] = [];
    const [parked, setParked] = solid.createSignal(false);
    const SessionView = component(between("../../gui/src/components/Panes.tsx", "function SessionView(", "/** A pane whose session isn't open"), "SessionView", {
        usePane: () => ({ focused: () => true, parked, split: () => false, rightmost: () => true, share: () => 1, wasFocused: () => true }),
        Header: () => node("header"),
        Transcript: (p: { dock?: number }) => { transcript = p; return node("transcript"); },
        FloatingBrowser: () => node("floating-browser"),
        Composer: () => node("composer"),
        ErrorCards: () => node("error-cards"),
        paneDock: (_key: object, h?: number) => windowDock.push(h),
        ResizeObserver: class {
            targets: any[] = [];
            constructor(public cb: () => void) { observed.push(this); }
            observe(target: any) { this.targets.push(target); }
            disconnect() {}
        },
    });
    const root = node("root");
    const dispose = renderer.render(() => SessionView({ handle: { id: "s" } }), root);
    try {
        const dock = all(root).find((n) => n.props.class === "composer-dock") as any;
        expect(observed.map((o) => o.targets)).toEqual([[dock]]);
        expect(transcript!.dock).toBeUndefined();
        dock.offsetHeight = 112;
        observed[0]!.cb();
        expect(transcript!.dock).toBe(112);
        dock.offsetHeight = 244;
        observed[0]!.cb();
        expect(transcript!.dock).toBe(244);
        // Kept out of sight (Panes.tsx): its dock isn't the window's; shown again, it is.
        setParked(true);
        setParked(false);
        expect(windowDock).toEqual([112, 244, undefined, 244]);
    } finally {
        dispose();
    }
});

test("a sub-agent's view measures its dock for the window too, so a floating diff reader ends above it", () => {
    const observed: { cb: () => void; targets: any[] }[] = [];
    const windowDock: number[] = [];
    const source = readFileSync(new URL("../../gui/src/components/Agents.tsx", import.meta.url), "utf8");
    // Every imported name gets a stand-in; the view's own helpers stay real.
    const imported = [...source.matchAll(/^import (?:type )?\{([^}]*)\}/gm)].flatMap((m) => m[1]!.split(",").map((n) => n.trim().replace(/^type /, "").split(" as ").pop()!).filter(Boolean));
    const stubs = Object.fromEntries(imported.filter((n) => !(n in solid)).map((n) => [n, () => null]));
    const AgentView = component(source.replace(/^import [\s\S]*?;\n/gm, "").replace(/^export /gm, ""), "AgentView", {
        ...stubs,
        groupBlocks: () => [], duration: () => "1s", now: () => 0, clock: () => "", plural: () => "", sessionTitle: () => "Session",
        paneDock: (_key: object, h?: number) => windowDock.push(h ?? 0),
        ResizeObserver: class {
            targets: any[] = [];
            constructor(public cb: () => void) { observed.push(this); }
            observe(target: any) { this.targets.push(target); }
            disconnect() {}
        },
    });
    const handle = { id: "s", view: { state: { projectName: "p", cwd: "/p", interactions: [] }, agents: [] } };
    const agent = { id: "a", status: "done", blocks: [], startedAt: 0, endedAt: 1000, description: "Look around" };
    const root = node("root");
    const dispose = renderer.render(() => AgentView({ handle, agent }), root);
    const dock = all(root).find((n) => n.props.class === "composer-dock") as any;
    expect(observed.map((o) => o.targets)).toEqual([[dock]]);
    dock.offsetHeight = 96;
    observed[0]!.cb();
    dock.offsetHeight = 180;
    observed[0]!.cb();
    expect(windowDock).toEqual([96, 180]);
    // Leaving it, the window has no dock again (Home's, or a session's, measures its own).
    dispose();
    expect(windowDock).toEqual([96, 180, 0]);
});
