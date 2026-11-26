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
    /** Each request, and its size once it's in (0 until then). */
    private entries = new Map<string, { p: Promise<T[]>; size: number }>();

    /**
     * Up to `max` entries and, with `sizeOf`, `maxSize` in all (the most recent one is kept even when it alone is
     * over), the least recently used dropped first.
     */
    constructor(private max: number, private maxSize = Infinity, private sizeOf?: (value: T) => number) {}

    get(key: string, load: () => Promise<T[]>): Promise<T[]> {
        const all = this.entries;
        const hit = all.get(key);
        if (hit) {
            // Most recently used last: the first entry is the one to drop.
            all.delete(key);
            all.set(key, hit);
            return hit.p;
        }
        const p = load();
        const entry = { p, size: 0 };
        all.set(key, entry);
        p.then(
            (values) => {
                if (all.get(key) !== entry || !this.sizeOf) return;
                for (const v of values) entry.size += this.sizeOf(v);
                this.trim();
            },
            () => all.get(key) === entry && all.delete(key),
        );
        this.trim();
        return p;
    }

    /** What's kept for `key`, without making it the most recent. */
    peek(key: string): Promise<T[]> | undefined {
        return this.entries.get(key)?.p;
    }

    get size(): number {
        return this.entries.size;
    }

    /**
     * Drops the least recently used past the limits, never the most recently used (an older one whose load ends late
     * goes before the newer ones, as it would have had it come in time).
     */
    private trim() {
        const all = this.entries;
        let total = 0;
        for (const e of all.values()) total += e.size;
        let left = all.size;
        for (const [key, e] of all) {
            if (--left === 0 || (all.size <= this.max && total <= this.maxSize)) return;
            all.delete(key);
            total -= e.size;
        }
    }
}
