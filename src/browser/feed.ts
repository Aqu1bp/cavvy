// Only so many frames on their way to a viewer at once: one, unless told otherwise. Only a frame's matching
// acknowledgement makes room for the newest waiting frame.
// IDs never repeat, including after an unwatch/re-watch; delayed replies cannot release another subscription.
interface Viewer<F> {
    send(frame: F, frameId: string): void;
    outstanding: Set<string>;
    waiting?: F;
}

export class FrameFeed<F> {
    private viewers = new Map<object, Viewer<F>>();

    /**
     * `atOnce`: how many frames may be on their way to a viewer. More than one is for a viewer a network away,
     * where the next would otherwise wait out a round trip for the last one's acknowledgement.
     */
    constructor(private atOnce = 1) {}

    get size(): number { return this.viewers.size; }
    has(key: object): boolean { return this.viewers.has(key); }

    add(key: object, send: (frame: F, frameId: string) => void) {
        const existing = this.viewers.get(key);
        // Resizing is not a new subscription and must not reset backpressure.
        if (existing) existing.send = send;
        else this.viewers.set(key, { send, outstanding: new Set() });
    }

    remove(key: object) { this.viewers.delete(key); }

    push(frame: F) {
        for (const v of this.viewers.values()) {
            if (v.outstanding.size >= this.atOnce) v.waiting = frame;
            else this.deliver(v, frame);
        }
    }

    ack(key: object, frameId: string) {
        const v = this.viewers.get(key);
        if (!v || !v.outstanding.delete(frameId)) return;
        const frame = v.waiting;
        v.waiting = undefined;
        if (frame !== undefined) this.deliver(v, frame);
    }

    clearWaiting() {
        for (const v of this.viewers.values()) v.waiting = undefined;
    }

    private deliver(v: Viewer<F>, frame: F) {
        const id = crypto.randomUUID();
        v.outstanding.add(id);
        v.waiting = undefined;
        v.send(frame, id);
    }
}
