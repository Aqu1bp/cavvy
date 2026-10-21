import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { ArrowDown, GitFork } from "lucide-solid";
import type { Turn } from "@shared/protocol";
import { fork, forkAnchor } from "../state/actions";
import { activate, toast, type SessionHandle } from "../state/app";
import { findOpen, jumpTarget, openFind, setFindQuery, setJumpTarget, setRewindOpen } from "../state/ui";
import { prefs } from "../state/prefs";
import { anchoredTop, atBottom, restoredShown, transcriptPositions, TURN_PAGE as PAGE, type ScrollAnchor } from "../lib/transcript-scroll";
import { turnAt } from "../lib/find";
import { LiveHead, specialActivity, TurnView } from "./TurnView";
import { rewindTarget } from "./RewindDialog";
import { BAR_ROOM, FindBar, type FindAnchor } from "./FindBar";

export function Transcript(p: { handle: SessionHandle }) {
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
    const afterLayout = (fn: () => void) => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            fn();
            // A send or search may supersede the initial restoration frame.
            ready = true;
            reading = capture();
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
    };

    const capture = (): ScrollAnchor | undefined => {
        if (!scroller || !content) return;
        const top = scroller.getBoundingClientRect().top;
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
        const next = anchoredTop(scroller.scrollTop, box.top - scroller.getBoundingClientRect().top, offset);
        // A no-op write would cancel an in-flight smooth Jump to latest.
        if (Math.abs(next - scroller.scrollTop) > 0.5) scroller.scrollTop = next;
    };

    onMount(() => {
        if (!scroller || !content) return;
        const ro = new ResizeObserver(() => {
            if (!ready) return;
            if (stick() || smoothScroll) toBottom(smoothScroll);
            else restore();
        });
        ro.observe(content);
        ro.observe(scroller);
        onCleanup(() => ro.disconnect());
        afterLayout(() => {
            if (stick()) toBottom();
            else { scroller!.scrollTop = saved?.top ?? 0; restore(); }
        });
    });
    onCleanup(() => {
        cancelAnimationFrame(frame);
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

    const onScroll = () => {
        if (!scroller || !ready) return;
        if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1) smoothScroll = false;
        setStick(atBottom(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight));
        reading = capture();
    };
    const interruptJump = () => {
        if (!smoothScroll) return;
        smoothScroll = false;
        setStick(false);
        reading = capture();
    };

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
                reading = capture();
                el.classList.remove("flash");
                void el.offsetWidth;
                el.classList.add("flash");
                setTimeout(() => el.classList.remove("flash"), 1800);
            });
        });
    });

    const rewind = (index: number) => {
        rewindTarget.set(index);
        setRewindOpen(true);
    };

    return (
        <div class="transcript-wrap">
            <div class="transcript-fade" aria-hidden="true" />
            <div class="transcript" ref={scroller} onScroll={onScroll} onWheel={interruptJump} onTouchStart={interruptJump} onPointerDown={interruptJump} onKeyDown={interruptJump} aria-label="Conversation">
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
                    <For each={visible()}>{(t) => <TurnView turn={t} state={p.handle.view.state} agents={p.handle.view.agents} last={t === turns()[turns().length - 1]} onRewind={rewind} onFork={() => forkFrom(t)}
                        workOpen={openWork.has(t.id)} keepWorkOpen={() => !stick()} onWorkOpen={(open) => open ? openWork.add(t.id) : openWork.delete(t.id)} onToggleWork={toggleWork} />}</For>
                    {/* Work that isn't a turn (a compaction, one while idle): it shows at the end, as a turn's would. */}
                    <Show when={p.handle.view.state.busy && specialActivity(p.handle.view.state.activity?.label ?? "") && !turns().some((t) => t.status === "running")}>
                        <div class="turn">
                            <LiveHead state={p.handle.view.state} tail hint={p.handle.view.state.activity?.idle ? "send a message to stop it" : undefined} />
                        </div>
                    </Show>
                    <div class="transcript-end" />
                </div>
            </div>
            <Show when={findOpen()}>
                <FindBar turns={turns} scroller={() => scroller} col={() => content} show={show} anchor={anchor} clearAnchor={() => setAnchor(undefined)} onNavigate={() => { reading = capture(); }} />
            </Show>
            <Show when={!stick()}>
                <button class="jump glass" title="Jump to latest" aria-label="Jump to latest" onClick={() => { setStick(true); toBottom(true); }}>
                    <ArrowDown size={14} /> Latest
                </button>
            </Show>
        </div>
    );
}
