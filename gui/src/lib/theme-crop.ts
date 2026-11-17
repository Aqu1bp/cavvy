// Each layer cut to where its picture draws, and drawn no finer than it has detail for. A layer's texture is as large
// as its box however much of it is empty (a full-stage layer with grass along the bottom would take a whole window's
// worth of GPU memory), and as fine as the screen however soft it is (a blurred glow the size of the window, the
// same). Both are found from its pixels: it's cut by its SVG's own viewBox, so it looks and moves the same, and a soft
// one is drawn once into a canvas as fine as it needs, which the compositor stretches as smoothly as it was.

import type { Layer } from "../../../src/themes/format";
import { boxOf } from "./theme-draw";

/** Part of a layer's box (stage units, from its corner), its SVG cut to show just that, and how fine it has detail for. */
export interface Crop {
    x: number;
    y: number;
    width: number;
    height: number;
    /** undefined: the SVG as it is, the part being all of it or its SVG not to be cut. */
    svg?: string;
    /** Pixels to a stage unit it needs drawn at for no pixel to be a level out once stretched (Infinity: all there is). */
    density: number;
}

/** Samples across a layer's longer side, looking for where it draws and how smooth it is. */
const SAMPLES = 512;
/** How far out a pixel may be, in 0–255 levels, once a coarser drawing is stretched. */
const LEVELS = 1;
/** The most a layer's drawing is stretched: further, a smooth gradient's levels could show as bands. */
const STRETCH = 4;
/** Each patch checked for a coarser drawing, in pixels as fine as it'd be drawn. */
const PATCH = 48;
/**
 * A patch drawn coarser and stretched may be out by this much at a pixel (a gradient's dither differs), and by this much
 * averaged over 3 × 3 (what would be lost: a streak, a grain).
 */
const PATCH_MOST = 8;
const PATCH_SMOOTH = 2.5;
/** Not cut for less than this much of its box saved. */
const WORTH = 0.2;

/** Where in its box the layer draws, a sample's margin round it, and how fine it needs drawing at most `full` pixels to a unit; undefined when it can't be read. */
export function cropOf(layer: Layer, img: HTMLImageElement, full: number): Crop | undefined {
    const box = boxOf(layer);
    const k = Math.max(box.width, box.height) / SAMPLES;
    const w = Math.max(1, Math.ceil(box.width / k));
    const h = Math.max(1, Math.ceil(box.height / k));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return undefined;
    let px: Uint8ClampedArray;
    try {
        ctx.drawImage(img, 0, 0, w, h);
        px = ctx.getImageData(0, 0, w, h).data;
    } catch {
        return undefined;
    }
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    // Premultiplied, as it's drawn: a colour under no alpha is no detail.
    const pm = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const a = px[i + 3]!;
            if (!a) continue;
            pm[i] = (px[i]! * a) / 255;
            pm[i + 1] = (px[i + 1]! * a) / 255;
            pm[i + 2] = (px[i + 2]! * a) / 255;
            pm[i + 3] = a;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
        }
    }
    if (x1 < 0) return undefined;
    // How far from straight it bends between samples: where it's straight, a coarser drawing stretched is the same.
    let bend = 0;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const i = (y * w + x) * 4;
            for (let c = 0; c < 4; c++) {
                const v = 2 * pm[i + c]!;
                if (x > 0 && x < w - 1) bend = Math.max(bend, Math.abs(pm[i - 4 + c]! - v + pm[i + 4 + c]!));
                if (y > 0 && y < h - 1) bend = Math.max(bend, Math.abs(pm[i - w * 4 + c]! - v + pm[i + w * 4 + c]!));
            }
        }
    }
    // Stretched from pixels `s` units apart, it's out by about bend·(s/k)²/8: no more than LEVELS. Its biggest pose
    // magnifies it. Never stretched more than STRETCH times.
    const grows = Math.max(1, ...(layer.motion?.keyframes.map((f) => f.scale ?? 1) ?? []));
    let density = Math.max(full / STRETCH, bend > 0 ? (grows / k) * Math.sqrt(bend / (8 * LEVELS)) : 0);
    // A sample's margin each side: a blur's faint edge falls between samples.
    const cx = Math.max(0, (x0 - 1) * k);
    const cy = Math.max(0, (y0 - 1) * k);
    const cw = Math.min(box.width, (x1 + 2) * k) - cx;
    const ch = Math.min(box.height, (y1 + 2) * k) - cy;
    const part = { x: cx, y: cy, width: cw, height: ch };
    // The samples can't see detail finer than they are (rain's streaks): drawn coarser and stretched back, it must look
    // the same where it has the most going on, or it's drawn finer, up to as fine as it'd be drawn anyway.
    if (density < full / 2) {
        const busiest = busy(pm, w, x0, y0, x1, y1).map(([sx, sy]) => [(sx + 0.5) * k, (sy + 0.5) * k] as [number, number]);
        while (density < full / 2 && !busiest.every((at) => holds(img, box, part, at, density, full))) density *= 2;
    }
    if (density >= full / 2) density = Infinity;
    if (cw * ch > (1 - WORTH) * box.width * box.height) return { x: 0, y: 0, width: box.width, height: box.height, density };
    const svg = cutSvg(layer.svg, box.width, box.height, part);
    return svg ? { ...part, svg, density } : { x: 0, y: 0, width: box.width, height: box.height, density };
}

/** The samples where the layer changes most from its neighbours, and its middle: where a coarser drawing would show first. */
function busy(pm: Float32Array, w: number, x0: number, y0: number, x1: number, y1: number): [number, number][] {
    const scored: [number, number, number][] = [];
    for (let y = y0 + 1; y < y1; y++) {
        for (let x = x0 + 1; x < x1; x++) {
            const i = (y * w + x) * 4;
            let d = 0;
            for (let c = 0; c < 4; c++) d += Math.abs(pm[i + 4 + c]! - pm[i - 4 + c]!) + Math.abs(pm[i + w * 4 + c]! - pm[i - w * 4 + c]!);
            if (d) scored.push([d, x, y]);
        }
    }
    scored.sort((a, b) => b[0] - a[0]);
    const out: [number, number][] = [[Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2)]];
    // Spread out: not all on one edge.
    for (const [, x, y] of scored) {
        if (out.length >= 4) break;
        if (out.every(([ox, oy]) => Math.abs(ox - x) + Math.abs(oy - y) > 8)) out.push([x, y]);
    }
    return out;
}

/** A canvas's pixels, premultiplied. */
function pixels(c: HTMLCanvasElement): Float32Array {
    const d = c.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
    const out = new Float32Array(d.length);
    for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3]!;
        out[i] = (d[i]! * a) / 255;
        out[i + 1] = (d[i + 1]! * a) / 255;
        out[i + 2] = (d[i + 2]! * a) / 255;
        out[i + 3] = a;
    }
    return out;
}

/**
 * Whether the layer drawn `density` pixels to a unit, on the grid its canvas would have, and stretched (bilinear, as
 * the compositor does) looks the same round `at` (units in its box) as drawn `full` pixels to a unit.
 */
function holds(img: HTMLImageElement, box: { width: number; height: number }, part: { x: number; y: number }, at: [number, number], density: number, full: number): boolean {
    const span = PATCH / full;
    // On the coarse drawing's grid, from the cut's corner.
    const ux = part.x + Math.floor((at[0] - span / 2 - part.x) * density) / density;
    const uy = part.y + Math.floor((at[1] - span / 2 - part.y) * density) / density;
    const canvas = (size: number) => {
        const c = document.createElement("canvas");
        c.width = c.height = size;
        return c;
    };
    const fine = canvas(PATCH);
    const coarse = canvas(Math.ceil(span * density) + 2);
    const back = canvas(PATCH);
    try {
        fine.getContext("2d")!.drawImage(img, -ux * full, -uy * full, box.width * full, box.height * full);
        coarse.getContext("2d")!.drawImage(img, -ux * density, -uy * density, box.width * density, box.height * density);
        const b = back.getContext("2d")!;
        b.imageSmoothingEnabled = true;
        b.imageSmoothingQuality = "low";
        b.drawImage(coarse, 0, 0, (coarse.width * full) / density, (coarse.height * full) / density);
        const f = pixels(fine);
        const s = pixels(back);
        const near = (p: Float32Array, x: number, y: number, c: number) => {
            let n = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += p[((y + dy) * PATCH + x + dx) * 4 + c]!;
            return n / 9;
        };
        for (let y = 1; y < PATCH - 1; y++) {
            for (let x = 1; x < PATCH - 1; x++) {
                for (let c = 0; c < 4; c++) {
                    const i = (y * PATCH + x) * 4 + c;
                    if (Math.abs(f[i]! - s[i]!) > PATCH_MOST || Math.abs(near(f, x, y, c) - near(s, x, y, c)) > PATCH_SMOOTH) return false;
                }
            }
        }
        return true;
    } catch {
        return false;
    }
}

const num = (s: string | undefined) => (s === undefined ? NaN : Number(s));

/**
 * The SVG shown in a `width` × `height` box, cut to `part` of it: its viewBox is that part, in its own units, mapped
 * the way its preserveAspectRatio maps it now, and stretched to fit (the cut keeps the box's scale). undefined for one
 * without a viewBox, which is drawn unscaled.
 */
export function cutSvg(svg: string, width: number, height: number, part: { x: number; y: number; width: number; height: number }): string | undefined {
    const at = svg.search(/<svg[\s>]/i);
    if (at < 0) return undefined;
    const end = svg.indexOf(">", at);
    if (end < 0) return undefined;
    const tag = svg.slice(at, end);
    const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*(["'])([^"']*)\\1`, "i").exec(tag)?.[2];
    const vb = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
    if (!vb || vb.length !== 4 || vb.some((n) => !Number.isFinite(n)) || vb[2]! <= 0 || vb[3]! <= 0) return undefined;
    const [vx, vy, vw, vh] = vb as [number, number, number, number];
    // Its own units to the box's: as its preserveAspectRatio says (by default, the middle, all of it showing).
    const par = (attr("preserveAspectRatio") ?? "xMidYMid meet").trim().split(/\s+/);
    let sx = width / vw;
    let sy = height / vh;
    let tx = -vx * sx;
    let ty = -vy * sy;
    if (par[0] !== "none") {
        const s = par[1] === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
        const along = (a: string) => (a === "Min" ? 0 : a === "Max" ? 1 : 0.5);
        const m = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/.exec(par[0] ?? "");
        if (!m) return undefined;
        sx = sy = s;
        tx = -vx * s + (width - vw * s) * along(m[1]!);
        ty = -vy * s + (height - vh * s) * along(m[2]!);
    }
    const r = (n: number) => Math.round(n * 1000) / 1000;
    const box = `${r((part.x - tx) / sx)} ${r((part.y - ty) / sy)} ${r(part.width / sx)} ${r(part.height / sy)}`;
    const rest = tag.slice(4).replace(/\s(viewBox|preserveAspectRatio|width|height)\s*=\s*(["'])[^"']*\2/gi, "");
    return `${svg.slice(0, at)}<svg viewBox="${box}" preserveAspectRatio="none"${rest}${svg.slice(end)}`;
}
