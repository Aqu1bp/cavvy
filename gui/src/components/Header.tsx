// The title line above the conversation: where you are (project / session),
// the session's menu on its title, and the panel toggle.

import { createSignal, For, Show, type JSX } from "solid-js";
import { Archive, ChevronDown, FolderOpen, History, PanelLeft, PanelRight, Pencil, Share, ShieldAlert, Shrink, SquareArrowOutUpRight, SquareTerminal, Trash2 } from "lucide-solid";
import type { SessionHandle } from "../state/app";
import { app, reportError, rpc, toast } from "../state/app";
import { archive, editorName, exportSession, newSession, openInEditor, refreshEditors, rename, togglePanel, toggleSidebar } from "../state/actions";
import { prefs } from "../state/prefs";
import { terminalOpen, setTerminalOpen, setRewindOpen, setDeleteRequest } from "../state/ui";
import { copyText, isTauri, os } from "../lib/platform";
import { tildify } from "../lib/format";
import { Monogram } from "./Sidebar";
import { Menu } from "./ui/Menu";
import { RunSwitcher } from "./RunSwitcher";
import { ProjectScripts } from "./ProjectScripts";
import { withShortcut } from "../state/keybindings";
import { promptPreview } from "../lib/review-comments";

type MenuEntry = { icon: typeof Pencil; label: string; disabled?: boolean; run: () => void };

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

/** The frame every main view shares: room for the traffic lights when the sidebar is hidden, the sidebar toggle, then the crumbs. */
export function TitleBar(p: { children: JSX.Element; end?: JSX.Element }) {
    return (
        <header class={`header ${!prefs.sidebar && isTauri && os === "macos" ? "traffic" : ""}`} data-tauri-drag-region>
            <Show when={!prefs.sidebar}>
                <button class="hb" title={withShortcut("Show sidebar", "app:toggleSidebar")} aria-label="Show sidebar" onClick={toggleSidebar}>
                    <PanelLeft size={16} />
                </button>
            </Show>
            <nav class="crumbs" aria-label="Breadcrumb" data-tauri-drag-region>
                {p.children}
            </nav>
            <span class="grow" data-tauri-drag-region />
            {p.end}
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

export function Header(p: { handle?: SessionHandle }) {
    const [editing, setEditing] = createSignal(false);
    const [menuOpen, setMenuOpen] = createSignal(false);
    let titleBtn: HTMLButtonElement | undefined;
    const st = () => p.handle?.view.state;
    const close = () => setMenuOpen(false);
    const copy = async (text: string, done: string) => {
        close();
        if (await copyText(text)) toast(done, "success");
    };

    return (
        <TitleBar
            end={
                <>
                    <Show when={st()}>{(s) => <RunSwitcher id={s().id} />}</Show>
                    <Show when={st()?.cwd}>{(cwd) => <ProjectScripts cwd={cwd()} />}</Show>
                    <button class={`hb ${terminalOpen() ? "on" : ""}`} title={withShortcut("Toggle terminal", "app:toggleTerminal")} aria-label="Toggle terminal" aria-pressed={terminalOpen()} disabled={!st()?.cwd && !app.homeCwd} onClick={() => setTerminalOpen(!terminalOpen())}><SquareTerminal size={16} /></button>
                    <Show when={st()}>
                        <button class={`hb ${prefs.panel ? "on" : ""}`} title={withShortcut("Toggle panel", "app:togglePanel")} aria-label="Toggle panel" aria-pressed={prefs.panel} onClick={() => togglePanel()}>
                            <PanelRight size={16} />
                        </button>
                    </Show>
                </>
            }
        >
            <Show when={st()} fallback={<span class="bc static current">New session</span>}>
                {(s) => (
                    <>
                        <Crumb title={`New session in ${s().projectName}`} onClick={() => newSession(s().cwd)}>
                            <Monogram name={s().projectName} size={14} />
                            <span class="truncate">{s().projectName}</span>
                        </Crumb>
                        <CrumbSep />
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
                            <button ref={titleBtn} class={`bct ${menuOpen() ? "open" : ""}`} aria-haspopup="menu" aria-expanded={menuOpen()} title="Session actions" onClick={() => (setMenuOpen(!menuOpen()), menuOpen() && void refreshEditors())} onDblClick={() => (close(), setEditing(true))}>
                                <span class="truncate">{sessionTitle(p.handle)}</span>
                                <ChevronDown size={14} class="chv" />
                            </button>
                        </Show>
                        <Show when={!s().trusted}>
                            <span class="pill warn" title="This folder's own configuration (hooks, MCP servers, permission rules) is ignored">
                                <ShieldAlert size={12} /> Untrusted
                            </span>
                        </Show>
                        <Menu label="Session actions" open={menuOpen()} anchor={() => titleBtn} onClose={close} width={244}>
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
                                ] as MenuEntry[]}
                            >
                                {(it) => (
                                    <button role="menuitem" class="menu-item compact" disabled={it.disabled} onClick={it.run}>
                                        <it.icon size={14} /> {it.label}
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
