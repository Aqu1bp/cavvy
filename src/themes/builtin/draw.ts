// Small helpers the built-in scenes are drawn with. Each scene is code that writes a theme in the same JSON shape an
// agent writes (format.ts), and goes through the same check (test/themes.test.ts).

import type { Keyframe, Layer, Motion } from "../format";

/** An SVG document of `w` × `h`, drawn to fill its layer's box. */
export function svg(w: number, h: number, body: string, defs = ""): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>`;
}

/** A picture of the part `x`, `y`, `w` × `h` of the stage, drawn in the stage's own coordinates: a layer only as big as what's in it. */
export function svgPart(x: number, y: number, w: number, h: number, body: string, defs = ""): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>`;
}

/** A radial gradient from `color` at `peak` opacity in the middle to nothing at its edge. */
export function glow(id: string, color: string, peak = 1, mid = 0.35): string {
    return `<radialGradient id="${id}"><stop offset="0" stop-color="${color}" stop-opacity="${peak}"/><stop offset="${mid}" stop-color="${color}" stop-opacity="${peak * 0.45}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`;
}

/** A vertical gradient through `stops` ([offset, colour]). */
export function vertical(id: string, stops: [number, string][]): string {
    return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("")}</linearGradient>`;
}

/** The same numbers every time: a scene looks the same on every machine and every start. */
export function seeded(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

/** A full-stage layer that doesn't move. */
export const still = (art: string, extra: Partial<Layer> = {}): Layer => ({ svg: art, x: 0, y: 0, width: 1600, height: 1000, ...extra });

export function moving(art: string, box: { x: number; y: number; width: number; height: number }, motion: Motion, extra: Partial<Layer> = {}): Layer {
    return { svg: art, ...box, motion, ...extra };
}

export const frames = (...k: Keyframe[]) => k;

/** A blur filter to wrap soft shapes in: drawn at the layer's own size and scaled, which only soft things can afford. */
export const blurDef = (id: string, sd: number) => `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${sd}"/></filter>`;

/** Pick one of `items` with `rand`. */
export const pick = <T>(rand: () => number, items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
