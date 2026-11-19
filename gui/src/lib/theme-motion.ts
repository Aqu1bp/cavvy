// A theme layer's keyframes as a CSS animation the compositor runs by itself: transform and opacity only, in steps.
// Each layer steps only as often as it must for its steps not to show (frameFor): 60 a second for rain, a few for a
// cloud's drift, all on a grid of 60 a second and each started on a multiple of its own step, so the window is drawn
// again only when some layer changes. It runs while --scene-play says (theme-backdrop.css: Cavvy's window seen and
// focused, and someone at it). The easing is worked into the keyframes: steps() takes no curve of its own, so the path
// is sampled along the curve and each stretch between samples is walked in steps.

import type { Layer, Motion } from "../../../src/themes/format";
import { STEP_MS } from "./stream-clock";
import { poseAt, poseOf, r, times, transformOf, type Pose } from "./theme-pose";

export { poseAt, restPose, transformOf, type Pose } from "./theme-pose";

/** A frame of a layer that must move as smoothly as the window can show it: 60 a second, three to each of its steps. */
export const SMOOTH_MS = STEP_MS / 3;
/** 30 a second. */
const HALF_MS = SMOOTH_MS * 2;
/** What a layer may step at, slowest first (5, 10, 20, 30, 60 a second): each a whole number of SMOOTH_MS. */
export const FRAMES = [200, 100, STEP_MS, HALF_MS, SMOOTH_MS];

/** A step doesn't show on a layer that moves less than this in it, in device pixels, or fades less than FADES_IN_A_STEP. */
const PX_IN_A_STEP = 1;
const FADES_IN_A_STEP = 0.01;

/**
 * How fast a layer goes at its fastest: device pixels a second at `px` device pixels to a stage unit, and opacity a
 * second. Its fastest stretch decides: the ease is half as fast again as an even move at its middle. A turn or a
 * growth counts as far as the layer's edge moves.
 */
export function speedOf(layer: Layer, px: number): { moves: number; fades: number } {
    const m = layer.motion;
    if (!m || m.duration <= 0) return { moves: 0, fades: 0 };
    const at = times(m.keyframes);
    const frames = m.keyframes.map(poseOf);
    const edge = Math.max(layer.width ?? 1600, layer.height ?? 1000) / 2;
    const peak = m.easing === "linear" ? 1 : 1.5;
    let moves = 0;
    let fades = 0;
    for (let i = 1; i < frames.length; i++) {
        const span = (at[i]! - at[i - 1]!) * m.duration;
        if (span <= 0) continue;
        const a = frames[i - 1]!;
        const b = frames[i]!;
        const far = Math.hypot(b.x - a.x, b.y - a.y) + (Math.abs(b.rotate - a.rotate) * Math.PI * edge) / 180 + Math.abs(b.scale - a.scale) * edge;
        moves = Math.max(moves, ((far * px) / span) * peak);
        fades = Math.max(fades, ((Math.abs(b.opacity - a.opacity) * (layer.opacity ?? 1)) / span) * peak);
    }
    return { moves, fades };
}

/**
 * How often a layer's animation changes, in ms: the slowest of FRAMES at which no step shows, at `px` device pixels to a
 * stage unit. A layer drawn coarser than the screen (`grain` device pixels to each of its own, ThemeBackdrop's soft
 * layers) may step one of its own pixels: it has no edge finer than that for a step to show on.
 */
export function frameFor(layer: Layer, px: number, grain = 1): number {
    const { moves, fades } = speedOf(layer, px);
    const most = PX_IN_A_STEP * Math.max(1, grain);
    return FRAMES.find((f) => (moves * f) / 1000 <= most && (fades * f) / 1000 <= FADES_IN_A_STEP) ?? SMOOTH_MS;
}

/**
 * Each of a scene's layers' frames. With one at 30 a second, those at 20 go to 30: their steps don't fall together, so
 * 30 and 20 would have the window drawn 40 times a second.
 */
export function sceneFrames(layers: readonly Layer[], px: number, grains: readonly number[] = []): number[] {
    const frames = layers.map((l, i) => frameFor(l, px, grains[i]));
    return frames.includes(HALF_MS) ? frames.map((f) => (f === STEP_MS ? HALF_MS : f)) : frames;
}

/**
 * What a layer stepping every `frame` ms starts on, and its stretches and delay are whole numbers of: a multiple of the
 * frame in whole ms, and of the window's own steps where the frame is shorter than one.
 */
export function gridOf(frame: number): number {
    return frame === HALF_MS ? 100 : Math.max(frame, STEP_MS);
}

/** The device pixels to a stage unit of a scene that covers a window as large as the screen it's on: the most it shows. */
export function screenPx(): number {
    return Math.max(screen.width / 1600, screen.height / 1000) * devicePixelRatio;
}

export interface LayerAnimation {
    /** The @keyframes rule. */
    keyframes: string;
    /** The animation shorthand for the layer. */
    animation: string;
    /** One pass, in ms, as run: a whole number of steps. */
    durationMs: number;
}

/**
 * Where in the pass each of a motion's `stretches` + 1 stops is sampled: at its own place, or at the keyframe nearest
 * it that differs from it most (the first and last stops keep their own). A keyframe between two stops (a flash that peaks and is gone within a
 * stretch) is then shown, up to half a stretch early or late, instead of never.
 */
function sampledAt(m: Motion, stretches: number): number[] {
    const at = Array.from({ length: stretches + 1 }, (_, i) => i / stretches);
    const apart = (a: Pose, b: Pose) => Math.max(Math.abs(a.opacity - b.opacity), Math.abs(a.x - b.x) / 100, Math.abs(a.y - b.y) / 100, Math.abs(a.rotate - b.rotate) / 90, Math.abs(a.scale - b.scale));
    const most = new Map<number, number>();
    for (const k of times(m.keyframes)) {
        // The first and last stops stay where the motion starts and ends (shown through a delay, and joined by a repeat).
        const i = Math.min(stretches - 1, Math.max(1, Math.round(k * stretches)));
        if (Math.abs(k - i / stretches) < 1e-9) continue;
        const d = apart(poseAt(m, k), poseAt(m, i / stretches));
        if (d > (most.get(i) ?? 0)) {
            most.set(i, d);
            at[i] = k;
        }
    }
    return at;
}

/**
 * The animation for a layer's motion, under `name`. One pass is cut into stretches a whole number of steps long, about
 * a quarter second each (the curve's sampled at their ends), and each stretch is walked in steps of `frame` (frameFor).
 */
export function layerAnimation(m: Motion, name: string, baseOpacity = 1, frame = STEP_MS): LayerAnimation {
    const grid = gridOf(frame);
    const wanted = Math.max(m.duration * 1000, grid * 2);
    const stretches = Math.max(2, Math.min(240, Math.round(wanted / 250)));
    const stretch = Math.max(grid, Math.round(wanted / stretches / grid) * grid);
    const durationMs = stretch * stretches;
    const fades = m.keyframes.some((f) => f.opacity !== undefined) || baseOpacity !== 1;
    const at = sampledAt(m, stretches);
    const lines: string[] = [];
    for (let i = 0; i <= stretches; i++) {
        const p = poseAt(m, at[i]!);
        const pct = r((i / stretches) * 100, 4);
        lines.push(`${pct}%{transform:${transformOf(p)}${fades ? `;opacity:${r(p.opacity * baseOpacity, 3)}` : ""}}`);
    }
    const delay = Math.round(((m.delay ?? 0) * 1000) / grid) * grid;
    return {
        keyframes: `@keyframes ${name}{${lines.join("")}}`,
        animation: `${name} ${durationMs}ms steps(${Math.round(stretch / frame)}) ${delay}ms infinite ${m.loop === "repeat" ? "normal" : "alternate"} both var(--scene-play)`,
        durationMs,
    };
}

/** The grid an animation's layer steps on: its data-grid (ThemeBackdrop.tsx), or the window's steps. */
const gridOn = (a: Animation) => Number(((a.effect as KeyframeEffect | null)?.target as HTMLElement | null)?.dataset.grid) || STEP_MS;

/** Started on its own grid: a layer stepping 10 a second, started on a multiple of 100 ms, changes when others do. */
export function alignOnStart(root: HTMLElement): () => void {
    const align = (e: AnimationEvent) => {
        for (const a of (e.target as Element).getAnimations()) {
            // One paused (Cavvy can't be seen, nobody's there) is put on the grid when it runs (carryOn): a start time
            // set now would run it.
            if (a.playState !== "running" || (a as CSSAnimation).animationName !== e.animationName) continue;
            const g = gridOn(a);
            const at = a.startTime ?? document.timeline.currentTime;
            if (typeof at === "number") a.startTime = Math.floor(at / g) * g;
        }
    };
    root.addEventListener("animationstart", align);
    return () => root.removeEventListener("animationstart", align);
}

/**
 * Layers running again (Cavvy seen or focused again, someone back at the window) carry on from where they stopped, on
 * their grid: what each shows moves at most a step. Not from their start: a whole scene would jump.
 */
export function carryOn(anims: Animation[]) {
    const now = document.timeline.currentTime;
    if (typeof now !== "number") return;
    for (const a of anims) {
        const t = a.currentTime;
        if (a.playState !== "running" || typeof t !== "number") continue;
        const g = gridOn(a);
        a.startTime = Math.ceil(now / g) * g - Math.floor(t / g) * g;
    }
}
