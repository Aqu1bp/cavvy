// The plan meter beside the context ring: where the user's Claude or ChatGPT
// plan stands, as the session's agent CLI last reported it. Limits are the
// account's, so sessions using that account share the same numbers.

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { planLimitKey, type AccountInfo } from "@shared/protocol";
import { app, handleFor, reportError, rpc, toast } from "../state/app";
import { setSettingsTab } from "../state/ui";
import { now } from "../lib/clock";
import { limitAlternatives, meterOf, windowLine } from "../lib/limits";
import { Popover } from "./ui/Popover";

export function PlanMeter(p: { provider?: string; sessionId?: string }) {
    let btn: HTMLButtonElement | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const [open, setOpen] = createSignal(false);
    const [accounts, setAccounts] = createSignal<AccountInfo[]>([]);
    const [checking, setChecking] = createSignal(false);
    const [switching, setSwitching] = createSignal(false);
    const state = () => p.sessionId ? handleFor(p.sessionId)?.view.state : undefined;
    const provider = () => state()?.model?.provider ?? p.provider;
    const providerInfo = () => app.providers.find((x) => x.id === provider());
    const accountId = () => state()?.accounts?.[provider() ?? ""] ?? providerInfo()?.agentCli?.defaultAccount ?? "default";
    const limits = () => app.limits[planLimitKey(provider() ?? "", accountId())];
    const meter = createMemo(() => meterOf(limits(), now()));
    const name = () => `${providerInfo()?.agentCli?.plan ?? providerInfo()?.name ?? "Plan"} · ${providerInfo()?.agentCli?.accounts?.find((a) => a.id === accountId())?.name ?? (accountId() === "default" ? "Default" : accountId())}`;
    const alternatives = () => limitAlternatives(accounts(), accountId());
    // A limit can arrive before Settings has ever checked account status.
    const refreshKey = createMemo(() => meter()?.reached ? `${provider()}:${accountId()}:${limits()?.at}` : undefined);
    createEffect(() => {
        const key = refreshKey();
        setAccounts([]);
        setChecking(false);
        if (!key || !providerInfo()?.agentCli?.accounts?.some((a) => a.id !== accountId())) return;
        let active = true;
        setChecking(true);
        void rpc.call("accounts.list", { provider: provider()!, refresh: true }).then((items) => {
            if (active) setAccounts(items);
        }).catch((error) => { if (active) reportError(error); }).finally(() => { if (active) setChecking(false); });
        onCleanup(() => { active = false; });
    });
    async function switchTo(id: string) {
        const selectedProvider = provider();
        if (!selectedProvider || !p.sessionId) return;
        setSwitching(true);
        try {
            await rpc.call("session.setAccount", { id: p.sessionId, provider: selectedProvider, accountId: id });
            setOpen(false);
            toast("Account switched. Send your message again to continue.", "info");
        } catch (error) { reportError(error); }
        finally { setSwitching(false); }
    }
    const show = () => (clearTimeout(closeTimer), setOpen(true));
    const hide = () => (closeTimer = setTimeout(() => setOpen(false), 160));
    onCleanup(() => clearTimeout(closeTimer));
    const tone = () => (meter()?.reached ? "danger" : (meter()?.top ?? 0) >= 80 ? "warn" : "");
    const chip = () => {
        const m = meter()!;
        if (m.reached) return m.resets ? `Limit · ${m.resets.replace(/, in .*$/, "")}` : "Limit reached";
        return m.top !== undefined ? `${m.top}%` : "Plan";
    };
    return (
        <Show when={meter()}>
            <span class="account-plan-meter">
                <button
                    ref={btn}
                    class={`hb plan-meter ${tone()}`}
                    aria-haspopup="dialog"
                    aria-expanded={open()}
                    aria-label={`${name()} usage: ${meter()!.windows.map(windowLine).join("; ") || "limit reached"}`}
                    onMouseEnter={show}
                    onMouseLeave={hide}
                    onClick={() => setOpen(!open())}
                >
                    <span class="plan-gauge" aria-hidden="true">
                        <span style={{ width: `${Math.min(100, meter()!.reached ? 100 : (meter()!.top ?? 0))}%` }} />
                    </span>
                    <span class="num">{chip()}</span>
                </button>
                <Show when={p.sessionId && meter()?.reached}>
                    <Show when={checking()}><span class="plan-account-hint">Checking accounts…</span></Show>
                    <For each={alternatives()}>{(a) => <button class="hb" disabled={state()?.busy || switching()} onClick={() => void switchTo(a.id)} title="Starts a new CLI thread with this conversation; send your message again">Switch to {a.name}</button>}</For>
                </Show>
            </span>
            <Popover open={open()} anchor={() => btn} onClose={() => setOpen(false)} placement="top" align="end" width={280} class="ctx-card">
                <div onMouseEnter={show} onMouseLeave={hide}>
                    <div class="ctx-label">
                        {name()} limits
                        <Show when={meter()!.asOf}>
                            <span class="plan-asof"> · {meter()!.asOf}</span>
                        </Show>
                    </div>
                    <Show when={meter()!.reached}>
                        <div class="plan-reached">Limit reached{meter()!.resets ? `. Resets ${meter()!.resets}.` : "."}</div>
                    </Show>
                    <For each={meter()!.windows}>
                        {(w) => (
                            <div class="plan-window">
                                <div class="ctx-line">
                                    <span>{w.label}</span>
                                    <span class="ctx-pct num">{w.pct !== undefined ? `${w.pct}%` : w.reached ? "reached" : "—"}</span>
                                </div>
                                <Show when={w.pct !== undefined}>
                                    <div class="ctx-bar">
                                        <div class={`ctx-fill ${w.reached || (w.pct ?? 0) >= 90 ? "danger" : (w.pct ?? 0) >= 80 ? "warn" : ""}`} style={{ width: `${Math.min(100, w.pct ?? 0)}%` }} />
                                    </div>
                                </Show>
                                <Show when={w.resets}>
                                    <div class="plan-resets">Resets {w.resets}</div>
                                </Show>
                            </div>
                        )}
                    </For>
                    <div class="ctx-foot">
                        <span>From this account's CLI reports.</span>
                        <button
                            class="ghost-btn outlined"
                            onClick={() => {
                                setOpen(false);
                                setSettingsTab("usage");
                            }}
                        >
                            Usage
                        </button>
                    </div>
                </div>
            </Popover>
        </Show>
    );
}
