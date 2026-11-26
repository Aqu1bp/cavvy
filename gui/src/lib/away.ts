// Whether anyone's at the window: what a theme's scene (ThemeBackdrop.tsx) moves for.

import { createEffect, createSignal, onCleanup, untrack } from "solid-js";

/** No touch of the window for this long, and its scene stops moving: an agent can run for hours with nobody watching. */
export const AWAY_MS = 2 * 60_000;

/**
 * Whether nobody's been at the window for AWAY_MS while `watch` holds: no pointer, key or wheel in it, and it hasn't
 * come to the front. One timer, while watched, that looks again when the time's up: a touch only notes the time.
 */
export function away(watch: () => boolean): () => boolean {
    const [isAway, setAway] = createSignal(false);
    let last = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
        const idle = performance.now() - last;
        if (idle >= AWAY_MS) {
            timer = undefined;
            setAway(true);
        } else timer = setTimeout(look, AWAY_MS - idle);
    };
    const touched = () => {
        last = performance.now();
        if (isAway()) setAway(false);
        if (!timer && untrack(watch)) timer = setTimeout(look, AWAY_MS);
    };
    const seen = () => !document.hidden && touched();
    const EVENTS = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    createEffect(() => {
        if (!watch()) {
            clearTimeout(timer);
            timer = undefined;
            setAway(false);
            return;
        }
        for (const e of EVENTS) window.addEventListener(e, touched, { capture: true, passive: true });
        window.addEventListener("focus", touched);
        document.addEventListener("visibilitychange", seen);
        // Untracked: reading whether it's away here would start it over each time it goes away.
        untrack(touched);
        onCleanup(() => {
            for (const e of EVENTS) window.removeEventListener(e, touched, { capture: true });
            window.removeEventListener("focus", touched);
            document.removeEventListener("visibilitychange", seen);
            clearTimeout(timer);
            timer = undefined;
        });
    });
    return isAway;
}
