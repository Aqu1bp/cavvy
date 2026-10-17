// Compile the real Solid dashboard and loader, replacing only rendering/services.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { transformSync } from "../gui/node_modules/@babel/core/lib/index.js";
import solidPreset from "../gui/node_modules/babel-preset-solid/index.js";
import * as solid from "../gui/node_modules/solid-js/dist/solid.js";
import * as usage from "../gui/src/lib/usage";
import * as limits from "../gui/src/lib/limits";
import { tokens } from "../gui/src/lib/format";
import type { UsageSummary, UsageTotals } from "../src/server/protocol";
const zero = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, planEquivalent: 0, unknown: false, costByType: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unallocated: 0 }, cacheSavings: 0 });
function summary(): UsageSummary {
    const total = { ...zero(), inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 10, cost: 2, planEquivalent: 2, costByType: { input: 1, cacheRead: .2, cacheWrite: .3, output: .5, unallocated: 0 }, cacheSavings: 1 };
    return { days: 7, since: 1_800_000_000_000, totals: total, rows: [{ ...total, provider: "claude-code", providerName: "Claude Code", model: "claude-opus-5-5", plan: true, sessions: 1 }],
        sources: [{ ...total, source: "claude-code", label: "Claude Code plan", sessions: 1 }, { ...zero(), source: "codex", label: "Codex plan", sessions: 0 }, { ...zero(), source: "api", label: "API providers", sessions: 0 }],
        series: [{ ...total, at: 1_800_000_000_000, sessions: 1, sources: { "claude-code": total, codex: zero(), api: zero() } }], interval: "day", accounts: [], buckets: [], limits: [], sessions: 1, approxDated: 0 };
}
function mount(call = async (_method: string, _params: any): Promise<UsageSummary> => summary(), limitReports: any = {}) {
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
    const scope = { renderer, ...solid, ...usage, ...limits, tokens, now: () => 1_800_000_000_000,
        app: { limits: limitReports, providers: [] }, refreshLimits: async () => { limitRefreshes++; },
        rpc: { call: (method: string, params: any) => { requests.push({ method, params }); return call(method, params); } },
        RotateCcw: () => null, Spinner: () => null, ProviderIcon: () => null,
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
        get limitRefreshes() { return limitRefreshes; } };
}
const tick = () => Bun.sleep(0);

test("dashboard renders separate estimate labels, totals, cost components and accessible chart/table", async () => {
    const f = mount();
    try {
        expect(f.text()).toContain("Reading local usage transcripts");
        await tick();
        expect(f.text()).toContain("Combined estimates");
        const calls = f.requests.length;
        f.segment("Usage time range").onChange("7");
        expect(f.text()).toContain("Combined estimates");
        expect(f.requests).toHaveLength(calls);
        expect(f.text()).toContain("API-equivalent estimate");
        expect(f.text()).toContain("API spend (list-price estimate)");
        expect(f.text()).toContain("Cached input");
        expect(f.text()).toContain("Cache write");
        expect(f.text()).toContain("Cache savings estimate");
        expect(f.nodes().filter(n => n.tag === "polyline")).toHaveLength(3);
        expect(f.nodes().find(n => n.tag === "svg").props.role).toBe("img");
        expect(f.nodes().some(n => n.props?.["aria-label"] === "Usage breakdown table")).toBe(true);
        expect(f.segment("Usage time range").options.map((o: any) => o.label)).toEqual(["24h", "7d", "30d", "90d"]);
        f.segment("Usage view").onChange("tokens"); await tick();
        expect(f.text()).toContain("Processed tokens across all sources");
        f.segment("Usage breakdown").onChange("time");
        expect(f.text()).toContain("Period (UTC)");
        expect(f.text()).not.toContain("claude-opus-5-5");
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
        expect(f.text()).toContain("Partial usage:");
        expect(f.text()).toContain("file bound");
        expect(f.text()).not.toContain("fixture offline");
    } finally { f.dispose(); }
});

test("empty state differs from partial/unknown usage; limits displays windows and resets", async () => {
    const empty = summary(); empty.rows = []; empty.sessions = 0;
    const f = mount(async () => empty, { codex: { provider: "codex", at: 1_800_000_000_000, windows: [{ id: "five", label: "5-hour", usedPercent: 40, resetsAt: 1_800_000_060_000 }] } });
    try {
        await tick(); expect(f.text()).toContain("No usage in the last 7 days.");
        f.segment("Usage view").onChange("limits"); await tick();
        expect(f.text()).toContain("5-hour 40%"); expect(f.text()).toContain("resets");
        expect(f.limitRefreshes).toBe(1);
        f.button("Refresh limits").onClick(); await tick(); expect(f.limitRefreshes).toBe(2);
        expect(f.nodes().some(n => n.tag === "segmented" && n.props.label === "Usage time range")).toBe(false);
    } finally { f.dispose(); }
    const unknown = summary(); unknown.totals.unknown = true; unknown.totals.cost = 0;
    const g = mount(async () => unknown);
    try { await tick(); expect(g.text()).toContain("unknown"); expect(g.text()).toContain("Unpriced usage is excluded"); }
    finally { g.dispose(); }
});

test("chart geometry and shares remain finite for empty and zero data", () => {
    expect(usage.share(5, 0)).toBe(0);
    expect(usage.share(20, 10)).toBe(100);
    expect(usage.chartPoints(summary().series, "api", "cost", 0)).toBe("50,180");
    expect(usage.chartPoints([], "api", "tokens", 0)).toBe("");
});
