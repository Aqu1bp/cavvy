// What Find in a conversation finds: the text each part of a turn shows, as the page shows it, and where a query
// appears in it. No page needed: the window counts the turns it has, the server those it hasn't sent
// (src/server/find.ts), and both count the same way.

import { foldCase, type Block, type Turn } from "@shared/protocol";
import { cardOf } from "./cards";
import { planTitle } from "./plan-chat";
import { commandDescription, sameInARow, toolLabel } from "./tool-words";
import { commandLabel, commandMeta, firstStep, liveCommand, outputLines } from "./command-row";
import { stripAnsi } from "./format";
import { renderMarkdown } from "./markdown";
import { splitComments } from "./review-comments";
import { noticeReads } from "./notices";

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

/**
 * The text of HTML the transcript renders, as the page has it (an element's textContent): its tags taken out and its
 * characters decoded. Exactly so for what renderMarkdown makes: its attributes are escaped (no ">" in them), and raw
 * HTML in a reply is shown as text (escaped), so there's nothing else to parse.
 */
export function htmlText(html: string): string {
    return decodeEntities(html.replace(/<[^>]*>/g, ""));
}

/**
 * Character references as a page reads them. In a window, by its own parser (a textarea's text is parsed for them and
 * nothing else); on the server, by the same table (setEntityDecoder: entity-decoder.ts), which the window's bundle
 * needn't carry (47 KB). Without either (a test without a page), the references the renderer itself writes.
 */
let decoder: ((s: string) => string) | undefined;
/** (Read through globalThis: the server's own type check has no page.) */
type Area = { innerHTML: string; value: string };
let area: Area | undefined;

export function setEntityDecoder(decode: (s: string) => string) {
    decoder = decode;
}

function decodeEntities(s: string): string {
    if (!s.includes("&")) return s;
    if (decoder) return decoder(s);
    const page = (globalThis as { document?: { createElement?: (tag: "textarea") => Area } }).document;
    if (typeof page?.createElement === "function") {
        area ??= page.createElement("textarea");
        area.innerHTML = s;
        return area.value;
    }
    return s.replace(/&(lt|gt|quot|#39|amp);/g, (_, e: string) => ({ lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" })[e]!);
}

/** Markdown as it reads on the page: rendered the way the transcript renders it, then its text. */
export function plain(md: string): string {
    let text = shownText.get(md);
    if (text === undefined) {
        text = htmlText(renderMarkdown(md));
        // Finished replies don't change; a streaming one is a new key each time, so old ones go.
        if (shownText.size > 4000) shownText.clear();
        shownText.set(md, text);
    }
    return text;
}

/**
 * What a block shows, as find sees it. Thinking isn't searched; a tool row is its title and summary, not its
 * output (its details are for reading, not searching); a finished command's row is its command and output too.
 */
/** `counted`: the first of a run of the same call, drawn as one row with a count and no result (sameInARow). */
function blockText(b: Block, counted = false): string | undefined {
    switch (b.t) {
        case "text":
            return plain(b.text);
        case "tool": {
            const l = toolLabel(b);
            // A sub-agent's row starts with its task, not the word "Agent", running or not.
            if (b.agent) return typeof b.input?.description === "string" && b.input.description.trim() ? b.input.description.trim() : l.arg;
            // A plan's card: its title (the rest is a faded glimpse; the plan dialog has all of it).
            if (cardOf(b) === "plan") return b.status === "streaming" || b.status === "queued" ? undefined : planTitle(String(b.input?.plan ?? "")) || "Plan";
            if (cardOf(b) === "command") {
                // As its row reads folded: its label (what it's for, or the command shortened) and what it came to;
                // opened, all of the command and its output.
                if (b.status === "streaming") return undefined;
                // Under way, the turn's live line shows it: what it says after its label is what find counts there.
                if (b.status === "running" || b.status === "queued") return liveCommand(b);
                if (b.status === "awaiting") return commandDescription(b) ?? firstStep(String(b.input?.command ?? ""));
                const head = [commandLabel(b), commandMeta(b)].filter(Boolean).join(" ");
                const command = String(b.input?.command ?? "").trim();
                // Its output as the opened row draws it (without the exit code the tool adds: the footer, which find skips, says it).
                const output = outputLines(b.output, b.status === "error").join("\n");
                return [head, command || undefined, output.trim() ? output : undefined].filter(Boolean).join("\n");
            }
            // Still running: its argument, which its live row shows as long as it runs (nothing while the call is still arriving).
            if (b.status === "running" || b.status === "queued" || b.status === "awaiting") return l.arg;
            if (b.status === "streaming") return undefined;
            // As the row reads, a space between each part (ToolRow puts one there): verb, argument, summary.
            // A card (an edit, a command) doesn't show its verb: it's there for the screen reader only.
            const meta = counted ? undefined : b.status === "denied" ? "Declined" : b.diff && b.status === "ok" ? undefined : b.summary;
            return [cardOf(b) ? undefined : l.verb, l.arg, meta].filter(Boolean).join(" ");
        }
        case "peer":
            // A message from another session that joined the turn, as it's quoted.
            return b.text;
        case "notice":
            // As it reads opened (lib/notices.ts): its title or line, then what folds under it.
            return noticeReads(b, Date.now());
        case "compact":
            return plain(b.summary);
        case "shell":
            return `${b.command}\n${stripAnsi(b.output)}`;
        default:
            return undefined;
    }
}

export function findParts(turn: Turn): { part: string; text: string }[] {
    const out: { part: string; text: string }[] = [];
    if (turn.prompt?.text) {
        // As drawn: the typed text, then each review comment's text (their markup isn't shown).
        const { text, comments } = splitComments(turn.prompt.text);
        out.push({ part: "prompt", text: [text, ...comments.map((c) => c.text)].filter(Boolean).join("\n") });
    }
    // The same call made again in a row is drawn once, counted (Activity.tsx StepRows): no row of its own to find in.
    const same = sameInARow(turn.blocks, { apart: (t) => Boolean(cardOf(t)) });
    for (const b of turn.blocks) {
        if (same.joined.has(b.id)) continue;
        const text = blockText(b, same.more.has(b.id));
        if (text) out.push({ part: b.id, text });
    }
    return out;
}

/** Every place `query` (literal, any case) appears, in order. */
export function findMatches(turns: readonly Turn[], query: string): FindMatch[] {
    return matchesIn(turns, (t) => foldedParts(t), query);
}

/** A turn's parts with their text case-folded: what's searched (findMatches; the server keeps them: src/server/find.ts). */
export function foldedParts(turn: Turn): { part: string; folded: string }[] {
    return findParts(turn).map((p) => ({ part: p.part, folded: foldCase(p.text) }));
}

/** Every place `query` appears in these turns' parts (`parts`), in order, at most MAX_MATCHES. */
export function matchesIn(turns: readonly Turn[], parts: (t: Turn) => readonly { part: string; folded: string }[], query: string): FindMatch[] {
    const q = foldCase(query);
    const out: FindMatch[] = [];
    if (!q) return out;
    for (const t of turns) {
        for (const p of parts(t)) {
            let n = 0;
            for (let i = p.folded.indexOf(q); i >= 0; i = p.folded.indexOf(q, i + q.length)) {
                out.push({ turnId: t.id, part: p.part, n: n++ });
                if (out.length >= MAX_MATCHES) return out;
            }
        }
    }
    return out;
}
