// The stage's sessions: the one in view, or two side by side (state/split.ts). Each is a pane of its own, kept by its
// session's id: a second one coming or going, or the other one replaced, leaves a pane's conversation as it was.
// While a session is dragged from the rail, the stage shows where it would go. The one shown before stays, out of sight
// (parked): switched back to, it's there as it was, nothing built or laid out again.

import { batch, createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, untrack } from "solid-js";
import { activate, app, handleFor, type SessionHandle } from "../state/app";
import { paneDock, shellLayout } from "../state/ui";
import { canDrop, draggedSession, dropSession, endPaneOpen, focusPane, openPane, paneOpening, paneAgent, PaneContext, saveSplitRatio, setDraggedSession, setSplitDrag, split, splitDrag, splitIds, splitRatio, usePane, SESSION_DRAG, type Side } from "../state/split";
import { columnSteps, splitShare, BAR_RAIL_ROOM, PANE_NARROW } from "../lib/layout";
import { isDesktop, os } from "../lib/platform";
import { prefs } from "../state/prefs";
import { frameDrag } from "../lib/drag";
import { ErrorCards } from "./ErrorCards";
import { Header } from "./Header";
import { Transcript } from "./Transcript";
import { FloatingBrowser } from "./FloatingBrowser";
import { Composer } from "./Composer";
import { AgentView } from "./Agents";

const titleOf = (id: string) => (app.sessions.find((s) => s.id === id) ?? app.archived.find((s) => s.id === id))?.title;

/** A session: the conversation, and the composer floating over its end. (Its inspector is the sheet's other column.) */
function SessionView(p: { handle: SessionHandle }) {
    const pane = usePane();
    let dock: HTMLDivElement | undefined;
    // Unmeasured: the transcript's boxes have --dock-h's initial value (stage.css).
    const [dockH, setDockH] = createSignal<number>();
    onMount(() => {
        // The transcript scrolls under the composer and keeps that much room at its end.
        const ro = new ResizeObserver(() => setDockH(dock?.offsetHeight ?? 0));
        if (dock) ro.observe(dock);
        onCleanup(() => ro.disconnect());
    });
    // A floating or filling inspector ends above the composer and request cards: with two panes, the taller dock
    // (a diff reader filling the sheet spans both).
    const key = {};
    createEffect(() => {
        const h = dockH();
        if (h !== undefined) paneDock(key, pane.parked() ? undefined : h);
    });
    onCleanup(() => paneDock(key, undefined));
    return (
        <>
            <Header handle={p.handle} />
            <div class="stage">
                <Transcript handle={p.handle} dock={dockH()} />
                {/* One page shows at a time: the focused session's. */}
                <Show when={pane.focused()}>
                    <FloatingBrowser handle={p.handle} />
                </Show>
                <div class="composer-dock" ref={dock}>
                    <div class="composer-col">
                        {/* What the app tells you shows once, by the composer you're using. */}
                        <Show when={pane.focused()}>
                            <ErrorCards place="composer" />
                        </Show>
                        <Composer sessionId={p.handle.id} />
                    </div>
                </div>
            </div>
        </>
    );
}

/** A pane whose session isn't open here yet: its title, then (after a moment) that it's opening, or why it couldn't. */
function OpeningPane(p: { id: string }) {
    const focusedOpen = () => app.opening?.id === p.id;
    // The focused one opens as any session does (state/app.ts activate); the other, here.
    const opening = () => (focusedOpen() ? app.opening : paneOpening[p.id]);
    createEffect(() => {
        if (focusedOpen()) return;
        if (app.conn !== "open" || !app.sessionsLoaded) return endPaneOpen(p.id);
        untrack(() => {
            if (!paneOpening[p.id]) openPane(p.id);
        });
    });
    onCleanup(() => endPaneOpen(p.id));
    return (
        <>
            <Header title={titleOf(p.id)} />
            <div class="session-opening" aria-busy={!opening()?.error}>
                <Show when={opening()?.error} fallback={<Show when={opening()?.visible}><div role="status">Opening session…</div><div class="session-skeleton" aria-hidden="true"><i /><i /><i /></div></Show>}>
                    <p role="alert" class="selectable">Couldn't open this session: {opening()!.error}</p>
                    <button class="ghost-btn" disabled={app.conn !== "open"} onClick={() => void activate(p.id)}>Retry opening session</button>
                </Show>
            </div>
        </>
    );
}

/** `share`: how much of the column it is (1 alone). `parked`: the one shown before, kept out of sight (Panes). */
function Pane(p: { id: string; first: boolean; last: boolean; share: number; parked: boolean }) {
    const inSplit = () => Boolean(split());
    const focused = () => !p.parked && (!inSplit() || app.activeId === p.id);
    const handle = () => handleFor(p.id);
    // A sub-agent's view, in a split: each pane keeps its own (state/split.ts). Alone, App.tsx shows it in place of the pane.
    const agent = () => {
        const id = inSplit() ? paneAgent(p.id) : undefined;
        return id ? handle()?.view.agents.find((a) => a.id === id) : undefined;
    };
    let wasFocused = true;
    // Made while there's a split: the session dragged in, which fades in (stage.css). Not the one already there.
    const entering = inSplit();
    // A press or a Tab into the other pane focuses it. Before the press reaches what's under it, so a menu it opens
    // or a model it picks is that session's.
    const take = () => {
        wasFocused = focused();
        // One that couldn't open: only its Retry tries again (focusing it would, and may go to its machine to ask).
        if (!wasFocused && !paneOpening[p.id]?.error) focusPane(p.id);
    };
    let section: HTMLElement | undefined;
    // Kept out of sight with the keyboard in it (a switch by key while typing): let go of now, or the browser keeps it
    // there a frame or more, and what's shown wouldn't take it (Composer: focusSoon) and what's typed would be lost.
    createEffect(() => {
        if (!p.parked) return;
        const active = document.activeElement;
        if (active instanceof HTMLElement && section?.contains(active)) active.blur();
    });
    // Shown again: what content-visibility skips (a reply's code, rows far up) was counted out of view while put away,
    // and stayed skipped in the frame that showed it again: the end of a reply was blank for a frame. What's in view is
    // drawn in that frame, and left to the page again after it.
    createEffect(
        on(
            () => p.parked,
            (parked, was) => {
                if (parked || !was || !section) return;
                const held: HTMLElement[] = [];
                for (const el of section.querySelectorAll<HTMLElement>(".turn[data-far], [data-work-far], .md .code > pre.code-body")) {
                    const r = el.getBoundingClientRect();
                    if (!r.height || r.bottom <= 0 || r.top >= innerHeight) continue;
                    el.style.contentVisibility = "visible";
                    held.push(el);
                }
                if (held.length) requestAnimationFrame(() => requestAnimationFrame(() => held.forEach((el) => el.style.removeProperty("content-visibility"))));
            },
            { defer: true },
        ),
    );
    const ctx = { id: p.id, focused, parked: () => p.parked, split: inSplit, rightmost: () => p.last, share: () => p.share, wasFocused: () => wasFocused };
    // In a split each pane has the steps of its own width (shell.css, lib/layout.ts); alone, the column's are on .main.
    const narrow = createMemo(() => (inSplit() && shellLayout().sheet.w ? columnSteps(shellLayout().column.w * p.share, PANE_NARROW) : undefined));
    // Its title bar's own: the first one's holds the rail's buttons where the rail isn't docked and shown (header.css).
    const bar = createMemo(() => {
        if (!inSplit() || !shellLayout().sheet.w) return undefined;
        const rail = p.first && (shellLayout().railMode === "overlay" || !prefs.sidebar) ? BAR_RAIL_ROOM[isDesktop && os === "macos" ? "traffic" : "plain"] : 0;
        return columnSteps(shellLayout().column.w * p.share - rail, PANE_NARROW);
    });
    return (
        <PaneContext.Provider value={ctx}>
            <section
                class="stage-pane"
                classList={{ entering }}
                data-focused={inSplit() ? (focused() ? "on" : "off") : undefined}
                data-narrow={narrow()}
                data-bar={bar()}
                data-parked={p.parked ? "" : undefined}
                aria-label={inSplit() ? titleOf(p.id) : undefined}
                ref={(el) => {
                    section = el;
                    el.addEventListener("pointerdown", take, true);
                }}
                onFocusIn={() => {
                    if (!focused()) take();
                }}
            >
                <Switch fallback={<OpeningPane id={p.id} />}>
                    <Match when={handle() && agent()}>
                        <AgentView handle={handle()!} agent={agent()!} />
                    </Match>
                    <Match when={handle()} keyed>
                        {(h) => <SessionView handle={h} />}
                    </Match>
                </Switch>
            </section>
        </PaneContext.Provider>
    );
}

/**
 * Where a session dragged from the rail would go, over the stage: the half it's over, beside the one in view; in a
 * split, the place of the one it's over, which it takes. Over the whole stage, so nothing under it takes the drag (the
 * composer's file drop, a text field) and moving across it doesn't flicker.
 */
function DropZone(p: { id: string; left: number }) {
    let el!: HTMLDivElement;
    const [side, setSide] = createSignal<Side>();
    // Where the halves meet: the bar, in a split.
    const edge = () => (split() ? p.left : 0.5);
    const where = (e: DragEvent): Side => {
        const r = el.getBoundingClientRect();
        return e.clientX < r.left + r.width * edge() ? "left" : "right";
    };
    const over = (e: DragEvent) => {
        if (!e.dataTransfer?.types.includes(SESSION_DRAG)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const s = where(e);
        if (s !== side()) setSide(s);
    };
    // One for each half, as wide as it is: the one under the pointer shows.
    const box = (s: Side) => {
        const l = `${edge() * 100}%`;
        return s === "left" ? { width: `calc(${l} - 12 * var(--sp))` } : { left: `calc(${l} + 4 * var(--sp))`, width: `calc(100% - ${l} - 12 * var(--sp))` };
    };
    return (
        <div
            ref={el}
            class="drop-zone"
            data-window-drag="off"
            onDragEnter={over}
            onDragOver={over}
            onDragLeave={() => setSide(undefined)}
            onDrop={(e) => {
                if (!e.dataTransfer?.types.includes(SESSION_DRAG)) return;
                e.preventDefault();
                const s = where(e);
                setDraggedSession(undefined);
                dropSession(p.id, s);
            }}
        >
            <For each={["left", "right"] as const}>
                {(s) => (
                    <div class="drop-target" data-side={s} classList={{ on: side() === s }} style={box(s)} aria-hidden="true">
                        <span class="drop-title truncate">{titleOf(p.id)}</span>
                    </div>
                )}
            </For>
        </div>
    );
}

/**
 * The bar between a split's two sessions: dragged (or moved with the arrow keys) to share the column between them,
 * double-clicked for halves. Shown once a frame while dragged, saved on release.
 */
function SplitBar(p: { left: number }) {
    const [dragging, setDragging] = createSignal(false);
    const columnW = () => shellLayout().column.w;
    const set = (r: number) => saveSplitRatio(splitShare(r, columnW()));
    /** Ends the drag under way, if any: on release, and when the bar goes away in the middle of one. */
    let stop: (() => void) | undefined;
    onCleanup(() => stop?.());
    const start = (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        stop?.();
        const target = e.currentTarget as HTMLElement;
        target.setPointerCapture(e.pointerId);
        const box = target.parentElement!.getBoundingClientRect();
        setDragging(true);
        document.body.classList.add("resizing");
        // Esc (or the system taking the pointer) puts it back as it was.
        let cancelled = false;
        const drag = frameDrag({
            show: setSplitDrag,
            commit: (r) => batch(() => {
                if (r !== undefined && !cancelled) saveSplitRatio(r);
                setSplitDrag(undefined);
            }),
        });
        const move = (ev: PointerEvent) => drag.move(splitShare((ev.clientX - box.left) / box.width, box.width));
        const end = () => {
            stop = undefined;
            drag.end();
            setDragging(false);
            document.body.classList.remove("resizing");
            target.removeEventListener("pointermove", move);
            target.removeEventListener("lostpointercapture", end);
            target.removeEventListener("pointercancel", cancel);
            window.removeEventListener("keydown", onKey, true);
            if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
        };
        const cancel = () => {
            cancelled = true;
            end();
        };
        // Only the drag's: not a request card's answer, nor stopping the turn (the app's keys, App.tsx).
        const onKey = (ev: KeyboardEvent) => {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            if (ev.key === "Escape") cancel();
        };
        stop = end;
        target.addEventListener("pointermove", move);
        target.addEventListener("lostpointercapture", end);
        target.addEventListener("pointercancel", cancel);
        window.addEventListener("keydown", onKey, true);
    };
    return (
        <div
            class={`split-bar ${dragging() ? "drag" : ""}`}
            style={{ left: `${p.left * 100}%` }}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sessions"
            aria-valuenow={Math.round(p.left * 100)}
            tabIndex={0}
            onPointerDown={start}
            onDblClick={() => set(0.5)}
            onKeyDown={(e) => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                e.preventDefault();
                set(p.left + (e.key === "ArrowLeft" ? -24 : 24) / (columnW() || 1));
            }}
        />
    );
}

/** The stage's panes: `single`, the session in view, or the split's two. */
export function Panes(p: { single?: SessionHandle }) {
    /** The left one's share of the column: as dragged now, or as it was left; kept within each one's least. */
    const left = createMemo(() => splitShare(splitDrag() ?? splitRatio(), shellLayout().column.w));
    const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);
    /**
     * The one shown before, alone: switched back to (the usual way back and forth between two), it's shown as it was
     * left, with its style and layout kept (stage.css), rather than built again from its turns. Only while its session
     * is idle: one streaming out of sight would spend each frame on what nobody sees. One, not more: each kept costs what
     * its conversation does.
     */
    let before: string | undefined;
    let last: string | undefined;
    /** The panes in the order they were put in: one moved in the page would lose what it kept. */
    let order: string[] = [];
    const ids = createMemo(() => {
        const both = splitIds();
        const now = p.single?.id;
        if (last !== now) {
            if (last) before = last;
            last = now;
        }
        if (both) return (order = [...both]);
        // Only one already built: one let go of (it went busy) isn't built again out of sight when it's idle again.
        const h = before !== now && order.includes(before!) ? handleFor(before) : undefined;
        const want = [now, h && !h.view.state.busy ? h.id : undefined].filter((id): id is string => id !== undefined);
        order = [...order.filter((id) => want.includes(id)), ...want.filter((id) => !order.includes(id))];
        return order;
    }, undefined, { equals: same });
    /** Those in sight: the split's two, or the one. */
    const shown = createMemo(() => (split() ? ids() : ids().filter((id) => id === p.single?.id)), undefined, { equals: same });
    const dropping = () => {
        const id = draggedSession();
        return id && canDrop(id) ? id : undefined;
    };
    return (
        <div class="panes" data-split={split() ? "" : undefined} style={split() ? { "grid-template-columns": `minmax(0, ${left() * 100}%) minmax(0, 1fr)` } : undefined}>
            <For each={ids()}>
                {(id) => {
                    const i = () => shown().indexOf(id);
                    return <Pane id={id} parked={i() < 0} first={i() <= 0} last={i() < 0 || i() === shown().length - 1} share={shown().length < 2 ? 1 : i() === 0 ? left() : 1 - left()} />;
                }}
            </For>
            <Show when={split()}>
                <SplitBar left={left()} />
            </Show>
            <Show when={dropping()} keyed>
                {(id) => <DropZone id={id} left={left()} />}
            </Show>
        </div>
    );
}
