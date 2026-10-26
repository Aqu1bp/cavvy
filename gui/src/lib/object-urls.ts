// Object URLs with more than one user. A reply's image URLs are its own and
// are revoked when it goes (state/images.ts), but the image viewer can still
// be showing them then (a session switched from the palette over it, an
// interim reply folded away): it holds them while it's open, and a URL
// dropped meanwhile is revoked when the last hold on it ends.

export class UrlLeases {
    private holds = new Map<string, number>();
    private dropped = new Set<string>();

    constructor(private revoke: (url: string) => void = (url) => URL.revokeObjectURL(url)) {}

    /** Its owner is done with it: revoked now, or once nothing holds it. */
    drop(url: string): void {
        if (this.holds.has(url)) this.dropped.add(url);
        else this.revoke(url);
    }

    /** Keeps these past their owner's drop until the returned release is called (once; again does nothing). */
    hold(urls: Iterable<string>): () => void {
        const held = new Set(urls);
        for (const url of held) this.holds.set(url, (this.holds.get(url) ?? 0) + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            for (const url of held) {
                const n = this.holds.get(url)! - 1;
                if (n > 0) {
                    this.holds.set(url, n);
                    continue;
                }
                this.holds.delete(url);
                if (this.dropped.delete(url)) this.revoke(url);
            }
        };
    }
}
