// How a notice reads (#426): what it is decides how it's drawn (TurnView's Notice), and what it says is the least
// that only words can say. Plain functions of the block and the time (no DOM, so they're tested from test/).

import { stoppedText, switchWord, type Block, type NoticeBlock, type NoticeLimit } from "@shared/protocol";
import { resetLabel } from "./limits";

/**
 * How a notice is drawn: a switch's line between turns, what a switch stopped on a line of its own (said after a
 * message came), an info line, a warning's pill, an error's card.
 */
export type NoticeKind = "switch" | "stopped" | "info" | "warn" | "error";

export function noticeKind(b: NoticeBlock): NoticeKind {
    if (b.account) return "switch";
    if (b.stopped) return "stopped";
    return b.level;
}

/** "3:40 PM" today, "Thu 3:40 PM" on another day. */
export function untilLabel(ms: number, now: number): string {
    return resetLabel(ms, now, true).replace(/, in .*$/, "");
}

/** A window's name in a sentence: "5-hour", "weekly". */
function windowWord(w: string): string {
    return /^[A-Z][a-z]/.test(w) ? w.charAt(0).toLowerCase() + w.slice(1) : w;
}

/**
 * A limit, in a few words: stopping the turn, "Second is out of its 5-hour limit until 3:40 PM"; on credits, "Using
 * credits until 3:40 PM"; reached, "5-hour limit reached".
 */
export function limitTitle(l: NoticeLimit, level: NoticeBlock["level"], now: number): string {
    const until = l.resetsAt !== undefined && l.resetsAt > now ? ` until ${untilLabel(l.resetsAt, now)}` : "";
    if (level === "error") return `${l.name} is out of its ${l.window ? `${windowWord(l.window)} ` : "usage "}limit${until}`;
    if (l.credits) return `Using credits${until}`;
    return `${l.window ? `${l.window} limit` : "Usage limit"} reached`;
}

/** A warning's pill: its title, and what folds under it (none when the title is all of it). */
export function warnParts(b: NoticeBlock, now: number): { title: string; body?: string } {
    if (b.limit) return { title: limitTitle(b.limit, "warn", now) };
    if (b.title) return { title: b.title, ...(b.text.trim() ? { body: b.text } : {}) };
    return { title: b.text };
}

/** Where a CLI's or Harness's error names who stopped: "Claude Code stopped: API Error: 500 …". */
const STOPPED = /^([^\n:]{3,60}?(?:stopped|failed|error)):\s+([\s\S]+)$/i;

/** An error's card: one short sentence, and what was said with it (in monospace: a CLI's raw words). */
export function errorParts(b: NoticeBlock, now: number): { title: string; body?: string } {
    if (b.limit) return { title: limitTitle(b.limit, "error", now) };
    if (b.title) return { title: b.title, ...(b.text.trim() ? { body: b.text } : {}) };
    const m = STOPPED.exec(b.text.trim());
    return m ? { title: m[1]!, body: m[2]! } : { title: b.text };
}

/** A notice's text as runs of plain text and `code` (each odd one is code). */
export function codeRuns(text: string): string[] {
    const runs = text.split("`");
    // An unpaired backtick is just a backtick.
    if (runs.length % 2 === 0) return [text];
    return runs;
}

/** What a run of text reads as, its backticks gone where they mark code. */
export function plainOf(text: string): string {
    return codeRuns(text).join("");
}

/** A switch's line as it reads (find counts this): who, the word, then what it stopped. */
export function switchLine(b: NoticeBlock): string {
    const a = b.account!;
    const stopped = a.stopped ?? [];
    const sub = stopped.length ? stoppedText(stopped) : "";
    return [`${a.cli} · ${a.name} ${switchWord(a.how)}`, sub].filter(Boolean).join("\n");
}

/** A notice as it reads on the page, everything folded under it included (find.ts counts matches in this). */
export function noticeReads(b: NoticeBlock, now: number): string {
    switch (noticeKind(b)) {
        case "switch":
            return switchLine(b);
        case "stopped":
            return stoppedText(b.stopped!.tasks);
        case "warn": {
            const w = warnParts(b, now);
            return [plainOf(w.title), w.body ? plainOf(w.body) : undefined, ...(b.details ?? [])].filter(Boolean).join("\n");
        }
        case "error": {
            const e = errorParts(b, now);
            return [plainOf(e.title), e.body ? plainOf(e.body) : undefined, ...(b.details ?? [])].filter(Boolean).join("\n");
        }
        default:
            return [plainOf(b.text), ...(b.details ?? [])].join("\n");
    }
}

/**
 * The blocks a turn shows. A limit that stopped the turn has a card that says it: the turn's earlier "limit reached"
 * warning goes (one on credits stays: it isn't the same news).
 */
export function shownBlocks(blocks: Block[]): Block[] {
    const stopped = blocks.some((b) => b.t === "notice" && b.level === "error" && b.limit);
    if (!stopped) return blocks;
    return blocks.filter((b) => !(b.t === "notice" && b.level === "warn" && b.limit && !b.limit.credits));
}

/** The turn has an error card: it says how the turn ended, so no "Stopped with an error" line under it. */
export function hasErrorCard(blocks: Block[]): boolean {
    return blocks.some((b) => b.t === "notice" && b.level === "error" && !b.account);
}

/**
 * How many of a turn's first segments are notices from before its first step: they sit above "Worked for", where
 * they happened. A mid-turn one stays in its place, in time order.
 */
export function leadingNotices<S extends { kind: string; item?: { kind: string; block?: { t: string } } }>(segs: S[]): number {
    let n = 0;
    while (n < segs.length && segs[n]!.kind === "item" && segs[n]!.item?.kind === "block" && segs[n]!.item!.block?.t === "notice") n++;
    return n;
}
