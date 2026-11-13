// The pace of a page's pictures when its pane is watched over a network (a session on a server). The stream's
// frames are lighter than the still (lower quality: page.ts FAR_QUALITY), so that the pane ends on the still
// matters here as it doesn't for a pane on the same machine:
//
// - Each frame of the stream that shows something new is shown as it comes.
// - When frames stop, the still.
// - Taking a still makes Chrome send a frame of the stream too, while it's taken or a moment after. That frame is
//   the page as it already was: byte for byte the stream's last frame (measured with Chrome 157 on macOS and on
//   Linux: 24 of 24). So a frame with the bytes of the one before it shows nothing new and is passed over, whenever
//   it comes; any other is the page changing, and is shown, with another still to follow once it stops.

/** How long without a new frame counts as the page having stopped moving. */
export const STOPPED_MS = 200;

export class FarStream<F> {
    private timer?: ReturnType<typeof setTimeout>;
    /** What tells the stream's last frame from another (its bytes, hashed). */
    private last?: unknown;
    /** A still is being taken, and whether the page changed meanwhile. */
    private taking = false;
    private changed = false;
    /** The still the pane shows, by what tells one from another; none once a frame of the stream was shown over it. */
    private shown?: unknown;
    /** Each start and stop: what was under way before isn't shown after. */
    private run = 0;
    private stopped = true;

    constructor(
        private o: {
            /** Sends a picture to the pane. */
            show: (frame: F) => void;
            /** Takes the sharp still: the picture, and what tells it from another. Undefined: there's none to be had now. */
            still: () => Promise<{ frame: F; key: unknown } | undefined>;
        },
    ) {}

    /** The stream began (or began again, at another size): a still soon, since a page at rest sends no frame for it. */
    start() {
        this.run++;
        this.stopped = false;
        this.last = undefined;
        this.shown = undefined;
        this.later();
    }

    stop() {
        this.run++;
        this.stopped = true;
        clearTimeout(this.timer);
    }

    /** A frame of the stream, and what tells it from another. */
    frame(f: F, key: unknown) {
        if (this.stopped || key === this.last) return;
        this.last = key;
        this.changed = true;
        this.shown = undefined;
        this.o.show(f);
        this.later();
    }

    private later() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.settle(), STOPPED_MS);
        (this.timer as { unref?: () => void }).unref?.();
    }

    private async settle() {
        // One at a time: a still that's slow (a page busy, or held by a dialog) is waited for, and looked at again after.
        if (this.stopped) return;
        if (this.taking) return this.later();
        const run = this.run;
        this.taking = true;
        this.changed = false;
        const still = await this.o.still().catch(() => undefined);
        this.taking = false;
        // Stopped or started again meanwhile; or the page changed while it was taken, and its frame set the next one going.
        if (run !== this.run || this.changed || !still || still.key === this.shown) return;
        this.shown = still.key;
        this.o.show(still.frame);
    }
}
