// Images the transcript shows (see lib/imagecache.ts). The CSP allows data:
// and blob: images, nothing remote. A prompt's images come from the session
// by the turn's position; a reply's from files in the session's folders,
// which the server reads and checks are really images.

import type { Turn } from "@shared/protocol";
import { ImageCache, promptKey } from "../lib/imagecache";
import { rpc } from "./app";

const toUrl = (i: { mediaType: string; data: string }) => `data:${i.mediaType};base64,${i.data}`;

/** Prompts' images: up to 20 MB each, so only the most recent few dozen are held. */
const prompts = new ImageCache(32);

/** The data: URLs of a prompt's images, fetched by where it is and kept by what they are. Rejects when they're gone. */
export function promptImages(sessionId: string, pos: NonNullable<Turn["pos"]>, imagesKey: string): Promise<string[]> {
    return prompts.get(promptKey(sessionId, imagesKey), () => rpc.call("session.promptImages", { id: sessionId, seg: pos.seg, index: pos.index }).then((r) => r.images.map(toUrl)));
}

/** One reply's file images: the bytes it was shown with stay while it streams; a later reply reads the file again. */
export function replyImages(sessionId: string): (path: string) => Promise<string> {
    const files = new ImageCache(16);
    return (path) => files.get(path, () => rpc.call("fs.image", { sessionId, path }).then((r) => [toUrl(r)])).then((u) => u[0]!);
}
