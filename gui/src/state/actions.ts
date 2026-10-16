// What the user does, as calls to the server.

import { createSignal } from "solid-js";
import type { CliSessionInfo, EditorInfo, EffortLevel, GitCommitHead, InteractionResponse, PermissionModeId, ProviderInfo } from "@shared/protocol";
import { RpcError } from "../lib/rpc";
import { UNDO_DELETE_MS } from "../lib/toasts";
import { copyText, pickFolder } from "../lib/platform";
import { toWire, type Attachment } from "../lib/attachments";
import { activate, app, createSession, handleFor, importCliSession, markSeen, refreshModels, refreshProjects, refreshProviders, refreshSessions, refreshSettings, reportError, requestTrust, rpc, setApp, toast } from "./app";
import type { ReviewScope } from "./changes";
import { refreshGitChanges } from "./changes";
import { prefs, setPrefs } from "./prefs";
import { requestComposerFocus, setAgentFocus, setFolderPickerOpen, setMcpOpen, setModePickerOpen, setModelPickerOpen, setReview, setRewindOpen, setSettingsTab } from "./ui";

export type { Attachment } from "../lib/attachments";

/** Back to the home screen to start a new session (optionally in another project). */
export function newSession(cwd?: string) {
    if (cwd) setApp("homeCwd", cwd);
    setApp("activeId", undefined);
    requestComposerFocus();
}

/** Choose a folder: the native picker in the desktop app, ours in the browser. */
export async function chooseFolder(o: { title?: string; action?: string; start?: string } = {}): Promise<string | undefined> {
    const native = await pickFolder(o.start ?? app.homeCwd, o.title).catch(() => undefined);
    if (native === null) return undefined;
    if (native) return native;
    return new Promise((resolve) => setFolderPickerOpen({ then: resolve, ...o }));
}

/** Choose a project folder. */
export function chooseProject(): Promise<string | undefined> {
    return chooseFolder();
}

/** Carry on with a Claude Code or Codex session in Harness: import it, or open the session that already holds it. */
export async function continueCliSession(cwd: string, s: CliSessionInfo): Promise<boolean> {
    try {
        if (s.harnessId) {
            await activate(s.harnessId);
            return true;
        }
        const h = await importCliSession(cwd, s.source, s.id);
        setApp("activeId", h.id);
        if (h.view.state.cwd) setApp("homeCwd", h.view.state.cwd);
        markSeen(h.id);
        void refreshSessions();
        return true;
    } catch (e) {
        if (e instanceof RpcError && e.code === "needs_trust") {
            requestTrust(cwd, () => void continueCliSession(cwd, s));
            return false;
        }
        reportError(e);
        return false;
    }
}

export async function openProject(path: string) {
    try {
        const info = await rpc.call("projects.inspect", { path });
        if (!info.exists) return toast(`${path} isn't a folder`, "error");
        newSession(info.path);
        void refreshProjects();
    } catch (e) {
        reportError(e);
    }
}

/** Run a slash command the GUI handles itself. Returns false when it's the server's (or a prompt). */
function clientCommand(id: string | undefined, text: string): boolean {
    const m = text.trim().match(/^\/(\S+)\s*([\s\S]*)$/);
    if (!m) return false;
    const [, name = "", args = ""] = m;
    switch (name.toLowerCase()) {
        case "model":
            setModelPickerOpen(true);
            return true;
        case "mode":
            setModePickerOpen(true);
            return true;
        case "new":
        case "clear":
            newSession(app.homeCwd);
            return true;
        case "rewind":
            if (id) setRewindOpen(true);
            return true;
        case "mcp":
            if (id) setMcpOpen({ focus: args.trim() || undefined });
            return true;
        case "settings":
        case "config":
            setSettingsTab("general");
            return true;
        case "rename":
            if (id && args.trim()) void rpc.call("session.rename", { id, title: args.trim() }).catch(reportError);
            return true;
        case "export":
            if (id) void exportSession(id);
            return true;
        case "tasks": {
            const [verb, task] = args.trim().split(/\s+/);
            if (verb === "stop" && id) {
                // By task id (task-1), as in the terminal, or every one still running.
                const agent = task ? handleFor(id)?.view.agents.find((a) => a.taskId === task || a.id === task) : undefined;
                if (task && !agent) toast(`No delegated task ${task}`, "error");
                else void stopAgent(id, agent?.id);
                return true;
            }
            openAgents();
            return true;
        }
        default:
            return false;
    }
}

/** Show a sub-agent's own view, or (with none) the session's lineage in the panel. */
export function openAgents(agentId?: string) {
    if (agentId) return setAgentFocus(agentId);
    setAgentFocus(undefined);
    setPrefs("panel", true);
}

/** The docked review pane, on a file and a view when given (else the view last used). */
export function openReview(path?: string, scope?: ReviewScope) {
    setReview({ path, scope });
}

/** Stop a delegated task (or every one running); Task sub-agents stop with the turn. */
export async function stopAgent(sessionId: string, agentId?: string) {
    try {
        const { stopped } = await rpc.call("session.stopAgent", { id: sessionId, agentId });
        toast(stopped ? `Stopping ${stopped === 1 ? "the task" : `${stopped} tasks`}` : "Nothing was running");
    } catch (e) {
        reportError(e);
    }
}

export async function exportSession(id: string) {
    try {
        const { markdown } = await rpc.call("session.export", { id });
        if (await copyText(markdown)) toast("Copied the conversation as Markdown", "success");
    } catch (e) {
        reportError(e);
    }
}

/** Send from the composer: to the open session, or a new one in the home screen's project. */
export async function send(text: string, attachments: Attachment[] = []): Promise<boolean | "command"> {
    let id = app.activeId;
    // Done here, without sending: what's attached stays in the box.
    if (text.startsWith("/") && clientCommand(id, text)) return "command";
    try {
        if (!id) {
            const cwd = app.homeCwd;
            if (!cwd) {
                toast("Choose a project folder first", "warn");
                return false;
            }
            const h = await startIn(cwd);
            if (!h) return false;
            id = h.id;
        }
        await rpc.call("session.send", { id, text, ...toWire(attachments) });
        return true;
    } catch (e) {
        reportError(e);
        return false;
    }
}

async function startIn(cwd: string) {
    try {
        const h = await createSession(cwd, app.homeMode);
        setApp("activeId", h.id);
        return h;
    } catch (e) {
        if (e instanceof RpcError && e.code === "needs_trust") {
            // The message stays in the input box; send it again once the folder is trusted.
            requestTrust(cwd, requestComposerFocus);
            return undefined;
        }
        throw e;
    }
}

export async function trustAndContinue(path: string, trust: boolean) {
    await rpc.call("projects.trust", { path, trust });
    void refreshProjects();
}

export function interrupt(id = app.activeId) {
    if (id) void rpc.call("session.interrupt", { id }).catch(reportError);
}

/** Whether the answer was taken. */
export function respond(id: string, interactionId: string, response: InteractionResponse): Promise<boolean> {
    return rpc.call("session.respond", { id, interactionId, response }).then(
        () => true,
        (e) => {
            reportError(e);
            return false;
        },
    );
}

export async function setModel(ref: string) {
    const id = app.activeId;
    if (id && handleFor(id)?.view.state.busy) {
        toast("Switch models once this response is done, or interrupt it first.", "warn");
        return;
    }
    try {
        if (id) await rpc.call("session.setModel", { id, ref, persist: true });
        else {
            await rpc.call("settings.update", { patch: { model: ref } });
            setApp("settings", "model", ref);
        }
    } catch (e) {
        reportError(e);
    }
}

export async function setMode(mode: PermissionModeId) {
    const id = app.activeId;
    if (!id) {
        // For the sessions started from the home screen (the saved default is in Settings).
        setApp("homeMode", mode);
        return;
    }
    // Shown at once, so pressing shift+tab twice quickly moves two steps; put back if the server refuses.
    const h = handleFor(id);
    const prev = h?.view.state.mode;
    h?.set("state", "mode", mode);
    await rpc.call("session.setMode", { id, mode }).catch((e) => {
        if (prev) h?.set("state", "mode", prev);
        reportError(e);
    });
}

export async function setFastMode(enabled: boolean) {
    try {
        if (app.activeId) await rpc.call("session.setFastMode", { id: app.activeId, enabled });
        else {
            const settings = await rpc.call("settings.update", { patch: { fastMode: enabled } });
            setApp("settings", settings);
        }
    } catch (e) { reportError(e); }
}

export async function setEffort(effort: EffortLevel) {
    const id = app.activeId;
    if (id) await rpc.call("session.setEffort", { id, effort }).catch(reportError);
    else {
        await rpc.call("settings.update", { patch: { effort } }).catch(reportError);
        setApp("settings", "effort", effort);
    }
}

export async function rename(id: string, title: string) {
    if (title.trim()) await rpc.call("session.rename", { id, title: title.trim() }).catch(reportError);
}

export async function pin(id: string, pinned: boolean) {
    await rpc.call("session.pin", { id, pinned }).catch(reportError);
}

/** Set aside (or back in play). Sending to it puts it back too. */
export async function settle(id: string, settled: boolean) {
    await rpc.call("session.settle", { id, settled }).catch(reportError);
}

/** After the confirm dialog. The server moves its files to the trash; Undo puts them back. */
export async function deleteSession(id: string) {
    try {
        await rpc.call("session.delete", { id });
    } catch (e) {
        return reportError(e);
    }
    toast("Session deleted", "info", { label: "Undo", run: () => void rpc.call("session.restore", { id }).catch(reportError) }, UNDO_DELETE_MS);
}

/** Only the commit dialog's explicit Commit click calls this. Errors stay in the dialog. */
export async function gitCommit(id: string, paths: string[], message: string, expectedHead?: GitCommitHead) {
    try {
        const result = await rpc.call("session.gitCommit", { id, paths, message, expectedHead });
        toast(`Committed ${result.hash.slice(0, 7)} ${result.subject}`, "success");
        return result;
    } finally {
        // Failed hooks can still edit working files; a post-publication error
        // also needs a fresh view even though the dialog stays open.
        refreshGitChanges();
    }
}

export function gitCommitMessage(id: string, paths: string[]) {
    return rpc.call("session.gitCommitMessage", { id, paths });
}

export async function archive(id: string, archived: boolean) {
    await rpc.call("session.archive", { id, archived }).catch(reportError);
    if (archived && app.activeId === id) newSession(app.homeCwd);
    toast(archived ? "Session archived" : "Session restored", "info", archived ? { label: "Undo", run: () => void archive(id, false) } : undefined);
}

export function togglePanel() {
    setPrefs("panel", !prefs.panel);
}

export function toggleSidebar() {
    setPrefs("sidebar", !prefs.sidebar);
}

/** Go to the next/previous session in the sidebar's order. */
export function cycleSession(dir: 1 | -1) {
    const list = app.sessions;
    if (!list.length) return;
    const i = list.findIndex((s) => s.id === app.activeId);
    const next = list[(i + dir + list.length) % list.length];
    if (next) void activate(next.id);
}

export function activeHandle() {
    return handleFor(app.activeId);
}

/**
 * Use the user's own plan through their installed Claude Code or Codex. The
 * CLI is asked whether it's signed in; signing in is the CLI's own business.
 */
export async function connectCli(pr: ProviderInfo): Promise<boolean> {
    try {
        const r = await rpc.call("providers.connectCli", { provider: pr.id });
        toast(`Using your ${pr.agentCli?.plan ?? pr.name} through ${pr.name} (${r.description})`, "success");
        if (r.warning) toast(r.warning, "warn");
        await Promise.all([refreshProviders(), refreshModels(), refreshSettings()]);
        return true;
    } catch (e) {
        reportError(e);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Open in editor (on the server's machine)

const [editors, setEditors] = createSignal<EditorInfo[]>([]);
export { editors };

/** The editors Harness knows, and which of them this machine has; also brings the chosen one up to date. */
export async function refreshEditors() {
    try {
        const r = await rpc.call("editors.list", {});
        setEditors(r.editors);
        setApp("settings", "editor", r.selected);
    } catch (e) {
        reportError(e);
    }
}

/** The chosen editor's name, when there is one. */
export function editorName(): string | undefined {
    const id = app.settings.editor;
    return id ? (editors().find((e) => e.id === id)?.name ?? undefined) : undefined;
}

/**
 * Open a file at a line (or, with `folder`, a project) in the editor chosen in
 * Settings. The server resolves `path` against the session's folder and opens
 * only what's inside its folders.
 */
export async function openInEditor(path: string, line?: number, o: { col?: number; folder?: boolean; sessionId?: string } = {}) {
    const sessionId = o.sessionId ?? app.activeId;
    if (!sessionId) return;
    try {
        await rpc.call("fs.open", { sessionId, path, line, col: o.col, folder: o.folder });
    } catch (e) {
        const code = e instanceof RpcError ? e.code : undefined;
        if (code === "no_editor" || code === "not_installed")
            return toast(code === "no_editor" ? "No editor chosen yet. Pick one under Settings → General → Open files with." : (e as Error).message, "warn", {
                label: "Settings",
                run: () => setSettingsTab("general"),
            });
        reportError(e);
    }
}

export { refreshSessions };
