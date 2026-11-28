// The session rail, straight on the window glass. Every session is one line:
// a dot that says how it's doing, what it's about, and when it last moved.
// Where it is (project, branch) is in its tooltip, and in the title bar once
// it's open. Ones you've settled fold into a list at the bottom, without a
// dot; sending to one brings it back. The ones waiting on you are pinned above
// them all, under Needs you, with what they ask, until answered.

import { batch, createEffect, createMemo, createSignal, ErrorBoundary, For, lazy, Match, on, onCleanup, onMount, Show, Suspense, Switch, untrack, type JSX } from "solid-js";
import { Archive, ArchiveRestore, Check, CheckCheck, ChevronsDownUp, ChevronRight, ChevronsUpDown, Folder, FolderOpen, FolderPlus, Layers, ListFilter, MoreHorizontal, PanelLeftClose, Pencil, Pin, PinOff, Plus, Search, Settings, Square, SquarePen, Trash2, Undo2, X } from "lucide-solid";
import type { SessionSummary } from "@shared/protocol";
import { activate, app, handleFor, isUnread, refreshSessions, reportError, warmFor } from "../state/app";
import { archive, archiveSessions, chooseProject, deleteSessions, newSession, openProject, openWaiting, pin, rename, settle, settleSessions, toggleSidebar } from "../state/actions";
import { prefs, setPrefs } from "../state/prefs";
import { agentFocus, railFree, requestComposerFocus, setDeletedOpen, setPaletteOpen, setRailDrag, setSettingsTab, settingsTab } from "../state/ui";
import { frameDrag } from "../lib/drag";
import { ago, monogram, projectColor, since, wakeTime } from "../lib/format";
import { dayOf, folderOf, holdSidebar, isSnoozed, listedOnce, machineLabel, projectOf, revealDay, revealProject, sidebarEntries, sidebarIds, SESSION_PAGE, toggleProject, type DayLabel, type SidebarEntry } from "../lib/session-order";
import { sessionStatus } from "../lib/session-status";
import { groupCounts, inFront, needsRowLine, needsYou } from "../lib/rail";
import { railSelection, setRailSelection, setSidebarOrder } from "../state/sidebar";
import { bulkPlan, clickKind, clickSelect, extendSelect, pruneSelection, railTargets, selectAll, sessionCount, type BulkPlan, type RailList } from "../lib/rail-select";
import { now } from "../lib/clock";
import { isDesktop, machine, os } from "../lib/platform";
import { Menu } from "./ui/Menu";
import { rowMenuKey } from "../lib/menu";
import { ProviderIcon } from "./ui/ProviderIcon";
import { modelName } from "../lib/model-name";
import { Logo } from "./ui/bits";
import { actionOf, keyText, shortcut, withShortcut } from "../state/keybindings";
import { besideInFront, inSplit, setDraggedSession, SESSION_DRAG } from "../state/split";

/** Snooze and Wake now in a row's menu, and the menu of several picked rows: loaded as the rail is first pointed at or focused. */
const RowExtras = lazy(() => import("./RowExtras"));

/** Cards shown before "Show more". */
const PAGE = SESSION_PAGE;

export function Monogram(p: { name: string; cwd?: string; label?: string; size?: number }) {
    return (
        <span class="mg" style={{ "background-color": projectColor(p.cwd ?? p.name),
            ...(p.size ? { width: `calc(${p.size} * var(--sp))`, height: `calc(${p.size} * var(--sp))`, "font-size": `calc(${(p.size * 0.47).toFixed(1)} * var(--sp))` } : {}),
        }} aria-hidden="true">
            {p.label ?? monogram(p.name)}
        </span>
    );
}

/** main or master: most sessions are on it, so the row doesn't say it. */
const usualBranch = (branch: string | undefined) => branch === "main" || branch === "master";

function branchOf(s: SessionSummary): string | undefined {
    if (s.id === app.activeId) return handleFor(s.id)?.view.state.branch;
    // The projects are the window's machine's: a folder at the same path on another isn't one of them.
    return handleFor(s.id)?.view.state.branch ?? (s.machine === machine ? app.projects.find((p) => p.path === s.cwd)?.branch : undefined);
}

/** The model it last used: the open session's own, else the one it was saved with. */
function modelOf(s: SessionSummary): string | undefined {
    return handleFor(s.id)?.view.state.model?.ref ?? s.model;
}

function useRename(s: () => SessionSummary) {
    const [editing, setEditing] = createSignal(false);
    const input = () => (
        <input
            class="srow-rename"
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
    /** Rows are being picked: every row of the list shows its box. */
    picking: () => boolean;
    click: (e: MouseEvent, id: string) => void;
    /** A plain click: opens the session (openWaiting), the selection cleared (what a row under Needs you does with any click). */
    open: (id: string) => void;
    /** The selection, when this row is in one of two or more: its menu acts on all of them. */
    group: (id: string) => readonly string[] | undefined;
    plan: (ids: readonly string[]) => BulkPlan;
    clear: () => void;
}

function RowMenu(p: { s: SessionSummary; pick: RailPick; open: boolean; setOpen: (v: boolean) => void; anchor: () => HTMLElement | undefined; returnFocus: () => HTMLElement | undefined; onRename: () => void }) {
    const close = () => p.setOpen(false);
    // Taken as the menu opens, so it doesn't change under the pointer.
    const group = createMemo(() => (p.open ? untrack(() => p.pick.group(p.s.id)) : undefined));
    return (
        // Under its row and as wide as it, however it's opened (the row's "…", a right click, the menu key): one
        // menu in one place, inside the rail, and what's behind doesn't peek out at its edge. 4px off, as the design's.
        <Menu label={group() ? "Selected sessions actions" : "Session actions"} returnFocus={p.returnFocus} open={p.open} anchor={p.anchor} span={() => p.anchor()?.closest<HTMLElement>(".srow") ?? undefined} onClose={close} align="end" offset={4} width={190} class="menu">
            <Show when={group()} fallback={<SingleItems s={p.s} close={close} onRename={p.onRename} />}>
                {(ids) => <RowExtras ids={ids()} plan={p.pick.plan(ids())} close={close} clear={p.pick.clear} />}
            </Show>
        </Menu>
    );
}

function SingleItems(p: { s: SessionSummary; close: () => void; onRename: () => void }) {
    const close = p.close;
    return (
        <>
            <button role="menuitem" class="menu-item" onClick={() => batch(() => { p.onRename(); close(); })}>
                <Pencil size={14} /><span class="menu-item-name">Rename</span>
            </button>
            <button role="menuitem" class="menu-item" onClick={() => (close(), void pin(p.s.id, !p.s.pinned))}>
                {p.s.pinned ? <PinOff size={14} /> : <Pin size={14} />}<span class="menu-item-name">{p.s.pinned ? "Unpin" : "Pin"}</span>
            </button>
            {/* Snoozed, it's off the list already: Wake now (below) brings it back. */}
            <Show when={!p.s.archived && !isSnoozed(p.s)}>
                <button role="menuitem" class="menu-item" onClick={() => (close(), void settle(p.s.id, !p.s.settled))}>
                    {p.s.settled ? <Undo2 size={14} /> : <CheckCheck size={14} />}<span class="menu-item-name">{p.s.settled ? "Back in play" : "Settle"}</span>
                </button>
            </Show>
            {/* Wake now, Snooze ▸ and More ▸ (Regenerate title, Never auto-settle, New session in its folder). */}
            <RowExtras ids={[p.s.id]} close={close} />
            <div class="menu-sep" />
            <button role="menuitem" class="menu-item" onClick={() => (close(), void archive(p.s.id, !p.s.archived))}>
                {p.s.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}<span class="menu-item-name">{p.s.archived ? "Restore" : "Archive"}</span>
            </button>
            <button role="menuitem" class="menu-item" data-danger onClick={() => (close(), void deleteSessions([p.s.id]))}>
                <Trash2 size={14} /><span class="menu-item-name">Delete</span>
            </button>
        </>
    );
}

/** Both row layouts use the same pointer/keyboard invocation and focus target. */
function useRowMenu(more: () => HTMLElement | undefined) {
    const [menu, setMenu] = createSignal(false);
    let returnTo: HTMLElement | undefined;
    const contextMenu = (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
        e.preventDefault();
        returnTo = (e.currentTarget as HTMLElement).querySelector<HTMLElement>("button.srow-main") ?? more();
        setMenu(true);
    };
    const contextKey = (e: KeyboardEvent) => rowMenuKey(e, () => {
        returnTo = e.target as HTMLElement;
        setMenu(true);
    });
    const toggleMenu = () => {
        returnTo = more();
        setMenu(!menu());
    };
    return { menu, setMenu, contextMenu, contextKey, toggleMenu, returnFocus: () => returnTo };
}

/** What a screen reader hears for a row: its title, then how it's doing, and whether it's selected. */
function rowLabel(s: SessionSummary, unread: boolean, picked = false): string {
    const word = s.making ? "forking" : sessionStatus(s, now())?.text;
    return [s.run ? `${s.run.modelName} · ${s.title}` : s.title, s.machine && `on ${s.machine}`, s.status === "idle" && !s.making ? (unread ? (s.stopped ? "stopped, unread" : "unread") : undefined) : word, s.pinned ? "pinned" : undefined, picked ? "selected" : undefined].filter(Boolean).join(", ");
}

/** How a row's session is doing, as the design's status glyph says it. */
function rowStatus(s: SessionSummary, unread?: boolean): "working" | "needs" | "failed" | "stopped" | "done" | "idle" {
    if (s.making || s.status === "running") return "working";
    if (s.status === "waiting") return "needs";
    if (s.status === "error") return "failed";
    if (s.stopped && (unread || s.messages > 0)) return "stopped";
    return s.messages > 0 || unread || s.woke ? "done" : "idle";
}

/** A row's start: how it's doing (a still glyph: nothing in the rail animates), or a box while rows are being picked, ticked when it's one. */
function RowLead(p: { s: SessionSummary; picking?: boolean; picked?: boolean; unread?: boolean }) {
    const status = () => rowStatus(p.s, p.unread);
    return (
        <Show when={!p.picking} fallback={<span class="srow-pick" data-on={p.picked || undefined} aria-hidden="true"><Show when={p.picked}><Check size={11} stroke-width={3} /></Show></span>}>
            <span class="status-icon" data-status={status()} aria-hidden="true">
                <Switch>
                    <Match when={status() === "working"}>
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="8" cy="8" r="6" opacity="0.22" />
                            <path d="M8 2a6 6 0 0 1 6 6" stroke-linecap="round" />
                        </svg>
                    </Match>
                    <Match when={status() === "needs"}><span class="status-dot" /></Match>
                    <Match when={status() === "done" && (p.unread || p.s.woke)}><span class="status-unread" /></Match>
                    <Match when={status() === "done"}><Check size={14} stroke-width={2.4} /></Match>
                    <Match when={status() === "failed"}><X size={14} stroke-width={2.6} /></Match>
                    <Match when={status() === "stopped"}><Square size={9} fill="currentColor" stroke-width={0} /></Match>
                    <Match when={status() === "idle"}><span class="status-idle" /></Match>
                </Switch>
            </span>
        </Show>
    );
}

/**
 * The end of a row's first line: a pin when pinned, then one thing: how it's doing when that's news ("Working 8m",
 * "Done" when it finished and you haven't looked, "Stopped" on an error or when its turn didn't finish: stopped, or
 * cut off by quitting), otherwise when it last moved ("2m", "1h", "3d"), amber while it waits on you; snoozed, when
 * it wakes.
 */
function RowMeta(p: { s: SessionSummary; unread: boolean }) {
    // Set again only when it changes, not at each tick of the clock it's worked out from.
    const word = createMemo(() =>
        p.s.making ? "Forking" : p.s.status === "running" ? sessionStatus(p.s, now())?.text : p.s.status === "error" ? "Stopped" : p.s.status !== "waiting" && p.unread ? (p.s.stopped ? "Stopped" : "Done") : p.s.woke ? "Woke" : undefined,
    );
    const tone = () => (p.s.making || p.s.status === "running" ? "working" : p.s.status === "error" ? "failed" : p.s.status === "waiting" ? "needs" : word() && word() !== "Stopped" ? "done" : undefined);
    return (
        <span class="srow-meta" data-tone={tone()}>
            <Show when={p.s.pinned}><Pin size={11} class="srow-pin" /></Show>
            {word() ?? (isSnoozed(p.s) ? wakeTime(p.s.snoozedUntil!, now()) : (now(), since(p.s.updatedAt)))}
        </span>
    );
}

/** A shortcut as its keys, a box each ("⌘" "N"). */
function NavKeys(p: { action: string }) {
    return (
        <Show when={shortcut(p.action)}>
            {(k) => <span class="kbd-group" aria-hidden="true"><For each={k().split("+")}>{(key) => <kbd class="kbd">{keyText(key)}</kbd>}</For></span>}
        </Show>
    );
}

/** The plans' chips and their card (PlanFooter.tsx): loaded a moment after the window, not with it. */
const PlanFooter = lazy(() => import("./PlanFooter").then((m) => ({ default: m.PlanFooter })));

/**
 * Beside Settings while there's an update or one is running (UpdateButton.tsx): loaded only then, so a window with
 * nothing to update doesn't carry it.
 */
const UpdateButton = lazy(() => import("./UpdateButton").then((m) => ({ default: m.UpdateButton })));
/** Whether the rail may show the update button: a superset of when it does (updateView's `rail`). */
const mayUpdate = () => {
    const u = app.update;
    return Boolean(u && (u.available || u.updating || u.failed || u.ready));
};

/** A row drags onto the stage to show its session beside the one in view (state/split.ts), whichever machine it's on: not while it's renamed. */
const draggable = (_s: SessionSummary, editing: boolean) => (!editing ? "true" : undefined);
/** In a split, the one beside the session in view. */
const beside = (id: string) => app.activeId !== id && inSplit(id);

/** A row's drag: the session it carries, for the stage to show where it would go. */
function dragRow(e: DragEvent) {
    const row = (e.target as HTMLElement | null)?.closest?.("[data-session-id], [data-needs-id]");
    const id = row?.getAttribute("data-session-id") ?? row?.getAttribute("data-needs-id");
    if (!id || !e.dataTransfer) return;
    e.dataTransfer.setData(SESSION_DRAG, id);
    e.dataTransfer.effectAllowed = "move";
    setDraggedSession(id);
    // The row may be gone by the drag's end (the list moved), and its dragend with it: the first move after the drag ends it.
    window.addEventListener("mousemove", () => setDraggedSession(undefined), { once: true });
}

/** Where a row is in the rail: under Needs you, a full row (title and where it is), or a slim one (Settled, Snoozed, Archived). */
type RowKind = "needs" | "card" | "slim";

/**
 * A session's row, the design's markup for all three: the glyph, the title with its time or status, and (not slim)
 * a line under it. Archive and More come up over the time while you point at it.
 *
 * Under Needs you, a session waiting on you, its one row in the rail until it's answered (lib/session-order.ts
 * listedOnce): what it's asking, in amber. Any click opens it. Rows are picked together in the list below, which
 * this one isn't in. Answered while the rail holds still, it shows how it's doing now until it goes back to its place.
 */
function SessionRow(p: { s: SessionSummary; kind: RowKind; hold: (id: string, held: boolean) => void; pick: RailPick }) {
    const r = useRename(() => p.s);
    const { menu, setMenu, contextMenu, contextKey, toggleMenu, returnFocus } = useRowMenu(() => more);
    const id = p.s.id;
    createEffect(() => p.hold(id, menu() || r.editing()));
    onCleanup(() => p.hold(id, false));
    let el: HTMLDivElement | undefined;
    let more: HTMLButtonElement | undefined;
    const needs = p.kind === "needs";
    const slim = p.kind === "slim";
    const current = () => app.activeId === p.s.id;
    const unread = () => isUnread(p.s) && !current();
    const waiting = () => p.s.status === "waiting";
    const picked = () => !needs && p.pick.picked(p.s.id);
    const picking = () => !needs && p.pick.picking();
    const snoozed = () => isSnoozed(p.s);
    const title = () => (p.s.run ? (p.kind === "card" ? p.s.run.modelName : `${p.s.run.modelName} · ${p.s.title}`) : p.s.title);
    // What it waits for; one on a server says which first, as its row in the list does.
    const ask = () => (p.s.machine ? `${machineLabel(p.s.machine)} · ` : "") + needsRowLine(p.s);
    // Where it is, for the tooltip: its server, its project, and its branch when it isn't the usual one.
    const where = () => [p.s.machine && machineLabel(p.s.machine), p.s.projectName, usualBranch(branchOf(p.s)) ? undefined : branchOf(p.s)].filter(Boolean).join(" · ");
    const provider = () => modelOf(p.s)?.split(":")[0];
    // Under the title, where it is: its project by date (by project, the heading says it), its model by project,
    // its branch in a run (the title is its model).
    const sub = () => {
        if (p.s.run) return branchOf(p.s) ?? p.s.projectName;
        const ref = modelOf(p.s);
        if (prefs.groupBy === "project" && ref) return modelName(ref);
        return p.s.machine ? `${machineLabel(p.s.machine)} · ${p.s.projectName}` : p.s.projectName;
    };
    const tooltip = () =>
        needs ? `${p.s.title}: ${ask()}`
        : slim ? `${p.s.title}\n${p.s.machine ? `${p.s.machine}: ` : ""}${p.s.cwd}\n${snoozed() ? `Wakes ${wakeTime(p.s.snoozedUntil!, now(), true)}` : `Updated ${(now(), ago(p.s.updatedAt))}`}`
        : `${p.s.title}\n${p.s.cwd}\n${where()}`;
    const click = (e: MouseEvent) => (needs ? p.pick.open(p.s.id) : p.pick.click(e, p.s.id));
    return (
        <div
            ref={el}
            // `cur`: the selected row's hook for the browser tests (perf-gui); the look keys on data-selected.
            class={slim ? "srow srow-slim" : "srow"}
            classList={{ cur: current() }}
            data-session-id={needs ? undefined : p.s.id}
            data-needs-id={needs ? p.s.id : undefined}
            data-selected={current() || undefined}
            data-beside={beside(p.s.id) || undefined}
            data-picked={picked() || undefined}
            data-status={rowStatus(p.s, unread())}
            data-menu-open={menu() || undefined}
            data-unread={unread() || undefined}
            data-receding={(p.s.status === "running" && !current() && !beside(p.s.id)) || undefined}
            data-snoozed={snoozed() || undefined}
            draggable={draggable(p.s, r.editing())}
            onContextMenu={contextMenu}
            onKeyDown={contextKey}
        >
            <Show
                when={!r.editing()}
                fallback={
                    <div class="srow-main">
                        <RowLead s={p.s} picking={picking()} picked={picked()} unread={unread()} />
                        <span class="srow-text">{r.input()}</span>
                    </div>
                }
            >
                <button
                    class="srow-main"
                    onClick={click}
                    onDblClick={(e) => !needs && !e.shiftKey && !e.metaKey && !e.ctrlKey && r.setEditing(true)}
                    aria-current={current() ? "page" : undefined}
                    aria-label={needs ? `${title()}, ${ask()}` : rowLabel(p.s, unread(), picked())}
                    title={tooltip()}
                >
                    <RowLead s={p.s} picking={picking()} picked={picked()} unread={unread()} />
                    <span class="srow-text">
                        <span class="srow-line">
                            <span class="srow-title">{title()}</span>
                            <Show when={slim && p.s.machine}>
                                <span class="srow-machine">{p.s.machine}</span>
                            </Show>
                            <RowMeta s={p.s} unread={unread()} />
                        </span>
                        <Show when={!slim}>
                            <span class="srow-sub" aria-hidden="true">
                                <Show
                                    when={!needs}
                                    fallback={<span class={waiting() ? "srow-ask" : "srow-detail"}>{ask()}</span>}
                                >
                                    <Show when={provider()}>{(id) => <ProviderIcon id={id()} size={12} class="srow-provider" />}</Show>
                                    <span class="srow-detail">{sub()}</span>
                                </Show>
                            </span>
                        </Show>
                    </span>
                </button>
                <div class="srow-actions" hidden={p.s.making}>
                    <Show
                        when={slim}
                        fallback={
                            /* A session waiting for you isn't archived from under its question. */
                            <Show when={!waiting() && !p.s.archived}>
                                <button class="icon-btn icon-btn-sm" title="Archive" aria-label={`Archive ${p.s.title}`} onClick={() => void archive(p.s.id, true)}>
                                    <Archive size={14} />
                                </button>
                            </Show>
                        }
                    >
                        {/* Snoozed: Pin is in its menu, and when it wakes stays in sight. */}
                        <Show when={!snoozed()}>
                            <button class="icon-btn icon-btn-sm" title={p.s.pinned ? "Unpin" : "Pin"} aria-label={`${p.s.pinned ? "Unpin" : "Pin"} ${p.s.title}`} onClick={() => void pin(p.s.id, !p.s.pinned)}>
                                <Show when={p.s.pinned} fallback={<Pin size={14} />}>
                                    <PinOff size={14} />
                                </Show>
                            </button>
                        </Show>
                    </Show>
                    <button ref={more} class="icon-btn icon-btn-sm" title="More" aria-label={`More for ${p.s.title}`} aria-haspopup="menu" aria-expanded={menu()} onClick={toggleMenu}>
                        <MoreHorizontal size={14} />
                    </button>
                </div>
            </Show>
            <RowMenu returnFocus={returnFocus} s={p.s} pick={p.pick} open={menu()} setOpen={setMenu} anchor={() => more ?? el} onRename={() => r.setEditing(true)} />
        </div>
    );
}

/**
 * Two or more rows picked: a bar under the list with what can be done to
 * all of them (only what applies: Restore for archived ones, Back in play when
 * every one is settled) and a way out.
 */
function SelectionBar(p: { count: number; plan: BulkPlan; act: (what: "settle" | "archive" | "delete") => void; clear: () => void; onKeyDown: (e: KeyboardEvent) => void }) {
    const n = () => sessionCount(p.count);
    return (
        <div class="selbar" role="toolbar" aria-label={`${n()} selected`} onKeyDown={p.onKeyDown}>
            <span class="selbar-count">{p.count} selected</span>
            <span class="grow" />
            <Show when={p.plan.settle.length}>
                <button class="icon-btn icon-btn-sm" title={withShortcut(`Settle ${sessionCount(p.plan.settle.length)}`, "sidebar:settleSelected")} aria-label={`Settle ${sessionCount(p.plan.settle.length)}`} onClick={() => p.act("settle")}>
                    <CheckCheck size={14} />
                </button>
            </Show>
            <Show when={p.plan.unsettle.length}>
                <button class="icon-btn icon-btn-sm" title={withShortcut("Back in play", "sidebar:settleSelected")} aria-label={`Back in play: ${n()}`} onClick={() => p.act("settle")}>
                    <Undo2 size={14} />
                </button>
            </Show>
            <Show when={p.plan.archive.length}>
                <button class="icon-btn icon-btn-sm" title={withShortcut(`Archive ${sessionCount(p.plan.archive.length)}`, "sidebar:archiveSelected")} aria-label={`Archive ${sessionCount(p.plan.archive.length)}`} onClick={() => p.act("archive")}>
                    <Archive size={14} />
                </button>
            </Show>
            <Show when={p.plan.restore.length}>
                <button class="icon-btn icon-btn-sm" title={withShortcut(`Restore ${n()}`, "sidebar:archiveSelected")} aria-label={`Restore ${n()}`} onClick={() => p.act("archive")}>
                    <ArchiveRestore size={14} />
                </button>
            </Show>
            <button class="icon-btn icon-btn-sm" data-danger title={withShortcut(`Delete ${n()}`, "sidebar:deleteSelected")} aria-label={`Delete ${n()}`} onClick={() => p.act("delete")}>
                <Trash2 size={14} />
            </button>
            <button class="icon-btn icon-btn-sm" title="Clear selection (Esc)" aria-label="Clear selection" onClick={p.clear}>
                <X size={14} />
            </button>
        </div>
    );
}

/**
 * The top line, level with the traffic lights (macOS): the app's mark where there are none, and at the rail's far
 * end its few tools (`tools`: open a project, how the list is shown) and the button that hides it. Shared with the
 * Settings rail.
 */
export function SidebarTop(p: { tools?: JSX.Element }) {
    return (
        <div class="sidebar-top side-top">
            <Show when={!(isDesktop && os === "macos")}>
                <Logo size={20} variant="brand" />
            </Show>
            <span class="grow" />
            {p.tools}
            <button class="icon-btn hb" title={withShortcut("Hide sidebar", "app:toggleSidebar")} aria-label="Hide sidebar" onClick={toggleSidebar}>
                <PanelLeftClose size={16} />
            </button>
        </div>
    );
}

/** The entries that head a group of the list (the design's section.sgroup). */
const HEADS = new Set<SidebarEntry["kind"]>(["needs", "day", "project", "settled", "snoozed", "archived"]);
/** `next`, or `previous` when it holds the same keys: a list's For keeps its rows while nothing moved. */
const sameKeys = (previous: string[] | undefined, next: string[]) => (previous?.length === next.length && previous.every((key, i) => key === next[i]) ? previous : next);

export function SidebarFrame(p: { children: any; class?: string; tools?: JSX.Element }) {
    const onResize = (e: PointerEvent) => {
        const dragStart = e.clientX;
        const widthStart = prefs.sidebarWidth;
        // Shown once a frame (the window's --rail-w), saved to the preferences on release.
        const drag = frameDrag({
            show: setRailDrag,
            commit: (w) => batch(() => {
                if (w !== undefined) setPrefs("sidebarWidth", w);
                setRailDrag(undefined);
            }),
        });
        const move = (ev: PointerEvent) => drag.move(Math.max(220, Math.min(420, widthStart + ev.clientX - dragStart)));
        const up = () => {
            drag.end();
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", up);
            document.body.classList.remove("resizing");
        };
        document.body.classList.add("resizing");
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
    };
    return (
        <aside class={`sidebar ${isDesktop && os === "macos" ? "traffic" : ""} ${p.class ?? ""}`} aria-label="Sessions">
            <SidebarTop tools={p.tools} />
            {p.children}
            <div class="resize-handle" onPointerDown={onResize} onDblClick={() => setPrefs("sidebarWidth", 280)} />
        </aside>
    );
}

export function Sidebar() {
    const [showArchived, setShowArchived] = createSignal(false);
    const [viewOpen, setViewOpen] = createSignal(false);
    const [shown, setShown] = createSignal(PAGE);
    const [settledShown, setSettledShown] = createSignal(PAGE);
    const [snoozedOpen, setSnoozedOpen] = createSignal(false);
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
    const all = createMemo(() => [...app.sessions, ...app.archived]);
    const sessions = createMemo(() => new Map(all().map((s) => [s.id, s])));
    const settledCount = () => app.sessions.filter((s) => s.settled && !isSnoozed(s)).length;
    const snoozedCount = () => app.sessions.filter(isSnoozed).length;
    // Providers by the sessions that used them, most recent first: the plan used last leads when no session is open.
    const recent = createMemo(() => [...new Set([...app.sessions].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => modelOf(s)?.split(":")[0]).filter((p): p is string => Boolean(p)))]);
    // While rows are picked they stay put too, so a range never jumps under the pointer or the keys.
    const held = () => ((hovered() || railSelection().ids.length > 0) && !manualLayout() && !railFree()) || locked().size > 0;
    // Needs you isn't in a selection's range, so rows picked don't hold it: only the pointer or an open menu does.
    const pinnedHeld = () => (hovered() && !manualLayout() && !railFree()) || locked().size > 0;
    // Waiting on you, but the session in front of you (not under Settings or a sub-agent's view: lib/rail.ts inFront): pinned at the top as well.
    const needs = createMemo(() => needsYou(all(), inFront({ activeId: app.activeId, settings: Boolean(settingsTab()), agentFocus: agentFocus() }), besideInFront(Boolean(settingsTab()))).map((s) => s.id), undefined, { equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]) });
    // Today's midnight: the day headings move when the date does, not with every tick of the clock.
    const today = createMemo(() => new Date(now()).setHours(0, 0, 0, 0));
    // The whole list, each session in its own place: what holds still while the pointer's on the rail.
    const heldLayout = createMemo<SidebarEntry[]>((previous) => {
        const next = sidebarEntries(app.sessions, app.archived, {
            activeId: app.activeId, groupBy: prefs.groupBy, archived: showArchived(),
            settledOpen: prefs.settledOpen, snoozedOpen: snoozedOpen(), cards: shown(), settled: settledShown(), archive: archiveShown(),
            collapsed: prefs.collapsedProjects, foldedDays: prefs.foldedDays, needs: needs(), now: prefs.groupBy === "date" ? today() : undefined,
        });
        return holdSidebar(previous ?? [], next, held(), all(), app.activeId, pinnedHeld());
    });
    // What's drawn: a session under Needs you shows there alone, not again in its place below.
    const layout = createMemo(() => listedOnce(heldLayout()));
    const entriesByKey = createMemo(() => new Map(layout().map((entry) => [entry.key, entry])));
    const counts = createMemo(() => groupCounts(layout()));
    // The list in the design's groups: a heading starts one (Needs you, a day, a project, Snoozed, Settled, Archived)
    // and what follows, up to the next, is in it. Each group's keys are the same array while its order holds: rows
    // take their new places at once, nothing in the rail slides or fades.
    const groups = createMemo(() => {
        const order: string[] = [];
        const items = new Map<string, string[]>();
        let at = "";
        for (const entry of layout()) {
            if (HEADS.has(entry.kind)) {
                at = entry.key;
                order.push(at);
                items.set(at, []);
                continue;
            }
            if (!items.has(at)) (order.push(at), items.set(at, []));
            items.get(at)!.push(entry.key);
        }
        return { order, items };
    });
    const groupKeys = createMemo<string[]>((previous) => sameKeys(previous, groups().order));
    // Each session in its own place, pinned under Needs you or not: opening one mustn't change what next and previous step to.
    createEffect(() => setSidebarOrder(sidebarIds(heldLayout())));
    onCleanup(() => setSidebarOrder(undefined));
    // A snoozed session waking (its time come, or it needs you) leaves Snoozed then, the pointer on the rail or not: the
    // user chose the time. The one on screen too: it was held in the shelf, where the rail had it, until the pointer left.
    createEffect(on(() => app.sessions.filter(isSnoozed).map((s) => s.id), (ids, was) => {
        if (was?.some((id) => !ids.includes(id))) allowLayout();
    }, { defer: true }));
    const showMore = (page: "cards" | "settled" | "archived") => {
        if (page === "cards") setShown((n) => n + PAGE);
        else if (page === "settled") setSettledShown((n) => n + PAGE);
        else setArchiveShown((n) => n + PAGE);
        // Explicit paging is intentional movement, even with the pointer on its button.
        allowLayout();
    };

    // ---- Folding a project's sessions (grouped by project), or a day's, under its heading: at once ----
    const setFolded = (next: string[]) => {
        // An explicit change: it shows at once, under the pointer or with rows picked.
        allowLayout();
        setPrefs("collapsedProjects", next);
    };
    const setDaysFolded = (next: DayLabel[]) => {
        allowLayout();
        setPrefs("foldedDays", next);
    };
    /** A project's (by its path) or a day's. */
    const toggleFold = (cwd: string, day?: DayLabel) => (day ? setDaysFolded(toggleProject(prefs.foldedDays, day)) : setFolded(toggleProject(prefs.collapsedProjects, cwd)));
    const projectsInPlay = createMemo(() => [...new Set(app.sessions.filter((s) => !s.settled).map(projectOf))]);
    // Opening a session in a folded project (⌘K, a notification) unfolds it, so the open row shows.
    createEffect(on(() => [app.activeId, Boolean(app.activeId && sessions().has(app.activeId))] as const, ([id]) => {
        const next = revealProject(prefs.collapsedProjects, id ? sessions().get(id) : undefined, prefs.groupBy);
        if (next !== prefs.collapsedProjects) setFolded([...next]);
        const days = revealDay(prefs.foldedDays, id ? sessions().get(id) : undefined, prefs.groupBy, now());
        if (days !== prefs.foldedDays) setDaysFolded([...days]);
    }));

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
        [...(listEl?.querySelectorAll<HTMLElement>("[data-session-id]") ?? [])].find((el) => el.dataset.sessionId === id)?.querySelector<HTMLElement>("button.srow-main") ?? undefined;
    const focusHit = (hit: HTMLElement | undefined) => {
        hit?.focus({ preventScroll: true });
        hit?.scrollIntoView({ block: "nearest" });
    };
    const focusRow = (id: string | undefined) => focusHit(id ? rowHit(id) : undefined);
    /** ↑/↓: the next row as the rail shows it, Needs you's included (a row being renamed has none). */
    const stepFocus = (row: HTMLElement, dir: 1 | -1) => {
        const hits = [...(listEl?.querySelectorAll<HTMLElement>("button.srow-main") ?? [])];
        const at = hits.indexOf(row.querySelector<HTMLElement>("button.srow-main")!);
        if (at >= 0) focusHit(hits[at + dir]);
    };
    const clear = (refocus = false) => {
        const sel = railSelection();
        setRailSelection({ ids: [], anchor: sel.anchor });
        // The bar goes with the selection: its focus goes back to the list.
        if (refocus) focusRow(sel.anchor && order().includes(sel.anchor) ? sel.anchor : sel.ids[0]);
    };
    const pick: RailPick = {
        picked: (id) => picked().has(id),
        picking: () => picked().size > 0,
        click: (e, id) => {
            const kind = clickKind(e, os === "macos");
            setRailSelection(clickSelect(railSelection(), id, kind, order(), listOf));
            // The one shown already: nothing to open, and the keyboard goes back to its composer, as for any other.
            if (kind === "plain" && id === app.activeId && !agentFocus() && handleFor(id) && !app.opening) return void requestComposerFocus();
            if (kind === "plain") return void activate(id);
            // The keys that act on the selection need the focus in the list (WebKit doesn't focus a clicked button).
            (e.currentTarget as HTMLElement | null)?.focus?.({ preventScroll: true });
        },
        open: (id) => {
            setRailSelection(clickSelect(railSelection(), id, "plain", order(), listOf));
            void openWaiting(id);
        },
        group: (id) => (selected().length > 1 && picked().has(id) ? selected() : undefined),
        plan,
        clear: () => clear(),
    };
    /** One thing in a group's list: a session's row, a run's rows under its prompt, or "Show more". */
    const item = (key: string) => {
        const entry = () => entriesByKey().get(key);
        // A held row keeps its component (and menu/rename) through status changes.
        const kind = untrack(() => entry()?.kind);
        if (kind === "run") {
            const group = () => entry() as Extract<SidebarEntry, { kind: "run" }>;
            const members = () => (group()?.ids ?? []).filter((id) => sessions().has(id));
            const run = () => sessions().get(members()[0]!)?.run;
            return <div class="srun" role="group" aria-label={`${members().length} models: ${run()?.label ?? ""}`}>
                <div class="srun-head" title={run()?.label}>
                    <Layers size={13} class="srun-icon" /><span class="srun-label">{run()?.label}</span><span class="sgroup-count">{members().length}</span>
                </div>
                <div class="srun-list"><For each={members()}>{(id) => (
                    <Show when={sessions().get(id)}>{(s) => (
                        <Show when={!group().row} fallback={<SessionRow s={s()} kind="slim" hold={hold} pick={pick} />}>
                            <SessionRow s={s()} kind="card" hold={hold} pick={pick} />
                        </Show>
                    )}</Show>
                )}</For></div>
            </div>;
        }
        if (kind === "card" || kind === "row") {
            return <Show when={sessions().get(key)}>{(s) => (
                <Show when={entry()?.kind === "card"} fallback={<SessionRow s={s()} kind="slim" hold={hold} pick={pick} />}>
                    <SessionRow s={s()} kind="card" hold={hold} pick={pick} />
                </Show>
            )}</Show>;
        }
        const more = () => entry() as Extract<SidebarEntry, { kind: "more" }> | undefined;
        return <button class="sgroup-more" onClick={() => more() && showMore(more()!.page)}>Show {Math.min(PAGE, more()?.remaining ?? 0)} more</button>;
    };
    /** Settle, archive or delete what's selected (else the focused or open row), as a key or the bar asks. */
    const act = (what: "settle" | "archive" | "delete", ids: readonly string[]) => {
        const p = plan(ids);
        if (what === "delete") return void deleteSessions(p.delete);
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
        // A row under Needs you acts on its session too; it only isn't where a Shift+arrow range runs.
        const row = target?.closest?.<HTMLElement>("[data-session-id], [data-needs-id]");
        const pinned = row?.dataset.needsId;
        const focused = row?.dataset.sessionId ?? pinned;
        const bare = !e.metaKey && !e.ctrlKey && !e.altKey;
        if ((e.key === "ArrowDown" || e.key === "ArrowUp") && bare && row && focused) {
            e.preventDefault();
            const dir = e.key === "ArrowDown" ? 1 : -1;
            if (!e.shiftKey || pinned) return stepFocus(row, dir);
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
        // A pinned row's own place may be folded away: it's still the one the key is about.
        const ids = pinned && !railSelection().ids.length ? [pinned] : railTargets(railSelection(), focused, app.activeId, order());
        if (action === "sidebar:deleteSelected") act("delete", ids);
        else if (action === "sidebar:settleSelected") act("settle", ids);
        else if (action === "sidebar:archiveSelected") act("archive", ids);
    };

    return (
        <SidebarFrame
            tools={
                <>
                    <button
                        class="icon-btn hb"
                        title="Open project…"
                        aria-label="Open project"
                        onClick={async () => {
                            const path = await chooseProject();
                            if (path) void openProject(path);
                        }}
                    >
                        <FolderPlus size={16} />
                    </button>
                    <button ref={viewBtn} class={`icon-btn hb ${viewOpen() ? "on" : ""}`} title="View options" aria-label="View options" aria-haspopup="menu" aria-expanded={viewOpen()} onClick={() => setViewOpen(!viewOpen())}>
                        <ListFilter size={16} />
                    </button>
                    <Menu label="View options" open={viewOpen()} anchor={() => viewBtn} onClose={() => setViewOpen(false)} align="end" width={190} class="menu">
                        <div class="menu-label">Group</div>
                        <button role="menuitemradio" aria-checked={prefs.groupBy === "date"} class="menu-item" onClick={() => (setPrefs("groupBy", "date"), setViewOpen(false))}>
                            <span class="menu-check"><Show when={prefs.groupBy === "date"}><Check size={14} /></Show></span>
                            <span class="menu-item-name">By date</span>
                        </button>
                        <button role="menuitemradio" aria-checked={prefs.groupBy === "project"} class="menu-item" onClick={() => (setPrefs("groupBy", "project"), setViewOpen(false))}>
                            <span class="menu-check"><Show when={prefs.groupBy === "project"}><Check size={14} /></Show></span>
                            <span class="menu-item-name">By project</span>
                        </button>
                        <Show when={prefs.groupBy === "project" && !showArchived()}>
                            <div class="menu-sep" />
                            <Show when={projectsInPlay().some((c) => !prefs.collapsedProjects.includes(c))}>
                                <button role="menuitem" class="menu-item" onClick={() => (setViewOpen(false), setFolded([...new Set([...prefs.collapsedProjects, ...projectsInPlay()])]))}>
                                    <ChevronsDownUp size={14} /><span class="menu-item-name">Collapse all projects</span>
                                </button>
                            </Show>
                            <Show when={prefs.collapsedProjects.length}>
                                <button role="menuitem" class="menu-item" onClick={() => (setViewOpen(false), setFolded([]))}>
                                    <ChevronsUpDown size={14} /><span class="menu-item-name">Expand all projects</span>
                                </button>
                            </Show>
                        </Show>
                        <div class="menu-sep" />
                        <button role="menuitem" class="menu-item" onClick={() => (setShowArchived(!showArchived()), setViewOpen(false))}>
                            <Archive size={14} /><span class="menu-item-name">{showArchived() ? "Show active sessions" : `Show archived (${app.archived.length})`}</span>
                        </button>
                        <button role="menuitem" class="menu-item" onClick={() => (setViewOpen(false), setDeletedOpen(true))}>
                            <Trash2 size={14} /><span class="menu-item-name">Recently deleted</span>
                        </button>
                    </Menu>
                </>
            }
        >
            <div class="sidebar-actions">
                <button class="new-session nav-row" title={withShortcut("New session", "app:newSession")} onClick={() => (setSettingsTab(undefined), newSession(app.homeCwd))}>
                    <SquarePen size={15} />
                    <span>New session</span>
                    <NavKeys action="app:newSession" />
                </button>
                <button class="search" title={withShortcut("Search", "app:commandPalette")} onClick={() => setPaletteOpen(true)}>
                    <Search size={14} class="search-icon" />
                    <span class="search-label">Search</span>
                    <NavKeys action="app:commandPalette" />
                </button>
            </div>

            <nav ref={listEl} class="sidebar-list side-list" data-group={prefs.groupBy} aria-label="Session list" onKeyDown={onRailKey}
                onDragStart={dragRow}
                onDragEnd={() => setDraggedSession(undefined)}
                onPointerEnter={() => (setHovered(true), RowExtras.preload())}
                onFocusIn={() => RowExtras.preload()}
                onPointerLeave={() => setHovered(false)}
                // Another machine's session: connected to as the pointer comes to it (warmFor), not as it's clicked.
                onPointerOver={(e) => {
                    const id = (e.target as HTMLElement | null)?.closest?.("[data-session-id]")?.getAttribute("data-session-id");
                    if (id) warmFor(id);
                }}>
                <For each={groupKeys()}>{(gkey) => {
                    const items = createMemo<string[]>((previous) => sameKeys(previous, groups().items.get(gkey) ?? []));
                    const head = () => entriesByKey().get(gkey);
                    // A group keeps its component (and its rows' menus and renames) through changes to its heading.
                    const kind = untrack(() => head()?.kind);
                    const rows = () => (
                        <Show when={items().length}>
                            <div class="sgroup-list"><For each={items()}>{(key) => item(key)}</For></div>
                        </Show>
                    );
                    if (kind === "needs") {
                        const members = () => (head() as Extract<SidebarEntry, { kind: "needs" }>).ids.filter((id) => sessions().has(id));
                        return <section class="sgroup sgroup-needs" role="group" aria-label={`Needs you: ${sessionCount(members().length)}`}>
                            <div class="sgroup-head"><span class="sgroup-toggle sgroup-static"><span class="sgroup-label">Needs you</span><span class="sgroup-count">{members().length}</span></span></div>
                            <div class="sgroup-list"><For each={members()}>{(id) => <Show when={sessions().get(id)}>{(s) => <SessionRow s={s()} kind="needs" hold={hold} pick={pick} />}</Show>}</For></div>
                        </section>;
                    }
                    if (kind === "project") {
                        const group = () => head() as Extract<SidebarEntry, { kind: "project" }>;
                        const open = () => !group().collapsed;
                        // Folded, a session in it that needs you still shows: the amber dot, on the heading.
                        const needsYou = () => !open() && (group().ids ?? []).some((id) => sessions().get(id)?.status === "waiting");
                        return <section class="sgroup" aria-label={group().name}>
                            <div class="sgroup-head" data-head={gkey}>
                                <button class="sgroup-toggle" aria-expanded={open()} title={(group().machine ? `${group().machine}: ` : "") + folderOf(group().cwd)} onClick={() => toggleFold(group().cwd)}>
                                    <Show when={open()} fallback={<Folder size={13} class="sgroup-folder" />}><FolderOpen size={13} class="sgroup-folder" /></Show>
                                    <span class="sgroup-label sgroup-label-project">{group().name}</span>
                                    <Show when={group().machine}><span class="sgroup-machine">{group().machine}</span></Show>
                                    {/* Folded, how many are under it. Open, its rows say so. */}
                                    <Show when={!open()}><span class="sgroup-count">{group().collapsed ? counts().get(gkey) : app.sessions.filter((s) => !s.settled && projectOf(s) === group().cwd).length}</span></Show>
                                    <Show when={needsYou()}><span class="dot" data-tone="amber" role="img" aria-label="A session here needs you" title="A session here needs you" /></Show>
                                </button>
                                <button class="icon-btn icon-btn-sm sgroup-add" title={`New session in ${group().name}`} aria-label={`New session in ${group().name}`} onClick={() => newSession(folderOf(group().cwd), group())}><Plus size={14} /></button>
                            </div>
                            {rows()}
                        </section>;
                    }
                    if (kind === "day") {
                        const day = () => head() as Extract<SidebarEntry, { kind: "day" }>;
                        const shut = () => Boolean(day().collapsed);
                        // Folded, a session under it that needs you still shows: the amber dot, as a project's heading does.
                        const needsYou = () => shut() && (day().ids ?? []).some((id) => sessions().get(id)?.status === "waiting");
                        return <section class="sgroup" aria-label={day().label}>
                            <div class="sgroup-head" data-head={gkey}>
                                <button class="sgroup-toggle" aria-expanded={!shut()} onClick={() => toggleFold("", day().label)}>
                                    <ChevronRight size={12} class="sgroup-chevron" data-open={!shut() || undefined} />
                                    <span class="sgroup-label">{day().label}</span>
                                    <Show when={shut()}><span class="sgroup-count">{day().ids?.length ?? app.sessions.filter((s) => !s.settled && dayOf(s, today()) === day().label).length}</span></Show>
                                    <Show when={needsYou()}><span class="dot" data-tone="amber" role="img" aria-label="Needs you" title="Needs you" /></Show>
                                </button>
                            </div>
                            {rows()}
                        </section>;
                    }
                    // At the foot of the list, under a gap that takes the room left: it stays put as sessions come and go above it.
                    // Snoozed (above Settled) the same, folded until opened: the gap goes above whichever comes first.
                    if (kind === "settled" || kind === "snoozed") {
                        const z = kind === "snoozed";
                        const open = () => (z ? snoozedOpen() : prefs.settledOpen);
                        const first = () => z || !snoozedCount();
                        return <>
                            <Show when={first()}><div class="settled-gap" aria-hidden="true" /></Show>
                            <section class={first() ? "sgroup sgroup-settled" : "sgroup"} aria-label={z ? "Snoozed" : "Settled"}>
                                <div class="sgroup-head" data-head={gkey}>
                                    <button class="sgroup-toggle" aria-expanded={open()} onClick={() => { allowLayout(); z ? setSnoozedOpen(!open()) : setPrefs("settledOpen", !open()); }}>
                                        <ChevronRight size={12} class="sgroup-chevron" data-open={open() || undefined} />
                                        <span class="sgroup-label">{z ? "Snoozed" : "Settled"}</span>
                                        <span class="sgroup-count">{z ? snoozedCount() : settledCount()}</span>
                                    </button>
                                </div>
                                {rows()}
                            </section>
                        </>;
                    }
                    if (kind === "archived") {
                        return <section class="sgroup" aria-label="Archived">
                            <div class="sgroup-head">
                                <span class="sgroup-toggle sgroup-static"><span class="sgroup-label">Archived</span><span class="sgroup-count">{app.archived.length}</span></span>
                                <button class="btn btn-sm" onClick={() => { allowLayout(); setShowArchived(false); }}>Done</button>
                            </div>
                            {rows()}
                        </section>;
                    }
                    // Rows before any heading.
                    return <section class="sgroup">{rows()}</section>;
                }}</For>
                <Show when={app.sessionsError || (!sidebarIds(layout()).length && !layout().some((e) => e.kind === "settled" || e.kind === "snoozed" || ((e.kind === "day" || e.kind === "project") && e.collapsed)))}>
                    {/* In the place of the first day's heading, the size of one: where the first session's "Today" comes. */}
                    <div class="sidebar-state">
                        <Show when={app.sessionsError} fallback={!app.sessionsLoaded ? app.conn === "open" ? "Loading sessions…" : "Connecting…" : showArchived() ? "Nothing archived" : "No sessions yet"}>
                            <span>Couldn't load sessions</span>
                            <button class="btn btn-sm" onClick={() => void refreshSessions().catch(reportError)}>Retry</button>
                        </Show>
                    </div>
                </Show>
            </nav>
            <Show when={selected().length > 1}>
                <SelectionBar count={selected().length} plan={selectedPlan()} act={(what) => act(what, selected())} clear={() => clear(true)} onKeyDown={onRailKey} />
            </Show>

            <div class="sidebar-foot">
                {/* The plans' chips: loaded a moment after the window, which has a gap of their width until then. */}
                <Suspense>
                    <PlanFooter recent={recent} />
                </Suspense>
                <span class="grow" />
                {/* If its chunk can't load, only the button is missing: the rest of the window carries on. */}
                <Show when={mayUpdate()}>
                    <ErrorBoundary fallback={null}>
                        <Suspense>
                            <UpdateButton />
                        </Suspense>
                    </ErrorBoundary>
                </Show>
                <button class="icon-btn" title={withShortcut("Settings", "app:settings")} aria-label="Settings" onClick={() => setSettingsTab("general")}>
                    <Settings size={16} />
                </button>
            </div>
        </SidebarFrame>
    );
}
