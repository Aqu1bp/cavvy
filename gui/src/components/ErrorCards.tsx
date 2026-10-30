// What the app tells you, in one place: right above the composer, where you're looking. Errors are
// cards: the whole message shows, and it stays until it's dismissed or its cause is fixed
// (state/app.ts). Two show, then "N more"; a repeat bumps the card's count and nudges it instead of
// stacking another. Confirmations (an Undo, "Copied") are pills over them that go on their own
// (Toasts.tsx). In Settings, where there's no composer, they sit at the foot of the page; with
// neither on screen (or the composer covered: a maximized terminal, a short floating inspector), at
// the window's. An error that belongs to something on screen shows there instead (a provider's row
// in Settings → Providers).

import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { CircleAlert, Copy, X } from "lucide-solid";
import { dismissToast, runToastChoice, toast, toasts, type Toast } from "../state/app";
import { settingsTab, shellLayout } from "../state/ui";
import { copyText } from "../lib/platform";
import { errorPlace, messageParts, splitError, type ErrorPlace } from "../lib/error-text";
import { coversComposer } from "../lib/layout";
import { ToastItem } from "./Toasts";

/** Cards shown at once; the rest are counted under them. */
export const MAX_ERROR_CARDS = 2;

const [mounted, setMounted] = createSignal<readonly ErrorPlace[]>([]);

/** A message with its backticked commands and paths as code. */
export function MessageText(p: { text: string }) {
    return <For each={messageParts(p.text)}>{(part, i) => (i() % 2 ? <code>{part}</code> : part)}</For>;
}

function ErrorCard(p: { toast: Toast }) {
    const t = () => p.toast;
    const text = () => splitError(t().message);
    const actions = () => [...(t().action ? [t().action!] : []), ...(t().additionalActions ?? [])];
    // A repeat replays the nudge: the animation's name alternates, so it starts over each time.
    const [nudge, setNudge] = createSignal<"a" | "b">();
    createEffect(on(() => t().count, () => setNudge((n) => (n === "a" ? "b" : "a")), { defer: true }));
    const count = () => (t().count > 1 ? <span class="error-count">{t().count}×</span> : undefined);
    return (
        <div class="error-card glass" data-nudge={nudge()}>
            <span class="error-card-icon">
                <CircleAlert size={17} stroke-width={2} />
            </span>
            <div class="error-card-body">
                <div class="error-card-text selectable">
                    <Show when={text().title}>
                        <div class="error-card-title">
                            <span>
                                <MessageText text={text().title!} />
                            </span>
                            {count()}
                        </div>
                    </Show>
                    <Show when={text().detail}>
                        <div class="error-card-detail">
                            <MessageText text={text().detail!} />
                            <Show when={!text().title}> {count()}</Show>
                        </div>
                    </Show>
                </div>
                <div class="error-card-actions">
                    <For each={actions()}>
                        {(action, index) => (
                            <button class={`btn sm ${index() === 0 ? "primary" : "ghost"}`} disabled={t().running} onClick={() => void runToastChoice(t().id, index())}>
                                {action.label}
                            </button>
                        )}
                    </For>
                    <button
                        class="btn sm ghost"
                        onClick={async () => {
                            const copied = await copyText(t().message);
                            toast(copied ? "Copied error" : "Couldn't copy error", copied ? "success" : "info");
                        }}
                    >
                        <Copy size={13} />
                        Copy error
                    </button>
                </div>
            </div>
            <button class="hb sm error-card-x" aria-label="Dismiss" title="Dismiss" onClick={() => dismissToast(t().id)}>
                <X size={14} />
            </button>
        </div>
    );
}

/**
 * The feedback at one place (see errorPlace): mount one wherever it may show, and only the one
 * that applies shows it. On Home: `<ErrorCards place="home" />` above its composer.
 */
export function ErrorCards(p: { place: ErrorPlace }) {
    const place = p.place;
    setMounted((m) => [...m, place]);
    onCleanup(() =>
        setMounted((m) => {
            const i = m.indexOf(place);
            return i < 0 ? m : [...m.slice(0, i), ...m.slice(i + 1)];
        }),
    );
    // A floating inspector uses the window host regardless of its current height. The
    // cards themselves change dockHeight: routing on inspector.short would move them
    // back and forth as adding/removing them makes the inspector short/tall.
    const windowHost = () => {
        const layout = shellLayout();
        return coversComposer(layout) || (layout.inspector.open && layout.inspector.mode !== "dock");
    };
    const here = () => errorPlace(mounted(), !!settingsTab(), windowHost()) === place;
    // Newest first, as the mockup stacks them.
    const errors = () => (here() ? toasts.filter((t) => t.level === "error").reverse() : []);
    const notes = () => (here() ? toasts.filter((t) => t.level !== "error") : []);
    const shown = () => errors().slice(0, MAX_ERROR_CARDS);
    const more = () => errors().length - shown().length;
    return (
        <div class={`feedback at-${place}`}>
            <div class="toast-region" role="status" aria-live="polite" aria-relevant="additions text">
                <For each={notes()}>{(t) => <ToastItem toast={t} />}</For>
            </div>
            <div class={`error-cards at-${place}`} classList={{ empty: !shown().length }} role="alert" aria-live="assertive" aria-relevant="additions text">
                <For each={shown()}>{(t) => <ErrorCard toast={t} />}</For>
                <Show when={more() > 0}>
                    <div class="error-more">{more()} more</div>
                </Show>
            </div>
        </div>
    );
}
