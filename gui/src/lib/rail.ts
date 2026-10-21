// What the session rail shows, as plain functions of the server's data (no DOM,
// so they're tested from test/): a row's status glyph, the counts on its group
// headings, and the plan line in its footer.

import type { PlanLimits, ProviderInfo, SessionSummary } from "@shared/protocol";
import { planLimitKey } from "../../../src/server/protocol";
import type { SidebarEntry } from "./session-order";
import { meterOf } from "./limits";

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
 * and "Show more" don't add to the last project.
 */
export function groupCounts(entries: readonly SidebarEntry[]): Map<string, number> {
    const counts = new Map<string, number>();
    let group: string | undefined;
    for (const e of entries) {
        if (e.kind === "project") {
            group = e.key;
            counts.set(group, 0);
        } else if (e.kind === "settled" || e.kind === "archived") group = undefined;
        else if (group && (e.kind === "card" || e.kind === "row")) counts.set(group, counts.get(group)! + 1);
        else if (group && e.kind === "run") counts.set(group, counts.get(group)! + e.ids.length);
    }
    return counts;
}

export interface RailFoot {
    /** The plan's provider, for its mark. */
    provider?: string;
    /** 0-100 for the ring; undefined shows the connection dot instead. */
    pct?: number;
    /** The ring's tint: a reached or nearly reached limit warns. */
    tone: "normal" | "warn" | "danger";
    /** "Claude Code Max", "ChatGPT plan", or "This computer" when no plan has reported. */
    name: string;
    /** "62% of the 5-hour limit", "Limit reached", or the connection when no plan has reported. */
    line: string;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The plan to show: the session in view's own provider and account when it's on
 * a plan that has reported its limits, else the plan that reported most recently.
 */
export function railFoot(o: {
    conn: string;
    limits: Record<string, PlanLimits>;
    providers: readonly ProviderInfo[];
    /** The open session's provider and account, if any. */
    provider?: string;
    account?: string;
    now: number;
}): RailFoot {
    const offline = o.conn !== "open";
    const own = o.provider ? o.limits[planLimitKey(o.provider, o.account)] : undefined;
    const latest = Object.values(o.limits).filter((l) => l.windows.length || l.reached).sort((a, b) => b.at - a.at)[0];
    const limits = own && (own.windows.length || own.reached) ? own : latest;
    const meter = meterOf(limits, o.now);
    if (!limits || !meter) return { tone: "normal", name: "This computer", line: offline ? "Reconnecting…" : "Connected" };
    const info = o.providers.find((p) => p.id === limits.provider);
    const account = info?.agentCli?.accounts?.find((a) => a.id === (limits.accountId ?? info.agentCli?.defaultAccount ?? "default"));
    const name = account?.plan ? `${info!.name} ${capital(account.plan)}` : info?.agentCli?.plan ?? info?.name ?? limits.provider;
    // The window nearest its limit is the one that matters now.
    const top = meter.windows.filter((w) => w.pct !== undefined).sort((a, b) => b.pct! - a.pct!)[0];
    const pct = meter.reached ? 100 : top?.pct;
    const line = offline ? "Reconnecting…"
        : meter.reached ? `Limit reached${meter.resets ? `, resets ${meter.resets}` : ""}`
        : top ? `${top.pct}% of the ${top.label.toLowerCase()} limit` : "Plan limits";
    return { provider: limits.provider, pct, tone: meter.reached || (pct ?? 0) >= 85 ? "danger" : (pct ?? 0) >= 70 ? "warn" : "normal", name, line };
}
