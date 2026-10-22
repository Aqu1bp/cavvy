// SessionView (App.tsx) rendered with real Solid reactivity in an in-memory DOM (run by
// gui-layout-sizes.test.ts): the composer dock's measured height reaches the transcript as its
// `dock` prop, which sets it on the boxes that keep room for the dock and gives it to find
// (gui-transcript-scroll checks that side). --dock-h isn't inherited, so nothing else carries it.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { all, component, node, renderer } from "../helpers/gui-render";

const between = (path: string, from: string, to: string) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    return source.slice(source.indexOf(from), source.indexOf(to));
};

test("the composer dock's measured height is the transcript's dock prop, and the window's", () => {
    const observed: { cb: () => void; targets: any[] }[] = [];
    let transcript: { dock?: number } | undefined;
    const windowDock: number[] = [];
    const SessionView = component(between("../../gui/src/App.tsx", "function SessionView(", "/** The docked inspector's left edge"), "SessionView", {
        Header: () => node("header"),
        Transcript: (p: { dock?: number }) => { transcript = p; return node("transcript"); },
        Composer: () => node("composer"),
        setDockHeight: (h: number) => windowDock.push(h),
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
        expect(windowDock).toEqual([112, 244]);
    } finally {
        dispose();
    }
});
