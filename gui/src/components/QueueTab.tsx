import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { CirclePause, CornerDownRight, GripVertical, ListEnd, Paperclip, Pencil, X } from "lucide-solid";
import type { SessionState } from "@shared/protocol";
import { reportError, rpc, toast } from "../state/app";
import { clampDrag, dragTarget, joiningRow, moved, movedAnnouncement, queueRow, settleMs, slotOf, stepTarget } from "../lib/queue";
import { splitComments } from "../lib/review-comments";
import { plural } from "../lib/format";

/**
 * A reorder in progress. `ids` is the queue when it began; `from` and `to` are places in it. While it's
 * held ("drag") the row follows the pointer `dy` from its own place; let go, it "settle"s into its slot,
 * then "wait"s, still drawn there, until the queue shows the move (or doesn't: then the rows go back).
 */
interface Sort {
    token: number;
    id: number;
    ids: readonly number[];
    from: number;
    to: number;
    dy: number;
    pitch: number;
    phase: "drag" | "settle" | "wait";
}

const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/** After the next frame is drawn; or soon, where none is (a hidden window doesn't draw, so it would never come). */
function nextFrame(fn: () => void) {
    let done = false;
    const once = () => {
        if (done) return;
        done = true;
        fn();
    };
    requestAnimationFrame(once);
    setTimeout(once, 100);
}
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Up next: the messages sent while a turn runs, in a small tray on top of the composer, numbered in the
 * order they go. Each says what it will do (join the turn at its next step, run after it, or wait for you
 * after a restart); on hover its buttons take the hint's place: Steer (while it runs) or Send now, Edit,
 * Remove. With more than one, a row moves: drag it (from anywhere but its buttons), or focus it and
 * press ↑/↓. The others slide out of its way and the numbers follow the order being made.
 */
export function QueueTab(p: { sessionId: string; state: SessionState; dequeue: (i: number, edit: boolean) => void }) {
    const [sort, setSort] = createSignal<Sort>();
    const [said, setSaid] = createSignal("");
    const busy = () => p.state.busy;
    const many = () => p.state.queued.length > 1;
    const modes = () => p.state.queuedModes ?? p.state.queued.map(() => undefined);
    const joining = createMemo(() => joiningRow(modes(), busy()));
    let list: HTMLDivElement | undefined;
    let tokens = 0;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    /** ↑/↓ pressed while a move is still going: done next, in the order pressed, on the same message. */
    let pendingKeys: { id: number; key: "up" | "down" }[] = [];
    /** The message to give the focus back to once its row has moved (moving a row takes the focus off it). */
    let refocus: number | undefined;
    let mounted = false;
    onMount(() => (mounted = true));
    onCleanup(() => clearTimeout(settleTimer));

    const rowOf = (id: number) => list?.querySelector<HTMLElement>(`.uq-row[data-qid="${id}"]`) ?? undefined;
    /** Rows are a fixed height apart: measured when a move starts, so density and font size are taken in. */
    const pitchOf = (row: HTMLElement) => row.offsetHeight + (parseFloat(getComputedStyle(list!).rowGap) || 0);

    // By the message's id, so a queue that moved on meanwhile never acts on a different one.
    const sendNow = async (i: number) => {
        const queueId = p.state.queueIds[i];
        if (queueId === undefined) return;
        try {
            const r = await rpc.call("session.sendQueuedNow", { id: p.sessionId, queueId });
            if (!r.sent) toast("That message has already been sent", "info");
        } catch (e) {
            reportError(e);
        }
    };

    const finish = (s: Sort, landed: boolean) => {
        if (sort()?.token !== s.token) return;
        clearTimeout(settleTimer);
        if (landed) {
            setSaid(movedAnnouncement(s.to, s.ids.length));
            // The rows are in their new order and every transform is back at none, with no transition
            // (the tray is "still"): nothing moved on screen. Transitions come back a frame later.
            nextFrame(() => {
                if (sort()?.token === s.token) setSort(undefined);
                afterMove(s.id);
            });
        } else {
            setSort(undefined);
            afterMove(s.id);
        }
    };
    const afterMove = (id: number) => {
        if (refocus === id) rowOf(id)?.focus({ preventScroll: true });
        refocus = undefined;
        // Keys for another message (its move was let go) are dropped; the rest go one by one, each
        // starting from where the last one left it. A key that can't move it (at the top) is skipped.
        pendingKeys = pendingKeys.filter((k) => k.id === id);
        while (pendingKeys.length && !step(id, pendingKeys.shift()!.key));
    };

    /** Let go over `to`: settle there, then ask the server, and keep the rows drawn in the new order until it shows it. */
    const drop = (s: Sort) => {
        const settled: Sort = { ...s, phase: "settle" };
        setSort(settled);
        clearTimeout(settleTimer);
        const ms = list ? settleMs(getComputedStyle(list).getPropertyValue("--dur-settle"), reducedMotion()) : 0;
        settleTimer = setTimeout(() => void commit(settled), ms);
    };
    const commit = async (s: Sort) => {
        if (sort()?.token !== s.token) return;
        if (s.to === s.from) return finish(s, false);
        setSort({ ...s, phase: "wait" });
        // Already there (the queue's update came first)? The effect below sees it on its own.
        try {
            const r = await rpc.call("session.moveQueued", { id: p.sessionId, queueId: s.id, to: s.to });
            if (!r.moved) {
                toast("That message has already been sent", "info");
                finish(s, false);
            } else if (sort()?.token === s.token) {
                // Moved, but the queue hasn't shown it yet: give it a moment, then stop drawing it there.
                setTimeout(() => finish(s, same(p.state.queueIds, moved(s.ids, s.from, s.to))), 1500);
            }
        } catch (e) {
            finish(s, false);
            reportError(e);
        }
    };

    // The queue changed under a move: the move shows (it's done), or something else did (a steer went in).
    createEffect(
        on(
            () => [...p.state.queueIds],
            (ids) => {
                const s = sort();
                if (!s || same(ids, s.ids)) return;
                if (s.phase === "wait" && same(ids, moved(s.ids, s.from, s.to))) return finish(s, true);
                // Held, settling or waiting on a queue that's no longer the one it was moved in: let it go
                // (a move already asked for still lands, by the message's id).
                finish(s, false);
            },
            { defer: true },
        ),
    );

    const begin = (id: number, row: HTMLElement): Sort | undefined => {
        const ids = [...p.state.queueIds];
        const from = ids.indexOf(id);
        if (from < 0 || ids.length < 2) return undefined;
        return { token: ++tokens, id, ids, from, to: from, dy: 0, pitch: pitchOf(row), phase: "drag" };
    };
    const follow = (s: Sort, dy: number): Sort => {
        const held = clampDrag(s.from, dy, s.pitch, s.ids.length);
        return { ...s, dy: held, to: dragTarget(s.from, held, s.pitch, s.ids.length) };
    };

    /** ↑/↓ on a focused row: one place, with the same motion as a drag, and the focus stays on it. */
    /** Whether a move started now (a key pressed mid-move is kept for later and doesn't count). */
    const step = (id: number, key: "up" | "down"): boolean => {
        if (sort()) {
            if (sort()!.id === id) pendingKeys.push({ id, key });
            return false;
        }
        const row = rowOf(id);
        const s = row && begin(id, row);
        if (!s) return false;
        const to = stepTarget(s.from, key, s.ids.length);
        if (to === undefined) return false;
        refocus = id;
        drop({ ...s, to, dy: (to - s.from) * s.pitch });
        return true;
    };

    const onPointerDown = (e: PointerEvent, id: number) => {
        const row = e.currentTarget as HTMLElement;
        if (e.button !== 0 || !many() || sort() || (e.target as Element).closest("button")) return;
        const y0 = e.clientY;
        let token: number | undefined;
        try {
            row.setPointerCapture(e.pointerId);
        } catch {
            // Not capturable (the pointer already went): the row's own events still arrive while it's over it.
        }
        const move = (ev: PointerEvent) => {
            if (token === undefined) {
                // A click stays a click: a drag starts once the pointer has moved 3px.
                if (Math.abs(ev.clientY - y0) < 3) return;
                const s = begin(id, row);
                if (!s) return stop();
                token = s.token;
                setSort(s);
            }
            const s = sort();
            if (s?.token !== token || s.phase !== "drag") return stop();
            setSort(follow(s, ev.clientY - y0));
        };
        const stop = () => {
            row.removeEventListener("pointermove", move);
            row.removeEventListener("pointerup", up);
            row.removeEventListener("pointercancel", cancel);
            row.removeEventListener("lostpointercapture", up);
        };
        const up = () => {
            stop();
            const s = sort();
            if (token === undefined || s?.token !== token || s.phase !== "drag") return;
            if (document.activeElement === row) refocus = id;
            drop(s);
        };
        const cancel = () => {
            stop();
            const s = sort();
            if (token !== undefined && s?.token === token && s.phase === "drag") drop({ ...s, to: s.from, dy: 0 });
        };
        row.addEventListener("pointermove", move);
        row.addEventListener("pointerup", up);
        row.addEventListener("pointercancel", cancel);
        row.addEventListener("lostpointercapture", up);
    };

    const sorting = () => sort() !== undefined;

    return (
        <div class="uq-tray glass">
            <div
                ref={list}
                class={`uq-list ${sorting() && sort()!.phase !== "wait" ? "sorting" : ""} ${sort()?.phase === "wait" ? "still" : ""}`}
                role="list"
                aria-label={`Up next: ${plural(p.state.queued.length, "message")}`}
            >
                <For each={p.state.queueIds}>
                    {(id, i) => {
                        const text = () => p.state.queued[i()] ?? "";
                        const mode = () => modes()[i()];
                        const info = () => queueRow(mode(), busy(), p.state.queuedWhy?.[i()]);
                        /** Its place in the snapshot a move started from (-1: it came in since). */
                        const at = () => sort()?.ids.indexOf(id) ?? -1;
                        /** Where it shows, in the order being made: its number is this + 1. */
                        const slot = () => {
                            const s = sort();
                            const k = at();
                            return s && k >= 0 ? slotOf(k, s.from, s.to) : i();
                        };
                        const held = () => sort()?.id === id && sort()!.phase !== "wait";
                        const transform = () => {
                            const s = sort();
                            if (!s || at() < 0) return undefined;
                            if (s.id === id && s.phase === "drag") return `translateY(${(s.from - i()) * s.pitch + s.dy}px) scale(1.02)`;
                            const dy = (slot() - i()) * s.pitch;
                            return dy ? `translateY(${dy}px)` : undefined;
                        };
                        let el!: HTMLDivElement;
                        // One that comes in later rises into place: by the Web Animations API, once it's in the
                        // document, so moving the row afterwards doesn't replay it (a CSS animation would).
                        const late = mounted;
                        onMount(() => {
                            if (late && !reducedMotion()) el.animate?.([{ opacity: 0, transform: "translateY(8px) scale(0.98)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
                        });
                        return (
                            <div
                                ref={el}
                                class={`uq-row q-${mode() ?? "steer"}`}
                                classList={{ lifted: held() && sort()!.phase === "drag", settling: held() && sort()!.phase === "settle", movable: many() }}
                                style={{ transform: transform() }}
                                data-qid={id}
                                role="listitem"
                                tabIndex={many() ? 0 : undefined}
                                aria-label={`${slot() + 1} of ${p.state.queued.length}: ${text() || p.state.queuedAttached?.[i()] || "(empty)"}. ${info().hint}`}
                                aria-keyshortcuts={many() ? "ArrowUp ArrowDown" : undefined}
                                onPointerDown={(e) => onPointerDown(e, id)}
                                onKeyDown={(e) => {
                                    if (e.target !== e.currentTarget || !many() || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                                    e.preventDefault();
                                    e.stopPropagation();
                                    step(id, e.key === "ArrowUp" ? "up" : "down");
                                }}
                            >
                                <span class="uq-n" title={many() ? "Drag to reorder, or press ↑ or ↓" : undefined} aria-hidden="true">
                                    <b class="num">{slot() + 1}</b>
                                    <Show when={many()}>
                                        <GripVertical size={13} />
                                    </Show>
                                </span>
                                <span class="uq-kind" title={info().detail} aria-hidden="true">
                                    {mode() === "held" ? <CirclePause size={14} /> : mode() === "steer" || mode() === undefined ? <CornerDownRight size={14} /> : <ListEnd size={14} />}
                                </span>
                                <QueuedText text={text()} empty={p.state.queuedAttached?.[i()] ? "" : "(empty)"} />
                                <Show when={p.state.queuedAttached?.[i()]}>
                                    {(label) => (
                                        <span class="queue-attached truncate" title={label()}>
                                            <Paperclip size={12} /> {label()}
                                        </span>
                                    )}
                                </Show>
                                <span class="uq-end">
                                    <span class="uq-hint" classList={{ joining: joining() === i() }} title={info().detail}>
                                        {info().hint}
                                        <span class="sr-only">: {info().detail}</span>
                                    </span>
                                    <span class="uq-acts">
                                        <Show when={info().action}>
                                            {(action) => (
                                                <button class="uq-send" title={action().title} onClick={() => void sendNow(i())}>
                                                    <Show when={action().label === "Steer"}>
                                                        <CornerDownRight size={13} stroke-width={2.25} aria-hidden="true" />
                                                    </Show>
                                                    {action().label}
                                                </button>
                                            )}
                                        </Show>
                                        <button class="uq-ib" title="Edit" aria-label="Edit queued message" onClick={() => p.dequeue(i(), true)}>
                                            <Pencil size={13} />
                                        </button>
                                        <button class="uq-ib" title="Remove from the queue" aria-label="Remove from the queue" onClick={() => p.dequeue(i(), false)}>
                                            <X size={14} />
                                        </button>
                                    </span>
                                </span>
                            </div>
                        );
                    }}
                </For>
            </div>
            <div class="sr-only" role="status" aria-live="polite">
                {said()}
            </div>
        </div>
    );
}

/** A queued message as typed, its review comments counted rather than spelled out. */
function QueuedText(p: { text: string; empty: string }) {
    const parts = createMemo(() => splitComments(p.text));
    return (
        <span class="uq-text truncate">
            {parts().text || (parts().comments.length ? "" : p.empty)}
            <Show when={parts().comments.length}>
                <span class="queue-attached"> {parts().text ? "· " : ""}{plural(parts().comments.length, "review comment")}</span>
            </Show>
        </span>
    );
}
