// Whose a key is while a card waits for an answer (components/InteractionDock.tsx): its number keys and Esc work
// while nothing is typed elsewhere.

/** When the user last pressed Sign in here (in a card, or on one put off): a window only brings a port over for a sign-in started in it. */
export const signInPressed = { at: 0 };

type Focused = Pick<HTMLElement, "tagName" | "isContentEditable" | "closest"> & { value?: string };

/**
 * Something that takes typing has the keyboard. The find bar's buttons too: its Esc closes it, and it has no use for the number
 * keys. And the browser's page and a sign-in's prompt, which take every key.
 */
export function typingIn(el: Focused | null): boolean {
    return Boolean(el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable || el.closest(".find-bar, .br-canvas, .si-term")));
}

/**
 * Whether a key pressed now is the card's. Esc from the composer's message box with nothing typed in it is: the card
 * says "Deny Esc", the box has the keyboard whenever a session is opened, and there's no message to lose. A number
 * there isn't: it may be the start of one. Nor is Esc in a field of the card itself (what to do instead: the card
 * sits in the composer too), which closes that field.
 */
export function cardsKey(key: string, el: Focused | null): boolean {
    if (!typingIn(el)) return true;
    return key === "Escape" && el!.tagName === "TEXTAREA" && Boolean(el!.closest(".composer")) && !el!.closest(".itab") && !el!.value;
}
