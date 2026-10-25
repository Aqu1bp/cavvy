// Local transcript history and the existing per-account plan limit reports.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Info, KeyRound, RotateCcw } from "lucide-solid";
import { planLimitKey, type UsageBucket, type UsageDays, type UsageSource, type UsageSummary, type UsageTotals } from "@shared/protocol";
import { app, refreshLimits, rpc } from "../state/app";
import { now } from "../lib/clock";
import { plural, tokens } from "../lib/format";
import { costText, emptyText, meterOf, rangeLabel, usd } from "../lib/limits";
import { axisTicks, byAccount, niceTop, pct, periodLabel, periodName, processed, share, sourceOf, SOURCES, type AccountTotal } from "../lib/usage";
import { Segmented, Spinner } from "./ui/bits";
import { ProviderIcon } from "./ui/ProviderIcon";
const RANGES = [1, 7, 30, 90].map(v => ({ value: String(v), label: v === 1 ? "24h" : `${v}d` }));
const VIEWS = [{ value: "cost", label: "Cost" }, { value: "tokens", label: "Tokens" }, { value: "limits", label: "Limits" }];
const [days, setDays] = createSignal<UsageDays>(7);

/** "40%, resets 4:40 PM": the bar's caption (the window's name is beside it). */
function windowCaption(w: { pct?: number; reached: boolean; resets?: string }): string {
    return [w.pct !== undefined ? `${w.pct}%` : "Not reported", w.reached ? "reached" : undefined].filter(Boolean).join(" ") + (w.resets ? `, resets ${w.resets}` : "");
}

/** Each plan as a heading (its mark, plan and account), then a bar per limit window. */
function PlanLimitsGroup() {
    const plans = () => Object.values(app.limits).map((l) => ({ l, m: meterOf(l, now()) })).filter((x) => x.m);
    const name = (id: string) => app.providers.find((p) => p.id === id);
    return (
        <Show when={plans().length} fallback={<p class="set-note">Claude Code and Codex report where your plan stands as they work: their limits show here after a turn on either.</p>}>
            <For each={plans()}>
                {({ l, m }) => (
                    <>
                        <h3 class="set-h usage-plan-name">
                            <ProviderIcon id={l.provider} name={name(l.provider)?.name} size={13} />
                            {name(l.provider)?.agentCli?.plan ?? name(l.provider)?.name ?? l.provider}
                            {" · "}{name(l.provider)?.agentCli?.accounts?.find((a) => a.id === (l.accountId ?? "default"))?.name ?? l.accountId ?? "Default"}
                            <Show when={m!.asOf}>
                                <span class="plan-asof"> · {m!.asOf}</span>
                            </Show>
                        </h3>
                        <div class={`set-group usage-plan ${m!.reached ? "reached" : ""}`}>
                            <Show when={m!.reached}>
                                <div class="plan-reached">{m!.usingCredits ? "Limit reached · using credits" : "Limit reached"}{m!.resets ? `. Resets ${m!.resets}.` : "."}</div>
                            </Show>
                            <For each={m!.windows}>
                                {(w) => (
                                    <div class={`useb ${w.reached ? "reached" : ""}`}>
                                        <div class="useb-top">
                                            <b>{w.label}</b>
                                            <span class="useb-sub num">{windowCaption(w)}</span>
                                        </div>
                                        <Show when={w.pct !== undefined}>
                                            <div class="useb-bar" role="meter" aria-label={`${w.label} limit used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(100, w.pct!))}>
                                                <i style={{ width: `${Math.max(0, Math.min(100, w.pct!))}%` }} />
                                            </div>
                                        </Show>
                                    </div>
                                )}
                            </For>
                        </div>
                    </>
                )}
            </For>
        </Show>
    );
}


type Metric = "cost" | "tokens";
const SHORT: Record<UsageSource, string> = { "claude-code": "Claude Code", codex: "Codex", api: "API" };
const amount = (r: Pick<UsageTotals, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "cost">, m: Metric) => (m === "tokens" ? processed(r) : r.cost);
/** A cost as a figure: "$X+" when part of it had no price, "—" when none did. Never "$0" for unpriced usage. */
const costFigure = (r: { cost: number; unknown: boolean }) => (r.unknown ? (r.cost > 0 ? `${usd(r.cost)}+` : "—") : usd(r.cost));
const figure = (r: Parameters<typeof amount>[0] & { unknown: boolean }, m: Metric) => (m === "tokens" ? tokens(processed(r)) : costFigure(r));
/** The CLIs report plans in lower case ("max"). */
const planLabel = (plan?: string) => (plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined);

/**
 * Kept separate from loading so the actual dashboard can also be rendered in tests. One total, split the same
 * way three times (bar, names, numbers); what each account gave; a stacked chart per period whose top line
 * reads the period pointed at; what the tokens were; then models or periods. Pointing at a source in the legend,
 * the accounts or the table brings it forward everywhere.
 */
export function UsageDashboard(p: { data: UsageSummary; metric: Metric }) {
    const [breakdown, setBreakdown] = createSignal("model");
    const [hl, setHl] = createSignal<UsageSource>();
    const m = () => p.metric;
    const total = () => amount(p.data.totals, m());
    const sources = () => p.data.sources.filter((s) => processed(s) > 0);
    const unpriced = () => [...new Set(p.data.rows.filter((r) => r.unknown).map((r) => r.model))];
    const accounts = createMemo(() => byAccount(p.data.accounts));
    const accountCount = (s: UsageSource) => accounts().filter((a) => a.source === s).length;
    return <section class="usage-dashboard" aria-label="Usage dashboard" data-hl={hl() ?? ""}>
        <section class="uh" aria-label="Total">
            <div class="uh-num"><span class="v">{m() === "tokens" ? tokens(processed(p.data.totals), 3) : costFigure(p.data.totals)}</span><span class="u">{m() === "tokens" ? "tokens" : "at API prices"}</span></div>
            <p class="uh-sub">
                In the last {rangeLabel(p.data.days)}, across {plural(p.data.sessions, "session")}.
                <Show when={m() === "cost" && unpriced().length}> No price is known for {unpriced().join(", ")}, so {unpriced().length === 1 ? "its" : "their"} usage isn't in the cost.</Show>
            </p>
            <div class="uh-bar" role="img" aria-label={sources().map((s) => `${s.label} ${pct(amount(s, m()), total())}`).join(", ")}>
                <For each={sources()}>{(s) => <i class={`src-${s.source}`} data-src={s.source} style={{ "flex-grow": amount(s, m()) }} />}</For>
            </div>
            <div class="uh-leg" style={{ "--k": sources().length }}>
                <For each={sources()}>{(s) => <div class={`uh-li src-${s.source}`} data-src={s.source} onPointerEnter={() => setHl(s.source)} onPointerLeave={() => setHl(undefined)}>
                    <span class="n"><i class="sw" />{s.label}</span>
                    <span class="v">{figure(s, m())}<span class="p">{pct(amount(s, m()), total())}</span></span>
                    <span class="m">
                        {m() === "tokens" ? `${costFigure(s)} at API prices` : `${tokens(processed(s))} tokens`}, {plural(s.sessions, "session")}
                        <Show when={s.source !== "api" && accountCount(s.source) > 1}>, <a class="u-link" href="#usage-accounts" onClick={(e) => { e.preventDefault(); document.getElementById("usage-accounts")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); }}>{accountCount(s.source)} accounts</a></Show>
                    </span>
                </div>}</For>
            </div>
        </section>
        <Show when={SOURCES.some((s) => s !== "api" && accountCount(s) > 1)}>
            <UsageAccounts accounts={accounts()} metric={m()} total={total()} hl={setHl} />
        </Show>
        <UsageChart data={p.data} metric={m()} />
        <h3 class="set-h">By token type</h3>
        <div class="set-group ut">
            <For each={m() === "tokens"
                ? [["Cache reads", "Earlier context, read back from the cache", p.data.totals.cacheReadTokens], ["Cache writes", "New context, stored in the cache", p.data.totals.cacheWriteTokens], ["Uncached input", "New context sent without caching", p.data.totals.inputTokens], ["Output", "What the models wrote", p.data.totals.outputTokens]] as const
                : [["Cache reads", "Earlier context, read back from the cache", p.data.totals.costByType.cacheRead], ["Cache writes", "New context, stored in the cache", p.data.totals.costByType.cacheWrite], ["Uncached input", "New context sent without caching", p.data.totals.costByType.input], ["Output", "What the models wrote", p.data.totals.costByType.output], ...(p.data.totals.costByType.unallocated ? [["Unallocated", "Cost the provider reported without a split", p.data.totals.costByType.unallocated] as const] : [])] as const}>
                {([label, desc, v]) => <div class="ut-r">
                    <div class="ut-l"><b>{label}</b><span>{desc}</span></div>
                    <div class="ut-bar" aria-hidden="true"><i style={{ width: `${share(v, total())}%` }} /></div>
                    <b class="ut-v num">{m() === "tokens" ? tokens(v) : usd(v)}</b>
                    <span class="ut-p num">{pct(v, total())}</span>
                </div>}
            </For>
            <div class="ut-r ut-save"><div class="ut-l"><b>Saved by caching</b><span>Against sending the cached context uncached, at API prices</span></div><b class="ut-v num">{costFigure({ cost: p.data.totals.cacheSavings, unknown: p.data.totals.unknown })}</b></div>
        </div>
        <div class="set-h usage-bar"><h3>By {breakdown() === "model" ? "model" : p.data.interval === "hour" ? "hour" : "day"}</h3><span class="spacer" /><Segmented label="Usage breakdown" size="sm" value={breakdown()} onChange={setBreakdown} options={[{ value: "model", label: "Model" }, { value: "time", label: p.data.interval === "hour" ? "Hour" : "Day" }]} /></div>
        <UsageTable data={p.data} metric={m()} by={breakdown()} hl={setHl} />
        <p class="set-note u-notes">
            Counted on this computer from Claude Code and Codex transcripts, sessions run in Harness included, and from Harness's own API sessions. Costs use API list prices; plans don't bill per token, so a plan's cost is what the same usage would cost on the API. {p.data.interval === "hour" ? "Hours" : "Days"} are UTC; the first and last are partial.
            <Show when={p.data.totals.unknown}> Unpriced usage is excluded from cost, cost shares, and cost charts. The Tokens view includes it. Known amounts are partial; unknown does not mean free.</Show>
            {p.data.approxDated ? ` ${p.data.approxDated} older records have approximate timestamps.` : ""}{p.data.approxPriced ? ` ${p.data.approxPriced} alias-only records lack a historical model resolution and may be unpriced.` : ""}
        </p>
    </section>;
}

/** What each account gave, under a heading per source; the bars are shares of the whole range, so accounts compare across sources. */
function UsageAccounts(p: { accounts: AccountTotal[]; metric: Metric; total: number; hl: (s?: UsageSource) => void }) {
    const info = (a: AccountTotal) => app.providers.find((x) => x.id === a.provider);
    const account = (a: AccountTotal) => info(a)?.agentCli?.accounts?.find((x) => x.id === a.accountId);
    const name = (a: AccountTotal) => (a.source === "api" ? a.providerName : account(a)?.name ?? (a.accountId === "default" ? "Default" : a.accountId));
    const meta = (a: AccountTotal) => {
        if (a.source === "api") return "API key";
        const weekly = meterOf(app.limits[planLimitKey(a.provider, a.accountId)], now())?.windows.find((w) => /week/i.test(w.label));
        return [planLabel(account(a)?.plan) ?? info(a)?.agentCli?.plan, weekly?.pct !== undefined ? `weekly limit ${weekly.pct}% used` : undefined].filter(Boolean).join(", ");
    };
    const groups = () => SOURCES.map((s) => ({ s, list: p.accounts.filter((a) => a.source === s).sort((x, y) => amount(y, p.metric) - amount(x, p.metric)) })).filter((g) => g.list.length);
    return <>
        <h3 class="set-h" id="usage-accounts">By account</h3>
        <div class="set-group ua">
            <For each={groups()}>{(g) => <>
                <div class={`ua-h src-${g.s}`} data-src={g.s} onPointerEnter={() => p.hl(g.s)} onPointerLeave={() => p.hl(undefined)}>
                    <span class="ua-ic"><Show when={g.s !== "api"} fallback={<KeyRound size={14} />}><ProviderIcon id={g.s} name={SHORT[g.s]} size={14} /></Show></span><b>{SHORT[g.s]}</b>
                    <span>{g.s === "api" ? plural(g.list.length, "key") : plural(g.list.length, "account")}</span>
                </div>
                <For each={g.list}>{(a) => <div class={`ua-r src-${a.source}`} data-src={a.source} onPointerEnter={() => p.hl(a.source)} onPointerLeave={() => p.hl(undefined)}>
                    <div class="ua-l"><b>{name(a)}</b><span>{meta(a)}</span></div>
                    <div class="ua-bar" aria-hidden="true"><i style={{ width: `${share(amount(a, p.metric), p.total)}%` }} /></div>
                    <b class="ua-v num">{figure(a, p.metric)}</b>
                    <span class="ua-2 num">{p.metric === "tokens" ? costFigure(a) : tokens(processed(a))}</span>
                    <span class="ua-p num">{pct(amount(a, p.metric), p.total)}</span>
                </div>}</For>
            </>}</For>
        </div>
    </>;
}

/** Stacked bars per period. The line on top reads the period pointed at (or reached with the arrow keys), else the busiest one. */
function UsageChart(p: { data: UsageSummary; metric: Metric }) {
    const [at, setAt] = createSignal<number>();
    let cols: HTMLDivElement | undefined;
    const series = () => p.data.series;
    const n = () => series().length;
    const hourly = () => p.data.interval === "hour";
    const tot = (b: UsageBucket) => amount(b, p.metric);
    const top = createMemo(() => niceTop(Math.max(0, ...series().map(tot))));
    const busiest = createMemo(() => series().reduce((k, b, i, all) => (tot(b) > tot(all[k]!) ? i : k), 0));
    const shown = () => at() ?? busiest();
    const f = (v: number) => (p.metric === "tokens" ? tokens(v) : usd(v));
    const unit = () => (hourly() ? "hour" : "day");
    const pick = (e: PointerEvent) => {
        const r = cols?.getBoundingClientRect();
        if (r && r.width) setAt(Math.max(0, Math.min(n() - 1, Math.floor(((e.clientX - r.left) / r.width) * n()))));
    };
    const key = (e: KeyboardEvent) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        setAt(e.key === "Home" ? 0 : e.key === "End" ? n() - 1 : Math.max(0, Math.min(n() - 1, shown() + (e.key === "ArrowLeft" ? -1 : 1))));
    };
    const note = (i: number) => (at() === undefined ? `Busiest ${unit()}` : i === n() - 1 ? "So far" : i === 0 ? "Partial" : "");
    return <>
        <h3 class="set-h">{p.metric === "tokens" ? "Tokens" : "Cost"} per {unit()}, UTC</h3>
        <figure class="set-group uc" data-dense={n() > 20 ? "" : undefined}>
            <Show when={series()[shown()]}>{(b) => <div class="uc-read" aria-live="polite">
                <span class="when">{periodName(b().at, hourly())}<Show when={note(shown())}><small>{note(shown())}</small></Show></span>
                <Show when={tot(b())} fallback={<span class="none">No usage</span>}>
                    <span class="tot num">{f(tot(b()))}</span>
                    <For each={SOURCES.filter((s) => amount(b().sources[s], p.metric) > 0)}>{(s) => <span class={`src src-${s}`} data-src={s}><i class="sw" />{SHORT[s]} <b class="num">{f(amount(b().sources[s], p.metric))}</b></span>}</For>
                </Show>
            </div>}</Show>
            <div class="uc-plot" tabindex="0" role="group" aria-label={`${p.metric === "tokens" ? "Tokens" : "Cost"} per ${unit()}. Use the arrow keys to read each ${unit()}; the table below lists them all.`}
                onPointerMove={pick} onPointerLeave={() => document.activeElement !== cols?.parentElement && setAt(undefined)} onKeyDown={key} onBlur={() => setAt(undefined)}>
                <div class="uc-grid" aria-hidden="true"><For each={[0, 0.5, 1]}>{(k) => <i style={{ bottom: `${k * 100}%` }}><span class="num">{k ? f(top() * k) : "0"}</span></i>}</For></div>
                <div class="uc-cols" ref={cols} style={{ "--n": n() }} aria-hidden="true">
                    <For each={series()}>{(b, i) => <div class={`uc-col ${tot(b) ? "" : "zero"} ${at() === i() ? "sel" : ""}`} style={{ padding: `0 ${n() > 60 ? 1 : n() > 20 ? 2 : 0}px` }}>
                        <span class="uc-stack" style={{ height: tot(b) ? `${Math.max(1.5, (tot(b) / top()) * 100)}%` : undefined }}>
                            <For each={SOURCES.filter((s) => amount(b.sources[s], p.metric) > 0)}>{(s) => <i class={`src-${s}`} data-src={s} style={{ "flex-grow": amount(b.sources[s], p.metric) }} />}</For>
                        </span>
                    </div>}</For>
                </div>
            </div>
            <div class="uc-x" aria-hidden="true"><For each={axisTicks(series(), hourly())}>{(t) => <span class="num" style={{ left: `${((t.i + 0.5) / n()) * 100}%` }}>{t.label}</span>}</For></div>
        </figure>
    </>;
}

/** Models (by the shown measure, largest first) or periods (newest first, each with its split by source). */
function UsageTable(p: { data: UsageSummary; metric: Metric; by: string; hl: (s?: UsageSource) => void }) {
    const total = () => amount(p.data.totals, p.metric);
    const hourly = () => p.data.interval === "hour";
    const last = () => p.data.series.length - 1;
    const periods = () => p.data.series.map((b, i) => ({ b, i })).filter((x) => x.b.sessions > 0 || processed(x.b) > 0).reverse();
    const rows = () => p.data.rows.slice().sort((a, b) => amount(b, p.metric) - amount(a, p.metric));
    const sorted = (col: Metric) => (p.metric === col ? "on" : "");
    return <div class="set-group usage-table-wrap" tabindex="0" role="region" aria-label="Usage breakdown table">
        <table class="usage-table"><caption class="sr-only">{p.by === "model" ? "Models" : "UTC periods"}: sessions, processed tokens and combined estimates</caption>
            <thead><tr><th scope="col">{p.by === "model" ? "Model" : `${hourly() ? "Hour" : "Day"} (UTC)`}</th><th scope="col" class="num opt">Sessions</th><th scope="col" class={`num ${sorted("tokens")}`} aria-sort={p.metric === "tokens" ? "descending" : undefined}>Tokens</th><th scope="col" class={`num ${sorted("cost")}`} aria-sort={p.metric === "cost" ? "descending" : undefined}>Cost</th><th scope="col" class="share">Share</th></tr></thead>
            <tbody>
                <Show when={p.by === "model"} fallback={<For each={periods()}>{({ b, i }) => <tr>
                    <th scope="row"><div class="usage-model">{periodName(b.at, hourly())}</div><Show when={i === last() || i === 0}><div class="usage-sub">{i === last() ? "So far" : "Partial"}</div></Show></th>
                    <td class="num opt">{b.sessions}</td><td class="num">{tokens(processed(b))}</td><td class="num">{costText(b)}</td>
                    <td class="share"><div class="usage-share"><span class="usage-track"><For each={SOURCES.filter((s) => amount(b.sources[s], p.metric) > 0)}>{(s) => <i class={`src-${s}`} data-src={s} style={{ width: `${share(amount(b.sources[s], p.metric), total())}%` }} />}</For></span><span class="usage-p num">{pct(amount(b, p.metric), total())}</span></div></td>
                </tr>}</For>}>
                    <For each={rows()}>{(r) => <tr data-src={sourceOf(r.provider)} onPointerEnter={() => p.hl(sourceOf(r.provider))} onPointerLeave={() => p.hl(undefined)}>
                        <th scope="row"><div class={`usage-name src-${sourceOf(r.provider)}`}><i class="sw" /><div><div class="usage-model">{r.model}</div><div class="usage-sub">{r.providerName}, {r.plan ? "plan" : "API key"}</div></div></div></th>
                        <td class="num opt">{r.sessions}</td><td class="num">{tokens(processed(r))}</td><td class={`num ${r.unknown && !r.cost ? "usage-unknown" : ""}`}>{r.unknown && !r.cost ? "No price" : costFigure(r)}</td>
                        <td class="share"><div class="usage-share"><span class="usage-track"><i class={`src-${sourceOf(r.provider)}`} style={{ width: `${share(amount(r, p.metric), total())}%` }} /></span><span class="usage-p num">{pct(amount(r, p.metric), total())}</span></div></td>
                    </tr>}</For>
                </Show>
            </tbody>
        </table>
    </div>;
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
    // Another range keeps the last one on screen, dimmed, until its own arrives: no flash, no jump.
    const stale = () => loading() && data()?.days !== days();
    return <div class="usage-view" aria-busy={loading()}>
        <div class="usage-bar usage-tools">
            <Segmented label="Usage view" size="sm" value={view()} options={VIEWS} onChange={setView} />
            <span class="spacer" />
            <Show when={view() !== "limits"}><Segmented label="Usage time range" size="sm" value={String(days())} options={RANGES} onChange={v => { if (Number(v) !== days()) setDays(Number(v) as UsageDays); }} /></Show>
            <button class="hb sm" title="Refresh" aria-label={view() === "limits" ? "Refresh limits" : "Refresh usage"} disabled={loading()} onClick={() => void load()}><Show when={loading()} fallback={<RotateCcw size={14} />}><Spinner size={14} /></Show></button>
        </div>
        <Show when={error()}><div class="set-group u-state" role="alert"><b>Couldn't read usage</b><p>{error()}</p><button class="btn secondary sm" onClick={() => void load()}>Try again</button></div></Show>
        <Show when={view() === "limits"} fallback={<>
            <Show when={loading() && !data()}><p class="set-note" role="status">Reading local usage transcripts…</p></Show>
            <Show when={!error() && data()}>{d => <div class={`usage-body ${stale() ? "busy" : ""}`}>
                <Show when={d().truncated}><div class="u-partial" role="status"><Info size={14} /><span>Only part of this range is counted: {d().truncated} A shorter range counts everything.</span></div></Show>
                <Show when={d().rows.length} fallback={<div class="set-group u-state"><b>{emptyText(d())}</b><Show when={!d().truncated}><p>Claude Code, Codex and API key sessions show up here after their first reply.</p></Show><Show when={!d().truncated && d().days < 90}><button class="btn secondary sm" onClick={() => setDays(90)}>Show the last 90 days</button></Show></div>}>
                    <UsageDashboard data={d()} metric={view() === "tokens" ? "tokens" : "cost"} />
                </Show>
            </div>}</Show>
        </>}><PlanLimitsGroup /></Show>
    </div>;
}
