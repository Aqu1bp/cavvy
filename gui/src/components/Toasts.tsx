// A toast: a small glass pill for a confirmation or an Undo, shown with the error
// cards right above the composer (ErrorCards.tsx), and gone on its own. At most
// two show (state/app.ts queues the rest); pointing at one, or focusing it, holds
// its timer, so an Undo can't slip away under the cursor. Errors are cards instead.

import { For, Match, onCleanup, Show, Switch } from "solid-js";
import { CircleCheck, Info, TriangleAlert, X } from "lucide-solid";
import { dismissToast, pauseToast, runToastChoice, type Toast } from "../state/app";

export function ToastItem(p: { toast: Toast }) {
    const t = () => p.toast;
    onCleanup(() => {
        // A failed action makes its toast an error card, which replaces this one.
        pauseToast(t().id, "hover", false);
        pauseToast(t().id, "focus", false);
    });
    return (
        <div
            class={`toast glass ${t().level}`}
            onPointerEnter={() => pauseToast(t().id, "hover", true)}
            onPointerLeave={() => pauseToast(t().id, "hover", false)}
            onFocusIn={() => pauseToast(t().id, "focus", true)}
            onFocusOut={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) pauseToast(t().id, "focus", false);
            }}
        >
            <Switch fallback={<Info size={15} />}>
                <Match when={t().level === "warn"}>
                    <TriangleAlert size={15} />
                </Match>
                <Match when={t().level === "success"}>
                    <CircleCheck size={15} />
                </Match>
            </Switch>
            <span class="toast-msg" title={t().message}>
                {t().message}
            </span>
            <Show when={t().count > 1}>
                <span class="toast-count">({t().count} times)</span>
            </Show>
            <For each={[...(t().action ? [t().action!] : []), ...(t().additionalActions ?? [])]}>
                {(action, index) => (
                    <button class="link-btn" disabled={t().running} onClick={() => void runToastChoice(t().id, index())}>
                        {action.label}
                    </button>
                )}
            </For>
            <button class="icon-btn" onClick={() => dismissToast(t().id)} aria-label="Dismiss">
                <X size={13} />
            </button>
        </div>
    );
}
