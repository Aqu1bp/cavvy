// The size, in the page's CSS pixels, a streamed frame of the page is drawn at, which the pane maps clicks with.
//
// Chrome labels each screencast frame with the page's size (metadata.deviceWidth/deviceHeight). With the browser
// started at a device scale of 2 (chrome.ts) and a page emulated at another (a pane on a screen of scale 1), now and
// then it labels a frame with the size divided by the browser's scale instead: 180×311 for a 360×622 page, its
// picture still 360×622 pixels. Clicks mapped with that size land at half their place. So a frame whose picture is
// the size the current stream asked for is the current viewport, whatever its label; any other keeps its label,
// which is right for a frame of the old size still arriving as the page is resized.

import type { Viewport } from "./page";

export interface Size {
    width: number;
    height: number;
}

/** Enough of a JPEG's start to hold its frame header after the usual tables: base64, a multiple of 4 characters. */
const HEAD_CHARS = 4096;

/** A JPEG's size in pixels, from its first frame header (baseline or progressive); undefined if there's none near its start. */
export function jpegSize(base64: string): Size | undefined {
    const b = Buffer.from(base64.slice(0, HEAD_CHARS), "base64");
    if (b[0] !== 0xff || b[1] !== 0xd8) return undefined;
    for (let i = 2; i + 9 <= b.length; ) {
        if (b[i] !== 0xff) return undefined;
        const marker = b[i + 1]!;
        // Padding before a marker.
        if (marker === 0xff) { i++; continue; }
        // SOF0 to SOF3 (not DHT, 0xc4): height then width, after the length and precision.
        if (marker >= 0xc0 && marker <= 0xc3) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        // Start of scan or end of image before any frame header.
        if (marker === 0xda || marker === 0xd9) return undefined;
        i += 2 + b.readUInt16BE(i + 2);
    }
    return undefined;
}

/** The CSS size to label a screencast frame with: see the top of this file. */
export function frameSize(label: { deviceWidth: number; deviceHeight: number }, picture: Size | undefined, viewport: Viewport): Size {
    const near = (a: number, b: number) => Math.abs(a - b) <= 1;
    if (picture && near(picture.width, viewport.width * viewport.scale) && near(picture.height, viewport.height * viewport.scale)) return { width: viewport.width, height: viewport.height };
    return { width: label.deviceWidth, height: label.deviceHeight };
}
