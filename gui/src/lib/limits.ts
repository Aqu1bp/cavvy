// What the plan meter and the Usage view say: plain functions of the
// server's data and the time (no DOM, so they're tested from test/).

import { usingCredits, type AccountInfo, type PlanLimits, type UsageRow, type UsageSummary } from "@shared/protocol";

/** Older than this, a report is shown with "as of" its time. */
export const STALE_MS = 15 * 60_000;

export interface MeterWindow {
    label: string;
    /** 0-100, or undefined when the CLI didn't say. */
    pct?: number;
    /** "4:40 PM", "Mon"; with the time and how long when it's reached ("Mon 9:00 AM, in 2d 3h"). */
    resets?: string;
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
    /** The fullest window's percentage, for the compact chip. */
    top?: number;
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

/** A reset time: today's as a time, a later day's by weekday (within a week) or date; `exact` adds the time and how long. */
export function resetLabel(ms: number, now: number, exact = false): string {
    const d = new Date(ms);
    const day = sameDay(ms, now) ? "" : ms - now < 6.5 * 86_400_000 ? d.toLocaleDateString(undefined, { weekday: "short" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (!exact) return day || clock(ms);
    return `${day ? `${day} ` : ""}${clock(ms)}${ms > now ? `, in ${until(ms, now)}` : ""}`;
}

export function meterOf(l: PlanLimits | undefined, now: number): Meter | undefined {
    // Nothing known but that a limit is reached is still worth saying.
    if (!l || (!l.windows.length && !l.reached)) return undefined;
    const passed = (t?: number) => t !== undefined && t <= now;
    const windows = l.windows.map((w) => {
        const reached = Boolean(w.reached || (w.usedPercent ?? 0) >= 100) && !passed(w.resetsAt);
        return { label: w.label, pct: w.usedPercent, reached, resets: w.resetsAt ? resetLabel(w.resetsAt, now, reached) : undefined };
    });
    const reached = windows.some((w) => w.reached) || (Boolean(l.reached) && !passed(l.resetsAt) && !(l.windows.length && l.windows.every((w) => passed(w.resetsAt))));
    const blockingResets = l.windows.filter((_, i) => windows[i]!.reached).map((w) => w.resetsAt);
    if (l.reached && !passed(l.resetsAt) && (l.resetsAt !== undefined || !blockingResets.length)) blockingResets.push(l.resetsAt);
    const knownResets = blockingResets.filter((t): t is number => t !== undefined);
    const resetsAt = !blockingResets.includes(undefined) && knownResets.length ? Math.max(...knownResets) : undefined;
    const stale = now - l.at > STALE_MS || l.windows.some((w) => passed(w.resetsAt));
    const pcts = windows.map((w) => w.pct).filter((p): p is number => p !== undefined);
    return {
        windows,
        reached,
        usingCredits: usingCredits(l, reached, (i) => windows[i]!.reached),
        resets: reached && resetsAt ? resetLabel(resetsAt, now, true) : undefined,
        asOf: stale ? `as of ${sameDay(l.at, now) ? clock(l.at) : resetLabel(l.at, now, true).replace(/, in .*$/, "")}` : undefined,
        top: pcts.length ? Math.max(...pcts) : undefined,
    };
}

/** "5-hour 62% · resets 4:40 PM" */
export function windowLine(w: MeterWindow): string {
    return [w.label, w.pct !== undefined ? `${w.pct}%` : undefined, w.reached ? "reached" : undefined].filter(Boolean).join(" ") + (w.resets ? ` · resets ${w.resets}` : "");
}

/** Only a fresh CLI status can offer a usable alternative; no identity enters the transcript. */
export function limitAlternatives(accounts: AccountInfo[], accountId: string): AccountInfo[] {
    return accounts.filter((a) => a.id !== accountId && a.signedIn === true);
}

export function usd(n: number): string {
    if (n === 0) return "$0.00";
    if (n < 0.01) return "<$0.01";
    if (n < 1000) return `$${n.toFixed(2)}`;
    return `$${Math.round(n).toLocaleString()}`;
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
