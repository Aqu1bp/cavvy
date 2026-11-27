// Where Tab goes at a dialog's edges (components/ui/Dialog.tsx): it stays in
// the dialog, so what's behind it can't be reached while it's open.

/**
 * What to focus instead of where Tab would go, or undefined to let it.
 * `items`: the dialog's tabbable elements in order; `at`: what has focus;
 * `inside`: whether that's in the dialog. From anything in it that isn't an
 * item (the dialog box itself, or a wrapper focused when it opened), it goes
 * as from the box: Shift+Tab to the last, Tab to the first.
 */
export function tabWrap<T>(items: readonly T[], at: T | null, inside: boolean, shift: boolean): T | undefined {
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return undefined;
    if (!inside || at === null || !items.includes(at)) return shift ? last : first;
    if (shift ? at === first : at === last) return shift ? last : first;
    return undefined;
}

/** Dialogs whose keyboard the user has moved themselves (Tab, a click) since they opened: nothing moves it for them after that. */
const moved = new WeakSet<Element>();
export const focusMoved = (dialog: Element) => void moved.add(dialog);
export const userMovedFocus = (dialog: Element) => moved.has(dialog);

/**
 * Gives `el` the keyboard if the user hasn't moved it since its dialog opened: it's on nothing, still outside the
 * dialog (on what opened it), or on what the dialog gave it first (its buttons). For a field that comes once a dialog's
 * content has loaded. `select`: its text too, so typing replaces what was filled in.
 */
export function takeFocus(el: HTMLElement | undefined, select = false): void {
    const at = document.activeElement;
    const dialog = el?.closest('[role="dialog"]');
    if (!el?.isConnected || (dialog && moved.has(dialog)) || (at && at !== document.body && dialog?.contains(at) && !at.closest(".dialog-actions"))) return;
    el.focus();
    if (select && el instanceof HTMLInputElement) el.select();
}
