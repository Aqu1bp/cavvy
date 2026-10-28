import { RenderBoundary } from "../ui/ErrorBoundary";
// Tool calls, the way the transcript shows them: a run of calls folds into
// one line ("Read 3 files, searched 2 patterns · +13 −1"), which opens into
// a row per call, which opens into the call's details.

import { createContext, createEffect, createMemo, createSignal, For, Match, on, Show, Switch, useContext, type JSX, type Signal } from "solid-js";
import {
    AlertTriangle,
    Bot,
    Check,
    ChevronDown,
    ChevronRight,
    CircleCheck,
    CircleX,
    ClipboardList,
    Clock,
    FileDiff,
    FilePen,
    FilePlus2,
    FileText,
    FolderTree,
    Globe,
    Hand,
    ListChecks,
    MessageCircleQuestion,
    Plug,
    Radar,
    Search,
    Sparkles,
    ShieldCheck,
    SquareArrowOutUpRight,
    SquareTerminal,
    Wrench,
    X, GitCommitHorizontal, ArrowUpFromLine, GitPullRequestArrow } from "lucide-solid";
import type { AgentRun, Block, ThinkingBlock, TodoEntry, ToolBlock } from "@shared/protocol";
import { duration, firstChangedLine, plural, sleepSeconds, stripAnsi, tokens } from "../../lib/format";
import { commandDescription, isLive, runningVerb, shortModelRef, toolLabel } from "../../lib/tool-words";
import { commandCut, commandLabel, commandMeta, exitCode, firstLine, highlightShell, outputLines, passTally, taskOf, type ShellToken } from "../../lib/command-row";
import { enterRow, lineTone, STAGGER_MS } from "../../lib/live-line";
import { backgroundOf } from "../../lib/background";
import { agentProvider, agentStep } from "../../lib/agent-marks";
import { now } from "../../lib/clock";
import { app, handleFor, reportError, rpc } from "../../state/app";
import { prefs } from "../../state/prefs";
import { openAgents, openInEditor, openReview, stopBackground } from "../../state/actions";
import { findReveal } from "../../state/ui";
import { CopyButton, Spinner } from "../ui/bits";
import { AgentMark, ProviderStack } from "../ui/AgentMark";
import { CodeBlock } from "./CodeBlock";
import { DiffView } from "./DiffView";
import { Markdown } from "./Markdown";
import { PlanCard } from "./PlanCard";
import { motionMs } from "../LiveLine";

export type Item =
    | { kind: "block"; block: Block }
    | { kind: "activity"; id: string; tools: ToolBlock[]; steps: (ToolBlock | ThinkingBlock)[]; card?: Card };

/** A call shown as its own card rather than a line in a group: an edit (its diff), a command (its output), or a plan (PlanCard). */
export type Card = "edit" | "command" | "plan";

/**
 * Fold runs of tool calls (and the thinking between them) into activity groups.
 * Edits, commands and plans stand on their own, as cards, between the groups.
 */
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
            const card = cardOf(b);
            if (card) {
                out.push({ kind: "activity", id: `g-${b.id}`, tools: [b], steps: [b], card });
                group = undefined;
                return;
            }
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

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** Whether a call gets a card of its own (sub-agents keep their own row). */
export function cardOf(t: ToolBlock): Card | undefined {
    if (t.agent) return undefined;
    if (EDIT_TOOLS.has(t.name)) return "edit";
    if (t.name === "Bash") return "command";
    if (t.name === "ExitPlanMode") return "plan";
    return undefined;
}

// ---------------------------------------------------------------------------
// Icons and summaries (the words are lib/tool-words.ts's)

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
            <Match when={p.name === "Monitor"}><Radar size={s()} /></Match>
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
    const monitors: string[] = [];
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
            default:
                if (t.name.startsWith("mcp__")) mcp++;
                else misc.push(t.name);
        }
    }
    const parts: string[] = [];
    if (reads.size) parts.push(`read ${plural(reads.size, "file")}`);
    if (searches) parts.push(`searched ${searches === 1 ? "once" : searches === 2 ? "twice" : `${searches} times`}`);
    for (const p of created.size ? [`created ${plural(created.size, "file")}`] : []) parts.push(p);
    if (edited.size) parts.push(edited.size === 1 && !created.size ? `edited ${short([...edited][0]!)}` : `edited ${plural(edited.size, "file")}`);
    if (commands.length === 1 && commands[0]!.length <= 48 && !commands[0]!.includes("\n")) parts.push(`ran \`${commands[0]}\``);
    else if (commands.length) parts.push(`ran ${plural(commands.length, "command")}`);
    if (monitors.length === 1 && monitors[0] && monitors[0].length <= 48) parts.push(`started a monitor: ${monitors[0]}`);
    else if (monitors.length) parts.push(`started ${plural(monitors.length, "monitor")}`);
    if (web) parts.push("searched the web");
    if (fetched) parts.push(`fetched ${plural(fetched, "page")}`);
    if (agents) parts.push(agents === 1 ? "ran an agent" : `ran ${agents} agents`);
    if (mcp) parts.push(`used ${plural(mcp, "MCP tool")}`);
    if (skills.size) parts.push(skills.size === 1 && [...skills][0] ? `loaded the ${[...skills][0]} skill` : `loaded ${plural(skills.size, "skill")}`);
    parts.push(...misc);
    if (unchanged.size) parts.push(unchanged.size === 1 ? `couldn't change ${short([...unchanged][0]!)}` : `couldn't change ${plural(unchanged.size, "file")}`);
    if (declined && !parts.length) parts.push(`${plural(declined, "call")} declined`);
    const shown = parts.length > 3 ? [...parts.slice(0, 3), `${parts.length - 3} more`] : parts;
    const text = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : (shown[0] ?? "");
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

const elapsed = (ms: number) => duration(Math.max(0, ms)).replace(/^(\d+)ms$/, "0s");

/** How long a running call has run; a wait, against how long it waits. */
function liveTime(t: ToolBlock): string | undefined {
    if (!t.startedAt) return undefined;
    const ran = elapsed(now() - t.startedAt);
    const wait = t.name === "Bash" && t.status === "running" ? sleepSeconds(t.input?.command) : undefined;
    return wait ? `${ran} of ${elapsed(wait * 1000)}` : ran;
}

type GroupProps = {
    tools: ToolBlock[];
    steps: (ToolBlock | ThinkingBlock)[];
    turnRunning: boolean;
    keepTail?: boolean;
    agents?: AgentRun[];
    card?: Card;
    /** A turn's work log: a quiet row per finished step, no summary line (a sub-agent's view keeps its summaries). */
    flat?: boolean;
    /** The turn's live line says what's under way: calls still running aren't rows until they're done. */
    hideLive?: boolean;
};

export function ActivityGroup(p: GroupProps) {
    const folds = useContext(CardFoldsContext);
    return (
        <RenderBoundary raw={() => p.steps}>
            <Show when={p.card && p.tools[0]} fallback={p.flat ? <StepRows {...p} /> : <ActivityGroupContent {...p} />}>
                {(t) => (
                    <Show
                        when={p.card !== "plan"}
                        // A plan's card shows from when it's presented, waiting on you included; while it's still written, the live line says so.
                        fallback={<Show when={t().status !== "streaming" && t().status !== "queued"}><PlanCard tool={t()} sessionId={folds.sessionId} /></Show>}
                    >
                        <Show when={!(p.hideLive && isLive(t()))}>
                            {p.card === "edit" ? <EditCard tool={t()} /> : <CommandCard tool={t()} />}
                        </Show>
                    </Show>
                )}
            </Show>
        </RenderBoundary>
    );
}

/**
 * The model's reasoning, as a quiet row: "Thought for 41s", opening into the text. While it's written, the turn's
 * live line shows it (with its latest line); Settings → Show thinking hides finished ones.
 */
export function Thinking(p: { block: ThinkingBlock; live: boolean }) {
    const [open, setOpen] = createSignal(false);
    const label = () => (p.live ? "Thinking" : p.block.durationMs && p.block.durationMs >= 1500 ? `Thought for ${duration(p.block.durationMs)}` : "Thought briefly");
    const preview = () => p.block.text.trim().split("\n").filter(Boolean).slice(-2).join(" ");
    return (
        <Show when={prefs.showThinking || p.live}>
            <div ref={(el) => enterRow(el, motionMs(STAGGER_MS))} class={`wgroup thinking ${open() ? "open" : ""} ${p.live ? "live" : ""}`}>
                <button class="acts-h wrow" onClick={() => setOpen(!open())} aria-expanded={open()}>
                    <ChevronRight size={14} class="chev" />
                    <span class={`wtext ${p.live ? "shimmer" : ""}`}>{label()}</span>
                </button>
                <Show when={open()} fallback={<Show when={p.live && preview()}><div class="thinking-peek">{preview()}</div></Show>}>
                    <div class="thinking-text">{p.block.text.trim()}</div>
                </Show>
            </div>
        </Show>
    );
}

/** A run of calls in a turn's work: a row per step (icon, verb, what, and what it came to), and its sub-agents. */
function StepRows(p: GroupProps) {
    const agentIds = createMemo(() => new Set(p.tools.filter((t) => t.agent).map((t) => t.id)));
    const runs = createMemo(() => (p.agents ?? []).filter((a) => agentIds().has(a.id)));
    const runIds = createMemo(() => new Set(runs().map((a) => a.id)));
    // A sub-agent with a run is a row in the sub-agents' card; a call still under way is the live line's.
    const rows = createMemo(() => p.steps.filter((b) => b.t === "thinking" || (!runIds().has(b.id) && !(p.hideLive && isLive(b)))));
    return (
        <div class="steps">
            <For each={rows()}>{(b) => (b.t === "tool" ? <ToolRow tool={b} /> : <Thinking block={b} live={false} />)}</For>
            <Show when={runs().length}>
                <SubAgentsRow runs={runs()} />
            </Show>
        </div>
    );
}

function ActivityGroupContent(p: GroupProps) {
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

    // While a call runs the rows say what's happening; the header only sums up what's done.
    const live = createMemo(() => plain().some(isLive));
    const working = () => live() && (open() || !done().length);

    return (
        <div class={`acts ${open() ? "open" : ""} ${live() ? "live" : ""}`}>
            <Show when={done().length || live()}>
                <button class="acts-h wrow" data-find-skip onClick={() => setOpen(!open())} aria-expanded={open()}>
                    <Show when={live()} fallback={<ChevronRight size={14} class="chev" />}>
                        <Spinner size={12} class="tone-accent" />
                    </Show>
                    <Show when={!working()} fallback={<span class="wtext">Working</span>}>
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
                    </Show>
                </button>
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
                    return <div class={isCurrent() ? `activity-step current${b.t === "tool" && isLive(b) ? " live" : ""}` : "activity-step"} hidden={!visible()}>
                        <Show when={mounted()}>
                            {b.t === "tool" ? <ToolRow tool={b} activity={isCurrent()} detailsOnly={open() && single() && !isCurrent() && findReveal()?.part !== b.id} /> : <div class="wthought">{b.text.trim().split("\n")[0]}</div>}
                        </Show>
                    </div>;
                }}</For>
            </div>
        </div>
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

/** One line of what a sub-agent is up to (its step in a few words: agentStep), or what it found. */
export function agentLine(a: AgentRun): string {
    if (a.status === "waiting") return AGENT_STATUS.waiting;
    if (agentLive(a)) return agentStep(a)?.text ?? "Working";
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
    // Who runs each: its model's provider, else its parent's, else the session's.
    const folds = useCardFolds();
    const view = () => handleFor(folds.sessionId)?.view;
    const providerOf = (a: AgentRun) => agentProvider(a, view()?.state.model?.provider, view()?.agents);
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
                <ProviderStack providers={p.runs.map(providerOf)} />
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
                        {(a) => {
                            const meta = () => `${a.model ? `${shortModelRef(a.model)} · ` : ""}${a.effort ? `${a.effort} effort · ` : ""}`;
                            // The whole call it's making, for the tooltip and a screen reader: the line says it in a few words.
                            const full = () => (a.status === "running" ? agentStep(a)?.full : undefined);
                            return (
                                <button class={`agr ${findReveal()?.part === a.id ? "found" : ""}`} data-find={a.id} onClick={() => openAgents(a.id)} title={a.model ? `${a.description}\n${shortModelRef(a.model)}` : a.description}>
                                    <span class="av">
                                        <AgentMark provider={providerOf(a)} />
                                        <span class={`nd st-${a.status}`} />
                                    </span>
                                    <span class="agr-text">
                                        <span class="agr-name truncate">{a.description.trim() || "Sub-agent"}</span>{" "}
                                        <span class={`agr-sub truncate ${a.status === "failed" ? "tone-err" : ""}`} title={full()} aria-label={full() && `${meta()}${full()}`}>
                                            {meta()}
                                            {agentLine(a)}
                                        </span>
                                    </span>
                                    <span class="ag-time num">{agentElapsed(a)}</span>
                                    <ChevronRight size={14} class="chev" />
                                </button>
                            );
                        }}
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
        <div ref={(el) => enterRow(el, motionMs(STAGGER_MS))} class={`tool ${open() ? "open" : ""} st-${p.tool.status} ${found() ? "found" : ""}`} data-find={p.tool.id}>
            <div class="tool-head" style={p.detailsOnly ? { display: "none" } : undefined}>
                <button class={p.activity ? `tool-line wrow ${isLive(p.tool) ? "live" : ""} ${p.tool.status === "awaiting" || p.tool.status === "queued" ? p.tool.status : ""}` : "tool-line"} onClick={() => setOpen(!open())} aria-expanded={open()}>
                    <span class="tool-icon">
                        <Switch fallback={<ToolIcon name={p.tool.name} agent={p.tool.agent} size={14} />}>
                            <Match when={p.activity && p.tool.status === "awaiting"}><Hand size={14} /></Match>
                            <Match when={p.activity && p.tool.status === "queued"}><Clock size={14} /></Match>
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
                            {(job) => <span class="wjob num" data-find-skip>started {elapsed(now() - job().startedAt)} ago</span>}
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

// ---------------------------------------------------------------------------
// Cards: an edit with its diff, a command with its output. Find reads a
// card's header as the argument and the summary; the verb is there for the
// screen reader only, and like the rest it isn't searched, since it isn't seen.

/** The state of a call as a small pill at the end of its card's header. */
function StatusPill(p: { tool: ToolBlock; done?: string }) {
    return (
        <Switch>
            <Match when={p.tool.status === "awaiting"}>
                <span class="tpill warn" data-find-skip>
                    <Hand size={12} /> {runningVerb(p.tool)}
                </span>
            </Match>
            <Match when={isLive(p.tool)}>
                <span class="tpill run" data-find-skip>
                    <Spinner size={11} /> {p.tool.status === "running" ? (runningVerb(p.tool) === "Waiting" ? "Waiting" : "Running") : runningVerb(p.tool)}
                </span>
            </Match>
            <Match when={p.tool.status === "error"}>
                <span class="tpill fail" data-find-skip>
                    <X size={12} /> Failed
                </span>
            </Match>
            <Match when={p.tool.status === "denied"}>
                <span class="tpill fail">Declined</span>
            </Match>
            <Match when={p.done && p.tool.status === "ok"}>
                <span class="tpill ok" data-find-skip>
                    <Check size={12} /> {p.done}
                </span>
            </Match>
        </Switch>
    );
}

/** Approved by the auto-mode reviewer: said briefly in the header, its reason on hover. */
function Approved(p: { tool: ToolBlock }) {
    return (
        <Show when={p.tool.approval && p.tool.approval !== "sandboxed" && p.tool.approval !== "hook"}>
            <span class="tcard-dim truncate" title={`Approved by the auto-mode reviewer: ${p.tool.approval}`} data-find-skip>
                <ShieldCheck size={12} /> Approved by reviewer
            </span>
        </Show>
    );
}

/** An edit: the file, what it added and removed, and the change itself, open until folded. */
export function EditCard(p: { tool: ToolBlock }) {
    return <RenderBoundary raw={() => p.tool}><EditCardContent {...p} /></RenderBoundary>;
}

function EditCardContent(p: { tool: ToolBlock }) {
    const t = () => p.tool;
    // Open on the change, a problem or a failure; an edit with only its input and output to show
    // (no diff: a notebook edit, a MultiEdit) starts folded, as its row did, until it's opened.
    const [folded, setFolded] = createSignal<boolean>();
    createEffect(on(findReveal, (r) => r?.part === p.tool.id && setFolded(false)));
    const label = createMemo(() => toolLabel(t()));
    const live = () => isLive(t());
    const ok = () => t().status === "ok";
    const meta = () => (t().status === "denied" || (t().diff && ok()) ? undefined : t().summary);
    const input = () => (t().diff ? undefined : Object.keys(t().input ?? {}).length ? JSON.stringify(t().input, null, 2) : undefined);
    const showOutput = () => (!t().diff || t().status === "error") && Boolean(t().output?.trim());
    const hasBody = () => Boolean(t().diff || t().diagnostics || input() || showOutput());
    const open = () => !(folded() ?? !(t().diff || t().diagnostics || t().status === "error"));
    return (
        <div ref={(el) => enterRow(el, motionMs(STAGGER_MS))} class={`tcard edit-card st-${t().status} ${findReveal()?.part === t().id ? "found" : ""}`} data-find={t().id}>
            <div class="tcard-h">
                <span class="tcard-ic">
                    <Show when={!live()} fallback={<Spinner size={12} class="tone-accent" />}>
                        <Show when={t().diff?.status === "added" || (t().name === "Write" && !t().diff)} fallback={<FilePen size={14} />}>
                            <FilePlus2 size={14} />
                        </Show>
                    </Show>
                </span>
                <span class="tcard-verb" data-find-skip>{live() ? runningVerb(t()) : label().verb}{" "}</span>
                <Show when={label().arg && t().status !== "streaming"}>
                    <span class="tcard-p truncate" title={label().arg}>{label().arg}</span>{!live() && " "}
                </Show>
                <Show when={t().status === "streaming" && t().receiving}>
                    <span class="tcard-dim" data-find-skip>{tokens(t().receiving!)} chars</span>
                </Show>
                <Show when={t().diff && ok()}>
                    <span class="stat" data-find-skip>
                        <span class="add">+{t().diff!.added}</span>
                        <span class="del">−{t().diff!.removed}</span>
                    </span>
                </Show>
                <Show when={meta()}>
                    <span class="tcard-dim truncate" data-find-skip={live() || undefined}>{meta()}</span>
                </Show>
                <Show when={t().diagnostics}>{(r) => <DiagnosticsChip report={r()} />}</Show>
                <span class="grow" />
                <Approved tool={t()} />
                <StatusPill tool={t()} />
                <Show when={t().diff && ok()}>
                    <button class="icon-btn tcard-btn" data-find-skip title="Review in the side panel" aria-label={`Review ${t().diff!.path}`} onClick={() => openReview(t().diff!.path, "uncommitted")}>
                        <FileDiff size={14} />
                    </button>
                </Show>
                <Show when={toolFile(t())}>{(f) => <OpenFileButton path={f().path} line={f().line} />}</Show>
                <Show when={hasBody()}>
                    <button class="icon-btn tcard-btn" data-find-skip title={open() ? "Collapse" : "Expand"} aria-label={`${open() ? "Collapse" : "Show"} the ${t().diff ? "change" : "details"}`} aria-expanded={open()} onClick={() => setFolded(open())}>
                        <Show when={open()} fallback={<ChevronRight size={14} />}>
                            <ChevronDown size={14} />
                        </Show>
                    </button>
                </Show>
            </div>
            <Show when={open() && hasBody()}>
                <div class="tcard-body" data-find-skip>
                    <Show when={t().diff}>{(d) => <DiffView diff={d()} maxLines={16} class="inline" />}</Show>
                    <Show when={input()}>
                        {(code) => (
                            <div class="tcard-sec">
                                <Section label="Input">
                                    <CodeBlock code={code()} lang="json" bare maxHeight={240} />
                                </Section>
                            </div>
                        )}
                    </Show>
                    <Show when={t().diagnostics}>
                        {(r) => (
                            <div class="tcard-sec">
                                <Diagnostics report={r()} />
                            </div>
                        )}
                    </Show>
                    <Show when={showOutput()}>
                        <Output tool={t()} bare />
                    </Show>
                </div>
            </Show>
        </div>
    );
}

/** The last lines of a running command's output; the whole of it once it's done. */
const LIVE_LINES = 40;

/** Which command rows the reader opened (or folded again), by call id; and the session they're in. */
export type CardFolds = { get(id: string): boolean | undefined; set(id: string, open: boolean): void; sessionId?: string };

function cardFolds(): CardFolds {
    const open = new Map<string, Signal<boolean | undefined>>();
    const of = (id: string) => {
        let s = open.get(id);
        if (!s) open.set(id, (s = createSignal<boolean>()));
        return s;
    };
    return { get: (id) => of(id)[0](), set: (id, value) => of(id)[1](value) };
}

/** Each session's, kept while the app runs: a row drawn again (the work log folded and opened, another session and back) is as it was left. */
const sessionFolds = new Map<string, CardFolds>();
function foldsOf(sessionId: string): CardFolds {
    let folds = sessionFolds.get(sessionId);
    if (!folds) {
        sessionFolds.set(sessionId, (folds = cardFolds()));
        if (sessionFolds.size > 100) sessionFolds.delete(sessionFolds.keys().next().value!);
    }
    return folds;
}

/** Outside a session's views (a test, a preview), the rows share one set. */
const CardFoldsContext = createContext<CardFolds>(cardFolds());

/** The command rows under it keep their open state in `sessionId`'s set, and find their background tasks there. */
export function CardFoldsProvider(p: { sessionId: string; children: JSX.Element }) {
    const folds: CardFolds = {
        get: (id) => foldsOf(p.sessionId).get(id),
        set: (id, open) => foldsOf(p.sessionId).set(id, open),
        get sessionId() {
            return p.sessionId;
        },
    };
    return <CardFoldsContext.Provider value={folds}>{p.children}</CardFoldsContext.Provider>;
}

/** The folds the command rows here keep: the live line opens a running command in them, so its row commits as it was left. */
export function useCardFolds(): CardFolds {
    return useContext(CardFoldsContext);
}

/**
 * The last line a command printed: the latest of its live output, or of its output once it failed,
 * passing over the exit code the tool adds at the end ("Exit code: 1"), which the row already says.
 */
function lastLine(text: string | undefined): string | undefined {
    if (!text) return undefined;
    // Only the end is wanted: don't clean a long output to read one line of it.
    const lines = stripAnsi(text.slice(-4096)).split(/\r\n|\r|\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!.trim();
        if (line && !/^Exit code:? -?\d+\b/.test(line)) return line;
    }
    return undefined;
}

/**
 * A command, as a quiet row: what it's for (Claude Code's description), or the command itself, shortened, when it
 * has none (Codex). On the right, in columns shared with the rows around it, what it came to: a test run's tally,
 * or a red "Exit 1" with its last line under the row; and its time. One run in the background says so, with Stop
 * on hover. Opened (a click, Enter or Space), the whole command, highlighted, over its output, each with Copy, and
 * a footer with the exit and the time.
 */
export function CommandCard(p: { tool: ToolBlock }) {
    return <RenderBoundary raw={() => p.tool}><CommandCardContent {...p} /></RenderBoundary>;
}

function CommandCardContent(p: { tool: ToolBlock }) {
    const folds = useContext(CardFoldsContext);
    const t = () => p.tool;
    const label = createMemo(() => toolLabel(t()));
    const live = () => isLive(t());
    const command = () => String(t().input?.command ?? "").trim();
    const description = () => commandDescription(t());
    const rowLabel = createMemo(() => commandLabel(t()));
    const meta = () => commandMeta(t());
    // The task it started in the background (Claude Code's run_in_background, Codex's terminals, Cavvy's shells).
    const task = createMemo(() => {
        const id = folds.sessionId;
        if (!id) return undefined;
        return taskOf(t(), backgroundOf(handleFor(id)?.view.state));
    });
    const background = () => task()?.status === "running";
    const failed = () => t().status === "error";
    const code = createMemo(() => (failed() ? exitCode(t()) : undefined));
    const exitText = () => (code() !== undefined ? `Exit ${code()}` : "Failed");
    // Folded until the reader opens it (or asked for activity open in Settings); find opens it on a match.
    const open = () => folds.get(t().id) ?? prefs.expandActivity;
    const setOpen = (value: boolean) => folds.set(t().id, value);
    createEffect(on(findReveal, (r) => r?.part === p.tool.id && setOpen(true)));
    const running = () => t().status === "running";
    const hasBody = () => Boolean(command()) && t().status !== "streaming";
    const shown = () => open() && hasBody();
    const tail = createMemo(() => (shown() ? undefined : running() ? lastLine(t().progress) : failed() ? lastLine(t().output) : undefined));
    // Its time: a background task's own (so far, or how long it ran), else the call's.
    const time = () => {
        const tk = task();
        if (tk) return tk.status === "running" ? elapsed(now() - tk.startedAt) : tk.endedAt !== undefined ? duration(tk.endedAt - tk.startedAt) : undefined;
        return live() ? liveTime(t()) : t().durationMs !== undefined ? duration(t().durationMs!) : undefined;
    };
    // What became of its background task, as its tag and footer say it.
    const taskWord = () => {
        const s = task()?.status;
        return s === undefined ? undefined : s === "running" ? "In the background" : s === "done" ? "Finished" : s === "failed" ? "Failed" : "Stopped";
    };
    const toggle = () => hasBody() && setOpen(!open());
    const [stopping, setStopping] = createSignal(false);
    const stop = async (e: MouseEvent) => {
        e.stopPropagation();
        const id = folds.sessionId;
        const tk = task();
        if (!id || !tk) return;
        setStopping(true);
        try {
            await stopBackground(id, [tk.id]);
        } finally {
            setStopping(false);
        }
    };
    return (
        <div ref={(el) => enterRow(el, motionMs(STAGGER_MS))} class={`tcard cmd-card cmd-row st-${t().status} ${shown() ? "open" : ""} ${failed() ? "fail" : ""} ${background() ? "bg" : ""} ${findReveal()?.part === t().id ? "found" : ""}`} data-find={t().id}>
            <div
                class="cmd-h"
                role="button"
                tabindex={hasBody() ? 0 : -1}
                aria-expanded={hasBody() ? shown() : undefined}
                aria-disabled={hasBody() ? undefined : true}
                onClick={toggle}
                onKeyDown={(e) => {
                    if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                    e.preventDefault();
                    toggle();
                }}
            >
                {/* Its columns (the label, then tags, result, time, chevron) line up with the rows around it (transcript.css). */}
                <span class="cmd-what">
                    <span class="ic">
                        <Show when={live() || background()} fallback={<SquareTerminal size={14} />}>
                            <Spinner size={12} />
                        </Show>
                    </span>
                    <span class="sr-only" data-find-skip>{label().verb}{" "}</span>
                    {/* Folded, only what it's for: the command is in the row opened. Under way, find counts the command
                        (as on the live line, whose label the description is), so not this. */}
                    <Show when={rowLabel() && t().status !== "streaming"}>
                        <span class={`cmd-l ${description() ? "" : "solo"} ${!description() && command().includes("\n") ? "more" : ""}`} data-find-skip={live() || undefined}>{rowLabel()}</span>{" "}
                    </Show>
                    <Show when={t().status === "streaming" && t().receiving}>
                        <span class="cmd-dim" data-find-skip>{tokens(t().receiving!)} chars</span>
                    </Show>
                    <span class="cmd-tools" data-find-skip>
                        <Show when={background() && task()!.stoppable && folds.sessionId}>
                            <button class="icon-btn stop" title="Stop this task" aria-label={`Stop the background command: ${task()!.label}`} disabled={stopping()} onClick={(e) => void stop(e)}>
                                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                                    <rect x="1" y="1" width="8" height="8" rx="2" fill="currentColor" />
                                </svg>
                            </button>
                        </Show>
                        <Show when={command() && !commandCut(command())}>
                            <CopyButton text={command} label="Copy command" class="cp" />
                        </Show>
                    </span>
                </span>
                <span class="cmd-tags">
                    <Show when={t().sandboxed}>
                        <span class="cmd-tag" title="Ran in the sandbox" data-find-skip>
                            <ShieldCheck size={12} /> sandbox
                        </span>
                    </Show>
                    <Approved tool={t()} />
                    {/* Started in the background: how its task is doing, when the session still lists it. */}
                    <Show when={task()} fallback={<Show when={t().input?.run_in_background === true && t().status === "ok"}><span class="cmd-tag badge" data-find-skip>Started in the background</span></Show>}>
                        <span class="cmd-tag badge" data-find-skip>
                            {taskWord()}
                        </span>
                    </Show>
                    <Show when={t().status === "awaiting"}>
                        <span class="cmd-tag warn" data-find-skip>
                            <Hand size={12} /> {runningVerb(t())}
                        </span>
                    </Show>
                </span>
                {/* What it came to: its summary ("(no output)", "Timed out", "Declined"), its exit, a test run's tally. */}
                <span class="cmd-res">
                    <Show when={meta()}>
                        <span class={`cmd-dim ${t().status === "denied" ? "exit" : ""}`} data-find-skip={live() || undefined}>{meta()}</span>
                    </Show>
                    <Show when={failed()}>
                        <span class="exit" data-find-skip>{exitText()}</span>
                    </Show>
                    <Show when={t().status === "ok" && !task() && passTally(t())}>{(sum) => <span class="cmd-sum" data-find-skip>{sum()}</span>}</Show>
                </span>
                <span class="cmd-time num" data-find-skip>{time()}</span>
                <span class="chev-w" aria-hidden="true">
                    <Show when={hasBody()}>
                        <ChevronRight size={14} class="chev" />
                    </Show>
                </span>
            </div>
            {/* Its last line, under the row while it's folded: a failure's, or what it's printing. Find counts it in the body it opens. */}
            <Show when={tail()}>
                <div class={`cmd-tail ${failed() ? "err" : ""}`} title={tail()} data-find-skip>{tail()}</div>
            </Show>
            <Show when={shown()}>
                {/* Find counts a finished command's body (see blockText): a line between it and the header, as there. */}
                {"\n"}
                <CommandBody tool={t()} live={live()} running={running()} code={code()} task={background() ? "Running" : taskWord()} time={time()} />
            </Show>
        </div>
    );
}

/** A command under way, opened on the turn's live line (LiveLine.tsx): the block its row opens to. */
export function LiveCommandBody(p: { tool: ToolBlock }) {
    return <CommandBody tool={p.tool} live running={p.tool.status === "running"} code={undefined} task={undefined} time={liveTime(p.tool)} />;
}

/** An opened command: the whole of it after "$", highlighted, over its output; then how it ended. Built when first opened. */
function CommandBody(p: { tool: ToolBlock; live: boolean; running: boolean; code: number | undefined; task: string | undefined; time: string | undefined }) {
    const command = () => String(p.tool.input?.command ?? "").trim();
    const tokens = createMemo(() => firstLine(highlightShell(command())));
    const token = (tk: ShellToken) => (tk.cls ? <span class={tk.cls}>{tk.text}</span> : tk.text);
    const [full, setFull] = createSignal<string>();
    const [loading, setLoading] = createSignal(false);
    const lines = createMemo(() => outputLines(full() ?? p.tool.output, p.tool.status === "error"));
    const progress = () => (p.running && p.tool.progress ? stripAnsi(p.tool.progress).trimEnd().split("\n").slice(-LIVE_LINES).join("\n") : "");
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
    let out: HTMLPreElement | undefined;
    // Follow the output while it runs, unless the reader has scrolled up in it. Whether they're at
    // the end is taken as they scroll: measured after new lines arrive, a burst would look like a scroll away.
    let atEnd = true;
    createEffect(on(progress, () => {
        if (out && atEnd) out.scrollTop = out.scrollHeight;
    }));
    const failed = () => p.tool.status === "error";
    return (
        <div class="cmd-body">
            <div class="cmd-in">
                <span class="ps" aria-hidden="true" data-find-skip>$</span>
                {/* Under way, find counts its first line, as the live line shows it (find.ts). */}
                <pre>
                    <For each={tokens()[0]}>{token}</For>
                    <span data-find-skip={p.live || undefined}>
                        <For each={tokens()[1]}>{token}</For>
                    </span>
                </pre>
                <Show when={!commandCut(command())}>
                    <span data-find-skip>
                        <CopyButton text={command} label="Copy command" class="cp" />
                    </span>
                </Show>
            </div>
            {"\n"}
            {/* Under way, find counts only the command (find.ts): its output keeps changing. */}
            <div class="cmd-out" data-find-skip={p.live || undefined}>
                <Show
                    when={p.live}
                    fallback={
                        <Show when={lines().length} fallback={<pre><span class="none" data-find-skip>{p.tool.status === "ok" || failed() ? "No output" : p.tool.status === "denied" ? "It didn't run" : "Nothing yet"}</span></pre>}>
                            <pre class={failed() ? "err" : ""}>
                                <For each={lines()}>{(l, i) => <>{i() > 0 && "\n"}<span class={lineTone(l) ?? ""}>{l}</span></>}</For>
                            </pre>
                            <span data-find-skip>
                                <CopyButton text={() => lines().join("\n")} label="Copy output" class="cp" />
                            </span>
                        </Show>
                    }
                >
                    <pre ref={(el) => ((out = el), (atEnd = true))} onScroll={() => out && (atEnd = out.scrollHeight - out.scrollTop - out.clientHeight < 40)}>
                        {progress() || <span class="none">Nothing yet</span>}
                    </pre>
                </Show>
            </div>
            <div class="cmd-foot" data-find-skip>
                <span class={failed() ? "exit" : ""}>{p.live ? "Running" : p.task ? p.task : p.tool.status === "denied" ? "Declined" : p.code !== undefined ? `Exit ${p.code}` : failed() ? "Failed" : "Exit 0"}</span>
                <Show when={p.time}>
                    <span>·</span>
                    <span class="num">{p.time}</span>
                </Show>
                <Show when={!p.live && lines().length > 8}>
                    <span>·</span>
                    <span class="num">{plural(lines().length, "line")}</span>
                </Show>
                <span class="grow" />
                <Show when={!p.live && p.tool.outputTruncated && !full()}>
                    <button class="link-btn" disabled={loading()} onClick={(e) => (e.stopPropagation(), void load())}>
                        {loading() ? "Loading…" : "Show full output"}
                    </button>
                </Show>
            </div>
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

function Output(p: { tool: ToolBlock; bare?: boolean }) {
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
    const more = () => (
        <Show when={p.tool.outputTruncated && !full()}>
            <button class="link-btn" disabled={loading()} onClick={load}>
                {loading() ? "Loading…" : "Show full output"}
            </button>
        </Show>
    );
    return (
        <Show when={text().trim()}>
            <Show
                when={p.bare}
                fallback={
                    <Section label={p.tool.status === "error" ? "Error" : "Output"} aside={more()}>
                        <pre class={`term ${p.tool.status === "error" ? "err" : ""}`}>{text()}</pre>
                    </Section>
                }
            >
                <pre class={`tcard-out ${p.tool.status === "error" ? "err" : ""}`}>{text()}</pre>
                <Show when={p.tool.outputTruncated && !full()}>
                    <div class="tcard-more" data-find-skip>{more()}</div>
                </Show>
            </Show>
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
                <Match when={t().name === "Bash" || t().name === "Monitor"}>
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
