/** WebKit may report the IME commit key as 229 without isComposing. */
export const composingKey = (e: Pick<KeyboardEvent, "isComposing" | "keyCode">) => e.isComposing || e.keyCode === 229;

/** Only scroll the menu, never the transcript or page containing it. */
export function revealMenuOption(list: HTMLElement, option: HTMLElement) {
    const bounds = list.getBoundingClientRect();
    const row = option.getBoundingClientRect();
    // Its bottom edge fades while there's more below (base.css): a row stops above that, by the list's scroll padding.
    const bottom = bounds.bottom - (parseFloat(globalThis.getComputedStyle?.(list).scrollPaddingBottom) || 0);
    if (row.top < bounds.top) list.scrollTop += row.top - bounds.top;
    else if (row.bottom > bottom) list.scrollTop += row.bottom - bottom;
}
