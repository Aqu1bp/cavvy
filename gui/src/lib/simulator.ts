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
