import { createEffect, createSignal, For, Show } from "solid-js";
import { CirclePause, CornerDownRight, GripVertical, ListEnd, Paperclip, Pencil, X } from "lucide-solid";
import type { SessionState } from "@shared/protocol";
import { reportError, rpc, toast } from "../state/app";
import { dropTarget, queueRow, stepTarget } from "../lib/queue";

const DRAG_TYPE = "application/x-harness-queued";

/**
 * Messages sent while a turn runs, on the composer's top edge: what each will
 * do (join the turn at its next step, run after it, or wait for you after a
 * restart), with Send now, Edit and Remove. With more than one, the grip
 * reorders them: drag it, or focus it and press ↑/↓.
 */
export function QueueTab(p: { sessionId: string; state: SessionState; dequeue: (i: number, edit: boolean) => void }) {
    const [drag, setDrag] = createSignal<{ from: number; before?: number }>();
    /** The grip pressed: a drag starts only from there, not from selecting a row's text. */
    let armed: number | undefined;
    const busy = () => p.state.busy;
    const many = () => p.state.queued.length > 1;
    let tab: HTMLDivElement | undefined;
    /** The message whose grip moved it with the keyboard: its grip keeps the focus once the queue shows the move. */
    const [follow, setFollow] = createSignal<{ id: number; to: number }>();
    createEffect(() => {
        const f = follow();
        if (!f || p.state.queueIds.indexOf(f.id) !== f.to) return;
        setFollow(undefined);
        // After the rows have moved (moving a row takes the focus off it).
        requestAnimationFrame(() => tab?.querySelector<HTMLElement>(`.queue-grip[data-qid="${f.id}"]`)?.focus());
    });

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
    const move = async (i: number, to: number | undefined, keyboard = false) => {
        const queueId = p.state.queueIds[i];
        if (queueId === undefined || to === undefined) return;
        // The grip follows its message, so ↑↑ keeps moving the same one.
        if (keyboard) setFollow({ id: queueId, to });
        try {
            const r = await rpc.call("session.moveQueued", { id: p.sessionId, queueId, to });
            if (!r.moved) {
                setFollow(undefined);
                toast("That message has already been sent", "info");
            }
        } catch (e) {
            setFollow(undefined);
            reportError(e);
        }
    };

    return (
        <div ref={tab} class="tab queue-tab" role="list" aria-label={`${p.state.queued.length} queued message${p.state.queued.length === 1 ? "" : "s"}`}>
            <For each={p.state.queued}>
                {(q, i) => {
                    const mode = () => p.state.queuedModes?.[i()];
                    const info = () => queueRow(mode(), busy());
                    const dropHere = () => drag()?.before === i() && dropTarget(drag()!.from, i()) !== undefined;
                    return (
                        <div
                            class={`queue-row m-${mode() ?? "steer"} ${drag()?.from === i() ? "dragging" : ""} ${dropHere() ? "drop-before" : ""}`}
                            role="listitem"
                            draggable={many()}
                            onDragStart={(e) => {
                                if (armed !== i() || !e.dataTransfer) return e.preventDefault();
                                e.dataTransfer.setData(DRAG_TYPE, String(i()));
                                e.dataTransfer.effectAllowed = "move";
                                setDrag({ from: i() });
                            }}
                            onDragOver={(e) => {
                                const d = drag();
                                if (!d) return;
                                e.preventDefault();
                                const r = e.currentTarget.getBoundingClientRect();
                                const before = e.clientY < r.top + r.height / 2 ? i() : i() + 1;
                                if (d.before !== before) setDrag({ ...d, before });
                            }}
                            onDrop={(e) => {
                                const d = drag();
                                if (!d) return;
                                e.preventDefault();
                                setDrag(undefined);
                                armed = undefined;
                                if (d.before !== undefined) void move(d.from, dropTarget(d.from, d.before));
                            }}
                            onDragEnd={() => {
                                setDrag(undefined);
                                armed = undefined;
                            }}
                        >
                            <Show when={many()}>
                                <button
                                    class="hb sm queue-grip"
                                    data-qid={p.state.queueIds[i()]}
                                    title="Drag to reorder, or press ↑ or ↓"
                                    aria-label={`Reorder queued message ${i() + 1} of ${p.state.queued.length} (↑ or ↓)`}
                                    onPointerDown={() => (armed = i())}
                                    onKeyDown={(e) => {
                                        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                                        e.preventDefault();
                                        void move(i(), stepTarget(i(), e.key === "ArrowUp" ? "up" : "down", p.state.queued.length), true);
                                    }}
                                >
                                    <GripVertical size={13} />
                                </button>
                            </Show>
                            <span class="queue-icon" title={info().detail} aria-hidden="true">
                                {mode() === "held" ? <CirclePause size={14} /> : mode() === "steer" || mode() === undefined ? <CornerDownRight size={14} /> : <ListEnd size={14} />}
                            </span>
                            <span class="queue-text truncate">{q || (p.state.queuedAttached?.[i()] ? "" : "(empty)")}</span>
                            <Show when={p.state.queuedAttached?.[i()]}>
                                {(label) => (
                                    <span class="queue-attached truncate" title={label()}>
                                        <Paperclip size={12} /> {label()}
                                    </span>
                                )}
                            </Show>
                            <span class="queue-hint" title={info().detail}>
                                {info().hint}
                                <span class="sr-only">: {info().detail}</span>
                            </span>
                            <Show when={info().sendNow}>
                                {(title) => (
                                    <button class="queue-send" title={title()} onClick={() => void sendNow(i())}>
                                        Send now
                                    </button>
                                )}
                            </Show>
                            <button class="hb sm" title="Edit" aria-label="Edit queued message" onClick={() => p.dequeue(i(), true)}>
                                <Pencil size={13} />
                            </button>
                            <button class="hb sm" title="Remove from the queue" aria-label="Remove from the queue" onClick={() => p.dequeue(i(), false)}>
                                <X size={14} />
                            </button>
                        </div>
                    );
                }}
            </For>
            <Show when={drag()?.before === p.state.queued.length && dropTarget(drag()!.from, p.state.queued.length) !== undefined}>
                <div class="queue-drop-end" aria-hidden="true" />
            </Show>
        </div>
    );
}
