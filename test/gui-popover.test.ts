import { expect, test } from "bun:test";
import { placePopover } from "../gui/src/lib/popover";

// A composer button near the window's bottom, as in a session: 1360x880, the card tall with images and text.
const button = { left: 594, right: 694, top: 821, bottom: 849 };
const view = { vw: 1360, vh: 880 };

test("a picker opens just above its own button, at its leading edge", () => {
    const at = placePopover(button, { ...view, width: 340, least: 335, placement: "top" });
    expect(at).toEqual({ left: 594, bottom: 880 - 821 + 6, maxHeight: 821 - 12 });
});

test("with no room above it flips below, and with none below it flips above", () => {
    const high = { left: 40, right: 140, top: 60, bottom: 88 };
    expect(placePopover(high, { ...view, width: 340, least: 335, placement: "top" })).toEqual({ left: 40, top: 94, maxHeight: 880 - 88 - 12 });
    // Home opens downward, unless the button is too low for it.
    const home = { left: 689, right: 789, top: 497, bottom: 525 };
    expect(placePopover(home, { ...view, width: 340, least: 335, placement: "bottom" })).toEqual({ left: 689, top: 531, maxHeight: 880 - 525 - 12 });
    expect(placePopover(button, { ...view, width: 340, least: 335, placement: "bottom" }).bottom).toBe(880 - 821 + 6);
});

test("it stays inside the window, and `end` lines it up with the button's trailing edge", () => {
    expect(placePopover({ left: 1300, right: 1340, top: 821, bottom: 849 }, { ...view, width: 340, least: 200, placement: "top" }).left).toBe(1360 - 340 - 8);
    expect(placePopover({ left: 2, right: 30, top: 821, bottom: 849 }, { ...view, width: 340, least: 200, placement: "top" }).left).toBe(8);
    expect(placePopover({ left: 1145, right: 1173, top: 821, bottom: 849 }, { ...view, width: 288, least: 200, placement: "top", align: "end" }).left).toBe(1173 - 288);
});
