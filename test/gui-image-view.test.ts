// The image viewer's sizing (gui/src/lib/image-view.ts): fitted into most of
// the window and never past its own size, 1:1 that keeps the clicked point
// under the cursor, the opening move from the thumbnail, the stepping keys,
// and an image's size read from its header.

import { describe, expect, test } from "bun:test";
import { canZoom, fitScale, fitSize, flipFrom, imageSize, stepKey, viewBox, zoomScroll } from "../gui/src/lib/image-view";

const box = { width: 1000, height: 800 };

describe("fitting", () => {
    test("the box is 92% of the window's width and 88% of its height", () => {
        expect(viewBox({ width: 1512, height: 982 })).toEqual({ width: 1391, height: 864 });
        expect(viewBox({ width: 720, height: 480 })).toEqual({ width: 662, height: 422 });
    });

    test("a wide screenshot fits by width, keeping its shape", () => {
        expect(fitScale({ width: 3000, height: 2000 }, box)).toBeCloseTo(1 / 3);
        expect(fitSize({ width: 3000, height: 2000 }, box)).toEqual({ width: 1000, height: 667 });
    });

    test("a tall screenshot fits by height", () => {
        expect(fitSize({ width: 1200, height: 4000 }, box)).toEqual({ width: 240, height: 800 });
    });

    test("a small image stays at its own size: never upscaled", () => {
        expect(fitScale({ width: 320, height: 200 }, box)).toBe(1);
        expect(fitSize({ width: 320, height: 200 }, box)).toEqual({ width: 320, height: 200 });
        expect(canZoom({ width: 320, height: 200 }, box)).toBe(false);
    });

    test("an image exactly the box's size isn't scaled, and can't be zoomed", () => {
        expect(fitSize(box, box)).toEqual(box);
        expect(canZoom(box, box)).toBe(false);
    });

    test("one larger in either direction can be zoomed", () => {
        expect(canZoom({ width: 1001, height: 10 }, box)).toBe(true);
        expect(canZoom({ width: 10, height: 801 }, box)).toBe(true);
    });

    test("a hairline image keeps at least a pixel each way", () => {
        expect(fitSize({ width: 100000, height: 1 }, box)).toEqual({ width: 1000, height: 1 });
    });

    test("no size, or no room, scales by 0 and has no size", () => {
        expect(fitScale({ width: 0, height: 100 }, box)).toBe(0);
        expect(fitScale({ width: 100, height: 100 }, { width: 0, height: 0 })).toBe(0);
        expect(fitSize({ width: Number.NaN, height: 100 }, box)).toEqual({ width: 0, height: 0 });
        expect(canZoom({ width: 0, height: 0 }, box)).toBe(false);
    });
});

describe("1:1 from a click", () => {
    const natural = { width: 3000, height: 2000 };
    const fitted = { width: 1000, height: 667 };
    const view = { width: 1200, height: 900 };

    test("the clicked point stays under the cursor", () => {
        // The middle of the image, clicked at the middle of the view.
        expect(zoomScroll({ x: 500, y: 333.5 }, { x: 600, y: 450 }, fitted, natural, view)).toEqual({ left: 900, top: 550 });
    });

    test("clamped to what can be scrolled", () => {
        // Its top-left corner can't be scrolled past 0; its bottom-right not past the far edge.
        expect(zoomScroll({ x: 0, y: 0 }, { x: 600, y: 450 }, fitted, natural, view)).toEqual({ left: 0, top: 0 });
        expect(zoomScroll({ x: 1000, y: 667 }, { x: 600, y: 450 }, fitted, natural, view)).toEqual({ left: 1800, top: 1100 });
    });

    test("a side that fits the view isn't scrolled", () => {
        expect(zoomScroll({ x: 120, y: 400 }, { x: 600, y: 450 }, { width: 240, height: 800 }, { width: 1200, height: 4000 }, view)).toEqual({ left: 0, top: 1550 });
    });
});

describe("opening from the thumbnail", () => {
    test("starts centred on it, scaled to cover it as its tile does", () => {
        const to = { left: 100, top: 50, width: 1000, height: 667 };
        // A 96×72 tile (object-fit: cover) of a 3:2 image: covered by height.
        const f = flipFrom({ left: 40, top: 600, width: 96, height: 72 }, to);
        expect(f.x).toBeCloseTo(88 - 600);
        expect(f.y).toBeCloseTo(636 - 383.5);
        expect(f.scale).toBeCloseTo(72 / 667);
    });

    test("no room to end in: no move", () => {
        expect(flipFrom({ left: 0, top: 0, width: 10, height: 10 }, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0, scale: 1 });
    });
});

describe("an image's size from its header", () => {
    const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));
    const be32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const be16 = (n: number) => [n >>> 8, n & 255];
    const le16 = (n: number) => [n & 255, n >>> 8];
    const le24 = (n: number) => [n & 255, (n >>> 8) & 255, n >>> 16];

    test("PNG: IHDR's width and height", () => {
        const png = bytes([137, 80, 78, 71, 13, 10, 26, 10], be32(13), "IHDR", be32(3024), be32(1964), [8, 6, 0, 0, 0]);
        expect(imageSize(png)).toEqual({ width: 3024, height: 1964 });
    });

    test("GIF: the logical screen", () => {
        expect(imageSize(bytes("GIF89a", le16(640), le16(480), [0, 0, 0]))).toEqual({ width: 640, height: 480 });
    });

    test("JPEG: the frame header, after the segments before it", () => {
        const app1 = bytes([0xff, 0xe1], be16(2 + 6), "Exif\0\0");
        const sof = bytes([0xff, 0xc0], be16(17), [8], be16(1080), be16(1920), [3]);
        const jpeg = new Uint8Array([0xff, 0xd8, ...app1, ...sof, 0xff, 0xd9]);
        expect(imageSize(jpeg)).toEqual({ width: 1920, height: 1080 });
    });

    test("JPEG: a Huffman table (C4) isn't a frame header", () => {
        const dht = bytes([0xff, 0xc4], be16(2 + 4), [1, 2, 3, 4]);
        const sof2 = bytes([0xff, 0xc2], be16(17), [8], be16(300), be16(400), [3]);
        expect(imageSize(new Uint8Array([0xff, 0xd8, ...dht, ...sof2]))).toEqual({ width: 400, height: 300 });
    });

    test("WebP: lossy, lossless and extended", () => {
        const riff = (chunk: string, body: number[]) => bytes("RIFF", [0, 0, 0, 0], "WEBP", chunk, [0, 0, 0, 0], body);
        // VP8: a frame tag (3 bytes), the start code, then 14-bit width and height.
        expect(imageSize(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(800), ...le16(600)]))).toEqual({ width: 800, height: 600 });
        // VP8L: a signature byte, then width-1 and height-1 in 14 bits each.
        const w = 1023, h = 511;
        const bits = (w - 1) | ((h - 1) << 14);
        expect(imageSize(riff("VP8L", [0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]))).toEqual({ width: w, height: h });
        // VP8X: flags and reserved bytes, then width-1 and height-1 in 24 bits each.
        expect(imageSize(riff("VP8X", [0, 0, 0, 0, ...le24(4095), ...le24(2047)]))).toEqual({ width: 4096, height: 2048 });
    });

    test("anything else, or too short to say, has no size", () => {
        expect(imageSize(bytes("hello world, not an image"))).toBeUndefined();
        expect(imageSize(new Uint8Array([137, 80, 78, 71]))).toBeUndefined();
        expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBeUndefined();
        expect(imageSize(new Uint8Array())).toBeUndefined();
    });
});

describe("stepping keys", () => {
    test("← and → step when the viewer is the dialog on top", () => {
        expect(stepKey("ArrowLeft", false, true)).toBe(-1);
        expect(stepKey("ArrowRight", false, true)).toBe(1);
    });

    test("not under another dialog (the palette over it), nor while typing", () => {
        expect(stepKey("ArrowRight", false, false)).toBe(0);
        expect(stepKey("ArrowLeft", true, true)).toBe(0);
    });

    test("other keys don't step", () => {
        expect(stepKey("ArrowUp", false, true)).toBe(0);
        expect(stepKey("Enter", false, true)).toBe(0);
    });
});
