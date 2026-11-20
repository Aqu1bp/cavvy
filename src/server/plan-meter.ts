// Where a plan's limits stand now, from the last report and the time: the one
// place that decides it for every surface (the GUI's rail, Usage, model picker
// and composer; the terminal's /cost). Usage starts again when a window
// resets, so a window whose reset has passed since the report is reset, not
// still at the figure it was reported at. Pure, so both apps and the tests use it.

import { usingCredits, type PlanLimits } from "./protocol";

/** Older than this, a report's figures may be out of date: they're shown with its time. */
export const STALE_MS = 15 * 60_000;

export interface WindowNow {
    id: string;
    label: string;
    /** 0-100; undefined when the CLI didn't say, or the window has reset since it did. */
    pct?: number;
    /** At its limit now (and not reset since). */
    reached: boolean;
    /** Its reset has passed since the report: usage started again then. */
    reset: boolean;
    /** When it resets (ms), or when it did (`reset`). */
    resetsAt?: number;
}

export interface PlanNow {
    windows: WindowNow[];
    /** A limit is reached now (and hasn't reset since). */
    reached: boolean;
    /** Reached, but turns go on past it, billed to credits. */
    usingCredits: boolean;
    /** When a reached limit lifts (ms), when known. */
    liftsAt?: number;
    /** Reported long enough ago that the figures may be out of date. */
    stale: boolean;
    /** The fullest window that hasn't reset since the report. */
    top?: WindowNow;
}

/** Undefined when there's nothing to show: no windows, and no limit reached. */
export function planNow(l: PlanLimits | undefined, now: number): PlanNow | undefined {
    if (!l || (!l.windows.length && !l.reached)) return undefined;
    const passed = (t?: number) => t !== undefined && t <= now;
    const windows = l.windows.map((w): WindowNow => {
        const reset = passed(w.resetsAt);
        const reached = !reset && Boolean(w.reached || (w.usedPercent ?? 0) >= 100);
        return { id: w.id, label: w.label, pct: reset ? undefined : w.usedPercent, reached, reset, resetsAt: w.resetsAt };
    });
    // Reached with no window to show for it (a plain stop) stands until its own reset, or until every window has reset.
    const reached = windows.some((w) => w.reached) || (Boolean(l.reached) && !passed(l.resetsAt) && !(windows.length && windows.every((w) => w.reset)));
    const blocking: (number | undefined)[] = windows.filter((w) => w.reached).map((w) => w.resetsAt);
    if (l.reached && !passed(l.resetsAt) && (l.resetsAt !== undefined || !blocking.length)) blocking.push(l.resetsAt);
    const known = blocking.filter((t): t is number => t !== undefined);
    const liftsAt = reached && !blocking.includes(undefined) && known.length ? Math.max(...known) : undefined;
    const top = windows.filter((w) => w.pct !== undefined).sort((a, b) => b.pct! - a.pct!)[0];
    return {
        windows,
        reached,
        usingCredits: usingCredits(l, reached, (i) => windows[i]!.reached),
        liftsAt,
        stale: now - l.at > STALE_MS,
        top,
    };
}
