// What the rail's footer shows of the plans (components/PlanFooter.tsx, loaded with it, not with the window): a
// chip per plan, its card's rows, its tooltip. Plain functions of the server's data and the time, tested from test/.

import type { PlanLimits, ProviderInfo } from "@shared/protocol";
import { planLimitKey } from "../../../src/server/protocol";
import { meterOf, planTitle, planTone, resetLabel, scopeName, windowLine, windowTone, type MeterWindow, type PlanTone } from "./limits";

export { planTone, windowTone, type PlanTone } from "./limits";

/** One of a plan's windows (5-hour, weekly), for the usage card. */
export interface RailWindow {
    label: string;
    /** 0-100; undefined when the CLI didn't say, or the window has reset since it did. */
    pct?: number;
    tone: PlanTone;
    /** Reached now (and not reset since). */
    reached: boolean;
    /** When it resets, briefly: "4:40 PM", "Mon", "Mon 9:00 AM" (a reached one). */
    resets?: string;
    /** When it reset, once that has passed since the report: "9:52 AM", "Wed". */
    reset?: string;
}

/** One plan in the rail's footer: an agent CLI's subscription that's signed in. */
export interface RailPlan {
    /** The plan's provider, for its mark. */
    provider: string;
    /** Its account. */
    accountId: string;
    /** "Claude Code Max", "Codex Plus"; what the CLI calls its plan ("Claude subscription") when it hasn't said which. */
    name: string;
    /** The fullest window's share, 0-100 (100 at a limit); undefined: nothing reported yet, or every window has reset since. */
    pct?: number;
    /** The gauge's tint (planTone): amber near a limit, red nearer and at it. */
    tone: PlanTone;
    /** At a limit now: the gauge's ring is full and red. */
    reached: boolean;
    /** The fullest window's label ("5-hour"), for a plan on its own: "62% 5-hour". */
    window?: string;
    /** When a reached limit lifts, as briefly as can be ("Mon", "4:40 PM"): "100% · resets Mon". */
    lifts?: string;
    /**
     * Short enough for the rail (about 24 characters): "62% of the 5-hour limit", "5-hour 62% as of 2:02 PM"
     * (reported a while ago), "Reached, resets 4:40 PM", "Usage shows after a turn".
     */
    line: string;
    /** The line for a row beside another plan's, which has no room for the age: "62% of the 5-hour limit". */
    brief: string;
    /** Only a model's limit reached, while the plan's other models go on: "Fable limit reached, resets Mon". */
    note?: string;
    /** Reported a while ago (or before a window reset): the figures may be out of date. */
    stale: boolean;
    /** "as of 2:02 PM", when stale. */
    asOf?: string;
    /** The tooltip: the plan and account, then each window. */
    detail: string;
    /** Each window, for the usage card. */
    windows: RailWindow[];
}

/**
 * The order the footer's chips fold into "+N" when they don't fit: the plain
 * ones first, from the end, so a plan near its limit stays in view.
 */
export function foldOrder(plans: readonly Pick<RailPlan, "tone">[]): number[] {
    return plans.map((p, i) => ({ i, near: p.tone !== "normal" })).sort((a, b) => Number(a.near) - Number(b.near) || b.i - a.i).map((x) => x.i);
}

/**
 * How the footer's chips fit in `room` px (the row's width inside its padding),
 * from their measured widths as they are (`normal`, `gap` apart) and tight (`%`
 * signs dropped, `tightGap` apart). Short of room, first tight; only if that
 * still overflows, fold chips into a "+N" chip `more` px wide, in `order`
 * (foldOrder), until the rest fits. Never folds when they'd fit without "+N",
 * and leaves one chip however narrow. A plan on its own never folds.
 */
export function planFit(o: { room: number; normal: readonly number[]; tight: readonly number[]; gap: number; tightGap: number; more: number; order: readonly number[] }): { tight: boolean; folded: number } {
    const n = o.normal.length;
    // Half a pixel of slack for rounding.
    const fits = (w: number) => w <= o.room + 0.5;
    const width = (ws: readonly number[], gap: number, hidden: ReadonlySet<number> = new Set()) => {
        const shown = ws.filter((_, i) => !hidden.has(i));
        return shown.reduce((a, b) => a + b, 0) + gap * Math.max(0, shown.length - 1);
    };
    if (n < 2 || fits(width(o.normal, o.gap))) return { tight: false, folded: 0 };
    if (fits(width(o.tight, o.tightGap))) return { tight: true, folded: 0 };
    const hidden = new Set<number>();
    while (hidden.size < n - 1) {
        hidden.add(o.order[hidden.size]!);
        if (fits(width(o.tight, o.tightGap, hidden) + o.tightGap + o.more)) break;
    }
    return { tight: true, folded: hidden.size };
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The plans to show, the one that matters first: the open session's when it's
 * on an agent CLI with a plan, else the one used most recently. Only CLIs turned on
 * and signed in to a plan count (an API key, or an API provider, has no plan
 * limits); none gives an empty list.
 */
export function railFoot(o: {
    limits: Record<string, PlanLimits>;
    providers: readonly ProviderInfo[];
    /** The open session's provider and account, if any. */
    provider?: string;
    account?: string;
    /** Providers by the sessions that used them, most recent first. */
    recent?: readonly string[];
    now: number;
}): RailPlan[] {
    const rank = (id: string) => {
        const i = o.recent?.indexOf(id) ?? -1;
        return i < 0 ? Infinity : i;
    };
    const plans = o.providers.flatMap((info) => {
        const cli = info.agentCli;
        // One that reports no plan limits (an ACP agent) has no plan to show.
        if (!cli || !info.configured || !cli.installed || cli.planLimits === false) return [];
        const accountId = (info.id === o.provider ? o.account : undefined) ?? cli.defaultAccount ?? "default";
        const account = cli.accounts?.find((a) => a.id === accountId);
        if (account?.signedIn === false || account?.apiKey) return [];
        return [{ info, accountId, account, limits: o.limits[planLimitKey(info.id, accountId)] }];
    });
    plans.sort((a, b) => Number(b.info.id === o.provider) - Number(a.info.id === o.provider) || rank(a.info.id) - rank(b.info.id) || (b.limits?.at ?? 0) - (a.limits?.at ?? 0));
    return plans.map(({ info, accountId, account, limits }): RailPlan => {
        // As every surface names it (planTitle): the account's name in it when there are several.
        const name = planTitle(info, accountId).title;
        const meter = meterOf(limits, o.now);
        const head = account?.email ? `${name} (${account.email})` : name;
        if (!limits || !meter) return { provider: info.id, accountId, name, tone: "normal", reached: false, line: "Usage shows after a turn", brief: "Usage shows after a turn", stale: false, detail: `${head}\nNo usage reported yet: it shows after your first turn.`, windows: [] };
        // The window nearest its limit is the one that matters now; one that has reset since the report says nothing.
        const top = meter.top;
        const pct = meter.reached ? 100 : top?.pct;
        // When it was reported, and when a reached limit lifts, as briefly as can be: "2:02 PM", "Mon".
        const reported = resetLabel(meter.reportedAt, o.now);
        const short = (t?: string) => t?.replace(/, in .*$/, "").replace(/^(.+?) \d{1,2}[:.]\d{2}.*$/, "$1");
        const lifts = short(meter.resets);
        // Only some models' limit reached (Fable's): the plan's others go on, so it's said, amber, not as the plan's.
        // Models' limits reached (Fable's): said whether or not the plan's own is reached too.
        const partly = scopedSummary(meter.partly, short);
        const brief = meter.reached ? `Reached${meter.usingCredits ? " · using credits" : ""}${lifts ? `, resets ${lifts}` : ""}`
            : partly ? partly
            : top ? `${top.pct}% of the ${top.label.toLowerCase()} limit`
            : `Reset since ${reported}`;
        const line = !meter.reached && !partly && top && meter.asOf ? `${top.label} ${top.pct}% as of ${reported}` : brief;
        // Only a model's limit reached: said under the plan's name, in the tooltip and the card, not only to a screen reader.
        const note = partly;
        // A stop with no window to show for it (a bare rejection) is what makes it red: said in the tooltip too.
        const detail = [head, meter.planStop ? brief : undefined, note, ...meter.windows.map(windowLine), meter.asOf ? capital(meter.asOf) : undefined].filter(Boolean).join("\n");
        // The card's rows: a window that has reset since the report has no figure to show, only when it reset.
        const windows = meter.windows.map((w): RailWindow => {
            const shown = w.pct === undefined ? undefined : Math.min(100, w.pct);
            return { label: w.label, pct: shown, tone: windowTone(w), reached: w.reached, ...(w.reset ? { reset: w.reset } : w.resets ? { resets: w.resets.replace(/, in .*$/, "") } : {}) };
        });
        // A limit reached that none of the windows is (only that, or Codex's workspace limit beside
        // windows with room left): a row of its own says so, first.
        if (meter.reached && !meter.windows.some((w) => w.reached && !w.scope)) windows.unshift({ label: "Limit", tone: "danger", reached: true, resets: lifts });
        const tone = meter.reached ? planTone(pct, true) : partly && planTone(pct) === "normal" ? "warn" : planTone(pct);
        return {
            provider: info.id, accountId, name, pct, tone, reached: meter.reached,
            window: meter.reached ? undefined : top?.label, lifts: meter.reached ? lifts : undefined,
            line, brief, ...(note ? { note } : {}), stale: Boolean(meter.asOf), asOf: meter.asOf, detail, windows,
        };
    });
}

/**
 * Models' limits reached (scope), as one line: "Fable limit reached, resets Mon"; several, "Fable and Opus limits
 * reached", with when they reset only if that's the same for all.
 */
export function scopedSummary(reached: readonly Pick<MeterWindow, "scope" | "resets" | "credits">[], short: (t?: string) => string | undefined = (t) => t): string | undefined {
    if (!reached.length) return undefined;
    const names = [...new Set(reached.map((w) => scopeName(w.scope!)))];
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]!;
    const resets = [...new Set(reached.map((w) => short(w.resets)))];
    const credits = reached.every((w) => w.credits === true);
    return `${list} limit${names.length > 1 ? "s" : ""} reached${credits ? " · using credits" : ""}${resets.length === 1 && resets[0] ? `, resets ${resets[0]}` : ""}`;
}
