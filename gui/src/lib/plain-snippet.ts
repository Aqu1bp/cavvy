// A search hit's snippet as plain text: what a message says, without the
// Markdown it was written in (backticks, emphasis, link targets, heading and
// list markers), with the match still on the same words.

export interface PlainSnippet {
    text: string;
    /** Where the match is in `text`; undefined when it was all syntax. */
    match?: [number, number];
}

const LINK = /!?\[([^\]\n]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g;
/** Inline code: its backticks go, what's inside stays exactly as written. */
const CODE = /(`+)([\s\S]*?[^`])\1(?!`)/g;
/** Paired markers: bold, strikethrough, and backticks that never closed. */
const RUNS = /\*\*|__|~~|`+/g;
/** A lone * or _ that opens or closes emphasis: next to a word on one side, not on the other. */
const OPEN = /(^|[\s(…"'])([*_])(?=[^\s*_])/g;
const CLOSE = /([^\s*_])([*_])(?=$|[\s).,;:!?…"'])/g;
/** A heading, quote or list marker at the start (the snippet's own start, or after "…"). */
const LEAD = /^(…?)((?:#{1,6}|>+|[-*+]|\d{1,3}[.)])\s+)/;

export function plainSnippet(text: string, match?: [number, number]): PlainSnippet {
    const drop = new Uint8Array(text.length);
    const keep = new Uint8Array(text.length);
    const cut = (from: number, to: number) => {
        for (let i = Math.max(0, from); i < Math.min(text.length, to); i++) if (!keep[i]) drop[i] = 1;
    };
    for (const m of text.matchAll(CODE)) {
        const inner = m.index! + m[1]!.length;
        cut(m.index!, inner);
        cut(inner + m[2]!.length, m.index! + m[0].length);
        keep.fill(1, m.index!, m.index! + m[0].length);
    }
    for (const m of text.matchAll(LINK)) {
        const at = m.index!;
        const start = at + (m[0].startsWith("!") ? 2 : 1);
        cut(at, start);
        cut(start + m[1]!.length, at + m[0].length);
    }
    for (const m of text.matchAll(RUNS)) cut(m.index!, m.index! + m[0].length);
    for (const m of text.matchAll(OPEN)) cut(m.index! + m[1]!.length, m.index! + m[1]!.length + 1);
    for (const m of text.matchAll(CLOSE)) cut(m.index! + m[1]!.length, m.index! + m[1]!.length + 1);
    const lead = LEAD.exec(text);
    if (lead) cut(lead[1]!.length, lead[1]!.length + lead[2]!.length);

    let out = "";
    // kept[i]: how many characters of text[0, i) are kept.
    const kept = new Uint32Array(text.length + 1);
    for (let i = 0; i < text.length; i++) {
        kept[i + 1] = kept[i]! + (drop[i] ? 0 : 1);
        if (!drop[i]) out += text[i];
    }
    if (!match) return { text: out };
    const from = kept[Math.max(0, Math.min(text.length, match[0]))]!;
    const to = kept[Math.max(0, Math.min(text.length, match[1]))]!;
    return to > from ? { text: out, match: [from, to] } : { text: out };
}
