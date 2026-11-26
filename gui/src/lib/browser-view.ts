// The Browser pane's page size and zoom, as picked in its menu (components/BrowserTools.tsx): the pane's own size (Fill
// pane), or a device's, drawn scaled down to fit the pane; and a zoom, as a browser's. Pure: the pane asks it what size
// and scale to ask the page for, and how large to draw it.

import type { Size } from "./browser";

export interface PageView {
    /** A device's size in CSS pixels; none: the pane's own. */
    device?: Size;
    /** As a browser zooms: 1.25 is 125%. */
    zoom: number;
}

export const DEVICES: readonly { name: string; size: Size }[] = [
    { name: "Phone", size: { width: 390, height: 844 } },
    { name: "Tablet", size: { width: 820, height: 1180 } },
    { name: "Laptop", size: { width: 1280, height: 800 } },
];

/** The device a size is, either way round (Phone rotated is still Phone); none: a custom size. */
export function deviceOf(size: Size | undefined): (typeof DEVICES)[number] | undefined {
    if (!size) return undefined;
    return DEVICES.find((d) => (d.size.width === size.width && d.size.height === size.height) || (d.size.width === size.height && d.size.height === size.width));
}

export const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
/** The sides a device size may have (the server keeps a page within these too: src/browser/page.ts). */
export const MIN_SIDE = 200;
export const MAX_SIDE = 4000;

/** The next zoom in (1) or out (-1) from `zoom`, as browsers step it. */
export function zoomStep(zoom: number, dir: 1 | -1): number {
    if (dir > 0) return ZOOMS.find((z) => z > zoom + 0.001) ?? ZOOMS.at(-1)!;
    return [...ZOOMS].reverse().find((z) => z < zoom - 0.001) ?? ZOOMS[0]!;
}

/** A side typed in, if it's a number a page can have (MIN_SIDE to MAX_SIDE); undefined if it isn't one. */
export function side(text: string): number | undefined {
    const n = Math.round(Number(text.trim()));
    return text.trim() && Number.isFinite(n) && n >= MIN_SIDE && n <= MAX_SIDE ? n : undefined;
}

/** How much a device's page is drawn smaller to fit the box (never larger than its own size). */
export function fitScale(box: Size, device: Size): number {
    return Math.min(1, box.width / device.width, box.height / device.height);
}

/**
 * What to ask the headless page for: its size in CSS pixels and its device pixels per CSS pixel. Zoom is as a browser's:
 * fewer CSS pixels across, each drawn larger. A device's page is drawn at the pixels it fits in (`fitScale`), so its
 * pictures are no larger than the pane shows them. Without a view: the pane's size at the screen's scale, as before.
 */
export function pageTarget(box: Size, dpr: number, view?: PageView): Size & { scale: number } {
    if (!view) return { ...box, scale: dpr };
    const page = view.device ?? box;
    const fit = view.device ? fitScale(box, view.device) : 1;
    return { width: Math.round(page.width / view.zoom), height: Math.round(page.height / view.zoom), scale: dpr * fit * view.zoom };
}

/** "390 × 844", "Fill pane", with the zoom when it isn't 100%. */
export function viewLabel(view?: PageView): string {
    const size = view?.device ? `${view.device.width} × ${view.device.height}` : "Fill pane";
    return view && view.zoom !== 1 ? `${size} · ${Math.round(view.zoom * 100)}%` : size;
}
