// What streams on screen moves on one clock: text coming out (lib/reveal.ts) and the server's updates going into the
// store (state/app.ts) happen in the same frame, about 20 times a second on any display, rather than each asking for a
// frame of its own. Waiting for the next step takes a timer, not a frame: a frame asked for on every refresh and then
// left empty still runs the page's whole pipeline, 120 times a second on a ProMotion display.

import { batch } from "solid-js";

/** How often. A word out sooner can't be seen; each step lays the column out, paints and draws the window. */
export const STEP_MS = 50;
/** The timer ends this much early and the step waits for the frame, so it lands on the frame it's due. */
const FRAME_SLACK_MS = 4;

const due = new Set<(now: number) => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let frame = 0;
/** When the last step ran. Long ago, the next runs on the next frame: something that isn't streaming doesn't wait. */
let last = -Infinity;

function fire(now: number) {
    frame = 0;
    last = now;
    const fns = [...due];
    due.clear();
    batch(() => {
        for (const fn of fns) fn(now);
    });
    arm();
}

function arm() {
    if (timer !== undefined || frame || !due.size) return;
    const wait = STEP_MS - FRAME_SLACK_MS - (performance.now() - last);
    if (wait <= 0) frame = requestAnimationFrame(fire);
    else
        timer = setTimeout(() => {
            timer = undefined;
            if (due.size) frame = requestAnimationFrame(fire);
        }, wait);
}

/** Runs `fn` once, at the next step, in a batch with whatever else is due then. */
export function onStep(fn: (now: number) => void) {
    due.add(fn);
    arm();
}

/** `fn` won't run at the next step after all. */
export function offStep(fn: (now: number) => void) {
    due.delete(fn);
}
