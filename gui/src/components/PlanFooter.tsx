// The rail's footer of plans: a chip per plan signed in, and the card each opens with every window. Loaded a moment
// after the window (Sidebar.tsx), with the plans' computations (lib/rail-plans.ts), not with it.

import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { app, checkLimits, handleFor, limitsFor, providersFor } from "../state/app";
import { setSettingsTab } from "../state/ui";
import { prefs } from "../state/prefs";
import { now } from "../lib/clock";
import { foldOrder, planFit, railFoot, type RailPlan } from "../lib/rail-plans";
import { heldOrder, planKey } from "../lib/plan-card";
import { Menu } from "./ui/Menu";
import { ProviderIcon } from "./ui/ProviderIcon";

/** The plans signed in, the session in view's first, else the one used last (`recent`: providers by use, latest first). */
export function PlanFooter(p: { recent: () => string[] }) {
    // The signed-in plans (Claude Code, Codex): the session in view's first, else the one used last.
    const plans = createMemo(() => {
        const st = handleFor(app.activeId)?.view.state;
        const provider = st?.model?.provider;
        // The session's machine's plans and limits: its account ("Default" there) isn't this computer's of that name.
        return railFoot({ limits: limitsFor(app.activeId), providers: providersFor(app.activeId), provider, account: provider ? st?.accounts?.[provider] : undefined, recent: p.recent(), now: now() });
    });
    return (
        <Show when={plans().length}>
            <PlanRow plans={plans()} check={() => void checkLimits(app.activeId, plans().map((plan) => ({ provider: plan.provider, accountId: plan.accountId })))} />
        </Show>
    );
}

const toneOf = (x: { reached?: boolean; tone?: string }) => (x.reached || x.tone === "danger" ? "red" : x.tone === "warn" ? "amber" : undefined);

/** A plan's mark inside a ring, filled as far as its fullest window: all the way at a limit, not at all before a report. */
function PlanGauge(p: { plan: RailPlan }) {
    const fill = () => (p.plan.reached ? 100 : Math.max(0, Math.min(100, p.plan.pct ?? 0)));
    return (
        <span class="ring" data-tone={toneOf(p.plan)} style={{ width: "calc(22 * var(--sp))", height: "calc(22 * var(--sp))" }}>
            <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
                <circle class="ring-track" cx="11" cy="11" r="9.5" fill="none" stroke-width="1.5" />
                <Show when={fill() > 0}>
                    {/* A sliver at least, so 1% still shows. */}
                    <circle class="ring-value" cx="11" cy="11" r="9.5" fill="none" stroke-width="1.5" stroke-linecap="round" pathLength="100" stroke-dasharray={`${Math.max(4, fill())} 100`} transform="rotate(-90 11 11)" />
                </Show>
            </svg>
            <span class="ring-inner"><ProviderIcon id={p.plan.provider} name={p.plan.name} size={11} /></span>
        </span>
    );
}

/**
 * The plans' usage, beside Settings: one row however many there are. A gauge per
 * plan, its mark in a ring that fills as its fullest window does, then the
 * figure: the same size in every state, the ring and figure turning amber, then
 * red, near a limit. Nothing reported yet: an empty ring and no figure (PlanGauge).
 * The mark names the plan (the tooltip and card spell it out); a plan on its
 * own adds the window where the whole of it fits. Short of room (a narrow or floating rail), the % signs
 * go first; only then do chips fold into "+N", the plain ones first
 * (lib/rail.ts planFit). The row opens every window's detail.
 */
function PlanRow(p: { plans: RailPlan[]; check: () => void }) {
    const [open, setOpen] = createSignal(false);
    const [tight, setTight] = createSignal(false);
    const [folded, setFolded] = createSignal(0);
    /** A plan on its own without its window: the whole of it didn't fit (never "resets 2:4"). */
    const [bare, setBare] = createSignal(false);
    let row: HTMLButtonElement | undefined;
    let more: HTMLSpanElement | undefined;
    const solo = () => p.plans.length === 1;
    const order = createMemo(() => foldOrder(p.plans));
    const hidden = (i: number) => order().indexOf(i) < folded();
    // Measures the chips as they are and tight, with none folded, then settles on the fit
    // (outside Solid's updates each change is in the DOM at once, so it can be read back).
    const fit = () => {
        if (!row) return;
        batch(() => (setFolded(0), setTight(false), setBare(false)));
        if (p.plans.length < 2) return setBare(row.scrollWidth > row.clientWidth + 0.5);
        const chips = [...row.querySelectorAll<HTMLElement>(".plan-chip:not(.more)")];
        const widths = () => chips.map((c) => c.getBoundingClientRect().width);
        const gap = () => parseFloat(getComputedStyle(row!).columnGap) || 0;
        const style = getComputedStyle(row);
        const room = row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const normal = widths();
        const normalGap = gap();
        setTight(true);
        const f = planFit({ room, normal, tight: widths(), gap: normalGap, tightGap: gap(), more: more?.getBoundingClientRect().width ?? 0, order: order() });
        batch(() => (setTight(f.tight), setFolded(f.folded)));
    };
    // The rail's width changes it (dragging its edge, the drawer); so do the text size and what the
    // chips say, once they're drawn.
    onMount(() => {
        const ro = new ResizeObserver(() => fit());
        ro.observe(row!.parentElement ?? row!);
        onCleanup(() => ro.disconnect());
    });
    createEffect(on(() => `${prefs.fontSize} ${p.plans.map((plan) => `${plan.provider} ${plan.pct} ${plan.tone} ${plan.reached} ${plan.window} ${plan.lifts}`).join()}`, () => queueMicrotask(fit), { defer: true }));
    const label = () => `Plan usage. ${p.plans.map((plan) => `${plan.name}: ${plan.brief}`).join(". ")}`;
    return (
        <>
            <button ref={row} class={`plans ${tight() ? "tight" : ""}`} aria-label={label()} aria-haspopup="dialog" aria-expanded={open()} onClick={() => (!open() && p.check(), setOpen(!open()))}>
                <For each={p.plans}>{(plan, i) => (
                    <span class={`plan-chip ${plan.stale ? "stale" : ""}`} hidden={hidden(i())} title={plan.detail}>
                        <PlanGauge plan={plan} />
                        <Show when={plan.pct !== undefined}>
                            <span class="plan-pct num" data-tone={toneOf(plan)}>
                                {plan.pct}<small>%</small>
                            </span>
                        </Show>
                        <Show when={solo() && !bare() && (plan.reached ? plan.lifts && `· resets ${plan.lifts}` : plan.window && `· ${plan.window.toLowerCase()}`)}>{(w) => <span class="plan-reset">{w()}</span>}</Show>
                    </span>
                )}</For>
                {/* Always there, to be measured: out of the row (and unseen) while nothing is folded. */}
                <span ref={more} class={`plan-chip dim more ${folded() ? "" : "measure"}`} aria-hidden={folded() ? undefined : "true"}>+{Math.max(1, folded())}</span>
            </button>
            <Menu kind="dialog" label="Plan usage" open={open()} anchor={() => row} onClose={() => setOpen(false)} placement="top" align="start" offset={8} width={300} class="menu plan-card">
                <div class="plan-card-title">Plan usage</div>
                <PlanCardPlans plans={p.plans} />
                <button class="link-btn plan-link" onClick={() => (setOpen(false), setSettingsTab("usage"))}>Usage and accounts…</button>
            </Menu>
        </>
    );
}

/** Mounted as the card opens: the order it opened in holds while it's open, though a check moves the newest report first. */
export function PlanCardPlans(p: { plans: RailPlan[] }) {
    const held = untrack(() => p.plans.map(planKey));
    return (
        <For each={heldOrder(p.plans, held)}>{(plan) => (
            <section class="plan-block">
                <header class="plan-head" title={plan.detail}>
                    <ProviderIcon id={plan.provider} name={plan.name} size={14} />
                    <span class="plan-name">{plan.name}</span>
                    <Show when={plan.asOf}>{(at) => <span class="plan-asof">{at()}</span>}</Show>
                </header>
                <Show when={plan.note}>{(n) => <p class="plan-note">{n()}</p>}</Show>
                <For each={plan.windows} fallback={<p class="plan-empty">Usage shows after a turn</p>}>{(w) => (
                    <div class="plan-row">
                        <span class="plan-label">{w.label}</span>
                        <span class="bar" data-tone={toneOf(w)} aria-hidden="true"><i style={{ width: `${w.reached ? 100 : w.pct ?? 0}%` }} /></span>
                        <span class="plan-value num" data-tone={toneOf(w)}>{w.reached ? "Full" : w.pct !== undefined ? `${w.pct}%` : "–"}</span>
                        <Show when={w.reset ? `Reset ${w.reset}` : w.resets && `Resets ${w.resets}`}>{(r) => <span class="plan-resets" title={r()}>{r()}</span>}</Show>
                    </div>
                )}</For>
            </section>
        )}</For>
    );
}
