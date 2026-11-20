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
    /** When the oldest figure shown was reported (ms). */
    reportedAt: number;
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
        asOf: p.stale ? `as of ${sameDay(p.reportedAt, now) ? clock(p.reportedAt) : resetLabel(p.reportedAt, now, true)}` : undefined,
        reportedAt: p.reportedAt,
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

/** Home's limit pill, and an account's badge in the model picker (nearLimit). */
export interface NearLimit {
    pct: number;
    /** A limit is reached now (the shared meter's: a window said to be allowed at 100% isn't). */
    reached: boolean;
    window?: string;
    resets?: string;
}

/**
 * Home's limit pill: the plan's fullest window once it's at 80% or more, or a limit is reached ("94%",
 * "5-hour"), and when it resets. Below that Home shows nothing there: a new session has no context to put
 * in a ring. A window that has reset since the report has no figure (meterOf), so it's never the one named.
 */
export function nearLimit(m: Meter | undefined): NearLimit | undefined {
    if (!m) return undefined;
    const live = m.windows.filter((w) => !w.reset);
    const used = (w: MeterWindow) => w.pct ?? (w.reached ? 100 : 0);
    // A reached window is the one to name, whatever another's percentage.
    const rank = (w: MeterWindow) => (w.reached ? 1000 : 0) + used(w);
    const w = live.reduce<MeterWindow | undefined>((a, b) => (!a || rank(b) > rank(a) ? b : a), undefined);
    // Reached with no window reached (a plain rate-limit stop): the plan's limit, not whichever window is fullest.
    if (m.reached && !w?.reached) return { pct: 100, reached: true, ...(m.resets ? { resets: m.resets } : {}) };
    // At its limit is full, whatever share the CLI last gave (a window rejected at 97%): as the rail's card says.
    const pct = w ? (w.reached ? 100 : used(w)) : 0;
    if (pct < 80 && !m.reached) return undefined;
    // "of weekly limit", but "of GPT-5 5-hour limit": only the plain words lose their capital.
    const resets = w?.resets ?? m.resets;
    return { pct: Math.min(100, Math.round(pct)), reached: m.reached, window: w?.label.replace(/^(Weekly|Primary|Secondary)\b/, (x) => x.toLowerCase()), ...(resets ? { resets } : {}) };
}

/** An account's badge in the model picker: "limit" once it's reached, else its share ("94%"); `long` in its list. */
export function limitBadge(n: Pick<NearLimit, "pct" | "reached">, long: boolean): string {
    return n.reached ? (long ? "Limit reached" : "limit") : `${n.pct}%${long ? " used" : ""}`;
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
