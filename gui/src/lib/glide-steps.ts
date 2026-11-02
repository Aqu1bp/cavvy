// Experiment (VITE_GLIDE_HZ at build time): the conversation's glides drawn at most this many times a second, the
// same curve in steps, rather than on every refresh of the display (120 a second on a ProMotion screen). Unset: as
// before, every refresh.

export const GLIDE_HZ = ((): number => {
    const v = Number((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_GLIDE_HZ);
    return Number.isFinite(v) && v > 0 ? v : 0;
})();

/** A CSS cubic-bezier(x1, y1, x2, y2) as a function of time (0..1). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
    const at = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
    return (t) => {
        if (t <= 0) return 0;
        if (t >= 1) return 1;
        // The curve's parameter for this time, by bisection: x is increasing in s.
        let lo = 0, hi = 1, s = t;
        for (let i = 0; i < 30; i++) {
            s = (lo + hi) / 2;
            if (at(x1, x2, s) < t) lo = s;
            else hi = s;
        }
        return at(y1, y2, s);
    };
}

/**
 * Keyframes and timing for a move from translateY(`from`) to none over `ms` on `curve`: as given, or, with GLIDE_HZ,
 * the curve's values held between steps GLIDE_HZ a second apart.
 */
export function glideKeyframes(from: number, ms: number, easing: string, curve: (t: number) => number): { keyframes: Keyframe[]; easing: string } {
    if (!GLIDE_HZ) return { keyframes: [{ transform: `translateY(${from}px)` }, { transform: "none" }], easing };
    const n = Math.max(1, Math.round((ms * GLIDE_HZ) / 1000));
    const keyframes: Keyframe[] = [];
    for (let k = 0; k <= n; k++) keyframes.push({ offset: k / n, easing: "step-end", transform: k === n ? "none" : `translateY(${from * (1 - curve(k / n))}px)` });
    return { keyframes, easing: "linear" };
}

/**
 * Where a glide from `from` over `ms` draws its element at `progress` (its effect's computed progress): as eased by its
 * timing, or, in steps, the step it's on.
 */
export function glideOffset(from: number, ms: number, progress: number, curve: (t: number) => number): number {
    if (!GLIDE_HZ) return from * (1 - progress);
    const n = Math.max(1, Math.round((ms * GLIDE_HZ) / 1000));
    return from * (1 - curve(Math.min(n, Math.floor(progress * n)) / n));
}
