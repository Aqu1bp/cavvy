// Tool calls, the way the transcript shows them: a run of calls folds into
// one line ("Read 3 files, searched 2 patterns · +13 −1"), which opens into
// a row per call, which opens into the call's details.

import { createMemo, createSignal, For, Match, Show, Switch, type JSX } from "solid-js";
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
    SquareTerminal,
    Wrench,
    X,
} from "lucide-solid";
import type { Block, ThinkingBlock, TodoEntry, ToolBlock } from "@shared/protocol";
import { duration, plural, splitTitle, stripAnsi, tokens } from "../../lib/format";
import { app, reportError, rpc } from "../../state/app";
import { prefs } from "../../state/prefs";
import { Spinner } from "../ui/bits";
import { CodeBlock } from "./CodeBlock";
import { DiffStat, DiffView } from "./DiffView";
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

export function toolLabel(t: ToolBlock): { verb: string; arg?: string } {
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

export function ToolIcon(p: { name: string; size?: number }) {
    const s = () => p.size ?? 15;
    return (
        <Switch fallback={<Wrench size={s()} />}>
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
    for (const t of tools) {
        const i = t.input ?? {};
        const path = String(i.file_path ?? i.notebook_path ?? i.path ?? t.title);
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

export function ActivityGroup(p: { tools: ToolBlock[]; steps: (ToolBlock | ThinkingBlock)[]; turnRunning: boolean }) {
    const [open, setOpen] = createSignal(prefs.expandActivity);
    const running = createMemo(() => p.tools.find((t) => t.status === "running" || t.status === "streaming" || t.status === "awaiting"));
    const stats = createMemo(() => {
        let added = 0;
        let removed = 0;
        for (const t of p.tools) {
            if (t.diff && t.status === "ok") {
                added += t.diff.added;
                removed += t.diff.removed;
            }
        }
        return { added, removed };
    });
    const failed = () => p.tools.filter((t) => t.status === "error").length;
    const denied = () => p.tools.filter((t) => t.status === "denied").length;
    const live = () => {
        const r = running();
        if (!r) return undefined;
        if (r.status === "awaiting") return r.name === "AskUserQuestion" || r.name === "ExitPlanMode" ? RUNNING[r.name] : "Waiting for approval";
        if (r.status === "streaming") return `Preparing ${VERBS[r.name]?.toLowerCase() ?? r.name}${r.receiving ? ` · ${tokens(r.receiving)} chars` : ""}`;
        const { arg } = toolLabel(r);
        return `${RUNNING[r.name] ?? `Running ${r.name}`}${arg ? ` ${arg}` : ""}`;
    };
    const tail = () => {
        const r = running();
        if (!r?.progress) return undefined;
        return stripAnsi(r.progress).trimEnd().split("\n").slice(-4).join("\n");
    };

    return (
        <div class={`activity ${open() ? "open" : ""} ${running() ? "live" : ""}`}>
            <button class="activity-line" onClick={() => setOpen(!open())} aria-expanded={open()}>
                <span class="activity-chevron">
                    <ChevronRight size={14} />
                </span>
                <Show when={running()} fallback={<span class="activity-text"><Inline text={summarize(p.tools)} /></span>}>
                    <span class={`activity-text shimmer ${running()?.status === "awaiting" ? "awaiting" : ""}`}>
                        <Show when={running()?.status === "awaiting"} fallback={<Spinner size={12} />}>
                            <Hand size={13} />
                        </Show>
                        <span class="truncate">{live()}</span>
                    </span>
                </Show>
                <Show when={stats().added || stats().removed}>
                    <DiffStat added={stats().added} removed={stats().removed} />
                </Show>
                <Show when={failed()}>
                    <span class="activity-flag err" title={`${plural(failed(), "call")} failed`}>
                        <AlertTriangle size={12} /> {failed()}
                    </span>
                </Show>
                <Show when={denied()}>
                    <span class="activity-flag warn" title={`${plural(denied(), "call")} declined`}>
                        <X size={12} /> {denied()}
                    </span>
                </Show>
            </button>
            <Show when={!open() && tail()}>
                <pre class="activity-tail">{tail()}</pre>
            </Show>
            <Show when={open() && p.tools.length === 1 && p.steps.length === 1}>
                {/* One call: its details straight away, no second row to open. */}
                <div class="activity-single">
                    <ToolDetails tool={p.tools[0]!} />
                </div>
            </Show>
            <Show when={open() && !(p.tools.length === 1 && p.steps.length === 1)}>
                <div class="activity-rows">
                    <For each={p.steps}>
                        {(b) => (b.t === "tool" ? <ToolRow tool={b} /> : <div class="activity-thought">{(b as ThinkingBlock).text.trim().split("\n")[0]}</div>)}
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
                <Spinner size={13} class="tone-accent" />
            </Match>
            <Match when={p.tool.status === "awaiting"}>
                <Hand size={13} class="tone-warn pulse" />
            </Match>
            <Match when={p.tool.status === "ok"}>
                <Check size={13} class="tone-ok" />
            </Match>
            <Match when={p.tool.status === "error"}>
                <X size={13} class="tone-err" />
            </Match>
            <Match when={p.tool.status === "denied"}>
                <X size={13} class="tone-warn" />
            </Match>
        </Switch>
    );
}

export function ToolRow(p: { tool: ToolBlock; nested?: boolean }) {
    const [open, setOpen] = createSignal(false);
    const label = () => toolLabel(p.tool);
    const meta = () => {
        const t = p.tool;
        if (t.status === "denied") return "Declined";
        if (t.diff && t.status === "ok") return undefined;
        return t.summary;
    };
    return (
        <div class={`tool ${open() ? "open" : ""} st-${p.tool.status}`}>
            <button class="tool-line" onClick={() => setOpen(!open())} aria-expanded={open()}>
                <span class="tool-icon">
                    <ToolIcon name={p.tool.name} />
                </span>
                <span class="tool-verb">{label().verb}</span>
                <Show when={label().arg}>
                    <span class="tool-arg truncate">{label().arg}</span>
                </Show>
                <span class="tool-meta">
                    <Show when={p.tool.sandboxed}>
                        <span class="chip tiny" title="Ran in the sandbox">
                            <ShieldCheck size={11} /> sandbox
                        </span>
                    </Show>
                    <Show when={meta()}>
                        <span class="truncate">{meta()}</span>
                    </Show>
                    <Show when={p.tool.diff && p.tool.status === "ok"}>
                        <DiffStat added={p.tool.diff!.added} removed={p.tool.diff!.removed} />
                    </Show>
                    <Show when={p.tool.durationMs !== undefined && p.tool.durationMs >= 1000}>
                        <span class="tool-dur">{duration(p.tool.durationMs!)}</span>
                    </Show>
                    <StatusIcon tool={p.tool} />
                </span>
            </button>
            <Show when={!open() && (p.tool.status === "running") && p.tool.progress}>
                <pre class="activity-tail nested">{stripAnsi(p.tool.progress!).trimEnd().split("\n").slice(-6).join("\n")}</pre>
            </Show>
            <Show when={!open() && p.tool.sub && p.tool.status === "running"}>
                <SubagentPeek tool={p.tool} />
            </Show>
            <Show when={open()}>
                <div class="tool-detail">
                    <ToolDetails tool={p.tool} />
                </div>
            </Show>
        </div>
    );
}

function SubagentPeek(p: { tool: ToolBlock }) {
    return (
        <div class="sub-peek">
            <For each={p.tool.sub!.tools.slice(-3)}>
                {(t) => (
                    <div class="sub-line">
                        <ToolIcon name={t.name} size={12} />
                        <span class="truncate">{t.title}</span>
                    </div>
                )}
            </For>
            <div class="sub-stats">
                {plural(p.tool.sub!.toolCount, "tool use")} · {tokens(p.tool.sub!.tokens)} tokens
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
                    <DiffView diff={t().diff!} maxLines={80} header />
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
                <Match when={t().name === "Task"}>
                    <Show when={t().sub}>
                        <Section label={`${t().sub!.label} · ${plural(t().sub!.toolCount, "tool use")} · ${tokens(t().sub!.tokens)} tokens`}>
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
