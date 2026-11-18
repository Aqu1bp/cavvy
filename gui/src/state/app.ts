// The GUI's state: the connection, the sidebar's sessions, models, providers
// and projects, and every open session's timeline (kept current from the
// server's ops, applied once per frame).

import { batch, createEffect, createRoot, createSignal, untrack } from "solid-js";
import { createStore, produce, reconcile, unwrap, type SetStoreFunction } from "solid-js/store";
import { planLimitKey, type PlanLimits } from "@shared/protocol";
import type { AgentRun, AgentsMore, AppUpdateInfo, GuiSettings, HelloResult, PermissionModeId, ProjectInfo, ProviderInfo, ProviderModels, ServerEvent, SessionOp, SessionResumed, SessionSnapshot, SessionSummary, WireFile } from "@shared/protocol";
import { applyOp, fromWireLimits, fromWireState, type SessionView } from "@shared/timeline";
import { Rpc, RpcError, type ConnectionState } from "../lib/rpc";
import { allLinks, dropLink, LinkError, linkProblem, linkTo, opened, type LinkProblem } from "../lib/machine-links";
import { canReveal, credentials, focused, machine, notify, isDesktop, showWindow, windowKey } from "../lib/platform";
import { prefs, setPrefs } from "./prefs";
import { backgroundOf, COALESCE_MS, combineEnded, noticeRoute, tabOf, workTabFor } from "../lib/background";
import { mayCreateFiles } from "../lib/pathcache";
// filelinks imports rpc from here: used only once events arrive, so the cycle is harmless.
import { paths } from "./filelinks";
import { repeatedToast, ToastLifetime, toastMs, type Toast, type ToastAction } from "../lib/toasts";
export type { Toast } from "../lib/toasts";
import { DelayedPending } from "../lib/delayed-pending";
import { safeRenderText } from "../lib/render-error";
import { afterFailedReopen } from "../lib/reopen";
import { jumpTarget, setAgentFocus, setFindOpen, setInspectorPane, setJumpTarget, setSettingsTab } from "./ui";
import { applyKeybindingsFile, keymap } from "./keybindings";
import { orderSessions } from "../lib/session-order";
import { composerStorage } from "../lib/drafts";
import { pickedPatch, takePicked } from "../lib/picked";
import { composerDrafts } from "../lib/composer-draft";
import { onStep } from "../lib/stream-clock";
import { waitedOn } from "../lib/waited-on";
import { keyedTurn, placeBefore, type TurnKey } from "../lib/transcript-scroll";

// On a server, the window talks to the Cavvy there; this computer's own Cavvy says where that is (lib/machines.ts).
export const serversUi = () => import("../components/Servers");
/** Why a window on a server isn't connected, in a few words, for the banner that says it's reconnecting. */
export const [connNote, setConnNote] = createSignal<string>();
export const rpc = new Rpc(machine ? async (stream?: boolean) => (await serversUi()).machineCredentials(stream) : credentials, windowKey);

/**
 * Sessions of another machine opened in this window (activate), by id: the connection to that machine's Cavvy
 * (lib/machine-links.ts) that what's asked of each goes over, and what it says of each comes back on.
 */
const away = new Map<string, Rpc>();
/** And the machine each is on ("" for this computer). */
const awayOn = new Map<string, string>();
/** Counts each session recorded in `away`: what reads them (linkedMachine) is run again. */
const [awayCount, setAwayCount] = createSignal(0);
/** The machine `id` is opened here from and the connection to it, once it's recorded (another machine's session). */
export function linkedMachine(id: string): { on: string; link: Rpc } | undefined {
    awayCount();
    const link = away.get(id);
    return link && { on: awayOn.get(id)!, link };
}
rpc.route = (method, params) => {
    // A session's own call names it `id`; one about something of a session's (a path in it), `sessionId`. Others'
    // ids (an account's, a terminal's) aren't sessions', whatever they're called.
    // What this computer lends a server's session (offers.*) is this computer's own, whichever machine that session is on.
    if (method.startsWith("offers.")) return undefined;
    const p = params as { id?: unknown; sessionId?: unknown } | undefined;
    const id = /^(session|browser|simulator)\./.test(method) && typeof p?.id === "string" ? p.id : typeof p?.sessionId === "string" ? p.sessionId : undefined;
    const link = id !== undefined ? away.get(id) : undefined;
    return link ? (link.call as (m: string, p: unknown) => Promise<unknown>)(method, params) : undefined;
};
/**
 * What machine `id` is on: its row's, or (its row not listed yet, after a reload) the one the window was showing it
 * from (cavvy.navigation's `on`); else the window's own.
 */
export function machineOf(id: string): string | undefined {
    // Opened here from another machine (a fork made there may not be listed yet).
    if (awayOn.has(id)) return awayOn.get(id) || undefined;
    const at = [...app.sessions, ...app.archived].find((s) => s.id === id);
    if (at) return at.machine;
    if (restoredOn.has(id)) return restoredOn.get(id) || undefined;
    return machine;
}
/**
 * Home in a folder of another machine's (newSession with one of its sessions on screen): what's sent from it makes a
 * session there, as opening one of its sessions opens it here, over the connection to it. The window isn't loaded
 * again for it (0.2-0.5 s, and what was typed meanwhile went astray).
 */
const [homeAway, setHomeAway] = createSignal<{ on: string; cwd: string; link: Rpc }>();
/** The permission mode picked on Home on each other machine, for the window's life (app.homeMode is this computer's). */
const [awayModes, setAwayModes] = createStore<Record<string, PermissionModeId>>({});
/** Each other machine's recent projects, for Home's project menu while it's on that machine. */
const [machineProjects, setMachineProjects] = createStore<Record<string, ProjectInfo[]>>({});
function machineProjectsAgain(on: string, link: Rpc) {
    void link.call("projects.recent", {}).then((p) => setMachineProjects(on, reconcile(p, { key: "path" })), () => undefined);
}
/** Each other machine's settings, for Home on it: the model, effort and permission mode a session made there starts with. */
const [machineSettings, setMachineSettings] = createStore<Record<string, GuiSettings>>({});
function machineSettingsAgain(on: string, link: Rpc) {
    void link.call("settings.get", {}).then((s) => setMachineSettings(on, reconcile(s)), () => undefined);
}
/** The other machine Home is on, while it's shown in that machine's folder ("" this computer, in a window on a server). */
export function homeOn(): string | undefined {
    const h = homeAway();
    return h && app.activeId === undefined && app.homeCwd === h.cwd ? h.on : undefined;
}
/**
 * Home in `cwd` on `on`, over the connection a session of it opened here has. False (and nothing changed) when none
 * of its sessions is: it isn't connected to here.
 */
export function homeOnMachine(on: string, cwd: string): boolean {
    const id = [...awayOn].find(([k, m]) => m === on && away.has(k))?.[0];
    if (id === undefined) return false;
    const link = away.get(id)!;
    batch(() => {
        setHomeAway({ on, cwd, link });
        setApp("homeCwd", cwd);
        setApp("activeId", undefined);
    });
    if (!(on in machineSettings)) machineSettingsAgain(on, link);
    machineProjectsAgain(on, link);
    if (!(on in machineModels)) machineModelsAgain(on, link);
    return true;
}
/** Home back on the window's own machine. */
export function homeHere() {
    setHomeAway(undefined);
}
/** The settings Home starts a session with: its machine's. */
export function homeSettings(): GuiSettings {
    const on = homeOn();
    return (on !== undefined && machineSettings[on]) || app.settings;
}
/** The permission mode picked on Home: its machine's own (a server's is Bypass; this computer's is never set by a server's). */
export function homeModeOf(): PermissionModeId | undefined {
    const on = homeOn();
    return on !== undefined ? awayModes[on] : app.homeMode;
}
/** Picked on Home on another machine: kept for it while the window's open, as app.homeMode is here. False on the window's own. */
export function setHomeAwayMode(mode: PermissionModeId): boolean {
    const on = homeOn();
    if (on === undefined) return false;
    setAwayModes(on, mode);
    return true;
}
/** The recent projects Home's menu offers: those of the machine it's on. */
export function homeProjects(): ProjectInfo[] {
    const on = homeOn();
    return on !== undefined ? (machineProjects[on] ?? []) : app.projects;
}
/** Home's draft: one for each machine, so what's typed for one isn't sent on another. */
export const homeDraftKey = () => (homeOn() === undefined ? "home" : `home@${homeOn()}`);

/** A setting picked on Home on another machine: saved there. Undefined on the window's own. */
export function updateHomeSettings(patch: Partial<GuiSettings>): Promise<GuiSettings> | undefined {
    const on = homeOn();
    if (on === undefined) return undefined;
    const link = homeAway()!.link;
    if (machineSettings[on]) setMachineSettings(on, patch);
    return link.call("settings.update", { patch } as never).then((s: GuiSettings) => (setMachineSettings(on, reconcile(s)), s));
}
/**
 * The other machine `sessionId` is opened here from, if it is (a server's name; "" this computer, in a window on a
 * server). No session: Home's, while it's on another machine.
 */
export function awayMachine(sessionId: string | undefined): string | undefined {
    return sessionId !== undefined ? awayOn.get(sessionId) : homeOn();
}
/** A new session from `sessionId` (its project, New session while it's shown) goes on its machine: this is it, when that isn't the window's. */
export function machineFor(sessionId: string | undefined): { machine?: string } | undefined {
    const on = awayMachine(sessionId);
    return on === undefined ? undefined : { machine: on || undefined };
}
/** Another machine's session, by its row, not opened here (its connection still being made, or that machine unreachable). */
export function awayUnopened(id: string | undefined): boolean {
    return id !== undefined && !awayOn.has(id) && machineOf(id) !== machine;
}
/** The folder Home shows once `id`, on screen, is gone: its own, unless it's another machine's (it names nothing on the window's); then the window's latest project. */
export function homeCwdAfter(id: string): string | undefined {
    return awayOn.has(id) || awayUnopened(id) ? (app.projects[0]?.path ?? app.hello?.startCwd) : app.homeCwd;
}
/** A session made on another machine from one of its sessions opened here (a fork, a plan carried out): on there too. */
export function sameMachine(from: string, made: string) {
    const link = away.get(from);
    if (!link) return;
    away.set(made, link);
    awayOn.set(made, awayOn.get(from)!);
    setAwayCount((n) => n + 1);
}
/** The last row the pointer came to (warmFor): coming to it again asks nothing more. */
let warmed: string | undefined;
/**
 * The pointer is on a session's row: one of another machine's, its machine is connected to now, so a click opens it
 * without waiting for that too (an address and a sign-in, then the connection: rounds trips before its own).
 */
export function warmFor(id: string) {
    if (id === warmed || away.has(id)) return;
    warmed = id;
    const at = app.sessions.find((s) => s.id === id);
    if (!at || at.machine === machine) return;
    const on = at.machine;
    void linkFor(on).catch(() => {
        // Not reached: it isn't kept trying for a row only pointed at. A click tries again, and says why.
        if (![...awayOn.values()].includes(on ?? "") && !heldLinks.has(on ?? "")) dropLink(on);
    });
}

/** Whether Finder can show `sessionId`'s files: they're on this computer, and so is the window. */
export const revealsIn = (sessionId: string) => canReveal && awayMachine(sessionId) === undefined;
/** The connection to ask about `sessionId` over what isn't named by it (the files in its folder: fs.mentions). */
export function rpcFor(sessionId: string | undefined): Rpc {
    if (sessionId === undefined) return homeOn() !== undefined ? homeAway()!.link : rpc;
    return away.get(sessionId) || rpc;
}
/** Each other machine's models, as its Cavvy lists them: for its sessions opened in this window (modelsFor). */
const [machineModels, setMachineModels] = createStore<Record<string, ProviderModels[]>>({});
/** The models to offer in `sessionId`: its machine's. */
export function modelsFor(sessionId: string | undefined): ProviderModels[] {
    const on = awayMachine(sessionId);
    return on === undefined ? app.models : (machineModels[on] ?? []);
}
/** That machine's models asked for again (`refresh`: from its providers, as Refresh asks). */
function machineModelsAgain(on: string, link: Rpc, refresh = false) {
    void link.call("models.list", { refresh }).then((m) => setMachineModels(on, reconcile(m, { key: "provider" })), () => undefined);
    machineProvidersAgain(on, link);
}
/** Each other machine's providers, as its Cavvy lists them: its CLIs' accounts, for its sessions opened in this window (providersFor). */
const [machineProviders, setMachineProviders] = createStore<Record<string, ProviderInfo[]>>({});
/** The providers of `sessionId`'s machine: whose accounts its model menu offers. */
export function providersFor(sessionId: string | undefined): ProviderInfo[] {
    const on = awayMachine(sessionId);
    return on === undefined ? app.providers : (machineProviders[on] ?? []);
}
function machineProvidersAgain(on: string, link: Rpc) {
    void link.call("providers.list", {}).then((p) => setMachineProviders(on, reconcile(p, { key: "id" })), () => undefined);
    void link.call("limits.get", {}).then((l) => Array.isArray(l) && setMachineLimits(on, reconcile(Object.fromEntries(l.map((x) => [planLimitKey(x.provider, x.accountId), fromWireLimits(x)])))), () => undefined);
}
/** Each other machine's plan limits, as its Cavvy knows them: its accounts are its own ("Default" there isn't this computer's). */
const [machineLimits, setMachineLimits] = createStore<Record<string, Record<string, PlanLimits>>>({});
/** The plan limits of `sessionId`'s machine's accounts. */
export function limitsFor(sessionId: string | undefined): Record<string, PlanLimits> {
    const on = awayMachine(sessionId);
    return on === undefined ? app.limits : (machineLimits[on] ?? {});
}
/** Refresh in the model menu of `sessionId`: its machine's list, or this computer's. */
export function refreshModelsFor(sessionId: string | undefined, refresh = false): Promise<void> {
    const on = awayMachine(sessionId);
    if (on === undefined) return refreshModels(refresh);
    machineModelsAgain(on, rpcFor(sessionId), refresh);
    return Promise.resolve();
}
/** Each other machine's connection, as it is now: for its sessions opened here (connFor). */
const [linkStates, setLinkStates] = createStore<Record<string, ConnectionState>>({});
/** Why each other machine's connection is down, while it is: for the banner of its session on screen (problemFor). */
const [linkIssues, setLinkIssues] = createStore<Record<string, LinkProblem | undefined>>({});
/** Why the connection `sessionId` is shown over (another machine's) is down, if it is and that's known. */
export function problemFor(sessionId: string | undefined): (LinkProblem & { machine: string }) | undefined {
    const on = awayMachine(sessionId);
    const issue = on !== undefined && connFor(sessionId) !== "open" ? linkIssues[on] : undefined;
    return issue && { ...issue, machine: on! };
}
/** The state of the connection `sessionId` is shown over: its machine's, or the window's own. */
export function connFor(sessionId: string | undefined): ConnectionState {
    return connOn(awayMachine(sessionId));
}
/** The state of the connection to machine `on` (awayMachine's names; undefined: the window's own). */
export function connOn(on: string | undefined): ConnectionState {
    return on === undefined ? app.conn : (linkStates[on] ?? "connecting");
}
/**
 * What another machine says that's for this window: what's said of its sessions opened here. Not its lists, its
 * toasts, its settings: those are the window's own machine's. Nor its notifications but a background task's end
 * (said in its session's view): this computer's Cavvy says them, for that machine's sessions opened here or not.
 */
function forUs(e: ServerEvent): boolean {
    if (e.type === "notify") return e.kind === "background";
    // Its browser's and simulator's state: what the agent opened there is said here (its pictures aren't: the panes offer
    // a window on that machine for them, RightPanel).
    return e.type === "session.ops" || e.type === "session.reload" || e.type === "draft" || e.type === "browser.state" || e.type === "simulator.state";
}
/** The session on screen (start), undefined while the window is hidden. */
let shownNow: () => string | undefined = () => undefined;
/**
 * Each machine's Cavvy is told which of its sessions is on screen, and the others that none of theirs is: so each
 * wakes this window less for what isn't (a session left on another machine streams at the hidden pace there).
 */
function tellShown() {
    const id = shownNow();
    // In a split, the other pane too, to its machine when the focused one isn't on it.
    const shown = id === undefined ? [] : [id, ...onScreen.beside().filter((x) => x !== id)];
    // One not linked yet is the window's only if it's on the window's machine.
    const on = (link: Rpc) => shown.find((x) => (away.get(x) ?? ((machineOf(x) ?? "") === (machine ?? "") ? rpc : undefined)) === link);
    if (app.conn === "open") void rpc.call("session.shown", { id: on(rpc) }).catch(() => undefined);
    for (const link of new Set([...allLinks(), ...away.values()])) if (link.state === "open") void link.call("session.shown", { id: on(link) }).catch(() => undefined);
}
/** Connections already listened to: what each says of its sessions comes to the window's handling of its own. */
const heard = new WeakSet<Rpc>();

/** Machines whose connection a terminal panel holds (machineLink): kept, though none of their sessions is open here. */
const heldLinks = new Set<string>();

/**
 * The connection to machine `on` (awayMachine's names: "" this computer, in a window on a server), made if it isn't,
 * and kept: not waited on, so one that can't be reached yet keeps trying by itself (a terminal panel waits for it).
 */
export function machineLink(on: string): Promise<Rpc> {
    heldLinks.add(on);
    return linkMade(on || undefined);
}

/** Connected to `name`'s Cavvy (undefined: this computer's), to open a session of it in this window. */
export async function linkFor(name: string | undefined): Promise<Rpc> {
    const link = await linkMade(name);
    await opened(link, name);
    return link;
}

/** The connection to `name`'s Cavvy, made and listened to if it isn't: not waited on. */
async function linkMade(name: string | undefined): Promise<Rpc> {
    // This computer's Cavvy says where a server's is. In a window on a server it's another connection of the window's.
    const home = machine ? (await import("../lib/machines")).home : undefined;
    const on = name ?? "";
    const theirs = (e: ServerEvent, from: Rpc) => {
        const sessionId = (e as { sessionId?: unknown }).sessionId;
        // As if heard on the window's own connection: what listens there (onEvent, the browser's state) has it.
        if (typeof sessionId === "string" && away.get(sessionId) === from && forUs(e)) rpc.hear(e);
        // Its models changed (a key added there): asked for again, if they were asked for.
        else if (e.type === "models.changed" && on in machineModels) machineModelsAgain(on, from);
        // Its accounts' limits, as they move: for the meter of its sessions here.
        else if (e.type === "limits" && on in machineLimits) setMachineLimits(on, planLimitKey(e.limits.provider, e.limits.accountId), reconcile(fromWireLimits(e.limits)));
    };
    const link = linkTo(name, home ?? rpc, home, theirs);
    if (!heard.has(link)) {
        heard.add(link);
        // This window's own, if it's this computer's connection in a window on a server: heard there by the servers code too.
        if (link === home) link.onEvent((e) => theirs(e, link));
        setLinkStates(on, link.state);
        // Dropped and back: its sessions here have what they missed (session.open's since), as the window's own do.
        link.onState((s) => {
            batch(() => {
                setLinkStates(on, s);
                setLinkIssues(on, s === "open" ? undefined : linkProblem(link));
            });
            const mine = [...handles.values()].filter((h) => away.get(h.id) === link);
            if (s !== "open") return void mine.forEach((h) => h.setReady(false));
            void Promise.all(mine.map((h) => reopen(h)));
            if (mine.length && on in machineModels) machineModelsAgain(on, link);
            tellShown();
        });
    }
    return link;
}
rpc.retriesCredentials = isDesktop;

// ---------------------------------------------------------------------------
// Toasts
//
// Confirmations and notices drop into the title bar's row (Toasts.tsx), at most two, each for a
// moment. Errors don't: they're cards by the composer (ErrorCards.tsx) and stay until they're
// dismissed, or until the code that raised them clears them. A repeat bumps the count of the one up.

// Two rows fit in the title bar's row.
const MAX_TOASTS = 2;
const MAX_QUEUED_TOASTS = 10;
/** Errors waiting to be dismissed: past this many, the oldest without an action goes. */
const MAX_ERRORS = 20;
let toastId = 0;
export const [toasts, setToasts] = createStore<Toast[]>([]);
const toastTimers = new Map<number, { life: ToastLifetime; duration: number; message: string; timer?: ReturnType<typeof setTimeout> }>();
const toastQueue: (Toast & { duration: number })[] = [];

const isError = (t: Toast) => t.level === "error";
/** The title bar's toasts: all but the errors. */
const notices = () => toasts.filter((t) => !isError(t));

function showQueuedToasts() {
    while (notices().length < MAX_TOASTS && toastQueue.length) {
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
    entry.timer = undefined;
    // An error waits for you.
    if (toasts.find((t) => t.id === id)?.level === "error") return;
    if (!entry.life.paused) entry.timer = setTimeout(() => dismissToast(id), entry.life.remaining(performance.now()));
}

export function pauseToast(id: number, reason: "hover" | "focus" | "hidden", paused: boolean) {
    const entry = toastTimers.get(id);
    if (!entry) return;
    if (paused) entry.life.pause(reason, performance.now());
    else entry.life.resume(reason, performance.now());
    scheduleToast(id);
}

export function toast(message: string, level: Toast["level"] = "info", actionOrActions?: ToastAction | ToastAction[], ms?: number) {
    const [action, ...additionalActions] = Array.isArray(actionOrActions) ? actionOrActions : actionOrActions ? [actionOrActions] : [];
    const existing = repeatedToast(toasts, message, level, action);
    if (existing) {
        const index = toasts.findIndex((t) => t.id === existing.id);
        setToasts(index, "count", existing.count + 1);
        toastTimers.get(existing.id)?.life.restart(toastMs(level, ms, action), performance.now());
        scheduleToast(existing.id);
        return;
    }
    const item: Toast = { id: ++toastId, level, message, count: 1, action, additionalActions: additionalActions.length ? additionalActions : undefined };
    const duration = toastMs(level, ms, action);
    if (level === "error") {
        // An error's action is a fix ("Show", "Try again"), not one operation's Undo: the same error with the same
        // fix is one card, counted, with the latest fix (repeatedToast keeps every Undo apart, so it doesn't merge these).
        const same = action && toasts.find((t) => isError(t) && !t.running && t.message === message && t.action?.label === action.label);
        if (same) {
            setToasts(toasts.indexOf(same), { count: same.count + 1, action, additionalActions: item.additionalActions });
            return;
        }
        // Straight into the error stack, which keeps them (it shows two and counts the rest).
        toastTimers.set(item.id, { life: new ToastLifetime(duration, performance.now()), duration, message });
        setToasts((t) => [...t, item]);
        capErrors(item.id);
        return;
    }
    const waiting = repeatedToast(toastQueue, message, level, action);
    if (waiting) {
        waiting.count++;
        return;
    }
    toastQueue.push({ ...item, duration });
    if (notices().length >= MAX_TOASTS) {
        const idle = notices().find((t) => !t.action && !t.running && !toastTimers.get(t.id)?.life.interacting);
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

/**
 * Past the cap the oldest errors go: ones without a fix first, then the oldest not running its fix.
 * Never `added`, the error just raised (it's the one you haven't seen yet). While every other error is
 * running its fix, there may be more for a moment: each fix as it ends calls this again (runToastChoice).
 */
function capErrors(added: number) {
    for (;;) {
        const errors = toasts.filter(isError);
        if (errors.length <= MAX_ERRORS) return;
        const others = errors.filter((t) => t.id !== added && !t.running);
        const oldest = others.find((t) => !t.action) ?? others[0];
        if (!oldest) return;
        dismissToast(oldest.id);
    }
}

export function dismissToast(id: number) {
    clearTimeout(toastTimers.get(id)?.timer);
    toastTimers.delete(id);
    setToasts((t) => t.filter((x) => x.id !== id));
    showQueuedToasts();
}

export function runToastAction(id: number) {
    return runToastChoice(id, 0);
}

export async function runToastChoice(id: number, index: number) {
    const item = toasts.find((t) => t.id === id);
    const entry = toastTimers.get(id);
    const action = index === 0 ? item?.action : item?.additionalActions?.[index - 1];
    if (!action || item?.running || !entry) return;
    setToasts((t) => t.id === id, "running", true);
    entry.life.pause("action", performance.now());
    scheduleToast(id);
    try {
        if ((await action.run()) !== false) {
            dismissToast(id);
            return;
        }
        throw new RpcError("Action failed. Try again.");
    } catch (e) {
        if (!toasts.some((t) => t.id === id)) {
            reportError(e);
            return;
        }
        // The toast itself becomes the error card, keeping its action for an explicit retry (a separate
        // error would leave the failed Undo to time out). Its place in the title bar frees.
        const message = e instanceof Error ? e.message : String(e);
        setToasts((t) => t.id === id, { level: "error", message: `${entry.message}: ${message}` });
        showQueuedToasts();
    } finally {
        // A failed action gets its full lifetime again (an error's has no end), never an automatic retry.
        entry.life.restart(entry.duration, performance.now());
        entry.life.resume("action", performance.now());
        setToasts((t) => t.id === id, "running", false);
        scheduleToast(id);
        // Running, it couldn't go to keep the cap; now it, or another, can (this one's kept if it failed again).
        capErrors(id);
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
    sessionsLoaded: boolean;
    sessionsError: boolean;
    models: ProviderModels[];
    modelsLoading: boolean;
    /** Models have been listed at least once (so "none" means none). */
    modelsLoaded: boolean;
    providers: ProviderInfo[];
    projects: ProjectInfo[];
    settings: GuiSettings;
    /** The session in the main view; none for the home screen. */
    activeId?: string;
    opening?: { id: string; visible: boolean; error?: string };
    /** The project new sessions start in. */
    homeCwd?: string;
    /** The mode picked on the home screen, which new sessions start in; the saved default until then. */
    homeMode?: PermissionModeId;
    seen: Record<string, number>;
    /** The agent CLIs' plan limits, by provider and account: the account's, shared by its sessions. */
    limits: Record<string, PlanLimits>;
    /** The desktop app's updates from main (Settings → About, and the rail's Update button while there's one). */
    update?: AppUpdateInfo;
}

const SEEN_KEY = "cavvy.seen";
const NAVIGATION_KEY = "cavvy.navigation";

/**
 * The session the window was showing as it loaded, and the machine it's on ("" this computer), when that isn't the
 * window's: it's opened from there again (machineOf), its row maybe not listed yet.
 */
const restoredOn = new Map<string, string>();
/** `id` is on machine `on` though its row may not be listed: shown from there before the reload (a split's other pane, state/split.ts), or found there by search. */
export function restoredFrom(id: string, on: string) {
    restoredOn.set(id, on);
}
/** Per webview/tab, separate from device-wide preferences and auth links. */
function loadNavigation(): Pick<AppState, "activeId" | "homeCwd"> {
    try {
        const saved = JSON.parse(sessionStorage.getItem(NAVIGATION_KEY) ?? "null");
        if (typeof saved?.activeId === "string" && typeof saved?.on === "string") restoredOn.set(saved.activeId, saved.on);
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
    sessionsLoaded: false,
    sessionsError: false,
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

/** Nothing connected: the model lists are in and none has a model. Kept while they load again (opening the model
 *  picker does that), so what depends on it doesn't go and come back. */
export const noModel = () => Boolean(app.modelsLoaded && app.models.every((g) => !g.models.length));

// Observe the store so all navigation paths (Home, send, import, deletion and
// sidebar activation) persist together, including direct setApp callers.
createRoot(() => createEffect(() => {
    const id = app.activeId;
    // Another machine's: which, to open it from there again after a reload (machineOf). Read once as it's picked.
    const on = id !== undefined ? untrack(() => machineOf(id)) : undefined;
    const saved = JSON.stringify({ activeId: id, homeCwd: app.homeCwd, ...(on !== machine ? { on: on ?? "" } : {}) });
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

/**
 * Sessions new to this window (another machine's, just heard of): seen as they are, so none starts unread. And
 * `unlisted`: those of another machine that are no longer listed here, of which nothing is kept.
 */
export function markSeenAll(list: SessionSummary[], unlisted: string[] = []) {
    batch(() => {
        for (const s of list) setApp("seen", s.id, s.updatedAt);
        for (const id of unlisted) setApp("seen", id, undefined!);
    });
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
    /** After what's typed in the box (a steer handed back), not before it. */
    after?: boolean;
}

export interface SessionHandle {
    id: string;
    /** Reads can resume only after this handle's session has been opened on the server. */
    ready: () => boolean;
    setReady: (ready: boolean) => void;
    view: SessionView;
    set: SetStoreFunction<SessionView>;
    seq: number;
    /** Whose `seq` it is (SessionSnapshot.epoch): a reconnect asks for what it missed since, from it. */
    epoch?: string;
    queue: SessionOp[];
    scheduled: boolean;
    draft: () => Draft | undefined;
    setDraft: (d: Draft | undefined) => void;
    /** Hand back a draft, added to one no input box has taken yet. */
    addDraft: (d: Draft) => void;
    lastUsed: number;
}

const handles = new Map<string, SessionHandle>();
/**
 * A session opens with its last this many turns at most, and no more than fit OPEN_BYTES (its first screens: with their
 * work folded, 7 to 17 of a long session's turns, against 100 that were 2.4 MB). The rest of its first page comes after
 * its first frame (Transcript), and the rest as they're asked for (loadEarlier).
 */
export const OPEN_TURNS = 100;
export const OPEN_BYTES = 64 * 1024;
/** Each handle's fetch of earlier turns under way: one at a time, so a page is never put in twice. */
const loadingEarlier = new Map<string, Promise<boolean>>();
const [handleVersion, setHandleVersion] = createSignal(0);
const KEEP_OPEN = 8;
/** Sessions on screen besides the one in view (two side by side, state/split.ts sets it): kept open, as that one is. */
export const onScreen: { beside: () => readonly string[] } = { beside: () => [] };
/**
 * What a session is opened with, the first time and again (a reconnect, a reload, one let go of and picked again): its
 * last turns, as fit its first screens. Not every turn the window had of it: after "Show earlier" or Find had them all,
 * that was the whole session again each time. The place read comes back with them (Transcript: loadEarlierTo).
 */
/**
 * How a window opens a session: its last turns, as many as fit OPEN_BYTES; finished ones with their work folded (what
 * only an opened row shows comes as the work is shown: loadTurn), unless work is shown expanded.
 */
const opening = (id: string) => ({ id, last: OPEN_TURNS, budget: OPEN_BYTES, fold: !prefs.expandActivity });
/** Opened afresh: its snapshot (asked without `since`, that's what comes). */
const openFresh = (id: string) => rpc.call("session.open", opening(id)) as Promise<SessionSnapshot>;

export function handleFor(id: string | undefined): SessionHandle | undefined {
    handleVersion();
    return id ? handles.get(id) : undefined;
}

function adopt(snap: SessionSnapshot): SessionHandle {
    const id = snap.state.id;
    // Its unset fields come as null (an unset goal would be read as one).
    const state = fromWireState(snap.state);
    // Ops missed while it wasn't open (or the connection was down) may have created files.
    paths.sawSnapshot(id);
    // There after all (brought back while this window was away).
    sessionPresent(id);
    const existing = handles.get(id);
    if (existing) {
        existing.seq = snap.seq;
        existing.epoch = snap.epoch;
        existing.queue = [];
        const after = [...(renewing.get(id) ?? [])].map((fn) => fn());
        // A message shown as sent stays until its turn comes, unless the snapshot has it (working, or queued).
        const shown = sending.get(id);
        // (A fork shown before it was made, that is: what it had shown was this window's own.)
        const kept = shown && forksMaking.has(id) && !state.busy && !state.queued?.length ? existing.view.turns.find((t) => t.id === shown) : undefined;
        if (shown && !kept) sending.delete(id);
        batch(() => {
            existing.set(reconcile({ state, turns: kept ? [...snap.turns, { ...unwrap(kept) }] : snap.turns, agents: snap.agents ?? [], earlier: snap.earlier ?? 0, agentsMore: snap.agentsMore }, { key: "id", merge: false }));
            existing.setReady(true);
        });
        for (const fn of after) fn?.();
        return existing;
    }
    const h = createRoot(() => {
        const [view, set] = createStore<SessionView>({ state, turns: snap.turns, agents: snap.agents ?? [], earlier: snap.earlier ?? 0, agentsMore: snap.agentsMore });
        const [draft, setDraft] = createSignal<Draft | undefined>();
        const [ready, setReady] = createSignal(true);
        // While no input box has taken it (the session isn't shown), another draft adds to it rather than replacing it.
        const addDraft = (d: Draft) => setDraft((prev) => (prev ? { text: [prev.text, d.text].filter((t) => t).join("\n"), images: [...(prev.images ?? []), ...(d.images ?? [])], files: [...(prev.files ?? []), ...(d.files ?? [])], after: prev.after || d.after } : d));
        return { id, ready, setReady, view, set, seq: snap.seq, epoch: snap.epoch, queue: [] as SessionOp[], scheduled: false, draft, setDraft, addDraft, lastUsed: Date.now() };
    });
    handles.set(id, h);
    trim(id);
    setHandleVersion((v) => v + 1);
    return h;
}

/** A session this window had open, asked for again after its connection was back: what it missed, or a snapshot. */
function reopen(h: SessionHandle): Promise<unknown> {
    return rpc.call("session.open", { ...opening(h.id), ...(h.epoch ? { since: { epoch: h.epoch, seq: h.seq } } : {}) })
        .then((r) => ("resumed" in r ? caughtUp(h, r) : adopt(r)), (e) => reopenFailed(h.id, e));
}

/**
 * A session this window had open, back after its connection dropped with only what it missed (SessionResumed): those
 * ops, after any still waiting, on the view as it is; where it was read, the turns it had paged in, all kept.
 */
function caughtUp(h: SessionHandle, r: SessionResumed): SessionHandle {
    const after = [...(renewing.get(h.id) ?? [])].map((fn) => fn());
    h.queue.push(...r.ops);
    h.seq = r.seq;
    flush(h);
    // Ops missed may have created files.
    if (mayCreateFiles(r.ops)) paths.forgetMissing(h.id);
    sessionPresent(h.id);
    h.setReady(true);
    for (const fn of after) fn?.();
    return h;
}

/** What's shown of each session, told when it comes again (adopt): read with the turns it had, it returns what to do with those it has now. */
const renewing = new Map<string, Set<() => (() => void) | void>>();

/**
 * `fn` runs as `h` comes again from the server (a reconnect, a reload), with its turns as they were; what it returns,
 * with them as they are now. They may be numbered anew: the server may have read the session in again meanwhile.
 * Returns what stops it.
 */
export function onRenew(h: SessionHandle, fn: () => (() => void) | void): () => void {
    let set = renewing.get(h.id);
    if (!set) renewing.set(h.id, (set = new Set()));
    set.add(fn);
    return () => {
        set.delete(fn);
        if (!set.size && renewing.get(h.id) === set) renewing.delete(h.id);
    };
}

/** What's shown of each session, told when its turns are replaced (a rewind's reset) after they're applied. */
const resetting = new Map<string, Set<() => void>>();

/** `fn` runs once `h`'s turns have been replaced by the server's (a reset op). Returns what stops it. */
export function onReset(h: SessionHandle, fn: () => void): () => void {
    let set = resetting.get(h.id);
    if (!set) resetting.set(h.id, (set = new Set()));
    set.add(fn);
    return () => {
        set.delete(fn);
        if (!set.size && resetting.get(h.id) === set) resetting.delete(h.id);
    };
}

/** No longer open here. */
function letGo(h: SessionHandle) {
    handles.delete(h.id);
}

/**
 * Few sessions stay subscribed; the rest are closed (the server keeps running them). Those working or waiting on the
 * user stay, and aren't counted: KEEP_OPEN is of the others. Counted, twelve waiting on plans had every other session
 * closed, the one just left too, each opened afresh on the way back (another machine's: 119-137 ms, against 14-19).
 * Not one holding a message handed back that no box has taken yet: it'd be lost. Nor `opened`, just made or opened to
 * be shown (not yet the one in view): with the others all working or waiting on the user, it was the one closed, and
 * what was typed into it went nowhere.
 */
function trim(opened: string) {
    const kept = (h: SessionHandle) => h.view.state.busy || h.draft() !== undefined;
    let idle = 0;
    for (const h of handles.values()) if (!kept(h)) idle++;
    if (idle <= KEEP_OPEN) return;
    const shown = onScreen.beside();
    const old = [...handles.values()].filter((h) => h.id !== opened && h.id !== app.activeId && !shown.includes(h.id) && !kept(h)).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const h of old.slice(0, idle - KEEP_OPEN)) {
        letGo(h);
        void rpc.call("session.close", { id: h.id }).catch(() => undefined);
    }
}

/**
 * A message shown as sent before the server has it (showSending): its turn, by session, until the server's own comes.
 * Shown only once the server's turn came, the prompt was on screen a round trip after Enter (13-16 ms here; a remote
 * link's round trip there).
 */
const sending = new Map<string, string>();
let sendingIds = 0;

/** `text`, sent to session `id` that isn't working, shown at once as its turn: undone by what's returned. */
export function showSending(id: string, text: string): (taken: boolean) => void {
    const h = handles.get(id);
    if (!h) return () => undefined;
    const turnId = `sending-${++sendingIds}`;
    // One still shown (taken, its turn not here yet) gives way: two at once would leave the first for good.
    const was = sending.get(id);
    if (was) dropSending(h, was);
    sending.set(id, turnId);
    h.set(produce((v) => {
        v.turns.push({ id: turnId, status: "running", prompt: { text }, blocks: [], startedAt: Date.now() });
    }));
    // Answered: what came before the answer (its turn, as a rule) is applied first, so no frame has neither. Taken but
    // its turn not here yet (a session still starting answers first): it stays until its turn or its place in the
    // queue comes (flush), for a moment at most.
    return (taken) => {
        if (h.queue.length) flush(h);
        if (!taken) return dropSending(h, turnId);
        if (sending.get(h.id) === turnId) setTimeout(() => dropSending(h, turnId), SENDING_WAIT_MS);
    };
}

/** How long a message shown as sent waits for its turn after the server took it. */
const SENDING_WAIT_MS = 15_000;

function dropSending(h: SessionHandle, turnId: string) {
    if (sending.get(h.id) !== turnId) return;
    sending.delete(h.id);
    h.set(produce((v) => {
        const i = v.turns.findIndex((t) => t.id === turnId);
        if (i >= 0) v.turns.splice(i, 1);
    }));
}

function flush(h: SessionHandle) {
    h.scheduled = false;
    if (!h.queue.length) return;
    const ops = h.queue;
    h.queue = [];
    // The server's turn for a message shown as sent takes its place, in the same update.
    const shown = sending.get(h.id);
    if (shown && ops.some((op) => op.op === "turn" || op.op === "reset" || (op.op === "state" && "queued" in op.patch))) batch(() => dropSending(h, shown));
    batch(() =>
        h.set(
            produce((v) => {
                for (const op of ops) applyOp(v, op);
            }),
        ),
    );
    if (ops.some((op) => op.op === "reset")) for (const fn of resetting.get(h.id) ?? []) fn();
}

function schedule(h: SessionHandle) {
    if (h.scheduled) return;
    h.scheduled = true;
    // Frames don't run in a hidden window; don't let updates wait for it to come back.
    if (document.visibilityState !== "visible") setTimeout(() => flush(h), 200);
    // On screen: in step with the frames. Not on screen: at once, asking for no frame (10 streaming out of sight drew
    // 20 frames a second that showed nothing).
    else if (h.id === app.activeId || onScreen.beside().includes(h.id)) onStep(() => flush(h));
    else setTimeout(() => flush(h), 0);
}

/** At the next frame, with whatever came before it (in order). */
function flushSoon(h: SessionHandle) {
    if (document.visibilityState !== "visible") return schedule(h);
    requestAnimationFrame(() => flush(h));
}

/** The server closed the session (archived with its worktree): this window no longer has it open. */
export function dropHandle(id: string) {
    if (!handles.delete(id)) return;
    setHandleVersion((v) => v + 1);
}

/** Each open under way: one asked for again meanwhile (the other of two side by side, state/split.ts) waits for it. */
const openingNow = new Map<string, Promise<SessionHandle>>();

export function openSession(id: string): Promise<SessionHandle> {
    const h = handles.get(id);
    if (h) {
        h.lastUsed = Date.now();
        return Promise.resolve(h);
    }
    const going = openingNow.get(id);
    if (going) return going;
    const opened = openNow(id);
    openingNow.set(id, opened);
    const done = () => { if (openingNow.get(id) === opened) openingNow.delete(id); };
    opened.then(done, done);
    return opened;
}

async function openNow(id: string): Promise<SessionHandle> {
    // Asked for already, with the lists (openAhead): that answer, whatever it was.
    const early = aheadFor(id);
    if (early) {
        ahead = undefined;
        const taken = await early;
        // Let go since (the server had it opened again, and that was refused): it's asked for anew.
        if (handles.get(id) === taken) return taken;
    }
    return adopt(await openFresh(id));
}

/**
 * The session a window loads on, asked for while its lists load, not after them: over a network that's a wait
 * less before it shows (measured on a server 40 ms away: 99 ms of 342). It's taken in as it arrives, so nothing it
 * streams meanwhile is missed, and its conversation is in the window from then on. What opening it also does
 * (it's marked seen, its folder becomes the window's, a failure is shown) waits for the lists, as before
 * (restoreActiveSession).
 *
 * The answer belongs to the connection that asked: one from before a reconnect, or left over from a start that
 * failed, is nobody's.
 */
let ahead: { id: string; connection: number; opened: Promise<SessionHandle> } | undefined;
const aheadFor = (id: string | undefined) => (ahead && ahead.id === id && ahead.connection === connectionVersion ? ahead.opened : undefined);
function openAhead() {
    ahead = undefined;
    const id = app.activeId;
    // Another machine's is opened over a connection of its own (activate).
    if (!id || handles.has(id) || machineOf(id) !== machine) return;
    const opened = openFresh(id).then(adopt);
    // Its failure is restoreActiveSession's to show.
    opened.catch(() => undefined);
    ahead = { id, connection: connectionVersion, opened };
}

/**
 * Turns before those the window has (it opened with its last OPEN_TURNS), put in before them: `count` more, back to
 * the turn holding message `through`, or `all` of them. False when they couldn't be had (the session's turns were
 * replaced meanwhile, as by a rewind: then it has them all already) or the server didn't answer.
 */
export function loadEarlier(h: SessionHandle, how: { count?: number; through?: { seg: number; index: number }; all?: boolean; upTo?: number } = {}): Promise<boolean> {
    const going = loadingEarlier.get(h.id);
    // One at a time: the next asks from where that one left off.
    const run = (going ?? Promise.resolve(true)).then(async () => {
        // A page far up asked for while one is here already (with its gap): that one goes back into the gap first.
        if (how.upTo !== undefined && h.view.gap) dropPage(h);
        if (!h.view.earlier) return true;
        const first = h.view.turns[0]?.id;
        if (!first) return false;
        const page = await rpc.call("session.turns", { id: h.id, before: first, fold: !prefs.expandActivity, ...how });
        // Ops sent before this answer are in it: those still queued go first, to the turns already here.
        flush(h);
        if (h.view.turns[0]?.id !== first) return false;
        batch(() => h.set(produce((v) => {
            v.turns.unshift(...page.turns);
            v.earlier = page.earlier;
            if (page.skipped && page.turns.length) v.gap = { after: page.turns.at(-1)!.id, count: page.skipped };
            // Their sub-agents whole: the window had only what its list shows of them (AgentRun.partial), or only
            // counted them (agentsMore).
            for (const a of page.agents ?? []) {
                const i = v.agents.findIndex((x) => x.id === a.id);
                // (One listed, of a turn sent folded, doesn't take the place of one whole.)
                if (i >= 0) {
                    if (!a.partial || v.agents[i]!.partial) v.agents[i] = a;
                } else {
                    v.agents.push(a);
                    if (v.agentsMore) v.agentsMore = lessAgents(v.agentsMore, a);
                }
            }
        })));
        return true;
    });
    const settled = run.catch(() => false);
    loadingEarlier.set(h.id, settled);
    void settled.finally(() => { if (loadingEarlier.get(h.id) === settled) loadingEarlier.delete(h.id); });
    return settled;
}

/** The page before a gap let go of: its turns are the gap's (earlier than them, `earlier`'s), and no gap is left. */
function dropPage(h: SessionHandle) {
    const gap = h.view.gap;
    if (!gap) return;
    const at = h.view.turns.findIndex((t) => t.id === gap.after);
    batch(() => h.set(produce((v) => {
        v.turns.splice(0, at + 1);
        v.earlier = (v.earlier ?? 0) + at + 1 + gap.count;
        v.gap = undefined;
    })));
}

/** The gap's next page (those after the page fetched far up), in one request: false when it couldn't be had, "moved" when the gap changed meanwhile. */
const fillingGap = new Map<string, Promise<boolean | "moved">>();
/** `put`: told, in the same update, how many turns went in (a view counting what it shows from the end shows them too). */
export function fillGap(h: SessionHandle, count = 40, put?: (n: number) => void): Promise<boolean | "moved"> {
    const going = fillingGap.get(h.id);
    if (going) return going;
    const run = (async () => {
        const gap = h.view.gap;
        if (!gap) return true;
        const at = h.view.turns.findIndex((t) => t.id === gap.after);
        const next = h.view.turns[at + 1]?.id;
        if (at < 0 || !next) return "moved";
        const page = await rpc.call("session.turns", { id: h.id, before: next, after: gap.after, count, fold: !prefs.expandActivity });
        flush(h);
        const now = h.view.gap;
        if (!now || now.after !== gap.after || h.view.turns[at + 1]?.id !== next) return "moved";
        batch(() => {
            put?.(page.turns.length);
            h.set(produce((v) => {
            v.turns.splice(at + 1, 0, ...page.turns);
            v.gap = page.skipped && page.turns.length ? { after: page.turns.at(-1)!.id, count: page.skipped } : undefined;
            for (const a of page.agents ?? []) {
                const i = v.agents.findIndex((x) => x.id === a.id);
                if (i >= 0) {
                    if (!a.partial || v.agents[i]!.partial) v.agents[i] = a;
                } else {
                    v.agents.push(a);
                    if (v.agentsMore) v.agentsMore = lessAgents(v.agentsMore, a);
                }
            }
            }));
        });
        return true;
    })().catch(() => false);
    fillingGap.set(h.id, run);
    void run.finally(() => { if (fillingGap.get(h.id) === run) fillingGap.delete(h.id); });
    return run;
}

/** Whole before its view opens (a sub-agent of a turn the window doesn't have): the view's first frame is all of it. */
export function agentReady(agentId: string): Promise<void> {
    for (const h of handles.values()) {
        const a = h.view.agents.find((x) => x.id === agentId);
        if (a) return a.partial ? loadAgent(h, agentId) : Promise.resolve();
    }
    return Promise.resolve();
}

/**
 * The window keeps only the last `keep` of a session's turns (the reader's back at its end after reading far up): the
 * rest are as the session opened without them (`earlier`, session.turns has them), and their sub-agents as their list
 * shows them. What it holds stays what's on screen, not all it was ever scrolled through.
 */
export function forgetEarlier(h: SessionHandle, keep: number) {
    const drop = h.view.turns.length - keep;
    // Not while a page of them is coming: it's put in before the first it has.
    if (drop <= 0 || loadingEarlier.has(h.id)) return;
    batch(() => h.set(produce((v) => {
        // Past a gap: what's let go of before it, and the gap with it, are earlier ones now.
        const gapAt = v.gap ? v.turns.findIndex((t) => t.id === v.gap!.after) : -1;
        const gone = new Set(v.turns.splice(0, drop).map((t) => t.id));
        v.earlier = (v.earlier ?? 0) + drop;
        if (v.gap && gapAt >= 0 && drop > gapAt) {
            v.earlier += v.gap.count;
            v.gap = undefined;
        }
        v.agents = v.agents.map((a) => {
            if (!gone.has(a.turnId) || a.partial || a.status === "running" || a.status === "waiting") return a;
            const { blocks: _b, prompt: _p, report: _r, ...listed } = a;
            return { ...listed, blocks: [], partial: true };
        });
    })));
}

/** A count of sub-agents not sent, less one that has come (with its turn). */
function lessAgents(more: AgentsMore, a: AgentRun): AgentsMore | undefined {
    const count = more.count - 1;
    return count > 0 ? { count, failed: Math.max(0, more.failed - (a.status === "failed" ? 1 : 0)) } : undefined;
}

/** Each session's fetch of its sub-agents' list under way (loadAgentList). */
const loadingAgentList = new Map<string, Promise<void>>();

/**
 * The sub-agents a session's window was only told the number of (agentsMore: finished, of turns it hasn't been sent),
 * as their rows show them: for its Agents list's Finished fold, as that's shown.
 */
export function loadAgentList(h: SessionHandle): Promise<void> {
    const going = loadingAgentList.get(h.id);
    if (going) return going;
    const run = rpc.call("session.agentList", { id: h.id }).then((list) => {
        h.set(produce((v) => {
            const have = new Set(v.agents.map((a) => a.id));
            // In the server's order (as they started), those the window has kept where they are.
            for (const a of list) if (!have.has(a.id)) v.agents.push(a);
            v.agentsMore = undefined;
        }));
    }, () => undefined).finally(() => loadingAgentList.delete(h.id));
    loadingAgentList.set(h.id, run);
    return run;
}

/** Each turn's fetch under way (loadTurn). */
const loadingTurn = new Map<string, Promise<void>>();

/**
 * A turn whole, and its sub-agents, for one sent with its work folded (Turn.folded), put in its place: as its work is
 * about to be shown (opened, found in), which waits for it.
 */
export function loadTurn(h: SessionHandle | undefined, turnId: string): Promise<void> {
    if (!h || !h.view.turns.some((t) => t.id === turnId && t.folded)) return Promise.resolve();
    const key = `${h.id}:${turnId}`;
    const going = loadingTurn.get(key);
    if (going) return going;
    const run = rpc.call("session.turn", { id: h.id, turnId }).then((r) => {
        if (!r) return;
        // Ops sent before this answer are in it: those still queued go first.
        flush(h);
        batch(() => h.set(produce((v) => {
            // Filled in where it is (the same turn: its view isn't made again).
            const t = v.turns.find((x) => x.id === turnId);
            if (t?.folded) {
                Object.assign(t, r.turn);
                delete t.folded;
            }
            for (const a of r.agents) {
                const j = v.agents.findIndex((x) => x.id === a.id);
                if (j < 0) v.agents.push(a);
                else if (v.agents[j]!.partial) v.agents[j] = a;
            }
        })));
    }, () => undefined).finally(() => loadingTurn.delete(key));
    loadingTurn.set(key, run);
    return run;
}

/** Each block's fetch under way (loadBlock). */
const loadingBlock = new Map<string, Promise<void>>();

/**
 * A block of a turn the window has whole, for one sent without all of itself (a finished turn's thought, without its
 * text: ThinkingBlock.omitted), put in its place.
 */
export function loadBlock(sessionId: string, blockId: string): Promise<void> {
    const h = handles.get(sessionId);
    // Only one still without its text: a whole one has nothing more to bring.
    const turn = h?.view.turns.findLast((t) => t.blocks.some((b) => b.id === blockId && b.t === "thinking" && b.omitted));
    if (!h || !turn) return Promise.resolve();
    const key = `${sessionId}:${blockId}`;
    const going = loadingBlock.get(key);
    if (going) return going;
    const turnId = turn.id;
    const run = rpc.call("session.block", { id: sessionId, turnId, blockId }).then((b) => {
        if (!b) return;
        h.set(produce((v) => {
            const t = v.turns.findLast((x) => x.id === turnId);
            const i = t ? t.blocks.findIndex((x) => x.id === blockId) : -1;
            // Still without it (not sent again whole since).
            const was = t?.blocks[i];
            if (was?.t === "thinking" && was.omitted) t!.blocks[i] = b;
        }));
    }, () => undefined).finally(() => loadingBlock.delete(key));
    loadingBlock.set(key, run);
    return run;
}

/** Each sub-agent's fetch under way (loadAgent): one at a time. */
const loadingAgent = new Map<string, Promise<void>>();

/**
 * A sub-agent whole, for one the window has only what its list shows of (AgentRun.partial: its turn wasn't sent): its
 * steps, instructions and report, put in its place. Nothing when it's whole already or the server no longer has it.
 */
export function loadAgent(h: SessionHandle, agentId: string): Promise<void> {
    const key = `${h.id}:${agentId}`;
    const going = loadingAgent.get(key);
    if (going) return going;
    const run = rpc.call("session.agent", { id: h.id, agentId }).then((a) => {
        if (!a) return;
        h.set(produce((v) => {
            const i = v.agents.findIndex((x) => x.id === agentId);
            // Whole by now (its turn came, or it ran again): that's the latest.
            if (i >= 0 && v.agents[i]!.partial) v.agents[i] = a;
        }));
    }, () => undefined).finally(() => loadingAgent.delete(key));
    loadingAgent.set(key, run);
    return run;
}

/** The fetch of earlier turns under way for this session, if one is (one fetched ahead, say): done when it is. */
export function earlierArriving(h: SessionHandle): Promise<boolean> {
    return loadingEarlier.get(h.id) ?? Promise.resolve(true);
}

/**
 * The turns back to `key`'s, in one request: where the session was being read, opened again with fewer turns than that
 * (new ones pushed it out). Undefined, with nothing asked, when it's here already or would be here if it still were.
 */
export function loadEarlierTo(h: SessionHandle, key: TurnKey): Promise<boolean> | undefined {
    const near = key.near;
    if (!near || !h.view.earlier || keyedTurn(h.view.turns, key)) return undefined;
    const first = h.view.turns.find((t) => t.pos)?.pos;
    if (first && !placeBefore(near, first)) return undefined;
    return loadEarlier(h, { through: near, count: 1, upTo: 40 });
}

/** A Claude Code or Codex session of this folder, as a Cavvy session (a new one, or the one that already holds it). */
export async function importCliSession(cwd: string, source: string, id: string): Promise<SessionHandle> {
    const snap = await rpc.call("cliSessions.import", { cwd, source, id });
    return adopt(snap);
}

/** Where a session made from Home now would be made: its machine's connection and mode (`there` unset: this window's). */
export type HomeAt = { there?: { on: string; link: Rpc }; mode?: PermissionModeId };
export function homeAt(): HomeAt {
    const h = homeOn() !== undefined ? homeAway() : undefined;
    return { there: h && { on: h.on, link: h.link }, mode: homeModeOf() };
}

/** Make a session in `cwd`, on Home's machine as it was when `at` was taken (the user may have moved on since). */
export async function createSession(cwd: string, at: HomeAt = homeAt()): Promise<SessionHandle> {
    // From Home on another machine: made there, and opened here as one of its sessions is.
    const { there, mode } = at;
    const snap = await (there ? there.link : rpc).call("session.create", { cwd, mode });
    if (there) {
        away.set(snap.state.id, there.link);
        awayOn.set(snap.state.id, there.on);
        setAwayCount((n) => n + 1);
    }
    return adopt(snap);
}

let openingVersion = 0;
let connectionVersion = 0;
let openingConnection = 0;
const pending = new DelayedPending(() => {
    if (app.opening) setApp("opening", "visible", true);
});
// Home, imports, deletion and other direct navigation also invalidate an open.
createRoot(() => createEffect(() => {
    if (app.opening && app.opening.id !== app.activeId) {
        openingVersion++;
        pending.cancel();
        setApp("opening", undefined);
    }
}));

/** Fork a session at the end of the turn `turn` of its prompt `index` (shown as `text`), and show the fork. */
export async function forkSession(id: string, at: { index: number; text: string; turn: string }): Promise<SessionHandle> {
    const snap = await rpc.call("session.fork", { ...opening(id), id, ...at, soon: true });
    sameMachine(id, snap.state.id);
    const h = adopt(snap);
    // Its row too, selected as it's shown, until the server lists it: the original's, as the fork starts.
    const o = snap.making ? [...app.sessions, ...app.archived].find((s) => s.id === id) : undefined;
    if (o && !upsertsDue.has(h.id) && !app.sessions.some((s) => s.id === h.id)) {
        const { run: _r, waitingKind: _w, turnStartedAt: _t, ...kept } = o;
        upsertSession({ ...kept, id: h.id, title: snap.state.title ?? o.title, createdAt: snap.state.createdAt, updatedAt: Date.now(), status: "idle", pinned: false, archived: false, settled: false, live: true, making: true });
    }
    await activate(h.id);
    if (!snap.making) return h;
    // Shown as it will be while it's made; opened (watched) once it is, its turns taking the place of those shown.
    // Returns then, so what says it's forked says so once it is. Failing, the window goes back to the original.
    forksMaking.set(h.id, id);
    try {
        const made = await openFresh(h.id);
        if (handles.get(h.id) === h) adopt(made);
        // The server's row takes its place as it's listed; one not listed yet is no longer being made.
        upsertsFirst();
        setApp("sessions", (s) => s.id === h.id && !!s.making, "making", undefined);
        return h;
    } catch (e) {
        upsertsFirst();
        setApp("sessions", (l) => (l.some((s) => s.id === h.id && s.making) ? l.filter((s) => !(s.id === h.id && s.making)) : l));
        if (handles.get(h.id) === h) {
            dropHandle(h.id);
            if (app.activeId === h.id) void activate(id);
        }
        throw e;
    } finally {
        forksMaking.delete(h.id);
    }
}

/** Forks shown before they're made (forkSession), by the session each is a fork of: a message sent to one that fails goes back there. */
const forksMaking = new Map<string, string>();

/** The session `id` is a fork of, while that fork is being made. */
export function forkMakingOf(id: string): string | undefined {
    return forksMaking.get(id);
}

/** `id`, a session of machine `on`'s, is opened here over `link` from now on. */
function linked(id: string, on: string | undefined, link: Rpc) {
    away.set(id, link);
    awayOn.set(id, on ?? "");
    setAwayCount((n) => n + 1);
    if (!((on ?? "") in machineModels)) machineModelsAgain(on ?? "", link);
    // And its settings: Home on it (a new session from this one) starts with them.
    if (!((on ?? "") in machineSettings)) machineSettingsAgain(on ?? "", link);
    tellShown();
}

/**
 * Opens a session without showing it in the main view (the one beside it in a split, Panes): one of another
 * machine's over the connection to it, made first if it isn't.
 */
export async function openBeside(id: string): Promise<SessionHandle> {
    const on = machineOf(id);
    if (on !== machine && !away.has(id)) linked(id, on, await linkFor(on));
    return openSession(id);
}

/** Show a session in the main view. Select immediately; only the newest request may finish navigation. */
export async function activate(id: string | undefined, cwd?: string) {
    // One on another machine: opened here, over a connection to that machine's Cavvy (linkFor), as one of the window's
    // own is. (The window went there instead, loading again: 0.5-0.8 s each way, its sessions opened afresh each time.)
    const on = id ? machineOf(id) : machine;
    const elsewhere = id !== undefined && on !== machine && !away.has(id);
    if (jumpTarget() && jumpTarget()!.sessionId !== id) setJumpTarget(undefined);
    if (id !== app.activeId) setFindOpen(false);
    pending.cancel();
    const version = ++openingVersion;
    const cached = id ? handles.get(id) : undefined;
    if (cached) {
        // Preserve the mounted view (pagination, scroll, drafts) when picking it again.
        // Cached navigation never needs a loading screen, even for another session.
        cached.lastUsed = Date.now();
        batch(() => {
            setApp("activeId", id);
            setApp("opening", undefined);
            if (cached.view.state.cwd) setApp("homeCwd", cached.view.state.cwd);
            markSeen(cached.id);
        });
        return;
    }
    const connection = openingConnection = connectionVersion;
    // A pick that turns out to be gone (a stale search hit) goes back to where you were.
    const prior = app.activeId && app.activeId !== id ? { id: app.activeId, cwd: app.homeCwd } : undefined;
    // Restoring the selection after a reload is silent; a pick says why it went nowhere.
    const picked = app.activeId !== id;
    batch(() => {
        setApp("activeId", id);
        setApp("opening", id ? { id, visible: false, error: undefined } : undefined);
        const where = (app.sessions.find((x) => x.id === id) ?? app.archived.find((x) => x.id === id))?.cwd ?? cwd;
        if (where) setApp("homeCwd", where);
    });
    if (!id) return;
    const project = app.homeCwd;
    const current = () => version === openingVersion && connection === connectionVersion && app.activeId === id && app.homeCwd === project;
    pending.start();
    try {
        if (elsewhere) {
            const link = await linkFor(on);
            if (!current()) return;
            linked(id, on, link);
        }
        const h = await openSession(id);
        if (!current()) return;
        await pending.finish();
        if (!current()) return;
        batch(() => {
            setApp("opening", undefined);
            if (h.view.state.cwd) setApp("homeCwd", h.view.state.cwd);
            markSeen(id);
        });
    } catch (e) {
        if (!current()) return;
        await pending.finish();
        if (!current()) return;
        if (e instanceof RpcError && e.code === "not_found") {
            forgetSession(id);
            if (picked) reportError(e);
            if (prior && handles.has(prior.id)) batch(() => {
                setApp("activeId", prior.id);
                if (prior.cwd) setApp("homeCwd", prior.cwd);
            });
            else if (prior && !wasDeleted(prior.id)) void activate(prior.id, prior.cwd);
            return;
        }
        // That machine needs the user's word first (its host key, an update, starting its Cavvy): the window goes
        // there, where it's asked (lib/machines.ts), and opens the session once it's given.
        if (e instanceof LinkError && e.problem && e.problem.status !== "failed") {
            setApp("opening", undefined);
            return void serversUi().then((m) => m.switchMachine(on, id), reportError);
        }
        const error = safeRenderText(e instanceof Error ? e.message : String(e));
        setApp("opening", { id, visible: true, error: error || "Opening failed. Try again." });
        if (e instanceof RpcError && e.code === "needs_trust" && project) {
            requestTrust(project, () => { if (current()) void activate(id, project); }, undefined, undefined, rpcFor(id));
        }
        if (jumpTarget()?.sessionId === id) setJumpTarget(undefined);
    }
}

/** Restore only after bootstrap. Lists are capped, so absence is not deletion. */
export async function restoreActiveSession() {
    const id = app.activeId;
    // One asked for ahead is here already, and still to be shown as opened.
    const early = Boolean(aheadFor(id));
    if (!early || handles.has(id!)) ahead = undefined;
    if (!id || (handles.has(id) && !app.opening && !early)) return;
    // A request from a previous connection may still be waiting out its spinner.
    // Supersede it rather than letting its disconnected result win after bootstrap.
    if (app.opening?.id === id && !app.opening.error && openingConnection === connectionVersion) return;
    await activate(id, app.homeCwd);
}

// Trust prompts are shown by the App component; this hands them over.
/**
 * MCP approval upgrades existing session trust, and an agent CLI that runs the folder's own hooks (`reason` says so)
 * needs it: declining either must not change that session.
 */
/** `link`: the connection to the machine the folder is on (another machine's session, or Home on one: rpcFor). */
export const [trustRequest, setTrustRequest] = createSignal<{ path: string; then: () => void; purpose?: "mcp-approval" | "agent"; reason?: string; link?: Rpc } | undefined>();
export function requestTrust(path: string, then: () => void, purpose?: "mcp-approval" | "agent", reason?: string, link?: Rpc) {
    setTrustRequest({ path, then, purpose, reason, link });
}

// ---------------------------------------------------------------------------
// Lists

/**
 * The sessions on the user's other machines, where this Cavvy has servers: listed with this machine's own, each
 * with the machine it's on (`list`: components/OtherMachines.tsx keeps them, and adds and removes one as it
 * changes). And `shown`: one of the window's own as its row shows it, when more is known of it than the machine
 * it's on says (lib/lent.ts, in a window on a server).
 */
export const others: { list?: () => SessionSummary[]; shown?: (s: SessionSummary) => SessionSummary } = {};
/** A session of the window's own machine, as the list holds it: with that machine, when it's a server. */
const own = (s: SessionSummary): SessionSummary => {
    const row = machine ? { ...s, machine } : s;
    return others.shown?.(row) ?? row;
};

export async function refreshSessions() {
    const markers = new Map(deleted);
    const lists = await Promise.all([rpc.call("sessions.list", { limit: 300 }), rpc.call("sessions.list", { limit: 300, archived: true })]).catch((e) => {
        setApp("sessionsError", true);
        throw e;
    });
    // A list confirms a missed restore, but cannot undo a deletion that happened
    // while either request was in flight (including a second deletion after Undo).
    const [list, archived] = lists.map((rows) => rows.filter((s) => !deleted.has(s.id) || deleted.get(s.id) === markers.get(s.id)).map(own)) as typeof lists;
    // The other machines' sessions go on being listed: none in the place of one of this machine's own.
    const mine = new Set([...list, ...archived].map((s) => s.id));
    for (const s of others.list?.() ?? []) if (!mine.has(s.id)) (s.archived ? archived : list).push(s);
    // (What came before the list is in it.)
    upsertsFirst();
    // The open search result can be older than the server's list window.
    const active = [...app.sessions, ...app.archived].find((s) => s.id === app.activeId);
    if (active && !deleted.has(active.id) && ![...list, ...archived].some((s) => s.id === active.id)) {
        (active.archived ? archived : list).push(active);
    }
    // A fork being made isn't listed yet: its row stays till it is.
    for (const s of app.sessions) if (s.making && s.id !== active?.id && forksMaking.has(s.id) && !list.some((x) => x.id === s.id)) list.push(s);
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
    batch(() => {
        setApp("sessions", reconcile(orderSessions(list), { key: "id" }));
        setApp("archived", reconcile(orderSessions(archived), { key: "id" }));
        setApp("sessionsLoaded", true);
        setApp("sessionsError", false);
    });
}

/** `after`: what the list waits for before it's taken in, once it has come (at startup, the providers: Home's "connect a model" card reads both, and says the wrong thing with the models alone). */
export async function refreshModels(refresh = false, after?: Promise<unknown>) {
    setApp("modelsLoading", true);
    try {
        const models = await rpc.call("models.list", { refresh });
        await after?.catch(() => undefined);
        setApp("models", reconcile(models, { key: "provider" }));
        setApp("modelsLoaded", true);
        usePicked();
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
    setApp("limits", reconcile(Object.fromEntries(limits.map((l) => [planLimitKey(l.provider, l.accountId), fromWireLimits(l)]))));
}

export async function refreshUpdate() {
    setApp("update", reconcile(await rpc.call("app.update.get", {})));
}

/** How old the last check may be when the window comes to the front before main is looked at again. */
const UPDATE_STALE_MS = 10 * 60_000;

/**
 * Coming back to the window, or to the server: main may have moved since the last check (the server's own are half an
 * hour apart). None before the server's first, which comes a few seconds after it starts.
 */
function recheckUpdate() {
    const u = app.update;
    if (document.visibilityState !== "visible" || app.conn !== "open" || !u?.checkedAt || u.unavailable || u.updating || u.checking) return;
    rpc.call("app.update.check", { maxAgeMs: UPDATE_STALE_MS }).then((info) => setApp("update", reconcile(info)), () => undefined);
}

let keybindingsLoaded = false;
export async function refreshKeybindings() {
    const { fatal } = applyKeybindingsFile(await rpc.call("keybindings.get", {}));
    // Problems in the file are told once a window opens; reconnects stay quiet.
    if (keybindingsLoaded) return;
    keybindingsLoaded = true;
    const issues = keymap().issues;
    if (fatal || issues.length) toast(`Your keybindings file has ${issues.length === 1 ? "a problem" : `${issues.length} problems`}: ${issues[0]!.message}`, issues.some((i) => i.level === "error") ? "error" : "warn", { label: "Show", run: () => void setSettingsTab("shortcuts") });
}

/** A save of the keybindings file: applied at once, and a word on how it went. */
function keybindingsChanged(next: Parameters<typeof applyKeybindingsFile>[0]) {
    const { fatal } = applyKeybindingsFile(next);
    const show = { label: "Show", run: () => void setSettingsTab("shortcuts") };
    if (fatal) return toast(`Keybindings not reloaded: ${fatal}`, "error", show);
    const issues = keymap().issues;
    if (issues.length) {
        const errors = issues.filter((i) => i.level === "error").length;
        return toast(`Keybindings reloaded with ${issues.length} problem${issues.length === 1 ? "" : "s"}: ${issues[0]!.message}`, errors ? "error" : "warn", show);
    }
    toast(next.text === undefined ? "Keybindings file removed: default shortcuts" : "Keybindings reloaded", "info");
}

/**
 * What the user had picked for a new session on the machine the window came from (lib/picked.ts): taken up here
 * once this machine's settings and models are both in, when it has that model. Then it's this machine's too.
 */
let picked = takePicked(() => sessionStorage);
/** Still to be taken up: a window that leaves before then takes it on (lib/machines.ts). */
export const pendingPicked = () => picked;
/** How long the first screen waits for the models when a pick came with the window: after that it's let go, so the composer doesn't change once it's shown. */
const PICKED_WAIT_MS = 400;
let settingsIn = false;
function usePicked() {
    if (!picked || !settingsIn || !app.modelsLoaded) return;
    const patch = pickedPatch(picked, app.settings, app.models.flatMap((g) => g.models));
    picked = undefined;
    if (!patch) return;
    // Shown at once; what the machine then says it has is what stays.
    setApp("settings", { ...app.settings, ...patch });
    void rpc.call("settings.update", { patch }).then((s) => setApp("settings", s), (e) => (reportError(e), refreshSettings()));
}

export async function refreshSettings() {
    setApp("settings", await rpc.call("settings.get", {}));
    settingsIn = true;
    usePicked();
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
export function forgetSession(id: string) {
    // One due to be put in (changed just before) goes in first, so it doesn't come back after.
    upsertsFirst();
    deleted.set(id, Symbol());
    setSessionPresenceVersion((v) => v + 1);
    if (jumpTarget()?.sessionId === id) setJumpTarget(undefined);
    composerDrafts.delete(id);
    composerStorage.delete(id);
    setApp("sessions", (l) => l.filter((s) => s.id !== id));
    setApp("archived", (l) => l.filter((s) => s.id !== id));
    if (handles.delete(id)) setHandleVersion((v) => v + 1);
    if (app.seen[id] !== undefined) {
        seenBeforeDelete.set(id, app.seen[id]!);
        setApp("seen", id, undefined!);
        saveSeen();
    }
    if (app.activeId === id) batch(() => {
        setApp("homeCwd", homeCwdAfter(id));
        setApp("activeId", undefined);
    });
}

/** Opening it again failed: deleted meanwhile, kept while disconnected (the reconnect reopens it), or dropped. */
function reopenFailed(id: string, e: unknown) {
    const next = afterFailedReopen(e instanceof RpcError ? e.code : undefined);
    if (next === "forget") forgetSession(id);
    else if (next === "drop") {
        const h = handles.get(id);
        if (!h) return;
        letGo(h);
        setHandleVersion((v) => v + 1);
    }
}

export function upsertSession(s: SessionSummary) {
    upsertsDue.delete(s.id);
    upsertsDue.set(s.id, s);
    upsertsFirst();
}

/** Into the lists in one update: the sidebar and the palette are worked out again once, not once each. */
function upsertSessions(all: readonly SessionSummary[]) {
    if (!all.length) return;
    for (const s of all) {
        sessionPresent(s.id);
        const seen = seenBeforeDelete.get(s.id);
        if (seen !== undefined) {
            seenBeforeDelete.delete(s.id);
            if (app.seen[s.id] === undefined) markSeen(s.id, seen);
        }
    }
    const put = (key: "sessions" | "archived", these: readonly SessionSummary[], gone: ReadonlySet<string>) =>
        setApp(key, (list) => {
            const by = new Map(these.map((s) => [s.id, s]));
            if (!by.size && !list.some((x) => gone.has(x.id))) return list;
            const next = list.flatMap((x) => (by.has(x.id) ? [by.get(x.id)!] : gone.has(x.id) ? [] : [x]));
            const have = new Set(list.map((x) => x.id));
            return orderSessions([...these.filter((s) => !have.has(s.id)), ...next]);
        });
    const archived = all.filter((s) => s.archived);
    const live = all.filter((s) => !s.archived);
    batch(() => {
        put("sessions", live, new Set(archived.map((s) => s.id)));
        put("archived", archived, new Set(live.map((s) => s.id)));
    });
    for (const s of all) if (s.id === app.activeId) markSeen(s.id, s.updatedAt);
}

/**
 * Sessions the server changed, put in at the next frame together (or a moment on, in a hidden window): 30 finishing in
 * the same second each worked the sidebar out again, 6 ms a time (headless), so the last showed done 400-700 ms late.
 */
const upsertsDue = new Map<string, SessionSummary>();
let upsertFrame: number | undefined;
let upsertTimer: ReturnType<typeof setTimeout> | undefined;
rpc.beforeAnswer = () => upsertsDue.size && upsertsFirst();
function upsertSoon(s: SessionSummary) {
    // Back, if it was deleted (an Undo): at once, as what's asked of it next goes by that.
    sessionPresent(s.id);
    upsertsDue.delete(s.id);
    upsertsDue.set(s.id, s);
    if (upsertTimer !== undefined) return;
    upsertTimer = setTimeout(upsertsFirst, 100);
    if (typeof requestAnimationFrame === "function") upsertFrame = requestAnimationFrame(upsertsFirst);
}
/** What's due goes in now (first, where what follows reads or changes the lists). */
export function upsertsFirst() {
    if (upsertFrame !== undefined) cancelAnimationFrame(upsertFrame);
    clearTimeout(upsertTimer);
    upsertFrame = upsertTimer = undefined;
    const due = [...upsertsDue.values()];
    upsertsDue.clear();
    upsertSessions(due);
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
            if (waitedOn(ev.ops)) flushSoon(h);
            else schedule(h);
            // A file named before it existed becomes a link once it may (an edit landed, or the turn ended).
            if (mayCreateFiles(ev.ops)) paths.forgetMissing(ev.sessionId);
            return;
        }
        case "sessions.upsert":
            upsertSoon(own(ev.session));
            return;
        case "sessions.remove":
            forgetSession(ev.id);
            return;
        case "session.reload":
            // A delete that failed closed it: a fresh snapshot into the same handle, so the view and draft stay.
            if (handles.has(ev.sessionId)) void openFresh(ev.sessionId).then(adopt, (e) => reopenFailed(ev.sessionId, e));
            return;
        case "draft":
            handles.get(ev.sessionId)?.addDraft({ text: ev.text, images: ev.images, files: ev.files, after: ev.after });
            return;
        case "toast":
            toast(ev.message, ev.level);
            return;
        case "limits":
            setApp("limits", planLimitKey(ev.limits.provider, ev.limits.accountId), reconcile(fromWireLimits(ev.limits)));
            return;
        case "keybindings.changed":
            keybindingsChanged(ev.keybindings);
            return;
        case "app.update":
            // In a window on a server, this computer's Cavvy says (lib/machines.ts): the server's has no app to update.
            if (!machine) setApp("update", reconcile(ev.info));
            return;
        case "models.changed":
            void refreshProviders().catch(() => undefined);
            // A fetch in flight gets the new list anyway.
            if (!app.modelsLoading) void refreshModels().catch(() => undefined);
            return;
        case "servers.changed":
            // An agent added or removed a server: the first one changes what this window shows (its sessions, where a new one runs).
            if (app.hello) setApp("hello", "servers", ev.count);
            if (ev.count) void serversUi().then((m) => m.connected());
            return;
        case "notify": {
            if (ev.kind === "background") return backgroundEnded(ev);
            if (!prefs.notifications) return;
            if (focused() && app.activeId === ev.sessionId) return;
            if (ev.kind === "done" && focused()) return;
            // In a window on a server the machine is named, as it is for sessions on machines no window is on.
            void notify(machine ? `${machine}: ${ev.title}` : ev.title, ev.body, () => void activate(ev.sessionId));
            return;
        }
    }
}

/** Background tasks whose end was told here (a toast or a notification), by tag: once each. */
const toldEnded = new Set<string>();

/** A background task ended on its own: a toast in its session's view, a desktop notification otherwise. */
function backgroundEnded(ev: Extract<ServerEvent, { type: "notify" }>) {
    const tag = ev.tag ?? `${ev.sessionId}:${ev.body}`;
    const route = noticeRoute({ focused: focused(), active: app.activeId === ev.sessionId, notifications: prefs.notifications, seen: toldEnded.has(tag) });
    if (route === "none") return;
    toldEnded.add(tag);
    const reveal = () => {
        void activate(ev.sessionId);
        revealBackground(ev.sessionId, ev.task?.id);
    };
    // The toast says what ended ("Background command finished"); which one is a click away, and in the notification.
    if (route === "toast") toast(ev.body.split(": ")[0]!, ev.task?.outcome === "failed" ? "warn" : ev.task?.outcome === "done" ? "success" : "info", { label: "Show", run: reveal });
    else desktopEnded(ev.sessionId, ev.title, ev.body, tag, reveal);
}

/** A session's task endings waiting a moment to go out as one desktop notification. */
const gathering = new Map<string, { title: string; bodies: string[]; tags: string[] }>();

/** A desktop notification for task endings: those close together (a burst) go as one, so they don't pile up. */
function desktopEnded(sessionId: string, title: string, body: string, tag: string, reveal: () => void) {
    let g = gathering.get(sessionId);
    if (!g) {
        const batch = (g = { title, bodies: [], tags: [] });
        gathering.set(sessionId, batch);
        setTimeout(() => {
            gathering.delete(sessionId);
            void notify(batch.title, combineEnded(batch.bodies), reveal, { tag: batch.tags.length === 1 ? batch.tags[0] : `background:${sessionId}` });
        }, COALESCE_MS);
    }
    g.bodies.push(body);
    g.tags.push(tag);
}

/** The side panel on a session's background work: on that task's tab, else Agents while a sub-agent runs, else Commands. */
export function revealBackground(sessionId = app.activeId, taskId?: string) {
    setAgentFocus(undefined);
    setPrefs("panel", true);
    const h = sessionId ? handleFor(sessionId) : undefined;
    if (!h) return;
    const tasks = backgroundOf(h.view.state);
    const task = taskId ? tasks.find((t) => t.id === taskId) : undefined;
    setInspectorPane(task ? tabOf(task) : workTabFor(tasks, h.view.agents));
}

/** How long the window waits for the first screen before it shows what there is (the splash, while the server starts). */
const SHOW_WINDOW_MS = 1000;

export function start() {
    setTimeout(showWindow, SHOW_WINDOW_MS);
    document.addEventListener("visibilitychange", () => {
        for (const t of toasts) pauseToast(t.id, "hidden", document.hidden);
        recheckUpdate();
    });
    window.addEventListener("focus", recheckUpdate);
    rpc.onSlow((slow) => setApp("slowRequest", slow));
    rpc.onEvent(onEvent);
    // The server's told what's on screen, so it can wake this window less for what isn't.
    const [hidden, setHidden] = createSignal(document.hidden);
    document.addEventListener("visibilitychange", () => setHidden(document.hidden));
    shownNow = () => (hidden() ? undefined : app.activeId);
    createRoot(() => createEffect(() => {
        shownNow();
        onScreen.beside();
        // Each connection that's open hears it, the window's own or not (tellShown checks each). Only on these changes:
        // not each time a row it looks a machine up in changes.
        void app.conn;
        untrack(tellShown);
    }));
    rpc.onState((s) => {
        if (s === "open") connectionVersion++;
        batch(() => {
            if (s !== "open") for (const h of handles.values()) if (!away.has(h.id)) h.setReady(false);
            setApp("conn", s);
        });
        // A screen that won't change by itself (a link that needs the terminal, a server that's gone) shows at once.
        if (s === "unauthorized" || s === "unavailable") showWindow();
        if (s !== "open") return;
        void (async () => {
            try {
                // To a server's Cavvy this window is a page like any other: what the desktop app lends its own Cavvy
                // (its browser, its folders) is this computer's, not the server's.
                setApp("hello", await rpc.call("hello", { client: isDesktop && !machine ? "desktop" : "browser" }));
                // After a reconnect, the sessions it had open, all at once, with the lists: each with only what it
                // missed while the connection was down when the server still has that (a round trip and those bytes),
                // else from a fresh snapshot. (Another machine's, opened here, are on a connection of their own.)
                const reopened = Promise.all([...handles.values()].filter((h) => !h.ready() && !away.has(h.id)).map(reopen));
                if (machine || app.hello?.servers) void serversUi().then((m) => m.connected());
                openAhead();
                const providers = refreshProviders();
                const lists = Promise.all([refreshSessions(), refreshProjects(), refreshSettings(), providers, refreshKeybindings().catch(() => undefined)]);
                // The models are asked for with the lists (the composer names its model from them, offers its efforts,
                // and a pick brought from another machine is checked against them), but after them, and not waited
                // for: the machine answers in the order it's asked, and the first screen waits for the lists (asked
                // for first, the models put 60 ms on a switch to a server).
                const models = refreshModels(false, providers).catch(() => undefined);
                await lists;
                // That pick is in the composer from the first screen, or not at all: the models are waited for, a moment.
                if (picked) await Promise.race([models, new Promise((r) => setTimeout(r, PICKED_WAIT_MS))]);
                picked = undefined;
                void refreshLimits().catch(() => undefined);
                // A server from before app.update.get has nothing to say: no update state, no button.
                void refreshUpdate().then(recheckUpdate, () => undefined);
                await reopened;
                await restoreActiveSession();
                // Path lookups that failed while it was down are asked again.
                paths.retryFailed();
            } catch (e) {
                // The start failed before the session asked for ahead was shown: the next try asks again.
                ahead = undefined;
                reportError(e);
            }
            // The first screen is drawn, with what it shows: the window comes up on it.
            showWindow();
        })();
    });
    void rpc.connect();
}

/** Sessions waiting on the user, for the window title. */
export function attentionCount(): number {
    return app.sessions.filter((s) => s.status === "waiting").length;
}
