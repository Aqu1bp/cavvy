// One outstanding frame per viewer. Only its matching acknowledgement releases the newest waiting frame.
// IDs never repeat, including after an unwatch/re-watch; delayed replies cannot release another subscription.
interface Viewer<F> {
    send(frame: F, frameId: string): void;
    outstanding?: string;
    waiting?: F;
}

export class FrameFeed<F> {
    private viewers = new Map<object, Viewer<F>>();

    get size(): number { return this.viewers.size; }
    has(key: object): boolean { return this.viewers.has(key); }

    add(key: object, send: (frame: F, frameId: string) => void) {
        const existing = this.viewers.get(key);
        // Resizing is not a new subscription and must not reset backpressure.
        if (existing) existing.send = send;
        else this.viewers.set(key, { send });
    }

    remove(key: object) { this.viewers.delete(key); }

    push(frame: F) {
        for (const v of this.viewers.values()) {
            if (v.outstanding !== undefined) v.waiting = frame;
            else this.deliver(v, frame);
        }
    }

    ack(key: object, frameId: string) {
        const v = this.viewers.get(key);
        if (!v || v.outstanding !== frameId) return;
        v.outstanding = undefined;
        const frame = v.waiting;
        v.waiting = undefined;
        if (frame !== undefined) this.deliver(v, frame);
    }

    clearWaiting() {
        for (const v of this.viewers.values()) v.waiting = undefined;
    }

    private deliver(v: Viewer<F>, frame: F) {
        v.outstanding = crypto.randomUUID();
        v.waiting = undefined;
        v.send(frame, v.outstanding);
    }
}
