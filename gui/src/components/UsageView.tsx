// Local transcript history and the existing per-account plan limit reports.
import { machine as windowMachine } from "../lib/platform";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Info, KeyRound, RotateCw } from "lucide-solid";
import { planLimitKey, type UsageBucket, type UsageDays, type UsageSource, type UsageSummary, type UsageTotals } from "@shared/protocol";
import { app, checkLimits, noModel, refreshLimits, rpc } from "../state/app";
import { setSettingsTab } from "../state/ui";
import { now } from "../lib/clock";
import { plural, tokens } from "../lib/format";
import { meterOf, planTitle, windowTone } from "../lib/limits";
import { costText, emptyText, liftsAt, rangeLabel, usd } from "../lib/usage-limits";
import { scopedSummary } from "../lib/rail-plans";
import { axisTicks, byAccount, pct, periodName, processed, share, sourceOf, SOURCES, type AccountTotal } from "../lib/usage";
import { Segmented, Spinner } from "./ui/bits";
import { ProviderIcon } from "./ui/ProviderIcon";
const RANGES = [1, 7, 30, 90].map(v => ({ value: String(v), label: v === 1 ? "24h" : `${v}d` }));
const VIEWS = [{ value: "cost", label: "Cost" }, { value: "tokens", label: "Tokens" }, { value: "limits", label: "Limits" }];
const [days, setDays] = createSignal<UsageDays>(7);

/** How full a window's bar is: all of it at its limit, else its share. */
const barShare = (w: { pct?: number; reached: boolean }) => (w.reached ? 100 : Math.max(0, Math.min(100, w.pct ?? 0)));
/** A window's tint, as the design's bars take it. */
const TONE = { normal: undefined, warn: "amber", danger: "red" } as const;

/** A titled block, as every Settings page has them: the heading on the left, its cards on the right. */
function Section(p: { title: string; sub?: JSX.Element; aside?: JSX.Element; id?: string; children: JSX.Element }) {
    return (
        <section class="set-section" aria-label={p.title} id={p.id}>
            <header class="set-section-head">
                <h3 class="set-h">{p.title}</h3>
                <Show when={p.sub}>
                    <p class="set-sub">{p.sub}</p>
                </Show>
                {p.aside}
            </header>
            <div class="set-section-body">{p.children}</div>
        </section>
    );
}

/** What a card shows when it has nothing: a line, a few words under it, and the way on. */
function Blank(p: { title: string; busy?: boolean; role?: "status"; children?: JSX.Element }) {
    return (
        <div class="card usage-blank" role={p.role}>
            <div class="blank">
                <Show when={p.busy}>
                    <Spinner size={14} class="blank-spinner" />
                </Show>
                <p class="blank-title">{p.title}</p>
                {p.children}
            </div>
        </div>
    );
}

/** Each plan as a card: its mark, plan and account, then a row per limit window. */
function PlanLimitsGroup() {
    const plans = () => Object.values(app.limits).map((l) => ({ l, m: meterOf(l, now()) })).filter((x) => x.m);
    const name = (id: string) => app.providers.find((p) => p.id === id);
    return (
        <Show when={plans().length} fallback={<Blank title="Plan limits show here after a turn on a plan." />}>
            <Section title="Plan limits">
                <For each={plans()}>
                    {({ l, m }) => (
                        <div class="card set-card limit-card">
                            <div class="card-head">
                                <ProviderIcon id={l.provider} name={name(l.provider)?.name} size={15} />
                                <span>{planTitle(name(l.provider), l.accountId, l.provider).title}</span>
                                <Show when={m!.reached}>
                                    <span class="tag plan-reached" data-tone={m!.usingCredits ? "amber" : "red"}>
                                        {m!.usingCredits ? "Limit reached · using credits" : "Limit reached"}
                                        <Show when={liftsAt(m!)}>{(at) => <> · resets {at()}</>}</Show>
                                    </span>
                                </Show>
                                {/* Some models' limit reached (Fable's): amber, as the plan's other models go on, beside a stop of the plan's own. */}
                                <Show when={m!.partly.length}>
                                    <span class="tag plan-reached" data-tone="amber">{scopedSummary(m!.partly, () => undefined)}</span>
                                </Show>
                                <span class="grow" />
                                <Show when={m!.asOf}>
                                    <span class="limit-asof">{m!.asOf}</span>
                                </Show>
                            </div>
                            <For each={m!.windows}>
                                {(w) => (
                                    <div class="row limit-row" data-tone={windowTone(w)}>
                                        <span class="limit-label">{w.label}</span>
                                        {/* At its limit, full (as the rail's card draws it), whatever share the CLI last gave: the figure has that.
                                            One that has reset since the report: empty, as usage started again then. */}
                                        <span class="bar" data-tone={TONE[windowTone(w)]} role="meter" aria-label={`${w.label} limit used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.reset ? undefined : barShare(w)} aria-valuetext={w.reset ? `Reset ${w.reset}` : undefined}>
                                            <i style={{ width: `${w.reset ? 0 : barShare(w)}%` }} />
                                        </span>
                                        <span class="limit-pct num">{w.reset ? "" : w.pct !== undefined ? `${w.pct}%` : w.reached ? "Full" : "—"}</span>
                                        <span class="limit-reset">{w.reset ? `Reset ${w.reset}` : w.resets ? `Resets ${w.resets}` : ""}</span>
                                    </div>
                                )}
                            </For>
                        </div>
                    )}
                </For>
            </Section>
        </Show>
    );
}


type Metric = "cost" | "tokens";
const SHORT: Record<UsageSource, string> = { "claude-code": "Claude Code", codex: "Codex", api: "API" };
const amount = (r: Pick<UsageTotals, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "cost">, m: Metric) => (m === "tokens" ? processed(r) : r.cost);
/** A cost as a figure: "$X+" when part of it had no price, "—" when none did, "~$X" when part is at a guessed price. Never "$0" for unpriced usage. */
const costFigure = (r: { cost: number; unknown: boolean; estimated?: boolean }) => (r.unknown && !r.cost ? "—" : `${r.estimated ? "~" : ""}${usd(r.cost)}${r.unknown ? "+" : ""}`);
const figure = (r: Parameters<typeof amount>[0] & { unknown: boolean }, m: Metric) => (m === "tokens" ? tokens(processed(r)) : costFigure(r));

/**
 * Kept separate from loading so the actual dashboard can also be rendered in tests. One total, split the same
 * way three times (bar, names, numbers); what the tokens were; a stacked chart per period whose top line reads the
 * period pointed at, then models or periods; what each account gave. Pointing at a source in the legend, the
 * accounts or the table brings it forward everywhere.
 */
export function UsageDashboard(p: { data: UsageSummary; metric: Metric }) {
    const [breakdown, setBreakdown] = createSignal("model");
    const [hl, setHl] = createSignal<UsageSource>();
    const m = () => p.metric;
    const total = () => amount(p.data.totals, m());
    const sources = () => p.data.sources.filter((s) => processed(s) > 0 || s.cost > 0);
    const unpriced = () => [...new Set(p.data.rows.filter((r) => r.unknown).map((r) => r.model))];
    const accounts = createMemo(() => byAccount(p.data.accounts));
    const accountCount = (s: UsageSource) => accounts().filter((a) => a.source === s).length;
    // Cost, and nothing used has a price: there's no figure, split or chart to draw, so say that once.
    const noCost = () => m() === "cost" && p.data.totals.cost === 0 && p.data.totals.unknown;
    const types = () => (m() === "tokens"
        ? [["Cache reads", "Earlier context, read back from the cache", p.data.totals.cacheReadTokens], ["Cache writes", "New context, stored in the cache", p.data.totals.cacheWriteTokens], ["Uncached input", "New context sent without caching", p.data.totals.inputTokens], ["Output", "What the models wrote", p.data.totals.outputTokens]] as const
        : [["Cache reads", "Earlier context, read back from the cache", p.data.totals.costByType.cacheRead], ["Cache writes", "New context, stored in the cache", p.data.totals.costByType.cacheWrite], ["Uncached input", "New context sent without caching", p.data.totals.costByType.input], ["Output", "What the models wrote", p.data.totals.costByType.output], ...(p.data.totals.costByType.unallocated ? [["Unallocated", "Cost the provider reported without a split", p.data.totals.costByType.unallocated] as const] : [])] as const);
    const biggest = () => Math.max(0, ...types().map((t) => t[2]));
    return <div class="usage-dashboard" aria-label="Usage dashboard" data-hl={hl() ?? ""}>
        <Show when={!noCost()} fallback={<Blank title="No cost to show"><p class="usage-blank-sub">No price is known for {unpriced().join(", ")}.</p></Blank>}><>
        <Section title="Total" sub={<>
            {m() === "tokens" ? "" : "At API prices. "}In the last {rangeLabel(p.data.days)}, across {plural(p.data.sessions, "session")}.
            <Show when={m() === "cost" && unpriced().length}> No price is known for {unpriced().join(", ")}, so {unpriced().length === 1 ? "its" : "their"} usage isn't in the cost.</Show>
        </>}>
            <div class="card set-card usage-total">
                <p class="usage-figure num">{m() === "tokens" ? `${tokens(processed(p.data.totals), 3)} tokens` : costFigure(p.data.totals)}</p>
                <div class="usage-split" role="img" aria-label={sources().map((s) => `${SHORT[s.source]} ${pct(amount(s, m()), total())}`).join(", ")}>
                    <For each={sources()}>{(s) => <i data-source={s.source} data-src={s.source} style={{ "flex-grow": share(amount(s, m()), total()) }} />}</For>
                </div>
                <ul class="usage-legend">
                    <For each={sources()}>{(s) => <li data-src={s.source} onPointerEnter={() => setHl(s.source)} onPointerLeave={() => setHl(undefined)}>
                        <i data-source={s.source} />
                        <span>{SHORT[s.source]}</span>
                        <span class="num">{figure(s, m())}</span>
                        <span class="dim num">{pct(amount(s, m()), total())}</span>
                        <span class="dim usage-legend-more">
                            {m() === "tokens" ? `${costFigure(s)} at API prices` : `${tokens(processed(s))} tokens`}, {plural(s.sessions, "session")}
                            <Show when={s.source !== "api" && accountCount(s.source) > 1}>, <a class="link-btn" href="#usage-accounts" onClick={(e) => { e.preventDefault(); document.getElementById("usage-accounts")?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); }}>{accountCount(s.source)} accounts</a></Show>
                        </span>
                    </li>}</For>
                </ul>
            </div>
        </Section>
        <Section title="By token type">
            <div class="card set-card">
                <For each={types()}>
                    {([label, desc, v]) => <div class="row usage-row">
                        <span class="usage-row-name" data-tip={desc}>{label}</span>
                        <span class="bar" aria-hidden="true"><i style={{ width: `${Math.max(1, share(v, biggest()))}%` }} /></span>
                        <span class="usage-row-value num">{m() === "tokens" ? tokens(v) : usd(v)}</span>
                        <span class="usage-row-share dim num">{pct(v, total())}</span>
                    </div>}
                </For>
                <div class="row usage-row usage-saved">
                    <span class="usage-row-name" data-tip="Compared with no caching, at API prices">Saved by caching</span>
                    <span class="grow" />
                    <span class="usage-row-value num">{costFigure({ cost: p.data.totals.cacheSavings, unknown: p.data.totals.unknown })}</span>
                    <span class="usage-row-share" />
                </div>
            </div>
        </Section>
        <Section
            title={`By ${breakdown() === "model" ? "model" : p.data.interval === "hour" ? "hour" : "day"}`}
            sub={`${m() === "tokens" ? "Tokens" : "Cost"} per ${p.data.interval === "hour" ? "hour" : "day"}, UTC`}
            aside={<Segmented label="Usage breakdown" size="sm" value={breakdown()} onChange={setBreakdown} options={[{ value: "model", label: "Model" }, { value: "time", label: p.data.interval === "hour" ? "Hour" : "Day" }]} />}
        >
            <UsageChart data={p.data} metric={m()} />
            <UsageTable data={p.data} metric={m()} by={breakdown()} hl={setHl} />
        </Section>
        {/* Also for one account alone when it's another machine's (`<id>@<server>`): its row says where that usage was. */}
        <Show when={SOURCES.some((s) => s !== "api" && accountCount(s) > 1) || accounts().some((a) => a.source !== "api" && a.accountId.includes("@"))}>
            <UsageAccounts accounts={accounts()} names={p.data.names} metric={m()} total={total()} hl={setHl} />
        </Show>
        <p class="usage-foot">
            Costs are at API list prices, not what a plan bills.
            <Show when={p.data.totals.unknown}> Costs leave out unpriced usage; the Tokens view includes it.</Show>
            <Show when={p.data.totals.estimated}> ~ marks a newer model priced like the one before it.</Show>
            {p.data.approxDated ? ` Times are approximate for ${plural(p.data.approxDated, "older record")}.` : ""}{p.data.approxPriced ? ` ${plural(p.data.approxPriced, "record")} may be unpriced.` : ""}
        </p>
        </></Show>
    </div>;
}

/** What each account gave, a card per source; the bars are shares of the whole range, so accounts compare across sources. */
function UsageAccounts(p: { accounts: AccountTotal[]; /** Names the summary gives: another machine's accounts, and this computer's in a window that isn't on it. */ names?: Record<string, string>; metric: Metric; total: number; hl: (s?: UsageSource) => void }) {
    const info = (a: AccountTotal) => app.providers.find((x) => x.id === a.provider);
    const account = (a: AccountTotal) => info(a)?.agentCli?.accounts?.find((x) => x.id === a.accountId);
    const name = (a: AccountTotal) => (a.source === "api" ? a.providerName : p.names?.[`${a.source}:${a.accountId}`] ?? account(a)?.name ?? (a.accountId === "default" ? "Default" : a.accountId));
    const meta = (a: AccountTotal) => {
        if (a.source === "api") return "API key";
        // In a window on a server the accounts counted are this computer's: the window's own (the server's) plan and limit aren't theirs.
        if (windowMachine) return "";
        // The plan's own weekly window, not a model's (Weekly Fable).
        const weekly = meterOf(app.limits[planLimitKey(a.provider, a.accountId)], now())?.windows.find((w) => !w.scope && /week/i.test(w.label));
        return [planTitle(info(a), a.accountId).plan, weekly?.reset ? `weekly limit reset ${weekly.reset}` : weekly?.pct !== undefined ? `weekly limit ${weekly.pct}% used` : undefined].filter(Boolean).join(", ");
    };
    const groups = () => SOURCES.map((s) => ({ s, list: p.accounts.filter((a) => a.source === s).sort((x, y) => amount(y, p.metric) - amount(x, p.metric)) })).filter((g) => g.list.length);
    return (
        <Section title="By account" id="usage-accounts">
            <For each={groups()}>{(g) => (
                <div class="card set-card" data-src={g.s} onPointerEnter={() => p.hl(g.s)} onPointerLeave={() => p.hl(undefined)}>
                    <div class="card-head">
                        <Show when={g.s !== "api"} fallback={<KeyRound size={15} />}><ProviderIcon id={g.s} name={SHORT[g.s]} size={15} /></Show>
                        <span>{SHORT[g.s]}</span>
                        <span class="grow" />
                        <span class="limit-asof">{g.s === "api" ? plural(g.list.length, "key") : plural(g.list.length, "account")}</span>
                    </div>
                    <For each={g.list}>{(a) => (
                        <div class="row usage-row">
                            <span class="usage-row-name usage-row-wide usage-account">
                                <span class="row-title">{name(a)}</span>
                                <Show when={meta(a)}><span class="row-sub">{meta(a)}</span></Show>
                            </span>
                            <span class="bar" aria-hidden="true"><i style={{ width: `${share(amount(a, p.metric), p.total)}%` }} /></span>
                            <span class="usage-row-value num" data-tip={p.metric === "tokens" ? costFigure(a) : `${tokens(processed(a))} tokens`}>{figure(a, p.metric)}</span>
                            <span class="usage-row-share dim num">{pct(amount(a, p.metric), p.total)}</span>
                        </div>
                    )}</For>
                </div>
            )}</For>
        </Section>
    );
}

/** Stacked bars per period. The line on top reads the period pointed at (or reached with the arrow keys), else the busiest one. */
function UsageChart(p: { data: UsageSummary; metric: Metric }) {
    const [at, setAt] = createSignal<number>();
    let cols: HTMLDivElement | undefined;
    const series = () => p.data.series;
    const n = () => series().length;
    const hourly = () => p.data.interval === "hour";
    const tot = (b: UsageBucket) => amount(b, p.metric);
    // The busiest period fills the height; the readout (the busiest, until another is pointed at) gives the scale.
    const top = createMemo(() => Math.max(0, ...series().map(tot)) || 1);
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
    return (
        <figure class="card set-card usage-chart">
            <div class="chart">
                <Show when={series()[shown()]}>{(b) => <p class="chart-read" aria-live="polite">
                    <span class="chart-read-when">{periodName(b().at, hourly())}</span>
                    <Show when={tot(b())} fallback={<span class="chart-read-total none">{processed(b()) > 0 ? (b().unknown ? "No known cost" : f(0)) : "No usage"}</span>}>
                        <span class="chart-read-total num">{f(tot(b()))}</span>
                        <For each={SOURCES.filter((s) => amount(b().sources[s], p.metric) > 0)}>{(s) => <span class="chart-read-part" data-src={s}>{SHORT[s]} <span class="num">{f(amount(b().sources[s], p.metric))}</span></span>}</For>
                    </Show>
                    <Show when={note(shown())}><span class="chart-read-note">{note(shown())}</span></Show>
                </p>}</Show>
                <div class="chart-bars" ref={cols} style={{ "--n": n() }} tabindex="0" role="group" aria-label={`${p.metric === "tokens" ? "Tokens" : "Cost"} per ${unit()}. Use the arrow keys to read each ${unit()}; the table below lists them all.`}
                    onPointerMove={pick} onPointerLeave={() => document.activeElement !== cols && setAt(undefined)} onKeyDown={key} onBlur={() => setAt(undefined)}>
                    <For each={series()}>{(b, i) => <span class="chart-col" data-on={at() === i() ? "" : undefined} aria-hidden="true">
                        <span class="chart-stack" style={{ height: tot(b) ? `${Math.max(1.5, (tot(b) / top()) * 100)}%` : "0" }}>
                            <For each={SOURCES.filter((s) => amount(b.sources[s], p.metric) > 0)}>{(s) => <i data-source={s} data-src={s} style={{ "flex-grow": share(amount(b.sources[s], p.metric), tot(b)) }} />}</For>
                        </span>
                    </span>}</For>
                </div>
                <div class="chart-axis" data-centered={n() <= 10 ? "" : undefined} aria-hidden="true"><For each={axisTicks(series(), hourly())}>{(t) => <span style={{ left: `${((t.i + 0.5) / n()) * 100}%` }}>{t.label}</span>}</For></div>
            </div>
        </figure>
    );
}

/** Models (by the shown measure, largest first) or periods (newest first). */
function UsageTable(p: { data: UsageSummary; metric: Metric; by: string; hl: (s?: UsageSource) => void }) {
    const total = () => amount(p.data.totals, p.metric);
    const hourly = () => p.data.interval === "hour";
    const last = () => p.data.series.length - 1;
    const periods = () => p.data.series.map((b, i) => ({ b, i })).filter((x) => x.b.sessions > 0 || processed(x.b) > 0).reverse();
    const rows = () => p.data.rows.slice().sort((a, b) => amount(b, p.metric) - amount(a, p.metric));
    return <div class="card set-card usage-table-card" tabindex="0" role="region" aria-label="Usage breakdown table">
        <table class="usage-table"><caption class="sr-only">{p.by === "model" ? "Models" : "UTC periods"}: sessions, processed tokens and combined estimates</caption>
            <thead><tr><th scope="col" aria-sort={p.by === "model" ? undefined : "descending"}>{p.by === "model" ? "Model" : `${hourly() ? "Hour" : "Day"} (UTC)`}</th><th scope="col" class="r">Sessions</th><th scope="col" class="r" aria-sort={p.by === "model" && p.metric === "tokens" ? "descending" : undefined}>Tokens</th><th scope="col" class="r" aria-sort={p.by === "model" && p.metric === "cost" ? "descending" : undefined}>Cost</th><th scope="col" class="r">Share</th></tr></thead>
            <tbody>
                <Show when={p.by === "model"} fallback={<For each={periods()}>{({ b, i }) => <tr>
                    <th scope="row"><span class="usage-model">{periodName(b.at, hourly())}<Show when={i === last() || i === 0}><span class="dim">{i === last() ? "So far" : "Partial"}</span></Show></span></th>
                    <td class="r num">{b.sessions}</td><td class="r num">{tokens(processed(b))}</td><td class="r num">{costText(b)}</td>
                    <td class="r num dim">{pct(amount(b, p.metric), total())}</td>
                </tr>}</For>}>
                    <For each={rows()}>{(r) => <tr data-src={sourceOf(r.provider)} onPointerEnter={() => p.hl(sourceOf(r.provider))} onPointerLeave={() => p.hl(undefined)}>
                        <th scope="row"><span class="usage-model"><i data-source={sourceOf(r.provider)} /><span class={r.model.includes("/") ? "mono" : ""}>{r.model}</span><span class="dim">{r.providerName}, {r.plan ? "plan" : "API key"}</span></span></th>
                        <td class="r num">{r.sessions}</td><td class="r num">{tokens(processed(r))}</td><td class={`r num ${r.unknown && !r.cost ? "dim" : ""}`}>{r.unknown && !r.cost ? "No price" : costFigure(r)}</td>
                        <td class="r num dim">{pct(amount(r, p.metric), total())}</td>
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
            // Where the plans stand now: the CLIs are asked (the server skips what was just reported), then shown.
            if (view() === "limits") await checkLimits().then(refreshLimits);
            else {
                const asked = days();
                const r = await rpc.call("usage.summary", { days: asked, first: true });
                if (mine === seq) setData(r);
                // This computer's own so far: the servers' are added when they've answered. If that can't be asked
                // for, what's shown stays, and says which weren't counted.
                if (mine === seq && r.waiting?.length) {
                    const all = await rpc.call("usage.summary", { days: asked, rest: true }).catch(() => ({ ...r, waiting: undefined, uncounted: [...(r.uncounted ?? []), ...r.waiting!] }));
                    if (mine === seq) setData(all);
                }
            }
        } catch (e) { if (mine === seq) setError(e instanceof Error ? e.message : String(e)); }
        finally { if (mine === seq) setLoading(false); }
    };
    createEffect(on([days, view], () => void load()));
    // Opened: the plans' limits (Limits, and By account's weekly figure) are asked for once, whichever view shows first.
    onMount(() => void checkLimits());
    // Another range keeps the last one on screen, dimmed, until its own arrives: no flash, no jump.
    const stale = () => loading() && data()?.days !== days();
    return <div class="usage" aria-busy={loading()} data-stale={stale() ? "" : undefined}>
        <div class="usage-bar">
            <Segmented label="Usage view" value={view()} options={VIEWS} onChange={setView} />
            <span class="grow" />
            <Show when={view() !== "limits"}><Segmented label="Usage time range" value={String(days())} options={RANGES} onChange={v => { if (Number(v) !== days()) setDays(Number(v) as UsageDays); }} /></Show>
            <button class="icon-btn" data-tip="Refresh" aria-label={view() === "limits" ? "Refresh limits" : "Refresh usage"} disabled={loading()} onClick={() => void load()}><Show when={loading()} fallback={<RotateCw size={14} />}><Spinner size={14} /></Show></button>
        </div>
        <Show when={error()}><div class="card usage-blank" role="alert"><div class="blank"><p class="blank-title">Couldn't read usage</p><p class="usage-blank-sub">{error()}</p><button class="btn btn-sm" onClick={() => void load()}>Try again</button></div></div></Show>
        <Show when={view() === "limits"} fallback={<>
            <Show when={loading() && !data()}><Blank title="Loading usage…" busy role="status" /></Show>
            <Show when={!error() && data()}>{d => <>
                <Show when={d().truncated}><div class="note" role="status"><Info size={14} /><span class="note-body">Only part of this range is counted: {d().truncated} A shorter range counts everything.</span></div></Show>
                <Show when={d().waiting?.length && d().days === days()}><div class="note" role="status"><Info size={14} /><span class="note-body">Adding {d().waiting!.join(", ")}…</span></div></Show>
                <Show when={d().uncounted?.length}><div class="note" role="status"><Info size={14} /><span class="note-body">Not counted: {d().uncounted!.join(", ")}.</span></div></Show>
                <Show when={d().rows.length} fallback={noModel() && !d().truncated ? <Blank title="No model connected."><button class="btn btn-sm" onClick={() => setSettingsTab("providers")}>Connect a model</button></Blank> : <Blank title={emptyText(d())}><Show when={!d().truncated}><p class="usage-blank-sub">Sessions show up here after their first reply.</p></Show><Show when={!d().truncated && d().days < 90}><button class="btn btn-sm" onClick={() => setDays(90)}>Show the last 90 days</button></Show></Blank>}>
                    <UsageDashboard data={d()} metric={view() === "tokens" ? "tokens" : "cost"} />
                </Show>
            </>}</Show>
        </>}><PlanLimitsGroup /></Show>
    </div>;
}
