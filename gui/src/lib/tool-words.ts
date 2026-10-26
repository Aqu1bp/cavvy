// How a tool call is worded: what it did ("Read"), what it's doing ("Reading"),
// and on what. Shared by the work log's rows (blocks/Activity.tsx), the running
// turn's live line (live-line.ts) and find (find.ts).

import type { ToolBlock } from "@shared/protocol";
import { sleepSeconds, splitTitle } from "./format";

export const VERBS: Record<string, string> = {
    Read: "Read",
    Grep: "Search",
    Glob: "Find",
    LS: "List",
    Edit: "Edit",
    MultiEdit: "Edit",
    Write: "Write",
    NotebookEdit: "Edit notebook",
    Bash: "Run",
    BashOutput: "Check output",
    KillShell: "Stop",
    Monitor: "Monitor",
    WebFetch: "Fetch",
    WebSearch: "Search the web",
    Task: "Agent",
    Skill: "Load skill",
    TodoWrite: "Update todos",
    AskUserQuestion: "Ask",
    ExitPlanMode: "Present plan",
    GitCommit: "Commit",
    GitPush: "Push",
    CreatePullRequest: "Open pull request",
    WatchPullRequest: "Watch pull request",
    UnwatchPullRequest: "Stop watching",
};

export const RUNNING: Record<string, string> = {
    Read: "Reading",
    Grep: "Searching",
    Glob: "Finding files",
    LS: "Listing",
    Edit: "Editing",
    MultiEdit: "Editing",
    Write: "Writing",
    NotebookEdit: "Editing notebook",
    Bash: "Running",
    BashOutput: "Checking output",
    Monitor: "Starting monitor",
    WebFetch: "Fetching",
    WebSearch: "Searching the web",
    Task: "Agent working",
    // Not "Loading": a skill can run as its own agent for minutes (/code-review does).
    Skill: "Using skill",
    TodoWrite: "Updating todos",
    AskUserQuestion: "Waiting for your answer",
    ExitPlanMode: "Waiting for plan review",
    GitCommit: "Committing",
    GitPush: "Pushing",
    CreatePullRequest: "Opening pull request",
    WatchPullRequest: "Reading pull request",
};

/** "Gemini 3 Pro" style: the model part of provider:model. */
export function shortModelRef(ref?: string): string | undefined {
    return ref?.slice(ref.indexOf(":") + 1);
}

export function toolLabel(t: ToolBlock): { verb: string; arg?: string } {
    // A sub-agent: its task, and the model when it's another one.
    if (t.agent) {
        const i = t.input ?? {};
        const model = shortModelRef(typeof i.model === "string" ? i.model : undefined);
        const what = String(i.description ?? splitTitle(t.title).arg ?? "");
        return { verb: t.name === "Task" ? "Agent" : t.name === "Skill" ? "Skill" : "Delegate", arg: [what, model].filter(Boolean).join(" · ") || undefined };
    }
    if (t.name.startsWith("mcp__")) {
        const { verb, arg } = splitTitle(t.title);
        return { verb, arg };
    }
    const { arg } = splitTitle(t.title);
    const input = t.input ?? {};
    let a = arg;
    if (t.name === "Bash") a = String(input.command ?? arg ?? "").split("\n")[0];
    if (t.job && (t.name === "BashOutput" || t.name === "KillShell")) a = t.job.label;
    if (t.name === "Monitor") a = String(input.description ?? arg ?? "");
    if (t.name === "Task") a = String(input.description ?? arg ?? "");
    if (t.name === "AskUserQuestion") a = String(input.question ?? arg ?? "");
    if (t.name === "Skill") a = String(input.skill ?? input.name ?? arg ?? "");
    if (t.name === "TodoWrite" || t.name === "ExitPlanMode" || t.name === "GitPush") a = undefined;
    if (t.name === "GitCommit") a = String(input.message ?? arg ?? "").split("\n")[0];
    if (t.name === "CreatePullRequest") a = String(input.title ?? arg ?? "");
    if (t.name === "WatchPullRequest" || t.name === "UnwatchPullRequest") a = input.pr !== undefined && input.pr !== "" ? `#${String(input.pr).replace(/^#/, "").replace(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\//, "")}` : undefined;
    return { verb: VERBS[t.name] ?? t.name, arg: a || undefined };
}

/** Still under way: arriving, waiting its turn, running, or waiting for the user. */
export const isLive = (t: ToolBlock) => t.status === "running" || t.status === "streaming" || t.status === "queued" || t.status === "awaiting";

/** What a call still under way is doing, in a word or two: "Reading", "Preparing edit", "Waiting for approval". */
export function runningVerb(t: ToolBlock): string {
    if (t.status === "awaiting") return t.name === "AskUserQuestion" || t.name === "ExitPlanMode" ? RUNNING[t.name]! : "Waiting for approval";
    if (t.status === "streaming") return `Preparing ${VERBS[t.name]?.toLowerCase() ?? t.name}`;
    if (t.status === "queued") return `Then ${VERBS[t.name]?.toLowerCase() ?? t.name}`;
    if (t.name === "Bash" && sleepSeconds(t.input?.command)) return "Waiting";
    return RUNNING[t.name] ?? `Running ${t.name}`;
}

/** What a command is for, in the model's words (Claude Code's Bash `description`), when it gave one. */
export function commandDescription(t: ToolBlock): string | undefined {
    const d = t.name === "Bash" ? t.input?.description : undefined;
    return typeof d === "string" && d.trim() ? d.trim() : undefined;
}
