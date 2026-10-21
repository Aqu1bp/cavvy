// Toasts: small glass pills that drop into the title bar's row, over the title
// for a moment and clear of the tool capsule, rather than over the content.
// At most two show (state/app.ts queues the rest); pointing at one, or focusing
// it, holds its timer, so an Undo can't slip away under the cursor.

import { For, Match, onCleanup, Show, Switch } from "solid-js";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-solid";
import { dismissToast, pauseToast, runToastChoice, toast, toasts, type Toast } from "../state/app";
import { copyText } from "../lib/platform";

export function ToastItem(p: { toast: Toast }) {
    const t = () => p.toast;
    onCleanup(() => {
        // Failed actions move to the alert region, replacing their old DOM node.
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
                <Match when={t().level === "error"}>
                    <CircleAlert size={15} />
                </Match>
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
            <Show when={t().level === "error"}>
                <button
                    class="link-btn"
                    onClick={async () => {
                        const copied = await copyText(t().message);
                        toast(copied ? "Copied error" : "Couldn't copy error", copied ? "success" : "info");
                    }}
                >
                    Copy
                </button>
            </Show>
            <button class="icon-btn" onClick={() => dismissToast(t().id)} aria-label="Dismiss">
                <X size={13} />
            </button>
        </div>
    );
}

export function Toasts() {
    return (
        <div class="toasts">
            <div class="toast-region" role="alert" aria-live="assertive" aria-relevant="additions text">
                <For each={toasts.filter((t) => t.level === "error")}>{(t) => <ToastItem toast={t} />}</For>
            </div>
            <div class="toast-region" role="status" aria-live="polite" aria-relevant="additions text">
                <For each={toasts.filter((t) => t.level !== "error")}>{(t) => <ToastItem toast={t} />}</For>
            </div>
        </div>
    );
}
