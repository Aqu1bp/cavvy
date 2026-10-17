import type { UsageBucket, UsageSource, UsageTotals } from "@shared/protocol";
export const processed = (v: Pick<UsageTotals, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">) => v.inputTokens + v.outputTokens + v.cacheReadTokens + v.cacheWriteTokens;
export const share = (value: number, total: number) => total > 0 ? Math.max(0, Math.min(100, value / total * 100)) : 0;
export function periodLabel(at: number, hourly: boolean) {
    return new Date(at).toLocaleString(undefined, { timeZone: "UTC", month: "short", day: "numeric", ...(hourly ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}) });
}
export function chartPoints(series: UsageBucket[], source: UsageSource, metric: "cost" | "tokens", peak: number) {
    return series.map((p, i) => `${50 + i * 640 / Math.max(1, series.length - 1)},${180 - (metric === "tokens" ? processed(p.sources[source]) : p.sources[source].cost) / (peak || 1) * 155}`).join(" ");
}
