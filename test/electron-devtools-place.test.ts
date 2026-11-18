// Where a Browser tab's DevTools window opens in the desktop app (desktop-electron/src/devtools-place.ts).
import { expect, test } from "bun:test";
import { DEVTOOLS_MIN, DEVTOOLS_SIZE, devToolsBounds, devToolsTitle } from "../desktop-electron/src/devtools-place";

const work = { x: 0, y: 25, width: 2560, height: 1415 };
const pane = (app: { x: number; y: number; width: number; height: number }) => ({ x: app.x + app.width - 360, y: app.y + 80, width: 320, height: app.height - 100 });

test("beside the app's window, right of it where there's room, at its height and top", () => {
    const app = { x: 100, y: 100, width: 1360, height: 880 };
    expect(devToolsBounds({ app, pane: pane(app), work, displays: [work] })).toEqual({ x: 1460, y: 100, width: DEVTOOLS_SIZE.width, height: 880 });
});

test("left of it when the right has no room, narrower when that's all there is", () => {
    const app = { x: 1000, y: 100, width: 1500, height: 880 };
    expect(devToolsBounds({ app, pane: pane(app), work, displays: [work] })).toEqual({ x: 1000 - DEVTOOLS_SIZE.width, y: 100, width: DEVTOOLS_SIZE.width, height: 880 });
    const tight = { x: 520, y: 100, width: 2000, height: 880 };
    expect(devToolsBounds({ app: tight, pane: pane(tight), work, displays: [work] })).toEqual({ x: 0, y: 100, width: 520, height: 880 });
});

test("a window filling its display: over the side away from the Browser pane, never over the pane", () => {
    const laptop = { x: 0, y: 25, width: 1512, height: 920 };
    const app = { ...laptop };
    const p = pane(app);
    const b = devToolsBounds({ app, pane: p, work: laptop, displays: [laptop] });
    expect(b.x + b.width).toBeLessThanOrEqual(p.x);
    expect(b.width).toBe(DEVTOOLS_SIZE.width);
    expect(b).toEqual({ x: p.x - DEVTOOLS_SIZE.width, y: 25, width: DEVTOOLS_SIZE.width, height: 920 });
    // the pane on the left (a panel moved there): DevTools on the right of it
    const left = { x: 300, y: 105, width: 320, height: 800 };
    const r = devToolsBounds({ app, pane: left, work: laptop, displays: [laptop] });
    expect(r.x).toBeGreaterThanOrEqual(left.x + left.width);
});

test("a small display: as large as it allows, on it", () => {
    const small = { x: 0, y: 0, width: 1024, height: 600 };
    const b = devToolsBounds({ app: small, pane: { x: 800, y: 40, width: 224, height: 560 }, work: small, displays: [small] });
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(800);
    expect(b.width).toBeGreaterThanOrEqual(DEVTOOLS_MIN.width);
    expect(b.height).toBe(600);
});

test("where it was last, if a display still shows it; kept within that display", () => {
    const app = { x: 100, y: 100, width: 1360, height: 880 };
    const saved = { x: 1600, y: 200, width: 900, height: 700 };
    expect(devToolsBounds({ app, work, displays: [work], saved })).toEqual(saved);
    // larger than the display it's on now: shrunk to it
    expect(devToolsBounds({ app, work, displays: [work], saved: { x: 2000, y: 200, width: 3000, height: 2000 } })).toEqual({ x: 0, y: 25, width: 2560, height: 1415 });
    // on a display that's gone, or junk: beside the window
    expect(devToolsBounds({ app, work, displays: [work], saved: { x: 5000, y: 200, width: 900, height: 700 } }).x).toBe(1460);
    expect(devToolsBounds({ app, work, displays: [work], saved: "junk" }).x).toBe(1460);
});

test("titled for the page", () => {
    expect(devToolsTitle("Acme status")).toBe("DevTools: Acme status");
    expect(devToolsTitle("  ")).toBe("DevTools");
});
