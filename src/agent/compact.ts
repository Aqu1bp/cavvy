import type { Message, UserMessage } from "../providers/types";

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
        }
    }
    return Math.ceil(chars / 3.5);
}
