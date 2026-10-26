// The rail's and the inspector's edges rendered with real Solid reactivity in an in-memory DOM
// (run by gui-drag.test.ts): a drag shows the size once a frame and saves it once, on release,
// within the same limits as before; a double-click and the keys still set it at once.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { all, component, node, renderer } from "../helpers/gui-render";
import { frameDrag } from "../../gui/src/lib/drag";
import { clampInspectorWidth, INSPECTOR_DEFAULT } from "../../gui/src/lib/layout";
import { fakeFrames } from "../helpers/frames";

const between = (path: string, from: string, to: string) => {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    return source.slice(source.indexOf(from), source.indexOf(to));
};

/** A stand-in for `window` and `document.body`: the listeners a drag adds, and the body's classes. */
function dragWorld() {
    const listeners: Record<string, ((e: any) => void) | undefined> = {};
    const classes = new Set<string>();
    return {
        listeners,
        classes,
        window: { addEventListener: (type: string, fn: any) => (listeners[type] = fn), removeEventListener: (type: string, fn: any) => listeners[type] === fn && delete listeners[type] },
        document: { body: { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } } },
    };
}

test("the rail's edge: shown once a frame within 220-420, saved on release; a double-click resets it", () => {
    const world = dragWorld();
    const frames = fakeFrames();
    const saved: [string, number][] = [];
    const shown: (number | undefined)[] = [];
    const Frame = component(between("../../gui/src/components/Sidebar.tsx", "export function SidebarFrame(", "export function Sidebar("), "SidebarFrame", {
        prefs: { sidebarWidth: 260 },
        setPrefs: (key: string, value: number) => saved.push([key, value]),
        setRailDrag: (w: number | undefined) => shown.push(w),
        frameDrag: (o: Parameters<typeof frameDrag>[0]) => frameDrag({ ...o, frames }),
        SidebarTop: () => node("top"),
        isTauri: false, isDesktop: false, isElectron: false, os: "macos",
        window: world.window, document: world.document,
    });
    const root = node("root");
    const dispose = renderer.render(() => Frame({ children: node("list") }), root);
    try {
        const handle = all(root).find((n) => n.props.class === "resize-handle")!;
        handle.props.onPointerDown({ button: 0, clientX: 260 });
        expect(world.classes.has("resizing")).toBe(true);
        world.listeners.pointermove!({ clientX: 280 });
        world.listeners.pointermove!({ clientX: 300 });
        expect(shown).toEqual([]);
        frames.run();
        expect(shown).toEqual([300]);
        world.listeners.pointermove!({ clientX: 900 });
        frames.run();
        world.listeners.pointermove!({ clientX: 0 });
        frames.run();
        expect(shown).toEqual([300, 420, 220]);
        expect(saved).toEqual([]);
        world.listeners.pointermove!({ clientX: 330 });
        world.listeners.pointerup!({});
        expect(saved).toEqual([["sidebarWidth", 330]]);
        expect(shown.at(-1)).toBeUndefined();
        expect(frames.pending()).toBe(0);
        expect(world.classes.has("resizing")).toBe(false);
        expect(Object.keys(world.listeners).filter((k) => world.listeners[k])).toEqual([]);
        // A double-click's presses don't move it, and save nothing; the double-click sets the default.
        handle.props.onPointerDown({ button: 0, clientX: 260 });
        world.listeners.pointerup!({});
        expect(saved).toEqual([["sidebarWidth", 330]]);
        handle.props.onDblClick();
        expect(saved.at(-1)).toEqual(["sidebarWidth", 260]);
        // A cancelled pointer ends the drag too.
        handle.props.onPointerDown({ button: 0, clientX: 260 });
        world.listeners.pointermove!({ clientX: 250 });
        world.listeners.pointercancel!({});
        expect(saved.at(-1)).toEqual(["sidebarWidth", 250]);
        expect(world.classes.has("resizing")).toBe(false);
    } finally {
        dispose();
    }
});

test("the inspector's edge: shown once a frame within its bounds, saved on release or when it goes away; keys and a double-click set it at once", () => {
    const world = dragWorld();
    const frames = fakeFrames();
    const saved: number[] = [];
    const shown: (number | undefined)[] = [];
    const Resizer = component(between("../../gui/src/App.tsx", "function InspectorResizer(", "const INSPECTOR_KEY"), "InspectorResizer", {
        // A 1200px sheet: the conversation keeps 480, so it can widen to 720.
        shellLayout: () => ({ sheet: { w: 1200 }, inspector: { width: 360 } }),
        clampInspectorWidth, INSPECTOR_DEFAULT,
        setInspectorWidth: (w: number) => saved.push(w),
        setInspectorDrag: (w: number | undefined) => shown.push(w),
        frameDrag: (o: Parameters<typeof frameDrag>[0]) => frameDrag({ ...o, frames }),
        document: world.document,
    });
    const root = node("root");
    const dispose = renderer.render(() => Resizer(), root);
    const target = { setPointerCapture() {}, addEventListener: (type: string, fn: any) => (world.listeners[type] = fn), removeEventListener: (type: string, fn: any) => world.listeners[type] === fn && delete world.listeners[type] };
    try {
        const handle = all(root).find((n) => String(n.props.class).includes("insp-resizer"))!;
        handle.props.onPointerDown({ button: 0, clientX: 800, pointerId: 1, preventDefault() {}, currentTarget: target });
        // Left widens it.
        world.listeners.pointermove!({ clientX: 760 });
        world.listeners.pointermove!({ clientX: 740 });
        frames.run();
        expect(shown).toEqual([420]);
        world.listeners.pointermove!({ clientX: 0 });
        frames.run();
        world.listeners.pointermove!({ clientX: 1400 });
        frames.run();
        // As wide as keeps the conversation at its least (a browser wants room), and no narrower than the least.
        expect(shown).toEqual([420, 720, 280]);
        expect(saved).toEqual([]);
        world.listeners.pointermove!({ clientX: 700 });
        world.listeners.lostpointercapture!({});
        expect(saved).toEqual([460]);
        expect(shown.at(-1)).toBeUndefined();
        expect(world.classes.has("resizing")).toBe(false);
        // Keys and a double-click: at once.
        handle.props.onKeyDown({ key: "ArrowLeft", preventDefault() {} });
        expect(saved.at(-1)).toBe(384);
        handle.props.onDblClick();
        expect(saved.at(-1)).toBe(INSPECTOR_DEFAULT);
        // The handle going away mid-drag (the panel closing) ends the drag, keeping the width so far.
        handle.props.onPointerDown({ button: 0, clientX: 800, pointerId: 1, preventDefault() {}, currentTarget: target });
        world.listeners.pointermove!({ clientX: 790 });
        dispose();
        expect(saved.at(-1)).toBe(370);
        expect(shown.at(-1)).toBeUndefined();
        expect(world.classes.has("resizing")).toBe(false);
        expect(Object.keys(world.listeners).filter((k) => world.listeners[k])).toEqual([]);
    } finally {
        dispose();
    }
});
