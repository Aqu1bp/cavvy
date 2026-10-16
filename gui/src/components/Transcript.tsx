import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { ArrowDown, GitFork } from "lucide-solid";
import type { Turn } from "@shared/protocol";
import { fork, forkAnchor } from "../state/actions";
import { activate, toast, type SessionHandle } from "../state/app";
import { findOpen, jumpTarget, openFind, setFindQuery, setJumpTarget, setRewindOpen } from "../state/ui";
import { turnAt } from "../lib/find";
import { TurnView } from "./TurnView";
import { rewindTarget } from "./RewindDialog";
import { BAR_ROOM, FindBar, type FindAnchor } from "./FindBar";

const PAGE = 40;

export function Transcript(p: { handle: SessionHandle }) {
    let scroller: HTMLDivElement | undefined;
    let content: HTMLDivElement | undefined;
    const [stick, setStick] = createSignal(true);
    const [shown, setShown] = createSignal(PAGE);
    const turns = () => p.handle.view.turns;
    const visible = createMemo(() => {
        const t = turns();
        return t.length > shown() ? t.slice(t.length - shown()) : t;
    });
    const hidden = () => Math.max(0, turns().length - shown());

    const toBottom = (smooth = false) => {
        if (!scroller) return;
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    };

    onMount(() => {
        if (!scroller || !content) return;
        // Whatever makes the content taller (a streamed token, an opened row), follow it while at the bottom.
        const ro = new ResizeObserver(() => {
            if (stick()) toBottom();
        });
        ro.observe(content);
        onCleanup(() => ro.disconnect());
        requestAnimationFrame(() => toBottom());
    });

    // A different session: start at its end.
    createEffect(
        on(
            () => p.handle.id,
            () => {
                setShown(PAGE);
                setStick(true);
                requestAnimationFrame(() => toBottom());
            },
            { defer: true },
        ),
    );

    // Sending a prompt jumps back down.
    createEffect(
        on(
            () => turns().length,
            (n, prev) => {
                if (prev !== undefined && n > prev && turns()[n - 1]?.prompt) {
                    setStick(true);
                    requestAnimationFrame(() => toBottom(true));
                }
            },
        ),
    );

    const onScroll = () => {
        if (!scroller) return;
        const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        setStick(gap < 64);
    };

    const forkFrom = (t: Turn) => {
        const at = forkAnchor(turns(), turns().indexOf(t));
        if (at) void fork(p.handle.id, at);
    };

    /** Draws the pages down to this turn and stops following the end, to show something in it. */
    const show = (turnId: string) => {
        const i = turns().findIndex((t) => t.id === turnId);
        if (i < 0) return;
        const need = turns().length - i;
        if (shown() < need) setShown(Math.ceil(need / PAGE) * PAGE);
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
            requestAnimationFrame(() => {
                const el = content?.querySelector<HTMLElement>(`[data-turn="${CSS.escape(turn.id)}"]`);
                if (!el || !scroller) return;
                scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - BAR_ROOM;
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
            <div class="transcript" ref={scroller} onScroll={onScroll} aria-label="Conversation">
                <div class="transcript-col" ref={content}>
                    <Show when={p.handle.view.state.forkOf}>
                        {(f) => (
                            <button class="forked-from" title="Open the original session" onClick={() => void activate(f().id)}>
                                <GitFork size={13} /> Forked from <span class="truncate">{f().title}</span>
                            </button>
                        )}
                    </Show>
                    <Show when={hidden()}>
                        <button class="earlier" onClick={() => setShown((n) => n + PAGE)}>
                            Show {Math.min(PAGE, hidden())} earlier {hidden() === 1 ? "turn" : "turns"}
                        </button>
                    </Show>
                    <For each={visible()}>{(t) => <TurnView turn={t} state={p.handle.view.state} agents={p.handle.view.agents} last={t === turns()[turns().length - 1]} onRewind={rewind} onFork={() => forkFrom(t)} />}</For>
                    <div class="transcript-end" />
                </div>
            </div>
            <Show when={findOpen()}>
                <FindBar turns={turns} scroller={() => scroller} col={() => content} show={show} anchor={anchor} clearAnchor={() => setAnchor(undefined)} />
            </Show>
            <Show when={!stick()}>
                <button class="jump" onClick={() => { setStick(true); toBottom(true); }}>
                    <ArrowDown size={14} /> Jump to latest
                </button>
            </Show>
        </div>
    );
}
