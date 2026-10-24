// The title bar over the conversation: the session's title (double-click
// renames) and branch, the project before it when the rail is hidden, and at
// the right one glass capsule of tools: the changes, the project's scripts,
// the terminal, the side panel and the session's menu.

import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Archive, ChevronDown, Copy, Ellipsis, FileDiff, FolderOpen, GitBranch, Hand, History, PanelBottom, PanelLeft, PanelRight, Pencil, Search, Share, ShieldAlert, Shrink, SquareArrowOutUpRight, SquarePen, SquareTerminal, Trash2 } from "lucide-solid";
import type { SessionSummary } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { activate, app, reportError, rpc, toast } from "../state/app";
import { archive, editorName, exportSession, newSession, openInEditor, openReview, refreshEditors, rename, togglePanel, toggleSidebar } from "../state/actions";
import { sessionReadReady, useGitChanges } from "../state/changes";
import { prefs } from "../state/prefs";
import { terminalOpen, setTerminalOpen, setRewindOpen, setDeleteRequest, openFind, review, setReview, setSettingsTab, setTitleBarBox, settingsTab, shellLayout } from "../state/ui";
import { copyText, isTauri, os } from "../lib/platform";
import { plural, tildify } from "../lib/format";
import { asking, needsLine, needsYou } from "../lib/rail";
import { Menu } from "./ui/Menu";
import { RunSwitcher } from "./RunSwitcher";
import { ProjectScripts } from "./ProjectScripts";
import { shortcut, withShortcut } from "../state/keybindings";
import { promptPreview } from "../lib/review-comments";

type MenuEntry = { icon: typeof Pencil; label: string; disabled?: boolean; kbd?: string; run: () => void };

export function sessionTitle(h?: SessionHandle): string {
    const first = h?.view.turns.find((t) => t.prompt)?.prompt?.text;
    return h?.view.state.title ?? (first !== undefined ? promptPreview(first).slice(0, 80) : undefined) ?? "New session";
}

/** Open the delete dialog for a session that's open (nothing to delete before its first prompt). */
export function askDelete(h?: SessionHandle) {
    if (!h?.view.turns.length) return;
    const cwd = h.view.state.cwd;
    setDeleteRequest({ id: h.id, title: sessionTitle(h), projectName: app.sessions.concat(app.archived).find((s) => s.id === h.id)?.projectName ?? (cwd.split("/").filter(Boolean).pop() || cwd) });
}

/**
 * Where the title starts and the tools end (from the window's left and right edges): the toasts
 * drop into this row, over the title and clear of the capsule, wherever the shell puts it. Kept
 * for the toasts alone: custom properties on the root would restyle the whole window each time
 * the title bar resizes (on every frame of dragging the rail, say).
 */
function placeToasts(header: HTMLElement) {
    if (!header.isConnected) return;
    const title = header.querySelector<HTMLElement>(".crumbs")?.getBoundingClientRect();
    const tools = header.querySelector<HTMLElement>(".bar-end")?.getBoundingClientRect();
    const box = header.getBoundingClientRect();
    if (!box.width) return;
    setTitleBarBox({
        start: Math.round(title?.left ?? box.left),
        end: Math.round(window.innerWidth - (tools?.width ? tools.left : box.right)),
        top: Math.round(box.top),
    });
}

/**
 * The sessions waiting on you while the rail is hidden (or a closed drawer): here,
 * beside the tools, until they're answered, never a toast that could time out
 * unseen. One by name, opening it; several by count, opening a menu of them.
 */
function NeedsYou(p: { waiting: SessionSummary[] }) {
    const [open, setOpen] = createSignal(false);
    let btn: HTMLButtonElement | undefined;
    const one = () => (p.waiting.length === 1 ? p.waiting[0] : undefined);
    const go = (id: string) => (setOpen(false), void activate(id));
    // Gone with the last of them: the menu goes too.
    createEffect(() => p.waiting.length < 2 && setOpen(false));
    return (
        <>
            <button
                ref={btn}
                class="needs glass"
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
                <Show when={one()} fallback={<><b>{p.waiting.length}</b><span class="needs-w">sessions need you</span><ChevronDown size={12} class="needs-chev" /></>}>
                    {(s) => <><b class="needs-one">1</b><span class="needs-t truncate">{s().title}</span><span class="needs-w">needs you</span></>}
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
 * then the title (or crumbs), and the tools at the far end, with whoever is
 * waiting on you before them.
 */
export function TitleBar(p: { children: JSX.Element; end?: JSX.Element }) {
    // Shown by the rail when it's there; the session in front of you shows its own request.
    const waiting = createMemo(() => (shellLayout().railShown ? [] : needsYou([...app.sessions, ...app.archived], settingsTab() ? undefined : app.activeId)));
    let el: HTMLElement | undefined;
    onMount(() => {
        const place = () => el && placeToasts(el);
        // Its first report comes after this frame's layout, before it's painted: placing them now
        // would lay out the whole view a second time (a session opening, say) only to read the bar.
        const ro = new ResizeObserver(place);
        ro.observe(el!);
        for (const part of el!.querySelectorAll(".crumbs, .bar-end")) ro.observe(part);
        window.addEventListener("resize", place);
        onCleanup(() => (ro.disconnect(), window.removeEventListener("resize", place)));
    });
    return (
        <header ref={el} class={`header ${isTauri && os === "macos" ? "traffic" : ""} ${prefs.sidebar ? "" : "rail-off"}`}>
            <div class="bar-rail">
                <button class={`hb ${waiting().length ? "has-wait" : ""}`} title={withShortcut(waiting().length ? "Show sidebar: a session needs you" : "Show sidebar", "app:toggleSidebar")} aria-label={waiting().length ? "Show sidebar, a session needs you" : "Show sidebar"} onClick={toggleSidebar}>
                    <PanelLeft size={16} />
                </button>
                <button class="hb" title={withShortcut("New session", "app:newSession")} aria-label="New session" onClick={() => (setSettingsTab(undefined), newSession(app.homeCwd))}>
                    <SquarePen size={16} />
                </button>
            </div>
            <nav class="crumbs" aria-label="Breadcrumb">
                {p.children}
            </nav>
            <span class="grow" />
            {/* Always there (empty, it's 0 wide), so the toasts' place follows Needs you coming and going in any view. */}
            <div class="bar-end">
                <Show when={waiting().length}>
                    <NeedsYou waiting={waiting()} />
                </Show>
                {p.end}
            </div>
        </header>
    );
}

export function Crumb(p: { children: JSX.Element; onClick?: () => void; title?: string }) {
    return (
        <Show when={p.onClick} fallback={<span class="bc static">{p.children}</span>}>
            <button class="bc" title={p.title} onClick={p.onClick}>
                {p.children}
            </button>
        </Show>
    );
}

export const CrumbSep = () => (
    <span class="bc-sep" aria-hidden="true">
        /
    </span>
);

/**
 * What changed in the session's folder: git's count, or Harness's own record of
 * its edits outside a repository. Opens (and closes) the diff reader.
 */
function ChangesChip(p: { handle: SessionHandle }) {
    const [git] = useGitChanges(() => p.handle);
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
                <>
                    <button
                        class={`hb diffchip ${review() ? "on" : ""}`}
                        title={`${review() ? "Close the changes" : "Review changes"}: ${plural(c().files, "changed file")}${c().atLeast ? " or more" : ""}`}
                        aria-label={`Changes: ${plural(c().files, "file")}, ${c().added} added, ${c().removed} removed`}
                        aria-pressed={!!review()}
                        onClick={() => (review() ? setReview(undefined) : openReview())}
                    >
                        <FileDiff size={15} />
                        <span class="a">+{c().added}</span>
                        <span class="d">−{c().removed}</span>
                    </button>
                    <span class="sep" />
                </>
            )}
        </Show>
    );
}

export function Header(p: { handle?: SessionHandle }) {
    const [editing, setEditing] = createSignal(false);
    const [menuOpen, setMenuOpen] = createSignal(false);
    let moreBtn: HTMLButtonElement | undefined;
    const st = () => p.handle?.view.state;
    const close = () => setMenuOpen(false);
    const copy = async (text: string, done: string) => {
        close();
        if (await copyText(text)) toast(done, "success");
    };
    // Another session in view: no rename carries over.
    createEffect(on(() => p.handle?.id, () => setEditing(false), { defer: true }));

    return (
        <TitleBar
            end={
                <>
                    <Show when={st()}>{(s) => <RunSwitcher id={s().id} />}</Show>
                    <div class="cap glass">
                        <Show when={p.handle}>{(h) => <ChangesChip handle={h()} />}</Show>
                        <Show when={st()?.cwd}>
                            {(cwd) => (
                                <>
                                    <ProjectScripts cwd={cwd()} />
                                    <span class="sep" />
                                </>
                            )}
                        </Show>
                        <button class={`hb ${terminalOpen() ? "on" : ""}`} title={withShortcut("Terminal", "app:toggleTerminal")} aria-label="Toggle terminal" aria-pressed={terminalOpen()} disabled={!st()?.cwd && !app.homeCwd} onClick={() => setTerminalOpen(!terminalOpen())}>
                            <PanelBottom size={16} />
                        </button>
                        <Show when={st()}>
                            <button class={`hb ${prefs.panel ? "on" : ""}`} title={withShortcut("Side panel", "app:togglePanel")} aria-label="Toggle panel" aria-pressed={prefs.panel} onClick={() => togglePanel()}>
                                <PanelRight size={16} />
                            </button>
                            <button ref={moreBtn} class="hb" title="More" aria-label="Session actions" aria-haspopup="menu" aria-expanded={menuOpen()} onClick={() => (setMenuOpen(!menuOpen()), menuOpen() && void refreshEditors())}>
                                <Ellipsis size={16} />
                            </button>
                        </Show>
                    </div>
                </>
            }
        >
            <Show when={st()} fallback={<h1 class="ttl-h">New session</h1>}>
                {(s) => (
                    <>
                        {/* With the rail hidden, the project goes before the title (and starts a session in it). */}
                        <button class="proj" title={`New session in ${s().projectName}`} onClick={() => newSession(s().cwd)}>
                            <span class="truncate">{s().projectName}</span>
                            <span class="proj-sep" aria-hidden="true">/</span>
                        </button>
                        <Show
                            when={!editing()}
                            fallback={
                                <input
                                    class="title-input"
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
                            <h1 class="ttl-h" title="Double-click to rename" onDblClick={() => (close(), setEditing(true))}>
                                {sessionTitle(p.handle)}
                            </h1>
                        </Show>
                        <Show when={s().branch}>
                            <span class="br" title="Git branch">
                                <GitBranch size={13} />
                                <span class="truncate">{s().branch}</span>
                            </span>
                        </Show>
                        <Show when={!s().trusted}>
                            <span class="pill warn" title="This folder's own configuration (hooks, MCP servers, permission rules) is ignored">
                                <ShieldAlert size={12} /> Untrusted
                            </span>
                        </Show>
                        <Menu label="Session actions" open={menuOpen()} anchor={() => moreBtn} onClose={close} align="end" width={244}>
                            <For
                                each={[
                                    { icon: Pencil, label: "Rename", run: () => void (close(), setEditing(true)) },
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
                                        <Show when={it.kbd && shortcut(it.kbd)}>{(k) => <kbd class="menu-kbd">{os === "macos" ? k().replaceAll("+", "") : k()}</kbd>}</Show>
                                    </button>
                                )}
                            </For>
                            <div class="menu-sep" />
                            <button role="menuitem" class="menu-item compact" onClick={() => (close(), void exportSession(s().id))}>
                                <Share size={14} /> Copy as Markdown
                            </button>
                            <button role="menuitem" class="menu-item compact" onClick={() => void copy(`harness --resume ${s().id}`, "Copied a command that resumes this session in the terminal")}>
                                <SquareTerminal size={14} /> Copy resume command
                            </button>
                            <Show when={s().branch}>
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
                            <button role="menuitem" class="menu-item compact danger" disabled={!p.handle?.view.turns.length} onClick={() => (close(), askDelete(p.handle))}>
                                <Trash2 size={14} /> Delete…
                            </button>
                        </Menu>
                    </>
                )}
            </Show>
        </TitleBar>
    );
}
