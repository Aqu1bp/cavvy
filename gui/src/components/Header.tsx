import { createSignal, Show } from "solid-js";
import { Archive, Copy, FileDiff, FolderGit2, GitBranch, History, MoreHorizontal, PanelLeftOpen, PanelRight, Share, Shrink } from "lucide-solid";
import type { SessionHandle } from "../state/app";
import { app, reportError, rpc, toast } from "../state/app";
import { archive, exportSession, rename, togglePanel, toggleSidebar } from "../state/actions";
import { prefs } from "../state/prefs";
import { setRewindOpen } from "../state/ui";
import { copyText, isTauri, mod, os } from "../lib/platform";
import { tildify, usd } from "../lib/format";
import { Popover } from "./ui/Popover";
import { Ring } from "./ui/bits";

export function Header(p: { handle?: SessionHandle }) {
    const [editing, setEditing] = createSignal(false);
    const [menuOpen, setMenuOpen] = createSignal(false);
    let moreBtn: HTMLButtonElement | undefined;
    const st = () => p.handle?.view.state;
    const title = () => st()?.title ?? p.handle?.view.turns.find((t) => t.prompt)?.prompt?.text.slice(0, 80) ?? "New session";
    const ctx = () => {
        const s = st();
        return s?.model?.contextWindow ? s.contextTokens / s.model.contextWindow : 0;
    };
    return (
        <header class={`header ${!prefs.sidebar && isTauri && os === "macos" ? "traffic" : ""}`} data-tauri-drag-region>
            <Show when={!prefs.sidebar}>
                <button class="icon-btn" title={`Show sidebar (${mod}+B)`} onClick={toggleSidebar}>
                    <PanelLeftOpen size={16} />
                </button>
            </Show>
            <Show when={st()} fallback={<div class="header-title muted" data-tauri-drag-region>New session</div>}>
                <div class="header-main" data-tauri-drag-region>
                    <Show
                        when={!editing()}
                        fallback={
                            <input
                                class="title-input"
                                value={title()}
                                ref={(el) => requestAnimationFrame(() => (el.focus(), el.select()))}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        void rename(st()!.id, e.currentTarget.value);
                                        setEditing(false);
                                    } else if (e.key === "Escape") setEditing(false);
                                }}
                                onBlur={(e) => {
                                    void rename(st()!.id, e.currentTarget.value);
                                    setEditing(false);
                                }}
                            />
                        }
                    >
                        <button class="header-title truncate" title="Rename" onClick={() => setEditing(true)}>
                            {title()}
                        </button>
                    </Show>
                    <span class="header-chips" data-tauri-drag-region>
                        <span class="chip" title={st()!.cwd}>
                            <FolderGit2 size={12} /> {st()!.projectName}
                        </span>
                        <Show when={st()!.branch}>
                            <span class="chip mono" title="Git branch">
                                <GitBranch size={12} /> {st()!.branch}
                            </span>
                        </Show>
                        <Show when={!st()!.trusted}>
                            <span class="chip warn" title="This folder's configuration is ignored">
                                untrusted
                            </span>
                        </Show>
                    </span>
                </div>
            </Show>
            <span class="grow" data-tauri-drag-region />
            <Show when={st()}>
                <div class="header-actions">
                    <Show when={st()!.filesChanged}>
                        <button class={`chip-btn ${prefs.panel && prefs.panelTab === "changes" ? "active" : ""}`} onClick={() => togglePanel("changes")} title="Files changed in this session">
                            <FileDiff size={13} /> {st()!.filesChanged} {st()!.filesChanged === 1 ? "file" : "files"}
                        </button>
                    </Show>
                    <button class={`chip-btn ${prefs.panel && prefs.panelTab === "context" ? "active" : ""}`} onClick={() => togglePanel("context")} title="Context and cost">
                        <Ring value={ctx()} size={14} stroke={2.2} />
                        <span>{st()!.cost > 0 ? usd(st()!.cost) : `${Math.round(ctx() * 100)}%`}</span>
                    </button>
                    <button class={`icon-btn ${prefs.panel ? "active" : ""}`} title={`Toggle panel (${mod}+.)`} onClick={() => togglePanel()}>
                        <PanelRight size={16} />
                    </button>
                    <button ref={moreBtn} class="icon-btn" title="More" onClick={() => setMenuOpen(!menuOpen())}>
                        <MoreHorizontal size={16} />
                    </button>
                    <Popover open={menuOpen()} anchor={() => moreBtn} onClose={() => setMenuOpen(false)} align="end" width={230}>
                        <button class="menu-item compact" onClick={() => { setMenuOpen(false); setRewindOpen(true); }}>
                            <History size={14} /> Rewind…
                        </button>
                        <button
                            class="menu-item compact"
                            disabled={st()!.busy}
                            onClick={() => {
                                setMenuOpen(false);
                                void rpc.call("session.compact", { id: st()!.id }).catch(reportError);
                            }}
                        >
                            <Shrink size={14} /> Compact conversation
                        </button>
                        <button class="menu-item compact" onClick={() => { setMenuOpen(false); void exportSession(st()!.id); }}>
                            <Share size={14} /> Copy as Markdown
                        </button>
                        <button
                            class="menu-item compact"
                            onClick={async () => {
                                setMenuOpen(false);
                                if (await copyText(`harness --resume ${st()!.id}`)) toast("Copied a command that resumes this session in the terminal", "success");
                            }}
                        >
                            <Copy size={14} /> Copy resume command
                        </button>
                        <div class="menu-sep" />
                        <div class="menu-note mono">{tildify(st()!.cwd, app.hello?.homeDir)}</div>
                        <div class="menu-sep" />
                        <button class="menu-item compact" onClick={() => { setMenuOpen(false); void archive(st()!.id, true); }}>
                            <Archive size={14} /> Archive
                        </button>
                    </Popover>
                </div>
            </Show>
        </header>
    );
}
