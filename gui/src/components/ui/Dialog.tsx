import { createSignal, createUniqueId, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { X } from "lucide-solid";
import { focusMoved, tabWrap, userMovedFocus } from "../../lib/focus-trap";

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
    /** The body runs edge to edge (a list): the design's .dlg-body-bare. */
    edge?: boolean;
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
/** Whether a dialog is open: it covers what's behind it, the errors shown there too (ErrorCards). */
const [isOpen, setDialogOpen] = createSignal(false);
export const dialogOpen = isOpen;

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
        setDialogOpen(true);
        document.documentElement.toggleAttribute("data-dialog", true);
        const onKey = (e: KeyboardEvent) => {
            if (stack[stack.length - 1] !== me || !box) return;
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                p.onClose();
            } else if (e.key === "Tab") {
                // The user moves the keyboard: what loads later doesn't take it back (takeFocus).
                focusMoved(me);
                // Tab stays in the dialog: what's behind it can't be reached while it's open.
                // A roving group's other members (tabIndex -1) aren't Tab stops, so they can't be the ends it wraps at.
                const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
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
        // Focus the field marked autofocus, else the first, or the dialog itself.
        requestAnimationFrame(() => {
            if (box && userMovedFocus(box)) return;
            const first = box?.querySelector<HTMLElement>("[autofocus]") ?? box?.querySelector<HTMLElement>("input, textarea, select, button:not(.dlg-close)");
            (first ?? box)?.focus();
        });
        onCleanup(() => {
            document.removeEventListener("keydown", onKey, true);
            stack.splice(stack.indexOf(me), 1);
            setDialogOpen(stack.length > 0);
            document.documentElement.toggleAttribute("data-dialog", stack.length > 0);
            previous?.focus?.();
        });
    });
    return (
        <Portal>
            <div class={`dialog-backdrop ${p.top ? "top" : ""}`} onPointerDown={(e) => e.target === e.currentTarget && p.onClose()}>
                <div
                    ref={box}
                    class={`dialog dlg ${p.class ?? ""}`}
                    style={{ width: `min(calc(${p.width ?? 520} * var(--sp)), calc(100vw - 32px))` }}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={p.bare ? p.labelledBy : p.title ? titleId : undefined}
                    tabIndex={-1}
                    onPointerDown={() => focusMoved(box!)}
                >
                    <Show when={!p.bare}>
                        <header class="dlg-head">
                            <div class="dlg-heading">
                                <h2 class="dlg-title" id={titleId}>{p.title}</h2>
                                <Show when={p.subtitle}>
                                    <p class="dlg-sub selectable">{p.subtitle}</p>
                                </Show>
                            </div>
                            <button type="button" class="icon-btn icon-btn-sm dlg-close" onClick={() => p.onClose()} aria-label="Close">
                                <X size={14} />
                            </button>
                        </header>
                    </Show>
                    <div class={`dialog-body dlg-body selectable${p.edge ? " dlg-body-bare" : ""}`}>{p.children}</div>
                    <Show when={p.footer}>
                        <footer class="dlg-foot">{p.footer}</footer>
                    </Show>
                </div>
            </div>
        </Portal>
    );
}
