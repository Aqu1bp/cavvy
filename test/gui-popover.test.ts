import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as solid from "../gui/node_modules/solid-js/dist/solid.js";
import { placePopover } from "../gui/src/lib/popover";
import { scaled } from "../gui/src/lib/text-size";
import { all, component, node, renderer } from "./helpers/gui-render";

// A composer button near the window's bottom, as in a session: 1360x880, the card tall with images and text.
const button = { left: 594, right: 694, top: 821, bottom: 849 };
const view = { vw: 1360, vh: 880 };

test("a picker opens just above its own button, at its leading edge", () => {
    const at = placePopover(button, { ...view, width: 340, least: 335, placement: "top" });
    expect(at).toEqual({ left: 594, width: 340, bottom: 880 - 821 + 6, maxHeight: 821 - 12 });
});

test("with no room above it flips below, and with none below it flips above", () => {
    const high = { left: 40, right: 140, top: 60, bottom: 88 };
    expect(placePopover(high, { ...view, width: 340, least: 335, placement: "top" })).toEqual({ left: 40, width: 340, top: 94, maxHeight: 880 - 88 - 12 });
    // Home opens downward, unless the button is too low for it.
    const home = { left: 689, right: 789, top: 497, bottom: 525 };
    expect(placePopover(home, { ...view, width: 340, least: 335, placement: "bottom" })).toEqual({ left: 689, width: 340, top: 531, maxHeight: 880 - 525 - 12 });
    expect(placePopover(button, { ...view, width: 340, least: 335, placement: "bottom" }).bottom).toBe(880 - 821 + 6);
});

test("it stays inside the window, and `end` lines it up with the button's trailing edge", () => {
    expect(placePopover({ left: 1300, right: 1340, top: 821, bottom: 849 }, { ...view, width: 340, least: 200, placement: "top" }).left).toBe(1360 - 340 - 8);
    expect(placePopover({ left: 2, right: 30, top: 821, bottom: 849 }, { ...view, width: 340, least: 200, placement: "top" }).left).toBe(8);
    expect(placePopover({ left: 1145, right: 1173, top: 821, bottom: 849 }, { ...view, width: 288, least: 200, placement: "top", align: "end" }).left).toBe(1173 - 288);
});

// Widths are given at text size 14 and grow with it (#350): a 420px picker is 540px at 18, wider than a
// narrow window. It keeps 8px a side, and its right edge (a worktree's "Remove" button) stays in sight.
test("a popover wider than the window is narrowed to it, 8px a side", () => {
    const narrow = { vw: 500, vh: 700 };
    const at = placePopover({ left: 300, right: 340, top: 40, bottom: 68 }, { ...narrow, width: scaled(420, 18), least: 200, placement: "bottom" });
    expect(at.width).toBe(500 - 16);
    expect([at.left, at.left + at.width]).toEqual([8, 500 - 8]);
    // `end`, too: against the window's right edge.
    const end = placePopover({ left: 420, right: 480, top: 40, bottom: 68 }, { ...narrow, width: scaled(420, 18), least: 200, placement: "bottom", align: "end" });
    expect([end.left, end.left + end.width]).toEqual([8, 500 - 8]);
    // One that fits keeps its width.
    expect(placePopover({ left: 40, right: 80, top: 40, bottom: 68 }, { ...narrow, width: 300, least: 200, placement: "bottom" }).width).toBe(300);
});

test("the popover is drawn at the width it was placed with", () => {
    const source = readFileSync(new URL("../gui/src/components/ui/Popover.tsx", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
    const win = { innerWidth: 500, innerHeight: 700, addEventListener() {}, removeEventListener() {} };
    const doc = { addEventListener() {}, removeEventListener() {} };
    const Popover = component(source, "Popover", {
        settingsTab: () => undefined, document: doc, window: win, requestAnimationFrame: (fn: () => void) => fn(), mountMenu: () => () => {}, placePopover, sp: (n: number) => scaled(n, 18),
        renderer: { ...solid, ...renderer, Portal: (p: any) => p.children },
    });
    const anchor = { getBoundingClientRect: () => ({ left: 300, right: 340, top: 40, bottom: 68 }), closest: () => null };
    const root = node("root");
    const dispose = renderer.render(() => Popover({ open: true, onClose() {}, anchor: () => anchor, width: 420, children: "menu" }), root);
    try {
        const box = all(root).find((n) => String(n.props.class ?? "").startsWith("popover"))!;
        const style = typeof box.props.style === "function" ? box.props.style() : box.props.style;
        expect({ left: style.left, width: style.width }).toEqual({ left: "8px", width: `${500 - 16}px` });
    } finally { dispose(); }
});
