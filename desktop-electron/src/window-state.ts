// Where the window was, kept between launches (as the Tauri shell's window-state plugin kept it): its size and place,
// and whether it was maximized or full screen. A place no display shows any more (a screen unplugged) isn't used: the
// window opens at its size, centred. No Electron here, so it's tested on its own (test/electron-window-state.test.ts).

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface WindowState {
    /** Undefined: centred. */
    x?: number;
    y?: number;
    width: number;
    height: number;
    maximized?: boolean;
    fullscreen?: boolean;
}

export const DEFAULT_SIZE = { width: 1360, height: 880 };
export const MIN_SIZE = { width: 720, height: 480 };
/** How much of the window's top strip (where it's dragged from) a display must show for the place to be kept. */
const GRIP = { width: 120, height: 30 };

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A saved state as this window can open with on these displays' work areas; the default size, centred, for anything else. */
export function restorable(saved: unknown, displays: readonly Rect[]): WindowState {
    const s = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>;
    // No bigger than the largest display, no smaller than the window allows.
    const maxW = Math.max(MIN_SIZE.width, ...displays.map((d) => d.width));
    const maxH = Math.max(MIN_SIZE.height, ...displays.map((d) => d.height));
    const width = num(s.width) ? Math.round(Math.min(maxW, Math.max(MIN_SIZE.width, s.width))) : DEFAULT_SIZE.width;
    const height = num(s.height) ? Math.round(Math.min(maxH, Math.max(MIN_SIZE.height, s.height))) : DEFAULT_SIZE.height;
    const state: WindowState = { width, height, ...(s.maximized === true ? { maximized: true } : {}), ...(s.fullscreen === true ? { fullscreen: true } : {}) };
    if (!num(s.x) || !num(s.y)) return state;
    const x = Math.round(s.x);
    const y = Math.round(s.y);
    const grip: Rect = { x, y, width, height: GRIP.height };
    const seen = displays.some((d) => overlap(grip, d).width >= Math.min(GRIP.width, width) && overlap(grip, d).height >= GRIP.height);
    return seen ? { ...state, x, y } : state;
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
    return {
        width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
        height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
    };
}
