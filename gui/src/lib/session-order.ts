import type { SessionSummary } from "@shared/protocol";

export const SESSION_PAGE = 25;

/** Attention first, then pins and recent activity. IDs break timestamp ties. */
export function orderSessions(list: readonly SessionSummary[]): SessionSummary[] {
    return [...list].sort((a, b) => Number(b.status === "waiting") - Number(a.status === "waiting")
        || Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function requiredSession(s: SessionSummary, activeId?: string): boolean {
    return s.id === activeId || s.status === "waiting";
}

export function pageSessions(list: readonly SessionSummary[], limit: number, activeId?: string): SessionSummary[] {
    return list.filter((s, i) => i < limit || requiredSession(s, activeId));
}

export type SidebarEntry =
    | { key: string; kind: "card" | "row"; id: string }
    | { key: string; kind: "project"; cwd: string; name: string }
    | { key: string; kind: "settled" | "archived" }
    | { key: string; kind: "more"; page: "cards" | "settled" | "archived"; remaining: number };

export interface SidebarOptions {
    activeId?: string;
    groupBy: "date" | "project";
    archived: boolean;
    settledOpen: boolean;
    cards: number;
    settled: number;
    archive: number;
}

/** A single projection drives the DOM and keyboard navigation, including paging. */
export function sidebarEntries(sessions: readonly SessionSummary[], archived: readonly SessionSummary[], o: SidebarOptions): SidebarEntry[] {
    const entries: SidebarEntry[] = [];
    const rows = (list: readonly SessionSummary[], kind: "card" | "row") => {
        for (const s of list) entries.push({ key: s.id, kind, id: s.id });
    };
    const more = (page: "cards" | "settled" | "archived", remaining: number) => {
        if (remaining > 0) entries.push({ key: `more:${page}`, kind: "more", page, remaining });
    };
    // Active/asking sessions stay discoverable even across the archive filter.
    const requiredElsewhere = (list: readonly SessionSummary[]) => rows(orderSessions(list).filter((s) => requiredSession(s, o.activeId)), "card");
    if (o.archived) {
        requiredElsewhere(sessions);
        entries.push({ key: "heading:archived", kind: "archived" });
        const all = orderSessions(archived);
        const visible = pageSessions(all, o.archive, o.activeId);
        rows(visible, "row");
        more("archived", all.length - visible.length);
        return entries;
    }
    requiredElsewhere(archived);
    const cards = orderSessions(sessions.filter((s) => !s.settled));
    const visible = pageSessions(cards, o.cards, o.activeId);
    if (o.groupBy === "project") {
        const groups = new Map<string, SessionSummary[]>();
        for (const s of visible) {
            const group = groups.get(s.cwd) ?? [];
            group.push(s);
            groups.set(s.cwd, group);
        }
        for (const [cwd, group] of groups) {
            entries.push({ key: `project:${cwd}`, kind: "project", cwd, name: group[0]!.projectName });
            rows(group, "card");
        }
    } else rows(visible, "card");
    more("cards", cards.length - visible.length);
    const settled = orderSessions(sessions.filter((s) => s.settled));
    if (settled.length) {
        entries.push({ key: "heading:settled", kind: "settled" });
        const visibleSettled = pageSessions(settled, o.settledOpen ? o.settled : 0, o.activeId);
        rows(visibleSettled, "row");
        if (o.settledOpen) more("settled", settled.length - visibleSettled.length);
    }
    return entries;
}

/** Hold the entire layout, not just sorting: moving between shelves also moves targets.
 * New attention/open rows append while held, without displacing any existing row. */
export function holdSidebar(previous: readonly SidebarEntry[], next: SidebarEntry[], held: boolean, sessions: readonly SessionSummary[], activeId?: string): SidebarEntry[] {
    if (!held || !previous.length) return next;
    const live = new Map(sessions.map((s) => [s.id, s]));
    const kept = previous.filter((e) => !("id" in e) || live.has(e.id));
    const keys = new Set(kept.map((e) => e.key));
    return [...kept, ...next.filter((e) => "id" in e && !keys.has(e.key) && requiredSession(live.get(e.id)!, activeId))];
}

export function sidebarIds(entries: readonly SidebarEntry[]): string[] {
    return entries.flatMap((e) => "id" in e ? [e.id] : []);
}

export function adjacentSession(ids: readonly string[], current: string | undefined, direction: 1 | -1): string | undefined {
    if (!ids.length) return;
    const index = current ? ids.indexOf(current) : -1;
    if (index < 0) return direction === 1 ? ids[0] : ids[ids.length - 1];
    return ids[(index + direction + ids.length) % ids.length];
}
