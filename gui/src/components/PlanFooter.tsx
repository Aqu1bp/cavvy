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
        <Show when={plans().length} fallback={<span class="grow" />}>
            <PlanRow plans={plans()} check={() => void checkLimits(app.activeId, plans().map((plan) => ({ provider: plan.provider, accountId: plan.accountId })))} />
        </Show>
    );
}

/** A plan's mark inside a ring, filled as far as its fullest window: all the way at a limit, not at all before a report. */
function PlanGauge(p: { plan: RailPlan }) {
    const fill = () => (p.plan.reached ? 100 : Math.max(0, Math.min(100, p.plan.pct ?? 0)));
    return (
        <span class="pl-g">
            <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle class="pl-track" cx="10" cy="10" r="9" />
                <Show when={fill() > 0}>
                    {/* A sliver at least, so 1% still shows. */}
                    <circle class="pl-arc" cx="10" cy="10" r="9" pathLength="100" stroke-dasharray={`${Math.max(4, fill())} 100`} transform="rotate(-90 10 10)" />
                </Show>
            </svg>
            <ProviderIcon id={p.plan.provider} name={p.plan.name} size={11} />
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
        const chips = [...row.querySelectorAll<HTMLElement>(".pl:not(.more)")];
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
                    <span class={`pl ${plan.reached ? "danger" : plan.tone} ${plan.stale ? "stale" : ""}`} hidden={hidden(i())} title={plan.detail}>
                        <PlanGauge plan={plan} />
                        <Show when={plan.pct !== undefined}>
                            <span class="pl-v">
                                {plan.pct}<small>%</small>
                                <Show when={solo() && !bare() && (plan.reached ? plan.lifts && `· resets ${plan.lifts}` : plan.window?.toLowerCase())}>{(w) => <span class="pl-w"> {w()}</span>}</Show>
                            </span>
                        </Show>
                    </span>
                )}</For>
                {/* Always there, to be measured: out of the row (and unseen) while nothing is folded. */}
                <span ref={more} class={`pl more ${folded() ? "" : "measure"}`} aria-hidden={folded() ? undefined : "true"}>+{Math.max(1, folded())}</span>
            </button>
            {/* Inside the rail, edge to edge with its footer (and the rows above), however wide the rail is. */}
            <Menu kind="dialog" label="Plan usage" open={open()} anchor={() => row} span={() => row?.closest<HTMLElement>(".side-foot") ?? undefined} onClose={() => setOpen(false)} placement="top" class="plans-card">
                <div class="menu-label">Plan usage</div>
                <PlanCardPlans plans={p.plans} />
                <div class="menu-sep" />
                <button class="menu-item compact" onClick={() => (setOpen(false), setSettingsTab("usage"))}>Usage and accounts…</button>
            </Menu>
        </>
    );
}

/** Mounted as the card opens: the order it opened in holds while it's open, though a check moves the newest report first. */
export function PlanCardPlans(p: { plans: RailPlan[] }) {
    const held = untrack(() => p.plans.map(planKey));
    return (
        <For each={heldOrder(p.plans, held)}>{(plan) => (
            <div class="pu-plan">
                <div class="pu-h" title={plan.detail}>
                    <ProviderIcon id={plan.provider} name={plan.name} size={14} />
                    <span class="truncate">{plan.name}</span>
                    <Show when={plan.asOf}>{(at) => <span class="pu-asof">{at()}</span>}</Show>
                </div>
                <Show when={plan.note}>{(n) => <div class="pu-note">{n()}</div>}</Show>
                <For each={plan.windows} fallback={<div class="pu-w none">Usage shows after a turn</div>}>{(w) => (
                    <div class={`pu-w ${w.tone}`}>
                        <span class="truncate">{w.label}</span>
                        <span class="pu-bar" aria-hidden="true"><i style={{ width: `${w.reached ? 100 : w.pct ?? 0}%` }} /></span>
                        <b>{w.reached ? "Full" : w.pct !== undefined ? `${w.pct}%` : "–"}</b>
                        <Show when={w.reset ? `Reset ${w.reset}` : w.resets && `Resets ${w.resets}`}>{(r) => <span class="pu-r" title={r()}>{r()}</span>}</Show>
                    </div>
                )}</For>
            </div>
        )}</For>
    );
}
