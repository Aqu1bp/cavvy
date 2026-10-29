// EffortSlider rendered with real Solid reactivity in an in-memory DOM (run by gui-effort.test.ts).
import { expect, mock, test } from "bun:test";
import { readFileSync } from "fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer, text, type Node } from "../helpers/gui-render";
import { effortAt, effortKey, effortLevels, effortOf, takesEffort } from "../../gui/src/lib/effort";

const key = (k: string) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false });
const source = () => readFileSync(new URL("../../gui/src/components/ModelPicker.tsx", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");

test("EffortSlider: the knob at the value, a dot per level, hover grows the one a click would pick, applies on click, drag and keys", () => {
    const Slider = component(source(), "EffortSlider", { effortAt, effortKey });
    const levels = effortLevels({ effortLevels: ["low", "medium", "high", "xhigh"] });
    const [value, setValue] = solid.createSignal<string | undefined>("medium");
    const picked: string[] = [];
    const root = node("root");
    const dispose = renderer.render(() => Slider({ levels, get value() { return value(); }, onChange: (id: string) => { picked.push(id); setValue(id); } }), root);
    try {
        const slider = all(root).find((n) => n.props.role === "slider")!;
        Object.assign(slider, { getBoundingClientRect: () => ({ left: 0, width: 100 }), focus() {}, setPointerCapture() {} });
        const place = () => Number(slider.props.style["--p"]);
        const dots = () => all(slider).find((n) => n.props.class === "es-stops")!.children;
        const lit = () => dots().map((d: Node) => /\bon\b/.test(d.props.class)).filter(Boolean).length;
        const hovered = () => dots().findIndex((d: Node) => /\bhov\b/.test(d.props.class));
        const press = (k: string) => {
            const e = { ...key(k), prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
            slider.props.onKeyDown(e);
            return e.prevented;
        };
        const pointer = (type: string, x: number) => slider.props[type]({ clientX: x, button: 0, pointerId: 1, preventDefault() {} });

        expect(slider.props["aria-valuenow"]).toBe(2);
        expect(slider.props["aria-valuemax"]).toBe(4);
        expect(slider.props["aria-valuetext"]).toBe("Medium");
        // Medium is the second of four stops: a third of the way along.
        expect(place()).toBeCloseTo(1 / 3);
        expect(slider.props.class).not.toContain("unset");
        // A dot per level, named; those up to the knob lit.
        expect(dots().map((d: Node) => d.props.title)).toEqual(["Low", "Medium", "High", "Extra high"]);
        expect(lit()).toBe(2);

        // Hover grows the dot a click would pick, without picking; not the one the knob is on.
        pointer("onPointerMove", 95);
        expect(hovered()).toBe(3);
        pointer("onPointerMove", 30);
        expect(hovered()).toBe(-1);
        expect(picked).toEqual([]);
        pointer("onPointerMove", 95);
        pointer("onPointerLeave", 95);
        expect(hovered()).toBe(-1);

        // Click, then drag: it applies as it moves, once per stop; the knob is held while it does.
        pointer("onPointerDown", 60);
        expect(picked).toEqual(["high"]);
        expect(slider.props.class).toContain("drag");
        pointer("onPointerMove", 70);
        pointer("onPointerMove", 90);
        pointer("onPointerMove", 10);
        pointer("onPointerUp", 10);
        expect(picked).toEqual(["high", "xhigh", "low"]);
        expect(slider.props.class).not.toContain("drag");
        pointer("onPointerMove", 90);
        expect(picked).toEqual(["high", "xhigh", "low"]);
        expect(place()).toBe(0);

        expect(press("ArrowRight")).toBe(true);
        expect(press("End")).toBe(true);
        expect(press("End")).toBe(true);
        expect(press("2")).toBe(true);
        expect(press("Home")).toBe(true);
        expect(press("x")).toBe(false);
        expect(picked).toEqual(["high", "xhigh", "low", "medium", "xhigh", "medium", "low"]);

        // A value the model doesn't name (its default): an empty track, and it says so.
        setValue(undefined);
        expect(slider.props.class).toContain("unset");
        expect(place()).toBe(0);
        expect(lit()).toBe(0);
        expect(slider.props["aria-valuenow"]).toBeUndefined();
        expect(slider.props["aria-valuetext"]).toBe("Default");
    } finally {
        dispose();
    }
});

test("EffortSlider: a secondary or middle press changes nothing and starts no drag", () => {
    const Slider = component(source(), "EffortSlider", { effortAt, effortKey });
    const levels = effortLevels({ effortLevels: ["low", "medium", "high", "xhigh"] });
    const picked: string[] = [];
    const root = node("root");
    const dispose = renderer.render(() => Slider({ levels, value: "medium", onChange: (id: string) => picked.push(id) }), root);
    try {
        const slider = all(root).find((n) => n.props.role === "slider")!;
        Object.assign(slider, { getBoundingClientRect: () => ({ left: 0, width: 100 }), focus() {}, setPointerCapture() {} });
        const pointer = (type: string, x: number, button = 0) => slider.props[type]({ clientX: x, button, pointerId: 1, preventDefault() {} });
        for (const button of [2, 1]) {
            pointer("onPointerDown", 90, button);
            pointer("onPointerMove", 10);
            pointer("onPointerUp", 10, button);
        }
        expect(picked).toEqual([]);
        // The primary button still picks.
        pointer("onPointerDown", 90);
        expect(picked).toEqual(["xhigh"]);
    } finally {
        dispose();
    }
});

test("EffortPicker: a change the server refuses goes back to the level in force, and picking it again sends again (in a session and on Home)", async () => {
    // The real action; the store and the socket under it are stand-ins (the call fails once, as when disconnected).
    const calls: unknown[] = [];
    const errors: unknown[] = [];
    let fail = true;
    const stub = () => null;
    const app = { activeId: "s1" as string | undefined, settings: {}, models: [] };
    const [effort, setSessionEffort] = solid.createSignal<string | undefined>("medium");
    const rpc = { call: async (method: string, params: unknown) => {
        calls.push([method, params]);
        if (fail) throw new Error("Disconnected");
        return null;
    } };
    const names = (list: string[]) => Object.fromEntries(list.map((n) => [n, stub]));
    mock.module("../../gui/src/state/app", () => ({
        // On Home the picker shows the saved default, which only a saved change moves.
        app, rpc, reportError: (e: unknown) => errors.push(e), toast: stub,
        setApp: (key: string, field: string, value: string) => { if (key === "settings" && field === "effort") setSessionEffort(value); },
        ...names(["activate", "createSession", "dropHandle", "forkSession", "handleFor", "importCliSession", "markSeen", "refreshModels", "refreshProjects", "refreshProviders", "refreshSessions", "refreshSettings", "requestTrust", "revealBackground"]),
    }));
    mock.module("../../gui/src/lib/platform", () => names(["copyText", "pickFolder"]));
    mock.module("../../gui/src/state/prefs", () => ({ prefs: {}, setPrefs: stub }));
    mock.module("../../gui/src/state/ui", () => ({
        ...names(["railOpen", "requestComposerFocus", "setAgentFocus", "setArchiveRequest", "setContextCardOpen", "setFolderPickerOpen", "setMcpOpen", "setModePickerOpen", "setModelPickerOpen", "setRailOpen", "setReview", "setRewindOpen", "setSettingsTab", "setTerminalMax"]),
        shellLayout: () => ({ railMode: "dock" }),
    }));
    const { setEffort } = await import("../../gui/src/state/actions");
    const Picker = component(source(), "EffortPicker", {
        app, effortAt, effortKey, effortLevels, effortOf, takesEffort, setEffort, setFastMode: stub, setSettingsTab: stub, Zap: stub, ChevronDown: stub,
        Menu: (p: { open: boolean; children: unknown }) => solid.createMemo(() => (p.open ? p.children : null)),
    });
    const current = { id: "m", ref: "mock:m", supportsReasoning: true, effortLevels: ["low", "medium", "high", "xhigh"] };
    const root = node("root");
    const dispose = renderer.render(() => Picker({ current, get effort() { return effort(); }, open: true, setOpen() {} }), root);
    const settle = () => new Promise((r) => setTimeout(r, 0));
    try {
        const slider = () => {
            const s = all(root).find((n) => n.props.role === "slider")!;
            return Object.assign(s, { getBoundingClientRect: () => ({ left: 0, width: 100 }), focus() {}, setPointerCapture() {} });
        };
        const pick = (x: number) => {
            slider().props.onPointerDown({ clientX: x, button: 0, pointerId: 1, preventDefault() {} });
            slider().props.onPointerUp({});
        };
        const label = () => text(all(root).find((n) => n.props.class === "lbl")!);
        expect(label()).toBe("Medium");

        pick(90);
        // Shown at once while it's on its way.
        expect(label()).toBe("Extra high");
        await settle();
        expect(calls).toEqual([["session.setEffort", { id: "s1", effort: "xhigh" }]]);
        // Refused: the session is still at Medium, and the control says so.
        expect(errors).toHaveLength(1);
        expect(label()).toBe("Medium");
        expect(slider().props["aria-valuetext"]).toBe("Medium");

        // Picking it again sends again; this time the server takes it.
        fail = false;
        pick(90);
        await settle();
        expect(calls).toHaveLength(2);
        expect(calls[1]).toEqual(["session.setEffort", { id: "s1", effort: "xhigh" }]);
        setSessionEffort("xhigh");
        expect(label()).toBe("Extra high");

        // Home: the same for the default the next session starts with.
        app.activeId = undefined;
        fail = true;
        pick(10);
        await settle();
        expect(calls[2]).toEqual(["settings.update", { patch: { effort: "low" } }]);
        expect(errors).toHaveLength(2);
        expect(label()).toBe("Extra high");
        fail = false;
        pick(10);
        await settle();
        expect(calls[3]).toEqual(["settings.update", { patch: { effort: "low" } }]);
        expect(label()).toBe("Low");
    } finally {
        dispose();
    }
});
