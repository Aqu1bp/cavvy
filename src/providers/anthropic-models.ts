// Static knowledge about Anthropic models, used when the Models API doesn't
// tell us (pricing is never in the API; capabilities are, when it's reachable).
// Source: Anthropic model catalog as of 2026-10.

import type { Effort } from "../config/settings";

export interface AnthropicTraits {
    /** Accepts thinking: {type: "adaptive"}. */
    adaptive: boolean;
    effort: Effort[];
    /** Supports thinking.display = "updates" (between-tool progress notes). */
    displayUpdates: boolean;
    /** Server-side refusal fallback ("default" form). */
    fallbacks: boolean;
    /** Supports the dynamic-filtering web search tool version. */
    webSearchVersion: "web_search_20260209" | "web_search_20250305";
    contextWindow: number;
    maxOutput: number;
    pricing: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const ALL: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const NO_XHIGH: Effort[] = ["low", "medium", "high", "max"];

function price(input: number, output: number, cacheRead = input * 0.1): AnthropicTraits["pricing"] {
    return { input, output, cacheRead, cacheWrite: input * 1.25 };
}

const TABLE: [RegExp, AnthropicTraits][] = [
    [/^claude-(fable|mythos)-5-1/, { adaptive: true, effort: ALL, displayUpdates: true, fallbacks: true, webSearchVersion: "web_search_20260209", contextWindow: 1_000_000, maxOutput: 128_000, pricing: price(10, 50, 0.25) }],
    [/^claude-(fable|mythos)-5(?!-)/, { adaptive: true, effort: ALL, displayUpdates: true, fallbacks: false, webSearchVersion: "web_search_20260209", contextWindow: 1_000_000, maxOutput: 128_000, pricing: price(10, 50, 1) }],
    [/^claude-opus-5-5/, { adaptive: true, effort: ALL, displayUpdates: true, fallbacks: true, webSearchVersion: "web_search_20260209", contextWindow: 1_000_000, maxOutput: 128_000, pricing: price(4, 20, 0.2) }],
    [/^claude-opus-5(?!-)/, { adaptive: true, effort: ALL, displayUpdates: false, fallbacks: true, webSearchVersion: "web_search_20260209", contextWindow: 1_000_000, maxOutput: 128_000, pricing: price(5, 25) }],
    [/^claude-opus-4-[78]/, { adaptive: true, effort: ALL, displayUpdates: false, fallbacks: false, webSearchVersion: "web_search_20260209", contextWindow: 1_000_000, maxOutput: 128_000, pricing: price(5, 25) }],
    [/^claude-opus-4-6/, { adaptive: true, effort: NO_XHIGH, displayUpdates: false, fallbacks: false, webSearchVersion: "web_search_20260209", contextWindow: 1_000_000, maxOutput: 128_000, pricing: price(5, 25) }],
    [/^claude-sonnet-5-5/, { adaptive: true, effort: ALL, displayUpdates: true, fallbacks: true, webSearchVersion: "web_search_20260209", contextWindow: 1_000_000, maxOutput: 128_000, pricing: price(2, 10, 0.2) }],
    [/^claude-sonnet-5(?!-)/, { adaptive: true, effort: ALL, displayUpdates: false, fallbacks: false, webSearchVersion: "web_search_20260209", contextWindow: 1_000_000, maxOutput: 128_000, pricing: price(2, 10) }],
    [/^claude-sonnet-4-6/, { adaptive: true, effort: NO_XHIGH, displayUpdates: false, fallbacks: false, webSearchVersion: "web_search_20260209", contextWindow: 1_000_000, maxOutput: 128_000, pricing: price(3, 15) }],
    [/^claude-haiku-5-5/, { adaptive: true, effort: ALL, displayUpdates: false, fallbacks: false, webSearchVersion: "web_search_20250305", contextWindow: 1_000_000, maxOutput: 128_000, pricing: price(0.1, 0.5) }],
    [/^claude-haiku-4-5/, { adaptive: false, effort: [], displayUpdates: false, fallbacks: false, webSearchVersion: "web_search_20250305", contextWindow: 200_000, maxOutput: 64_000, pricing: price(1, 5) }],
    [/^claude-opus-4-5/, { adaptive: false, effort: ["low", "medium", "high"], displayUpdates: false, fallbacks: false, webSearchVersion: "web_search_20250305", contextWindow: 200_000, maxOutput: 64_000, pricing: price(5, 25) }],
    [/^claude-sonnet-4-5/, { adaptive: false, effort: [], displayUpdates: false, fallbacks: false, webSearchVersion: "web_search_20250305", contextWindow: 200_000, maxOutput: 64_000, pricing: price(3, 15) }],
    [/^claude-opus-4/, { adaptive: false, effort: [], displayUpdates: false, fallbacks: false, webSearchVersion: "web_search_20250305", contextWindow: 200_000, maxOutput: 32_000, pricing: price(15, 75) }],
    [/^claude-sonnet-4/, { adaptive: false, effort: [], displayUpdates: false, fallbacks: false, webSearchVersion: "web_search_20250305", contextWindow: 200_000, maxOutput: 64_000, pricing: price(3, 15) }],
];

const UNKNOWN: AnthropicTraits = {
    adaptive: false,
    effort: [],
    displayUpdates: false,
    fallbacks: false,
    webSearchVersion: "web_search_20250305",
    contextWindow: 200_000,
    maxOutput: 32_000,
    pricing: price(3, 15),
};

export function anthropicTraits(id: string): AnthropicTraits {
    return TABLE.find(([re]) => re.test(id))?.[1] ?? UNKNOWN;
}

/** Known current models, offered when the Models API can't be reached. */
export const ANTHROPIC_FALLBACK_MODELS: { id: string; name: string }[] = [
    { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
];
