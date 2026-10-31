import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { ArrowDown, ArrowUpLeft, GitFork } from "lucide-solid";
import type { Turn } from "@shared/protocol";
import { fork, forkAnchor } from "../state/actions";
import { activate, app, toast, type SessionHandle } from "../state/app";
import { findOpen, jumpTarget, openFind, panelHold, setFindQuery, setFollowing, setJumpTarget, setRewindOpen, takeDockGlide } from "../state/ui";
import { GROW_EASE, GROW_MS } from "../lib/composer-size";
import { prefs } from "../state/prefs";
import { anchoredTop, atBottom, FAR, firstBelow, firstWindow, MORE_TURNS, restoredShown, turnHeight, transcriptPositions, TURN_PAGE as PAGE, type ScrollAnchor } from "../lib/transcript-scroll";
import { turnAt } from "../lib/find";
import { GLIDE_MAX, glideFrom, heldTurns, liveLine, specialActivity } from "../lib/live-line";
import { DrawnAgain, revealing } from "../lib/reveal";
import { observeWorkRendering } from "../lib/work-rendering";
import { TurnView } from "./TurnView";
import { LiveLine, motionMs } from "./LiveLine";
import { CardFoldsProvider } from "./blocks/Activity";
import { Spinner } from "./ui/bits";
import { rewindTarget } from "./RewindDialog";
import { BAR_ROOM, FindBar, type FindAnchor } from "./FindBar";

/** How long new content takes to glide into place at the end, before Settings → Motion scales it. */
const GLIDE_MS = 240;
/** A scroll back to where a pin moved from, this soon after, is the engine undoing it (onScroll), not the reader. */
const ENGINE_MS = 250;
/** A scroll up this soon after the column's content changed is the layout's (onScroll), not the reader's. */
const MUTATION_MS = 40;
/** A third scroll up within this of two taken for the engine's is the reader's (a scrollbar dragged). */
const REPIN_MS = 300;
const GLIDE_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
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
 * The entrances rows play as they first come in (a step rising into the work, "Worked for" fading in), over at once:
 * a conversation drawn again (a session switched back to) shows them where they are rather than bringing all of them
 * in a second time. Endless ones (a spinner, the writing dot) go on.
 */
function finishEntrances(el: HTMLElement) {
    if (typeof el.getAnimations !== "function") return;
    for (const a of el.getAnimations({ subtree: true })) if (a.effect?.getComputedTiming().iterations !== Infinity) a.finish();
}

/** `dock`: the composer dock's height (undefined until it's measured). */
export function Transcript(p: { handle: SessionHandle; dock?: number }) {
    // --dock-h goes on each box that reads it (stage.css): not inherited, and not passed down with `inherit`.
    const dock = () => (p.dock === undefined ? undefined : `${p.dock}px`);
    let scroller: HTMLDivElement | undefined;
    let content: HTMLDivElement | undefined;
    // SessionView is keyed by handle; save on disposal, restore on the next mount.
    const id = p.handle.id;
    const saved = transcriptPositions.get(id);
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
        : firstWindow(p.handle.view.turns.map(turnHeight), target, opensAtEnd ? undefined : anchorIndex, window.innerHeight, -(saved?.anchor?.offset ?? 0));
    const [shown, setShown] = createSignal(first.shown);
    /** Turns at the very end not mounted yet (reopened mid-way: those below the place read go in first). */
    const [trimmed, setTrimmed] = createSignal(first.trimmed);
    let reading = saved?.anchor;
    let ready = false;
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
    const visible = createMemo(() => {
        const t = turns();
        return t.slice(Math.max(0, t.length - shown()), t.length - trimmed());
    });
    /** Turns above the page, for "Show earlier" (not those still going in at first: grow, in onMount). */
    const hidden = () => Math.max(0, turns().length - Math.max(shown(), target));

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

    // Pinned to the end while a turn runs, new content glides in rather than jumping: one scrollTop write a
    // frame (to the end, at once), then a short compositor-only translate from where it was drawn to where it
    // is, picked up from wherever a glide still running is. Scrolling runs no script of ours. Only what's in
    // sight (or glides into it) moves, not the whole column: a long conversation costs no more to glide.
    let pinFrame = 0;
    /** The running glide: the same translate on each of the column's rows in sight. */
    let glides: { el: HTMLElement; anim: Animation }[] = [];
    /** A fold's moves (fold()): what's above an answer, coming down. */
    let folds: { el: HTMLElement; anim: Animation }[] = [];
    const translate = (el: Element) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
    /** How far a running glide has the rows in sight drawn from their place (px). */
    const shift = () => {
        const g = glides[0];
        return g?.anim.playState === "running" ? translate(g.el) : 0;
    };
    const cancelGlide = () => {
        for (const g of glides) g.anim.cancel();
        glides = [];
    };
    const stopGlide = () => {
        cancelAnimationFrame(pinFrame);
        pinFrame = 0;
        cancelGlide();
        for (const f of folds) f.anim.cancel();
        folds = [];
    };
    /** The column's rows in the view, or within `px` of it, from the end up (where a pin leaves it, a few). */
    const inSight = (px: number) => {
        const out: HTMLElement[] = [];
        if (!scroller || !content) return out;
        const view = scroller.getBoundingClientRect();
        for (let el = content.lastElementChild as HTMLElement | null; el; el = el.previousElementSibling as HTMLElement | null) {
            const box = el.getBoundingClientRect();
            if (box.bottom < view.top - px) break;
            if (box.top <= view.bottom + px) out.push(el);
        }
        return out;
    };
    /**
     * Something in the upper part of the view, and where it is in the column (by layout: a glide's translate isn't
     * counted). Moved down since it was last looked at, it means what changed is above what the reader sees: an image
     * getting its size, rows drawn again after being skipped, turns going in. Following the end, the view then stays
     * still at once, before the frame is drawn. Only growth in view, or at the end, glides. Asked on every change of
     * size, every scroll while following and every glide's frame, each acting on what it finds (one only looking would
     * take growth it saw for where things are).
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
        const moved = !!content && seen !== undefined && seen.el.isConnected && layoutTop(seen.el) - layoutTop(content) > seen.top + 0.5;
        look();
        return moved;
    };
    const pin = () => {
        if (pinFrame) return;
        pinFrame = requestAnimationFrame(() => {
            pinFrame = 0;
            if (!scroller || !stick() || smoothScroll) return;
            // Grown above what's in view since this was asked for (an image in the turns that just went in): no glide.
            if (grewAbove()) return toBottom();
            const before = scroller.scrollTop;
            const end = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
            if (Math.abs(end - before) <= 0.5) return;
            scroller.scrollTop = end;
            wrote();
            pinned = { at: performance.now(), from: before };
            const ms = motionMs(GLIDE_MS);
            if (!ms || !content || typeof content.animate !== "function") return;
            const running = shift();
            cancelGlide();
            const from = glideFrom(scroller.scrollTop - before, running);
            if (from === undefined) return;
            // Placed with the last glide gone; a row farther than `from` from the view never comes into it.
            glides = inSight(Math.abs(from)).map((el) => ({ el, anim: el.animate([{ transform: `translateY(${from}px)` }, { transform: "none" }], { duration: ms, easing: GLIDE_EASE }) }));
        });
    };

    /**
     * A finished turn's work folds into "Worked for" (TurnView, once it has faded out). Following the end, the answer
     * stays put and what's above it comes down by what folded away: drawn from where it was, it glides down rather
     * than jumping, as growth glides up.
     */
    const fold = (turn: HTMLElement, run: () => void) => {
        const ms = motionMs(GLIDE_MS);
        if (!scroller || !content || !turn.isConnected || !stick() || smoothScroll || !ms || typeof content.animate !== "function") return run();
        // The turn's top (its prompt): where it was, and where it is once the work has folded.
        const was = turn.getBoundingClientRect().top;
        const running = shift();
        run();
        toBottom();
        const moved = was - turn.getBoundingClientRect().top;
        // A fold is one move, not growth that goes on: all the way, up to a screen.
        const max = scroller.clientHeight;
        if (glideFrom(moved, 0, max) === undefined) return;
        // What moved: the column's rows above the turn in sight (or coming into it on the way), the turn's parts
        // before its reply, and "Worked for", which takes the work's place under the prompt.
        const rows = inSight(Math.min(Math.abs(moved), max));
        const at = rows.indexOf(turn);
        const parts = [...turn.children] as HTMLElement[];
        const reply = parts.find((el) => el.classList.contains("reply"));
        const els = [
            ...(at < 0 ? [] : rows.slice(at + 1)),
            ...parts.filter((el) => el !== reply),
            ...([...(reply?.children ?? [])] as HTMLElement[]).filter((el) => el.classList.contains("worked")),
        ];
        folds = folds.filter((f) => f.anim.playState === "running");
        for (const el of els) {
            // A row still gliding up goes on from where that glide has it.
            const glide = glides.find((g) => g.el === el);
            glide?.anim.cancel();
            const from = glideFrom(moved, glide ? running : 0, max);
            if (from !== undefined) folds.push({ el, anim: el.animate([{ transform: `translateY(${from}px)` }, { transform: "none" }], { duration: ms, easing: GLIDE_EASE }) });
        }
    };

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
        const els = visible().flatMap((t) => turnEls.get(t.id) ?? []);
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
    let far: IntersectionObserver | undefined;
    /** Each turn's element (TurnView gives it), so finding one doesn't search the whole column. */
    const turnEls = new Map<string, HTMLElement>();
    const track = (el: HTMLElement, turnId: string) => {
        turnEls.set(turnId, el);
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
                for (const e of entries) e.target.toggleAttribute(FAR, !e.isIntersecting);
                if (stick() || smoothScroll) return;
                let moved = 0;
                for (const n of near) if (n.was !== undefined) moved += n.el.getBoundingClientRect().height - n.was;
                if (Math.abs(moved) > 0.5) {
                    scroller!.scrollTop += moved;
                    wrote();
                }
            };
            far = new IntersectionObserver(relay(to), { root: scroller, rootMargin: "100% 0px" });
            for (const el of turnEls.values()) far.observe(el);
            onCleanup(() => {
                far?.disconnect();
                to.fn = undefined;
            });
        }
        onCleanup(observeWorkRendering(scroller, content, (moved) => {
            if (stick() || smoothScroll) return;
            scroller!.scrollTop += moved;
            wrote();
            reading = capture();
        }));
        const ro = new ResizeObserver(() => {
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
            else if (stick()) (running || revealing()) && !above ? pin() : toBottom();
            else {
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
        // Its first frame shows the conversation as it is: what was drawn for it lands, rather than coming in again.
        const settle = requestAnimationFrame(() => {
            settling = false;
            finishEntrances(content!);
        });
        onCleanup(() => cancelAnimationFrame(settle));
        // The rest of the turns this view shows, a few at a time once the first screen is painted: each batch goes in
        // above, between frames. Followed at the end, the end stays in view; read further up, the place read stays put.
        let growing = 0;
        let gone = false;
        const pending = () => trimmed() > 0 || shown() < target;
        const grow = () => {
            growing = 0;
            if (gone || !pending()) return;
            // Between frames, what went in last may have grown since it was put back (an image getting its size): the
            // place read is put back before it's read again, or the reader would be held where that pushed them.
            if (!stick()) {
                restore();
                reading = capture();
            }
            // Below the place read first, then above it.
            if (trimmed() > 0) setTrimmed((n) => Math.max(0, n - MORE_TURNS));
            else setShown((n) => (n >= target ? n : Math.min(target, n + MORE_TURNS)));
            // Solid has inserted them; before paint, the end (or the place read) where it was.
            if (stick()) toBottom();
            else restore();
            if (pending()) later();
        };
        // After the frame paints: a frame, then a task.
        const later = () => (growing = requestAnimationFrame(() => setTimeout(grow, 0)));
        if (pending()) later();
        onCleanup(() => {
            gone = true;
            cancelAnimationFrame(growing);
        });
    });
    onCleanup(() => {
        cancelAnimationFrame(frame);
        cancelAnimationFrame(jumpFrame);
        stopGlide();
        // A running log can finish while this keyed view is unmounted.
        if (!stick()) for (const turn of visible()) if (turn.status === "running") openWork.add(turn.id);
        transcriptPositions.set(id, {
            bottom: stick(), top: (ready ? scroller?.scrollTop : saved?.top) ?? 0,
            anchor: reading, openWork: [...openWork],
        });
    });

    const earlier = () => {
        reading = capture();
        smoothScroll = false;
        setStick(false);
        setShown((n) => Math.max(n, target) + PAGE);
        // Solid has inserted the page synchronously; compensate before paint.
        restore();
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

    // The composer opening or closing its large size (Composer.tsx): following the end, the end stays just above it,
    // gliding with its edge from where it was drawn. Here, as the dock's new height is set: before it's drawn.
    createEffect(() => setFollowing(stick()));
    onCleanup(() => setFollowing(false));

    createEffect(on(() => p.dock, (now, was) => {
        if (!takeDockGlide() || now === undefined || was === undefined || !scroller || !stick() || smoothScroll) return;
        stopGlide();
        scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
        wrote();
        const ms = motionMs(GROW_MS);
        const from = now - was;
        if (!ms || Math.abs(from) < 1 || !content || typeof content.animate !== "function") return;
        pinned = { at: performance.now(), from: scroller.scrollTop - from };
        glides = inSight(Math.abs(from)).map((el) => ({ el, anim: el.animate([{ transform: `translateY(${from}px)` }, { transform: "none" }], { duration: ms, easing: GROW_EASE }) }));
    }));

    // Sending a prompt jumps back down.
    createEffect(
        on(
            () => turns().length,
            (n, prev) => {
                if (prev !== undefined && n > prev && turns()[n - 1]?.prompt) {
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
            if (!moved) restore();
            reading = capture();
        }
        // Scroll events come before the frame's glide: growth above seen here lands here, before it's drawn.
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
    /** The reader scrolling up (wheel, touch, keys): it stops following at once, however near the end. */
    const scrollUp = () => {
        // Following an end it can't scroll up from (the whole conversation fits), there's nothing to stop.
        if (!smoothScroll && (!stick() || !scroller || scroller.scrollTop <= 0)) return;
        smoothScroll = false;
        setStick(false);
        reading = capture();
    };
    /** A pointer or finger down on the conversation: until it's lifted, scrolls up are the reader's even as it grows. */
    const press = () => {
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
        const need = turns().length - i;
        setTrimmed(0);
        if (shown() < need) setShown(Math.ceil(need / PAGE) * PAGE);
        smoothScroll = false;
        setStick(false);
    };

    // A message found from ⌘K: its turn, briefly marked, with the find bar on what was searched.
    const [anchor, setAnchor] = createSignal<FindAnchor>();
    createEffect(() => {
        const j = jumpTarget();
        if (!j || j.sessionId !== p.handle.id || !turns().length) return;
        untrack(() => {
            setJumpTarget(undefined);
            const turn = turnAt(turns(), j.seg, j.index);
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
        });
    });

    // While the panels slide (lib/layout.ts heldSizes), the conversation keeps one size, placed where it ends up
    // and drawn from where it was by a translate in step with the slide: laid out once, moved by the compositor.
    // From the column's end if it's following the end, else from its top.
    let box: HTMLDivElement | undefined;
    let moving: Animation | undefined;
    /** This slide's box is held from the column's end (it was following the end as the slide began). */
    let fromEnd = false;
    const atEnd = createMemo(on(() => panelHold()?.slide, (slide) => !!slide && untrack(stick)));
    const hold = () => {
        const held = panelHold();
        return held && { width: `${held.column.w}px`, height: `${held.column.h}px`, top: `${atEnd() ? held.to.h - held.column.h : 0}px` };
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
        moving?.cancel();
        moving = undefined;
        const held = panelHold();
        if (slide) fromEnd = atEnd();
        const x = held ? (held.from.w - held.to.w) / 2 : 0;
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
            <div class="transcript-fade" aria-hidden="true" />
            {/* Keeps one size while the panels slide (lib/layout.ts heldSizes): the conversation is laid out once, not every frame. */}
            <div class="transcript-hold" ref={box} classList={{ held: !!hold() }} style={hold()}>
            <div class="transcript" ref={scroller} onScroll={onScroll} onWheel={onWheel} onTouchStart={press} onPointerDown={press} onKeyDown={onKey} onClick={toggledRow} aria-label="Conversation">
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
                        <button class="earlier" onClick={earlier}>
                            Show {Math.min(PAGE, hidden())} earlier {hidden() === 1 ? "turn" : "turns"}
                        </button>
                    </Show>
                    <DrawnAgain.Provider value={() => settling}>
                    <CardFoldsProvider sessionId={id}>
                        <For each={visible()}>{(t) => <TurnView turn={t} state={p.handle.view.state} agents={p.handle.view.agents} last={t === turns()[turns().length - 1]} onRewind={rewind} onFork={() => forkFrom(t)}
                            workOpen={openWork.has(t.id)} keepWorkOpen={() => !stick()} onWorkOpen={(open) => open ? openWork.add(t.id) : openWork.delete(t.id)} onToggleWork={toggleWork} held={held().has(t.id)} onElement={track} onFold={fold} />}</For>
                    </CardFoldsProvider>
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
                </div>
            </div>
            </div>
            <Show when={findOpen()}>
                <FindBar turns={turns} scroller={() => scroller} dock={() => p.dock ?? 0} col={() => content} show={show} anchor={anchor} clearAnchor={() => setAnchor(undefined)} onNavigate={navigated} />
            </Show>
            <Show when={!stick() && !scrolledDown()}>
                <button class="jump glass" style={{ "--dock-h": dock() }} classList={{ "is-live": running() }} title="Jump to latest" aria-label={running() ? "Jump to latest: still working" : "Jump to latest"} onClick={() => { setTrimmed(0); setStick(true); toBottom(true); }}>
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
