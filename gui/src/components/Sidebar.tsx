// The session rail, straight on the window glass. Sessions still in play are
// two-line rows: how it's doing, what it's about, when; then its branch (and
// project, when the list isn't grouped by project). Ones you've settled fold
// into a one-line list at the bottom; sending to one brings it back.

import { batch, createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch, untrack } from "solid-js";
import { Archive, ArchiveRestore, Check, CheckCheck, ChevronUp, CircleAlert, Folder, FolderPlus, Hand, Layers, ListFilter, MessageSquareText, MoreHorizontal, PanelLeft, Pencil, Pin, PinOff, Plus, Search, Settings, SquarePen, Trash2, Undo2, X } from "lucide-solid";
import type { SessionSummary } from "@shared/protocol";
import { activate, app, handleFor, isUnread, refreshSessions, reportError } from "../state/app";
import { archive, archiveSessions, askToDelete, chooseProject, newSession, openProject, pin, rename, settle, settleSessions, toggleSidebar } from "../state/actions";
import { prefs, setPrefs } from "../state/prefs";
import { setDeleteRequest, setPaletteOpen, setSettingsTab } from "../state/ui";
import { ago, monogram, projectColor, since } from "../lib/format";
import { holdSidebar, sidebarEntries, sidebarIds, SESSION_PAGE, type SidebarEntry } from "../lib/session-order";
import { sessionStatus } from "../lib/session-status";
import { groupCounts, railFoot, railGlyph, type RailGlyph, type RailPlan } from "../lib/rail";
import { railSelection, setRailSelection, setSidebarOrder } from "../state/sidebar";
import { bulkPlan, clickKind, clickSelect, extendSelect, pruneSelection, railTargets, selectAll, sessionCount, type BulkPlan, type RailList } from "../lib/rail-select";
import { now } from "../lib/clock";
import { isTauri, os } from "../lib/platform";
import { Menu } from "./ui/Menu";
import { rowMenuKey } from "../lib/menu";
import { ProviderIcon } from "./ui/ProviderIcon";
import { actionOf, shortcut, withShortcut } from "../state/keybindings";

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

/** How a row takes part in the rail's selection (the Sidebar keeps it). */
interface RailPick {
    picked: (id: string) => boolean;
    click: (e: MouseEvent, id: string) => void;
    /** The selection, when this row is in one of two or more: its menu acts on all of them. */
    group: (id: string) => readonly string[] | undefined;
    plan: (ids: readonly string[]) => BulkPlan;
    clear: () => void;
}

/** The actions on several selected sessions, as menu items (a selected row's context menu). */
function BulkItems(p: { plan: BulkPlan; close: () => void; clear: () => void }) {
    // Read once: closing the menu ends the selection it was opened on before an item's action runs.
    const plan = p.plan;
    const n = (ids: readonly string[]) => sessionCount(ids.length);
    return (
        <>
            <div class="menu-head">{n(plan.delete)} selected</div>
            <Show when={plan.settle.length}>
                <button role="menuitem" class="menu-item compact" onClick={() => (p.close(), void settleSessions(plan.settle, true))}>
                    <CheckCheck size={14} /> Settle {n(plan.settle)}
                </button>
            </Show>
            <Show when={plan.unsettle.length}>
                <button role="menuitem" class="menu-item compact" onClick={() => (p.close(), void settleSessions(plan.unsettle, false))}>
                    <Undo2 size={14} /> Back in play
                </button>
            </Show>
            <Show when={plan.archive.length}>
                <button role="menuitem" class="menu-item compact" onClick={() => (p.close(), void archiveSessions(plan.archive, true))}>
                    <Archive size={14} /> Archive {n(plan.archive)}
                </button>
            </Show>
            <Show when={plan.restore.length}>
                <button role="menuitem" class="menu-item compact" onClick={() => (p.close(), void archiveSessions(plan.restore, false))}>
                    <ArchiveRestore size={14} /> Restore {n(plan.restore)}
                </button>
            </Show>
            <button role="menuitem" class="menu-item compact" onClick={() => (p.close(), p.clear())}>
                <X size={14} /> Clear selection
            </button>
            <div class="menu-sep" />
            <button role="menuitem" class="menu-item compact danger" onClick={() => (p.close(), askToDelete(plan.delete))}>
                <Trash2 size={14} /> Delete {n(plan.delete)}…
            </button>
        </>
    );
}

function RowMenu(p: { s: SessionSummary; pick: RailPick; open: boolean; setOpen: (v: boolean) => void; anchor: () => HTMLElement | undefined; returnFocus: () => HTMLElement | undefined; point?: { x: number; y: number }; onRename: () => void }) {
    const close = () => p.setOpen(false);
    // Taken as the menu opens, so it doesn't change under the pointer.
    const group = createMemo(() => (p.open ? untrack(() => p.pick.group(p.s.id)) : undefined));
    return (
        <Menu label={group() ? "Selected sessions actions" : "Session actions"} returnFocus={p.returnFocus} point={p.point} open={p.open} anchor={p.anchor} onClose={close} align="end" width={220}>
            <Show when={group()} fallback={<SingleItems s={p.s} close={close} onRename={p.onRename} />}>
                {(ids) => <BulkItems plan={p.pick.plan(ids())} close={close} clear={p.pick.clear} />}
            </Show>
        </Menu>
    );
}

function SingleItems(p: { s: SessionSummary; close: () => void; onRename: () => void }) {
    const close = p.close;
    return (
        <>
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
        </>
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

/** How a session is doing, at the start of its row; a check in an accent disc while it's selected. */
function Glyph(p: { kind: RailGlyph; picked?: boolean }) {
    return (
        <Show when={!p.picked} fallback={<span class="st pick" aria-hidden="true"><Check size={11} stroke-width={3} /></span>}>
            <StatusGlyph kind={p.kind} />
        </Show>
    );
}

function StatusGlyph(p: { kind: RailGlyph }) {
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

/** What a screen reader hears for a row: its title, then how it's doing, and whether it's selected. */
function rowLabel(s: SessionSummary, unread: boolean, picked = false): string {
    const word = sessionStatus(s, now())?.text;
    return [s.run ? `${s.run.modelName} · ${s.title}` : s.title, s.status === "idle" ? (unread ? "unread" : undefined) : word, s.pinned ? "pinned" : undefined, picked ? "selected" : undefined].filter(Boolean).join(", ");
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

/** A plan's usage ring: empty until the plan has reported. */
function PlanRing(p: { plan: RailPlan; small?: boolean }) {
    return <span class={`meter tone-${p.plan.tone} ${p.small ? "sm" : ""} ${p.plan.pct === undefined ? "unknown" : ""} ${p.plan.stale ? "stale" : ""}`} style={{ "--v": p.plan.pct ?? 0 }} role="img" aria-label={`${p.plan.name}: ${p.plan.pct === undefined ? "usage not known yet" : `${p.plan.pct}% used`}${p.plan.stale ? " when last reported" : ""}`} />;
}

function SessionCard(p: { s: SessionSummary; hold: (id: string, held: boolean) => void; grouped: boolean; pick: RailPick }) {
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
    const picked = () => p.pick.picked(p.s.id);
    return (
        <div
            ref={el}
            data-session-id={p.s.id}
            class={`card ${current() ? "cur" : ""} ${picked() ? "picked" : ""} ${recede() ? "rec" : ""} ${unread() ? "unread" : ""} ${waiting() ? "waiting" : ""} ${menu() ? "menu-open" : ""}`}
            onContextMenu={contextMenu} onKeyDown={contextKey}
        >
            <button class="card-hit" onClick={(e) => p.pick.click(e, p.s.id)} onDblClick={(e) => !e.shiftKey && !e.metaKey && !e.ctrlKey && r.setEditing(true)} aria-current={current() ? "page" : undefined} aria-label={rowLabel(p.s, unread(), picked())} title={`${p.s.title}\n${p.s.cwd}`}>
                <Glyph kind={railGlyph(p.s, unread())} picked={picked()} />
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
            <RowMenu returnFocus={returnFocus} point={point()} s={p.s} pick={p.pick} open={menu()} setOpen={setMenu} anchor={() => more ?? el} onRename={() => r.setEditing(true)} />
        </div>
    );
}

function SessionRow(p: { s: SessionSummary; hold: (id: string, held: boolean) => void; pick: RailPick }) {
    const r = useRename(() => p.s);
    const { menu, setMenu, point, contextMenu, contextKey, toggleMenu, returnFocus } = useRowMenu(() => more);
    const id = p.s.id;
    createEffect(() => p.hold(id, menu() || r.editing()));
    onCleanup(() => p.hold(id, false));
    let more: HTMLButtonElement | undefined;
    const current = () => app.activeId === p.s.id;
    const unread = () => isUnread(p.s) && !current();
    const picked = () => p.pick.picked(p.s.id);
    return (
        <div data-session-id={p.s.id} class={`slim ${current() ? "cur" : ""} ${picked() ? "picked" : ""} ${menu() ? "menu-open" : ""}`} onContextMenu={contextMenu} onKeyDown={contextKey}>
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
                    onClick={(e) => p.pick.click(e, p.s.id)}
                    onDblClick={(e) => !e.shiftKey && !e.metaKey && !e.ctrlKey && r.setEditing(true)}
                    aria-current={current() ? "page" : undefined}
                    aria-label={rowLabel(p.s, unread(), picked())}
                    title={`${p.s.title}\n${p.s.cwd}\nUpdated ${(now(), ago(p.s.updatedAt))}`}
                >
                    <Glyph kind={railGlyph(p.s, unread())} picked={picked()} />
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
            <RowMenu returnFocus={returnFocus} point={point()} s={p.s} pick={p.pick} open={menu()} setOpen={setMenu} anchor={() => more} onRename={() => r.setEditing(true)} />
        </div>
    );
}

/**
 * Two or more rows picked: a glass bar under the list with what can be done to
 * all of them (only what applies: Restore for archived ones, Back in play when
 * every one is settled) and a way out.
 */
function SelectionBar(p: { count: number; plan: BulkPlan; act: (what: "settle" | "archive" | "delete") => void; clear: () => void; onKeyDown: (e: KeyboardEvent) => void }) {
    const n = () => sessionCount(p.count);
    return (
        <div class="rail-sel glass" role="toolbar" aria-label={`${n()} selected`} onKeyDown={p.onKeyDown}>
            <span class="rail-sel-n">{p.count} selected</span>
            <Show when={p.plan.settle.length}>
                <button class="hb" title={withShortcut(`Settle ${sessionCount(p.plan.settle.length)}`, "sidebar:settleSelected")} aria-label={`Settle ${sessionCount(p.plan.settle.length)}`} onClick={() => p.act("settle")}>
                    <CheckCheck size={15} />
                </button>
            </Show>
            <Show when={p.plan.unsettle.length}>
                <button class="hb" title={withShortcut("Back in play", "sidebar:settleSelected")} aria-label={`Back in play: ${n()}`} onClick={() => p.act("settle")}>
                    <Undo2 size={15} />
                </button>
            </Show>
            <Show when={p.plan.archive.length}>
                <button class="hb" title={withShortcut(`Archive ${sessionCount(p.plan.archive.length)}`, "sidebar:archiveSelected")} aria-label={`Archive ${sessionCount(p.plan.archive.length)}`} onClick={() => p.act("archive")}>
                    <Archive size={15} />
                </button>
            </Show>
            <Show when={p.plan.restore.length}>
                <button class="hb" title={withShortcut(`Restore ${n()}`, "sidebar:archiveSelected")} aria-label={`Restore ${n()}`} onClick={() => p.act("archive")}>
                    <ArchiveRestore size={15} />
                </button>
            </Show>
            <button class="hb rail-sel-del" title={withShortcut(`Delete ${n()}…`, "sidebar:deleteSelected")} aria-label={`Delete ${n()}…`} onClick={() => p.act("delete")}>
                <Trash2 size={15} />
            </button>
            <span class="rail-sel-sep" aria-hidden="true" />
            <button class="hb" title="Clear selection (Esc)" aria-label="Clear selection" onClick={p.clear}>
                <X size={15} />
            </button>
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
    // Providers by the sessions that used them, most recent first: the plan used last leads when no session is open.
    const recent = createMemo(() => [...new Set([...app.sessions].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => modelOf(s)?.split(":")[0]).filter((p): p is string => Boolean(p)))]);
    // The signed-in plans (Claude Code, Codex): the session in view's first, else the one used last.
    const plans = createMemo(() => {
        const st = handleFor(app.activeId)?.view.state;
        const provider = st?.model?.provider;
        return railFoot({ limits: app.limits, providers: app.providers, provider, account: provider ? st?.accounts?.[provider] : undefined, recent: recent(), now: now() });
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

    // ---- Picking several (lib/rail-select.ts has the rules) ----
    const order = createMemo(() => sidebarIds(layout()));
    const listOf = (id: string): RailList | undefined => {
        const s = sessions().get(id);
        return s ? (s.archived ? "archived" : "active") : undefined;
    };
    const picked = createMemo(() => new Set(railSelection().ids));
    // Rows that leave the rail (deleted, paged out, folded away) leave the selection.
    createEffect(() => {
        const shown = order();
        setRailSelection((sel) => pruneSelection(sel, shown));
    });
    // The archived list and the active one are separate selections.
    createEffect((was?: boolean) => {
        const now = showArchived();
        if (was !== undefined && was !== now) setRailSelection({ ids: [] });
        return now;
    });
    const summaries = (ids: readonly string[]) => ids.map((id) => sessions().get(id)).filter((s) => s !== undefined);
    const plan = (ids: readonly string[]) => bulkPlan(summaries(ids));
    const selected = createMemo(() => railSelection().ids);
    const selectedPlan = createMemo(() => plan(selected()));
    const rowHit = (id: string) =>
        [...(listEl?.querySelectorAll<HTMLElement>("[data-session-id]") ?? [])].find((el) => el.dataset.sessionId === id)?.querySelector<HTMLElement>(".card-hit, .slim-hit") ?? undefined;
    const focusRow = (id: string | undefined) => {
        const hit = id ? rowHit(id) : undefined;
        hit?.focus({ preventScroll: true });
        hit?.scrollIntoView({ block: "nearest" });
    };
    const clear = (refocus = false) => {
        const sel = railSelection();
        setRailSelection({ ids: [], anchor: sel.anchor });
        // The bar goes with the selection: its focus goes back to the list.
        if (refocus) focusRow(sel.anchor && order().includes(sel.anchor) ? sel.anchor : sel.ids[0]);
    };
    const pick: RailPick = {
        picked: (id) => picked().has(id),
        click: (e, id) => {
            const kind = clickKind(e, os === "macos");
            setRailSelection(clickSelect(railSelection(), id, kind, order(), listOf));
            if (kind === "plain") return void activate(id);
            // The keys that act on the selection need the focus in the list (WebKit doesn't focus a clicked button).
            (e.currentTarget as HTMLElement | null)?.focus?.({ preventScroll: true });
        },
        group: (id) => (selected().length > 1 && picked().has(id) ? selected() : undefined),
        plan,
        clear: () => clear(),
    };
    /** Settle, archive or delete what's selected (else the focused or open row), as a key or the bar asks. */
    const act = (what: "settle" | "archive" | "delete", ids: readonly string[]) => {
        const p = plan(ids);
        if (what === "delete") return askToDelete(p.delete);
        if (what === "settle") {
            if (p.settle.length) void settleSessions(p.settle, true);
            else if (p.unsettle.length) void settleSessions(p.unsettle, false);
            return;
        }
        if (p.archive.length) void archiveSessions(p.archive, true);
        else if (p.restore.length) void archiveSessions(p.restore, false);
    };
    /** Keys in the list and its selection bar. Typing in a rename box keeps its keys. */
    const onRailKey = (e: KeyboardEvent) => {
        const target = e.target as HTMLElement | null;
        if (e.defaultPrevented || target?.closest?.("input, textarea, select, [contenteditable]")) return;
        const focused = target?.closest?.<HTMLElement>("[data-session-id]")?.dataset.sessionId;
        const bare = !e.metaKey && !e.ctrlKey && !e.altKey;
        if ((e.key === "ArrowDown" || e.key === "ArrowUp") && bare && focused) {
            e.preventDefault();
            const dir = e.key === "ArrowDown" ? 1 : -1;
            if (!e.shiftKey) return focusRow(order()[order().indexOf(focused) + dir]);
            const next = extendSelect(railSelection(), focused, dir, order(), listOf);
            if (next) {
                setRailSelection(next.sel);
                focusRow(next.focus);
            }
            return;
        }
        if (e.key === "Escape" && bare && !e.shiftKey && railSelection().ids.length) {
            // Before the window's Esc (which would interrupt a working session).
            e.preventDefault();
            return clear(!focused);
        }
        const action = actionOf(e, ["Sidebar", "Global"]);
        if (!action?.startsWith("sidebar:")) return;
        e.preventDefault();
        if (action === "sidebar:selectAll") return void setRailSelection(selectAll(order(), (focused && listOf(focused)) || (showArchived() ? "archived" : "active"), listOf));
        const ids = railTargets(railSelection(), focused, app.activeId, order());
        if (action === "sidebar:deleteSelected") act("delete", ids);
        else if (action === "sidebar:settleSelected") act("settle", ids);
        else if (action === "sidebar:archiveSelected") act("archive", ids);
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

            <nav ref={listEl} class="side-list" aria-label="Session list" onKeyDown={onRailKey}
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
                                    <Show when={!group().row} fallback={<SessionRow s={s()} hold={hold} pick={pick} />}>
                                        <SessionCard s={s()} hold={hold} grouped={grouped()} pick={pick} />
                                    </Show>
                                </Show>;
                            }}</For>
                        </div>;
                    }
                    if (kind === "card" || kind === "row") {
                        const s = () => sessions().get(key)!;
                        return <div data-session-row={key}>
                            <Show when={s()}>
                                <Show when={entry().kind === "card"} fallback={<SessionRow s={s()} hold={hold} pick={pick} />}>
                                    <SessionCard s={s()} hold={hold} grouped={grouped()} pick={pick} />
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
            <Show when={selected().length > 1}>
                <SelectionBar count={selected().length} plan={selectedPlan()} act={(what) => act(what, selected())} clear={() => clear(true)} onKeyDown={onRailKey} />
            </Show>

            <div class={`side-foot ${plans().length > 1 ? "two" : ""}`}>
                <Show when={plans().length > 1} fallback={
                    <Show when={plans()[0]} fallback={<span class="who" />}>{(plan) => (
                        <>
                            <PlanRing plan={plan()} />
                            <span class="who" title={plan().detail}>
                                <b>
                                    <ProviderIcon id={plan().provider} size={13} />
                                    <span class="truncate">{plan().name}</span>
                                </b>
                                <span class="truncate">{plan().line}</span>
                            </span>
                        </>
                    )}</Show>
                }>
                    <span class="plans">
                        <For each={plans()}>{(plan) => (
                            <span class="plan" title={plan.detail}>
                                <PlanRing plan={plan} small />
                                <ProviderIcon id={plan.provider} name={plan.name} size={12} />
                                <span class="truncate">{plan.brief}</span>
                            </span>
                        )}</For>
                    </span>
                </Show>
                <button class="hb lg" title={withShortcut("Settings", "app:settings")} aria-label="Settings" onClick={() => setSettingsTab("general")}>
                    <Settings size={16} />
                </button>
            </div>
        </SidebarFrame>
    );
}
