// A theme's scene drawn to a canvas, in any pose of its motion: for measuring how much veil it needs (ThemeBackdrop)
// and for the picture an agent gets of what it made (theme-picture.ts).

import type { Layer } from "../../../src/themes/format";
import { STAGE } from "../../../src/themes/format";
import { poseAt, restPose, type Pose } from "./theme-motion";

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

/** Each layer `t` (0–1) of the way through its own motion; at rest without one. */
export const poseAtPhase = (t: number) => (l: Layer): Pose => (l.motion ? poseAt(l.motion, t) : restPose(l));

/**
 * Where in their motion to look at a scene to see all it shows: evenly through the loop, and at each keyframe (a
 * twinkle's peak, a drop half way down). At most `most`; one when nothing moves.
 */
export function phases(layers: Layer[], most = 16): number[] {
    if (!layers.some((l) => l.motion)) return [0];
    const at = new Set<number>();
    for (let j = 0; j < 8; j++) at.add(j / 8);
    for (const l of layers) l.motion?.keyframes.forEach((f, i, all) => at.add(Math.round((f.at ?? i / (all.length - 1)) * 100) / 100));
    const all = [...at].sort((a, b) => a - b);
    return all.length <= most ? all : Array.from({ length: most }, (_, i) => all[Math.round((i * (all.length - 1)) / (most - 1))]!);
}

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
