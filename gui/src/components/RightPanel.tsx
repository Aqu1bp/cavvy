// The session's side card: where it works (folder, branch, changes), and
// only what's live besides: the plan, running shells, secrets it holds, MCP servers
// that failed or ask for approval, and its sub-agents. Empty sections aren't drawn.

import { createMemo, createSignal, For, Show } from "solid-js";
import { Bot, ChevronDown, ChevronRight, Circle, CircleCheck, CircleDashed, Copy, FileDiff, FolderGit2, FolderOpen, GitBranch, KeyRound, Plug, SquarePen, Terminal, X } from "lucide-solid";
import type { AgentRun } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { app, reportError, rpc, toast } from "../state/app";
import { newSession, openAgents, openReview, stopAgent } from "../state/actions";
import { setMcpOpen } from "../state/ui";
import { needsAttention, shownName, statusLabel } from "../lib/mcp";
import { useChanges, useGitChanges } from "../state/changes";
import { canReveal, copyText, revealPath } from "../lib/platform";
import { duration, plural, tildify } from "../lib/format";
import { now } from "../lib/clock";
import { Menu } from "./ui/Menu";

const live = (a: AgentRun) => a.status === "running" || a.status === "waiting";
const ran = (a: AgentRun) => duration((a.endedAt ?? (live(a) ? now() : a.startedAt)) - a.startedAt);

function Workspace(p: { handle: SessionHandle }) {
    let row: HTMLButtonElement | undefined;
    const [menu, setMenu] = createSignal(false);
    const st = () => p.handle.view.state;
    // Git's count of what changed in the folder; Harness's own record outside a repository.
    const [git] = useGitChanges(() => p.handle);
    const [edits] = useChanges(() => p.handle);
    const changes = () => {
        const g = git();
        if (!g) return undefined;
        if (g.repo) return { files: g.files.length + g.more, atLeast: g.moreAtLeast, added: g.added, removed: g.removed, error: g.error };
        const e = edits();
        return e && { files: e.files.length, atLeast: false, added: e.added, removed: e.removed, error: undefined };
    };
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
            <Menu label="Workspace actions" open={menu()} anchor={() => row} onClose={close} width={232}>
                <Show when={canReveal}>
                    <button role="menuitem" class="menu-item compact" onClick={() => (close(), void revealPath(st().cwd).catch(reportError))}>
                        <FolderOpen size={14} /> Reveal in Finder
                    </button>
                </Show>
                <button role="menuitem" class="menu-item compact" onClick={async () => (close(), (await copyText(st().cwd)) && toast(`Copied ${tildify(st().cwd, app.hello?.homeDir)}`, "success"))}>
                    <Copy size={14} /> Copy folder path
                </button>
                <button role="menuitem" class="menu-item compact" onClick={() => (close(), newSession(st().cwd))}>
                    <SquarePen size={14} /> New session in {st().projectName}
                </button>
                <button role="menuitem" class="menu-item compact" onClick={() => (close(), setMcpOpen({}))}>
                    <Plug size={14} /> MCP servers
                </button>
            </Menu>
            <Show when={st().branch}>
                <span class="prow lock" title="Git branch">
                    <GitBranch size={16} />
                    <span class="truncate">{st().branch}</span>
                </span>
            </Show>
            <button class="prow" title="Review changes" onClick={() => openReview()}>
                <FileDiff size={16} />
                <span class="grow">Changes</span>
                <Show when={changes()?.files} fallback={<span class="meta" title={changes()?.error}>{changes()?.error ? "Unavailable" : changes() ? "None yet" : ""}</span>}>
                    <span class="meta" title={plural(changes()!.files, "changed file")}>
                        {changes()!.files}
                        {changes()!.atLeast ? "+" : ""}
                    </span>
                    <span class="stat">
                        <span class="add">+{changes()!.added}</span>
                        <span class="del">−{changes()!.removed}</span>
                    </span>
                </Show>
            </button>
        </div>
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

/** The secrets the user gave this session, by name: its shell commands see them until forgotten or the session closes. */
function Secrets(p: { handle: SessionHandle }) {
    const names = () => p.handle.view.state.secrets ?? [];
    return (
        <Show when={names().length}>
            <div class="sec">
                <div class="sh">Secrets</div>
                <For each={names()}>
                    {(name) => (
                        <div class="prow swap" title={`New shell commands in this session see $${name}`}>
                            <KeyRound size={16} />
                            <span class="mono truncate grow">{name}</span>
                            <button class="act hb sm" title="Forget" aria-label={`Forget ${name}`} onClick={() => void rpc.call("session.forgetSecret", { id: p.handle.id, name }).catch(reportError)}>
                                <X size={14} />
                            </button>
                        </div>
                    )}
                </For>
            </div>
        </Show>
    );
}

/** Healthy servers stay out of the way; one that failed or asks for approval shows, and opens the full list. */
function Mcp(p: { handle: SessionHandle }) {
    const flagged = () => p.handle.view.state.mcp.filter(needsAttention);
    return (
        <Show when={flagged().length}>
            <div class="sec">
                <div class="sh">MCP</div>
                <For each={flagged()}>
                    {(m) => (
                        <>
                            <button class="prow" title={m.status === "failed" ? m.error : "Review what it runs"} onClick={() => setMcpOpen({ focus: m.name })}>
                                <Plug size={16} />
                                <span class="truncate grow">{shownName(m.name)}</span>
                                <span class={`meta tone-${statusLabel(m).tone}`}>{statusLabel(m).text}</span>
                            </button>
                            <Show when={m.error}>
                                <div class="panel-error">{m.error}</div>
                            </Show>
                        </>
                    )}
                </For>
                <button class="prow" onClick={() => setMcpOpen({})}>
                    <span class="mcp-spacer" aria-hidden="true" />
                    <span class="grow meta">All MCP servers</span>
                    <ChevronRight size={14} />
                </button>
            </div>
        </Show>
    );
}

function AgentRow(p: { handle: SessionHandle; a: AgentRun; depth?: number }) {
    const waiting = () => p.a.status === "waiting";
    const stoppable = () => live(p.a) && Boolean(p.a.taskId);
    // Its own sub-agents (a delegated Codex task's) are under it, a step in.
    const own = () => ((p.depth ?? 0) < 8 ? p.handle.view.agents.filter((x) => x.parentId === p.a.id) : []);
    const depth = () => p.depth ?? 0;
    return (
        <>
            <div class={`prow ${stoppable() ? "swap" : ""} agent-row`} style={depth() ? { "padding-left": `${10 + Math.min(depth(), 4) * 16}px` } : undefined}>
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
            <For each={own()}>{(x) => <AgentRow handle={p.handle} a={x} depth={depth() + 1} />}</For>
        </>
    );
}

/** The sub-agents: live ones on top, finished ones folded away. */
function Lineage(p: { handle: SessionHandle }) {
    const [showPrev, setShowPrev] = createSignal(false);
    const agents = () => p.handle.view.agents;
    // A sub-agent's own are listed under it; the counts take in every one.
    const top = createMemo(() => agents().filter((a) => !a.parentId || !agents().some((x) => x.id === a.parentId)));
    const current = createMemo(() => top().filter(live));
    const previous = createMemo(() => top().filter((a) => !live(a)).reverse());
    /** It and the ones under it. */
    const withOwn = (a: AgentRun, depth = 0): AgentRun[] => [a, ...(depth < 8 ? agents().filter((x) => x.parentId === a.id).flatMap((x) => withOwn(x, depth + 1)) : [])];
    const failed = () => previous().flatMap((a) => withOwn(a)).filter((a) => a.status === "failed").length;
    const running = () => agents().filter(live).length;
    const waiting = () => agents().filter((a) => a.status === "waiting").length;
    return (
        <Show when={agents().length}>
            <div class="sec">
                <div class="sh">
                    Lineage
                    <Show when={running()}>· {waiting() ? `${waiting()} needs you` : `${running()} running`}</Show>
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
                <Plan handle={p.handle} />
                <Shells handle={p.handle} />
                <Secrets handle={p.handle} />
                <Mcp handle={p.handle} />
                <Lineage handle={p.handle} />
            </div>
        </aside>
    );
}
