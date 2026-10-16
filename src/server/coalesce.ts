// One run per key at a time, without losing a request that comes in while
// one runs. Shared with the GUI, so it must stay pure TypeScript.

export interface Slot<T> {
    running: Promise<T>;
    /** The run after this one, for everyone who asked while it was going. */
    queued?: Promise<T>;
}

/**
 * The result of a run that starts no earlier than this call. Callers while
 * none is running start one; callers while one is running share a single
 * run after it, so they see whatever changed while the first was underway.
 */
export function coalesce<T>(slots: Map<string, Slot<T>>, key: string, run: () => Promise<T>): Promise<T> {
    const slot = slots.get(key);
    if (!slot) return start(slots, key, run);
    const settled = slot.running.then(
        () => undefined,
        () => undefined,
    );
    slot.queued ??= settled.then(() => start(slots, key, run));
    return slot.queued;
}

function start<T>(slots: Map<string, Slot<T>>, key: string, run: () => Promise<T>): Promise<T> {
    const slot: Slot<T> = { running: run() };
    slots.set(key, slot);
    const done = () => {
        // A queued run takes the key over itself when it starts.
        if (slots.get(key) === slot && !slot.queued) slots.delete(key);
    };
    slot.running.then(done, done);
    return slot.running;
}
