// The size, in the page's CSS pixels, a streamed frame of the page is drawn at, which the pane maps clicks with.
//
// Chrome labels each screencast frame with the page's size (metadata.deviceWidth/deviceHeight). With the browser
// started at a device scale of BROWSER_SCALE (chrome.ts) and a page emulated at another (a pane on a screen of scale
// 1), now and then it labels a frame with the size divided by the browser's scale instead: 180×311 for a 360×622 page,
// its picture still 360×622 pixels. Clicks mapped with that size land at half their place. So a frame whose picture
// is the size the current stream asked for, labelled with the viewport or with that mislabel, is the current
// viewport; any other keeps its label, which is right for a frame of the old size still arriving as the page is resized.

import { imageSize } from "../ui/images";
import { BROWSER_SCALE } from "./chrome";
import type { Viewport } from "./page";

export interface Size {
    width: number;
    height: number;
}

/** Enough of a JPEG's start to hold its frame header after its tables and any colour profile: base64, a multiple of 4. */
const HEAD_CHARS = 64 * 1024;

/** A streamed picture's size in pixels, from its header; undefined if it can't be read near its start. */
export function pictureSize(base64: string): Size | undefined {
    return imageSize(Buffer.from(base64.slice(0, HEAD_CHARS), "base64"));
}

/** The CSS size to label a screencast frame with: see the top of this file. */
export function frameSize(label: { deviceWidth: number; deviceHeight: number }, picture: Size | undefined, viewport: Viewport): Size {
    const near = (a: number, b: number) => Math.abs(a - b) <= 1;
    const pictured = picture && near(picture.width, viewport.width * viewport.scale) && near(picture.height, viewport.height * viewport.scale);
    const mislabelled = near(label.deviceWidth * BROWSER_SCALE, viewport.width) && near(label.deviceHeight * BROWSER_SCALE, viewport.height);
    if (pictured && mislabelled) return { width: viewport.width, height: viewport.height };
    return { width: label.deviceWidth, height: label.deviceHeight };
}
