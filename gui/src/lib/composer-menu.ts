/** WebKit may report the IME commit key as 229 without isComposing. */
export const composingKey = (e: Pick<KeyboardEvent, "isComposing" | "keyCode">) => e.isComposing || e.keyCode === 229;

/** Only scroll the menu, never the transcript or page containing it. */
export function revealMenuOption(list: HTMLElement, option: HTMLElement) {
    const bounds = list.getBoundingClientRect();
    const row = option.getBoundingClientRect();
    if (row.top < bounds.top) list.scrollTop += row.top - bounds.top;
    else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
}
