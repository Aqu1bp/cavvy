// Local-only history. CLI transcripts are authoritative for CLI providers;
// Harness records supply API providers. No authentication or network requests.
import { costOf, usageCostParts } from "../providers/pricing";
import { resolveModelInfo } from "../providers/models";
import { anthropicPricing } from "../providers/anthropic-models";
import { getProvider } from "../providers/registry";
import type { ModelInfo } from "../providers/types";
import { USAGE_DAYS, type UsageDays, type UsageSummary, type UsageTotals, type UsageRow, type UsageSourceRow, type UsageBucket, type UsageAccountRow, type UsageDetailBucket, type PlanLimits } from "./protocol";
import { RpcError } from "./rpc-error";
import { scanUsage, type Source, type UsageRecord } from "./usage-reader";
export { usageBounds, clearUsageCache } from "./usage-reader";

export function usageDays(v: unknown): UsageDays {
    if (!USAGE_DAYS.includes(v as UsageDays)) throw new RpcError(`days must be one of ${USAGE_DAYS.join(", ")}`, "bad_request");
    return v as UsageDays;
}
function empty(): UsageTotals {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, planEquivalent: 0, unknown: false,
        costByType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unallocated: 0 }, cacheSavings: 0 };
}
function add(a: UsageTotals, b: UsageTotals) {
    for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "cost", "planEquivalent", "cacheSavings"] as const) a[k] += b[k];
    a.unknown ||= b.unknown;
    for (const k of ["input", "cacheRead", "cacheWrite", "output", "unallocated"] as const) a.costByType[k] += b.costByType[k];
}
const labels: Record<Source, string> = { "claude-code": "Claude Code plan", codex: "Codex plan", api: "API providers" };

export async function usageSummary(days: UsageDays, now = Date.now(), limits: PlanLimits[] = []): Promise<UsageSummary> {
    const since = now - days * 86_400_000;
    const interval = days === 1 ? "hour" : "day";
    const width = interval === "hour" ? 3_600_000 : 86_400_000;
    const totals = empty();
    const sources: UsageSourceRow[] = (["claude-code", "codex", "api"] as const).map(source => ({ ...empty(), source, label: labels[source], sessions: 0 }));
    const series: UsageBucket[] = [];
    for (let at = Math.floor(since / width) * width; at <= now; at += width) series.push({ ...empty(), at, sessions: 0, sources: { "claude-code": empty(), codex: empty(), api: empty() } });
    const rows = new Map<string, UsageRow & UsageTotals>();
    const accounts = new Map<string, UsageAccountRow & UsageTotals>();
    const buckets = new Map<string, UsageDetailBucket & UsageTotals>();
    const sessions = new Map<object, Set<string>>();
    const seen = new Set<string>();
    const models = new Map<string, ModelInfo | undefined>();
    let approxDated = 0, approxPriced = 0;
    const scan = await scanUsage(since);
    const modelInfo = (provider: string, id: string): ModelInfo | undefined => {
        const key = `${provider}:${id}`;
        if (!models.has(key)) {
            // Concrete models pin historical records to their own price. An
            // alias without a recorded resolution has no historical evidence;
            // do not silently price it as today's default model.
            if (provider === "claude-code" || provider === "anthropic") {
                const pricing = anthropicPricing(id);
                models.set(key, pricing ? { ...resolveModelInfo(`anthropic:${id}`), provider: "anthropic", id, pricing } : undefined);
            } else models.set(key, resolveModelInfo(`${provider === "codex" ? "openai" : provider}:${id}`));
        }
        return models.get(key);
    };
    const priced = (r: UsageRecord, source: Source, provider: string, id: string): UsageTotals => {
        const v = { ...empty(), inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cacheReadTokens: r.usage.cacheReadTokens ?? 0, cacheWriteTokens: r.usage.cacheWriteTokens ?? 0 };
        const info = modelInfo(provider, id);
        const parts = usageCostParts(r.usage, info);
        const estimate = costOf(r.usage, info);
        v.cost = r.unknown ? r.cost : source === "api" && r.cost > 0 ? r.cost : estimate.usd;
        v.unknown = r.unknown || (estimate.unknown && !r.cost);
        v.planEquivalent = source === "api" ? 0 : v.cost;
        if (parts && !r.unknown) {
            const sum = parts.input + parts.output + parts.cacheRead + parts.cacheWrite;
            const scale = sum > 0 ? v.cost / sum : 0;
            for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) v.costByType[k] = parts[k] * scale;
            v.cacheSavings = parts.cacheSavings;
            if (!sum) v.costByType.unallocated = v.cost;
        } else v.costByType.unallocated = v.cost;
        return v;
    };
    const countSession = (obj: object, session: string) => { let set = sessions.get(obj); if (!set) sessions.set(obj, set = new Set()); set.add(session); };
    let aggregated = 0;
    const aggregationStart = Date.now();
    outer: for (const f of scan.files) {
        const source = sources.find(s => s.source === f.source)!;
        for (const r of f.records) {
            if (aggregated && aggregated % 2000 === 0) await new Promise<void>(resolve => setImmediate(resolve));
            if (aggregated++ % 1000 === 0 && Date.now() - aggregationStart > 4000) { scan.truncated ??= "Aggregating the sessions took too long; some usage is left out."; break outer; }
            if (r.at < since || r.at > now) continue;
            const session = JSON.stringify([f.source, f.account, r.session]);
            if (r.dedupe) {
                const key = JSON.stringify([f.source, f.account, f.source === "codex" ? r.session : "", r.dedupe]);
                if (seen.has(key)) continue;
                seen.add(key);
            }
            const colon = r.model.indexOf(":");
            const provider = colon > 0 ? r.model.slice(0, colon) : "unknown";
            const id = colon > 0 ? r.model.slice(colon + 1) : r.model;
            const val = priced(r, f.source, provider, id);
            const makeRow = () => ({ ...empty(), provider, providerName: getProvider(provider)?.name ?? provider, model: id, plan: f.source !== "api", sessions: 0 });
            let row = rows.get(r.model);
            if (!row) rows.set(r.model, row = makeRow());
            const accountKey = JSON.stringify([f.source, f.account, r.model]);
            let account = accounts.get(accountKey);
            if (!account) accounts.set(accountKey, account = { ...makeRow(), source: f.source, accountId: f.account });
            const at = Math.floor(r.at / width) * width;
            const bucketKey = JSON.stringify([at, accountKey]);
            let detail = buckets.get(bucketKey);
            if (!detail) buckets.set(bucketKey, detail = { ...makeRow(), source: f.source, accountId: f.account, at });
            const period = series[Math.round((at - series[0]!.at) / width)]!;
            for (const obj of [totals, row, account, detail, source, period, period.sources[f.source]]) { add(obj, val); countSession(obj, session); }
            if (r.approx) approxDated++;
            if (f.source !== "api" && (id === "default" || ["opus", "sonnet", "haiku"].includes(id))) approxPriced++;
        }
    }
    for (const group of [rows.values(), accounts.values(), buckets.values(), sources.values(), series.values()]) for (const r of group) r.sessions = sessions.get(r)?.size ?? 0;
    return { days, since, totals, rows: [...rows.values()].sort((a, b) => b.cost - a.cost), sources, accounts: [...accounts.values()], buckets: [...buckets.values()], series, interval, limits,
        sessions: sessions.get(totals)?.size ?? 0, approxDated, approxPriced, ...(scan.truncated ? { truncated: scan.truncated } : {}) };
}
