// Panes (components/Panes.tsx) alone keeps the session shown before, out of sight, to show it again as it was: one,
// only while it's idle, and never built again out of sight once let go of. Real Solid reactivity, in-memory DOM.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import * as solid from "../gui/node_modules/solid-js/dist/solid.js";
import { component, node, renderer } from "./helpers/gui-render";

const between = (path: string, from: string, to: string) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    return source.slice(source.indexOf(from), to ? source.indexOf(to) : undefined);
};

function setup() {
    const [busy, setBusy] = solid.createSignal<Record<string, boolean>>({});
    const handles = new Map(["a", "b", "c"].map((id) => [id, { id, view: { state: { get busy() { return Boolean(busy()[id]); } } } }]));
    const built: string[] = [];
    // Mounted now, in the order they were made (a pane made later goes after those there).
    const alive = new Map<string, { parked: () => boolean }>();
    const Pane = (p: { id: string; parked: boolean }) => {
        const id = p.id;
        built.push(id);
        alive.set(id, { parked: () => p.parked });
        solid.onCleanup(() => alive.delete(id));
        return node(`pane-${id}`);
    };
    const Panes = component(between("../gui/src/components/Panes.tsx", "/** The stage's panes:", ""), "Panes", {
        Pane, SplitBar: () => null, DropZone: () => null,
        handleFor: (id?: string) => (id ? handles.get(id) : undefined),
        split: () => undefined, splitIds: () => undefined, splitDrag: () => undefined, splitRatio: () => 0.5, splitShare: (r: number) => r,
        shellLayout: () => ({ column: { w: 1000 } }), draggedSession: () => undefined, canDrop: () => false,
    });
    const [single, setSingle] = solid.createSignal<{ id: string } | undefined>(handles.get("a"));
    const root = node("root");
    const dispose = renderer.render(() => Panes({ get single() { return single(); } }), root);
    const order = () => [...alive].map(([id, pane]) => id + (pane.parked() ? "(parked)" : ""));
    return { show: (id: string) => setSingle(handles.get(id)), setBusy, built, order, dispose };
}

test("the session shown before is kept, parked, and shown again without being built again", () => {
    const s = setup();
    try {
        expect(s.order()).toEqual(["a"]);
        s.show("b");
        expect(s.order()).toEqual(["a(parked)", "b"]);
        s.show("a");
        // The same panes: only which is parked changed.
        expect(s.order()).toEqual(["a", "b(parked)"]);
        s.show("b");
        expect(s.order()).toEqual(["a(parked)", "b"]);
        expect(s.built).toEqual(["a", "b"]);
        // Only one: the one before that is let go of.
        s.show("c");
        expect(s.order()).toEqual(["b(parked)", "c"]);
        expect(s.built).toEqual(["a", "b", "c"]);
    } finally {
        s.dispose();
    }
});

test("a busy session isn't kept, and isn't built again out of sight once it's idle", () => {
    const s = setup();
    try {
        s.show("b");
        expect(s.order()).toEqual(["a(parked)", "b"]);
        // Going busy while parked: let go of (it would stream out of sight).
        s.setBusy({ a: true });
        expect(s.order()).toEqual(["b"]);
        s.setBusy({});
        expect(s.order()).toEqual(["b"]);
        expect(s.built).toEqual(["a", "b"]);
        // Left while busy: not kept either; shown again, built afresh.
        s.setBusy({ b: true });
        s.show("a");
        expect(s.order()).toEqual(["a"]);
        expect(s.built).toEqual(["a", "b", "a"]);
    } finally {
        s.dispose();
    }
});
