// The GUI server's engine: every open session (each a Runtime), the projects
// they live in, and the requests the GUI makes. Several sessions can run at
// once, in different projects; each project gets its own settings, trust
// decision, MCP servers and file index, shared by its sessions.

import { ACCOUNT_PROVIDERS, account, accountProvider, addAccount, defaultAccount, listAccounts, removeAccount, renameAccount, setDefaultAccount } from "../providers/accounts";
import { loginCommand } from "../backends/account-login";
import { planLimitKey, type AccountInfo } from "./protocol";
import { mergeLimits } from "../backends/limits";
import { Terminals } from "./terminals";
import { deleteScript, findScript, findSetupScript, listScripts, markUsed, reorderScripts, saveScript } from "./scripts";
import { checkGrant, SetupTickets, setupTrusted } from "./setup";
import { RpcError } from "./rpc-error";
export { RpcError };
import { readdirSync, realpathSync, statSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { homedir, hostname, userInfo } from "os";
import { APP_VERSION, harnessHome, paths } from "../config/paths";
import { JsonFileError, loadScope, loadSettings, readJson, updateSettings, writeJson, EFFORT_LEVELS, type Effort, type Settings } from "../config/settings";
import { isTrusted, projectConfigSummary, trustedByUser, trustFolder, trustForSession } from "../config/trust";
import { fireHooks } from "../agent/hooks";
import { findSessionAnywhere, heldSessionFolders, listAllSessions, Session, SessionInUseError, sessionFolder, sessionHolder } from "../agent/session";
import { forkSession } from "../agent/fork";
import { loadCustomCommands, type CustomCommand } from "../commands/custom";
import { McpManager } from "../mcp/manager";
import { approvalMeaning, McpApprovalError, visible } from "../mcp/approval";
import { PERMISSION_MODES, type PermissionMode } from "../permissions/modes";
import { cachedListings, clientFor, defaultModelFrom, forgetClient, listAllModels, resolveModelInfo, type ProviderListing } from "../providers/models";
import { allProviders, getProvider, readAgentConfig, readVertexConfig, removeAgentConfig, saveAgentConfig, SEARCH_PROVIDERS } from "../providers/registry";
import { checkAgentCli, vendorOf } from "../backends/index";
import { CLAUDE_CLI, CODEX_CLI, findCli } from "../backends/cli";
import { getKey, removeKey, setKey } from "../auth/credentials";
import { detectKeyProvider, validateKey } from "../auth/detect";
import { FileIndex } from "../ui/mentions";
import { gitRoot, gitBranch } from "../util/git";
import { createWorktree, currentBase, ignoredWaiting, listWorktrees, mainCheckoutOf, managedWorktreeOf, planRemoval, runRemoval, suggestBranch, unpushedReason, type Removal } from "./worktrees";
import { defaultPlanPath, implementPrompt, planTitle, slugify, writePlanFile } from "./plans";
import { billingOf, parseRunRequest, startRun, type RunHost, type RunRecord } from "./runs";
import { checkPathInput, confinePath, defaultDetectEnv, opensAsProject, detectEditor, editorArgv, editorById, EDITOR_IDS, EDITORS, MAX_COL, MAX_LINE, position, takesLines, type DetectEnv } from "./editors";
import { childEnv } from "../util/env";
import { expandPath, isInside } from "../util/files";
import { maskKey, redact } from "../util/redact";
import { cleanTitle, modelSummary, Runtime } from "./runtime";
import { forkUiLog } from "./history";
import { CLI_SOURCES, findCliSession, listCliSessions, readCliTranscript, validCliId, type CliSource } from "./cli-sessions";
import { harnessLinks, importModel, linkKey, writeImportedSession, type HarnessLinks } from "./cli-import";
import { CODEX_CLIENT_NAME } from "../backends/codex";
import { checkId, claimForDelete, locateSession, purgeTrash, restoreSession, trashSession, type SessionFlags } from "./session-delete";
import { searchSessions } from "./search";
import { usageDays, usageSummary } from "./usage";
import type {
    ArchiveOffer,
    ArchiveResult,
    CliSessionInfo,
    CliSessionsList,
    CommandInfo,
    CreateWorktreeParams,
    CreateWorktreeResult,
    EditorInfo,
    EffortLevel,
    GuiSettings,
    HelloResult,
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
} from "./protocol";
import { IMPLEMENT_MODES, PROTOCOL_VERSION, SCRIPT_LIMITS } from "./protocol";
import { modelRef, type AttachedPart, type ImagePart } from "../providers/types";
import { checkFiles, checkMedia, toWire } from "./attachments";

export interface EngineOptions {
    /** --dangerously-skip-permissions: bypass mode may be chosen. */
    allowBypass?: boolean;
    /** The folder the server was started in. */
    startCwd?: string;
    /** Default model when settings don't name one (legacy MODEL in the harness .env). */
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
 * A CLI session in the list: one Harness holds is listed apart; one Harness's
 * sub-agents ran on is left out, as is a Codex thread started by Harness's
 * client that no session holds (sub-agent runs from before they were recorded).
 */
function sortCliSession(links: HarnessLinks, source: CliSource, id: string, originator: string | undefined): "new" | "held" | "hidden" {
    const k = linkKey(source, id);
    if (links.held.has(k)) return "held";
    if (links.subagent.has(k)) return "hidden";
    if (source === "codex" && originator === CODEX_CLIENT_NAME) return "hidden";
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

const storeFile = () => join(harnessHome(), "gui.json");
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

    constructor(
        private engine: Engine,
        readonly cwd: string,
        public trusted: boolean,
    ) {
        this.settings = loadSettings(cwd, { trusted });
        this.mcp = this.startMcp();
        this.files = new FileIndex(cwd);
        this.commands = loadCustomCommands(cwd, trusted);
    }

    private startMcp(): McpManager {
        const mcp = new McpManager(this.cwd, () => this.settings, this.trusted, () => (this.settings = loadSettings(this.cwd, { trusted: this.trusted })));
        mcp.onChange = () => this.engine.workspaceChanged(this);
        mcp.load();
        void mcp.startAll();
        return mcp;
    }

    reload() {
        this.settings = loadSettings(this.cwd, { trusted: this.trusted });
        this.commands = loadCustomCommands(this.cwd, this.trusted);
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
    private closingIn = new Map<string, string>();
    /** Worktrees being removed (real paths): no session opens in them meanwhile. */
    private removing = new Set<string>();
    /** Closing everything: no new work is taken on, as it would outlive the server. */
    private stopping = false;
    /** Sessions whose plan is being taken to a worktree, and sessions being archived with theirs: one at a time each. */
    private implementing = new Set<string>();
    private archiving = new Set<string>();
    private purgeTimer?: ReturnType<typeof setInterval>;
    /** The commands each agent CLI last said it runs itself, so a new session's first message can be one. */
    private cliCommandNames = new Map<string, Set<string>>();

    constructor(private o: EngineOptions = {}) {
        this.fallbackModel = o.fallbackModel;
        this.terminals = new Terminals({ graceMs: o.terminalGraceMs });
    }

    log(msg: string) {
        this.o.log?.(redact(msg));
    }

    async start() {
        void this.firstListings();
        purgeTrash();
        this.purgeTimer = setInterval(() => purgeTrash(), PURGE_EVERY_MS);
        this.purgeTimer.unref?.();
    }

    async stop() {
        this.stopping = true;
        for (const pending of this.openingTerminals.values()) pending.cancelled = true;
        const terminalsStopped = this.terminals.stop();
        clearInterval(this.purgeTimer);
        for (const t of this.unloadTimers.values()) clearTimeout(t);
        this.unloadTimers.clear();
        await Promise.all([...this.runtimes.values()].map((r) => r.close().catch(() => undefined)).concat([...this.closing.values()]));
        await terminalsStopped;
        await Promise.race([Promise.all([...this.workspaces.values()].map((w) => w.mcp.closeAll().catch(() => undefined))), new Promise((r) => setTimeout(r, 1500))]);
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

    sendOps(sessionId: string, seq: number, ops: SessionOp[]) {
        for (const c of this.clients) if (c.subs.has(sessionId)) c.send({ type: "session.ops", sessionId, seq, ops });
    }

    draft(rt: Runtime, text: string, attachments?: AttachedPart[]) {
        const back = toWire(attachments);
        for (const c of this.clients) if (c.subs.has(rt.id)) c.send({ type: "draft", sessionId: rt.id, text, ...back });
    }

    notify(rt: Runtime, kind: "done" | "permission" | "question" | "plan" | "error", body: string) {
        const title = rt.title ?? rt.firstPrompt()?.slice(0, 60) ?? basename(rt.ws.cwd);
        this.broadcast({ type: "notify", sessionId: rt.id, kind, title, body });
        this.sessionChanged(rt);
        const message = `Harness: ${body}`;
        void fireHooks(rt.settings(), "Notification", { session_id: rt.id, message, kind }, rt.ws.cwd, () => {});
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
     * or one in another process (a terminal) once it has sent a message and
     * so holds its lock. From the check until Git is done no session can
     * open there from this server, nor can another removal of it start; its
     * idle workspaces (picked while their paths still resolve) close after.
     */
    private async removeWorktree(path: string, worktree: string, deleteIgnored?: string, check?: (plan: Removal) => Promise<void>): Promise<RemoveWorktreeResult> {
        const held = heldSessionFolders();
        const open = () => [...[...this.runtimes.values()].map((rt) => rt.ws.cwd), ...this.closingIn.values(), ...held];
        const plan = planRemoval({ path, worktree, inUse: (dir) => open().some(within(dir)) });
        const reserved = realPath(plan.path);
        if ([...this.removing].some((dir) => within(dir)(reserved) || within(reserved)(dir))) throw new RpcError(`${plan.path} is already being removed.`, "busy");
        this.removing.add(reserved);
        const idle = [...this.workspaces].filter(([cwd]) => within(plan.path)(cwd));
        let result: RemoveWorktreeResult;
        try {
            // Last checks of the caller's own, with the folder reserved: nothing can open there meanwhile.
            await check?.(plan);
            result = await runRemoval(plan, { deleteIgnored }, this.o.log);
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
            updatedAt: rt.lastActive,
            messages: rt.session.messages.length,
            status: rt.status,
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
            const disk = out.get(rt.id);
            const live = this.summaryOf(rt);
            out.set(rt.id, { ...live, updatedAt: Math.max(live.updatedAt, disk?.updatedAt ?? 0) });
        }
        return [...out.values()].filter((s) => s.archived === archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
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
                if (!saved) throw new RpcError("Harness couldn't save this run.");
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

    /** Claude Code and Codex sessions that ran in this folder, newest first, marked when already in Harness. */
    cliSessionsList(cwd: string): CliSessionsList {
        const p = resolve(expandHome(cwd));
        if (!isDir(p)) throw new RpcError(`${p} isn't a folder`);
        const now = Date.now();
        const links = harnessLinks(this.aliasesOf(p, []));
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
                ...(links.held.has(linkKey(s.source, s.id)) ? { harnessId: links.held.get(linkKey(s.source, s.id)) } : {}),
                recent: now - s.updatedAt < RECENT_CLI_MS,
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt);
        return {
            sources: listings.map((l) => ({ source: l.source, name: getProvider(l.source)?.name ?? l.source, enabled: Boolean(readAgentConfig(l.source)), more: l.more, moreInHarness: l.moreHeld })),
            sessions,
        };
    }

    /**
     * Paths that are this folder, under which Harness may have kept its sessions:
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
     * A Harness session for a Claude Code or Codex session of this folder: the
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
        const links = harnessLinks(this.aliasesOf(p, [entry.cwd]));
        // A run of Harness's own sub-agents isn't offered, so it isn't imported either.
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
        if (!rt.idle) return this.unloadLater(id);
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
        this.closingIn.set(id, rt.ws.cwd);
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
        this.setups.drop(client);
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
        if (this.stopping) throw new RpcError("The harness server is stopping.", "stopping");
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
        if (rt) this.closingIn.set(id, rt.ws.cwd);
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
        return { id: plan.id, plan: plan.text, title, pending: Boolean(plan.interactionId), cwd, git, notGit, mode, modeWhy: why, savePath: defaultPlanPath({ home: harnessHome(), cwd, title }), home: harnessHome() };
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
        if (!w || w.branch !== branch) throw new RpcError(`${path} isn't a worktree Harness made for ${branch} in this repository.`, "not_managed");
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
            const made = resume ? this.madeWorktree(from, resume, branch) : await createWorktree({ path: from, branch, base, folder }, this.o.log);
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
                const link = { title, folder: from, path: made.path, branch: made.branch, base: named, at: Date.now() };
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
        if (file && sessionHolder(file) !== undefined) return { reason: "This session is open in another Harness process (a terminal, say). Close it there to remove its worktree.", code: "open_elsewhere" };
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
            if (!found) throw new RpcError("This session isn't in a worktree Harness manages, so there's no worktree to remove.", "not_managed");
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
            const others = [...[...this.runtimes.values()].filter((r) => r !== rt).map((r) => r.ws.cwd), ...this.closingIn.values(), ...heldSessionFolders()];
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
        this.broadcast({ type: "limits", limits: merged });
    }

    private accountStatus = new Map<string, Partial<AccountInfo>>();

    private accountProjects(): string[] {
        return [...this.workspaces.keys(), ...(this.o.startCwd ? [this.o.startCwd] : [])];
    }

    private async accountsList(provider: string, refresh = false): Promise<AccountInfo[]> {
        accountProvider(provider);
        return Promise.all(listAccounts(provider).map(async (a) => {
            const key = `${provider}:${a.id}`;
            if (refresh) {
                try {
                    const status = await checkAgentCli(provider, undefined, a.id);
                    this.accountStatus.set(key, { signedIn: status.signedIn, description: status.description, email: status.email, plan: status.plan });
                } catch (e) {
                    this.accountStatus.set(key, { description: redact((e as Error).message).slice(0, 400) });
                }
            }
            return { ...a, ...this.accountStatus.get(key) };
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
                const cli = p.id === "codex" ? CODEX_CLI : CLAUDE_CLI;
                const on = Boolean(readAgentConfig(p.id));
                out.push({
                    id: p.id,
                    name: p.name,
                    kind: p.kind,
                    configured: on,
                    source: on ? "your plan" : undefined,
                    keyUrl: p.keyUrl,
                    requiresKey: false,
                    agentCli: { accounts: listAccounts(p.id).length > 1 ? await this.accountsList(p.id) : undefined, defaultAccount: defaultAccount(p.id), installed: Boolean(findCli(p.id, cli)), signIn: cli.signIn, install: cli.install, plan: p.id === "codex" ? "ChatGPT plan" : "Claude subscription" },
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
        const st = await checkAgentCli(def.id);
        if (!st.installed) throw new RpcError(`${def.name} isn't installed. ${st.installHint}, sign in with \`${st.signIn}\`, then try again.`, "not_installed");
        if (!st.signedIn) throw new RpcError(`${def.name} isn't signed in. Run \`${st.signIn}\` in a terminal (${vendorOf(def.id)}'s own sign-in), then try again.`, "not_signed_in");
        saveAgentConfig(def.id);
        forgetClient(def.id);
        await this.afterKeyChange(def.id);
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
            webSearch: s.webSearch,
            allowBypass: s.permissions?.allowBypass,
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
            if ("webSearch" in patch && ["auto", "anthropic", "brave", "tavily", "duckduckgo", "off"].includes(String(patch.webSearch))) s.webSearch = patch.webSearch as Settings["webSearch"];
            if ("defaultMode" in patch || "allowBypass" in patch) {
                const perms = (s.permissions ??= {});
                if ("defaultMode" in patch) perms.defaultMode = patch.defaultMode && PERMISSION_MODES.includes(patch.defaultMode) ? patch.defaultMode : undefined;
                if ("allowBypass" in patch) perms.allowBypass = Boolean(patch.allowBypass) || undefined;
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
     * project that's open in Harness. Any other folder is refused, so the GUI
     * can't widen the roots by naming one.
     */
    private openScope(p: Record<string, any>): { cwd: string; roots: string[] } {
        if (p.sessionId !== undefined) {
            const rt = this.runtime(p.sessionId);
            return { cwd: rt.ws.cwd, roots: rt.checker.workspaceRoots() };
        }
        const ws = this.workspaces.get(resolve(str(p.cwd, "cwd")));
        if (!ws) throw new RpcError("That folder isn't open in Harness", "not_open");
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
        const { cwd, roots } = this.openScope(p);
        const t = confinePath(str(p.path, "path"), cwd, roots);
        if (folder && !t.dir) throw new RpcError(`${p.path} isn't a folder`, "invalid");
        if (!folder && t.dir && def.style !== "reveal") throw new RpcError(`${p.path} is a folder`, "invalid");
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

    /** With `provider`, the commands that agent CLI runs itself too (those it last listed). */
    private commandsFor(cwd: string, provider?: string): CommandInfo[] {
        const builtin: CommandInfo[] = [
            { name: "compact", description: "Summarize the conversation to free up context", args: "[instructions]" },
            { name: "init", description: "Create a HARNESS.md with notes about this codebase" },
            { name: "review", description: "Review the current changes (or a PR number) for bugs", args: "[pr|focus]" },
            { name: "model", description: "Switch the model" },
            { name: "mode", description: "Switch the permission mode" },
            { name: "rewind", description: "Go back to before an earlier prompt" },
            { name: "fork", description: "Continue in a new session from the latest response, keeping this one as it is" },
            { name: "mcp", description: "MCP servers: status, approval, reconnect", args: "[server]" },
            { name: "tasks", description: "Sub-agents and tasks delegated to other models (/tasks stop stops them)", args: "[stop [task-id]]" },
            { name: "rename", description: "Rename this session", args: "<title>" },
            { name: "new", description: "Start a new session in this project" },
            { name: "export", description: "Copy the conversation as markdown" },
            { name: "settings", description: "Open settings" },
            { name: "cost", description: "Tokens and cost by model, and your plan's limits" },
            { name: "context", description: "How full the context window is, and your plan's limits" },
        ];
        const ws = this.workspaces.get(resolve(cwd));
        // Before a session opens the project, its commands are read from disk (the home screen checks a /word against them).
        const custom = (ws?.commands ?? loadCustomCommands(resolve(cwd), isTrusted(resolve(cwd)))).map((c) => ({ name: c.name, description: c.description || `Custom command (${c.source})`, args: c.argumentHint, custom: true }));
        const own = new Set([...builtin, ...custom].map((c) => c.name));
        const name = provider ? (getProvider(provider)?.name ?? provider) : "";
        const cli = [...(this.cliCommands(provider, cwd) ?? [])].filter((n) => !own.has(n)).map((n) => ({ name: n, description: `${name}'s own command` }));
        return [...builtin, ...custom, ...cli];
    }

    // -----------------------------------------------------------------------
    // Requests

    async handle<M extends Method>(client: EngineClient, method: M, raw: unknown): Promise<Methods[M]["result"]> {
        if (this.stopping) throw new RpcError("The harness server is stopping.", "stopping");
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
                    const command = loginCommand(provider, accountId);
                    return this.terminals.open(client, str(p.id, "id"), homedir(), p.cols, p.rows, { command, login: { provider, accountId, name: account(provider, accountId).name }, onExit: () => { void this.accountsList(provider, true).then(() => this.refreshListings(true)).then(() => this.broadcast({ type: "models.changed" })).catch(() => undefined); } });
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
                return { version: APP_VERSION, protocol: PROTOCOL_VERSION, home: harnessHome(), platform: process.platform, homeDir: homedir(), user, host: hostname().replace(/\.local$/, ""), startCwd } satisfies HelloResult;
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
                return await rt.send(str(p.text ?? "", "text"), attached.length ? attached : undefined, p.literal === true);
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
            case "session.setFastMode":
                if (typeof p.enabled !== "boolean") throw new RpcError("enabled must be a boolean");
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
            case "session.rewindTargets":
                return this.runtime(p.id).rewindTargets();
            case "session.rewindPlan":
                return this.runtime(p.id).rewindPlan(num(p.index, -1));
            case "session.rewind":
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
                return this.runtime(p.id).gitChanges({ scope: p.scope, base: p.base, path: p.path, turnId: p.turnId });
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
                if (!Array.isArray(p.paths) || !p.paths.length || p.paths.length > 300 || p.paths.some((path: unknown) => typeof path !== "string" || !path || path.length > 4096 || path.includes("\0"))) {
                    throw new RpcError("paths must contain 1 to 300 file paths", "invalid");
                }
                if (method === "session.gitCommitMessage") return this.runtime(p.id).gitCommitMessage(p.paths);
                if (typeof p.message !== "string" || !p.message.trim() || Buffer.byteLength(p.message) > 65_536 || p.message.includes("\0")) {
                    throw new RpcError("message must be nonempty, at most 64 KiB, and contain no NUL bytes", "invalid");
                }
                if (p.expectedHead !== undefined) {
                    const head = p.expectedHead;
                    if (
                        !head || typeof head !== "object" || typeof head.detached !== "boolean" ||
                        (head.detached
                            ? head.branch !== undefined || typeof head.sha !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head.sha)
                            : typeof head.branch !== "string" || !head.branch || head.branch.length > 400 || head.branch.includes("\0"))
                    ) {
                        throw new RpcError("expectedHead must describe a branch or detached HEAD with its full SHA", "invalid");
                    }
                }
                return this.runtime(p.id).gitCommit(p.paths, p.message, p.expectedHead);
            }
            case "session.toolOutput":
                return { output: this.runtime(p.id).toolOutput(str(p.toolId, "toolId")) };
            case "session.dequeue": {
                const q = this.runtime(p.id).dequeue(num(p.queueId, -1));
                if (!q) return { removed: false };
                // Edited, it goes back to the window that asked (not to every one showing the session).
                return p.edit === true ? { removed: true, text: q.text, ...toWire(q.attachments) } : { removed: true };
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
                const input = optText(p.path, "path", 4096) ?? defaultPlanPath({ home: harnessHome(), cwd: rt.ws.cwd, title: planTitle(plan.text) });
                return { path: writePlanFile({ cwd: rt.ws.cwd, home: harnessHome(), input, text: plan.text, replace: p.replace === true }) };
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
                this.runtime(p.id).setAccount(str(p.provider, "provider"), str(p.accountId, "accountId"));
                return null;
            case "accounts.list":
                return this.accountsList(str(p.provider, "provider"), p.refresh === true);
            case "accounts.add": {
                const provider = str(p.provider, "provider");
                if ([...this.runtimes.values()].some((rt) => rt.busy || rt.agent?.hasCliChild())) throw new RpcError("Add accounts once running responses finish, so CLI protections can be refreshed", "busy");
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
                account(provider, id);
                for (const rt of this.runtimes.values()) {
                    if ((rt.busy && rt.session.accountId(provider) === id) || rt.agent?.childUsesAccount(provider, id)) throw new RpcError("Stop the account's running turn before removing it", "busy");
                }
                removeAccount(provider, id, str(p.confirmedFolder, "confirmedFolder"), this.accountProjects());
                this.accountStatus.delete(`${provider}:${id}`);
                this.limits.delete(planLimitKey(provider, id));
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
                const made = await createWorktree(
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
                const ws = this.workspaces.get(cwd);
                if (!ws) return [];
                return ws.files.search(str(p.query ?? "", "query"), 12);
            }
            case "fs.dirs":
                return listDirs(str(p.path, "path"));
            case "editors.list":
                return this.editorsList();
            case "fs.open":
                return this.openInEditor(p);
            case "fs.exists":
                return this.pathsExist(p);
            case "commands.list": {
                const cwd = resolve(expandHome(str(p.cwd, "cwd")));
                const provider = optStr(p.provider) ?? await this.commandProvider(cwd);
                const commands = this.commandsFor(cwd, provider);
                const command = optStr(p.command);
                // An uninitialized Claude Code workspace resolves its own skills, just as session.send does.
                if (command && !commands.some((c) => c.name === command) && !(provider === "claude-code" && this.cliCommands(provider, cwd) === undefined)) {
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
            case "settings.get":
                return this.guiSettings(optStr(p.cwd));
            case "settings.update":
                return this.updateGuiSettings((p.patch ?? {}) as GuiSettings);
            case "limits.get":
                return [...this.limits.values()];
            case "usage.summary":
                return usageSummary(usageDays(p.days));
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

function num(v: unknown, d: number): number {
    return typeof v === "number" && Number.isFinite(v) ? v : d;
}


