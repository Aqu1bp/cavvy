// A streaming reply comes out a block at a time: each paragraph, list, table or code block is shown once it's
// finished (a blank line after it), whole, and the ink trail brings it in (lib/stream-dom.ts: what's new is drawn
// lighter, then darkens). Code, and a block that's still being written after a moment (a long list), come out a
// line at a time instead, so nothing long waits unseen. Text that isn't streaming, or that changed other than by
// growing, shows at once.
//
// Word by word, the block being written was laid out, painted and its Markdown rendered again about 20 times a
// second. A block at a time, the same reply (headless Chromium, the mock's long reply at 80 tokens a second): 715
// paints -> 151, 247 layouts -> 79, 202 ms of script -> 113.

import { createComputed, createContext, createSignal, onCleanup, untrack, type Accessor } from "solid-js";

/**
 * True while a transcript draws what it already had (a session opened, or switched back to): its text is shown as
 * far as it has come at once. Text that starts after that comes out as it streams.
 */
export const DrawnAgain = createContext<() => boolean>(() => false);

/** Replies still streaming: the transcript keeps gliding to its end until they're done. */
let pending = 0;
export const revealing = () => pending > 0;

let flowing = false;
/** Words are coming out, or were a moment ago (a gap between chunks): false once they wait (a tool, the reply's end). */
const [wordsFlowing, setWordsFlowing] = createSignal(false);
export { wordsFlowing };
let flowEnd: ReturnType<typeof setTimeout> | undefined;
/** Words not flowing for this long is a wait (a tool, a pause), not a gap between chunks. */
const FLOW_GAP_MS = 400;

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

/** A block that's taken this long without being finished comes out a line at a time from then on (a long list, say). */
export const BLOCK_WAIT_MS = 1200;

/** A code fence's opening line: code comes out a line at a time from its start. */
const FENCE_START = /^ {0,3}(?:`{3,}|~{3,})/;

/**
 * The text to show while a reply streams a block at a time: as far as its last finished block (a blank line after
 * it), each new one whole at once (the ink trail brings it in: lib/stream-dom.ts). Code, and a block still being
 * written after BLOCK_WAIT_MS, come out a line at a time instead, so nothing long waits unseen. Not streaming: all
 * of it.
 */
export function createBlocks(text: Accessor<string>, streaming: Accessor<boolean>): Accessor<string> {
    /** The block being written comes out a line at a time (code, or it took long). */
    let lines = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const [shown, setShown] = createSignal(untrack(streaming) ? byBlock(untrack(text), "", false) : untrack(text));
    // While it streams, words are coming: the page reads as flowing (markFlowing), as when they came a word at a time.
    let counted = false;
    const count = (on: boolean) => {
        if (on === counted) return;
        counted = on;
        pending += on ? 1 : -1;
        markFlowing();
    };
    const show = (t: string) => {
        if (t !== untrack(shown)) setShown(t);
    };
    createComputed(() => {
        const t = text();
        const live = streaming();
        count(live);
        if (!live) {
            clearTimeout(timer);
            timer = undefined;
            lines = false;
            return show(t);
        }
        const had = untrack(shown);
        const blocks = byBlock(t, had, false);
        // A block finished: the next one starts waiting afresh.
        if (blocks.length > had.length || !t.startsWith(had)) {
            lines = false;
            clearTimeout(timer);
            timer = undefined;
        }
        if (!lines && FENCE_START.test(t.slice(blocks.length))) lines = true;
        show(byBlock(t, had, lines));
        if (!lines && untrack(shown).length < t.length && !timer) {
            timer = setTimeout(() => {
                timer = undefined;
                lines = true;
                show(byBlock(untrack(text), untrack(shown), true));
            }, BLOCK_WAIT_MS);
        }
    });
    onCleanup(() => {
        clearTimeout(timer);
        count(false);
    });
    return shown;
}

/**
 * What to show of `text`, streaming, having shown `had`: as far as its last finished block, or with `lines` its last
 * whole line; what was shown if that's further; from scratch when the text changed other than by growing.
 */
export function byBlock(text: string, had: string, lines: boolean): string {
    const blocks = upTo(text, "\n\n");
    const far = lines ? upTo(text, "\n") : blocks;
    return text.startsWith(had) && had.length > far.length ? had : far;
}

/** `text` up to and including its last `sep`. */
function upTo(text: string, sep: string): string {
    const at = text.lastIndexOf(sep);
    return at < 0 ? "" : text.slice(0, at + sep.length);
}
