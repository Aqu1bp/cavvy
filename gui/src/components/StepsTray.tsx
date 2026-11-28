import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { ChevronRight, X } from "lucide-solid";
import { Popover } from "./ui/Popover";
import type { SessionView } from "@shared/timeline";
import { stepsKey, stepsLine, stepsStale } from "../lib/plan-chat";

/** Each session's list as it stood when its strip was hidden (✕): it stays hidden until the list changes. */
const [hiddenAt, setHiddenAt] = createSignal<Readonly<Record<string, string>>>({});

/** Whether the session's Steps tray is up: the composer squares its card's top corners under it. */
export function stepsTrayShown(sessionId: string, view: SessionView): boolean {
    const todos = view.state.todos;
    return todos.length > 0 && !view.state.interactions.length && hiddenAt()[sessionId] !== stepsKey(todos) && !stepsStale(todos, view.turns, view.earlier ?? 0);
}

/**
 * Steps: the agent's to-do list, as a tray on top of the composer (above Up next). One line: a ring that fills
 * as steps are done, "3 of 6", and the step under way. Clicked, the whole list opens in a menu above it, over the
 * conversation, so neither the composer nor the conversation moves. A finished list reads "All steps done" until the next turn; ✕ hides it until the list changes. Not
 * shown while a request card is up (the card is what needs reading then).
 */
export function StepsTray(p: { sessionId: string; view: SessionView }) {
    const [open, setOpen] = createSignal(false);
    const todos = () => p.view.state.todos;
    const key = createMemo(() => stepsKey(todos()));
    const working = () => p.view.state.busy;
    const line = createMemo(() => stepsLine(todos(), working()));
    const shown = () => stepsTrayShown(p.sessionId, p.view);
    const listId = createUniqueId();
    let main: HTMLButtonElement | undefined;
    let list: HTMLDivElement | undefined;
    const toggle = () => {
        const next = !open();
        setOpen(next);
        // The step under way in sight, in a list long enough to scroll.
        if (next) requestAnimationFrame(() => list?.querySelector("[data-state='doing']")?.scrollIntoView({ block: "nearest" }));
    };
    const hide = () => {
        setOpen(false);
        setHiddenAt((h) => ({ ...h, [p.sessionId]: key() }));
    };
    // The ring: how much of the list is done.
    const R = 6.5;
    const C = 2 * Math.PI * R;
    return (
        <Show when={shown()}>
            <div class="tray tray-steps">
                <button ref={main} class="tray-main" aria-label="Steps" aria-expanded={open()} aria-controls={open() ? listId : undefined} title={open() ? "Hide the steps" : "Show all the steps"} onClick={toggle}>
                    <span class="ring" style={{ width: "calc(16 * var(--sp))", height: "calc(16 * var(--sp))" }} aria-hidden="true">
                        <svg width="16" height="16" viewBox="0 0 16 16">
                            <circle cx="8" cy="8" r={R} fill="none" stroke-width="1.5" class="ring-track" />
                            <circle cx="8" cy="8" r={R} fill="none" stroke-width="1.5" stroke-linecap="round" stroke-dasharray={`${(line().done / Math.max(1, line().total)) * C} ${C}`} transform="rotate(-90 8 8)" class="ring-value" />
                        </svg>
                    </span>
                    <Show when={!line().all}>
                        <span class="tray-count num">
                            {line().done} of {line().total}
                        </span>
                    </Show>
                    <span class="tray-text">{line().now}</span>
                    <ChevronRight size={13} class="chev tray-chev" aria-hidden="true" />
                </button>
                <button class="icon-btn icon-btn-sm" title="Hide until the list changes" aria-label="Hide the steps" onClick={hide}>
                    <X size={13} />
                </button>
                <Popover open={open()} anchor={() => main} onClose={() => setOpen(false)} placement="top" align="start" offset={6} width={360} maxHeight={320} class="menu steps-list">
                    <div ref={list} id={listId} role="list" aria-label={`Steps: ${line().done} of ${line().total} done`}>
                        <For each={todos()}>
                            {(t) => (
                                <div class="steps-item" role="listitem" data-state={t.status === "completed" ? "done" : t.status === "in_progress" ? "doing" : "todo"}>
                                    <span class="steps-mark" aria-label={t.status === "completed" ? "Done" : t.status === "in_progress" ? "In progress" : "To do"} />
                                    <span class="selectable">{t.status === "in_progress" && working() ? (t.activeForm ?? t.content) : t.content}</span>
                                </div>
                            )}
                        </For>
                    </div>
                </Popover>
            </div>
        </Show>
    );
}
