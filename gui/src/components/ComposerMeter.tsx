import { createEffect, createMemo, createSignal, createUniqueId, For, on, onCleanup, Show } from "solid-js";
import { planLimitKey, type AccountInfo } from "@shared/protocol";
import { app, handleFor, reportError, rpc, toast } from "../state/app";
import { contextCardOpen, setContextCardOpen, setSettingsTab } from "../state/ui";
import { now } from "../lib/clock";
import { limitAlternatives, meterOf, windowLine } from "../lib/limits";
import { contextView } from "../lib/context";
import { cost, tokens } from "../lib/format";
import { Ring } from "./ui/bits";
import { Popover } from "./ui/Popover";

export function ComposerMeter(p: { provider?: string; sessionId?: string }) {
    let btn: HTMLButtonElement | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const [open, setOpen] = [contextCardOpen, setContextCardOpen];
    const panelId = `composer-usage-${createUniqueId()}`;
    let panel: HTMLDivElement | undefined;
    let restoringFocus = false;
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
    const refreshKey = createMemo(() => {
        const others = providerInfo()?.agentCli?.accounts?.filter((a) => a.id !== accountId()).map((a) => a.id);
        return meter()?.reached && others?.length ? JSON.stringify([provider(), accountId(), limits()?.at, others]) : undefined;
    });
    createEffect(on(refreshKey, (key) => {
        setAccounts([]);
        setChecking(false);
        if (!key) return;
        let active = true;
        setChecking(true);
        void rpc.call("accounts.list", { provider: provider()!, refresh: true }).then((items) => {
            if (active) setAccounts(items);
        }).catch((error) => { if (active) reportError(error); }).finally(() => { if (active) setChecking(false); });
        onCleanup(() => { active = false; });
    }));
    async function switchTo(id: string) {
        const selectedProvider = provider();
        if (!selectedProvider || !p.sessionId) return;
        setSwitching(true);
        try {
            await rpc.call("session.setAccount", { id: p.sessionId, provider: selectedProvider, accountId: id });
            close();
            toast("Account switched. Send your message again to continue.", "info");
        } catch (error) { reportError(error); }
        finally { setSwitching(false); }
    }
    const view = () => contextView(state(), open());
    // The more urgent of the two. With neither known (no context size, no plan
    // report), the ring stays empty and neutral rather than implying a share.
    const urgency = () => Math.max(view().pct ?? 0, meter()?.reached ? 1 : (meter()?.top ?? 0) / 100);
    // Each source keeps its own thresholds: context nears compaction sooner,
    // while a plan only turns red at 90% or once a limit is reached.
    const tone = (): "danger" | "warning" | "normal" => {
        const ctx = view().pct ?? 0, plan = meter()?.top ?? 0;
        if (ctx >= 0.85 || meter()?.reached || plan >= 90) return "danger";
        if (ctx >= 0.7 || plan >= 80) return "warning";
        return "normal";
    };
    const label = () => [
        view().pct === undefined ? "Context window: size not known yet" : `Context: ${Math.round(view().pct! * 100)}% used`,
        meter() ? `${name()} usage: ${meter()!.windows.map(windowLine).join("; ") || "limit reached"}` : undefined,
    ].filter(Boolean).join(". ");
    const cancelClose = () => clearTimeout(closeTimer);
    const show = () => { cancelClose(); setOpen(true); };
    const close = () => {
        cancelClose();
        const restore = panel?.contains(document.activeElement);
        setOpen(false);
        if (restore) {
            restoringFocus = true;
            btn?.focus();
            restoringFocus = false;
        }
    };
    const hide = () => {
        cancelClose();
        closeTimer = setTimeout(() => {
            if (!btn?.contains(document.activeElement) && !panel?.contains(document.activeElement)) close();
        }, 160);
    };
    const enterPanel = () => {
        show();
        panel?.focus();
    };
    onCleanup(cancelClose);
    return (
        <Show when={state() || meter()}>
            <button
                ref={btn}
                type="button"
                class="hb ctx-ring"
                aria-haspopup="dialog"
                aria-expanded={open()}
                aria-controls={open() ? panelId : undefined}
                aria-label={label()}
                onMouseEnter={show}
                onMouseLeave={hide}
                onFocus={() => { if (!restoringFocus) show(); }}
                onBlur={hide}
                onClick={enterPanel}
                onKeyDown={(e) => {
                    if (e.key === "ArrowDown") { e.preventDefault(); enterPanel(); }
                }}
            >
                <span aria-hidden="true"><Ring value={urgency()} size={18} stroke={2.4} neutral tone={tone()} /></span>
            </button>
            <Popover open={open()} anchor={() => btn} onClose={close} placement="top" align="end" width={288} class="ctx-card usage-card">
                <div ref={panel} id={panelId} role="dialog" aria-label="Context and usage" tabIndex={-1}
                    onMouseEnter={cancelClose} onMouseLeave={hide} onFocusIn={cancelClose} onFocusOut={hide}>
                    <section class="usage-section" aria-label="Context window">
                        <h3 class="ctx-label">Context window</h3>
                        <div class="ctx-line">
                            <span class="num">{state() ? view().line : "Send a message to measure context usage."}</span>
                            <Show when={view().pct !== undefined}><span class="ctx-pct num">{Math.round(view().pct! * 100)}%</span></Show>
                        </div>
                        <div class="usage-actions">
                            <span>{app.settings.autoCompact === false ? "Automatic compaction is off." : "Compacts on its own near the limit."}</span>
                            <button class="ghost-btn outlined" disabled={!state() || (state()?.busy && !state()?.activity?.idle)} onClick={() => {
                                if (!p.sessionId) return;
                                close();
                                void rpc.call("session.compact", { id: p.sessionId }).catch(reportError);
                            }}>Compact now</button>
                        </div>
                    </section>
                    <Show when={meter()}>
                        <section class="usage-section" aria-label="Plan limits">
                            <h3 class="ctx-label">Plan limits</h3>
                            <div class="usage-account">{name()}</div>
                            <Show when={meter()?.asOf}><div class="plan-asof">{meter()!.asOf}</div></Show>
                            <Show when={meter()?.reached}><div class="plan-reached">Limit reached</div></Show>
                            <For each={meter()?.windows}>{(w) => (
                                <div class="plan-window">
                                    <div class="ctx-line"><span>{w.label}</span><span class="ctx-pct num">{w.pct !== undefined ? `${w.pct}%` : w.reached ? "reached" : "—"}</span></div>
                                    <Show when={w.resets}><div class="plan-resets num">Resets {w.resets}</div></Show>
                                </div>
                            )}</For>
                            <Show when={meter()?.resets && !meter()?.windows.some((w) => w.resets === meter()?.resets)}><div class="plan-resets num">Resets {meter()!.resets}</div></Show>
                            <Show when={p.sessionId && meter()?.reached}>
                                <div class="usage-switches">
                                    <Show when={checking()}><span class="plan-account-hint" role="status">Checking accounts…</span></Show>
                                    <For each={alternatives()}>{(a) => <button class="ghost-btn outlined" disabled={(state()?.busy && !state()?.activity?.idle) || switching()} onClick={() => void switchTo(a.id)} title="Starts a new CLI thread with this conversation; send your message again">Switch to {a.name}</button>}</For>
                                </div>
                            </Show>
                        </section>
                    </Show>
                    <section class="usage-section" aria-label="Spend">
                        <div class="usage-heading"><h3 class="ctx-label">Spend</h3><button class="ghost-btn" onClick={() => { close(); setSettingsTab("usage"); }}>Usage</button></div>
                        <Show when={state()} fallback={<div class="plan-resets">No session yet.</div>}>
                            <div class="ctx-grid">
                                <span>Session</span><span class="num" title={state()?.costUnknown ? "No price is known for some of the models used, so their usage isn't counted" : undefined}>{cost(state()?.cost ?? 0, state()?.costUnknown)}</span>
                                <span>Tokens</span><span class="num">{tokens(state()?.tokensIn ?? 0)} in · {tokens(state()?.tokensOut ?? 0)} out</span>
                            </div>
                        </Show>
                    </section>
                </div>
            </Popover>
        </Show>
    );
}
