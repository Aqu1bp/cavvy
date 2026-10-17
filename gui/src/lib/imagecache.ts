// Images the transcript shows, as data: URLs: each asked for once while it's
// kept, the most recently used kept, and a failed request never kept (so it's
// asked again next time). Keys say what makes an image the same image: a
// prompt's turn, not only its position (a rewind reuses positions); a file's
// reply, not only its path (the model may rewrite the file between replies).

/** A prompt's images: its turn and where its message is. */
export function promptKey(sessionId: string, turn: { id: string; pos: { seg: number; index: number } }): string {
    return `${sessionId}\0${turn.id}\0${turn.pos.seg}\0${turn.pos.index}`;
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
