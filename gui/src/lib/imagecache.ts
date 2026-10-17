// Images the transcript shows, as data: URLs: each asked for once while it's
// kept, the most recently used kept, and a failed request never kept (so it's
// asked again next time). Keys say what makes an image the same image: a
// prompt's images by the hash of their bytes the server sends (positions are
// reused by a rewind, turn ids by a reopen); a file by its reply, not only its
// path (the model may rewrite the file between replies).

/** A prompt's images: the same key only for the same images (TurnPrompt.imagesKey). */
export function promptKey(sessionId: string, imagesKey: string): string {
    return `${sessionId}\0${imagesKey}`;
}

export class ImageCache {
    private entries = new Map<string, Promise<string[]>>();

    constructor(private max: number) {}

    get(key: string, load: () => Promise<string[]>): Promise<string[]> {
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
