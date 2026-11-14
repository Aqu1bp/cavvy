import type { ToolBlock } from "@shared/protocol";
import { exitCode } from "./command-row";
import { plural } from "./format";
import { toolKind, toolLabel } from "./tool-words";

/**
 * What a run's finished steps came to, for its one line. Several steps are counted, never named: no path, no
 * command, no skill's name. The line is what's left when the steps are folded away; the rows under it say which.
 * One step alone says what it was. A call that failed isn't said to have done its thing (two reads that failed
 * aren't "Read 2 files"): the line's own mark counts those. A command that failed still ran (one that was never
 * run didn't), and an edit that failed is "couldn't change".
 */
export function summarize(tools: ToolBlock[]): string {
    const one = tools.length === 1;
    const reads = new Set<string>();
    let searches = 0;
    const edited = new Set<string>();
    const created = new Set<string>();
    const commands: string[] = [];
    const monitors: string[] = [];
    let web = 0;
    let fetched = 0;
    let agents = 0;
    let mcp = 0;
    /** Calls with no words of their own here (a Cavvy tool, one a CLI added). */
    let other = 0;
    const misc: string[] = [];
    let todos = false;
    const skills = new Set<string>();
    /** Changes that didn't happen: declined, or failed. */
    let declined = 0;
    let failed = 0;
    const unchanged = new Set<string>();
    for (const t of tools) {
        if (t.status === "denied") {
            declined++;
            continue;
        }
        if (t.agent) {
            agents++;
            continue;
        }
        const i = t.input ?? {};
        const path = String(i.file_path ?? i.notebook_path ?? i.path ?? t.title);
        if (t.status === "error" && ["Edit", "MultiEdit", "NotebookEdit", "Write"].includes(t.name)) {
            unchanged.add(path);
            continue;
        }
        const kind = toolKind(t.name);
        if (t.status === "error" && (kind !== "Bash" || !ran(t))) {
            if (one) misc.push(said(t));
            else failed++;
            continue;
        }
        switch (kind) {
            case "Read":
                reads.add(path);
                break;
            case "Grep":
            case "Glob":
            case "LS":
                searches++;
                break;
            case "Edit":
            case "MultiEdit":
            case "NotebookEdit":
                edited.add(path);
                break;
            case "Write":
                (t.diff?.status === "added" ? created : edited).add(path);
                break;
            case "Bash":
                commands.push(String(i.command ?? ""));
                break;
            case "Monitor":
                monitors.push(String(i.description ?? "").trim());
                break;
            case "WebSearch":
                web++;
                break;
            case "WebFetch":
                fetched++;
                break;
            case "Task":
                agents++;
                break;
            case "Skill":
                skills.add(String(i.skill ?? i.name ?? "").replace(/^[/$]/, "").trim());
                break;
            case "TodoWrite":
                if (!todos) misc.push("updated todos");
                todos = true;
                break;
            case "AskUserQuestion":
                misc.push("asked a question");
                break;
            case "ExitPlanMode":
                misc.push("presented a plan");
                break;
            case "GitCommit":
                misc.push("committed");
                break;
            case "GitPush":
                misc.push("pushed");
                break;
            case "CreatePullRequest":
                misc.push("opened a pull request");
                break;
            case "WatchPullRequest":
                misc.push("watched a pull request");
                break;
            case "UnwatchPullRequest":
                misc.push("stopped watching");
                break;
            // Cavvy's own asks and server steps, by what they are (to what and which server is in their rows).
            case "RequestSignIn":
                misc.push(one ? said(t) : "asked to sign in");
                break;
            case "RequestSecret":
                misc.push(one ? said(t) : "asked for a secret");
                break;
            case "ServerKey":
            case "ServerAdd":
            case "ServerRemove":
                misc.push(one ? said(t) : { ServerKey: "prepared a server", ServerAdd: "added a server", ServerRemove: "removed a server" }[kind]);
                break;
            default:
                if (one) misc.push(said(t));
                else if (t.name.startsWith("mcp__") && kind === t.name) mcp++;
                else other++;
        }
    }
    const parts: string[] = [];
    if (reads.size) parts.push(`read ${plural(reads.size, "file")}`);
    if (searches) parts.push(`searched ${searches === 1 ? "once" : searches === 2 ? "twice" : `${searches} times`}`);
    for (const p of created.size ? [`created ${plural(created.size, "file")}`] : []) parts.push(p);
    if (edited.size) parts.push(one ? `edited ${short([...edited][0]!)}` : `edited ${plural(edited.size, "file")}`);
    if (one && commands.length && commands[0]!.length <= 48 && !commands[0]!.includes("\n")) parts.push(`ran \`${commands[0]}\``);
    else if (commands.length) parts.push(`ran ${plural(commands.length, "command")}`);
    if (one && monitors[0] && monitors[0].length <= 48) parts.push(`started a monitor: ${monitors[0]}`);
    else if (monitors.length) parts.push(`started ${plural(monitors.length, "monitor")}`);
    if (web) parts.push("searched the web");
    if (fetched) parts.push(`fetched ${plural(fetched, "page")}`);
    if (agents) parts.push(agents === 1 ? "ran an agent" : `ran ${agents} agents`);
    if (mcp + other) parts.push(`used ${plural(mcp + other, other ? "tool" : "MCP tool")}`);
    if (skills.size) parts.push(one && [...skills][0] ? `loaded the ${[...skills][0]} skill` : `loaded ${plural(skills.size, "skill")}`);
    // Said once each, however many times it happened.
    parts.push(...new Set(misc));
    if (unchanged.size) parts.push(one ? `couldn't change ${short([...unchanged][0]!)}` : `couldn't change ${plural(unchanged.size, "file")}`);
    if (failed && !parts.length) parts.push(`${plural(failed, "call")} failed`);
    if (declined && !parts.length) parts.push(`${plural(declined, "call")} declined`);
    const shown = parts.length > 3 ? [...parts.slice(0, 3), `${parts.length - 3} more`] : parts;
    const text = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : (shown[0] ?? "");
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Whether a command that counts as failed ran at all: it has an exit code, or was cut short. One declined beside it, or never reached, didn't. */
const ran = (t: ToolBlock) => exitCode(t) !== undefined || /^(?:Timed out|Interrupted)$/.test(t.summary ?? "") || /Terminated by signal/.test((t.output ?? "").slice(-400));

/** One call in its own words: what it does, and what to. */
function said(t: ToolBlock): string {
    const { verb, arg } = toolLabel(t);
    return arg ? `${verb} ${arg}` : verb;
}

export function short(path: string): string {
    const parts = path.split("/");
    return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : path;
}
