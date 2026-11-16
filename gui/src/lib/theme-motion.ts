// A theme layer's keyframes as a CSS animation the compositor runs by itself: transform and opacity only, in steps
// on the window's 50 ms grid (STEP_MS), like everything else that animates for good (test/perf-rules.test.ts). A layer
// whose steps would show (frameFor) steps three times as often, 60 a second, still on the grid. It runs while
// --scene-play says (theme-backdrop.css: Cavvy's window seen and focused, and someone at it). The easing is worked
// into the keyframes: steps() takes no curve of its own, so the path is sampled along the curve and each stretch
// between samples is walked in steps.

import type { Keyframe, Layer, Motion } from "../../../src/themes/format";
import { STEP_MS } from "./stream-clock";

export interface Pose {
    x: number;
    y: number;
    rotate: number;
    scale: number;
    opacity: number;
}

const REST: Pose = { x: 0, y: 0, rotate: 0, scale: 1, opacity: 1 };

/** The keyframes' places in the loop, 0–1: their own, or spread evenly. */
function times(frames: Keyframe[]): number[] {
    return frames.map((f, i) => f.at ?? i / (frames.length - 1));
}

const poseOf = (f: Keyframe): Pose => ({ x: f.x ?? 0, y: f.y ?? 0, rotate: f.rotate ?? 0, scale: f.scale ?? 1, opacity: f.opacity ?? 1 });

/** Slow into and out of each keyframe. */
const ease = (t: number) => t * t * (3 - 2 * t);

/** Where the layer is at `t` (0–1) of one pass. */
export function poseAt(m: Motion, t: number): Pose {
    const at = times(m.keyframes);
    const frames = m.keyframes.map(poseOf);
    if (t <= at[0]!) return frames[0]!;
    for (let i = 1; i < frames.length; i++) {
        if (t <= at[i]!) {
            const span = at[i]! - at[i - 1]!;
            const k = span > 0 ? (t - at[i - 1]!) / span : 1;
            const e = m.easing === "linear" ? k : ease(k);
            const a = frames[i - 1]!;
            const b = frames[i]!;
            const lerp = (p: number, q: number) => p + (q - p) * e;
            return { x: lerp(a.x, b.x), y: lerp(a.y, b.y), rotate: lerp(a.rotate, b.rotate), scale: lerp(a.scale, b.scale), opacity: lerp(a.opacity, b.opacity) };
        }
    }
    return frames[frames.length - 1]!;
}

const r = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

export function transformOf(p: Pose): string {
    const parts = [`translate(${r(p.x)}px, ${r(p.y)}px)`];
    if (p.rotate) parts.push(`rotate(${r(p.rotate)}deg)`);
    if (p.scale !== 1) parts.push(`scale(${r(p.scale, 4)})`);
    return parts.join(" ");
}

/** The pose a layer rests in when nothing moves (reduced motion, Animate off): its first keyframe. */
export function restPose(layer: Layer): Pose {
    return layer.motion ? poseAt(layer.motion, 0) : REST;
}

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
