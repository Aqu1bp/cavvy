import { createEffect, createMemo, createSignal, createUniqueId, For, on, onCleanup, Show } from "solid-js";
import { planLimitKey, type AccountInfo } from "@shared/protocol";
import { app, handleFor, limitsFor, providersFor, reportError, rpc, rpcFor, servedFor, toast } from "../state/app";
import { contextCardOpen, setContextCardOpen } from "../state/ui";
import { usePane } from "../state/split";
import { now } from "../lib/clock";
import { Gauge, Shrink } from "lucide-solid";
import { limitAlternatives, limitFor, limitName, meterOf, nearLimit, planTitle, resolvedOn } from "../lib/limits";
import { contextView } from "../lib/context";
import { tokens } from "../lib/format";
import { Popover } from "./ui/Popover";
/** `home`: a new session's composer, which shows the limit pill (nearLimit) in place of the ring. */
export function ComposerMeter(p: { provider?: string; sessionId?: string; home?: boolean; /** The model a turn would use (Home's chosen one): a model's limit counts only for the models it covers. */ model?: { id: string; resolvedModel?: string; resolvedFor?: string } }) {
    let btn: HTMLButtonElement | undefined;
    // The focused pane's in a split (/context opens it).
    const pane = usePane();
    const [open, setOpen] = [() => contextCardOpen() && pane.focused(), setContextCardOpen];
    // Another session picked (by a key, say: a click elsewhere already closes it): the card was this one's.
    createEffect(on(() => app.activeId, () => setOpen(false), { defer: true }));
    const panelId = `composer-usage-${createUniqueId()}`;
    let panel: HTMLDivElement | undefined;
    const [accounts, setAccounts] = createSignal<AccountInfo[]>([]);
    const [checking, setChecking] = createSignal(false);
    const [switching, setSwitching] = createSignal(false);
    const state = () => p.sessionId ? handleFor(p.sessionId)?.view.state : undefined;
    const provider = () => state()?.model?.provider ?? p.provider;
    const providerInfo = () => providersFor(p.sessionId).find((x) => x.id === provider());
    const accountId = () => state()?.accounts?.[provider() ?? ""] ?? providerInfo()?.agentCli?.defaultAccount ?? "default";
    // The plan limits of the session's machine's accounts: another machine's session opened here has that machine's.
    const limits = () => limitsFor(p.sessionId)[planLimitKey(provider() ?? "", accountId())];
    const meter = createMemo(() => meterOf(limits(), now()));
    // What stops this session's turns: the plan's limit, or a model's (Fable's) that covers its model. Another
    // model's limit says nothing here.
    // The model by the one its CLI served (this session's, else last on this account), or listed it as for this
    // account; else by its id.
    const model = () => {
        const m = state()?.model ?? p.model;
        if (!m) return undefined;
        const listed = { provider: provider() ?? "", resolvedModel: m.resolvedModel, resolvedFor: m.resolvedFor, id: m.id };
        return { id: m.id, resolved: state()?.servedModel ?? resolvedOn(listed, accountId(), servedFor(p.sessionId)) };
    };
    const stop = createMemo(() => limitFor(meter(), model()));
    const name = () => planTitle(providerInfo(), accountId(), "Plan").title;
    const alternatives = () => limitAlternatives(accounts(), accountId());
    // A limit can arrive before Settings has ever checked account status.
    const refreshKey = createMemo(() => {
        const others = providerInfo()?.agentCli?.accounts?.filter((a) => a.id !== accountId()).map((a) => a.id);
        return p.sessionId && stop() && others?.length ? JSON.stringify([provider(), accountId(), limits()?.at, others]) : undefined;
    });
    createEffect(on(refreshKey, (key) => {
        setAccounts([]);
        setChecking(false);
        if (!key) return;
        let active = true;
        setChecking(true);
        void rpcFor(p.sessionId).call("accounts.list", { provider: provider()!, refresh: true }).then((items) => {
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
            toast(stop()?.credits ? "Account switched. Your next message uses it." : "Account switched. Send your message again.", "info");
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
        const ctx = view().pct ?? 0, credits = Boolean(stop()?.credits);
        if (ctx >= 0.85 || (stop() && !credits)) return "danger";
        if (ctx >= 0.7 || (stop() && credits)) return "warning";
        return "normal";
    };
    // The limit that stops this model, in words: "Fable limit reached, resets Mon 9:00 AM".
    const stopWords = () => {
        const st = stop();
        return st && `${st.window ? `${limitName(st.window)} limit reached` : "Limit reached"}${st.credits ? ", using credits" : ""}${st.resets ? `, resets ${st.resets}` : ""}`;
    };
    const label = () => [
        view().pct === undefined ? "Context window: size not known yet" : `Context: ${Math.round(view().pct! * 100)}% used`,
        stopWords() && `${name()}: ${stopWords()}`,
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
    const busy = () => !state() || Boolean(state()?.busy && !state()?.activity?.idle);
    const near = createMemo(() => (p.home ? nearLimit(meter(), model()) : undefined));
    const width = () => (stop() ? 280 : 256);
    // Unavailable, not disabled: the tooltip still says why, to the pointer and the keyboard.
    const compactTitle = () => (!state() ? "Available in a session" : busy() ? "Available when the reply finishes" : undefined);
    const compactItem = () => (
        <button class="menu-item compact" aria-disabled={busy() || undefined} title={compactTitle()} onClick={() => {
            if (busy() || !p.sessionId) return;
            close();
            void rpc.call("session.compact", { id: p.sessionId }).catch(reportError);
        }}>
            <Shrink size={15} aria-hidden="true" />
            <span>Compact now</span>
        </button>
    );
    // Opened by a click (or ArrowDown, or /context), above what opened it; closed by another, Escape, or a click or
    // focus elsewhere. Closing from inside gives the focus back to the words.
    const close = () => {
        const restore = panel?.contains(document.activeElement);
        setOpen(false);
        if (restore) btn?.focus();
    };
    const openPanel = () => {
        setOpen(true);
        panel?.focus();
    };
    /** The ring's share as a number inside it; nothing while neither share is known. */
    const shownPct = () => (view().pct === undefined ? undefined : Math.round(Math.min(1, urgency()) * 100));
    const ctxTone = () => ((view().pct ?? 0) >= 0.85 ? "danger" : (view().pct ?? 0) >= 0.7 ? "warning" : "");
    // Home has no session: no context to show, nothing to compact or switch. The pill says it all; when it resets is its tooltip.
    // Home: the chosen model's limit reached ("Fable limit reached"), else its fullest window from 80% ("94% of weekly
    // limit"); its words, tooltip and label all of that one.
    if (p.home)
        return (
            <Show
                when={stop()}
                fallback={
                    <Show when={near()}>
                        {(n) => (
                            <span class="ctx-limit" role="status" aria-label={`${name()}: ${n().pct}% of ${n().window ?? "plan"} limit${n().resets ? `, resets ${n().resets}` : ""}`} title={n().resets ? `Resets ${n().resets}` : undefined}>
                                <Gauge size={14} stroke-width={2} aria-hidden="true" />
                                <b class="num" aria-hidden="true">{n().pct}%</b>
                                <span class="lbl" aria-hidden="true">of {n().window ?? "plan"} limit</span>
                            </span>
                        )}
                    </Show>
                }
            >
                {(st) => (
                    <span class="ctx-limit" role="status" aria-label={`${name()}: ${stopWords()}`} title={st().resets ? `Resets ${st().resets}` : undefined}>
                        <Gauge size={14} stroke-width={2} aria-hidden="true" />
                        <b aria-hidden="true">{st().window ? limitName(st().window!) : "Plan"}</b>
                        <span class="lbl" aria-hidden="true">limit reached</span>
                    </span>
                )}
            </Show>
        );
    return (
        <Show when={state() || meter()}>
            <button
                ref={btn}
                type="button"
                class={`ctx-btn tone-${tone()} ${open() ? "open" : ""}`}
                aria-haspopup="dialog"
                aria-expanded={open()}
                aria-controls={open() ? panelId : undefined}
                aria-label={label()}
                onClick={() => (open() ? close() : openPanel())}
                onKeyDown={(e) => {
                    if (e.key === "ArrowDown") { e.preventDefault(); openPanel(); }
                }}
            >
                {/* Under the composer, in words: "4% context". */}
                <span class="ctx-num num" aria-hidden="true">{shownPct() === undefined ? "Context" : `${shownPct()}% context`}</span>
            </button>
            <Popover open={open()} anchor={() => btn} onClose={close} placement="top" align="end" width={width()} class="ctx-card">
                <div ref={panel} id={panelId} class="cx" role="dialog" aria-label="Context and session" tabIndex={-1}
                    onFocusOut={(e) => {
                        const to = e.relatedTarget as Node | null;
                        if (to && !panel?.contains(to) && to !== btn) close();
                    }}>
                    {/* A reached limit stops this session, so it's the one plan state said here, with the accounts to switch to. */}
                    <Show when={stop()}>{(st) => (
                        <section class={`cx-limit ${st().credits ? "credits" : ""}`} aria-label="Plan limit">
                            <Gauge size={15} aria-hidden="true" />
                            <div>
                                {/* Named by the limit that stops this session, the one that lifts last: "Fable limit reached", "Weekly limit reached". */}
                                <b>{`${st().window ? `${limitName(st().window!)} limit reached` : "Limit reached"}${st().credits ? ", using credits" : ""}`}</b>
                                <span>{name()}.<Show when={st().resets}>{(r) => <> Resets {r()}.</>}</Show></span>
                                <Show when={p.sessionId}>
                                    <div class="cx-switches">
                                        <Show when={checking()}><span class="plan-account-hint" role="status">Checking accounts…</span></Show>
                                        <For each={alternatives()}>{(a) => <button class="cbtn" disabled={busy() || switching()} onClick={() => void switchTo(a.id)} title="Send your message again after switching">Use {a.name} account</button>}</For>
                                    </div>
                                </Show>
                            </div>
                        </section>
                    )}</Show>
                    {/* What the context holds, the bar under it, then the one thing to do. (What the session has used is
                        Settings → Usage's.) */}
                    <div class="cx-info">
                        <div class="cx-head">
                            <h3>Context</h3>
                            <span class="num" title={view().pct !== undefined ? fullWhy() : undefined}>
                                {state() ? view().line : "Send a message first"}{view().pct !== undefined && autoOff() ? ", auto-compact off" : ""}
                            </span>
                        </div>
                        <Show when={view().pct !== undefined}>
                            <div class={`cx-bar ${ctxTone()}`} aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, view().pct! * 100))}%` }} /></div>
                        </Show>
                    </div>
                    <div class="menu-sep" />
                    {compactItem()}
                </div>
            </Popover>
        </Show>
    );
}
