// Settings covers the session (and its inspector) without unmounting it (App.tsx), so coming back
// is a repaint rather than building, laying out and fetching everything again. Covered parts are
// marked with data-covered and aria-hidden. Neither restyles anything, where `inert` or
// `visibility: hidden` restyles every element inside: tens of milliseconds in WebKit for a long
// conversation, on every opening and closing. What inert would also do, keeping focus out, is done
// here, by moving focus that lands inside past the covered part.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Can take focus and is in sight: not covered, inert or hidden. */
function reachable(el: HTMLElement): boolean {
    if (el.closest("[data-covered], [inert]")) return false;
    if (!el.getClientRects().length) return false;
    return el.checkVisibility?.({ checkVisibilityCSS: true, visibilityProperty: true }) ?? true;
}

/**
 * For a covered part's focusin: focus moves on to what's after it (Tab from before it) or before
 * it (Shift+Tab from after it), as if it weren't there; with nothing there, focus just leaves.
 */
export function skipCovered(e: FocusEvent) {
    const box = e.currentTarget as HTMLElement;
    const target = e.target as HTMLElement;
    if (!box.hasAttribute("data-covered") || !box.contains(target)) return;
    const from = e.relatedTarget as Node | null;
    const forward = !from || box.contains(from) || Boolean(box.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_PRECEDING);
    const all = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !box.contains(el));
    const after = (el: HTMLElement) => Boolean(box.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    const next = forward ? all.find((el) => after(el) && reachable(el)) : all.reverse().find((el) => !after(el) && reachable(el));
    if (next) next.focus();
    else target.blur();
}
