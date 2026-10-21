// Comments left on lines of the review pane's diff, and how they travel: each
// one becomes a <review_comment> block after the message's text (T3 Code's
// format), quoting the diff lines it was written on, and comes back apart when
// that text returns to the box (an edited queued message, a rewind) or is
// drawn in the transcript.

import type { DiffLine } from "@shared/protocol";
import { slashName } from "./commands";

/** Deleted lines are numbered in the old file; context and added lines in the new one. */
export type Side = "old" | "new";
export interface LineRef {
    side: Side;
    line: number;
}

export interface ReviewComment {
    id: string;
    /** As the review pane lists it: relative to the session's folder (../ for the rest of the repository). */
    path: string;
    start: LineRef;
    end: LineRef;
    text: string;
    /** The lines it was written on, as unified diff lines (" ", "-", "+" then the text), under a @@ header. */
    snippet: string;
    /**
     * Up to two lines either side of it, as snippet lines: kept here, never sent. They tell its own
     * lines from a copy elsewhere in the diff once the file moves on.
     */
    before?: string[];
    after?: string[];
    created: number;
}

export const lineRef = (l: DiffLine): LineRef | undefined => (l.t === "del" ? (l.a !== undefined ? { side: "old", line: l.a } : undefined) : l.b !== undefined ? { side: "new", line: l.b } : undefined);

const marker = (t: DiffLine["t"]) => (t === "add" ? "+" : t === "del" ? "-" : " ");

/** How many lines either side of a comment it keeps, to know its own lines again. */
export const AROUND = 2;

/** A comment on these consecutive lines of one hunk, or undefined when there's nothing to anchor to. */
export function buildComment(input: { id: string; path: string; lines: readonly DiffLine[]; before?: readonly DiffLine[]; after?: readonly DiffLine[]; text: string; now?: number }): ReviewComment | undefined {
    const lines = input.lines;
    const first = lines[0];
    const last = lines.at(-1);
    const start = first && lineRef(first);
    const end = last && lineRef(last);
    const text = input.text.trim();
    if (!start || !end || !text) return undefined;
    const olds = lines.filter((l) => l.t !== "add");
    const news = lines.filter((l) => l.t !== "del");
    const header = `@@ -${olds[0]?.a ?? 0},${olds.length} +${news[0]?.b ?? 0},${news.length} @@`;
    const around = (ls: readonly DiffLine[] | undefined) => (ls?.length ? ls.map((l) => marker(l.t) + l.text) : undefined);
    const before = around(input.before?.slice(-AROUND));
    const after = around(input.after?.slice(0, AROUND));
    return { id: input.id, path: input.path, start, end, text, snippet: [header, ...lines.map((l) => marker(l.t) + l.text)].join("\n"), ...(before ? { before } : {}), ...(after ? { after } : {}), created: input.now ?? Date.now() };
}

const num = (r: LineRef) => `${r.side === "old" ? "−" : ""}${r.line}`;

/** "12", "12–14", "−7", "−7 to 9": the lines, deleted ones marked. */
export function linesLabel(c: Pick<ReviewComment, "start" | "end">): string {
    if (c.start.side === c.end.side && c.start.line === c.end.line) return num(c.start);
    if (c.start.side === c.end.side) return `${num(c.start)}–${c.end.line}`;
    return `${num(c.start)} to ${num(c.end)}`;
}

/** For screen readers and titles: "line 12", "lines 12–14", "deleted line 7". */
export function linesPhrase(c: Pick<ReviewComment, "start" | "end">): string {
    const one = c.start.side === c.end.side && c.start.line === c.end.line;
    if (one) return `${c.start.side === "old" ? "deleted line" : "line"} ${c.start.line}`;
    return `lines ${linesLabel(c)}`;
}

/** The snippet's lines with their numbers, rebuilt from its @@ header. */
export function snippetLines(snippet: string): DiffLine[] {
    const [header, ...rest] = snippet.split("\n");
    const m = header?.match(/^@@ -(\d+),\d+ \+(\d+),\d+ @@$/);
    if (!m) return [];
    let a = Number(m[1]);
    let b = Number(m[2]);
    return rest.map((s): DiffLine => {
        const t = s[0] === "+" ? "add" : s[0] === "-" ? "del" : "ctx";
        const l: DiffLine = { t, text: s.slice(1) };
        if (t !== "add") l.a = a++;
        if (t !== "del") l.b = b++;
        return l;
    });
}

const CLOSE = "</review_comment>";
// The closing tag inside a comment gets one more backslash after its "<", and loses one coming back,
// so text that already has `<\/review_comment>` comes back as written.
const escapeBody = (s: string) => s.replace(/<(\\*)\/review_comment>/g, "<\\$1/review_comment>");
const unescapeBody = (s: string) => s.replace(/<\\(\\*)\/review_comment>/g, "<$1/review_comment>");
const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unescapeAttr = (s: string) => s.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

/** A fence longer than any run of backticks in what it holds. */
function fenceFor(s: string): string {
    let longest = 0;
    for (const m of s.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
    return "`".repeat(Math.max(3, longest + 1));
}

export function formatComment(c: ReviewComment): string {
    const fence = fenceFor(c.snippet);
    return `<review_comment file="${escapeAttr(c.path)}" lines="${escapeAttr(linesLabel(c))}">\n${escapeBody(c.text)}\n\n${fence}diff\n${escapeBody(c.snippet)}\n${fence}\n${CLOSE}`;
}

/**
 * Whether a message takes the waiting comments, read as the server reads it: a shell line
 * (`!`, after any spaces) or a command doesn't; a path or `//` at the start is just a message.
 */
export const takesComments = (text: string) => !text.trimStart().startsWith("!") && slashName(text) === undefined;

/** The message as sent: what was typed, then each comment. */
export function withComments(text: string, comments: readonly ReviewComment[]): string {
    if (!comments.length) return text;
    const blocks = comments.map(formatComment).join("\n\n");
    return text.trim() ? `${text.trimEnd()}\n\n${blocks}` : blocks;
}

/** A sent comment read back: what the transcript shows, and what goes back to the box. */
export type SentComment = Omit<ReviewComment, "id" | "created">;

const BLOCK = /<review_comment file="([^"]*)" lines="([^"]*)">\n([\s\S]*?)\n<\/review_comment>/y;

function parseBlock(path: string, body: string): SentComment | undefined {
    const closing = body.lastIndexOf("\n");
    const fence = body.slice(closing + 1);
    if (!/^`{3,}$/.test(fence)) return undefined;
    const open = body.lastIndexOf(`\n\n${fence}diff\n`, closing);
    if (open < 0) return undefined;
    const text = unescapeBody(body.slice(0, open));
    const snippet = unescapeBody(body.slice(open + fence.length + 7, closing));
    const lines = snippetLines(snippet);
    const start = lines[0] && lineRef(lines[0]);
    const end = lines.at(-1) && lineRef(lines.at(-1)!);
    if (!start || !end || !text.trim()) return undefined;
    return { path, start, end, text, snippet };
}

/**
 * The typed text and the comments in it. A comment is a well-formed block standing as its own
 * paragraph: after the text as sent, or between messages that were queued and then sent together.
 * A message that merely mentions the tag is left alone.
 */
export function splitComments(message: string): { text: string; comments: SentComment[] } {
    if (!message.includes("<review_comment ")) return { text: message, comments: [] };
    const comments: SentComment[] = [];
    const kept: string[] = [];
    let from = 0;
    for (let i = message.indexOf("<review_comment "); i >= 0; i = message.indexOf("<review_comment ", i + 1)) {
        if (i < from || (i > 0 && message.slice(i - 2, i) !== "\n\n")) continue;
        BLOCK.lastIndex = i;
        const m = BLOCK.exec(message);
        const c = m && parseBlock(unescapeAttr(m[1]!), m[3]!);
        if (!m || !c) continue;
        const end = BLOCK.lastIndex;
        const rest = message.slice(end);
        if (!rest.startsWith("\n\n") && rest.trim()) continue;
        comments.push(c);
        kept.push(message.slice(from, i));
        from = rest.trim() ? end + 2 : message.length;
    }
    if (!comments.length) return { text: message, comments: [] };
    kept.push(message.slice(from));
    const text = kept.map((part) => part.replace(/^\n+|\n+$/g, "")).filter(Boolean).join("\n\n");
    return { text, comments };
}

/** A prompt in one line for lists and titles: what was typed, or how many comments it carried. */
export function promptPreview(message: string): string {
    const { text, comments } = splitComments(message);
    if (!comments.length) return message;
    const n = comments.length === 1 ? "1 review comment" : `${comments.length} review comments`;
    return text.trim() ? `${text} (+${n})` : n[0]!.toUpperCase() + n.slice(1);
}

/** Whether the lines from `from`, going `step`, read as `want` does (nearest first when going back). */
function nextTo(lines: readonly DiffLine[], from: number, step: 1 | -1, want: readonly string[] | undefined): boolean {
    if (!want?.length) return false;
    for (let k = 0; k < want.length; k++) {
        const l = lines[from + k * step];
        const w = want[step === 1 ? k : want.length - 1 - k]!;
        if (!l || marker(l.t) + l.text !== w) return false;
    }
    return true;
}

/**
 * Where a comment sits in this diff: the index (into `lines`) of the last line it covers, found by
 * its quoted text and its neighbours, nearest its old place, so it follows lines that moved.
 * Undefined when those lines aren't here any more (edited, reverted, another view): it's outdated here.
 */
export function locate(c: Pick<ReviewComment, "snippet" | "end" | "before" | "after">, lines: readonly DiffLine[]): number | undefined {
    const want = snippetLines(c.snippet);
    if (!want.length) return undefined;
    const lastText = want.at(-1)!.text;
    let best: number | undefined;
    let bestDistance = Infinity;
    for (let i = want.length - 1; i < lines.length; i++) {
        if (lines[i]!.text !== lastText) continue;
        let match = true;
        for (let k = 1; k < want.length && match; k++) match = lines[i - k]!.text === want[want.length - 1 - k]!.text && (lines[i - k]!.t === "del") === (want[want.length - 1 - k]!.t === "del");
        if (!match || (lines[i]!.t === "del") !== (c.end.side === "old")) continue;
        const ref = lineRef(lines[i]!);
        const distance = ref ? Math.abs(ref.line - c.end.line) : Infinity;
        // Its neighbours on one side at least: an identical line elsewhere isn't this one. Without them it
        // can't tell, so only its own place counts.
        if (c.before || c.after ? !nextTo(lines, i - want.length, -1, c.before) && !nextTo(lines, i + 1, 1, c.after) : distance !== 0) continue;
        if (distance < bestDistance) {
            best = i;
            bestDistance = distance;
            if (distance === 0) break;
        }
    }
    return best;
}
