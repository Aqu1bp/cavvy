// Who has the keyboard when a terminal is open and a card waits for an answer (components/InteractionDock.tsx: its
// number keys and Esc work while nothing is typed elsewhere).
//
// A terminal takes the keyboard when the user asks for it: opening the panel, adding or picking a tab, clicking in
// it. Coming into view by itself (its tabs back after a reload, a session of another project opened) it leaves the
// keyboard alone while a card waits, and gives it up to a card that arrives before the user has used it.

/** How long after the user asked for a terminal it still takes the keyboard as asked for: a shell takes a moment to attach. */
const ASKED_MS = 1500;
/** On a terminal that took the keyboard by itself and hasn't been typed or clicked in since. */
const UNASKED = "data-unasked";

let askedAt = -Infinity;

/** The user opened the terminal panel, or added or picked a tab. */
export function terminalAsked(): void {
    askedAt = performance.now();
}

/** Whether a terminal that came into view takes the keyboard. One that takes it unasked is marked so. */
export function terminalTakesKeys(screen: HTMLElement): boolean {
    // It has the keyboard already: whose it is doesn't change.
    if (screen.contains(document.activeElement)) return true;
    const asked = performance.now() - askedAt < ASKED_MS;
    if (!asked && document.querySelector(".itab")) return false;
    screen.toggleAttribute(UNASKED, !asked);
    return true;
}

/** Typed or clicked in, or left: no longer a terminal that merely took the keyboard. */
export function terminalUsed(screen: HTMLElement): void {
    screen.removeAttribute(UNASKED);
}

/** A card arrived: a terminal that only took the keyboard gives it up, so the card's keys answer it. */
export function cardArrived(): void {
    const el = document.activeElement as HTMLElement | null;
    if (el?.closest(`[${UNASKED}]`)) el.blur();
}
