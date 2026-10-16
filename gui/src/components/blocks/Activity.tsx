// Tool calls, the way the transcript shows them: a run of calls folds into
// one line ("Read 3 files, searched 2 patterns · +13 −1"), which opens into
// a row per call, which opens into the call's details.

import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch, type JSX } from "solid-js";
import {
    AlertTriangle,
    Bot,
    Check,
    ChevronRight,
    ClipboardList,
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
    ShieldCheck,
    SquareArrowOutUpRight,
    SquareTerminal,
    Wrench,
    X,
} from "lucide-solid";
import type { AgentRun, Block, ThinkingBlock, TodoEntry, ToolBlock } from "@shared/protocol";
import { duration, firstChangedLine, plural, splitTitle, stripAnsi, tokens } from "../../lib/format";
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
    blocks.forEach((b, i) => {
        if (b.t === "tool") {
            if (!group) out.push((group = { kind: "activity", id: `g-${b.id}`, tools: [], steps: [] }));
            group.tools.push(b);
            group.steps.push(b);
            return;
        }
        if (b.t === "thinking") {
            // Thinking between two tool calls belongs to the work, not the reply.
            const next = blocks.slice(i + 1).find((x) => x.t !== "thinking");
            if (group && next?.t === "tool") {
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
    TodoWrite: "Update todos",
    AskUserQuestion: "Ask",
    ExitPlanMode: "Present plan",
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
    TodoWrite: "Updating todos",
    AskUserQuestion: "Waiting for your answer",
    ExitPlanMode: "Waiting for plan review",
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
    if (t.name === "Task") a = String(input.description ?? arg ?? "");
    if (t.name === "AskUserQuestion") a = String(input.question ?? arg ?? "");
    if (t.name === "TodoWrite" || t.name === "ExitPlanMode") a = undefined;
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
            <Match when={p.name === "TodoWrite"}><ListChecks size={s()} /></Match>
            <Match when={p.name === "AskUserQuestion"}><MessageCircleQuestion size={s()} /></Match>
            <Match when={p.name === "ExitPlanMode"}><ClipboardList size={s()} /></Match>
            <Match when={p.name.startsWith("mcp__")}><Plug size={s()} /></Match>
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
            case "TodoWrite":
                if (!misc.includes("updated todos")) misc.push("updated todos");
                break;
            case "AskUserQuestion":
                misc.push("asked a question");
                break;
            case "ExitPlanMode":
                misc.push("presented a plan");
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

const isLive = (t: ToolBlock) => t.status === "running" || t.status === "streaming" || t.status === "awaiting";

export function ActivityGroup(p: { tools: ToolBlock[]; steps: (ToolBlock | ThinkingBlock)[]; turnRunning: boolean; agents?: AgentRun[] }) {
    const [open, setOpen] = createSignal(prefs.expandActivity);
    // Find opens it to one of its calls; a lone call then shows as its row, the title find matched.
    const [found, setFound] = createSignal(false);
    createEffect(on(findReveal, (r) => r && p.tools.some((t) => t.id === r.part) && (setOpen(true), setFound(true))));
    const runs = createMemo(() => (p.agents ?? []).filter((a) => p.tools.some((t) => t.agent && t.id === a.id)));
    const plain = createMemo(() => p.tools.filter((t) => !runs().some((a) => a.id === t.id)));
    const running = createMemo(() => plain().find(isLive));
    const done = createMemo(() => plain().filter((t) => t !== running()));
    const steps = createMemo(() => p.steps.filter((b) => b.t === "thinking" || done().includes(b)));
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
    const failed = () => done().filter((t) => t.status === "error").length;
    const denied = () => done().filter((t) => t.status === "denied").length;
    const single = () => done().length === 1 && steps().length === 1 && !found();

    return (
        <>
            <Show when={done().length}>
                <div class={`wgroup ${open() ? "open" : ""}`}>
                    <button class="wrow" onClick={() => setOpen(!open())} aria-expanded={open()}>
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
                    <Show when={open()}>
                        <div class="wkids">
                            <Show when={single()} fallback={<For each={steps()}>{(b) => (b.t === "tool" ? <ToolRow tool={b} /> : <div class="wthought">{(b as ThinkingBlock).text.trim().split("\n")[0]}</div>)}</For>}>
                                <div class="tool-detail">
                                    <ToolDetails tool={done()[0]!} />
                                </div>
                            </Show>
                        </div>
                    </Show>
                </div>
            </Show>
            <Show when={runs().length}>
                <SubAgentsRow runs={runs()} />
            </Show>
            <Show when={running()} keyed>
                {(t) => <RunningRow tool={t} />}
            </Show>
        </>
    );
}

/** The call running now: what it's doing, shimmering, and for how long. */
function RunningRow(p: { tool: ToolBlock }) {
    const label = () => toolLabel(p.tool);
    const verb = () => {
        const t = p.tool;
        if (t.status === "awaiting") return t.name === "AskUserQuestion" || t.name === "ExitPlanMode" ? RUNNING[t.name]! : "Waiting for approval";
        if (t.status === "streaming") return `Preparing ${VERBS[t.name]?.toLowerCase() ?? t.name}`;
        return RUNNING[t.name] ?? `Running ${t.name}`;
    };
    const tail = () => (p.tool.progress ? stripAnsi(p.tool.progress).trimEnd().split("\n").slice(-4).join("\n") : undefined);
    return (
        <>
            <div class={`wrow live ${p.tool.status === "awaiting" ? "awaiting" : ""}`}>
                <span class="slot">
                    <Show when={p.tool.status === "awaiting"} fallback={<ToolIcon name={p.tool.name} size={16} />}>
                        <Hand size={16} />
                    </Show>
                </span>
                <span class={p.tool.status === "awaiting" ? "wverb" : "wverb shimmer"}>{verb()}</span>
                <Show when={label().arg && p.tool.status !== "streaming"}>
                    <span class="warg mono truncate">{label().arg}</span>
                </Show>
                <Show when={p.tool.status === "streaming" && p.tool.receiving}>
                    <span class="warg truncate">{tokens(p.tool.receiving!)} chars</span>
                </Show>
                <Show when={p.tool.startedAt}>
                    <span class="wtime num">{duration(Math.max(0, now() - p.tool.startedAt!)).replace(/^(\d+)ms$/, "0s")}</span>
                </Show>
            </div>
            <Show when={tail()}>
                <pre class="activity-tail">{tail()}</pre>
            </Show>
        </>
    );
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
                                    <span class="agr-name truncate">{a.description.trim() || "Sub-agent"}</span>
                                    <span class={`agr-sub truncate ${a.status === "failed" ? "tone-err" : ""}`}>
                                        {a.model ? `${shortModelRef(a.model)} · ` : ""}
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
export function ToolRow(p: { tool: ToolBlock; nested?: boolean }) {
    const [open, setOpen] = createSignal(false);
    // Shown by find: its whole title, where the match may be past the cut.
    const found = () => findReveal()?.part === p.tool.id;
    const label = () => toolLabel(p.tool);
    const meta = () => {
        const t = p.tool;
        if (t.status === "denied") return "Declined";
        if (t.diff && t.status === "ok") return undefined;
        return t.summary;
    };
    return (
        <div class={`tool ${open() ? "open" : ""} st-${p.tool.status} ${p.nested ? "nested" : ""} ${found() ? "found" : ""}`} data-find={p.tool.id}>
            <div class="tool-head">
                <button class="tool-line" onClick={() => setOpen(!open())} aria-expanded={open()}>
                    <span class="tool-icon">
                        <ToolIcon name={p.tool.name} agent={p.tool.agent} size={14} />
                    </span>
                    <span class="tool-verb">{label().verb}</span>
                    <Show when={label().arg}>
                        <span class="tool-arg truncate">{label().arg}</span>
                    </Show>
                    <span class="tool-meta">
                        <Show when={p.tool.sandboxed}>
                            <span class="tool-tag" title="Ran in the sandbox">
                                <ShieldCheck size={11} /> sandbox
                            </span>
                        </Show>
                        <Show when={meta()}>
                            <span class="truncate">{meta()}</span>
                        </Show>
                        <Show when={p.tool.diff && p.tool.status === "ok"}>
                            <span class="stat">
                                <span class="add">+{p.tool.diff!.added}</span>
                                <span class="del">−{p.tool.diff!.removed}</span>
                            </span>
                        </Show>
                        <Show when={p.tool.durationMs !== undefined && p.tool.durationMs >= 1000}>
                            <span class="tool-dur num">{duration(p.tool.durationMs!)}</span>
                        </Show>
                        <StatusIcon tool={p.tool} />
                    </span>
                </button>
                <Show when={toolFile(p.tool)}>{(f) => <OpenFileButton path={f().path} line={f().line} />}</Show>
            </div>
            <Show when={!open() && p.tool.status === "running" && p.tool.progress}>
                <pre class="activity-tail nested">{stripAnsi(p.tool.progress!).trimEnd().split("\n").slice(-6).join("\n")}</pre>
            </Show>
            <Show when={open()}>
                <div class="tool-detail">
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
                    <button class="link-btn tool-open" onClick={() => void openInEditor(f().path, f().line)}>
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
                    <Show when={t().sub}>
                        <Section label={`${t().sub!.label} · ${plural(t().sub!.toolCount, "tool use")}${t().sub!.tokens ? ` · ${tokens(t().sub!.tokens)} tokens` : ""}`}>
                            <div class="sub-rows">
                                <For each={t().sub!.tools}>{(x) => <ToolRow tool={x} nested />}</For>
                            </div>
                        </Section>
                    </Show>
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
