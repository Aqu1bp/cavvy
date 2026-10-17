// Local transcript history and the existing per-account plan limit reports.
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { RotateCcw } from "lucide-solid";
import type { UsageDays, UsageSummary } from "@shared/protocol";
import { app, refreshLimits, rpc } from "../state/app";
import { now } from "../lib/clock";
import { tokens } from "../lib/format";
import { costText, emptyText, meterOf, usd, windowLine } from "../lib/limits";
import { chartPoints, periodLabel, processed, share } from "../lib/usage";
import { Segmented, Spinner } from "./ui/bits";
import { ProviderIcon } from "./ui/ProviderIcon";
const RANGES = [1, 7, 30, 90].map(v => ({ value: String(v), label: v === 1 ? "24h" : `${v}d` }));
const VIEWS = [{ value: "cost", label: "Cost" }, { value: "tokens", label: "Tokens" }, { value: "limits", label: "Limits" }];
const [days, setDays] = createSignal<UsageDays>(7);

function PlanLimitsGroup() {
    const plans = () => Object.values(app.limits).map((l) => ({ l, m: meterOf(l, now()) })).filter((x) => x.m);
    const name = (id: string) => app.providers.find((p) => p.id === id);
    return (
        <>
            <div class="sgroup">Plan limits</div>
            <Show when={plans().length} fallback={<p class="set-note">Claude Code and Codex report where your plan stands as they work: their limits show here after a turn on either.</p>}>
                <For each={plans()}>
                    {({ l, m }) => (
                        <div class={`usage-plan ${m!.reached ? "reached" : ""}`}>
                            <ProviderIcon id={l.provider} name={name(l.provider)?.name} size={16} />
                            <div>
                                <div class="usage-plan-name">
                                    {name(l.provider)?.agentCli?.plan ?? name(l.provider)?.name ?? l.provider}
                                    {" · "}{name(l.provider)?.agentCli?.accounts?.find((a) => a.id === (l.accountId ?? "default"))?.name ?? l.accountId ?? "Default"}
                                    <Show when={m!.asOf}>
                                        <span class="plan-asof"> · {m!.asOf}</span>
                                    </Show>
                                </div>
                                <Show when={m!.reached}>
                                    <div class="plan-reached">Limit reached{m!.resets ? `. Resets ${m!.resets}.` : "."}</div>
                                </Show>
                                <For each={m!.windows}>{(w) => <div class="usage-plan-line num">{windowLine(w)}</div>}</For>
                            </div>
                        </div>
                    )}
                </For>
            </Show>
        </>
    );
}


/** Kept separate from loading so the actual dashboard can also be rendered in tests. */
export function UsageDashboard(p: { data: UsageSummary; metric: "cost" | "tokens" }) {
    const [breakdown, setBreakdown] = createSignal("model");
    const value = (r: UsageSummary["totals"]) => p.metric === "tokens" ? processed(r) : r.cost;
    const peak = () => Math.max(0, ...p.data.series.flatMap(b => Object.values(b.sources).map(value)));
    const periods = () => p.data.series.filter(b => b.sessions > 0).slice().reverse();
    const typeParts = () => [
        { key: "input", label: "Input", value: p.data.totals.costByType.input },
        { key: "cacheRead", label: "Cache read", value: p.data.totals.costByType.cacheRead },
        { key: "cacheWrite", label: "Cache write", value: p.data.totals.costByType.cacheWrite },
        { key: "output", label: "Output", value: p.data.totals.costByType.output },
        ...(p.data.totals.costByType.unallocated ? [{ key: "unallocated", label: "Unallocated reported cost", value: p.data.totals.costByType.unallocated }] : []),
    ];
    return <section class="usage-dashboard" aria-label="Usage dashboard">
        <p class="usage-sub">{p.metric === "tokens" ? "Processed tokens across all sources" : "Combined estimates · API-equivalent plan usage + API spend"}</p>
        <div class="usage-headline">{p.metric === "tokens" ? tokens(processed(p.data.totals)) : costText(p.data.totals)}</div>
        <p class="set-note">Plan usage is an API-equivalent estimate, not a bill. API spend is a list-price estimate. CLI transcripts are the only source for Claude Code and Codex, including sessions run through Harness. All processing stays on this machine.</p>
        <div class="usage-sources">
            <For each={p.data.sources}>{s => <div class={`usage-source usage-color-${s.source}`}>
                <span class="usage-swatch" aria-hidden="true" />
                <div><strong>{s.label}</strong><div class="usage-sub">{s.source === "api" ? "API spend (list-price estimate)" : "API-equivalent estimate"}</div></div>
                <div class="usage-source-value"><strong>{p.metric === "tokens" ? tokens(processed(s)) : costText(s)}</strong><div class="usage-sub">{s.sessions} sessions · {share(s.cost, p.data.totals.cost).toFixed(1)}% of known cost · {tokens(processed(s))} tokens</div></div>
            </div>}</For>
        </div>
        <figure class="usage-chart">
            <figcaption>{p.metric === "tokens" ? "Processed tokens" : "Estimated cost (USD)"} by {p.data.interval} · UTC · {p.metric === "cost" ? "known prices only" : "all sources"}</figcaption>
            <svg viewBox="0 0 720 215" role="img" aria-label={`${p.metric === "cost" ? "Estimated cost" : "Tokens"} by source over time. Exact values are available in the breakdown table.`}>
                <line x1="50" y1="25" x2="690" y2="25" class="usage-grid" />
                <line x1="50" y1="180" x2="690" y2="180" class="usage-grid" />
                <text x="48" y="18">{p.metric === "tokens" ? tokens(peak()) : usd(peak())}</text>
                <text x="35" y="184">0</text>
                <For each={p.data.sources}>{(s, i) => <polyline class={`usage-line usage-color-${s.source}`} points={chartPoints(p.data.series, s.source, p.metric, peak())} stroke-dasharray={i() === 1 ? "6 3" : i() === 2 ? "2 3" : undefined}><title>{s.label}: {p.metric === "tokens" ? tokens(processed(s)) : costText(s)}</title></polyline>}</For>
                <text x="50" y="207">{periodLabel(p.data.since, p.data.interval === "hour")}</text>
                <text x="690" y="207" text-anchor="end">{periodLabel(p.data.series.at(-1)?.at ?? p.data.since, p.data.interval === "hour")}</text>
            </svg>
        </figure>
        <h3 class="sgroup">Totals</h3>
        <div class="usage-cards">
            <For each={[
                ["Processed", tokens(processed(p.data.totals))], ["Cached input", tokens(p.data.totals.cacheReadTokens)],
                ["Uncached input", tokens(p.data.totals.inputTokens + p.data.totals.cacheWriteTokens)], ["Output", tokens(p.data.totals.outputTokens)],
                ["Cache savings estimate", costText({ cost: p.data.totals.cacheSavings, unknown: p.data.totals.unknown })],
            ]}>{c => <div class="usage-card"><span>{c[0]}</span><strong>{c[1]}</strong></div>}</For>
        </div>
        <h3 class="sgroup">Cost by type</h3>
        <div class="usage-cost-bar" aria-hidden="true"><For each={typeParts()}>{c => <span class={`usage-type-${c.key}`} style={{ width: `${share(c.value, p.data.totals.cost)}%` }} />}</For></div>
        <ul class="usage-cost-legend"><For each={typeParts()}>{c => <li><i class={`usage-type-${c.key}`} aria-hidden="true" />{c.label} <strong>{usd(c.value)}</strong></li>}</For></ul>
        <Show when={p.data.totals.unknown}><p class="set-note">Unpriced usage is excluded from cost, cost shares, and cost charts. The Tokens view includes it. Known amounts are partial; unknown does not mean free.</p></Show>
        <div class="sgroup usage-bar"><h3>Breakdown</h3><span class="spacer" /><Segmented label="Usage breakdown" size="sm" value={breakdown()} onChange={setBreakdown} options={[{ value: "model", label: "Model" }, { value: "time", label: p.data.interval === "hour" ? "Hour" : "Day" }]} /></div>
        <div class="usage-table-wrap" tabindex="0" role="region" aria-label="Usage breakdown table">
            <table class="usage-table"><caption class="sr-only">{breakdown() === "model" ? "Models" : "UTC periods"}: sessions, processed tokens and combined estimates</caption>
                <thead><tr><th scope="col">{breakdown() === "model" ? "Model / source" : "Period (UTC)"}</th><th scope="col" class="num">Sessions</th><th scope="col" class="num">Tokens</th><th scope="col" class="num">Estimated cost</th><th scope="col">Share</th></tr></thead>
                <tbody><Show when={breakdown() === "model"} fallback={<For each={periods()}>{r => <tr><th scope="row">{periodLabel(r.at, p.data.interval === "hour")}</th><td class="num">{r.sessions}</td><td class="num">{tokens(processed(r))}</td><td class="num">{costText(r)}</td><td><ShareBar value={p.metric === "tokens" ? processed(r) : r.cost} total={value(p.data.totals)} /></td></tr>}</For>}>
                    <For each={p.data.rows}>{r => <tr><th scope="row"><div class="usage-model">{r.model}</div><div class="usage-sub">{r.providerName} · {r.plan ? "API-equivalent estimate" : "API spend (list-price estimate)"}</div></th><td class="num">{r.sessions}</td><td class="num">{tokens(processed(r))}</td><td class="num">{costText(r)}</td><td><ShareBar value={p.metric === "tokens" ? processed(r) : r.cost} total={value(p.data.totals)} /></td></tr>}</For>
                </Show></tbody>
            </table>
        </div>
        <p class="set-note">UTC buckets include partial first and last periods. Cache savings compare cached reads with uncached input at list prices. {p.data.approxDated ? `${p.data.approxDated} older records have approximate timestamps. ` : ""}{p.data.approxPriced ? `${p.data.approxPriced} alias-only records lack a historical model resolution and may be unpriced. ` : ""}</p>
    </section>;
}
function ShareBar(p: { value: number; total: number }) {
    return <div class="usage-share"><span>{share(p.value, p.total).toFixed(1)}%</span><div aria-hidden="true"><i style={{ width: `${share(p.value, p.total)}%` }} /></div></div>;
}
export function UsageView() {
    const [data, setData] = createSignal<UsageSummary>();
    const [view, setView] = createSignal("cost");
    const [loading, setLoading] = createSignal(false);
    const [error, setError] = createSignal("");
    let seq = 0;
    onCleanup(() => { seq++; });
    const load = async () => {
        const mine = ++seq;
        setLoading(true); setError("");
        try {
            if (view() === "limits") await refreshLimits();
            else {
                const r = await rpc.call("usage.summary", { days: days() });
                if (mine === seq) setData(r);
            }
        } catch (e) { if (mine === seq) setError(e instanceof Error ? e.message : String(e)); }
        finally { if (mine === seq) setLoading(false); }
    };
    createEffect(on([days, view], () => void load()));
    return <div class="usage-view" aria-busy={loading()}>
        <div class="sgroup usage-bar">
            <Segmented label="Usage view" size="sm" value={view()} options={VIEWS} onChange={setView} />
            <span class="spacer" />
            <Show when={view() !== "limits"}><Segmented label="Usage time range" size="sm" value={String(days())} options={RANGES} onChange={v => { if (Number(v) !== days()) { setData(undefined); setDays(Number(v) as UsageDays); } }} /></Show>
            <button class="hb sm" title="Refresh" aria-label={view() === "limits" ? "Refresh limits" : "Refresh usage"} disabled={loading()} onClick={() => void load()}><Show when={loading()} fallback={<RotateCcw size={14} />}><Spinner size={14} /></Show></button>
        </div>
        <Show when={error()}><p class="set-note" role="alert">Could not load usage: {error()} <button class="hb sm" onClick={() => void load()}>Retry</button></p></Show>
        <Show when={view() === "limits"} fallback={<>
            <Show when={loading()}><p class="set-note" role="status">Reading local usage transcripts…</p></Show>
            <Show when={data()}>{d => <>
                <Show when={d().truncated}><p class="set-note" role="status">Partial usage: {d().truncated} Try a shorter range or refresh.</p></Show>
                <Show when={d().rows.length} fallback={<p class="set-note">{emptyText(d())}</p>}><UsageDashboard data={d()} metric={view() === "tokens" ? "tokens" : "cost"} /></Show>
            </>}</Show>
        </>}><PlanLimitsGroup /></Show>
    </div>;
}
