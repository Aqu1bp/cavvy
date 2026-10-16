// What the composer attaches to a message, sorted the way the server will
// sort it: what a file is comes from its bytes (a PDF by its header, text by
// decoding as UTF-8 and not looking binary), not its name or MIME type, and
// anything over the caps is refused here with its reason, before it's sent.
// The server checks it all again.

import { ATTACH_LIMITS, LONG_PASTE, type WireFile } from "@shared/protocol";

export type Attachment =
    | { kind: "image"; name: string; size: number; mediaType: string; data: string; preview: string }
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

function toBase64(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

function fromBase64(data: string): Uint8Array {
    const s = atob(data);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
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
    let a: Attachment;
    if (image) {
        if (f.size > MAX_IMAGE) return { kind: "refused", name, size: f.size, reason: `Images can be ${formatSize(MAX_IMAGE)} at most` };
        const bytes = new Uint8Array(await f.arrayBuffer());
        a = { kind: "image", name, size: f.size, mediaType: f.type, data: toBase64(bytes), preview: URL.createObjectURL(f) };
    } else {
        // Over every cap: refused without reading it.
        if (f.size > Math.max(ATTACH_LIMITS.pdfBytes, ATTACH_LIMITS.textBytes)) return { kind: "refused", name, size: f.size, reason: `Too large (text files up to ${formatSize(ATTACH_LIMITS.textBytes)}, PDFs up to ${formatSize(ATTACH_LIMITS.pdfBytes)})` };
        a = fromBytes(name, new Uint8Array(await f.arrayBuffer()));
    }
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
    const out: Attachment[] = (images ?? []).map((i) => ({ kind: "image", name: "image", size: Math.floor((i.data.length * 3) / 4), mediaType: i.mediaType, data: i.data, preview: `data:${i.mediaType};base64,${i.data}` }));
    for (const f of files ?? []) out.push(fromBytes(f.name, fromBase64(f.data), f.pasted));
    return out;
}

/** The attachments of a `session.send`. Refused ones never go (and block sending until removed). */
export function toWire(list: readonly Attachment[]): { images?: { mediaType: string; data: string }[]; files?: WireFile[] } {
    const images = list.flatMap((a) => (a.kind === "image" ? [{ mediaType: a.mediaType, data: a.data }] : []));
    const files = list.flatMap((a): WireFile[] => (a.kind === "text" || a.kind === "pdf" ? [{ name: a.name, data: a.data, ...(a.kind === "text" && a.pasted ? { pasted: true } : {}) }] : []));
    return { ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) };
}

/** Why the message can't be sent as it is, if it can't. */
export function blockedBy(list: readonly Attachment[], readsPdf: boolean): string | undefined {
    if (list.some((a) => a.kind === "refused")) return "Remove the files that can't be attached to send this message.";
    // Each fit when it was added; together (messages handed back from the queue) they may not.
    if (fileCount(list) > ATTACH_LIMITS.files) return `A message can carry ${ATTACH_LIMITS.files} files at most. Remove ${fileCount(list) - ATTACH_LIMITS.files}.`;
    if (bytesOf(list, ["text", "pdf"]) > ATTACH_LIMITS.totalBytes) return `Files in one message can come to ${formatSize(ATTACH_LIMITS.totalBytes)} at most. Remove some.`;
    if (bytesOf(list, ["image", "text", "pdf"]) > MAX_MESSAGE) return "Too much attached for one message. Remove some.";
    if (!readsPdf && list.some((a) => a.kind === "pdf")) return "This model can't read PDFs. Remove the PDF, or pick a model that can.";
    return undefined;
}
