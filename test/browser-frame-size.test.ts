// The size a streamed frame is labelled with (src/browser/frame-size.ts), which the Browser pane maps clicks with.
import { describe, expect, test } from "bun:test";
import { frameSize, pictureSize } from "../src/browser/frame-size";

/** A JPEG's start as Chrome writes one: JFIF, a quantization table, then the frame header (`sof`) and a scan. */
function jpeg(width: number, height: number, sof = 0xc0, padding = false): string {
    const seg = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
    const bytes = [
        0xff, 0xd8,
        ...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
        ...seg(0xdb, [0, ...Array.from({ length: 64 }, () => 1)]),
        ...seg(0xc4, [0, ...Array.from({ length: 16 }, () => 0)]),
        ...(padding ? [0xff] : []),
        ...seg(sof, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
        ...seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
        0x12, 0x34, 0xff, 0xd9,
    ];
    return Buffer.from(bytes).toString("base64");
}

describe("pictureSize", () => {
    test("reads a baseline or progressive JPEG's pixel size from its frame header", () => {
        expect(pictureSize(jpeg(360, 622))).toEqual({ width: 360, height: 622 });
        expect(pictureSize(jpeg(1440, 900, 0xc2))).toEqual({ width: 1440, height: 900 });
        expect(pictureSize(jpeg(720, 1244, 0xc0, true))).toEqual({ width: 720, height: 1244 });
    });

    test("anything else, or a frame header that isn't near the start, has no size", () => {
        expect(pictureSize(Buffer.from("not a jpeg at all").toString("base64"))).toBeUndefined();
        expect(pictureSize("")).toBeUndefined();
        // A PNG.
        expect(pictureSize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"))).toBeUndefined();
        // Cut off before its frame header.
        expect(pictureSize(jpeg(360, 622).slice(0, 40))).toBeUndefined();
    });

    test("a frame header after a large colour profile is still found", () => {
        const profile = Buffer.concat([Buffer.from([0xff, 0xe2, 0x80, 0x02]), Buffer.alloc(0x8000)]);
        const plain = Buffer.from(jpeg(360, 622), "base64");
        const withProfile = Buffer.concat([plain.subarray(0, 2), profile, plain.subarray(2)]).toString("base64");
        expect(pictureSize(withProfile)).toEqual({ width: 360, height: 622 });
    });
});

describe("frameSize", () => {
    const viewport = { width: 360, height: 622, scale: 1 };
    const at = (scale: number) => ({ ...viewport, scale });
    /** A picture of `size`, and whether it was read. */
    const pictureOf = (size: { width: number; height: number } | undefined) => {
        const read = { count: 0 };
        return { read, picture: () => (read.count++, size) };
    };

    test("the labels Chrome gets wrong, at each scale but its own, are the viewport (clicks landed off by scale ÷ 2)", () => {
        // As captured from Chromium streaming a 360×622 page: the label is the picture's size ÷ 2.
        // Now and then the picture is drawn at the browser's scale (2) instead: still the page, at 720×1244.
        for (const [scale, label, picture] of [[1, [180, 311], [360, 622]], [1.5, [270, 466], [540, 933]], [3, [540, 933], [1080, 1866]], [3, [540, 933], [720, 1244]], [1, [180, 311], [720, 1244]]] as const) {
            const p = pictureOf({ width: picture[0], height: picture[1] });
            expect(frameSize({ deviceWidth: label[0], deviceHeight: label[1] }, at(scale), p.picture)).toEqual({ width: 360, height: 622 });
            expect(p.read.count).toBe(1);
        }
    });

    test("a frame labelled with the viewport is taken as it is, without reading its picture", () => {
        for (const scale of [1, 1.5, 2, 3]) {
            const p = pictureOf({ width: 1, height: 1 });
            expect(frameSize({ deviceWidth: 360, deviceHeight: 622 }, at(scale), p.picture)).toEqual({ width: 360, height: 622 });
            expect(p.read.count).toBe(0);
        }
    });

    test("at the browser's own scale, ÷ 2 is the right size: nothing is relabelled or read", () => {
        const p = pictureOf({ width: 720, height: 1244 });
        expect(frameSize({ deviceWidth: 720, deviceHeight: 1244 }, at(2), p.picture)).toEqual({ width: 720, height: 1244 });
        expect(p.read.count).toBe(0);
    });

    test("a frame of the old size, still arriving after a resize, keeps its own label", () => {
        // Its label looks like the new size's mislabel, but its picture is its own size, not the stream's.
        expect(frameSize({ deviceWidth: 180, deviceHeight: 311 }, viewport, pictureOf({ width: 180, height: 311 }).picture)).toEqual({ width: 180, height: 311 });
        expect(frameSize({ deviceWidth: 500, deviceHeight: 400 }, viewport, pictureOf({ width: 500, height: 400 }).picture)).toEqual({ width: 500, height: 400 });
        expect(frameSize({ deviceWidth: 270, deviceHeight: 466 }, at(1.5), pictureOf({ width: 270, height: 466 }).picture)).toEqual({ width: 270, height: 466 });
    });

    test("rounding: a label or picture a pixel or two off still counts; without a picture size, the label stands", () => {
        expect(frameSize({ deviceWidth: 180, deviceHeight: 311 }, { width: 361, height: 623, scale: 1 }, pictureOf({ width: 361, height: 623 }).picture)).toEqual({ width: 361, height: 623 });
        expect(frameSize({ deviceWidth: 180, deviceHeight: 311 }, viewport, pictureOf({ width: 362, height: 620 }).picture)).toEqual({ width: 360, height: 622 });
        expect(frameSize({ deviceWidth: 180, deviceHeight: 311 }, viewport, pictureOf(undefined).picture)).toEqual({ width: 180, height: 311 });
    });
});
