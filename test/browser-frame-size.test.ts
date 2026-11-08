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

    test("a frame Chrome labels with half its size, its picture the stream's size, is the viewport (what made clicks land at half their place)", () => {
        expect(frameSize({ deviceWidth: 180, deviceHeight: 311 }, { width: 360, height: 622 }, viewport)).toEqual({ width: 360, height: 622 });
    });

    test("a frame of the old size, still arriving after a resize, keeps its own label", () => {
        expect(frameSize({ deviceWidth: 500, deviceHeight: 400 }, { width: 500, height: 400 }, viewport)).toEqual({ width: 500, height: 400 });
        // Size and scale changed together: the old frame's picture is the new stream's size, its label its own.
        expect(frameSize({ deviceWidth: 720, deviceHeight: 1244 }, { width: 720, height: 1244 }, { ...viewport, scale: 2 })).toEqual({ width: 720, height: 1244 });
    });

    test("at scale 2, the picture is twice the viewport and the label is the viewport", () => {
        expect(frameSize({ deviceWidth: 360, deviceHeight: 622 }, { width: 720, height: 1244 }, { ...viewport, scale: 2 })).toEqual({ width: 360, height: 622 });
        expect(frameSize({ deviceWidth: 180, deviceHeight: 311 }, { width: 720, height: 1244 }, { ...viewport, scale: 2 })).toEqual({ width: 360, height: 622 });
    });

    test("a picture a pixel off from rounding still counts; without a picture size, the label stands", () => {
        expect(frameSize({ deviceWidth: 180, deviceHeight: 311 }, { width: 361, height: 621 }, viewport)).toEqual({ width: 360, height: 622 });
        // Odd sizes: half of 361×623 is labelled 180×311 (rounded down).
        expect(frameSize({ deviceWidth: 180, deviceHeight: 311 }, { width: 361, height: 623 }, { width: 361, height: 623, scale: 1 })).toEqual({ width: 361, height: 623 });
        expect(frameSize({ deviceWidth: 180, deviceHeight: 311 }, undefined, viewport)).toEqual({ width: 180, height: 311 });
    });
});
