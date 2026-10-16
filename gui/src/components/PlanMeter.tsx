// Per-account plan limits come only from the CLI's own reports.
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { planLimitKey, type AccountInfo } from "@shared/protocol";
import { app, handleFor, reportError, rpc, toast } from "../state/app";
import { now } from "../lib/clock";
import { limitAlternatives, meterOf, windowLine } from "../lib/limits";
import { Popover } from "./ui/Popover";

export function PlanMeter(p: { sessionId: string }) {
    let button: HTMLButtonElement | undefined;
    const [open, setOpen] = createSignal(false);
    const [accounts, setAccounts] = createSignal<AccountInfo[]>([]);
    const [checking, setChecking] = createSignal(false);
    const [switching, setSwitching] = createSignal(false);
    const state = () => handleFor(p.sessionId)?.view.state;
    const provider = () => state()?.model?.provider;
    const accountId = () => state()?.accounts?.[provider() ?? ""] ?? "default";
    const limits = () => app.limits[planLimitKey(provider() ?? "", accountId())];
    const meter = createMemo(() => meterOf(limits(), now()));
    const providerInfo = () => app.providers.find((x) => x.id === provider());
    const name = () => `${providerInfo()?.name ?? "Plan"} · ${providerInfo()?.agentCli?.accounts?.find((a) => a.id === accountId())?.name ?? "Default"}`;
    const alternatives = () => limitAlternatives(accounts(), accountId());
    // A limit can arrive before Settings has ever checked account status.
    const refreshKey = createMemo(() => meter()?.reached ? `${provider()}:${accountId()}:${limits()?.at}` : undefined);
    createEffect(() => {
        const key = refreshKey();
        setAccounts([]);
        if (!key || !providerInfo()?.agentCli?.accounts?.length) return;
        let active = true;
        setChecking(true);
        void rpc.call("accounts.list", { provider: provider()!, refresh: true }).then((items) => {
            if (active) setAccounts(items);
        }).catch((error) => { if (active) reportError(error); }).finally(() => { if (active) setChecking(false); });
        onCleanup(() => { active = false; });
    });
    async function switchTo(id: string) {
        const selectedProvider = provider();
        if (!selectedProvider) return;
        setSwitching(true);
        try {
            await rpc.call("session.setAccount", { id: p.sessionId, provider: selectedProvider, accountId: id });
            setOpen(false);
            toast("Account switched. Send your message again to continue.", "info");
        } catch (error) { reportError(error); }
        finally { setSwitching(false); }
    }
    return (
        <Show when={meter() && (providerInfo()?.agentCli?.accounts?.length ?? 0) > 1}>
            <span class="account-plan-meter">
                <button ref={button} class={`hb plan-meter ${meter()?.reached ? "danger" : ""}`} aria-label={`${name()} usage: ${meter()!.windows.map(windowLine).join("; ") || "limit reached"}`} aria-haspopup="dialog" aria-expanded={open()} onClick={() => setOpen(!open())}>
                    <span class="plan-gauge" aria-hidden="true"><span style={{ width: `${Math.min(100, meter()?.reached ? 100 : meter()?.top ?? 0)}%` }} /></span>
                    <span class="num">{meter()?.reached ? "Limit reached" : meter()?.top !== undefined ? `${meter()!.top}%` : "Plan"}</span>
                </button>
                <Show when={meter()?.reached}>
                    <Show when={checking()}><span class="plan-account-hint">Checking accounts…</span></Show>
                    <For each={alternatives()}>{(a) => <button class="hb" disabled={state()?.busy || switching()} onClick={() => void switchTo(a.id)} title="Starts a new CLI thread with this conversation; send your message again">Switch to {a.name}</button>}</For>
                </Show>
            </span>
            <Popover open={open()} anchor={() => button} onClose={() => setOpen(false)} placement="top" align="end" width={280} class="ctx-card">
                <div class="ctx-label">{name()} limits</div>
                <Show when={meter()?.asOf}><div class="plan-account-hint">{meter()!.asOf}</div></Show>
                <Show when={meter()?.reached}><p>Limit reached{meter()?.resets ? `. Resets ${meter()!.resets}` : ""}. Switch accounts above, then send again.</p></Show>
                <For each={meter()?.windows}>{(w) => <div class="plan-window"><div class="ctx-line"><span>{w.label}</span><span class="num">{w.pct !== undefined ? `${w.pct}%` : w.reached ? "reached" : "—"}</span></div><Show when={w.pct !== undefined}><div class="ctx-bar"><div class="ctx-fill" style={{ width: `${w.pct}%` }} /></div></Show><Show when={w.resets}><div class="plan-account-hint">Resets {w.resets}</div></Show></div>}</For>
                <div class="ctx-foot">From this account's CLI reports. Reset times do not confirm renewed availability.</div>
            </Popover>
        </Show>
    );
}
