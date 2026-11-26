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

/**
 * Gives `el` the keyboard if nothing has been given it on purpose since its dialog opened: it's on nothing, still
 * outside the dialog (on what opened it), or on what the dialog gave it first (its buttons). For a field that comes
 * once a dialog's content has loaded. `select`: its text too, so typing replaces what was filled in.
 */
export function takeFocus(el: HTMLElement | undefined, select = false): void {
    const at = document.activeElement;
    if (!el?.isConnected || (at && at !== document.body && el.closest('[role="dialog"]')?.contains(at) && !at.closest(".dialog-actions"))) return;
    el.focus();
    if (select && el instanceof HTMLInputElement) el.select();
}
