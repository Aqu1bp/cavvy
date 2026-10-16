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
export function transcriptText(messages: Message[], maxChars: number): string {
    const cap = Math.floor(maxChars / 4);
    const blocks = messages
        .map(renderForTranscript)
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

function renderForTranscript(m: Message): string {
    const out: string[] = [];
    for (const p of m.content) {
        if (p.type === "text") out.push(truncateMiddle(p.text, 4000));
        else if (p.type === "tool_call") out.push(`[called ${p.name}: ${truncateMiddle(JSON.stringify(p.input), 600)}]`);
        else if (p.type === "tool_result") out.push(`[${p.isError ? "error from" : "result of"} ${p.toolName}: ${truncateMiddle(p.content, 1500)}]`);
        else if (p.type === "image") out.push("[image]");
        // Framed here too, so a file can't pass for the transcript's own lines.
        else if (p.type === "file") out.push(p.kind === "text" ? framedText({ ...p, text: truncateMiddle(p.text, 4000) }) : `[attached PDF ${p.name}]`);
    }
    if (!out.length) return "";
    const results = m.content.every((p) => p.type === "tool_result");
    return results ? out.join("\n") : `${m.role === "user" ? "User" : "Assistant"}: ${out.join("\n")}`;
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
