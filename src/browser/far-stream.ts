// The pace of a page's pictures when its pane is watched over a network (a session on a server). The stream's
// frames are lighter than the still (lower quality: page.ts FAR_QUALITY), so that the pane ends on the still
// matters here as it doesn't for a pane on the same machine:
//
// - Each frame of the stream is shown as it comes.
// - When frames stop, the still. Taking one makes Chrome send a frame of the stream too (measured with Chrome 157:
//   one, while the still is taken, every time), so one frame meanwhile isn't the page moving, and isn't shown over
//   the still; more than one is the page moving, and the still waits until it stops.
// - A still is looked at once more a moment later, and sent again only if it differs: a change that came with the
//   still's own frame isn't missed, and an unchanged page costs nothing more.

/** How long without a frame counts as the page having stopped moving. */
export const STOPPED_MS = 200;

export class FarStream<F> {
    private timer?: ReturnType<typeof setTimeout>;
    /** A still is being taken: the frames that come meanwhile, and the last of them. */
    private taking = false;
    private meanwhile = 0;
    private held?: F;
    /** The still the pane shows, by what tells one from another; none once a frame of the stream was shown over it. */
    private shown?: string;
    /** Each start and stop: what was under way before isn't shown after. */
    private run = 0;
    private stopped = true;

    constructor(
        private o: {
            /** Sends a picture to the pane. */
            show: (frame: F) => void;
            /** Takes the sharp still: the picture, and what tells it from another (its bytes). Undefined: there's none to be had now. */
            still: () => Promise<{ frame: F; key: string } | undefined>;
        },
    ) {}

    /** The stream began (or began again, at another size): a still soon, since a page at rest sends no frame for it. */
    start() {
        this.run++;
        this.stopped = false;
        this.shown = undefined;
        this.later();
    }

    stop() {
        this.run++;
        this.stopped = true;
        clearTimeout(this.timer);
        this.held = undefined;
    }

    /** A frame of the stream. */
    frame(f: F) {
        if (this.stopped) return;
        if (this.taking) {
            this.meanwhile++;
            this.held = f;
            return;
        }
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
        if (this.stopped || this.taking) return;
        const run = this.run;
        this.taking = true;
        this.meanwhile = 0;
        this.held = undefined;
        const still = await this.o.still().catch(() => undefined);
        this.taking = false;
        const held = this.held;
        this.held = undefined;
        if (run !== this.run) return;
        if (this.meanwhile > 1) {
            // The page moved while the still was taken: its newest frame, and another still once it stops.
            if (held !== undefined) this.o.show(held);
            this.shown = undefined;
            return this.later();
        }
        if (!still || still.key === this.shown) return;
        this.shown = still.key;
        this.o.show(still.frame);
        this.later();
    }
}
