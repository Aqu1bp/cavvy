// How the image viewer (components/ImageViewer.tsx) sizes an image: fitted
// into most of the window and never past its own size, so a small image stays
// crisp at 1× and a tall screenshot fits by its height. Also where 1:1 scrolls
// to, the move it opens with, and an image's size read from its header, so
// the box is right from the first frame, before the image is decoded.

export type Size = { width: number; height: number };
export type Rect = Size & { left: number; top: number };

/** The share of the window an image may fill. */
const SHARE = { width: 0.92, height: 0.88 };

/** The box an image is fitted into, for a window this size. */
export function viewBox(win: Size): Size {
    return { width: Math.floor(win.width * SHARE.width), height: Math.floor(win.height * SHARE.height) };
}

const sized = (s: Size) => s.width > 0 && s.height > 0;

/** How much the image is scaled to fit the box: 1 at most, so it's never upscaled; 0 when either has no size. */
export function fitScale(natural: Size, box: Size): number {
    if (!sized(natural) || !sized(box)) return 0;
    return Math.min(1, box.width / natural.width, box.height / natural.height);
}

/** The image's size fitted into the box, in whole pixels (at least 1 each way); 0×0 when it can't be. */
export function fitSize(natural: Size, box: Size): Size {
    const scale = fitScale(natural, box);
    if (!scale) return { width: 0, height: 0 };
    return { width: Math.max(1, Math.round(natural.width * scale)), height: Math.max(1, Math.round(natural.height * scale)) };
}

/** Scaled down to fit: a click shows it at 1:1. */
export function canZoom(natural: Size, box: Size): boolean {
    const scale = fitScale(natural, box);
    return scale > 0 && scale < 1;
}

/**
 * Where the view scrolls to when the fitted image is shown at 1:1, so the
 * point that was clicked stays under the cursor. `at`: the click in the fitted
 * image; `cursor`: the click in the view. A side no larger than the view
 * isn't scrolled (it's centred).
 */
export function zoomScroll(at: { x: number; y: number }, cursor: { x: number; y: number }, fitted: Size, natural: Size, view: Size): { left: number; top: number } {
    const axis = (a: number, c: number, f: number, n: number, v: number) => {
        if (n <= v || f <= 0) return 0;
        return Math.round(Math.min(n - v, Math.max(0, (a / f) * n - c)));
    };
    return { left: axis(at.x, cursor.x, fitted.width, natural.width, view.width), top: axis(at.y, cursor.y, fitted.height, natural.height, view.height) };
}

/**
 * The transform that puts the image, laid out at `to`, over the thumbnail it
 * was opened from at `from` (the first frame of its opening move): centred on
 * it, and scaled to cover it, as the tile's `object-fit: cover` shows it.
 */
export function flipFrom(from: Rect, to: Rect): { x: number; y: number; scale: number } {
    if (!sized(to) || !sized(from)) return { x: 0, y: 0, scale: 1 };
    return {
        x: from.left + from.width / 2 - (to.left + to.width / 2),
        y: from.top + from.height / 2 - (to.top + to.height / 2),
        scale: Math.max(from.width / to.width, from.height / to.height),
    };
}

const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const be32 = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const ascii = (b: Uint8Array, i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
const some = (width: number, height: number): Size | undefined => (width > 0 && height > 0 ? { width, height } : undefined);

function jpegSize(b: Uint8Array): Size | undefined {
    let i = 2;
    while (i + 9 < b.length) {
        if (b[i] !== 0xff) return undefined;
        const marker = b[i + 1]!;
        // Fill bytes before a marker.
        if (marker === 0xff) {
            i++;
            continue;
        }
        // Start of frame: C0–CF, but C4 (Huffman tables), C8 (reserved) and CC (arithmetic coding) aren't.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return some(be16(b, i + 7), be16(b, i + 5));
        i += 2 + be16(b, i + 2);
    }
    return undefined;
}

/**
 * An image's size in pixels from its header (PNG, GIF, WebP, JPEG), without
 * decoding it; undefined when the bytes don't say. A JPEG's EXIF rotation
 * isn't read: the decoded size wins once the viewer has it.
 */
export function imageSize(b: Uint8Array): Size | undefined {
    if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, "PNG") && ascii(b, 12, "IHDR")) return some(be32(b, 16), be32(b, 20));
    if (b.length >= 10 && ascii(b, 0, "GIF8")) return some(le16(b, 6), le16(b, 8));
    if (b.length >= 16 && ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) {
        if (ascii(b, 12, "VP8 ") && b.length >= 30) return some(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff);
        if (ascii(b, 12, "VP8L") && b.length >= 25) {
            const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
            return some((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
        }
        if (ascii(b, 12, "VP8X") && b.length >= 30) return some(le24(b, 24) + 1, le24(b, 27) + 1);
        return undefined;
    }
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpegSize(b);
    return undefined;
}
