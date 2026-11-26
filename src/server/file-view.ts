// The file viewer's reads (fs.read): a file inside the session's folders, never past them (a link out included), read
// as a regular file to a bound so a FIFO or a growing log can't hold the server.

import { relative } from "path";
import { imageMediaType, looksBinary, MAX_SHOWN_IMAGE, sniffImage } from "../util/files";
import { confinePath } from "./editors";
import { readRegular } from "./git-changes";
import { RpcError } from "./rpc-error";
import type { FileContent } from "./protocol";

/** The most text the viewer is sent: past it, it offers the editor. */
export const MAX_VIEW_TEXT = 4 * 1024 * 1024;

/** `path` (relative to `cwd`, or absolute) read for the viewer, if it's inside `roots` once links are followed. */
export async function readProjectFile(path: string, cwd: string, roots: string[]): Promise<FileContent> {
    const t = confinePath(path, cwd, roots);
    if (t.dir) throw new RpcError(`${path} is a folder`, "invalid");
    const rel = relative(cwd, t.path) || t.path;
    const named = { path: t.path, rel };
    // An image by its name is read as one (up to an image's size); judged by its bytes.
    const image = imageMediaType(t.real) !== undefined;
    const r = await readRegular(t.real, image ? MAX_SHOWN_IMAGE : MAX_VIEW_TEXT);
    if (r === null) throw new RpcError(`${path} doesn't exist`, "not_found");
    if (!r) throw new RpcError(`Can't read ${path}`, "invalid");
    if (!r.buf) return { ...named, size: r.size, kind: "large" };
    const mediaType = image ? sniffImage(r.buf) : undefined;
    if (mediaType) return { ...named, size: r.size, kind: "image", mediaType, data: r.buf.toString("base64") };
    if (r.size > MAX_VIEW_TEXT) return { ...named, size: r.size, kind: "large" };
    if (looksBinary(r.buf)) return { ...named, size: r.size, kind: "binary" };
    const text = r.buf.toString("utf8");
    return { ...named, size: r.size, kind: "text", text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
}
