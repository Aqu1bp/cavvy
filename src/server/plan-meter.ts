// Where a plan's limits stand now, from the last report and the time: the one
// place that decides it for every surface (the GUI's rail, Usage, model picker
// and composer; the terminal's /cost). Usage starts again when a window
// resets, so a window whose reset has passed since the report is reset, not
// still at the figure it was reported at. Pure, so both apps and the tests use it.

import { usingCredits, type PlanLimits } from "./protocol";

/** Older than this, a report's figures may be out of date: they're shown with its time. */
export const STALE_MS = 15 * 60_000;

/**
 * Claude Code's windows that count only some models, by the family they cover (LimitWindow.scope): reached, they
 * stop those models, not the plan. Its "Fable limit" counts the models on its overage-included allowlist, Fable's.
 */
export const CLAUDE_SCOPES: Readonly<Record<string, string>> = { seven_day_opus: "opus", seven_day_sonnet: "sonnet", seven_day_overage_included: "fable" };

/** A stop's reset this close to a window's is that window's period (/usage rounds to the minute). */
const SAME_PERIOD_MS = 10 * 60_000;

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
    const partly = windows.filter((w) => w.reached && w.scope);
    // A stop the CLI reported (a turn was refused) stands until its own reset; with none known, until every window
    // has reset. It's a model's limit's (Fable's), not the plan's, when such a window is reached for the same period,
    // or either says no period (Codex's model limit with no window, a turn's stop before its event).
    const stopLive = Boolean(l.reached) && (l.resetsAt !== undefined ? !passed(l.resetsAt) : !(windows.length && windows.every((w) => w.reset)));
    const samePeriod = (w: WindowNow) => l.resetsAt === undefined || w.resetsAt === undefined || Math.abs(w.resetsAt - l.resetsAt) <= SAME_PERIOD_MS;
    const scopedStop = stopLive && partly.some(samePeriod);
    const planStop = stopLive && !scopedStop;
    const reached = windows.some(planWide) || planStop;
    const blocking: (number | undefined)[] = windows.filter(planWide).map((w) => w.resetsAt);
    if (planStop && (l.resetsAt !== undefined || !blocking.length)) blocking.push(l.resetsAt);
    const known = blocking.filter((t): t is number => t !== undefined);
    const liftsAt = reached && !blocking.includes(undefined) && known.length ? Math.max(...known) : undefined;
    // A model's reached limit goes on, on credits, by its own word, else the plan's (Claude Code's extra usage).
    for (const w of partly) if (w.credits === undefined && l.credits !== undefined) w.credits = l.credits;
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
 * Whether a model limit's window (its scope: a model family, a model slug) covers a model: its id has the scope's word,
 * by the model the CLI said it served (`resolved`) where known, else by its id. An alias that names no model
 * ("default") can't be told: undefined, which callers take as "may be covered" rather than ignore a limit that may
 * stop it. Display names ("Default (recommended)") aren't read: they aren't the account's own resolution.
 */
export function covers(scope: string, model: { id: string; resolved?: string } | undefined): boolean | undefined {
    if (!model) return undefined;
    const id = (model.resolved || model.id).toLowerCase();
    if (id.includes(scope)) return true;
    return !model.resolved && /^(default|auto|best)?$/.test(id) ? undefined : false;
}

/**
 * A plan as every surface names it: the CLI and its plan ("Claude Code Max", "Codex Plus"; the CLI alone until it
 * has said which plan), and the account's name too when the CLI has more than one.
 */
export function planTitle(cli: { name: string; accounts?: readonly { id: string; name: string; plan?: string }[] } | undefined, accountId = "default", fallback = ""): { title: string; plan: string; account?: string } {
    const accounts = cli?.accounts ?? [];
    const account = accounts.find((a) => a.id === accountId);
    const plan = account?.plan ? `${cli!.name} ${account.plan.charAt(0).toUpperCase()}${account.plan.slice(1)}` : cli?.name ?? fallback;
    const name = accounts.length > 1 ? account?.name ?? (accountId === "default" ? "Default" : accountId) : undefined;
    return { title: name ? `${plan} · ${name}` : plan, plan, ...(name ? { account: name } : {}) };
}
