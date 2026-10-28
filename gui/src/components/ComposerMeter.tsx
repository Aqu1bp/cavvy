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
            toast(meter()?.usingCredits ? "Account switched. Your next message uses it." : "Account switched. Send your message again.", "info");
        } catch (error) { reportError(error); }
        finally { setSwitching(false); }
    }
    const view = () => contextView(state(), open());
    // The ring is the context, measured to where it compacts: plan limits are in the rail's footer. With no
    // size known it stays empty and neutral rather than implying a share.
    const urgency = () => view().pct ?? 0;
    // A reached limit is the one plan state shown here, since it stops this session: red while it blocks,
    // amber past it on credits, where nothing is blocked but it costs (#426).
    const tone = (): "danger" | "warning" | "normal" => {
        const ctx = view().pct ?? 0, credits = Boolean(meter()?.usingCredits);
        if (ctx >= 0.85 || (meter()?.reached && !credits)) return "danger";
        if (ctx >= 0.7 || (meter()?.reached && credits)) return "warning";
        return "normal";
    };
    const planLine = () => (meter() ? `${name()} usage: ${meter()!.windows.map(windowLine).join("; ") || "limit reached"}${meter()!.usingCredits ? " · using credits" : ""}` : undefined);
    const label = () => [
        view().pct === undefined ? "Context window: size not known yet" : `Context: ${Math.round(view().pct! * 100)}% used`,
        meter()?.reached ? planLine() : undefined,
    ].filter(Boolean).join(". ");
    const cli = () => Boolean(providerInfo()?.agentCli);
    const autoOff = () => !cli() && app.settings.autoCompact === false;
    /** Where "full" comes from, on the numbers' tooltip. */
    const fullWhy = () => {
        const v = view(), whole = v.window ? ` The model holds up to ${tokens(v.window)}.` : "";
        if (autoOff()) return `Automatic compaction is off, so this is the model's whole window.`;
        if (cli()) return v.early ? `${providerInfo()?.name ?? "The CLI"} compacts at ${tokens(v.full!)}, your auto-compact setting.${whole}` : `${providerInfo()?.name ?? "The CLI"} decides when to compact.${whole}`;
        return `Compacts on its own at ${tokens(v.full!)}, leaving room for the answer.${whole}`;
    };
    const reachedWindow = () => meter()?.windows.find((w) => w.reached);
    const busy = () => !state() || Boolean(state()?.busy && !state()?.activity?.idle);
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
    const shownPct = () => (view().pct === undefined ? undefined : Math.round(Math.min(1, urgency()) * 100));
    const ctxTone = () => ((view().pct ?? 0) >= 0.85 ? "danger" : (view().pct ?? 0) >= 0.7 ? "warning" : "");
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
            <Popover open={open()} anchor={() => btn} onClose={close} placement="top" align="end" width={280} class="ctx-card">
                <div ref={panel} id={panelId} class="cx" role="dialog" aria-label="Context and session" tabIndex={-1}
                    onMouseEnter={cancelClose} onMouseLeave={hide} onFocusIn={cancelClose} onFocusOut={hide}>
                    {/* A reached limit stops this session, so it's the one plan state said here, with the accounts to switch to. */}
                    <Show when={meter()?.reached}>
                        <section class={`cx-limit ${meter()!.usingCredits ? "credits" : ""}`} aria-label="Plan limit">
                            <Gauge size={15} aria-hidden="true" />
                            <div>
                                <b>{meter()!.usingCredits ? "Limit reached, using credits" : "Limit reached"}</b>
                                <span>{name()}{reachedWindow() ? `, ${reachedWindow()!.label.replace(/^(Weekly|Primary|Secondary)\b/, (x) => x.toLowerCase())} limit` : ""}.<Show when={meter()!.resets ?? reachedWindow()?.resets}>{(r) => <> Resets {r()}.</>}</Show></span>
                                <Show when={p.sessionId}>
                                    <div class="cx-switches">
                                        <Show when={checking()}><span class="plan-account-hint" role="status">Checking accounts…</span></Show>
                                        <For each={alternatives()}>{(a) => <button class="cbtn" disabled={busy() || switching()} onClick={() => void switchTo(a.id)} title="Send your message again after switching">Switch to {a.name}</button>}</For>
                                    </div>
                                </Show>
                            </div>
                        </section>
                    </Show>
                    <div class="cx-head">
                        <h3>Context</h3>
                        <Show when={view().pct !== undefined}><span class={`cx-pct num ${ctxTone()}`}>{Math.round(view().pct! * 100)}%</span></Show>
                    </div>
                    <Show when={view().pct !== undefined}>
                        <div class={`cx-bar ${ctxTone()}`} aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, view().pct! * 100))}%` }} /></div>
                    </Show>
                    <div class="cx-line">
                        <span class="num" title={view().pct !== undefined ? fullWhy() : undefined}>{state() ? view().line : "Send a message to measure it"}{view().pct !== undefined && autoOff() ? ", auto-compact off" : ""}</span>
                        {/* Unavailable, not disabled: its tooltip still says why, to the pointer and the keyboard. */}
                        <button class="cx-link" aria-disabled={busy() || undefined} title={!state() ? "Available in a session" : busy() ? "Available when the reply finishes" : "Summarize earlier turns to free up room"} onClick={() => {
                            if (busy() || !p.sessionId) return;
                            close();
                            void rpc.call("session.compact", { id: p.sessionId }).catch(reportError);
                        }}>Compact now</button>
                    </div>
                    <div class="cx-foot">
                        <span class="num">
                            <Show when={state()} fallback="No session yet">
                                {tokens(state()?.tokensIn ?? 0)} in, {tokens(state()?.tokensOut ?? 0)} out
                                <Show when={(state()?.cost ?? 0) > 0 || state()?.costUnknown}>
                                    <span title={state()?.costUnknown ? "Leaves out models with no known price" : undefined}>, {cost(state()?.cost ?? 0, state()?.costUnknown)}</span>
                                </Show>
                            </Show>
                        </span>
                        <button class="cx-link" onClick={() => { close(); setSettingsTab("usage"); }}>Usage</button>
                    </div>
                </div>
            </Popover>
        </Show>
    );
}
