// The Simulator pane's arithmetic: where the device's screen is drawn in the pane, where a pointer lands on it, and
// what the pane says the device is doing. Pure: the component (SimulatorPane.tsx) feeds them sizes and states.

import type { SimulatorDevice, SimulatorInputKind, SimulatorState } from "@shared/protocol";

export interface Size {
    width: number;
    height: number;
}

export interface Rect extends Size {
    x: number;
    y: number;
}

/**
 * A two-finger swipe on the pane, which the device sees as a finger: how large its turns have been (CSS pixels), and
 * whether the finger has lifted with the turns still coming (`coasting`).
 */
export interface WheelSwipe {
    peak: number;
    last: number;
    falls: number;
    coasting: boolean;
}

/** Turns getting smaller with none getting larger, and how far below the swipe's largest, that say the fingers have left the trackpad. */
const WHEEL_FALLS = 5;
const WHEEL_SLOWED_TO = 0.6;

export function wheelStart(size: number): WheelSwipe {
    return { peak: size, last: size, falls: 0, coasting: false };
}

/**
 * The swipe after a turn. Browsers don't say when the fingers leave the trackpad, and macOS keeps turning for seconds
 * after: the finger lifts at the screen's edge, where it can go no further, or as the turns die down. It's still moving
 * then, so the device sees a flick: a page turns, a list carries on. The turns left over move nothing.
 */
export function wheelTurn(s: WheelSwipe, size: number, atEdge: boolean): WheelSwipe {
    if (s.coasting) return { ...s, last: size };
    const falls = size > s.last ? 0 : size < s.last ? s.falls + 1 : s.falls;
    const peak = Math.max(s.peak, size);
    return { peak, last: size, falls, coasting: atEdge || (falls >= WHEEL_FALLS && size < peak * WHEEL_SLOWED_TO) };
}

/**
 * A mouse wheel's notch is one large turn on its own, and a finger that far at once is a fling (the device sends a list
 * dozens of rows away). The finger goes there at this pace, in screens a second, where a list moves as far as it does.
 */
const WHEEL_PACE = 0.55;
/** A turn this long after the last is on its own; closer, the turns are a series, a trackpad's, which come as they are. */
export const WHEEL_SERIES_MS = 20;
/** A turn moving the finger this far (a share of the screen) goes at the pace when it's on its own. */
export const WHEEL_JUMP = 0.03;

/** Where a finger going to `to` at the pace is after `ms`, at most there. */
export function wheelPaced(from: { x: number; y: number }, to: { x: number; y: number }, ms: number): { x: number; y: number } {
    const left = Math.hypot(to.x - from.x, to.y - from.y);
    const step = (WHEEL_PACE * ms) / 1000;
    if (left <= step) return { x: to.x, y: to.y };
    return { x: from.x + ((to.x - from.x) * step) / left, y: from.y + ((to.y - from.y) * step) / left };
}

/** A turn much larger than the one before while coasting: the fingers are back, and this is a new swipe. */
export function wheelSwipesAgain(s: WheelSwipe, size: number): boolean {
    return s.coasting && size > s.last * 1.5 && size > s.last + 4;
}

/** Room around the screen in the pane, in CSS pixels. */
export const SCREEN_MARGIN = 24;

/**
 * Where the screen goes in a pane of `box`: as large as fits with a margin around it, centered, never larger than
 * the device's own size in points (a point is a CSS pixel there), so a small device isn't blown up.
 */
export function placeScreen(box: Size, screen: Size, scale: number): Rect {
    const roomW = Math.max(0, box.width - 2 * SCREEN_MARGIN);
    const roomH = Math.max(0, box.height - 2 * SCREEN_MARGIN);
    if (screen.width <= 0 || screen.height <= 0) return { x: 0, y: 0, width: 0, height: 0 };
    const k = Math.min(roomW / screen.width, roomH / screen.height, 1 / Math.max(scale, 0.01));
    const width = Math.floor(screen.width * k);
    const height = Math.floor(screen.height * k);
    return { x: Math.round((box.width - width) / 2), y: Math.round((box.height - height) / 2), width, height };
}

/** A pointer at `p` (CSS pixels in the pane) as a fraction of the screen; undefined off the screen unless `clamp`. */
export function screenFraction(p: { x: number; y: number }, at: Rect, clamp = false): { x: number; y: number } | undefined {
    if (at.width <= 0 || at.height <= 0) return undefined;
    let x = (p.x - at.x) / at.width;
    let y = (p.y - at.y) / at.height;
    if (clamp) {
        x = Math.min(Math.max(x, 0), 1);
        y = Math.min(Math.max(y, 0), 1);
    } else if (x < 0 || y < 0 || x > 1 || y > 1) return undefined;
    return { x, y };
}

/** How round the screen's corners are drawn, as the device's are: iPhones' more than iPads'. */
export function cornerRadius(kind: SimulatorDevice["kind"] | undefined, width: number): number {
    return Math.round(width * (kind === "ipad" ? 0.03 : 0.12));
}

/** What the pane shows in place of the screen, by the session's simulator state; undefined when the screen shows. */
export function paneNote(state: SimulatorState | undefined): { title: string; detail?: string; busy?: boolean; start?: boolean; retry?: boolean } | undefined {
    if (!state) return { title: "", busy: true };
    const d = state.device;
    switch (state.status) {
        case "unavailable":
            return { title: "No simulators here", detail: state.error };
        case "off":
            if (!d) return { title: "No simulators", detail: "Add one in Xcode." };
            if (d.state === "shutting_down") return { title: `Shutting down ${d.name}…`, busy: true };
            return { title: `${d.name} is off`, start: true };
        case "booting":
            return { title: `Starting ${d?.name ?? "the simulator"}…`, busy: true };
        case "error":
            return { title: `Can't show ${d?.name ?? "the simulator"}`, detail: state.error, retry: true };
        case "ready":
            return undefined;
    }
}

/**
 * What the pane says when another tool has taken some of the device's input (all of it is its input), or has taken
 * over and what it took can't be read.
 */
export function takenNote(cut: SimulatorInputKind[] | undefined, uncertain?: boolean): string | undefined {
    if (!cut?.length) return uncertain ? "Another app may have this device's input" : undefined;
    const names = { touch: "touch screen", keyboard: "keyboard", buttons: "buttons" };
    const what = cut.length >= 3 ? "input" : cut.map((k) => names[k]).join(" and ");
    return `Another app took this device's ${what}`;
}

/** The device menu's line for a device: "iPhone 17", with "iOS 27.0" and whether it runs under it. */
export function deviceDetail(d: SimulatorDevice): string {
    const state = d.state === "booted" ? "Running" : d.state === "booting" ? "Starting" : d.state === "shutting_down" ? "Shutting down" : undefined;
    return state ? `${d.runtime} · ${state}` : d.runtime;
}

/** The agent did something on the device within this long: the pane says it's using it. */
export const AGENT_ACTIVE_MS = 8000;
