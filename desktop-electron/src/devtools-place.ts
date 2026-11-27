// Where a Browser tab's DevTools window opens (browser-host.ts devTools). Where it was last, while a display still shows
// it and it doesn't cover the Browser pane it's there to inspect; otherwise beside the app's window on the same display,
// on the side with room for it, at the window's height; and where there's no room beside it, over the side of the window
// away from the Browser pane, its edge at the pane. Always whole within the display's work area, its frame (title bar
// included) too, and a step off another DevTools window already there, so two never look like one.
// No Electron here, so it's tested on its own (test/electron-devtools-place.test.ts).

import type { Rect } from "./window-state";

export const DEVTOOLS_SIZE = { width: 760, height: 720 };
export const DEVTOOLS_MIN = { width: 480, height: 360 };
/** How much of the window's top strip (where it's dragged from) a display must show for its last place to be kept. */
const GRIP = { width: 120, height: 30 };
/** How far each DevTools window opened onto another's place moves off it, right and down (or left, away from the pane). */
export const CASCADE_STEP = 28;

/**
 * What the system draws around a window outside the bounds it's given: on Linux the window manager adds its frame (the
 * title bar above) outside them; on macOS and Windows the bounds include it. Enough for the common window managers'
 * title bars; the place is kept that far inside the work area.
 */
export interface Frame {
    top: number;
    left: number;
    right: number;
    bottom: number;
}
export const NO_FRAME: Frame = { top: 0, left: 0, right: 0, bottom: 0 };
export const LINUX_FRAME: Frame = { top: 40, left: 4, right: 4, bottom: 8 };

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

function overlap(a: Rect, b: Rect): { width: number; height: number } {
    return {
        width: Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)),
        height: Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y)),
    };
}
const covers = (a: Rect, b: Rect) => {
    const o = overlap(a, b);
    return o.width > 0 && o.height > 0;
};
/** Where the window's bounds may go on a display for its frame to be whole on it. */
const inside = (d: Rect, f: Frame): Rect => ({ x: d.x + f.left, y: d.y + f.top, width: Math.max(0, d.width - f.left - f.right), height: Math.max(0, d.height - f.top - f.bottom) });
/** The bounds moved, then shrunk where they must be (not below the least size the area allows), to be whole in `area`. */
function within(b: Rect, area: Rect): Rect {
    const width = clamp(b.width, Math.min(DEVTOOLS_MIN.width, area.width), area.width);
    const height = clamp(b.height, Math.min(DEVTOOLS_MIN.height, area.height), area.height);
    return { x: clamp(b.x, area.x, right(area) - width), y: clamp(b.y, area.y, bottom(area) - height), width, height };
}

export interface PlaceOptions {
    /** The app's window. */
    app: Rect;
    /** The Browser pane, in the same (screen) coordinates. */
    pane?: Rect;
    /** The work area of the display the app is on. */
    work: Rect;
    /** Every display's work area. */
    displays: readonly Rect[];
    /** Where it was last. */
    saved?: unknown;
    /** What the system draws outside the bounds (LINUX_FRAME on Linux). */
    frame?: Frame;
    /** The other DevTools windows open now. */
    others?: readonly Rect[];
}

/** The DevTools window's bounds. */
export function devToolsBounds(o: PlaceOptions): Rect {
    const frame = o.frame ?? NO_FRAME;
    const area = inside(o.work, frame);
    const s = (o.saved && typeof o.saved === "object" ? o.saved : {}) as Record<string, unknown>;
    if (num(s.x) && num(s.y) && num(s.width) && num(s.height)) {
        const saved = { x: Math.round(s.x), y: Math.round(s.y), width: Math.round(s.width), height: Math.round(s.height) };
        const grip = { x: saved.x, y: saved.y, width: saved.width, height: GRIP.height };
        const on = o.displays.find((d) => overlap(grip, d).width >= Math.min(GRIP.width, saved.width) && overlap(grip, d).height >= GRIP.height);
        if (on) {
            const kept = within(saved, inside(on, frame));
            // Over the pane now (the app moved, grew or was maximised since): placed afresh instead.
            if (!o.pane || !covers(kept, o.pane)) return offOthers(kept, inside(on, frame), o.pane, o.others);
        }
    }
    return offOthers(fresh(o.app, area, o.pane), area, o.pane, o.others);
}

/** Beside the app's window where there's room, else over it on the side away from the pane, its edge at the pane. */
function fresh(app: Rect, area: Rect, given?: Rect): Rect {
    const height = clamp(Math.min(app.height, area.height), Math.min(DEVTOOLS_MIN.height, area.height), area.height);
    const y = clamp(app.y, area.y, bottom(area) - height);
    const roomRight = right(area) - right(app);
    const roomLeft = app.x - area.x;
    // Beside the window: right first (the side the pane is on), else left.
    if (roomRight >= DEVTOOLS_MIN.width) return { x: right(app), y, width: Math.min(DEVTOOLS_SIZE.width, roomRight), height };
    if (roomLeft >= DEVTOOLS_MIN.width) {
        const width = Math.min(DEVTOOLS_SIZE.width, roomLeft);
        return { x: app.x - width, y, width, height };
    }
    // Over the window, on the side away from the pane (by default the panel's side, the right).
    const pane = given ?? { x: app.x + app.width * 0.66, y: app.y, width: app.width * 0.34, height: app.height };
    const width = Math.min(DEVTOOLS_SIZE.width, area.width);
    const paneOnRight = pane.x + pane.width / 2 >= app.x + app.width / 2;
    if (paneOnRight && Math.round(pane.x) - area.x >= DEVTOOLS_MIN.width) {
        const w = Math.min(width, Math.round(pane.x) - area.x);
        return { x: Math.round(pane.x) - w, y, width: w, height };
    }
    if (!paneOnRight && right(area) - Math.round(right(pane)) >= DEVTOOLS_MIN.width) {
        return { x: Math.round(right(pane)), y, width: Math.min(width, right(area) - Math.round(right(pane))), height };
    }
    // No room anywhere: as far from the pane as the display allows.
    return { x: paneOnRight ? area.x : right(area) - width, y, width, height };
}

/**
 * Off another DevTools window that's (nearly) where this one would open: a step down and right, further steps while
 * those are taken too, or down and left where right would cover the pane or leave the display. Shrunk at the display's
 * edge rather than moved off it; kept off the pane where the place it started from was.
 */
function offOthers(b: Rect, area: Rect, pane: Rect | undefined, others: readonly Rect[] = []): Rect {
    const near = (a: Rect, c: Rect) => Math.abs(a.x - c.x) < CASCADE_STEP / 2 && Math.abs(a.y - c.y) < CASCADE_STEP / 2;
    const taken = (c: Rect) => others.some((o) => near(o, c));
    if (!taken(b)) return b;
    const avoidPane = pane && !covers(b, pane) ? pane : undefined;
    for (const dir of [1, -1]) {
        for (let k = 1; k <= 12; k++) {
            const dx = dir * k * CASCADE_STEP;
            const x = b.x + dx;
            const y = b.y + k * CASCADE_STEP;
            // Shrunk at the area's edge, not moved back onto the place it's stepping off.
            const width = Math.min(b.width, dx > 0 ? right(area) - x : right(b) - Math.max(x, area.x));
            const height = Math.min(b.height, bottom(area) - y);
            const c = { x: Math.max(x, area.x), y, width, height };
            if (width < Math.min(DEVTOOLS_MIN.width, area.width) || height < Math.min(DEVTOOLS_MIN.height, area.height)) continue;
            if (avoidPane && covers(c, avoidPane)) continue;
            if (!taken(c)) return c;
        }
    }
    return b;
}

/** The window's title: the page's, as the person knows it. */
export function devToolsTitle(pageTitle: string): string {
    const t = pageTitle.trim();
    return t ? `DevTools: ${t}` : "DevTools";
}
