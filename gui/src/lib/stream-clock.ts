// What moves on screen moves on one clock: text coming out (lib/reveal.ts) and the server's updates going into the store
// (state/app.ts) happen in the same frame, about 20 times a second on any display, rather than each asking for a frame of
// its own. Waiting for the next step takes a timer, not a frame: a frame asked for on every refresh and then left empty
// still runs the page's whole pipeline, 120 times a second on a ProMotion display. What animates for as long as something
// waits is on the same grid (alignAnimations): each one out of step with the others is a window drawn again.

import { batch } from "solid-js";

/** How often. A word out sooner can't be seen; each step lays the column out, paints and draws the window. */
export const STEP_MS = 50;
/** The timer ends this much early and the step waits for the frame, so what it draws lands on the frame it's due. */
const FRAME_SLACK_MS = 12;

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

/** The next step of the grid at least half a step after `t`. */
const gridAfter = (t: number) => Math.ceil((t + STEP_MS / 2) / STEP_MS) * STEP_MS;

function arm() {
    if (timer !== undefined || frame || !due.size) return;
    const now = performance.now();
    const wait = now - last >= STEP_MS ? 0 : gridAfter(last) - FRAME_SLACK_MS - now;
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

/**
 * Holds what animates for good (stylesheets' `infinite` ones, each changing every STEP_MS or a multiple of it: steps()) to the
 * grid, by starting it on a step of it. Started anywhere, three of them mean three times the windows drawn.
 */
export function alignAnimations() {
    document.addEventListener("animationstart", (e) => {
        const target = e.target as Element;
        // One's own unless it's on a pseudo-element: a turn drawn again starts many short ones, and this runs for each.
        for (const a of target.getAnimations(e.pseudoElement ? { subtree: true } : undefined)) {
            if ((a as CSSAnimation).animationName !== e.animationName || a.effect?.getComputedTiming().iterations !== Infinity) continue;
            // Not started yet, as a rule, when this is told: it's starting now.
            const at = a.startTime ?? document.timeline.currentTime;
            if (typeof at === "number") a.startTime = Math.floor(at / STEP_MS) * STEP_MS;
        }
    }, true);
}
