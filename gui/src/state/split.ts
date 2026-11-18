// Two sessions side by side: a session dragged from the rail onto the one in view goes to the half it was dropped on.
// Another dragged in takes the place of the one it's dropped on. The session focused (clicked or typed in) is app.activeId, so everything that acts on "the session"
// (the side panel, the model picker, Esc, the terminal) acts on it; the side panel shows its views, and each session's
// own (its pane, its diff reader, a sub-agent's view) come back when it's focused again. Picking a session outside
// the two shows it alone.

import { batch, createContext, createRoot, createSignal, useContext } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { activate, app, forgetSession, handleFor, machineOf, onScreen, openBeside, restoredFrom, wasDeleted } from "./app";
import { machine } from "../lib/platform";
import { RpcError } from "../lib/rpc";
import { safeRenderText } from "../lib/render-error";
import { agentFocus, inspectorPane, review, setAgentFocus, setInspectorPane, setReview, splitActions } from "./ui";
import type { InspectorPane } from "../lib/inspector";

export type Side = "left" | "right";
/** `added`: the one dropped last, on `side`; `anchor`, the other. `on`: the machine of each not on the window's ("" this computer). */
export interface Split { anchor: string; added: string; side: Side; on?: Record<string, string> }

const SPLIT_KEY = "cavvy.split";

function load(): Split | undefined {
    try {
        const s = JSON.parse(sessionStorage.getItem(SPLIT_KEY) ?? "null");
        if (typeof s?.anchor === "string" && typeof s.added === "string" && s.anchor !== s.added && (s.side === "left" || s.side === "right")) {
            // Opened from there again, their rows maybe not listed yet.
            for (const id of [s.anchor, s.added]) if (typeof s.on?.[id] === "string") restoredFrom(id, s.on[id]);
            return { anchor: s.anchor, added: s.added, side: s.side };
        }
    } catch { /* storage off: none */ }
    return undefined;
}

const [split, setSplitNow] = createSignal<Split | undefined>(load());
export { split };

function setSplit(s: Split | undefined) {
    setSplitNow(s);
    try {
        if (s) {
            const on: Record<string, string> = {};
            for (const id of [s.anchor, s.added]) {
                const m = machineOf(id);
                if (m !== machine) on[id] = m ?? "";
            }
            sessionStorage.setItem(SPLIT_KEY, JSON.stringify(Object.keys(on).length ? { ...s, on } : s));
        }
        else sessionStorage.removeItem(SPLIT_KEY);
    } catch { /* in memory only */ }
}

/** The two sessions, left to right; none outside a split. */
export function splitIds(s = split()): [string, string] | undefined {
    if (!s) return undefined;
    return s.side === "left" ? [s.added, s.anchor] : [s.anchor, s.added];
}

export const inSplit = (id: string | undefined, s = split()) => Boolean(id && s && (s.anchor === id || s.added === id));

/** What each session in the split had in the side panel and on its stage, kept while the other is focused. */
interface Kept { review?: ReturnType<typeof review>; pane?: InspectorPane; agent?: string }
const [kept, setKept] = createRoot(() => createStore<Record<string, Kept | undefined>>({}));

/** The sub-agent a pane shows: the focused one's is agentFocus; the other's, what it had when focus left it. */
export function paneAgent(id: string): string | undefined {
    return app.activeId === id ? agentFocus() : kept[id]?.agent;
}

/** In a split, the session beside the focused one, with its request card on screen too (not under Settings, nor a sub-agent's view). */
export function besideInFront(settings: boolean): string | undefined {
    const s = split();
    if (!s || settings) return undefined;
    const other = app.activeId === s.anchor ? s.added : s.anchor;
    return paneAgent(other) ? undefined : other;
}

/**
 * The session beside the focused one has its diff reader open (kept while it's not focused): the side panel stays
 * open, as wide, showing the focused one's views, so nothing moves as focus goes between them (App.tsx).
 */
export function besideReads(): boolean {
    const s = split();
    if (!s) return false;
    return Boolean(kept[app.activeId === s.anchor ? s.added : s.anchor]?.review);
}

/** The side panel closed while held open by the other's reader: the reader goes. False if it wasn't held. */
function closeBesideReader(): boolean {
    const s = split();
    if (!s || !besideReads()) return false;
    const other = app.activeId === s.anchor ? s.added : s.anchor;
    setKept(other, "review", undefined);
    return true;
}

/** Whether `id` can be dragged in beside what's in view (or, in a split, in place of either), on whichever machine. */
export function canDrop(id: string): boolean {
    const shown = app.activeId;
    if (!shown || !handleFor(shown)) return false;
    if (![...app.sessions, ...app.archived].some((x) => x.id === id)) return false;
    return id !== shown && !inSplit(id);
}

/**
 * `id` dropped on the stage's `side`: beside the session in view, or in a split in place of the one there; and
 * focused. It opens there if it isn't open yet.
 */
export function dropSession(id: string, side: Side) {
    if (!canDrop(id)) return;
    const s = split();
    batch(() => {
        if (s) {
            const [left, right] = splitIds(s)!;
            setKept(side === "left" ? left : right, undefined);
            setSplit({ anchor: side === "left" ? right : left, added: id, side });
        } else setSplit({ anchor: app.activeId!, added: id, side });
        void activate(id);
    });
}

/** Focus one of the split's sessions: what acts on "the session" acts on it. */
export function focusPane(id: string) {
    if (app.activeId !== id && inSplit(id)) void activate(id);
}

/** What the session left alone by a closing pane had, for when it's focused (focusMoved). */
let handoff: { to: string; kept?: Kept } | undefined;

/** Close one of the two: the other is shown alone, focused if this one was. */
export function closePane(id: string) {
    const s = split();
    if (!s || !inSplit(id, s)) return;
    const other = s.anchor === id ? s.added : s.anchor;
    batch(() => {
        setSplit(undefined);
        setKept(id, undefined);
        if (app.activeId === other) setKept(other, undefined);
        else {
            handoff = { to: other, kept: kept[other] };
            setKept(other, undefined);
            void activate(other);
        }
    });
}

function restore(k: Kept | undefined) {
    setAgentFocus(k?.agent);
    // As it was set, not the store's proxy of it.
    setReview(k?.review && { ...unwrap(k.review) });
    if (k?.pane) setInspectorPane(k.pane);
}

/**
 * The session in view changed (App.tsx), from `from` to `to`. Between the split's two, each one's panel and stage
 * come back as it left them: true when it was that (or the one a closed pane left). Anywhere else, the split ends.
 */
export function focusMoved(from: string | undefined, to: string | undefined): boolean {
    const h = handoff;
    handoff = undefined;
    if (h && h.to === to) return restore(h.kept), true;
    const s = split();
    if (!s) return false;
    if (!inSplit(to, s)) {
        // The focused one deleted: its pane closes, and the other stays.
        if (to === undefined && inSplit(from, s) && wasDeleted(from!)) return closePane(from!), true;
        batch(() => {
            setSplit(undefined);
            setKept(s.anchor, undefined);
            setKept(s.added, undefined);
        });
        return false;
    }
    batch(() => {
        if (inSplit(from, s)) setKept(from!, { review: review(), pane: inspectorPane(), agent: agentFocus() });
        restore(kept[to!]);
    });
    return true;
}

/** `id` is leaving the screen (archived): in a split, only its pane closes. Returns whether it was in one. */
export function leaveSplit(id: string): boolean {
    if (!inSplit(id)) return false;
    closePane(id);
    return true;
}

splitActions.leave = leaveSplit;
splitActions.closeBesideReader = closeBesideReader;

/** One of the split's sessions deleted, here or elsewhere: its pane closes. */
export function prune() {
    const s = split();
    if (!s) return;
    for (const id of [s.anchor, s.added]) if (wasDeleted(id)) return closePane(id);
}

/** After a reload: a split the session in view isn't in is over. (Its other session opens in its pane: Panes.tsx.) */
export function restoreSplit() {
    const s = split();
    if (s && !inSplit(app.activeId, s)) setSplit(undefined);
}

/**
 * The one of two not focused, opening in its own pane (the focused one's open is app.opening): after a moment, that
 * it's opening; or why it couldn't. As after a reload, or when the other was focused before the one dropped had opened.
 */
const [paneOpening, setPaneOpening] = createRoot(() => createStore<Record<string, { visible: boolean; error?: string } | undefined>>({}));
export { paneOpening };
const paneOpens = new Map<string, number>();
let opens = 0;

export function openPane(id: string) {
    const n = ++opens;
    paneOpens.set(id, n);
    setPaneOpening(id, { visible: false });
    const current = () => paneOpens.get(id) === n;
    const shown = setTimeout(() => {
        if (current() && !paneOpening[id]?.error) setPaneOpening(id, "visible", true);
    }, 400);
    openBeside(id).then(
        () => {
            clearTimeout(shown);
            if (current()) endPaneOpen(id);
        },
        (e) => {
            clearTimeout(shown);
            if (!current()) return;
            // Gone: its pane closes (prune).
            if (e instanceof RpcError && e.code === "not_found") return endPaneOpen(id), forgetSession(id);
            setPaneOpening(id, { visible: true, error: safeRenderText(e instanceof Error ? e.message : String(e)) || "Opening failed. Try again." });
        },
    );
}

/** Its pane is gone, or the connection with it: what its open comes back with is no one's. */
export function endPaneOpen(id: string) {
    paneOpens.delete(id);
    if (paneOpening[id]) setPaneOpening(id, undefined);
}

// Both stay open while they're on screen, the one not focused too.
onScreen.beside = () => splitIds() ?? [];

const RATIO_KEY = "cavvy.splitRatio";
/** How much of the column the left session takes: as the bar between them was left (kept on this device), else half. */
const [splitRatio, setSplitRatio] = createSignal(((r) => (r > 0 && r < 1 ? r : 0.5))(Number(globalThis.localStorage?.getItem(RATIO_KEY))));
/** The share the bar is being dragged to, shown until the release saves it. */
export const [splitDrag, setSplitDrag] = createSignal<number>();
export { splitRatio };
export function saveSplitRatio(r: number) {
    setSplitRatio(r);
    try { localStorage.setItem(RATIO_KEY, String(r)); } catch { /* private mode: this run only */ }
}

/** The session being dragged from the rail, while it is (Sidebar.tsx): the stage shows where it would go. */
export const [draggedSession, setDraggedSession] = createSignal<string>();
/** What a session row's drag carries. */
export const SESSION_DRAG = "application/x-cavvy-session";

/**
 * The pane a component is in (components/Panes.tsx): its session, whether it's the one focused, and whether it's the
 * rightmost one (a floating inspector floats over it); `share`, how much of the column it is. `wasFocused`: it was focused before the press under way,
 * which focused it (a press on the other pane's side-panel button shows its panel rather than closing the panel).
 * Outside a split: the one, focused. `parked`: the one shown before, kept out of sight to be shown again as it was
 * (Panes.tsx); not focused.
 */
export interface Pane { id?: string; focused: () => boolean; parked: () => boolean; split: () => boolean; rightmost: () => boolean; share: () => number; wasFocused: () => boolean }
export const PaneContext = createContext<Pane>({ focused: () => true, parked: () => false, split: () => false, rightmost: () => true, share: () => 1, wasFocused: () => true });
export const usePane = () => useContext(PaneContext);
