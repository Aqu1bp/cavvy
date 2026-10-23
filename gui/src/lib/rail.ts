// What the session rail shows, as plain functions of the server's data (no DOM,
// so they're tested from test/): a row's status glyph, the counts on its group
// headings, and the plans in its footer.

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
        } else if (e.kind === "settled" || e.kind === "archived") group = undefined;
        else if (group && (e.kind === "card" || e.kind === "row")) counts.set(group, counts.get(group)! + 1);
        else if (group && e.kind === "run") counts.set(group, counts.get(group)! + e.ids.length);
    }
    return counts;
}

/** One plan in the rail's footer: a Claude Code or Codex subscription that's signed in. */
export interface RailPlan {
    /** The plan's provider, for its mark. */
    provider: string;
    /** "Claude Code Max", "Codex Plus"; what the CLI calls its plan ("Claude subscription") when it hasn't said which. */
    name: string;
    /** 0-100 for the ring; undefined leaves it empty (nothing reported yet, or every window has reset since). */
    pct?: number;
    /** The ring's tint: a reached or nearly reached limit warns. */
    tone: "normal" | "warn" | "danger";
    /**
     * Short enough for the rail (about 24 characters): "62% of the 5-hour limit", "5-hour 62% as of 2:02 PM"
     * (reported a while ago), "Reached, resets 4:40 PM", "Usage shows after a turn".
     */
    line: string;
    /** The line for a row beside another plan's, which has no room for the age: "62% of the 5-hour limit". */
    brief: string;
    /** Reported a while ago (or before a window reset): the figures may be out of date. */
    stale: boolean;
    /** The tooltip: the plan and account, then each window. */
    detail: string;
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
    return plans.map(({ info, account, limits }) => {
        const plan = account?.plan ? capital(account.plan) : undefined;
        const name = plan ? `${info.name} ${plan}` : info.agentCli!.plan;
        const meter = meterOf(limits, o.now);
        const many = (info.agentCli!.accounts?.length ?? 0) > 1;
        const who = [many ? account?.name : undefined, account?.email].filter(Boolean).join(", ");
        const head = who ? `${name} (${who})` : name;
        if (!limits || !meter) return { provider: info.id, name, tone: "normal" as const, line: "Usage shows after a turn", brief: "Usage shows after a turn", stale: false, detail: `${head}\nNo usage reported yet: it shows after your first turn.` };
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
        return { provider: info.id, name, pct, tone: meter.reached || (pct ?? 0) >= 85 ? "danger" as const : (pct ?? 0) >= 70 ? "warn" as const : "normal" as const, line, brief, stale: Boolean(meter.asOf), detail };
    });
}
