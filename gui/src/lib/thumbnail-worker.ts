// Shrinks an image to a thumbnail off the UI thread: decoding a 3024×1964
// screenshot takes WebKit 30–50 ms, and on the main thread createImageBitmap
// blocks for all of it. Answers with a PNG data: URL (PNG keeps transparency,
// which a window screenshot's shadow has), or nothing when the image is already
// small enough to show as it is.

import { coverSize, type ThumbRequest, type ThumbResponse } from "./thumbnail-size";

function bytesOf(data: string): Uint8Array {
    const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
    if (native) return native(data);
    const s = atob(data);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

async function thumb(req: ThumbRequest): Promise<string | undefined> {
    const blob = req.blob ?? new Blob([bytesOf(req.data!) as BlobPart], { type: req.mediaType });
    const bitmap = await createImageBitmap(blob);
    try {
        const size = coverSize(bitmap.width, bitmap.height);
        if (!size) return undefined;
        const canvas = new OffscreenCanvas(size.width, size.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return undefined;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, size.width, size.height);
        const png = await canvas.convertToBlob({ type: "image/png" });
        return await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.onerror = () => reject(r.error);
            r.readAsDataURL(png);
        });
    } finally {
        bitmap.close();
    }
}

self.onmessage = async (event: MessageEvent<ThumbRequest>) => {
    const { id } = event.data;
    try {
        self.postMessage({ id, url: await thumb(event.data) } satisfies ThumbResponse);
    } catch {
        // Not decodable here: the caller shows the image itself.
        self.postMessage({ id, error: true } satisfies ThumbResponse);
    }
};
