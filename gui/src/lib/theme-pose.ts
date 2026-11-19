// Where a theme layer is at a moment of its motion: what's drawn on a canvas (lib/theme-draw.ts) and what the
// compositor runs (lib/theme-motion.ts). No clock of its own, so drawing a scene doesn't bring the window's in.

import type { Keyframe, Layer, Motion } from "../../../src/themes/format";

export interface Pose {
    x: number;
    y: number;
    rotate: number;
    scale: number;
    opacity: number;
}

const REST: Pose = { x: 0, y: 0, rotate: 0, scale: 1, opacity: 1 };

/** The keyframes' places in the loop, 0–1: their own, or spread evenly. */
export function times(frames: Keyframe[]): number[] {
    return frames.map((f, i) => f.at ?? i / (frames.length - 1));
}

export const poseOf = (f: Keyframe): Pose => ({ x: f.x ?? 0, y: f.y ?? 0, rotate: f.rotate ?? 0, scale: f.scale ?? 1, opacity: f.opacity ?? 1 });

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

export const r = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

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

