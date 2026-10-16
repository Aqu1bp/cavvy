// The GUI's state: the connection, the sidebar's sessions, models, providers
// and projects, and every open session's timeline (kept current from the
// server's ops, applied once per frame).

import { batch, createEffect, createRoot, createSignal } from "solid-js";
import { createStore, produce, reconcile, type SetStoreFunction } from "solid-js/store";
import { planLimitKey, type PlanLimits } from "@shared/protocol";
import type { GuiSettings, HelloResult, PermissionModeId, ProjectInfo, ProviderInfo, ProviderModels, ServerEvent, SessionOp, SessionSnapshot, SessionSummary, WireFile } from "@shared/protocol";
import { applyOp, type SessionView } from "@shared/timeline";
import { Rpc, RpcError, type ConnectionState } from "../lib/rpc";
import { credentials, focused, notify, isTauri } from "../lib/platform";
import { prefs } from "./prefs";
import { mayCreateFiles } from "../lib/pathcache";
// filelinks imports rpc from here: used only once events arrive, so the cycle is harmless.
import { paths } from "./filelinks";
import { repeatedToast, ToastLifetime, toastMs, type Toast, type ToastAction } from "../lib/toasts";
export type { Toast } from "../lib/toasts";
import { afterFailedReopen } from "../lib/reopen";
import { jumpTarget, setFindOpen, setJumpTarget } from "./ui";
import { composerDrafts } from "../lib/composer-draft";

export const rpc = new Rpc(credentials);
rpc.retriesCredentials = isTauri;

// ---------------------------------------------------------------------------
// Toasts

// Two wrapped rows fit above Home's input even in a 600px-tall window.
const MAX_TOASTS = 2;
const MAX_QUEUED_TOASTS = 10;
let toastId = 0;
export const [toasts, setToasts] = createStore<Toast[]>([]);
const toastTimers = new Map<number, { life: ToastLifetime; duration: number; message: string; timer?: ReturnType<typeof setTimeout> }>();
const toastQueue: (Toast & { duration: number })[] = [];

function showQueuedToasts() {
    while (toasts.length < MAX_TOASTS && toastQueue.length) {
        const { duration, ...item } = toastQueue.shift()!;
        // Waiting in the queue uses none of the toast's visible lifetime.
        const life = new ToastLifetime(duration, performance.now());
        if (document.hidden) life.pause("hidden", performance.now());
        toastTimers.set(item.id, { life, duration, message: item.message });
        setToasts((t) => [...t, item]);
        scheduleToast(item.id);
    }
}

function scheduleToast(id: number) {
    const entry = toastTimers.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (!entry.life.paused) entry.timer = setTimeout(() => dismissToast(id), entry.life.remaining(performance.now()));
}

export function pauseToast(id: number, reason: "hover" | "focus" | "hidden", paused: boolean) {
    const entry = toastTimers.get(id);
    if (!entry) return;
    if (paused) entry.life.pause(reason, performance.now());
    else entry.life.resume(reason, performance.now());
    scheduleToast(id);
}

export function toast(message: string, level: Toast["level"] = "info", action?: ToastAction, ms?: number) {
    const existing = repeatedToast(toasts, message, level, action);
    if (existing) {
        const index = toasts.findIndex((t) => t.id === existing.id);
        setToasts(index, "count", existing.count + 1);
        toastTimers.get(existing.id)?.life.restart(toastMs(level, ms), performance.now());
        scheduleToast(existing.id);
        return;
    }
    const waiting = repeatedToast(toastQueue, message, level, action);
    if (waiting) {
        waiting.count++;
        return;
    }
    toastQueue.push({ id: ++toastId, level, message, count: 1, action, duration: toastMs(level, ms) });
    if (toasts.length >= MAX_TOASTS) {
        const idle = toasts.find((t) => !t.action && !t.running && !toastTimers.get(t.id)?.life.interacting);
        if (idle) dismissToast(idle.id);
    }
    showQueuedToasts();
    while (toastQueue.length > MAX_QUEUED_TOASTS) {
        const oldest = toastQueue.findIndex((t) => !t.action);
        // Recovery actions take precedence over the queue limit when none can be dropped.
        if (oldest < 0) break;
        toastQueue.splice(oldest, 1);
    }
}

export function dismissToast(id: number) {
    clearTimeout(toastTimers.get(id)?.timer);
    toastTimers.delete(id);
    setToasts((t) => t.filter((x) => x.id !== id));
    showQueuedToasts();
}

export async function runToastAction(id: number) {
    const item = toasts.find((t) => t.id === id);
    const entry = toastTimers.get(id);
    if (!item?.action || item.running || !entry) return;
    setToasts((t) => t.id === id, "running", true);
    entry.life.pause("action", performance.now());
    scheduleToast(id);
    try {
        if ((await item.action.run()) !== false) {
            dismissToast(id);
            return;
        }
        throw new RpcError("Action failed. Try again.");
    } catch (e) {
        if (!toasts.some((t) => t.id === id)) {
            reportError(e);
            return;
        }
        // A separate error toast could evict another failed Undo under the two-row cap.
        const message = e instanceof Error ? e.message : String(e);
        setToasts((t) => t.id === id, { level: "error", message: `${entry.message}: ${message}` });
    } finally {
        // A failed action gets its full visible lifetime again, never an automatic retry.
        entry.life.restart(entry.duration, performance.now());
        entry.life.resume("action", performance.now());
        setToasts((t) => t.id === id, "running", false);
        scheduleToast(id);
    }
}

export function reportError(e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    toast(msg, "error");
}

// ---------------------------------------------------------------------------
// App store

export interface AppState {
    conn: ConnectionState;
    slowRequest: boolean;
    hello?: HelloResult;
    sessions: SessionSummary[];
    archived: SessionSummary[];
    models: ProviderModels[];
    modelsLoading: boolean;
    /** Models have been listed at least once (so "none" means none). */
    modelsLoaded: boolean;
    providers: ProviderInfo[];
    projects: ProjectInfo[];
    settings: GuiSettings;
    /** The session in the main view; none for the home screen. */
    activeId?: string;
    /** The project new sessions start in. */
    homeCwd?: string;
    /** The mode picked on the home screen, which new sessions start in; the saved default until then. */
    homeMode?: PermissionModeId;
    seen: Record<string, number>;
    /** The agent CLIs' plan limits, by provider and account: the account's, shared by its sessions. */
    limits: Record<string, PlanLimits>;
}

const SEEN_KEY = "harness.seen";
const NAVIGATION_KEY = "harness.navigation";

/** Per webview/tab, separate from device-wide preferences and auth links. */
function loadNavigation(): Pick<AppState, "activeId" | "homeCwd"> {
    try {
        const saved = JSON.parse(sessionStorage.getItem(NAVIGATION_KEY) ?? "null");
        return {
            activeId: typeof saved?.activeId === "string" && saved.activeId ? saved.activeId : undefined,
            homeCwd: typeof saved?.homeCwd === "string" && saved.homeCwd ? saved.homeCwd : undefined,
        };
    } catch {
        return {};
    }
}

function loadSeen(): Record<string, number> {
    try {
        return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "null") ?? {};
    } catch {
        return {};
    }
}

export const [app, setApp] = createStore<AppState>({
    conn: "connecting",
    slowRequest: false,
    sessions: [],
    archived: [],
    models: [],
    modelsLoading: false,
    modelsLoaded: false,
    providers: [],
    projects: [],
    settings: {},
    seen: loadSeen(),
    limits: {},
    ...loadNavigation(),
});

// Observe the store so all navigation paths (Home, send, import, deletion and
// sidebar activation) persist together, including direct setApp callers.
createRoot(() => createEffect(() => {
    const saved = JSON.stringify({ activeId: app.activeId, homeCwd: app.homeCwd });
    try {
        sessionStorage.setItem(NAVIGATION_KEY, saved);
    } catch {
        // Storage can be disabled; navigation still works in memory.
    }
}));

function saveSeen() {
    try {
        localStorage.setItem(SEEN_KEY, JSON.stringify(app.seen));
    } catch {
        // fine
    }
}

export function markSeen(id: string, at = Date.now()) {
    setApp("seen", id, at);
    saveSeen();
}

export function isUnread(s: SessionSummary): boolean {
    if (s.id === app.activeId || s.status === "running") return false;
    const seen = app.seen[s.id];
    return seen !== undefined ? s.updatedAt > seen + 1500 : false;
}

// ---------------------------------------------------------------------------
// Open sessions

/** What the server hands back to the input box. */
export interface Draft {
    text: string;
    images?: { mediaType: string; data: string }[];
    files?: WireFile[];
}

export interface SessionHandle {
    id: string;
    /** Reads can resume only after this handle's session has been opened on the server. */
    ready: () => boolean;
    setReady: (ready: boolean) => void;
    view: SessionView;
    set: SetStoreFunction<SessionView>;
    seq: number;
    queue: SessionOp[];
    scheduled: boolean;
    draft: () => Draft | undefined;
    setDraft: (d: Draft | undefined) => void;
    /** Hand back a draft, added to one no input box has taken yet. */
    addDraft: (d: Draft) => void;
    lastUsed: number;
}

const handles = new Map<string, SessionHandle>();
const [handleVersion, setHandleVersion] = createSignal(0);
const KEEP_OPEN = 8;

export function handleFor(id: string | undefined): SessionHandle | undefined {
    handleVersion();
    return id ? handles.get(id) : undefined;
}

function adopt(snap: SessionSnapshot): SessionHandle {
    const id = snap.state.id;
    // Ops missed while it wasn't open (or the connection was down) may have created files.
    paths.sawSnapshot(id);
    // There after all (brought back while this window was away).
    sessionPresent(id);
    const existing = handles.get(id);
    if (existing) {
        existing.seq = snap.seq;
        existing.queue = [];
        batch(() => {
            existing.set(reconcile({ state: snap.state, turns: snap.turns, agents: snap.agents ?? [] }, { key: "id", merge: false }));
            existing.setReady(true);
        });
        return existing;
    }
    const h = createRoot(() => {
        const [view, set] = createStore<SessionView>({ state: snap.state, turns: snap.turns, agents: snap.agents ?? [] });
        const [draft, setDraft] = createSignal<Draft | undefined>();
        const [ready, setReady] = createSignal(true);
        // While no input box has taken it (the session isn't shown), another draft adds to it rather than replacing it.
        const addDraft = (d: Draft) => setDraft((prev) => (prev ? { text: [prev.text, d.text].filter((t) => t).join("\n"), images: [...(prev.images ?? []), ...(d.images ?? [])], files: [...(prev.files ?? []), ...(d.files ?? [])] } : d));
        return { id, ready, setReady, view, set, seq: snap.seq, queue: [] as SessionOp[], scheduled: false, draft, setDraft, addDraft, lastUsed: Date.now() };
    });
    handles.set(id, h);
    trim();
    setHandleVersion((v) => v + 1);
    return h;
}

/** Few sessions stay subscribed; the rest are closed (the server keeps running them). */
function trim() {
    if (handles.size <= KEEP_OPEN) return;
    const old = [...handles.values()].filter((h) => h.id !== app.activeId && !h.view.state.busy).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const h of old.slice(0, handles.size - KEEP_OPEN)) {
        handles.delete(h.id);
        void rpc.call("session.close", { id: h.id }).catch(() => undefined);
    }
}

function flush(h: SessionHandle) {
    h.scheduled = false;
    if (!h.queue.length) return;
    const ops = h.queue;
    h.queue = [];
    batch(() =>
        h.set(
            produce((v) => {
                for (const op of ops) applyOp(v, op);
            }),
        ),
    );
}

function schedule(h: SessionHandle) {
    if (h.scheduled) return;
    h.scheduled = true;
    // Frames don't run in a hidden window; don't let updates wait for it to come back.
    if (document.visibilityState === "visible") requestAnimationFrame(() => flush(h));
    else setTimeout(() => flush(h), 200);
}

export async function openSession(id: string): Promise<SessionHandle> {
    const h = handles.get(id);
    if (h) {
        h.lastUsed = Date.now();
        return h;
    }
    const snap = await rpc.call("session.open", { id });
    return adopt(snap);
}

/** A Claude Code or Codex session of this folder, as a Harness session (a new one, or the one that already holds it). */
export async function importCliSession(cwd: string, source: string, id: string): Promise<SessionHandle> {
    const snap = await rpc.call("cliSessions.import", { cwd, source, id });
    return adopt(snap);
}

export async function createSession(cwd: string, mode?: PermissionModeId): Promise<SessionHandle> {
    const snap = await rpc.call("session.create", { cwd, mode });
    return adopt(snap);
}

/** Show a session in the main view. `cwd` is its project, for one not in the lists (an old one found by search). */
export async function activate(id: string | undefined, cwd?: string) {
    // A jump waiting for another session doesn't wait any more.
    if (jumpTarget() && jumpTarget()!.sessionId !== id) setJumpTarget(undefined);
    if (!id) {
        setApp("activeId", undefined);
        return;
    }
    try {
        const h = await openSession(id);
        if (id !== app.activeId) setFindOpen(false);
        setApp("activeId", id);
        if (h.view.state.cwd) setApp("homeCwd", h.view.state.cwd);
        markSeen(id);
    } catch (e) {
        if (e instanceof RpcError && e.code === "needs_trust") {
            const where = (app.sessions.find((x) => x.id === id) ?? app.archived.find((x) => x.id === id))?.cwd ?? cwd;
            if (where) requestTrust(where, () => void activate(id, cwd));
            return;
        }
        if (e instanceof RpcError && e.code === "not_found") forgetSession(id);
        if (jumpTarget()?.sessionId === id) setJumpTarget(undefined);
        reportError(e);
    }
}

/** Restore only after bootstrap. Lists are capped, so absence is not deletion. */
export async function restoreActiveSession() {
    const id = app.activeId;
    if (!id || handles.has(id)) return;
    const cwd = app.homeCwd;
    const current = () => app.activeId === id && app.homeCwd === cwd;
    try {
        const h = await openSession(id);
        // A slow restore must not undo navigation performed in the meantime.
        if (!current()) return;
        setApp("homeCwd", h.view.state.cwd);
        markSeen(id);
    } catch (e) {
        if (!current()) return;
        if (e instanceof RpcError && e.code === "not_found") {
            forgetSession(id);
        } else if (e instanceof RpcError && e.code === "needs_trust" && cwd) {
            requestTrust(cwd, () => { if (current()) void restoreActiveSession(); });
        } else {
            // Keep the selection on transient failures for the next reconnect.
            reportError(e);
        }
    }
}

// Trust prompts are shown by the App component; this hands them over.
/** MCP approval upgrades existing session trust; declining it must not change that session. */
export const [trustRequest, setTrustRequest] = createSignal<{ path: string; then: () => void; purpose?: "mcp-approval" } | undefined>();
export function requestTrust(path: string, then: () => void, purpose?: "mcp-approval") {
    setTrustRequest({ path, then, purpose });
}

// ---------------------------------------------------------------------------
// Lists

export async function refreshSessions() {
    const markers = new Map(deleted);
    const lists = await Promise.all([rpc.call("sessions.list", { limit: 300 }), rpc.call("sessions.list", { limit: 300, archived: true })]);
    // A list confirms a missed restore, but cannot undo a deletion that happened
    // while either request was in flight (including a second deletion after Undo).
    const [list, archived] = lists.map((rows) => rows.filter((s) => !deleted.has(s.id) || deleted.get(s.id) === markers.get(s.id))) as typeof lists;
    batch(() => {
        for (const s of [...list, ...archived]) sessionPresent(s.id);
    });
    // First run: nothing counts as unread yet.
    if (!Object.keys(app.seen).length) {
        const seen: Record<string, number> = {};
        for (const s of list) seen[s.id] = s.updatedAt;
        setApp("seen", seen);
        saveSeen();
    }
    setApp("sessions", reconcile(list, { key: "id" }));
    setApp("archived", reconcile(archived, { key: "id" }));
}

export async function refreshModels(refresh = false) {
    setApp("modelsLoading", true);
    try {
        setApp("models", reconcile(await rpc.call("models.list", { refresh }), { key: "provider" }));
        setApp("modelsLoaded", true);
    } finally {
        setApp("modelsLoading", false);
    }
}

export async function refreshProviders() {
    setApp("providers", reconcile(await rpc.call("providers.list", {}), { key: "id" }));
}

export async function refreshProjects() {
    const projects = await rpc.call("projects.recent", {});
    setApp("projects", reconcile(projects, { key: "path" }));
    if (!app.homeCwd) {
        const start = app.hello?.startCwd;
        setApp("homeCwd", start ?? projects[0]?.path);
    }
}

let watchingEditor = false;

export async function refreshLimits() {
    const limits = await rpc.call("limits.get", {});
    setApp("limits", reconcile(Object.fromEntries(limits.map((l) => [planLimitKey(l.provider, l.accountId), l]))));
}

export async function refreshSettings() {
    setApp("settings", await rpc.call("settings.get", {}));
    // Observe the first settings immediately: other startup refreshes may still be pending when the editor changes.
    if (!watchingEditor) {
        watchingEditor = true;
        // Editor changes here or seen from another window on refresh need fresh answers about which paths are links.
        createRoot(() => createEffect(() => paths.editorIs(app.settings.editor)));
    }
}

/** Unsent text and images per session (the input box keeps them here), so switching sessions doesn't lose them. */
export { composerDrafts } from "../lib/composer-draft";
/** Deleted sessions (until they're brought back): an input box going away doesn't keep their draft. */
const deleted = new Map<string, symbol>();
/** Invalidate search answers when a deletion or its restoration is observed. */
const [sessionPresenceVersion, setSessionPresenceVersion] = createSignal(0);
export { sessionPresenceVersion };
export const wasDeleted = (id: string) => { sessionPresenceVersion(); return deleted.has(id); };
function sessionPresent(id: string) {
    if (deleted.delete(id)) setSessionPresenceVersion((v) => v + 1);
}
/** What this window had seen of deleted sessions, in case they're brought back (Undo). */
const seenBeforeDelete = new Map<string, number>();

/** A session deleted (here, in another window, or while this one was away): out of the lists, its handle and draft dropped, and off the screen. */
function forgetSession(id: string) {
    deleted.set(id, Symbol());
    setSessionPresenceVersion((v) => v + 1);
    if (jumpTarget()?.sessionId === id) setJumpTarget(undefined);
    composerDrafts.delete(id);
    setApp("sessions", (l) => l.filter((s) => s.id !== id));
    setApp("archived", (l) => l.filter((s) => s.id !== id));
    if (handles.delete(id)) setHandleVersion((v) => v + 1);
    if (app.seen[id] !== undefined) {
        seenBeforeDelete.set(id, app.seen[id]!);
        setApp("seen", id, undefined!);
        saveSeen();
    }
    if (app.activeId === id) setApp("activeId", undefined);
}

/** Opening it again failed: deleted meanwhile, kept while disconnected (the reconnect reopens it), or dropped. */
function reopenFailed(id: string, e: unknown) {
    const next = afterFailedReopen(e instanceof RpcError ? e.code : undefined);
    if (next === "forget") forgetSession(id);
    else if (next === "drop" && handles.delete(id)) setHandleVersion((v) => v + 1);
}

function upsertSession(s: SessionSummary) {
    sessionPresent(s.id);
    const seen = seenBeforeDelete.get(s.id);
    if (seen !== undefined) {
        seenBeforeDelete.delete(s.id);
        if (app.seen[s.id] === undefined) markSeen(s.id, seen);
    }
    const key = s.archived ? "archived" : "sessions";
    const other = s.archived ? "sessions" : "archived";
    setApp(other, (list) => list.filter((x) => x.id !== s.id));
    setApp(key, (list) => {
        const i = list.findIndex((x) => x.id === s.id);
        if (i < 0) return [s, ...list];
        const next = list.slice();
        next[i] = { ...list[i], ...s };
        return next;
    });
    if (s.id === app.activeId) markSeen(s.id, s.updatedAt);
}

// ---------------------------------------------------------------------------
// Events

function onEvent(ev: ServerEvent) {
    switch (ev.type) {
        case "session.ops": {
            const h = handles.get(ev.sessionId);
            if (!h || ev.seq <= h.seq) return;
            h.seq = ev.seq;
            h.queue.push(...ev.ops);
            schedule(h);
            // A file named before it existed becomes a link once it may (an edit landed, or the turn ended).
            if (mayCreateFiles(ev.ops)) paths.forgetMissing(ev.sessionId);
            return;
        }
        case "sessions.upsert":
            upsertSession(ev.session);
            return;
        case "sessions.remove":
            forgetSession(ev.id);
            return;
        case "session.reload":
            // A delete that failed closed it: a fresh snapshot into the same handle, so the view and draft stay.
            if (handles.has(ev.sessionId)) void rpc.call("session.open", { id: ev.sessionId }).then(adopt, (e) => reopenFailed(ev.sessionId, e));
            return;
        case "draft":
            handles.get(ev.sessionId)?.addDraft({ text: ev.text, images: ev.images, files: ev.files });
            return;
        case "toast":
            toast(ev.message, ev.level);
            return;
        case "limits":
            setApp("limits", planLimitKey(ev.limits.provider, ev.limits.accountId), reconcile(ev.limits));
            return;
        case "models.changed":
            void refreshProviders().catch(() => undefined);
            // A fetch in flight gets the new list anyway.
            if (!app.modelsLoading) void refreshModels().catch(() => undefined);
            return;
        case "notify": {
            if (!prefs.notifications) return;
            if (focused() && app.activeId === ev.sessionId) return;
            if (ev.kind === "done" && focused()) return;
            void notify(ev.title, ev.body, () => void activate(ev.sessionId));
            return;
        }
    }
}

export function start() {
    document.addEventListener("visibilitychange", () => {
        for (const t of toasts) pauseToast(t.id, "hidden", document.hidden);
    });
    rpc.onSlow((slow) => setApp("slowRequest", slow));
    rpc.onEvent(onEvent);
    rpc.onState((s) => {
        batch(() => {
            if (s !== "open") for (const h of handles.values()) h.setReady(false);
            setApp("conn", s);
        });
        if (s !== "open") return;
        void (async () => {
            try {
                setApp("hello", await rpc.call("hello", { client: isTauri ? "desktop" : "browser" }));
                await Promise.all([refreshSessions(), refreshProjects(), refreshSettings(), refreshProviders()]);
                void refreshModels().catch(() => undefined);
                void refreshLimits().catch(() => undefined);
                // After a reconnect, the open sessions start over from fresh snapshots.
                for (const h of [...handles.values()]) if (!h.ready()) await rpc.call("session.open", { id: h.id }).then(adopt, (e) => reopenFailed(h.id, e));
                await restoreActiveSession();
                // Path lookups that failed while it was down are asked again.
                paths.retryFailed();
            } catch (e) {
                reportError(e);
            }
        })();
    });
    void rpc.connect();
}

/** Sessions waiting on the user, for the window title. */
export function attentionCount(): number {
    return app.sessions.filter((s) => s.status === "waiting").length;
}
