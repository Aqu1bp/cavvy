// A theme's scene drawn to a canvas, in any pose of its motion: for measuring how much veil it needs (ThemeBackdrop)
// and for the picture an agent gets of what it made (theme-picture.ts).

import type { Layer, Motion } from "../../../src/themes/format";
import { STAGE } from "../../../src/themes/format";
import { poseAt, restPose, type Pose } from "./theme-pose";

export const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export const boxOf = (l: Layer) => ({ x: l.x ?? 0, y: l.y ?? 0, width: l.width ?? STAGE.width, height: l.height ?? STAGE.height });

/** Each layer's picture, decoded; undefined for one that couldn't be, by index in `failed`. */
export async function loadLayers(layers: Layer[]): Promise<{ images: (HTMLImageElement | undefined)[]; failed: number[] }> {
    const failed: number[] = [];
    const images = await Promise.all(
        layers.map(async (layer, i) => {
            const img = new Image();
            img.src = svgUrl(layer.svg);
            try {
                await img.decode();
                return img;
            } catch {
                failed.push(i);
                return undefined;
            }
        }),
    );
    return { images, failed: failed.sort((a, b) => a - b) };
}

/**
 * A layer's whole cycle: one pass, or there and back for one that alternates. `u` (0–1) of the way through it, where
 * its motion is, its delay counted (as the window runs it, from its start).
 */
function passAt(m: Motion, u: number): number {
    const cycle = m.loop === "repeat" ? m.duration : 2 * m.duration;
    const pos = (((u - (m.delay ?? 0) / cycle) % 1) + 1) % 1;
    if (m.loop === "repeat") return pos;
    const p = 2 * pos;
    return p <= 1 ? p : 2 - p;
}

/** Each layer `u` (0–1) of the way through its own cycle (passAt); at rest without motion. */
export const poseAtPhase = (u: number) => (l: Layer): Pose => (l.motion ? poseAt(l.motion, passAt(l.motion, u)) : restPose(l));

/** How far a layer travels in one cycle, in stage units: its moves, and its turns and growth at its edge. */
function travel(l: Layer): number {
    const m = l.motion!;
    const box = boxOf(l);
    const edge = Math.max(box.width, box.height) / 2;
    let len = 0;
    let last = poseAt(m, 0);
    for (let i = 1; i <= 200; i++) {
        const p = poseAt(m, i / 200);
        len += Math.abs(p.x - last.x) + Math.abs(p.y - last.y) + (Math.abs(p.rotate - last.rotate) * Math.PI * edge) / 180 + Math.abs(p.scale - last.scale) * edge;
        last = p;
    }
    return m.loop === "repeat" ? len : 2 * len;
}

/** A pose in the measure for each this many stage units a layer travels: under the veil map's cell (100). */
const STRIDE = 80;

/**
 * Where to look at a scene to see all it shows (ThemeBackdrop), as points of each layer's cycle (poseAtPhase):
 * often enough that nothing moves further than STRIDE between two, and at each layer's keyframes (a twinkle's peak).
 * Layers that share a duration are posed as they run together; ones that don't drift apart as the window runs, so
 * where they overlap is seen in some of the ways it can be, not all. One when nothing moves.
 */
export function phases(layers: Layer[]): number[] {
    const moving = layers.filter((l) => l.motion);
    if (!moving.length) return [0];
    const n = Math.min(96, Math.max(8, ...moving.map((l) => Math.ceil(travel(l) / STRIDE))));
    const at = Array.from({ length: n }, (_, i) => i / n);
    for (const l of moving) {
        const m = l.motion!;
        const cycle = m.loop === "repeat" ? m.duration : 2 * m.duration;
        const share = m.loop === "repeat" ? 1 : 0.5;
        m.keyframes.forEach((f, i, all) => at.push((((f.at ?? i / (all.length - 1)) * share + (m.delay ?? 0) / cycle) % 1 + 1) % 1));
    }
    at.sort((a, b) => a - b);
    const out: number[] = [];
    for (const t of at) if (!out.length || t - out[out.length - 1]! > 0.002) out.push(t);
    // Sixty layers of sixteen keyframes: past MOST, an even pick (each pose costs a draw and a read of the canvas).
    return out.length <= MOST ? out : Array.from({ length: MOST }, (_, i) => out[Math.round((i * (out.length - 1)) / (MOST - 1))]!);
}

const MOST = 320;

/** Draws the layers `keep` lets through, each in the pose `poseOf` gives (at rest by default), the stage scaled by 1/k, over what's on the canvas. */
export function drawLayers(ctx: CanvasRenderingContext2D, layers: Layer[], images: (HTMLImageElement | undefined)[], k: number, keep: (l: Layer) => boolean = () => true, poseOf: (l: Layer) => Pose = restPose) {
    layers.forEach((layer, i) => {
        const img = images[i];
        if (!img || !keep(layer)) return;
        const box = boxOf(layer);
        const pose = poseOf(layer);
        const [ox, oy] = layer.origin ?? [0.5, 0.5];
        ctx.save();
        ctx.globalAlpha = (layer.opacity ?? 1) * pose.opacity;
        ctx.translate((box.x + pose.x + box.width * ox) / k, (box.y + pose.y + box.height * oy) / k);
        ctx.rotate((pose.rotate * Math.PI) / 180);
        ctx.scale(pose.scale, pose.scale);
        ctx.drawImage(img, (-box.width * ox) / k, (-box.height * oy) / k, box.width / k, box.height / k);
        ctx.restore();
    });
}
