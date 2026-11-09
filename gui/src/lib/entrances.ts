// What plays once as a row first comes in (a step rising into the work, "Worked for" fading in) is over at once when
// it isn't drawn: a turn or a row the browser skips (content-visibility, far from the view) stops its animations where
// they are, and one stopped part way is never let go of. Each one left like that costs the page on every frame, for
// as long as the conversation is open. Endless ones (a spinner, the writing dot) are left to go on.

/** Ends the one-time animations in `el` (and under it), as they'd end anyway. */
export function finishEntrances(el: Element) {
    if (typeof (el as HTMLElement).getAnimations !== "function") return;
    for (const a of el.getAnimations({ subtree: true })) if (a.effect?.getComputedTiming().iterations !== Infinity) a.finish();
}
