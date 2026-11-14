// The images a tool call's result brought the model (a screenshot it took, an image file it read), kept by the
// session so its row can show what the model looked at. A CLI's results reach Cavvy once, as they happen, and its
// own session files are its own: so each image is kept here, beside the session's file history, by a hash of it.

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { ImagePart } from "../providers/types";

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const TYPE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** A kept image's name: a hash of it and its kind. Nothing else is ever read from the folder. */
export const IMAGE_KEY = /^[a-f0-9]{24}\.(png|jpg|gif|webp)$/;

/** The same image, the same key; undefined for a kind no model takes. */
export function imageKey(i: Pick<ImagePart, "mediaType" | "data">): string | undefined {
    const ext = EXT[i.mediaType];
    return ext && `${createHash("sha256").update(i.data).digest("hex").slice(0, 24)}.${ext}`;
}

/** Where a session's are kept: in its project's folder, as its file history is (session-delete moves both). */
export function toolImagesDir(sessionPath: string, id: string): string {
    return join(dirname(sessionPath), "tool-images", id);
}

/** Keeps each image (once), and gives their keys in order. */
export function keepImages(dir: string, images: readonly ImagePart[]): string[] {
    const keys: string[] = [];
    for (const i of images) {
        const key = imageKey(i);
        if (!key) continue;
        const file = join(dir, key);
        if (!existsSync(file)) {
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            writeFileSync(file, Buffer.from(i.data, "base64"), { mode: 0o600 });
        }
        keys.push(key);
    }
    return keys;
}

/** A kept image by its key, undefined when it isn't kept (a session from before, or from the terminal). */
export function readKept(dir: string, key: string): { mediaType: string; data: string } | undefined {
    if (!IMAGE_KEY.test(key)) return undefined;
    try {
        return { mediaType: TYPE[key.split(".")[1]!]!, data: readFileSync(join(dir, key)).toString("base64") };
    } catch {
        return undefined;
    }
}
