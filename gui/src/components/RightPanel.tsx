// The side panel, in the sheet's inspector column: Changes | Plan | Agents |
// Commands at the top. Changes: the folder's changes, each opening the diff
// reader, with Commit and Push at the foot. Plan: the proposed plan and the
// agent's to-do list. Agents: every sub-agent once (a background one's task and
// its run are one row), and tasks given to other models. Commands: background
// shells and monitors, watched pull requests, and the session's secrets and MCP
// servers that failed or ask for approval. Empty sections aren't drawn.

import { createEffect, createMemo, createResource, createSignal, For, Match, on, Show, Switch } from "solid-js";
import { ArrowUpLeft, Bot, Check, ClipboardList, Copy, FileDiff, FolderGit2, FolderOpen, GitBranch, GitBranchPlus, GitCommitHorizontal, GitPullRequestArrow, KeyRound, Map as MapIcon, Plug, Save, SquarePen, Terminal, X } from "lucide-solid";
import type { ChangesInfo, GitFileDiff, PlanLink } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { activate, app, reportError, rpc, toast } from "../state/app";
import { inspectorPane, setCommitRequest, setInspectorPane, setMcpOpen, setPlanDialog } from "../state/ui";
import { newSession, openReview } from "../state/actions";
import { needsAttention, shownName, statusLabel } from "../lib/mcp";
import { commitUnavailable, sessionReadReady, useGitChanges } from "../state/changes";
import { canReveal, copyText, openExternal, os, revealPath } from "../lib/platform";
import { tildify } from "../lib/format";
import { agentRows, backgroundOf, commandRows, rowLive, type WorkRow } from "../lib/background";
import { CHANGE, dirOf, nameOf, type Change } from "../lib/inspector";
import { shortcut } from "../state/keybindings";
import { Menu } from "./ui/Menu";
import { Segmented, Spinner } from "./ui/bits";
import { PublishDialog } from "./PublishDialog";
import { uncleared, WorkList } from "./BackgroundTasks";

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
        <button class="file" title={p.f.from ? `${p.f.from} → ${p.f.path}` : undefined} onClick={() => p.onOpen()}>
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
        <Show when={c()} fallback={<div class="blank" aria-busy="true"><Spinner size={16} /></div>}>
            {(ch) => (
                <Show
                    when={ch().count}
                    fallback={
                        <div class="blank">
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
                    <div>
                        <div class="sum">
                            <b class="add">+{ch().added}</b>
                            <b class="del">−{ch().removed}</b>
                            <span class="grow">
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

/** Pull requests the agent watches: it's woken when checks fail or someone comments. A click opens the pull request. */
function Watches(p: { handle: SessionHandle }) {
    // Monitors are commands of their own (time left, from the shell list).
    const watches = () => (p.handle.view.state.watches ?? []).filter((w) => w.kind !== "monitor");
    const tone = (detail?: string) => (/failing|conflicts|can't reach/.test(detail ?? "") ? "tone-err" : /passed/.test(detail ?? "") ? "tone-ok" : "");
    return (
        <Show when={watches().length}>
            <div class="grp">
                <div class="sh">Watching</div>
                <For each={watches()}>
                    {(w) => (
                        <div class={`task swap ${w.url ? "click" : ""}`}>
                            <Show when={w.url}>{(url) => <button class="task-hit" aria-label={`Open ${w.label}`} onClick={() => void openExternal(url())} />}</Show>
                            <span class="ki watch">
                                <GitPullRequestArrow size={14} />
                            </span>
                            <span class="tx">
                                <b>{w.label.replace(/ in \S+$/, "")}</b>
                                <span>Wakes the agent on news</span>
                            </span>
                            <span class={`meta ${tone(w.detail)}`}>{w.detail}</span>
                            <button class="act" title="Stop watching" aria-label={`Stop watching ${w.label}`} onClick={() => void rpc.call("session.stopWatch", { id: p.handle.id, watchId: w.id }).catch(reportError)}>
                                <X size={14} />
                            </button>
                        </div>
                    )}
                </For>
            </div>
        </Show>
    );
}

/**
 * The session's own: the secrets the user gave it, by name (its shell commands see them until forgotten or the
 * session closes), and MCP servers that failed or ask for approval (healthy ones stay out of the way). A server
 * opens the MCP list on it.
 */
function SessionGroup(p: { handle: SessionHandle }) {
    const names = () => p.handle.view.state.secrets ?? [];
    const flagged = () => p.handle.view.state.mcp.filter(needsAttention);
    return (
        <Show when={names().length || flagged().length}>
            <div class="grp">
                <div class="sh">Session</div>
                <For each={names()}>
                    {(name) => (
                        <div class="task swap">
                            <span class="ki">
                                <KeyRound size={14} />
                            </span>
                            <span class="tx">
                                <b class="mono">{name}</b>
                                <span>New shell commands see ${name}</span>
                            </span>
                            <span class="meta" />
                            <button class="act" title="Forget" aria-label={`Forget ${name}`} onClick={() => void rpc.call("session.forgetSecret", { id: p.handle.id, name }).catch(reportError)}>
                                <X size={14} />
                            </button>
                        </div>
                    )}
                </For>
                <For each={flagged()}>
                    {(m) => (
                        <div class="task click">
                            <button class="task-hit" aria-label={`MCP server ${shownName(m.name)}: ${statusLabel(m).text}`} onClick={() => setMcpOpen({ focus: m.name })} />
                            <span class="ki">
                                <Plug size={14} />
                                <span class={`nd ${m.status === "failed" ? "st-failed" : "st-waiting"}`} />
                            </span>
                            <span class="tx">
                                <b>{shownName(m.name)}</b>
                                <Show when={m.error} fallback={<span>Review what it runs</span>}>
                                    <span class="err selectable">{m.error}</span>
                                </Show>
                            </span>
                            <span class={`meta tone-${statusLabel(m).tone}`}>{statusLabel(m).text}</span>
                        </div>
                    )}
                </For>
            </div>
        </Show>
    );
}

/** The Agents tab: every sub-agent once, and tasks given to other models. */
function AgentsPane(p: { handle: SessionHandle; rows: WorkRow[] }) {
    return (
        <Show
            when={p.rows.length}
            fallback={
                <div class="blank">
                    <Bot size={22} class="ic" />
                    <b>No agents yet</b>
                    Sub-agents, and tasks given to other models, show up here while they run, with what each is doing.
                </div>
            }
        >
            <WorkList handle={p.handle} tab="agents" rows={p.rows} />
        </Show>
    );
}

/** The Commands tab: background shells and monitors, then watched pull requests, then the session's own. */
function CommandsPane(p: { handle: SessionHandle; rows: WorkRow[] }) {
    const st = () => p.handle.view.state;
    const any = () => p.rows.length || (st().watches ?? []).some((w) => w.kind !== "monitor") || (st().secrets ?? []).length || st().mcp.some(needsAttention);
    return (
        <Show
            when={any()}
            fallback={
                <div class="blank">
                    <Terminal size={22} class="ic" />
                    <b>No background commands</b>
                    Shells and monitors the agent leaves running show up here, with how long each has run.
                </div>
            }
        >
            <WorkList handle={p.handle} tab="commands" rows={p.rows} />
            <Watches handle={p.handle} />
            <SessionGroup handle={p.handle} />
        </Show>
    );
}

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
    const tasks = createMemo(() => backgroundOf(st()));
    const agents = createMemo(() => uncleared(p.handle.id, agentRows(tasks(), p.handle.view.agents)));
    const commands = createMemo(() => uncleared(p.handle.id, commandRows(tasks())));
    const running = (rows: readonly WorkRow[]) => rows.filter(rowLive).length;
    const asks = () => agents().some((r) => r.status === "waiting");
    return (
        <aside class="panel" aria-label="Session details">
            <div class="insp-h">
                <Segmented
                    label="Side panel"
                    value={inspectorPane()}
                    onChange={setInspectorPane}
                    options={[
                        {
                            value: "changes",
                            label: (
                                <>
                                    Changes
                                    <Show when={changes()?.count}>
                                        <span class="ct files">
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
                        {
                            value: "agents",
                            // A tab's count is what runs in it now, in the accent.
                            label: (
                                <>
                                    Agents
                                    <Show when={running(agents())}>
                                        <span class="ct live">{running(agents())}</span>
                                    </Show>
                                    <Show when={asks()}>
                                        <span class="ct-dot" title="A sub-agent needs you" />
                                    </Show>
                                </>
                            ),
                        },
                        {
                            value: "commands",
                            label: (
                                <>
                                    Commands
                                    <Show when={running(commands())}>
                                        <span class="ct live">{running(commands())}</span>
                                    </Show>
                                </>
                            ),
                        },
                    ]}
                />
                <WorkspaceButton handle={p.handle} />
            </div>
            <div class="insp-body panel-scroll">
                {/* A pane is made when its tab is chosen, and fades in then: not when what's in it changes. */}
                <Switch>
                    <Match when={inspectorPane() === "agents"}>
                        <div class="pane">
                            <AgentsPane handle={p.handle} rows={agents()} />
                        </div>
                    </Match>
                    <Match when={inspectorPane() === "commands"}>
                        <div class="pane">
                            <CommandsPane handle={p.handle} rows={commands()} />
                        </div>
                    </Match>
                    <Match when={inspectorPane() === "plan"}>
                        <div class="pane">
                            <Show
                                when={hasPlan() || todos().length}
                                fallback={
                                    <div class="blank">
                                        <MapIcon size={22} class="ic" />
                                        <b>No plan yet</b>
                                        Switch to Plan mode{cycle() ? ` (${cycle()})` : ""} and the agent lays out the steps before changing anything. Its to-do list shows here as it works.
                                    </div>
                                }
                            >
                                <ProposedPlan handle={p.handle} />
                                <Plan handle={p.handle} heading={hasPlan()} />
                            </Show>
                        </div>
                    </Match>
                    <Match when={inspectorPane() === "changes"}>
                        <div class="pane">
                            <ChangesPane changes={changes()} />
                        </div>
                    </Match>
                </Switch>
            </div>
            <Show when={inspectorPane() === "changes"}>
                <PanelFoot handle={p.handle} changes={changes()} />
            </Show>
        </aside>
    );
}
