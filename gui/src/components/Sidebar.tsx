// The session list. Sessions still in play are cards: the project, what it's
// about, and its branch and model. Ones you've settled fold into a list at the
// bottom; sending to one brings it back.

import { createMemo, createSignal, For, Show } from "solid-js";
import { Archive, ArchiveRestore, Check, CheckCheck, ChevronUp, FolderPlus, ListFilter, MoreHorizontal, PanelLeftClose, Pencil, Pin, PinOff, Plus, Search, Settings, SquarePen, Trash2, Undo2 } from "lucide-solid";
import type { SessionSummary } from "@shared/protocol";
import { activate, app, handleFor, isUnread } from "../state/app";
import { archive, chooseProject, newSession, openProject, pin, rename, settle, toggleSidebar } from "../state/actions";
import { prefs, setPrefs } from "../state/prefs";
import { setDeleteRequest, setPaletteOpen, setSettingsTab } from "../state/ui";
import { ago, duration, monogram, since } from "../lib/format";
import { now } from "../lib/clock";
import { isTauri, mod, os } from "../lib/platform";
import { Menu } from "./ui/Menu";
import { rowMenuKey } from "../lib/menu";
import { ProviderIcon } from "./ui/ProviderIcon";

/** Cards shown before "Show more". */
const PAGE = 25;

export function Monogram(p: { name: string; size?: number }) {
    return (
        <span class="mg" style={p.size ? { width: `${p.size}px`, height: `${p.size}px`, "font-size": `${(p.size * 0.47).toFixed(1)}px` } : undefined} aria-hidden="true">
            {monogram(p.name)}
        </span>
    );
}

function branchOf(s: SessionSummary): string | undefined {
    if (s.id === app.activeId) return handleFor(s.id)?.view.state.branch;
    return handleFor(s.id)?.view.state.branch ?? app.projects.find((p) => p.path === s.cwd)?.branch;
}

/** What it's doing, when that's worth a word; otherwise its card shows how long ago. */
function statusWord(s: SessionSummary): { text: string; tone: string } | undefined {
    if (s.status === "waiting") return { text: "Needs you", tone: "warn" };
    if (s.status === "running") {
        const since = handleFor(s.id)?.view.state.activity?.since;
        const ms = since ? now() - since : 0;
        return { text: ms >= 1000 ? `Working ${duration(ms).replace(/ \d+s$/, "")}` : "Working", tone: "info" };
    }
    if (s.status === "error") return { text: "Stopped", tone: "err" };
    return undefined;
}

/** The model it last used: the open session's own, else the one it was saved with. */
function modelOf(s: SessionSummary): string | undefined {
    return handleFor(s.id)?.view.state.model?.ref ?? s.model;
}

function useRename(s: () => SessionSummary) {
    const [editing, setEditing] = createSignal(false);
    const input = () => (
        <input
            class="sess-rename"
            value={s().title}
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
    );
    return { editing, setEditing, input };
}

function RowMenu(p: { s: SessionSummary; open: boolean; setOpen: (v: boolean) => void; anchor: () => HTMLElement | undefined; returnFocus: () => HTMLElement | undefined; point?: { x: number; y: number }; onRename: () => void }) {
    const close = () => p.setOpen(false);
    return (
        <Menu label="Session actions" returnFocus={p.returnFocus} point={p.point} open={p.open} anchor={p.anchor} onClose={close} align="end" width={220}>
            <button role="menuitem" class="menu-item compact" onClick={() => (close(), p.onRename())}>
                <Pencil size={14} /> Rename
            </button>
            <button role="menuitem" class="menu-item compact" onClick={() => (close(), void pin(p.s.id, !p.s.pinned))}>
                {p.s.pinned ? <PinOff size={14} /> : <Pin size={14} />} {p.s.pinned ? "Unpin" : "Pin"}
            </button>
            <Show when={!p.s.archived}>
                <button role="menuitem" class="menu-item compact" onClick={() => (close(), void settle(p.s.id, !p.s.settled))}>
                    {p.s.settled ? <Undo2 size={14} /> : <CheckCheck size={14} />} {p.s.settled ? "Back in play" : "Settle"}
                </button>
            </Show>
            <button role="menuitem" class="menu-item compact" onClick={() => (close(), newSession(p.s.cwd))}>
                <Plus size={14} /> <span class="truncate">New session in {p.s.projectName}</span>
            </button>
            <div class="menu-sep" />
            <button role="menuitem" class="menu-item compact" onClick={() => (close(), void archive(p.s.id, !p.s.archived))}>
                {p.s.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />} {p.s.archived ? "Restore" : "Archive"}
            </button>
            <button role="menuitem" class="menu-item compact danger" onClick={() => (close(), setDeleteRequest({ id: p.s.id, title: p.s.title, projectName: p.s.projectName }))}>
                <Trash2 size={14} /> Delete…
            </button>
        </Menu>
    );
}

/** Both row layouts use the same pointer/keyboard invocation and focus target. */
function useRowMenu(more: () => HTMLElement | undefined) {
    const [menu, setMenu] = createSignal(false);
    const [point, setPoint] = createSignal<{ x: number; y: number }>();
    let returnTo: HTMLElement | undefined;
    const contextMenu = (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
        e.preventDefault();
        returnTo = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(".card-hit, .slim-hit") ?? more();
        setPoint(e.button === 2 ? { x: e.clientX, y: e.clientY } : undefined);
        setMenu(true);
    };
    const contextKey = (e: KeyboardEvent) => rowMenuKey(e, () => {
        returnTo = e.target as HTMLElement;
        setPoint(undefined);
        setMenu(true);
    });
    const toggleMenu = () => {
        returnTo = more();
        setPoint(undefined);
        setMenu(!menu());
    };
    return { menu, setMenu, point, contextMenu, contextKey, toggleMenu, returnFocus: () => returnTo };
}

function SessionCard(p: { s: SessionSummary }) {
    const r = useRename(() => p.s);
    const { menu, setMenu, point, contextMenu, contextKey, toggleMenu, returnFocus } = useRowMenu(() => more);
    let el: HTMLDivElement | undefined;
    let more: HTMLButtonElement | undefined;
    const current = () => app.activeId === p.s.id;
    const word = () => statusWord(p.s);
    const unread = () => isUnread(p.s) && !current();
    const provider = () => modelOf(p.s)?.split(":")[0];
    // Working in the background: it's fine, it can recede.
    const recede = () => p.s.status === "running" && !current();
    return (
        <div
            ref={el}
            class={`card ${current() ? "cur" : ""} ${recede() ? "rec" : ""} ${menu() ? "menu-open" : ""}`}
            onContextMenu={contextMenu} onKeyDown={contextKey}
        >
            <button class="card-hit" onClick={() => void activate(p.s.id)} onDblClick={() => r.setEditing(true)} aria-current={current() ? "page" : undefined} title={`${p.s.title}\n${p.s.cwd}`}>
                <span class="l1">
                    <Monogram name={p.s.projectName} />
                    <span class="truncate">{p.s.projectName}</span>
                    <Show when={word()} fallback={<span class={`st when ${unread() ? "unread" : ""}`}>{(now(), since(p.s.updatedAt))}</span>}>
                        {(w) => <span class={`st tone-${w().tone}`}>{w().text}</span>}
                    </Show>
                </span>
                <Show when={!r.editing()} fallback={<span class="l2" />}>
                    <span class="l2 truncate">
                        <Show when={p.s.pinned}>
                            <Pin size={12} class="card-pin" />
                        </Show>
                        {p.s.title}
                    </span>
                </Show>
                <span class="l3">
                    <span class="truncate">{branchOf(p.s)}</span>
                    <Show when={provider()}>
                        {(id) => (
                            <span class="card-model" title={modelOf(p.s)}>
                                <ProviderIcon id={id()} name={app.models.find((g) => g.provider === id())?.providerName} size={14} />
                            </span>
                        )}
                    </Show>
                </span>
            </button>
            <button ref={more} class="hb sm card-more" title="More" aria-label={`More for ${p.s.title}`} aria-haspopup="menu" aria-expanded={menu()} onClick={toggleMenu}>
                <MoreHorizontal size={14} />
            </button>
            <Show when={r.editing()}>
                <div class="card-rename">{r.input()}</div>
            </Show>
            <RowMenu returnFocus={returnFocus} point={point()} s={p.s} open={menu()} setOpen={setMenu} anchor={() => more ?? el} onRename={() => r.setEditing(true)} />
        </div>
    );
}

function SessionRow(p: { s: SessionSummary }) {
    const r = useRename(() => p.s);
    const { menu, setMenu, point, contextMenu, contextKey, toggleMenu, returnFocus } = useRowMenu(() => more);
    let more: HTMLButtonElement | undefined;
    const current = () => app.activeId === p.s.id;
    return (
        <div class={`slim ${current() ? "cur" : ""} ${menu() ? "menu-open" : ""}`} onContextMenu={contextMenu} onKeyDown={contextKey}>
            <Show
                when={!r.editing()}
                fallback={
                    <>
                        <Monogram name={p.s.projectName} />
                        {r.input()}
                    </>
                }
            >
                <button
                    class="slim-hit"
                    onClick={() => void activate(p.s.id)}
                    onDblClick={() => r.setEditing(true)}
                    aria-current={current() ? "page" : undefined}
                    title={`${p.s.title}\n${p.s.cwd}\nUpdated ${(now(), ago(p.s.updatedAt))}`}
                >
                    <Monogram name={p.s.projectName} />
                    <Show when={p.s.pinned}>
                        <Pin size={12} class="slim-pin" />
                    </Show>
                    <span class="truncate">{p.s.title}</span>
                </button>
                <span class="slim-end">
                    <span class="t">{(now(), since(p.s.updatedAt))}</span>
                    <span class="slim-acts">
                        <button class="hb sm" title={p.s.pinned ? "Unpin" : "Pin"} aria-label={p.s.pinned ? "Unpin" : "Pin"} onClick={() => void pin(p.s.id, !p.s.pinned)}>
                            <Show when={p.s.pinned} fallback={<Pin size={13} />}>
                                <PinOff size={13} />
                            </Show>
                        </button>
                        <button ref={more} class="hb sm" title="More" aria-label="More" aria-haspopup="menu" aria-expanded={menu()} onClick={toggleMenu}>
                            <MoreHorizontal size={14} />
                        </button>
                    </span>
                </span>
            </Show>
            <RowMenu returnFocus={returnFocus} point={point()} s={p.s} open={menu()} setOpen={setMenu} anchor={() => more} onRename={() => r.setEditing(true)} />
        </div>
    );
}

/** The top line, level with the traffic lights (macOS): hide, then the name. Shared with the Settings sidebar. */
export function SidebarTop() {
    return (
        <div class="side-top" data-tauri-drag-region>
            <button class="hb" title={`Hide sidebar (${mod}+B)`} aria-label="Hide sidebar" onClick={toggleSidebar}>
                <PanelLeftClose size={17} />
            </button>
            <span class="brand" data-tauri-drag-region>
                Harness
            </span>
        </div>
    );
}

export function SidebarFrame(p: { children: any; class?: string }) {
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
        <aside class={`sidebar ${isTauri && os === "macos" ? "traffic" : ""} ${p.class ?? ""}`} aria-label="Sessions">
            <SidebarTop />
            {p.children}
            <div class="resize-handle" onPointerDown={onResize} onDblClick={() => setPrefs("sidebarWidth", 260)} />
        </aside>
    );
}

export function Sidebar() {
    const [showArchived, setShowArchived] = createSignal(false);
    const [viewOpen, setViewOpen] = createSignal(false);
    const [shown, setShown] = createSignal(PAGE);
    let viewBtn: HTMLButtonElement | undefined;

    const pinnedFirst = (list: SessionSummary[]) => [...list.filter((s) => s.pinned), ...list.filter((s) => !s.pinned)];
    const cards = createMemo(() => (showArchived() ? [] : pinnedFirst(app.sessions.filter((s) => !s.settled))));
    const settledList = createMemo(() => (showArchived() ? [] : app.sessions.filter((s) => s.settled)));
    const byProject = createMemo(() => {
        const out: { name: string; cwd: string; sessions: SessionSummary[] }[] = [];
        const by = new Map<string, SessionSummary[]>();
        for (const s of cards()) {
            if (!by.has(s.projectName)) {
                by.set(s.projectName, []);
                out.push({ name: s.projectName, cwd: s.cwd, sessions: by.get(s.projectName)! });
            }
            by.get(s.projectName)!.push(s);
        }
        return out;
    });

    return (
        <SidebarFrame>
            <div class="side-tools">
                <button class="side-search" title={`Search sessions, messages and actions (${mod}+K)`} onClick={() => setPaletteOpen(true)}>
                    <Search size={16} />
                    <span>Search</span>
                    <span class="side-kbd">{mod}K</span>
                </button>
                <button ref={viewBtn} class={`hb ${viewOpen() ? "on" : ""}`} title="View options" aria-label="View options" aria-haspopup="menu" aria-expanded={viewOpen()} onClick={() => setViewOpen(!viewOpen())}>
                    <ListFilter size={16} />
                </button>
                <button
                    class="hb"
                    title="Open project…"
                    aria-label="Open project"
                    onClick={async () => {
                        const path = await chooseProject();
                        if (path) void openProject(path);
                    }}
                >
                    <FolderPlus size={16} />
                </button>
                <button class="hb" title={`New session (${mod}+N)`} aria-label="New session" onClick={() => newSession(app.homeCwd)}>
                    <SquarePen size={16} />
                </button>
                <Menu label="View options" open={viewOpen()} anchor={() => viewBtn} onClose={() => setViewOpen(false)} align="end" width={220}>
                    <div class="menu-head">Group</div>
                    <button role="menuitemradio" aria-checked={prefs.groupBy === "date"} class="menu-item compact" onClick={() => (setPrefs("groupBy", "date"), setViewOpen(false))}>
                        <span class="menu-label">Most recent first</span>
                        <Show when={prefs.groupBy === "date"}>
                            <Check size={14} class="menu-check" />
                        </Show>
                    </button>
                    <button role="menuitemradio" aria-checked={prefs.groupBy === "project"} class="menu-item compact" onClick={() => (setPrefs("groupBy", "project"), setViewOpen(false))}>
                        <span class="menu-label">By project</span>
                        <Show when={prefs.groupBy === "project"}>
                            <Check size={14} class="menu-check" />
                        </Show>
                    </button>
                    <div class="menu-sep" />
                    <button role="menuitem" class="menu-item compact" onClick={() => (setShowArchived(!showArchived()), setViewOpen(false))}>
                        <Archive size={14} /> {showArchived() ? "Show active sessions" : `Show archived (${app.archived.length})`}
                    </button>
                </Menu>
            </div>

            <nav class="side-list" aria-label="Session list">
                <Show when={showArchived()}>
                    <div class="shelf">
                        <span>Archived</span>
                        <i />
                        <button class="shelf-btn" onClick={() => setShowArchived(false)}>
                            Done
                        </button>
                    </div>
                    <For each={app.archived}>{(s) => <SessionRow s={s} />}</For>
                </Show>
                <Show
                    when={prefs.groupBy === "project"}
                    fallback={
                        <>
                            <For each={cards().slice(0, shown())}>{(s) => <SessionCard s={s} />}</For>
                            <Show when={cards().length > shown()}>
                                <button class="slim more" onClick={() => setShown((n) => n + PAGE)}>
                                    <Plus size={14} />
                                    <span>Show {Math.min(PAGE, cards().length - shown())} more</span>
                                </button>
                            </Show>
                        </>
                    }
                >
                    <For each={byProject()}>
                        {(g) => (
                            <>
                                <div class="shelf">
                                    <span class="truncate">{g.name}</span>
                                    <i />
                                    <button class="shelf-btn" title={`New session in ${g.name}`} aria-label={`New session in ${g.name}`} onClick={() => newSession(g.cwd)}>
                                        <Plus size={13} />
                                    </button>
                                </div>
                                <For each={g.sessions}>{(s) => <SessionCard s={s} />}</For>
                            </>
                        )}
                    </For>
                </Show>
                <Show when={settledList().length}>
                    <div class="side-grow" />
                    <button class="shelf settled-head" aria-expanded={prefs.settledOpen} onClick={() => setPrefs("settledOpen", !prefs.settledOpen)}>
                        <span>Settled</span>
                        <i />
                        <ChevronUp size={14} class={`settled-chev ${prefs.settledOpen ? "" : "closed"}`} />
                    </button>
                    <Show when={prefs.settledOpen}>
                        <For each={settledList()}>{(s) => <SessionRow s={s} />}</For>
                    </Show>
                </Show>
                <Show when={!showArchived() && !cards().length && !settledList().length}>
                    <div class="side-empty">{app.conn === "open" ? "No sessions yet. Start one from the composer." : "Connecting…"}</div>
                </Show>
                <Show when={showArchived() && !app.archived.length}>
                    <div class="side-empty">Nothing archived.</div>
                </Show>
            </nav>

            <div class="side-foot">
                <span class={`conn conn-${app.conn}`} />
                <span class="side-foot-text truncate" title={app.hello ? `${app.hello.user}@${app.hello.host}\n${app.hello.home}` : undefined}>
                    {app.conn === "open" ? "This computer" : "Reconnecting…"}
                </span>
                <span class="grow" />
                <button class="hb lg" title={`Settings (${mod}+,)`} aria-label="Settings" onClick={() => setSettingsTab("general")}>
                    <Settings size={16} />
                </button>
            </div>
        </SidebarFrame>
    );
}
