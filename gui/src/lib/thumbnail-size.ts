// How big a thumbnail is, shared by the page and the worker that makes them.

/**
 * The box a thumbnail has to cover: the transcript shows a prompt's images at
 * 96×72 and the composer at 44×44, both `object-fit: cover`, so this is the
 * larger at 2.5× (a Retina screen, and some room to zoom).
 */
export const THUMB_BOX = { width: 240, height: 180 };

/** The smallest size, in whole pixels, that covers the box with the image's shape; undefined if it's no bigger than that already. */
export function coverSize(width: number, height: number): { width: number; height: number } | undefined {
    if (!(width > 0 && height > 0)) return undefined;
    const scale = Math.max(THUMB_BOX.width / width, THUMB_BOX.height / height);
    if (scale >= 1) return undefined;
    return { width: Math.max(1, Math.ceil(width * scale)), height: Math.max(1, Math.ceil(height * scale)) };
}

/** An image as a Blob (just read from a file) or as base64 (from the server). */
export type ThumbRequest = { id: number; blob?: Blob; data?: string; mediaType: string };
/** A PNG data: URL, nothing (it's small enough as it is), or an error (it couldn't be decoded). */
export type ThumbResponse = { id: number; url?: string; error?: true };
