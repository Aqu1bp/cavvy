// What plays once as a row first comes in (a step rising into the work, "Worked for" fading in) is over at once when
// it isn't drawn: a turn or a row the browser skips (content-visibility, far from the view) stops its animations where
// they are, and one stopped part way is never let go of. Each one left like that costs the page on every frame, for
// as long as the conversation is open. Endless ones (a spinner, the writing dot) are left to go on.

/** Ends the one-time animations in `el` (and under it), as they'd end anyway. */
export function finishEntrances(el: Element) {
    finishEntrancesIn([el]);
}

/**
 * The same for each of `els`, at once. Asking for animations brings the page's style up to date first: asked for
 * each turn in turn, with each one's attribute changed between (it's let go of as it goes far), that was the page's
 * style worked out again for every one of them (a jump from the top of a long session to its end: 40 times, most of
 * the jump's frame). Asked once, before any of them changes, and only of what's running.
 */
export function finishEntrancesIn(els: readonly Element[]) {
    if (!els.length || typeof document === "undefined" || typeof document.getAnimations !== "function") return;
    for (const a of document.getAnimations()) {
        if (a.effect?.getComputedTiming().iterations === Infinity) continue;
        const target = (a.effect as KeyframeEffect | null)?.target;
        if (target && els.some((el) => el.contains(target))) a.finish();
    }
}
