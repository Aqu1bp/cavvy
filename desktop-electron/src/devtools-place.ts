// Where a Browser tab's DevTools window opens (browser-host.ts devTools). Where it was last, if a display still shows
// it; otherwise beside the app's window on the same display, on the side with room for it, at the window's height; and
// where there's no room beside it, over the side of the window away from the Browser pane, which it's there to inspect.
// No Electron here, so it's tested on its own (test/electron-devtools-place.test.ts).

import type { Rect } from "./window-state";

export const DEVTOOLS_SIZE = { width: 760, height: 720 };
export const DEVTOOLS_MIN = { width: 480, height: 360 };
/** How much of the window's top strip (where it's dragged from) a display must show for its last place to be kept. */
const GRIP = { width: 120, height: 30 };

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

/**
 * The DevTools window's bounds. `app`: the app's window; `pane`: the Browser pane, in the same (screen) coordinates;
 * `work`: the work area of the display the app is on; `displays`: every display's work area; `saved`: where it was last.
 */
export function devToolsBounds(o: { app: Rect; pane?: Rect; work: Rect; displays: readonly Rect[]; saved?: unknown }): Rect {
    const s = (o.saved && typeof o.saved === "object" ? o.saved : {}) as Record<string, unknown>;
    if (num(s.x) && num(s.y) && num(s.width) && num(s.height)) {
        const saved = { x: Math.round(s.x), y: Math.round(s.y), width: Math.round(s.width), height: Math.round(s.height) };
        const grip = { x: saved.x, y: saved.y, width: saved.width, height: GRIP.height };
        const on = o.displays.find((d) => overlap(grip, d).width >= Math.min(GRIP.width, saved.width) && overlap(grip, d).height >= GRIP.height);
        if (on) {
            const width = clamp(saved.width, Math.min(DEVTOOLS_MIN.width, on.width), on.width);
            const height = clamp(saved.height, Math.min(DEVTOOLS_MIN.height, on.height), on.height);
            return { x: clamp(saved.x, on.x, right(on) - width), y: clamp(saved.y, on.y, bottom(on) - height), width, height };
        }
    }
    const { app, work } = o;
    const height = clamp(Math.min(app.height, work.height), Math.min(DEVTOOLS_MIN.height, work.height), work.height);
    const y = clamp(app.y, work.y, bottom(work) - height);
    const roomRight = right(work) - right(app);
    const roomLeft = app.x - work.x;
    // Beside the window: right first (the side the pane is on), else left.
    if (roomRight >= DEVTOOLS_MIN.width) return { x: right(app), y, width: Math.min(DEVTOOLS_SIZE.width, roomRight), height };
    if (roomLeft >= DEVTOOLS_MIN.width) {
        const width = Math.min(DEVTOOLS_SIZE.width, roomLeft);
        return { x: app.x - width, y, width, height };
    }
    // Over the window, on the side away from the pane (by default the panel's side, the right).
    const pane = o.pane ?? { x: app.x + app.width * 0.66, y: app.y, width: app.width * 0.34, height: app.height };
    const width = Math.min(DEVTOOLS_SIZE.width, work.width);
    const paneOnRight = pane.x + pane.width / 2 >= app.x + app.width / 2;
    if (paneOnRight && pane.x - work.x >= DEVTOOLS_MIN.width) {
        const w = Math.min(width, Math.round(pane.x) - work.x);
        return { x: Math.round(pane.x) - w, y, width: w, height };
    }
    if (!paneOnRight && right(work) - right(pane) >= DEVTOOLS_MIN.width) {
        return { x: Math.round(right(pane)), y, width: Math.min(width, right(work) - Math.round(right(pane))), height };
    }
    // No room anywhere: as far from the pane as the display allows.
    return { x: paneOnRight ? work.x : right(work) - width, y, width, height };
}

/** The window's title: the page's, as the person knows it. */
export function devToolsTitle(pageTitle: string): string {
    const t = pageTitle.trim();
    return t ? `DevTools: ${t}` : "DevTools";
}
