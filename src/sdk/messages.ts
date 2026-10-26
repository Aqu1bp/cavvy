// The messages a run reports: what the SDK yields, and what
// `cavvy -p --output-format stream-json` prints, one JSON object a line.
// Both come from here, so they keep the same shapes.

import type { AgentEvent, TurnEndReason } from "../agent/agent";
import { textOf, type Usage } from "../providers/types";
import { addUsage, emptyUsage } from "../providers/pricing";
import type { PermissionMode } from "../permissions/modes";

export type SDKContentBlock =
    | { type: "text"; text: string }
    | { type: "thinking"; text: string }
    | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> };

export interface SDKSystemInitMessage {
    type: "system";
    subtype: "init";
    session_id: string;
    cwd: string;
    /** provider:model */
    model: string;
    permission_mode: PermissionMode;
    /** The tools the model is offered (empty for an agent backend, which uses its own). */
    tools: string[];
    /** Set when the model is an agent CLI (Claude Code, Codex). */
    agent_backend?: string;
    mcp_servers: { name: string; status: string }[];
}

export interface SDKNoticeMessage {
    type: "system";
    subtype: "notice";
    level: "info" | "warn" | "error";
    message: string;
}

export interface SDKRetryMessage {
    type: "system";
    subtype: "retry";
    attempt: number;
    delay_ms: number;
    reason: string;
}

export interface SDKCompactMessage {
    type: "system";
    subtype: "compact";
    summary_chars: number;
}

export interface SDKAssistantMessage {
    type: "assistant";
    session_id: string;
    message: { role: "assistant"; content: SDKContentBlock[] };
    /** The Task call a sub-agent's message belongs to (SDK only). */
    parent_tool_use_id?: string;
}

export interface SDKToolResultMessage {
    type: "tool_result";
    session_id: string;
    tool_use_id: string;
    tool: string;
    is_error: boolean;
    content: string;
    parent_tool_use_id?: string;
}

/** Text as it streams in (with `includePartialMessages`). */
export interface SDKPartialMessage {
    type: "stream_event";
    session_id: string;
    event: { type: "text_delta" | "thinking_delta"; text: string };
}

export type ResultSubtype = "success" | "error_max_turns" | "error_aborted" | "error_during_execution";

export interface SDKResultMessage {
    type: "result";
    subtype: ResultSubtype;
    is_error: boolean;
    /** The last text the model wrote this turn. */
    result: string;
    session_id: string;
    model: string;
    /** Model responses this turn (each tool round is one). */
    num_turns: number;
    duration_ms: number;
    total_cost_usd: number;
    usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
    /** Tools whose calls were denied this turn, one entry a call. */
    permission_denials: string[];
    /** Why the turn failed, from the run's error notices. */
    errors: string[];
}

export type SDKMessage =
    | SDKSystemInitMessage
    | SDKNoticeMessage
    | SDKRetryMessage
    | SDKCompactMessage
    | SDKAssistantMessage
    | SDKToolResultMessage
    | SDKPartialMessage
    | SDKResultMessage;

export interface MapOptions {
    sessionId: string;
    /** Keep thinking blocks in assistant messages. */
    thinking: boolean;
    /** stream_event deltas. */
    partial: boolean;
    /** Sub-agents' assistant messages and tool results, with parent_tool_use_id. */
    subagents: boolean;
}

/** Tool output beyond this is cut in messages (the model got all of it). */
export const TOOL_CONTENT_LIMIT = 20_000;

/** The message an agent event becomes, if any. */
export function messageOf(e: AgentEvent, o: MapOptions, parent?: string): SDKMessage | undefined {
    const sub = parent ? { parent_tool_use_id: parent } : {};
    switch (e.type) {
        case "assistant":
            return { type: "assistant", session_id: o.sessionId, message: { role: "assistant", content: e.message.content.filter((p) => p.type !== "thinking" || o.thinking) as SDKContentBlock[] }, ...sub };
        case "tool_end":
            return { type: "tool_result", session_id: o.sessionId, tool_use_id: e.call.id, tool: e.call.name, is_error: Boolean(e.result.isError), content: e.result.content.slice(0, TOOL_CONTENT_LIMIT), ...sub };
        case "text":
        case "thinking":
            if (!o.partial || parent || (e.type === "thinking" && !o.thinking)) return undefined;
            return { type: "stream_event", session_id: o.sessionId, event: { type: e.type === "text" ? "text_delta" : "thinking_delta", text: e.text } };
        case "subagent":
            return o.subagents && !parent && (e.event.type === "assistant" || e.event.type === "tool_end") ? messageOf(e.event, o, e.parentId) : undefined;
    }
    if (parent) return undefined;
    switch (e.type) {
        case "notice":
            return { type: "system", subtype: "notice", level: e.level, message: e.message };
        case "retry":
            return { type: "system", subtype: "retry", attempt: e.attempt, delay_ms: e.delayMs, reason: e.reason };
        case "compact_end":
            return { type: "system", subtype: "compact", summary_chars: e.summary.length };
    }
    return undefined;
}

/** The text that says a call was denied because nobody could approve it. */
export const NON_INTERACTIVE_DENIAL = /not granted \(non-interactive session\)/;

/** What one turn did, for its result message. */
export class TurnTally {
    numTurns = 0;
    lastText = "";
    cost = 0;
    usage: Usage = emptyUsage();
    denials: string[] = [];
    errors: string[] = [];
    readonly started = Date.now();

    observe(e: AgentEvent) {
        switch (e.type) {
            case "assistant": {
                this.numTurns++;
                const t = (e.answer ?? textOf(e.message)).trim();
                if (t) this.lastText = t;
                break;
            }
            case "tool_end":
                if (e.result.isError && NON_INTERACTIVE_DENIAL.test(e.result.content)) this.denials.push(e.call.name);
                break;
            case "usage":
                if (!e.displayOnly) this.addUsage(e.usage, e.cost.usd);
                break;
            case "subagent":
                // Session folding persists these records without re-emitting them.
                if (e.event.type === "usage" || e.event.type === "subagent") this.observe(e.event);
                break;
            case "notice":
                if (e.level === "error") this.errors.push(e.message);
                break;
        }
    }

    addUsage(usage: Usage, usd: number) {
        this.cost += usd;
        this.usage = addUsage(this.usage, usage);
    }

    result(reason: TurnEndReason, sessionId: string, model: string): SDKResultMessage {
        const subtype: ResultSubtype = reason === "done" ? "success" : reason === "max_turns" ? "error_max_turns" : reason === "aborted" ? "error_aborted" : "error_during_execution";
        return {
            type: "result",
            subtype,
            is_error: reason !== "done",
            result: this.lastText,
            session_id: sessionId,
            model,
            num_turns: this.numTurns,
            duration_ms: Date.now() - this.started,
            total_cost_usd: Number(this.cost.toFixed(6)),
            usage: { input_tokens: this.usage.inputTokens, output_tokens: this.usage.outputTokens, cache_read_input_tokens: this.usage.cacheReadTokens ?? 0, cache_creation_input_tokens: this.usage.cacheWriteTokens ?? 0 },
            permission_denials: [...this.denials],
            errors: [...this.errors],
        };
    }
}

