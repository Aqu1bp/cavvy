import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { Check, ChevronUp, X } from "lucide-solid";
import type { SessionView } from "@shared/timeline";
import { stepsKey, stepsLine, stepsStale } from "../lib/plan-chat";

/** Each session's list as it stood when its strip was hidden (✕): it stays hidden until the list changes. */
const [hiddenAt, setHiddenAt] = createSignal<Readonly<Record<string, string>>>({});

/**
 * Steps: the agent's to-do list, as a glass strip on top of the composer (above the Up next tray). One line:
 * a ring that fills as steps are done, "3 of 6", and the step under way. Clicked, the whole list opens upward,
 * over the conversation: the line keeps its place in the dock, so neither the composer nor the conversation
 * moves. A finished list reads "All steps done" until the next turn; ✕ hides it until the list changes. Not
 * shown while a request card is up (the card is what needs reading then).
 */
export function StepsTray(p: { sessionId: string; view: SessionView }) {
    const [open, setOpen] = createSignal(false);
    const todos = () => p.view.state.todos;
    const key = createMemo(() => stepsKey(todos()));
    const line = createMemo(() => stepsLine(todos()));
    const shown = () => todos().length > 0 && !p.view.state.interactions.length && hiddenAt()[p.sessionId] !== key() && !stepsStale(todos(), p.view.turns);
    const listId = createUniqueId();
    let list: HTMLUListElement | undefined;
    const toggle = () => {
        const next = !open();
        setOpen(next);
        // The step under way in sight, in a list long enough to scroll.
        if (next) requestAnimationFrame(() => list?.querySelector(".now")?.scrollIntoView({ block: "nearest" }));
    };
    const hide = () => {
        setOpen(false);
        setHiddenAt((h) => ({ ...h, [p.sessionId]: key() }));
    };
    return (
        <Show when={shown()}>
            <div class="steps-slot">
                <div class="steps-tray glass" classList={{ open: open() }}>
                    <div class="st-list" inert={!open()}>
                        <div>
                            <ul ref={list} id={listId} aria-label={`Steps: ${line().done} of ${line().total} done`}>
                                <For each={todos()}>
                                    {(t) => (
                                        <li class={t.status === "completed" ? "done" : t.status === "in_progress" ? "now" : ""}>
                                            <span class="box" aria-label={t.status === "completed" ? "Done" : t.status === "in_progress" ? "In progress" : "To do"}>
                                                <Show when={t.status === "completed"}>
                                                    <Check size={9} stroke-width={3.4} />
                                                </Show>
                                            </span>
                                            <span class="selectable">{t.status === "in_progress" ? (t.activeForm ?? t.content) : t.content}</span>
                                        </li>
                                    )}
                                </For>
                            </ul>
                        </div>
                    </div>
                    <div class="st-row">
                        <button class="st-main" aria-expanded={open()} aria-controls={listId} title={open() ? "Hide the steps" : "Show all the steps"} onClick={toggle}>
                            <span class="st-ring" classList={{ all: line().all }} style={{ "--p": `${(line().done / Math.max(1, line().total)) * 100}%` }} aria-hidden="true">
                                <Show when={line().all}>
                                    <Check size={10} stroke-width={3.2} />
                                </Show>
                            </span>
                            <span class="st-k num">
                                {line().done} of {line().total}
                            </span>
                            <span class="st-now truncate">{line().now}</span>
                            {/* Where the ✕ sits (it's its own button, over this). */}
                            <span class="st-xroom" aria-hidden="true" />
                            <ChevronUp size={14} class="st-chev" aria-hidden="true" />
                        </button>
                        <button class="st-x" title="Hide until the list changes" aria-label="Hide the steps until the list changes" onClick={hide}>
                            <X size={14} />
                        </button>
                    </div>
                </div>
            </div>
        </Show>
    );
}
