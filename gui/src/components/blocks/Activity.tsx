import { RenderBoundary } from "../ui/ErrorBoundary";
// Tool calls, the way the transcript shows them: a run of calls folds into
// one line ("Read 3 files, searched 2 patterns · +13 −1"), which opens into
// a row per call, which opens into the call's details.

import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch, type JSX } from "solid-js";
import {
    AlertTriangle,
    Bot,
    Check,
    ChevronRight,
    CircleCheck,
    CircleX,
    ClipboardList,
    Clock,
    FilePen,
    FilePlus2,
    FileText,
    FolderTree,
    Globe,
    Hand,
    ListChecks,
    MessageCircleQuestion,
    Plug,
    Search,
    Sparkles,
    ShieldCheck,
    SquareArrowOutUpRight,
    SquareTerminal,
    Wrench,
    X, GitCommitHorizontal, ArrowUpFromLine, GitPullRequestArrow } from "lucide-solid";
import type { AgentRun, Block, ThinkingBlock, TodoEntry, ToolBlock } from "@shared/protocol";
import { duration, firstChangedLine, plural, sleepSeconds, splitTitle, stripAnsi, tokens } from "../../lib/format";
import { now } from "../../lib/clock";
import { app, reportError, rpc } from "../../state/app";
import { prefs } from "../../state/prefs";
import { openAgents, openInEditor } from "../../state/actions";
import { findReveal } from "../../state/ui";
import { Spinner } from "../ui/bits";
import { CodeBlock } from "./CodeBlock";
import { DiffView } from "./DiffView";
import { Markdown } from "./Markdown";

export type Item =
    | { kind: "block"; block: Block }
    | { kind: "activity"; id: string; tools: ToolBlock[]; steps: (ToolBlock | ThinkingBlock)[] };

/** Fold runs of tool calls (and the thinking between them) into activity groups. */
export function groupBlocks(blocks: Block[]): Item[] {
    const out: Item[] = [];
    let group: Extract<Item, { kind: "activity" }> | undefined;
    // One reverse pass avoids slicing/scanning the remaining turn for every thought.
    const nextKind: (Block["t"] | undefined)[] = new Array(blocks.length);
    let next: Block["t"] | undefined;
    for (let i = blocks.length - 1; i >= 0; i--) {
        nextKind[i] = next;
        if (blocks[i]!.t !== "thinking") next = blocks[i]!.t;
    }
    blocks.forEach((b, i) => {
        if (b.t === "tool") {
            if (!group) out.push((group = { kind: "activity", id: `g-${b.id}`, tools: [], steps: [] }));
            group.tools.push(b);
            group.steps.push(b);
            return;
        }
        if (b.t === "thinking") {
            // Thinking between two tool calls belongs to the work, not the reply.
            if (group && nextKind[i] === "tool") {
                group.steps.push(b);
                return;
            }
        }
        group = undefined;
        out.push({ kind: "block", block: b });
    });
    return out;
}

// ---------------------------------------------------------------------------
// Wording

const VERBS: Record<string, string> = {
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

const RUNNING: Record<string, string> = {
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
    WebFetch: "Fetching",
    WebSearch: "Searching the web",
    Task: "Agent working",
    Skill: "Loading skill",
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
        return { verb: t.name === "Task" ? "Agent" : "Delegate", arg: [what, model].filter(Boolean).join(" · ") || undefined };
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
    if (t.name === "Task") a = String(input.description ?? arg ?? "");
    if (t.name === "AskUserQuestion") a = String(input.question ?? arg ?? "");
    if (t.name === "Skill") a = String(input.skill ?? input.name ?? arg ?? "");
    if (t.name === "TodoWrite" || t.name === "ExitPlanMode" || t.name === "GitPush") a = undefined;
    if (t.name === "GitCommit") a = String(input.message ?? arg ?? "").split("\n")[0];
    if (t.name === "CreatePullRequest") a = String(input.title ?? arg ?? "");
    if (t.name === "WatchPullRequest" || t.name === "UnwatchPullRequest") a = input.pr !== undefined && input.pr !== "" ? `#${String(input.pr).replace(/^#/, "").replace(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\//, "")}` : undefined;
    return { verb: VERBS[t.name] ?? t.name, arg: a || undefined };
}

export function ToolIcon(p: { name: string; size?: number; agent?: boolean }) {
    const s = () => p.size ?? 15;
    return (
        <Switch fallback={<Wrench size={s()} />}>
            <Match when={p.agent}><Bot size={s()} /></Match>
            <Match when={p.name === "Read"}><FileText size={s()} /></Match>
            <Match when={p.name === "Grep" || p.name === "Glob"}><Search size={s()} /></Match>
            <Match when={p.name === "LS"}><FolderTree size={s()} /></Match>
            <Match when={p.name === "Edit" || p.name === "MultiEdit" || p.name === "NotebookEdit"}><FilePen size={s()} /></Match>
            <Match when={p.name === "Write"}><FilePlus2 size={s()} /></Match>
            <Match when={p.name === "Bash" || p.name === "BashOutput" || p.name === "KillShell"}><SquareTerminal size={s()} /></Match>
            <Match when={p.name === "WebFetch" || p.name === "WebSearch"}><Globe size={s()} /></Match>
            <Match when={p.name === "Task"}><Bot size={s()} /></Match>
            <Match when={p.name === "Skill"}><Sparkles size={s()} /></Match>
            <Match when={p.name === "TodoWrite"}><ListChecks size={s()} /></Match>
            <Match when={p.name === "AskUserQuestion"}><MessageCircleQuestion size={s()} /></Match>
            <Match when={p.name === "ExitPlanMode"}><ClipboardList size={s()} /></Match>
            <Match when={p.name.startsWith("mcp__")}><Plug size={s()} /></Match>
            <Match when={p.name === "GitCommit"}><GitCommitHorizontal size={s()} /></Match>
            <Match when={p.name === "GitPush"}><ArrowUpFromLine size={s()} /></Match>
            <Match when={p.name === "CreatePullRequest" || p.name === "WatchPullRequest" || p.name === "UnwatchPullRequest"}><GitPullRequestArrow size={s()} /></Match>
        </Switch>
    );
}

function summarize(tools: ToolBlock[]): string {
    const reads = new Set<string>();
    let searches = 0;
    const edited = new Set<string>();
    const created = new Set<string>();
    const commands: string[] = [];
    let web = 0;
    let fetched = 0;
    let agents = 0;
    let mcp = 0;
    const misc: string[] = [];
    let todos = false;
    const skills = new Set<string>();
    /** Changes that didn't happen: declined, or failed. */
    let declined = 0;
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
        switch (t.name) {
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
            default:
                if (t.name.startsWith("mcp__")) mcp++;
                else misc.push(t.name);
        }
    }
    const parts: string[] = [];
    if (reads.size) parts.push(`read ${plural(reads.size, "file")}`);
    if (searches) parts.push(`searched ${plural(searches, "time")}`);
    for (const p of created.size ? [`created ${plural(created.size, "file")}`] : []) parts.push(p);
    if (edited.size) parts.push(edited.size === 1 && !created.size ? `edited ${short([...edited][0]!)}` : `edited ${plural(edited.size, "file")}`);
    if (commands.length === 1 && commands[0]!.length <= 48 && !commands[0]!.includes("\n")) parts.push(`ran \`${commands[0]}\``);
    else if (commands.length) parts.push(`ran ${plural(commands.length, "command")}`);
    if (web) parts.push("searched the web");
    if (fetched) parts.push(`fetched ${plural(fetched, "page")}`);
    if (agents) parts.push(agents === 1 ? "ran an agent" : `ran ${agents} agents`);
    if (mcp) parts.push(`used ${plural(mcp, "MCP tool")}`);
    if (skills.size) parts.push(skills.size === 1 && [...skills][0] ? `loaded the ${[...skills][0]} skill` : `loaded ${plural(skills.size, "skill")}`);
    parts.push(...misc);
    if (unchanged.size) parts.push(unchanged.size === 1 ? `couldn't change ${short([...unchanged][0]!)}` : `couldn't change ${plural(unchanged.size, "file")}`);
    if (declined && !parts.length) parts.push(`${plural(declined, "call")} declined`);
    const text = parts.slice(0, 3).join(", ") + (parts.length > 3 ? `, and ${parts.length - 3} more` : "");
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function short(path: string): string {
    const parts = path.split("/");
    return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : path;
}

/** Inline `code` in a summary line. */
function Inline(p: { text: string }) {
    const parts = () => p.text.split(/(`[^`]+`)/g);
    return <For each={parts()}>{(s) => (s.startsWith("`") && s.endsWith("`") ? <code>{s.slice(1, -1)}</code> : <>{s}</>)}</For>;
}

// ---------------------------------------------------------------------------
// The work log: one sentence per run of tool calls, opening into a plain line
// per call; sub-agents get their own row; the call running now shimmers.

/** The icon for a run of calls: what it mostly did. */
function groupIcon(tools: ToolBlock[]): string {
    const names = new Set(tools.map((t) => t.name));
    if (["Edit", "MultiEdit", "Write", "NotebookEdit"].some((n) => names.has(n))) return "Edit";
    if (names.has("Bash")) return "Bash";
    if (names.has("WebSearch") || names.has("WebFetch")) return "WebFetch";
    if (names.has("Grep") || names.has("Glob")) return "Grep";
    if (names.has("Read")) return "Read";
    return tools[0]?.name ?? "";
}

const isLive = (t: ToolBlock) => t.status === "running" || t.status === "streaming" || t.status === "queued" || t.status === "awaiting";

const elapsed = (ms: number) => duration(Math.max(0, ms)).replace(/^(\d+)ms$/, "0s");

/** How long a running call has run; a wait, against how long it waits. */
function liveTime(t: ToolBlock): string | undefined {
    if (!t.startedAt) return undefined;
    const ran = elapsed(now() - t.startedAt);
    const wait = t.name === "Bash" && t.status === "running" ? sleepSeconds(t.input?.command) : undefined;
    return wait ? `${ran} of ${elapsed(wait * 1000)}` : ran;
}

export function ActivityGroup(p: { tools: ToolBlock[]; steps: (ToolBlock | ThinkingBlock)[]; turnRunning: boolean; keepTail?: boolean; agents?: AgentRun[] }) {
    return <RenderBoundary raw={() => p.steps}><ActivityGroupContent {...p} /></RenderBoundary>;
}

function ActivityGroupContent(p: { tools: ToolBlock[]; steps: (ToolBlock | ThinkingBlock)[]; turnRunning: boolean; keepTail?: boolean; agents?: AgentRun[] }) {
    const [open, setOpen] = createSignal(prefs.expandActivity);
    createEffect(on(findReveal, (r) => r && p.tools.some((t) => t.id === r.part) && setOpen(true)));
    const agentIds = createMemo(() => new Set(p.tools.filter((t) => t.agent).map((t) => t.id)));
    const runs = createMemo(() => (p.agents ?? []).filter((a) => agentIds().has(a.id)));
    const runIds = createMemo(() => new Set(runs().map((a) => a.id)));
    const plain = createMemo(() => p.tools.filter((t) => !runIds().has(t.id)));
    const plainIds = createMemo(() => new Set(plain().map((t) => t.id)));
    // Membership depends on structure, never on progress or elapsed time.
    const steps = createMemo(() => p.steps.filter((b) => b.t === "thinking" || plainIds().has(b.id)));
    // Keep the last call in place after it finishes, until more work arrives.
    const tail = createMemo(() => {
        const last = p.tools.at(-1);
        return p.turnRunning && p.keepTail !== false && last && plainIds().has(last.id) ? last : undefined;
    });
    const done = createMemo(() => plain().filter((t) => !isLive(t) && t !== tail()));
    const stats = createMemo(() => {
        let added = 0;
        let removed = 0;
        for (const t of done()) {
            if (t.diff && t.status === "ok") {
                added += t.diff.added;
                removed += t.diff.removed;
            }
        }
        return { added, removed };
    });
    const failed = createMemo(() => done().filter((t) => t.status === "error").length);
    const denied = createMemo(() => done().filter((t) => t.status === "denied").length);
    const single = createMemo(() => done().length === 1 && !steps().some((b) => b.t === "thinking"));
    const agentRow = { t: "agents" as const };
    const current = (b: ToolBlock | ThinkingBlock) => b.t === "tool" && (isLive(b) || b === tail());
    // Preserve the original finished-work / agents / live-call order. For moves
    // existing nodes within this list when necessary, retaining their owners.
    const rows = createMemo(() => {
        const finished: (ToolBlock | ThinkingBlock | typeof agentRow)[] = [];
        const live: (ToolBlock | ThinkingBlock)[] = [];
        for (const b of steps()) (current(b) ? live : finished).push(b);
        return [...finished, agentRow, ...live];
    });

    return (
        <>
            <Show when={done().length}>
                <div class={`wgroup ${open() ? "open" : ""}`}>
                    <button class="wrow" data-find-skip onClick={() => setOpen(!open())} aria-expanded={open()}>
                        <span class="slot">
                            <ToolIcon name={groupIcon(done())} size={16} />
                        </span>
                        <span class="wtext truncate">
                            <Inline text={summarize(done())} />
                        </span>
                        <Show when={stats().added || stats().removed}>
                            <span class="stat">
                                <span class="add">+{stats().added}</span>
                                <span class="del">−{stats().removed}</span>
                            </span>
                        </Show>
                        <Show when={groupDiagnostics(done())}>{(r) => <DiagnosticsChip report={r()} />}</Show>
                        <Show when={failed()}>
                            <span class="wflag err" title={`${plural(failed(), "call")} failed`}>
                                <AlertTriangle size={12} /> {failed()}
                            </span>
                        </Show>
                        <Show when={denied()}>
                            <span class="wflag warn" title={`${plural(denied(), "call")} declined`}>
                                <X size={12} /> {denied()}
                            </span>
                        </Show>
                        <span class="end">
                            <ChevronRight size={14} class="chev" />
                        </span>
                    </button>
                </div>
            </Show>
            {/* A call has one owner through streaming, running and completion.
                Disclosure changes visibility, not ownership or local detail state. */}
            <div class="activity-steps">
                <For each={rows()}>{(b) => {
                    if (b.t === "agents") return <Show when={runs().length}><SubAgentsRow runs={runs()} /></Show>;
                    const isCurrent = () => current(b);
                    const visible = () => open() || isCurrent();
                    const [mounted, setMounted] = createSignal(visible());
                    createEffect(() => { if (visible()) setMounted(true); });
                    return <div class={isCurrent() ? "activity-step current" : "activity-step"} hidden={!visible()}>
                        <Show when={mounted()}>
                            {b.t === "tool" ? <ToolRow tool={b} activity={isCurrent()} detailsOnly={open() && single() && !isCurrent() && findReveal()?.part !== b.id} /> : <div class="wthought">{b.text.trim().split("\n")[0]}</div>}
                        </Show>
                    </div>;
                }}</For>
            </div>
        </>
    );
}

function runningVerb(t: ToolBlock): string {
    if (t.status === "awaiting") return t.name === "AskUserQuestion" || t.name === "ExitPlanMode" ? RUNNING[t.name]! : "Waiting for approval";
    if (t.status === "streaming") return `Preparing ${VERBS[t.name]?.toLowerCase() ?? t.name}`;
    if (t.status === "queued") return `Then ${VERBS[t.name]?.toLowerCase() ?? t.name}`;
    if (t.name === "Bash" && sleepSeconds(t.input?.command)) return "Waiting";
    return RUNNING[t.name] ?? `Running ${t.name}`;
}

const AGENT_STATUS: Record<AgentRun["status"], string> = {
    running: "Working",
    waiting: "Needs your approval",
    done: "Done",
    failed: "Failed",
    stopped: "Stopped",
};

const agentLive = (a: AgentRun) => a.status === "running" || a.status === "waiting";

export function agentElapsed(a: AgentRun): string {
    return duration(Math.max(0, (a.endedAt ?? (agentLive(a) ? now() : a.startedAt)) - a.startedAt)).replace(/^(\d+)ms$/, "0s");
}

/** One line of what a sub-agent is up to, or what it found. */
export function agentLine(a: AgentRun): string {
    if (a.status === "waiting") return AGENT_STATUS.waiting;
    if (agentLive(a)) return a.activity ?? "Working";
    const report = a.report
        ?.replace(/```[\s\S]*?```/g, " ")
        .replace(/[*_`>#]/g, "")
        .split("\n")
        .map((l) => l.trim())
        .find(Boolean);
    return report ?? AGENT_STATUS[a.status];
}

/** "2 sub-agents · 1 working · 1 done", opening into a row per agent that opens its own view. */
export function SubAgentsRow(p: { runs: AgentRun[] }) {
    const [open, setOpen] = createSignal(p.runs.some(agentLive));
    createEffect(on(findReveal, (r) => r && p.runs.some((a) => a.id === r.part) && setOpen(true)));
    const counts = () => {
        const n = (s: AgentRun["status"][]) => p.runs.filter((a) => s.includes(a.status)).length;
        return [
            n(["running"]) && `${n(["running"])} working`,
            n(["waiting"]) && `${n(["waiting"])} waiting for you`,
            n(["done"]) && `${n(["done"])} done`,
            n(["failed"]) && `${n(["failed"])} failed`,
            n(["stopped"]) && `${n(["stopped"])} stopped`,
        ].filter(Boolean) as string[];
    };
    const tone = () => (p.runs.some((a) => a.status === "waiting") ? "warn" : p.runs.some((a) => a.status === "running") ? "info" : p.runs.some((a) => a.status === "failed") ? "err" : "muted");
    const span = () => {
        const start = Math.min(...p.runs.map((a) => a.startedAt));
        const end = p.runs.some(agentLive) ? now() : Math.max(...p.runs.map((a) => a.endedAt ?? a.startedAt));
        return duration(Math.max(0, end - start)).replace(/^(\d+)ms$/, "0s");
    };
    return (
        <div class="subagents">
            <button class="ag-head" aria-expanded={open()} onClick={() => setOpen(!open())}>
                <span class="stack">
                    <For each={p.runs.slice(0, 3)}>
                        {() => (
                            <span class="av">
                                <Bot size={14} />
                            </span>
                        )}
                    </For>
                </span>
                <span class="ag-text">
                    <span class="ag-title">{plural(p.runs.length, "sub-agent")}</span>
                    <span class={`ag-sub tone-${tone()}`}>{counts().join(" · ")}</span>
                </span>
                <span class="grow" />
                <span class="ag-time num">{span()}</span>
                <ChevronRight size={14} class="chev" />
            </button>
            <Show when={open()}>
                <div class="agl">
                    <For each={p.runs}>
                        {(a) => (
                            <button class={`agr ${findReveal()?.part === a.id ? "found" : ""}`} data-find={a.id} onClick={() => openAgents(a.id)} title={a.model ? `${a.description}\n${shortModelRef(a.model)}` : a.description}>
                                <span class="av">
                                    <Bot size={14} />
                                    <span class={`nd st-${a.status}`} />
                                </span>
                                <span class="agr-text">
                                    <span class="agr-name truncate">{a.description.trim() || "Sub-agent"}</span>{" "}
                                    <span class={`agr-sub truncate ${a.status === "failed" ? "tone-err" : ""}`}>
                                        {a.model ? `${shortModelRef(a.model)} · ` : ""}
                                        {a.effort ? `${a.effort} effort · ` : ""}
                                        {agentLine(a)}
                                    </span>
                                </span>
                                <span class="ag-time num">{agentElapsed(a)}</span>
                                <ChevronRight size={14} class="chev" />
                            </button>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
}

// ---------------------------------------------------------------------------

function StatusIcon(p: { tool: ToolBlock }) {
    return (
        <Switch>
            <Match when={p.tool.status === "running" || p.tool.status === "streaming"}>
                <Spinner size={12} class="tone-accent" />
            </Match>
            <Match when={p.tool.status === "awaiting"}>
                <Hand size={12} class="tone-warn pulse" />
            </Match>
            <Match when={p.tool.status === "queued"}>
                <Clock size={12} class="tone-muted" />
            </Match>
            <Match when={p.tool.status === "error"}>
                <X size={12} class="tone-err" />
            </Match>
            <Match when={p.tool.status === "denied"}>
                <X size={12} class="tone-warn" />
            </Match>
        </Switch>
    );
}

const FILE_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** The file a call read or changed, and the line to open it at, while there's a file to open. */
export function toolFile(t: ToolBlock): { path: string; line?: number } | undefined {
    if (!FILE_TOOLS.has(t.name) || t.agent || t.status === "error" || t.status === "denied") return undefined;
    const i = t.input ?? {};
    const path = i.file_path ?? i.notebook_path;
    if (typeof path !== "string" || !path) return undefined;
    const offset = t.name === "Read" && typeof i.offset === "number" && i.offset >= 1 ? Math.floor(i.offset) : undefined;
    return { path, line: offset ?? firstChangedLine(t.diff) };
}

/** A small "Open in editor" button for a row. */
export function OpenFileButton(p: { path: string; line?: number }) {
    return (
        <button
            class="icon-btn row-open"
            data-find-skip
            title="Open in editor"
            aria-label={`Open ${p.path} in editor`}
            onClick={(e) => {
                e.stopPropagation();
                void openInEditor(p.path, p.line);
            }}
        >
            <SquareArrowOutUpRight size={13} />
        </button>
    );
}

/** One call, as a plain line; opens into its details. */
export function ToolRow(p: { tool: ToolBlock; activity?: boolean; detailsOnly?: boolean }) {
    return <RenderBoundary raw={() => p.tool}><ToolRowContent {...p} /></RenderBoundary>;
}

function ToolRowContent(p: { tool: ToolBlock; activity?: boolean; detailsOnly?: boolean }) {
    const [open, setOpen] = createSignal(false);
    createEffect(() => { if (p.detailsOnly) setOpen(true); });
    // Shown by find: its whole title, where the match may be past the cut.
    const found = () => findReveal()?.part === p.tool.id;
    const label = createMemo(() => toolLabel(p.tool));
    const meta = () => {
        const t = p.tool;
        if (t.status === "denied") return "Declined";
        if (t.diff && t.status === "ok") return undefined;
        return t.summary;
    };
    return (
        <div class={`tool ${open() ? "open" : ""} st-${p.tool.status} ${found() ? "found" : ""}`} data-find={p.tool.id}>
            <div class="tool-head" style={p.detailsOnly ? { display: "none" } : undefined}>
                <button class={p.activity ? `tool-line wrow ${isLive(p.tool) ? "live" : ""} ${p.tool.status === "awaiting" || p.tool.status === "queued" ? p.tool.status : ""}` : "tool-line"} onClick={() => setOpen(!open())} aria-expanded={open()}>
                    <span class={p.activity ? "tool-icon slot" : "tool-icon"}>
                        <Switch fallback={<ToolIcon name={p.tool.name} agent={p.tool.agent} size={p.activity ? 16 : 14} />}>
                            <Match when={p.activity && p.tool.status === "awaiting"}><Hand size={16} /></Match>
                            <Match when={p.activity && p.tool.status === "queued"}><Clock size={16} /></Match>
                        </Switch>
                    </span>
                    {/* Spaces between the parts, as find counts them ("Read src/a.ts"); a flex row doesn't draw them. */}
                    <span class={p.activity && isLive(p.tool) && p.tool.status !== "awaiting" && p.tool.status !== "queued" ? "tool-verb wverb shimmer" : p.activity && isLive(p.tool) ? "tool-verb wverb" : "tool-verb"} data-find-skip={isLive(p.tool) || undefined}>{p.activity && isLive(p.tool) ? runningVerb(p.tool) : label().verb}</span>{!isLive(p.tool) && " "}
                    <Show when={label().arg && (!p.activity || p.tool.status !== "streaming")}>
                        <span class={p.activity ? "tool-arg warg mono truncate" : "tool-arg truncate"} data-find-skip={p.tool.status === "streaming" || undefined}>{label().arg}</span>{!isLive(p.tool) && " "}
                    </Show>
                    <Show when={p.activity && p.tool.status === "streaming" && p.tool.receiving}>
                        <span class="warg truncate" data-find-skip>{tokens(p.tool.receiving!)} chars</span>
                    </Show>
                    <span class="tool-meta" data-find-skip={isLive(p.tool) || undefined}>
                        <Show when={p.activity && isLive(p.tool) && p.tool.job}>
                            {(job) => <span class="wjob num" data-find-skip title="How long ago the background command started">started {elapsed(now() - job().startedAt)} ago</span>}
                        </Show>
                        <Show when={p.activity && isLive(p.tool) && liveTime(p.tool)}>
                            {(time) => <span class="wtime num" data-find-skip>{time()}</span>}
                        </Show>
                        <Show when={p.tool.sandboxed}>
                            <span class="tool-tag" title="Ran in the sandbox" data-find-skip>
                                <ShieldCheck size={11} /> sandbox
                            </span>
                        </Show>
                        <Show when={meta()}>
                            <span class="truncate">{meta()}</span>
                        </Show>
                        <Show when={p.tool.diff && p.tool.status === "ok"}>
                            <span class="stat" data-find-skip>
                                <span class="add">+{p.tool.diff!.added}</span>
                                <span class="del">−{p.tool.diff!.removed}</span>
                            </span>
                        </Show>
                        <Show when={p.tool.diagnostics}>{(r) => <DiagnosticsChip report={r()} />}</Show>
                        <Show when={p.tool.durationMs !== undefined && p.tool.durationMs >= 1000}>
                            <span class="tool-dur num" data-find-skip>
                                {duration(p.tool.durationMs!)}
                            </span>
                        </Show>
                        <Show when={!p.activity || !isLive(p.tool)}><StatusIcon tool={p.tool} /></Show>
                    </span>
                </button>
                <Show when={toolFile(p.tool)}>{(f) => <OpenFileButton path={f().path} line={f().line} />}</Show>
            </div>
            <Show when={!open() && p.tool.status === "running" && p.tool.progress}>
                <pre class={p.activity ? "activity-tail" : "activity-tail nested"} data-find-skip>
                    {stripAnsi(p.tool.progress!).trimEnd().split("\n").slice(p.activity ? -4 : -6).join("\n")}
                </pre>
            </Show>
            <Show when={open()}>
                <div class="tool-detail" data-find-skip>
                    <ToolDetails tool={p.tool} />
                </div>
            </Show>
        </div>
    );
}

function Section(p: { label: string; children: JSX.Element; aside?: JSX.Element }) {
    return (
        <div class="detail-section">
            <div class="detail-label">
                <span>{p.label}</span>
                {p.aside}
            </div>
            {p.children}
        </div>
    );
}

function Output(p: { tool: ToolBlock }) {
    const [full, setFull] = createSignal<string>();
    const [loading, setLoading] = createSignal(false);
    const text = () => stripAnsi(full() ?? p.tool.output ?? "");
    const load = async () => {
        setLoading(true);
        try {
            setFull((await rpc.call("session.toolOutput", { id: app.activeId!, toolId: p.tool.id })).output);
        } catch (e) {
            reportError(e);
        } finally {
            setLoading(false);
        }
    };
    return (
        <Show when={text().trim()}>
            <Section
                label={p.tool.status === "error" ? "Error" : "Output"}
                aside={
                    <Show when={p.tool.outputTruncated && !full()}>
                        <button class="link-btn" disabled={loading()} onClick={load}>
                            {loading() ? "Loading…" : "Show full output"}
                        </button>
                    </Show>
                }
            >
                <pre class={`term ${p.tool.status === "error" ? "err" : ""}`}>{text()}</pre>
            </Section>
        </Show>
    );
}

type DiagnosticReport = NonNullable<ToolBlock["diagnostics"]>;

function diagnosticCounts(r: DiagnosticReport) {
    return {
        errors: r.files.reduce((a, f) => a + f.newErrors, 0),
        warnings: r.files.reduce((a, f) => a + f.newWarnings, 0),
        fixed: r.files.reduce((a, f) => a + f.fixed, 0),
    };
}

/** A group's word from the language server: each file as its latest report in the group left it. */
function groupDiagnostics(tools: ToolBlock[]): DiagnosticReport | undefined {
    const last = new Map<string, DiagnosticReport["files"][number]>();
    for (const t of tools) for (const f of t.diagnostics?.files ?? []) last.set(f.path, f);
    const files = [...last.values()];
    return files.length ? { files, omitted: files.reduce((a, f) => a + f.total - f.items.length, 0) } : undefined;
}

/** On the row: what the language server found after the edit, at a glance. */
function DiagnosticsChip(p: { report: DiagnosticReport }) {
    const c = () => diagnosticCounts(p.report);
    const title = () => {
        const { errors, warnings, fixed } = c();
        const parts = [errors && plural(errors, "new error"), warnings && plural(warnings, "new warning"), fixed && `${fixed} fixed`].filter(Boolean);
        return `Language server: ${parts.join(", ")}`;
    };
    return (
        <span class="diag-chip" title={title()} data-find-skip>
            <Show when={c().errors}>
                <span class="diag-err"><CircleX size={11} />{c().errors}</span>
            </Show>
            <Show when={c().warnings}>
                <span class="diag-warn"><AlertTriangle size={11} />{c().warnings}</span>
            </Show>
            <Show when={!c().errors && !c().warnings && c().fixed}>
                <span class="diag-ok"><CircleCheck size={11} />{c().fixed} fixed</span>
            </Show>
        </span>
    );
}

/** In the details: each new problem, its place opening the file there. */
function Diagnostics(p: { report: DiagnosticReport }) {
    const items = () => p.report.files.flatMap((f) => f.items);
    const more = () => p.report.omitted;
    const multi = () => p.report.files.length > 1;
    const aside = () => {
        const { errors, warnings, fixed } = diagnosticCounts(p.report);
        return [errors && plural(errors, "error"), warnings && plural(warnings, "warning"), fixed && `${fixed} fixed`].filter(Boolean).join(" · ");
    };
    return (
        <Section label="Diagnostics" aside={<span class="diag-aside">{aside()}</span>}>
            <Show when={items().length} fallback={<div class="detail-note">The problems reported before are gone.</div>}>
                <ul class="diag-list">
                    <For each={items()}>
                        {(i) => (
                            <li class={`diag-item ${i.severity}`}>
                                <span class="diag-icon">{i.severity === "error" ? <CircleX size={12} /> : <AlertTriangle size={12} />}</span>
                                <button class="diag-at mono" title={`Open ${i.path} at line ${i.line}`} onClick={() => void openInEditor(i.path, i.line, { col: i.col })}>
                                    {multi() ? `${i.path}:` : ""}{i.line}:{i.col}
                                </button>
                                <span class="diag-msg" title={i.message}>{i.message}</span>
                                <Show when={i.code}>
                                    <span class="diag-code mono">{i.source ? `${i.source}(${i.code})` : i.code}</span>
                                </Show>
                            </li>
                        )}
                    </For>
                </ul>
                <Show when={more() > 0}>
                    <div class="detail-note">and {plural(more(), "more problem")}</div>
                </Show>
            </Show>
        </Section>
    );
}

function Todos(p: { todos: TodoEntry[] }) {
    return (
        <ul class="todo-list">
            <For each={p.todos}>
                {(t) => (
                    <li class={t.status}>
                        <span class="todo-box">
                            <Show when={t.status === "completed"}>
                                <Check size={11} />
                            </Show>
                        </span>
                        <span>{t.status === "in_progress" ? (t.activeForm ?? t.content) : t.content}</span>
                    </li>
                )}
            </For>
        </ul>
    );
}

function ToolDetails(p: { tool: ToolBlock }) {
    return <RenderBoundary raw={() => p.tool}><ToolDetailsContent {...p} /></RenderBoundary>;
}

function ToolDetailsContent(p: { tool: ToolBlock }) {
    const t = () => p.tool;
    const input = () => t().input ?? {};
    return (
        <>
            <Show when={t().approval && t().approval !== "sandboxed" && t().approval !== "hook"}>
                <div class="approval-note">
                    <ShieldCheck size={13} /> Approved by the auto-mode reviewer: {t().approval}
                </div>
            </Show>
            <Show when={!t().diff && toolFile(t())}>
                {(f) => (
                    <button class="link-btn tool-open" data-find-skip onClick={() => void openInEditor(f().path, f().line)}>
                        <SquareArrowOutUpRight size={13} /> Open in editor
                    </button>
                )}
            </Show>
            <Switch
                fallback={
                    <>
                        <Show when={Object.keys(input()).length}>
                            <Section label="Input">
                                <CodeBlock code={JSON.stringify(input(), null, 2)} lang="json" bare maxHeight={240} />
                            </Section>
                        </Show>
                        <Output tool={t()} />
                    </>
                }
            >
                <Match when={t().diff}>
                    <DiffView diff={t().diff!} maxLines={80} header headerAction={<Show when={toolFile(t())}>{(f) => <OpenFileButton path={f().path} line={f().line} />}</Show>} />
                    <Show when={t().diagnostics}>{(r) => <Diagnostics report={r()} />}</Show>
                    <Show when={t().status === "error"}>
                        <Output tool={t()} />
                    </Show>
                </Match>
                <Match when={t().name === "Bash"}>
                    <Section label="Command">
                        <CodeBlock code={String(input().command ?? "")} lang="bash" bare />
                    </Section>
                    <Show when={t().status === "running" && t().progress} fallback={<Output tool={t()} />}>
                        <Section label="Output">
                            <pre class="term">{stripAnsi(t().progress ?? "")}</pre>
                        </Section>
                    </Show>
                </Match>
                <Match when={t().agent}>
                    <button class="link-btn" onClick={() => openAgents(t().id)}>
                        <Bot size={13} /> View its activity
                    </button>
                    <Show when={t().output && t().status !== "running"}>
                        <Section label="Report">
                            <Markdown text={t().output ?? ""} class="small" />
                        </Section>
                    </Show>
                </Match>
                <Match when={t().name === "TodoWrite"}>
                    <Todos todos={(input().todos as TodoEntry[]) ?? []} />
                </Match>
                <Match when={t().name === "ExitPlanMode"}>
                    <Section label="Plan">
                        <Markdown text={String(input().plan ?? "")} class="small" />
                    </Section>
                    <Show when={t().summary}>
                        <div class="detail-note">{t().summary}</div>
                    </Show>
                </Match>
                <Match when={t().name === "AskUserQuestion"}>
                    <Section label="Question">
                        <div class="detail-q">{String(input().question ?? "")}</div>
                    </Section>
                    <Show when={t().summary}>
                        <Section label="Answer">
                            <div class="detail-q">{t().summary}</div>
                        </Section>
                    </Show>
                </Match>
                <Match when={t().name === "Read" || t().name === "Grep" || t().name === "Glob" || t().name === "LS"}>
                    <Output tool={t()} />
                </Match>
            </Switch>
        </>
    );
}
