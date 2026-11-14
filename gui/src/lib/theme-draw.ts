// A theme's scene drawn to a canvas, at rest: for measuring how much veil it needs (ThemeBackdrop) and for the picture
// an agent gets of what it made (theme-picture.ts).

import type { Layer } from "../../../src/themes/format";
import { STAGE } from "../../../src/themes/format";
import { restPose } from "./theme-motion";

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

/** Draws the layers `keep` lets through at rest, the stage scaled by 1/k, over what's on the canvas. */
export function drawLayers(ctx: CanvasRenderingContext2D, layers: Layer[], images: (HTMLImageElement | undefined)[], k: number, keep: (l: Layer) => boolean = () => true) {
    layers.forEach((layer, i) => {
        const img = images[i];
        if (!img || !keep(layer)) return;
        const box = boxOf(layer);
        const pose = restPose(layer);
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
