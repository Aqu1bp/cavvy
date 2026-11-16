// What a session's history says that's needed without reading all of it: its tool state (the todos, the plan last
// approved), the plan last presented, and the latest checkpoint's id. Session.read keeps these with a checkpoint of
// a session whose messages are most of it (a Claude Code one's: never compacted here), in place of the messages.

import type { Message } from "../providers/types";
import type { TodoItem } from "../tools/types";

export interface ToolHistory {
    todos: TodoItem[];
    approvedPlan?: string;
}

/**
 * The todos and the approved plan as the history leaves them: the last TodoWrite and ExitPlanMode that succeeded (or a
 * summary's), from `start` (what the messages before these left). A call's result comes before the next prompt, so
 * from a prompt on, the messages say all there is about their calls.
 */
export function toolStateOf(messages: readonly Message[], start: ToolHistory = { todos: [] }): ToolHistory {
    const ok = new Set<string>();
    for (const m of messages) {
        if (m.role === "user") for (const p of m.content) if (p.type === "tool_result" && !p.isError) ok.add(p.toolCallId);
    }
    let todos: TodoItem[] = start.todos;
    let plan: string | undefined = start.approvedPlan;
    for (const m of messages) {
        if (m.role === "user" && m.meta?.kind === "summary" && m.meta.compactedState) {
            todos = m.meta.compactedState.todos.map((t) => ({ ...t }));
            plan = m.meta.compactedState.approvedPlan;
        }
        if (m.role !== "assistant") continue;
        for (const p of m.content) {
            if (p.type !== "tool_call" || !ok.has(p.id)) continue;
            if (p.name === "TodoWrite" && Array.isArray(p.input.todos)) {
                todos = (p.input.todos as TodoItem[]).map((t) => ({ content: t.content, status: t.status, activeForm: t.activeForm }));
            } else if (p.name === "ExitPlanMode" && typeof p.input.plan === "string") plan = p.input.plan;
        }
    }
    return { todos, ...(plan !== undefined ? { approvedPlan: plan } : {}) };
}

/** The last ExitPlanMode call with a plan, answered or not (the plan presented last). */
export function lastPlanCall(messages: readonly Message[]): { id: string; text: string } | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role !== "assistant") continue;
        for (let j = m.content.length - 1; j >= 0; j--) {
            const p = m.content[j]!;
            if (p.type === "tool_call" && p.name === "ExitPlanMode" && typeof p.input?.plan === "string") return { id: p.id, text: String(p.input.plan) };
        }
    }
    return undefined;
}

/** The checkpoint the last message that records one records (where the next turn's snapshot starts from). */
export function latestCheckpointOf(messages: readonly Message[]): number | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role === "user" && m.meta?.checkpoint !== undefined) return m.meta.checkpoint;
    }
    return undefined;
}

/** The highest checkpoint a message records (FileHistory's ids go on past it). */
export function lastCheckpointOf(messages: readonly Message[]): number {
    let last = 0;
    for (const m of messages) if (m.role === "user" && m.meta?.checkpoint) last = Math.max(last, m.meta.checkpoint);
    return last;
}

/** A turn's prompt (as the server's isPrompt says): where the digest's last messages start from. */
export const isPromptMessage = (m: Message) => m.role === "user" && (m.meta?.kind === undefined || m.meta.kind === "prompt" || m.meta.kind === "command" || m.meta.kind === "wake");

/** In place of a session's messages, what's needed of them without reading them (Session.read). */
export interface MessagesDigest {
    count: number;
    /** Where `tail` starts: its last prompt. */
    from: number;
    /** The messages from its last prompt on. */
    tail: Message[];
    /** The tool state the messages before `tail` leave (toolStateOf). */
    before: ToolHistory;
    /** The last plan presented (lastPlanCall). */
    plan?: { id: string; text: string };
    /** The highest checkpoint a message records (lastCheckpointOf). */
    checkpoint: number;
    /** The checkpoint the last one recording one records (latestCheckpointOf). */
    latestCheckpoint?: number;
}

export function digestOf(messages: readonly Message[]): MessagesDigest {
    let from = messages.length - 1;
    while (from > 0 && !isPromptMessage(messages[from]!)) from--;
    from = Math.max(0, from);
    const plan = lastPlanCall(messages);
    const latestCheckpoint = latestCheckpointOf(messages);
    return { count: messages.length, from, tail: messages.slice(from), before: toolStateOf(messages.slice(0, from)), ...(plan ? { plan } : {}), checkpoint: lastCheckpointOf(messages), ...(latestCheckpoint !== undefined ? { latestCheckpoint } : {}) };
}

/** The digest of its messages and `m` after them: as digestOf them all makes. */
export function digestWith(d: MessagesDigest, m: Message): MessagesDigest {
    const plan = lastPlanCall([m]) ?? d.plan;
    const checkpoint = Math.max(d.checkpoint, lastCheckpointOf([m]));
    const latestCheckpoint = latestCheckpointOf([m]) ?? d.latestCheckpoint;
    const marks = { ...(plan ? { plan } : {}), checkpoint, ...(latestCheckpoint !== undefined ? { latestCheckpoint } : {}) };
    if (isPromptMessage(m)) return { count: d.count + 1, from: d.count, tail: [m], before: toolStateOf(d.tail, d.before), ...marks };
    return { ...d, count: d.count + 1, tail: [...d.tail, m], ...marks };
}

/** The tool state its messages leave (toolStateOf them all). */
export function digestToolState(d: MessagesDigest): ToolHistory {
    return toolStateOf(d.tail, d.before);
}
