// Streamed text arrives in bursts: a provider's chunks are a few characters
// to a few words, at uneven gaps, and a fast model sends whole paragraphs at
// once. Shown as they come, a reply stutters: a line jumps forward, stalls,
// jumps again. createReveal lets the text out at an even pace instead, a word
// at a time: what has arrived is all out a moment after the last of it came
// (LAG_MS, or as long as the stream's bursts are apart, up to MAX_LAG_MS), at
// one speed over that time, so a burst sweeps in rather than landing whole and
// a pause in the stream is spread over the words before it. The lag is
// bounded, so a fast model still finishes fast. A block that starts while the
// reply streams comes out from its start, its first words in the step they
// arrive. When the stream ends, the few words still waiting come out in the next
// step: nothing follows them to keep a pace with. Text that isn't streaming, or
// that changed other than by growing, shows at once.

import { createComputed, createContext, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import { offStep, onStep, STEP_MS } from "./stream-clock";

/**
 * True while a transcript draws what it already had (a session opened, or switched back to): its text is shown as
 * far as it has come, not let out again from the start (which grew the reply, and moved the conversation, for the
 * moment it took). Text that starts after that comes out as it streams.
 */
export const DrawnAgain = createContext<() => boolean>(() => false);

/** How far behind the stream the text runs at least: what has arrived is out this long after the last of it came. */
export const LAG_MS = 90;
/**
 * At most. A stream that comes in bursts (a paragraph at a time) runs as far behind as its bursts are apart, up to
 * this: a burst sweeps in over the wait for the next rather than landing a few lines at once.
 */
export const MAX_LAG_MS = 300;

/** How far behind to run, given the gap between arrivals so far (smoothed): `gap` ms apart, out by the next. */
export function lagFor(gap: number | undefined): number {
    return Math.min(MAX_LAG_MS, Math.max(LAG_MS, gap ?? 0));
}

/** The gap between arrivals, smoothed: one long wait (a tool) counts as no more than twice the most lag. */
export function nextGap(gap: number | undefined, sample: number): number {
    const s = Math.min(sample, MAX_LAG_MS * 2);
    return gap === undefined ? s : gap * 0.7 + s * 0.3;
}
/** The slowest pace, so the last words don't crawl in. */
const MIN_CHARS_PER_SECOND = 90;
/** A word longer than this (a URL, a path) is let out in pieces. */
const MAX_WORD = 16;
/** Far behind (a hidden window, a long burst): catch up at once. */
const MAX_BACKLOG = 4000;
/** A block that starts while the reply streams comes out from its start, unless it already has this much (drawn again mid-reply). */
const MAX_FRESH = 1200;

/** Words not flowing for this long is a wait (a tool, a pause), not a gap between chunks. */
const FLOW_GAP_MS = 400;

/** Reveals with text still to let out: the transcript keeps gliding to its end until they're done. */
let pending = 0;
export const revealing = () => pending > 0;

let flowing = false;
/** Words are coming out, or were a moment ago (a gap between chunks): false once they wait (a tool, the reply's end). */
const [wordsFlowing, setWordsFlowing] = createSignal(false);
export { wordsFlowing };
let flowEnd: ReturnType<typeof setTimeout> | undefined;
/** `data-flowing` on the page while words come out: the open session's spinner holds still then (sidebar.css), the words say it's working. */
function markFlowing() {
    clearTimeout(flowEnd);
    if (pending > 0) {
        if (!flowing) globalThis.document?.documentElement?.setAttribute("data-flowing", "");
        flowing = true;
        setWordsFlowing(true);
    } else {
        flowEnd = setTimeout(() => {
            flowing = false;
            setWordsFlowing(false);
            globalThis.document?.documentElement?.removeAttribute("data-flowing");
        }, FLOW_GAP_MS);
    }
}

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

/**
 * The text to show, and whether some of it is still to come out (the reply reads as streaming until it has).
 * `again`: drawn again (DrawnAgain), so what has come shows at once.
 */
export function createReveal(text: Accessor<string>, streaming: Accessor<boolean>, again = false): [Accessor<string>, Accessor<boolean>] {
    let target = untrack(text);
    // New while the reply streams (not a block drawn again mid-reply): from its start, as the rest of it will come.
    const fresh = !again && untrack(streaming) && target.length <= MAX_FRESH && typeof requestAnimationFrame !== "undefined";
    let pos = fresh ? 0 : target.length;
    const [shown, setShown] = createSignal(target.slice(0, pos));
    const [behind, setBehind] = createSignal(false);
    let running = false;
    let last = 0;
    let carry = 0;
    /** When what has arrived should all be out (performance.now() ms). */
    let due = 0;
    /** When text last arrived, and the gap between arrivals so far (nextGap). */
    let arrived: number | undefined;
    let gap: number | undefined;
    const run = (on: boolean) => {
        if (on === running) return;
        running = on;
        pending += on ? 1 : -1;
        markFlowing();
        if (on) onStep(tick);
        else {
            offStep(tick);
            last = 0;
            carry = 0;
        }
    };
    const tick = (now: number) => {
        const dt = last ? Math.min(64, now - last) : STEP_MS;
        last = now;
        const step = revealStep(target.length - pos, dt, carry, due - now);
        carry = step.carry;
        if (step.chars > 0) {
            pos = revealEnd(target, pos, step.chars);
            setShown(target.slice(0, pos));
        }
        if (pos < target.length) onStep(tick);
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
        const draining = !live && running;
        if ((!live && !draining) || !grew || t.length - pos > MAX_BACKLOG || typeof requestAnimationFrame === "undefined" || document.hidden) {
            run(false);
            pos = t.length;
            setShown(t);
            setBehind(false);
            return;
        }
        if (pos < t.length) {
            // More came: all of it is out a moment from now, as far behind as the stream comes apart. No more to come:
            // what's left is out within the least lag.
            const now = performance.now();
            if (live) {
                if (arrived !== undefined) gap = nextGap(gap, now - arrived);
                arrived = now;
                due = now + lagFor(gap);
            } else due = Math.min(due, now + LAG_MS);
            setBehind(true);
            if (running) return;
            run(true);
            // Nothing was waiting: these are the first words, which don't wait for the next step.
            tick(now);
        }
    });
    onCleanup(() => run(false));
    return [shown, behind];
}
