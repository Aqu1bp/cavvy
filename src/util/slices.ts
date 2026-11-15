// Work done a slice at a time on the server's thread (Find, the turn store, a first open's earlier turns), so that
// nothing else waits on it for long. Each yields when its slice is up; but two resumed in the same turn of the event
// loop ran their slices one after the other, and the thread was held for both (21-23 ms, a 100,000-item session's
// first open with Find straight after). They take turns here instead: one slice a turn of the event loop, in the
// order they asked.

const waiting: (() => void)[] = [];
let scheduled = false;

function next() {
    scheduled = false;
    const go = waiting.shift();
    if (waiting.length) {
        scheduled = true;
        setImmediate(next);
    }
    go?.();
}

/** The slice that's ending is over: the next one goes on in a later turn of the event loop, after others waiting. */
export function nextSlice(): Promise<void> {
    return new Promise((r) => {
        waiting.push(r);
        if (!scheduled) {
            scheduled = true;
            setImmediate(next);
        }
    });
}
