// SuggestTask: the agent, having come across a problem unrelated to its task,
// suggests it to the user as a card (src/agent/suggestions.ts). It returns at
// once and starts nothing: the user picks where and on what, and presses
// Start (tasks.start) or Dismiss. API models get it as a Cavvy tool; Claude
// Code and Codex as suggest_task through Cavvy's MCP server, checked as this.

import { randomUUID } from "crypto";
import type { ServerTool, ServerToolResult } from "../mcp/server";
import { checkSuggestion } from "../agent/suggestions";
import { EFFORT_LEVELS } from "../config/settings";
import { MCP_SERVER_NAME } from "../config/name";
import type { Tool, ToolContext } from "./types";

type Input = { title: string; prompt: string; why: string; model?: string; effort?: string };

const DESCRIPTION = `Suggest a separate task to the user, as a card they can start as a new session or dismiss. Use it on your own initiative when, while working, you come across a problem unrelated to your task: a bug, a UI glitch, something that doesn't work as it should, a test failing for a reason your change didn't cause. Don't fix it here, and don't just mention it or offer to fix it: suggest it and carry on. Nothing starts until the user presses Start; they choose the model, machine and folder, and may edit the prompt. You get no answer: don't wait for one, and don't bring the suggestion up again unless asked.
- Not for your own task or any part of it, or for something the user asked for: do that, or say what's left.
- Not for a hunch: say what you saw that shows it.
- One per problem, at most 3 a turn.
- prompt is the new session's first message, self-contained (it hasn't seen this conversation): what's wrong, where (files, commands, steps to reproduce), what you saw, and what done looks like.`;

const SCHEMA = {
    type: "object",
    properties: {
        title: { type: "string", description: "A few words naming the problem (at most 80 characters); the new session's title." },
        prompt: { type: "string", description: "The new session's first message, self-contained (at most 4000 characters)." },
        why: { type: "string", description: "One sentence: what you saw, and where (at most 200 characters)." },
        model: { type: "string", description: "provider:model you'd suggest for it. Default: the user picks." },
        effort: { type: "string", enum: EFFORT_LEVELS, description: "Reasoning effort you'd suggest. Default: the user picks." },
    },
    required: ["title", "prompt", "why"],
};

const NO_HOST = "Tasks can't be suggested from here. Mention the problem in your reply instead.";

/** Checked before anything is recorded: the input, and a model or effort hint this machine can't take. */
async function inputError(i: Record<string, unknown>, ctx: ToolContext): Promise<string | undefined> {
    const c = checkSuggestion(i);
    if ("error" in c) return c.error;
    const hint = c.input.hint;
    return hint ? ctx.state.peers?.checkStart?.({ model: hint.model, effort: hint.effort }) : undefined;
}

const titleOf = (i: Record<string, unknown>) => (typeof i.title === "string" ? i.title.replace(/\s+/g, " ").trim().slice(0, 60) : "");

export const SuggestTaskTool: Tool<Input> = {
    name: "SuggestTask",
    category: "meta",
    readOnly: true,
    description: DESCRIPTION,
    parameters: SCHEMA,
    title: (i) => `SuggestTask(${titleOf(i as Record<string, unknown>)})`,
    validate: (input, ctx) => inputError(input as Record<string, unknown>, ctx),
    async run(input, ctx) {
        const host = ctx.state.suggest;
        if (!host) return { content: NO_HOST, isError: true };
        const c = checkSuggestion(input as Record<string, unknown>);
        if ("error" in c) return { content: c.error, isError: true };
        // Its id is the call's, which the card stands in for; a call without one still gets its card.
        const r = host.suggest(c.input, ctx.callId ?? `suggest-${randomUUID()}`);
        if ("error" in r) return { content: r.error, isError: true };
        return {
            content: `Suggested “${c.input.title}” to the user. Nothing has started: they decide. Carry on with your task; don't work on it here.`,
            display: { summary: `Suggested “${c.input.title}”` },
        };
    },
};

export const SUGGEST_TOOLS: Tool<any>[] = [SuggestTaskTool];
export const SUGGEST_TOOL_NAMES = SUGGEST_TOOLS.map((t) => t.name);

// ---------------------------------------------------------------------------
// The same, for Claude Code and Codex through Cavvy's MCP server.

export const SUGGEST_SERVER_TOOL = "suggest_task";

const served = (text: string) => text.replaceAll("SuggestTask", SUGGEST_SERVER_TOOL);

/** suggest_task: `run` takes the call through Cavvy's checks (rules, hooks, mode), as SuggestTask called by a model Cavvy runs. */
export function suggestServerTools(run: (tool: Tool<any>, input: Record<string, unknown>, signal: AbortSignal, callId?: string) => Promise<ServerToolResult>): ServerTool[] {
    return [
        {
            name: SUGGEST_SERVER_TOOL,
            title: "Suggest a task",
            description: served(DESCRIPTION),
            inputSchema: SCHEMA,
            annotations: { readOnlyHint: true, openWorldHint: false },
            call: async (args, { signal, meta }) => {
                const r = await run(SuggestTaskTool, args, signal, typeof meta.callId === "string" ? meta.callId : undefined);
                return { ...r, text: served(r.text) };
            },
        },
    ];
}

/** SuggestTask, by its served name (suggest_task). */
export function servedSuggestName(tool: string): string | undefined {
    return tool === SuggestTaskTool.name ? SUGGEST_SERVER_TOOL : undefined;
}

/** A served call (mcp__cavvy__suggest_task's bare name) as the Cavvy tool it is, for the transcript. */
export function nativeSuggestCall(tool: string, input: Record<string, unknown>): { name: string; input: Record<string, unknown> } | undefined {
    return tool === SUGGEST_SERVER_TOOL ? { name: SuggestTaskTool.name, input } : undefined;
}

/** Whether a call (by the name its backend gave it) is suggest_task, which Cavvy runs its own hooks for. */
export function servedSuggestTool(server: string | undefined, toolName: unknown): boolean {
    return Boolean(server) && toolName === `mcp__${server}__${SUGGEST_SERVER_TOOL}`;
}

/** The served tool's name as the CLI calls it. */
export const SERVED_SUGGEST_NAME = `mcp__${MCP_SERVER_NAME}__${SUGGEST_SERVER_TOOL}`;

/**
 * What gets an agent to use suggest_task unprompted: a CLI may list it by name alone. Codex (and other CLIs) get it in
 * Cavvy's MCP server instructions; Claude Code in its system prompt (suggestNote), since it keeps only the start of a
 * server's instructions.
 */
export const SUGGEST_INSTRUCTIONS = `# Suggesting tasks (${MCP_SERVER_NAME})

Before you reply, if you noticed a problem unrelated to what you were asked (a bug, a UI glitch, a test failing for a reason your change didn't cause), call ${SUGGEST_SERVER_TOOL} with a title, a self-contained prompt and why, then carry on with your task. Do this instead of fixing it, offering to fix it or only mentioning it: the user gets a card to start it as a new session, and nothing starts until they do.`;

/** For Claude Code's --append-system-prompt: SUGGEST_INSTRUCTIONS, where Cavvy's MCP server offers it suggest_task. */
export function suggestNote(orchestrator: { tools: readonly string[] } | undefined): string | undefined {
    return orchestrator?.tools.includes(SUGGEST_SERVER_TOOL) ? SUGGEST_INSTRUCTIONS : undefined;
}
