// Thumbnails for attached images, made in a worker (lib/thumbnail-worker.ts).
// A screenshot is ~6 million pixels; shown as a 44 px chip or a 96 px tile it
// cost a full-size decode on the UI thread and ~24 MB of decoded pixels for
// as long as it was on screen. A thumbnail is a ~240×180 PNG data: URL: no
// object URL to revoke, and it's gone when the attachment is.

import type { ThumbRequest, ThumbResponse } from "./thumbnail-size";

let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, (url: string | undefined) => void>();

function start(): Worker {
    const active = new Worker(new URL("./thumbnail-worker.ts", import.meta.url), { type: "module" });
    active.onmessage = (event: MessageEvent<ThumbResponse>) => {
        const done = pending.get(event.data.id);
        pending.delete(event.data.id);
        done?.(event.data.error ? undefined : event.data.url);
    };
    const fail = () => {
        if (worker !== active) return;
        worker = undefined;
        active.terminate();
        for (const done of pending.values()) done(undefined);
        pending.clear();
    };
    active.onerror = (event) => {
        event.preventDefault();
        fail();
    };
    active.onmessageerror = fail;
    return active;
}

/** Where a worker can decode and draw images (the desktop app's WebKit and current browsers; not Bun). */
export const canThumbnail = () => typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap !== "undefined";

/**
 * A thumbnail of an image, as a data: URL. Undefined when the image is small
 * enough to show as it is, or can't be made here: show the image itself then.
 */
export function thumbnail(image: { blob: Blob; mediaType: string } | { data: string; mediaType: string }): Promise<string | undefined> {
    if (!canThumbnail()) return Promise.resolve(undefined);
    return new Promise((resolve) => {
        const id = ++sequence;
        try {
            worker ??= start();
            pending.set(id, resolve);
            worker.postMessage({ id, ...image } satisfies ThumbRequest);
        } catch {
            pending.delete(id);
            resolve(undefined);
        }
    });
}
