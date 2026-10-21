// The command palette's results, as the mockup groups them: sessions, then
// messages, then actions, each group under one heading.

/**
 * Entries grouped by section: the sections named in `order` first, in that
 * order, then any others in the order they first appear. Within a section the
 * entries keep their order (best match first), so each heading shows once.
 */
export function groupSections<T extends { section: string }>(entries: readonly T[], order: readonly string[]): T[] {
    const rank = (section: string) => {
        const i = order.indexOf(section);
        return i >= 0 ? i : order.length;
    };
    const seen = new Map<string, number>();
    for (const e of entries) if (!seen.has(e.section)) seen.set(e.section, seen.size);
    // Array.prototype.sort is stable, so entries keep their order inside a section.
    return [...entries].sort((a, b) => rank(a.section) - rank(b.section) || seen.get(a.section)! - seen.get(b.section)!);
}

/**
 * Where the selection goes when the list changes under it. A new query starts
 * at the top; otherwise it stays on the same entry (message hits arrive late and
 * land above the actions), or as near its old place as the list allows.
 */
export function keepSelection(prev: readonly { id: string }[] | undefined, next: readonly { id: string }[], at: number, newQuery: boolean): number {
    if (newQuery || !prev) return 0;
    const id = prev[at]?.id;
    const same = id === undefined ? -1 : next.findIndex((e) => e.id === id);
    return same >= 0 ? same : Math.min(at, Math.max(0, next.length - 1));
}

/** Message hits shown before "Show more", when other results follow them (the mockup shows three). */
export const MESSAGES_FIRST = 3;

/**
 * How many message hits to show: all of them when nothing else matched or the
 * user asked for all; otherwise the first few, so they don't push the actions
 * below them out of sight. One left over is shown rather than hidden behind a row.
 */
export function messagesShown(total: number, others: number, showAll: boolean, first = MESSAGES_FIRST): number {
    if (showAll || others === 0 || total <= first + 1) return total;
    return first;
}
