// Usage across the user's machines (src/server/usage-machines.ts): this computer's summary with each server's added,
// which accounts are the same one, which servers weren't counted, and what's kept of a server's answer.

import { expect, test } from "bun:test";
import { machineSummary, usageEverywhere } from "../src/server/usage-machines";
import type { UsageSummary, UsageTotals } from "../src/server/protocol";

const t = (cost: number, tokens = cost * 1000): UsageTotals => ({ inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost, planEquivalent: cost, unknown: false, costByType: { input: cost, cacheRead: 0, cacheWrite: 0, output: 0, unallocated: 0 }, cacheSavings: 0 });
const HOUR = 3_600_000;
/** One machine's summary of a day: `cost` on Claude Code's `accountId`, all in the hour at `at`. */
function summary(cost: number, accountId: string, who: Record<string, string> = {}, at = 10 * HOUR): UsageSummary {
    const r = { ...t(cost), provider: "claude-code", providerName: "Claude Code", model: "opus", plan: true, sessions: 2 };
    const none = () => t(0);
    return {
        days: 1, since: 0, interval: "hour", totals: t(cost), rows: [r], sessions: 2, approxDated: 0, limits: [], who,
        sources: [{ ...t(cost), source: "claude-code", label: "Claude Code plan", sessions: 2 }, { ...none(), source: "codex", label: "Codex plan", sessions: 0 }, { ...none(), source: "api", label: "API providers", sessions: 0 }],
        accounts: [{ ...r, source: "claude-code", accountId }],
        buckets: [{ ...r, source: "claude-code", accountId, at }],
        series: [{ ...t(cost), at, sessions: 2, sources: { "claude-code": t(cost), codex: none(), api: none() } }],
    };
}
const server = (answer: unknown) => ({ ask: async () => answer });
const wire = (s: UsageSummary) => JSON.parse(JSON.stringify(s));

test("each connected server's usage is added to this computer's; the same sign-in on two machines is one account", async () => {
    const own = summary(300, "default", { "claude-code:default": "Me@Example.com" });
    const box = summary(500, "default", { "claude-code:default": "me@example.com" });
    const all = await usageEverywhere(own, { names: ["box"], connected: new Map([["box", server(wire(box))]]) });
    expect(all.totals.cost).toBe(800);
    expect(all.totals.inputTokens).toBe(800_000);
    expect(all.sessions).toBe(4);
    expect(all.sources.find((s) => s.source === "claude-code")).toMatchObject({ cost: 800, sessions: 4 });
    expect(all.rows.map((r) => [r.model, r.cost, r.sessions])).toEqual([["opus", 800, 4]]);
    expect(all.series.map((s) => [s.cost, s.sources["claude-code"].cost])).toEqual([[800, 800]]);
    // One account: the server's "default" is the one signed in here.
    expect(all.accounts.map((a) => [a.accountId, a.cost])).toEqual([["default", 800]]);
    expect(all.buckets.map((b) => [b.accountId, b.cost])).toEqual([["default", 800]]);
    expect(all.uncounted).toBeUndefined();
});

test("an account not known to be this computer's is a row of its own, named with its server", async () => {
    // Another sign-in there, and one whose CLI hasn't said who it is: neither is this computer's "default".
    const own = summary(300, "default", { "claude-code:default": "me@example.com" });
    const box = summary(500, "default", { "claude-code:default": "other@example.com" });
    const den = summary(20, "work");
    const all = await usageEverywhere(own, { names: ["box", "den"], connected: new Map([["box", server(wire(box))], ["den", server(wire(den))]]) });
    expect(all.totals.cost).toBe(820);
    expect(all.accounts.map((a) => [a.accountId, a.cost])).toEqual([["default", 300], ["Default on box", 500], ["work on den", 20]]);
});

test("a server that isn't connected, fails, or answers with something else is named as not counted", async () => {
    const own = summary(300, "default");
    const all = await usageEverywhere(own, {
        names: ["off", "broken", "odd", "box"],
        connected: new Map([["broken", { ask: async () => { throw new Error("no"); } }], ["odd", server({ days: 7, interval: "day" })], ["box", server(wire(summary(5, "default")))]]),
    });
    expect(all.uncounted).toEqual(["off", "broken", "odd"]);
    expect(all.totals.cost).toBe(305);
    // No servers: this computer's as it is.
    expect(await usageEverywhere(own, { names: [], connected: new Map() })).toBe(own);
});

test("only numbers and short names are kept of what a server says", () => {
    const said = wire(summary(5, "default"));
    said.totals.cost = "1e9";
    said.totals.inputTokens = -4;
    said.totals.outputTokens = Infinity;
    said.rows[0].model = "m".repeat(5000);
    said.rows[0].extra = { nested: true };
    said.accounts.push({ source: "elsewhere", accountId: "x", cost: 9 });
    said.who = { "claude-code:default": "not an address", "codex:default": "A@B.c" };
    said.limits = [{ provider: "claude-code", windows: [] }];
    said.uncounted = ["mac"];
    const s = machineSummary(said, 1)!;
    expect([s.totals.cost, s.totals.inputTokens, s.totals.outputTokens]).toEqual([0, 0, 0]);
    expect(s.rows[0]!.model.length).toBe(200);
    expect("extra" in s.rows[0]!).toBe(false);
    expect(s.accounts).toHaveLength(1);
    expect(s.who).toEqual({ "codex:default": "a@b.c" });
    expect(s.limits).toEqual([]);
    expect(s.uncounted).toBeUndefined();
    expect(machineSummary(null, 1)).toBeUndefined();
    expect(machineSummary(said, 7)).toBeUndefined();
});
