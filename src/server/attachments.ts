// Files sent with a message from the GUI. The composer already sorts and
// refuses them, but nothing it says is trusted here: what a file is comes
// from its bytes (not its name or MIME type), every cap is checked again,
// and anything wrong is an error back to the composer, never a silent drop.

import { ATTACH_LIMITS, type FileChip, type WireFile } from "./protocol";
import { RpcError } from "./rpc-error";
import { readsPdf } from "../providers/files";
import type { AttachedPart, FilePart, ImagePart, ModelInfo } from "../providers/types";
import { formatBytes, looksBinary } from "../util/files";
import { redact } from "../util/redact";

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * A name fit to show the model: the last path component, without control,
 * zero-width or direction characters, quotes or angle brackets (so it can't
 * close a frame or start a line of its own), capped with its extension kept.
 */
export function sanitizeName(raw: string, fallback = "file"): string {
    let s = raw.split(/[/\\]/).pop() ?? "";
    // eslint-disable-next-line no-control-regex
    s = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff"<>`]/g, "");
    s = s.replace(/\s+/g, " ").trim();
    if (s.length > ATTACH_LIMITS.nameChars) {
        const dot = s.lastIndexOf(".");
        const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : "";
        s = s.slice(0, ATTACH_LIMITS.nameChars - ext.length - 1) + "…" + ext;
    }
    return redact(s) || fallback;
}

function lineCount(text: string): number {
    if (!text) return 0;
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/**
 * The files of a `session.send`, checked: each one text (valid UTF-8 that
 * doesn't look binary, redacted like an @mention) or a PDF (by its header,
 * to a model that reads PDFs). Throws an RpcError naming the file otherwise.
 */
export function checkFiles(raw: unknown, model: ModelInfo | undefined): FilePart[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new RpcError("files must be a list");
    if (raw.length > ATTACH_LIMITS.files) throw new RpcError(`A message can carry ${ATTACH_LIMITS.files} files at most; this one has ${raw.length}.`);
    const out: FilePart[] = [];
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
        // Over the largest cap, don't even decode it.
        if (f.data.length > Math.ceil((ATTACH_LIMITS.pdfBytes * 4) / 3) + 4) throw new RpcError(`${name} is too large to attach (PDFs up to ${formatBytes(ATTACH_LIMITS.pdfBytes)}, text files up to ${formatBytes(ATTACH_LIMITS.textBytes)}).`);
        if (f.data.length % 4 !== 0 || !BASE64.test(f.data)) throw new RpcError(`${name} didn't arrive as base64`);
        const bytes = Buffer.from(f.data, "base64");
        total += bytes.length;
        stored += bytes.length;
        if (total > ATTACH_LIMITS.totalBytes) throw new RpcError(`These files come to more than ${formatBytes(ATTACH_LIMITS.totalBytes)}, the most one message can carry.`);
        // Pasted text is text, whatever it starts with.
        if (!pasted && bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
            if (bytes.length > ATTACH_LIMITS.pdfBytes) throw new RpcError(`${name} is ${formatBytes(bytes.length)}; PDFs can be ${formatBytes(ATTACH_LIMITS.pdfBytes)} at most.`);
            if (model && !readsPdf(model)) throw new RpcError(`${model.name ?? model.id} can't read PDFs. Remove ${name}, or switch to a model that can.`, "pdf_unsupported");
            storedFits();
            out.push({ type: "file", kind: "pdf", name, size: bytes.length, mediaType: "application/pdf", data: f.data });
            continue;
        }
        if (bytes.length > ATTACH_LIMITS.textBytes) throw new RpcError(`${name} is ${formatBytes(bytes.length)}; text files can be ${formatBytes(ATTACH_LIMITS.textBytes)} at most.`);
        let text: string;
        try {
            text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
        } catch {
            throw new RpcError(`${name} isn't a text file or a PDF, so it can't be attached.`, "not_text");
        }
        if (looksBinary(bytes)) throw new RpcError(`${name} isn't a text file or a PDF, so it can't be attached.`, "not_text");
        text = redact(text);
        // Stored redacted: what comes back to the box when it's edited must fit again.
        if (Buffer.byteLength(text) > ATTACH_LIMITS.textBytes) throw new RpcError(`${name} is too large to attach once the secrets in it are redacted (text files can be ${formatBytes(ATTACH_LIMITS.textBytes)} at most).`);
        stored += Buffer.byteLength(text) - bytes.length;
        storedFits();
        out.push({ type: "file", kind: "text", name, size: bytes.length, lines: lineCount(text), text, ...(pasted ? { pasted: true } : {}) });
    }
    return out;
}

/** What a prompt shows of its files. */
export function fileChips(parts: readonly { type: string }[]): FileChip[] {
    return parts.flatMap((p) => {
        if (p.type !== "file") return [];
        const f = p as FilePart;
        return [{ name: f.name, kind: f.kind, size: f.size, ...(f.kind === "text" ? { lines: f.lines } : {}), ...(f.kind === "text" && f.pasted ? { pasted: true } : {}) }];
    });
}

/** A turn prompt's attachment fields: how many images, which files. */
export function attachedPrompt(parts: readonly { type: string }[] | undefined): { images?: number; files?: FileChip[] } {
    const images = (parts ?? []).filter((p) => p.type === "image").length;
    const files = fileChips(parts ?? []);
    return { ...(images ? { images } : {}), ...(files.length ? { files } : {}) };
}

/** Attachments back to the input box, as the composer sends them. */
export function toWire(parts: readonly AttachedPart[] | undefined): { images?: { mediaType: string; data: string }[]; files?: WireFile[] } {
    const images = (parts ?? []).filter((p): p is ImagePart => p.type === "image").map((i) => ({ mediaType: i.mediaType, data: i.data }));
    const files = (parts ?? []).flatMap((p): WireFile[] => {
        if (p.type !== "file") return [];
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
