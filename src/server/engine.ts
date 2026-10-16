// The GUI server's engine: every open session (each a Runtime), the projects
// they live in, and the requests the GUI makes. Several sessions can run at
// once, in different projects; each project gets its own settings, trust
// decision, MCP servers and file index, shared by its sessions.

import { readdirSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { homedir, hostname, userInfo } from "os";
import { APP_VERSION, harnessHome } from "../config/paths";
import { loadScope, loadSettings, readJson, updateSettings, writeJson, EFFORT_LEVELS, type Effort, type Settings } from "../config/settings";
import { isTrusted, projectConfigSummary, trustFolder, trustForSession } from "../config/trust";
import { fireHooks } from "../agent/hooks";
import { findSessionAnywhere, listAllSessions, Session, SessionInUseError } from "../agent/session";
import { loadCustomCommands, type CustomCommand } from "../commands/custom";
import { McpManager } from "../mcp/manager";
import { PERMISSION_MODES, type PermissionMode } from "../permissions/modes";
import { cachedListings, defaultModelFrom, forgetClient, listAllModels, type ProviderListing } from "../providers/models";
import { allProviders, getProvider, readAgentConfig, readVertexConfig, removeAgentConfig, saveAgentConfig, SEARCH_PROVIDERS } from "../providers/registry";
import { checkAgentCli, vendorOf } from "../backends/index";
import { CLAUDE_CLI, CODEX_CLI, findCli } from "../backends/cli";
import { getKey, removeKey, setKey } from "../auth/credentials";
import { detectKeyProvider, validateKey } from "../auth/detect";
import { FileIndex } from "../ui/mentions";
import { gitRoot, gitSnapshot } from "../util/git";
import { maskKey, redact } from "../util/redact";
import { cleanTitle, modelSummary, Runtime } from "./runtime";
import type {
    CommandInfo,
    EffortLevel,
    GuiSettings,
    HelloResult,
    McpStatus,
    Method,
    Methods,
    PermissionModeId,
    ProjectInfo,
    ProviderInfo,
    ProviderModels,
    ServerEvent,
    SessionOp,
    SessionSnapshot,
    SessionSummary,
} from "./protocol";
import { PROTOCOL_VERSION } from "./protocol";
import { modelRef, type ImagePart } from "../providers/types";

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
}

/** Long enough for a window that reloads (or reconnects) to open its sessions again. */
const UNLOAD_AFTER_MS = 30_000;

export interface EngineClient {
    send(ev: ServerEvent): void;
    /** Sessions this client has open. */
    subs: Set<string>;
}

/** A request the GUI got wrong, or one that needs the user first. */
export class RpcError extends Error {
    constructor(
        message: string,
        readonly code?: string,
    ) {
        super(message);
    }
}

// ---------------------------------------------------------------------------
// The GUI's own state: recent projects, pinned, settled and archived sessions.

interface GuiStore {
    recent?: { path: string; at: number }[];
    pinned?: string[];
    archived?: string[];
    settled?: string[];
}

const storeFile = () => join(harnessHome(), "gui.json");

function readStore(): GuiStore {
    return readJson<GuiStore>(storeFile()) ?? {};
}

function updateStore(fn: (s: GuiStore) => void) {
    const s = readStore();
    fn(s);
    try {
        writeJson(storeFile(), s, 0o600);
    } catch {
        // best effort
    }
}

// ---------------------------------------------------------------------------

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
        const mcp = new McpManager(this.cwd, () => this.settings, this.trusted);
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
        if (this.trusted) return;
        this.trusted = true;
        const old = this.mcp;
        this.settings = loadSettings(this.cwd, { trusted: true });
        this.commands = loadCustomCommands(this.cwd, true);
        this.mcp = this.startMcp();
        await old.closeAll().catch(() => undefined);
        this.engine.workspaceChanged(this);
    }

    mcpStatus(): McpStatus[] {
        return [...this.mcp.servers.values()].map((s) => ({ name: s.name, status: s.status, tools: s.tools.length, error: s.error ? redact(s.error.split("\n")[0]!) : undefined, source: s.source }));
    }
}

// ---------------------------------------------------------------------------

export class Engine {
    readonly clients = new Set<EngineClient>();
    readonly workspaces = new Map<string, Workspace>();
    readonly runtimes = new Map<string, Runtime>();
    listings: ProviderListing[] = cachedListings();
    readonly fallbackModel?: string;
    private refreshing?: Promise<ProviderListing[]>;
    /** Folders whose configuration the user chose not to trust (this run). */
    private declined = new Set<string>();
    private unloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /** Sessions being unloaded (their SessionEnd hooks running): opened again once that's done. */
    private closing = new Map<string, Promise<void>>();
    /** Closing everything: no new work is taken on, as it would outlive the server. */
    private stopping = false;

    constructor(private o: EngineOptions = {}) {
        this.fallbackModel = o.fallbackModel;
    }

    async start() {
        void this.firstListings();
    }

    async stop() {
        this.stopping = true;
        for (const t of this.unloadTimers.values()) clearTimeout(t);
        this.unloadTimers.clear();
        await Promise.all([...this.runtimes.values()].map((r) => r.close().catch(() => undefined)).concat([...this.closing.values()]));
        await Promise.race([Promise.all([...this.workspaces.values()].map((w) => w.mcp.closeAll().catch(() => undefined))), new Promise((r) => setTimeout(r, 1500))]);
    }

    // -----------------------------------------------------------------------
    // Sending

    broadcast(ev: ServerEvent) {
        for (const c of this.clients) c.send(ev);
    }

    sendOps(sessionId: string, seq: number, ops: SessionOp[]) {
        for (const c of this.clients) if (c.subs.has(sessionId)) c.send({ type: "session.ops", sessionId, seq, ops });
    }

    draft(rt: Runtime, text: string, images?: ImagePart[]) {
        const back = images?.length ? images.map((i) => ({ mediaType: i.mediaType, data: i.data })) : undefined;
        for (const c of this.clients) if (c.subs.has(rt.id)) c.send({ type: "draft", sessionId: rt.id, text, images: back });
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

    private modelsList(): ProviderModels[] {
        return this.listings
            .filter((l) => l.status !== "offline")
            .map((l) => ({ provider: l.provider.id, providerName: l.provider.name, status: l.status, error: l.error ? redact(l.error) : undefined, models: l.models.map(modelSummary) }));
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
            branch: git ? gitSnapshot(p)?.branch : undefined,
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
        };
    }

    listSessions(limit = 200, archived = false): SessionSummary[] {
        const store = readStore();
        const pinned = new Set(store.pinned ?? []);
        const arch = new Set(store.archived ?? []);
        const settled = new Set(store.settled ?? []);
        const out = new Map<string, SessionSummary>();
        for (const s of listAllSessions(limit + arch.size)) {
            out.set(s.id, { id: s.id, cwd: s.cwd, projectName: basename(s.cwd) || s.cwd, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, messages: s.messages, status: "idle", pinned: pinned.has(s.id), archived: arch.has(s.id), settled: settled.has(s.id), model: s.model, live: false });
        }
        for (const rt of this.runtimes.values()) {
            if (!rt.session.messages.length && !rt.busy) continue;
            const disk = out.get(rt.id);
            const live = this.summaryOf(rt);
            out.set(rt.id, { ...live, updatedAt: Math.max(live.updatedAt, disk?.updatedAt ?? 0) });
        }
        return [...out.values()].filter((s) => s.archived === archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
    }

    private defaultMode(ws: Workspace): PermissionMode {
        const m = ws.settings.permissions?.defaultMode ?? "default";
        // Bypass as a default only counts from the user's own settings file.
        if (m === "bypassPermissions" && loadScope("user", ws.cwd).permissions?.defaultMode !== "bypassPermissions") return "default";
        return m;
    }

    async createSession(cwd: string, opts: { model?: string; mode?: PermissionModeId } = {}): Promise<Runtime> {
        const p = resolve(expandHome(cwd));
        if (!isDir(p)) throw new RpcError(`${p} isn't a folder`);
        const ws = this.workspaceFor(p);
        const session = Session.create(p);
        const mode = opts.mode && PERMISSION_MODES.includes(opts.mode) ? opts.mode : this.defaultMode(ws);
        const rt = new Runtime(this, ws, session, { mode, resumed: false });
        this.runtimes.set(rt.id, rt);
        this.remember(p);
        await rt.ready.catch(() => undefined);
        if (opts.model) await rt.setModel(opts.model);
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
        this.runtimes.delete(id);
        const done: Promise<void> = rt
            .close()
            .catch(() => undefined)
            .finally(() => {
                if (this.closing.get(id) === done) this.closing.delete(id);
            });
        this.closing.set(id, done);
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

    /** A window went away (closed, reloading, or lost its connection). */
    dropClient(client: EngineClient) {
        this.clients.delete(client);
        for (const id of client.subs) this.unloadLater(id);
    }

    /** The window shows the session from now on. If it went away while the session was being set up, it's closed later. */
    private watch(client: EngineClient, id: string) {
        client.subs.add(id);
        if (!this.clients.has(client)) this.unloadLater(id);
    }

    /** Before opening a session that's being unloaded: once that's done, if the server isn't stopping meanwhile. */
    private async afterClosing(id: string) {
        await this.closing.get(id);
        if (this.stopping) throw new RpcError("The harness server is stopping.", "stopping");
    }

    private runtime(id: unknown): Runtime {
        if (typeof id !== "string") throw new RpcError("Missing session id");
        const rt = this.runtimes.get(id);
        if (!rt) throw new RpcError("That session isn't open", "not_open");
        return rt;
    }

    // -----------------------------------------------------------------------
    // Providers

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
                    agentCli: { installed: Boolean(findCli(p.id, cli)), signIn: cli.signIn, install: cli.install, plan: p.id === "codex" ? "ChatGPT plan" : "Claude subscription" },
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
            defaultMode: s.permissions?.defaultMode,
            showThinking: s.showThinking,
            autoCompact: s.autoCompact,
            webSearch: s.webSearch,
            allowBypass: s.permissions?.allowBypass,
        };
    }

    private updateGuiSettings(patch: GuiSettings): GuiSettings {
        const cwd = this.o.startCwd ?? homedir();
        updateSettings("user", cwd, (s) => {
            if ("model" in patch) s.model = patch.model || undefined;
            if ("smallModel" in patch) s.smallModel = patch.smallModel || undefined;
            if ("reviewModel" in patch) s.reviewModel = patch.reviewModel || undefined;
            if ("effort" in patch) s.effort = patch.effort && EFFORT_LEVELS.includes(patch.effort as Effort) ? (patch.effort as Effort) : undefined;
            if ("showThinking" in patch) s.showThinking = Boolean(patch.showThinking);
            if ("autoCompact" in patch) s.autoCompact = patch.autoCompact !== false;
            if ("webSearch" in patch && ["auto", "anthropic", "brave", "tavily", "duckduckgo", "off"].includes(String(patch.webSearch))) s.webSearch = patch.webSearch as Settings["webSearch"];
            if ("defaultMode" in patch || "allowBypass" in patch) {
                const perms = (s.permissions ??= {});
                if ("defaultMode" in patch) perms.defaultMode = patch.defaultMode && PERMISSION_MODES.includes(patch.defaultMode) ? patch.defaultMode : undefined;
                if ("allowBypass" in patch) perms.allowBypass = Boolean(patch.allowBypass) || undefined;
            }
        });
        this.reloadSettings();
        return this.guiSettings(cwd);
    }

    private commandsFor(cwd: string): CommandInfo[] {
        const builtin: CommandInfo[] = [
            { name: "compact", description: "Summarize the conversation to free up context", args: "[instructions]" },
            { name: "init", description: "Create a HARNESS.md with notes about this codebase" },
            { name: "review", description: "Review the current changes (or a PR number) for bugs", args: "[pr|focus]" },
            { name: "model", description: "Switch the model" },
            { name: "mode", description: "Switch the permission mode" },
            { name: "rewind", description: "Go back to before an earlier prompt" },
            { name: "tasks", description: "Sub-agents and tasks delegated to other models (/tasks stop stops them)", args: "[stop [task-id]]" },
            { name: "rename", description: "Rename this session", args: "<title>" },
            { name: "new", description: "Start a new session in this project" },
            { name: "export", description: "Copy the conversation as markdown" },
            { name: "settings", description: "Open settings" },
        ];
        const ws = this.workspaces.get(resolve(cwd));
        const custom = (ws?.commands ?? []).map((c) => ({ name: c.name, description: c.description || `Custom command (${c.source})`, args: c.argumentHint, custom: true }));
        return [...builtin, ...custom];
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
            case "session.create": {
                const rt = await this.createSession(str(p.cwd, "cwd"), { model: optStr(p.model), mode: p.mode });
                this.watch(client, rt.id);
                return rt.snapshot() satisfies SessionSnapshot;
            }
            case "session.open": {
                const id = str(p.id, "id");
                await this.afterClosing(id);
                const rt = this.openSession(id);
                this.watch(client, rt.id);
                return rt.snapshot();
            }
            case "session.close": {
                const id = str(p.id, "id");
                client.subs.delete(id);
                this.unloadIfUnused(id);
                return null;
            }
            case "session.send": {
                const rt = this.runtime(p.id);
                const images = Array.isArray(p.images) ? (p.images as { mediaType: unknown; data: unknown }[]).filter(validImage).map((i): ImagePart => ({ type: "image", mediaType: String(i.mediaType), data: String(i.data) })) : undefined;
                this.remember(rt.ws.cwd);
                // Set aside, it's back in play once you send to it.
                if ((readStore().settled ?? []).includes(rt.id)) {
                    updateStore((s) => {
                        s.settled = (s.settled ?? []).filter((x) => x !== rt.id);
                    });
                    this.sessionChanged(rt);
                }
                return rt.send(str(p.text ?? "", "text"), images?.length ? images : undefined);
            }
            case "session.interrupt":
                this.runtime(p.id).interrupt();
                return null;
            case "session.respond":
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
                if (!PERMISSION_MODES.includes(p.mode)) throw new RpcError("Unknown mode");
                if (!this.runtime(p.id).setMode(p.mode)) throw new RpcError("Bypass mode is off. Start the GUI with --dangerously-skip-permissions or set permissions.allowBypass in your user settings.");
                return null;
            case "session.setEffort":
                if (!EFFORT_LEVELS.includes(p.effort)) throw new RpcError("Unknown effort level");
                this.runtime(p.id).setEffort(p.effort as EffortLevel);
                return null;
            case "session.rename": {
                const id = str(p.id, "id");
                const title = cleanTitle(str(p.title, "title"));
                await this.afterClosing(id);
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
            case "session.changes":
                return this.runtime(p.id).changes();
            case "session.toolOutput":
                return { output: this.runtime(p.id).toolOutput(str(p.toolId, "toolId")) };
            case "session.dequeue":
                return { removed: this.runtime(p.id).dequeue(num(p.index, -1), { text: typeof p.text === "string" ? p.text : undefined, edit: p.edit === true }) };
            case "session.pin":
            case "session.settle":
            case "session.archive": {
                const id = str(p.id, "id");
                const key = method === "session.pin" ? "pinned" : method === "session.settle" ? "settled" : "archived";
                const on = Boolean(p[key]);
                updateStore((s) => {
                    const list = new Set(s[key] ?? []);
                    if (on) list.add(id);
                    else list.delete(id);
                    s[key] = [...list];
                });
                const rt = this.runtimes.get(id);
                const summary = rt ? this.summaryOf(rt) : this.listSessions(1000, method === "session.archive" ? !on : false).find((s) => s.id === id) ?? this.listSessions(1000, true).find((s) => s.id === id);
                if (summary) this.broadcast({ type: "sessions.upsert", session: { ...summary, [key]: on } });
                return null;
            }
            case "session.killShell":
                await this.runtime(p.id).killShell(str(p.shellId, "shellId"));
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
            case "commands.list":
                return this.commandsFor(str(p.cwd, "cwd"));
            case "settings.get":
                return this.guiSettings(optStr(p.cwd));
            case "settings.update":
                return this.updateGuiSettings((p.patch ?? {}) as GuiSettings);
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

function validImage(i: { mediaType: unknown; data: unknown }): boolean {
    return /^image\/(png|jpeg|gif|webp)$/.test(String(i?.mediaType)) && typeof i?.data === "string" && i.data.length < 20_000_000 && /^[A-Za-z0-9+/=]+$/.test(i.data.slice(0, 100));
}

function str(v: unknown, name: string): string {
    if (typeof v !== "string") throw new RpcError(`${name} must be a string`);
    return v;
}

function optStr(v: unknown): string | undefined {
    return typeof v === "string" && v ? v : undefined;
}

function num(v: unknown, d: number): number {
    return typeof v === "number" && Number.isFinite(v) ? v : d;
}


