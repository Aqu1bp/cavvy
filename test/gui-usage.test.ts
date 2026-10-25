// Compile the real Solid dashboard and loader, replacing only rendering/services.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { transformSync } from "../gui/node_modules/@babel/core/lib/index.js";
import solidPreset from "../gui/node_modules/babel-preset-solid/index.js";
import * as solid from "../gui/node_modules/solid-js/dist/solid.js";
import * as usage from "../gui/src/lib/usage";
import * as limits from "../gui/src/lib/limits";
import { plural, tokens } from "../gui/src/lib/format";
import { planLimitKey } from "../src/server/protocol";
import type { UsageSummary, UsageTotals } from "../src/server/protocol";
const zero = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, planEquivalent: 0, unknown: false, costByType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unallocated: 0 }, cacheSavings: 0 });
function summary(): UsageSummary {
    const total = { ...zero(), inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 10, cost: 2, planEquivalent: 2, costByType: { input: 1, cacheRead: .2, cacheWrite: .3, output: .5, unallocated: 0 }, cacheSavings: 1 };
    return { days: 7, since: 1_800_000_000_000, totals: total, rows: [{ ...total, provider: "claude-code", providerName: "Claude Code", model: "claude-opus-5-5", plan: true, sessions: 1 }],
        sources: [{ ...total, source: "claude-code", label: "Claude Code plan", sessions: 1 }, { ...zero(), source: "codex", label: "Codex plan", sessions: 0 }, { ...zero(), source: "api", label: "API providers", sessions: 0 }],
        series: [{ ...total, at: 1_800_000_000_000, sessions: 1, sources: { "claude-code": total, codex: zero(), api: zero() } }], interval: "day", accounts: [], buckets: [], limits: [], sessions: 1, approxDated: 0 };
}
function mount(call = async (_method: string, _params: any): Promise<UsageSummary> => summary(), limitReports: any = {}, providers: any[] = []) {
    const requests: any[] = []; let limitRefreshes = 0;
    const renderer = {
        ...solid, effect: solid.createRenderEffect, memo: solid.createMemo,
        createElement: (tag: string) => ({ tag, props: {} as any, children: [] as any[] }),
        createTextNode: (text: string) => text,
        insertNode: (parent: any, child: any) => parent.children.push(child),
        setProp: (node: any, key: string, value: any) => { node.props[key] = value; },
        insert: (parent: any, value: any) => { const slot = { current: undefined as any }; parent.children.push(slot); solid.createRenderEffect(() => { slot.current = resolve(value); }); },
    };
    function resolve(v: any): any { return typeof v === "function" ? resolve(v()) : v; }
    const source = readFileSync(new URL("../gui/src/components/UsageView.tsx", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
    const compiled = transformSync(source, { filename: "UsageView.tsx", parserOpts: { plugins: ["typescript", "jsx"] }, presets: [[solidPreset, { generate: "universal", moduleName: "test-renderer" }]], configFile: false, babelrc: false })!.code!;
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(compiled).replace(/import \{ ([\w$]+) as ([\w$]+) \} from "test-renderer";/g, "const $2 = renderer.$1;");
    const scope = { renderer, ...solid, ...usage, ...limits, tokens, plural, planLimitKey, now: () => 1_800_000_000_000,
        app: { limits: limitReports, providers }, refreshLimits: async () => { limitRefreshes++; },
        rpc: { call: (method: string, params: any) => { requests.push({ method, params }); return call(method, params); } },
        RotateCcw: () => null, Info: () => null, KeyRound: () => null, Spinner: () => null, ProviderIcon: () => null,
        Segmented: (p: any) => ({ tag: "segmented", props: p, children: [] }),
    };
    const component = new Function(...Object.keys(scope), `${js}; return UsageView;`)(...Object.values(scope));
    let root: any, dispose!: () => void;
    solid.createRoot((d: () => void) => { dispose = d; root = component(); });
    const walk = (v: any): any[] => {
        v = resolve(v);
        if (Array.isArray(v)) return v.flatMap(walk);
        if (v === undefined || v === null || v === false) return [];
        if (typeof v !== "object") return [v];
        if ("current" in v) return walk(v.current);
        return [v, ...walk(v.children)];
    };
    const nodes = () => walk(root);
    return { dispose, requests, nodes, text: () => nodes().filter(n => typeof n !== "object").join(" "),
        segment: (label: string) => nodes().find(n => n.tag === "segmented" && n.props.label === label).props,
        button: (label: string) => nodes().find(n => n.tag === "button" && n.props["aria-label"] === label).props,
        buttonText: (text: string) => nodes().find(n => n.tag === "button" && walk(n.children).join("") === text).props,
        cls: (c: string) => nodes().filter(n => typeof n === "object" && String(n.props?.class ?? "").split(/\s+/).includes(c)),
        get limitRefreshes() { return limitRefreshes; } };
}
const tick = () => Bun.sleep(0);

test("dashboard: the total, its split by source, a stacked chart, token types and an accessible table", async () => {
    const f = mount();
    try {
        expect(f.text()).toContain("Reading local usage transcripts");
        await tick();
        expect(f.text()).toContain("at API prices");
        for (const part of ["In the last", "7 days", "across", "1 session"]) expect(f.text()).toContain(part);
        const calls = f.requests.length;
        f.segment("Usage time range").onChange("7");
        expect(f.requests).toHaveLength(calls);
        expect(f.text()).toContain("Claude Code plan");
        // Sources with nothing in the range stay out of the bar and the legend.
        expect(f.text()).not.toContain("Codex plan");
        expect(f.text()).toContain("By token type");
        expect(f.text()).toContain("Cache writes");
        expect(f.text()).toContain("Saved by caching");
        expect(f.cls("uc-col")).toHaveLength(1);
        expect(f.nodes().find(n => n.props?.class === "uc-plot").props.role).toBe("group");
        expect(f.text()).toContain("Busiest day");
        expect(f.nodes().some(n => n.props?.["aria-label"] === "Usage breakdown table")).toBe(true);
        expect(f.segment("Usage time range").options.map((o: any) => o.label)).toEqual(["24h", "7d", "30d", "90d"]);
        // One account per source: no account section.
        expect(f.text()).not.toContain("By account");
        f.segment("Usage view").onChange("tokens"); await tick();
        expect(f.text()).toContain("430 tokens");
        f.segment("Usage breakdown").onChange("time");
        expect(f.text()).toContain("Day (UTC)");
        expect(f.text()).not.toContain("claude-opus-5-5");
    } finally { f.dispose(); }
});

test("by account: shown once a subscription has two, named from the provider, with the plan and weekly limit", async () => {
    const two = summary();
    const row = (accountId: string, cost: number) => ({ ...two.rows[0]!, source: "claude-code" as const, accountId, cost });
    two.accounts = [row("default", 1.5), row("second", 0.5)];
    const providers = [{ id: "claude-code", name: "Claude Code", agentCli: { plan: "Claude subscription", accounts: [{ id: "default", name: "Work", plan: "max" }, { id: "second", name: "Personal" }] } }];
    const limitReports = { [planLimitKey("claude-code", "default")]: { provider: "claude-code", accountId: "default", at: 1_800_000_000_000, windows: [{ id: "week", label: "Weekly", usedPercent: 31 }] } };
    const f = mount(async () => two, limitReports, providers);
    try {
        await tick();
        expect(f.text()).toContain("By account");
        expect(f.text()).toContain("2 accounts");
        expect(f.text()).toContain("Work");
        expect(f.text()).toContain("Max, weekly limit 31% used");
        expect(f.text()).toContain("Personal");
        expect(f.text()).toContain("Claude subscription");
    } finally { f.dispose(); }
});

test("range and refresh requests, loading guard, stale replies and inline retry", async () => {
    const gates: ReturnType<typeof Promise.withResolvers<UsageSummary>>[] = [];
    const f = mount(() => { const gate = Promise.withResolvers<UsageSummary>(); gates.push(gate); return gate.promise; });
    try {
        expect(f.button("Refresh usage").disabled).toBe(true);
        f.segment("Usage time range").onChange("90");
        expect(f.requests.at(-1).params.days).toBe(90);
        gates[0]!.resolve({ ...summary(), truncated: "stale response" }); await tick();
        expect(f.text()).not.toContain("stale response");
        gates[1]!.reject(new Error("fixture offline")); await tick();
        expect(f.nodes().some(n => n.props?.role === "alert")).toBe(true);
        expect(f.text()).toContain("fixture offline");
        f.button("Refresh usage").onClick();
        gates[2]!.resolve({ ...summary(), truncated: "file bound" }); await tick();
        expect(f.text()).toContain("Only part of this range is counted:");
        expect(f.text()).toContain("file bound");
        expect(f.text()).not.toContain("fixture offline");
    } finally { f.dispose(); }
});

test("empty state differs from partial/unknown usage; limits displays windows and resets", async () => {
    const empty = summary(); empty.rows = []; empty.sessions = 0;
    const f = mount(async () => empty, { codex: { provider: "codex", at: 1_800_000_000_000, windows: [{ id: "five", label: "5-hour", usedPercent: 40, resetsAt: 1_800_000_060_000 }] } });
    try {
        await tick(); expect(f.text()).toContain("No usage in the last 7 days.");
        f.buttonText("Show the last 90 days").onClick(); await tick();
        expect(f.requests.at(-1).params.days).toBe(90);
        f.segment("Usage time range").onChange("7"); await tick();
        f.segment("Usage view").onChange("limits"); await tick();
        expect(f.text()).toContain("5-hour 40%"); expect(f.text()).toContain("resets");
        expect(f.limitRefreshes).toBe(1);
        f.button("Refresh limits").onClick(); await tick(); expect(f.limitRefreshes).toBe(2);
        expect(f.nodes().some(n => n.tag === "segmented" && n.props.label === "Usage time range")).toBe(false);
    } finally { f.dispose(); }
    const unknown = summary(); unknown.totals.unknown = true; unknown.totals.cost = 0; unknown.rows[0]!.unknown = true; unknown.rows[0]!.cost = 0;
    const g = mount(async () => unknown);
    try {
        await tick(); expect(g.text()).toContain("—");
        expect(g.text()).toContain("No price is known for");
        expect(g.text()).toContain("No price");
        expect(g.text()).toContain("Unpriced usage is excluded from cost, cost shares, and cost charts. The Tokens view includes it.");
        g.segment("Usage view").onChange("tokens"); await tick();
        expect(g.text()).toContain("The Tokens view includes it.");
        expect(g.text()).toContain("430 tokens");
    }
    finally { g.dispose(); }
});

test("chart geometry and shares remain finite for empty and zero data", () => {
    expect(usage.share(5, 0)).toBe(0);
    expect(usage.share(20, 10)).toBe(100);
    expect(usage.chartPoints(summary().series, "api", "cost", 0)).toBe("50,180");
    expect(usage.chartPoints([], "api", "tokens", 0)).toBe("");
    expect(usage.niceTop(0)).toBe(1);
    expect(usage.niceTop(471e6)).toBe(500e6);
    expect(usage.niceTop(1.2e9)).toBe(2e9);
    expect(usage.pct(0, 0)).toBe("0%");
    expect(usage.pct(1, 2000)).toBe("<0.1%");
    expect(usage.pct(86, 1000)).toBe("8.6%");
    expect(usage.pct(426, 1000)).toBe("43%");
});

test("token counts roll over to the next unit; costs group thousands", () => {
    expect([999, 1000, 9_949, 9_960, 12_400, 999_499, 999_600, 9_960_000, 854e6, 999.6e6, 1e9, 1.24e9, 12.4e9].map((n) => tokens(n)))
        .toEqual(["999", "1.0k", "9.9k", "10k", "12k", "999k", "1.0M", "10M", "854M", "1.0B", "1.0B", "1.2B", "12B"]);
    expect([854e6, 1.236e9, 999_960].map((n) => tokens(n, 3))).toEqual(["854M", "1.24B", "1M"]);
    expect([0, 0.004, 4.123, 41.2, 99.996, 763.4, 2184.2].map(limits.usd)).toEqual(["$0.00", "<$0.01", "$4.12", "$41.20", "$100", "$763", "$2,184"]);
});

test("axis ticks: every 6 hours, each day of a week, weekly over a month, month starts over 90 days", () => {
    const day = 86_400_000, end = Date.UTC(2026, 9, 25);
    const days = (n: number) => Array.from({ length: n }, (_, i) => ({ at: end - (n - 1 - i) * day }));
    expect(usage.axisTicks(Array.from({ length: 24 }, (_, i) => ({ at: Date.UTC(2026, 9, 24, 16) + i * 3_600_000 })), true).map((t) => t.label)).toEqual(["18:00", "00:00", "06:00", "12:00"]);
    expect(usage.axisTicks(days(8), false)).toHaveLength(8);
    expect(usage.axisTicks(days(31), false).map((t) => t.i)).toEqual([2, 9, 16, 23, 30]);
    expect(usage.axisTicks(days(91), false).map((t) => t.label)).toEqual([usage.periodLabel(Date.UTC(2026, 7, 1), false), usage.periodLabel(Date.UTC(2026, 8, 1), false), usage.periodLabel(Date.UTC(2026, 9, 1), false)]);
});

test("by account adds up a CLI's models per account and API usage per provider", () => {
    const base = { providerName: "", model: "m", plan: true, sessions: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, cost: 1, planEquivalent: 1, unknown: false };
    const out = usage.byAccount([
        { ...base, source: "claude-code", provider: "claude-code", accountId: "a" },
        { ...base, source: "claude-code", provider: "claude-code", accountId: "a", model: "n", unknown: true },
        { ...base, source: "claude-code", provider: "claude-code", accountId: "b" },
        { ...base, source: "api", provider: "openrouter", providerName: "OpenRouter", accountId: "default", plan: false },
        { ...base, source: "api", provider: "openrouter", providerName: "OpenRouter", accountId: "default", plan: false, model: "n" },
    ]);
    expect(out.map((a) => [a.source, a.accountId, a.provider, a.cost, a.inputTokens, a.unknown])).toEqual([
        ["claude-code", "a", "claude-code", 2, 2, true], ["claude-code", "b", "claude-code", 1, 1, false], ["api", "default", "openrouter", 2, 2, false],
    ]);
});
