// What Settings → Usage says of a plan's limits and of usage (its lazy view's own: kept out of what the window loads
// first). Plain functions of the server's data, tested from test/.

import type { UsageRow, UsageSummary } from "@shared/protocol";
import type { Meter, MeterWindow } from "./limits";

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
