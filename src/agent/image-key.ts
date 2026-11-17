// An image's key: a hash of it and its kind. What the server keeps a session's images by (src/server/tool-images.ts),
// and what a digest of its messages says its prompts' images are (history-digest.ts).

import { createHash } from "crypto";
import type { ImagePart } from "../providers/types";

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** The same image, the same key; undefined for a kind no model takes. */
export function imageKey(i: Pick<ImagePart, "mediaType" | "data">): string | undefined {
    const ext = EXT[i.mediaType];
    return ext && `${createHash("sha256").update(i.data).digest("hex").slice(0, 24)}.${ext}`;
}
