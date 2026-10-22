// What the composer attaches to a message, sorted the way the server will
// sort it: what a file is comes from its bytes (a PDF by its header, text by
// decoding as UTF-8 and not looking binary), not its name or MIME type, and
// anything over the caps is refused here with its reason, before it's sent.
// The server checks it all again.

import { ATTACH_LIMITS, LONG_PASTE, MEDIA_BUDGET, base64Size, type WireFile } from "@shared/protocol";
import { thumbnail } from "./thumbnail";

export type Attachment =
    | { kind: "image"; name: string; size: number; mediaType: string; data: string }
    | { kind: "text"; name: string; size: number; data: string; text: string; lines: number; pasted?: boolean }
    | { kind: "pdf"; name: string; size: number; data: string }
    | { kind: "refused"; name: string; size: number; reason: string };

const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp)$/;
const MAX_IMAGE = 15 * 1024 * 1024;
/** Everything in one message, images too, as base64 has to fit the server's 48 MB WebSocket messages. */
const MAX_MESSAGE = 32 * 1024 * 1024;

export function formatSize(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The same test as the server's (src/util/files.ts): a NUL, or many control characters. */
function looksBinary(buf: Uint8Array): boolean {
    const n = Math.min(buf.length, 8000);
    let suspicious = 0;
    for (let i = 0; i < n; i++) {
        const c = buf[i]!;
        if (c === 0) return true;
        if (c < 7 || (c > 13 && c < 32)) suspicious++;
    }
    return n > 0 && suspicious / n > 0.1;
}

function lineCount(text: string): number {
    if (!text) return 0;
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

type NativeBase64 = { toBase64?: (this: Uint8Array) => string };
const nativeFromBase64 = () => (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;

/**
 * Standard base64 with padding. WebKit's own (Uint8Array.prototype.toBase64,
 * Safari 18.2+) does a 5 MB screenshot in about 1 ms; the loop it falls back to
 * held the UI thread for ~60 ms (5 MB) to ~140 ms (12 MB).
 */
export function toBase64(bytes: Uint8Array): string {
    const native = (Uint8Array.prototype as NativeBase64).toBase64;
    if (native) return native.call(bytes);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

export function fromBase64(data: string): Uint8Array {
    const native = nativeFromBase64();
    if (native) return native(data);
    const s = atob(data);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

export type ImageAttachment = Extract<Attachment, { kind: "image" }>;
const dataUrl = (mediaType: string, data: string) => `data:${mediaType};base64,${data}`;
const previews = new WeakMap<ImageAttachment, Promise<string>>();
const preview = (thumb: Promise<string | undefined>, a: ImageAttachment) => thumb.then((t) => t ?? dataUrl(a.mediaType, a.data));

/**
 * What an attached image is shown as: a thumbnail (lib/thumbnail.ts), or the
 * image itself as a data: URL where none can be made. Made once per
 * attachment, in a worker, and dropped with it.
 */
export function previewOf(a: ImageAttachment): Promise<string> {
    let p = previews.get(a);
    if (!p) previews.set(a, (p = preview(thumbnail({ data: a.data, mediaType: a.mediaType }), a)));
    return p;
}

const isPdf = (b: Uint8Array) => b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d; // %PDF-

/** Bytes as a text file or a PDF, or refused with the reason. */
function fromBytes(name: string, bytes: Uint8Array, pasted = false): Attachment {
    const size = bytes.length;
    if (!pasted && isPdf(bytes)) {
        if (size > ATTACH_LIMITS.pdfBytes) return { kind: "refused", name, size, reason: `PDFs can be ${formatSize(ATTACH_LIMITS.pdfBytes)} at most` };
        return { kind: "pdf", name, size, data: toBase64(bytes) };
    }
    if (size > ATTACH_LIMITS.textBytes) return { kind: "refused", name, size, reason: `Text files can be ${formatSize(ATTACH_LIMITS.textBytes)} at most` };
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return { kind: "refused", name, size, reason: "Not a text file, PDF or image" };
    }
    if (looksBinary(bytes)) return { kind: "refused", name, size, reason: "Not a text file, PDF or image" };
    return { kind: "text", name, size, data: toBase64(bytes), text, lines: lineCount(text), ...(pasted ? { pasted: true } : {}) };
}

const sent = (list: readonly Attachment[]) => list.filter((a) => a.kind !== "refused");
const fileCount = (list: readonly Attachment[]) => list.filter((a) => a.kind === "text" || a.kind === "pdf").length;
const bytesOf = (list: readonly Attachment[], kinds: Attachment["kind"][]) => list.reduce((n, a) => (kinds.includes(a.kind) ? n + a.size : n), 0);

/** What else fits next to what's already attached, or why not. */
function overLimits(a: Attachment, list: readonly Attachment[]): string | undefined {
    if (a.kind === "refused") return undefined;
    if (a.kind !== "image" && fileCount(list) >= ATTACH_LIMITS.files) return `A message can carry ${ATTACH_LIMITS.files} files at most`;
    if (a.kind !== "image" && bytesOf(list, ["text", "pdf"]) + a.size > ATTACH_LIMITS.totalBytes) return `Files in one message can come to ${formatSize(ATTACH_LIMITS.totalBytes)} at most`;
    if ((a.kind === "image" || a.kind === "pdf") && bytesOf(list, ["image", "pdf"]) + a.size > MEDIA_BUDGET) return `PDFs and images in one message can come to ${formatSize(MEDIA_BUDGET)} at most`;
    if (bytesOf(sent(list), ["image", "text", "pdf"]) + a.size > MAX_MESSAGE) return "Too much attached for one message";
    return undefined;
}

/** A dropped, picked or pasted file, next to what's attached already. */
export async function readAttachment(f: File, list: readonly Attachment[]): Promise<Attachment> {
    try {
        return await sortFile(f, list);
    } catch {
        // A dropped folder, or a file that went away.
        return { kind: "refused", name: f.name || "file", size: f.size, reason: "Couldn't be read (a folder can't be attached)" };
    }
}

async function sortFile(f: File, list: readonly Attachment[]): Promise<Attachment> {
    const image = IMAGE_TYPE.test(f.type);
    const name = f.name || (image ? "pasted image" : "file");
    if (image) {
        if (f.size > MAX_IMAGE) return { kind: "refused", name, size: f.size, reason: `Images can be ${formatSize(MAX_IMAGE)} at most` };
        const bytes = new Uint8Array(await f.arrayBuffer());
        const data = toBase64(bytes);
        const a: ImageAttachment = { kind: "image", name, size: f.size, mediaType: f.type, data };
        const over = overLimits(a, list);
        if (over) return { kind: "refused", name, size: f.size, reason: over };
        // Made while the chip shows. From the bytes already read, not the file again: a dragged screenshot's file can be gone by now.
        previews.set(a, preview(thumbnail({ blob: new Blob([bytes as BlobPart], { type: f.type }), mediaType: f.type }), a));
        return a;
    }
    // Over every cap: refused without reading it.
    if (f.size > Math.max(ATTACH_LIMITS.pdfBytes, ATTACH_LIMITS.textBytes)) return { kind: "refused", name, size: f.size, reason: `Too large (text files up to ${formatSize(ATTACH_LIMITS.textBytes)}, PDFs up to ${formatSize(ATTACH_LIMITS.pdfBytes)})` };
    const a = fromBytes(name, new Uint8Array(await f.arrayBuffer()));
    const over = overLimits(a, list);
    return over ? { kind: "refused", name, size: a.size, reason: over } : a;
}

/** Long enough that it should be an attachment rather than fill the box. */
export function isLongPaste(text: string): boolean {
    return text.length > LONG_PASTE.chars || lineCount(text) > LONG_PASTE.lines;
}

export function pastedText(text: string, list: readonly Attachment[]): Attachment {
    const a = fromBytes("Pasted text", new TextEncoder().encode(text), true);
    const over = overLimits(a, list);
    return over ? { kind: "refused", name: a.name, size: a.size, reason: over } : a;
}

/** What the server hands back to the box (an edited or interrupted queued message). */
export function fromWire(images: { mediaType: string; data: string }[] | undefined, files: WireFile[] | undefined): Attachment[] {
    const out: Attachment[] = (images ?? []).map((i) => ({ kind: "image", name: "image", size: base64Size(i.data), mediaType: i.mediaType, data: i.data }));
    for (const f of files ?? []) out.push(fromBytes(f.name, fromBase64(f.data), f.pasted));
    return out;
}

/** The attachments of a `session.send`. Refused ones never go (and block sending until removed). */
export function toWire(list: readonly Attachment[]): { images?: { mediaType: string; data: string }[]; files?: WireFile[] } {
    const images = list.flatMap((a) => (a.kind === "image" ? [{ mediaType: a.mediaType, data: a.data }] : []));
    const files = list.flatMap((a): WireFile[] => (a.kind === "text" || a.kind === "pdf" ? [{ name: a.name, data: a.data, ...(a.kind === "text" && a.pasted ? { pasted: true } : {}) }] : []));
    return { ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) };
}

/** Why the message can't be sent as it is, if it can't. `readsImages`: false only for a model known to take none. */
export function blockedBy(list: readonly Attachment[], readsPdf: boolean, readsImages = true): string | undefined {
    if (list.some((a) => a.kind === "refused")) return "Remove the files that can't be attached to send this message.";
    // Each fit when it was added; together (messages handed back from the queue) they may not.
    if (fileCount(list) > ATTACH_LIMITS.files) return `A message can carry ${ATTACH_LIMITS.files} files at most. Remove ${fileCount(list) - ATTACH_LIMITS.files}.`;
    if (bytesOf(list, ["text", "pdf"]) > ATTACH_LIMITS.totalBytes) return `Files in one message can come to ${formatSize(ATTACH_LIMITS.totalBytes)} at most. Remove some.`;
    if (bytesOf(list, ["image", "pdf"]) > MEDIA_BUDGET) return `PDFs and images in one message can come to ${formatSize(MEDIA_BUDGET)} at most. Remove some.`;
    if (bytesOf(list, ["image", "text", "pdf"]) > MAX_MESSAGE) return "Too much attached for one message. Remove some.";
    if (!readsPdf && list.some((a) => a.kind === "pdf")) return "This model can't read PDFs. Remove the PDF, or pick a model that can.";
    if (!readsImages && list.some((a) => a.kind === "image")) return "This model can't read images. Remove the image, or pick a model that can.";
    return undefined;
}
