// A person's input for one tab: in order, one dispatch at a time. Pointer moves and wheel turns that arrive while one is
// being dispatched merge into the next. Chrome answers a wheel only once the page has handled it, and a page with a wheel
// listener or a busy main thread takes a frame or more for each; sent as they come, they would queue in Chrome, and the
// page would fall further behind the person's hand the longer they scrolled. Merged, the page gets the latest position
// and the summed distance, so it ends where the hand did, as soon as it can take it.

import type { BrowserInput } from "../server/protocol";

interface Waiting {
    input: BrowserInput;
    done: (() => void)[];
}

export class InputQueue {
    private waiting: Waiting[] = [];
    private running = false;

    constructor(private dispatch: (input: BrowserInput) => Promise<void>) {}

    /** Settles once the input (or the merged one it went into) has been dispatched, or failed to be. */
    push(input: BrowserInput): Promise<void> {
        return new Promise((resolve) => {
            const last = this.waiting.at(-1);
            const merged = last && mergeInput(last.input, input);
            if (last && merged) {
                last.input = merged;
                last.done.push(resolve);
            } else this.waiting.push({ input, done: [resolve] });
            if (!this.running) void this.run();
        });
    }

    private async run() {
        this.running = true;
        while (this.waiting.length) {
            const next = this.waiting.shift()!;
            try {
                await this.dispatch(next.input);
            } catch {
                // a page that has crashed or closed takes no input
            }
            for (const done of next.done) done();
        }
        this.running = false;
    }
}

/** `b` folded into `a` when it can stand for both (wheel turns summed, a move replaced by a later one); else undefined. */
export function mergeInput(a: BrowserInput, b: BrowserInput): BrowserInput | undefined {
    if (a.kind === "wheel" && b.kind === "wheel" && (a.modifiers ?? 0) === (b.modifiers ?? 0)) return { ...b, deltaX: a.deltaX + b.deltaX, deltaY: a.deltaY + b.deltaY };
    if (a.kind === "mouse" && b.kind === "mouse" && a.type === "move" && b.type === "move" && (a.buttons ?? 0) === (b.buttons ?? 0) && a.button === b.button && (a.modifiers ?? 0) === (b.modifiers ?? 0)) return b;
    return undefined;
}
