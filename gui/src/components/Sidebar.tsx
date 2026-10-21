// The session rail, straight on the window glass. Sessions still in play are
// two-line rows: how it's doing, what it's about, when; then its branch (and
// project, when the list isn't grouped by project). Ones you've settled fold
// into a one-line list at the bottom; sending to one brings it back.

import { batch, createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch, untrack } from "solid-js";
import { Archive, ArchiveRestore, Check, CheckCheck, ChevronUp, CircleAlert, Folder, FolderPlus, Hand, Layers, ListFilter, MessageSquareText, MoreHorizontal, PanelLeft, Pencil, Pin, PinOff, Plus, Search, Settings, SquarePen, Trash2, Undo2 } from "lucide-solid";
import type { SessionSummary } from "@shared/protocol";
import { activate, app, handleFor, isUnread, refreshSessions, reportError } from "../state/app";
import { archive, chooseProject, newSession, openProject, pin, rename, settle, toggleSidebar } from "../state/actions";
import { prefs, setPrefs } from "../state/prefs";
import { setDeleteRequest, setPaletteOpen, setSettingsTab } from "../state/ui";
import { ago, monogram, projectColor, since } from "../lib/format";
import { holdSidebar, sidebarEntries, sidebarIds, SESSION_PAGE, type SidebarEntry } from "../lib/session-order";
import { sessionStatus } from "../lib/session-status";
import { groupCounts, railFoot, railGlyph, type RailGlyph } from "../lib/rail";
import { setSidebarOrder } from "../state/sidebar";
import { now } from "../lib/clock";
import { isTauri, os } from "../lib/platform";
import { Menu } from "./ui/Menu";
import { rowMenuKey } from "../lib/menu";
import { ProviderIcon } from "./ui/ProviderIcon";
import { shortcut, withShortcut } from "../state/keybindings";

/** Cards shown before "Show more". */
const PAGE = SESSION_PAGE;

export function Monogram(p: { name: string; cwd?: string; label?: string; size?: number }) {
    return (
        <span class="mg" style={{ "background-color": projectColor(p.cwd ?? p.name),
            ...(p.size ? { width: `${p.size}px`, height: `${p.size}px`, "font-size": `${(p.size * 0.47).toFixed(1)}px` } : {}),
        }} aria-hidden="true">
            {p.label ?? monogram(p.name)}
        </span>
    );
}

function branchOf(s: SessionSummary): string | undefined {
    if (s.id === app.activeId) return handleFor(s.id)?.view.state.branch;
    return handleFor(s.id)?.view.state.branch ?? app.projects.find((p) => p.path === s.cwd)?.branch;
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
            <button role="menuitem" class="menu-item compact" onClick={() => batch(() => { p.onRename(); close(); })}>
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

/** How a session is doing, at the start of its row. */
function Glyph(p: { kind: RailGlyph }) {
    return (
        <span class={`st ${p.kind}`} aria-hidden="true">
            <Switch fallback={<MessageSquareText size={15} />}>
                <Match when={p.kind === "running"}><span class="spin-ring" /></Match>
                <Match when={p.kind === "waiting"}><Hand size={15} /></Match>
                <Match when={p.kind === "done"}><Check size={15} stroke-width={2} /></Match>
                <Match when={p.kind === "error"}><CircleAlert size={15} /></Match>
                <Match when={p.kind === "new"}><SquarePen size={15} /></Match>
            </Switch>
        </span>
    );
}

/** What a screen reader hears for a row: its title, then how it's doing. */
function rowLabel(s: SessionSummary, unread: boolean): string {
    const word = sessionStatus(s, now())?.text;
    return [s.run ? `${s.run.modelName} · ${s.title}` : s.title, s.status === "idle" ? (unread ? "unread" : undefined) : word, s.pinned ? "pinned" : undefined].filter(Boolean).join(", ");
}

/** The right end of a row: an amber dot while it needs you, else when it last moved (with a dot when unread). */
function RowEnd(p: { s: SessionSummary; unread: boolean }) {
    return (
        <Show when={p.s.status !== "waiting"} fallback={<span class="wait-dot" title={sessionStatus(p.s, now())?.text} />}>
            <Show when={p.unread}>
                <span class="unread-dot" />
            </Show>
            <span class="when">{p.s.status === "running" ? "now" : (now(), since(p.s.updatedAt))}</span>
        </Show>
    );
}

function SessionCard(p: { s: SessionSummary; hold: (id: string, held: boolean) => void; grouped: boolean }) {
    const r = useRename(() => p.s);
    const { menu, setMenu, point, contextMenu, contextKey, toggleMenu, returnFocus } = useRowMenu(() => more);
    const id = p.s.id;
    createEffect(() => p.hold(id, menu() || r.editing()));
    onCleanup(() => p.hold(id, false));
    let el: HTMLDivElement | undefined;
    let more: HTMLButtonElement | undefined;
    const current = () => app.activeId === p.s.id;
    const unread = () => isUnread(p.s) && !current();
    const waiting = () => p.s.status === "waiting";
    const provider = () => modelOf(p.s)?.split(":")[0];
    // Working in the background: it's fine, it can recede.
    const recede = () => p.s.status === "running" && !current();
    // Grouped by project, the heading names it; listed by date, the row does.
    const where = () => [p.grouped ? undefined : p.s.projectName, branchOf(p.s)].filter(Boolean).join(" · ") || p.s.projectName;
    return (
        <div
            ref={el}
            class={`card ${current() ? "cur" : ""} ${recede() ? "rec" : ""} ${unread() ? "unread" : ""} ${waiting() ? "waiting" : ""} ${menu() ? "menu-open" : ""}`}
            onContextMenu={contextMenu} onKeyDown={contextKey}
        >
            <button class="card-hit" onClick={() => void activate(p.s.id)} onDblClick={() => r.setEditing(true)} aria-current={current() ? "page" : undefined} aria-label={rowLabel(p.s, unread())} title={`${p.s.title}\n${p.s.cwd}`}>
                <Glyph kind={railGlyph(p.s, unread())} />
                <span class="t">
                    {/* A run's sessions all start from one prompt (the group's label): each says which model it is. */}
                    <Show when={!r.editing()}>{p.s.run ? p.s.run.modelName : p.s.title}</Show>
                </span>
                <span class="end">
                    <RowEnd s={p.s} unread={unread()} />
                </span>
                <span class="m">
                    <Show when={p.s.pinned}>
                        <Pin size={11} class="card-pin" />
                    </Show>
                    <span class="truncate">{where()}</span>
                    <Show when={provider()}>
                        {(id) => (
                            <span class="card-model" title={modelOf(p.s)}>
                                <ProviderIcon id={id()} name={app.models.find((g) => g.provider === id())?.providerName} size={12} />
                            </span>
                        )}
                    </Show>
                </span>
            </button>
            <span class="sess-acts">
                {/* A session waiting for you isn't archived from under its question. */}
                <Show when={!waiting() && !p.s.archived}>
                    <button class="hb sm" title="Archive" aria-label={`Archive ${p.s.title}`} onClick={() => void archive(p.s.id, true)}>
                        <Archive size={14} />
                    </button>
                </Show>
                <button ref={more} class="hb sm card-more" title="More" aria-label={`More for ${p.s.title}`} aria-haspopup="menu" aria-expanded={menu()} onClick={toggleMenu}>
                    <MoreHorizontal size={14} />
                </button>
            </span>
            <Show when={r.editing()}>
                <div class="card-rename">{r.input()}</div>
            </Show>
            <RowMenu returnFocus={returnFocus} point={point()} s={p.s} open={menu()} setOpen={setMenu} anchor={() => more ?? el} onRename={() => r.setEditing(true)} />
        </div>
    );
}

function SessionRow(p: { s: SessionSummary; hold: (id: string, held: boolean) => void }) {
    const r = useRename(() => p.s);
    const { menu, setMenu, point, contextMenu, contextKey, toggleMenu, returnFocus } = useRowMenu(() => more);
    const id = p.s.id;
    createEffect(() => p.hold(id, menu() || r.editing()));
    onCleanup(() => p.hold(id, false));
    let more: HTMLButtonElement | undefined;
    const current = () => app.activeId === p.s.id;
    const unread = () => isUnread(p.s) && !current();
    return (
        <div class={`slim ${current() ? "cur" : ""} ${menu() ? "menu-open" : ""}`} onContextMenu={contextMenu} onKeyDown={contextKey}>
            <Show
                when={!r.editing()}
                fallback={
                    <>
                        <Glyph kind={railGlyph(p.s, unread())} />
                        {r.input()}
                    </>
                }
            >
                <button
                    class="slim-hit"
                    onClick={() => void activate(p.s.id)}
                    onDblClick={() => r.setEditing(true)}
                    aria-current={current() ? "page" : undefined}
                    aria-label={rowLabel(p.s, unread())}
                    title={`${p.s.title}\n${p.s.cwd}\nUpdated ${(now(), ago(p.s.updatedAt))}`}
                >
                    <Glyph kind={railGlyph(p.s, unread())} />
                    <span class="truncate">{p.s.run ? `${p.s.run.modelName} · ${p.s.title}` : p.s.title}</span>
                    <Show when={p.s.pinned}>
                        <Pin size={11} class="slim-pin" />
                    </Show>
                </button>
                <span class="slim-end">
                    <span class="t">
                        <RowEnd s={p.s} unread={unread()} />
                    </span>
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

/**
 * The top line, level with the traffic lights (macOS): hide the rail and start a
 * session, at the rail's far end. Shared with the Settings rail.
 */
export function SidebarTop() {
    return (
        <div class="side-top" data-tauri-drag-region>
            <span class="grow" data-tauri-drag-region />
            <button class="hb" title={withShortcut("Hide sidebar", "app:toggleSidebar")} aria-label="Hide sidebar" onClick={toggleSidebar}>
                <PanelLeft size={16} />
            </button>
            <button class="hb" title={withShortcut("New session", "app:newSession")} aria-label="New session" onClick={() => (setSettingsTab(undefined), newSession(app.homeCwd))}>
                <SquarePen size={16} />
            </button>
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
    const [settledShown, setSettledShown] = createSignal(PAGE);
    const [archiveShown, setArchiveShown] = createSignal(PAGE);
    const [hovered, setHovered] = createSignal(false);
    const [manualLayout, setManualLayout] = createSignal(false);
    const allowLayout = () => { setManualLayout(true); queueMicrotask(() => setManualLayout(false)); };
    const [locked, setLocked] = createSignal<Set<string>>(new Set());
    const hold = (id: string, held: boolean) => setLocked((previous) => {
        if (previous.has(id) === held) return previous;
        const next = new Set(previous);
        if (held) next.add(id); else next.delete(id);
        return next;
    });
    let viewBtn: HTMLButtonElement | undefined;
    let listEl: HTMLElement | undefined;
    let frame = 0;
    const animations = new Set<Animation>();
    const all = createMemo(() => [...app.sessions, ...app.archived]);
    const sessions = createMemo(() => new Map(all().map((s) => [s.id, s])));
    // Grouped by project, a row needn't name its project: the heading above it does.
    const grouped = () => prefs.groupBy === "project" && !showArchived();
    const settledCount = () => app.sessions.filter((s) => s.settled).length;
    // The plan of the session in view (else the latest to report), or the connection when no plan has.
    const foot = createMemo(() => {
        const st = handleFor(app.activeId)?.view.state;
        const provider = st?.model?.provider;
        return railFoot({ conn: app.conn, limits: app.limits, providers: app.providers, provider, account: provider ? st?.accounts?.[provider] : undefined, now: now() });
    });
    const held = () => (hovered() && !manualLayout()) || locked().size > 0;
    const layout = createMemo<SidebarEntry[]>((previous) => {
        const next = sidebarEntries(app.sessions, app.archived, {
            activeId: app.activeId, groupBy: prefs.groupBy, archived: showArchived(),
            settledOpen: prefs.settledOpen, cards: shown(), settled: settledShown(), archive: archiveShown(),
        });
        return holdSidebar(previous ?? [], next, held(), all(), app.activeId);
    });
    const entriesByKey = createMemo(() => new Map(layout().map((entry) => [entry.key, entry])));
    const counts = createMemo(() => groupCounts(layout()));
    // Capture before Solid moves keyed rows; animate only after the new layout is painted.
    const keys = createMemo<string[]>((previous) => {
        const next = layout().map((entry) => entry.key);
        if (previous?.length === next.length && previous.every((key, i) => key === next[i])) return previous;
        if (held()) return next;
        const before = new Map<string, number>();
        for (const el of listEl?.querySelectorAll<HTMLElement>("[data-session-row]") ?? []) before.set(el.dataset.sessionRow!, el.getBoundingClientRect().top);
        for (const animation of animations) animation.cancel();
        animations.clear();
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
            if (held() || prefs.motion === "instant" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
            for (const el of listEl?.querySelectorAll<HTMLElement>("[data-session-row]") ?? []) {
                const old = before.get(el.dataset.sessionRow!);
                if (old === undefined) continue;
                const delta = old - el.getBoundingClientRect().top;
                if (!delta) continue;
                const animation = el.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], { duration: prefs.motion === "smooth" ? 260 : 160, easing: "ease-out" });
                animations.add(animation);
                animation.onfinish = () => animations.delete(animation);
            }
        });
        return next;
    });
    createEffect(() => setSidebarOrder(sidebarIds(layout())));
    createEffect(() => {
        const pause = held();
        for (const animation of animations) {
            if (pause) animation.pause(); else animation.play();
        }
    });
    onCleanup(() => {
        cancelAnimationFrame(frame);
        for (const animation of animations) animation.cancel();
        setSidebarOrder(undefined);
    });
    const showMore = (page: "cards" | "settled" | "archived") => {
        if (page === "cards") setShown((n) => n + PAGE);
        else if (page === "settled") setSettledShown((n) => n + PAGE);
        else setArchiveShown((n) => n + PAGE);
        // Explicit paging is intentional movement, even with the pointer on its button.
        allowLayout();
    };

    return (
        <SidebarFrame>
            <div class="side-tools">
                <button class="side-search" title={withShortcut("Search sessions, messages and actions", "app:commandPalette")} onClick={() => setPaletteOpen(true)}>
                    <Search size={14} />
                    <span>Search</span>
                    <Show when={shortcut("app:commandPalette")}>{(k) => <span class="side-kbd">{os === "macos" ? k().replaceAll("+", "") : k()}</span>}</Show>
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

            <nav ref={listEl} class="side-list" aria-label="Session list"
                onPointerEnter={() => setHovered(true)}
                onPointerLeave={() => setHovered(false)}>
                <For each={keys()}>{(key) => {
                    const entry = () => entriesByKey().get(key)!;
                    // A held row keeps its component (and menu/rename) through status changes.
                    const kind = untrack(() => entry().kind);
                    if (kind === "run") {
                        const group = () => entry() as Extract<SidebarEntry, { kind: "run" }>;
                        const members = () => group().ids.filter((id) => sessions().has(id));
                        const run = () => sessions().get(members()[0]!)?.run;
                        return <div class="run-group" data-session-row={key} role="group" aria-label={`${members().length} models: ${run()?.label ?? ""}`}>
                            <div class="run-head" title={run()?.label}>
                                <Layers size={12} /><span class="truncate">{run()?.label}</span><span class="run-count">{members().length}</span>
                            </div>
                            <For each={members()}>{(id) => {
                                const s = () => sessions().get(id)!;
                                return <Show when={s()}>
                                    <Show when={!group().row} fallback={<SessionRow s={s()} hold={hold} />}>
                                        <SessionCard s={s()} hold={hold} grouped={grouped()} />
                                    </Show>
                                </Show>;
                            }}</For>
                        </div>;
                    }
                    if (kind === "card" || kind === "row") {
                        const s = () => sessions().get(key)!;
                        return <div data-session-row={key}>
                            <Show when={s()}>
                                <Show when={entry().kind === "card"} fallback={<SessionRow s={s()} hold={hold} />}>
                                    <SessionCard s={s()} hold={hold} grouped={grouped()} />
                                </Show>
                            </Show>
                        </div>;
                    }
                    if (kind === "project") {
                        const group = () => entry() as Extract<SidebarEntry, { kind: "project" }>;
                        return <div class="shelf"><Folder size={14} /><span class="truncate" title={group().cwd}>{group().name}</span><span class="n">{counts().get(key)}</span>
                            <button class="shelf-btn add" title={`New session in ${group().name}`} aria-label={`New session in ${group().name}`} onClick={() => newSession(group().cwd)}><Plus size={13} /></button>
                        </div>;
                    }
                    if (kind === "settled") return <button class="shelf settled-head" aria-expanded={prefs.settledOpen} onClick={() => { allowLayout(); setPrefs("settledOpen", !prefs.settledOpen); }}>
                        <CheckCheck size={14} /><span>Settled</span><span class="n">{settledCount()}</span><ChevronUp size={14} class={`settled-chev ${prefs.settledOpen ? "" : "closed"}`} />
                    </button>;
                    if (kind === "archived") return <div class="shelf"><Archive size={14} /><span>Archived</span><span class="n">{app.archived.length}</span><button class="shelf-btn" onClick={() => { allowLayout(); setShowArchived(false); }}>Done</button></div>;
                    const more = () => entry() as Extract<SidebarEntry, { kind: "more" }>;
                    return <button class="slim more" onClick={() => showMore(more().page)}><Plus size={14} /><span>Show {Math.min(PAGE, more().remaining)} more</span></button>;
                }}</For>
                <Show when={app.sessionsError || !all().length || (showArchived() && !sidebarIds(layout()).length)}>
                    <div class="side-empty">
                        <Show when={app.sessionsError} fallback={!app.sessionsLoaded ? app.conn === "open" ? "Loading sessions…" : "Connecting…" : showArchived() ? "Nothing archived." : "No sessions yet. Start one from the composer."}>
                            <div>Couldn't load sessions.</div>
                            <button class="ghost-btn" onClick={() => void refreshSessions().catch(reportError)}>Retry</button>
                        </Show>
                    </div>
                </Show>
            </nav>

            <div class="side-foot">
                <Show when={foot().pct !== undefined} fallback={<span class="foot-mark"><span class={`conn conn-${app.conn}`} /></span>}>
                    <span class={`meter tone-${foot().tone}`} style={{ "--v": foot().pct }} role="img" aria-label={`${foot().pct}% used`} />
                </Show>
                <span class="who" title={app.hello ? `${app.hello.user}@${app.hello.host}\n${app.hello.home}` : undefined}>
                    <b>
                        <Show when={foot().provider}>{(id) => <ProviderIcon id={id()} size={13} />}</Show>
                        <span class="truncate">{foot().name}</span>
                    </b>
                    <span class="truncate">{foot().line}</span>
                </span>
                <button class="hb lg" title={withShortcut("Settings", "app:settings")} aria-label="Settings" onClick={() => setSettingsTab("general")}>
                    <Settings size={16} />
                </button>
            </div>
        </SidebarFrame>
    );
}
