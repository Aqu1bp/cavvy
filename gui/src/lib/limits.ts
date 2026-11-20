// What the plan meter and the Usage view say: plain functions of the
// server's data and the time (no DOM, so they're tested from test/).

import type { AccountInfo, PlanLimits, ProviderInfo, UsageRow, UsageSummary } from "@shared/protocol";
import { covers, planNow, planTitle as corePlanTitle, STALE_MS } from "@shared/plan-meter";

export { STALE_MS };

export interface MeterWindow {
    label: string;
    /** 0-100, or undefined when the CLI didn't say or the window has reset since it did. */
    pct?: number;
    /** When it resets: "4:40 PM", "Mon"; with the time and how long when it's reached ("Mon 9:00 AM, in 2d 3h"). */
    resets?: string;
    /** When it reset, once that has passed since the report ("9:52 AM", "Wed"): usage started again then. */
    reset?: string;
    /** When it resets (ms), when known: which of several lifts last. */
    resetsAt?: number;
    reached: boolean;
    /** The model family it counts, for a window of some models' ("fable"): reached, it stops those only. */
    scope?: string;
    /** Reached, but carried on credits: a model limit's own. */
    credits?: boolean;
}

export interface Meter {
    windows: MeterWindow[];
    /** A limit of the whole plan is reached now (and hasn't reset since). */
    reached: boolean;
    /** Windows of some models reached now ("Weekly Fable"): those models are stopped, the plan's others aren't. */
    partly: MeterWindow[];
    /** Reached with no window to show for it (a bare rejection): the whole plan's, for every model. */
    planStop: boolean;
    /** Reached, but turns go on past it, billed to credits (Codex) or extra usage (Claude Code). */
    usingCredits: boolean;
    /** When a reached limit resets, as a phrase ("4:40 PM, in 2h 5m"). */
    resets?: string;
    /** "as of 2:02 PM" when the numbers may be out of date. */
    asOf?: string;
    /** When the oldest figure shown was reported (ms). */
    reportedAt: number;
    /** The fullest window that hasn't reset since the report, for the compact chip. */
    top?: MeterWindow;
}

function clock(ms: number): string {
    return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function sameDay(a: number, b: number): boolean {
    return new Date(a).toDateString() === new Date(b).toDateString();
}

/** "2h 5m", "3d 4h", "12m". */
export function until(ms: number, now: number): string {
    const mins = Math.max(1, Math.round((ms - now) / 60_000));
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    if (h < 24) return mins % 60 ? `${h}h ${mins % 60}m` : `${h}h`;
    const d = Math.floor(h / 24);
    return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/**
 * A time beside its verb ("resets", "reset", "as of"): today's as a time, another day less than a week either side
 * by weekday, else by date; `exact` adds the time, and how long until it when it's ahead. A weekday names
 * one day only within that span, so a past time never reads as the next one.
 */
export function resetLabel(ms: number, now: number, exact = false): string {
    const d = new Date(ms);
    const day = sameDay(ms, now) ? "" : Math.abs(ms - now) < 6.5 * 86_400_000 ? d.toLocaleDateString(undefined, { weekday: "short" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    if (!exact) return day || clock(ms);
    return `${day ? `${day} ` : ""}${clock(ms)}${ms > now ? `, in ${until(ms, now)}` : ""}`;
}

export function meterOf(l: PlanLimits | undefined, now: number): Meter | undefined {
    const p = planNow(l, now);
    if (!l || !p) return undefined;
    const windows = p.windows.map((w): MeterWindow => ({
        label: w.label,
        pct: w.pct,
        reached: w.reached,
        ...(w.resetsAt === undefined ? {} : w.reset ? { reset: resetLabel(w.resetsAt, now) } : { resets: resetLabel(w.resetsAt, now, w.reached) }),
        ...(w.resetsAt === undefined ? {} : { resetsAt: w.resetsAt }),
        ...(w.scope ? { scope: w.scope } : {}),
        ...(w.credits === undefined ? {} : { credits: w.credits }),
    }));
    return {
        windows,
        reached: p.reached,
        partly: p.partly.map((w) => windows[p.windows.indexOf(w)]!),
        planStop: p.planStop,
        usingCredits: p.usingCredits,
        resets: p.liftsAt ? resetLabel(p.liftsAt, now, true) : undefined,
        asOf: p.stale ? `as of ${sameDay(p.reportedAt, now) ? clock(p.reportedAt) : resetLabel(p.reportedAt, now, true)}` : undefined,
        reportedAt: p.reportedAt,
        top: p.top ? windows[p.windows.indexOf(p.top)] : undefined,
    };
}

/** How near its limit a plan (or one of its windows) is: amber from 75%, red from 90% and at the limit. */
export type PlanTone = "normal" | "warn" | "danger";

export function planTone(pct: number | undefined, reached = false): PlanTone {
    if (reached || (pct ?? 0) >= 90) return "danger";
    return (pct ?? 0) >= 75 ? "warn" : "normal";
}

/** A window's tint, wherever it's drawn (the rail's card, Usage's bars): a model's limit reached (scope) is amber, as its plan is, since the plan's other models go on. */
export function windowTone(w: Pick<MeterWindow, "pct" | "reached" | "scope">): PlanTone {
    return w.reached && w.scope ? "warn" : planTone(w.pct === undefined ? undefined : Math.min(100, w.pct), w.reached);
}

/** "5-hour 62% · resets 4:40 PM", "5-hour · reset 9:52 AM" */
export function windowLine(w: MeterWindow): string {
    if (w.reset) return `${w.label} · reset ${w.reset}`;
    return [w.label, w.pct !== undefined ? `${w.pct}%` : undefined, w.reached ? "reached" : undefined].filter(Boolean).join(" ") + (w.resets ? ` · resets ${w.resets}` : "");
}

/** "5-hour 62%", "5-hour reset 9:52 AM": a window in a short list (a tooltip's); nothing when there's no figure. */
export function windowShort(w: MeterWindow): string | undefined {
    if (w.reset) return `${w.label} reset ${w.reset}`;
    return w.pct !== undefined ? `${w.label} ${w.pct}%` : undefined;
}

/**
 * "40%, resets 4:40 PM": a window's bar caption in Usage (its name is beside it). A reached one isn't called reached
 * again (the plan's banner says so), only when it resets; "Reached" only when it's all there is to say. One that
 * has reset since the report says when: "Reset 9:52 AM".
 */
export function windowCaption(w: Pick<MeterWindow, "pct" | "reached" | "resets" | "reset">): string {
    if (w.reset) return `Reset ${w.reset}`;
    if (w.pct === undefined && w.reached) return w.resets ? `Resets ${w.resets}` : "Reached";
    return (w.pct !== undefined ? `${w.pct}%` : "Not reported") + (w.resets ? `, resets ${w.resets}` : "");
}

/** Home's limit pill, and an account's badge in the model picker (nearLimit). */
export interface NearLimit {
    pct: number;
    /** A limit is reached now (the shared meter's: a window said to be allowed at 100% isn't). */
    reached: boolean;
    window?: string;
    resets?: string;
    /** The model family of the window named, when it's a reached limit of some models only. */
    scope?: string;
}

/**
 * Home's limit pill (for the model chosen there), and an account's badge in the model picker (for no model in
 * particular): the plan's fullest window once it's at 80% or more, or a limit is reached ("94%",
 * "5-hour"), and when it resets. Below that Home shows nothing there: a new session has no context to put
 * in a ring. A window that has reset since the report has no figure (meterOf), so it's never the one named.
 */
export function nearLimit(m: Meter | undefined, model?: { id: string; resolved?: string }): NearLimit | undefined {
    if (!m) return undefined;
    // The plan's stop with no window to show (a bare rejection): every model's, until it lifts.
    if (m.planStop) return { pct: 100, reached: true, ...(m.resets ? { resets: m.resets } : {}) };
    // The limits that apply to this model (no model: the account's own, its plan's windows only).
    const live = model ? applies(m, model) : m.windows.filter((w) => !w.reset && !w.scope);
    const reached = live.filter((w) => w.reached);
    const named = (w: MeterWindow) => w.label.replace(/^(Weekly|Primary|Secondary)\b/, (x) => x.toLowerCase());
    // At a limit: the one that lifts last, full, whatever share the CLI last gave (a window rejected at 97%).
    if (reached.length) {
        const w = lastToLift(reached);
        return { pct: 100, reached: true, window: named(w), ...(w.resets ? { resets: w.resets } : {}), ...(w.scope ? { scope: w.scope } : {}) };
    }
    const w = live.filter((w) => w.pct !== undefined).sort((a, b) => b.pct! - a.pct!)[0];
    if (!w || w.pct! < 80) return undefined;
    return { pct: Math.min(100, Math.round(w.pct!)), reached: false, window: named(w), ...(w.resets ? { resets: w.resets } : {}) };
}

/** An account's badge in the model picker: "limit" once its plan's limit is reached, else its share ("94%"); `long` in its list. A model's own limit marks that model's row. */
export function limitBadge(n: Pick<NearLimit, "pct" | "reached">, long: boolean): string {
    return n.reached ? (long ? "Limit reached" : "limit") : `${n.pct}%${long ? " used" : ""}`;
}

/** A model family as it's named to the user: "fable" → "Fable". */
export function scopeName(scope: string): string {
    return scope.charAt(0).toUpperCase() + scope.slice(1);
}

/** A window as a limit is named: a model family's by the family ("Fable"), the plan's by its length ("Weekly", "5-hour"). */
export function limitName(w: Pick<MeterWindow, "label" | "scope">): string {
    return w.scope ? scopeName(w.scope) : w.label;
}

/**
 * The limits that apply to a model: the plan's own windows, and the windows of some models (Fable's) that cover it
 * (or may: an alias not served yet). A plan's stop with no window reached (a bare rejection) applies to every model.
 */
function applies(m: Meter, model: { id: string; resolved?: string } | undefined): MeterWindow[] {
    return m.windows.filter((w) => !w.reset && (!w.scope || (model !== undefined && covers(w.scope, model) !== false)));
}

/**
 * What a turn on `model` runs into now: its reached limit that lifts last ("Fable", "Weekly"), or the plan's stop with
 * none to show. Undefined when nothing stops it. `credits`: it goes on, on credits, for every limit reached: any
 * that stops turns wins.
 */
export function limitFor(m: Meter | undefined, model: { id: string; resolved?: string } | undefined): { window?: MeterWindow; credits: boolean; resets?: string } | undefined {
    if (!m) return undefined;
    if (m.planStop) return { credits: m.usingCredits, ...(m.resets ? { resets: m.resets } : {}) };
    const reached = applies(m, model).filter((w) => w.reached);
    if (!reached.length) return undefined;
    // Each window by its own say, else the plan's (planNow fills it in): any that stops turns wins.
    const credits = reached.every((w) => w.credits === true);
    const last = lastToLift(reached);
    return { window: last, credits, ...(last.resets ? { resets: last.resets } : {}) };
}

/** The reached window that lifts last: one with no known reset counts as last. */
function lastToLift(ws: MeterWindow[]): MeterWindow {
    return ws.reduce((a, b) => (b.resetsAt === undefined || (a.resetsAt !== undefined && b.resetsAt > a.resetsAt) ? b : a));
}

/** A plan as every surface names it (plan-meter.ts planTitle), from what the server lists of its CLI. */
export function planTitle(info: Pick<ProviderInfo, "name" | "agentCli"> | undefined, accountId = "default", fallback = ""): { title: string; plan: string; account?: string } {
    return corePlanTitle(info && { name: info.name, accounts: info.agentCli?.accounts }, accountId, fallback);
}

/** When a reached plan lifts, for its summary: not when the one window that's reached says it already. */
export function liftsAt(m: Pick<Meter, "resets" | "windows">): string | undefined {
    if (!m.resets) return undefined;
    const reached = m.windows.filter((w) => w.reached);
    return reached.length === 1 && reached[0]!.resets === m.resets ? undefined : m.resets;
}

/** Only a fresh CLI status can offer a usable alternative; no identity enters the transcript. */
export function limitAlternatives(accounts: AccountInfo[], accountId: string): AccountInfo[] {
    return accounts.filter((a) => a.id !== accountId && a.signedIn === true);
}

export function usd(n: number): string {
    if (n === 0) return "$0.00";
    if (n < 0.01) return "<$0.01";
    if (n < 99.995) return `$${n.toFixed(2)}`;
    return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** A row's or the total's cost: "unknown" when none of it had a price, "$X + unknown" when part didn't. Never "$0" for unpriced usage. */
export function costText(r: Pick<UsageRow, "cost" | "unknown">): string {
    if (!r.unknown) return usd(r.cost);
    return r.cost > 0 ? `${usd(r.cost)} + unknown` : "unknown";
}

/** Tokens in: what wasn't read from the cache (cache writes are new input). */
export function tokensIn(r: Pick<UsageRow, "inputTokens" | "cacheWriteTokens">): number {
    return r.inputTokens + r.cacheWriteTokens;
}

/** What the Usage view says when there are no rows: not "no usage" when it didn't get to read everything. */
export function emptyText(s: Pick<UsageSummary, "days" | "truncated">): string {
    return s.truncated ? `Nothing read yet: ${s.truncated}` : `No usage in the last ${rangeLabel(s.days)}.`;
}

export function rangeLabel(days: UsageSummary["days"]): string {
    return days === 1 ? "24 hours" : `${days} days`;
}

/** A configured model reference ("claude-code:fable") as the model it names, for one not in the list yet. */
export function refModel(ref: string | undefined): { id: string } | undefined {
    const i = ref?.indexOf(":") ?? -1;
    return ref && i > 0 && i < ref.length - 1 ? { id: ref.slice(i + 1) } : undefined;
}
