// What the user does, as calls to the server.

import { createSignal } from "solid-js";
import { adjacentSession, sidebarEntries, sidebarIds, SESSION_PAGE } from "../lib/session-order";
import { sidebarOrder, unselect } from "./sidebar";
import { sessionCount, sessionNames } from "../lib/rail-select";
import type { ArchiveResult, CliSessionInfo, EditorInfo, EffortLevel, FollowUpMode, GitCommitHead, InteractionResponse, PermissionModeId, ProviderInfo } from "@shared/protocol";
import { RpcError } from "../lib/rpc";
import { UNDO_DELETE_MS } from "../lib/toasts";
import { copyText, pickFolder } from "../lib/platform";
import { toWire, type Attachment } from "../lib/attachments";
import { activate, app, createSession, revealBackground, dropHandle, forkSession, handleFor, importCliSession, markSeen, refreshModels, refreshProjects, refreshProviders, refreshSessions, refreshSettings, reportError, requestTrust, rpc, setApp, toast } from "./app";
import type { ReviewScope } from "./changes";
import { refreshGitChanges } from "./changes";
import { keepSentImages } from "./images";
import { prefs, setPrefs } from "./prefs";
import { railOpen, requestComposerFocus, setAgentFocus, setArchiveRequest, setContextCardOpen, setDeleteRequest, setFolderPickerOpen, setMcpOpen, setModePickerOpen, setModelPickerOpen, setRailOpen, setReview, setRewindOpen, setSettingsTab, shellLayout } from "./ui";
import { clientAction, slashName } from "../lib/commands";
import { forkAnchor } from "../lib/fork";
import { backgroundOf, stopOutcome, stopTasks } from "../lib/background";
export { forkAnchor } from "../lib/fork";

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
    const c = clientAction(text);
    if (!c) return false;
    const args = c.args;
    switch (c.action) {
        case "model":
            setModelPickerOpen(true);
            return true;
        case "mode":
            setModePickerOpen(true);
            return true;
        case "new":
            newSession(app.homeCwd);
            return true;
        case "rewind":
            if (id) setRewindOpen(true);
            return true;
        case "fork":
            if (id) void fork(id);
            return true;
        case "mcp":
            if (id) setMcpOpen({ focus: args.trim() || undefined });
            return true;
        case "settings":
            setSettingsTab("general");
            return true;
        case "plugins":
            setSettingsTab("plugins");
            return true;
        case "usage":
            setSettingsTab("usage");
            return true;
        case "context":
            if (id) setContextCardOpen(true);
            else setSettingsTab("usage");
            return true;
        case "rename":
            if (id && args.trim()) void rpc.call("session.rename", { id, title: args.trim() }).catch(reportError);
            return true;
        case "export":
            if (id) void exportSession(id);
            return true;
        case "tasks": {
            const [verb, task] = args.trim().split(/\s+/);
            if (verb === "restart" && id) {
                void rpc.call("session.restartCli", { id }).catch(reportError);
                return true;
            }
            if (verb === "stop" && id) {
                // By task id (task-1, bash_2, a CLI's own), as in the terminal, or every one still running.
                const listed = backgroundOf(handleFor(id)?.view.state);
                if (task && task !== "all" && !listed.some((t) => t.id === task && t.status === "running")) toast(`No running background task ${task}`, "error");
                else void stopBackground(id, task && task !== "all" ? [task] : undefined);
                return true;
            }
            openBackground(id);
            return true;
        }
    }
}

/** A new session with the conversation up to a turn (by default the latest finished one); the original stays as it is. */
export async function fork(id: string, at?: { index: number; text: string; turn: string }) {
    const turns = handleFor(id)?.view.turns ?? [];
    if (!at) {
        for (let i = turns.length - 1; i >= 0 && !at; i--) if (turns[i]!.status !== "running" && turns[i]!.prompt) at = forkAnchor(turns, i);
    }
    if (!at) return toast("Nothing to fork yet: send a prompt first.", "warn");
    try {
        const h = await forkSession(id, at);
        toast(`Forked into “${h.view.state.title ?? "a new session"}”`, "success");
    } catch (e) {
        reportError(e);
    }
}

/** Show a sub-agent's own view, or (with none) the session's lineage in the panel. */
export function openAgents(agentId?: string) {
    if (agentId) return setAgentFocus(agentId);
    setAgentFocus(undefined);
    setPrefs("panel", true);
}

/** The docked review pane, on a file and a view when given (else the view last used). */
/** `token`: the file's handle when its name was shown redacted (GitFileDiff.pathToken). */
export function openReview(path?: string, scope?: ReviewScope, turnId?: number, token?: string) {
    setReview({ path, scope, turnId, ...(path !== undefined && token ? { token } : {}) });
}

/** The diff reader on another worktree of the session's repository, on its branch: at `path` (relative to it), if given; `token` when its name was shown redacted. */
export function openWorktreeReview(worktree: string, path?: string, token?: string) {
    setReview({ worktree, ...(path !== undefined ? { path, ...(token ? { token } : {}) } : {}) });
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

/** Stop background tasks (the side panel, /tasks stop): these, or every one running. */
export async function stopBackground(sessionId: string, ids?: string[]) {
    try {
        const results = await stopTasks(rpc.call.bind(rpc) as never, sessionId, handleFor(sessionId)?.view.state, ids);
        const { message, level } = stopOutcome(results);
        toast(message, level);
    } catch (e) {
        reportError(e);
    }
}

/** The side panel, on the tab that lists what runs in the background. */
export const openBackground = revealBackground;

/** Clear the finished tasks from the side panel. */
export async function clearBackground(sessionId: string) {
    await rpc.call("session.clearBackground", { id: sessionId }).catch(reportError);
}

export async function exportSession(id: string) {
    try {
        const { markdown } = await rpc.call("session.export", { id });
        if (await copyText(markdown)) toast("Copied the conversation as Markdown", "success");
    } catch (e) {
        reportError(e);
    }
}

/**
 * Send from the composer: to the open session, or a new one in the home
 * screen's project. A /word that names no command isn't sent (false keeps it
 * in the box); the toast offers to send it as a message, and `sent` runs if it is.
 * `accepted` identifies the receiving session, including one just created from Home.
 */
export async function send(text: string, attachments: Attachment[] = [], opts: { literal?: boolean; /** What it does if a turn is running (default: the setting). */ followUp?: FollowUpMode; sent?: () => void; accepted?: (id: string) => void; to?: { id?: string; cwd?: string }; throwErrors?: boolean } = {}): Promise<boolean | "command"> {
    // Where it was typed, even if the user has moved on by the time the toast is clicked.
    let id = opts.to ? opts.to.id : app.activeId;
    const cwd = opts.to ? opts.to.cwd : app.homeCwd;
    let created = false;
    if (!opts.literal && text.startsWith("/") && clientCommand(id, text)) return "command";
    const unknown = (name: string) => {
        const to = { id, cwd };
        // The toast stays, with its action, until the send succeeds.
        toast(`Unknown command /${name}`, "warn", { label: "Send as message", run: async () => {
            // A failure is shown once, in this toast, with its retry.
            if (!(await send(text, attachments, { literal: true, to, throwErrors: true, accepted: opts.accepted }))) return false;
            if (created && app.activeId === undefined && app.homeCwd === cwd) setApp("activeId", to.id);
            opts.sent?.();
        } });
        return false;
    };
    try {
        if (!id) {
            if (!cwd) {
                toast("Choose a project folder first", "warn");
                return false;
            }
            // Check before creating a session, so a typo on Home doesn't start one.
            const command = opts.literal ? undefined : slashName(text);
            if (command) await rpc.call("commands.list", { cwd, command });
            const h = await createIn(cwd);
            if (!h) return false;
            id = h.id;
            created = true;
        }
        const images = attachments.flatMap((a) => (a.kind === "image" ? [a] : []));
        // Hashed while the message uploads: done long before the turn asks (and if not, it asks the server as before).
        if (images.length) void keepSentImages(id, images);
        await rpc.call("session.send", { id, text, ...toWire(attachments), literal: opts.literal || undefined, ...(opts.followUp ? { mode: opts.followUp } : {}) });
        opts.accepted?.(id);
        // A final server refusal leaves the original Home composer and its draft in place.
        if (created && app.activeId === undefined && app.homeCwd === cwd) setApp("activeId", id);
        return true;
    } catch (e) {
        if (e instanceof RpcError && e.code === "unknown_command") return unknown(slashName(text) ?? text);
        if (opts.throwErrors) throw e;
        reportError(e);
        return false;
    }
}

async function createIn(cwd: string) {
    try {
        return await createSession(cwd, app.homeMode);
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
    const st = id ? handleFor(id)?.view.state : undefined;
    // An idle compaction stops for a model switch.
    if (st?.busy && !st.activity?.idle) {
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

export async function setAccount(provider: string, accountId: string) {
    try {
        if (app.activeId) await rpc.call("session.setAccount", { id: app.activeId, provider, accountId });
        else await rpc.call("accounts.setDefault", { provider, id: accountId });
        await refreshProviders();
    } catch (e) { reportError(e); }
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

/** Whether the server took it (a failure is reported here). */
export async function setEffort(effort: EffortLevel): Promise<boolean> {
    const id = app.activeId;
    const failed = (e: unknown) => {
        reportError(e);
        return false;
    };
    if (id) return rpc.call("session.setEffort", { id, effort }).then(() => true, failed);
    const ok = await rpc.call("settings.update", { patch: { effort } }).then(() => true, failed);
    if (ok) setApp("settings", "effort", effort);
    return ok;
}

export async function rename(id: string, title: string) {
    if (title.trim()) await rpc.call("session.rename", { id, title: title.trim() }).catch(reportError);
}

export async function pin(id: string, pinned: boolean) {
    await rpc.call("session.pin", { id, pinned }).catch(reportError);
}

/** Set aside (or back in play). Sending to it puts it back too. Whether it was done. */
export async function settle(id: string, settled: boolean): Promise<boolean> {
    try {
        await rpc.call("session.settle", { id, settled });
    } catch (e) {
        reportError(e);
        return false;
    }
    if (settled) {
        toast("Session settled", "info", {
            label: "Undo",
            run: async () => {
                await rpc.call("session.settle", { id, settled: false });
            },
        });
    }
    return true;
}

/** After the confirm dialog. The server moves its files to the trash; Undo puts them back. Whether it was done. */
export async function deleteSession(id: string): Promise<boolean> {
    try {
        await rpc.call("session.delete", { id });
    } catch (e) {
        reportError(e);
        return false;
    }
    toast(
        "Session deleted",
        "info",
        {
            label: "Undo",
            run: async () => {
                await rpc.call("session.restore", { id });
            },
        },
        UNDO_DELETE_MS,
    );
    return true;
}

// ---------------------------------------------------------------------------
// Several sessions at once (picked in the rail): each goes the way a single one
// does, with one toast and one Undo for all of them. Those that fail are named
// in a second toast and stay selected.

const summaryOf = (id: string) => app.sessions.find((s) => s.id === id) ?? app.archived.find((s) => s.id === id);
const titleOf = (id: string) => summaryOf(id)?.title ?? handleFor(id)?.view.state.title ?? "Untitled";
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Each id through `one`, a few at a time: those done and those that failed (both in the order given), and the first failure. */
async function eachSession(ids: readonly string[], one: (id: string) => Promise<unknown>) {
    const done = new Set<string>();
    const failed = new Set<string>();
    let error: unknown;
    let next = 0;
    const worker = async () => {
        while (next < ids.length) {
            const id = ids[next++]!;
            try {
                await one(id);
                done.add(id);
            } catch (e) {
                failed.add(id);
                error ??= e;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
    return { done: ids.filter((id) => done.has(id)), failed: ids.filter((id) => failed.has(id)), error };
}

async function bulk(ids: readonly string[], o: {
    /** "Couldn't <verb> “A” and “B”: …" */
    verb: string;
    /** "5 sessions <did>"; none: no toast when it worked. */
    did?: string;
    one: (id: string) => Promise<unknown>;
    undo?: (id: string) => Promise<unknown>;
    ms?: number;
    /** With the ones done, before the toast. */
    after?: (done: readonly string[]) => void;
}): Promise<string[]> {
    // Taken now: a deleted session's summary is gone by the time its Undo runs.
    const titles = new Map(ids.map((id) => [id, titleOf(id)]));
    const names = (list: readonly string[]) => sessionNames(list.map((id) => titles.get(id)!));
    const r = await eachSession(ids, o.one);
    unselect(r.done);
    if (r.done.length) {
        o.after?.(r.done);
        let left = r.done;
        const undo = o.undo;
        if (o.did)
            toast(`${sessionCount(r.done.length)} ${o.did}`, "info", undo ? {
                label: "Undo",
                // A retry brings back only those still missing.
                run: async () => {
                    const back = await eachSession(left, undo);
                    left = back.failed;
                    if (left.length) throw new Error(`${names(left)} couldn't be brought back: ${errorText(back.error)}`);
                },
            } : undefined, o.ms);
    }
    if (r.failed.length) toast(`Couldn't ${o.verb} ${names(r.failed)}: ${errorText(r.error)}`, "error");
    return r.failed;
}

/** Settle several (or bring them back into play). The ids that failed. */
export async function settleSessions(ids: readonly string[], settled: boolean): Promise<string[]> {
    if (ids.length === 1) return (await settle(ids[0]!, settled)) ? (unselect(ids), []) : [...ids];
    return bulk(ids, {
        verb: settled ? "settle" : "bring back",
        did: settled ? "settled" : undefined,
        one: (id) => rpc.call("session.settle", { id, settled }),
        undo: settled ? (id) => rpc.call("session.settle", { id, settled: false }) : undefined,
    });
}

/**
 * Archive several (or restore them). One alone goes the usual way (asking about
 * its worktree); several are archived only, keeping their worktrees, as that
 * question's default does. The ids that failed.
 */
export async function archiveSessions(ids: readonly string[], archived: boolean): Promise<string[]> {
    if (ids.length === 1) {
        if ((await archive(ids[0]!, archived)) === false) return [...ids];
        unselect(ids);
        return [];
    }
    return bulk(ids, {
        verb: archived ? "archive" : "restore",
        did: archived ? "archived" : "restored",
        one: (id) => rpc.call("session.archive", { id, archived }),
        undo: archived ? (id) => rpc.call("session.archive", { id, archived: false }) : undefined,
        // As for one: the open session, archived, leaves the screen for Home.
        after: (done) => {
            if (archived && app.activeId && done.includes(app.activeId)) newSession(app.homeCwd);
        },
    });
}

/** After the confirm dialog: several to the trash, one Undo for all. The ids that failed. */
export async function deleteSessions(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 1) return (await deleteSession(ids[0]!)) ? (unselect(ids), []) : [...ids];
    return bulk(ids, {
        verb: "delete",
        did: "deleted",
        one: (id) => rpc.call("session.delete", { id }),
        undo: (id) => rpc.call("session.restore", { id }),
        ms: UNDO_DELETE_MS,
    });
}

/** The delete dialog, for one session or several. */
export function askToDelete(ids: readonly string[]) {
    const list = ids.map(summaryOf).filter((s) => s !== undefined);
    if (list.length === 1) setDeleteRequest({ id: list[0]!.id, title: list[0]!.title, projectName: list[0]!.projectName });
    else if (list.length > 1) setDeleteRequest({ ids: list.map((s) => s.id), titles: list.map((s) => s.title) });
}

/** Only the commit dialog's explicit Commit click calls this. Errors stay in the dialog. */
/** `pathTokens`: files whose names were shown redacted (GitFileDiff.pathToken), beside `paths`. */
export async function gitCommit(id: string, paths: string[], message: string, expectedHead?: GitCommitHead, pathTokens: string[] = []) {
    try {
        const result = await rpc.call("session.gitCommit", { id, paths, message, expectedHead, ...(pathTokens.length ? { pathTokens } : {}) });
        toast(`Committed ${result.hash.slice(0, 7)} ${result.subject}`, "success");
        return result;
    } finally {
        // Failed hooks can still edit working files; a post-publication error
        // also needs a fresh view even though the dialog stays open.
        refreshGitChanges();
    }
}

export function gitCommitMessage(id: string, paths: string[], pathTokens: string[] = []) {
    return rpc.call("session.gitCommitMessage", { id, paths, ...(pathTokens.length ? { pathTokens } : {}) });
}

/**
 * Archive (or restore) a session. One working in a managed worktree asks first
 * whether to remove the worktree too (ArchiveDialog); any other archives at once.
 */
export async function archive(id: string, archived: boolean) {
    if (archived) {
        // Can't ask (an older server, say): archived as before, keeping everything.
        const offer = await rpc.call("session.archiveOffer", { id }).catch(() => undefined);
        if (offer?.worktree) {
            const title = [...app.sessions, ...app.archived].find((s) => s.id === id)?.title ?? handleFor(id)?.view.state.title ?? "this session";
            setArchiveRequest({ id, title, offer });
            return;
        }
    }
    return setArchived(id, archived);
}

/** Undo brings the session back, never a removed worktree. */
export async function setArchived(id: string, archived: boolean) {
    try {
        await rpc.call("session.archive", { id, archived });
    } catch (e) {
        reportError(e);
        return false;
    }
    if (archived && app.activeId === id) newSession(app.homeCwd);
    toast(
        archived ? "Session archived" : "Session restored",
        "info",
        archived
            ? {
                  label: "Undo",
                  run: async () => {
                      await rpc.call("session.archive", { id, archived: false });
                  },
              }
            : undefined,
    );
    return true;
}

/** Archived from ArchiveDialog: the worktree removed, or kept and why. */
export function archivedWithWorktree(id: string, r: Extract<ArchiveResult, { archived: true }>) {
    // The server closed it to remove the worktree: opening it again (after Undo) starts over.
    if (r.closed) dropHandle(id);
    const gone = r.removed && r.worktree;
    const inside = (p: string | undefined) => Boolean(gone && p && (p === r.worktree || p.startsWith(`${r.worktree}/`)));
    if (inside(app.homeCwd) && r.main) setApp("homeCwd", r.main);
    if (app.activeId === id) newSession(app.homeCwd);
    toast(
        r.removed ? "Session archived; worktree removed" : `Session archived; worktree kept: ${r.kept ?? "it couldn't be removed."}`,
        r.removed ? "success" : "info",
        {
            label: "Undo",
            run: async () => {
                await rpc.call("session.archive", { id, archived: false });
            },
        },
    );
}

export function togglePanel() {
    setPrefs("panel", !prefs.panel);
}

export function toggleSidebar() {
    // Narrow windows: the rail is a drawer over the sheet, opened for the moment.
    if (shellLayout().railMode === "overlay") return void setRailOpen(!railOpen());
    setPrefs("sidebar", !prefs.sidebar);
}

/** Go to the next/previous session in the sidebar's order. */
export function cycleSession(dir: 1 | -1) {
    const ids = sidebarOrder() ?? sidebarIds(sidebarEntries(app.sessions, app.archived, {
        activeId: app.activeId, groupBy: prefs.groupBy, archived: false,
        settledOpen: prefs.settledOpen, cards: SESSION_PAGE, settled: SESSION_PAGE, archive: SESSION_PAGE,
    }));
    const next = adjacentSession(ids, app.activeId, dir);
    if (next) void activate(next);
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
/** `gitToken`: a file a Git listing showed redacted (GitFileDiff.pathToken): the server opens it, `path` unused. `editor`: "finder" reveals it. */
export async function openInEditor(path: string, line?: number, o: { col?: number; folder?: boolean; sessionId?: string; gitToken?: string; editor?: string } = {}) {
    const sessionId = o.sessionId ?? app.activeId;
    if (!sessionId) return;
    try {
        await rpc.call("fs.open", { sessionId, ...(o.gitToken !== undefined ? { gitToken: o.gitToken } : { path }), line, col: o.col, folder: o.folder, ...(o.editor ? { editor: o.editor } : {}) });
    } catch (e) {
        const code = e instanceof RpcError ? e.code : undefined;
        if (code === "no_editor" || code === "not_installed")
            return toast(code === "no_editor" ? "No editor chosen yet. Pick one under Settings → General → Open files with." : (e as Error).message, "warn", {
                label: "Settings",
                run: () => {
                    setSettingsTab("general");
                },
            });
        reportError(e);
    }
}

export { refreshSessions };
