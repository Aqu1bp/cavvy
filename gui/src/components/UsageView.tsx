// Settings → Usage: where the plans stand, and what sessions used over the
// last day, week or month, per provider and model (from the transcripts).

import { createEffect, createSignal, For, on, Show } from "solid-js";
import { RotateCcw } from "lucide-solid";
import type { UsageDays, UsageSummary } from "@shared/protocol";
import { app, refreshLimits, reportError, rpc } from "../state/app";
import { now } from "../lib/clock";
import { tokens } from "../lib/format";
import { costText, emptyText, meterOf, tokensIn, usd, windowLine } from "../lib/limits";
import { Segmented, Spinner } from "./ui/bits";
import { ProviderIcon } from "./ui/ProviderIcon";

const RANGES: { value: string; label: string }[] = [
    { value: "1", label: "24h" },
    { value: "7", label: "7d" },
    { value: "30", label: "30d" },
];

/** The range picked last, for this window. */
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

export function UsageView() {
    const [data, setData] = createSignal<UsageSummary>();
    const [loading, setLoading] = createSignal(false);
    let seq = 0;
    const load = async () => {
        const mine = ++seq;
        setLoading(true);
        try {
            const r = await rpc.call("usage.summary", { days: days() });
            if (mine === seq) setData(r);
        } catch (e) {
            if (mine === seq) reportError(e);
        } finally {
            if (mine === seq) setLoading(false);
        }
    };
    // However the tab was opened (a slash command, the palette), it loads.
    createEffect(on(days, () => void load()));
    void refreshLimits().catch(() => undefined);
    return (
        <>
            <PlanLimitsGroup />
            <div class="sgroup usage-bar">
                <span>Tokens and cost</span>
                <Show when={loading()}>
                    <Spinner size={14} />
                </Show>
                <span class="spacer" />
                <Segmented label="Usage time range" size="sm" value={String(days())} options={RANGES} onChange={(v) => setDays(Number(v) as UsageDays)} />
                <button class="hb sm" title="Refresh" aria-label="Refresh" onClick={() => void load()}>
                    <RotateCcw size={14} />
                </button>
            </div>
            <Show when={data()} fallback={<p class="set-note" role="status">Reading the sessions…</p>}>
                    {(d) => (
                        <Show when={d().rows.length} fallback={<p class="set-note">{emptyText(d())}</p>}>
                            <div class="usage-table-wrap">
                                <table class="usage-table" aria-busy={loading()}>
                                    <caption class="sr-only">Tokens and cost for the last {days()} days</caption>
                                    <thead>
                                        <tr>
                                            <th>Model</th>
                                            <th class="num">Sessions</th>
                                            <th class="num" title="Input tokens, cache writes included">In</th>
                                            <th class="num">Out</th>
                                            <th class="num">Cache reads</th>
                                            <th class="num">Cost</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <For each={d().rows}>
                                            {(r) => (
                                                <tr>
                                                    <td>
                                                        <div class="usage-model">
                                                            <ProviderIcon id={r.provider} name={r.providerName} size={14} />
                                                            <span class="mono">{r.model}</span>
                                                        </div>
                                                        <div class="usage-sub">{r.providerName}</div>
                                                    </td>
                                                    <td class="num">{r.sessions}</td>
                                                    <td class="num">{tokens(tokensIn(r))}</td>
                                                    <td class="num">{tokens(r.outputTokens)}</td>
                                                    <td class="num">{tokens(r.cacheReadTokens)}</td>
                                                    <td class="num">
                                                        <span class={r.unknown && !r.cost ? "usage-unknown" : ""}>{costText(r)}</span>
                                                        <Show when={r.planEquivalent > 0}>
                                                            <div class="usage-sub" title="Covered by your plan: what the API would have charged for the same tokens">API-equivalent est.</div>
                                                        </Show>
                                                    </td>
                                                </tr>
                                            )}
                                        </For>
                                    </tbody>
                                    <tfoot>
                                        <tr>
                                            <td>Total</td>
                                            <td class="num">{d().sessions}</td>
                                            <td class="num">{tokens(tokensIn(d().totals))}</td>
                                            <td class="num">{tokens(d().totals.outputTokens)}</td>
                                            <td class="num">{tokens(d().totals.cacheReadTokens)}</td>
                                            <td class="num">{costText(d().totals)}</td>
                                        </tr>
                                    </tfoot>
                                </table>
                            </div>
                            <p class="set-note">
                                Costs are estimates from list prices. On a plan (Claude Code, Codex) nothing is billed per token: those show what the API would have charged
                                {d().totals.planEquivalent > 0 ? ` (${usd(d().totals.planEquivalent)} of the total)` : ""}. Models without a known price show “unknown”, not $0.
                                <Show when={d().approxDated}> {d().approxDated} records from before usage was dated are counted at their session's last activity.</Show>
                                <Show when={d().approxPriced}> {d().approxPriced} records without a concrete model use today's alias mapping; their prices are approximate.</Show>
                                <Show when={d().truncated}> {d().truncated}</Show>
                            </p>
                        </Show>
                    )}
                </Show>
        </>
    );
}
