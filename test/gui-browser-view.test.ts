// The Browser pane's page size and zoom (gui/src/lib/browser-view.ts): what the headless page is asked for, and how
// large a device's page is drawn in the pane (gui/src/lib/browser.ts placeFrame).
import { expect, test } from "bun:test";
import { DEVICES, deviceOf, fitScale, pageTarget, side, viewLabel, zoomStep } from "../gui/src/lib/browser-view";
import { placeFrame } from "../gui/src/lib/browser";

const pane = { width: 400, height: 700 };

test("without a view the page is the pane's size at the screen's scale, as before", () => {
    expect(pageTarget(pane, 2)).toEqual({ width: 400, height: 700, scale: 2 });
});

test("a device's page keeps its size, at the pixels it's drawn in", () => {
    // 390 × 844 in 400 × 700: drawn at 700/844 of its size.
    const t = pageTarget(pane, 2, { device: { width: 390, height: 844 }, zoom: 1 });
    expect({ width: t.width, height: t.height }).toEqual({ width: 390, height: 844 });
    expect(t.scale).toBeCloseTo((2 * 700) / 844, 5);
    // One that fits isn't drawn larger.
    expect(pageTarget({ width: 1000, height: 1000 }, 2, { device: { width: 390, height: 844 }, zoom: 1 }).scale).toBe(2);
    expect(fitScale({ width: 1000, height: 1000 }, { width: 390, height: 844 })).toBe(1);
});

test("zoom is a browser's: fewer CSS pixels across, each drawn larger", () => {
    expect(pageTarget(pane, 2, { zoom: 1.25 })).toEqual({ width: 320, height: 560, scale: 2.5 });
    expect(pageTarget(pane, 1, { zoom: 0.5 })).toEqual({ width: 800, height: 1400, scale: 0.5 });
    const t = pageTarget({ width: 1000, height: 1000 }, 1, { device: { width: 400, height: 800 }, zoom: 2 });
    expect(t).toEqual({ width: 200, height: 400, scale: 2 });
});

test("a device's frame is drawn no larger than the device, centred", () => {
    // At 100% a 390-wide frame in a 1000-wide box stays 390 wide.
    expect(placeFrame({ width: 1000, height: 1000 }, { width: 390, height: 844 }, 1)).toEqual({ x: 305, y: 78, width: 390, height: 844 });
    // At 200% the frame is half the device's CSS pixels across, drawn twice as large: the device's size again.
    expect(placeFrame({ width: 1000, height: 1000 }, { width: 195, height: 422 }, 2)).toMatchObject({ width: 390, height: 844 });
    // Larger than the box: scaled down to fit.
    expect(placeFrame(pane, { width: 1280, height: 800 }, 1).width).toBe(400);
    // Without a cap (the pane's own size) a frame fills the box.
    expect(placeFrame(pane, { width: 200, height: 350 }).width).toBe(400);
});

test("zoom steps, sides typed in, and the label", () => {
    expect(zoomStep(1, 1)).toBe(1.1);
    expect(zoomStep(1, -1)).toBe(0.9);
    expect(zoomStep(2, 1)).toBe(2);
    expect(zoomStep(0.5, -1)).toBe(0.5);
    expect(zoomStep(1.2, 1)).toBe(1.25);
    expect(side(" 390 ")).toBe(390);
    expect(side("200")).toBe(200);
    expect(side("4000")).toBe(4000);
    // out of range is refused, not changed: the strip says what it takes
    expect(side("50")).toBeUndefined();
    expect(side("99999")).toBeUndefined();
    expect(side("wide")).toBeUndefined();
    expect(side("")).toBeUndefined();
    expect(viewLabel()).toBe("Fill pane");
    expect(viewLabel({ device: { width: 390, height: 844 }, zoom: 1.5 })).toBe("390 × 844 · 150%");
});

test("a device either way round is that device; any other size is a custom one", () => {
    const phone = DEVICES.find((d) => d.name === "Phone")!;
    expect(deviceOf(phone.size)).toBe(phone);
    expect(deviceOf({ width: phone.size.height, height: phone.size.width })).toBe(phone);
    expect(deviceOf({ width: 390, height: 845 })).toBeUndefined();
    expect(deviceOf(undefined)).toBeUndefined();
});
