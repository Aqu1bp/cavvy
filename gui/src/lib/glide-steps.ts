// The conversation's glides (Transcript: growth while following the end, a fold, the composer resizing) drawn at
// most GLIDE_HZ times a second: the same curve over the same time, held between steps, rather than drawn on every
// refresh of the display. While a reply streams, a glide is under way most of the time, and on a 120 Hz screen each
// refresh is a frame for the GPU; at 60 a second, a 60 Hz screen draws what it drew before, and a 120 Hz one half
// the frames, of moves of a few pixels each.

/** Steps a second: the most a glide is drawn. (Experiment: VITE_GLIDE_HZ at build time, 120 for every refresh of a ProMotion screen.) */
export const GLIDE_HZ = Number((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_GLIDE_HZ) || 60;

/** A CSS cubic-bezier(x1, y1, x2, y2) as a function of time (0..1). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
    const at = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
    return (t) => {
        if (t <= 0) return 0;
        if (t >= 1) return 1;
        // The curve's parameter for this time, by bisection: x grows with it.
        let lo = 0, hi = 1, s = t;
        for (let i = 0; i < 30; i++) {
            s = (lo + hi) / 2;
            if (at(x1, x2, s) < t) lo = s;
            else hi = s;
        }
        return at(y1, y2, s);
    };
}

/** How many steps a glide of `ms` takes. */
const stepsIn = (ms: number) => Math.max(1, Math.round((ms * GLIDE_HZ) / 1000));

/**
 * A move from translateY(`from`) to its place over `ms` on `curve`, in steps: each step's place, held until the next
 * (linear timing, so the effect's progress is time).
 */
export function glideKeyframes(from: number, ms: number, curve: (t: number) => number): Keyframe[] {
    const n = stepsIn(ms);
    const out: Keyframe[] = [];
    for (let k = 0; k <= n; k++) out.push({ offset: k / n, easing: "step-end", transform: k === n ? "none" : `translateY(${from * (1 - curve(k / n))}px)` });
    return out;
}

/** Where a glide from `from` over `ms` draws its element at `progress` (its effect's, linear): the step it's on. */
export function glideOffset(from: number, ms: number, progress: number, curve: (t: number) => number): number {
    const n = stepsIn(ms);
    return from * (1 - curve(Math.min(n, Math.floor(progress * n)) / n));
}

/** Experiment: how the conversation follows a reply (VITE_FOLLOW=runway: in room kept under it, Transcript's `follow`). */
export const FOLLOW_RUNWAY = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_FOLLOW === "runway";
