// Keeping something drawn outside the page's own layout (the Electron app's browser tab, a native-backed <webview> in
// BrowserHostLayer) over an element's box. The box moves when the window resizes, a panel slides open or is dragged, a
// dialog appears in it: after any of those, `place` runs every frame for a moment, and not at all while nothing moves.
// (Running it every frame regardless cost the UI's CPU while the window sat still.)

/** How long after a change the box is followed frame by frame: past the panels' slide (--dur 380ms). */
const SETTLE_MS = 700;

export interface Follow {
    /** Something else may have moved it (state the caller knows of): follow it for a moment. */
    kick(): void;
    stop(): void;
}

export function followBox(el: Element, place: () => void): Follow {
    let until = 0;
    let frame = 0;
    let stopped = false;
    const tick = () => {
        frame = 0;
        if (stopped) return;
        place();
        if (performance.now() < until) frame = requestAnimationFrame(tick);
    };
    const kick = () => {
        if (stopped) return;
        until = Math.max(until, performance.now() + SETTLE_MS);
        if (!frame) frame = requestAnimationFrame(tick);
    };
    const resize = new ResizeObserver(kick);
    resize.observe(el);
    resize.observe(document.documentElement);
    const mutate = new MutationObserver(kick);
    mutate.observe(el, { childList: true, subtree: true });
    const events = ["transitionrun", "transitionend", "animationstart", "animationend", "pointerup"] as const;
    for (const type of events) document.addEventListener(type, kick, true);
    window.addEventListener("resize", kick);
    kick();
    return {
        kick,
        stop() {
            stopped = true;
            cancelAnimationFrame(frame);
            resize.disconnect();
            mutate.disconnect();
            for (const type of events) document.removeEventListener(type, kick, true);
            window.removeEventListener("resize", kick);
        },
    };
}
