// Where a Browser tab's DevTools window opens in the desktop app (desktop-electron/src/devtools-place.ts).
import { expect, test } from "bun:test";
import { CASCADE_STEP, DEVTOOLS_MIN, DEVTOOLS_SIZE, LINUX_FRAME, devToolsBounds, devToolsTitle } from "../desktop-electron/src/devtools-place";

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

const covers = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) && Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);

test("where it was last, unless that now covers the Browser pane (the app moved, grew or was maximised)", () => {
    const saved = { x: 1600, y: 200, width: 900, height: 700 };
    // The app small and to the left: the place it was last is clear of the pane, kept.
    const small = { x: 100, y: 100, width: 1360, height: 880 };
    expect(devToolsBounds({ app: small, pane: pane(small), work, displays: [work], saved })).toEqual(saved);
    // Moved right, under it: placed afresh, beside the app (left: the right has no room), off the pane.
    const moved = { x: 1100, y: 100, width: 1360, height: 880 };
    const m = devToolsBounds({ app: moved, pane: pane(moved), work, displays: [work], saved });
    expect(covers(m, pane(moved))).toBe(false);
    expect(m).toEqual({ x: 1100 - DEVTOOLS_SIZE.width, y: 100, width: DEVTOOLS_SIZE.width, height: 880 });
    // Maximised: over the chat, its edge at the pane.
    const max = { ...work };
    const p = pane(max);
    const b = devToolsBounds({ app: max, pane: p, work, displays: [work], saved });
    expect(covers(b, p)).toBe(false);
    expect(b.x + b.width).toBe(p.x);
});

test("its frame, title bar included, stays inside the work area where the system draws it outside the bounds", () => {
    const max = { ...work };
    const b = devToolsBounds({ app: max, pane: pane(max), work, displays: [work], frame: LINUX_FRAME });
    expect(b.y - LINUX_FRAME.top).toBeGreaterThanOrEqual(work.y);
    expect(b.y + b.height + LINUX_FRAME.bottom).toBeLessThanOrEqual(work.y + work.height);
    expect(b.x - LINUX_FRAME.left).toBeGreaterThanOrEqual(work.x);
    // A remembered place at the very top: moved down for its title bar.
    const saved = { x: 100, y: 25, width: 900, height: 700 };
    const app = { x: 1200, y: 300, width: 1300, height: 900 };
    expect(devToolsBounds({ app, pane: pane(app), work, displays: [work], saved, frame: LINUX_FRAME })).toEqual({ ...saved, y: 25 + LINUX_FRAME.top });
    // Beside a window at the top of the display, at its height where that fits.
    const top = { x: 100, y: 25, width: 1360, height: 1415 };
    const t = devToolsBounds({ app: top, pane: pane(top), work, displays: [work], frame: LINUX_FRAME });
    expect(t.y).toBe(25 + LINUX_FRAME.top);
    expect(t.y + t.height + LINUX_FRAME.bottom).toBeLessThanOrEqual(work.y + work.height);
});

test("a second tab's DevTools opens a step off the first, still in the work area and off the pane", () => {
    for (const app of [{ x: 100, y: 100, width: 1360, height: 880 }, { ...work }]) {
        const p = pane(app);
        const first = devToolsBounds({ app, pane: p, work, displays: [work], frame: LINUX_FRAME });
        const second = devToolsBounds({ app, pane: p, work, displays: [work], frame: LINUX_FRAME, others: [first] });
        expect(Math.abs(second.y - first.y)).toBe(CASCADE_STEP);
        expect(Math.abs(second.x - first.x)).toBe(CASCADE_STEP);
        expect(covers(second, p)).toBe(false);
        expect(second.y + second.height + LINUX_FRAME.bottom).toBeLessThanOrEqual(work.y + work.height);
        expect(second.x + second.width).toBeLessThanOrEqual(work.x + work.width);
        // A third steps further.
        const third = devToolsBounds({ app, pane: p, work, displays: [work], frame: LINUX_FRAME, others: [first, second] });
        expect(Math.abs(third.y - first.y)).toBe(2 * CASCADE_STEP);
        expect(covers(third, p)).toBe(false);
    }
    // From a remembered place too.
    const app = { x: 100, y: 100, width: 1360, height: 880 };
    const saved = { x: 1600, y: 200, width: 900, height: 700 };
    expect(devToolsBounds({ app, pane: pane(app), work, displays: [work], saved, others: [saved] })).toEqual({ x: 1628, y: 228, width: 900, height: 700 });
});

test("titled for the page", () => {
    expect(devToolsTitle("Acme status")).toBe("DevTools: Acme status");
    expect(devToolsTitle("  ")).toBe("DevTools");
});
