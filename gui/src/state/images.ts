// Images the transcript shows (see lib/imagecache.ts). The CSP allows data:
// and blob: images, nothing remote. A prompt's images come from the session
// by the turn's position; a reply's from local files it links to, which the
// server reads and checks are really images. Whole images never go to the DOM
// as data: URLs: WebKit spends ~2 ms per MB on the main thread each time one
// is set or read, so a reply's are object URLs and a prompt's stay base64
// until the viewer shows one.

import type { Turn } from "@shared/protocol";
import { ImageCache, imagesKeyOf, promptKey } from "../lib/imagecache";
import { RpcError } from "../lib/rpc";
import { thumbnail } from "../lib/thumbnail";
import { fromBase64, previewOf, type ImageAttachment } from "../lib/attachments";
import { UrlLeases } from "../lib/object-urls";
import { handleFor, rpc } from "./app";
import { sessionReadReady } from "./changes";

/** The session can be asked: connected, and reopened after a reconnect (asking before that is refused with not_open). */
export function imagesReady(sessionId: string): boolean {
    const h = handleFor(sessionId);
    return Boolean(h && sessionReadReady(h));
}

/** A failure that's down to the connection, not the image: asked again once the session is back. */
export function transient(e: unknown): boolean {
    return e instanceof RpcError && (e.code === "disconnected" || e.code === "not_open");
}

const toUrl = (i: { mediaType: string; data: string }) => `data:${i.mediaType};base64,${i.data}`;

/** A prompt's image: the whole of it (base64, for the viewer) and what the transcript shows (a thumbnail, or the image itself where none can be made). */
export type PromptImage = { mediaType: string; data: string; thumb: string };

/** Prompts' images: up to 20 MB each, so only the most recent few dozen are held. */
const prompts = new ImageCache<PromptImage>(32);

async function withThumb(i: { mediaType: string; data: string }): Promise<PromptImage> {
    return { mediaType: i.mediaType, data: i.data, thumb: (await thumbnail(i)) ?? toUrl(i) };
}

/** Replies' image URLs: the image viewer holds those it shows, past the reply going. */
export const replyUrls = new UrlLeases();

/** An image as an object URL, to be revoked when it's no longer shown. */
function objectUrl(i: { mediaType: string; data: string }): string {
    return URL.createObjectURL(new Blob([fromBase64(i.data) as BlobPart], { type: i.mediaType }));
}

/** A prompt's images, fetched by where it is and kept by what they are. Rejects when they're gone. */
export function promptImages(sessionId: string, pos: NonNullable<Turn["pos"]>, imagesKey: string): Promise<PromptImage[]> {
    return prompts.get(promptKey(sessionId, imagesKey), () => rpc.call("session.promptImages", { id: sessionId, seg: pos.seg, index: pos.index }).then((r) => Promise.all(r.images.map(withThumb))));
}

/**
 * Keeps the images being sent as that prompt's, with the composer's
 * thumbnails, so the turn shows them without asking the server for the bytes
 * it was just sent. Kept under the server's key for them: images an @mention
 * adds change that key, and then the turn asks as before.
 */
export async function keepSentImages(sessionId: string, images: readonly ImageAttachment[]): Promise<void> {
    const key = await imagesKeyOf(images);
    if (key) void prompts.get(promptKey(sessionId, key), () => Promise.all(images.map(async (i) => ({ mediaType: i.mediaType, data: i.data, thumb: await previewOf(i) }))));
}

/**
 * One reply's file images, as object URLs: the bytes it was shown with stay
 * while it streams; a later reply reads the file again. `dispose` revokes
 * them when the reply is no longer shown, or once the viewer showing one
 * closes.
 */
export function replyImages(sessionId: string): { load: (path: string) => Promise<string>; dispose: () => void } {
    const files = new ImageCache(16);
    const urls = new Set<string>();
    let disposed = false;
    const made = (r: { mediaType: string; data: string }) => {
        const url = objectUrl(r);
        if (disposed) replyUrls.drop(url);
        else urls.add(url);
        return [url];
    };
    return {
        load: (path) => files.get(path, () => rpc.call("fs.image", { sessionId, path }).then(made)).then((u) => u[0]!),
        dispose: () => {
            disposed = true;
            for (const url of urls) replyUrls.drop(url);
            urls.clear();
        },
    };
}
