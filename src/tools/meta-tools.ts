import type { TodoItem, Tool } from "./types";
import { MODE_INFO } from "../permissions/modes";
import { redact } from "../util/redact";
import { cleanPurpose, requestSecret, secretNameError } from "../agent/secrets";

export const TodoWriteTool: Tool<{ todos: TodoItem[] }> = {
    name: "TodoWrite",
    category: "meta",
    readOnly: true,
    description: `Creates and updates a structured task list for the current session. The user sees it, so it doubles as a progress report.

Use it for multi-step work (3+ steps), when the user gives several tasks, or when planning non-trivial changes. Skip it for single, trivial requests.

Rules:
- Send the complete list every time (it replaces the previous one).
- Exactly one task should be in_progress while you work; mark tasks completed immediately when done (don't batch).
- Only mark a task completed when it is fully done (tests pass, no errors). If blocked, keep it in_progress and add a task describing the blocker.
- content is imperative ("Run tests"); activeForm is present continuous ("Running tests").`,
    parameters: {
        type: "object",
        properties: {
            todos: {
                type: "array",
                description: "The full, updated task list",
                items: {
                    type: "object",
                    properties: {
                        content: { type: "string", description: "Task description, imperative" },
                        status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                        activeForm: { type: "string", description: "Present-continuous form shown while in progress" },
                    },
                    required: ["content", "status"],
                },
            },
        },
        required: ["todos"],
    },
    title: () => "TodoWrite",
    validate(input) {
        if (!Array.isArray(input.todos)) return "todos must be an array";
        for (const t of input.todos) {
            if (!t || typeof t.content !== "string" || !["pending", "in_progress", "completed"].includes(t.status)) return "each todo needs content and a valid status";
        }
        return undefined;
    },
    async run(input, ctx) {
        ctx.state.todos = input.todos.map((t) => ({ content: t.content, status: t.status, activeForm: t.activeForm }));
        const done = input.todos.filter((t) => t.status === "completed").length;
        return {
            content: "Todo list updated. Keep working through the tasks and keep the list current.",
            display: { summary: `${done}/${input.todos.length} done` },
        };
    },
};

export const ExitPlanModeTool: Tool<{ plan: string }> = {
    name: "ExitPlanMode",
    category: "meta",
    readOnly: true,
    description: `Call this when you are in plan mode and have finished researching and planning an implementation. Pass the plan as concise markdown (steps, files to change, risks). The user will review it: if approved, plan mode ends and you can start making changes; if rejected, keep planning based on their feedback.

Only use this for tasks that require writing code or making changes, not for research-only questions.`,
    parameters: {
        type: "object",
        properties: { plan: { type: "string", description: "The implementation plan in markdown" } },
        required: ["plan"],
    },
    title: () => "ExitPlanMode",
    async run(input, ctx) {
        if (ctx.mode() !== "plan") return { content: "You are not in plan mode; proceed with the task directly.", isError: true };
        if (!ctx.ui.approvePlan) return { content: "Plan approval is not available in this session.", isError: true };
        const decision = await ctx.ui.approvePlan(input.plan);
        if (decision.approved) {
            const mode = decision.mode ?? "default";
            ctx.setMode(mode);
            ctx.state.approvedPlan = input.plan;
            return {
                content: `The user approved your plan. Plan mode is off (permission mode: ${MODE_INFO[mode].label}). Start implementing it now, tracking progress with TodoWrite if useful.`,
                display: { summary: "Plan approved" },
            };
        }
        return {
            content: `The user rejected the plan and wants you to keep planning.${decision.feedback ? ` Their feedback: ${decision.feedback}` : ""}\nStay in plan mode: do not modify files.`,
            isError: true,
            display: { summary: "Plan rejected" },
        };
    },
};

export const AskUserQuestionTool: Tool<{ question: string; options: { label: string; description?: string }[]; multi_select?: boolean }> = {
    name: "AskUserQuestion",
    category: "meta",
    readOnly: true,
    description: `Asks the user a multiple-choice question when you genuinely need a decision only they can make (ambiguous requirements, choosing between materially different approaches). Provide 2-4 short options; the user can also type their own answer. Don't use it for things you can find out yourself or for routine confirmations.`,
    parameters: {
        type: "object",
        properties: {
            question: { type: "string", description: "The question, ending with a question mark" },
            options: {
                type: "array",
                description: "2-4 choices",
                items: {
                    type: "object",
                    properties: {
                        label: { type: "string", description: "Short option label" },
                        description: { type: "string", description: "What choosing this means" },
                    },
                    required: ["label"],
                },
            },
            multi_select: { type: "boolean", description: "Allow selecting several options" },
        },
        required: ["question", "options"],
    },
    title: (i) => `AskUserQuestion(${(i.question ?? "").slice(0, 60)})`,
    async run(input, ctx) {
        if (!ctx.ui.askQuestion) return { content: "The user is not available to answer questions (non-interactive session). Make a reasonable assumption and state it.", isError: true };
        const answer = await ctx.ui.askQuestion(input.question, input.options ?? [], Boolean(input.multi_select));
        if (!answer) return { content: "The user dismissed the question without answering. Proceed with your best judgment and state your assumption.", display: { summary: "Dismissed" } };
        return { content: `The user answered: ${answer.join(", ")}`, display: { summary: answer.join(", ") } };
    },
};

export const RequestSecretTool: Tool<{ name: string; purpose: string }> = {
    name: "RequestSecret",
    category: "meta",
    readOnly: true,
    description: `Asks the user to type in a secret (an API token, a password) that a shell command needs, without its value ever reaching you. The user sees the name and your purpose and types the value into a masked field.

- name is the environment variable it becomes, e.g. GITHUB_TOKEN. Bash commands in this session then see it as $GITHUB_TOKEN; write the variable in the command, never the value.
- purpose is one or two sentences on what it's for, shown to the user as you write it.
- You get back whether it was provided, never the value. If the user declines, don't ask again unless they bring it up.
- Asking again for the same name replaces the value.
- Its value is replaced with [REDACTED <name>] wherever it appears in tool output (as is, URL-encoded or base64). Redaction can't catch a value that's been deliberately transformed (split, reversed, re-encoded), so never transform it to print it, and don't write it into files.
- Use it only when the task needs a credential the user hasn't set up some other way (check the environment and config first), and never to ask for ordinary information.`,
    parameters: {
        type: "object",
        properties: {
            name: { type: "string", description: "The environment variable it becomes: capital letters, digits and underscores (e.g. GITHUB_TOKEN)" },
            purpose: { type: "string", description: "One or two sentences on what it's for" },
        },
        required: ["name", "purpose"],
    },
    title: (i) => `RequestSecret(${typeof i.name === "string" ? i.name.slice(0, 64) : ""})`,
    validate(input) {
        const p = cleanPurpose(input.purpose);
        return secretNameError(input.name) ?? ("error" in p ? p.error : undefined);
    },
    async run(input, ctx) {
        const p = cleanPurpose(input.purpose);
        if ("error" in p) return { content: p.error, isError: true };
        const ask = ctx.ui.requestSecret?.bind(ctx.ui);
        const r = await requestSecret({ store: ctx.state.secrets, ask, name: input.name, purpose: redact(p.text), signal: ctx.signal, using: "bash" });
        return { content: r.text, isError: r.isError, display: { summary: r.provided ? "Provided" : "Not provided" } };
    },
};

export const TaskTool: Tool<{ description: string; prompt: string; subagent_type?: string; model?: string }> = {
    name: "Task",
    category: "meta",
    readOnly: false,
    description: `Launches a sub-agent with its own fresh context to handle a self-contained task, and returns its final report. The sub-agent can't see this conversation, so the prompt must contain everything it needs (goal, relevant paths, what to return).

Agent types:
- "general-purpose": full tool access (subject to the same permissions) for multi-step research or implementation.
- "explore": read-only (Read, Glob, Grep, LS, WebFetch, WebSearch) for searching a codebase broadly and reporting findings.
- Custom agents defined in .harness/agents/*.md are also available by name.

Models: a sub-agent runs on your model unless its agent type sets one or you pass model. That can be any model set up in this harness, from any provider (API models, and Claude Code or Codex when they're turned on): for a second opinion, a review, or a task another model is better at. Call ListModels to see the agent types and models.

Use it to keep large searches or independent subtasks out of the main context, and launch several in parallel (in one response) when tasks are independent. Don't use it for a simple lookup you can do with one or two tool calls.`,
    parameters: {
        type: "object",
        properties: {
            description: { type: "string", description: "Short (3-5 word) description of the task" },
            prompt: { type: "string", description: "Complete instructions for the sub-agent" },
            subagent_type: { type: "string", description: 'Agent type: "general-purpose" (default), "explore", or a custom agent name' },
            model: { type: "string", description: "Run it on this model, as provider:model from ListModels (default: the agent type's model, else yours)" },
        },
        required: ["description", "prompt"],
    },
    title: (i) => `Task(${[i.description ?? "", i.model ?? ""].filter(Boolean).join(" · ")})`,
    async run(input, ctx) {
        if (!ctx.runSubagent) return { content: "Sub-agents are not available here.", isError: true };
        const r = await ctx.runSubagent({ description: input.description, prompt: input.prompt, agentType: input.subagent_type, model: input.model?.trim() || undefined }, ctx.signal);
        return { content: r.report, isError: r.isError, display: { summary: r.isError ? "Failed" : "Done" } };
    },
};

export const ListModelsTool: Tool<{ provider?: string; query?: string }> = {
    name: "ListModels",
    category: "meta",
    readOnly: true,
    description:
        "Lists the agent types and the models the Task tool can run a sub-agent on: every model provider set up in this harness (API providers, and Claude Code or Codex when they're turned on), with how each is billed. Without arguments it shows a few models per provider.",
    parameters: {
        type: "object",
        properties: {
            provider: { type: "string", description: "Show every model of this provider (its id, e.g. gemini)" },
            query: { type: "string", description: "Only models whose id or name contains this" },
        },
    },
    title: (i) => `ListModels(${i.provider ?? i.query ?? ""})`,
    async run(input, ctx) {
        if (!ctx.listModels) return { content: "Model listing isn't available here.", isError: true };
        const text = await ctx.listModels({ provider: input.provider?.trim() || undefined, query: input.query?.trim() || undefined }, ctx.signal);
        return { content: text, display: { summary: "Listed agent types and models" } };
    },
};
