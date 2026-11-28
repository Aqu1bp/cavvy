// The side panel, in the sheet's inspector column: Changes | Agents | Commands | Side chat | Browser
// at the top. Changes opens the diff reader, with its file count on the icon. Agents: every sub-agent once (a background one's
// task and its run are one row), and tasks given to other models. Commands (CommandsPane):
// background shells and monitors, watched pull requests, and the session's
// secrets and MCP servers that failed or ask for approval. Side chat (SideChatPane): questions about the session that
// don't go into it. Browser: the session's browser, watched and driven by hand (BrowserPane). Empty sections aren't
// drawn. The plan and its steps are in the conversation (Composer, Activity).

import { batch, createEffect, createMemo, createResource, createSignal, Match, on, Show, Switch, lazy, type JSX } from "solid-js";
import { Bot, Copy, FileDiff, FolderGit2, FolderOpen, GitBranch, Globe, Maximize2, MessageSquareText, Minimize2, Plug, Smartphone, SquarePen, SquareTerminal } from "lucide-solid";
import type { ChangesInfo, GitFileDiff } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { app, awayMachine, machineFor, reportError, revealsIn, rpc, toast } from "../state/app";
import { setPrefs } from "../state/prefs";
import { inspectorPane, panelFull, review, setInspectorPane, setMcpOpen, setPanelFull, setReview } from "../state/ui";
import { newSession, openReview } from "../state/actions";
import { sessionReadReady, useGitChanges } from "../state/changes";
import { copyText, revealPath } from "../lib/platform";
import { tildify } from "../lib/format";
import { workingBranch } from "../lib/worktree-work";
import { agentRows, backgroundOf, commandRows, rowLive, type WorkRow } from "../lib/background";
import { tabName, type Change, type InspectorPane } from "../lib/inspector";
import { Menu } from "./ui/Menu";
import { uncleared } from "../lib/background-cleared";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { browserUnseen, loadBrowserState } from "../state/browser";
import { loadSimulatorState, simulatorOffered, simulatorState, simulatorUnseen } from "../state/simulator";

/** The folder the session works in: its actions, from the rail's last button (the path on hover). */
function WorkspaceButton(p: { handle: SessionHandle }) {
    let btn: HTMLButtonElement | undefined;
    const [menu, setMenu] = createSignal(false);
    const st = () => p.handle.view.state;
    const close = () => setMenu(false);
    return (
        <>
            <button ref={btn} class="rail-tab" data-state={menu() ? "open" : undefined} aria-label="Workspace actions" aria-haspopup="menu" aria-expanded={menu()} data-tip="Workspace" data-tip-side="left" onClick={() => setMenu(!menu())}>
                <FolderGit2 size={16} />
            </button>
            <Menu label="Workspace actions" open={menu()} anchor={() => btn} onClose={close} placement="top" align="end" width={280}>
                <div class="ws-head" title={tildify(st().cwd, app.hello?.homeDir)}>
                    <span class="ws-name truncate">{st().projectName}</span>
                    <Show when={st().branch}>
                        <span class="ws-chip" title="Git branch">
                            <GitBranch size={12} />
                            <span class="mono truncate">{st().branch}</span>
                        </span>
                    </Show>
                    <Show when={st().workingIn}>
                        {(w) => (
                            <span class="ws-chip" title={`The agent works in the worktree ${tildify(w().path, app.hello?.homeDir)}`}>
                                <FolderGit2 size={12} />
                                <span class="truncate">{workingBranch(w())}</span>
                            </span>
                        )}
                    </Show>
                </div>
                <div class="menu-sep" />
                <Show when={revealsIn(st().id)}>
                    <button role="menuitem" class="menu-item" onClick={() => (close(), void revealPath(st().cwd).catch(reportError))}>
                        <FolderOpen size={14} />
                        <span class="menu-item-name">Reveal in Finder</span>
                    </button>
                </Show>
                <button role="menuitem" class="menu-item" onClick={async () => (close(), (await copyText(st().cwd)) && toast("Copied the folder path", "success"))}>
                    <Copy size={14} />
                    <span class="menu-item-name">Copy folder path</span>
                </button>
                <button role="menuitem" class="menu-item" onClick={() => (close(), newSession(st().cwd, machineFor(p.handle.id)))}>
                    <SquarePen size={14} />
                    <span class="menu-item-name">New session</span>
                </button>
                <button role="menuitem" class="menu-item" onClick={() => (close(), setMcpOpen({}))}>
                    <Plug size={14} />
                    <span class="menu-item-name">MCP servers</span>
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

/** Each view's name, at the head of its pane. */
const TITLES: Record<InspectorPane, string> = { changes: "Changes", agents: "Agents", commands: "Commands", sidechat: "Side chat", browser: "Browser", simulator: "Simulator" };

/** The Agents tab (BackgroundTasks.tsx), loaded when it's first shown, as the other panes are. */
const AgentsPane = lazy(() => import("./BackgroundTasks").then((m) => ({ default: m.AgentsPane })));

/** The Commands tab (CommandsPane), loaded when it's first shown. */
const CommandsPane = lazy(() => import("./CommandsPane"));

/** The side chat (SideChatPane), loaded when it's first shown. */
const SideChatPane = lazy(() => import("./SideChatPane"));

/** The Browser pane is loaded when it's first shown, with its menu and bars (BrowserTools.tsx). */
const BrowserPane = lazy(() => import("./BrowserPane").then((m) => ({ default: m.BrowserPane })));
/** The Simulator pane is loaded when it's first shown: only a Mac with Xcode, or a server lent one's, ever shows it. */
const SimulatorPane = lazy(() => import("./SimulatorPane").then((m) => ({ default: m.SimulatorPane })));

/** What the panel's views hold, for its rail and its panes: the folder's changes, the agents and the commands. */
function usePanelWork(handle: () => SessionHandle) {
    const changes = useFolderChanges(handle);
    const tasks = createMemo(() => backgroundOf(handle().view.state));
    const agents = createMemo(() => uncleared(handle().id, agentRows(tasks(), handle().view.agents)));
    const commands = createMemo(() => uncleared(handle().id, commandRows(tasks())));
    // What the agent does in the browser is told even while the pane isn't showing (a dot on its icon).
    // Asked again once the session is open again on its machine (its connection came back).
    createEffect(on([() => handle().id, () => handle().ready()], ([id, ready]) => void (ready && loadBrowserState(id).catch(() => undefined))));
    // And on the simulator, whose view shows only on a Mac with Xcode.
    // Another machine's session: what this computer lends it is asked of first (lib/lent.ts).
    createEffect(on([() => handle().id, () => handle().ready()], ([id, ready]) => void (ready && (awayMachine(id) === undefined ? Promise.resolve() : import("../lib/lent")).then(() => loadSimulatorState(id)).catch(() => undefined))));
    return { changes, agents, commands };
}

/** One of the rail's views: its icon, what runs there now (a count) or wants a look (a dot); its name is its tooltip. */
function RailTab(p: { name: string; tip: string; active: boolean; count?: string | number; dot?: "accent" | "amber" | "red"; dotTitle?: string; onClick: () => void; children: JSX.Element }) {
    return (
        <button type="button" role="tab" class="rail-tab" aria-selected={p.active} aria-label={p.name} data-tip={p.tip} data-tip-side="left" onClick={p.onClick}>
            {p.children}
            <Show when={p.count}>
                <span class="rail-count">{p.count}</span>
            </Show>
            <Show when={p.dot}>
                <span class="rail-dot" data-tone={p.dot} title={p.dotTitle} />
            </Show>
        </button>
    );
}

/**
 * The panel's views, as icons down its outer edge (first for the keyboard; panel.css puts it there): one look at any
 * width. A view's name is its tooltip, and the title of its pane. It stays beside the diff reader too (`reviewing`:
 * Changes is the view the reader belongs to; none for the file viewer), so the reader reads as part of the panel: an icon leaves it for that view.
 */
function PanelRail(p: { handle: SessionHandle; work: ReturnType<typeof usePanelWork>; reviewing?: boolean }) {
    const { changes, agents, commands } = p.work;
    const running = (rows: readonly WorkRow[]) => rows.filter(rowLive).length;
    const asks = () => agents().some((r) => r.status === "waiting");
    const files = () => (changes()?.count ? `${changes()!.count.toLocaleString()}${changes()!.atLeast ? "+" : ""}` : undefined);
    const current = () => (p.reviewing ? (review()?.file ? undefined : "changes") : inspectorPane());
    // Changes is the diff reader itself; the other icons are the panel's panes.
    const show = (pane: InspectorPane) => batch(() => {
        if (pane === "changes") return openChanges(changes());
        setReview(undefined);
        setInspectorPane(pane);
        setPrefs("panel", true);
    });
    const sideChat = () => p.handle.view.state.sideChat?.status;
    return (
        <nav class="rail" role="tablist" aria-orientation="vertical" aria-label="Side panel">
            <RailTab
                name={tabName("Changes", files() && `${files()} ${changes()!.count === 1 ? "file" : "files"}`)}
                tip={files() ? `Changes: ${files()} ${changes()!.count === 1 ? "file" : "files"}, +${changes()!.added.toLocaleString()} −${changes()!.removed.toLocaleString()}` : "Changes"}
                active={current() === "changes"}
                count={files()}
                onClick={() => show("changes")}
            >
                <FileDiff size={16} />
            </RailTab>
            <RailTab
                name={tabName("Agents", running(agents()) > 0 && `${running(agents())} running`, asks() && "a sub-agent needs you")}
                tip="Agents"
                active={current() === "agents"}
                count={running(agents()) || undefined}
                dot={asks() ? "amber" : undefined}
                dotTitle="A sub-agent needs you"
                onClick={() => show("agents")}
            >
                <Bot size={16} />
            </RailTab>
            <RailTab
                name={tabName("Commands", running(commands()) > 0 && `${running(commands())} running`)}
                tip="Commands"
                active={current() === "commands"}
                count={running(commands()) || undefined}
                onClick={() => show("commands")}
            >
                <SquareTerminal size={16} />
            </RailTab>
            <RailTab
                name={tabName("Side chat", sideChat() === "waiting" ? "it needs you" : sideChat() === "running" ? "working" : sideChat() === "error" && "it stopped with an error")}
                tip="Side chat"
                active={current() === "sidechat"}
                // Working: the accent, as a working session's; waiting on you: amber; failed: red.
                dot={sideChat() === "running" ? "accent" : sideChat() === "waiting" ? "amber" : sideChat() === "error" ? "red" : undefined}
                dotTitle={sideChat() === "running" ? "Working" : sideChat() === "waiting" ? "Needs you" : "Stopped with an error"}
                onClick={() => show("sidechat")}
            >
                <MessageSquareText size={16} />
            </RailTab>
            <RailTab
                name={tabName("Browser", browserUnseen(p.handle.id) && "the agent opened a page")}
                tip="Browser"
                active={current() === "browser"}
                dot={browserUnseen(p.handle.id) ? "accent" : undefined}
                dotTitle="The agent opened a page"
                onClick={() => show("browser")}
            >
                <Globe size={16} />
            </RailTab>
            <Show when={simulatorOffered(p.handle.id)}>
                <RailTab
                    name={tabName("Simulator", simulatorUnseen(p.handle.id) && "the agent used it")}
                    tip="Simulator"
                    active={current() === "simulator"}
                    dot={simulatorUnseen(p.handle.id) ? "accent" : undefined}
                    dotTitle="The agent used the simulator"
                    onClick={() => show("simulator")}
                >
                    <Smartphone size={16} />
                </RailTab>
            </Show>
            <span class="rail-sep" />
            <button type="button" class="rail-tab" aria-pressed={panelFull()} aria-label={panelFull() ? "Exit full screen" : "Full screen"} data-tip={panelFull() ? "Exit full screen" : "Full screen"} data-tip-side="left" onClick={() => setPanelFull(!panelFull())}>
                <Show when={panelFull()} fallback={<Maximize2 size={15} />}>
                    <Minimize2 size={15} />
                </Show>
            </button>
            <WorkspaceButton handle={p.handle} />
        </nav>
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
    // Each pane's name heads it, as a title line; the side chat's line has its own buttons (SideChatPane).
    const titled = () => inspectorPane() !== "sidechat";
    return (
        <aside class="panel" aria-label="Session details">
            {/* The folder's changes (the Changes icon's count) are the one thing here fetched once the session is open:
                until they're in, a window that just switched machines keeps its picture over the panel
                (desktop-electron/src/preload.ts). */}
            <Show when={work.changes() === undefined}>
                <div class="insp-loading" aria-busy="true" hidden />
            </Show>
            <PanelRail handle={p.handle} work={work} />
            <div class="inspector-main">
                <Show when={titled()}>
                    <header class="inspector-head">
                        <h2 class="inspector-title">{TITLES[inspectorPane()]}</h2>
                    </header>
                </Show>
                <div class="inspector-body insp-body" classList={{ "br-body": inspectorPane() === "browser" || inspectorPane() === "simulator" || inspectorPane() === "sidechat" }} role="tabpanel" aria-label={TITLES[inspectorPane()]}>
                    {/* A pane is made when its tab is chosen: not when what's in it changes. */}
                    <Switch>
                        <Match when={inspectorPane() === "agents"}>
                            <AgentsPane handle={p.handle} rows={agents()} />
                        </Match>
                        <Match when={inspectorPane() === "commands"}>
                            <CommandsPane handle={p.handle} rows={commands()} />
                        </Match>
                        <Match when={inspectorPane() === "browser"}>
                            <div class="pane">
                                <BrowserPane handle={p.handle} />
                            </div>
                        </Match>
                        <Match when={inspectorPane() === "sidechat"}>
                            <SideChatPane handle={p.handle} views={{ Transcript, Composer }} />
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
