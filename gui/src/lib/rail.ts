// What the session rail shows, as plain functions of the server's data (no DOM,
// so they're tested from test/): a row's status glyph, the counts on its group
// headings, the sessions that need you, and the plans in its footer.

import type { PlanLimits, ProviderInfo, SessionSummary } from "@shared/protocol";
import { planLimitKey } from "../../../src/server/protocol";
import type { SidebarEntry } from "./session-order";
import { meterOf, resetLabel, windowLine } from "./limits";

/** The glyph at the start of a row: working, waiting for you, finished since you looked, stopped, or quiet. */
export type RailGlyph = "running" | "waiting" | "done" | "error" | "new" | "idle";

export function railGlyph(s: Pick<SessionSummary, "status" | "messages">, unread: boolean): RailGlyph {
    if (s.status === "running") return "running";
    if (s.status === "waiting") return "waiting";
    if (s.status === "error") return "error";
    if (unread) return "done";
    return s.messages > 0 ? "idle" : "new";
}

/**
 * Sessions under each project heading, keyed by the heading's entry key. A run
 * counts each of its sessions; the count stops at the next heading, so Settled
 * and "Show more" don't add to the last project. A folded project counts its
 * folded sessions.
 */
export function groupCounts(entries: readonly SidebarEntry[]): Map<string, number> {
    const counts = new Map<string, number>();
    let group: string | undefined;
    for (const e of entries) {
        if (e.kind === "project") {
            group = e.key;
            // A folded project counts the sessions folded under it.
            counts.set(group, e.collapsed ? e.ids?.length ?? 0 : 0);
        } else if (e.kind === "settled" || e.kind === "archived" || e.kind === "needs") group = undefined;
        else if (group && (e.kind === "card" || e.kind === "row")) counts.set(group, counts.get(group)! + 1);
        else if (group && e.kind === "run") counts.set(group, counts.get(group)! + e.ids.length);
    }
    return counts;
}

/**
 * Sessions waiting on you, but the one in front of you (its request card is
 * already there): the latest first. They're pinned at the top of the rail, or
 * in the title bar while the rail is hidden, until they're answered.
 */
export function needsYou<T extends Pick<SessionSummary, "id" | "status" | "updatedAt">>(sessions: readonly T[], inFront?: string): T[] {
    return sessions.filter((s) => s.status === "waiting" && s.id !== inFront).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

/**
 * Where the sessions that need you show: pinned at the top of the rail when
 * it's shown, else in the title bar. Settings covers both (its own list takes
 * the rail's place, its page the title bar's): its top line has them, the open
 * one too, since Settings covers its request as well.
 */
export function needsPlace(o: { railShown: boolean; settings: boolean }): "rail" | "title" | "settings" {
    return o.settings ? "settings" : o.railShown ? "rail" : "title";
}

/**
 * The session whose request is in front of you, so Needs you leaves it out: the
 * open one, but not under Settings, nor while one of its sub-agents' views is
 * open (that shows only the sub-agent's own requests; opening it from Needs you
 * leaves the view: state/actions.ts openWaiting).
 */
export function inFront(o: { activeId?: string; settings: boolean; agentFocus?: string }): string | undefined {
    return o.settings || o.agentFocus ? undefined : o.activeId;
}

/** What a waiting session asks of you, for its row under Needs you. */
export function asking(s: Pick<SessionSummary, "waitingKind">): string {
    switch (s.waitingKind) {
        case "permission": return "Wants your approval";
        case "plan": return "Plan ready for review";
        case "question": return "Has a question for you";
        case "secret": return "Asks for a secret";
        default: return "Waiting for your answer";
    }
}

/**
 * A row under Needs you: what it asks, while it does. Answered while the rail
 * holds still (the pointer on it), it says so until the row goes.
 */
export function needsRowLine(s: Pick<SessionSummary, "status" | "waitingKind">): string {
    return s.status === "waiting" ? asking(s) : "Answered";
}

/** The title bar's Needs you, in words: "Fix the build needs you: Wants your approval", "3 sessions need you". */
export function needsLine(waiting: readonly Pick<SessionSummary, "title" | "waitingKind">[]): string {
    const [one] = waiting;
    if (waiting.length === 1 && one) return `${one.title} needs you: ${asking(one)}`;
    return `${waiting.length} sessions need you`;
}

/** How near its limit a plan (or one of its windows) is: amber from 75%, red from 90% and at the limit. */
export type PlanTone = "normal" | "warn" | "danger";

export function planTone(pct: number | undefined, reached = false): PlanTone {
    if (reached || (pct ?? 0) >= 90) return "danger";
    return (pct ?? 0) >= 75 ? "warn" : "normal";
}

/** One of a plan's windows (5-hour, weekly), for the usage card. */
export interface RailWindow {
    label: string;
    /** 0-100; undefined when the CLI didn't say, or the window has reset since it did. */
    pct?: number;
    tone: PlanTone;
    /** Reached now (and not reset since). */
    reached: boolean;
    /** When it resets, briefly: "4:40 PM", "Mon", "Mon 9:00 AM" (a reached one); "Reset" once it has. */
    resets?: string;
}

/** One plan in the rail's footer: a Claude Code or Codex subscription that's signed in. */
export interface RailPlan {
    /** The plan's provider, for its mark. */
    provider: string;
    /** "Claude Code Max", "Codex Plus"; what the CLI calls its plan ("Claude subscription") when it hasn't said which. */
    name: string;
    /** The fullest window's share, 0-100 (100 at a limit); undefined: nothing reported yet, or every window has reset since. */
    pct?: number;
    /** The chip's tint (planTone): amber near a limit, red nearer and at it. */
    tone: PlanTone;
    /** At a limit now: the chip fills red. */
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
 * on Claude Code or Codex, else the one used most recently. Only CLIs turned on
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
        if (!cli || !info.configured || !cli.installed) return [];
        const accountId = (info.id === o.provider ? o.account : undefined) ?? cli.defaultAccount ?? "default";
        const account = cli.accounts?.find((a) => a.id === accountId);
        if (account?.signedIn === false || account?.apiKey) return [];
        return [{ info, account, limits: o.limits[planLimitKey(info.id, accountId)] }];
    });
    plans.sort((a, b) => Number(b.info.id === o.provider) - Number(a.info.id === o.provider) || rank(a.info.id) - rank(b.info.id) || (b.limits?.at ?? 0) - (a.limits?.at ?? 0));
    return plans.map(({ info, account, limits }): RailPlan => {
        const plan = account?.plan ? capital(account.plan) : undefined;
        const name = plan ? `${info.name} ${plan}` : info.agentCli!.plan;
        const meter = meterOf(limits, o.now);
        const many = (info.agentCli!.accounts?.length ?? 0) > 1;
        const who = [many ? account?.name : undefined, account?.email].filter(Boolean).join(", ");
        const head = who ? `${name} (${who})` : name;
        if (!limits || !meter) return { provider: info.id, name, tone: "normal", reached: false, line: "Usage shows after a turn", brief: "Usage shows after a turn", stale: false, detail: `${head}\nNo usage reported yet: it shows after your first turn.`, windows: [] };
        // The window nearest its limit is the one that matters now; one that has reset since the report says nothing.
        const reset = (i: number) => (limits.windows[i]?.resetsAt ?? Infinity) <= o.now;
        const top = meter.windows.filter((w, i) => w.pct !== undefined && !reset(i)).sort((a, b) => b.pct! - a.pct!)[0];
        const pct = meter.reached ? 100 : top?.pct;
        // When it was reported, and when a reached limit lifts, as briefly as can be: "2:02 PM", "Mon".
        const reported = resetLabel(limits.at, o.now);
        const lifts = meter.resets?.replace(/, in .*$/, "").replace(/^(.+?) \d{1,2}[:.]\d{2}.*$/, "$1");
        const brief = meter.reached ? `Reached${meter.usingCredits ? " · using credits" : ""}${lifts ? `, resets ${lifts}` : ""}`
            : top ? `${top.pct}% of the ${top.label.toLowerCase()} limit`
            : `Reset since ${reported}`;
        const line = !meter.reached && top && meter.asOf ? `${top.label} ${top.pct}% as of ${reported}` : brief;
        const detail = [head, ...meter.windows.map(windowLine), meter.asOf ? capital(meter.asOf) : undefined].filter(Boolean).join("\n");
        // The card's rows: a window that has reset since the report has no figure to show.
        const windows = meter.windows.map((w, i): RailWindow => {
            const shown = reset(i) || w.pct === undefined ? undefined : Math.min(100, w.pct);
            return { label: w.label, pct: shown, tone: planTone(shown, w.reached), reached: w.reached, resets: reset(i) ? "Reset" : w.resets?.replace(/, in .*$/, "") };
        });
        // A limit reached that none of the windows is (only that, or Codex's workspace limit beside
        // windows with room left): a row of its own says so, first.
        if (meter.reached && !windows.some((w) => w.reached)) windows.unshift({ label: "Limit", tone: "danger", reached: true, resets: lifts });
        return {
            provider: info.id, name, pct, tone: planTone(pct, meter.reached), reached: meter.reached,
            window: meter.reached ? undefined : top?.label, lifts: meter.reached ? lifts : undefined,
            line, brief, stale: Boolean(meter.asOf), asOf: meter.asOf, detail, windows,
        };
    });
}
