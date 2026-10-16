// The session's side card: where it works (folder, branch, changes), and
// only what's live besides: the plan it proposed (and where a plan went or
// came from), its todo list, running shells, MCP servers that failed, and its
// sub-agents. Sections with nothing to say aren't drawn.

import { createMemo, createSignal, For, Show } from "solid-js";
import { ArrowUpLeft, Bot, ChevronDown, ChevronRight, Circle, CircleCheck, CircleDashed, ClipboardList, Copy, FileDiff, FolderGit2, FolderOpen, GitBranch, GitBranchPlus, Plug, Save, SquarePen, Terminal, X } from "lucide-solid";
import type { AgentRun, PlanLink } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { activate, app, reportError, rpc, toast } from "../state/app";
import { setPlanDialog } from "../state/ui";
import { newSession, openAgents, openReview, stopAgent } from "../state/actions";
import { useChanges } from "../state/changes";
import { canReveal, copyText, revealPath } from "../lib/platform";
import { duration, tildify } from "../lib/format";
import { now } from "../lib/clock";
import { Popover } from "./ui/Popover";

const live = (a: AgentRun) => a.status === "running" || a.status === "waiting";
const ran = (a: AgentRun) => duration((a.endedAt ?? (live(a) ? now() : a.startedAt)) - a.startedAt);

function Workspace(p: { handle: SessionHandle }) {
    let row: HTMLButtonElement | undefined;
    const [menu, setMenu] = createSignal(false);
    const st = () => p.handle.view.state;
    const [changes] = useChanges(() => p.handle);
    const close = () => setMenu(false);
    return (
        <div class="sec">
            <button ref={row} class="prow" aria-haspopup="menu" aria-expanded={menu()} title={tildify(st().cwd, app.hello?.homeDir)} onClick={() => setMenu(!menu())}>
                <FolderGit2 size={16} />
                <span class="truncate grow">{st().projectName}</span>
                <span class="cell" aria-hidden="true">
                    <ChevronDown size={16} />
                </span>
            </button>
            <Popover open={menu()} anchor={() => row} onClose={close} width={232}>
                <Show when={canReveal}>
                    <button class="menu-item compact" onClick={() => (close(), void revealPath(st().cwd).catch(reportError))}>
                        <FolderOpen size={14} /> Reveal in Finder
                    </button>
                </Show>
                <button class="menu-item compact" onClick={async () => (close(), (await copyText(st().cwd)) && toast(`Copied ${tildify(st().cwd, app.hello?.homeDir)}`, "success"))}>
                    <Copy size={14} /> Copy folder path
                </button>
                <button class="menu-item compact" onClick={() => (close(), newSession(st().cwd))}>
                    <SquarePen size={14} /> New session in {st().projectName}
                </button>
            </Popover>
            <Show when={st().branch}>
                <span class="prow lock" title="Git branch">
                    <GitBranch size={16} />
                    <span class="truncate">{st().branch}</span>
                </span>
            </Show>
            <button class="prow" title="Review changes" onClick={() => openReview()}>
                <FileDiff size={16} />
                <span class="grow">Changes</span>
                <Show when={changes()?.files.length} fallback={<span class="meta">{changes.loading && !changes() ? "" : "None yet"}</span>}>
                    <span class="stat">
                        <span class="add">+{changes()!.added}</span>
                        <span class="del">−{changes()!.removed}</span>
                    </span>
                </Show>
            </button>
        </div>
    );
}

/**
 * The plan the session presented last, after its card is gone too, with what
 * can be done with it; and the links a plan taken to a worktree leaves in
 * both sessions. (The todo list below is the agent's own progress.)
 */
function ProposedPlan(p: { handle: SessionHandle }) {
    let row: HTMLButtonElement | undefined;
    const [menu, setMenu] = createSignal(false);
    const st = () => p.handle.view.state;
    const plan = () => st().plan;
    const waiting = () => st().interactions.some((i) => i.kind === "plan");
    const links = () => st().planLinks ?? [];
    const open = (kind: "view" | "save" | "worktree") => {
        setMenu(false);
        setPlanDialog({ kind, sessionId: p.handle.id, planId: plan()?.id });
    };
    const titleOf = (l: PlanLink) => app.sessions.find((s) => s.id === l.session)?.title ?? app.archived.find((s) => s.id === l.session)?.title;
    return (
        <Show when={plan() || links().length}>
            <div class="sec">
                <div class="sh">Proposed plan</div>
                <Show when={plan()}>
                    {(pl) => (
                        <>
                            <button ref={row} class="prow" aria-haspopup="menu" aria-expanded={menu()} title="Read, save or implement the plan" onClick={() => setMenu(!menu())}>
                                <ClipboardList size={16} />
                                <span class="truncate grow">{pl().title}</span>
                                <span class={`meta ${waiting() ? "tone-warn" : ""}`}>{waiting() ? "Needs you" : ""}</span>
                            </button>
                            <Popover open={menu()} anchor={() => row} onClose={() => setMenu(false)} width={260}>
                                <button class="menu-item compact" onClick={() => open("view")}>
                                    <ClipboardList size={14} /> Read the plan
                                </button>
                                <button class="menu-item compact" onClick={() => open("worktree")}>
                                    <FolderGit2 size={14} /> Implement in a new worktree…
                                </button>
                                <button class="menu-item compact" onClick={() => open("save")}>
                                    <Save size={14} /> Save plan…
                                </button>
                                <button
                                    class="menu-item compact"
                                    onClick={async () => {
                                        setMenu(false);
                                        const r = await rpc.call("session.planInfo", { id: p.handle.id, toolId: pl().id }).catch(reportError);
                                        if (r && (await copyText(r.plan))) toast("Copied the plan", "success");
                                    }}
                                >
                                    <Copy size={14} /> Copy plan
                                </button>
                            </Popover>
                        </>
                    )}
                </Show>
                <For each={links()}>
                    {(l) => (
                        <button class="prow" title={`${l.role === "to" ? "Implemented" : "Planned"}: ${tildify(l.path, app.hello?.homeDir)} on ${l.branch}${l.base ? `, from ${l.base}` : ""}. Open that session.`} onClick={() => void activate(l.session)}>
                            <Show when={l.role === "to"} fallback={<ArrowUpLeft size={16} />}>
                                <GitBranchPlus size={16} />
                            </Show>
                            <span class="truncate grow">{l.role === "to" ? `Implementing on ${l.branch}` : `Plan from “${titleOf(l) ?? l.title ?? "another session"}”`}</span>
                            <span class="meta">{l.role === "to" ? "Open" : ""}</span>
                        </button>
                    )}
                </For>
            </div>
        </Show>
    );
}

function Plan(p: { handle: SessionHandle }) {
    const todos = () => p.handle.view.state.todos;
    const done = () => todos().filter((t) => t.status === "completed").length;
    return (
        <Show when={todos().length}>
            <div class="sec">
                <div class="sh">
                    Plan · {done()} of {todos().length}
                </div>
                <For each={todos()}>
                    {(t) => (
                        <span class={`prow lock ${t.status === "completed" ? "done" : t.status === "in_progress" ? "now" : ""}`}>
                            <Show when={t.status === "completed"} fallback={<Show when={t.status === "in_progress"} fallback={<Circle size={16} class="todo-pending" />}><CircleDashed size={16} class="todo-now" /></Show>}>
                                <CircleCheck size={16} class="todo-done" />
                            </Show>
                            <span class="truncate" title={t.content}>
                                {t.status === "in_progress" ? (t.activeForm ?? t.content) : t.content}
                            </span>
                        </span>
                    )}
                </For>
            </div>
        </Show>
    );
}

function Shells(p: { handle: SessionHandle }) {
    const running = () => p.handle.view.state.shells.filter((s) => s.running);
    return (
        <Show when={running().length}>
            <div class="sec">
                <div class="sh">Shells</div>
                <For each={running()}>
                    {(sh) => (
                        <div class="prow swap" title={sh.command}>
                            <Terminal size={16} class="shell-live" />
                            <span class="mono truncate grow shell-cmd">{sh.command}</span>
                            <span class="meta">{duration(now() - sh.startedAt)}</span>
                            <button class="act hb sm" title="Stop" aria-label="Stop shell" onClick={() => void rpc.call("session.killShell", { id: p.handle.id, shellId: sh.id }).catch(reportError)}>
                                <X size={14} />
                            </button>
                        </div>
                    )}
                </For>
            </div>
        </Show>
    );
}

/** Healthy servers stay out of the way; one that failed shows with why. */
function Mcp(p: { handle: SessionHandle }) {
    const broken = () => p.handle.view.state.mcp.filter((m) => m.status === "failed" || m.status === "needs-approval");
    return (
        <Show when={broken().length}>
            <div class="sec">
                <div class="sh">MCP</div>
                <For each={broken()}>
                    {(m) => (
                        <>
                            <span class="prow lock" title={m.error}>
                                <Plug size={16} />
                                <span class="truncate grow">{m.name}</span>
                                <span class={`meta ${m.status === "failed" ? "tone-err" : "tone-warn"}`}>{m.status === "failed" ? "Failed" : "Needs approval"}</span>
                            </span>
                            <Show when={m.error}>
                                <div class="panel-error">{m.error}</div>
                            </Show>
                        </>
                    )}
                </For>
            </div>
        </Show>
    );
}

function AgentRow(p: { handle: SessionHandle; a: AgentRun }) {
    const waiting = () => p.a.status === "waiting";
    const stoppable = () => live(p.a) && Boolean(p.a.taskId);
    return (
        <div class={`prow ${stoppable() ? "swap" : ""} agent-row`}>
            <button class="agent-hit" onClick={() => openAgents(p.a.id)} title={waiting() ? "It's asking you something in the composer" : p.a.description} aria-label={p.a.description || "Sub-agent"} />
            <span class="lic">
                <Bot size={16} />
                <span class={`nd st-${p.a.status}`} />
            </span>
            <span class="lt truncate grow">{p.a.description || "Sub-agent"}</span>
            <span class={`meta ${waiting() ? "tone-warn" : p.a.status === "failed" ? "tone-err" : ""}`}>{waiting() ? "Needs you" : p.a.status === "failed" ? "Failed" : p.a.status === "stopped" ? "Stopped" : ran(p.a)}</span>
            <Show when={stoppable()}>
                <button class="act hb sm stop" title="Stop sub-agent" aria-label="Stop sub-agent" onClick={() => void stopAgent(p.handle.id, p.a.id)}>
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                        <rect x="1" y="1" width="8" height="8" rx="2" fill="currentColor" />
                    </svg>
                </button>
            </Show>
        </div>
    );
}

/** The sub-agents: live ones on top, finished ones folded away. */
function Lineage(p: { handle: SessionHandle }) {
    const [showPrev, setShowPrev] = createSignal(false);
    const agents = () => p.handle.view.agents;
    const current = createMemo(() => agents().filter(live));
    const previous = createMemo(() => agents().filter((a) => !live(a)).reverse());
    const failed = () => previous().filter((a) => a.status === "failed").length;
    const waiting = () => current().filter((a) => a.status === "waiting").length;
    return (
        <Show when={agents().length}>
            <div class="sec">
                <div class="sh">
                    Lineage
                    <Show when={current().length}>· {waiting() ? `${waiting()} needs you` : `${current().length} running`}</Show>
                </div>
                <For each={current()}>{(a) => <AgentRow handle={p.handle} a={a} />}</For>
                <Show when={previous().length}>
                    <Show when={current().length || previous().length > 3} fallback={<For each={previous()}>{(a) => <AgentRow handle={p.handle} a={a} />}</For>}>
                        <button class="divi" aria-expanded={showPrev()} onClick={() => setShowPrev(!showPrev())}>
                            <span>Previous agents{showPrev() ? "" : ` (${previous().length})`}</span>
                            <i />
                            <Show when={failed()}>
                                <span class="tone-err divi-tag">{failed()} failed</span>
                            </Show>
                            <ChevronRight size={14} class="chev" />
                        </button>
                        <Show when={showPrev()}>
                            <For each={previous()}>{(a) => <AgentRow handle={p.handle} a={a} />}</For>
                        </Show>
                    </Show>
                </Show>
            </div>
        </Show>
    );
}

export function RightPanel(p: { handle: SessionHandle }) {
    return (
        <aside class="panel" aria-label="Session details">
            <div class="panel-scroll">
                <Workspace handle={p.handle} />
                <ProposedPlan handle={p.handle} />
                <Plan handle={p.handle} />
                <Shells handle={p.handle} />
                <Mcp handle={p.handle} />
                <Lineage handle={p.handle} />
            </div>
        </aside>
    );
}
