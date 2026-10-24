import type { SessionSummary } from "@shared/protocol";
import { basename } from "./format";

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
    return sessionGroups(list).filter((group, i) => i < limit || group.some((s) => requiredSession(s, activeId))).flat();
}

/** Runs occupy one page slot at their highest-priority member's position.
 * Within a run, model cards stay in start order rather than racing each other. */
function sessionGroups(list: readonly SessionSummary[]): SessionSummary[][] {
    const groups: SessionSummary[][] = [];
    const runs = new Map<string, SessionSummary[]>();
    for (const s of list) {
        if (!s.run) groups.push([s]);
        else {
            let group = runs.get(s.run.id);
            if (!group) { group = []; runs.set(s.run.id, group); groups.push(group); }
            group.push(s);
        }
    }
    for (const group of runs.values()) group.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return groups;
}

export type SidebarEntry =
    | { key: string; kind: "card" | "row"; id: string }
    | { key: string; kind: "run"; ids: string[]; row: boolean }
    /** A project heading; `collapsed`: its sessions in play (`ids`) are folded under it. */
    | { key: string; kind: "project"; cwd: string; name: string; collapsed?: boolean; ids?: string[] }
    | { key: string; kind: "settled" | "archived" }
    | { key: string; kind: "more"; page: "cards" | "settled" | "archived"; remaining: number }
    /**
     * Needs you, pinned above everything: the sessions waiting on you (`ids`), each
     * also in its own place below. Its ids aren't the list's order (sidebarIds).
     */
    | { key: string; kind: "needs"; ids: string[] };

export interface SidebarOptions {
    activeId?: string;
    groupBy: "date" | "project";
    archived: boolean;
    settledOpen: boolean;
    cards: number;
    settled: number;
    archive: number;
    /** Grouped by project: the projects (by path) whose sessions are folded under their heading. */
    collapsed?: readonly string[];
    /** Sessions waiting on you but the one in front of you (rail.ts needsYou), pinned at the top of the active list. */
    needs?: readonly string[];
}

/** The project a session is listed under when grouped by project: a run's own folder, else its folder. */
export const projectOf = (s: Pick<SessionSummary, "cwd" | "run">) => s.run?.cwd ?? s.cwd;

/** Fold a project's sessions under its heading, or unfold them. */
export function toggleProject(collapsed: readonly string[], cwd: string): string[] {
    return collapsed.includes(cwd) ? collapsed.filter((c) => c !== cwd) : [...collapsed, cwd];
}

/**
 * Opening a session in a folded project unfolds it, so the open row shows.
 * The same array when there's nothing to unfold (a settled or archived one is
 * listed elsewhere; listed by date, nothing folds).
 */
export function revealProject(collapsed: readonly string[], s: Pick<SessionSummary, "cwd" | "run" | "settled" | "archived"> | undefined, groupBy: "date" | "project"): readonly string[] {
    if (!s || groupBy !== "project" || s.settled || s.archived || !collapsed.includes(projectOf(s))) return collapsed;
    return collapsed.filter((c) => c !== projectOf(s));
}

/** A single projection drives the DOM and keyboard navigation, including paging. */
export function sidebarEntries(sessions: readonly SessionSummary[], archived: readonly SessionSummary[], o: SidebarOptions): SidebarEntry[] {
    const entries: SidebarEntry[] = [];
    const rows = (list: readonly SessionSummary[], kind: "card" | "row", shelf: string) => {
        for (const group of sessionGroups(list)) {
            const s = group[0]!;
            if (s.run) entries.push({ key: `run:${shelf}:${s.run.id}`, kind: "run", ids: group.map((s) => s.id), row: kind === "row" });
            else entries.push({ key: s.id, kind, id: s.id });
        }
    };
    const more = (page: "cards" | "settled" | "archived", remaining: number) => {
        if (remaining > 0) entries.push({ key: `more:${page}`, kind: "more", page, remaining });
    };
    // Active/asking sessions stay discoverable even across the archive filter.
    const requiredElsewhere = (list: readonly SessionSummary[]) => rows(pageSessions(orderSessions(list), 0, o.activeId), "card", "elsewhere");
    if (o.archived) {
        requiredElsewhere(sessions);
        entries.push({ key: "heading:archived", kind: "archived" });
        const all = orderSessions(archived);
        const visible = pageSessions(all, o.archive, o.activeId);
        rows(visible, "row", "archived");
        more("archived", sessionGroups(all).length - sessionGroups(visible).length);
        return entries;
    }
    if (o.needs?.length) entries.push({ key: "heading:needs", kind: "needs", ids: [...o.needs] });
    requiredElsewhere(archived);
    const all = orderSessions(sessions.filter((s) => !s.settled));
    // A folded project's sessions take no page slots: only its heading shows, where its latest session would be.
    const folded = new Set(o.groupBy === "project" ? o.collapsed ?? [] : []);
    const cards = folded.size ? all.filter((s) => !folded.has(projectOf(s))) : all;
    const visible = pageSessions(cards, o.cards, o.activeId);
    if (o.groupBy === "project") {
        const shown = new Set(visible.map((s) => s.id));
        const groups = new Map<string, SessionSummary[]>();
        for (const s of all) {
            const cwd = projectOf(s);
            if (!folded.has(cwd) && !shown.has(s.id)) continue;
            const group = groups.get(cwd) ?? [];
            group.push(s);
            groups.set(cwd, group);
        }
        for (const [cwd, group] of groups) {
            const name = group[0]!.run ? basename(cwd) : group[0]!.projectName;
            if (folded.has(cwd)) entries.push({ key: `project:${cwd}`, kind: "project", cwd, name, collapsed: true, ids: group.map((s) => s.id) });
            else {
                entries.push({ key: `project:${cwd}`, kind: "project", cwd, name });
                rows(group, "card", "cards");
            }
        }
    } else rows(visible, "card", "cards");
    more("cards", sessionGroups(cards).length - sessionGroups(visible).length);
    const settled = orderSessions(sessions.filter((s) => s.settled));
    if (settled.length) {
        entries.push({ key: "heading:settled", kind: "settled" });
        const visibleSettled = pageSessions(settled, o.settledOpen ? o.settled : 0, o.activeId);
        rows(visibleSettled, "row", "settled");
        if (o.settledOpen) more("settled", sessionGroups(settled).length - sessionGroups(visibleSettled).length);
    }
    return entries;
}

/** Hold the entire layout, not just sorting: moving between shelves also moves targets.
 * New attention/open rows append while held, without displacing any existing row. */
export function holdSidebar(previous: readonly SidebarEntry[], next: SidebarEntry[], held: boolean, sessions: readonly SessionSummary[], activeId?: string): SidebarEntry[] {
    if (!held || !previous.length) return next;
    const live = new Map(sessions.map((s) => [s.id, s]));
    const kept = previous.flatMap((e): SidebarEntry[] => {
        if (e.kind === "run" || e.kind === "needs") {
            const ids = e.ids.filter((id) => live.has(id));
            return ids.length ? [{ ...e, ids }] : [];
        }
        return "id" in e && !live.has(e.id) ? [] : [e];
    });
    const ids = new Set(sidebarIds(kept));
    const added = next.flatMap((e): SidebarEntry[] => {
        if (e.kind === "run") {
            const missing = e.ids.filter((id) => !ids.has(id));
            if (!missing.some((id) => requiredSession(live.get(id)!, activeId))) return [];
            // A newly required member must not move targets below its held group.
            return [{ ...e, key: `${e.key}:pending:${missing[0]}`, ids: missing }];
        }
        return "id" in e && !ids.has(e.id) && requiredSession(live.get(e.id)!, activeId) ? [e] : [];
    });
    return [...kept, ...added];
}

export function sidebarIds(entries: readonly SidebarEntry[]): string[] {
    return entries.flatMap((e) => e.kind === "run" ? e.ids : "id" in e ? [e.id] : []);
}

export function adjacentSession(ids: readonly string[], current: string | undefined, direction: 1 | -1): string | undefined {
    if (!ids.length) return;
    const index = current ? ids.indexOf(current) : -1;
    if (index < 0) return direction === 1 ? ids[0] : ids[ids.length - 1];
    return ids[(index + direction + ids.length) % ids.length];
}
