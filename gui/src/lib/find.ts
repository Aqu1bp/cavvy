// Find in the conversation (⌘F): matches are counted in the turns themselves,
// so pages not drawn yet and rows folded away count too; the one being shown
// is then looked up in the page, once the rows around it are open.

import { foldCase, type Block, type Turn } from "@shared/protocol";
import { toolLabel } from "../components/blocks/Activity";
import { renderMarkdown } from "./markdown";

/** More than this and the count says "N+". */
export const MAX_MATCHES = 5000;

export interface FindMatch {
    turnId: string;
    /** The row it's in: "prompt", or a block's id (the element with that data-find). */
    part: string;
    /** Which match in that row. */
    n: number;
}

const shownText = new Map<string, string>();

/** Markdown as it reads on the page: rendered the way the transcript renders it, then its text. */
function plain(md: string): string {
    let text = shownText.get(md);
    if (text === undefined) {
        text = new DOMParser().parseFromString(renderMarkdown(md), "text/html").body.textContent ?? md;
        // Finished replies don't change; a streaming one is a new key each time, so old ones go.
        if (shownText.size > 4000) shownText.clear();
        shownText.set(md, text);
    }
    return text;
}

/** What a block shows, as find sees it. Thinking isn't searched; a tool row is its title and summary, not its output. */
function blockText(b: Block): string | undefined {
    switch (b.t) {
        case "text":
            return plain(b.text);
        case "tool": {
            const l = toolLabel(b);
            // A sub-agent's row starts with its task, not the word "Agent".
            if (b.agent) return typeof b.input?.description === "string" && b.input.description.trim() ? b.input.description.trim() : l.arg;
            // As the row reads, a space between each part (ToolRow puts one there): verb, argument, summary.
            const meta = b.status === "denied" ? "Declined" : b.diff && b.status === "ok" ? undefined : b.summary;
            return [l.verb, l.arg, meta].filter(Boolean).join(" ");
        }
        case "notice":
            return b.text;
        case "compact":
            return b.summary;
        case "shell":
            return `${b.command}\n${b.output}`;
        default:
            return undefined;
    }
}

export function findParts(turn: Turn): { part: string; text: string }[] {
    const out: { part: string; text: string }[] = [];
    if (turn.prompt?.text) out.push({ part: "prompt", text: turn.prompt.text });
    for (const b of turn.blocks) {
        const text = blockText(b);
        if (text) out.push({ part: b.id, text });
    }
    return out;
}

/** Every place `query` (literal, any case) appears, in order. */
export function findMatches(turns: readonly Turn[], query: string): FindMatch[] {
    const q = foldCase(query);
    const out: FindMatch[] = [];
    if (!q) return out;
    for (const t of turns) {
        for (const p of findParts(t)) {
            const f = foldCase(p.text);
            let n = 0;
            for (let i = f.indexOf(q); i >= 0; i = f.indexOf(q, i + q.length)) {
                out.push({ turnId: t.id, part: p.part, n: n++ });
                if (out.length >= MAX_MATCHES) return out;
            }
        }
    }
    return out;
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
