// Looping motion (a spinner, the label's light, a pulse) has the window draw a frame at each of its steps for as long as
// it runs: on a Mac, about 100 ms of CPU a second for one small ring. So it runs only when someone can see it, and costs
// nothing otherwise:
// - the window can be seen: not minimized or hidden (macOS keeps drawing a minimized window; the desktop app says when);
// - it's in view: not scrolled out of the conversation, nor in a panel put away;
// - for what's only decoration (the label's light, --decor), Cavvy has the focus;
// - reduced motion is off (the stylesheets).
// Every endless animation's play state is var(--loops) or var(--decor) (test/perf-rules.test.ts): paused here by
// attributes, and started again from its start when it can be seen again, never mid-motion.

import { electron } from "./platform";
import { STEP_MS } from "./stream-clock";

let seen = true;
let focused = true;

const endless = (a: Animation): boolean => a.effect?.getComputedTiming().iterations === Infinity;

/** From their start, on the stream clock's grid: a light coming back crosses from the label's left edge. */
function restart(anims: Animation[]) {
    const now = document.timeline.currentTime;
    if (typeof now !== "number") return;
    const at = Math.ceil(now / STEP_MS) * STEP_MS;
    for (const a of anims) if (endless(a) && a.playState === "running") a.startTime = at;
}

/** Told whether the window can be seen and has the focus, each time either may have changed (the clock, lib/clock.ts). */
const sightWatchers: ((seen: boolean, focused: boolean) => void)[] = [];
const visible = () => seen && document.visibilityState !== "hidden";

/** Calls `fn` now and each time the window's being seen or focused may have changed. */
export function onSight(fn: (seen: boolean, focused: boolean) => void) {
    sightWatchers.push(fn);
    fn(visible(), focused);
}

function apply() {
    const loops = visible();
    for (const fn of sightWatchers) fn(loops, focused);
    const root = document.documentElement;
    const decor = loops && focused;
    const back = (loops && root.hasAttribute("data-loops-off")) || (decor && root.hasAttribute("data-decor-off"));
    root.toggleAttribute("data-loops-off", !loops);
    root.toggleAttribute("data-decor-off", !decor);
    // getAnimations() brings styles up to date first: what was paused is running again when it's started over.
    if (back) restart(document.getAnimations());
}

/** What `sight` watches: one taken out of the page while out of view brings no news, so it's let go at the next start. */
const watched = new Set<Element>();

/** Out of view, one is paused where it is; back in view, it starts over. */
const sight =
    typeof IntersectionObserver === "function"
        ? new IntersectionObserver((entries) => {
              for (const e of entries) {
                  const el = e.target as HTMLElement;
                  if (!el.isConnected) {
                      sight!.unobserve(el);
                      watched.delete(el);
                      continue;
                  }
                  const out = el.hasAttribute("data-loop-out");
                  if (e.isIntersecting && out) {
                      el.removeAttribute("data-loop-out");
                      restart(el.getAnimations());
                  } else if (!e.isIntersecting && !out) el.setAttribute("data-loop-out", "");
              }
          })
        : undefined;

/** Watches each endless animation as it starts, and the window. Once, at startup. */
export function gateLoops() {
    document.addEventListener(
        "animationstart",
        (e) => {
            const el = e.target as Element;
            if (!sight || watched.has(el) || !el.getAnimations(e.pseudoElement ? { subtree: true } : undefined).some((a) => (a as CSSAnimation).animationName === e.animationName && endless(a))) return;
            for (const w of watched) {
                if (w.isConnected) continue;
                sight.unobserve(w);
                watched.delete(w);
            }
            watched.add(el);
            sight.observe(el);
        },
        true,
    );
    document.addEventListener("visibilitychange", apply);
    if (electron?.onWindowState) {
        electron.onWindowState((s) => {
            seen = s.seen;
            focused = s.focused;
            apply();
        });
    } else {
        // In a browser: its tab's focus. (The desktop app's own say is the window's: focus in a browser tab inside it,
        // a frame of the page's own, isn't the window losing it.)
        focused = document.hasFocus();
        addEventListener("focus", () => ((focused = true), apply()));
        addEventListener("blur", () => ((focused = false), apply()));
    }
    apply();
}
