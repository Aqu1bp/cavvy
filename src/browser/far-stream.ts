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
// - A page that never stops (a spinner, a video, a carousel) would never get its still, and stay soft for good. For
//   a pane that asks (`steady`), a still is sent every so often while frames keep coming by themselves: the pane
//   keeps it under the stream, and lays over it only the part of each frame that changed (BrowserPane.tsx). Not
//   while the user moves the page (scrolling, typing): the whole picture changes then, and the still when it stops
//   is the one that counts.

/** How long without a new frame counts as the page having stopped moving. */
export const STOPPED_MS = 200;
/** How often a page that keeps changing by itself gets a still, and how long after the user's input it gets none. */
export const STEADY_MS = 1000;
export const MOVED_MS = 500;

/** Which still a picture is: the page at rest (1), or as it was a moment ago while it goes on changing (2). */
export type Still = 1 | 2;

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
    /** When the frames now coming began (after a pause), when a still was last taken, and when the user last moved the page. */
    private since = 0;
    private stillAt = 0;
    private movedAt = 0;
    private waiting = false;

    constructor(
        private o: {
            /** Sends a picture to the pane. `still`: it's a sharp one, and which. */
            show: (frame: F, still?: Still) => void;
            /** Takes the sharp still: the picture, and what tells it from another. Undefined: there's none to be had now. */
            still: () => Promise<{ frame: F; key: unknown } | undefined>;
            /** The pane keeps a still under the stream: one is sent now and then while the page keeps changing by itself. */
            steady?: boolean;
            now?: () => number;
        },
    ) {}

    /** The stream began (or began again, at another size): a still soon, since a page at rest sends no frame for it. */
    start() {
        this.run++;
        this.stopped = false;
        this.last = undefined;
        this.shown = undefined;
        // What comes from here on is counted from here.
        this.since = this.now();
        this.later();
    }

    stop() {
        this.run++;
        this.stopped = true;
        this.waiting = false;
        clearTimeout(this.timer);
    }

    /** The user moved the page (scrolled, typed, pressed): what changes for a while is their doing. */
    moved() {
        this.movedAt = this.now();
    }

    private now(): number {
        return this.o.now?.() ?? Date.now();
    }

    /** A frame of the stream, and what tells it from another. */
    frame(f: F, key: unknown) {
        if (this.stopped || key === this.last) return;
        this.last = key;
        this.changed = true;
        this.shown = undefined;
        this.o.show(f);
        const now = this.now();
        // The first after a pause: frames have kept coming since now.
        if (!this.waiting) this.since = now;
        this.later();
        // It has gone on changing by itself for a while: a still under what changes.
        if (this.o.steady && !this.taking && now - Math.max(this.since, this.stillAt) >= STEADY_MS && now - this.movedAt >= MOVED_MS) void this.settle(true);
    }

    private later() {
        clearTimeout(this.timer);
        this.waiting = true;
        this.timer = setTimeout(() => ((this.waiting = false), void this.settle()), STOPPED_MS);
        (this.timer as { unref?: () => void }).unref?.();
    }

    /** `steady`: taken while frames keep coming, not because they stopped. */
    private async settle(steady = false) {
        // One at a time: a still that's slow (a page busy, or held by a dialog) is waited for, and looked at again after.
        if (this.stopped) return;
        if (this.taking) return steady ? undefined : this.later();
        const run = this.run;
        this.taking = true;
        this.changed = false;
        const still = await this.o.still().catch(() => undefined);
        this.taking = false;
        this.stillAt = this.now();
        // Stopped or started again meanwhile.
        if (run !== this.run || !still) return;
        // The page changed while it was taken, and its frame set the next one going. One that keeps changing by itself
        // gets this one all the same, as the page a moment ago: the pane lays what changes over it.
        if (this.changed) return void (steady && this.now() - this.movedAt >= MOVED_MS && this.o.show(still.frame, 2));
        if (still.key === this.shown) return;
        this.shown = still.key;
        this.o.show(still.frame, 1);
    }
}
