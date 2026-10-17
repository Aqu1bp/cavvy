// Images the transcript shows, fetched once as data: URLs (the CSP allows
// data: and blob: images, nothing remote). A prompt's images come from the
// session by the turn's position; a reply's from files in the session's
// folders, which the server reads and checks are really images.

import type { Turn } from "@shared/protocol";
import { rpc } from "./app";

const prompts = new Map<string, Promise<string[]>>();
const files = new Map<string, Promise<string>>();
const MAX_FILES = 64;

/** The data: URLs of a prompt's images. Rejects when they're gone (the session file was cut). */
export function promptImages(sessionId: string, pos: NonNullable<Turn["pos"]>): Promise<string[]> {
    const key = `${sessionId}\0${pos.seg}\0${pos.index}`;
    let p = prompts.get(key);
    if (!p) {
        p = rpc.call("session.promptImages", { id: sessionId, seg: pos.seg, index: pos.index }).then((r) => r.images.map((i) => `data:${i.mediaType};base64,${i.data}`));
        p.catch(() => prompts.delete(key));
        prompts.set(key, p);
    }
    return p;
}

/** A file in the session's folders as a data: URL. */
export function fileImage(sessionId: string, path: string): Promise<string> {
    const key = `${sessionId}\0${path}`;
    let p = files.get(key);
    if (!p) {
        // The file may change (the model rewrites a mockup): only the most recent few are kept.
        if (files.size >= MAX_FILES) files.delete(files.keys().next().value!);
        p = rpc.call("fs.image", { sessionId, path }).then((r) => `data:${r.mediaType};base64,${r.data}`);
        p.catch(() => files.delete(key));
        files.set(key, p);
    }
    return p;
}
