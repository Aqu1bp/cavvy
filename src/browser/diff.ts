// What changed between two outlines of a page (ax.ts), so a call that acts on the page can answer with the change
// rather than the whole page again. Lines are compared as text: an element keeps its ref (refs.ts) while the page
// stays in one generation, so an unchanged element prints identically in both.

/** More changes than this, or a diff nearly as long as the page, and the whole outline is the better answer. */
const MAX_CHANGED = 80;
const MAX_REMOVED = 20;
const WORTH_IT = 0.6;

const indent = (line: string) => line.length - line.trimStart().length;

/**
 * The lines of `next` that `prev` didn't have, each under the lines it sits in, and those that went away. Undefined
 * when the change is too large to be worth telling apart from the page.
 */
export function outlineDiff(prev: string, next: string): string | undefined {
    const before = prev ? prev.split("\n") : [];
    const after = next ? next.split("\n") : [];
    const left = new Map<string, number>();
    for (const l of before) left.set(l, (left.get(l) ?? 0) + 1);
    const added = new Set<number>();
    after.forEach((l, i) => {
        const n = left.get(l) ?? 0;
        if (n > 0) left.set(l, n - 1);
        else added.add(i);
    });
    const removed = before.filter((l) => {
        const n = left.get(l) ?? 0;
        if (n > 0) left.set(l, n - 1);
        return n > 0;
    });
    if (!added.size && !removed.length) return "The page's outline hasn't changed.";
    if (added.size + removed.length > MAX_CHANGED || added.size > after.length * WORTH_IT) return undefined;
    // Each new line with the lines it is inside, so it reads in place.
    const shown = new Set<number>();
    const parents: number[] = [];
    after.forEach((l, i) => {
        const depth = indent(l) / 2;
        parents.length = Math.min(parents.length, depth);
        if (added.has(i)) {
            shown.add(i);
            for (const p of parents) if (p !== undefined) shown.add(p);
        }
        parents[depth] = i;
    });
    const out = ["Changed since the last snapshot (+ is new or different):"];
    after.forEach((l, i) => {
        if (shown.has(i)) out.push(`${added.has(i) ? "+" : " "} ${l}`);
    });
    if (removed.length) {
        out.push("Gone:");
        for (const l of removed.slice(0, MAX_REMOVED)) out.push(`  ${l.trim()}`);
        if (removed.length > MAX_REMOVED) out.push(`  … ${removed.length - MAX_REMOVED} more`);
    }
    const text = out.join("\n");
    return text.length > next.length * WORTH_IT ? undefined : text;
}
