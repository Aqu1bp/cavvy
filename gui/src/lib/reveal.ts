// Streamed text arrives in bursts: a provider's chunks are a few characters
// to a few words, at uneven gaps. Shown as they come, a reply stutters: a
// line jumps forward, stalls, jumps again. createReveal lets the text out at
// an even pace instead, a word at a time, staying a moment behind what has
// arrived (about LAG_MS) so a pause in the stream is spread over the words
// before it. When the stream ends, the few words still waiting finish at the
// same pace. Text that isn't streaming, or that changed other than by
// growing, shows at once.

import { createComputed, createSignal, onCleanup, untrack, type Accessor } from "solid-js";

/** How far behind the stream the text runs: the backlog drains over about this long. */
const LAG_MS = 140;
/** The slowest pace, so the last words don't crawl in. */
const MIN_CHARS_PER_SECOND = 90;
/** A word longer than this (a URL, a path) is let out in pieces. */
const MAX_WORD = 16;
/** Far behind (a hidden window, a long burst): catch up at once. */
const MAX_BACKLOG = 4000;

/** Characters to let out after `dt` ms with `backlog` waiting, carrying the fraction to the next frame. */
export function revealStep(backlog: number, dt: number, carry: number): { chars: number; carry: number } {
    const budget = carry + Math.max((backlog * dt) / LAG_MS, (MIN_CHARS_PER_SECOND * dt) / 1000);
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
    const [shown, setShown] = createSignal(untrack(text));
    const [behind, setBehind] = createSignal(false);
    let target = untrack(text);
    let pos = target.length;
    let frame = 0;
    let last = 0;
    let carry = 0;
    const stop = () => {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        last = 0;
        carry = 0;
    };
    const tick = (now: number) => {
        frame = 0;
        const dt = last ? Math.min(64, now - last) : 16;
        last = now;
        const step = revealStep(target.length - pos, dt, carry);
        carry = step.carry;
        if (step.chars > 0) {
            pos = revealEnd(target, pos, step.chars);
            setShown(target.slice(0, pos));
        }
        if (pos < target.length) frame = requestAnimationFrame(tick);
        else {
            last = 0;
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
            stop();
            pos = t.length;
            setShown(t);
            setBehind(false);
            return;
        }
        if (pos < t.length && !frame) {
            frame = requestAnimationFrame(tick);
            setBehind(true);
        }
    });
    onCleanup(stop);
    return [shown, behind];
}
