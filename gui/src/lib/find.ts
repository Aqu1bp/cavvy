// Find in the conversation (⌘F): matches are counted in the turns themselves,
// so pages not drawn yet and rows folded away count too; the one being shown
// is then looked up in the page, once the rows around it are open.

import { foldCase, type Turn } from "@shared/protocol";
import { findMatches, MAX_MATCHES, type FindMatch } from "./find-text";

export { MAX_MATCHES, findMatches, findParts, plain, type FindMatch } from "./find-text";

/**
 * Every match, in the turns' order: those the server found (`there`: in turns the window hasn't, and in those it has
 * folded, which it can't count itself), then each of the window's turns, counted here or (folded) there, with those
 * of the turns its gap stands for after `gapAfter`. Those of a turn that has come in whole since it was asked are
 * counted here. At most MAX_MATCHES.
 */
export function allMatches(turns: readonly Turn[], query: string, there: readonly (FindMatch & { gap?: true })[], gapAfter?: string): FindMatch[] {
    const here = findMatches(turns.filter((t) => !t.folded), query);
    if (!there.length) return here;
    const whole = new Set(turns.filter((t) => !t.folded).map((t) => t.id));
    const has = new Set(turns.map((t) => t.id));
    const byTurn = new Map<string, FindMatch[]>();
    for (const m of [...there.filter((x) => has.has(x.turnId) && !whole.has(x.turnId)), ...here]) byTurn.set(m.turnId, [...(byTurn.get(m.turnId) ?? []), m]);
    // Those of turns that came in since it was asked (the gap filled) are counted with them; for a gap the window no
    // longer holds, it's asked again.
    const inGap = gapAfter && has.has(gapAfter) ? there.filter((m) => m.gap && !has.has(m.turnId)) : [];
    const before = there.filter((m) => !has.has(m.turnId) && !m.gap);
    return [...before, ...turns.flatMap((t) => (t.id === gapAfter ? [...(byTurn.get(t.id) ?? []), ...inGap] : byTurn.get(t.id) ?? []))].slice(0, MAX_MATCHES);
}

/**
 * The turn a message belongs to: the last one starting at or before it, in
 * file order. A reply that carried on past a compaction (a turn of the
 * segment before) is in that turn until the next prompt.
 */
export function turnAt(turns: readonly Turn[], seg: number, index: number): Turn | undefined {
    let best: Turn | undefined;
    for (const t of turns) if (t.pos && (t.pos.seg < seg || (t.pos.seg === seg && t.pos.index <= index))) best = t;
    return best;
}

/** Ranges of the page where `query` appears under `root` (text split across elements included). */
export function textRanges(root: Node, query: string): Range[] {
    const q = foldCase(query);
    if (!q) return [];
    const nodes: Text[] = [];
    const starts: number[] = [];
    let all = "";
    // Not the page's own labels (a code block's language), which find doesn't count.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement?.closest("[data-find-skip]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        nodes.push(n as Text);
        starts.push(all.length);
        all += n.nodeValue ?? "";
    }
    // The text node holding position `pos` (for an end, the one it closes).
    const locate = (pos: number, end: boolean): [Text, number] => {
        let lo = 0;
        let hi = nodes.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (end ? starts[mid]! < pos : starts[mid]! <= pos) lo = mid;
            else hi = mid - 1;
        }
        return [nodes[lo]!, pos - starts[lo]!];
    };
    const f = foldCase(all);
    const out: Range[] = [];
    for (let i = f.indexOf(q); i >= 0 && out.length < MAX_MATCHES; i = f.indexOf(q, i + q.length)) {
        const r = document.createRange();
        const [sn, so] = locate(i, false);
        const [en, eo] = locate(i + q.length, true);
        r.setStart(sn, so);
        r.setEnd(en, eo);
        out.push(r);
    }
    return out;
}

/**
 * Scrolls each box between the match and `outer` that scrolls (a long shell
 * output, a wide code line) so the match is in it, innermost first; the
 * transcript itself is placed by the caller.
 */
export function revealInBoxes(r: Range, outer: Element) {
    for (let el = r.startContainer.parentElement; el && el !== outer; el = el.parentElement) {
        const cs = getComputedStyle(el);
        // One skipped while out of sight (a reply's code block, transcript.css) measures as if it held nothing: drawn
        // for this, and left to the page again at the next frame, once the caller has brought it into view.
        if (cs.contentVisibility === "auto") {
            const box = el as HTMLElement;
            box.style.contentVisibility = "visible";
            requestAnimationFrame(() => box.style.removeProperty("content-visibility"));
        }
        const sy = el.scrollHeight > el.clientHeight && /auto|scroll/.test(cs.overflowY);
        const sx = el.scrollWidth > el.clientWidth && /auto|scroll/.test(cs.overflowX);
        if (!sx && !sy) continue;
        const box = r.getBoundingClientRect();
        const view = el.getBoundingClientRect();
        if (sy && (box.top < view.top || box.bottom > view.bottom)) el.scrollTop += box.top - view.top - (view.height - box.height) / 2;
        if (sx && (box.left < view.left || box.right > view.right)) el.scrollLeft += box.left - view.left - (view.width - box.width) / 2;
    }
}

const canPaint = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

/** Marks the matches on the page, and the current one apart (CSS ::highlight, so the page itself isn't touched). */
export function paintMatches(all: Range[], current?: Range) {
    if (!canPaint()) return;
    CSS.highlights.set("find-match", new Highlight(...all));
    if (current) CSS.highlights.set("find-current", new Highlight(current));
    else CSS.highlights.delete("find-current");
}

export function clearPaint() {
    if (!canPaint()) return;
    CSS.highlights.delete("find-match");
    CSS.highlights.delete("find-current");
}
