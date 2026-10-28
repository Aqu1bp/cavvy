// The composer's control row when it's tight: what's on it gives way a step at a time, so the model's
// name isn't cut to a letter or two. Measured rather than by the column's width (`data-narrow`): the
// name, the account and the pickers' labels are as long as they are. The row's `data-fit` holds the
// steps taken, as words ("1 2 3"), for composer.css:
//   1. the effort and mode pickers' labels (their glyphs stay; their tooltips say it)
//   2. the pickers' chevrons
//   3. the account after the model's name
//   4. the model's name, once only a few letters of it would show (the provider's mark stays)
//   5. the context ring

export const FIT_STEPS = 5;
/** Cut shorter than this many of its letters' height, the model's name gives way to the provider's mark. */
const NAME_LEAST_EM = 5;

/** The steps taken, as the attribute's words: 3 is "1 2 3". */
export function fitWords(steps: number): string {
    return Array.from({ length: steps }, (_, i) => i + 1).join(" ");
}

/** The fewest steps that fit, trying each in turn; all of them when none does. */
export function fewestSteps(fits: (steps: number) => boolean, most = FIT_STEPS): number {
    for (let n = 0; n < most; n++) if (fits(n)) return n;
    return most;
}

/** Its text is wider than the room it has (ellipsized). */
const cut = (el: Element | null) => Boolean(el && el.scrollWidth > el.clientWidth);

/**
 * Whether the row fits with `steps` taken (applied): its last control (send) inside its end, and the model's
 * name and account whole, or the name cut no shorter than `NAME_LEAST_EM`. Its end, not its scrollWidth:
 * the send button's hint card sticks out of the row while it shows.
 */
function fits(bar: HTMLElement, steps: number): boolean {
    const end = bar.lastElementChild?.getBoundingClientRect().right ?? 0;
    if (end > bar.getBoundingClientRect().right + 0.5) return false;
    const name = bar.querySelector<HTMLElement>(".pick.model > .truncate");
    if (steps < 3) return !cut(name) && !cut(bar.querySelector(".pick-acct"));
    if (steps === 3 && name && cut(name)) return name.clientWidth >= NAME_LEAST_EM * parseFloat(getComputedStyle(name).fontSize);
    return true;
}

function apply(bar: HTMLElement, steps: number) {
    const words = fitWords(steps);
    if ((bar.dataset.fit ?? "") !== words) bar.dataset.fit = words;
}

/**
 * Keeps `bar` fitted as it's resized and as what its controls say changes (a model, an account, fast mode).
 * Each change in the DOM is read back at once, before the frame is painted. Returns the cleanup.
 */
export function fitComposerBar(bar: HTMLElement): () => void {
    const fit = () => apply(bar, fewestSteps((n) => (apply(bar, n), fits(bar, n))));
    // The row's own size: the column, the window, the text size. Not its controls': each step resizes those.
    const sizes = new ResizeObserver(fit);
    sizes.observe(bar);
    // What the controls say. `data-fit` is an attribute, so setting it isn't seen here.
    const content = new MutationObserver(fit);
    content.observe(bar, { childList: true, characterData: true, subtree: true });
    void document.fonts?.ready.then(fit);
    return () => (sizes.disconnect(), content.disconnect());
}
