// The size, in the page's CSS pixels, a streamed frame of the page is drawn at, which the pane maps clicks with.
//
// Chrome labels each screencast frame with the page's size (metadata.deviceWidth/deviceHeight). With the browser
// started at a device scale of BROWSER_SCALE (chrome.ts) and a page emulated at another scale (a pane on a screen of
// scale 1, 1.5 or 3), now and then it labels a frame with its picture's size divided by the browser's scale rather than
// the page's: 180×311 for a 360×622 page at scale 1, 270×466 at 1.5, 540×933 at 3, the picture itself still the
// page's size × its scale (or, now and then, × the browser's). Clicks mapped with that label land off by scale ÷ 2.
// So a frame labelled that way whose picture is the current viewport at either scale is the current viewport; any other
// keeps its label, which is right for a frame of the old size still arriving as the page is resized. At the browser's
// own scale the two are the same.

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

/**
 * The CSS size to label a screencast frame with: see the top of this file. `picture` reads the frame's pixel size, only
 * for a frame whose label is that mislabel (rare), so most frames aren't decoded at all.
 */
export function frameSize(label: { deviceWidth: number; deviceHeight: number }, viewport: Viewport, picture: () => Size | undefined): Size {
    const own = { width: label.deviceWidth, height: label.deviceHeight };
    if (viewport.scale === BROWSER_SCALE || (own.width === viewport.width && own.height === viewport.height)) return own;
    const mislabelled = Math.abs(own.width - (viewport.width * viewport.scale) / BROWSER_SCALE) <= 1 && Math.abs(own.height - (viewport.height * viewport.scale) / BROWSER_SCALE) <= 1;
    if (!mislabelled) return own;
    const pic = picture();
    const drawnAt = (scale: number) => !!pic && Math.abs(pic.width - viewport.width * scale) <= 2 && Math.abs(pic.height - viewport.height * scale) <= 2;
    return drawnAt(viewport.scale) || drawnAt(BROWSER_SCALE) ? { width: viewport.width, height: viewport.height } : own;
}
