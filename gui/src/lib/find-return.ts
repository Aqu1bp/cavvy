// Find in page opened from the Browser pane's address bar: the keyboard goes back there as the bar closes, with what
// was typed in it and the caret as they were, as a browser's find bar does. From the page, it goes back to the page
// (BrowserTools.tsx closeFind).

type Field = Pick<HTMLInputElement, "selectionStart" | "selectionEnd" | "selectionDirection" | "disabled" | "isConnected" | "focus" | "setSelectionRange">;

/** The address bar's caret (or selection) as the find bar took the keyboard from it. */
export interface AddressMark {
    start: number | null;
    end: number | null;
    dir: "forward" | "backward" | "none" | null;
}

/** The address bar's caret when it has the keyboard (`active`) as the find bar opens; undefined when the keyboard is elsewhere. */
export function addressMark(address: Field | undefined, active: unknown): AddressMark | undefined {
    if (!address || active !== address || address.disabled) return undefined;
    return { start: address.selectionStart, end: address.selectionEnd, dir: address.selectionDirection };
}

/**
 * The keyboard back in the address bar with its caret as it was. Its focus selects all of it (BrowserPane.tsx), which
 * the next key would replace: the caret is put back after. false: it can't have the keyboard now (gone, or turned off).
 */
export function backToAddress(address: Field | undefined, mark: AddressMark | undefined): boolean {
    if (!address || !mark || !address.isConnected || address.disabled) return false;
    address.focus({ preventScroll: true });
    if (mark.start !== null && mark.end !== null) address.setSelectionRange(mark.start, mark.end, mark.dir ?? undefined);
    return true;
}

/** Whether the keyboard leaving the address bar for `next` keeps what was typed there: `next` is in the find bar. */
export const keepsDraft = (bar: Pick<Node, "contains"> | undefined, next: EventTarget | null): boolean => !!bar && !!next && bar.contains(next as Node);
