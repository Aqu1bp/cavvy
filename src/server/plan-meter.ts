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
    /** The model family it counts ("fable"), when it's one of some models' (LimitWindow.scope): reached, it stops those only. */
    scope?: string;
    /** Reached, but carried on credits (a model limit's own: LimitWindow.credits). */
    credits?: boolean;
}

export interface PlanNow {
    windows: WindowNow[];
    /** A limit of the whole plan is reached now (and hasn't reset since). */
    reached: boolean;
    /** Windows of some models (scope) reached now: those models are stopped, the plan's others aren't. */
    partly: WindowNow[];
    /** Reached, but turns go on past it, billed to credits. */
    usingCredits: boolean;
    /** When a reached limit lifts (ms), when known. */
    liftsAt?: number;
    /** When the oldest figure shown was reported: a window kept from an earlier report has that one's time. */
    reportedAt: number;
    /** Reported long enough ago that the figures may be out of date. */
    stale: boolean;
    /** The fullest window that hasn't reset since the report, of those that aren't a model's reached limit (partly says those). */
    top?: WindowNow;
}

/** Undefined when there's nothing to show: no windows, and no limit reached. */
export function planNow(l: PlanLimits | undefined, now: number): PlanNow | undefined {
    if (!l || (!l.windows.length && !l.reached)) return undefined;
    const passed = (t?: number) => t !== undefined && t <= now;
    const windows = l.windows.map((w): WindowNow => {
        const reset = passed(w.resetsAt);
        // As the CLI said (rejected, or allowed), else a full window is.
        const reached = !reset && (w.reached ?? (w.usedPercent ?? 0) >= 100);
        return { id: w.id, label: w.label, pct: reset ? undefined : w.usedPercent, reached, reset, resetsAt: w.resetsAt, ...(w.scope ? { scope: w.scope } : {}), ...(w.credits === undefined ? {} : { credits: w.credits }) };
    });
    const planWide = (w: WindowNow) => w.reached && !w.scope;
    // Reached with no window to show for it (a plain stop) stands until its own reset; with none known, until every
    // window has reset.
    const planStop = Boolean(l.reached) && (l.resetsAt !== undefined ? !passed(l.resetsAt) : !(windows.length && windows.every((w) => w.reset)));
    const reached = windows.some(planWide) || planStop;
    const blocking: (number | undefined)[] = windows.filter(planWide).map((w) => w.resetsAt);
    if (l.reached && !passed(l.resetsAt) && (l.resetsAt !== undefined || !blocking.length)) blocking.push(l.resetsAt);
    const known = blocking.filter((t): t is number => t !== undefined);
    const liftsAt = reached && !blocking.includes(undefined) && known.length ? Math.max(...known) : undefined;
    const partly = windows.filter((w) => w.reached && w.scope);
    const top = windows.filter((w) => w.pct !== undefined && !partly.includes(w)).sort((a, b) => b.pct! - a.pct!)[0];
    const reportedAt = reportedOf(l, now);
    return {
        windows,
        reached,
        partly,
        usingCredits: usingCredits(l, reached, (i) => planWide(windows[i]!)),
        liftsAt,
        reportedAt,
        stale: now - reportedAt > STALE_MS,
        top,
    };
}

/** When the oldest figure still shown was reported (a window that has reset shows none): the plan's report, or a window kept from an earlier one. */
export function reportedOf(l: PlanLimits, now: number): number {
    return Math.min(l.at, ...l.windows.filter((w) => w.resetsAt === undefined || w.resetsAt > now).map((w) => w.at ?? l.at));
}

/**
 * Whether a model limit's window (its scope, a model family) covers a model: its id or name has the family's word
 * ("claude-fable-1", "Default (claude-opus-5)"). An alias that names no model ("default") can't be told: undefined,
 * which callers take as covered rather than ignore a limit that may stop it.
 */
export function covers(scope: string, model: { id: string; name?: string } | undefined): boolean | undefined {
    if (!model) return undefined;
    const text = `${model.id} ${model.name ?? ""}`.toLowerCase();
    if (text.includes(scope)) return true;
    // An alias with no model behind it said ("default", "auto"): it may be any family.
    return /^(default|auto|best)?$/i.test(model.id) && !/\(([^)]+)\)/.test(model.name ?? "") ? undefined : false;
}

/** What stops a turn on `model` now: a limit of the whole plan, or a reached window of some models that covers it (or may). */
export function stoppedFor(p: PlanNow | undefined, model: { id: string; name?: string } | undefined): { plan: true } | { window: WindowNow } | undefined {
    if (!p) return undefined;
    if (p.reached) return { plan: true };
    const w = p.partly.find((w) => covers(w.scope!, model) !== false);
    return w ? { window: w } : undefined;
}
