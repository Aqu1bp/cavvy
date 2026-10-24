import { createEffect, createMemo, createSignal, createUniqueId, For, on, onCleanup, Show } from "solid-js";
import { planLimitKey, type AccountInfo, type PlanLimits } from "@shared/protocol";
import { app, handleFor, reportError, rpc, toast } from "../state/app";
import { contextCardOpen, setContextCardOpen, setSettingsTab } from "../state/ui";
import { now } from "../lib/clock";
import { Gauge } from "lucide-solid";
import { limitAlternatives, meterOf, windowLine, type Meter, type MeterWindow } from "../lib/limits";
import { contextView } from "../lib/context";
import { cost, tokens } from "../lib/format";
import { Ring } from "./ui/bits";
import { Popover } from "./ui/Popover";

/**
 * Home's limit pill: the plan's fullest window once it's at 80% or more, or a limit is reached ("94%",
 * "5-hour"). Below that Home shows nothing there: a new session has no context to put in a ring.
 * A window that has reset since the report says nothing now (as in the rail's footer), so it's skipped.
 */
export function nearLimit(m: Meter | undefined, l?: PlanLimits, at = Date.now()): { pct: number; window?: string } | undefined {
    if (!m) return undefined;
    const live = m.windows.filter((_, i) => (l?.windows[i]?.resetsAt ?? Infinity) > at);
    const used = (w: MeterWindow) => w.pct ?? (w.reached ? 100 : 0);
    // A reached window is the one to name, whatever another's percentage.
    const rank = (w: MeterWindow) => (w.reached ? 1000 : 0) + used(w);
    const w = live.reduce<MeterWindow | undefined>((a, b) => (!a || rank(b) > rank(a) ? b : a), undefined);
    // Reached with no window reached (a plain rate-limit stop): the plan's limit, not whichever window is fullest.
    if (m.reached && !w?.reached) return { pct: 100 };
    const pct = w ? used(w) : 0;
    if (pct < 80 && !m.reached) return undefined;
    // "of weekly limit", but "of GPT-5 5-hour limit": only the plain words lose their capital.
    return { pct: Math.min(100, Math.round(pct)), window: w?.label.replace(/^(Weekly|Primary|Secondary)\b/, (x) => x.toLowerCase()) };
}

/** `home`: a new session's composer, which shows the limit pill (nearLimit) in place of the ring. */
export function ComposerMeter(p: { provider?: string; sessionId?: string; home?: boolean }) {
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
            // On credits the turn didn't stop: there's nothing to send again.
            toast(meter()?.usingCredits ? "Account switched. Your next message uses it." : "Account switched. Send your message again to continue.", "info");
        } catch (error) { reportError(error); }
        finally { setSwitching(false); }
    }
    const view = () => contextView(state(), open());
    // The more urgent of the two. With neither known (no context size, no plan
    // report), the ring stays empty and neutral rather than implying a share.
    const urgency = () => Math.max(view().pct ?? 0, meter()?.reached ? 1 : (meter()?.top ?? 0) / 100);
    // Each source keeps its own thresholds: context nears compaction sooner,
    // while a plan only turns red at 90% or once a limit is reached. Past a reached limit on credits nothing is
    // blocked, but it costs: amber, not red (#426).
    const tone = (): "danger" | "warning" | "normal" => {
        const ctx = view().pct ?? 0, plan = meter()?.top ?? 0, credits = Boolean(meter()?.usingCredits);
        if (ctx >= 0.85 || (!credits && (meter()?.reached || plan >= 90))) return "danger";
        if (credits || ctx >= 0.7 || plan >= 80) return "warning";
        return "normal";
    };
    const planLine = () => (meter() ? `${name()} usage: ${meter()!.windows.map(windowLine).join("; ") || "limit reached"}${meter()!.usingCredits ? " · using credits" : ""}` : undefined);
    const label = () => [
        view().pct === undefined ? "Context window: size not known yet" : `Context: ${Math.round(view().pct! * 100)}% used`,
        planLine(),
    ].filter(Boolean).join(". ");
    const near = createMemo(() => (p.home ? nearLimit(meter(), limits(), now()) : undefined));
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
    /** The ring's share as a number inside it; nothing while neither share is known. */
    const shownPct = () => (view().pct === undefined && !meter() ? undefined : Math.round(Math.min(1, urgency()) * 100));
    const bar = (pct: number | undefined, tone?: "danger" | "warning") => (
        <div class={`cc-bar ${tone ?? ""}`} aria-hidden="true">
            <i style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }} />
        </div>
    );
    return (
        <Show when={p.home ? near() : state() || meter()}>
            <button
                ref={btn}
                type="button"
                class={`${p.home ? "ctx-limit" : `ctx-btn tone-${tone()}`} ${open() ? "open" : ""}`}
                aria-haspopup="dialog"
                aria-expanded={open()}
                aria-controls={open() ? panelId : undefined}
                aria-label={p.home ? planLine() : label()}
                onMouseEnter={show}
                onMouseLeave={hide}
                onFocus={() => { if (!restoringFocus) show(); }}
                onBlur={hide}
                onClick={enterPanel}
                onKeyDown={(e) => {
                    if (e.key === "ArrowDown") { e.preventDefault(); enterPanel(); }
                }}
            >
                <Show
                    when={near()}
                    fallback={<>
                        <span class="ctx-ring" aria-hidden="true"><Ring value={urgency()} size={26} stroke={2.5} neutral tone={tone()} /></span>
                        <span class="ctx-num num" aria-hidden="true">{shownPct()}</span>
                    </>}
                >
                    {(n) => <>
                        <Gauge size={14} stroke-width={2} aria-hidden="true" />
                        <b class="num" aria-hidden="true">{n().pct}%</b>
                        <span class="lbl" aria-hidden="true">of {n().window ?? "plan"} limit</span>
                    </>}
                </Show>
            </button>
            <Popover open={open()} anchor={() => btn} onClose={close} placement="top" align="end" width={288} class="ctx-card usage-card">
                <div ref={panel} id={panelId} role="dialog" aria-label="Context and usage" tabIndex={-1}
                    onMouseEnter={cancelClose} onMouseLeave={hide} onFocusIn={cancelClose} onFocusOut={hide}>
                    <section class="usage-section" aria-label="Context window">
                        <h3 class="ctx-label">Context window</h3>
                        <div class="cc-line">
                            <span class="num">{state() ? view().line : "Send a message to measure context usage."}</span>
                            <Show when={view().pct !== undefined}><b class="num">{Math.round(view().pct! * 100)}%</b></Show>
                        </div>
                        <Show when={view().pct !== undefined}>{bar(view().pct! * 100)}</Show>
                        <div class="usage-actions">
                            <span>{app.settings.autoCompact === false ? "Automatic compaction is off." : "Compacts on its own near the limit."}</span>
                            <button class="cbtn" disabled={!state() || (state()?.busy && !state()?.activity?.idle)} onClick={() => {
                                if (!p.sessionId) return;
                                close();
                                void rpc.call("session.compact", { id: p.sessionId }).catch(reportError);
                            }}>Compact now</button>
                        </div>
                    </section>
                    <Show when={meter()}>
                        <section class="usage-section" aria-label="Plan limits">
                            <div class="usage-heading">
                                <h3 class="ctx-label">Plan limits</h3>
                                <span class="usage-account truncate">· {name()}</span>
                            </div>
                            <Show when={meter()?.asOf}><div class="plan-asof">{meter()!.asOf}</div></Show>
                            <Show when={meter()?.reached}><div class={`plan-reached ${meter()!.usingCredits ? "credits" : ""}`}>{meter()!.usingCredits ? "Limit reached · using credits" : "Limit reached"}</div></Show>
                            <For each={meter()?.windows}>{(w) => (
                                <div class="plan-window">
                                    <div class="cc-line"><span>{w.label}</span><b class="num">{w.pct !== undefined ? `${w.pct}%` : w.reached ? "reached" : "—"}</b></div>
                                    {bar(w.reached && w.pct === undefined ? 100 : w.pct, w.reached ? (meter()!.usingCredits ? "warning" : "danger") : undefined)}
                                    <Show when={w.resets}><div class="cc-sub num">Resets {w.resets}</div></Show>
                                </div>
                            )}</For>
                            <Show when={meter()?.resets && !meter()?.windows.some((w) => w.resets === meter()?.resets)}><div class="cc-sub num">Resets {meter()!.resets}</div></Show>
                            <Show when={p.sessionId && meter()?.reached}>
                                <div class="usage-switches">
                                    <Show when={checking()}><span class="plan-account-hint" role="status">Checking accounts…</span></Show>
                                    <For each={alternatives()}>{(a) => <button class="cbtn" disabled={(state()?.busy && !state()?.activity?.idle) || switching()} onClick={() => void switchTo(a.id)} title="Starts a new CLI thread with this conversation; send your message again">Switch to {a.name}</button>}</For>
                                </div>
                            </Show>
                        </section>
                    </Show>
                    <section class="usage-section" aria-label="Spend">
                        <div class="usage-heading"><h3 class="ctx-label">Spend</h3><span class="grow" /><button class="cbtn quiet" onClick={() => { close(); setSettingsTab("usage"); }}>Usage</button></div>
                        <Show when={state()} fallback={<div class="cc-sub">No session yet.</div>}>
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
