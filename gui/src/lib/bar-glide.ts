// The title bar through the rail's slide. Hiding the rail puts its two buttons, and the project, before the title;
// showing it takes them away. Either way the title's place in the bar changes at once, while the bar itself slides
// with the sheet: left alone, the title jumps one way and then slides the other. So each part of the bar is drawn from
// where it was and moved to its new place in step with the slide. What's new is drawn where it ends up in the window
// from the start, and the sheet's edge uncovers it on its way there.

/** A part's left edge from the bar's own, as drawn (a glide under way included), and whether it's there at all. */
export interface BarPlace { left: number; shown: boolean }

/** Under this, a part hasn't moved: no animation for a rounding difference. */
const STILL = 0.5;

/**
 * How far from its new place a part is drawn as the slide starts (px, along the bar), or undefined to leave it be.
 * `travel`: how far the bar itself moves over the slide. A part that's new starts that far back, so it stays where
 * it is in the window while the bar moves under it.
 */
export function barMove(before: BarPlace | undefined, after: BarPlace, travel: number): number | undefined {
    if (!after.shown) return undefined;
    const dx = before?.shown ? before.left - after.left : travel;
    return Math.abs(dx) > STILL ? dx : undefined;
}

/** Where the parts are now, from the bar's left edge. */
export function barPlaces(bar: Element, parts: readonly Element[]): Map<Element, BarPlace> {
    const origin = bar.getBoundingClientRect().left;
    return new Map(parts.map((el) => {
        const box = el.getBoundingClientRect();
        return [el, { left: box.left - origin, shown: box.width > 0 }];
    }));
}

/**
 * Starts the parts' moves, timed as `slide` is (the window's track sliding) and kept in step with it.
 * `before`: where they were, read before the rail changed; `travel`: how far the bar's own left edge moves over the
 * slide. Returns the animations, to cancel if another slide begins.
 */
export function glideBar(bar: Element, parts: readonly Element[], before: ReadonlyMap<Element, BarPlace>, slide: Animation, travel: number): Animation[] {
    const timing = slide.effect?.getTiming();
    if (!timing) return [];
    const options = { duration: Number(timing.duration), easing: timing.easing };
    const moves: Animation[] = [];
    for (const [el, place] of barPlaces(bar, parts)) {
        const dx = barMove(before.get(el), place, travel);
        if (dx !== undefined) moves.push(el.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], options));
    }
    // Both start on the next frame; this keeps them together if they don't.
    void slide.ready.then(() => { for (const m of moves) if (m.playState !== "idle" && slide.startTime !== null) m.startTime = slide.startTime; }, () => {});
    return moves;
}
