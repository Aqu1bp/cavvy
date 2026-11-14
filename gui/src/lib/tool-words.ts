// How a tool call is worded: what it did ("Read"), what it's doing ("Reading"),
// and on what. Shared by the work log's rows (blocks/Activity.tsx), the running
// turn's live line (live-line.ts) and find (find.ts).

import type { Block, ToolBlock } from "@shared/protocol";
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
    // Claude Code's: it loads tools it has only the names of.
    ToolSearch: "Find tools",
    // The agent CLIs' own, which Cavvy only shows: said as what they do, never as their names.
    Agent: "Agent",
    TaskOutput: "Check task",
    TaskStop: "Stop task",
    TaskCreate: "Add task",
    TaskUpdate: "Update task",
    TaskList: "List tasks",
    TaskGet: "Read task",
    CronCreate: "Schedule",
    CronList: "List schedules",
    CronDelete: "Delete schedule",
    ScheduleWakeup: "Schedule a wake-up",
    EnterPlanMode: "Enter plan mode",
    EnterWorktree: "Enter worktree",
    ExitWorktree: "Leave worktree",
    KillBash: "Stop",
    SlashCommand: "Run command",
    ListMcpResourcesTool: "List resources",
    ReadMcpResourceTool: "Read resource",
    SendMessage: "Message agent",
    Workflow: "Run workflow",
    LSP: "Look up code",
    ListModels: "List models",
    apply_patch: "Edit",
    update_plan: "Update plan",
    view_image: "View image",
    web_search: "Search the web",
};

/**
 * What a call does, in words: its verb above, or for a tool with none (a CLI's own, a new one) its name as words
 * ("TaskOutput" is "Task output"), never the name as the tool spells it.
 */
const verbOf = (name: string) =>
    VERBS[name] ??
    name
        .replace(/[_-]+/g, " ")
        .replace(/([a-z\d])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`)
        .replace(/^[a-z]/, (c) => c.toUpperCase());
/** Those words after another ("Then search", "Running task output"): a name in capitals stays as it is ("Running LSP"). */
const after = (name: string) => verbOf(name).replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase());

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
    KillShell: "Stopping",
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
    UnwatchPullRequest: "Ending the watch",
    ToolSearch: "Finding tools",
    Agent: "Agent working",
    TaskOutput: "Checking task",
    TaskStop: "Stopping task",
    TaskCreate: "Adding task",
    TaskUpdate: "Updating task",
    TaskList: "Listing tasks",
    TaskGet: "Reading task",
    CronCreate: "Scheduling",
    CronList: "Listing schedules",
    CronDelete: "Deleting schedule",
    ScheduleWakeup: "Scheduling a wake-up",
    EnterPlanMode: "Entering plan mode",
    EnterWorktree: "Entering worktree",
    ExitWorktree: "Leaving worktree",
    KillBash: "Stopping",
    SlashCommand: "Running command",
    ListMcpResourcesTool: "Listing resources",
    ReadMcpResourceTool: "Reading resource",
    SendMessage: "Messaging agent",
    Workflow: "Running workflow",
    LSP: "Looking up code",
    ListModels: "Listing models",
    apply_patch: "Editing",
    update_plan: "Updating plan",
    view_image: "Viewing image",
    web_search: "Searching the web",
};

/** "Gemini 3 Pro" style: the model part of provider:model. */
export function shortModelRef(ref?: string): string | undefined {
    return ref?.slice(ref.indexOf(":") + 1);
}

/** Which tool a call is of: one of Cavvy's own however it was called (BrowserEval for mcp__cavvy__browser_eval, as its server names it), else its name. */
export function toolKind(name: string): string {
    const m = /^mcp__cavvy__(\w+)$/.exec(name);
    return m ? m[1]!.replace(/(^|_)(\w)/g, (_, __, c: string) => c.toUpperCase()) : name;
}

type Words = { verb: string; running: string; arg?: string };

/** An action on a page or the simulator, done and under way. */
const ACTS: Record<string, [string, string]> = {
    click: ["Click", "Clicking"],
    double_click: ["Double-click", "Double-clicking"],
    hover: ["Hover over", "Hovering over"],
    type: ["Type into", "Typing into"],
    press: ["Press", "Pressing"],
    select: ["Select", "Selecting"],
    scroll: ["Scroll", "Scrolling"],
    wait: ["Wait for", "Waiting for"],
    dialog: ["Answer a dialog", "Answering a dialog"],
    tap: ["Tap", "Tapping"],
    double_tap: ["Double-tap", "Double-tapping"],
    long_press: ["Long-press", "Long-pressing"],
    swipe: ["Swipe", "Swiping"],
    button: ["Press", "Pressing"],
};

/** A page's address without the scheme: what's read. */
const shortUrl = (u: unknown) => (typeof u === "string" && u ? u.replace(/^https?:\/\//, "").replace(/\/$/, "") : undefined);

/** What it acted on, from what the browser said it did ('Clicked button "Save" [e12]'): a ref (e12) means nothing to a reader. */
function actedOn(output: string | undefined): string | undefined {
    const first = output?.split("\n", 1)[0] ?? "";
    const m = /^(?:Clicked|Double-clicked|Right-clicked|Hovered|Typed into|Replaced the text of) (.+?)(?: \[e\d+\])?(?: and pressed Enter)?$/.exec(first);
    return m?.[1];
}

/**
 * Cavvy's other tools, however they were called (ServerAdd, or mcp__cavvy__server_add from an agent CLI): what each
 * does, what it's doing, and which of its arguments says on what. Never "Using cavvy": that says nothing.
 */
const CAVVY: Record<string, [verb: string, running: string, arg?: string]> = {
    ServerKey: ["Prepare server", "Preparing server", "name"],
    ServerAdd: ["Add server", "Adding server", "name"],
    ServerRemove: ["Remove server", "Removing server", "name"],
    RequestSignIn: ["Ask to sign in", "Checking sign-in", "target"],
    RequestSecret: ["Ask for secret", "Asking for a secret", "name"],
    RunWithSecrets: ["Run with secrets", "Running with secrets", "description"],
    Models: ["List models", "Listing models"],
    TaskStatus: ["Check task", "Checking task"],
    TaskCancel: ["Stop task", "Stopping task"],
    ScheduleCreate: ["Schedule", "Scheduling", "prompt"],
    ScheduleList: ["List schedules", "Listing schedules"],
    ScheduleDelete: ["Delete schedule", "Deleting schedule"],
    ListSessions: ["List sessions", "Listing sessions"],
    ReadSession: ["Read session", "Reading session"],
    SendToSession: ["Message session", "Messaging session"],
    StartSession: ["Start session", "Starting session", "prompt"],
    Delegate: ["Delegate", "Delegating", "description"],
};

/** Cavvy's own tools in words: what they did to what, never their internal names, refs or code. */
function ownWords(t: ToolBlock): Words | undefined {
    const i = t.input ?? {};
    const s = (k: string) => (typeof i[k] === "string" && i[k] ? (i[k] as string) : undefined);
    const kind = toolKind(t.name);
    const cavvy = t.agent ? undefined : CAVVY[kind];
    if (cavvy) return { verb: cavvy[0], running: cavvy[1], arg: cavvy[2] ? s(cavvy[2])?.split("\n")[0] : undefined };
    // One with words under its own name (WatchPullRequest), called through Cavvy's server.
    if (kind !== t.name && VERBS[kind]) return { verb: VERBS[kind]!, running: RUNNING[kind] ?? VERBS[kind]!, arg: splitTitle(t.title).arg };
    switch (kind) {
        case "BrowserNavigate": {
            const a = s("action") ?? "goto";
            if (a === "goto" || a === "new_tab") return { verb: "Open", running: "Opening", arg: shortUrl(i.url) };
            const fixed: Record<string, [string, string]> = { back: ["Go back", "Going back"], forward: ["Go forward", "Going forward"], reload: ["Reload the page", "Reloading the page"], close_tab: ["Close a tab", "Closing a tab"], switch_tab: ["Switch tabs", "Switching tabs"], list_tabs: ["List tabs", "Listing tabs"], resize: ["Resize the page", "Resizing the page"] };
            const [verb, running] = fixed[a] ?? ["Use the browser", "Using the browser"];
            return { verb, running };
        }
        case "BrowserSnapshot":
            return { verb: "Read the page", running: "Reading the page" };
        case "BrowserScreenshot":
            return { verb: "Screenshot the page", running: "Taking a screenshot" };
        case "BrowserEval":
            return { verb: "Run a script in the page", running: "Running a script in the page" };
        case "BrowserLogs":
            return { verb: "Read the page's logs", running: "Reading the page's logs" };
        case "SimulatorSnapshot":
            return { verb: "Read the screen", running: "Reading the screen" };
        case "SimulatorScreenshot":
            return { verb: "Screenshot the simulator", running: "Taking a screenshot" };
        case "SimulatorControl": {
            const a = s("action") ?? "";
            const app = s("bundleId") ?? s("app")?.split("/").pop();
            const words: Record<string, [string, string, string?]> = {
                boot: ["Start the simulator", "Starting the simulator", s("device")],
                shutdown: ["Shut down the simulator", "Shutting down the simulator"],
                install: ["Install", "Installing", app],
                launch: ["Open", "Opening", app],
                terminate: ["Quit", "Quitting", app],
                open_url: ["Open", "Opening", shortUrl(i.url)],
                list: ["List simulators", "Listing simulators"],
            };
            const [verb, running, arg] = words[a] ?? ["Use the simulator", "Using the simulator"];
            return { verb, running, arg };
        }
        case "BrowserAct":
        case "SimulatorAct": {
            const a = s("action") ?? "";
            const [verb, running] = ACTS[a] ?? (kind === "SimulatorAct" ? ["Act on the screen", "Acting on the screen"] : ["Act on the page", "Acting on the page"]);
            // What it pressed or waited for; else what it clicked or typed into, once it says.
            const arg = a === "press" ? s("key") : a === "button" ? s("button") : a === "wait" ? (s("text") ?? s("selector")) : a === "select" ? s("value") : actedOn(t.output);
            return { verb, running, arg };
        }
    }
    return undefined;
}

/** A call whose result only says again what its row does ("Clicked button "Save" [e12]", the address it opened): none shown. */
export function resultEchoes(t: ToolBlock): boolean {
    const kind = toolKind(t.name);
    return t.status === "ok" && (kind === "BrowserNavigate" || kind === "BrowserAct" || kind === "SimulatorAct" || kind === "SimulatorControl");
}

/** Another MCP server's tool, by its own name in words: mcp__github__create_issue is "Create issue", from github. */
function mcpWords(t: ToolBlock): Words | undefined {
    const m = /^mcp__(.+?)__(.+)$/.exec(t.name);
    if (!m) return undefined;
    const { verb, arg } = splitTitle(t.title);
    const own = verb === t.name || verb.startsWith("mcp__") ? m[2]!.replace(/[_-]+/g, " ").trim() : verb;
    const said = own.charAt(0).toUpperCase() + own.slice(1);
    // Under way it's still what it does ("Create issue"): "Using github" said where, and nothing of what. With nothing
    // it's about to show, its server is.
    return { verb: said, running: said, arg: arg ?? (t.status === "ok" || t.status === "error" || m[1] === "cavvy" ? undefined : m[1]!.replace(/[_-]+/g, " ")) };
}

/**
 * What a search for tools asked for, in words: tools it named ("select:mcp__cavvy__server_key,mcp__github__create_issue")
 * as what they do ("Prepare server, Create issue"), a search as it was typed.
 */
function toolsAsked(query: string): string {
    const m = /^select:(.+)$/.exec(query.trim());
    if (!m) return query;
    const named = (name: string) => {
        const t = { t: "tool", id: "", name, title: name, status: "ok", input: {} } as unknown as ToolBlock;
        return (CAVVY[toolKind(name)]?.[0] ?? mcpWords(t)?.verb ?? ownWords(t)?.verb ?? verbOf(name)) || name;
    };
    return m[1]!.split(",").map((n) => named(n.trim())).filter(Boolean).join(", ");
}

export function toolLabel(t: ToolBlock): { verb: string; arg?: string } {
    // A sub-agent: its task, and the model when it's another one.
    if (t.agent) {
        const i = t.input ?? {};
        const model = shortModelRef(typeof i.model === "string" ? i.model : undefined);
        const what = String(i.description ?? splitTitle(t.title).arg ?? "");
        return { verb: t.name === "Task" ? "Agent" : t.name === "Skill" ? "Skill" : "Delegate", arg: [what, model].filter(Boolean).join(" · ") || undefined };
    }
    const own = ownWords(t) ?? mcpWords(t);
    if (own) return { verb: own.verb, arg: own.arg };
    const { arg } = splitTitle(t.title);
    const input = t.input ?? {};
    let a = arg;
    if (t.name === "Bash") a = String(input.command ?? arg ?? "").split("\n")[0];
    if (t.job && (t.name === "BashOutput" || t.name === "KillShell")) a = t.job.label;
    if (t.name === "Monitor") a = String(input.description ?? arg ?? "");
    if (t.name === "Task" || t.name === "Agent") a = String(input.description ?? arg ?? "");
    if (t.name === "AskUserQuestion") a = String(input.question ?? arg ?? "");
    if (t.name === "Skill") a = String(input.skill ?? input.name ?? arg ?? "");
    if (t.name === "TodoWrite" || t.name === "ExitPlanMode" || t.name === "GitPush") a = undefined;
    if (t.name === "GitCommit") a = String(input.message ?? arg ?? "").split("\n")[0];
    if (t.name === "CreatePullRequest") a = String(input.title ?? arg ?? "");
    if (t.name === "WatchPullRequest" || t.name === "UnwatchPullRequest") a = input.pr !== undefined && input.pr !== "" ? `#${String(input.pr).replace(/^#/, "").replace(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\//, "")}` : undefined;
    if (t.name === "ToolSearch") a = toolsAsked(String(input.query ?? arg ?? ""));
    return { verb: verbOf(t.name), arg: a || undefined };
}

/**
 * While its input arrives. An edit's or a new file's content is most of it, so that's the edit being written
 * ("Writing src/game.gd"); a command, the command. Others are over quickly: "Preparing search".
 */
const ARRIVING: Record<string, string> = {
    Write: "Writing",
    Edit: "Editing",
    MultiEdit: "Editing",
    NotebookEdit: "Editing notebook",
    Bash: "Writing command",
    ToolSearch: "Finding tools",
    // Not yet asked: the question, or the plan, is still being written.
    AskUserQuestion: "Writing a question",
    ExitPlanMode: "Writing the plan",
    Task: "Starting agent",
    Agent: "Starting agent",
};

/** Still under way: arriving, waiting its turn, running, or waiting for the user. */
export const isLive = (t: ToolBlock) => t.status === "running" || t.status === "streaming" || t.status === "queued" || t.status === "awaiting";

/** What a call still under way is doing, in a word or two: "Reading", "Writing", "Waiting for approval". */
export function runningVerb(t: ToolBlock): string {
    if (t.status === "awaiting") return t.name === "AskUserQuestion" || t.name === "ExitPlanMode" ? RUNNING[t.name]! : "Waiting for approval";
    const own = ownWords(t) ?? mcpWords(t);
    if (own) return t.status === "queued" ? `Then ${own.verb.charAt(0).toLowerCase()}${own.verb.slice(1)}` : own.running;
    // Arriving, it's about to be what it does: "Reading", not "Preparing read".
    if (t.status === "streaming") return ARRIVING[t.name] ?? RUNNING[t.name] ?? `Preparing ${after(t.name)}`;
    if (t.status === "queued") return `Then ${after(t.name)}`;
    if (t.name === "Bash" && sleepSeconds(t.input?.command)) return "Waiting";
    return RUNNING[t.name] ?? `Running ${after(t.name)}`;
}

/** What a command is for, in the model's words (Claude Code's Bash `description`), when it gave one. */
export function commandDescription(t: ToolBlock): string | undefined {
    const d = t.name === "Bash" ? t.input?.description : undefined;
    return typeof d === "string" && d.trim() ? d.trim() : undefined;
}

/**
 * Calls in a row that read the same ("Run a script in the page" three times): one row, counted. Only finished ones
 * that worked; a failure keeps its own row. `more` is the calls after the first, by its id; `joined`, their ids.
 */
export function sameInARow(steps: readonly Block[], o: { /** Calls drawn as cards of their own (an edit, a command), which never join a row. */ apart?: (t: ToolBlock) => boolean } = {}): { more: Map<string, ToolBlock[]>; joined: Set<string> } {
    const more = new Map<string, ToolBlock[]>();
    const joined = new Set<string>();
    let first: ToolBlock | undefined;
    let key = "";
    for (const b of steps) {
        const k = b.t === "tool" && b.status === "ok" && !b.diff && !b.agent && !o.apart?.(b) ? JSON.stringify(toolLabel(b)) : undefined;
        if (b.t === "tool" && k !== undefined && first && k === key) {
            more.set(first.id, [...(more.get(first.id) ?? []), b]);
            joined.add(b.id);
            continue;
        }
        first = k !== undefined ? (b as ToolBlock) : undefined;
        key = k ?? "";
    }
    return { more, joined };
}
