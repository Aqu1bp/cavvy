// EffortBars rendered with real Solid reactivity in an in-memory DOM (run by gui-effort.test.ts).
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer, type Node } from "../helpers/gui-render";
import { effortAt, effortKey, effortLevels } from "../../gui/src/lib/effort";

const key = (k: string) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false });

test("EffortBars: fills to the value, previews on hover, applies on click, drag and keys", () => {
    const source = readFileSync(new URL("../../gui/src/components/ModelPicker.tsx", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
    const Bars = component(source, "EffortBars", { effortAt, effortKey });
    const levels = effortLevels({ effortLevels: ["low", "medium", "high", "xhigh"] });
    const [value, setValue] = solid.createSignal<string | undefined>("medium");
    const picked: string[] = [];
    const root = node("root");
    const dispose = renderer.render(() => Bars({ levels, get value() { return value(); }, onChange: (id: string) => { picked.push(id); setValue(id); } }), root);
    try {
        const slider = all(root).find((n) => n.props.role === "slider")!;
        Object.assign(slider, { getBoundingClientRect: () => ({ left: 0, width: 100 }), focus() {}, setPointerCapture() {} });
        const bars = () => all(slider).filter((n) => String(n.props.class ?? "").startsWith("eb"));
        const on = () => bars().filter((n) => /\bon\b/.test(n.props.class)).length;
        const pre = () => bars().filter((n) => /\bpre\b/.test(n.props.class)).length;
        const press = (k: string) => {
            const e = { ...key(k), prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} };
            slider.props.onKeyDown(e);
            return e.prevented;
        };
        const pointer = (type: string, x: number) => slider.props[type]({ clientX: x, pointerId: 1, preventDefault() {} });

        expect(bars()).toHaveLength(4);
        expect(slider.props["aria-valuenow"]).toBe(2);
        expect(slider.props["aria-valuemax"]).toBe(4);
        expect(slider.props["aria-valuetext"]).toBe("Medium");
        expect(on()).toBe(2);
        // Heights rise left to right.
        expect(bars().map((b: Node) => Number(b.props.style["--h"]))).toEqual([0.25, 0.5, 0.75, 1]);

        // Hover previews without picking.
        pointer("onPointerMove", 80);
        expect(slider.props.class).toContain("hov");
        expect(pre()).toBe(4);
        expect(picked).toEqual([]);
        pointer("onPointerLeave", 80);
        expect(slider.props.class).not.toContain("hov");
        expect(pre()).toBe(0);

        // Click, then drag: it applies as it moves, once per bar.
        pointer("onPointerDown", 60);
        expect(picked).toEqual(["high"]);
        pointer("onPointerMove", 70);
        pointer("onPointerMove", 90);
        pointer("onPointerMove", 10);
        pointer("onPointerUp", 10);
        expect(picked).toEqual(["high", "xhigh", "low"]);
        pointer("onPointerMove", 90);
        expect(picked).toEqual(["high", "xhigh", "low"]);
        expect(on()).toBe(1);

        expect(press("ArrowRight")).toBe(true);
        expect(press("End")).toBe(true);
        expect(press("End")).toBe(true);
        expect(press("2")).toBe(true);
        expect(press("Home")).toBe(true);
        expect(press("x")).toBe(false);
        expect(picked).toEqual(["high", "xhigh", "low", "medium", "xhigh", "medium", "low"]);

        // A value the model doesn't name (its default): nothing filled, and it says so.
        setValue(undefined);
        expect(on()).toBe(0);
        expect(slider.props["aria-valuenow"]).toBeUndefined();
        expect(slider.props["aria-valuetext"]).toBe("Default");
    } finally {
        dispose();
    }
});
