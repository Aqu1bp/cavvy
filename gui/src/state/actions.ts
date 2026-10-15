// What the user does, as calls to the server.

import type { EffortLevel, InteractionResponse, PermissionModeId, ProviderInfo } from "@shared/protocol";
import { RpcError } from "../lib/rpc";
import { copyText, pickFolder } from "../lib/platform";
import { activate, app, createSession, handleFor, refreshModels, refreshProjects, refreshProviders, refreshSessions, refreshSettings, reportError, requestTrust, rpc, setApp, toast } from "./app";
import { prefs, setPrefs } from "./prefs";
import { requestComposerFocus, setAgentFocus, setFolderPickerOpen, setModePickerOpen, setModelPickerOpen, setRewindOpen, setSettingsTab } from "./ui";

export interface Attachment {
    name: string;
    mediaType: string;
    data: string;
    preview: string;
}

/** Back to the home screen to start a new session (optionally in another project). */
export function newSession(cwd?: string) {
    if (cwd) setApp("homeCwd", cwd);
    setApp("activeId", undefined);
    requestComposerFocus();
}

/** Choose a project folder: the native picker in the desktop app, ours in the browser. */
export async function chooseProject(): Promise<string | undefined> {
    const native = await pickFolder(app.homeCwd).catch(() => undefined);
    if (native === null) return undefined;
    if (native) return native;
    return new Promise((resolve) => setFolderPickerOpen({ then: resolve }));
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

/** Show a sub-agent's activity in the side panel, or the list of them. */
export function openAgents(agentId?: string) {
    setAgentFocus(agentId);
    setPrefs({ panel: true, panelTab: "agents" });
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
export async function send(text: string, attachments: Attachment[] = []): Promise<boolean> {
    const images = attachments.map((a) => ({ mediaType: a.mediaType, data: a.data }));
    let id = app.activeId;
    if (text.startsWith("/") && clientCommand(id, text)) return true;
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
        await rpc.call("session.send", { id, text, images: images.length ? images : undefined });
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

export async function archive(id: string, archived: boolean) {
    await rpc.call("session.archive", { id, archived }).catch(reportError);
    if (archived && app.activeId === id) newSession(app.homeCwd);
    toast(archived ? "Session archived" : "Session restored", "info", archived ? { label: "Undo", run: () => void archive(id, false) } : undefined);
}

export function togglePanel(tab?: typeof prefs.panelTab) {
    if (tab && (!prefs.panel || prefs.panelTab !== tab)) setPrefs({ panel: true, panelTab: tab });
    else setPrefs("panel", !prefs.panel);
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

export { refreshSessions };
