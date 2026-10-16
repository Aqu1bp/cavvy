// Shared by the composer, server and provider serializers; keep this browser-safe.

/** 20 MB of PDFs and images is about 27 MB as base64, within Anthropic's 32 MB request limit. */
export const MEDIA_BUDGET = 20 * 1024 * 1024;

/** Decoded bytes, without allocating a second copy of the attachment. */
export function base64Size(data: string): number {
    return Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}
