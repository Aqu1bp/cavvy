import type { UsageAccountRow, UsageBucket, UsageSource, UsageTotals } from "@shared/protocol";
export const processed = (v: Pick<UsageTotals, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">) => v.inputTokens + v.outputTokens + v.cacheReadTokens + v.cacheWriteTokens;
export const share = (value: number, total: number) => total > 0 ? Math.max(0, Math.min(100, value / total * 100)) : 0;
export function periodLabel(at: number, hourly: boolean) {
    return new Date(at).toLocaleString(undefined, { timeZone: "UTC", month: "short", day: "numeric", ...(hourly ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}) });
}
export function chartPoints(series: UsageBucket[], source: UsageSource, metric: "cost" | "tokens", peak: number) {
    return series.map((p, i) => `${50 + i * 640 / Math.max(1, series.length - 1)},${180 - (metric === "tokens" ? processed(p.sources[source]) : p.sources[source].cost) / (peak || 1) * 155}`).join(" ");
}

/** The sources, in the order the bar, the legend and the chart's stacks use. */
export const SOURCES: UsageSource[] = ["claude-code", "codex", "api"];
/** A model row's or account's source: the agent CLIs by their provider, everything else through an API key. */
export const sourceOf = (provider: string): UsageSource => (provider === "claude-code" || provider === "codex" ? provider : "api");

/** A share as text: "<0.1%", "8.6%", "43%". */
export function pct(value: number, total: number): string {
    const p = share(value, total);
    return p === 0 ? "0%" : p < 0.1 ? "<0.1%" : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`;
}

/** The chart's top: the peak rounded up to 1, 2, 2.5 or 5 of its power of ten (the gridlines at 0, half and top). */
export function niceTop(peak: number): number {
    if (!(peak > 0)) return 1;
    const e = 10 ** Math.floor(Math.log10(peak)), f = peak / e;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}

/** "Sat, Oct 25" or "Sat, Oct 25, 14:00" (UTC): the chart's readout and the by-period table. */
export function periodName(at: number, hourly: boolean): string {
    return new Date(at).toLocaleString(undefined, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", ...(hourly ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}) });
}

/**
 * Which periods the chart's axis names: every 6 hours, each day of a week, every 7th day of a month (counted
 * back from today), the first of each month over 90 days.
 */
export function axisTicks(series: Pick<UsageBucket, "at">[], hourly: boolean): { i: number; label: string }[] {
    const n = series.length;
    return series.flatMap((b, i) => {
        const d = new Date(b.at);
        const show = hourly ? d.getUTCHours() % 6 === 0 : n <= 8 ? true : n <= 31 ? (n - 1 - i) % 7 === 0 : d.getUTCDate() === 1;
        if (!show) return [];
        return [{ i, label: hourly ? `${String(d.getUTCHours()).padStart(2, "0")}:00` : periodLabel(b.at, false) }];
    });
}

export interface AccountTotal extends Pick<UsageTotals, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "cost" | "unknown"> {
    source: UsageSource;
    provider: string;
    providerName: string;
    accountId: string;
}

/** Each account's usage: a CLI's by account, API usage by provider (its key). The rows come per model; this adds them up. */
export function byAccount(rows: UsageAccountRow[]): AccountTotal[] {
    const out = new Map<string, AccountTotal>();
    for (const r of rows) {
        const key = r.source === "api" ? `api\0${r.provider}` : `${r.source}\0${r.accountId}`;
        const a = out.get(key) ?? { source: r.source, provider: r.provider, providerName: r.providerName, accountId: r.accountId, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, unknown: false };
        a.inputTokens += r.inputTokens; a.outputTokens += r.outputTokens; a.cacheReadTokens += r.cacheReadTokens; a.cacheWriteTokens += r.cacheWriteTokens;
        a.cost += r.cost; a.unknown ||= r.unknown;
        out.set(key, a);
    }
    return [...out.values()];
}
