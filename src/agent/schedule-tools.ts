// The model's side of scheduling: CronCreate, CronList and CronDelete, as
// Claude Code names them. API models get them as harness tools; Claude Code
// and Codex get the same through the harness MCP server (their own per-turn
// processes couldn't keep a schedule). Jobs go to the session's Scheduler and
// fire in that session, while it's idle.

import type { ServerTool, ServerToolResult } from "../mcp/server";
import type { Tool, ToolResult } from "../tools/types";
import { CronError } from "../util/cron";
import { clipPrompt, describeJob, MAX_JOBS, MAX_PROMPT, RECURRING_TTL_MS, shortTime, type Scheduler, type ScheduledJob } from "./schedule";

export const CRON_TOOL_NAMES = ["CronCreate", "CronList", "CronDelete"];

const CREATE_DESCRIPTION = `Schedule a prompt to run later in this session, once or on a cron schedule. When it comes due and the session is idle, the prompt runs as if the user had sent it (slash commands work too). If the session is busy then, it runs once as soon as it isn't.

Uses standard 5-field cron in the user's local time zone: minute hour day-of-month month day-of-week. "0 9 * * *" means 9am local.

One-shot (recurring: false), for "remind me at X" or "at <time>, do Y": pin minute, hour, day of month and month, e.g. "30 14 21 10 *". It runs once, then is deleted.

Recurring (the default), for "every N minutes", "hourly", "weekdays at 9am": "*/5 * * * *", "7 * * * *", "0 9 * * 1-5". Recurring schedules expire after 7 days (they run one last time, then are deleted): tell the user about that limit.

When the user's time is approximate, avoid minute 0 and 30 ("every morning around 9" → "57 8 * * *", "hourly" → "7 * * * *").

durable: true saves it with the session, so it survives quitting and comes back when the session is opened again (missed recurring runs are skipped; a one-shot that came due while closed runs if it's less than a day late). Default false: it lasts as long as this session is open.

For "do X every few minutes, starting now", the user can also type /loop <interval> <prompt>. At most ${MAX_JOBS} schedules per session. Returns the schedule's id (for CronDelete) and when it runs next: tell the user that time.`;

const LIST_DESCRIPTION = "List this session's schedules (from CronCreate, /loop, and the automatic resume after a usage limit): id, prompt, when it runs, and when next.";
const DELETE_DESCRIPTION = "Cancel one of this session's schedules by the id CronCreate or CronList gave.";

const CREATE_SCHEMA = {
    type: "object",
    properties: {
        cron: { type: "string", description: 'Standard 5-field cron in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm, once with recurring: false).' },
        prompt: { type: "string", description: "The prompt to run each time." },
        recurring: { type: "boolean", description: "true (default): every match until deleted or 7 days pass. false: once, at the next match." },
        durable: { type: "boolean", description: "true: saved with the session, survives quitting. Default false." },
    },
    required: ["cron", "prompt"],
};

const DELETE_SCHEMA = { type: "object", properties: { id: { type: "string", description: "The schedule's id." } }, required: ["id"] };

export function jobLine(j: ScheduledJob, now = Date.now()): string {
    const state = j.paused ? "paused" : j.due ? "due now (runs when the session is idle)" : j.nextAt ? `next ${shortTime(j.nextAt, now)}` : "no further runs";
    const extra = [j.durable ? "durable" : "", j.recurring && j.expiresAt ? `expires ${shortTime(j.expiresAt, now)}` : "", j.runs ? `ran ${j.runs}×` : ""].filter(Boolean).join(", ");
    return `${j.id}  ${describeJob(j)}${j.cron ? ` (${j.cron})` : ""}: ${state}${extra ? `; ${extra}` : ""}\n    ${clipPrompt(j.prompt, 200)}`;
}

/** What each tool does, given the session's scheduler; the text is what the model reads. */
export function createSchedule(s: Scheduler | undefined, input: Record<string, unknown>): { text: string; isError?: boolean } {
    if (!s) return { text: "Scheduling isn't available here (only in an interactive session).", isError: true };
    if (typeof input.cron !== "string" || !input.cron.trim()) return { text: "cron must be a 5-field cron expression.", isError: true };
    if (typeof input.prompt !== "string" || !input.prompt.trim()) return { text: "prompt must be a non-empty string.", isError: true };
    if (input.prompt.length > MAX_PROMPT) return { text: `prompt must be at most ${MAX_PROMPT} characters.`, isError: true };
    try {
        const j = s.add({ kind: "cron", cron: input.cron, prompt: input.prompt, recurring: input.recurring !== false, durable: input.durable === true });
        const when = describeJob(j);
        const next = j.nextAt ? shortTime(j.nextAt) : "";
        const lines = [`Scheduled ${j.id}: ${when}. Next run: ${next} (local time).`];
        if (j.recurring) lines.push(`It expires ${shortTime(j.createdAt + RECURRING_TTL_MS)} (7 days). Recurring schedules stop after 7 days: tell the user.`);
        lines.push(j.durable ? "Saved with the session: it survives quitting." : "It lasts while this session is open.");
        lines.push("The user can see, pause and delete it with /schedules.");
        return { text: lines.join(" ") };
    } catch (e) {
        return { text: e instanceof CronError ? `Invalid cron: ${e.message}` : (e as Error).message, isError: true };
    }
}

export function listSchedules(s: Scheduler | undefined): { text: string } {
    const jobs = s?.list() ?? [];
    if (!jobs.length) return { text: "No schedules in this session." };
    return { text: jobs.map((j) => jobLine(j)).join("\n") };
}

export function deleteSchedule(s: Scheduler | undefined, input: Record<string, unknown>): { text: string; isError?: boolean } {
    if (typeof input.id !== "string" || !input.id.trim()) return { text: "id must be a schedule's id (CronList shows them).", isError: true };
    const j = s?.remove(input.id);
    if (!j) return { text: `No schedule ${input.id}. CronList shows the ones there are.`, isError: true };
    return { text: `Deleted ${j.id} (${describeJob(j)}): ${clipPrompt(j.prompt, 80)}` };
}

const asResult = (r: { text: string; isError?: boolean }): ToolResult => ({ content: r.text, isError: r.isError });

/** The harness tools, for API models. */
export const CronCreateTool: Tool<{ cron: string; prompt: string; recurring?: boolean; durable?: boolean }> = {
    name: "CronCreate",
    description: CREATE_DESCRIPTION,
    parameters: CREATE_SCHEMA,
    category: "meta",
    readOnly: false,
    title: (i) => `CronCreate(${typeof i.cron === "string" ? i.cron : ""})`,
    async run(input, ctx) {
        const r = createSchedule(ctx.state.scheduler, input);
        return { ...asResult(r), display: { summary: r.isError ? undefined : r.text.split(". ")[0] } };
    },
};

export const CronListTool: Tool<Record<string, never>> = {
    name: "CronList",
    description: LIST_DESCRIPTION,
    parameters: { type: "object", properties: {} },
    category: "meta",
    readOnly: true,
    title: () => "CronList",
    async run(_input, ctx) {
        const r = listSchedules(ctx.state.scheduler);
        const n = ctx.state.scheduler?.size ?? 0;
        return { ...asResult(r), display: { summary: n ? `${n} schedule${n === 1 ? "" : "s"}` : "No schedules" } };
    },
};

export const CronDeleteTool: Tool<{ id: string }> = {
    name: "CronDelete",
    description: DELETE_DESCRIPTION,
    parameters: DELETE_SCHEMA,
    category: "meta",
    readOnly: false,
    title: (i) => `CronDelete(${typeof i.id === "string" ? i.id : ""})`,
    async run(input, ctx) {
        return asResult(deleteSchedule(ctx.state.scheduler, input));
    },
};

export const CRON_TOOLS: Tool<any>[] = [CronCreateTool, CronListTool, CronDeleteTool];

/** The same, for Claude Code and Codex through the harness MCP server. */
export function scheduleServerTools(scheduler: () => Scheduler | undefined): ServerTool[] {
    const wrap = (r: { text: string; isError?: boolean }): ServerToolResult => ({ text: r.text, isError: r.isError });
    return [
        {
            name: "schedule_create",
            title: "Schedule a prompt",
            description: CREATE_DESCRIPTION.replaceAll("CronDelete", "schedule_delete").replace("/loop <interval> <prompt>", "/loop <interval> <prompt> in Harness"),
            inputSchema: CREATE_SCHEMA,
            annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
            call: async (args) => wrap(createSchedule(scheduler(), args)),
        },
        {
            name: "schedule_list",
            title: "List schedules",
            description: LIST_DESCRIPTION.replace("CronCreate", "schedule_create"),
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true, openWorldHint: false },
            call: async () => wrap(listSchedules(scheduler())),
        },
        {
            name: "schedule_delete",
            title: "Cancel a schedule",
            description: DELETE_DESCRIPTION.replace("CronCreate or CronList", "schedule_create or schedule_list"),
            inputSchema: DELETE_SCHEMA,
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
            call: async (args) => wrap(deleteSchedule(scheduler(), args)),
        },
    ];
}

export const SCHEDULE_INSTRUCTIONS = `# Scheduling (harness)

To run something later or repeatedly in this session ("every morning at 9", "remind me at 3pm", "check the deploy every 20 minutes"), use schedule_create, not your own CronCreate or ScheduleWakeup: this CLI process ends after each turn, so only Harness can keep a schedule. schedule_list and schedule_delete show and cancel them.`;
