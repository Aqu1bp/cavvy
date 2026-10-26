// Picking several sessions in the rail, as plain functions (no DOM, so they're
// tested from test/): what a click, Shift+arrow or Select all leaves selected,
// and which actions apply to what's selected.
//
// The rules:
// - A plain click opens a session and clears the selection; the row clicked
//   becomes the anchor.
// - Shift-click selects the rows from the anchor to the one clicked, in the
//   order the rail shows them, across group headings (date, project, Settled).
// - ⌘-click (Ctrl elsewhere) adds a row or takes it out, and becomes the anchor.
// - One list at a time: active sessions (in play and settled) or archived ones.
//   The rail can show a few of the other list's (an open or waiting one), and
//   those are skipped by a range; ⌘-clicking one starts a new selection.

/** Which list a session belongs to. A selection holds one. */
export type RailList = "active" | "archived";

export interface RailSelection {
    /** Selected session ids, in the order they were added. */
    readonly ids: readonly string[];
    /** Where a Shift-click or Shift+arrow range starts. */
    readonly anchor?: string;
}

export const NO_SELECTION: RailSelection = { ids: [] };

export type ClickKind = "plain" | "toggle" | "range";

/** What a click with these modifiers does: ⌘ toggles on a Mac (Ctrl-click is a right click there), Ctrl elsewhere. */
export function clickKind(e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }, mac: boolean): ClickKind {
    if (e.shiftKey) return "range";
    return (mac ? e.metaKey : e.ctrlKey) ? "toggle" : "plain";
}

/** The rows from `a` to `b` (either way round) in `order`, of `list` only. */
function span(order: readonly string[], a: string, b: string, list: RailList, listOf: (id: string) => RailList | undefined): string[] {
    const i = order.indexOf(a);
    const j = order.indexOf(b);
    if (i < 0 || j < 0) return [];
    const [from, to] = i <= j ? [i, j] : [j, i];
    return order.slice(from, to + 1).filter((id) => listOf(id) === list);
}

/**
 * The selection after clicking row `id`. `order`: the rows as the rail shows
 * them; `listOf`: each row's list.
 */
export function clickSelect(sel: RailSelection, id: string, kind: ClickKind, order: readonly string[], listOf: (id: string) => RailList | undefined): RailSelection {
    const list = listOf(id);
    if (kind === "plain" || !list) return { ids: [], anchor: id };
    const same = sel.ids.filter((x) => listOf(x) === list);
    if (kind === "toggle") {
        // A row of the other list starts over: the actions differ between them.
        if (same.length !== sel.ids.length) return { ids: [id], anchor: id };
        return { ids: same.includes(id) ? same.filter((x) => x !== id) : [...same, id], anchor: id };
    }
    const anchor = sel.anchor && order.includes(sel.anchor) && listOf(sel.anchor) === list ? sel.anchor : id;
    return { ids: span(order, anchor, id, list, listOf), anchor };
}

/**
 * Shift+↑/↓ from the focused row: the selection runs from the anchor (the
 * focused row when nothing is selected) to the next row of the same list,
 * which takes the focus. Undefined at either end of the list.
 */
export function extendSelect(sel: RailSelection, focused: string, dir: 1 | -1, order: readonly string[], listOf: (id: string) => RailList | undefined): { sel: RailSelection; focus: string } | undefined {
    const list = listOf(focused);
    if (!list) return undefined;
    let i = order.indexOf(focused);
    if (i < 0) return undefined;
    do i += dir;
    while (i >= 0 && i < order.length && listOf(order[i]!) !== list);
    const next = order[i];
    if (next === undefined) return undefined;
    const kept = sel.ids.length && sel.anchor && order.includes(sel.anchor) && listOf(sel.anchor) === list;
    const anchor = kept ? sel.anchor! : focused;
    return { sel: { ids: span(order, anchor, next, list, listOf), anchor }, focus: next };
}

/** Every row of `list` the rail shows. */
export function selectAll(order: readonly string[], list: RailList, listOf: (id: string) => RailList | undefined): RailSelection {
    const ids = order.filter((id) => listOf(id) === list);
    return { ids, anchor: ids[0] };
}

/** Drops rows the rail no longer shows (deleted, paged out, folded away). The same object when nothing changed. */
export function pruneSelection(sel: RailSelection, order: readonly string[]): RailSelection {
    const shown = new Set(order);
    const ids = sel.ids.filter((id) => shown.has(id));
    const anchor = sel.anchor && shown.has(sel.anchor) ? sel.anchor : undefined;
    return ids.length === sel.ids.length && anchor === sel.anchor ? sel : { ids, anchor };
}

/**
 * What a key or the menu acts on: the selection, else the focused row, else
 * the open session (when the rail shows it).
 */
export function railTargets(sel: RailSelection, focused: string | undefined, open: string | undefined, order: readonly string[]): string[] {
    if (sel.ids.length) return [...sel.ids];
    if (focused && order.includes(focused)) return [focused];
    if (open && order.includes(open)) return [open];
    return [];
}

export interface BulkPlan {
    list: RailList;
    /** In play: Settle acts on these. */
    settle: string[];
    /** All settled: Back in play. */
    unsettle: string[];
    archive: string[];
    restore: string[];
    delete: string[];
}

/** The actions that apply to these sessions (one list's, as a selection is). */
export function bulkPlan(sessions: readonly { id: string; settled: boolean; archived: boolean }[]): BulkPlan {
    const ids = sessions.map((s) => s.id);
    if (sessions.length && sessions.every((s) => s.archived)) return { list: "archived", settle: [], unsettle: [], archive: [], restore: ids, delete: ids };
    const active = sessions.filter((s) => !s.archived);
    const settle = active.filter((s) => !s.settled).map((s) => s.id);
    return { list: "active", settle, unsettle: settle.length ? [] : active.map((s) => s.id), archive: active.map((s) => s.id), restore: [], delete: ids };
}

/** "1 session", "5 sessions". */
export const sessionCount = (n: number) => `${n} session${n === 1 ? "" : "s"}`;

/** Titles for a message: "“A”", "“A” and “B”", "“A”, “B” and 3 more". */
export function sessionNames(titles: readonly string[]): string {
    const q = titles.map((t) => `“${t}”`);
    if (q.length <= 2) return q.join(" and ");
    if (q.length === 3) return `${q[0]}, ${q[1]} and ${q[2]}`;
    return `${q[0]}, ${q[1]} and ${q.length - 2} more`;
}
