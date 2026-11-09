// What a browser tab nobody is looking at should do next (browser-host.ts acts on it). No Electron here, so it's
// tested on its own (test/electron-tab-rest.test.ts).
//
// A tab unseen and unused for a while is frozen: hidden, so Chromium stops drawing it, then its scripts and timers
// stopped. One playing sound is only hidden: it goes on playing, as a background tab does in Chrome, without drawing
// frames nobody sees (a game with sound otherwise costs as much unseen as on screen). Once it's quiet it's frozen like
// the rest. One still loading is left alone, as is one Chromium refused to freeze.

/** How a tab is resting: drawn and running, hidden but running (playing sound), or frozen. */
export type Rest = "awake" | "hidden" | "frozen";

export interface TabLook {
    rest: Rest;
    closed: boolean;
    /** Chromium refused to freeze it once. */
    unfreezable: boolean;
    /** A pane or the floating view shows it. */
    onScreen: boolean;
    /** Since the agent, the person or a pane last used it. */
    idleMs: number;
    loading: boolean;
    audible: boolean;
    /** Its page process's CPU over the last look, in percent. */
    cpuPercent: number;
}

export type RestStep = "none" | "hide" | "freeze" | "resleep";

/** A tab unseen and unused this long rests. */
export const REST_AFTER_MS = 30_000;
/** A frozen tab's page process using more CPU than this (%) is being drawn again: put back to sleep. */
export const BUSY_ASLEEP_PERCENT = 1;

export function nextRest(t: TabLook, restAfterMs = REST_AFTER_MS): RestStep {
    if (t.closed || t.onScreen) return "none";
    if (t.rest === "frozen") return t.cpuPercent > BUSY_ASLEEP_PERCENT ? "resleep" : "none";
    if (t.idleMs < restAfterMs || t.loading || t.unfreezable) return "none";
    if (t.audible) return t.rest === "hidden" ? "none" : "hide";
    return "freeze";
}
