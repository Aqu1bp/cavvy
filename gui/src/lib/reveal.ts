// Streamed text arrives in bursts: a provider's chunks are a few characters
// to a few words, at uneven gaps, and a fast model sends whole paragraphs at
// once. Shown as they come, a reply stutters: a line jumps forward, stalls,
// jumps again. createReveal lets the text out at an even pace instead, a word
// at a time: what has arrived is all out LAG_MS after the last of it came, at
// one speed over that time, so a burst sweeps in rather than landing whole and
// a pause in the stream is spread over the words before it. The lag is
// bounded, so a fast model still finishes fast. A block that starts while the
// reply streams comes out from its start. When the stream ends, the few words
// still waiting finish at the same pace. Text that isn't streaming, or that
// changed other than by growing, shows at once.

import { createComputed, createSignal, onCleanup, untrack, type Accessor } from "solid-js";

/** How far behind the stream the text runs at most: what has arrived is out this long after the last of it came. */
export const LAG_MS = 180;
/** The slowest pace, so the last words don't crawl in. */
const MIN_CHARS_PER_SECOND = 90;
/** A word longer than this (a URL, a path) is let out in pieces. */
const MAX_WORD = 16;
/** Far behind (a hidden window, a long burst): catch up at once. */
const MAX_BACKLOG = 4000;
/** A block that starts while the reply streams comes out from its start, unless it already has this much (drawn again mid-reply). */
const MAX_FRESH = 1200;

/** Reveals with text still to let out: the transcript keeps gliding to its end until they're done. */
let pending = 0;
export const revealing = () => pending > 0;

/**
 * Characters to let out after `dt` ms with `backlog` waiting and `left` ms until all of it should be out,
 * carrying the fraction to the next frame: an even share of what's left of the time, so a burst comes out at one
 * speed rather than fast and then crawling.
 */
export function revealStep(backlog: number, dt: number, carry: number, left: number): { chars: number; carry: number } {
    const budget = carry + Math.max((backlog * dt) / Math.max(dt, left), (MIN_CHARS_PER_SECOND * dt) / 1000);
    const chars = Math.min(backlog, Math.floor(budget));
    return { chars, carry: chars >= backlog ? 0 : budget - chars };
}

/** Where to stop after letting out about `n` more characters from `pos`: the end of a word. */
export function revealEnd(text: string, pos: number, n: number): number {
    let end = Math.min(text.length, pos + n);
    for (let k = 0; k < MAX_WORD && end < text.length && !/\s/.test(text[end]!); k++) end++;
    return end;
}

/** The text to show, and whether some of it is still to come out (the reply reads as streaming until it has). */
export function createReveal(text: Accessor<string>, streaming: Accessor<boolean>): [Accessor<string>, Accessor<boolean>] {
    let target = untrack(text);
    // New while the reply streams (not a block drawn again mid-reply): from its start, as the rest of it will come.
    const fresh = untrack(streaming) && target.length <= MAX_FRESH && typeof requestAnimationFrame !== "undefined";
    let pos = fresh ? 0 : target.length;
    const [shown, setShown] = createSignal(target.slice(0, pos));
    const [behind, setBehind] = createSignal(false);
    let frame = 0;
    let last = 0;
    let carry = 0;
    /** When what has arrived should all be out (performance.now() ms). */
    let due = 0;
    const run = (on: boolean) => {
        if (on === (frame !== 0)) return;
        pending += on ? 1 : -1;
        if (on) frame = requestAnimationFrame(tick);
        else {
            cancelAnimationFrame(frame);
            frame = 0;
            last = 0;
            carry = 0;
        }
    };
    const tick = (now: number) => {
        const dt = last ? Math.min(64, now - last) : 16;
        last = now;
        const step = revealStep(target.length - pos, dt, carry, due - now);
        carry = step.carry;
        if (step.chars > 0) {
            pos = revealEnd(target, pos, step.chars);
            setShown(target.slice(0, pos));
        }
        if (pos < target.length) frame = requestAnimationFrame(tick);
        else {
            run(false);
            setBehind(false);
        }
    };
    createComputed(() => {
        const t = text();
        const live = streaming();
        target = t;
        const grew = t.length >= pos && t.startsWith(untrack(shown));
        // When the stream ends mid-burst, what's left still comes out at the same pace (a moment).
        const draining = !live && frame !== 0;
        if ((!live && !draining) || !grew || t.length - pos > MAX_BACKLOG || typeof requestAnimationFrame === "undefined" || document.hidden) {
            run(false);
            pos = t.length;
            setShown(t);
            setBehind(false);
            return;
        }
        if (pos < t.length) {
            // More came: all of it is out a moment from now.
            if (live) due = performance.now() + LAG_MS;
            run(true);
            setBehind(true);
        }
    });
    onCleanup(() => run(false));
    return [shown, behind];
}
