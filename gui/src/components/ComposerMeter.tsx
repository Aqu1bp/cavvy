import { createEffect, createMemo, createUniqueId, on, Show } from "solid-js";
import { planLimitKey } from "@shared/protocol";
import { app, handleFor, limitsFor, providersFor, reportError, rpc, servedFor } from "../state/app";
import { contextCardOpen, setContextCardOpen } from "../state/ui";
import { keysHere, usePane } from "../state/split";
import { now } from "../lib/clock";
import { limitFor, limitName, meterOf, nearLimit, planTitle, resolvedOn } from "../lib/limits";
import { contextView } from "../lib/context";
import { tokens } from "../lib/format";
import { Popover } from "./ui/Popover";
/** `home`: a new session's composer, which shows the limit pill (nearLimit) in place of the ring. */
export function ComposerMeter(p: { provider?: string; sessionId?: string; home?: boolean; /** A side chat: nothing until there's a figure (no lone "Context"). */ aside?: boolean; /** The model a turn would use (Home's chosen one): a model's limit counts only for the models it covers. */ model?: { id: string; resolvedModel?: string; resolvedFor?: string } }) {
    let btn: HTMLButtonElement | undefined;
    // The focused pane's in a split (/context opens it).
    const pane = usePane();
    const [open, setOpen] = [() => contextCardOpen() && keysHere(pane), setContextCardOpen];
    // Another session picked (by a key, say: a click elsewhere already closes it): the card was this one's.
    createEffect(on(() => app.activeId, () => setOpen(false), { defer: true }));
    const panelId = `composer-usage-${createUniqueId()}`;
    let panel: HTMLDivElement | undefined;
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
    const view = () => contextView(state(), open());
    // The context alone, measured to where it compacts: plan limits are in the rail's footer and Settings → Usage, a
    // reached one in the conversation's card (with the accounts to switch to). With no size known it stays neutral
    // rather than implying a share.
    const urgency = () => view().pct ?? 0;
    const tone = (): "danger" | "warning" | "normal" => {
        const ctx = view().pct ?? 0;
        return ctx >= 0.85 ? "danger" : ctx >= 0.7 ? "warning" : "normal";
    };
    // The limit that stops this model, in words: "Fable limit reached, resets Mon 9:00 AM".
    const stopWords = () => {
        const st = stop();
        return st && `${st.window ? `${limitName(st.window)} limit reached` : "Limit reached"}${st.credits ? ", using credits" : ""}${st.resets ? `, resets ${st.resets}` : ""}`;
    };
    const label = () => (view().pct === undefined ? "Context: size unknown" : `Context: ${Math.round(view().pct! * 100)}% used`);
    const cli = () => Boolean(providerInfo()?.agentCli);
    const autoOff = () => !cli() && app.settings.autoCompact === false;
    /** Where "full" comes from, on the numbers' tooltip. */
    const fullWhy = () => {
        const v = view(), whole = v.window ? ` The model holds ${tokens(v.window)}.` : "";
        if (autoOff()) return `Auto-compact is off.${whole}`;
        if (cli()) return v.early ? `${providerInfo()?.name ?? "The CLI"} compacts at ${tokens(v.full!)}, your setting.${whole}` : `${providerInfo()?.name ?? "The CLI"} decides when to compact.${whole}`;
        return `Compacts at ${tokens(v.full!)}.${whole}`;
    };
    const busy = () => !state() || Boolean(state()?.busy && !state()?.activity?.idle);
    const near = createMemo(() => (p.home ? nearLimit(meter(), model()) : undefined));
    const width = 280;
    // Unavailable, not disabled: the tooltip still says why, to the pointer and the keyboard.
    const compactTitle = () => (!state() ? "Available in a session" : busy() ? "Available when the reply finishes" : undefined);
    const compactItem = () => (
        <button class="btn btn-sm ctx-compact" aria-disabled={busy() || undefined} title={compactTitle()} onClick={() => {
            if (busy() || !p.sessionId) return;
            close();
            void rpc.call("session.compact", { id: p.sessionId }).catch(reportError);
        }}>Compact now</button>
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
                            <span class="meter meter-static num" data-tone={n().pct >= 90 ? "red" : n().pct >= 70 ? "amber" : undefined} role="status" aria-label={`${name()}: ${n().pct}% of ${n().window ?? "plan"} limit${n().resets ? `, resets ${n().resets}` : ""}`} title={n().resets ? `Resets ${n().resets}` : undefined}>
                                <span aria-hidden="true">{n().pct}% of {n().window ?? "plan"} limit</span>
                            </span>
                        )}
                    </Show>
                }
            >
                {(st) => (
                    <span class="meter meter-static" data-tone="amber" role="status" aria-label={`${name()}: ${stopWords()}`} title={st().resets ? `Resets ${st().resets}` : undefined}>
                        <span aria-hidden="true">{st().window ? limitName(st().window!) : "Plan"} limit reached</span>
                    </span>
                )}
            </Show>
        );
    return (
        <Show when={(state() || meter()) && !(p.aside && shownPct() === undefined)}>
            <button
                ref={btn}
                type="button"
                class={`meter tone-${tone()}`}
                data-tone={tone() === "danger" ? "red" : tone() === "warning" ? "amber" : undefined}
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
                <span class="num" aria-hidden="true">{shownPct() === undefined ? "Context" : `${shownPct()}% context`}</span>
            </button>
            <Popover open={open()} anchor={() => btn} onClose={close} placement="top" align="start" offset={6} width={width} class="menu ctx-card">
                <div ref={panel} id={panelId} style={{ outline: "none" }} role="dialog" aria-label="Context" tabIndex={-1}
                    onFocusOut={(e) => {
                        const to = e.relatedTarget as Node | null;
                        if (to && !panel?.contains(to) && to !== btn) close();
                    }}>
                    {/* What the context holds, the bar under it, then the one thing to do. (Plan limits: the rail's foot and
                        Settings → Usage; a reached one, with other accounts to use, is the conversation's limit card.) */}
                    <section class="ctx-block">
                        <div class="ctx-line">
                            <span class="ctx-name">Context</span>
                            <span class="ctx-dim num" title={view().pct !== undefined ? fullWhy() : undefined}>
                                {state() ? view().line : "Send a message first"}{view().pct !== undefined && autoOff() ? ", auto-compact off" : ""}
                            </span>
                        </div>
                        <Show when={view().pct !== undefined}>
                            <span class={`bar ${ctxTone()}`} data-tone={ctxTone() === "danger" ? "red" : ctxTone() === "warning" ? "amber" : undefined} aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, view().pct! * 100))}%` }} /></span>
                        </Show>
                        {compactItem()}
                    </section>
                </div>
            </Popover>
        </Show>
    );
}
