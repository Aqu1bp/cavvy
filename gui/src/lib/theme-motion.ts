// A theme layer's keyframes as a CSS animation the compositor runs by itself: transform and opacity only, in steps
// on the window's 50 ms grid (STEP_MS), like everything else that animates for good (test/perf-rules.test.ts). A layer
// whose steps would show (frameFor) steps three times as often, 60 a second, still on the grid. It runs while
// --scene-play says (theme-backdrop.css: Cavvy's window seen and focused, and someone at it). The easing is worked
// into the keyframes: steps() takes no curve of its own, so the path is sampled along the curve and each stretch
// between samples is walked in steps.

import type { Layer, Motion } from "../../../src/themes/format";
import { STEP_MS } from "./stream-clock";
import { poseAt, poseOf, r, times, transformOf } from "./theme-pose";

export { poseAt, restPose, transformOf, type Pose } from "./theme-pose";

/** A step of 50 ms shows on a layer that moves further than this in one, in stage units, or fades more than FADES_IN_A_STEP. */
const MOVES_IN_A_STEP = 0.5;
const FADES_IN_A_STEP = 0.01;
/** A frame of a layer whose steps would show: 60 a second, three to each of the window's steps. */
export const SMOOTH_MS = STEP_MS / 3;

/**
 * How often a layer's animation changes, in ms: on the window's step, or SMOOTH_MS for one that moves far enough in a
 * step to show it (a seed blowing across, rain). Its fastest stretch decides: the ease is half as fast again as an
 * even move at its middle. A turn or a growth counts as far as the layer's edge moves.
 */
export function frameFor(layer: Layer): number {
    const m = layer.motion;
    if (!m || m.duration <= 0) return STEP_MS;
    const at = times(m.keyframes);
    const frames = m.keyframes.map(poseOf);
    const edge = Math.max(layer.width ?? 1600, layer.height ?? 1000) / 2;
    const peak = m.easing === "linear" ? 1 : 1.5;
    let moves = 0;
    let fades = 0;
    for (let i = 1; i < frames.length; i++) {
        const span = (at[i]! - at[i - 1]!) * m.duration * 1000;
        if (span <= 0) continue;
        const a = frames[i - 1]!;
        const b = frames[i]!;
        const far = Math.hypot(b.x - a.x, b.y - a.y) + (Math.abs(b.rotate - a.rotate) * Math.PI * edge) / 180 + Math.abs(b.scale - a.scale) * edge;
        moves = Math.max(moves, (far / span) * peak * STEP_MS);
        fades = Math.max(fades, ((Math.abs(b.opacity - a.opacity) * (layer.opacity ?? 1)) / span) * peak * STEP_MS);
    }
    return moves > MOVES_IN_A_STEP || fades > FADES_IN_A_STEP ? SMOOTH_MS : STEP_MS;
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
 * The animation for a layer's motion, under `name`. One pass is cut into stretches a whole number of steps long, about
 * a quarter second each (the curve's sampled at their ends), and each stretch is walked in steps of `frame` (frameFor).
 */
export function layerAnimation(m: Motion, name: string, baseOpacity = 1, frame = STEP_MS): LayerAnimation {
    const wanted = Math.max(m.duration * 1000, STEP_MS * 2);
    const stretches = Math.max(2, Math.min(240, Math.round(wanted / 250)));
    const stretch = Math.max(STEP_MS, Math.round(wanted / stretches / STEP_MS) * STEP_MS);
    const durationMs = stretch * stretches;
    const fades = m.keyframes.some((f) => f.opacity !== undefined) || baseOpacity !== 1;
    const lines: string[] = [];
    for (let i = 0; i <= stretches; i++) {
        const p = poseAt(m, i / stretches);
        const pct = r((i / stretches) * 100, 4);
        lines.push(`${pct}%{transform:${transformOf(p)}${fades ? `;opacity:${r(p.opacity * baseOpacity, 3)}` : ""}}`);
    }
    const delay = Math.round(((m.delay ?? 0) * 1000) / STEP_MS) * STEP_MS;
    return {
        keyframes: `@keyframes ${name}{${lines.join("")}}`,
        animation: `${name} ${durationMs}ms steps(${Math.round(stretch / frame)}) ${delay}ms infinite ${m.loop === "repeat" ? "normal" : "alternate"} both var(--scene-play)`,
        durationMs,
    };
}

/**
 * Layers running again (Cavvy seen or focused again, someone back at the window) carry on from where they stopped, on
 * the grid: what each shows moves at most a step. Not from their start: a whole scene would jump.
 */
export function carryOn(anims: Animation[]) {
    const now = document.timeline.currentTime;
    if (typeof now !== "number") return;
    const at = Math.ceil(now / STEP_MS) * STEP_MS;
    for (const a of anims) {
        const t = a.currentTime;
        if (a.playState === "running" && typeof t === "number") a.startTime = at - Math.floor(t / STEP_MS) * STEP_MS;
    }
}
