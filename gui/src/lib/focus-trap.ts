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
