// The title line above the conversation: where you are (project / session),
// the session's menu on its title, and the panel toggle.

import { createSignal, For, Show, type JSX } from "solid-js";
import { Archive, ChevronDown, FolderOpen, History, PanelLeft, PanelRight, Pencil, Share, ShieldAlert, Shrink, SquareTerminal } from "lucide-solid";
import type { SessionHandle } from "../state/app";
import { app, reportError, rpc, toast } from "../state/app";
import { archive, exportSession, newSession, rename, togglePanel, toggleSidebar } from "../state/actions";
import { prefs } from "../state/prefs";
import { setRewindOpen } from "../state/ui";
import { copyText, isTauri, mod, os } from "../lib/platform";
import { tildify } from "../lib/format";
import { Monogram } from "./Sidebar";
import { Popover } from "./ui/Popover";

type MenuEntry = { icon: typeof Pencil; label: string; disabled?: boolean; run: () => void };

export function sessionTitle(h?: SessionHandle): string {
    return h?.view.state.title ?? h?.view.turns.find((t) => t.prompt)?.prompt?.text.slice(0, 80) ?? "New session";
}

/** The frame every main view shares: room for the traffic lights when the sidebar is hidden, the sidebar toggle, then the crumbs. */
export function TitleBar(p: { children: JSX.Element; end?: JSX.Element }) {
    return (
        <header class={`header ${!prefs.sidebar && isTauri && os === "macos" ? "traffic" : ""}`} data-tauri-drag-region>
            <Show when={!prefs.sidebar}>
                <button class="hb" title={`Show sidebar (${mod}+B)`} aria-label="Show sidebar" onClick={toggleSidebar}>
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
                <Show when={st()}>
                    <button class={`hb ${prefs.panel ? "on" : ""}`} title={`Toggle panel (${mod}+.)`} aria-label="Toggle panel" aria-pressed={prefs.panel} onClick={() => togglePanel()}>
                        <PanelRight size={16} />
                    </button>
                </Show>
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
                            <button ref={titleBtn} class={`bct ${menuOpen() ? "open" : ""}`} aria-haspopup="menu" aria-expanded={menuOpen()} title="Session actions" onClick={() => setMenuOpen(!menuOpen())} onDblClick={() => (close(), setEditing(true))}>
                                <span class="truncate">{sessionTitle(p.handle)}</span>
                                <ChevronDown size={14} class="chv" />
                            </button>
                        </Show>
                        <Show when={!s().trusted}>
                            <span class="pill warn" title="This folder's own configuration (hooks, MCP servers, permission rules) is ignored">
                                <ShieldAlert size={12} /> Untrusted
                            </span>
                        </Show>
                        <Popover open={menuOpen()} anchor={() => titleBtn} onClose={close} width={244}>
                            <For
                                each={[
                                    { icon: Pencil, label: "Rename", run: () => void (close(), setEditing(true)) },
                                    { icon: History, label: "Rewind…", run: () => void (close(), setRewindOpen(true)) },
                                    {
                                        icon: Shrink,
                                        label: "Compact conversation",
                                        disabled: s().busy,
                                        run: () => void (close(), rpc.call("session.compact", { id: s().id }).catch(reportError)),
                                    },
                                ] as MenuEntry[]}
                            >
                                {(it) => (
                                    <button class="menu-item compact" disabled={it.disabled} onClick={it.run}>
                                        <it.icon size={14} /> {it.label}
                                    </button>
                                )}
                            </For>
                            <div class="menu-sep" />
                            <button class="menu-item compact" onClick={() => (close(), void exportSession(s().id))}>
                                <Share size={14} /> Copy as Markdown
                            </button>
                            <button class="menu-item compact" onClick={() => void copy(`harness --resume ${s().id}`, "Copied a command that resumes this session in the terminal")}>
                                <SquareTerminal size={14} /> Copy resume command
                            </button>
                            <button class="menu-item compact" title={s().cwd} onClick={() => void copy(s().cwd, `Copied ${tildify(s().cwd, app.hello?.homeDir)}`)}>
                                <FolderOpen size={14} /> Copy folder path
                            </button>
                            <div class="menu-sep" />
                            <button class="menu-item compact" onClick={() => (close(), void archive(s().id, true))}>
                                <Archive size={14} /> Archive
                            </button>
                        </Popover>
                    </>
                )}
            </Show>
        </TitleBar>
    );
}

