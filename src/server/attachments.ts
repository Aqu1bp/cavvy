// Files sent with a message from the GUI. The composer already sorts and
// refuses them, but nothing it says is trusted here: what a file is comes
// from its bytes (not its name or MIME type), every cap is checked again,
// and anything wrong is an error back to the composer, never a silent drop.
// What can't go to the model inline (a .docx, a zip, text past the cap) is
// saved in the project for the model to open with its tools.

import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { ATTACH_LIMITS, type FileChip, type WireFile } from "./protocol";
import { RpcError } from "./rpc-error";
import { MEDIA_BUDGET, base64Size } from "../util/media";
import type { AttachedPart, FilePart, ImagePart } from "../providers/types";
import { formatBytes, isInside, looksBinary } from "../util/files";
import { redact } from "../util/redact";
import { imageSize } from "../ui/images";

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * A name fit to show the model: the last path component, without control,
 * zero-width or direction characters, quotes or angle brackets (so it can't
 * close a frame or start a line of its own), capped with its extension kept.
 */
export function sanitizeName(raw: string, fallback = "file"): string {
    // Redacted whole first: the split on slashes, cleanup and the cut below would each leave parts redact() can't match.
    let s = redact(raw).split(/[/\\]/).pop() ?? "";
    // eslint-disable-next-line no-control-regex
    s = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff"<>`]/g, "");
    s = s.replace(/\s+/g, " ").trim();
    // Cleanup can put a value back together (a zero-width character dropped from its middle): before the cut too.
    s = redact(s);
    if (s.length > ATTACH_LIMITS.nameChars) {
        const dot = s.lastIndexOf(".");
        const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : "";
        s = s.slice(0, ATTACH_LIMITS.nameChars - ext.length - 1) + "…" + ext;
    }
    return s || fallback;
}

function lineCount(text: string): number {
    if (!text) return 0;
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** Saves a file that can't go to the model inline, and says where it is. */
export type SaveFile = (name: string, bytes: Uint8Array) => string;

/** Where a session's saved files go: a folder of the project's own, which git leaves out. */
export function attachmentsDir(cwd: string): string {
    return join(cwd, ".cavvy", "attachments");
}

/**
 * Saves into the project (the session's folder, where its agent works and can read without asking, on whichever
 * machine runs it), a folder per file so two of the same name don't meet.
 */
export function fileSaver(cwd: string, session: string): SaveFile {
    return (name, bytes) => {
        const root = attachmentsDir(cwd);
        mkdirSync(root, { recursive: true });
        // A repository's own .cavvy can be a link out of it: saved only inside the project.
        if (!isInside(realpathSync(root), realpathSync(cwd))) throw new RpcError(`Couldn't save ${name} in this project: its .cavvy folder leads out of it.`);
        const ignore = join(root, ".gitignore");
        if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
        const dir = join(root, session.replace(/[^\w.-]/g, "_") || "session", `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, name === "." || name === ".." ? "file" : name);
        writeFileSync(file, bytes);
        return file;
    };
}

/**
 * The files of a `session.send`, checked: each one text (valid UTF-8 that
 * doesn't look binary, redacted like an @mention) or a PDF (by its header),
 * inline; anything else, or past their caps, saved by `save`. Throws an
 * RpcError naming the file when it can't be either. Model support is checked at send time.
 */
export function checkFiles(raw: unknown, save?: SaveFile): FilePart[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new RpcError("files must be a list");
    if (raw.length > ATTACH_LIMITS.files) throw new RpcError(`A message can carry ${ATTACH_LIMITS.files} files at most; this one has ${raw.length}.`);
    const out: FilePart[] = [];
    const toSave: { part: { path: string; name: string }; bytes: Uint8Array }[] = [];
    let total = 0;
    /** As kept: text redacted, which can make it longer (an edited message must fit again). */
    let stored = 0;
    const storedFits = () => {
        if (stored > ATTACH_LIMITS.totalBytes) throw new RpcError(`These files come to more than ${formatBytes(ATTACH_LIMITS.totalBytes)} once the secrets in them are redacted, the most one message can carry.`);
    };
    for (const f of raw as Partial<WireFile>[]) {
        if (typeof f?.name !== "string" || typeof f.data !== "string") throw new RpcError("Each file needs a name and its data");
        const pasted = f.pasted === true;
        const name = pasted ? "Pasted text" : sanitizeName(f.name);
        // Over every file's cap, don't even decode it.
        if (f.data.length > Math.ceil((ATTACH_LIMITS.totalBytes * 4) / 3) + 4) throw new RpcError(`${name} is too large to attach (files in one message can come to ${formatBytes(ATTACH_LIMITS.totalBytes)} at most).`);
        if (f.data.length % 4 !== 0 || !BASE64.test(f.data)) throw new RpcError(`${name} didn't arrive as base64`);
        const bytes = Buffer.from(f.data, "base64");
        total += bytes.length;
        stored += bytes.length;
        if (total > ATTACH_LIMITS.totalBytes) throw new RpcError(`These files come to more than ${formatBytes(ATTACH_LIMITS.totalBytes)}, the most one message can carry.`);
        /** Kept in the project rather than in the message (once all of them pass): `why` when there's nowhere to keep it. */
        const saved = (why: string, kept: Uint8Array = bytes, code?: string): FilePart => {
            if (!save) throw new RpcError(why, code);
            stored -= bytes.length;
            const part = { type: "file" as const, kind: "saved" as const, name: pasted ? "Pasted text.txt" : name, size: kept.length, path: "" };
            toSave.push({ part, bytes: kept });
            return part;
        };
        // Pasted text is text, whatever it starts with.
        if (!pasted && bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
            if (bytes.length > ATTACH_LIMITS.pdfBytes) {
                out.push(saved(`${name} is ${formatBytes(bytes.length)}; PDFs can be ${formatBytes(ATTACH_LIMITS.pdfBytes)} at most.`));
                continue;
            }
            storedFits();
            out.push({ type: "file", kind: "pdf", name, size: bytes.length, mediaType: "application/pdf", data: f.data });
            continue;
        }
        let text: string | undefined;
        try {
            text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
        } catch {
            text = undefined;
        }
        if (text === undefined || looksBinary(bytes)) {
            out.push(saved(`${name} isn't a text file or a PDF, so it can't be attached.`, bytes, "not_text"));
            continue;
        }
        // Redacted whether it's sent or saved: the model reads a saved one too.
        text = redact(text);
        // Stored redacted: what comes back to the box when it's edited must fit again.
        if (bytes.length > ATTACH_LIMITS.textBytes || Buffer.byteLength(text) > ATTACH_LIMITS.textBytes) {
            const why = bytes.length > ATTACH_LIMITS.textBytes ? `${name} is ${formatBytes(bytes.length)}; text files can be ${formatBytes(ATTACH_LIMITS.textBytes)} at most.` : `${name} is too large to attach once the secrets in it are redacted (text files can be ${formatBytes(ATTACH_LIMITS.textBytes)} at most).`;
            out.push(saved(why, Buffer.from(text, "utf-8")));
            continue;
        }
        stored += Buffer.byteLength(text) - bytes.length;
        storedFits();
        out.push({ type: "file", kind: "text", name, size: bytes.length, lines: lineCount(text), text, ...(pasted ? { pasted: true } : {}) });
    }
    for (const { part, bytes } of toSave) part.path = save!(part.name, bytes);
    return out;
}

/** Refuse oversized attachments early, before serializers have to leave any out. */
export function checkMedia(parts: readonly AttachedPart[]): void {
    const total = parts.reduce((n, p) => n + (p.type === "image" || p.kind === "pdf" ? base64Size(p.data) : 0), 0);
    if (total > MEDIA_BUDGET) throw new RpcError(`PDFs and images in one message can come to ${formatBytes(MEDIA_BUDGET)} at most. Remove some.`);
}

/** What a prompt shows of its files. */
export function fileChips(parts: readonly { type: string }[]): FileChip[] {
    return parts.flatMap((p) => {
        if (p.type !== "file") return [];
        const f = p as FilePart;
        return [{ name: f.name, kind: f.kind, size: f.size, ...(f.kind === "text" ? { lines: f.lines } : {}), ...(f.kind === "text" && f.pasted ? { pasted: true } : {}) }];
    });
}

/**
 * A turn prompt's attachment fields: how many images and what's in them
 * (imagesKey), which files. `keyed: false` leaves the key out, and the hash of
 * every image's bytes (~6 ms for a 12 MB screenshot) with it.
 */
export function attachedPrompt(parts: readonly { type: string }[] | undefined, keyed = true): { images?: number; imagesKey?: string; imageSizes?: [number, number][]; files?: FileChip[] } {
    const images = (parts ?? []).filter((p): p is ImagePart => p.type === "image");
    const files = fileChips(parts ?? []);
    return { ...(images.length ? { images: images.length, ...(keyed ? { imagesKey: imagesKey(images), imageSizes: images.map(shownSize) } : {}) } : {}), ...(files.length ? { files } : {}) };
}

/**
 * How much of an image to read for its header, in base64: most have it in
 * the first few bytes; a JPEG's can come after its EXIF data (at most 64 KB),
 * and only then is the rest read.
 */
const HEADERS_BASE64 = [4 * 1024, 96 * 1024, Infinity];

/** An image's width and height as it's shown (a JPEG turned as its EXIF says); 0, 0 when they can't be read. */
export function shownSize(i: { data: string }): [number, number] {
    for (const n of HEADERS_BASE64) {
        const b = Buffer.from(n < i.data.length ? i.data.slice(0, n) : i.data, "base64");
        const size = imageSize(b);
        if (size?.width && size.height) return turned(b) ? [size.height, size.width] : [size.width, size.height];
        if (n >= i.data.length) break;
    }
    return [0, 0];
}

/** A JPEG whose EXIF orientation is a quarter turn (5 to 8): shown with width and height swapped. */
function turned(b: Buffer): boolean {
    if (b[0] !== 0xff || b[1] !== 0xd8) return false;
    let i = 2;
    while (i + 4 <= b.length && b[i] === 0xff) {
        const m = b[i + 1]!;
        if (m === 0xda || m === 0xd9) return false;
        const len = b.readUInt16BE(i + 2);
        if (m === 0xe1 && b.toString("latin1", i + 4, i + 10) === "Exif\0\0") {
            const t = i + 10;
            if (t + 8 > b.length) return false;
            const le = b.toString("latin1", t, t + 2) === "II";
            const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
            const u32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
            const ifd = t + u32(t + 4);
            if (ifd + 2 > b.length) return false;
            for (let e = 0, n = u16(ifd); e < n; e++) {
                const at = ifd + 2 + e * 12;
                if (at + 10 > b.length) return false;
                if (u16(at) === 0x0112) return u16(at + 8) >= 5 && u16(at + 8) <= 8;
            }
            return false;
        }
        i += 2 + len;
    }
    return false;
}

/** The same for the same images, in the same order, and only then: what the GUI keeps fetched images by. */
function imagesKey(images: readonly ImagePart[]): string {
    const h = createHash("sha256");
    for (const i of images) h.update(`${i.mediaType}\0${i.data.length}\0`).update(i.data);
    return h.digest("base64url").slice(0, 32);
}

/** Attachments back to the input box, as the composer sends them. */
export function toWire(parts: readonly AttachedPart[] | undefined): { images?: { mediaType: string; data: string }[]; files?: WireFile[] } {
    const images = (parts ?? []).filter((p): p is ImagePart => p.type === "image").map((i) => ({ mediaType: i.mediaType, data: i.data }));
    const files = (parts ?? []).flatMap((p): WireFile[] => {
        if (p.type !== "file") return [];
        if (p.kind === "saved") {
            // Back from where it was saved; gone from there (the folder deleted), it can't come back.
            try {
                return [{ name: p.name, data: readFileSync(p.path).toString("base64") }];
            } catch {
                return [];
            }
        }
        const data = p.kind === "pdf" ? p.data : Buffer.from(p.text, "utf-8").toString("base64");
        return [{ name: p.name, data, ...(p.kind === "text" && p.pasted ? { pasted: true } : {}) }];
    });
    return { ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) };
}

/** A queued message's attachments in a few words, for the queue row. */
export function attachedLabel(parts: readonly AttachedPart[] | undefined): string {
    if (!parts?.length) return "";
    const names = parts.flatMap((p) => (p.type === "file" ? [p.name] : []));
    const images = parts.length - names.length;
    return [...names, ...(images ? [`${images} image${images === 1 ? "" : "s"}`] : [])].join(", ");
}
