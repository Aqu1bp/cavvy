// First-party API capabilities, checked against official fast-mode/pricing docs
// (2026-10-16). CLI capabilities come from their live catalogs instead.
import type { ModelInfo } from "./types";

type Price = NonNullable<ModelInfo["pricing"]>;
const OPENAI_FAST: Record<string, Price> = {
    "gpt-6-astra": { input: 20, output: 100, cacheRead: 2, cacheWrite: 25 },
    "gpt-6.1-sol": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    "gpt-6-sol": { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
    "gpt-6-luna": { input: 0.2, output: 1, cacheRead: 0.02, cacheWrite: 0.25 },
    "gpt-5.6-sol": { input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 },
    "gpt-5.6-terra": { input: 4, output: 24, cacheRead: 0.4, cacheWrite: 5 },
    "gpt-5.6-luna": { input: 0.4, output: 2.4, cacheRead: 0.04, cacheWrite: 0.5 },
    "gpt-5.5": { input: 12.5, output: 75, cacheRead: 1.25 },
    "gpt-5.4": { input: 5, output: 30, cacheRead: 0.5 },
    "gpt-5.4-mini": { input: 1.5, output: 9, cacheRead: 0.15 },
    "gpt-5.2": { input: 3.5, output: 28, cacheRead: 0.35 },
    "gpt-5.1": { input: 2.5, output: 20, cacheRead: 0.25 },
    "gpt-5": { input: 2.5, output: 20, cacheRead: 0.25 },
    "gpt-5-mini": { input: 0.45, output: 3.6, cacheRead: 0.045 },
    "gpt-4.1": { input: 3.5, output: 14, cacheRead: 0.875 },
    "gpt-4.1-mini": { input: 0.7, output: 2.8, cacheRead: 0.175 },
    "gpt-4.1-nano": { input: 0.2, output: 0.8, cacheRead: 0.05 },
    "gpt-4o": { input: 4.25, output: 17, cacheRead: 2.125 },
    "gpt-4o-2024-05-13": { input: 8.75, output: 26.25 },
    "gpt-4o-mini": { input: 0.25, output: 1, cacheRead: 0.125 },
    "o3": { input: 3.5, output: 14, cacheRead: 0.875 },
    "o4-mini": { input: 2, output: 8, cacheRead: 0.5 },
};

export function apiFastModeInfo(provider: string, id: string, baseUrl: string): Pick<ModelInfo, "supportsFastMode" | "fastPricing" | "fastPricingLong"> {
    let host: string;
    try { host = new URL(baseUrl).hostname; } catch { return {}; }
    let fastPricing: Price | undefined;
    let fastPricingLong: Price | undefined;
    if (provider === "openai" && host === "api.openai.com") {
        const alias = id.replace(/-\d{4}-\d{2}-\d{2}$/, "");
        fastPricing = OPENAI_FAST[id] ?? OPENAI_FAST[alias];
        if (fastPricing && /^(gpt-6|gpt-5\.6)/.test(alias)) {
            fastPricingLong = { input: fastPricing.input * 2, output: fastPricing.output * 1.5, cacheRead: fastPricing.cacheRead! * 2, cacheWrite: fastPricing.cacheWrite! * 2 };
        }
    } else if (provider === "anthropic" && host === "api.anthropic.com") {
        const alias = id.replace(/-\d{8}$/, "");
        if (["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"].includes(alias)) {
            const input = alias === "claude-opus-5-5" ? 8 : 10;
            fastPricing = { input, output: input * 5, cacheRead: input * (alias === "claude-opus-5-5" ? 0.05 : 0.1), cacheWrite: input * 1.25 };
        }
    }
    return fastPricing ? { supportsFastMode: true, fastPricing, ...(fastPricingLong ? { fastPricingLong } : {}) } : {};
}
