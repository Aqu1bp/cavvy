// Images the transcript shows (see state/images.ts): each asked for once
// while it's kept, the most recently used kept, and a failed request never
// kept (so it's asked again next time). Keys say what makes an image the same
// image: a prompt's images by the hash of their bytes the server sends
// (positions are reused by a rewind, turn ids by a reopen); a file by its
// reply, not only its path (the model may rewrite the file between replies).

/** A prompt's images: the same key only for the same images (TurnPrompt.imagesKey). */
export function promptKey(sessionId: string, imagesKey: string): string {
    return `${sessionId}\0${imagesKey}`;
}

/**
 * The server's TurnPrompt.imagesKey for these images (imagesKey in
 * src/server/attachments.ts: SHA-256 over each one's media type, length and
 * base64, base64url, 32 characters), so a prompt's images can be kept as they
 * were sent instead of asked for again. Undefined without WebCrypto.
 */
export async function imagesKeyOf(images: readonly { mediaType: string; data: string }[]): Promise<string | undefined> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle || !images.length) return undefined;
    const enc = new TextEncoder();
    const parts = images.flatMap((i) => [enc.encode(`${i.mediaType}\0${i.data.length}\0`), enc.encode(i.data)]);
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        all.set(p, at);
        at += p.length;
    }
    try {
        const digest = new Uint8Array(await subtle.digest("SHA-256", all));
        return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 32);
    } catch {
        return undefined;
    }
}

export class ImageCache<T = string> {
    private entries = new Map<string, Promise<T[]>>();

    constructor(private max: number) {}

    get(key: string, load: () => Promise<T[]>): Promise<T[]> {
        const hit = this.entries.get(key);
        if (hit) {
            // Most recently used last: the first entry is the one to drop.
            this.entries.delete(key);
            this.entries.set(key, hit);
            return hit;
        }
        const p = load();
        this.entries.set(key, p);
        p.catch(() => {
            if (this.entries.get(key) === p) this.entries.delete(key);
        });
        while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
        return p;
    }

    get size(): number {
        return this.entries.size;
    }
}
