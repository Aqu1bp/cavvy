// How a sub-agent is drawn wherever it's listed (the transcript's sub-agent card, blocks/Activity.tsx; the side
// panel's Agents tab, BackgroundTasks.tsx; the permission dock, InteractionDock.tsx): which provider runs it,
// whose mark it shows (ui/AgentMark.tsx), and what it's doing in a few words rather than the raw call.

import type { AgentRun, ToolBlock } from "@shared/protocol";
import { splitTitle } from "./format";
import { commandLabel } from "./command-row";
import { RUNNING, commandDescription, isLive, runningVerb, toolLabel } from "./tool-words";

/**
 * The provider that runs a sub-agent: its model's, when it isn't the session's own (`own`). A model with no
 * provider is its parent's (`agents`: the session's, to find it): a Claude Code agent's own "haiku" child runs
 * on Claude Code, not the session's; at the top, the session's.
 */
export function agentProvider(a: Pick<AgentRun, "model" | "parentId">, own?: string, agents: readonly AgentRun[] = []): string | undefined {
    const seen = new Set<string>();
    for (let at: Pick<AgentRun, "model" | "parentId"> | undefined = a; at; ) {
        const model = at.model;
        if (model?.includes(":")) return model.slice(0, model.indexOf(":"));
        const parent: string | undefined = at.parentId;
        if (!parent || seen.has(parent)) break;
        seen.add(parent);
        at = agents.find((x) => x.id === parent);
    }
    return own;
}

/** The distinct providers of a group of agents, in the order they first appear: up to `max` to show, and how many more. `undefined`: not known. */
export function providerStack(providers: readonly (string | undefined)[], max = 3): { shown: (string | undefined)[]; more: number } {
    const distinct = [...new Set(providers)];
    return { shown: distinct.slice(0, max), more: Math.max(0, distinct.length - max) };
}

const FILE_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write", "NotebookEdit"]);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const base = (path: string) => path.replace(/\/+$/, "").split("/").at(-1) || path;

/** A call's verb: what it's doing while it runs ("Reading"), else what it did ("Read"). */
function verbOf(t: ToolBlock, verb: string): string {
    if (t.status === "running") return RUNNING[t.name] ?? verb;
    return isLive(t) ? runningVerb(t) : verb;
}

/**
 * A call in a few words: what it's for, when the model said (Claude Code's Bash `description`); else its verb and
 * what it's on (a command past its cd, a file by its name).
 */
export function stepWords(t: ToolBlock): string {
    const description = commandDescription(t);
    if (description) return oneLine(description);
    const { verb, arg } = toolLabel(t);
    const what = t.name === "Bash" ? commandLabel(t) : arg && FILE_TOOLS.has(t.name) ? base(arg) : arg;
    return oneLine([verbOf(t, verb), what].filter(Boolean).join(" "));
}

/** The whole call, for its tooltip: a command whole (its title is cut at 120 characters), else the call's title. */
export function fullCall(t: ToolBlock): string {
    const command = t.name === "Bash" ? t.input?.command : undefined;
    return typeof command === "string" && command.trim() ? `Bash(${command.trim()})` : t.title;
}

/**
 * What a running sub-agent is doing, as its row's second line says it: the step's words (stepWords) when its
 * activity is one of its calls, and the whole call (`full`) for the tooltip. Other activity ("Thinking",
 * "Writing", "Waiting for approval") is already words; a call's title with no call to go with it is worded
 * from the title.
 */
export function agentStep(a: Pick<AgentRun, "activity" | "blocks">): { text: string; full?: string } | undefined {
    const activity = a.activity?.trim();
    if (!activity) return undefined;
    for (let i = a.blocks.length - 1; i >= 0; i--) {
        const b = a.blocks[i]!;
        if (b.t === "tool" && b.title.trim() === activity) return { text: stepWords(b), full: fullCall(b) };
    }
    const { verb, arg } = splitTitle(activity);
    // A tool's name has no spaces: "Working (step 2)" is words already.
    if (arg === undefined || !/^[\w.-]+$/.test(verb)) return { text: activity };
    const call: ToolBlock = { t: "tool", id: "", name: verb, title: activity, status: "running", ...(verb === "Bash" ? { input: { command: arg } } : {}) };
    return { text: stepWords(call), full: activity };
}
