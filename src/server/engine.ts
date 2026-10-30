// The GUI server's engine: every open session (each a Runtime), the projects
// they live in, and the requests the GUI makes. Several sessions can run at
// once, in different projects; each project gets its own settings, trust
// decision, MCP servers and file index, shared by its sessions.

import { noteScheduleIndex, readScheduleIndex } from "../agent/schedule-host";
import { ACCOUNT_PROVIDERS, account, accountProvider, cliAccounts, accountSharingWarning, addAccount, defaultAccount, holdLogin, listAccounts, removeAccount, renameAccount, setDefaultAccount, registerAccountRoots } from "../providers/accounts";
import { loginCommand } from "../backends/account-login";
import { redactedError } from "./git-handles";
import { sessionWorktree } from "./session-worktrees";
import { planLimitKey, type AccountInfo, type BackgroundTaskInfo } from "./protocol";
import { endedText } from "../agent/background";
import { mergeLimits } from "../backends/limits";
import { Terminals } from "./terminals";
import { deleteScript, findScript, findSetupScript, listScripts, markUsed, reorderScripts, saveScript } from "./scripts";
import { checkGrant, SetupTickets, setupTrusted } from "./setup";
import { RpcError } from "./rpc-error";
export { RpcError };
import { readdirSync, realpathSync, statSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { homedir, hostname, userInfo } from "os";
import { APP_VERSION, cavvyHome, paths } from "../config/paths";
import { LEGACY } from "../config/legacy";
import { JsonFileError, loadScope, loadSettings, readJson, updateSettings, writeJson, EFFORT_LEVELS, type Effort, type Settings } from "../config/settings";
import { isTrusted, projectConfigSummary, trustedByUser, trustFolder, trustForSession } from "../config/trust";
import { fireHooks } from "../agent/hooks";
import { findSessionAnywhere, heldSessionFolders, listAllSessions, Session, SessionInUseError, sessionFolder, sessionHolder } from "../agent/session";
import { forkSession } from "../agent/fork";
import { isFollowUp } from "../agent/queue-store";
import { loadCustomCommands, pluginCommandFor, type CustomCommand } from "../commands/custom";
import { loadSkills, sameSkills, type Skill } from "../agent/skills";
import { McpManager, SignInReplaced } from "../mcp/manager";
import { approvalMeaning, McpApprovalError, visible } from "../mcp/approval";
import { PERMISSION_MODES, type PermissionMode } from "../permissions/modes";
import { cachedListings, clientFor, defaultModelFrom, forgetClient, listAllModels, resolveModelInfo, type ProviderListing } from "../providers/models";
import { allProviders, getProvider, readAgentConfig, readVertexConfig, removeAgentConfig, saveAgentConfig, SEARCH_PROVIDERS } from "../providers/registry";
import { checkAgentPlan, vendorOf, type AgentCliStatus } from "../backends/index";
import { loadPlanLimits, savePlanLimits } from "./limits-store";
import { AppUpdates } from "./app-update";
import { findCli } from "../backends/cli";
import { AGENT_CLIS, agentCli } from "../backends/defs";
import { getKey, removeKey, setKey } from "../auth/credentials";
import { detectKeyProvider, validateKey } from "../auth/detect";
import { FileIndex } from "../ui/mentions";
import { gitRoot, gitBranch } from "../util/git";
import { createWorktreeWithHooks, currentBase, ignoredWaiting, listWorktrees, mainCheckoutOf, managedWorktreeOf, othersPresent, planRemoval, runRemoval, suggestBranch, unpushedReason, type Removal } from "./worktrees";
import { defaultPlanPath, implementPrompt, planTitle, slugify, writePlanFile } from "./plans";
import { billingOf, parseRunRequest, startRun, type RunHost, type RunRecord } from "./runs";
import { readRegular } from "./git-changes";
import { agentsByWorktree } from "./worktree-agents";
import { checkPathInput, confinePath, defaultDetectEnv, opensAsProject, detectEditor, editorArgv, editorById, EDITOR_IDS, EDITORS, MAX_COL, MAX_LINE, position, takesLines, type DetectEnv } from "./editors";
import { childEnv } from "../util/env";
import { expandPath, isInside, MAX_SHOWN_IMAGE, sniffImage } from "../util/files";
import { maskKey, redact } from "../util/redact";
import { searchResources } from "../mcp/mentions";
import { cleanTitle, modelSummary, promptTitle, Runtime } from "./runtime";
import { forkUiLog } from "./history";
import { CLI_SOURCES, findCliSession, listCliSessions, readCliTranscript, validCliId, type CliSource } from "./cli-sessions";
import { cavvyLinks, importModel, linkKey, writeImportedSession, type CavvyLinks } from "./cli-import";
import { CODEX_CLIENT_NAME } from "../backends/codex";
import { checkId, claimForDelete, locateSession, purgeTrash, restoreSession, trashSession, type SessionFlags } from "./session-delete";
import { searchSessions } from "./search";
import { usageDays, usageSummary } from "./usage";
import type {
    ArchiveOffer,
    ArchiveResult,
    BrowserState,
    SimulatorInput,
    SimulatorState,
    CliSessionInfo,
    CliSessionsList,
    CommandInfo,
    CreateWorktreeParams,
    CreateWorktreeResult,
    EditorInfo,
    EffortLevel,
    GuiSettings,
    HelloResult,
    KeybindingsFile,
    ImplementMode,
    ImplementPlanResult,
    McpListInfo,
    McpStatus,
    PlanLimits,
    Method,
    Methods,
    PermissionModeId,
    PlanInfo,
    ProjectInfo,
    RemoveWorktreeResult,
    ProviderInfo,
    ProviderModels,
    ServerEvent,
    RunMember,
    RunOutcome,
    SessionOp,
    SessionSnapshot,
    SessionSearchResult,
    SessionSummary,
    WorktreeInfo,
    PluginActionParams,
    PluginsInfo,
} from "./protocol";
import { ensureKeybindingsFile, keybindingsPath, readKeybindings, watchKeybindings } from "../keybindings/file";
import { listPlugins } from "../plugins/install";
import { pluginLogo } from "../plugins/logos";
import { runPluginCli } from "../plugins/cli";
import { pluginServerMatch } from "../plugins/loader";
import { withPluginCommands } from "../plugins/native";
import { IMPLEMENT_MODES, PROTOCOL_VERSION, SCRIPT_LIMITS } from "./protocol";
import { modelRef, type AttachedPart, type ImagePart } from "../providers/types";
import { checkFiles, checkMedia, toWire } from "./attachments";
import { BrowserError } from "../browser/page";
import { SimulatorError } from "../simulator/simctl";

export interface EngineOptions {
    /** --dangerously-skip-permissions: bypass mode may be chosen. */
    allowBypass?: boolean;
    /** The folder the server was started in. */
    startCwd?: string;
    /** Default model when settings don't name one (legacy MODEL in Cavvy .env). */
    fallbackModel?: string;
    /** Lists every provider's models (tests replace it). */
    listModels?: typeof listAllModels;
    /** How long a session no window shows waits to be closed once it has nothing to do (tests shorten it). */
    unloadAfterMs?: number;
    /** How long a window that went away has to come back to its terminals before they're stopped (tests shorten it). */
    terminalGraceMs?: number;
    /** The server's log (stderr), for details the GUI isn't shown. */
    log?: (message: string) => void;
    /** Where to look for editors (tests point it at fake launchers). */
    editorEnv?: () => DetectEnv;
    /** Starts an editor (tests record the argv instead). */
    launchEditor?: (argv: string[]) => Promise<void>;
}

/**
 * A CLI session in the list: one Cavvy holds is listed apart; one Cavvy's
 * sub-agents ran on is left out, as is a Codex thread started by Cavvy's
 * client that no session holds (sub-agent runs from before they were recorded).
 */
function sortCliSession(links: CavvyLinks, source: CliSource, id: string, originator: string | undefined): "new" | "held" | "hidden" {
    const k = linkKey(source, id);
    if (links.held.has(k)) return "held";
    if (links.subagent.has(k)) return "hidden";
    // Threads Cavvy started, or Harness did under its own name, are its own sessions already.
    if (source === "codex" && (originator === CODEX_CLIENT_NAME || originator === LEGACY.codexClient)) return "hidden";
    return "new";
}

/** A CLI session changed this recently may still be open in a terminal. */
const RECENT_CLI_MS = 2 * 60_000;

/** Long enough for a window that reloads (or reconnects) to open its sessions again. */
const UNLOAD_AFTER_MS = 30_000;
/** Deleted sessions older than a week are purged at start and this often. */
const PURGE_EVERY_MS = 60 * 60 * 1000;
/** How long opening a session waits for its model to be set up, so the snapshot has it (a slow provider's comes after). */
const OPEN_MODEL_WAIT_MS = 2_000;

export interface EngineClient {
    send(ev: ServerEvent): void;
    /** Sessions this client has open. */
    subs: Set<string>;
    /** The window's key, when its connection presented one: its terminals are the window's, not this connection's. */
    window?: string;
}


// ---------------------------------------------------------------------------
// The GUI's own state: recent projects, pinned, settled and archived sessions.

interface GuiStore {
    recent?: { path: string; at: number }[];
    pinned?: string[];
    archived?: string[];
    settled?: string[];
    /** Sessions started together from one prompt (runs.start), newest first. */
    runs?: RunRecord[];
}

/** Runs remembered; an older run's sessions are listed on their own. */
const MAX_RUNS = 50;

/** Each session's place in a run. */
function runMembers(store: GuiStore): Map<string, RunMember> {
    const out = new Map<string, RunMember>();
    for (const r of store.runs ?? []) for (const s of r.sessions) out.set(s.id, { id: r.id, label: r.label, cwd: r.cwd, model: s.model, modelName: s.modelName, ...(s.outcome ? { outcome: s.outcome === "working" ? "stopped" : s.outcome } : {}) });
    return out;
}

function runOutcome(rt: Runtime): RunOutcome {
    if (rt.status === "running" || rt.status === "waiting") return "working";
    return rt.lastTurnStatus === "done" ? "done" : "stopped";
}

const storeFile = () => join(cavvyHome(), "gui.json");
/** The store's lists of session ids. */
const STORE_FLAGS = ["pinned", "archived", "settled"] as const;

function readStore(): GuiStore {
    return readJson<GuiStore>(storeFile()) ?? {};
}

/** Best effort: false when it couldn't be saved. */
function updateStore(fn: (s: GuiStore) => void): boolean {
    const s = readStore();
    fn(s);
    try {
        writeJson(storeFile(), s, 0o600);
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------

const MAX_MCP_STATUS = 100;

/** A refusal from the MCP core, or a local settings file that can't be updated, is the client's to show. */
function mcpError(e: unknown): unknown {
    if (e instanceof McpApprovalError) return new RpcError(e.message, e.code);
    if (e instanceof JsonFileError) return new RpcError(e.message, "settings");
    return e;
}

export class Workspace {
    settings: Settings;
    mcp: McpManager;
    files: FileIndex;
    commands: CustomCommand[];
    skills: Skill[];
    private skillsReadAt = Date.now();

    constructor(
        private engine: Engine,
        readonly cwd: string,
        public trusted: boolean,
    ) {
        this.settings = loadSettings(cwd, { trusted });
        this.mcp = this.startMcp();
        this.files = new FileIndex(cwd);
        this.commands = loadCustomCommands(cwd, trusted);
        this.skills = loadSkills(cwd, trusted);
    }

    private startMcp(): McpManager {
        const mcp = new McpManager(this.cwd, () => this.settings, this.trusted, () => (this.settings = loadSettings(this.cwd, { trusted: this.trusted })), true);
        mcp.onChange = () => this.engine.workspaceChanged(this);
        mcp.load();
        void mcp.startAll();
        return mcp;
    }

    /** The skills, read again when the last read is a couple of seconds old, so a new SKILL.md shows up without a restart. */
    freshSkills(): Skill[] {
        if (Date.now() - this.skillsReadAt > 2000) {
            this.skills = sameSkills(this.skills, loadSkills(this.cwd, this.trusted));
            this.skillsReadAt = Date.now();
        }
        return this.skills;
    }

    reload() {
        this.settings = loadSettings(this.cwd, { trusted: this.trusted });
        this.commands = loadCustomCommands(this.cwd, this.trusted);
        this.skills = loadSkills(this.cwd, this.trusted);
        this.engine.workspaceChanged(this);
    }

    /** Trusted later on: project settings, servers and commands take effect. */
    async trust() {
        if (this.trusted) {
            // Trusted for this session only (it had nothing to protect when opened): now the user's word too, which
            // approving its .mcp.json servers needs, and enableAllProjectMcpServers looks for.
            await this.mcp.sync();
            this.engine.workspaceChanged(this);
            return;
        }
        this.trusted = true;
        const old = this.mcp;
        this.settings = loadSettings(this.cwd, { trusted: true });
        this.commands = loadCustomCommands(this.cwd, true);
        this.skills = loadSkills(this.cwd, true);
        this.mcp = this.startMcp();
        await old.closeAll().catch(() => undefined);
        this.engine.workspaceChanged(this);
    }

    /** For every session's state: no fingerprints, no configuration, bounded (session.mcp has the rest). */
    mcpStatus(): McpStatus[] {
        return [...this.mcp.servers.values()].slice(0, MAX_MCP_STATUS).map((s) => ({
            name: s.name,
            status: s.status,
            tools: s.tools.length,
            // No empty fields (they'd travel as null).
            ...((s.resources?.length ?? 0) + (s.templates?.length ?? 0) ? { resources: (s.resources?.length ?? 0) + (s.templates?.length ?? 0) } : {}),
            ...(s.prompts?.length ? { prompts: s.prompts.length } : {}),
            error: s.error ? visible(redact(s.error.split("\n")[0]!)).text.slice(0, 500) : undefined,
            source: s.source,
            // No fingerprint here; and no empty fields (they'd travel as null).
            approval: s.approval && { state: s.approval.state, ...(s.approval.reason ? { reason: s.approval.reason } : {}), ...(s.approval.viaAll ? { viaAll: true } : {}) },
        }));
    }

    /** The folder's servers for `rt`'s card and list: what approving means depends on the session's provider. */
    mcpList(rt: Runtime, name?: string): McpListInfo {
        let servers;
        let omitted = 0;
        if (name !== undefined) {
            const one = this.mcp.describe(name);
            if (!one) throw new RpcError(`There's no MCP server named "${name}" here.`, "unknown");
            servers = [one];
        } else ({ servers, omitted } = this.mcp.list());
        const userTrusted = trustedByUser(this.cwd);
        return { servers, omitted, trusted: this.trusted, userTrusted, savedIn: paths.localSettings(this.cwd), meaning: approvalMeaning(rt.model?.provider, userTrusted) };
    }

    /** Approving, rejecting and revoking need the folder trusted, whatever the client sends. */
    mustTrust() {
        if (!this.trusted) throw new RpcError("This folder isn't trusted, so its .mcp.json isn't read and its servers can't be approved. Trust the folder first.", "untrusted");
    }
}

// ---------------------------------------------------------------------------

/** A window's Rewind dialog holds off an idle compaction apart from its message box. */
const dialogs = new WeakMap<object, object>();
function dialogOf(client: object): object {
    let d = dialogs.get(client);
    if (!d) dialogs.set(client, (d = {}));
    return d;
}

export class Engine {
    private terminals: Terminals;
    /** Script lookup is asynchronous: a tab can close before its shell exists. */
    private openingTerminals = new Map<string, { window: string | EngineClient; cancelled: boolean }>();
    /** Setup runs that a window may start, once, in the worktree it just created (see setup.ts). */
    readonly setups = new SetupTickets();
    readonly clients = new Set<EngineClient>();
    readonly workspaces = new Map<string, Workspace>();
    readonly runtimes = new Map<string, Runtime>();
    /** Each window's latest search: an older one still reading stops. */
    private searches = new WeakMap<EngineClient, number>();
    listings: ProviderListing[] = cachedListings();
    readonly fallbackModel?: string;
    private refreshing?: Promise<ProviderListing[]>;
    /** Folders whose configuration the user chose not to trust (this run). */
    private declined = new Set<string>();
    private unloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /** Sessions being unloaded (their SessionEnd hooks running): opened again once that's done. */
    private closing = new Map<string, Promise<void>>();
    /** Their folders, meanwhile: hooks may still be running there. */
    private closingIn = new Map<string, string[]>();
    /** Worktrees being removed (real paths): no session opens in them meanwhile. */
    private removing = new Set<string>();
    /** File names of folders Home's @ searches before a session opens there (the last few, newest last). */
    private homeFiles = new Map<string, FileIndex>();
    /** Closing everything: no new work is taken on, as it would outlive the server. */
    private stopping = false;
    /** Sessions whose plan is being taken to a worktree, and sessions being archived with theirs: one at a time each. */
    private implementing = new Set<string>();
    private archiving = new Set<string>();
    private purgeTimer?: ReturnType<typeof setInterval>;
    /** The commands each agent CLI last said it runs itself, so a new session's first message can be one. */
    private cliCommandNames = new Map<string, Set<string>>();

    private readonly unregisterAccountRoots: () => void;
    private stopKeybindings?: () => void;
    /** The desktop app updating itself from main: only the installed app does. */
    private readonly updates = new AppUpdates({ emit: (info) => this.broadcast({ type: "app.update", info }) });

    constructor(private o: EngineOptions = {}) {
        this.fallbackModel = o.fallbackModel;
        this.terminals = new Terminals({ graceMs: o.terminalGraceMs });
        this.unregisterAccountRoots = registerAccountRoots(() => this.accountProjects());
    }

    log(msg: string) {
        this.o.log?.(redact(msg));
    }

    async start() {
        void this.firstListings();
        this.loadLimits();
        void this.checkPlans();
        // Every window applies a save of the keybindings file at once.
        this.stopKeybindings = watchKeybindings((r) => this.broadcast({ type: "keybindings.changed", keybindings: { path: keybindingsPath(), ...r } }));
        this.updates.start();
        this.reopenScheduled();
        purgeTrash();
        this.purgeTimer = setInterval(() => purgeTrash(), PURGE_EVERY_MS);
        this.purgeTimer.unref?.();
    }

    /**
     * Sessions with saved schedules are opened when the server starts, so
     * they run without a window on them. One that can't be (open in a
     * terminal, its folder gone, not trusted) waits until it's opened.
     */
    private reopenScheduled() {
        for (const [id, e] of Object.entries(readScheduleIndex())) {
            if (this.runtimes.has(id)) continue;
            try {
                if (!isDir(e.cwd) || !isTrusted(e.cwd)) continue;
                const rt = this.openSession(id);
                // Nothing to run after all (deleted since): let it go again.
                void rt.ready.then(() => this.unloadIfUnused(id), () => undefined);
            } catch (err) {
                const gone = err instanceof RpcError && err.code === "not_found";
                if (gone) noteScheduleIndex(id, e.cwd, false);
                this.log(`Schedules: couldn't reopen session ${id}: ${(err as Error).message}`);
            }
        }
    }

    async stop() {
        this.stopping = true;
        this.planChecks.abort();
        for (const pending of this.openingTerminals.values()) pending.cancelled = true;
        const terminalsStopped = this.terminals.stop();
        clearInterval(this.purgeTimer);
        this.stopKeybindings?.();
        this.updates.stop();
        for (const t of this.unloadTimers.values()) clearTimeout(t);
        this.unloadTimers.clear();
        await Promise.all([...this.runtimes.values()].map((r) => r.close().catch(() => undefined)).concat([...this.closing.values()]));
        await terminalsStopped;
        await Promise.race([Promise.all([...this.workspaces.values()].map((w) => w.mcp.closeAll().catch(() => undefined))), new Promise((r) => setTimeout(r, 1500))]);
        await Promise.race([this.checkingPlans, new Promise((r) => setTimeout(r, 1500))]);
        this.unregisterAccountRoots();
    }

    // -----------------------------------------------------------------------
    // Sending

    broadcast(ev: ServerEvent) {
        for (const c of this.clients) c.send(ev);
    }

    cliCommandsReported(provider: string, cwd: string, names: string[]) {
        this.cliCommandNames.set(`${provider}:${resolve(cwd)}`, new Set(names));
    }

    cliCommands(provider: string | undefined, cwd: string): ReadonlySet<string> | undefined {
        return provider ? this.cliCommandNames.get(`${provider}:${resolve(cwd)}`) : undefined;
    }

    /** The session's simulator changed: the windows that have it open hear of it. */
    sendSimulator(sessionId: string, state: SimulatorState) {
        for (const c of this.clients) if (c.subs.has(sessionId)) c.send({ type: "simulator.state", sessionId, state });
    }

    /** The session's browser changed: the windows that have it open hear of it. */
    sendBrowser(sessionId: string, state: BrowserState) {
        for (const c of this.clients) if (c.subs.has(sessionId)) c.send({ type: "browser.state", sessionId, state });
    }

    sendOps(sessionId: string, seq: number, ops: SessionOp[]) {
        for (const c of this.clients) if (c.subs.has(sessionId)) c.send({ type: "session.ops", sessionId, seq, ops });
    }

    /** `after`: it goes after what's typed in the composer, not before it. */
    draft(rt: Runtime, text: string, attachments?: AttachedPart[], after = false) {
        const back = toWire(attachments);
        for (const c of this.clients) if (c.subs.has(rt.id)) c.send({ type: "draft", sessionId: rt.id, text, ...back, ...(after ? { after: true as const } : {}) });
    }

    /** The session's name for a notification. */
    private notifyTitle(rt: Runtime): string {
        // One line cut at a word (as a title from the prompt is made), not the raw prompt with its
        // newlines. Redacted first: the title reaches every window and the OS notification center.
        const first = rt.firstPrompt();
        return rt.title ?? (first ? promptTitle(redact(first)) : undefined) ?? basename(rt.ws.cwd);
    }

    /**
     * A background task ended on its own (done, failed, stopped by something other than the user's Stop): a
     * toast in a window showing the session, a notification otherwise (the GUI decides, as for turns).
     * Tagged per task, so it's said once however many times it reaches a window.
     */
    notifyBackground(rt: Runtime, task: BackgroundTaskInfo) {
        const outcome = task.status === "done" ? "done" : task.status === "failed" ? "failed" : "stopped";
        this.broadcast({ type: "notify", sessionId: rt.id, kind: "background", title: this.notifyTitle(rt), body: endedText(task), tag: `background:${rt.id}:${task.id}:${task.startedAt}:${outcome}`, task: { id: task.id, outcome } });
    }

    notify(rt: Runtime, kind: "done" | "permission" | "question" | "plan" | "error", body: string) {
        const title = this.notifyTitle(rt);
        this.broadcast({ type: "notify", sessionId: rt.id, kind, title, body });
        this.sessionChanged(rt);
        const message = `Cavvy: ${body}`;
        void fireHooks(rt.settings(), "Notification", { session_id: rt.id, message, kind, notification_type: kind }, rt.ws.cwd, () => {});
    }

    sessionChanged(rt: Runtime) {
        if (!rt.session.messages.length && !rt.busy) return;
        const member = readStore().runs?.flatMap((r) => r.sessions).find((s) => s.id === rt.id);
        const outcome = runOutcome(rt);
        if (member && member.outcome !== outcome) updateStore((s) => {
            const saved = s.runs?.flatMap((r) => r.sessions).find((m) => m.id === rt.id);
            if (saved) saved.outcome = outcome;
        });
        this.broadcast({ type: "sessions.upsert", session: this.summaryOf(rt) });
    }

    workspaceChanged(ws: Workspace) {
        for (const r of this.runtimes.values()) if (r.ws === ws) r.workspaceChanged();
    }

    reloadSettings() {
        for (const ws of this.workspaces.values()) ws.reload();
    }

    // -----------------------------------------------------------------------
    // Plugins

    private pluginsInfo(cwd?: string): PluginsInfo {
        const dir = cwd ? resolve(cwd) : homedir();
        const trusted = cwd ? isTrusted(dir) : false;
        return { ...listPlugins(dir, trusted), cwd: cwd ? dir : undefined, trusted };
    }

    /** Plugin changes run one at a time: two updates of one marketplace mustn't swap its folder at once. */
    private pluginQueue: Promise<unknown> = Promise.resolve();

    private pluginAction(p: PluginActionParams): Promise<PluginsInfo & { message: string }> {
        const run = this.pluginQueue.then(() => this.runPluginAction(p));
        this.pluginQueue = run.catch(() => undefined);
        return run;
    }

    private async runPluginAction(p: PluginActionParams): Promise<PluginsInfo & { message: string }> {
        const cwd = typeof p.cwd === "string" && p.cwd ? resolve(p.cwd) : undefined;
        const dir = cwd ?? homedir();
        const trusted = cwd ? isTrusted(dir) : false;
        const scope = "scope" in p && p.scope !== undefined ? p.scope : undefined;
        if (scope !== undefined && scope !== "user" && scope !== "project" && scope !== "local") throw new RpcError("scope must be user, project or local", "invalid");
        if (scope && scope !== "user" && !cwd) throw new RpcError(`Open a project to use the ${scope} scope.`, "invalid");
        let argv: string[];
        switch (p.action) {
            case "install":
                argv = ["install", str(p.id, "id"), "--scope", scope ?? "user"];
                break;
            case "uninstall":
            case "enable":
            case "disable":
                argv = [p.action, str(p.id, "id"), ...(scope ? ["--scope", scope] : [])];
                break;
            case "update":
                argv = ["update", optStr(p.id) ?? "--all"];
                break;
            case "marketplaceAdd":
                argv = ["marketplace", "add", str(p.source, "source")];
                break;
            case "marketplaceRemove":
                argv = ["marketplace", "remove", str(p.name, "name")];
                break;
            case "marketplaceUpdate":
                argv = ["marketplace", "update", str(p.name, "name")];
                break;
            default:
                throw new RpcError(`Unknown plugin action ${String((p as { action?: unknown }).action)}`, "invalid");
        }
        const r = await runPluginCli(argv, dir, trusted);
        if (r.changed) {
            // Plugins change settings, commands and servers in every open folder.
            const restart = pluginServerMatch(r.restart);
            for (const ws of this.workspaces.values()) {
                ws.reload();
                void ws.mcp
                    .sync()
                    .then(() => restart && ws.mcp.restartWhere(restart))
                    .catch(() => undefined);
            }
            // What Claude Code listed predates the change: it runs the plugins' commands now enabled too.
            for (const [key, names] of this.cliCommandNames) {
                const ws = this.workspaces.get(key.slice(key.indexOf(":") + 1));
                if (ws) this.cliCommandNames.set(key, withPluginCommands(names, ws.commands));
            }
        }
        const message = r.lines.map((l) => l.trim()).filter(Boolean).join("\n");
        if (!r.ok) throw new RpcError(message || "That didn't work.", "plugin");
        return { ...this.pluginsInfo(cwd), message };
    }

    bypassAllowed(cwd: string): boolean {
        return Boolean(this.o.allowBypass) || Boolean(loadScope("user", cwd).permissions?.allowBypass);
    }

    // -----------------------------------------------------------------------
    // Models

    /** Listed at least once since the server started (an empty list is then really empty). */
    private listed = false;
    /** Last run's lists, read without asking any provider; whether they were shown before the fresh ones came. */
    private cachedListings?: Promise<boolean>;

    /**
     * Until the providers have answered, what was cached last time (of any
     * age), so the model picker doesn't wait for the slowest of them (a gcloud
     * that doesn't answer held it up for 30s). The fresh lists replace it.
     */
    private firstListings(): Promise<unknown> {
        const fresh = this.refreshListings();
        this.cachedListings ??= (this.o.listModels ?? listAllModels)({ cachedOnly: true }).then(
            (l) => {
                if (this.listed || !l.length) return this.listed;
                this.listings = l;
                return true;
            },
            () => false,
        );
        return Promise.race([this.cachedListings, fresh.then(() => true)]).then((shown): unknown => (shown ? undefined : fresh));
    }

    refreshListings(force = false): Promise<ProviderListing[]> {
        if (this.refreshing && !force) return this.refreshing;
        const p = (this.o.listModels ?? listAllModels)({ refresh: force })
            .then((l) => {
                const key = (x: ProviderListing[]) => JSON.stringify(x.map((y) => [y.provider.id, y.status, y.models.map((m) => [m.id, m.contextWindow, m.pricing?.input])]));
                const changed = key(l) !== key(this.listings);
                this.listings = l;
                this.listed = true;
                if (!changed) return l;
                for (const r of this.runtimes.values()) r.refreshModelInfo();
                this.broadcast({ type: "models.changed" });
                return l;
            })
            .catch(() => this.listings)
            .finally(() => {
                if (this.refreshing === p) this.refreshing = undefined;
            });
        this.refreshing = p;
        return p;
    }

    private modelsList(): Promise<ProviderModels[]> {
        return Promise.all(this.listings
            .filter((l) => l.status !== "offline")
            .map(async (l) => ({ provider: l.provider.id, providerName: l.provider.name, status: l.status, error: l.error ? redact(l.error) : undefined, billing: await billingOf(l.provider), models: l.models.map(modelSummary) })));
    }

    // -----------------------------------------------------------------------
    // Projects

    inspectProject(path: string): ProjectInfo {
        const p = resolve(expandHome(path));
        const exists = isDir(p);
        const trusted = exists && isTrusted(p);
        const found = exists ? projectConfigSummary(p) : [];
        const git = exists && Boolean(gitRoot(p));
        return {
            path: p,
            name: basename(p) || p,
            exists,
            trusted: trusted || (!found.length && exists),
            needsTrust: trusted || this.declined.has(p) ? [] : found,
            branch: git ? gitBranch(p) : undefined,
            git,
            openedAt: readStore().recent?.find((r) => r.path === p)?.at,
        };
    }

    async trustProject(path: string, trust: boolean): Promise<ProjectInfo> {
        const p = resolve(expandHome(path));
        if (!isDir(p)) throw new RpcError(`${p} isn't a folder`);
        if (trust) {
            this.declined.delete(p);
            try {
                trustFolder(p);
            } catch (e) {
                trustForSession(p);
                this.broadcast({ type: "toast", level: "warn", message: `Trusted for this run only. ${redact((e as Error).message)}` });
            }
            await this.workspaces.get(p)?.trust();
        } else this.declined.add(p);
        return this.inspectProject(p);
    }

    workspaceFor(cwd: string): Workspace {
        const p = resolve(cwd);
        if ([...this.removing].some((dir) => within(dir)(p))) throw new RpcError(`${p} is being removed.`, "busy");
        const existing = this.workspaces.get(p);
        if (existing) return existing;
        let trusted = isTrusted(p);
        const found = projectConfigSummary(p);
        if (!trusted && found.length && !this.declined.has(p)) {
            throw new RpcError(`${p} has configuration (${found.join(", ")}) that can run commands. Trust the folder, or open it without its configuration.`, "needs_trust");
        }
        if (!trusted && !found.length) {
            // Nothing to protect yet; rules the user adds later this run come from them.
            trustForSession(p);
            trusted = true;
        }
        const ws = new Workspace(this, p, trusted);
        this.workspaces.set(p, ws);
        return ws;
    }

    /**
     * The worktree at `path` was just created for `client`, which asked for its setup: may the setup script run
     * there? Never throws: the worktree is made either way, and the window says why the script didn't run.
     */
    private async grantSetup(client: EngineClient, path: string, preview: CreateWorktreeParams["setupScript"]): Promise<Pick<CreateWorktreeResult, "setup" | "setupError">> {
        try {
            const main = mainCheckoutOf(path);
            if (!setupTrusted(main, path)) return { setupError: "The setup script didn't run: you haven't trusted this repository." };
            const { project, script } = await findSetupScript(path);
            if (!script) return { setupError: "The setup script didn't run: no script is marked to run when a worktree is created (it may have changed in another window)." };
            if (!preview || script.id !== preview.id || script.command !== preview.command) {
                return { setupError: "The setup script didn't run: it no longer matches the script and command previewed when you clicked Create. Review it in the project scripts menu before running it." };
            }
            // Nobody would see it start.
            if (!this.clients.has(client)) return {};
            const ticket = this.setups.issue({ owner: client, path, main, project, script: script.id, command: script.command });
            return { setup: { ticket, script } };
        } catch (e) {
            return { setupError: `The setup script didn't run: ${redact((e as Error).message)}` };
        }
    }

    /**
     * Refused while a session is open inside it: one here (or still closing),
     * or one in another process (a terminal) once it holds its lock, or a
     * `cavvy -w` there that marked itself present before that. From the
     * check until Git is done no session can open there from this server,
     * nor can another removal of it start; its idle workspaces (picked while
     * their paths still resolve) close after.
     */
    private async removeWorktree(path: string, worktree: string, deleteIgnored?: string, check?: (plan: Removal) => Promise<void>): Promise<RemoveWorktreeResult> {
        const open = () => [...[...this.runtimes.values()].flatMap((rt) => rt.folders), ...[...this.closingIn.values()].flat(), ...heldSessionFolders()];
        // A terminal's `cavvy -w` is marked present there from its start, before it has a lock.
        const inUse = (dir: string) => othersPresent(dir) || open().some(within(dir));
        const plan = planRemoval({ path, worktree, inUse });
        const reserved = realPath(plan.path);
        if ([...this.removing].some((dir) => within(dir)(reserved) || within(reserved)(dir))) throw new RpcError(`${plan.path} is already being removed.`, "busy");
        this.removing.add(reserved);
        const idle = [...this.workspaces].filter(([cwd]) => within(plan.path)(cwd));
        let result: RemoveWorktreeResult;
        try {
            // Last checks of the caller's own, with the folder reserved: nothing can open there meanwhile.
            await check?.(plan);
            // Asked again just before Git removes it: one in another process may have opened there since.
            result = await runRemoval(plan, { deleteIgnored, inUse }, this.o.log);
        } finally {
            this.removing.delete(reserved);
        }
        if (!result.removed) return result;
        for (const [cwd, ws] of idle) {
            if (this.workspaces.get(cwd) !== ws || [...this.runtimes.values()].some((rt) => rt.ws === ws)) continue;
            this.workspaces.delete(cwd);
            void ws.mcp.closeAll().catch(() => undefined);
        }
        return result;
    }

    private recentProjects(): ProjectInfo[] {
        const seen = new Map<string, number>();
        for (const r of readStore().recent ?? []) seen.set(r.path, Math.max(seen.get(r.path) ?? 0, r.at));
        // Projects you've used from the terminal show up too.
        for (const s of listAllSessions(60)) if (!seen.has(s.cwd)) seen.set(s.cwd, s.updatedAt);
        return [...seen]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 16)
            .map(([path, at]) => ({ ...this.inspectProject(path), openedAt: at }))
            .filter((p) => p.exists);
    }

    private remember(path: string) {
        updateStore((s) => {
            s.recent = [{ path, at: Date.now() }, ...(s.recent ?? []).filter((r) => r.path !== path)].slice(0, 30);
        });
    }

    // -----------------------------------------------------------------------
    // Sessions

    summaryOf(rt: Runtime): SessionSummary {
        const store = readStore();
        const run = runMembers(store).get(rt.id);
        return {
            id: rt.id,
            cwd: rt.ws.cwd,
            projectName: basename(rt.ws.cwd) || rt.ws.cwd,
            title: rt.title ?? rt.firstPrompt()?.replace(/\s+/g, " ").slice(0, 120) ?? "New session",
            createdAt: rt.session.meta.createdAt,
            // Its file's time can be a moment later (a turn's end, saved once the turn is put away).
            updatedAt: Math.max(rt.lastActive, rt.session.workedAt ?? -Infinity),
            messages: rt.session.messages.length,
            status: rt.status,
            waitingKind: rt.waitingKind,
            turnStartedAt: rt.sidebarTurnStartedAt,
            pinned: (store.pinned ?? []).includes(rt.id),
            archived: (store.archived ?? []).includes(rt.id),
            settled: (store.settled ?? []).includes(rt.id),
            model: rt.session.model,
            live: true,
            run: run ? { ...run, outcome: runOutcome(rt) } : undefined,
        };
    }

    listSessions(limit = 200, archived = false): SessionSummary[] {
        const store = readStore();
        const pinned = new Set(store.pinned ?? []);
        const arch = new Set(store.archived ?? []);
        const settled = new Set(store.settled ?? []);
        const runs = runMembers(store);
        const out = new Map<string, SessionSummary>();
        for (const s of listAllSessions(limit + arch.size)) {
            out.set(s.id, { id: s.id, cwd: s.cwd, projectName: basename(s.cwd) || s.cwd, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, messages: s.messages, status: "idle", pinned: pinned.has(s.id), archived: arch.has(s.id), settled: settled.has(s.id), model: s.model, live: false, run: runs.get(s.id) });
        }
        for (const rt of this.runtimes.values()) {
            if (!rt.session.messages.length && !rt.busy) continue;
            // By when it last worked, which its file can't say yet while it works (Session.worked writes a line a minute).
            out.set(rt.id, this.summaryOf(rt));
        }
        return [...out.values()].filter((s) => s.archived === archived).sort((a, b) => b.updatedAt - a.updatedAt).filter((s, i) => i < limit || s.status === "waiting");
    }

    /** What was said in every session (archived ones marked), read from their files; see search.ts. */
    async searchSessions(client: EngineClient, query: string, limit = 50, archived?: boolean): Promise<SessionSearchResult> {
        if (query.length > 200) throw new RpcError("The search is longer than 200 characters.");
        const seq = (this.searches.get(client) ?? 0) + 1;
        this.searches.set(client, seq);
        if (query.trim().length < 2) return { hits: [], partial: false };
        const arch = new Set(readStore().archived ?? []);
        const r = await searchSessions(query, {
            limit: Math.max(1, Math.min(Math.floor(limit), 200)),
            include: archived === undefined ? undefined : (id) => arch.has(id) === archived,
            stale: () => this.searches.get(client) !== seq || this.stopping,
        });
        if (r.stale) return { hits: [], partial: true, stale: true };
        return {
            partial: r.partial,
            hits: r.hits.map((h) => ({
                id: h.id,
                title: redact(this.runtimes.get(h.id)?.title ?? h.title),
                cwd: h.cwd,
                projectName: basename(h.cwd) || h.cwd,
                archived: arch.has(h.id),
                seg: h.seg,
                index: h.index,
                role: h.role,
                snippet: h.snippet,
                ...(h.match ? { match: h.match } : {}),
                at: h.at,
            })),
        };
    }

    private defaultMode(ws: Workspace): PermissionMode {
        const m = ws.settings.permissions?.defaultMode ?? "default";
        // Bypass as a default only counts from the user's own settings file.
        if (m === "bypassPermissions" && loadScope("user", ws.cwd).permissions?.defaultMode !== "bypassPermissions") return "default";
        return m;
    }

    async createSession(cwd: string, opts: { model?: string; mode?: PermissionModeId; accounts?: Record<string, string> } = {}): Promise<Runtime> {
        const p = resolve(expandHome(cwd));
        if (!isDir(p)) throw new RpcError(`${p} isn't a folder`);
        const ws = this.workspaceFor(p);
        const session = Session.create(p);
        // Apply inherited selections before Runtime starts model setup; native threads stay fresh.
        for (const [provider, id] of Object.entries(opts.accounts ?? {})) session.setAccount(provider, id);
        const mode = opts.mode && PERMISSION_MODES.includes(opts.mode) ? opts.mode : this.defaultMode(ws);
        const rt = new Runtime(this, ws, session, { mode, resumed: false });
        this.runtimes.set(rt.id, rt);
        this.remember(p);
        await rt.ready.catch(() => undefined);
        if (opts.model) await rt.setModel(opts.model);
        return rt;
    }

    /** What a run (runs.ts) does through the engine. */
    private runHost(): RunHost {
        return {
            listings: async () => {
                if (!this.listed) await this.firstListings();
                return this.listings;
            },
            declined: (path) => this.declined.has(resolve(path)),
            decline: (path) => void this.declined.add(resolve(path)),
            bypassAllowed: (cwd) => this.bypassAllowed(cwd),
            stopping: () => this.stopping,
            openSession: (cwd, mode) => this.createSession(cwd, { mode }),
            discard: (id) => this.unloadIfUnused(id),
            release: (id) => this.unloadLater(id),
            record: (run) => {
                const saved = updateStore((s) => {
                    // A preceding model can finish while the next worktree is made.
                    const previous = s.runs?.find((r) => r.id === run.id);
                    const sessions = run.sessions.map((m) => previous?.sessions.find((p) => p.id === m.id) ?? m);
                    s.runs = [{ ...run, sessions }, ...(s.runs ?? []).filter((r) => r.id !== run.id)].slice(0, MAX_RUNS);
                });
                if (!saved) throw new RpcError("Cavvy couldn't save this run.");
            },
            log: this.o.log,
        };
    }

    /**
     * Fork an open session at the end of the turn of its prompt `index`
     * (src/agent/fork.ts), and open the fork with the original's model,
     * speed, mode and effort.
     */
    async forkSession(original: Runtime, index: unknown, text: string, turnId: string): Promise<Runtime> {
        const cut = original.forkPoint(index, text, turnId);
        // As they are now: the original may go on while the fork's model is set up.
        const notes = original.notesAt(cut);
        const effort = original.effort;
        let session: Session;
        try {
            session = forkSession(original.session, { cut, model: original.model && modelRef(original.model), title: original.title ?? original.firstPrompt(), shareBackends: !original.busy });
        } catch (e) {
            throw new RpcError(`Couldn't fork the session: ${redact((e as Error).message)}`);
        }
        forkUiLog({ file: original.session.path, id: original.id }, { file: session.path, id: session.meta.id });
        // Made now, by the person: it goes to the top of the sidebar, and stays there until something else works.
        session.worked(Date.now(), true);
        // The original's folder, already trusted to open it; bypass mode still needs allowing (the constructor checks).
        let rt: Runtime;
        try {
            rt = new Runtime(this, original.ws, session, { mode: original.mode, resumed: true });
        } catch (e) {
            session.release();
            throw e;
        }
        this.runtimes.set(rt.id, rt);
        await rt.ready.catch(() => undefined);
        if (effort) rt.setEffort(effort);
        rt.forkedFrom(notes);
        this.sessionChanged(rt);
        return rt;
    }

    /** Claude Code and Codex sessions that ran in this folder, newest first, marked when already in Cavvy. */
    cliSessionsList(cwd: string): CliSessionsList {
        const p = resolve(expandHome(cwd));
        if (!isDir(p)) throw new RpcError(`${p} isn't a folder`);
        const now = Date.now();
        const links = cavvyLinks(this.aliasesOf(p, []));
        const listings = CLI_SOURCES.map((source) => ({ source, ...listCliSessions(source, p, { sort: (id, originator) => sortCliSession(links, source, id, originator) }) }));
        const sessions: CliSessionInfo[] = listings
            .flatMap((l) => [...l.sessions, ...l.held])
            .map((s) => ({
                source: s.source,
                id: s.id,
                title: redact(s.title),
                startedAt: s.startedAt,
                updatedAt: s.updatedAt,
                messages: s.messages,
                partial: s.partial,
                ...(s.model ? { model: redact(s.model) } : {}),
                ...(links.held.has(linkKey(s.source, s.id)) ? { cavvyId: links.held.get(linkKey(s.source, s.id)) } : {}),
                recent: now - s.updatedAt < RECENT_CLI_MS,
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt);
        return {
            sources: listings.map((l) => ({ source: l.source, name: getProvider(l.source)?.name ?? l.source, enabled: Boolean(readAgentConfig(l.source)), more: l.more, moreInCavvy: l.moreHeld })),
            sessions,
        };
    }

    /**
     * Paths that are this folder, under which Cavvy may have kept its sessions:
     * as given, as the CLI sessions recorded it, and recent projects that are the
     * same folder by another path (/tmp and /private/tmp).
     */
    private aliasesOf(p: string, recorded: string[]): string[] {
        const real = (x: string) => {
            try {
                return realpathSync(x);
            } catch {
                return resolve(x);
            }
        };
        const target = real(p);
        const recent = (readStore().recent ?? []).map((r) => r.path).filter((x) => real(x) === target);
        return [...new Set([p, ...recorded, ...recent])];
    }

    private importing = new Map<string, Promise<Runtime>>();

    /**
     * A Cavvy session for a Claude Code or Codex session of this folder: the
     * one that already holds it, else a new one on the matching backend with
     * the conversation so far, opened. Two requests for the same one share the work.
     */
    async importCliSession(cwd: string, source: unknown, id: unknown): Promise<Runtime> {
        if (!CLI_SOURCES.includes(source as CliSource)) throw new RpcError("source must be claude-code or codex");
        if (!validCliId(id)) throw new RpcError("That isn't a Claude Code or Codex session id");
        const p = resolve(expandHome(cwd));
        if (!isDir(p)) throw new RpcError(`${p} isn't a folder`);
        const key = linkKey(source as CliSource, id);
        const running = this.importing.get(key);
        if (running) return running;
        const work = (async () => this.importNow(p, source as CliSource, id))();
        this.importing.set(key, work);
        try {
            return await work;
        } finally {
            this.importing.delete(key);
        }
    }

    private async importNow(p: string, source: CliSource, id: string): Promise<Runtime> {
        const name = getProvider(source)?.name ?? source;
        // Only a session a listing of this folder shows: no path is made from the id.
        const entry = findCliSession(source, p, id);
        if (!entry) throw new RpcError(`No ${name} session ${id} in ${p}`, "not_found");
        const links = cavvyLinks(this.aliasesOf(p, [entry.cwd]));
        // A run of Cavvy's own sub-agents isn't offered, so it isn't imported either.
        if (sortCliSession(links, source, entry.id, entry.originator) === "hidden") throw new RpcError(`No ${name} session ${id} in ${p}`, "not_found");
        const existing = links.held.get(linkKey(source, entry.id));
        if (existing) {
            while (this.closing.has(existing)) await this.afterClosing(existing);
            const rt = this.openSession(existing);
            await rt.ready.catch(() => undefined);
            return rt;
        }
        if (!readAgentConfig(source)) throw new RpcError(`Turn on ${name} in Settings → Providers`, "provider_off");
        // The folder it ran in, as this one names it (the listing matched them by real path): the
        // trust asked about and given is for this path, and the CLI, started here, sees the real one.
        const folder = p;
        // The trust check comes first: nothing is written for a folder that can't be opened.
        this.workspaceFor(folder);
        const transcript = readCliTranscript(entry);
        if (!transcript.turns.length) throw new RpcError(`That ${name} session has no messages to import`);
        const model = importModel(source, transcript.model ?? entry.model, this.listings);
        const sid = writeImportedSession({ cwd: folder, entry, transcript, model, title: cleanTitle(redact(entry.title)) });
        this.remember(folder);
        const rt = this.openSession(sid);
        await rt.ready.catch(() => undefined);
        return rt;
    }

    private loadSession(id: string): Session {
        const file = findSessionAnywhere(id);
        if (!file) throw new RpcError(`No session ${id}`, "not_found");
        try {
            return Session.load(file);
        } catch (e) {
            if (e instanceof SessionInUseError) throw new RpcError(e.message, "in_use");
            throw new RpcError(`Could not open the session: ${redact((e as Error).message)}`);
        }
    }

    openSession(id: string): Runtime {
        const live = this.runtimes.get(id);
        if (live) return live;
        const session = this.loadSession(id);
        let rt: Runtime;
        try {
            // Its worktree removed, say: its tools, shells and hooks would all fail there.
            if (!isDir(session.meta.cwd)) throw new RpcError(`This session's folder, ${session.meta.cwd}, no longer exists (if it was a worktree, it was removed; its branch is still in the repository). The conversation is saved, but it can't be opened without its folder.`, "folder_missing");
            const ws = this.workspaceFor(session.meta.cwd);
            rt = new Runtime(this, ws, session, { mode: this.defaultMode(ws), resumed: true });
        } catch (e) {
            // A folder still to be trusted, say: the terminal may open it meanwhile.
            session.release();
            throw e;
        }
        this.runtimes.set(rt.id, rt);
        return rt;
    }

    /**
     * A session no window shows is closed once it has nothing running or
     * waiting, as quitting a terminal would, so a terminal can resume it.
     * One still working is checked again later.
     */
    private unloadIfUnused(id: string) {
        const rt = this.runtimes.get(id);
        if (!rt || this.stopping || [...this.clients].some((c) => c.subs.has(id))) return;
        // A watch (a pull request) goes on with no window open: it wakes the session when there's news.
        if (!rt.idle || rt.scheduled || rt.watching) return this.unloadLater(id);
        void this.unload(rt);
    }

    /** Close a session as quitting a terminal would (its SessionEnd hooks run); it can be opened again once that's done. */
    private unload(rt: Runtime): Promise<void> {
        const id = rt.id;
        const timer = this.unloadTimers.get(id);
        if (timer) clearTimeout(timer);
        this.unloadTimers.delete(id);
        this.runtimes.delete(id);
        const done: Promise<void> = rt
            .close()
            .catch(() => undefined)
            .finally(() => {
                if (this.closing.get(id) === done) {
                    this.closing.delete(id);
                    this.closingIn.delete(id);
                }
            });
        this.closing.set(id, done);
        this.closingIn.set(id, rt.folders);
        return done;
    }

    private unloadLater(id: string) {
        if (this.stopping || this.unloadTimers.has(id)) return;
        const t = setTimeout(() => {
            this.unloadTimers.delete(id);
            this.unloadIfUnused(id);
        }, this.o.unloadAfterMs ?? UNLOAD_AFTER_MS);
        t.unref?.();
        this.unloadTimers.set(id, t);
    }

    /** A window went away (closed, reloading, or lost its connection). Its terminals wait a while for it to come back. */
    dropClient(client: EngineClient) {
        this.clients.delete(client);
        this.terminals.drop(client);
        for (const rt of this.runtimes.values()) rt.browser.unwatch(client);
        for (const rt of this.runtimes.values()) rt.simulator.unwatch(client);
        this.setups.drop(client);
        for (const rt of this.runtimes.values()) {
            rt.setDrafting(client, false);
            rt.setDrafting(dialogOf(client), false);
        }
        for (const id of client.subs) this.unloadLater(id);
    }

    /** The window shows the session from now on. If it went away while the session was being set up, it's closed later. */
    private watch(client: EngineClient, id: string) {
        client.subs.add(id);
        if (!this.clients.has(client)) this.unloadLater(id);
    }

    /**
     * Before opening a session that's being unloaded or deleted: once that's
     * done, if the server isn't stopping meanwhile. Callers loop on `closing`
     * (`while (this.closing.has(id)) await ...`) so they act in the same turn
     * they found nothing closing: returning from here leaves a gap in which a
     * delete can start.
     */
    private async afterClosing(id: string) {
        await this.closing.get(id);
        if (this.stopping) throw new RpcError("Cavvy server is stopping.", "stopping");
    }

    /**
     * Delete a session: its files go to the trash (session-delete.ts). One
     * that's working is left alone; one open here but idle is closed first.
     * Meanwhile opening or renaming it waits, as for one being unloaded, and
     * then finds nothing.
     */
    private async deleteSession(id: string) {
        // A model still being set up (as it opens) isn't work to refuse over: wait for it, a while.
        const until = Date.now() + 10_000;
        for (;;) {
            while (this.closing.has(id)) await this.afterClosing(id);
            const setup = this.runtimes.get(id)?.modelSetup;
            if (!setup || Date.now() >= until) break;
            await Promise.race([setup.catch(() => undefined), new Promise((r) => setTimeout(r, until - Date.now()).unref?.())]);
        }
        const rt = this.runtimes.get(id);
        // Only when one runs: otherwise the delete goes on in the same tick, as before.
        if (rt?.compactingWhileIdle) await rt.yieldIdleCompaction();
        if (rt && !rt.idle) throw new RpcError("This session is still working (a response, queued messages, a question, or shells or tasks running). Stop it first, then delete it.", "busy");
        const store = readStore();
        const flags: SessionFlags = { pinned: !!store.pinned?.includes(id), archived: !!store.archived?.includes(id), settled: !!store.settled?.includes(id) };
        // Held from before its runtime closes until it's in the trash, so a terminal can't take it in between.
        const release = claimForDelete(locateSession(id).file);
        const work = (async () => {
            try {
                if (rt) {
                    this.runtimes.delete(id);
                    clearTimeout(this.unloadTimers.get(id));
                    this.unloadTimers.delete(id);
                    await rt.close().catch(() => undefined);
                }
                trashSession(id, flags);
            } finally {
                release();
            }
        })();
        const done: Promise<void> = work
            .catch(() => undefined)
            .finally(() => {
                if (this.closing.get(id) === done) {
                    this.closing.delete(id);
                    this.closingIn.delete(id);
                }
            });
        this.closing.set(id, done);
        // As for one being unloaded: its SessionEnd hooks may run in its folder meanwhile.
        if (rt) this.closingIn.set(id, rt.folders);
        try {
            await work;
        } catch (e) {
            if (rt) {
                // Closed, but not deleted: windows that had it open it again, as it now is on disk.
                for (const c of this.clients) if (c.subs.delete(id)) c.send({ type: "session.reload", sessionId: id });
                const summary = this.listSessions(1000, flags.archived).find((s) => s.id === id);
                if (summary) this.broadcast({ type: "sessions.upsert", session: summary });
            }
            throw e;
        }
        for (const c of this.clients) c.subs.delete(id);
        updateStore((s) => {
            for (const key of STORE_FLAGS) if (s[key]) s[key] = s[key]!.filter((x) => x !== id);
        });
        this.broadcast({ type: "sessions.remove", id });
    }

    private runtime(id: unknown): Runtime {
        if (typeof id !== "string") throw new RpcError("Missing session id");
        const rt = this.runtimes.get(id);
        if (!rt) throw new RpcError("That session isn't open", "not_open");
        return rt;
    }

    /** Pin, set aside or archive (the GUI's own lists), and tell every window. */
    private setFlag(id: string, key: "pinned" | "settled" | "archived", on: boolean) {
        updateStore((s) => {
            const list = new Set(s[key] ?? []);
            if (on) list.add(id);
            else list.delete(id);
            s[key] = [...list];
        });
        const rt = this.runtimes.get(id);
        const summary = rt ? this.summaryOf(rt) : this.listSessions(1000, key === "archived" ? !on : false).find((s) => s.id === id) ?? this.listSessions(1000, true).find((s) => s.id === id);
        if (summary) this.broadcast({ type: "sessions.upsert", session: { ...summary, [key]: on } });
    }

    // -----------------------------------------------------------------------
    // Plans: saved as Markdown, or carried out in a new worktree

    private planOf(rt: Runtime, toolId?: string) {
        const plan = rt.planText(toolId);
        if (!plan) throw new RpcError(toolId ? "That plan isn't in this session." : "This session hasn't presented a plan.", "no_plan");
        return plan;
    }

    /** The mode a plan's new session starts in: never plan, which would only plan again. */
    private implementMode(rt: Runtime): { mode: ImplementMode; why: string } {
        const offered = (m: string | undefined): m is ImplementMode => IMPLEMENT_MODES.includes(m as ImplementMode);
        if (offered(rt.modeBeforePlan)) return { mode: rt.modeBeforePlan, why: "the mode this session was in before it started planning" };
        const preferred = this.defaultMode(rt.ws);
        if (offered(preferred)) return { mode: preferred, why: "your default mode" };
        return { mode: "default", why: preferred === "plan" ? "your default mode is Plan, which would only plan again" : "your default mode can't be chosen for a plan" };
    }

    private planInfo(rt: Runtime, toolId?: string): PlanInfo {
        const plan = this.planOf(rt, toolId);
        const title = planTitle(plan.text);
        const cwd = rt.ws.cwd;
        let git: PlanInfo["git"];
        let notGit: string | undefined;
        let worktrees: WorktreeInfo[] = [];
        try {
            worktrees = listWorktrees(cwd);
        } catch {
            notGit = `${cwd} isn't in a Git repository, so there's no worktree to make. Save the plan instead.`;
        }
        if (!notGit) {
            const main = worktrees.find((w) => w.main);
            const base = currentBase(cwd);
            if (!main) notGit = "This repository has no main worktree (it's bare), so there's nowhere to put a new one.";
            else if (!base) notGit = "This repository has no commit yet, so a worktree has nothing to start from.";
            else git = { main: main.path, base, branch: suggestBranch(cwd, slugify(title) || "plan") };
        }
        const { mode, why } = this.implementMode(rt);
        return { id: plan.id, plan: plan.text, title, pending: Boolean(plan.interactionId), cwd, git, notGit, mode, modeWhy: why, savePath: defaultPlanPath({ home: cavvyHome(), cwd, title }), home: cavvyHome() };
    }

    /** A managed worktree an earlier attempt made for the plan, checked again from Git's own records. */
    private madeWorktree(from: string, path: string, branch: string): { path: string; branch: string; commit?: string } {
        let all: WorktreeInfo[];
        try {
            all = listWorktrees(from);
        } catch {
            throw new RpcError("This folder isn't in a Git repository.", "not_git");
        }
        const w = all.find((x) => x.managed && x.exists && (resolve(x.path) === resolve(path) || realPath(x.path) === realPath(path)));
        if (!w || w.branch !== branch) throw new RpcError(`${path} isn't a worktree Cavvy made for ${branch} in this repository.`, "not_managed");
        return { path: w.path, branch, commit: w.head };
    }

    /**
     * Steps, each only once the one before it worked: a managed worktree on the
     * new branch (createWorktree, its trust checks unchanged); a session there
     * (workspaceFor, so a folder with configuration still asks for trust) with
     * the planning session's accounts, model, effort and speed; links both ways; the plan
     * as its first prompt; and last, the planning session's card answered so it
     * stops, still in plan mode. A worktree made for a session that then
     * couldn't start is kept and reported (`failed`): it may already hold the
     * user's work by the time they read it, and `resume` starts the session in it.
     */
    private async implementPlan(client: EngineClient, p: Record<string, any>): Promise<ImplementPlanResult> {
        const rt = this.runtime(text(p.id, "id", 200));
        const toolId = optText(p.toolId, "toolId", 200);
        const branch = text(p.branch, "branch", 200);
        const base = optText(p.base, "base", 200);
        const folder = optText(p.folder, "folder", 255);
        const resume = optText(p.resume, "resume", 4096);
        if (!IMPLEMENT_MODES.includes(p.mode)) throw new RpcError("Choose how the new session handles edits: auto-accept them, ask, or auto mode.", "invalid_mode");
        const mode = p.mode as ImplementMode;
        const plan = this.planOf(rt, toolId);
        const sourceModel = rt.model ? modelRef(rt.model) : rt.session.model;
        if (!sourceModel) throw new RpcError("Choose a model for the planning session before implementing its plan.", "no_model");
        if (this.implementing.has(rt.id)) throw new RpcError("This plan is already being taken to a worktree.", "busy");
        this.implementing.add(rt.id);
        try {
            const from = rt.ws.cwd;
            const made = resume ? this.madeWorktree(from, resume, branch) : await createWorktreeWithHooks({ path: from, branch, base, folder }, this.o.log);
            // The new session works where the planning one did, relative to its worktree.
            const top = gitRoot(from);
            const sub = top ? relative(realPath(top), realPath(from)) : "";
            // Only a real folder inside the worktree: a checked-out symlink could lead anywhere.
            const candidate = sub && sub !== ".." && !sub.startsWith(`..${sep}`) && !isAbsolute(sub) ? join(made.path, sub) : "";
            const there = candidate && isDir(candidate) && isInside(realPath(candidate), realPath(made.path)) ? candidate : made.path;
            const failed = (e: unknown, sessionId?: string): ImplementPlanResult => {
                const code = e instanceof RpcError ? e.code : undefined;
                const folder = code === "needs_trust" ? ((e as RpcError).folder ?? there) : undefined;
                return { path: made.path, branch: made.branch, sessionId, failed: { message: redact((e as Error).message), code, folder } };
            };
            let next: Runtime;
            try {
                const accounts = Object.fromEntries(ACCOUNT_PROVIDERS.map((provider) => [provider, rt.session.accountId(provider)]));
                next = await this.createSession(there, { mode, accounts });
            } catch (e) {
                return failed(e);
            }
            try {
                // Keep the runtime's id before model setup: a provider failure must identify
                // the session that already exists, so the user can open it instead of duplicating it.
                if (!(await next.setModel(sourceModel))) throw new RpcError("The planning session's model is unavailable in the new session. Choose an available model there before implementing the plan.", "model_unavailable");
                if (plan.interactionId && (this.runtimes.get(rt.id) !== rt || rt.planText(plan.id)?.interactionId !== plan.interactionId)) {
                    throw new RpcError("The planning session was interrupted or its plan was answered while the worktree was being created. The worktree and new session are kept, but implementation was not started.", "expired");
                }
                const effort = rt.settings().effort;
                if (effort && EFFORT_LEVELS.includes(effort)) next.setEffort(effort as EffortLevel);
                if (next.model?.supportsFastMode) next.setFastMode(rt.fastModeEnabled());
                const title = rt.title ?? rt.firstPrompt()?.replace(/\s+/g, " ").slice(0, 80);
                const named = base ?? currentBase(from) ?? made.commit?.slice(0, 12) ?? "HEAD";
                const link = { title, folder: from, path: made.path, branch: made.branch, base: named, at: Date.now(), plan: plan.id };
                next.addPlanLink({ role: "from", session: rt.id, ...link });
                rt.addPlanLink({ role: "to", session: next.id, ...link });
                this.watch(client, next.id);
                await next.send(implementPrompt({ plan: plan.text, title, sessionId: rt.id, from, fromRoot: top ?? from, path: made.path, branch: made.branch, base: named, commit: made.commit }));
            } catch (e) {
                return failed(e, next.id);
            }
            if (plan.interactionId) rt.handOffPlan(plan.interactionId, `It went to a new session (${next.id}) in a new Git worktree at ${made.path}, on branch ${made.branch}.`);
            return { path: made.path, branch: made.branch, sessionId: next.id };
        } finally {
            this.implementing.delete(rt.id);
        }
    }

    // -----------------------------------------------------------------------
    // Archiving a session in a managed worktree, and removing the worktree with it

    /** A session's folder, live or from its file, and the file (for whether another process has it open). */
    private sessionWhere(id: string): { cwd: string; file?: string } {
        const rt = this.runtimes.get(id);
        const file = findSessionAnywhere(id);
        if (rt) return { cwd: rt.ws.cwd, file };
        const cwd = file ? sessionFolder(file) : undefined;
        if (!cwd) throw new RpcError(`No session ${id}`, "not_found");
        return { cwd, file };
    }

    /**
     * Why archiving this session keeps its worktree, if it does. Another
     * session (in the sidebar, or open) working there keeps it; so do this one
     * still working or open elsewhere, a lock, and commits no remote branch has.
     * Changes in the worktree are Git's to refuse, at removal.
     */
    private async keepReason(client: EngineClient, id: string, file: string | undefined, cwd: string, wt: WorktreeInfo): Promise<{ reason: string; code: string } | undefined> {
        const rt = this.runtimes.get(id);
        if (rt && !rt.idle) return { reason: "This session is still working, or waiting for you. Stop it, or let it finish, to remove its worktree.", code: "running" };
        if ([...this.clients].some((c) => c !== client && c.subs.has(id))) return { reason: "This session is open in another window. Close it there to remove its worktree.", code: "open_elsewhere" };
        if (file && sessionHolder(file) !== undefined) return { reason: "This session is open in another Cavvy process (a terminal, say). Close it there to remove its worktree.", code: "open_elsewhere" };
        const inside = within(wt.path);
        const other = this.listSessions(Infinity).find((s) => s.id !== id && inside(s.cwd));
        if (other) return { reason: `“${other.title}” also works in this worktree, so it stays.`, code: "shared" };
        if ([...this.runtimes.values()].some((r) => r.id !== id && inside(r.ws.cwd))) return { reason: "Another open session works in this worktree, so it stays.", code: "shared" };
        if (wt.locked !== undefined) return { reason: `The worktree is locked${wt.locked ? ` (${wt.locked})` : ""}.`, code: "locked" };
        try {
            const why = await unpushedReason({ path: cwd, worktree: wt.path });
            return why ? { reason: why, code: "unpushed" } : undefined;
        } catch (e) {
            // The removal dialog must still offer its explicit Trust and remove action.
            if (e instanceof RpcError && e.code === "needs_trust") return undefined;
            return { reason: (e as Error).message, code: e instanceof RpcError && e.code ? e.code : "unchecked" };
        }
    }

    private async archiveOffer(client: EngineClient, id: string): Promise<ArchiveOffer> {
        const { cwd, file } = this.sessionWhere(id);
        const found = isDir(cwd) ? managedWorktreeOf(cwd) : undefined;
        if (!found) return { removable: false };
        const worktree = { path: found.worktree.path, branch: found.worktree.branch, main: found.main };
        const keep = await this.keepReason(client, id, file, cwd, found.worktree);
        return keep ? { worktree, removable: false, reason: keep.reason } : { worktree, removable: true };
    }

    /**
     * Archive, and remove the managed worktree the session works in with
     * PR 13's removal unchanged (no --force; the branch stays), plus a check
     * of its own: every commit is on a remote branch, checked right before Git
     * runs. Trust and ignored files need the user, so they come first and
     * nothing is done until they've answered; anything else that keeps the
     * worktree still archives the session, and says why. The session, open in
     * the window that asked, is closed properly first: removal refuses while
     * one is open there.
     */
    private async archiveAndRemove(client: EngineClient, id: string, deleteIgnored?: string): Promise<ArchiveResult> {
        if (this.archiving.has(id)) throw new RpcError("This session is already being archived.", "busy");
        this.archiving.add(id);
        try {
            const { cwd, file } = this.sessionWhere(id);
            const found = isDir(cwd) ? managedWorktreeOf(cwd) : undefined;
            if (!found) throw new RpcError("This session isn't in a worktree Cavvy manages, so there's no worktree to remove.", "not_managed");
            const wt = found.worktree.path;
            let closed = false;
            const done = (removed: boolean, kept?: string, code?: string): ArchiveResult => {
                this.setFlag(id, "archived", true);
                return { archived: true, removed, kept, code, worktree: wt, main: found.main, closed };
            };
            const keep = await this.keepReason(client, id, file, cwd, found.worktree);
            if (keep) return done(false, keep.reason, keep.code);
            const rt = this.runtimes.get(id);
            // As removal will see it, but with this session not counting yet: it's still open, and only closed once nothing needs asking.
            const others = [...[...this.runtimes.values()].filter((r) => r !== rt).flatMap((r) => r.folders), ...[...this.closingIn.values()].flat(), ...heldSessionFolders()];
            let plan: Removal;
            try {
                plan = planRemoval({ path: cwd, worktree: wt, inUse: (dir) => others.some(within(dir)) });
            } catch (e) {
                if (e instanceof RpcError && e.code !== "needs_trust") return done(false, e.message, e.code);
                throw e;
            }
            let waiting;
            try {
                waiting = await ignoredWaiting(plan, deleteIgnored, this.o.log);
            } catch (e) {
                if (e instanceof RpcError) return done(false, e.message, e.code);
                throw e;
            }
            if (waiting) return { archived: false, ignored: waiting.ignored, total: waiting.total, confirm: waiting.confirm };
            if (rt) {
                // Checked again now, after the awaits above: a turn started, or another window opened it, meanwhile.
                if (this.runtimes.get(id) !== rt || !rt.idle) return done(false, "This session started working again, so its worktree stays.", "running");
                if ([...this.clients].some((c) => c !== client && c.subs.has(id))) return done(false, "This session was opened in another window, so its worktree stays.", "open_elsewhere");
                client.subs.delete(id);
                closed = true;
                await this.unload(rt);
            }
            try {
                const r = await this.removeWorktree(cwd, wt, deleteIgnored, async () => {
                    const why = await unpushedReason({ path: cwd, worktree: wt });
                    if (why) throw new RpcError(why, "unpushed");
                    // Closing the runtime and checking Git both yield: another saved session may have
                    // been restored meanwhile. Check all sessions while new opens are reserved out.
                    const other = this.listSessions(Infinity).find((s) => s.id !== id && within(wt)(s.cwd));
                    if (other) throw new RpcError(`“${other.title}” also works in this worktree, so it stays.`, "shared");
                });
                if (!r.removed) return done(false, "Its ignored files changed while you were deciding, so it was kept. Remove it from the worktree picker to see them again.", "ignored_changed");
                return done(true);
            } catch (e) {
                if (e instanceof RpcError) return done(false, e.message, e.code);
                throw e;
            }
        } finally {
            this.archiving.delete(id);
        }
    }

    // -----------------------------------------------------------------------
    // Providers

    private limits = new Map<string, PlanLimits>();

    /** Never let a delayed report or a different account replace this account's meter. */
    limitsReported(limits: PlanLimits, partial: boolean) {
        const key = planLimitKey(limits.provider, limits.accountId);
        const prev = this.limits.get(key);
        if (prev && prev.at > limits.at) return;
        const merged = mergeLimits(prev, limits, partial);
        this.limits.set(key, merged);
        this.saveLimits();
        this.broadcast({ type: "limits", limits: merged });
    }

    /** The limits saved when the server last ran, for accounts that still exist; shown with their age until a newer report. */
    private loadLimits() {
        for (const l of loadPlanLimits()) {
            if (!(ACCOUNT_PROVIDERS as readonly string[]).includes(l.provider) || !listAccounts(l.provider).some((a) => a.id === (l.accountId ?? "default"))) continue;
            const key = planLimitKey(l.provider, l.accountId);
            const prev = this.limits.get(key);
            if (!prev || prev.at < l.at) this.limits.set(key, l);
        }
    }

    private saveLimits() {
        try {
            savePlanLimits([...this.limits.values()]);
        } catch (e) {
            this.log(`Couldn't save plan limits: ${(e as Error).message}`);
        }
    }

    private readonly planChecks = new AbortController();
    private checkingPlans: Promise<void> = Promise.resolve();

    /**
     * Without a turn: is each account of a CLI in use signed in, on what plan,
     * and, for Codex on a ChatGPT plan, where its limits stand (Claude Code says
     * only in a turn). At start; Settings' account checks and turning a CLI on
     * ask the same (accountsList, connectCli).
     */
    private checkPlans(): Promise<void> {
        const run = async () => {
            const checks = AGENT_CLIS.filter((d) => readAgentConfig(d.id) && findCli(d.id, d.cli))
                .flatMap((d) => cliAccounts(d.id).filter((a) => !a.invalid).map((a) => ({ provider: d.id, id: a.id })));
            const changed = await Promise.all(checks.map(async ({ provider, id }) => {
                if (this.stopping) return false;
                try {
                    const { status, limits } = await checkAgentPlan(provider, this.planChecks.signal, id);
                    if (this.stopping) return false;
                    if (limits) this.limitsReported(limits, false);
                    return this.noteStatus(provider, id, status);
                } catch {
                    // Left as it was: Settings asks again.
                    return false;
                }
            }));
            if (changed.some(Boolean) && !this.stopping) this.broadcast({ type: "models.changed" });
        };
        const p = this.checkingPlans.then(run, run).catch(() => undefined);
        this.checkingPlans = p;
        return p;
    }

    private accountStatus = new Map<string, Partial<AccountInfo>>();

    /** What the CLI said of an account's sign-in; true when that's news. */
    private noteStatus(provider: string, id: string, status: AgentCliStatus): boolean {
        const key = `${provider}:${id}`;
        const next: Partial<AccountInfo> = { signedIn: status.signedIn, description: status.description, email: status.email, plan: status.plan, apiKey: status.apiKey };
        if (JSON.stringify(next) === JSON.stringify(this.accountStatus.get(key))) return false;
        this.accountStatus.set(key, next);
        return true;
    }

    private accountProjects(): string[] {
        return [
            ...this.workspaces.keys(), ...this.terminals.projectRoots(),
            ...[...this.runtimes.values()].flatMap((rt) => rt.toolState?.cwd ?? []),
            ...(this.o.startCwd ? [this.o.startCwd] : []),
        ];
    }

    private async accountsList(provider: string, refresh = false): Promise<AccountInfo[]> {
        if (!agentCli(provider)) accountProvider(provider);
        return Promise.all(cliAccounts(provider).map(async (a) => {
            if (a.invalid) return { ...a, description: "Invalid account folder: use a non-empty absolute path with no '..'" };
            const key = `${provider}:${a.id}`;
            if (refresh) {
                try {
                    // Codex on a plan says where its limits stand from the same app-server.
                    const { status, limits } = await checkAgentPlan(provider, undefined, a.id);
                    this.noteStatus(provider, a.id, status);
                    if (limits) this.limitsReported(limits, false);
                } catch (e) {
                    this.accountStatus.set(key, { description: redact((e as Error).message).slice(0, 400) });
                }
            }
            const sharing = agentCli(provider)?.account ? accountSharingWarning(provider, a.id) : undefined;
            return { ...a, ...this.accountStatus.get(key), ...(sharing ? { sharing } : {}) };
        }));
    }

    private async providersList(): Promise<ProviderInfo[]> {
        const out: ProviderInfo[] = [];
        for (const p of allProviders()) {
            if (p.auth === "gcloud") {
                const v = readVertexConfig();
                out.push({ id: p.id, name: p.name, kind: p.kind, configured: Boolean(v), source: v ? "gcloud" : undefined, masked: v ? `${v.project} · ${v.location}` : undefined, requiresKey: false });
                continue;
            }
            if (p.auth === "cli") {
                // Only looks for the program; asking it whether it's signed in waits for "Use my plan".
                const def = agentCli(p.id)!;
                const cli = def.cli;
                const on = Boolean(readAgentConfig(p.id));
                out.push({
                    id: p.id,
                    name: p.name,
                    kind: p.kind,
                    configured: on,
                    source: on ? "your plan" : undefined,
                    keyUrl: p.keyUrl,
                    requiresKey: false,
                    agentCli: {
                        accounts: await this.accountsList(p.id),
                        defaultAccount: def.account ? defaultAccount(p.id) : "default",
                        installed: Boolean(findCli(p.id, cli)),
                        signIn: cli.signIn,
                        install: cli.install,
                        plan: def.planLabel,
                        multiAccount: Boolean(def.account),
                        planLimits: def.caps.planLimits !== "none",
                    },
                });
                continue;
            }
            if (!p.requiresKey) {
                out.push({ id: p.id, name: p.name, kind: p.kind, configured: true, source: "local", local: p.local, custom: p.custom, requiresKey: false });
                continue;
            }
            const k = await getKey(p.id);
            out.push({ id: p.id, name: p.name, kind: p.kind, configured: Boolean(k), source: k ? (k.source === "env" ? `$${k.envVar}` : k.source) : undefined, masked: k ? maskKey(k.value) : undefined, keyUrl: p.keyUrl, local: p.local, custom: p.custom, requiresKey: true });
        }
        for (const s of SEARCH_PROVIDERS) {
            const k = await getKey(s.id);
            out.push({ id: s.id, name: s.name, kind: "search", configured: Boolean(k), source: k ? (k.source === "env" ? `$${k.envVar}` : k.source) : undefined, masked: k ? maskKey(k.value) : undefined, keyUrl: s.keyUrl, search: true, requiresKey: true });
        }
        return out;
    }

    private async addKey(providerId: string | undefined, key: string): Promise<{ provider: string; masked: string; warning?: string; model?: string }> {
        const value = key.trim();
        if (!value) throw new RpcError("Paste a key first.");
        if (/\s/.test(value)) throw new RpcError("That doesn't look like a single key.");
        let id = providerId?.toLowerCase();
        if (id && !getProvider(id) && !SEARCH_PROVIDERS.some((s) => s.id === id)) throw new RpcError(`Unknown provider "${id}"`);
        if (!id) {
            const guesses = detectKeyProvider(value);
            if (guesses.length !== 1) throw new RpcError(guesses.length ? `The key could belong to ${guesses.map((g) => g.name ?? g.id).join(" or ")}; pick the provider.` : "Couldn't tell which provider this key is for; pick the provider.", "ambiguous");
            id = guesses[0]!.id;
        }
        const def = getProvider(id);
        let warning: string | undefined;
        if (def) {
            const r = await validateKey(def, value);
            if (!r.ok && r.definitive) throw new RpcError(`${def.name} rejected the key (${redact(r.reason)}). Nothing was saved.`);
            if (!r.ok) warning = `Couldn't verify the key (${redact(r.reason)}); saved anyway.`;
        }
        await setKey(id, value);
        forgetClient(id);
        const eff = await getKey(id);
        if (eff?.source === "env") warning = `$${eff.envVar} is set and takes precedence over the saved key.`;
        await this.afterKeyChange(id);
        return { provider: id, masked: maskKey(value), warning, model: this.adoptDefaultModel(id) };
    }

    /** `auth add claude-code|codex` for the GUI: the CLI says whether it's installed and signed in; nothing secret is saved. */
    private async connectCli(providerId: string): Promise<{ description: string; warning?: string; model?: string }> {
        const def = getProvider(providerId);
        if (def?.auth !== "cli") throw new RpcError(`${providerId} isn't used through a CLI`);
        const { status: st, limits } = await checkAgentPlan(def.id);
        if (!st.installed) throw new RpcError(`${def.name} isn't installed. ${st.installHint}, sign in with \`${st.signIn}\`, then try again.`, "not_installed");
        if (!st.signedIn) throw new RpcError(`${def.name} isn't signed in. Run \`${st.signIn}\` in a terminal (${vendorOf(def.id)}'s own sign-in), then try again.`, "not_signed_in");
        saveAgentConfig(def.id);
        forgetClient(def.id);
        await this.afterKeyChange(def.id);
        this.noteStatus(def.id, "default", st);
        if (limits) this.limitsReported(limits, false);
        return { description: st.description, warning: st.apiKey ? `${def.name} is signed in with an API key, so usage is billed to that key, not a subscription.` : undefined, model: this.adoptDefaultModel(def.id) };
    }

    /** As /login does: with no default model yet, the newly connected provider's best one becomes it. */
    private adoptDefaultModel(providerId: string): string | undefined {
        if (this.guiSettings(this.o.startCwd).model) return undefined;
        const listing = this.listings.find((l) => l.provider.id === providerId);
        const pick = defaultModelFrom(listing ? [listing] : []);
        if (!pick) return undefined;
        this.updateGuiSettings({ model: modelRef(pick) });
        return modelRef(pick);
    }

    private async afterKeyChange(id: string) {
        // A key can change who reviews: forget verdicts now, not after the listings (which can be slow).
        for (const r of this.runtimes.values()) r.classifier.clearCache();
        await this.refreshListings(true);
        await Promise.all([...this.runtimes.values()].map((r) => r.keyChanged(id).catch(() => undefined)));
    }

    // -----------------------------------------------------------------------
    // Settings

    private guiSettings(cwd?: string): GuiSettings {
        const s = loadScope("user", cwd ?? homedir());
        return {
            model: s.model,
            smallModel: s.smallModel,
            reviewModel: s.reviewModel,
            effort: s.effort,
            fastMode: s.fastMode,
            defaultMode: s.permissions?.defaultMode,
            showThinking: s.showThinking,
            autoCompact: s.autoCompact,
            idleCompaction: s.idleCompaction,
            webSearch: s.webSearch,
            browser: s.browser?.enabled,
            simulator: s.simulator?.enabled,
            allowBypass: s.permissions?.allowBypass,
            followUpBehavior: s.followUpBehavior,
            editor: s.editor,
        };
    }

    private updateGuiSettings(patch: GuiSettings): GuiSettings {
        const cwd = this.o.startCwd ?? homedir();
        updateSettings("user", cwd, (s) => {
            if ("model" in patch) s.model = patch.model || undefined;
            if ("smallModel" in patch) s.smallModel = patch.smallModel || undefined;
            if ("reviewModel" in patch) s.reviewModel = patch.reviewModel || undefined;
            if ("effort" in patch) s.effort = patch.effort && EFFORT_LEVELS.includes(patch.effort as Effort) ? (patch.effort as Effort) : undefined;
            if ("fastMode" in patch) {
                if (typeof patch.fastMode !== "boolean") throw new RpcError("fastMode must be a boolean");
                if (patch.fastMode && !resolveModelInfo(patch.model ?? s.model ?? "")?.supportsFastMode) throw new RpcError("Fast mode is not available for this model/backend");
                s.fastMode = patch.fastMode;
            }
            if ("showThinking" in patch) s.showThinking = Boolean(patch.showThinking);
            if ("autoCompact" in patch) s.autoCompact = patch.autoCompact !== false;
            if ("idleCompaction" in patch) s.idleCompaction = patch.idleCompaction === "always" ? "always" : patch.idleCompaction === false ? false : undefined;
            if ("webSearch" in patch && ["auto", "anthropic", "brave", "tavily", "duckduckgo", "off"].includes(String(patch.webSearch))) s.webSearch = patch.webSearch as Settings["webSearch"];
            if ("browser" in patch) {
                const { enabled: _, ...rest } = s.browser ?? {};
                s.browser = patch.browser === false ? { ...rest, enabled: false } : Object.keys(rest).length ? rest : undefined;
            }
            if ("simulator" in patch) s.simulator = patch.simulator === false ? { enabled: false } : undefined;
            if ("defaultMode" in patch || "allowBypass" in patch) {
                const perms = (s.permissions ??= {});
                if ("defaultMode" in patch) perms.defaultMode = patch.defaultMode && PERMISSION_MODES.includes(patch.defaultMode) ? patch.defaultMode : undefined;
                if ("allowBypass" in patch) perms.allowBypass = Boolean(patch.allowBypass) || undefined;
            }
            if ("followUpBehavior" in patch) {
                const v: unknown = patch.followUpBehavior;
                // null or "" clears it (the default, steer).
                if (v !== null && v !== "" && v !== undefined && !isFollowUp(v)) throw new RpcError("followUpBehavior must be steer or queue", "invalid");
                s.followUpBehavior = isFollowUp(v) ? v : undefined;
            }
            if ("editor" in patch) {
                if (patch.editor && !EDITOR_IDS.includes(patch.editor)) throw new RpcError("Unknown editor", "invalid");
                s.editor = patch.editor || undefined;
            }
        });
        this.reloadSettings();
        return this.guiSettings(cwd);
    }

    // -----------------------------------------------------------------------
    // Open in editor

    private editorsList(): { editors: EditorInfo[]; selected?: string } {
        const env = (this.o.editorEnv ?? defaultDetectEnv)();
        const editors = EDITORS.filter((d) => d.style !== "reveal" || env.platform === "darwin").map((d) => {
            const f = detectEditor(d, env);
            return { id: d.id, name: d.name, installed: Boolean(f), lines: Boolean(f && takesLines(f)) };
        });
        return { editors, selected: this.guiSettings().editor };
    }

    /**
     * The folder a path from the GUI is resolved against, and the roots it
     * must stay inside: a session's cwd plus its additionalDirectories, or a
     * project that's open in Cavvy. Any other folder is refused, so the GUI
     * can't widen the roots by naming one.
     */
    private openScope(p: Record<string, any>): { cwd: string; roots: string[] } {
        if (p.sessionId !== undefined) {
            const rt = this.runtime(p.sessionId);
            return { cwd: rt.ws.cwd, roots: rt.checker.workspaceRoots() };
        }
        const ws = this.workspaces.get(resolve(str(p.cwd, "cwd")));
        if (!ws) throw new RpcError("That folder isn't open in Cavvy", "not_open");
        const extra = ws.settings.permissions?.additionalDirectories ?? [];
        return { cwd: ws.cwd, roots: [ws.cwd, ...extra.map((d) => expandPath(d, ws.cwd))] };
    }

    private async openInEditor(p: Record<string, any>): Promise<{ editor: string }> {
        const id = optStr(p.editor) ?? this.guiSettings().editor;
        if (!id) throw new RpcError("Choose an editor in Settings → General → Open files with.", "no_editor");
        const def = editorById(id);
        if (!def) throw new RpcError("Unknown editor", "invalid");
        const env = (this.o.editorEnv ?? defaultDetectEnv)();
        if (env.platform === "win32") throw new RpcError("Opening files in an editor isn't supported on Windows yet.", "unsupported");
        const found = detectEditor(def, env);
        if (!found) throw new RpcError(`${def.name} isn't installed on this computer. Choose another editor in Settings → General.`, "not_installed");
        const line = position(p.line, "line", MAX_LINE);
        const col = position(p.col, "col", MAX_COL);
        const folder = p.folder === true;
        let { cwd, roots } = this.openScope(p);
        // A file a Git listing showed redacted: the server knows where it is; it's confined as any path is.
        let target: string;
        if (p.gitToken !== undefined) {
            const rt = this.runtime(str(p.sessionId, "sessionId"));
            const where = rt.gitHandles.where(p.gitToken);
            target = where.path;
            // Finder reveals a file of another worktree of the session's repository the Review pane listed, as the
            // window does for names it can see; an editor opens files in the session's folders only.
            if (def.style === "reveal" && where.root !== rt.ws.cwd) {
                const w = await sessionWorktree(rt.ws.cwd, where.root).catch(() => undefined);
                if (w && !w.current && w.real === where.root) ({ cwd, roots } = { cwd: w.real, roots: [w.real] });
            }
        } else target = str(p.path, "path");
        const named = p.gitToken !== undefined ? "That file" : p.path;
        let t: ReturnType<typeof confinePath>;
        try {
            t = confinePath(target, cwd, roots);
        } catch (e) {
            // Its messages name the path.
            throw p.gitToken !== undefined ? redactedError(e) : e;
        }
        if (folder && !t.dir) throw new RpcError(`${named} isn't a folder`, "invalid");
        if (!folder && t.dir && def.style !== "reveal") throw new RpcError(`${named} is a folder`, "invalid");
        // The real location, so a symlink in the path can't be swapped after the
        // check. (A file or folder replaced in the moment between the check and
        // the editor opening it isn't caught: that needs the editor to take an
        // open handle, which none of these launchers do.)
        const argv = editorArgv(found, { path: t.real, line, col, folder });
        await (this.o.launchEditor ?? launchEditor)(argv);
        return { editor: def.name };
    }

    private pathsExist(p: Record<string, any>): (string | null)[] {
        if (!Array.isArray(p.paths)) throw new RpcError("paths must be a list", "invalid");
        if (p.paths.length > 200) throw new RpcError("At most 200 paths at a time", "limit");
        const { cwd, roots } = this.openScope(p);
        // Not linked: what the chosen editor (any, before one is chosen) would open as a project.
        const chosen = this.guiSettings().editor;
        const def = chosen ? editorById(chosen) : undefined;
        return p.paths.map((raw: unknown) => {
            try {
                const t = confinePath(checkPathInput(raw), cwd, roots);
                // The real file decides, as in fs.open: a link named like a solution may be a text file, and the other way round.
                return t.dir || opensAsProject(def, t.real) ? null : t.path;
            } catch {
                return null;
            }
        });
    }

    /**
     * An image file a reply links to, anywhere on this machine (the model can
     * read any file already, and showing one sends nothing out; mockups often
     * live in /tmp). Relative paths are the session's. Judged by its bytes,
     * never an SVG (it can carry script), and read as a regular file to a
     * bound, so a FIFO named like an image can't block the server.
     */
    private async readImage(p: Record<string, any>): Promise<{ mediaType: string; data: string }> {
        const { cwd } = this.openScope(p);
        const path = checkPathInput(p.path);
        let real: string;
        let dir: boolean;
        try {
            real = realpathSync(expandPath(path, cwd));
            dir = statSync(real).isDirectory();
        } catch {
            throw new RpcError(`${p.path} doesn't exist`, "not_found");
        }
        if (dir) throw new RpcError(`${p.path} is a folder`, "invalid");
        const r = await readRegular(real, MAX_SHOWN_IMAGE);
        if (!r) throw new RpcError(`${p.path} isn't a regular file that can be read`, "not_image");
        if (!r.buf) throw new RpcError(`${p.path} is too large to show (images up to ${MAX_SHOWN_IMAGE / 1024 / 1024} MB)`, "limit");
        const bytes = r.buf;
        const mediaType = sniffImage(bytes);
        if (!mediaType) throw new RpcError(`${p.path} isn't a PNG, JPEG, GIF or WebP image`, "not_image");
        return { mediaType, data: bytes.toString("base64") };
    }

    private async commandProvider(cwd: string): Promise<string | undefined> {
        const usable = async (ref: string | undefined) => {
            const model = ref && resolveModelInfo(ref);
            if (!model) return undefined;
            try {
                await clientFor(model.provider);
                return model.provider;
            } catch {
                return undefined;
            }
        };
        // A new session falls back when its configured model is unavailable; Home must check that provider's commands.
        const settings = this.workspaces.get(cwd)?.settings ?? loadSettings(cwd, { trusted: isTrusted(cwd) });
        const provider = await usable(settings.model ?? this.fallbackModel);
        if (provider) return provider;
        const model = defaultModelFrom(this.listings) ?? defaultModelFrom(await this.refreshListings());
        return usable(model && modelRef(model));
    }

    private homeSkillCache = new Map<string, { at: number; skills: Skill[] }>();
    /** A project no session has open (Home's composer): its skills, read at most every couple of seconds. */
    private homeSkills(cwd: string): Skill[] {
        const hit = this.homeSkillCache.get(cwd);
        if (hit && Date.now() - hit.at < 2000) return hit.skills;
        const skills = loadSkills(cwd, isTrusted(cwd));
        if (this.homeSkillCache.size > 50) this.homeSkillCache.clear();
        this.homeSkillCache.set(cwd, { at: Date.now(), skills });
        return skills;
    }

    /** With `provider`, the commands that agent CLI runs itself too (those it last listed). */
    private commandsFor(cwd: string, provider?: string): CommandInfo[] {
        const builtin: CommandInfo[] = [
            { name: "compact", description: "Summarize the conversation to free up context", args: "[instructions]", noAttachments: true },
            { name: "init", description: "Create a CAVVY.md with notes about this codebase" },
            { name: "review", description: "Review the current changes (or a PR number) for bugs", args: "[pr|focus]" },
            { name: "goal", description: "Keep working until a condition holds (/goal clear stops)", args: "[condition]" },
            { name: "trust", description: "Trust this folder yourself (MCP approvals, diagnostics after edits)", noAttachments: true },
            { name: "model", description: "Switch the model" },
            { name: "mode", description: "Switch the permission mode" },
            { name: "rewind", description: "Go back to before an earlier prompt" },
            { name: "fork", description: "Continue in a new session from the latest response, keeping this one as it is" },
            { name: "mcp", description: "MCP servers: status, approval, reconnect", args: "[server]" },
            { name: "tasks", description: "Background work: sub-agents, shells, monitors and delegated tasks (/tasks stop stops them)", args: "[stop <task-id|all> | restart]" },
            { name: "rename", description: "Rename this session", args: "<title>" },
            { name: "new", description: "Start a new session in this project" },
            { name: "export", description: "Copy the conversation as markdown" },
            { name: "settings", description: "Open settings" },
            { name: "plugin", description: "Browse, install and manage plugins" },
            { name: "cost", description: "Tokens and cost by model, and your plan's limits" },
            { name: "context", description: "How full the context window is, and your plan's limits" },
            { name: "loop", description: "Run a prompt now and then every interval (default 10m); /loop stop stops it", args: "[interval] <prompt>", noAttachments: true },
            { name: "schedules", description: "This session's schedules (pause, run or delete them above the message box)", args: "[pause|resume|delete|run <id>]", noAttachments: true },
        ];
        const ws = this.workspaces.get(resolve(cwd));
        // Before a session opens the project, its commands are read from disk (the home screen checks a /word against them).
        const custom = (ws?.commands ?? loadCustomCommands(resolve(cwd), isTrusted(resolve(cwd)))).map((c) => ({ name: c.name, description: c.description || `Custom command (${c.source})`, args: c.argumentHint, custom: true }));
        const taken = new Set([...builtin, ...custom].map((c) => c.name));
        const skills = (ws?.freshSkills() ?? this.homeSkills(resolve(cwd)))
            .filter((s) => s.userInvocable && !taken.has(s.name))
            .map((s) => ({ name: s.name, description: s.description, args: s.argumentHint, skill: true }));
        // Connected MCP servers' prompts (mcp__server__prompt), once a session has the project open.
        const named = new Set([...taken, ...skills.map((s) => s.name)]);
        const prompts = (ws?.mcp.promptCommands() ?? []).filter((p) => !named.has(p.command)).map((p) => ({ name: p.command, description: p.description, ...(p.args ? { args: p.args } : {}) }));
        const own = new Set([...named, ...prompts.map((p) => p.name)]);
        const name = provider ? (getProvider(provider)?.name ?? provider) : "";
        // All Codex reports are its skills (skills/list), for the $ menu too.
        const skill = provider === "codex";
        const cli = [...(this.cliCommands(provider, cwd) ?? [])].filter((n) => !own.has(n)).map((n) => ({ name: n, description: `${name}'s own ${skill ? "skill" : "command"}`, ...(skill ? { skill } : {}) }));
        return [...builtin, ...custom, ...skills, ...prompts, ...cli];
    }

    // -----------------------------------------------------------------------
    // Requests

    async handle<M extends Method>(client: EngineClient, method: M, raw: unknown): Promise<Methods[M]["result"]> {
        if (this.stopping) throw new RpcError("Cavvy server is stopping.", "stopping");
        const p = (raw ?? {}) as Record<string, any>;
        const r = await this.dispatch(client, method, p);
        return r as Methods[M]["result"];
    }

    private async dispatch(client: EngineClient, method: Method, p: Record<string, any>): Promise<unknown> {
        switch (method) {
            case "terminal.open":
                if (!this.clients.has(client)) throw new RpcError("Disconnected", "disconnected");
                if (p.login !== undefined) {
                    if (!p.login || typeof p.login !== "object") throw new RpcError("Invalid login selector", "invalid");
                    const provider = str(p.login.provider, "provider");
                    const accountId = str(p.login.accountId, "accountId");
                    // Seen by removals in other Cavvy processes too, until the login process exits.
                    const release = holdLogin(provider, accountId);
                    try {
                        const command = loginCommand(provider, accountId);
                        return this.terminals.open(client, str(p.id, "id"), homedir(), p.cols, p.rows, { command, login: { provider, accountId, name: account(provider, accountId).name }, onExit: () => { release(); void this.accountsList(provider, true).then(() => this.refreshListings(true)).then(() => this.broadcast({ type: "models.changed" })).catch(() => undefined); } });
                    } catch (e) {
                        release();
                        throw e;
                    }
                }
                return this.terminals.open(client, str(p.id, "id"), str(p.cwd, "cwd"), p.cols, p.rows);
            case "terminal.write":
                this.terminals.write(client, str(p.id, "id"), str(p.data, "data"));
                return null;
            case "terminal.ack":
                this.terminals.ack(client, str(p.id, "id"), p.chars);
                return null;
            case "terminal.resize":
                this.terminals.resize(client, str(p.id, "id"), p.cols, p.rows);
                return null;
            case "terminal.close": {
                const id = str(p.id, "id");
                const pending = this.openingTerminals.get(id);
                const cancelled = pending?.window === (client.window ?? client);
                if (cancelled) pending!.cancelled = true;
                try { this.terminals.close(client, id); }
                catch (e) {
                    if (!cancelled || !(e instanceof RpcError && e.code === "terminal_not_open")) throw e;
                }
                return null;
            }
            case "simulator.state":
                return await simulatorCall(() => this.runtime(p.id).simulator.refresh());
            case "simulator.watch": {
                const rt = this.runtime(p.id);
                const side = typeof p.side === "number" && Number.isFinite(p.side) ? p.side : undefined;
                return await simulatorCall(() => rt.simulator.watch(client, (f, frameId) => client.send({ type: "simulator.frame", sessionId: rt.id, frameId, data: f.data, width: f.width, height: f.height }), side));
            }
            case "simulator.unwatch":
                this.runtimes.get(str(p.id, "id"))?.simulator.unwatch(client);
                return null;
            case "simulator.ack":
                this.runtimes.get(str(p.id, "id"))?.simulator.ack(client, str(p.frameId, "frameId"));
                return null;
            case "simulator.input": {
                const input = parseSimulatorInput(p.input);
                if (!input) throw new RpcError("Bad simulator input");
                await simulatorCall(() => this.runtime(p.id).simulator.input(input));
                return null;
            }
            case "simulator.command": {
                const command = str(p.command, "command");
                if (command !== "select" && command !== "boot" && command !== "shutdown" && command !== "take_control") throw new RpcError("Unknown simulator command");
                return await simulatorCall(() => this.runtime(p.id).simulator.command(command, typeof p.udid === "string" ? p.udid : undefined));
            }
            case "browser.state":
                return this.runtime(p.id).browser.state();
            case "browser.watch": {
                const rt = this.runtime(p.id);
                // The pane's size, its scale: the page is sized to it.
                let shownTab: number | undefined;
                rt.browser.watch(client, (f, frameId) => {
                    // The first picture can beat the debounced tab announcement. Publish its tab first.
                    if (shownTab !== f.tab) {
                        shownTab = f.tab;
                        client.send({ type: "browser.state", sessionId: rt.id, state: rt.browser.state() });
                    }
                    client.send({ type: "browser.frame", sessionId: rt.id, frameId, tab: f.tab, data: f.data, width: f.width, height: f.height });
                }, { width: num(p.width, 0), height: num(p.height, 0), scale: num(p.scale, 1) });
                return rt.browser.state();
            }
            case "browser.unwatch":
                this.runtimes.get(str(p.id, "id"))?.browser.unwatch(client);
                return null;
            case "browser.ack":
                this.runtimes.get(str(p.id, "id"))?.browser.ack(client, str(p.frameId, "frameId"));
                return null;
            case "browser.input":
                await this.runtime(p.id).browser.input(p.input, typeof p.tab === "number" ? p.tab : undefined);
                return null;
            case "browser.command": {
                const rt = this.runtime(p.id);
                await browserCall(() => rt.browser.command({ command: str(p.command, "command"), url: typeof p.url === "string" ? p.url : undefined, tab: typeof p.tab === "number" ? p.tab : undefined }));
                return rt.browser.state();
            }
            case "browser.dialog":
                if (typeof p.accept !== "boolean") throw new RpcError("accept must be a boolean");
                await browserCall(() => this.runtime(p.id).browser.answerDialog(p.accept, typeof p.text === "string" ? p.text : undefined, typeof p.tab === "number" ? p.tab : undefined));
                return null;
            case "terminal.arm":
                this.terminals.arm(client, str(p.id, "id"));
                return null;
            case "terminal.list":
                return this.terminals.list(client);
            case "terminal.attach":
                if (!this.clients.has(client)) throw new RpcError("Disconnected", "disconnected");
                return this.terminals.attach(client, str(p.id, "id"), p.have);
            case "scripts.list":
                return await listScripts(p.cwd);
            case "scripts.save": {
                const { project, script } = await saveScript(p.cwd, { id: p.id, name: p.name, command: p.command, icon: p.icon, runOnWorktreeCreate: p.runOnWorktreeCreate });
                this.broadcast({ type: "scripts.changed", project });
                return script;
            }
            case "scripts.delete": {
                const { project } = await deleteScript(p.cwd, p.id);
                this.broadcast({ type: "scripts.changed", project });
                return null;
            }
            case "scripts.reorder": {
                const list = await reorderScripts(p.cwd, p.ids);
                this.broadcast({ type: "scripts.changed", project: list.project });
                return list;
            }
            case "scripts.run": {
                // Only ever from a click in the GUI: the stored command, typed into a terminal the window can see and stop.
                // Or, with `setup`, the setup script, once, in the worktree this window just created (see setup.ts).
                if (!this.clients.has(client)) throw new RpcError("Disconnected", "disconnected");
                const grant = p.setup === undefined ? undefined : this.setups.take(client, p.setup);
                const id = str(p.id, "id");
                if (!/^[a-zA-Z0-9-]{1,80}$/.test(id) || this.openingTerminals.has(id)) throw new RpcError("Invalid or duplicate terminal id", "invalid");
                const pending = { window: client.window ?? client, cancelled: false };
                this.openingTerminals.set(id, pending);
                try {
                    const cwd = str(p.cwd, "cwd");
                    const found = await findScript(cwd, p.script);
                    const { project, script } = found;
                    // A close from the reloaded window also cancels this old connection's pending lookup.
                    if (pending.cancelled) throw new RpcError("That terminal was closed", "terminal_not_open");
                    if (!this.clients.has(client)) throw new RpcError("Disconnected", "disconnected");
                    if (grant) checkGrant(grant, cwd, found);
                    const opened = this.terminals.open(client, id, grant ? grant.path : cwd, p.cols, p.rows, { input: `${script.command}\r`, script: { id: script.id, name: script.name } });
                    // A setup run must not change the header button's last-used script.
                    if (!grant) void markUsed(project, script.id).then(() => this.broadcast({ type: "scripts.changed", project }), () => undefined);
                    return { ...opened, script };
                } finally { this.openingTerminals.delete(id); }
            }
            case "scripts.setupInfo": {
                if (typeof p.cwd !== "string") throw new RpcError("cwd must be a string", "invalid");
                const cwd = resolve(expandHome(text(p.cwd, "cwd", 4096)));
                const main = mainCheckoutOf(cwd);
                const { script } = await findSetupScript(cwd);
                return { main, ...(script ? { script } : {}), trusted: setupTrusted(main, main) };
            }
            case "hello": {
                const startCwd = this.o.startCwd && this.o.startCwd !== homedir() ? this.o.startCwd : undefined;
                let user = "";
                try {
                    user = userInfo().username;
                } catch {
                    user = process.env.USER ?? "";
                }
                return { version: APP_VERSION, protocol: PROTOCOL_VERSION, home: cavvyHome(), platform: process.platform, homeDir: homedir(), user, host: hostname().replace(/\.local$/, ""), startCwd } satisfies HelloResult;
            }
            case "keybindings.get":
                return { path: keybindingsPath(), ...readKeybindings() } satisfies KeybindingsFile;
            case "keybindings.create": {
                const path = keybindingsPath();
                return { created: ensureKeybindingsFile(path), path };
            }
            case "sessions.list":
                return this.listSessions(num(p.limit, 200), Boolean(p.archived));
            case "sessions.search":
                // Awaited: it can reject before its first await (see providers.setKey below).
                return await this.searchSessions(client, str(p.query, "query"), num(p.limit, 50), typeof p.archived === "boolean" ? p.archived : undefined);
            case "session.create": {
                const rt = await this.createSession(str(p.cwd, "cwd"), { model: optStr(p.model), mode: p.mode });
                this.watch(client, rt.id);
                return rt.snapshot() satisfies SessionSnapshot;
            }
            case "session.open": {
                const id = str(p.id, "id");
                while (this.closing.has(id)) await this.afterClosing(id);
                const loaded = this.runtimes.has(id);
                const rt = this.openSession(id);
                this.watch(client, rt.id);
                if (!loaded) {
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    await Promise.race([rt.ready.catch(() => undefined), new Promise((r) => (timer = setTimeout(r, OPEN_MODEL_WAIT_MS)))]);
                    clearTimeout(timer);
                }
                // Search can open a session beyond the sidebar list window.
                client.send({ type: "sessions.upsert", session: this.summaryOf(rt) });
                return rt.snapshot();
            }
            case "cliSessions.list":
                return this.cliSessionsList(str(p.cwd, "cwd"));
            case "cliSessions.import": {
                const rt = await this.importCliSession(str(p.cwd, "cwd"), p.source, p.id);
                this.watch(client, rt.id);
                return rt.snapshot() satisfies SessionSnapshot;
            }
            case "session.close": {
                const id = str(p.id, "id");
                client.subs.delete(id);
                this.runtimes.get(id)?.browser.unwatch(client);
                this.runtimes.get(id)?.simulator.unwatch(client);
                this.unloadIfUnused(id);
                return null;
            }
            case "session.send": {
                const rt = this.runtime(p.id);
                const images = Array.isArray(p.images) ? (p.images as { mediaType: unknown; data: unknown }[]).map((i): ImagePart => {
                    if (!validImage(i)) throw new RpcError("Images must be PNG, JPEG, GIF or WebP, under 15 MB.");
                    return { type: "image", mediaType: String(i.mediaType), data: String(i.data) };
                }) : [];
                const attached: AttachedPart[] = [...images, ...checkFiles(p.files)];
                checkMedia(attached);
                this.remember(rt.ws.cwd);
                // Set aside, it's back in play once you send to it.
                if ((readStore().settled ?? []).includes(rt.id)) {
                    updateStore((s) => {
                        s.settled = (s.settled ?? []).filter((x) => x !== rt.id);
                    });
                    this.sessionChanged(rt);
                }
                if (p.mode !== undefined && !isFollowUp(p.mode)) throw new RpcError("mode must be steer or queue", "invalid");
                return await rt.send(str(p.text ?? "", "text"), attached.length ? attached : undefined, p.literal === true, p.mode);
            }
            case "session.interrupt":
                this.runtime(p.id).interrupt();
                return null;
            case "session.respond":
                if (this.implementing.has(p.id)) throw new RpcError("This plan is being taken to a worktree. Wait for that to finish before answering it.", "busy");
                this.runtime(p.id).respond(str(p.interactionId, "interactionId"), p.response);
                return null;
            case "session.setModel": {
                const rt = this.runtime(p.id);
                if (rt.compactingWhileIdle) await rt.yieldIdleCompaction();
                // As in the terminal: the turn in progress keeps its model (Claude Code and Codex can't take over half way).
                if (rt.busy) throw new RpcError("Switch models once this response is done, or interrupt it first.", "busy");
                if (!(await rt.switchModel(str(p.ref, "ref"), { persist: p.persist !== false }))) throw new RpcError(`Couldn't switch to ${p.ref}`);
                return null;
            }
            case "session.setMode":
                if (this.implementing.has(p.id)) throw new RpcError("This plan is being taken to a worktree. Wait for that to finish before changing its mode.", "busy");
                if (!PERMISSION_MODES.includes(p.mode)) throw new RpcError("Unknown mode");
                if (!this.runtime(p.id).setMode(p.mode)) throw new RpcError("Bypass mode is off. Start the GUI with --dangerously-skip-permissions or set permissions.allowBypass in your user settings.");
                return null;
            case "session.draft":
                if (typeof p.present !== "boolean") throw new RpcError("present must be a boolean");
                this.runtimes.get(str(p.id, "id"))?.setDrafting(p.dialog === true ? dialogOf(client) : client, p.present);
                return null;
            case "session.setFastMode":
                if (typeof p.enabled !== "boolean") throw new RpcError("enabled must be a boolean");
                await this.runtime(p.id).yieldIdleCompaction();
                this.runtime(p.id).setFastMode(p.enabled);
                return null;
            case "session.setEffort":
                if (!EFFORT_LEVELS.includes(p.effort)) throw new RpcError("Unknown effort level");
                this.runtime(p.id).setEffort(p.effort as EffortLevel);
                return null;
            case "session.rename": {
                const id = str(p.id, "id");
                const title = cleanTitle(str(p.title, "title"));
                while (this.closing.has(id)) await this.afterClosing(id);
                const rt = this.runtimes.get(id);
                if (rt) rt.rename(title);
                else if (title) {
                    // From the sidebar, one that isn't open: just the title line, without opening it.
                    const session = this.loadSession(id);
                    try {
                        session.setTitle(title);
                    } finally {
                        session.release();
                    }
                    const summary = this.listSessions(1000).find((s) => s.id === id) ?? this.listSessions(1000, true).find((s) => s.id === id);
                    if (summary) this.broadcast({ type: "sessions.upsert", session: summary });
                }
                return null;
            }
            case "session.compact":
                await this.runtime(p.id).compact(optStr(p.instructions));
                return null;
            // The Rewind dialog opening, or a prompt picked in it: an idle compaction stops, so what it shows can still be rewound to.
            case "session.rewindTargets": {
                const rt = this.runtime(p.id);
                if (rt.compactingWhileIdle) await rt.yieldIdleCompaction();
                return rt.rewindTargets();
            }
            case "session.rewindPlan": {
                const rt = this.runtime(p.id);
                if (rt.compactingWhileIdle) await rt.yieldIdleCompaction();
                return rt.rewindPlan(num(p.index, -1));
            }
            case "session.rewind":
                await this.runtime(p.id).yieldIdleCompaction();
                return this.runtime(p.id).rewind(num(p.index, -1), str(p.planId, "planId"), Boolean(p.code), Boolean(p.conversation));
            case "session.fork": {
                const rt = await this.forkSession(this.runtime(p.id), p.index, str(p.text, "text"), str(p.turn, "turn"));
                this.watch(client, rt.id);
                return rt.snapshot();
            }
            case "session.changes":
                return this.runtime(p.id).changes();
            case "session.gitChanges": {
                if (!["uncommitted", "branch", "last-turn", "turn"].includes(p.scope)) throw new RpcError("Unknown changes scope", "invalid");
                if (p.turnId !== undefined && (!Number.isSafeInteger(p.turnId) || p.turnId < 0)) throw new RpcError("turnId must be a checkpoint id", "invalid");
                if (p.scope === "turn" && p.turnId === undefined) throw new RpcError("turnId is required for a turn scope", "invalid");
                // A base must be one git lists (checked against for-each-ref); here it's only kept sane.
                if (p.base !== undefined && (typeof p.base !== "string" || !p.base || p.base.length > 400)) throw new RpcError("base must be a branch name", "invalid");
                if (p.path !== undefined && typeof p.path !== "string") throw new RpcError("path must be a string", "invalid");
                if (p.worktree !== undefined && (typeof p.worktree !== "string" || !p.worktree || p.worktree.length > 4096 || p.worktree.includes("\0"))) throw new RpcError("worktree must be a folder path", "invalid");
                return this.runtime(p.id).gitChanges({ scope: p.scope, base: p.base, baseToken: optStr(p.baseToken), path: p.path, pathToken: optStr(p.pathToken), turnId: p.turnId, worktree: p.worktree });
            }
            case "session.worktrees": {
                const list = await this.runtime(p.id).worktrees();
                // Every loaded session's sub-agents, not only this one's: what works where, whoever started it.
                const found = agentsByWorktree(list.map((w) => w.path), [...this.runtimes.values()].flatMap((rt) => rt.agentRuns.map((agent) => ({ sessionId: rt.id, agent }))), homedir());
                return list.map((w) => (found.has(w.path) ? { ...w, agents: found.get(w.path) } : w));
            }
            case "session.gitPublishInfo":
                return this.runtime(p.id).gitPublishInfo();
            case "session.gitPrState":
                return this.runtime(p.id).gitPrState();
            case "session.gitPublish": {
                if (typeof p.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(p.fingerprint) || !["push", "pr"].includes(p.action)) throw new RpcError("Invalid publish confirmation.", "invalid");
                for (const key of ["confirmProtected", "draft"]) if (p[key] !== undefined && typeof p[key] !== "boolean") throw new RpcError(`${key} must be a boolean.`, "invalid");
                for (const [key, limit] of [["base", 400], ["title", 250], ["body", 16000]] as const) {
                    if (p[key] !== undefined && (typeof p[key] !== "string" || p[key].length > limit || p[key].includes("\0"))) throw new RpcError(`Invalid ${key}.`, "invalid");
                }
                return this.runtime(p.id).gitPublish({ fingerprint: p.fingerprint, action: p.action, confirmProtected: p.confirmProtected, base: p.base, title: p.title, body: p.body, draft: p.draft });
            }
            case "session.gitCommit":
            case "session.gitCommitMessage": {
                // Files whose names were shown redacted come as handles (pathTokens), beside the rest.
                const tokens: unknown = p.pathTokens ?? [];
                if (!Array.isArray(tokens) || tokens.some((t) => typeof t !== "string" || !t || t.length > 200)) throw new RpcError("pathTokens must be a list of file handles", "invalid");
                if (!Array.isArray(p.paths) || !(p.paths.length + tokens.length) || p.paths.length + tokens.length > 300 || p.paths.some((path: unknown) => typeof path !== "string" || !path || path.length > 4096 || path.includes("\0"))) {
                    throw new RpcError("paths must contain 1 to 300 file paths", "invalid");
                }
                if (method === "session.gitCommitMessage") return this.runtime(p.id).gitCommitMessage(p.paths, tokens as string[]);
                if (typeof p.message !== "string" || !p.message.trim() || Buffer.byteLength(p.message) > 65_536 || p.message.includes("\0")) {
                    throw new RpcError("message must be nonempty, at most 64 KiB, and contain no NUL bytes", "invalid");
                }
                if (p.expectedHead !== undefined) {
                    const head = p.expectedHead;
                    if (
                        !head || typeof head !== "object" || typeof head.detached !== "boolean" ||
                        (head.detached
                            ? head.branch !== undefined || head.branchToken !== undefined || typeof head.sha !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head.sha)
                            : head.branchToken !== undefined
                              ? head.branch !== undefined || typeof head.branchToken !== "string" || !head.branchToken || head.branchToken.length > 200
                              : typeof head.branch !== "string" || !head.branch || head.branch.length > 400 || head.branch.includes("\0"))
                    ) {
                        throw new RpcError("expectedHead must describe a branch or detached HEAD with its full SHA", "invalid");
                    }
                }
                return this.runtime(p.id).gitCommit(p.paths, p.message, p.expectedHead, tokens as string[]);
            }
            case "session.toolOutput":
                return { output: this.runtime(p.id).toolOutput(str(p.toolId, "toolId")) };
            case "session.promptImages":
                return { images: this.runtime(p.id).promptImages(num(p.seg, -1), num(p.index, -1)) };
            case "session.schedule": {
                const action = p.action;
                if (action !== "pause" && action !== "resume" && action !== "run" && action !== "delete") throw new RpcError("action must be pause, resume, run or delete", "invalid");
                return { found: this.runtime(p.id).scheduleAction(text(p.scheduleId, "scheduleId", 40), action) };
            }
            case "session.resumeAfterLimit":
                this.runtime(p.id).resumeAfterLimit();
                return null;
            case "session.dequeue": {
                const q = this.runtime(p.id).dequeue(num(p.queueId, -1));
                if (!q) return { removed: false };
                // Edited, it goes back to the window that asked (not to every one showing the session).
                return p.edit === true ? { removed: true, text: q.text, ...toWire(q.attachments) } : { removed: true };
            }
            case "session.sendQueuedNow":
                return this.runtime(p.id).sendQueuedNow(num(p.queueId, -1));
            case "session.moveQueued": {
                const to = num(p.to, -1);
                if (to < 0) throw new RpcError("to must be a position in the queue", "invalid");
                return { moved: this.runtime(p.id).moveQueued(num(p.queueId, -1), to) };
            }
            case "session.pin":
            case "session.settle":
            case "session.archive": {
                const id = str(p.id, "id");
                const key = method === "session.pin" ? "pinned" : method === "session.settle" ? "settled" : "archived";
                const on = Boolean(p[key]);
                if (key === "archived" && !on && this.removing.size) {
                    const { cwd } = this.sessionWhere(id);
                    if ([...this.removing].some((dir) => within(dir)(cwd))) throw new RpcError("This session's worktree is being removed. Wait for removal to finish before restoring it.", "busy");
                }
                if (key === "archived" && on && p.removeWorktree === true) return await this.archiveAndRemove(client, id, optText(p.deleteIgnored, "deleteIgnored", 128));
                this.setFlag(id, key, on);
                return null;
            }
            case "session.archiveOffer":
                return await this.archiveOffer(client, text(p.id, "id", 200));
            case "session.planInfo":
                return this.planInfo(this.runtime(text(p.id, "id", 200)), optText(p.toolId, "toolId", 200));
            case "session.implementPlan":
                return await this.implementPlan(client, p);
            case "session.savePlan": {
                const rt = this.runtime(text(p.id, "id", 200));
                const plan = this.planOf(rt, optText(p.toolId, "toolId", 200));
                const input = optText(p.path, "path", 4096) ?? defaultPlanPath({ home: cavvyHome(), cwd: rt.ws.cwd, title: planTitle(plan.text) });
                return { path: writePlanFile({ cwd: rt.ws.cwd, home: cavvyHome(), input, text: plan.text, replace: p.replace === true }) };
            }
            case "session.delete":
                await this.deleteSession(checkId(p.id));
                return null;
            case "session.restore": {
                const id = checkId(p.id);
                while (this.closing.has(id)) await this.afterClosing(id);
                const flags = restoreSession(id, this.removing.size ? (cwd) => {
                    if (!cwd || [...this.removing].some((dir) => within(dir)(cwd))) throw new RpcError("This session's worktree is being removed. Wait for removal to finish before restoring it.", "busy");
                } : undefined);
                const saved = updateStore((s) => {
                    for (const key of STORE_FLAGS) if (flags[key]) s[key] = [...new Set([...(s[key] ?? []), id])];
                });
                // In whichever list it's in: without its flags saved, it's back as an active one.
                const summary = this.listSessions(1000).find((s) => s.id === id) ?? this.listSessions(1000, true).find((s) => s.id === id);
                if (summary) this.broadcast({ type: "sessions.upsert", session: summary });
                if (!saved && STORE_FLAGS.some((key) => flags[key])) client.send({ type: "toast", level: "warn", message: `The session is back, but its pin and archived state couldn't be saved to ${storeFile()}.` });
                return null;
            }
            case "session.killShell":
                await this.runtime(p.id).killShell(str(p.shellId, "shellId"));
                return null;
            case "session.stopBackground": {
                if (p.ids !== undefined && (!Array.isArray(p.ids) || p.ids.length > 500 || p.ids.some((x: unknown) => typeof x !== "string" || !x || x.length > 500))) throw new RpcError("ids must be a list of task ids", "invalid");
                return { results: await this.runtime(p.id).stopBackground(p.ids as string[] | undefined) };
            }
            case "session.clearBackground":
                this.runtime(p.id).clearBackground();
                return null;
            case "session.restartCli":
                await this.runtime(p.id).restartCli();
                return null;
            case "session.stopWatch":
                this.runtime(p.id).stopWatch(str(p.watchId, "watchId"));
                return null;
            case "session.forgetSecret":
                this.runtime(p.id).forgetSecret(str(p.name, "name"));
                return null;
            case "session.stopAgent":
                try {
                    return { stopped: this.runtime(p.id).stopAgent(optStr(p.agentId)) };
                } catch (e) {
                    throw new RpcError((e as Error).message);
                }
            case "session.export":
                return { markdown: this.runtime(p.id).exportMarkdown() };
            case "models.list":
                if (p.refresh) await this.refreshListings(true);
                else if (!this.listed) await this.firstListings();
                return this.modelsList();
            case "session.setAccount":
                await this.runtime(p.id).yieldIdleCompaction();
                await this.runtime(p.id).setAccount(str(p.provider, "provider"), str(p.accountId, "accountId"));
                return null;
            case "accounts.list":
                return this.accountsList(str(p.provider, "provider"), p.refresh === true);
            case "accounts.add": {
                const provider = str(p.provider, "provider");
                // An account only selects a CLI's folder (#375): what's running goes on as it is.
                const added = addAccount(provider, { id: str(p.id, "id"), name: str(p.name, "name"), folder: p.folder === undefined ? undefined : str(p.folder, "folder") }, this.accountProjects());
                forgetClient(provider);
                await this.refreshListings(true);
                this.broadcast({ type: "models.changed" });
                return added;
            }
            case "accounts.rename":
                renameAccount(str(p.provider, "provider"), str(p.id, "id"), str(p.name, "name"));
                this.broadcast({ type: "models.changed" });
                return null;
            case "accounts.setDefault":
                setDefaultAccount(str(p.provider, "provider"), str(p.id, "id"));
                await this.refreshListings(true);
                this.broadcast({ type: "models.changed" });
                return null;
            case "accounts.remove": {
                const provider = str(p.provider, "provider");
                const id = str(p.id, "id");
                const idle = [...this.runtimes.values()].filter((rt) => rt.compactingWhileIdle && rt.session.accountId(provider) === id);
                if (idle.length) await Promise.all(idle.map((rt) => rt.yieldIdleCompaction()));
                for (const rt of this.runtimes.values()) {
                    if ((rt.busy && rt.session.accountId(provider) === id) || rt.agent?.childUsesAccount(provider, id)) throw new RpcError("Stop the account's running turn and CLI background tasks before removing it", "busy");
                }
                // A login still running would sign in to a folder no longer registered, nor protected once it was the last.
                // Checked with no await before the removal, so a login can't start in between.
                if (this.terminals.signingIn(provider, id)) throw new RpcError("Close the account's sign-in terminal before removing it", "busy");
                removeAccount(provider, id, str(p.confirmedFolder, "confirmedFolder"), this.accountProjects());
                this.accountStatus.delete(`${provider}:${id}`);
                this.limits.delete(planLimitKey(provider, id));
                this.saveLimits();
                this.broadcast({ type: "limits", limits: { provider, accountId: id, windows: [], reached: false, at: Date.now() } });
                this.broadcast({ type: "models.changed" });
                return null;
            }
            case "providers.list":
                return this.providersList();
            // Awaited here: these can reject before their first await, and a promise handed back unawaited is
            // only handled a tick later (bun test reports that as an unhandled rejection).
            case "providers.setKey":
                return await this.addKey(optStr(p.provider), str(p.key, "key"));
            case "providers.connectCli":
                return await this.connectCli(str(p.provider, "provider"));
            case "providers.removeKey": {
                const id = str(p.provider, "provider");
                if (getProvider(id)?.auth === "cli") {
                    // Keep account folders registered and protected until explicitly removed.
                    if ((readAgentConfig(id)?.accounts?.length ?? 0) > 0) throw new RpcError("Remove named accounts before turning off this CLI", "invalid");
                    // Turns it off here; the CLI stays signed in.
                    removeAgentConfig(id);
                    forgetClient(id);
                    await this.afterKeyChange(id);
                    return null;
                }
                const k = await getKey(id);
                if (k?.source === "env") throw new RpcError(`The ${id} key comes from $${k.envVar}; unset it in your shell.`);
                await removeKey(id);
                forgetClient(id);
                await this.afterKeyChange(id);
                return null;
            }
            case "projects.recent":
                return this.recentProjects();
            case "projects.inspect":
                return this.inspectProject(str(p.path, "path"));
            case "projects.worktrees":
                return listWorktrees(resolve(expandHome(str(p.path, "path"))));
            case "projects.createWorktree": {
                if (p.setup !== undefined && typeof p.setup !== "boolean") throw new RpcError("setup must be true or false", "invalid");
                // Copy the client's accepted preview before checkout yields; never select a replacement later.
                let preview: CreateWorktreeParams["setupScript"];
                if (p.setup === true && p.setupScript !== undefined) {
                    const s = p.setupScript;
                    if (!s || typeof s !== "object" || Array.isArray(s) || typeof s.id !== "string" || typeof s.command !== "string") {
                        throw new RpcError("setupScript must contain the previewed id and command", "invalid");
                    }
                    preview = { id: text(s.id, "setupScript.id", 64), command: text(s.command, "setupScript.command", SCRIPT_LIMITS.command) };
                }
                const made = await createWorktreeWithHooks(
                    {
                        path: resolve(expandHome(text(p.path, "path", 4096))),
                        branch: text(p.branch, "branch", 200),
                        base: optText(p.base, "base", 200),
                        folder: optText(p.folder, "folder", 255),
                        location: optText(p.location, "location", 4096),
                    },
                    this.o.log,
                );
                // The commit is for plan handoffs on the server; the wire result stays CreateWorktreeResult.
                const wire = { path: made.path, branch: made.branch };
                // The worktree is there whatever its setup does: only asked for, by this request, may it run.
                return p.setup === true ? { ...wire, ...(await this.grantSetup(client, made.path, preview)) } : wire;
            }
            case "projects.removeWorktree":
                return this.removeWorktree(resolve(expandHome(text(p.path, "path", 4096))), text(p.worktree, "worktree", 4096), optText(p.deleteIgnored, "deleteIgnored", 128));
            case "runs.start":
                return await startRun(this.runHost(), parseRunRequest(p, { validImage, resolvePath: (path) => resolve(expandHome(path)) }));
            case "projects.trust":
                return this.trustProject(str(p.path, "path"), Boolean(p.trust));
            case "projects.forget": {
                const path = resolve(str(p.path, "path"));
                updateStore((s) => (s.recent = (s.recent ?? []).filter((r) => r.path !== path)));
                return null;
            }
            case "fs.mentions": {
                const cwd = resolve(str(p.cwd, "cwd"));
                const query = str(p.query ?? "", "query");
                const ws = this.workspaces.get(cwd);
                if (ws) return ws.files.search(query, 12);
                // Home, before a session opens there: the folder's file names (listed, as for a session, nothing read).
                if (!isDir(cwd) || [...this.removing].some((dir) => within(dir)(cwd))) return [];
                const index = this.homeFiles.get(cwd) ?? new FileIndex(cwd);
                this.homeFiles.delete(cwd);
                this.homeFiles.set(cwd, index);
                for (const old of this.homeFiles.keys()) if (this.homeFiles.size > 4) this.homeFiles.delete(old);
                return index.search(query, 12);
            }
            case "fs.dirs":
                return listDirs(str(p.path, "path"));
            case "editors.list":
                return this.editorsList();
            case "fs.open":
                return this.openInEditor(p);
            case "fs.exists":
                return this.pathsExist(p);
            case "fs.image":
                return this.readImage(p);
            case "commands.list": {
                const cwd = resolve(expandHome(str(p.cwd, "cwd")));
                const provider = optStr(p.provider) ?? await this.commandProvider(cwd);
                const commands = this.commandsFor(cwd, provider);
                const command = optStr(p.command);
                // An uninitialized Claude Code workspace resolves its own skills, just as session.send does.
                // A bare /name may be a plugin's command (/plugin:name) when only one plugin has it.
                const plugin = () => pluginCommandFor(this.workspaces.get(cwd)?.commands ?? loadCustomCommands(cwd, isTrusted(cwd)), command!);
                if (command && !commands.some((c) => c.name === command) && !(provider === "claude-code" && this.cliCommands(provider, cwd) === undefined) && !plugin()) {
                    throw new RpcError(`Unknown command /${command}`, "unknown_command");
                }
                return commands;
            }
            case "session.mcp": {
                const rt = this.runtime(p.id);
                await rt.ws.mcp.sync();
                return rt.ws.mcpList(rt, optStr(p.name));
            }
            case "session.mcpApprove": {
                const rt = this.runtime(p.id);
                rt.ws.mustTrust();
                const name = str(p.name, "name");
                const fingerprint = str(p.fingerprint, "fingerprint");
                try {
                    const st = await rt.ws.mcp.approve(name, fingerprint);
                    void rt.ws.mcp.start(st);
                    return { approved: true, list: rt.ws.mcpList(rt) };
                } catch (e) {
                    // What the card showed isn't what would run now: nothing saved, here's what would.
                    if (e instanceof McpApprovalError && e.code === "changed") return { approved: false, list: rt.ws.mcpList(rt) };
                    throw mcpError(e);
                }
            }
            case "session.mcpReject":
            case "session.mcpRevoke": {
                const rt = this.runtime(p.id);
                rt.ws.mustTrust();
                const name = str(p.name, "name");
                try {
                    if (method === "session.mcpReject") await rt.ws.mcp.reject(name);
                    else await rt.ws.mcp.revoke(name);
                } catch (e) {
                    throw mcpError(e);
                }
                return rt.ws.mcpList(rt);
            }
            case "session.mcpReconnect": {
                const rt = this.runtime(p.id);
                const name = str(p.name, "name");
                // It answers once the configuration is read again; the status follows in session events.
                await rt.ws.mcp.refresh();
                if (!rt.ws.mcp.servers.has(name)) throw new RpcError(`There's no MCP server named "${name}" here.`, "unknown");
                void rt.ws.mcp.reconnect(name).catch(() => undefined);
                return rt.ws.mcpList(rt);
            }
            case "plugins.list":
                return this.pluginsInfo(optStr(p.cwd));
            case "plugins.action":
                return this.pluginAction(p as PluginActionParams);
            case "plugins.logo":
                return pluginLogo(str(p.owner, "owner"));
            case "session.mcpSignIn": {
                const rt = this.runtime(p.id);
                const name = str(p.name, "name");
                await rt.ws.mcp.refresh();
                if (!rt.ws.mcp.servers.has(name)) throw new RpcError(`There's no MCP server named "${name}" here.`, "unknown");
                // Answered with the link as soon as there is one; the sign-in itself goes on in the browser.
                let shown!: (url: string) => void;
                const link = new Promise<string>((r) => (shown = r));
                const done = rt.ws.mcp.signIn(name, (url) => shown(url));
                done.then(
                    (st) => rt.notice(st.status === "connected" ? `Signed in to ${name}: connected.` : `Signed in to ${name}, but it didn't connect${st.error ? `: ${redact(st.error.split("\n")[0]!)}` : "."}`, st.status === "connected" ? "info" : "warn"),
                    (e) => e instanceof SignInReplaced || rt.notice(`Sign-in to ${name} didn't finish: ${redact((e as Error).message)}`, "error"),
                );
                try {
                    return { url: await Promise.race([link, done.then(() => { throw new RpcError("The sign-in finished without a link to open.", "mcp"); })]) };
                } catch (e) {
                    const m = mcpError(e);
                    throw m instanceof RpcError ? m : new RpcError(redact((e as Error).message), "mcp");
                }
            }
            case "session.mcpSignOut": {
                const rt = this.runtime(p.id);
                const name = str(p.name, "name");
                await rt.ws.mcp.signOut(name);
                return rt.ws.mcpList(rt);
            }
            case "session.mcpResources": {
                const rt = this.runtime(p.id);
                return searchResources(rt.ws.mcp.resourceList(), str(p.query ?? "", "query"), 8).map(({ server, uri, name, title, description, mention }) => ({ server, uri, name, ...(title ? { title } : {}), ...(description ? { description } : {}), mention }));
            }
            case "settings.get":
                return this.guiSettings(optStr(p.cwd));
            case "settings.update":
                return this.updateGuiSettings((p.patch ?? {}) as GuiSettings);
            case "limits.get":
                return [...this.limits.values()];
            case "usage.summary":
                return usageSummary(usageDays(p.days), Date.now(), [...this.limits.values()]);
            case "app.update.get":
                return this.updates.get();
            case "app.update.check":
                return await this.updates.check({ maxAgeMs: num(p.maxAgeMs, 0) });
            case "app.update.start":
                return await this.updates.update();
            default:
                throw new RpcError(`Unknown method ${String(method)}`, "unknown_method");
        }
    }
}

// ---------------------------------------------------------------------------

function expandHome(p: string): string {
    return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function isDir(p: string): boolean {
    try {
        return statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function listDirs(path: string): { path: string; parent?: string; dirs: string[] } {
    const p = resolve(expandHome(path || "~"));
    if (!isDir(p)) throw new RpcError(`${p} isn't a folder`);
    let dirs: string[] = [];
    try {
        dirs = readdirSync(p, { withFileTypes: true })
            .filter((d) => (d.isDirectory() || (d.isSymbolicLink() && isDir(join(p, d.name)))) && !d.name.startsWith("."))
            .map((d) => d.name)
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
            .slice(0, 500);
    } catch {
        // unreadable: no children
    }
    const parent = dirname(p);
    return { path: p, parent: parent !== p ? parent : undefined, dirs };
}

/**
 * Starts an editor's launcher and lets it run on its own. Launchers that hand
 * the file to a running editor exit at once; one that fails quickly (a broken
 * install) is reported, and one still running after a moment is the editor.
 */
async function launchEditor(argv: string[]): Promise<void> {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
        proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: childEnv(), detached: true });
    } catch (e) {
        throw new RpcError(`Couldn't start ${basename(argv[0] ?? "")}: ${(e as Error).message}`);
    }
    const code = await Promise.race([proc.exited, Bun.sleep(1500).then(() => undefined)]);
    proc.unref();
    if (code !== undefined && code !== 0) throw new RpcError(`${basename(argv[0] ?? "")} exited with status ${code}`);
}

function validImage(i: { mediaType: unknown; data: unknown }): boolean {
    return /^image\/(png|jpeg|gif|webp)$/.test(String(i?.mediaType)) && typeof i?.data === "string" && i.data.length < 20_000_000 && /^[A-Za-z0-9+/=]+$/.test(i.data.slice(0, 100));
}

function str(v: unknown, name: string): string {
    if (typeof v !== "string") throw new RpcError(`${name} must be a string`);
    return v;
}

/** A bounded string without NUL, which no argument or path can carry. */
function text(v: unknown, name: string, max: number): string {
    const s = str(v, name);
    if (s.length > max) throw new RpcError(`${name} is too long`, "invalid");
    if (s.includes("\0")) throw new RpcError(`${name} can't contain NUL`, "invalid");
    return s;
}

function optText(v: unknown, name: string, max: number): string | undefined {
    return v === undefined || v === null || v === "" ? undefined : text(v, name, max);
}

/** `cwd` is `dir` or inside it, as written or with symlinks resolved. */
function within(dir: string): (cwd: string) => boolean {
    return (cwd) => isInside(resolve(cwd), resolve(dir)) || isInside(realPath(cwd), realPath(dir));
}

function realPath(p: string): string {
    try {
        return realpathSync(p);
    } catch {
        return resolve(p);
    }
}

function optStr(v: unknown): string | undefined {
    return typeof v === "string" && v ? v : undefined;
}

/** A simulator call whose refusal (none running, Xcode missing) is for the window to show. */
async function simulatorCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (e) {
        throw e instanceof SimulatorError ? new RpcError(e.message, "simulator") : e;
    }
}

/** What the Simulator pane sent, checked; undefined when it isn't an input. */
export function parseSimulatorInput(v: unknown): SimulatorInput | undefined {
    if (!v || typeof v !== "object") return undefined;
    const i = v as Record<string, unknown>;
    const fraction = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
    switch (i.kind) {
        case "touch":
            return (i.phase === "down" || i.phase === "move" || i.phase === "up") && fraction(i.x) && fraction(i.y) ? { kind: "touch", phase: i.phase, x: i.x as number, y: i.y as number } : undefined;
        case "key":
            return typeof i.code === "string" && i.code.length <= 32 && typeof i.down === "boolean" ? { kind: "key", code: i.code, down: i.down } : undefined;
        case "button":
            return i.name === "home" || i.name === "lock" ? { kind: "button", name: i.name } : undefined;
        case "text":
            return typeof i.text === "string" && i.text.length > 0 && i.text.length <= 10_000 ? { kind: "text", text: i.text } : undefined;
        default:
            return undefined;
    }
}

/** A browser call whose refusal (not an address, no such tab) is for the window to show. */
async function browserCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (e) {
        throw e instanceof BrowserError ? new RpcError(e.message, "browser") : e;
    }
}

function num(v: unknown, d: number): number {
    return typeof v === "number" && Number.isFinite(v) ? v : d;
}


