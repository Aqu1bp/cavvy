import { onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { X } from "lucide-solid";

export interface DialogProps {
    open: boolean;
    onClose: () => void;
    title?: JSX.Element;
    subtitle?: JSX.Element;
    width?: number;
    class?: string;
    /** No header row (the content brings its own). */
    bare?: boolean;
    children: JSX.Element;
    footer?: JSX.Element;
}

export function Dialog(p: DialogProps) {
    return (
        <Show when={p.open}>
            <DialogInner {...p} />
        </Show>
    );
}

function DialogInner(p: DialogProps) {
    let box: HTMLDivElement | undefined;
    const previous = document.activeElement as HTMLElement | null;
    onMount(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                p.onClose();
            }
        };
        document.addEventListener("keydown", onKey, true);
        // Focus the first field, or the dialog itself.
        requestAnimationFrame(() => {
            const first = box?.querySelector<HTMLElement>("[autofocus], input, textarea, select, button:not(.dialog-close)");
            (first ?? box)?.focus();
        });
        onCleanup(() => {
            document.removeEventListener("keydown", onKey, true);
            previous?.focus?.();
        });
    });
    return (
        <Portal>
            <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}>
                <div ref={box} class={`dialog ${p.class ?? ""}`} style={{ width: `min(${p.width ?? 520}px, calc(100vw - 32px))` }} role="dialog" aria-modal="true" tabIndex={-1}>
                    <Show when={!p.bare}>
                        <div class="dialog-head">
                            <div>
                                <div class="dialog-title">{p.title}</div>
                                <Show when={p.subtitle}>
                                    <div class="dialog-sub">{p.subtitle}</div>
                                </Show>
                            </div>
                            <button class="icon-btn dialog-close" onClick={() => p.onClose()} aria-label="Close">
                                <X size={16} />
                            </button>
                        </div>
                    </Show>
                    <div class="dialog-body">{p.children}</div>
                    <Show when={p.footer}>
                        <div class="dialog-foot">{p.footer}</div>
                    </Show>
                </div>
            </div>
        </Portal>
    );
}
