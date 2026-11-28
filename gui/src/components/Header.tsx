// The title bar over the conversation: the session's title (double-click
// renames) and branch, the project before it when the rail is hidden, and at
// the right one glass capsule of tools: the changes, the project's scripts,
// the terminal, the side panel and the session's menu.

import { createEffect, createMemo, createResource, createSignal, For, lazy, on, Show, Suspense, type JSX } from "solid-js";
import { Archive, ChevronDown, X, Copy, Ellipsis, FileDiff, FolderGit2, FolderOpen, GitBranch, Hand, History, PanelBottom, PanelLeft, PanelRight, Pencil, Search, Share, ShieldAlert, Shrink, Sparkles, SquareArrowOutUpRight, SquarePen, SquareTerminal, Trash2 } from "lucide-solid";
import type { SessionSummary, WorkingIn } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { app, machineFor, reportError, rpc, toast } from "../state/app";
import { archive, deleteSession, editorName, exportSession, newSession, openInEditor, openReview, openWaiting, openWorktreeReview, refreshEditors, rename, togglePanel, toggleSidebar } from "../state/actions";
import { sessionReadReady, useGitChanges } from "../state/changes";
import { prefs, setPrefs } from "../state/prefs";
import { agentFocus, gitModule, terminalOpen, setTerminalOpen, setRewindOpen, openFind, review, setReview, setSettingsTab, settingsTab, shellLayout } from "../state/ui";
import { copyText, isDesktop, machine, os } from "../lib/platform";
import { basename, plural, tildify } from "../lib/format";
import { asking, inFront, needsLine, needsPlace, needsYou } from "../lib/rail";
import { Menu } from "./ui/Menu";
import { RunSwitcher } from "./RunSwitcher";
import { ProjectScripts } from "./ProjectScripts";
import { keyText, shortcut, withShortcut } from "../state/keybindings";
import { promptPreview } from "../lib/review-comments";
import { workingBranch } from "../lib/worktree-work";
import { besideInFront, besideReads, closePane, usePane } from "../state/split";

/** The branch with its upstream counts, opening the branch dialog: a chunk of its own (GitBranches.tsx). */
const BranchChip = lazy(() => gitModule().then((m) => ({ default: m.BranchChip })));

type MenuEntry = { icon: typeof Pencil; label: string; disabled?: boolean; kbd?: string; run: () => void };

export function sessionTitle(h?: SessionHandle): string {
    if (h?.view.state.title) return h.view.state.title;
    // Untitled: as its row names it (after its first prompt), not after the first of the turns this window has.
    const row = h && (app.sessions.find((s) => s.id === h.id) ?? app.archived.find((s) => s.id === h.id));
    if (row && row.title !== "New session") return row.title;
    const first = h?.view.turns.find((t) => t.prompt)?.prompt?.text;
    return (first !== undefined ? promptPreview(first).slice(0, 80) : undefined) ?? "New session";
}

/** Delete a session that's open, at once, with Undo (nothing to delete before its first prompt). */
export function deleteOpen(h?: SessionHandle) {
    if (h?.view.turns.length) void deleteSession(h.id);
}

/**
 * The sessions waiting on you, in Settings' top line (Settings.tsx), which covers
 * the rail where they're listed: there until they're answered, never a toast that
 * could time out unseen. One by name, opening it; several by count, opening a menu
 * of them. Not in a session's title bar: the rail lists them, and while it's
 * hidden its button there carries an amber dot. Opening one (state/actions.ts
 * openWaiting) closes Settings and a sub-agent's view.
 */
export function NeedsYou(p: { waiting: SessionSummary[] }) {
    const [open, setOpen] = createSignal(false);
    let btn: HTMLButtonElement | undefined;
    const one = () => (p.waiting.length === 1 ? p.waiting[0] : undefined);
    const go = (id: string) => (setOpen(false), void openWaiting(id));
    // Gone with the last of them: the menu goes too.
    createEffect(() => p.waiting.length < 2 && setOpen(false));
    return (
        <>
            <button
                ref={btn}
                class="needs-btn"
                title={needsLine(p.waiting)}
                aria-label={needsLine(p.waiting)}
                aria-haspopup={one() ? undefined : "menu"}
                aria-expanded={one() ? undefined : open()}
                onClick={() => {
                    const s = one();
                    if (s) go(s.id);
                    else setOpen(!open());
                }}
            >
                <Hand size={14} />
                <Show when={one()} fallback={<><b>{p.waiting.length}</b><span class="needs-btn-title">sessions need you</span><ChevronDown size={12} /></>}>
                    {(s) => <><b class="needs-one">1</b><span class="needs-btn-title">{s().title}</span><span class="needs-btn-word">needs you</span></>}
                </Show>
            </button>
            <Menu label="Needs you" open={open()} anchor={() => btn} onClose={() => setOpen(false)} align="end" width={320}>
                <div class="menu-head">Needs you</div>
                <For each={p.waiting}>{(s) => (
                    <button role="menuitem" class="menu-item" onClick={() => go(s.id)}>
                        <Hand size={15} />
                        <span class="menu-text">
                            <span class="menu-label truncate">{s.title}</span>
                            <span class="menu-desc truncate">{s.projectName} · {asking(s)}</span>
                        </span>
                    </button>
                )}</For>
            </Menu>
        </>
    );
}

/**
 * The frame every main view shares. With the rail hidden it starts with the
 * rail's own two buttons (show it, new session), clear of the traffic lights;
 * then the title (or crumbs), and the tools at the far end. A session waiting
 * on you while the rail is hidden shows as an amber dot on the rail's button.
 */
export function TitleBar(p: { children: JSX.Element; end?: JSX.Element }) {
    return (
        <header class={`header ${isDesktop && os === "macos" ? "traffic" : ""} ${prefs.sidebar ? "" : "rail-off"}`}>
            {/* Opens and closes with the rail's slide (header.css): the inner box keeps the buttons' own width. */}
            <div class="bar-rail">
                <div class="bar-rail-in">
                    <RailButtons />
                </div>
            </div>
            <nav class="main-title" aria-label="Breadcrumb">
                {p.children}
            </nav>
            <span class="grow" />
            <div class="bar-end">{p.end}</div>
        </header>
    );
}

/** The rail's own two buttons (show it, new session), where the rail is hidden: the title bar, or a full-screen panel over it. */
export function RailButtons() {
    // Listed by the rail when it's there (by Settings over both); hidden, its button here says there are some. The session in front of you shows its own request.
    const waiting = createMemo(() => (needsPlace({ railShown: shellLayout().railShown, settings: Boolean(settingsTab()) }) === "title" ? needsYou([...app.sessions, ...app.archived], inFront({ activeId: app.activeId, settings: false, agentFocus: agentFocus() }), besideInFront(false)) : []));
    return (
        <>
            <button class={`hb head-rail-btn ${waiting().length ? "has-wait" : ""}`} title={withShortcut(waiting().length ? "Show sidebar: a session needs you" : "Show sidebar", "app:toggleSidebar")} aria-label={waiting().length ? "Show sidebar, a session needs you" : "Show sidebar"} onClick={toggleSidebar}>
                <PanelLeft size={16} />
            </button>
            <button class="hb" title={withShortcut("New session", "app:newSession")} aria-label="New session" onClick={() => (setSettingsTab(undefined), newSession(app.homeCwd))}>
                <SquarePen size={16} />
            </button>
        </>
    );
}

export function Crumb(p: { children: JSX.Element; onClick?: () => void; title?: string }) {
    return (
        <Show when={p.onClick} fallback={<span class="main-project">{p.children}</span>}>
            <button class="main-project" title={p.title} onClick={p.onClick}>
                {p.children}
            </button>
        </Show>
    );
}

export const CrumbSep = () => (
    <span class="main-slash" aria-hidden="true">
        /
    </span>
);

/** Where the agent works, for the branch's hover. */
/**
 * The terminal command that resumes session `id`: on its server, in its folder there, when it runs on one (`cavvy
 * --server <name>:<folder>`; a session is found by its folder's project).
 */
function resumeCommand(id: string, cwd: string | undefined): string {
    const away = machineFor(id);
    const on = away ? away.machine : machine;
    if (!on) return `cavvy --resume ${id}`;
    const quoted = `'${`${on}${cwd ? `:${cwd}` : ""}`.replace(/'/g, `'\\''`)}'`;
    return `cavvy --server ${quoted} --resume ${id}`;
}

function workingTitle(w: WorkingIn): string {
    return `Working in the worktree ${tildify(w.path, app.hello?.homeDir)}`;
}

/**
 * What changed where the agent works: in the session's folder, git's count (or Cavvy's own record of its edits
 * outside a repository); in another worktree it moved to, its branch against the main branch, committed or not,
 * as the diff reader shows it. Opens (and closes) the diff reader there.
 */
function ChangesChip(p: { handle: SessionHandle }) {
    // The diff reader is the focused session's: the other pane's chip isn't pressed.
    const pane = usePane();
    const reading = () => pane.focused() && !!review();
    const workingIn = () => p.handle.view.state.workingIn?.path;
    const [git] = useGitChanges(() => p.handle, () => (workingIn() ? "branch" : "uncommitted"), () => undefined, () => undefined, workingIn);
    // Only asked for outside a repository, where git has nothing to say.
    // On a yes or no, not on git's reply itself: each new reply would otherwise ask again for the same change.
    const notRepo = createMemo(() => git()?.repo === false);
    const [edits] = createResource(
        () => notRepo() && sessionReadReady(p.handle) && { id: p.handle.id, n: p.handle.view.state.filesChanged, busy: p.handle.view.state.busy },
        ({ id }) => rpc.call("session.changes", { id }).catch(() => undefined),
    );
    const changes = () => {
        const g = git();
        if (!g) return undefined;
        if (g.repo) return g.error ? undefined : { files: g.files.length + g.more, atLeast: g.moreAtLeast, added: g.added, removed: g.removed };
        const e = edits();
        return e && { files: e.files.length, atLeast: false, added: e.added, removed: e.removed };
    };
    return (
        <Show when={changes()?.files ? changes() : undefined}>
            {(c) => (
                    <button
                        class="head-changes"
                        title={`${reading() ? "Hide changes" : "Review changes"}${workingIn() ? " in the worktree" : ""}: ${c().files}${c().atLeast ? "+" : ""} changed ${c().files === 1 && !c().atLeast ? "file" : "files"}`}
                        aria-label={`Changes: ${plural(c().files, "file")}, ${c().added} added, ${c().removed} removed`}
                        aria-pressed={reading()}
                        onClick={() => {
                            const w = workingIn();
                            if (review()) setReview(undefined);
                            else if (w) openWorktreeReview(w);
                            else openReview();
                        }}
                    >
                        <FileDiff size={15} />
                        {/* Only the sides that changed: "+18", not "+18 −0"; the mark alone when no line did. */}
                        <span class="stat">
                            <span class="add" hidden={!c().added}>+{c().added}</span>
                            <span class="del" hidden={!c().removed}>−{c().removed}</span>
                        </span>
                    </button>
            )}
        </Show>
    );
}

/** In a split, each pane's (a sub-agent's view in it too): the other session stays, alone. */
export function ClosePane() {
    const pane = usePane();
    return (
        <Show when={pane.split() && pane.id}>
            {(id) => (
                <button class="hb" title="Remove from split" aria-label="Remove from split" onClick={() => closePane(id())}>
                    <X size={16} />
                </button>
            )}
        </Show>
    );
}

/** `title`: no session yet (one opening), what to call it. */
export function Header(p: { handle?: SessionHandle; title?: string }) {
    const pane = usePane();
    const [editing, setEditing] = createSignal(false);
    const [menuOpen, setMenuOpen] = createSignal(false);
    let moreBtn: HTMLButtonElement | undefined;
    const st = () => p.handle?.view.state;
    const close = () => setMenuOpen(false);
    const copy = async (text: string, done: string) => {
        close();
        if (await copyText(text)) toast(done, "success");
    };
    // The side panel shows the focused session's: the other pane's button isn't pressed.
    const panelOn = () => pane.focused() && (prefs.panel || !!review() || besideReads());
    // Another session in view: no rename carries over.
    createEffect(on(() => p.handle?.id, () => setEditing(false), { defer: true }));

    return (
        <TitleBar
            end={
                <>
                    <Show when={st()}>{(s) => <RunSwitcher id={s().id} />}</Show>
                    <div class="head-tools">
                        <Show when={p.handle}>{(h) => <ChangesChip handle={h()} />}</Show>
                        <Show when={st()?.cwd}>
                            {(cwd) => (
                                <ProjectScripts cwd={cwd()} sessionId={st()?.id} />
                            )}
                        </Show>
                        <button class={`hb win ${terminalOpen() ? "on" : ""}`} title={withShortcut("Terminal", "app:toggleTerminal")} aria-label="Toggle terminal" aria-pressed={terminalOpen()} disabled={!st()?.cwd && !app.homeCwd} onClick={() => setTerminalOpen(!terminalOpen())}>
                            <PanelBottom size={16} />
                        </button>
                        <Show when={st()}>
                            <button class={`hb win ${panelOn() ? "on" : ""}`} title={withShortcut("Side panel", "app:togglePanel")} aria-label="Toggle panel" aria-pressed={panelOn()} onClick={() => (pane.wasFocused() ? togglePanel() : setPrefs("panel", true))}>
                                <PanelRight size={16} />
                            </button>
                            <button ref={moreBtn} class="hb" title="More" aria-label="Session actions" aria-haspopup="menu" aria-expanded={menuOpen()} onClick={() => (setMenuOpen(!menuOpen()), menuOpen() && void refreshEditors())}>
                                <Ellipsis size={16} />
                            </button>
                        </Show>
                    </div>
                    <ClosePane />
                </>
            }
        >
            <Show
                when={st()}
                fallback={
                    <>
                        {/* Home: the project the new session starts in, before its name. */}
                        <Show when={!p.title && app.homeCwd}>
                            {(cwd) => (
                                <>
                                    <span class="main-project">{basename(cwd())}</span>
                                    <CrumbSep />
                                </>
                            )}
                        </Show>
                        <h1 class={`main-title-btn ${p.title ? "" : "main-title-none"}`}>{p.title ?? "New session"}</h1>
                    </>
                }
            >
                {(s) => (
                    <>
                        {/* With the rail hidden, the project goes before the title (and starts a session in it). */}
                        <button class="main-project" title={`New session in ${s().projectName}`} onClick={() => newSession(s().cwd, machineFor(p.handle?.id))}>
                            {s().projectName}
                        </button>
                        <CrumbSep />
                        <Show
                            when={!editing()}
                            fallback={
                                <input
                                    class="main-rename"
                                    value={sessionTitle(p.handle)}
                                    aria-label="Session name"
                                    ref={(el) => requestAnimationFrame(() => (el.focus(), el.select()))}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            void rename(s().id, e.currentTarget.value);
                                            setEditing(false);
                                        } else if (e.key === "Escape") setEditing(false);
                                    }}
                                    onBlur={(e) => {
                                        if (!editing()) return;
                                        void rename(s().id, e.currentTarget.value);
                                        setEditing(false);
                                    }}
                                />
                            }
                        >
                            <h1 class="main-title-btn" title="Double-click to rename" onDblClick={() => (close(), setEditing(true))}>
                                {sessionTitle(p.handle)}
                            </h1>
                        </Show>
                        <Show
                            when={s().workingIn}
                            fallback={
                                <Show when={s().branch}>
                                    {(b) => {
                                        const plain = (
                                            <span class="main-branch" title="Git branch">
                                                <GitBranch size={12} />
                                                <span class="mono">{b()}</span>
                                            </span>
                                        );
                                        return <Suspense fallback={plain}><BranchChip handle={p.handle!} branch={b()} /></Suspense>;
                                    }}
                                </Show>
                            }
                        >
                            {(w) => (
                                <span class="main-branch" title={workingTitle(w())}>
                                    <FolderGit2 size={12} />
                                    <span class="mono">{workingBranch(w())}</span>
                                </span>
                            )}
                        </Show>
                        <Show when={!s().trusted}>
                            <span class="head-untrusted" title="This folder's own configuration is ignored">
                                <ShieldAlert size={12} /> Untrusted
                            </span>
                        </Show>
                        <Menu label="Session actions" open={menuOpen()} anchor={() => moreBtn} onClose={close} align="end" width={244}>
                            <For
                                each={[
                                    { icon: Pencil, label: "Rename", run: () => void (close(), setEditing(true)) },
                                    { icon: Sparkles, label: "Regenerate title", run: () => void (close(), import("./RowExtras").then((m) => m.regenerateTitle(s().id))) },
                                    { icon: History, label: "Rewind…", run: () => void (close(), setRewindOpen(true)) },
                                    {
                                        icon: Shrink,
                                        label: "Compact conversation",
                                        // An idle compaction gives way to the user's own.
                                        disabled: s().busy && !s().activity?.idle,
                                        run: () => void (close(), rpc.call("session.compact", { id: s().id }).catch(reportError)),
                                    },
                                    { icon: Search, label: "Find in conversation", kbd: "app:find", run: () => void (close(), openFind()) },
                                ] as MenuEntry[]}
                            >
                                {(it) => (
                                    <button role="menuitem" class="menu-item compact" disabled={it.disabled} onClick={it.run}>
                                        <it.icon size={14} /> <span class="menu-label">{it.label}</span>
                                        <Show when={it.kbd && shortcut(it.kbd)}>{(k) => <kbd class="menu-kbd">{keyText(k())}</kbd>}</Show>
                                    </button>
                                )}
                            </For>
                            <div class="menu-sep" />
                            <button role="menuitem" class="menu-item compact" onClick={() => (close(), void exportSession(s().id))}>
                                <Share size={14} /> Copy as Markdown
                            </button>
                            <button role="menuitem" class="menu-item compact" onClick={() => void copy(resumeCommand(s().id, s().cwd), "Copied the resume command")}>
                                <SquareTerminal size={14} /> Copy resume command
                            </button>
                            <Show when={s().workingIn ? s().workingIn!.branch : s().branch}>
                                {(branch) => (
                                    <button role="menuitem" class="menu-item compact" onClick={() => void copy(branch(), `Copied ${branch()}`)}>
                                        <Copy size={14} /> Copy branch name
                                    </button>
                                )}
                            </Show>
                            <button role="menuitem" class="menu-item compact" title={s().cwd} onClick={() => void copy(s().cwd, `Copied ${tildify(s().cwd, app.hello?.homeDir)}`)}>
                                <FolderOpen size={14} /> Copy folder path
                            </button>
                            <button role="menuitem" class="menu-item compact" title={s().cwd} onClick={() => (close(), void openInEditor(s().cwd, undefined, { folder: true, sessionId: s().id }))}>
                                <SquareArrowOutUpRight size={14} /> Open project in {editorName() ?? "editor"}
                            </button>
                            <div class="menu-sep" />
                            <button role="menuitem" class="menu-item compact" onClick={() => (close(), void archive(s().id, true))}>
                                <Archive size={14} /> Archive
                            </button>
                            <button role="menuitem" class="menu-item compact danger" disabled={!p.handle?.view.turns.length} onClick={() => (close(), deleteOpen(p.handle))}>
                                <Trash2 size={14} /> Delete
                            </button>
                        </Menu>
                    </>
                )}
            </Show>
        </TitleBar>
    );
}
