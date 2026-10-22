import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { ArrowDown, GitFork } from "lucide-solid";
import type { Turn } from "@shared/protocol";
import { fork, forkAnchor } from "../state/actions";
import { activate, toast, type SessionHandle } from "../state/app";
import { findOpen, jumpTarget, openFind, panelHold, setFindQuery, setJumpTarget, setRewindOpen } from "../state/ui";
import { prefs } from "../state/prefs";
import { anchoredTop, atBottom, FAR, restoredShown, transcriptPositions, TURN_PAGE as PAGE, type ScrollAnchor } from "../lib/transcript-scroll";
import { turnAt } from "../lib/find";
import { glideFrom, heldTurns, liveLine, specialActivity } from "../lib/live-line";
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

/**
 * An observer's callback that can be let go of. WebKit keeps an IntersectionObserver with a root alive after
 * disconnect(), and its callback with it: one closing over the transcript kept all of it (every turn's elements)
 * after the session was left. This one holds only `to`, which the transcript empties when it goes.
 */
function relay(to: { fn?: IntersectionObserverCallback }): IntersectionObserverCallback {
    return (entries, observer) => to.fn?.(entries, observer);
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
    const [shown, setShown] = createSignal(restoredShown(p.handle.view.turns.map((t) => t.id), saved));
    let reading = saved?.anchor;
    let ready = false;
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
    const wrote = () => {
        if (!scroller) return;
        lastTop = scroller.scrollTop;
        lastGap = scroller.scrollHeight - scroller.clientHeight - lastTop;
        lastSize = sizeOf(scroller);
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
        return t.length > shown() ? t.slice(t.length - shown()) : t;
    });
    const hidden = () => Math.max(0, turns().length - shown());

    const toBottom = (smooth = false) => {
        if (!scroller) return;
        const height = scroller.scrollHeight;
        // ResizeObserver can report both content and viewport without any new
        // scroll range. Avoid redundant writes (and restarting a smooth jump).
        if (Math.abs(Math.max(0, height - scroller.clientHeight) - scroller.scrollTop) <= 0.5) return;
        smoothScroll = smooth && prefs.motion !== "instant" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
        scroller.scrollTo({ top: height, behavior: smoothScroll ? "smooth" : "instant" });
        if (!smoothScroll) wrote();
    };

    // Pinned to the end while a turn runs, new content glides in rather than jumping: one scrollTop write a
    // frame (to the end, at once), then a short compositor-only translate from where it was drawn to where it
    // is, picked up from wherever a glide still running is. Scrolling runs no script of ours. Only what's in
    // sight (or glides into it) moves, not the whole column: a long conversation costs no more to glide.
    let pinFrame = 0;
    /** The running glide: the same translate on each of the column's rows in sight. */
    let glides: { el: HTMLElement; anim: Animation }[] = [];
    /** How far a running glide has the rows in sight drawn from their place (px). */
    const shift = () => {
        const g = glides[0];
        return g?.anim.playState === "running" ? new DOMMatrixReadOnly(getComputedStyle(g.el).transform).m42 : 0;
    };
    const cancelGlide = () => {
        for (const g of glides) g.anim.cancel();
        glides = [];
    };
    const stopGlide = () => {
        cancelAnimationFrame(pinFrame);
        pinFrame = 0;
        cancelGlide();
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
    const pin = () => {
        if (pinFrame) return;
        pinFrame = requestAnimationFrame(() => {
            pinFrame = 0;
            if (!scroller || !stick() || smoothScroll) return;
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

    const capture = (): ScrollAnchor | undefined => {
        if (!scroller || !content) return;
        // Where things are, not where a running glide draws them.
        const top = scroller.getBoundingClientRect().top + shift();
        const turn = [...content.querySelectorAll<HTMLElement>("[data-turn]")].find((el) => el.getBoundingClientRect().bottom > top);
        if (!turn) return;
        // A block anchor also survives replacing the live head with a work-log toggle.
        const part = [...turn.querySelectorAll<HTMLElement>("[data-find], .worklog")].find((el) => el.getBoundingClientRect().bottom > top);
        return {
            turnId: turn.dataset.turn!, offset: turn.getBoundingClientRect().top - top,
            part: part?.dataset.find ?? (part ? `worklog:${[...turn.querySelectorAll(".worklog")].indexOf(part)}` : undefined),
            partOffset: part ? part.getBoundingClientRect().top - top : undefined,
        };
    };
    const restore = () => {
        if (!scroller || !content || !reading) return;
        const turn = content.querySelector<HTMLElement>(`[data-turn="${CSS.escape(reading.turnId)}"]`);
        if (!turn) return;
        const part = reading.part?.startsWith("worklog:")
            ? turn.querySelectorAll<HTMLElement>(".worklog")[Number(reading.part.slice(8))]
            : reading.part ? turn.querySelector<HTMLElement>(`[data-find="${CSS.escape(reading.part)}"]`) : undefined;
        const el = part ?? turn;
        const box = el.getBoundingClientRect();
        const savedOffset = part && reading.partOffset !== undefined ? reading.partOffset : reading.offset;
        // A remounted prompt may be clamped again. If the saved reading point
        // no longer fits, show this anchor's top instead of skipping past it.
        const offset = savedOffset <= -box.height ? 0 : savedOffset;
        const next = anchoredTop(scroller.scrollTop, box.top - shift() - scroller.getBoundingClientRect().top, offset);
        // A no-op write would cancel an in-flight smooth Jump to latest.
        if (Math.abs(next - scroller.scrollTop) > 0.5) scroller.scrollTop = next;
        wrote();
    };

    // A turn a screen or more from the view is marked far: it skips its layout and paint (transcript.css), at the
    // size it was last drawn at. Each is drawn once before it can be (not far until the observer says so).
    let far: IntersectionObserver | undefined;
    const track = (el: HTMLElement) => {
        far?.observe(el);
        onCleanup(() => far?.unobserve(el));
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
            for (const el of content.querySelectorAll<HTMLElement>("[data-turn]")) far.observe(el);
            onCleanup(() => {
                far?.disconnect();
                to.fn = undefined;
            });
        }
        const ro = new ResizeObserver(() => {
            if (!ready) return;
            if (smoothScroll) toBottom(true);
            // Glides only while a turn is running: the end of a turn (its work folding away above, its footer,
            // the composer settling) lands at once.
            else if (stick()) turns().at(-1)?.status === "running" ? pin() : toBottom();
            else restore();
        });
        ro.observe(content);
        ro.observe(scroller);
        onCleanup(() => ro.disconnect());
        if (typeof MutationObserver !== "undefined") {
            const mo = new MutationObserver(() => (mutatedAt = performance.now()));
            mo.observe(content, { childList: true, subtree: true, characterData: true });
            onCleanup(() => mo.disconnect());
        }
        afterLayout(() => {
            if (stick()) toBottom();
            else { scroller!.scrollTop = saved?.top ?? 0; restore(); }
        });
    });
    onCleanup(() => {
        cancelAnimationFrame(frame);
        stopGlide();
        // A running log can finish while this keyed view is unmounted.
        if (!stick()) for (const turn of visible()) if (turn.status === "running") openWork.add(turn.id);
        transcriptPositions.set(id, {
            shown: shown(), bottom: stick(), top: (ready ? scroller?.scrollTop : saved?.top) ?? 0,
            anchor: reading, openWork: [...openWork],
        });
    });

    const earlier = () => {
        reading = capture();
        smoothScroll = false;
        setStick(false);
        setShown((n) => n + PAGE);
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

    // Sending a prompt jumps back down.
    createEffect(
        on(
            () => turns().length,
            (n, prev) => {
                if (prev !== undefined && n > prev && turns()[n - 1]?.prompt) {
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
        else if (atBottom(top, scroller.scrollHeight, scroller.clientHeight) && (gap <= 1 || top > lastTop + 0.5)) setStick(true);
        lastTop = top;
        lastGap = gap;
        reading = capture();
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
        if (!stick() && !smoothScroll) return;
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
    const onWheel = (e: WheelEvent) => {
        if (e.deltaY < 0) scrollUp();
        else interruptJump();
    };
    const onKey = (e: KeyboardEvent) => {
        if (["ArrowUp", "PageUp", "Home"].includes(e.key) || (e.key === " " && e.shiftKey)) scrollUp();
        else interruptJump();
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
            if (!turn) return toast("That message isn't in this session any more.");
            show(turn.id);
            setAnchor({ turnId: turn.id, role: j.role });
            setFindQuery(j.query);
            openFind();
            afterLayout(() => {
                const el = content?.querySelector<HTMLElement>(`[data-turn="${CSS.escape(turn.id)}"]`);
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
            <div class="transcript" ref={scroller} onScroll={onScroll} onWheel={onWheel} onTouchStart={press} onPointerDown={press} onKeyDown={onKey} aria-label="Conversation">
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
                    <Show when={hidden()}>
                        <button class="earlier" onClick={earlier}>
                            Show {Math.min(PAGE, hidden())} earlier {hidden() === 1 ? "turn" : "turns"}
                        </button>
                    </Show>
                    <CardFoldsProvider sessionId={id}>
                        <For each={visible()}>{(t) => <TurnView turn={t} state={p.handle.view.state} agents={p.handle.view.agents} last={t === turns()[turns().length - 1]} onRewind={rewind} onFork={() => forkFrom(t)}
                            workOpen={openWork.has(t.id)} keepWorkOpen={() => !stick()} onWorkOpen={(open) => open ? openWork.add(t.id) : openWork.delete(t.id)} onToggleWork={toggleWork} held={held().has(t.id)} onElement={track} />}</For>
                    </CardFoldsProvider>
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
            <Show when={!stick()}>
                <button class="jump glass" style={{ "--dock-h": dock() }} classList={{ "is-live": running() }} title="Jump to latest" aria-label={running() ? "Jump to latest: still working" : "Jump to latest"} onClick={() => { setStick(true); toBottom(true); }}>
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
