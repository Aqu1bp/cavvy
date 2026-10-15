import { createMemo, createSignal, For, Show } from "solid-js";
import { Archive, ArchiveRestore, Check, CircleDot, FolderOpen, Layers, ListFilter, MoreHorizontal, PanelLeftClose, Pencil, Pin, PinOff, Plus, Search, Settings } from "lucide-solid";
import type { SessionSummary } from "@shared/protocol";
import { activate, app, isUnread } from "../state/app";
import { archive, chooseProject, newSession, openProject, pin, rename, toggleSidebar } from "../state/actions";
import { prefs, setPrefs } from "../state/prefs";
import { setPaletteOpen, setSettingsTab } from "../state/ui";
import { ago, dayGroup } from "../lib/format";
import { now } from "../lib/clock";
import { isTauri, mod, os } from "../lib/platform";
import { Popover } from "./ui/Popover";
import { Kbd, Logo, Spinner } from "./ui/bits";

function StatusMark(p: { s: SessionSummary }) {
    return (
        <span class="sess-mark">
            <Show when={p.s.status === "running"} fallback={<Show when={p.s.status === "waiting"} fallback={<Show when={p.s.status === "error"}><span class="dot err" title="Stopped with an error" /></Show>}><span class="dot warn pulse" title="Waiting for you" /></Show>}>
                <Spinner size={12} class="tone-accent" />
            </Show>
        </span>
    );
}

function SessionRow(p: { s: SessionSummary }) {
    const [editing, setEditing] = createSignal(false);
    const [menuOpen, setMenuOpen] = createSignal(false);
    let more: HTMLButtonElement | undefined;
    const active = () => app.activeId === p.s.id;
    const unread = () => isUnread(p.s);
    return (
        <div class={`sess ${active() ? "active" : ""} ${unread() ? "unread" : ""} ${menuOpen() ? "menu-open" : ""}`}>
            <Show
                when={!editing()}
                fallback={
                    <input
                        class="sess-rename"
                        value={p.s.title}
                        ref={(el) => requestAnimationFrame(() => (el.focus(), el.select()))}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                void rename(p.s.id, e.currentTarget.value);
                                setEditing(false);
                            } else if (e.key === "Escape") setEditing(false);
                        }}
                        onBlur={(e) => {
                            void rename(p.s.id, e.currentTarget.value);
                            setEditing(false);
                        }}
                    />
                }
            >
                <button class="sess-main" onClick={() => void activate(p.s.id)} onDblClick={() => setEditing(true)} title={`${p.s.title}\n${p.s.cwd}`}>
                    <StatusMark s={p.s} />
                    <span class="sess-title truncate">{p.s.title}</span>
                    <Show when={prefs.groupBy === "date" && app.projects.length > 1}>
                        <span class="sess-proj truncate">{p.s.projectName}</span>
                    </Show>
                    <span class="sess-time">{(now(), ago(p.s.updatedAt))}</span>
                    <Show when={unread()}>
                        <span class="dot accent" title="New activity" />
                    </Show>
                </button>
                <span class="sess-actions">
                    <button class="icon-btn" title={p.s.pinned ? "Unpin" : "Pin"} onClick={() => void pin(p.s.id, !p.s.pinned)}>
                        <Show when={p.s.pinned} fallback={<Pin size={13} />}>
                            <PinOff size={13} />
                        </Show>
                    </button>
                    <button ref={more} class="icon-btn" title="More" onClick={() => setMenuOpen(!menuOpen())}>
                        <MoreHorizontal size={14} />
                    </button>
                </span>
                <Popover open={menuOpen()} anchor={() => more} onClose={() => setMenuOpen(false)} align="end" width={200}>
                    <button class="menu-item compact" onClick={() => { setMenuOpen(false); setEditing(true); }}>
                        <Pencil size={14} /> Rename
                    </button>
                    <button class="menu-item compact" onClick={() => { setMenuOpen(false); void pin(p.s.id, !p.s.pinned); }}>
                        {p.s.pinned ? <PinOff size={14} /> : <Pin size={14} />} {p.s.pinned ? "Unpin" : "Pin"}
                    </button>
                    <button class="menu-item compact" onClick={() => { setMenuOpen(false); newSession(p.s.cwd); }}>
                        <Plus size={14} /> New session in {p.s.projectName}
                    </button>
                    <div class="menu-sep" />
                    <button class="menu-item compact" onClick={() => { setMenuOpen(false); void archive(p.s.id, !p.s.archived); }}>
                        {p.s.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />} {p.s.archived ? "Restore" : "Archive"}
                    </button>
                </Popover>
            </Show>
        </div>
    );
}

export function Sidebar() {
    const [showArchived, setShowArchived] = createSignal(false);
    const [filterOpen, setFilterOpen] = createSignal(false);
    let filterBtn: HTMLButtonElement | undefined;
    const list = () => (showArchived() ? app.archived : app.sessions);
    const pinned = createMemo(() => (showArchived() ? [] : list().filter((s) => s.pinned)));
    const groups = createMemo(() => {
        const rest = showArchived() ? list() : list().filter((s) => !s.pinned);
        const out: { label: string; sessions: SessionSummary[] }[] = [];
        const by = new Map<string, SessionSummary[]>();
        for (const s of rest) {
            const k = prefs.groupBy === "project" ? s.projectName : dayGroup(s.updatedAt);
            if (!by.has(k)) {
                by.set(k, []);
                out.push({ label: k, sessions: by.get(k)! });
            }
            by.get(k)!.push(s);
        }
        return out;
    });
    const waiting = () => app.sessions.filter((s) => s.status === "waiting").length;

    let dragStart = 0;
    let widthStart = 0;
    const onResize = (e: PointerEvent) => {
        dragStart = e.clientX;
        widthStart = prefs.sidebarWidth;
        const move = (ev: PointerEvent) => setPrefs("sidebarWidth", Math.max(220, Math.min(420, widthStart + ev.clientX - dragStart)));
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            document.body.classList.remove("resizing");
        };
        document.body.classList.add("resizing");
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };

    return (
        <aside class={`sidebar ${isTauri && os === "macos" ? "traffic" : ""}`}>
            <div class="sidebar-top" data-tauri-drag-region>
                <div class="brand" data-tauri-drag-region>
                    <Logo size={22} />
                    <span class="brand-name">Harness</span>
                </div>
                <span class="grow" data-tauri-drag-region />
                <button class="icon-btn" title={`Hide sidebar (${mod}+B)`} onClick={toggleSidebar}>
                    <PanelLeftClose size={16} />
                </button>
            </div>
            <nav class="side-nav">
                <button class="nav-item" onClick={() => newSession(app.homeCwd)}>
                    <Plus size={16} />
                    <span>New session</span>
                    <Kbd keys={`${mod}+N`} />
                </button>
                <button class="nav-item" onClick={() => setPaletteOpen(true)}>
                    <Search size={16} />
                    <span>Search</span>
                    <Kbd keys={`${mod}+K`} />
                </button>
                <button
                    class="nav-item"
                    onClick={async () => {
                        const path = await chooseProject();
                        if (path) void openProject(path);
                    }}
                >
                    <FolderOpen size={16} />
                    <span>Open project…</span>
                </button>
            </nav>
            <div class="side-section-head">
                <span>{showArchived() ? "Archived" : "Sessions"}</span>
                <Show when={waiting()}>
                    <span class="badge warn" title="Sessions waiting for you">
                        {waiting()}
                    </span>
                </Show>
                <span class="grow" />
                <button ref={filterBtn} class="icon-btn" title="View options" onClick={() => setFilterOpen(!filterOpen())}>
                    <ListFilter size={14} />
                </button>
                <button class="icon-btn" title="New session" onClick={() => newSession(app.homeCwd)}>
                    <Plus size={15} />
                </button>
                <Popover open={filterOpen()} anchor={() => filterBtn} onClose={() => setFilterOpen(false)} align="end" width={210}>
                    <div class="menu-head">Group by</div>
                    <button class="menu-item compact" onClick={() => setPrefs("groupBy", "date")}>
                        <CircleDot size={14} /> Date <Show when={prefs.groupBy === "date"}><Check size={14} class="menu-check" /></Show>
                    </button>
                    <button class="menu-item compact" onClick={() => setPrefs("groupBy", "project")}>
                        <Layers size={14} /> Project <Show when={prefs.groupBy === "project"}><Check size={14} class="menu-check" /></Show>
                    </button>
                    <div class="menu-sep" />
                    <button class="menu-item compact" onClick={() => { setShowArchived(!showArchived()); setFilterOpen(false); }}>
                        <Archive size={14} /> {showArchived() ? "Show active sessions" : `Show archived (${app.archived.length})`}
                    </button>
                </Popover>
            </div>
            <div class="side-scroll">
                <Show when={pinned().length}>
                    <div class="side-group">
                        <div class="side-group-label">
                            <Pin size={12} /> Pinned
                        </div>
                        <For each={pinned()}>{(s) => <SessionRow s={s} />}</For>
                    </div>
                </Show>
                <For each={groups()}>
                    {(g) => (
                        <div class="side-group">
                            <div class="side-group-label">{g.label}</div>
                            <For each={g.sessions}>{(s) => <SessionRow s={s} />}</For>
                        </div>
                    )}
                </For>
                <Show when={!list().length}>
                    <div class="side-empty">{showArchived() ? "Nothing archived." : app.conn === "open" ? "No sessions yet. Start one from the composer." : "Connecting…"}</div>
                </Show>
            </div>
            <div class="sidebar-foot">
                <button class="nav-item" onClick={() => setSettingsTab("general")}>
                    <Settings size={16} />
                    <span>Settings</span>
                    <Kbd keys={`${mod}+,`} />
                </button>
                <span class={`conn conn-${app.conn}`} title={app.conn === "open" ? "Connected" : app.conn} />
            </div>
            <div class="resize-handle" onPointerDown={onResize} />
        </aside>
    );
}
