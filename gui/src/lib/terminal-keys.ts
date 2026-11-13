// Who has the keyboard when a terminal is open and a card waits for an answer (components/InteractionDock.tsx: its
// number keys and Esc work while nothing is typed elsewhere).
//
// A terminal takes the keyboard when the user asks for it: opening the panel, adding or picking a tab, clicking in
// it. Coming into view by itself (its tabs back after a reload, a session of another project opened) it leaves the
// keyboard alone while a card waits, and gives it up to a card that arrives in the moment after (the session's card
// comes a little later than its terminal). Past that moment the terminal is the user's, touched or not: a card that
// arrives while they read what a script prints doesn't take the keys they meant for it.

/** How long after the user asked for a terminal it still takes the keyboard as asked for: a shell takes a moment to attach. */
const ASKED_MS = 1500;
/** How long after a terminal took the keyboard by itself a card arriving still gets it back: as long as a session's card is in coming. */
const UNASKED_MS = 3000;
/** On a terminal that took the keyboard by itself and hasn't been used since: when it did. */
const UNASKED = "data-unasked";

let askedAt = -Infinity;

/** The user opened the terminal panel, or added or picked a tab. */
export function terminalAsked(): void {
    askedAt = performance.now();
}

/** A card the user can see now: not one under Settings, or behind a terminal that covers the conversation. */
function cardShowing(): boolean {
    const card = document.querySelector<HTMLElement>(".itab");
    return Boolean(card) && !card!.closest("[data-covered]") && card!.checkVisibility?.({ checkVisibilityCSS: true, visibilityProperty: true }) !== false;
}

/** Whether a terminal that came into view takes the keyboard. One that takes it unasked is marked so. */
export function terminalTakesKeys(screen: HTMLElement): boolean {
    // It has the keyboard already: whose it is doesn't change.
    if (screen.contains(document.activeElement)) return true;
    const asked = performance.now() - askedAt < ASKED_MS;
    if (!asked && cardShowing()) return false;
    if (asked) screen.removeAttribute(UNASKED);
    else screen.setAttribute(UNASKED, String(performance.now()));
    return true;
}

/** Typed, clicked or scrolled in, or left: no longer a terminal that merely took the keyboard. */
export function terminalUsed(screen: HTMLElement): void {
    screen.removeAttribute(UNASKED);
}

/** A card arrived: a terminal that only just took the keyboard by itself gives it up, so the card's keys answer it. */
export function cardArrived(): void {
    const el = document.activeElement as HTMLElement | null;
    const took = el?.closest(`[${UNASKED}]`);
    if (!el || !took) return;
    // Not for a card the terminal covers (maximized over the conversation): its keys are off while it can't be seen.
    if (performance.now() - Number(took.getAttribute(UNASKED)) < UNASKED_MS && !took.closest(".terminal-panel.max")) el.blur();
    else took.removeAttribute(UNASKED);
}
