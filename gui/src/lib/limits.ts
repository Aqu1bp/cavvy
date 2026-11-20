// What the plan meter and the Usage view say: plain functions of the
// server's data and the time (no DOM, so they're tested from test/).

import type { AccountInfo, PlanLimits, UsageRow, UsageSummary } from "@shared/protocol";
import { planNow, STALE_MS } from "@shared/plan-meter";

export { STALE_MS };

export interface MeterWindow {
    label: string;
    /** 0-100, or undefined when the CLI didn't say or the window has reset since it did. */
    pct?: number;
    /** When it resets: "4:40 PM", "Mon"; with the time and how long when it's reached ("Mon 9:00 AM, in 2d 3h"). */
    resets?: string;
    /** When it reset, once that has passed since the report ("9:52 AM", "Wed"): usage started again then. */
    reset?: string;
    reached: boolean;
}

export interface Meter {
    windows: MeterWindow[];
    /** A limit is reached now (and hasn't reset since). */
    reached: boolean;
    /** Reached, but turns go on past it, billed to credits (Codex) or extra usage (Claude Code). */
    usingCredits: boolean;
    /** When a reached limit resets, as a phrase ("4:40 PM, in 2h 5m"). */
    resets?: string;
    /** "as of 2:02 PM" when the numbers may be out of date. */
    asOf?: string;
    /** The fullest window that hasn't reset since the report, for the compact chip. */
    top?: MeterWindow;
}

function clock(ms: number): string {
    return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function sameDay(a: number, b: number): boolean {
    return new Date(a).toDateString() === new Date(b).toDateString();
}

/** "2h 5m", "3d 4h", "12m". */
export function until(ms: number, now: number): string {
    const mins = Math.max(1, Math.round((ms - now) / 60_000));
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    if (h < 24) return mins % 60 ? `${h}h ${mins % 60}m` : `${h}h`;
    const d = Math.floor(h / 24);
    return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/**
 * A time beside its verb ("resets", "reset", "as of"): today's as a time, another day less than a week either side
 * by weekday, else by date; `exact` adds the time, and how long until it when it's ahead. A weekday names
 * one day only within that span, so a past time never reads as the next one.
 */
export function resetLabel(ms: number, now: number, exact = false): string {
    const d = new Date(ms);
    const day = sameDay(ms, now) ? "" : Math.abs(ms - now) < 6.5 * 86_400_000 ? d.toLocaleDateString(undefined, { weekday: "short" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (!exact) return day || clock(ms);
    return `${day ? `${day} ` : ""}${clock(ms)}${ms > now ? `, in ${until(ms, now)}` : ""}`;
}

export function meterOf(l: PlanLimits | undefined, now: number): Meter | undefined {
    const p = planNow(l, now);
    if (!l || !p) return undefined;
    const windows = p.windows.map((w): MeterWindow => ({
        label: w.label,
        pct: w.pct,
        reached: w.reached,
        ...(w.resetsAt === undefined ? {} : w.reset ? { reset: resetLabel(w.resetsAt, now) } : { resets: resetLabel(w.resetsAt, now, w.reached) }),
    }));
    return {
        windows,
        reached: p.reached,
        usingCredits: p.usingCredits,
        resets: p.liftsAt ? resetLabel(p.liftsAt, now, true) : undefined,
        asOf: p.stale ? `as of ${sameDay(l.at, now) ? clock(l.at) : resetLabel(l.at, now, true)}` : undefined,
        top: p.top ? windows[p.windows.indexOf(p.top)] : undefined,
    };
}

/** "5-hour 62% · resets 4:40 PM", "5-hour · reset 9:52 AM" */
export function windowLine(w: MeterWindow): string {
    if (w.reset) return `${w.label} · reset ${w.reset}`;
    return [w.label, w.pct !== undefined ? `${w.pct}%` : undefined, w.reached ? "reached" : undefined].filter(Boolean).join(" ") + (w.resets ? ` · resets ${w.resets}` : "");
}

/** "5-hour 62%", "5-hour reset 9:52 AM": a window in a short list (a tooltip's); nothing when there's no figure. */
export function windowShort(w: MeterWindow): string | undefined {
    if (w.reset) return `${w.label} reset ${w.reset}`;
    return w.pct !== undefined ? `${w.label} ${w.pct}%` : undefined;
}

/**
 * "40%, resets 4:40 PM": a window's bar caption in Usage (its name is beside it). A reached one isn't called reached
 * again (the plan's banner says so), only when it resets; "Reached" only when it's all there is to say. One that
 * has reset since the report says when: "Reset 9:52 AM".
 */
export function windowCaption(w: Pick<MeterWindow, "pct" | "reached" | "resets" | "reset">): string {
    if (w.reset) return `Reset ${w.reset}`;
    if (w.pct === undefined && w.reached) return w.resets ? `Resets ${w.resets}` : "Reached";
    return (w.pct !== undefined ? `${w.pct}%` : "Not reported") + (w.resets ? `, resets ${w.resets}` : "");
}

/** When a reached plan lifts, for its summary: not when the one window that's reached says it already. */
export function liftsAt(m: Pick<Meter, "resets" | "windows">): string | undefined {
    if (!m.resets) return undefined;
    const reached = m.windows.filter((w) => w.reached);
    return reached.length === 1 && reached[0]!.resets === m.resets ? undefined : m.resets;
}

/** Only a fresh CLI status can offer a usable alternative; no identity enters the transcript. */
export function limitAlternatives(accounts: AccountInfo[], accountId: string): AccountInfo[] {
    return accounts.filter((a) => a.id !== accountId && a.signedIn === true);
}

export function usd(n: number): string {
    if (n === 0) return "$0.00";
    if (n < 0.01) return "<$0.01";
    if (n < 99.995) return `$${n.toFixed(2)}`;
    return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** A row's or the total's cost: "unknown" when none of it had a price, "$X + unknown" when part didn't. Never "$0" for unpriced usage. */
export function costText(r: Pick<UsageRow, "cost" | "unknown">): string {
    if (!r.unknown) return usd(r.cost);
    return r.cost > 0 ? `${usd(r.cost)} + unknown` : "unknown";
}

/** Tokens in: what wasn't read from the cache (cache writes are new input). */
export function tokensIn(r: Pick<UsageRow, "inputTokens" | "cacheWriteTokens">): number {
    return r.inputTokens + r.cacheWriteTokens;
}

/** What the Usage view says when there are no rows: not "no usage" when it didn't get to read everything. */
export function emptyText(s: Pick<UsageSummary, "days" | "truncated">): string {
    return s.truncated ? `Nothing read yet: ${s.truncated}` : `No usage in the last ${rangeLabel(s.days)}.`;
}

export function rangeLabel(days: UsageSummary["days"]): string {
    return days === 1 ? "24 hours" : `${days} days`;
}
