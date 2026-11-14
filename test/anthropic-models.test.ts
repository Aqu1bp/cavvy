import { expect, test } from "bun:test";
import { anthropicPricing, anthropicTraits, claudeCodeWindow } from "../src/providers/anthropic-models";

test("a newer model of a known family takes its family's latest size and price, as an estimate", () => {
    expect(anthropicPricing("claude-fable-5-2")).toEqual({ pricing: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }, estimated: false });
    expect(anthropicPricing("claude-fable-5-3")).toEqual({ pricing: anthropicPricing("claude-fable-5-2")!.pricing, estimated: true });
    expect(anthropicPricing("claude-opus-6")).toEqual({ pricing: anthropicPricing("claude-opus-5-5")!.pricing, estimated: true });
    expect(anthropicPricing("claude-newfamily-1")).toBeUndefined();
    // Size and price carry over; what a request may ask of the model doesn't.
    const t = anthropicTraits("claude-fable-5-3");
    expect(t).toMatchObject({ contextWindow: 1_000_000, maxOutput: 128_000, adaptive: false, fallbacks: false });
    expect(anthropicTraits("claude-newfamily-1").contextWindow).toBe(200_000);
});

test("Claude Code's window comes from its model id: [1m], then the table, else unknown", () => {
    expect(claudeCodeWindow("claude-fable-5-2[1m]")).toBe(1_000_000);
    expect(claudeCodeWindow("claude-haiku-4-5[1m]")).toBe(1_000_000);
    expect(claudeCodeWindow("claude-haiku-4-5")).toBe(200_000);
    expect(claudeCodeWindow("claude-sonnet-6")).toBe(1_000_000);
    expect(claudeCodeWindow("opus")).toBeUndefined();
    expect(claudeCodeWindow("claude-newfamily-1")).toBeUndefined();
    expect(claudeCodeWindow(undefined)).toBeUndefined();
});
