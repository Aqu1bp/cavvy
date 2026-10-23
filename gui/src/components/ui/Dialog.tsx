import { createUniqueId, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { X } from "lucide-solid";
import { tabWrap } from "../../lib/focus-trap";

export interface DialogProps {
    open: boolean;
    onClose: () => void;
    title?: JSX.Element;
    subtitle?: JSX.Element;
    width?: number;
    class?: string;
    /** No header row (the content brings its own). */
    bare?: boolean;
    /** A bare dialog's name: the id of the heading its content brings. */
    labelledBy?: string;
    /** Opens near the top of the window (the command palette) instead of in its middle. */
    top?: boolean;
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

/** Open dialogs' boxes, the topmost last: only it takes keys. */
const stack: HTMLElement[] = [];

/** Whether `el` is in the dialog on top (keys a dialog handles itself go to it alone). */
export function inTopDialog(el: Element): boolean {
    return Boolean(stack[stack.length - 1]?.contains(el));
}
const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

function DialogInner(p: DialogProps) {
    const titleId = createUniqueId();
    let box: HTMLDivElement | undefined;
    const previous = document.activeElement as HTMLElement | null;
    onMount(() => {
        const me = box!;
        stack.push(me);
        const onKey = (e: KeyboardEvent) => {
            if (stack[stack.length - 1] !== me || !box) return;
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                p.onClose();
            } else if (e.key === "Tab") {
                // Tab stays in the dialog: what's behind it can't be reached while it's open.
                const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
                if (!items.length) {
                    e.preventDefault();
                    box.focus();
                    return;
                }
                const at = document.activeElement as HTMLElement | null;
                const to = tabWrap(items, at, box.contains(at), e.shiftKey);
                if (to) {
                    e.preventDefault();
                    to.focus();
                }
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
            stack.splice(stack.indexOf(me), 1);
            previous?.focus?.();
        });
    });
    return (
        <Portal>
            <div class={`dialog-backdrop ${p.top ? "top" : ""}`} onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}>
                <div
                    ref={box}
                    class={`dialog glass ${p.class ?? ""}`}
                    style={{ width: `min(calc(${p.width ?? 520} * var(--sp)), calc(100vw - 32px))` }}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={p.bare ? p.labelledBy : p.title ? titleId : undefined}
                    tabIndex={-1}
                >
                    <Show when={!p.bare}>
                        <div class="dialog-head">
                            <div>
                                <div class="dialog-title" id={titleId}>{p.title}</div>
                                <Show when={p.subtitle}>
                                    <div class="dialog-sub selectable">{p.subtitle}</div>
                                </Show>
                            </div>
                            <button class="icon-btn dialog-close" onClick={() => p.onClose()} aria-label="Close">
                                <X size={16} />
                            </button>
                        </div>
                    </Show>
                    <div class="dialog-body selectable">{p.children}</div>
                    <Show when={p.footer}>
                        <div class="dialog-foot">{p.footer}</div>
                    </Show>
                </div>
            </div>
        </Portal>
    );
}
