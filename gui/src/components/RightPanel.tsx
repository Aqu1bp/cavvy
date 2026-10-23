// The side panel, in the sheet's inspector column: Changes | Plan at the top
// (the folder's changes, each opening the diff reader; the proposed plan and the
// agent's to-do list), what's live under either (background work: sub-agents,
// shells, monitors and delegated tasks; watched pull requests, secrets, MCP
// servers that failed or ask for approval, sub-agents), and Commit and Push at
// the foot. Empty sections aren't drawn.

import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import { ArrowUpLeft, Bot, Check, ChevronRight, ClipboardList, Copy, FileDiff, FolderGit2, FolderOpen, GitBranch, GitBranchPlus, GitCommitHorizontal, GitPullRequestArrow, KeyRound, Map as MapIcon, Plug, Save, SquarePen, X } from "lucide-solid";
import type { AgentRun, ChangesInfo, GitFileDiff, PlanLink } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { activate, app, reportError, rpc, toast } from "../state/app";
import { setCommitRequest, setMcpOpen, setPlanDialog } from "../state/ui";
import { newSession, openAgents, openReview, stopAgent } from "../state/actions";
import { needsAttention, shownName, statusLabel } from "../lib/mcp";
import { commitUnavailable, sessionReadReady, useGitChanges } from "../state/changes";
import { canReveal, copyText, openExternal, os, revealPath } from "../lib/platform";
import { duration, plural, tildify } from "../lib/format";
import { now } from "../lib/clock";
import { CHANGE, dirOf, nameOf, type Change, type InspectorPane } from "../lib/inspector";
import { shortcut } from "../state/keybindings";
import { Menu } from "./ui/Menu";
import { Segmented, Spinner } from "./ui/bits";
import { PublishDialog } from "./PublishDialog";
import { BackgroundTasks } from "./BackgroundTasks";

const live = (a: AgentRun) => a.status === "running" || a.status === "waiting";
const ran = (a: AgentRun) => duration((a.endedAt ?? (live(a) ? now() : a.startedAt)) - a.startedAt);

/** The folder the session works in: its actions, from the header's button (the path on hover). */
function WorkspaceButton(p: { handle: SessionHandle }) {
    let btn: HTMLButtonElement | undefined;
    const [menu, setMenu] = createSignal(false);
    const st = () => p.handle.view.state;
    const close = () => setMenu(false);
    return (
        <>
            <button ref={btn} class="hb" aria-label="Workspace actions" aria-haspopup="menu" aria-expanded={menu()} title={tildify(st().cwd, app.hello?.homeDir)} onClick={() => setMenu(!menu())}>
                <FolderGit2 size={16} />
            </button>
            <Menu label="Workspace actions" open={menu()} anchor={() => btn} onClose={close} align="end" width={244}>
                <div class="menu-head insp-ws" title={tildify(st().cwd, app.hello?.homeDir)}>
                    <span class="truncate">{st().projectName}</span>
                    <Show when={st().branch}>
                        <span class="insp-ws-br truncate" title="Git branch">
                            <GitBranch size={12} />
                            <span class="truncate">{st().branch}</span>
                        </span>
                    </Show>
                </div>
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
        </>
    );
}

/** `pathToken`: the name hides a registered value (GitFileDiff.pathToken): the reader opens it by that. */
type Listed = { path: string; change: Change; added: number; removed: number; kind?: GitFileDiff["kind"]; from?: string; pathToken?: string };

/**
 * What changed in the folder: Git's uncommitted changes, whoever made them, or Harness's own
 * record of its edits outside a repository. The files open the diff reader.
 */
function useFolderChanges(handle: () => SessionHandle) {
    const [git] = useGitChanges(handle);
    // Only asked for outside a repository, where git has nothing to say. On a yes or no, not on
    // git's reply itself: each new reply would otherwise ask again for the same change.
    const notRepo = createMemo(() => git()?.repo === false);
    const [edits] = createResource(
        () => notRepo() && sessionReadReady(handle()) && { id: handle().id, n: handle().view.state.filesChanged, busy: handle().view.state.busy },
        ({ id }) =>
            rpc.call("session.changes", { id }).catch((e): ChangesInfo & { error?: string } => {
                if (sessionReadReady(handle())) reportError(e);
                // Said, not left loading: the pane shows why, and still opens the reader.
                return { files: [], added: 0, removed: 0, tracked: true, error: e instanceof Error ? e.message : String(e) };
            }),
    );
    return createMemo(() => {
        const g = git();
        if (!g) return undefined;
        if (g.repo) {
            const files: Listed[] = g.files.map((f) => ({ path: f.path, change: f.change, added: f.added, removed: f.removed, kind: f.kind, from: f.from, ...(f.pathToken ? { pathToken: f.pathToken } : {}) }));
            return { repo: true, files, count: g.files.length + g.more, more: g.more, atLeast: Boolean(g.moreAtLeast), added: g.added, removed: g.removed, error: g.error };
        }
        const e = edits();
        if (!e) return undefined;
        const files: Listed[] = e.files.map((f) => ({ path: f.path, change: f.status, added: f.added, removed: f.removed }));
        return { repo: false, files, count: files.length, more: 0, atLeast: false, added: e.added, removed: e.removed, error: (e as { error?: string }).error, untracked: e.tracked === false };
    });
}

function FileRow(p: { f: Listed; onOpen: () => void }) {
    const c = () => CHANGE[p.f.change];
    return (
        <button class="file" title={`Review ${p.f.from ? `${p.f.from} → ${p.f.path}` : p.f.path}`} onClick={() => p.onOpen()}>
            <span class={`fs ${p.f.change}`} title={c().label} aria-label={c().label}>
                {c().letter}
            </span>
            <span class="nm">
                <b class="truncate">{nameOf(p.f.path)}</b>
                <Show when={dirOf(p.f.path)}>
                    <span class="truncate">{dirOf(p.f.path)}</span>
                </Show>
            </span>
            <Show when={p.f.added || p.f.removed}>
                <span class="stat">
                    <Show when={p.f.added || !p.f.removed}>
                        <span class="add">+{p.f.added}</span>
                    </Show>
                    <Show when={p.f.removed}>
                        <span class="del">−{p.f.removed}</span>
                    </Show>
                </span>
            </Show>
        </button>
    );
}

/** The Changes pane: the counts, then each file; a file opens the diff reader on it. */
function ChangesPane(p: { changes: ReturnType<ReturnType<typeof useFolderChanges>> }) {
    const c = () => p.changes;
    // Git's uncommitted view, or (outside a repository) Harness's own record.
    const open = (path?: string, token?: string) => openReview(path, c()?.repo === false ? "harness" : "uncommitted", undefined, token);
    return (
        <Show when={c()} fallback={<div class="pane blank" aria-busy="true"><Spinner size={16} /></div>}>
            {(ch) => (
                <Show
                    when={ch().count}
                    fallback={
                        <div class="pane blank">
                            <FileDiff size={22} class="ic" />
                            <Show
                                when={!ch().error}
                                fallback={
                                    <>
                                        <b>Changes unavailable</b>
                                        <span class="selectable">{ch().error}</span>
                                    </>
                                }
                            >
                                <b>No changes yet</b>
                                {ch().repo ? "The working tree matches the last commit." : ch().untracked ? "This session isn't saved yet." : "Files Harness edits in this session show up here."}
                            </Show>
                            <button class="link-btn" onClick={() => open()}>
                                {ch().repo ? "Review the branch or a turn" : "Open the diff reader"}
                            </button>
                        </div>
                    }
                >
                    <div class="pane">
                        <div class="sum">
                            <b class="add">+{ch().added}</b>
                            <b class="del">−{ch().removed}</b>
                            <span class="grow" title={plural(ch().count, "changed file")}>
                                in {ch().count.toLocaleString()}
                                {ch().atLeast ? "+" : ""} {ch().count === 1 ? "file" : "files"}
                            </span>
                            <button class="btn ghost sm" title="Open the diff reader" onClick={() => open()}>
                                Review
                            </button>
                        </div>
                        <For each={ch().files}>{(f) => <FileRow f={f} onOpen={() => open(f.path, f.pathToken)} />}</For>
                        <Show when={ch().more}>
                            <div class="file-more">
                                {ch().more.toLocaleString()}
                                {ch().atLeast ? "+" : ""} more not shown
                            </div>
                        </Show>
                    </div>
                </Show>
            )}
        </Show>
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
    const [info] = createResource(() => menu() && plan()?.id, (toolId) => rpc.call("session.planInfo", { id: p.handle.id, toolId }).catch(() => undefined));
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
                            <Menu label="Plan actions" open={menu()} anchor={() => row} onClose={() => setMenu(false)} width={260}>
                                <button role="menuitem" class="menu-item compact" onClick={() => open("view")}>
                                    <ClipboardList size={14} /> Read the plan
                                </button>
                                <button role="menuitem" class="menu-item compact" disabled={!info()?.git} title={info()?.notGit ?? (info()?.git ? "Implement the plan in a new worktree" : info.loading ? "Checking the repository…" : "Repository information unavailable")} onClick={() => open("worktree")}>
                                    <FolderGit2 size={14} /> Implement in a new worktree…
                                </button>
                                <button role="menuitem" class="menu-item compact" onClick={() => open("save")}>
                                    <Save size={14} /> Save plan…
                                </button>
                                <button
                                    role="menuitem"
                                    class="menu-item compact"
                                    onClick={async () => {
                                        setMenu(false);
                                        const r = await rpc.call("session.planInfo", { id: p.handle.id, toolId: pl().id }).catch(reportError);
                                        if (r && (await copyText(r.plan))) toast("Copied the plan", "success");
                                    }}
                                >
                                    <Copy size={14} /> Copy plan
                                </button>
                            </Menu>
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

function Plan(p: { handle: SessionHandle; heading?: boolean }) {
    const todos = () => p.handle.view.state.todos;
    const done = () => todos().filter((t) => t.status === "completed").length;
    return (
        <Show when={todos().length}>
            <div class="sec plan">
                <Show when={p.heading}>
                    <div class="sh">
                        Steps · {done()} of {todos().length}
                    </div>
                </Show>
                <ul aria-label={`Plan: ${done()} of ${todos().length} done`}>
                    <For each={todos()}>
                        {(t) => (
                            <li class={t.status === "completed" ? "done" : t.status === "in_progress" ? "now" : ""} title={t.content}>
                                <span class="box" aria-label={t.status === "completed" ? "Done" : t.status === "in_progress" ? "In progress" : "To do"}>
                                    <Show when={t.status === "completed"}>
                                        <Check size={11} stroke-width={3} />
                                    </Show>
                                </span>
                                <span class="selectable">{t.status === "in_progress" ? (t.activeForm ?? t.content) : t.content}</span>
                            </li>
                        )}
                    </For>
                </ul>
            </div>
        </Show>
    );
}

/** Pull requests the agent watches: it's woken when checks fail or someone comments. */
function Watches(p: { handle: SessionHandle }) {
    // Monitors have their own section (time left, from the shell list).
    const watches = () => (p.handle.view.state.watches ?? []).filter((w) => w.kind !== "monitor");
    const tone = (detail?: string) => (/failing|conflicts|can't reach/.test(detail ?? "") ? "tone-err" : /passed/.test(detail ?? "") ? "tone-ok" : "");
    return (
        <Show when={watches().length}>
            <div class="sec">
                <div class="sh">Watching</div>
                <For each={watches()}>
                    {(w) => (
                        <div class="prow swap" title={`${w.label}${w.detail ? ` · ${w.detail}` : ""}. The agent is woken when there's news.`}>
                            <GitPullRequestArrow size={16} class="watch-live" />
                            <Show when={w.url} fallback={<span class="truncate grow">{w.label.replace(/ in \S+$/, "")}</span>}>
                                <button class="link-btn truncate grow watch-link" onClick={() => void openExternal(w.url!)}>
                                    {w.label.replace(/ in \S+$/, "")}
                                </button>
                            </Show>
                            <span class={`meta ${tone(w.detail)}`}>{w.detail}</span>
                            <button class="act hb sm" title="Stop watching" aria-label={`Stop watching ${w.label}`} onClick={() => void rpc.call("session.stopWatch", { id: p.handle.id, watchId: w.id }).catch(reportError)}>
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
                                <div class="panel-error selectable">{m.error}</div>
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
            <div class={`prow ${stoppable() ? "swap" : ""} agent-row`} style={depth() ? { "padding-left": `calc(${10 + Math.min(depth(), 4) * 16} * var(--sp))` } : undefined}>
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
    // While the pointer is over the list, the agents in "Previous agents" stay the ones that were
    // there: one that finishes (even one that started meanwhile) keeps its row rather than sliding
    // another under a click. The order catches up on leave.
    const [held, setHeld] = createSignal<ReadonlySet<string>>();
    const listed = (a: AgentRun) => {
        const before = held();
        return before ? !before.has(a.id) : live(a);
    };
    const current = createMemo(() => top().filter(listed));
    const previous = createMemo(() => top().filter((a) => !listed(a)).reverse());
    /** It and the ones under it. */
    const withOwn = (a: AgentRun, depth = 0): AgentRun[] => [a, ...(depth < 8 ? agents().filter((x) => x.parentId === a.id).flatMap((x) => withOwn(x, depth + 1)) : [])];
    const failed = () => previous().flatMap((a) => withOwn(a)).filter((a) => a.status === "failed").length;
    const running = () => agents().filter(live).length;
    const waiting = () => agents().filter((a) => a.status === "waiting").length;
    return (
        <Show when={agents().length}>
            <div class="sec" onPointerEnter={() => setHeld(new Set(top().filter((a) => !live(a)).map((a) => a.id)))} onPointerLeave={() => setHeld(undefined)}>
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

/** Which pane the side panel shows; kept while the app runs, like the reader's layout. */
const [pane, setPane] = createSignal<InspectorPane>("changes");

/** Commit and push, at the panel's foot (the diff reader has its own, for the files checked there). */
function PanelFoot(p: { handle: SessionHandle; changes: ReturnType<ReturnType<typeof useFolderChanges>> }) {
    const [publish, setPublish] = createSignal<string>();
    createEffect(on(() => p.handle.id, () => setPublish(undefined)));
    const paths = () => (p.changes?.files ?? []).filter((f) => f.kind !== "folder" && f.kind !== "repo").map((f) => f.path);
    const commitOff = () => commitUnavailable(p.handle) ?? (p.changes?.error ? "Refresh the changes before committing." : !paths().length ? "Nothing to commit." : undefined);
    return (
        <Show when={p.changes?.repo}>
            <div class="insp-foot">
                <span class="grow" title={commitOff() ?? "Commit the changed files"}>
                    <button class="btn ghost" disabled={Boolean(commitOff())} onClick={() => setCommitRequest({ id: p.handle.id, paths: paths() })}>
                        <GitCommitHorizontal size={14} /> Commit…
                    </button>
                </span>
                <span class="grow" title={commitUnavailable(p.handle)?.replace(/committing/g, "pushing") ?? "Push the branch, and open a pull request"}>
                    <button class="btn primary" disabled={Boolean(commitUnavailable(p.handle))} onClick={() => setPublish(p.handle.id)}>
                        <GitPullRequestArrow size={14} /> Push…
                    </button>
                </span>
            </div>
            <PublishDialog id={publish()} onClose={() => setPublish(undefined)} onPublished={() => {}} />
        </Show>
    );
}

export function RightPanel(p: { handle: SessionHandle }) {
    const changes = useFolderChanges(() => p.handle);
    const st = () => p.handle.view.state;
    const todos = () => st().todos;
    const hasPlan = () => Boolean(st().plan || st().planLinks?.length);
    const planWaits = () => st().interactions.some((i) => i.kind === "plan");
    const cycle = () => {
        const k = shortcut("chat:cycleMode");
        return k && (os === "macos" ? k.replaceAll("+", "") : k);
    };
    return (
        <aside class="panel" aria-label="Session details">
            <div class="insp-h">
                <Segmented
                    label="Side panel"
                    value={pane()}
                    onChange={setPane}
                    options={[
                        {
                            value: "changes",
                            label: (
                                <>
                                    Changes
                                    <Show when={changes()?.count}>
                                        <span class="ct">
                                            {changes()!.count.toLocaleString()}
                                            {changes()!.atLeast ? "+" : ""}
                                        </span>
                                    </Show>
                                </>
                            ),
                        },
                        {
                            value: "plan",
                            label: (
                                <>
                                    Plan
                                    <Show when={todos().length}>
                                        <span class="ct">
                                            {todos().filter((t) => t.status === "completed").length}/{todos().length}
                                        </span>
                                    </Show>
                                    <Show when={planWaits()}>
                                        <span class="ct-dot" title="The plan needs you" />
                                    </Show>
                                </>
                            ),
                            title: planWaits() ? "The plan is waiting for your answer" : undefined,
                        },
                    ]}
                />
                <WorkspaceButton handle={p.handle} />
            </div>
            <div class="insp-body panel-scroll">
                <Show when={pane() === "plan"} fallback={<ChangesPane changes={changes()} />}>
                    <Show
                        when={hasPlan() || todos().length}
                        fallback={
                            <div class="pane blank">
                                <MapIcon size={22} class="ic" />
                                <b>No plan yet</b>
                                Switch to Plan mode{cycle() ? ` (${cycle()})` : ""} and the agent lays out the steps before changing anything. Its to-do list shows here as it works.
                            </div>
                        }
                    >
                        <div class="pane">
                            <ProposedPlan handle={p.handle} />
                            <Plan handle={p.handle} heading={hasPlan()} />
                        </div>
                    </Show>
                </Show>
                {/* What's live, whichever pane is showing. */}
                <div class="insp-live">
                    <BackgroundTasks handle={p.handle} />
                    <Watches handle={p.handle} />
                    <Secrets handle={p.handle} />
                    <Mcp handle={p.handle} />
                    <Lineage handle={p.handle} />
                </div>
            </div>
            <PanelFoot handle={p.handle} changes={changes()} />
        </aside>
    );
}
