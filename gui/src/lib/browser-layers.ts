// The picture of a page watched over a network (a session on a server), kept sharp where the page doesn't move.
//
// Its stream is light while the page changes (soft: drawn at 1x, low quality), and a sharp still follows when it
// stops (src/browser/far-stream.ts). A page that never stops (a spinner, a video, a carousel) would stay soft for
// good. So the pane keeps the last still under the stream, and of each frame of the stream draws only the part
// that changed: the text beside a spinner stays sharp, and the spinner turns at the stream's pace. The server sends
// a still now and then while such a page goes on (`still: 2`), and one when it stops (`still: 1`).
//
// Pure, apart from the pictures it's handed (it closes the ones it lets go): BrowserPane.tsx draws what `plan` says.

import type { Placement, Size } from "./browser";

/** The share of the page past which what changes is the whole page moving (a scroll): the stream is shown whole. */
export const MOST = 0.4;
/** Around what changed: a picture's blocks differ a little past the pixels the page changed. */
const MARGIN = 4;

/** A picture's pixels for comparing: RGBA as 32-bit words, `width` to a row, and how many of its pixels make a CSS pixel of the page. */
export interface Pixels {
    data: Uint32Array;
    width: number;
    height: number;
    scale: number;
}

/** The box of the pixels that differ between two pictures of one size, in their pixels; undefined when none do. */
export function changedBox(a: Uint32Array, b: Uint32Array, width: number, height: number): Placement | undefined {
    const n = width * height;
    let first = 0;
    while (first < n && a[first] === b[first]) first++;
    if (first === n) return undefined;
    let last = n - 1;
    while (a[last] === b[last]) last--;
    const top = Math.floor(first / width);
    const bottom = Math.floor(last / width);
    let left = width;
    let right = -1;
    for (let y = top; y <= bottom; y++) {
        const row = y * width;
        // Only as far as the box already reaches: a row that changes inside it widens nothing.
        let x = 0;
        while (x < left && a[row + x] === b[row + x]) x++;
        if (x < left) left = x;
        let r = width - 1;
        while (r > right && a[row + r] === b[row + r]) r--;
        if (r > right) right = r;
    }
    return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function union(a: Placement | undefined, b: Placement | undefined): Placement | undefined {
    if (!a || !b) return a ?? b;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** What to draw: `under` whole, then `over` (whole, or only its `part`, in the page's CSS pixels). */
export interface Plan<B> {
    size: Size;
    under?: B;
    over?: B;
    part?: Placement;
}

export class Layers<B extends { close(): void }> {
    /** The last still, and the page's size it shows. */
    private base?: { picture: B; size: Size };
    /** The stream's latest frame. */
    private top?: { picture: B; size: Size };
    private prev?: Pixels;
    /** What the stream changed since the still under it, and in the stretch before that still: both are drawn from the stream. */
    private now?: Placement;
    private before?: Placement;
    /** The stream's last frame changed all over: the page is moving, and no still is laid under it. */
    private moving = false;
    /** A still has come marked as one: the stream is a server's, and its frames are compared. */
    private far = false;

    /** Whether the stream's frames need their pixels read (`frame`'s `pixels`): only a server's do. */
    get compares(): boolean {
        return this.far;
    }

    /** A sharp still. False when it isn't to be shown: the page moved on all over since it was taken. */
    still(picture: B, size: Size, kind: 1 | 2): boolean {
        this.far = true;
        if (kind === 2 && this.moving) {
            picture.close();
            return false;
        }
        this.base?.picture.close();
        this.base = { picture, size };
        if (kind === 1) {
            // The page at rest: nothing of the stream is over it.
            this.top?.picture.close();
            this.top = undefined;
            this.now = this.before = undefined;
            this.moving = false;
        } else {
            // The page a moment ago: what has been changing still is, and is drawn from the stream.
            this.before = this.now;
            this.now = undefined;
        }
        return true;
    }

    /** A frame of the stream. `pixels`: read when frames are compared, undefined if they can't be read. */
    frame(picture: B, size: Size, pixels?: () => Pixels | undefined) {
        this.top?.picture.close();
        this.top = { picture, size };
        if (!this.far) return;
        const cur = pixels?.();
        const prev = this.prev;
        this.prev = cur;
        const same = cur && prev && cur.width === prev.width && cur.height === prev.height && cur.scale === prev.scale;
        const box = same ? changedBox(prev.data, cur.data, cur.width, cur.height) : undefined;
        // Not to be compared (the first frame, another size), or most of the page changed: it's moving.
        const page = size.width * size.height;
        const changed = same ? box && { x: box.x / cur.scale - MARGIN, y: box.y / cur.scale - MARGIN, width: box.width / cur.scale + 2 * MARGIN, height: box.height / cur.scale + 2 * MARGIN } : undefined;
        const all = union(union(this.now, this.before), changed);
        if (!same || (all && all.width * all.height > MOST * page) || (this.base && (this.base.size.width !== size.width || this.base.size.height !== size.height))) {
            this.moving = true;
            this.now = this.before = undefined;
            this.base?.picture.close();
            this.base = undefined;
            return;
        }
        this.moving = false;
        this.now = union(this.now, changed);
    }

    plan(): Plan<B> | undefined {
        const { base, top } = this;
        if (base && !this.moving) {
            const all = union(this.now, this.before);
            // Within the page.
            const x = Math.max(0, Math.floor(all?.x ?? 0));
            const y = Math.max(0, Math.floor(all?.y ?? 0));
            const part = all && { x, y, width: Math.min(base.size.width, Math.ceil(all.x + all.width)) - x, height: Math.min(base.size.height, Math.ceil(all.y + all.height)) - y };
            return { size: base.size, under: base.picture, ...(top && part && part.width > 0 && part.height > 0 ? { over: top.picture, part } : {}) };
        }
        const one = top ?? base;
        return one && { size: one.size, over: one.picture };
    }

    clear() {
        this.base?.picture.close();
        this.top?.picture.close();
        this.base = this.top = this.prev = this.now = this.before = undefined;
        this.moving = this.far = false;
    }
}

/**
 * Reads a frame's pixels at half its size, for telling what changed since the one before. One canvas, kept between
 * frames; undefined where the window can't read pictures back.
 */
export function pixelReader(): (picture: CanvasImageSource, size: Size) => Pixels | undefined {
    let reader: { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | undefined;
    return (picture, size) => {
        const scale = 0.5;
        const width = Math.max(1, Math.round(size.width * scale));
        const height = Math.max(1, Math.round(size.height * scale));
        try {
            if (!reader || reader.canvas.width !== width || reader.canvas.height !== height) {
                const canvas = new OffscreenCanvas(width, height);
                const ctx = canvas.getContext("2d", { willReadFrequently: true });
                if (!ctx) return undefined;
                reader = { canvas, ctx };
            }
            reader.ctx.drawImage(picture, 0, 0, width, height);
            return { data: new Uint32Array(reader.ctx.getImageData(0, 0, width, height).data.buffer), width, height, scale };
        } catch {
            return undefined;
        }
    };
}
