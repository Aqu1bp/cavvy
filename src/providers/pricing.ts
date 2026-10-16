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
    const p = usage.fastMode ? (promptTokens(usage) > 272_000 ? model?.fastPricingLong ?? model?.fastPricing : model?.fastPricing) : model?.pricing;
    if (!p) return { usd: 0, estimated: true, unknown: true };
    const usd =
        (usage.inputTokens * p.input +
            usage.outputTokens * p.output +
            (usage.cacheReadTokens ?? 0) * (p.cacheRead ?? p.input) +
            (usage.cacheWriteTokens ?? 0) * (p.cacheWrite ?? p.input)) /
        1e6;
    return { usd, estimated: true, unknown: false };
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
