// The GUI's state: the connection, the sidebar's sessions, models, providers
// and projects, and every open session's timeline (kept current from the
// server's ops, applied once per frame).

import { batch, createRoot, createSignal } from "solid-js";
import { createStore, produce, reconcile, type SetStoreFunction } from "solid-js/store";
import type { GuiSettings, HelloResult, PermissionModeId, ProjectInfo, ProviderInfo, ProviderModels, ServerEvent, SessionOp, SessionSnapshot, SessionSummary } from "@shared/protocol";
import { applyOp, type SessionView } from "@shared/timeline";
import { Rpc, RpcError, type ConnectionState } from "../lib/rpc";
import { credentials, focused, notify, isTauri } from "../lib/platform";
import { prefs } from "./prefs";

export const rpc = new Rpc(credentials);
rpc.retriesCredentials = isTauri;

// ---------------------------------------------------------------------------
// Toasts

export interface Toast {
    id: number;
    level: "info" | "warn" | "error" | "success";
    message: string;
    action?: { label: string; run: () => void };
}

let toastId = 0;
export const [toasts, setToasts] = createStore<Toast[]>([]);

export function toast(message: string, level: Toast["level"] = "info", action?: Toast["action"]) {
    const id = ++toastId;
    setToasts((t) => [...t.slice(-3), { id, level, message, action }]);
    setTimeout(() => dismissToast(id), level === "error" ? 8000 : 4500);
}

export function dismissToast(id: number) {
    setToasts((t) => t.filter((x) => x.id !== id));
}

export function reportError(e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    toast(msg, "error");
}

// ---------------------------------------------------------------------------
// App store

export interface AppState {
    conn: ConnectionState;
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
}

const SEEN_KEY = "harness.seen";

function loadSeen(): Record<string, number> {
    try {
        return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "null") ?? {};
    } catch {
        return {};
    }
}

export const [app, setApp] = createStore<AppState>({
    conn: "connecting",
    sessions: [],
    archived: [],
    models: [],
    modelsLoading: false,
    modelsLoaded: false,
    providers: [],
    projects: [],
    settings: {},
    seen: loadSeen(),
});

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

export interface SessionHandle {
    id: string;
    view: SessionView;
    set: SetStoreFunction<SessionView>;
    seq: number;
    queue: SessionOp[];
    scheduled: boolean;
    draft: () => string | undefined;
    setDraft: (t: string | undefined) => void;
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
    const existing = handles.get(id);
    if (existing) {
        existing.set(reconcile({ state: snap.state, turns: snap.turns, agents: snap.agents ?? [] }, { key: "id", merge: false }));
        existing.seq = snap.seq;
        existing.queue = [];
        return existing;
    }
    const h = createRoot(() => {
        const [view, set] = createStore<SessionView>({ state: snap.state, turns: snap.turns, agents: snap.agents ?? [] });
        const [draft, setDraft] = createSignal<string | undefined>();
        return { id, view, set, seq: snap.seq, queue: [] as SessionOp[], scheduled: false, draft, setDraft, lastUsed: Date.now() };
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

export async function createSession(cwd: string, mode?: PermissionModeId): Promise<SessionHandle> {
    const snap = await rpc.call("session.create", { cwd, mode });
    return adopt(snap);
}

/** Show a session in the main view. */
export async function activate(id: string | undefined) {
    if (!id) {
        setApp("activeId", undefined);
        return;
    }
    try {
        const h = await openSession(id);
        setApp("activeId", id);
        if (h.view.state.cwd) setApp("homeCwd", h.view.state.cwd);
        markSeen(id);
    } catch (e) {
        if (e instanceof RpcError && e.code === "needs_trust") {
            const s = app.sessions.find((x) => x.id === id);
            if (s) requestTrust(s.cwd, () => void activate(id));
            return;
        }
        reportError(e);
    }
}

// Trust prompts are shown by the App component; this hands them over.
export const [trustRequest, setTrustRequest] = createSignal<{ path: string; then: () => void } | undefined>();
export function requestTrust(path: string, then: () => void) {
    setTrustRequest({ path, then });
}

// ---------------------------------------------------------------------------
// Lists

export async function refreshSessions() {
    const [list, archived] = await Promise.all([rpc.call("sessions.list", { limit: 300 }), rpc.call("sessions.list", { limit: 300, archived: true })]);
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

export async function refreshSettings() {
    setApp("settings", await rpc.call("settings.get", {}));
}

function upsertSession(s: SessionSummary) {
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
            return;
        }
        case "sessions.upsert":
            upsertSession(ev.session);
            return;
        case "sessions.remove":
            setApp("sessions", (l) => l.filter((s) => s.id !== ev.id));
            return;
        case "draft":
            handles.get(ev.sessionId)?.setDraft(ev.text);
            return;
        case "toast":
            toast(ev.message, ev.level);
            return;
        case "models.changed":
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

let connectedOnce = false;

export function start() {
    rpc.onEvent(onEvent);
    rpc.onState((s) => {
        setApp("conn", s);
        if (s !== "open") return;
        void (async () => {
            try {
                setApp("hello", await rpc.call("hello", { client: isTauri ? "desktop" : "browser" }));
                await Promise.all([refreshSessions(), refreshProjects(), refreshSettings(), refreshProviders()]);
                void refreshModels().catch(() => undefined);
                // After a reconnect, the open sessions start over from fresh snapshots.
                if (connectedOnce) for (const h of [...handles.values()]) await rpc.call("session.open", { id: h.id }).then(adopt, () => handles.delete(h.id));
                connectedOnce = true;
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
