// The composer's text: a modest height that scrolls past it (composer.css), and a large size on request
// (Composer.tsx's expand button), opened and closed by a transform the conversation glides with (Transcript).

/** How long opening or closing the large size takes, before Settings → Motion: the conversation's glide's (Transcript GLIDE_MS). */
export const GROW_MS = 240;
/** The glide's easing (Transcript GLIDE_EASE), so the box's edge and the conversation's end move together. */
export const GROW_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const CURVE = [0.2, 0.8, 0.2, 1] as const;

/** At the large size, this much of the column's top (and at least KEEP_MIN) stays clear: the title bar and the conversation's end. */
export const KEEP = 0.3;
export const KEEP_MIN = 160;

/**
 * The text's height at the large size, from its height and the composer's top now: it grows up from the bottom, so
 * its top lands `KEEP` below the column's. Never less than `least` (the height it had before it was opened).
 */
export function expandedHeight(p: { text: number; top: number; columnTop: number; column: number; least: number }): number {
    const keep = Math.max(KEEP_MIN, p.column * KEEP);
    return Math.max(p.least, Math.round(p.text + p.top - (p.columnTop + keep)));
}

/** Home's composer grows down instead: its foot (the strip under the card included) lands this far above the page's. */
export const FOOT_GAP = 24;

/** The text's height at the large size on Home, from its height and the composer's foot now. Never less than `least`. */
export function expandedDown(p: { text: number; bottom: number; pageBottom: number; least: number }): number {
    return Math.max(p.least, Math.round(p.text + p.pageBottom - FOOT_GAP - p.bottom));
}

/** A cubic-bezier easing's progress at time t (0 to 1), as CSS draws it. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, t: number): number {
    const at = (a: number, b: number, u: number) => 3 * a * u * (1 - u) ** 2 + 3 * b * u ** 2 * (1 - u) + u ** 3;
    // x(u) rises with u: halve the interval until it finds t.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (at(x1, x2, mid) < t) lo = mid;
        else hi = mid;
    }
    return at(y1, y2, (lo + hi) / 2);
}

/**
 * Keyframes that take a box from `from` to `to` px tall when it's already `to` tall: the box scaled to the height
 * it's drawn at, and what's in it scaled back, so the text isn't stretched and stays where it's laid out. The easing
 * is baked in (an inverse scale isn't linear in time), to play with linear timing.
 */
export function growFrames(from: number, to: number, steps = 20): { box: Keyframe[]; content: Keyframe[] } {
    const box: Keyframe[] = [];
    const content: Keyframe[] = [];
    for (let i = 0; i <= steps; i++) {
        const drawn = from + (to - from) * cubicBezier(...CURVE, i / steps);
        const s = to > 0 ? drawn / to : 1;
        box.push({ transform: `scaleY(${s})` });
        content.push({ transform: `scaleY(${1 / s})` });
    }
    return { box, content };
}

/** Each box's grow under way: a new one takes over from it. */
const growing = new WeakMap<HTMLElement, Animation[]>();

/**
 * Plays growFrames on the box: about its bottom edge (a composer at the window's foot grows up) or its top (Home's
 * grows down). What's in it is clipped to the edge as it moves. `from` is the height it's drawn at (a grow under way
 * included), `to` the one it's laid out at now.
 */
export function grow(box: HTMLElement, from: number, to: number, edge: "top" | "bottom", ms: number): void {
    for (const a of growing.get(box) ?? []) a.cancel();
    growing.delete(box);
    const children = [...box.children] as HTMLElement[];
    const settle = () => {
        box.style.transformOrigin = "";
        box.style.overflow = "";
        for (const el of children) el.style.transformOrigin = "";
    };
    settle();
    if (!ms || Math.abs(to - from) < 1 || typeof box.animate !== "function") return;
    const { box: frames, content } = growFrames(from, to);
    const timing = { duration: ms, easing: "linear" };
    box.style.transformOrigin = edge === "bottom" ? "50% 100%" : "50% 0";
    box.style.overflow = "clip";
    // Each child scaled back about the box's edge, in its own coordinates: together they cancel.
    for (const el of children) el.style.transformOrigin = `50% ${edge === "bottom" ? to - el.offsetTop : -el.offsetTop}px`;
    const anims = [box.animate(frames, timing), ...children.map((el) => el.animate(content, timing))];
    growing.set(box, anims);
    anims[0]!.onfinish = () => {
        if (growing.get(box) !== anims) return;
        growing.delete(box);
        settle();
    };
}
