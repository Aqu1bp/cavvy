import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { ArrowDown, ArrowUpLeft, GitFork } from "lucide-solid";
import type { Turn } from "@shared/protocol";
import { fork, forkAnchor } from "../state/actions";
import { activate, app, earlierArriving, fillGap, forgetEarlier, loadEarlier, loadEarlierTo, loadTurn, onRenew, rpc, toast, type SessionHandle } from "../state/app";
import { findOpen, jumpTarget, openFind, panelHold, setFindQuery, setJumpTarget, setRewindOpen, shellLayout, takeDockGlide } from "../state/ui";
import { GROW_EASE, GROW_MS } from "../lib/composer-size";
import { prefs } from "../state/prefs";
import { AGAIN, anchoredTop, atBottom, FAR, STAGED, firstBelow, firstWindow, keyed, lazyHeights, MORE_TURNS, placedAgain, restoredShown, transcriptPositions, TURN_PAGE as PAGE, type ScrollAnchor, type TranscriptPosition } from "../lib/transcript-scroll";
import { turnAt } from "../lib/find";
import { FOLLOW_ROOM, ROOM_KEPT, ROOM_WRITTEN_MS, roomFor } from "../lib/follow";
import { GLIDE_MAX, glideFrom, heldTurns, liveLine, specialActivity } from "../lib/live-line";
import { BuiltFromEnd, DrawnAgain, revealing, wordsFlowing } from "../lib/reveal";
import { onStep } from "../lib/stream-clock";
import { observeWorkRendering } from "../lib/work-rendering";
import { KeyedList } from "../lib/keyed-list";
import { finishEntrances, finishEntrancesIn } from "../lib/entrances";
import { settlingObserver, type SettlingObserver } from "../lib/settling-observer";
import { TurnView } from "./TurnView";
import { LiveLine, motionMs } from "./LiveLine";
import { CardFoldsProvider } from "./blocks/Activity";
import { Spinner } from "./ui/bits";
import { rewindTarget } from "./RewindDialog";
import { BAR_ROOM, FindBar, type FindAnchor } from "./FindBar";
import { usePane } from "../state/split";

/** How long new content takes to glide into place at the end, before Settings → Motion scales it. */
const GLIDE_MS = 240;
/** A scroll back to where a pin moved from, this soon after, is the engine undoing it (onScroll), not the reader. */
const ENGINE_MS = 250;
/** A scroll up this soon after the column's content changed is the layout's (onScroll), not the reader's. */
const MUTATION_MS = 40;
/** A third scroll up within this of two taken for the engine's is the reader's (a scrollbar dragged). */
const REPIN_MS = 300;
const GLIDE_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
/** The end of a turn settling (settle()): one longer, softer move than a glide. */
const SETTLE_MS = 380;
const SETTLE_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
/** How long a finished turn's work fades before it folds (TurnView). */
const FOLD_WAIT_MS = 200;
/** How long the reader is back at the end, with nothing coming, before what's above its first page is let go of. */
const LET_GO_MS = 5000;
/**
 * Each turn's height as it went far (the observer's own measure, nothing laid out for it), by session, a few kept: shown
 * again (switched back to), a turn put in after its first screens (a few a frame) goes in skipped at it, rather than laid
 * out whole at each step (a session of 65 long turns: ten steps of 11-40 ms each, headless, after its first frame). Only
 * one as it was then: as many blocks, the same status, its work open or not alike.
 */
const turnHeights = new Map<string, Map<string, number>>();
const TURN_HEIGHTS_KEPT = 8;
/** What a turn put in again went in skipped with is let go of this long after it first comes near (as work-rendering's rows). */
const AGAIN_MS = 2000;
/**
 * Turns fetched for a jump far up (Find, ⌘K): about a screen from the one jumped to; those after come as they're read
 * down to (LaterTurns). A page of 40 there took the server 52 ms of the jump's 124 (a 100,000-item session, Linux).
 */
const JUMP_PAGE = 12;
/** An element's padding and border, above and below it (px). */
function outside(el: Element): number {
    if (typeof getComputedStyle !== "function") return 0;
    const s = getComputedStyle(el);
    return (parseFloat(s.paddingTop) || 0) + (parseFloat(s.paddingBottom) || 0) + (parseFloat(s.borderTopWidth) || 0) + (parseFloat(s.borderBottomWidth) || 0);
}
/** How much of what's left a jump down covers each frame: a few thousand pixels in about half a second. */
const JUMP_STEP = 0.2;

/**
 * An observer's callback that can be let go of. WebKit keeps an IntersectionObserver with a root alive after
 * disconnect(), and its callback with it: one closing over the transcript kept all of it (every turn's elements)
 * after the session was left. This one holds only `to`, which the transcript empties when it goes.
 */
function relay(to: { fn?: IntersectionObserverCallback }): IntersectionObserverCallback {
    return (entries, observer) => to.fn?.(entries, observer);
}


/**
 * `dock`: the composer dock's height (undefined until it's measured). Opened again where a turn was being read, it opens
 * on that turn, found by its place in the session (its id may be another turn's now); if the session didn't come with
 * it this time (new turns pushed it out), the turns back to it come first, in one request. Not there: at the end.
 */
export function Transcript(p: { handle: SessionHandle; dock?: number }) {
    const saved = transcriptPositions.get(p.handle.id);
    const key = !saved?.bottom ? saved?.keys?.anchor : undefined;
    const loading = key && loadEarlierTo(p.handle, key);
    if (!loading) return <TranscriptView handle={p.handle} dock={p.dock} saved={saved && placedAgain(p.handle.view.turns, saved)} />;
    const [placed, setPlaced] = createSignal<TranscriptPosition>();
    void loading.finally(() => setPlaced(placedAgain(p.handle.view.turns, saved!)));
    return <Show when={placed()} keyed>{(s) => <TranscriptView handle={p.handle} dock={p.dock} saved={s} />}</Show>;
}

function TranscriptView(p: { handle: SessionHandle; dock?: number; saved?: TranscriptPosition }) {
    // In a split (state/split.ts): Find is the focused pane's, a floating inspector is over the rightmost, and each
    // pane is half the conversation column.
    const pane = usePane();
    const finding = () => findOpen() && pane.focused();
    const share = pane.share;
    // --dock-h goes on each box that reads it (stage.css): not inherited, and not passed down with `inherit`.
    const dock = () => (p.dock === undefined ? undefined : `${p.dock}px`);
    // What a side panel floating over the conversation covers, with its gap to the edge: "Latest" centres in the rest.
    const floatOver = () => {
        const i = shellLayout().inspector;
        return i.open && i.mode === "float" && pane.rightmost() ? `${i.width + 8}px` : "0px";
    };
    let scroller: HTMLDivElement | undefined;
    let content: HTMLDivElement | undefined;
    // SessionView is keyed by handle; save on disposal, restore on the next mount.
    const id = p.handle.id;
    const saved = p.saved;
    const openWork = new Set(saved?.openWork);
    const [stick, setStick] = createSignal(saved?.bottom ?? true);
    /** Scrolled all the way down: "Latest" has nothing to jump to, following the end or not. */
    const [scrolledDown, setScrolledDown] = createSignal(true);
    // At first only about two screens of turns: the last ones, or (reopened where it was being read) those around the
    // place read. The rest of the page goes in a moment after (grow, below).
    const ids = p.handle.view.turns.map((t) => t.id);
    const target = restoredShown(ids, saved);
    const opensAtEnd = saved?.bottom ?? true;
    const anchorIndex = !opensAtEnd && saved?.anchor ? ids.indexOf(saved.anchor.turnId) : -1;
    const first = !opensAtEnd && anchorIndex < 0
        ? { shown: target, trimmed: 0 }
        : firstWindow(lazyHeights(p.handle.view.turns), target, opensAtEnd ? undefined : anchorIndex, window.innerHeight, -(saved?.anchor?.offset ?? 0));
    const [shown, setShown] = createSignal(first.shown);
    // Opened at its end with nothing to find in it: a long reply builds its end first (lib/reveal.ts BuiltFromEnd).
    const jumpingHere = () => jumpTarget()?.sessionId === p.handle.id;
    /** The reader is leaving the end (finishAtEnd): what's above in a reply built from its end goes in now, all of it. */
    const [allIn, setAllIn] = createSignal(false);
    const builtFromEnd = {
        fromEnd: () => settling && opensAtEnd && !untrack(jumpingHere) && !untrack(findOpen),
        // All of it once Find or a jump needs it, or the reader leaves the end (allIn).
        whole: () => findOpen() || jumpingHere() || allIn() || !stick(),
        // Following the end, the end stays (as the conversation grows): nothing to measure. Read higher up, what's read
        // stays, the scroll position taking what went in above it.
        keep: (el: Element | null | undefined, put: () => void) => {
            if (!el || !scroller || untrack(stick)) return put();
            const was = el.getBoundingClientRect().top;
            put();
            queueMicrotask(() => {
                if (!scroller || !el.isConnected) return;
                const moved = el.getBoundingClientRect().top - was;
                if (Math.abs(moved) > 0.5) {
                    scroller.scrollTop += moved;
                    // The place read, as it is now: it's measured from the top of its turn, which this moved, and it's
                    // put back after (the column changed size). Following the end too: a wheel that moved the view
                    // may not have told it yet.
                    reading = capture();
                    wrote();
                }
            });
        },
    };
    /** How many turns go in, counted from the end: the first page, then a page more each "Show earlier", put in a few at a time (grow). */
    const [goal, setGoal] = createSignal(target);
    /** A page going in a few turns at a time ("Show earlier"): those of it in so far, staged (stage, below). */
    let staged: HTMLElement[] | undefined;
    /** Rows of turns just put in, taken by lib/work-rendering.ts at once (before they're laid out): see its settle. */
    let settleRows: (() => void) | undefined;
    /**
     * The first turn shown before the page: those before it are the page's. By the turn, not a count: turns still
     * going in below the place read (after Find) or a new one at the end would move a count off it.
     */
    let stagedBefore: string | undefined;
    /** Turns at the very end not mounted yet (reopened mid-way: those below the place read go in first). */
    const [trimmed, setTrimmed] = createSignal(first.trimmed);
    let reading = saved?.anchor;
    let ready = false;
    /** The turns still to go in (trimmed, or short of the page) put in a few at a time from the next frame (onMount). */
    let growMore: (() => void) | undefined;
    /** Until its first frame: drawing what the session already had (DrawnAgain), so nothing of it comes in again. */
    let settling = true;
    let smoothScroll = false;
    let frame = 0;
    /** Where the last scroll event left the conversation (onScroll). */
    let lastTop = 0;
    let lastGap = 0;
    /** The sizes it was measured at: a scroll that comes with a change of size is the layout's, not the reader's. */
    let lastSize = "";
    /** A pointer or finger is down on the conversation (dragging its scrollbar, say): its scrolls are the reader's. */
    let pressed = false;
    const sizeOf = (el: HTMLElement) => `${el.scrollHeight}:${el.clientHeight}`;
    /** Our own write is where the next scroll is measured from: only the reader's scrolls move it on from there. */
    /** The last pin's write: when, and from where (onScroll tells WebKit undoing it from the reader). */
    let pinned = { at: -Infinity, from: 0 };
    /** When the column's content last changed, and when onScroll last put the engine's scroll back. */
    let mutatedAt = -Infinity;
    let repinned: number[] = [];
    const gapOf = (el: HTMLElement) => el.scrollHeight - el.clientHeight - el.scrollTop;
    /** Measured after every scroll and size change: the button goes by what's in view, not only by following. The end of
     * what's mounted isn't the end while turns below it are still held back (trimmed). */
    const measureEnd = () => scroller && setScrolledDown(trimmed() === 0 && gapOf(scroller) <= 1);
    const wrote = () => {
        if (!scroller) return;
        lastTop = scroller.scrollTop;
        lastGap = gapOf(scroller);
        lastSize = sizeOf(scroller);
        measureEnd();
    };
    const afterLayout = (fn: () => void) => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            fn();
            // A send or search may supersede the initial restoration frame.
            ready = true;
            reading = capture();
            wrote();
        });
    };
    const turns = () => p.handle.view.turns;
    /** The turns the window holds a gap for, between two of its own (Find searches them where they are). */
    const findGap = createMemo(() => {
        const g = p.handle.view.gap;
        if (!g) return undefined;
        const t = turns();
        const at = t.findIndex((x) => x.id === g.after);
        const next = at >= 0 ? t[at + 1]?.id : undefined;
        return next ? { after: g.after, before: next } : undefined;
    }, undefined, { equals: (a, b) => a?.after === b?.after && a?.before === b?.before });
    const visible = createMemo(() => {
        const t = turns();
        return t.slice(Math.max(0, t.length - shown()), t.length - trimmed());
    });
    /** Turns above the page here, not those still going in at first (grow, in onMount). */
    const hiddenHere = () => Math.max(0, turns().length - Math.max(shown(), goal()));
    /** Turns above the page, for "Show earlier": those here, and those the session opened without (loadEarlier). */
    /** While a page goes in (staged, below), "Show earlier" stays as it was: gone or changed before the page is shown, what's below it would move up by its height. */
    const [buttonHeld, setButtonHeld] = createSignal<number>();
    const hidden = () => buttonHeld() ?? hiddenHere() + (p.handle.view.earlier ?? 0);
    const [loadingEarlier, setLoadingEarlier] = createSignal(false);

    /**
     * A jump down ("Latest", a send from further up) is ours, a step a frame toward wherever the end is in that frame,
     * a fifth of the way left each time. What's below often grows on the way (turns skipped while far, drawn at their
     * size as they come near): the motion goes on to the new end. The browser's smooth scroll, asked again for the new
     * end, starts over from standing still each time, stalling and setting off again.
     */
    let jumpFrame = 0;
    const jumpStep = () => {
        jumpFrame = 0;
        if (!scroller || !smoothScroll) return;
        const end = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const left = end - scroller.scrollTop;
        if (left <= 1) {
            smoothScroll = false;
            if (left !== 0) scroller.scrollTop = end;
        } else {
            scroller.scrollTop += Math.max(left * JUMP_STEP, Math.min(left, 2));
            jumpFrame = requestAnimationFrame(jumpStep);
        }
        wrote();
    };
    const toBottom = (smooth = false) => {
        if (!scroller) return;
        const height = scroller.scrollHeight;
        // ResizeObserver can report both content and viewport without any new
        // scroll range. Avoid redundant writes.
        if (Math.abs(Math.max(0, height - scroller.clientHeight) - scroller.scrollTop) <= 0.5) return;
        smoothScroll = smooth && prefs.motion !== "instant" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
        // One in flight goes on toward the new end.
        if (smoothScroll) {
            if (!jumpFrame) jumpFrame = requestAnimationFrame(jumpStep);
            return;
        }
        cancelAnimationFrame(jumpFrame);
        jumpFrame = 0;
        scroller.scrollTo({ top: height, behavior: "instant" });
        wrote();
    };

    // Pinned to the end while a turn runs, new content glides in rather than jumping: one scrollTop write with each
    // growth (to the end, at once, in the frame that grew: a frame of its own costs the page's whole pipeline), then a
    // short compositor-only translate from where it was drawn to where it is, picked up from wherever a glide still
    // running is. Scrolling runs no script of ours. Only what's in sight (or glides into it) moves, not the whole
    // column: a long conversation costs no more to glide.
    /** The running glide: the same translate, from `from`, on each of the column's rows in sight. */
    let glides: { el: HTMLElement; anim: Animation; from: number }[] = [];
    /** A fold's moves (fold()): what's above an answer, coming down. */
    let folds: { el: HTMLElement; anim: Animation }[] = [];
    const translate = (el: Element) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
    /** How far a running glide has the rows in sight drawn from their place (px), worked out: asked of the page, it lays out. */
    const shift = () => {
        const g = glides[0];
        return g?.anim.playState === "running" ? g.from * (1 - (g.anim.effect?.getComputedTiming().progress ?? 0)) : 0;
    };
    const cancelGlide = () => {
        for (const g of glides) g.anim.cancel();
        glides = [];
    };
    const stopGlide = () => {
        cancelGlide();
        for (const f of folds) f.anim.cancel();
        folds = [];
    };
    /** The column's rows in the view, or within `px` of it, by layout (not as a glide draws them), from the end up (where a pin leaves it, a few). */
    const inSight = (px: number) => {
        const out: HTMLElement[] = [];
        if (!scroller || !content) return out;
        const top = layoutTop(scroller) + scroller.scrollTop;
        const bottom = top + scroller.clientHeight;
        for (let el = content.lastElementChild as HTMLElement | null; el; el = el.previousElementSibling as HTMLElement | null) {
            const y = layoutTop(el);
            if (y + el.offsetHeight < top - px) break;
            if (y <= bottom + px) out.push(el);
        }
        return out;
    };
    /**
     * Something in the upper part of the view, and where it is in the column (by layout: a glide's translate isn't
     * counted). Moved down since it was last looked at, it means what changed is above what the reader sees: an image
     * getting its size, rows drawn again after being skipped, turns going in. Following the end, the view then stays
     * still at once, before the frame is drawn. Only growth in view, or at the end, glides. Asked on every change of
     * size and every scroll while following, each acting on what it finds (one only looking would take growth it saw
     * for where things are).
     */
    let seen: { el: HTMLElement; top: number } | undefined;
    const layoutTop = (el: HTMLElement) => {
        let y = 0;
        for (let e: HTMLElement | null = el; e; e = e.offsetParent as HTMLElement | null) y += e.offsetTop;
        return y;
    };
    const look = () => {
        seen = undefined;
        if (!scroller || !content) return;
        const box = scroller.getBoundingClientRect();
        const hit = document.elementFromPoint?.(box.left + box.width / 2, box.top + box.height / 4);
        // Not the room kept at the end for the composer: the turn above it growing moves it, and that's growth in view.
        if (hit instanceof HTMLElement && content.contains(hit) && hit !== content.lastElementChild) seen = { el: hit, top: layoutTop(hit) - layoutTop(content) };
    };
    const grewAbove = () => {
        if (!scroller || !content || !seen?.el.isConnected) {
            look();
            return false;
        }
        const y = layoutTop(seen.el);
        const top = y - layoutTop(content);
        const moved = top > seen.top + 0.5;
        // While it's still in the upper part of the view it goes on being what's watched: a look is a hit test.
        const inView = y - layoutTop(scroller) - scroller.scrollTop;
        if (moved || inView < 0 || inView > scroller.clientHeight / 2) look();
        else seen.top = top;
        return moved;
    };
    /** `was`: where the view was, before a change already laid out. */
    const pin = (was?: number) => {
        if (!scroller || !stick() || smoothScroll) return;
        const before = was ?? scroller.scrollTop;
        const end = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (Math.abs(end - before) <= 0.5) return;
        scroller.scrollTop = end;
        wrote();
        pinned = { at: performance.now(), from: before };
        const ms = motionMs(GLIDE_MS);
        if (!ms || !content || typeof content.animate !== "function") return;
        const from = glideFrom(scroller.scrollTop - before, shift());
        if (from === undefined) return cancelGlide();
        // A row farther than `from` from the view never comes into it. A row already moving goes on in the animation it
        // has: a transform taken off and put back lays the column out again, each time.
        const rows = inSight(Math.abs(from));
        const steps = [{ transform: `translateY(${from}px)` }, { transform: "none" }];
        for (const g of glides) if (!rows.includes(g.el)) g.anim.cancel();
        glides = rows.map((el) => {
            const anim = glides.find((g) => g.el === el && g.anim.playState === "running")?.anim;
            if (!anim) return { el, from, anim: el.animate(steps, { duration: ms, easing: GLIDE_EASE }) };
            const effect = anim.effect as KeyframeEffect;
            effect.updateTiming({ duration: ms, easing: GLIDE_EASE });
            effect.setKeyframes(steps);
            anim.currentTime = 0;
            return { el, from, anim };
        });
    };

    // Room under a reply as it streams (lib/follow.ts): the reply writes down into it and the conversation holds
    // still, and once it's used, the conversation glides up by a room's worth and the room is there again.
    const [room, setRoom] = createSignal(0);
    /** The column's height, without the room, when the room was last made (undefined: none being written into). */
    let roomBase: number | undefined;
    /** The room's size when it was last made (or taken up, left from before). */
    let roomMade = 0;
    /** The column's height, without the room, when it was last followed or held. */
    let roomLast: number | undefined;
    /**
     * How far the words have written down the column since they started, as they came (over ROOM_WRITTEN_MS at most):
     * growth of the turn's text only, not rows landing between words or a card opening over the composer.
     */
    let written: { at: number; px: number }[] = [];
    let wordsPx = 0;
    let columnWas: number | undefined;
    const follow = () => {
        if (!scroller || !content) return;
        // Where it was, read before the room changes (a smaller room brings the view back within the column).
        const before = scroller.scrollTop;
        const h = content.offsetHeight;
        const now = performance.now();
        const column = h - (p.dock ?? 0);
        // Words are what grew while the turn ends in its text (not a row landing after them).
        if (columnWas !== undefined && turns().at(-1)?.blocks.at(-1)?.t === "text") wordsPx += Math.max(0, column - columnWas);
        columnWas = column;
        written.push({ at: now, px: wordsPx });
        while (written.length > 1 && written[1]!.at <= now - ROOM_WRITTEN_MS) written.shift();
        // Room left from a reply that ended: written into from where it is, not made again.
        if (roomBase === undefined && room() > 0) {
            roomBase = h;
            roomMade = room();
        }
        const used = roomBase === undefined ? -1 : h - roomBase;
        if (used >= 0 && roomMade - used >= ROOM_KEPT) setRoom(roomMade - used);
        else {
            // What's left of the room stays, and what went from the column is given to it: none taken away while the
            // words come (the conversation would move down).
            const left = roomBase === undefined ? 0 : Math.max(0, roomMade - used);
            roomBase = h;
            roomMade = Math.max(left, roomFor(scroller.clientHeight, GLIDE_MAX, wordsPx - written[0]!.px));
            setRoom(roomMade);
        }
        roomLast = h;
        pin(before);
    };
    /** What grew above the view isn't written into the room, or written by the words. */
    const roomAbove = () => {
        if (!content) return;
        const h = content.offsetHeight;
        if (roomBase !== undefined && roomLast !== undefined) roomBase += h - roomLast;
        roomLast = h;
        if (columnWas !== undefined) columnWas = h - (p.dock ?? 0);
    };
    /**
     * The words stopped (a tool, a stall, the reply's end): the room stays where it is. Taken back at the end of the
     * view, it could only move the conversation down, and up again when the words go on. What they write next is
     * counted from here.
     */
    const wordsStopped = () => {
        written = [];
        wordsPx = 0;
        columnWas = undefined;
    };
    /**
     * What lands at the end while no words come (a tool's row, the reply's footer) goes into the room, the conversation
     * holding still; only what doesn't fit moves it up. What goes from the end is given to the room, so nothing moves
     * down.
     */
    const fill = (live: boolean) => {
        if (!scroller || !content) return;
        const before = scroller.scrollTop;
        const h = content.offsetHeight;
        if (roomBase === undefined) {
            roomBase = h;
            roomMade = room();
        }
        const left = roomMade - (h - roomBase);
        roomBase = roomLast = h;
        roomMade = Math.min(Math.max(0, left), scroller.clientHeight);
        setRoom(roomMade);
        if (left < 0) live ? pin(before) : toBottom();
    };
    /** Read elsewhere, the room goes where nothing on screen moves for it: wholly below the view. */
    const dropRoomUnseen = () => {
        if (!scroller || !room()) return;
        if (scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - room() - 1) return;
        setRoom(0);
        roomBase = roomLast = undefined;
        written = [];
        wordsPx = 0;
        columnWas = undefined;
    };

    /** The room goes (the reply's done): nothing kept under it any more. */
    const dropRoom = () => {
        setRoom(0);
        roomBase = roomLast = undefined;
        written = [];
        wordsPx = 0;
        columnWas = undefined;
    };
    /** The turn's over and its last words are out: the room under it can go. */
    const settled = () => turns().at(-1)?.status !== "running" && !revealing();
    /**
     * Something changes above the end at the end of a turn (its work folding into "Worked for", the room under its
     * reply going): following the end, each part in sight glides from where it was drawn to where it is now, in one
     * move. A turn's parts and its reply's are each their own, as they move by different amounts (the answer comes
     * down by the room, what's above it by the work as well).
     */
    const settle = (change: () => void) => {
        const ms = motionMs(SETTLE_MS);
        if (!scroller || !content || !stick() || smoothScroll || !ms || typeof content.animate !== "function") {
            change();
            if (scroller && stick() && !smoothScroll) toBottom();
            return;
        }
        const parts = () => inSight(scroller!.clientHeight).reverse().flatMap((row) => !row.hasAttribute("data-turn") ? [row]
            : ([...row.children] as HTMLElement[]).flatMap((part) => (part.classList.contains("reply") ? ([...part.children] as HTMLElement[]) : [part])));
        // Where each is drawn: a glide still running counts.
        const was = new Map(parts().map((el) => [el, el.getBoundingClientRect().top]));
        stopGlide();
        change();
        toBottom();
        const now = parts();
        const moved = now.map((el) => (was.has(el) ? was.get(el)! - el.getBoundingClientRect().top : undefined));
        // One that's new here ("Worked for", in the work's place) or comes into sight moves with the part before it (or after).
        for (let i = 0; i < moved.length; i++) moved[i] ??= moved.slice(0, i).reverse().find((m) => m !== undefined) ?? moved.slice(i).find((m) => m !== undefined);
        now.forEach((el, i) => {
            const from = glideFrom(moved[i] ?? 0, 0, scroller!.clientHeight);
            if (from !== undefined) folds.push({ el, anim: el.animate([{ transform: `translateY(${from}px)` }, { transform: "none" }], { duration: ms, easing: SETTLE_EASE }) });
        });
    };
    /**
     * A finished turn's work folds into "Worked for" (TurnView, once it has faded out). The answer stays put and what's
     * above it comes down by what folded away, unless the room under the answer goes too: then all of it comes down,
     * in the one move. While the last words still come out, the fold waits for them, so it's one move, not two.
     */
    const fold = (turn: HTMLElement, run: () => void) => {
        if (!turn.isConnected) return run();
        if (revealing()) return onStep(() => fold(turn, run));
        settle(() => {
            run();
            // What folded is above the answer: not the end's to give to the room.
            roomAbove();
            if (settled()) dropRoom();
        });
    };
    /** The reply's done: a moment for its work to fold (which takes the room with it), then the room goes if it's still there. */
    let roomGoing: ReturnType<typeof setTimeout> | undefined;
    const settleRoom = () => {
        clearTimeout(roomGoing);
        roomGoing = setTimeout(() => {
            roomGoing = undefined;
            if (ready && room() > 0 && settled()) settle(dropRoom);
        }, motionMs(FOLD_WAIT_MS) + 50);
    };
    onCleanup(() => clearTimeout(roomGoing));

    /**
     * How far running glides and folds draw this element from its place (the moves on it and on what it's in):
     * what's out of their reach doesn't move.
     */
    const shiftOf = (el: Element) => {
        let by = 0;
        for (const m of [...glides, ...folds]) if (m.anim.playState === "running" && (m.el === el || m.el.contains(el))) by += translate(m.el);
        return by;
    };
    const capture = (): ScrollAnchor | undefined => {
        if (!scroller || !content) return;
        // Where things are, not where a running glide draws them (the reader may have scrolled away from it).
        const top = scroller.getBoundingClientRect().top;
        // The first turn reaching into the view: they're in order, so a few are measured, not all of them.
        // Not one of a page still going in (staged): it isn't laid out, so it's nowhere.
        const all = visible().flatMap((t) => turnEls.get(t.id) ?? []);
        const els = staged ? all.filter((el) => !el.hasAttribute(STAGED)) : all;
        const turn = els[firstBelow(els.length, (i) => els[i]!.getBoundingClientRect().bottom - shiftOf(els[i]!), top)];
        if (!turn) return;
        // A block anchor also survives replacing the live head with a work-log toggle.
        let part = [...turn.querySelectorAll<HTMLElement>("[data-find], .worklog")].find((el) => el.getBoundingClientRect().bottom - shiftOf(el) > top);
        // Within one large work log or reply, anchor the measured row in view. A container's
        // top alone cannot preserve the paragraph/tool being read when rows above reflow.
        const rows = part ? [...part.querySelectorAll<HTMLElement>('[data-work-row="sized"]')] : [];
        const rowIndex = firstBelow(rows.length, (i) => rows[i]!.getBoundingClientRect().bottom - shiftOf(rows[i]!), top);
        const row = rows[rowIndex];
        if (row?.dataset.find) part = row;
        return {
            turnId: turn.dataset.turn!, offset: turn.getBoundingClientRect().top - shiftOf(turn) - top,
            part: part?.dataset.find ?? (part ? `worklog:${[...turn.querySelectorAll(".worklog")].indexOf(part)}` : undefined),
            partOffset: part ? part.getBoundingClientRect().top - shiftOf(part) - top : undefined,
            ...(row && row !== part ? { row: [...part!.querySelectorAll<HTMLElement>("[data-work-row]")].indexOf(row), rowOffset: row.getBoundingClientRect().top - shiftOf(row) - top } : {}),
        };
    };
    /**
     * The place read, taken again after it was put back: the same, unless something moved it more than the browser's
     * rounding of our own write (a whole pixel). Taken afresh each time, it moved by that rounding at each step of a
     * page going in a few turns at a time (1-2 px over ten).
     */
    const recapture = () => {
        const now = capture();
        const was = reading;
        const near = (a?: number, b?: number) => a === b || (a !== undefined && b !== undefined && Math.abs(a - b) < 1);
        reading = was && now && now.turnId === was.turnId && now.part === was.part && now.row === was.row && near(now.offset, was.offset) && near(now.partOffset, was.partOffset) && near(now.rowOffset, was.rowOffset) ? was : now;
    };
    /**
     * A page going in ("Show earlier") a few turns at a time: those in already are built but not laid out (staged:
     * transcript.css) until it's all in, then shown at once and the place read put back once. Laid out as they went in,
     * each step moved the place read by the browser's rounding (a pixel either way); all at once, the click's frame
     * built and laid out the whole page (58-104 ms, headless, a long session).
     */
    const stage = () => {
        if (!staged) return;
        const v = visible();
        const at = v.findIndex((t) => t.id === stagedBefore);
        for (const t of at < 0 ? [] : v.slice(0, at)) {
            const el = turnEls.get(t.id);
            if (el && !el.hasAttribute(STAGED)) {
                el.setAttribute(STAGED, "");
                staged.push(el);
            }
        }
    };
    /** The page shown, whole, where it goes: what's read stays put (restore). */
    const unstage = () => {
        if (!staged) return;
        // The button had the keyboard ("Show earlier" pressed by a key): if the page shown is the last, the button goes.
        const button = document.activeElement instanceof HTMLElement && document.activeElement.classList.contains("earlier") && scroller?.contains(document.activeElement) ? document.activeElement : undefined;
        // Not skipped: each is drawn once before it can be (what it's skipped at is the size it was drawn at).
        for (const el of staged) {
            el.removeAttribute(STAGED);
            el.removeAttribute(FAR);
        }
        staged = undefined;
        setButtonHeld(undefined);
        // Gone with it: the keyboard goes to the first turn, the one it brought in on top (not to the page's body, where a
        // key reaches nothing).
        if (button && !button.isConnected) {
            const first = turnEls.get(visible()[0]?.id ?? "");
            if (first) {
                if (!first.hasAttribute("tabindex")) first.tabIndex = -1;
                first.focus({ preventScroll: true });
            }
        }
    };
    const restore = () => {
        if (!scroller || !content || !reading) return;
        const turn = turnEls.get(reading.turnId);
        if (!turn) return;
        const part = reading.part?.startsWith("worklog:")
            ? turn.querySelectorAll<HTMLElement>(".worklog")[Number(reading.part.slice(8))]
            : reading.part ? turn.querySelector<HTMLElement>(`[data-find="${CSS.escape(reading.part)}"]`) : undefined;
        const row = part && reading.row !== undefined ? part.querySelectorAll<HTMLElement>("[data-work-row]")[reading.row] : undefined;
        const el = row ?? part ?? turn;
        const box = el.getBoundingClientRect();
        const savedOffset = row && reading.rowOffset !== undefined ? reading.rowOffset : part && reading.partOffset !== undefined ? reading.partOffset : reading.offset;
        // A remounted prompt may be clamped again. If the saved reading point
        // no longer fits, show this anchor's top instead of skipping past it.
        const offset = savedOffset <= -box.height ? 0 : savedOffset;
        const next = anchoredTop(scroller.scrollTop, box.top - shiftOf(el) - scroller.getBoundingClientRect().top, offset);
        // A no-op write would cancel an in-flight smooth Jump to latest.
        if (Math.abs(next - scroller.scrollTop) > 0.5) scroller.scrollTop = next;
        wrote();
    };

    // A turn a screen or more from the view is marked far: it skips its layout and paint (transcript.css), at the
    // size it was last drawn at. Each is drawn once before it can be (not far until the observer says so).
    let far: SettlingObserver | undefined;
    /** Each turn's element (TurnView gives it), so finding one doesn't search the whole column. */
    const turnEls = new Map<string, HTMLElement>();
    const heights = (() => {
        const was = turnHeights.get(id) ?? new Map<string, number>();
        turnHeights.delete(id);
        turnHeights.set(id, was);
        while (turnHeights.size > TURN_HEIGHTS_KEPT) turnHeights.delete(turnHeights.keys().next().value!);
        return was;
    })();
    const byId = createMemo(() => new Map(visible().map((t) => [t.id, t])));
    const heightKey = (turnId: string) => {
        const t = byId().get(turnId);
        return t && `${turnId}:${t.status}:${t.blocks?.length ?? 0}:${openWork.has(turnId) ? 1 : 0}`;
    };
    const track = (el: HTMLElement, turnId: string) => {
        turnEls.set(turnId, el);
        // Put in after the first frame (a few a frame, not a page of "Show earlier": that's staged) and drawn before as
        // it is: skipped at the height it had, what it brings in already over (transcript.css), till it comes near.
        const h = !settling && !staged ? untrack(() => heights.get(heightKey(turnId) ?? "")) : undefined;
        if (h) {
            el.style.containIntrinsicBlockSize = `auto ${h}px`;
            el.setAttribute(FAR, "");
            el.setAttribute(AGAIN, "");
        }
        far?.observe(el);
        onCleanup(() => {
            if (turnEls.get(turnId) === el) turnEls.delete(turnId);
            far?.unobserve(el);
        });
    };

    onMount(() => {
        if (!scroller || !content) return;
        if (typeof IntersectionObserver !== "undefined") {
            const to: { fn?: IntersectionObserverCallback } = {};
            to.fn = (entries) => {
                // One drawn again may not be the size it was skipped at (the column was another width, say). Above
                // the view, the scroll position takes the difference: what's in view stays put. Measured here, as
                // the next scroll event's capture() would take the move for the reader's.
                const top = scroller!.getBoundingClientRect().top;
                const near = entries.filter((e) => e.isIntersecting && e.target.hasAttribute(FAR)).map((e) => {
                    const box = e.target.getBoundingClientRect();
                    return { el: e.target, was: box.bottom <= top ? box.height : undefined };
                });
                // Skipped from here: what it was still bringing in is over now, not left part way (lib/entrances.ts).
                // All of them before any is marked, so the page's style is worked out once, not once a turn.
                finishEntrancesIn(entries.filter((e) => !e.isIntersecting && !e.target.hasAttribute(FAR)).map((e) => e.target));
                // Each one going far: its height, for the next time this session is shown (turnHeights). Its content's:
                // that's what a skipped turn's size stands for, its padding drawn around it all the same.
                for (const e of entries) {
                    if (e.isIntersecting || e.target.hasAttribute(FAR) || !(e.boundingClientRect?.height > 0)) continue;
                    const key = heightKey((e.target as HTMLElement).dataset.turn ?? "");
                    if (key) heights.set(key, e.boundingClientRect!.height - outside(e.target));
                }
                // Put in again skipped: what it brought in is let go of a while after it comes near (AGAIN_MS).
                const again = entries.filter((e) => e.isIntersecting && e.target.hasAttribute(AGAIN)).map((e) => e.target);
                if (again.length) setTimeout(() => { for (const el of again) el.removeAttribute(AGAIN); }, AGAIN_MS);
                for (const e of entries) e.target.toggleAttribute(FAR, !e.isIntersecting);
                if (stick() || smoothScroll) return;
                let moved = 0;
                for (const n of near) if (n.was !== undefined) moved += n.el.getBoundingClientRect().height - n.was;
                if (Math.abs(moved) > 0.5) {
                    scroller!.scrollTop += moved;
                    wrote();
                }
            };
            // Let go of while nothing scrolls or changes size (lib/settling-observer.ts): a spinner waiting on a model
            // would otherwise cost a main-thread frame at each of its steps.
            far = settlingObserver(relay(to), { root: scroller, rootMargin: "100% 0px" }, [content]);
            for (const el of turnEls.values()) far.observe(el);
            onCleanup(() => {
                far?.disconnect();
                to.fn = undefined;
            });
        }
        // The rows of turns far from the view are let go of once more than a page of turns is drawn ("Show earlier"), or once
        // a turn runs here (they cost on each frame, and a turn is what draws frames). Not as a session opens.
        let ran = false;
        const work = observeWorkRendering(scroller, content, (moved) => {
            if (stick() || smoothScroll) return;
            scroller!.scrollTop += moved;
            wrote();
            reading = capture();
        }, () => (ran ||= p.handle.view.state.busy) || visible().length > PAGE, id);
        settleRows = work.settle;
        onCleanup(work);
        const ro = new ResizeObserver(() => {
            // Laid out just now, so this reads nothing new: where the column starts, for a slide that begins from here.
            columnLeft = content!.offsetLeft;
            const above = grewAbove();
            if (!ready) return;
            const running = turns().at(-1)?.status === "running";
            // A jump down (a send, "Latest") near the end while a turn grows: the rest of the way is a glide, which
            // growth carries on. Scrolling there smoothly again on every growth restarts the scroll each time: it
            // stutters, and a fast reply never lets it arrive.
            if (smoothScroll && running && scroller!.scrollHeight - scroller!.clientHeight - scroller!.scrollTop <= GLIDE_MAX) {
                smoothScroll = false;
                pin();
            }
            else if (smoothScroll) toBottom(true);
            // Glides only while a turn is running, or its reply's last words are still coming out: the end of a
            // turn (its footer, the composer settling) lands at once. Its work folding away glides (fold()).
            else if (stick()) {
                const live = (running || revealing()) && !above;
                // Room only while words come out: what lands between them (a tool's row) glides in, and the room
                // isn't left standing empty under a wait.
                if (FOLLOW_ROOM && live && (revealing() || wordsFlowing())) follow();
                // Growth above the view as a reply runs (or with room left): the end stays where it is, and the room is still all there.
                else if (FOLLOW_ROOM && above && (running || revealing() || room() > 0)) {
                    roomAbove();
                    toBottom();
                }
                // The words stopped, or the reply's done: what lands goes into the room left.
                else if (FOLLOW_ROOM && room() > 0 && !above) fill(live);
                else live ? pin() : toBottom();
            }
            else {
                if (FOLLOW_ROOM && !(running || revealing())) dropRoomUnseen();
                restore();
                // Nothing left to scroll (something folded until it all fits): no scroll event will come to say the
                // end is in view, so it's followed again here.
                if (trimmed() === 0 && scroller!.scrollHeight <= scroller!.clientHeight + 1) setStick(true);
            }
            measureEnd();
        });
        ro.observe(content);
        ro.observe(scroller);
        onCleanup(() => ro.disconnect());
        for (const type of ["click", "keydown"]) scroller.addEventListener(type, toggling, true);
        onCleanup(() => {
            for (const type of ["click", "keydown"]) scroller?.removeEventListener(type, toggling, true);
        });
        if (typeof MutationObserver !== "undefined") {
            const mo = new MutationObserver(() => (mutatedAt = performance.now()));
            mo.observe(content, { childList: true, subtree: true, characterData: true });
            onCleanup(() => mo.disconnect());
        }
        afterLayout(() => {
            if (stick()) toBottom();
            else { scroller!.scrollTop = saved?.top ?? 0; restore(); }
        });
        // Its first frame shows the conversation as it is: what was drawn for it lands, rather than coming in again
        // (a session switched back to doesn't bring its rows in a second time).
        const settle = requestAnimationFrame(() => {
            settling = false;
            finishEntrances(content!);
        });
        onCleanup(() => cancelAnimationFrame(settle));
        // The rest of the turns this view shows, a few at a time once the first screen is painted: each batch goes in
        // above, between frames. Followed at the end, the end stays in view; read further up, the place read stays put.
        let growing = 0;
        let gone = false;
        const pending = () => trimmed() > 0 || shown() < goal();
        const grow = () => {
            growing = 0;
            if (gone || !pending()) return;
            // Between frames, what went in last may have grown since it was put back (an image getting its size): the
            // place read is put back before it's read again, or the reader would be held where that pushed them.
            if (!stick()) {
                restore();
                recapture();
            }
            // Below the place read first, then above it.
            if (trimmed() > 0) setTrimmed((n) => Math.max(0, n - MORE_TURNS));
            else setShown((n) => (n >= goal() ? n : Math.min(goal(), n + MORE_TURNS)));
            // Shown before, their rows skip their layout at the sizes they had (not laid out first, here).
            settleRows?.();
            // A page going in: staged till it's all in, then shown at once.
            if (shown() >= goal()) unstage();
            else stage();
            // Solid has inserted them; before paint, the end (or the place read) where it was.
            if (stick()) toBottom();
            else restore();
            if (pending()) later();
        };
        // After the frame paints: a frame, then a task.
        const later = () => (growing = requestAnimationFrame(() => setTimeout(grow, 0)));
        if (pending()) later();
        growMore = () => {
            if (!growing && pending()) later();
        };
        // Opened with what fits its first screens (OPEN_BYTES): the rest of its page comes once that's painted, put in
        // above as "Show earlier" puts a page, the end (or the place read) where it was.
        const topUp = async () => {
            const want = target - turns().length;
            if (gone || want <= 0 || !p.handle.view.earlier) return;
            if (!stick()) reading = capture();
            const ok = await loadEarlier(p.handle, { count: want });
            if (!ok || gone) return;
            // Solid has put them in; before paint, the end (or the place read) where it was.
            if (stick()) toBottom();
            else restore();
        };
        const topping = requestAnimationFrame(() => setTimeout(() => void topUp(), 0));
        onCleanup(() => {
            gone = true;
            cancelAnimationFrame(growing);
            cancelAnimationFrame(topping);
        });
    });
    onCleanup(() => {
        cancelAnimationFrame(frame);
        cancelAnimationFrame(jumpFrame);
        stopGlide();
        // A running log can finish while this keyed view is unmounted.
        if (!stick()) for (const turn of visible()) if (turn.status === "running") openWork.add(turn.id);
        // Where the last scroll left it (lastTop), not read from the page: by now the next session is in it, and reading
        // a scroll position lays that out there and then (43 ms of a switch to one ending in a 60 KB reply, headless).
        transcriptPositions.set(id, keyed(turns(), {
            bottom: stick(), top: (ready ? lastTop : saved?.top) ?? 0,
            anchor: reading, openWork: [...openWork],
            // A page asked for and still going in (staged): it comes with it, as it would have once in.
            ...(staged ? { shown: goal() } : {}),
        }));
    });

    // Back at the end a while after reading far up, with nothing coming: what's drawn above its first page goes, and so do
    // the turns the window holds beyond it (scrolled up again, they come back as "Show earlier" brings them). Its memory
    // stays what's on screen, not everything it was ever scrolled through.
    let letGo: ReturnType<typeof setTimeout> | undefined;
    createEffect(on([stick, () => p.handle.view.state.busy], ([atEnd, busy]) => {
        clearTimeout(letGo);
        if (!atEnd || busy) return;
        letGo = setTimeout(() => {
            const keep = Math.max(target, PAGE);
            if (!stick() || p.handle.view.state.busy || loadingEarlier() || turns().length <= keep) return;
            unstage();
            setShown((n) => Math.min(n, keep));
            setGoal((g) => Math.max(target, Math.min(g, keep)));
            forgetEarlier(p.handle, keep);
            toBottom();
        }, LET_GO_MS);
    }, { defer: true }));
    onCleanup(() => clearTimeout(letGo));

    const earlier = async () => {
        // A page still going in: the next once it's shown (the button stays as it was meanwhile, focus on it).
        if (buttonHeld() !== undefined) return;
        // Fewer here than a page: the next ones come from the server first (put in above, out of sight).
        if (hiddenHere() < PAGE && p.handle.view.earlier) {
            if (loadingEarlier()) return;
            setLoadingEarlier(true);
            // One fetched ahead may be on its way: it may be all this page needs.
            await earlierArriving(p.handle);
            const ok = hiddenHere() >= PAGE || !p.handle.view.earlier || (await loadEarlier(p.handle, { count: PAGE }));
            setLoadingEarlier(false);
            if (!ok && p.handle.view.earlier) return void toast("Couldn't load earlier turns.");
        }
        reading = capture();
        smoothScroll = false;
        setStick(false);
        // A page more: the first few now, the rest a few a frame (grow), each above the place read, which stays put.
        // All at once, the click's frame laid a page of 40 turns out (58-104 ms, headless, a long session).
        const to = Math.max(shown(), goal()) + PAGE;
        if (!staged) {
            staged = [];
            stagedBefore = visible()[0]?.id;
            setButtonHeld(hidden());
        }
        setGoal(to);
        setShown((n) => Math.min(to, Math.max(n, target) + MORE_TURNS));
        // Solid has inserted those synchronously: staged before they're laid out (nothing on screen moves).
        settleRows?.();
        stage();
        restore();
        growMore?.();
        // The next page fetched now, above what's drawn (nothing on screen moves): the next "Show earlier" has it.
        if (hiddenHere() < PAGE && p.handle.view.earlier && !loadingEarlier()) void loadEarlier(p.handle, { count: PAGE });
    };
    const toggleWork = (el: HTMLElement, toggle: () => void) => {
        const top = el.getBoundingClientRect().top;
        smoothScroll = false;
        setStick(false);
        toggle();
        if (scroller) scroller.scrollTop = anchoredTop(scroller.scrollTop, el.getBoundingClientRect().top, top);
        wrote();
        reading = capture();
    };

    // A row the reader opens or folds (a command, a tool call, a thought) stays where it was clicked: what it adds
    // goes below it, not glided or scrolled to the end. Where it is is taken as the click starts (the capture phase),
    // and kept after the row's own handler has run (in the scroller's onClick, which the event reaches after the
    // row's). Opened at the end, the end isn't followed any more: the reader is reading what they opened.
    let toggled: { el: Element; top: number } | undefined;
    const toggling = (e: Event) => {
        toggled = undefined;
        const target = e.target as Element | null;
        // A button's Enter or Space comes as a click.
        if (e.type === "keydown" && ((e as KeyboardEvent).key !== "Enter" && (e as KeyboardEvent).key !== " " || target?.tagName === "BUTTON")) return;
        const el = target?.closest?.("[aria-expanded]:not([aria-haspopup])");
        if (el) toggled = { el, top: el.getBoundingClientRect().top };
    };
    const toggledRow = () => {
        const t = toggled;
        toggled = undefined;
        if (!t || !scroller || !t.el.isConnected) return;
        // Where a running glide drew it is where the reader saw it: the glide stops, and the row stays there.
        stopGlide();
        smoothScroll = false;
        const next = anchoredTop(scroller.scrollTop, t.el.getBoundingClientRect().top, t.top);
        if (Math.abs(next - scroller.scrollTop) > 0.5) scroller.scrollTop = next;
        // Followed again if the end is in view after it (folded with all of it showing): as a scroll there would.
        setStick(trimmed() === 0 && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1);
        wrote();
        reading = capture();
    };

    // The words stop (a tool, the reply's end): what they write next is counted afresh. The room stays while the turn
    // runs (taken back, it would move the conversation down, and up again as the words go on); once it's over, it goes.
    createEffect(on(wordsFlowing, (flowing, was) => {
        if (!FOLLOW_ROOM || !was || flowing) return;
        wordsStopped();
        settleRoom();
    }, { defer: true }));
    createEffect(on(() => turns().at(-1)?.status === "running", (running, was) => {
        if (FOLLOW_ROOM && was && !running) settleRoom();
    }, { defer: true }));

    // The composer opening or closing its large size (Composer.tsx): following the end, the end stays just above it,
    // gliding with its edge from where it was drawn. Here, as the dock's new height is set: before it's drawn.

    createEffect(on(() => p.dock, (now, was) => {
        if (!takeDockGlide() || now === undefined || was === undefined || !scroller || !stick() || smoothScroll) return;
        stopGlide();
        scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
        wrote();
        const ms = motionMs(GROW_MS);
        const from = now - was;
        if (!ms || Math.abs(from) < 1 || !content || typeof content.animate !== "function") return;
        pinned = { at: performance.now(), from: scroller.scrollTop - from };
        glides = inSight(Math.abs(from)).map((el) => ({ el, from, anim: el.animate([{ transform: `translateY(${from}px)` }, { transform: "none" }], { duration: ms, easing: GROW_EASE }) }));
    }));

    // Sending a prompt jumps back down: a new turn at the end, not earlier ones put in above (loadEarlier).
    createEffect(
        on(
            () => [turns().length, turns()[turns().length - 1]?.id] as const,
            ([n, last], prev) => {
                if (prev !== undefined && n > prev[0] && last !== prev[1] && turns()[n - 1]?.prompt) {
                    setTrimmed(0);
                    setStick(true);
                    afterLayout(() => toBottom(true));
                }
            },
        ),
    );

    // Where the last scroll left it. Only the reader's own scroll up, away from the end, unsticks it: content
    // growing below moves nothing, the column shrinking above (a fold) pulls it up without moving it away from
    // the end, and our own writes go down. Moving down near the end sticks it again.
    const onScroll = () => {
        if (!scroller || !ready) return;
        const top = scroller.scrollTop;
        const gap = scroller.scrollHeight - scroller.clientHeight - top;
        if (gap <= 1) smoothScroll = false;
        const size = sizeOf(scroller);
        const resized = size !== lastSize;
        lastSize = size;
        const up = top < lastTop - 0.5 && gap > lastGap + 0.5;
        // Not every scroll up is the reader's (their wheel and keys unpin it before the scroll comes):
        // - the column changing size: WebKit clamps the position to a shorter column for a moment mid-update
        //   (a row replaced by another), then it grows back. The ResizeObserver puts it back at the end.
        // - just after a pin: WebKit can put the position back where it was, the end of the column before it
        //   grew (its scrolling thread hadn't the new size yet). Written again at once, before it's drawn
        //   there; by now the new size is known.
        // A pointer or finger down (the scrollbar dragged) is always the reader.
        // - just after the content changed, at the same size: WebKit's clamp mid-update again, the column
        //   back to its size by the time the scroll is told (a row removed, another added).
        // Each is put back at the end at once. A pointer or finger down (the scrollbar dragged) is always the
        // reader, and so is a run of them (a drag without pointer events; the engine's come one or two at a time).
        const now = performance.now();
        const undone = now - pinned.at < ENGINE_MS && Math.abs(top - pinned.from) <= 1;
        repinned = repinned.filter((t) => now - t < REPIN_MS);
        const engine = !pressed && repinned.length < 2 && (resized || undone || now - mutatedAt < MUTATION_MS);
        if (up && engine && stick() && !smoothScroll) {
            repinned.push(now);
            scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
            wrote();
            return;
        }
        if (up) setStick(false);
        else if (trimmed() === 0 && atBottom(top, scroller.scrollHeight, scroller.clientHeight) && (gap <= 1 || top > lastTop + 0.5)) setStick(true);
        const moved = Math.abs(top - lastTop) > 0.5;
        lastTop = top;
        lastGap = gap;
        measureEnd();
        // Following the end, nothing is anchored (every way out of it takes its own reading). Read further up, a scroll
        // that moved is the reader going somewhere else. One that didn't is our own write's, a frame later: what's above
        // may have grown since (an image getting its size), so the place read is put back before it's read again.
        if (!stick()) {
            if (!moved) {
                restore();
                recapture();
            } else reading = capture();
            // Read up toward the top of what's here: the next page is fetched now, above what's drawn, so "Show
            // earlier" has it when it's reached. Only for a reader who goes up there: nothing more is fetched otherwise.
            if (top < scroller.clientHeight * 1.5 && hiddenHere() < PAGE && p.handle.view.earlier && !loadingEarlier()) void loadEarlier(p.handle, { count: PAGE });
        }
        // Growth above seen here lands here, before it's drawn.
        else if (grewAbove() && !smoothScroll) toBottom();
    };
    /** Find moved to a match: up from the end, it stops following (its scroll may come just after a write of ours). */
    const navigated = () => {
        if (scroller && scroller.scrollTop < lastTop - 0.5) {
            smoothScroll = false;
            setStick(false);
        }
        reading = capture();
    };
    const interruptJump = () => {
        if (!smoothScroll) return;
        smoothScroll = false;
        setStick(false);
        reading = capture();
    };
    /**
     * The reader about to leave the end: a reply still building from its end (BuiltFromEnd) is put in whole first, and
     * the end kept, while it's followed. Put in as they read up instead, it moved what they read (and each step was
     * taken for theirs, measured: a jump of thousands of px).
     */
    const finishAtEnd = () => {
        if (allIn() || !scroller) return;
        setAllIn(true);
        if (stick()) {
            scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
            wrote();
        }
    };
    /** The reader scrolling up (wheel, touch, keys): it stops following at once, however near the end. */
    const scrollUp = () => {
        // Following an end it can't scroll up from (the whole conversation fits), there's nothing to stop.
        if (!smoothScroll && (!stick() || !scroller || scroller.scrollTop <= 0)) return;
        finishAtEnd();
        smoothScroll = false;
        setStick(false);
        reading = capture();
    };
    /** A pointer or finger down on the conversation: until it's lifted, scrolls up are the reader's even as it grows. */
    const press = () => {
        finishAtEnd();
        interruptJump();
        if (pressed) return;
        pressed = true;
        const lift = () => {
            pressed = false;
            for (const t of ["pointerup", "pointercancel", "touchend", "touchcancel"]) removeEventListener(t, lift, true);
        };
        for (const t of ["pointerup", "pointercancel", "touchend", "touchcancel"]) addEventListener(t, lift, true);
    };
    /** The reader moving down where it can't go further: at the end, it follows the end again (no scroll event comes to say so). */
    const downAtEnd = (target: EventTarget | null) => {
        if (scroller && !smoothScroll && trimmed() === 0 && gapOf(scroller) <= 1 && !innerTakes(target)) setStick(true);
    };
    /**
     * A box inside the conversation (a command's output) that takes the move down itself, or a field the keys type
     * into: the conversation doesn't move, so it doesn't follow the end again (the output read there would move).
     */
    const innerTakes = (target: EventTarget | null) => {
        for (let el = target as HTMLElement | null; el && el !== scroller; el = el.parentElement) {
            if (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return true;
            const scrolls = el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY);
            if (scrolls && el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
        }
        return false;
    };
    const onWheel = (e: WheelEvent) => {
        // A mostly sideways swipe (a wide code block, a table) isn't a scroll up, whatever its hair of deltaY.
        if (e.deltaY < 0 && -e.deltaY > Math.abs(e.deltaX)) scrollUp();
        else {
            interruptJump();
            if (e.deltaY > 0) downAtEnd(e.target);
        }
    };
    const onKey = (e: KeyboardEvent) => {
        toggledRow();
        if (["ArrowUp", "PageUp", "Home"].includes(e.key) || (e.key === " " && e.shiftKey)) scrollUp();
        else {
            interruptJump();
            if (["ArrowDown", "PageDown", "End", " "].includes(e.key)) downAtEnd(e.target);
        }
    };

    /** Finished turns a steer carried on, while the chain still runs: they stay open until it ends. */
    const held = createMemo(() => heldTurns(turns()));
    const running = () => Boolean(p.handle.view.state.busy && turns().at(-1)?.status === "running");

    const forkFrom = (t: Turn) => {
        const at = forkAnchor(turns(), turns().indexOf(t));
        if (at) void fork(p.handle.id, at);
    };

    /** Draws the pages down to this turn and stops following the end, to show something in it. */
    const show = (turnId: string) => {
        const i = turns().findIndex((t) => t.id === turnId);
        if (i < 0) return;
        reading = undefined; // Explicit navigation owns the next position.
        unstage();
        const need = turns().length - i;
        // Far above what's drawn (a find a thousand turns up): a page around it, and the turns below it go in a few at
        // a time after, as when opened there. Drawn all at once down to it, they were a frame of hundreds of turns.
        if (need > shown() + PAGE) {
            const half = Math.floor(PAGE / 2);
            setShown(Math.min(turns().length, need + half));
            setTrimmed(Math.max(0, need - 1 - half));
            growMore?.();
        } else {
            setTrimmed(0);
            if (shown() < need) setShown(Math.ceil(need / PAGE) * PAGE);
        }
        smoothScroll = false;
        setStick(false);
    };

    // The session come again from the server (a reconnect, a reload), which may have read it in anew and numbered its
    // turns anew: the place read stays on its turn (the turns back to it first, if it didn't come with them), and the
    // work logs open stay open on theirs. The turn gone, the view goes to the end.
    let disposed = false;
    onCleanup(() => (disposed = true));
    const placeAgain = async (was: TranscriptPosition) => {
        const key = !was.bottom ? was.keys?.anchor : undefined;
        const loading = key && loadEarlierTo(p.handle, key);
        if (loading) {
            // Not restored meanwhile to the turn that has its id now.
            reading = undefined;
            await loading;
            if (disposed) return;
        }
        const now = placedAgain(turns(), was);
        openWork.clear();
        for (const w of now.openWork) openWork.add(w);
        // Following the end, or the reader went there meanwhile.
        if (stick()) return;
        if (now.bottom) {
            setTrimmed(0);
            setStick(true);
            toBottom();
            return;
        }
        if (!now.anchor) return;
        reading = now.anchor;
        const need = turns().length - turns().findIndex((t) => t.id === now.anchor!.turnId);
        unstage();
        setTrimmed(0);
        if (shown() < need) setShown(Math.ceil(need / PAGE) * PAGE);
        restore();
    };
    onCleanup(onRenew(p.handle, () => {
        const was = keyed(turns(), { bottom: stick(), top: 0, anchor: reading, openWork: [...openWork] });
        return () => void placeAgain(was);
    }));


    // A message found from ⌘K: its turn, briefly marked, with the find bar on what was searched.
    const [anchor, setAnchor] = createSignal<FindAnchor>();
    const jump = (j: { role: FindAnchor["role"]; query: string }, turn: Turn | undefined) => {
        if (!turn) return toast("That message isn't here any more.");
        show(turn.id);
        setAnchor({ turnId: turn.id, role: j.role });
        setFindQuery(j.query);
        openFind();
        afterLayout(() => {
            const el = turnEls.get(turn.id);
            if (!el || !scroller) return;
            scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - BAR_ROOM;
            wrote();
            reading = capture();
            el.classList.remove("flash");
            void el.offsetWidth;
            el.classList.add("flash");
            setTimeout(() => el.classList.remove("flash"), 1800);
        });
    };
    createEffect(() => {
        const j = jumpTarget();
        if (!j || j.sessionId !== p.handle.id || !turns().length) return;
        untrack(() => {
            setJumpTarget(undefined);
            const found = turnAt(turns(), j.seg, j.index);
            // The last before a gap may be it, or one of those the gap stands for: the page is fetched again from it.
            const gap = p.handle.view.gap;
            if (gap ? found && found.id !== gap.after : found || !p.handle.view.earlier) return jump(j, found);
            // Before the turns the session opened with: those back to it come first.
            void loadEarlier(p.handle, { through: { seg: j.seg, index: j.index }, upTo: JUMP_PAGE }).then(() => untrack(() => jump(j, turnAt(turns(), j.seg, j.index))));
        });
    });

    // While the panels slide (lib/layout.ts heldSizes), the conversation keeps one size, placed where it ends up
    // and drawn from where it was by a translate in step with the slide: laid out once, moved by the compositor.
    // From the column's end if it's following the end, else from its top.
    let box: HTMLDivElement | undefined;
    let moving: Animation | undefined;
    /** Where the column of text starts in its box, as last laid out (the resize observer keeps it). */
    let columnLeft: number | undefined;
    /** This slide's box is held from the column's end (it was following the end as the slide began). */
    let fromEnd = false;
    const atEnd = createMemo(on(() => panelHold()?.slide, (slide) => !!slide && untrack(stick)));
    const hold = () => {
        const held = panelHold();
        return held && { width: `${held.column.w * share()}px`, height: `${held.column.h}px`, top: `${atEnd() ? held.to.h - held.column.h : 0}px` };
    };
    // The hold ending puts the box back at the column's top. Held from the end and scrolled up meanwhile (not
    // following the end any more), it's scrolled by as much, so what's read stays where it is.
    createEffect(on(panelHold, (held, before) => {
        if (held || !before || !scroller || !fromEnd || stick()) return;
        const top = before.to.h - before.column.h;
        if (!top) return;
        scroller.scrollTop -= top;
        wrote();
        reading = capture();
    }, { defer: true }));
    createEffect(on(() => panelHold()?.slide, (slide) => {
        // A slide that cuts another short starts from where that one had drawn the column, not from where it was going.
        const drawn = slide && box && moving?.playState === "running" ? new DOMMatrixReadOnly(getComputedStyle(box).transform).m41 : 0;
        moving?.cancel();
        moving = undefined;
        const held = panelHold();
        if (slide) fromEnd = atEnd();
        // From where the column's left edge was: text is set from the left, so that edge is the line the eye follows.
        // (While the column is centred at its full width at both ends, that's half the difference of the widths. Once
        // it's narrower than that at one end it isn't, and the edge jumped one way before sliding the other.)
        const x = !held ? 0 : drawn + (slide && content && columnLeft !== undefined ? columnLeft - content.offsetLeft : ((held.from.w - held.to.w) / 2) * share());
        const y = held && atEnd() ? held.from.h - held.to.h : 0;
        if (!slide || !box || (!x && !y)) return;
        const { duration, easing } = slide.effect!.getTiming();
        moving = box.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: "none" }], { duration: Number(duration), easing });
        // Both start on the next frame; this keeps them together if they don't.
        void slide.ready.then(() => { if (moving && slide.startTime !== null) moving.startTime = slide.startTime; }, () => {});
    }));
    onCleanup(() => moving?.cancel());

    const rewind = (index: number) => {
        rewindTarget.set(index);
        setRewindOpen(true);
    };

    return (
        <div class="transcript-wrap">
            {/* Keeps one size while the panels slide (lib/layout.ts heldSizes): the conversation is laid out once, not every frame. */}
            <div class="transcript-hold" ref={box} classList={{ held: !!hold() }} style={hold()}>
            <div class="transcript" ref={scroller} style={{ "--dock-h": dock() }} onScroll={onScroll} onWheel={onWheel} onTouchStart={press} onPointerDown={press} onKeyDown={onKey} onClick={toggledRow} aria-label="Conversation">
                {/* Clips the column's glide, so a translate never adds to what the conversation scrolls through. */}
                <div class="transcript-glide">
                <div class="transcript-col" ref={content}>
                    <Show when={p.handle.view.state.forkOf}>
                        {(f) => (
                            <button class="forked-from" title="Open the original session" onClick={() => void activate(f().id)}>
                                <GitFork size={13} /> Forked from <span class="truncate">{f().title}</span>
                            </button>
                        )}
                    </Show>
                    {/* Started from another session's plan (in a new worktree): that session, a click away. */}
                    <For each={(p.handle.view.state.planLinks ?? []).filter((l) => l.role === "from")}>
                        {(l) => (
                            <button class="forked-from" title="Open the planning session" onClick={() => void activate(l.session)}>
                                <ArrowUpLeft size={13} /> Plan from <span class="truncate">“{app.sessions.find((s) => s.id === l.session)?.title ?? app.archived.find((s) => s.id === l.session)?.title ?? l.title ?? "another session"}”</span>
                            </button>
                        )}
                    </For>
                    <Show when={hidden()}>
                        <button class="earlier" onClick={() => void earlier()} disabled={loadingEarlier()} aria-disabled={buttonHeld() !== undefined || undefined}>
                            Show {Math.min(PAGE, hidden())} earlier {hidden() === 1 ? "turn" : "turns"}
                        </button>
                    </Show>
                    <DrawnAgain.Provider value={() => settling}>
                    <BuiltFromEnd.Provider value={builtFromEnd}>
                    <CardFoldsProvider sessionId={id}>
                        {/* As <For>, without keeping turns let go of (lib/keyed-list.ts). */}
                        <KeyedList each={visible()}>{(t) => <>
                            <TurnView turn={t} state={p.handle.view.state} agents={p.handle.view.agents} last={t === turns()[turns().length - 1]} onRewind={rewind} onFork={() => forkFrom(t)}
                                workOpen={openWork.has(t.id)} keepWorkOpen={() => !stick()} onWorkOpen={(open) => open ? openWork.add(t.id) : openWork.delete(t.id)} onToggleWork={toggleWork} held={held().has(t.id)} onElement={track} onFold={fold} />
                            <Show when={p.handle.view.gap?.after === t.id && p.handle.view.gap}>{(g) => <LaterTurns count={g().count} fill={() => fillGap(p.handle, PAGE, (n) => setShown((s) => s + n))} root={() => scroller} />}</Show>
                        </>}</KeyedList>
                    </CardFoldsProvider>
                    </BuiltFromEnd.Provider>
                    </DrawnAgain.Provider>
                    {/* Work that isn't a turn (a compaction, one while idle): it shows at the end, as a turn's would. */}
                    <Show when={p.handle.view.state.busy && specialActivity(p.handle.view.state.activity?.label) && !turns().some((t) => t.status === "running")}>
                        <div class="turn">
                            <div class="reply">
                                <LiveLine
                                    state={liveLine({ blocks: [], activity: p.handle.view.state.activity, interactions: [], showThinking: false })}
                                    hint={p.handle.view.state.activity?.idle ? "Send a message to stop it" : undefined}
                                />
                            </div>
                        </div>
                    </Show>
                    <div class="transcript-end" style={{ "--dock-h": dock() }} />
                </div>
                {/* The room a reply writes into (follow): outside the column, so making it doesn't resize what's observed. */}
                <div class="transcript-room" style={{ height: room() ? `${room()}px` : undefined }} />
                </div>
            </div>
            </div>
            <Show when={finding()}>
                <FindBar turns={turns} earlier={() => p.handle.view.earlier ?? 0} gap={findGap} elsewhere={(query, before, folded, gap) => rpc.call("session.find", { id: p.handle.id, query, before, ...(folded.length ? { turns: folded } : {}), ...(gap ? { gap } : {}) }).then((r) => r.matches)} bring={(m) => loadEarlier(p.handle, m.pos ? { through: m.pos, upTo: JUMP_PAGE } : { all: true }).then(() => undefined)} whole={(turnId) => loadTurn(p.handle, turnId)} scroller={() => scroller} dock={() => p.dock ?? 0} col={() => content} show={show} anchor={anchor} clearAnchor={() => setAnchor(undefined)} onNavigate={navigated} />
            </Show>
            <Show when={!stick() && !scrolledDown()}>
                {/* It has the dock's height itself (it isn't inherited). */}
                <button class="jump glass" style={{ "--dock-h": dock(), "--over": floatOver() }} classList={{ "is-live": running() }} title="Jump to latest" aria-label={running() ? "Jump to latest: still working" : "Jump to latest"} onClick={() => { setTrimmed(0); setStick(true); toBottom(true); }}>
                    {/* Still working down there: a spinner, where the arrow is. */}
                    <Show when={running()} fallback={<ArrowDown size={14} />}>
                        <Spinner size={12} />
                    </Show>
                    Latest
                </button>
            </Show>
        </div>
    );
}

/**
 * The turns between a page fetched far up (a jump to a turn there) and those after it the window has: put in a page at a
 * time as they're read down to, a screen before they're in sight, or at the click. Not on their own while this is in
 * sight: they'd push the turns below it away from the reader (2 runs in 3 moved them 530-2,380 px, headless).
 */
function LaterTurns(p: { count: number; fill: () => Promise<boolean | "moved">; root: () => HTMLElement | undefined }) {
    let el: HTMLButtonElement | undefined;
    const [busy, setBusy] = createSignal(false);
    let near = false;
    /** Asks the observers where it is now (observing again reports at once): more, if it's still a screen away. */
    let lookAgain = () => {};
    const go = (clicked?: boolean) => {
        if (busy()) return;
        setBusy(true);
        const failed = () => {
            setBusy(false);
            if (clicked) toast("Couldn't load later turns.");
        };
        void p.fill().then(
            (ok) => {
                if (ok === false) return failed();
                setBusy(false);
                // Its gap went meanwhile (another jump, the session renewed): nothing to say or do.
                if (ok === "moved") return;
                // The page that came may be short of the screen. One that didn't come waits to be read down to again,
                // or a click: asked again at once, a dropped connection's at-once refusal would never let go.
                lookAgain();
            },
            failed,
        );
    };
    onMount(() => {
        const root = p.root();
        if (!el || !root || typeof IntersectionObserver === "undefined") return;
        // A screen away and out of sight, where it is now: the observers report one at a time, each with its own news.
        const auto = () => {
            if (!near || busy() || !el) return;
            const r = el.getBoundingClientRect(), v = root.getBoundingClientRect();
            if (r.bottom > v.top && r.top < v.bottom) return;
            go();
        };
        const close = new IntersectionObserver((entries) => {
            for (const e of entries) near = e.isIntersecting;
            auto();
        }, { root, rootMargin: "100% 0px" });
        // Leaving sight while still near (read back up from it).
        const sight = new IntersectionObserver(auto, { root });
        lookAgain = () => {
            if (!el?.isConnected) return;
            close.unobserve(el);
            close.observe(el);
        };
        close.observe(el);
        sight.observe(el);
        onCleanup(() => {
            close.disconnect();
            sight.disconnect();
        });
    });
    return (
        <button ref={el} class="earlier later" onClick={() => go(true)} disabled={busy()}>
            Show {Math.min(40, p.count)} later {p.count === 1 ? "turn" : "turns"}
        </button>
    );
}

