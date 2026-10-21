// Images the transcript shows (see lib/imagecache.ts). The CSP allows data:
// and blob: images, nothing remote. A prompt's images come from the session
// by the turn's position; a reply's from local files it links to, which the
// server reads and checks are really images.

import type { Turn } from "@shared/protocol";
import { ImageCache, imagesKeyOf, promptKey } from "../lib/imagecache";
import { RpcError } from "../lib/rpc";
import { thumbnail } from "../lib/thumbnail";
import { previewOf, type ImageAttachment } from "../lib/attachments";
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

/** A prompt's image: the whole of it (`src`, for the viewer) and what the transcript shows (a thumbnail, or `src` where none can be made). */
export type PromptImage = { src: string; thumb: string };

/** Prompts' images: up to 20 MB each, so only the most recent few dozen are held. */
const prompts = new ImageCache<PromptImage>(32);

async function withThumb(i: { mediaType: string; data: string }): Promise<PromptImage> {
    const src = toUrl(i);
    return { src, thumb: (await thumbnail(i)) ?? src };
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
    if (key) void prompts.get(promptKey(sessionId, key), () => Promise.all(images.map(async (i) => ({ src: toUrl(i), thumb: await previewOf(i) }))));
}

/** One reply's file images: the bytes it was shown with stay while it streams; a later reply reads the file again. */
export function replyImages(sessionId: string): (path: string) => Promise<string> {
    const files = new ImageCache(16);
    return (path) => files.get(path, () => rpc.call("fs.image", { sessionId, path }).then((r) => [toUrl(r)])).then((u) => u[0]!);
}
