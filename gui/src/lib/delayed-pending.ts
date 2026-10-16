/** Delayed feedback with a minimum visible lifetime; superseded waits are released. */
export class DelayedPending {
    private timer?: ReturnType<typeof setTimeout>;
    private shownAt?: number;
    private release?: () => void;

    constructor(private show: () => void, private now = () => performance.now()) {}

    start() {
        this.cancel();
        this.timer = setTimeout(() => {
            this.shownAt = this.now();
            this.show();
        }, 400);
    }

    finish(): Promise<void> {
        clearTimeout(this.timer);
        const remaining = this.shownAt === undefined ? 0 : Math.max(0, 400 - (this.now() - this.shownAt));
        if (!remaining) return Promise.resolve();
        return new Promise((resolve) => {
            this.release = resolve;
            this.timer = setTimeout(() => { this.release = undefined; resolve(); }, remaining);
        });
    }

    cancel() {
        clearTimeout(this.timer);
        this.release?.();
        this.release = undefined;
        this.shownAt = undefined;
    }
}
