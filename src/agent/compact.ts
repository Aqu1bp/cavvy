import type { Message, UserMessage } from "../providers/types";
import { truncateMiddle } from "../util/files";
import { framedText } from "../providers/files";

export const COMPACT_PROMPT = `Your task is to write a detailed summary of the conversation so far. The summary replaces the conversation history, so it must preserve everything needed to continue the work without losing context.

Respond with text only. Do not call any tools.

Structure the summary with these sections:

1. Primary request and intent: everything the user asked for, in detail, including constraints and preferences. Quote the user's exact words where they matter.
2. Key technical concepts: technologies, frameworks, conventions and decisions involved.
3. Files and code: every file examined, created or modified, why it matters, and the important code (include short snippets for recent or tricky changes).
4. Errors and fixes: problems hit and how they were resolved, including any user feedback or corrections.
5. Problem solving: what has been solved and any ongoing troubleshooting.
6. All user messages: list every message from the user that isn't a tool result, verbatim or near-verbatim.
7. Pending tasks: work the user asked for that isn't done yet.
8. Current work: precisely what was being worked on immediately before this summary, with file names and code.
9. Next step: the next step that directly continues the most recent work, consistent with the user's latest request. Include a verbatim quote from the most recent messages showing where things left off. If the last task was finished, only list a next step the user actually asked for.`;

export function compactRequestMessage(extra?: string): UserMessage {
    return {
        role: "user",
        content: [{ type: "text", text: COMPACT_PROMPT + (extra?.trim() ? `\n\nAdditional instructions from the user for this summary:\n${extra.trim()}` : "") }],
        meta: { kind: "command" },
    };
}

/**
 * The conversation as condensed plain text, for when the real history is too
 * long to summarize: tool inputs and outputs are cut short, the first message
 * (usually the user's request) is always kept, and the rest is filled in from
 * the most recent end. No message takes more than a quarter of the space, so
 * one huge batch of tool results can't push out what was said around it.
 */
export function compactTranscriptText(messages: Message[], maxChars: number): string {
    const cap = Math.floor(maxChars / 4);
    const blocks = messages
        .map((m) => renderForTranscript(m, cap).text)
        .filter(Boolean)
        .map((b) => truncateMiddle(b, cap));
    if (!blocks.length) return "";
    const first = blocks[0]!;
    const recent: string[] = [];
    let used = first.length;
    for (let i = blocks.length - 1; i >= 1; i--) {
        const b = blocks[i]!;
        if (used + b.length + 2 > maxChars) {
            recent.push("[… earlier messages omitted …]");
            break;
        }
        recent.push(b);
        used += b.length + 2;
    }
    return [first, ...recent.reverse()].join("\n\n");
}

/** Handoffs keep the initial task, then whole recent user messages, before other history. */
export function handoffTranscript(messages: Message[], maxChars: number): { text: string; shortenedChars: number } {
    // Queued user instructions can share a message with a batch of tool results.
    const blocks = messages.flatMap((m) => {
        if (m.role !== "user") return [{ ...renderForTranscript(m, maxChars), user: false }];
        const results = m.content.filter((p) => p.type === "tool_result");
        const content = m.content.filter((p) => p.type !== "tool_result");
        return [{ ...renderForTranscript({ ...m, content: results }, maxChars), user: false }, { ...renderForTranscript({ ...m, content }, maxChars, true), user: true }];
    });
    const first = blocks.findIndex((b) => b.user && b.text);
    const recent = blocks.map((_, i) => i).reverse();
    const order = [first, ...recent.filter((i) => i !== first && blocks[i]!.user), ...recent.filter((i) => !blocks[i]!.user)];
    const selected = new Map<number, string>();
    let remaining = Math.max(0, Math.floor(maxChars));
    let shortenedChars = blocks.reduce((n, b) => n + b.originalChars, 0);
    for (const i of order) {
        const b = blocks[i];
        if (!b?.text) continue;
        const available = remaining - (selected.size ? 2 : 0);
        let text = b.text;
        let kept = b.keptChars;
        if (text.length > available) {
            // Only an oversized user message is cut again; capped assistant/tool blocks can wait.
            if (!b.user || text.length <= maxChars) continue;
            // The full omission marker bounds its digit counts, including the omitted lines.
            kept = available - truncateMiddle(text, 0).length;
            if (kept <= 0) continue;
            text = truncateMiddle(text, kept);
        }
        selected.set(i, text);
        remaining -= text.length + (selected.size > 1 ? 2 : 0);
        shortenedChars -= kept;
    }
    return { text: [...selected].sort(([a], [b]) => a - b).map(([, text]) => text).join("\n\n"), shortenedChars };
}

/**
 * A message as a transcript entry, and how much of it that keeps (what a
 * handoff shortened is said). Past `cap`, whole attached files go (the last
 * first) rather than shortening the message through a frame.
 */
function renderForTranscript(m: Message, cap: number, wholeUserText = false): { text: string; originalChars: number; keptChars: number } {
    const parts: { text: string; original: number; kept: number; file?: string }[] = [];
    const part = (text: string, max: number, prefix = "", suffix = "") =>
        parts.push({ text: prefix + truncateMiddle(text, max) + suffix, original: prefix.length + text.length + suffix.length, kept: prefix.length + Math.min(text.length, max) + suffix.length });
    for (const p of m.content) {
        if (p.type === "text") part(p.text, wholeUserText && m.role === "user" ? p.text.length : 4000);
        else if (p.type === "tool_call") part(JSON.stringify(p.input), 600, `[called ${p.name}: `, "]");
        else if (p.type === "tool_result") part(p.content, 1500, `[${p.isError ? "error from" : "result of"} ${p.toolName}: `, "]");
        else if (p.type === "image") part("[image]", 7);
        else if (p.type === "file") {
            if (p.kind === "pdf") part(`[the user attached ${p.name} earlier; its contents aren't included here]`, Infinity);
            else {
                // Framed here too (shortened first), so a file can't pass for the transcript's own lines.
                // A paste is the user's own words, as their text is.
                const inner = truncateMiddle(p.text, wholeUserText && p.pasted ? p.text.length : 4000);
                const text = framedText({ ...p, text: inner });
                const kept = text.length - inner.length + Math.min(p.text.length, inner === p.text ? p.text.length : 4000);
                parts.push({ text, original: text.length - inner.length + p.text.length, kept, file: p.name });
            }
        }
    }
    if (!parts.length) return { text: "", originalChars: 0, keptChars: 0 };
    const results = m.content.every((p) => p.type === "tool_result");
    const left: string[] = [];
    const render = () => {
        const shown = parts.filter((x) => x.text).map((x) => x.text);
        if (left.length) shown.push(`[${left.length === 1 ? "an attached file" : `${left.length} attached files`} left out here, too long to include: ${left.join(", ")}]`);
        return results ? shown.join("\n") : `${m.role === "user" ? "User" : "Assistant"}: ${shown.join("\n")}`;
    };
    let text = render();
    for (let i = parts.length - 1; i >= 0 && text.length > cap; i--) {
        const x = parts[i]!;
        if (!x.file || !x.text) continue;
        left.unshift(x.file);
        x.text = "";
        x.kept = 0;
        text = render();
    }
    // What the entry adds (its role, line breaks, the note of files left out) counts as kept.
    const cut = parts.reduce((n, x) => n + x.text.length - x.kept, 0);
    const keptChars = text.length - cut;
    return { text, originalChars: keptChars + parts.reduce((n, x) => n + x.original - x.kept, 0), keptChars };
}

/** The compaction request with a condensed transcript in place of the full history. */
export function transcriptCompactRequest(transcript: string, extra?: string): UserMessage {
    const req = compactRequestMessage(extra);
    const intro = `The conversation is too long to send in full, so here is a condensed transcript of it (long tool inputs and outputs are shortened):\n\n<transcript>\n${transcript}\n</transcript>`;
    return { ...req, content: [{ type: "text", text: intro }, ...req.content] };
}

/** The message that replaces history after compaction. */
export function summaryMessage(summary: string, continuing: boolean): UserMessage {
    const text =
        `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${summary.trim()}` +
        (continuing ? `\n\nContinue the work from where it left off without asking the user any further questions. Pick up the last task as if the break never happened.` : "");
    return { role: "user", content: [{ type: "text", text }], meta: { kind: "summary", display: "(conversation summary)" } };
}

/** Rough token estimate for messages we have no usage figures for. */
export function estimateTokens(messages: Message[]): number {
    let chars = 0;
    for (const m of messages) {
        for (const p of m.content) {
            if (p.type === "text") chars += p.text.length;
            else if (p.type === "tool_result") chars += p.content.length + (p.images?.length ?? 0) * 6000;
            else if (p.type === "tool_call") chars += JSON.stringify(p.input).length + 50;
            else if (p.type === "thinking") chars += p.text.length;
            else if (p.type === "image") chars += 6000;
            // A PDF's pages are read as text and images: a rough guess from its size.
            else if (p.type === "file") chars += p.kind === "text" ? p.text.length + 300 : Math.max(6000, Math.round(p.size / 6));
        }
    }
    return Math.ceil(chars / 3.5);
}
