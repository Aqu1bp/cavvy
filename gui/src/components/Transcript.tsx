import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { ArrowDown, GitFork } from "lucide-solid";
import type { Turn } from "@shared/protocol";
import { activate, type SessionHandle } from "../state/app";
import { fork, forkAnchor } from "../state/actions";
import { setRewindOpen } from "../state/ui";
import { TurnView } from "./TurnView";
import { rewindTarget } from "./RewindDialog";

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
            <Show when={!stick()}>
                <button class="jump" onClick={() => { setStick(true); toBottom(true); }}>
                    <ArrowDown size={14} /> Jump to latest
                </button>
            </Show>
        </div>
    );
}
