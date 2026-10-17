import type { ModelInfo, Usage } from "./types";

export interface CostEstimate {
    usd: number;
    /** False when the provider reported the cost itself. */
    estimated: boolean;
    /** No price known for this model. */
    unknown: boolean;
}

/**
 * Cost of one response. Uses the provider-reported cost when present
 * (OpenRouter); otherwise prices from the model catalog. Unknown cache prices
 * fall back to the input price, so the estimate errs high, never low.
 */
export function costOf(usage: Usage, model: ModelInfo | undefined): CostEstimate {
    if (typeof usage.cost === "number") return { usd: usage.cost, estimated: Boolean(usage.costEstimated), unknown: false };
    const parts = usageCostParts(usage, model);
    if (!parts) return { usd: 0, estimated: true, unknown: true };
    const usd = parts.input + parts.output + parts.cacheRead + parts.cacheWrite;
    return { usd, estimated: true, unknown: false };
}

/** Per-token-type list prices. Thresholds use the whole prompt, before splitting
 * its components, so every part of a long-context request uses the same tier. */
export function usageCostParts(usage: Usage, model: ModelInfo | undefined) {
    let p = usage.fastMode ? (promptTokens(usage) > 272_000 ? model?.fastPricingLong ?? model?.fastPricing : model?.fastPricing) : model?.pricing;
    if (!usage.fastMode && model?.pricingLong && promptTokens(usage) > (model.longContextThreshold ?? 200_000)) p = model.pricingLong;
    // Historical Sonnet 4/4.5 long-context rates. Newer models have flat rates.
    if (!usage.fastMode && p && model?.provider === "anthropic" && /^claude-sonnet-4(?:-5)?(?:-20\d{6})?$/.test(model.id) && promptTokens(usage) > 200_000) {
        p = { input: p.input * 2, output: p.output * 1.5, cacheRead: (p.cacheRead ?? p.input) * 2, cacheWrite: (p.cacheWrite ?? p.input) * 2 };
    }
    if (!p) return undefined;
    const hour = Math.min(usage.cacheWriteTokens ?? 0, usage.cacheWrite1hTokens ?? 0);
    return {
        input: usage.inputTokens * p.input / 1e6,
        output: usage.outputTokens * p.output / 1e6,
        cacheRead: (usage.cacheReadTokens ?? 0) * (p.cacheRead ?? p.input) / 1e6,
        cacheWrite: (((usage.cacheWriteTokens ?? 0) - hour) * (p.cacheWrite ?? p.input) + hour * p.input * 2) / 1e6,
        cacheSavings: (usage.cacheReadTokens ?? 0) * Math.max(0, p.input - (p.cacheRead ?? p.input)) / 1e6,
    };
}

export function addUsage(a: Usage, b: Usage): Usage {
    return {
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
        cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
        reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
    };
}

export function emptyUsage(): Usage {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

/** Tokens in the prompt that produced this response (what counts against the context window). */
export function promptTokens(u: Usage): number {
    return u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
}

export function formatUsd(n: number): string {
    if (n === 0) return "$0.00";
    if (n < 0.01) return `$${n.toFixed(4)}`;
    if (n < 1) return `$${n.toFixed(3)}`;
    return `$${n.toFixed(2)}`;
}

/**
 * A cost where some usage may have had no known price (Vertex, a model not
 * in the catalog): "—" when none of it was priced, "$X+" when part was. Not
 * "$0", which would read as free.
 */
export function formatCost(usd: number, unknown: boolean | undefined): string {
    if (!unknown) return formatUsd(usd);
    return usd > 0 ? `${formatUsd(usd)}+` : "—";
}

export function formatTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
    return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

export function formatPrice(m: ModelInfo): string {
    const p = m.pricing;
    if (!p) return "";
    const f = (x: number) => (x === 0 ? "0" : x < 0.1 ? x.toFixed(3) : x < 10 ? x.toFixed(2).replace(/\.?0+$/, "") : x.toFixed(0));
    if (p.input === 0 && p.output === 0) return "free";
    return `$${f(p.input)}/$${f(p.output)}${m.pricingEstimated ? "~" : ""}`;
}
