// Frames of a page on their way to the windows watching it. A window that hasn't taken the last frame yet is
// sent nothing: the newest frame waits for it, replacing whatever waited before, so a slow window never builds a
// backlog and always gets the latest picture when it catches up.

/** A window that doesn't answer in this long is sent frames again: its answer may have been lost. */
export const ACK_TIMEOUT_MS = 3000;

interface Viewer<F> {
    send(frame: F): void;
    busySince?: number;
    waiting?: F;
}

export class FrameFeed<F> {
    private viewers = new Map<object, Viewer<F>>();

    constructor(private now: () => number = Date.now) {}

    get size(): number {
        return this.viewers.size;
    }

    has(key: object): boolean {
        return this.viewers.has(key);
    }

    add(key: object, send: (frame: F) => void) {
        this.viewers.set(key, { send });
    }

    remove(key: object) {
        this.viewers.delete(key);
    }

    /** A new frame: to each viewer that is free, and held for the rest. */
    push(frame: F) {
        for (const v of this.viewers.values()) {
            if (v.busySince !== undefined && this.now() - v.busySince < ACK_TIMEOUT_MS) v.waiting = frame;
            else this.deliver(v, frame);
        }
    }

    /** The viewer drew its last frame: the one that waited goes now. */
    ack(key: object) {
        const v = this.viewers.get(key);
        if (!v) return;
        v.busySince = undefined;
        const frame = v.waiting;
        v.waiting = undefined;
        if (frame !== undefined) this.deliver(v, frame);
    }

    /** The window shows another page now: what waited for it is out of date, and what it has is too. */
    clearWaiting() {
        for (const v of this.viewers.values()) v.waiting = undefined;
    }

    private deliver(v: Viewer<F>, frame: F) {
        v.busySince = this.now();
        v.waiting = undefined;
        v.send(frame);
    }
}
