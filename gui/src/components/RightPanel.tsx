// The side panel, in the sheet's inspector column: Changes | Agents | Commands | Browser
// at the top. Changes opens the diff reader, with its file count on the icon. Agents: every sub-agent once (a background one's
// task and its run are one row), and tasks given to other models. Commands:
// background shells and monitors, watched pull requests, and the session's
// secrets and MCP servers that failed or ask for approval. Browser: the session's
// browser, watched and driven by hand (BrowserPane). Empty sections aren't
// drawn. The plan and its steps are in the conversation (Composer, Activity).

import { batch, createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js";
import { Bot, Copy, FileDiff, FolderGit2, FolderOpen, GitBranch, GitPullRequestArrow, Globe, KeyRound, Maximize2, Minimize2, Plug, Smartphone, SquarePen, Terminal, X } from "lucide-solid";
import type { ChangesInfo, GitFileDiff } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { app, reportError, rpc, toast } from "../state/app";
import { setPrefs } from "../state/prefs";
import { inspectorPane, panelFull, setInspectorPane, setMcpOpen, setPanelFull, setReview } from "../state/ui";
import { newSession, openReview } from "../state/actions";
import { needsAttention, shownName, statusLabel } from "../lib/mcp";
import { sessionReadReady, useGitChanges } from "../state/changes";
import { canReveal, copyText, openExternal, revealPath } from "../lib/platform";
import { tildify } from "../lib/format";
import { workingBranch } from "../lib/worktree-work";
import { agentRows, backgroundOf, commandRows, rowLive, type WorkRow } from "../lib/background";
import { tabName, type Change, type InspectorPane } from "../lib/inspector";
import { Menu } from "./ui/Menu";
import { Segmented } from "./ui/bits";
import { PublishDialog } from "./PublishDialog";
import { uncleared, WorkList } from "./BackgroundTasks";
import { BrowserPane } from "./BrowserPane";
import { browserUnseen, loadBrowserState } from "../state/browser";
import { SimulatorPane } from "./SimulatorPane";
import { loadSimulatorState, simulatorOffered, simulatorState, simulatorUnseen } from "../state/simulator";

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
                    <Show when={st().workingIn}>
                        {(w) => (
                            <span class="insp-ws-br truncate" title={`The agent works in the worktree ${tildify(w().path, app.hello?.homeDir)}`}>
                                <FolderGit2 size={12} />
                                <span class="truncate">{workingBranch(w())}</span>
                            </span>
                        )}
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
                    <SquarePen size={14} /> New session
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
 * What changed in the folder: Git's uncommitted changes, whoever made them, or Cavvy's own
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

type FolderChanges = ReturnType<ReturnType<typeof useFolderChanges>>;

/** The diff reader on these changes: git's uncommitted view, or (outside a repository) Cavvy's own record. */
const openChanges = (c: FolderChanges, path?: string, token?: string) => openReview(path, c?.repo === false ? "cavvy" : "uncommitted", undefined, token);

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
<div class="none">No agents yet</div>
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
<div class="none">No commands running</div>
            }
        >
            <WorkList handle={p.handle} tab="commands" rows={p.rows} />
            <Watches handle={p.handle} />
            <SessionGroup handle={p.handle} />
        </Show>
    );
}

/** What the panel's views hold, for its rail and its panes: the folder's changes, the agents and the commands. */
function usePanelWork(handle: () => SessionHandle) {
    const changes = useFolderChanges(handle);
    const tasks = createMemo(() => backgroundOf(handle().view.state));
    const agents = createMemo(() => uncleared(handle().id, agentRows(tasks(), handle().view.agents)));
    const commands = createMemo(() => uncleared(handle().id, commandRows(tasks())));
    // What the agent does in the browser is told even while the pane isn't showing (a dot on its icon).
    createEffect(on(() => handle().id, (id) => void loadBrowserState(id).catch(() => undefined)));
    // And on the simulator, whose view shows only on a Mac with Xcode.
    createEffect(on(() => handle().id, (id) => void loadSimulatorState(id).catch(() => undefined)));
    return { changes, agents, commands };
}

/**
 * The panel's views, as icons down its outer edge (first for the keyboard; panel.css puts it there): one look at any
 * width. A view's name is its tooltip, and the title of its pane. It stays beside the diff reader too (`reviewing`:
 * Changes is the view the reader belongs to), so the reader reads as part of the panel: an icon leaves it for that view.
 */
function PanelRail(p: { handle: SessionHandle; work: ReturnType<typeof usePanelWork>; reviewing?: boolean }) {
    const { changes, agents, commands } = p.work;
    const running = (rows: readonly WorkRow[]) => rows.filter(rowLive).length;
    const asks = () => agents().some((r) => r.status === "waiting");
    const files = () => (changes()?.count ? `${changes()!.count.toLocaleString()}${changes()!.atLeast ? "+" : ""}` : undefined);
    // Changes is the diff reader itself; the other icons are the panel's panes.
    const show = (pane: InspectorPane) => batch(() => {
        if (pane === "changes") return openChanges(changes());
        setReview(undefined);
        setInspectorPane(pane);
        setPrefs("panel", true);
    });
    return (
        <div class="insp-rail">
            <Segmented
                label="Side panel"
                value={p.reviewing ? "changes" : inspectorPane()}
                onChange={show}
                options={[
                    {
                        value: "changes",
                        get name() {
                            return tabName("Changes", files() && `${files()} ${changes()!.count === 1 ? "file" : "files"}`);
                        },
                        title: "Changes",
                        label: (
                            <>
                                <FileDiff class="seg-i" />
                                <Show when={files()}>
                                    <span class="ct files">{files()}</span>
                                </Show>
                            </>
                        ),
                    },
                    {
                        value: "agents",
                        get name() {
                            return tabName("Agents", running(agents()) > 0 && `${running(agents())} running`, asks() && "a sub-agent needs you");
                        },
                        title: "Agents",
                        // A tab's count is what runs in it now, in the accent.
                        label: (
                            <>
                                <Bot class="seg-i" />
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
                        get name() {
                            return tabName("Commands", running(commands()) > 0 && `${running(commands())} running`);
                        },
                        title: "Commands",
                        label: (
                            <>
                                <Terminal class="seg-i" />
                                <Show when={running(commands())}>
                                    <span class="ct live">{running(commands())}</span>
                                </Show>
                            </>
                        ),
                    },
                    {
                        value: "browser",
                        get name() {
                            return tabName("Browser", browserUnseen(p.handle.id) && "the agent opened a page");
                        },
                        title: "Browser",
                        label: (
                            <>
                                <Globe class="seg-i" />
                                <Show when={browserUnseen(p.handle.id)}>
                                    <span class="ct-dot" title="The agent opened a page" />
                                </Show>
                            </>
                        ),
                    },
                    ...(simulatorOffered(p.handle.id)
                        ? [
                              {
                                  value: "simulator" as const,
                                  get name() {
                                      return tabName("Simulator", simulatorUnseen(p.handle.id) && "the agent used it");
                                  },
                                  title: "Simulator",
                                  label: (
                                      <>
                                          <Smartphone class="seg-i" />
                                          <Show when={simulatorUnseen(p.handle.id)}>
                                              <span class="ct-dot" title="The agent used the simulator" />
                                          </Show>
                                      </>
                                  ),
                              },
                          ]
                        : []),
                ]}
            />
            <span class="grow" />
            <button class="hb" aria-pressed={panelFull()} aria-label="Full screen" title={panelFull() ? "Exit full screen" : "Full screen"} onClick={() => setPanelFull(!panelFull())}>
                <Show when={panelFull()} fallback={<Maximize2 size={15} />}>
                    <Minimize2 size={15} />
                </Show>
            </button>
            <WorkspaceButton handle={p.handle} />
        </div>
    );
}

/** The panel's rail, beside the diff reader (App.tsx). */
export function ReviewRail(p: { handle: SessionHandle }) {
    return <PanelRail handle={p.handle} work={usePanelWork(() => p.handle)} reviewing />;
}

export function RightPanel(p: { handle: SessionHandle }) {
    const work = usePanelWork(() => p.handle);
    const { agents, commands } = work;
    createEffect(() => {
        if (inspectorPane() === "simulator" && simulatorState(p.handle.id)?.status === "unavailable") setInspectorPane("agents");
    });
    // The panes with a title line; the browser's and the simulator's own bars say what they are.
    const titled = () => (inspectorPane() === "browser" || inspectorPane() === "simulator" ? undefined : inspectorPane());
    return (
        <aside class="panel" aria-label="Session details">
            <PanelRail handle={p.handle} work={work} />
            <div class="insp-main">
            <Show when={titled()}>
                {(pane) => (
                    <div class="insp-t">
                        <h2>{pane()}</h2>
                    </div>
                )}
            </Show>
            <div class="insp-body panel-scroll" classList={{ "br-body": !titled() }}>
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
                    <Match when={inspectorPane() === "browser"}>
                        <div class="pane">
                            <BrowserPane handle={p.handle} />
                        </div>
                    </Match>
                    <Match when={inspectorPane() === "simulator"}>
                        <div class="pane">
                            <SimulatorPane handle={p.handle} />
                        </div>
                    </Match>
                </Switch>
            </div>
            </div>
        </aside>
    );
}
