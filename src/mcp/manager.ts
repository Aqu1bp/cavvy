// Starts configured MCP servers and exposes their tools as Cavvy tools
// named mcp__<server>__<tool>.
//
// Sources: "mcpServers" in user/local settings (trusted), and the project's
// .mcp.json, whose servers only start after the user approves what they run
// (approval.ts). start() is the only place a server is started, and it
// refuses a project server that isn't approved.

import { existsSync } from "fs";
import type { McpServerConfig, Settings } from "../config/settings";
import { loadSettings, readJson } from "../config/settings";
import { paths } from "../config/paths";
import type { Tool, ToolResult } from "../tools/types";
import type { ImagePart } from "../providers/types";
import { McpAuthError, McpClient, McpError, transportOf, type McpCallResult, type McpContent, type McpPrompt, type McpResource, type McpResourceContents, type McpResourceTemplate, type McpTool } from "./client";
import { mcpInput, type McpAsker } from "./elicitation";
import { hasOAuthTokens, oauthFor, signIn as oauthSignIn, signOut as oauthSignOut } from "./oauth";
import { maskMcpSchema } from "./payload";
import { truncateMiddle } from "../util/files";
import { createHash } from "crypto";
import type { McpServerInfo } from "./info";
import { trustedByUser } from "../config/trust";
import { approvalOf, approvalReason, describeServer, hasConfigValue, headerClash, serverCwd, maskConfigDeep, maskConfigValues, McpApprovalError, removeApproval, saveApproval, saveRejection, type Approval } from "./approval";

export interface ServerState {
    name: string;
    config: McpServerConfig;
    source: "settings" | "project";
    status: "pending" | "connecting" | "connected" | "failed" | "disabled" | "needs-approval" | "needs-auth";
    error?: string;
    client?: McpClient;
    tools: McpTool[];
    /** What it offers besides tools (empty until connected, or when it offers none). */
    resources?: McpResource[];
    templates?: McpResourceTemplate[];
    prompts?: McpPrompt[];
    /** Its last 401 challenge (WWW-Authenticate), for signing in. */
    challenge?: string;
    era?: string;
    /** Another configured server whose names clean to the same segment; this one never starts. */
    collidesWith?: string;
    /** A project server's standing with the user, for the configuration in `config`. */
    approval?: Approval;
    /** Bumped by each start (and when load() drops this state): an earlier start that's still connecting gives up. */
    gen?: number;
}

/** Shared start policy: valid, enabled configuration, with an exact approval for project servers. */
export function mayStart(st: ServerState): boolean {
    return !st.config.disabled && !startError(st) && (st.source !== "project" || st.approval?.state === "approved");
}

/** Invalid configurations are excluded by the same policy as unapproved servers. */
function startError(st: ServerState): string | undefined {
    if (st.collidesWith !== undefined) return collisionError(serverSegment(st.name), st.collidesWith);
    return headerClash(st.config);
}

/** Servers allowed by mayStart(); definitions remain exactly as load() read and checked them for approval. */
export interface ApprovedMcpServers {
    cwd: string;
    /** `fingerprint`: what load() approved, so a consumer can check that the definition still resolves to it. */
    servers: Record<string, Pick<ServerState, "config" | "source"> & { fingerprint?: string }>;
}

const MAX_OUTPUT = 40_000;
/** Resources, templates and prompts kept per server: a server listing thousands doesn't fill memory or the menus. */
const MAX_LISTED_ITEMS = 2000;
/** Bounds for list(): how many servers, and roughly how many characters of description. */
const MAX_LISTED = 100;
const LIST_BUDGET = 64_000;
/** A server named longer than this isn't loaded (its name travels in every status update). */
const MAX_NAME = 200;

const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * The server's part of its tool names. It never contains "__", so the first
 * "__" after "mcp__" always ends it: a rule for `mcp__github` can't match a
 * server named "github__x".
 */
export function serverSegment(server: string): string {
    return clean(server).replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 30).replace(/_$/, "") || "server";
}

function collisionError(seg: string, first: string): string {
    return `its tool names (mcp__${seg}__…) would collide with server "${first}"; rename one of them`;
}

export function toolNameFor(server: string, tool: string): string {
    return `mcp__${serverSegment(server)}__${clean(tool)}`.slice(0, 64);
}

function sanitizeSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
    const s: Record<string, unknown> = { ...(schema ?? {}) };
    delete s.$schema;
    if (s.type !== "object") s.type = "object";
    if (!s.properties) s.properties = {};
    return s;
}

export function formatMcpResult(r: McpCallResult): { content: string; images: ImagePart[] } {
    const texts: string[] = [];
    const images: ImagePart[] = [];
    for (const c of r.content) {
        switch (c.type) {
            case "text":
                texts.push(c.text);
                break;
            case "image":
                if (/^image\/(png|jpeg|gif|webp)$/.test(c.mimeType)) images.push({ type: "image", mediaType: c.mimeType, data: c.data });
                else texts.push(`[image of type ${c.mimeType} omitted]`);
                break;
            case "audio":
                texts.push(`[audio (${c.mimeType}) omitted]`);
                break;
            case "resource_link":
                texts.push(`Resource: ${c.title ?? c.name} <${c.uri}>${c.description ? ` - ${c.description}` : ""}`);
                break;
            case "resource":
                if (typeof c.resource.text === "string") texts.push(`Resource ${c.resource.uri}:\n${c.resource.text}`);
                // An embedded image is attached, as one read with readResource is.
                else if (typeof c.resource.blob === "string" && c.resource.mimeType && IMAGE_TYPES.test(c.resource.mimeType)) images.push({ type: "image", mediaType: c.resource.mimeType, data: c.resource.blob });
                else texts.push(`[binary resource ${c.resource.uri}${c.resource.mimeType ? ` (${c.resource.mimeType})` : ""} omitted]`);
                break;
        }
    }
    if (!texts.length && r.structuredContent !== undefined) texts.push(JSON.stringify(r.structuredContent, null, 2));
    return { content: texts.join("\n\n"), images };
}

/** A resource as menus show it; `mention` is what goes after the @. */
export interface ResourceEntry {
    server: string;
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
    mention: string;
}

/** A sign-in ended because a newer one for the same server started. */
export class SignInReplaced extends McpError {
    constructor() {
        super("replaced by a newer sign-in");
    }
}

export class McpManager {
    servers = new Map<string, ServerState>();
    onChange?: () => void;
    /** Servers left out by load() for their name's length. */
    skipped = 0;

    /**
     * `reloadSettings` re-reads the settings `settings` returns, after an
     * approval is saved (and before a refresh), so they're current.
     */
    constructor(
        private cwd: string,
        private settings: () => Settings,
        readonly trusted: boolean,
        private reloadSettings?: () => void,
        /** Someone can answer servers' forms and approve sampling (the terminal, the GUI; not a headless run). */
        readonly interactive = false,
    ) {}

    /**
     * Read configuration; doesn't start anything. A server whose configuration
     * and approval didn't change keeps its state (running, failed, or turned
     * off for this session); any other running one is stopped, and the
     * returned promise settles once it has.
     */
    load(s = this.settings()): Promise<void> {
        const next = new Map<string, ServerState>();
        this.skipped = 0;
        for (const [name, config] of Object.entries(s.mcpServers ?? {})) {
            if (name.length > MAX_NAME) this.skipped++;
            else next.set(name, { name, config, source: "settings", status: config.disabled ? "disabled" : "pending", tools: [] });
        }
        let userTrusted: boolean | undefined;
        if (this.trusted && existsSync(paths.projectMcp(this.cwd))) {
            const f = readJson<{ mcpServers?: Record<string, McpServerConfig> }>(paths.projectMcp(this.cwd));
            const servers = f?.mcpServers && typeof f.mcpServers === "object" ? f.mcpServers : {};
            for (const [name, raw] of Object.entries(servers)) {
                if (next.has(name)) continue;
                if (name.length > MAX_NAME) {
                    this.skipped++;
                    continue;
                }
                const config: McpServerConfig = raw && typeof raw === "object" ? raw : {};
                const approval = approvalOf(name, config, s, this.cwd, (userTrusted ??= trustedByUser(this.cwd)));
                const status = approval.state === "rejected" || config.disabled ? "disabled" : approval.state === "approved" ? "pending" : "needs-approval";
                next.set(name, { name, config, source: "project", status, tools: [], approval });
            }
        }
        // Two servers whose names clean to the same segment would share tool
        // names and permission rules; the later one (project after user) is refused.
        const bySegment = new Map<string, string>();
        for (const st of next.values()) {
            const seg = serverSegment(st.name);
            const first = bySegment.get(seg);
            if (first === undefined) bySegment.set(seg, st.name);
            else {
                st.collidesWith = first;
                if (st.status !== "disabled") {
                    st.status = "failed";
                    st.error = collisionError(seg, first);
                }
            }
        }
        // Keep unchanged servers as they are.
        const closing: Promise<void>[] = [];
        for (const [name, st] of this.servers) {
            const n = next.get(name);
            const same = n && n.source === st.source && n.collidesWith === st.collidesWith && JSON.stringify(n.config) === JSON.stringify(st.config) && n.approval?.fingerprint === st.approval?.fingerprint && n.approval?.state === st.approval?.state;
            const kept = same && n.status === "pending" && (["connected", "connecting", "failed", "needs-auth"].includes(st.status) || (st.status === "disabled" && !st.config.disabled));
            if (kept) {
                st.approval = n.approval;
                next.set(name, st);
            } else {
                // A start of this state still under way gives up, and starts nothing more.
                st.gen = (st.gen ?? 0) + 1;
                const c = st.client;
                st.client = undefined;
                if (c) closing.push(c.close().catch(() => undefined));
            }
        }
        this.servers = next;
        return Promise.all(closing).then(() => undefined);
    }

    /** Settings and .mcp.json read again (what the other front end saved, or an edit), clients told if anything changed. */
    async refresh(): Promise<void> {
        const before = this.summary();
        this.reloadSettings?.();
        const closed = this.load();
        if (this.summary() !== before) this.onChange?.();
        await closed;
    }

    /** refresh(), then start what's newly approved. It doesn't retry a server that failed. */
    async sync(): Promise<void> {
        await this.refresh();
        void this.startAll();
    }

    private summary(): string {
        return JSON.stringify([...this.servers.values()].map((s) => [s.name, s.source, s.status, s.tools.length, s.error, s.approval?.state, s.approval?.reason]));
    }

    /** Start permission, independent of connection status except "disable for this session"; copy the raw approved config without resolving or masking it. */
    approvedServers(): ApprovedMcpServers {
        // Approvals as saved now: another Cavvy process may have revoked one (or blanket approval) since load().
        let still: (st: ServerState) => boolean;
        try {
            const settings = this.reloadSettings ? loadSettings(this.cwd, { trusted: this.trusted }) : this.settings();
            const userTrusted = trustedByUser(this.cwd);
            still = (st) => {
                if (st.source !== "project") return true;
                const now = approvalOf(st.name, st.config, settings, this.cwd, userTrusted);
                return now.state === "approved" && now.fingerprint === st.approval?.fingerprint;
            };
        } catch {
            still = (st) => st.source !== "project";
        }
        return {
            cwd: this.cwd,
            servers: Object.fromEntries([...this.servers.values()]
                .filter((s) => mayStart(s) && s.status !== "disabled" && still(s))
                .map((s) => [s.name, { config: structuredClone(s.config), source: s.source, ...(s.approval ? { fingerprint: s.approval.fingerprint } : {}) }])),
        };
    }

    async startAll(signal?: AbortSignal) {
        await Promise.all([...this.servers.values()].filter((s) => s.status === "pending").map((s) => this.start(s, signal)));
    }

    async start(st: ServerState, signal?: AbortSignal) {
        if (this.servers.get(st.name) !== st) return;
        if (!mayStart(st)) {
            const error = startError(st);
            if (error) {
                st.status = "failed";
                st.error = maskConfigValues(error, st.config);
            }
            this.onChange?.();
            return;
        }
        // Resolve once: checking a symlink and resolving it again at spawn can run in another folder.
        const runCwd = st.config.url ? undefined : serverCwd(st.config, this.cwd);
        const gen = (st.gen ?? 0) + 1;
        st.gen = gen;
        const superseded = () => st.gen !== gen;
        // One client per server: a start already under way is replaced, not doubled.
        void st.client?.close();
        st.client = undefined;
        st.status = "connecting";
        st.error = undefined;
        this.onChange?.();
        let client: McpClient | undefined;
        try {
            if (!this.stillApproved(st, runCwd)) return;
            // OAuth for a remote server, unless an Authorization header is configured for it (that one is the user's choice).
            const oauth = transportOf(st.config) !== "stdio" && !Object.keys(st.config.headers ?? {}).some((h) => h.toLowerCase() === "authorization");
            client = new McpClient(st.name, st.config, this.cwd, runCwd, { auth: oauth ? oauthFor(st.name, st.config) : undefined, interactive: this.interactive });
            st.client = client;
            const c = client;
            client.onExit = () => {
                if (!superseded() && st.status === "connected") {
                    st.status = "failed";
                    st.error = maskConfigValues(`server exited${c.stderrTail() ? `: ${c.stderrTail()}` : ""}`, st.config);
                    this.onChange?.();
                }
            };
            await client.connect(signal);
            // Revoked (or restarted) while connecting: no more requests with its configuration.
            if (superseded() || !this.stillApproved(st, runCwd)) {
                await client.close();
                return;
            }
            // Resources and prompts alongside tools, not after them; a server whose lists fail still connects with its tools.
            // A server that says what it offers and leaves out tools has none to list (a resource-only server).
            const listsTools = client.offers("tools") || !Object.keys(client.capabilities).length;
            const [tools, extras] = await Promise.all([listsTools ? client.listTools(signal) : Promise.resolve([]), this.listExtras(client, signal)]);
            if (superseded() || !this.stillApproved(st, runCwd)) {
                await client.close();
                return;
            }
            this.setTools(st, tools);
            Object.assign(st, extras);
            st.challenge = undefined;
            st.era = client.era === "modern" ? client.protocolVersion : `legacy ${client.protocolVersion}`;
            st.status = "connected";
            const current = () => !superseded() && st.client === c;
            client.onResourcesChanged = () => {
                if (!current()) return;
                void this.listExtras(c, undefined, "resources").then(
                    (x) => {
                        if (!current()) return;
                        Object.assign(st, x);
                        this.onChange?.();
                    },
                    (e) => void this.authLost(st, c, e),
                );
            };
            client.onPromptsChanged = () => {
                if (!current()) return;
                void this.listExtras(c, undefined, "prompts").then(
                    (x) => {
                        if (!current()) return;
                        Object.assign(st, x);
                        this.onChange?.();
                    },
                    (e) => void this.authLost(st, c, e),
                );
            };
            client.onToolsChanged = () => {
                if (!current()) return;
                c.listTools()
                    .then((t) => {
                        if (!current()) return;
                        this.setTools(st, t);
                        this.onChange?.();
                    })
                    .catch((e) => void this.authLost(st, c, e));
            };
        } catch (e) {
            await client?.close();
            // Whoever superseded this start closed its client (and owns the status now).
            if (superseded()) return;
            if (e instanceof McpAuthError) {
                st.status = "needs-auth";
                st.challenge = e.challenge;
                st.error = maskConfigValues(e.message, st.config);
                st.client = undefined;
                this.onChange?.();
                return;
            }
            st.status = "failed";
            const tail = client?.stderrTail();
            st.error = maskConfigValues(`${(e as Error).message}${tail ? `\n${tail}` : ""}`, st.config);
            st.client = undefined;
        }
        this.onChange?.();
    }

    /** Another process can revoke an approval or edit .mcp.json without refreshing this manager. */
    private stillApproved(st: ServerState, runCwd?: string): boolean {
        if (st.source !== "project") return true;
        const settings = loadSettings(this.cwd, { trusted: this.trusted });
        const config = this.trusted ? readJson<{ mcpServers?: Record<string, McpServerConfig> }>(paths.projectMcp(this.cwd))?.mcpServers?.[st.name] : undefined;
        if (config && typeof config === "object" && !Object.hasOwn(settings.mcpServers ?? {}, st.name)) {
            const approval = approvalOf(st.name, config, settings, this.cwd, trustedByUser(this.cwd), config.cwd === st.config.cwd ? runCwd : undefined);
            if (mayStart({ ...st, config, approval }) && approval.fingerprint === st.approval?.fingerprint) return true;
        }
        // load detaches obsolete states and begins closing their clients synchronously, including in headless runs.
        void this.load(settings);
        this.onChange?.();
        return false;
    }

    private setTools(st: ServerState, tools: McpTool[]): void {
        st.tools = tools.filter((t) => !hasConfigValue(t.name, st.config) && maskMcpSchema(t.inputSchema, st.config) !== undefined);
        const skipped = tools.length - st.tools.length;
        st.error = skipped ? `${skipped} tool${skipped === 1 ? " was" : "s were"} hidden because its name or input schema contains a configured secret.` : undefined;
    }

    /** A server's resources, templates and prompts, as far as it offers them; a list that fails is left empty. */
    private async listExtras(c: McpClient, signal?: AbortSignal, only?: "resources" | "prompts"): Promise<Pick<ServerState, "resources" | "templates" | "prompts">> {
        // A list that fails leaves it empty, unless the server stopped taking the token: that needs signing in.
        const quiet = <T>(p: Promise<T[]>) =>
            p.then((x) => x.slice(0, MAX_LISTED_ITEMS)).catch((e) => {
                if (e instanceof McpAuthError) throw e;
                return [] as T[];
            });
        const out: Pick<ServerState, "resources" | "templates" | "prompts"> = {};
        const jobs: Promise<unknown>[] = [];
        if (only !== "prompts") {
            const offers = c.offers("resources");
            jobs.push(offers ? quiet(c.listResources(signal)).then((r) => (out.resources = r)) : Promise.resolve((out.resources = [])));
            jobs.push(offers ? quiet(c.listResourceTemplates(signal)).then((r) => (out.templates = r)) : Promise.resolve((out.templates = [])));
        }
        if (only !== "resources") jobs.push(c.offers("prompts") ? quiet(c.listPrompts(signal)).then((r) => (out.prompts = r)) : Promise.resolve((out.prompts = [])));
        await Promise.all(jobs);
        return out;
    }

    /**
     * Sign in to a remote server in the browser (OAuth), then connect it.
     * `open` shows or opens the link. Rejects when the sign-in fails or is
     * cancelled; the server keeps its status then.
     */
    private signingIn = new Map<string, { ac: AbortController; done: Promise<void> }>();

    async signIn(name: string, open: (url: string) => void | Promise<void>, signal?: AbortSignal): Promise<ServerState> {
        const st = this.servers.get(name);
        if (!st) throw new McpApprovalError(`There's no MCP server named "${name}" here.`, "unknown");
        if (transportOf(st.config) === "stdio") throw new McpApprovalError(`"${name}" runs on this computer: there's nothing to sign in to.`, "not_remote");
        if (!mayStart(st)) throw new McpApprovalError(`"${name}" isn't allowed to start${st.status === "needs-approval" ? " until you approve it" : ""}.`, "blocked");
        // One sign-in per server: a new one (the first link was lost, the window closed) replaces the one waiting,
        // which stops listening first, so a fixed callback port is free again.
        const prior = this.signingIn.get(name);
        prior?.ac.abort();
        await prior?.done;
        const ac = new AbortController();
        const run = oauthSignIn(name, st.config, { challenge: st.challenge, open, signal: signal ? AbortSignal.any([signal, ac.signal]) : ac.signal });
        const entry = { ac, done: run.then(() => undefined, () => undefined) };
        this.signingIn.set(name, entry);
        try {
            await run;
        } catch (e) {
            if (ac.signal.aborted && !signal?.aborted) throw new SignInReplaced();
            throw new McpError(maskConfigValues((e as Error).message, st.config));
        } finally {
            if (this.signingIn.get(name) === entry) this.signingIn.delete(name);
        }
        if (this.servers.get(name) !== st) return this.servers.get(name) ?? st;
        if (st.status === "disabled") st.status = "pending";
        await this.restart(name);
        return st;
    }

    /** Forget a remote server's OAuth tokens; it asks to sign in again the next time it connects. */
    async signOut(name: string): Promise<boolean> {
        const st = this.servers.get(name);
        if (!st) return false;
        const removed = oauthSignOut(name, st.config);
        if (removed && st.status !== "disabled" && mayStart(st)) await this.restart(name);
        return removed;
    }

    /** Signed in (OAuth tokens stored) for this server. */
    signedIn(name: string): boolean {
        const st = this.servers.get(name);
        return Boolean(st && hasOAuthTokens(name, st.config));
    }

    async restart(name: string) {
        const st = this.servers.get(name);
        if (!st) return;
        const old = st.client;
        await old?.close();
        // Another restart may have started a newer client meanwhile: start() replaces it, closing it.
        if (st.client === old) st.client = undefined;
        await this.start(st);
    }

    /** Start again every server `match` picks that's running or failed (its program changed on disk, though its configuration didn't). */
    async restartWhere(match: (name: string) => boolean): Promise<void> {
        await Promise.all([...this.servers.values()].filter((s) => match(s.name) && ["connecting", "connected", "failed"].includes(s.status)).map((s) => this.restart(s.name)));
    }

    /** Turned back on after "disable for this session", once settings and .mcp.json are read again (the other front end may have rejected it since). */
    async enable(name: string): Promise<void> {
        await this.refresh();
        const st = this.servers.get(name);
        if (!st || st.status !== "disabled" || !mayStart(st)) return;
        st.status = "pending";
        await this.start(st);
    }

    /**
     * Read the configuration again, then start the server afresh if it may
     * run. One whose .mcp.json entry changed since it was approved asks again
     * instead (and stays off).
     */
    async reconnect(name: string): Promise<ServerState> {
        await this.refresh();
        const st = this.servers.get(name);
        if (!st) throw new McpApprovalError(`There's no MCP server named "${name}" here.`, "unknown");
        if (mayStart(st) && st.status !== "disabled") await this.restart(name);
        return st;
    }

    private projectServer(name: string): ServerState {
        if (!this.trusted) throw new McpApprovalError("This folder isn't trusted, so its .mcp.json isn't read and its servers can't be approved. Trust the folder first.", "untrusted");
        const st = this.servers.get(name);
        if (!st) throw new McpApprovalError(`There's no MCP server named "${name}" here.`, "unknown");
        if (st.source !== "project" || !st.approval) throw new McpApprovalError(`"${name}" comes from your settings, not from .mcp.json: it doesn't need approving.`, "not_project");
        return st;
    }

    /**
     * Approve exactly the configuration with this fingerprint (what the user
     * was shown), after reading .mcp.json again: if it changed in between,
     * nothing is saved ("changed"). Saved to the folder's local settings.
     * Returns the server, ready for start().
     */
    async approve(name: string, fingerprint: string): Promise<ServerState> {
        await this.refresh();
        const st = this.projectServer(name);
        const a = st.approval!;
        if (a.state === "approved") throw new McpApprovalError(`"${name}" is already approved.`, "not_needed");
        // Its saved approval wouldn't count until then.
        if (a.reason === "unreadable") throw new McpApprovalError(approvalReason(a)!, "blocked");
        // Trusted for this session only, for having had nothing to protect when it was opened, isn't the user's say-so.
        if (!trustedByUser(this.cwd)) throw new McpApprovalError("You haven't trusted this folder yourself: Cavvy trusted it for this session only, because it had nothing to protect when it was opened. Trust the folder first, then approve its servers.", "needs_trust");
        if (st.config.disabled === true) throw new McpApprovalError(`"${name}" is turned off in .mcp.json ("disabled": true).`, "blocked");
        if (a.fingerprint !== fingerprint) throw new McpApprovalError(`What "${name}" runs changed since it was shown to you. Look at it again before approving.`, "changed");
        saveApproval(this.cwd, name, a.fingerprint);
        await this.refresh();
        const now = this.servers.get(name);
        if (now?.approval?.state !== "approved") throw new McpApprovalError(`"${name}" is still rejected in your user settings (disabledMcpjsonServers).`, "blocked");
        return now;
    }

    /** Rejected by name: it stays off (and stops) until approved again. */
    async reject(name: string): Promise<void> {
        await this.refresh();
        const st = this.projectServer(name);
        if (st.approval!.state === "rejected") return;
        saveRejection(this.cwd, name);
        await this.refresh();
    }

    /** The approval taken back: the server stops and asks again. */
    async revoke(name: string): Promise<void> {
        await this.refresh();
        const st = this.projectServer(name);
        const a = st.approval!;
        if (a.state !== "approved") throw new McpApprovalError(`"${name}" isn't approved.`, "not_needed");
        if (a.viaAll) throw new McpApprovalError(`"${name}" is approved by enableAllProjectMcpServers in your settings. Turn that off to approve servers one by one, or reject this one.`, "blocked");
        removeApproval(this.cwd, name);
        await this.refresh();
        if (this.servers.get(name)?.approval?.state === "approved") throw new McpApprovalError(`"${name}" is still approved in your user settings (approvedMcpjsonServers). Remove it there.`, "blocked");
    }

    async closeAll() {
        await Promise.all([...this.servers.values()].map((s) => s.client?.close()));
    }

    /** Cavvy tool wrappers for every connected server's tools. */
    tools(): Tool<any>[] {
        const out: Tool<any>[] = [];
        const self = this;
        for (const st of this.servers.values()) {
            if (st.status !== "connected" || !st.client) continue;
            const client = st.client;
            // Tools whose names clean (or truncate) to the same string all get a
            // suffix derived from their real name, so a name (and any rule that
            // approved it) stays with one tool whatever order the server lists them in.
            const base = new Map<string, number>();
            for (const t of st.tools) base.set(toolNameFor(st.name, t.name), (base.get(toolNameFor(st.name, t.name)) ?? 0) + 1);
            for (const t of st.tools) {
                let name = toolNameFor(st.name, t.name);
                if ((base.get(name) ?? 0) > 1) name = `${name.slice(0, 64 - 9)}_${createHash("sha256").update(t.name).digest("hex").slice(0, 8)}`;
                const readOnly = t.annotations?.readOnlyHint === true;
                // Everything the server says about its tools is masked for its own env and headers, as its results are.
                const label = maskConfigValues(t.title ?? t.annotations?.title ?? t.name, st.config);
                out.push({
                    name,
                    category: "mcp",
                    readOnly,
                    description: `${(t.description === undefined ? label : maskConfigValues(t.description, st.config)).slice(0, 4000)}\n\n(MCP tool "${maskConfigValues(t.name, st.config)}" from server "${st.name}")`,
                    parameters: sanitizeSchema(maskMcpSchema(t.inputSchema, st.config)),
                    title: (input: Record<string, unknown>) => {
                        const arg = Object.values(input ?? {}).find((v) => typeof v === "string") as string | undefined;
                        return `${st.name} - ${label}${arg ? `(${arg.slice(0, 60)})` : ""}`;
                    },
                    async run(input: Record<string, unknown>, ctx): Promise<ToolResult> {
                        // Revoked, rejected or restarted since this tool was listed (say, while its call waited for permission).
                        if (st.client !== client || self.servers.get(st.name) !== st || !mayStart(st) || !self.stillApproved(st)) return { content: `MCP server ${st.name} isn't running any more.`, isError: true };
                        try {
                            const r = await client.callTool(t.name, input ?? {}, ctx.signal, undefined, self.inputFor(st, { askQuestion: ctx.ui?.askQuestion?.bind(ctx.ui), sample: ctx.sample }));
                            // Structured data must be masked before JSON serialization escapes its strings and keys.
                            const f = formatMcpResult({ ...r, structuredContent: maskConfigDeep(r.structuredContent, st.config) });
                            // Formatting includes URIs and MIME types too; mask before truncation can split a secret.
                            const content = truncateMiddle(maskConfigValues(f.content, st.config), MAX_OUTPUT);
                            return {
                                content: content || "(no output)",
                                images: f.images.length ? f.images : undefined,
                                isError: r.isError,
                                display: { summary: r.isError ? "Error" : `${content.split("\n").length} lines${f.images.length ? `, ${f.images.length} image(s)` : ""}` },
                            };
                        } catch (e) {
                            if (self.authLost(st, client, e)) return { content: `MCP server ${st.name} needs signing in again. Ask the user to sign in with /mcp, then try again.`, isError: true };
                            return { content: `MCP error from ${st.name}: ${maskConfigValues((e as Error).message, st.config)}`, isError: true };
                        }
                    },
                });
            }
        }
        if (this.resourceServers().length) out.push(...this.resourceTools());
        return out;
    }

    /**
     * A connected server that stops accepting its token (revoked, expired with no refresh) needs
     * signing in again, as one that refused it at start does: the same status, so /mcp and the GUI offer it.
     */
    private authLost(st: ServerState, client: McpClient, e: unknown): e is McpAuthError {
        if (!(e instanceof McpAuthError)) return false;
        if (st.client !== client || this.servers.get(st.name) !== st) return true;
        st.status = "needs-auth";
        st.challenge = e.challenge;
        st.error = maskConfigValues(e.message, st.config);
        st.client = undefined;
        void client.close();
        this.onChange?.();
        return true;
    }

    /** What a server asks of the user while one of its requests is open, through `asker` (masked for its own configuration). */
    inputFor(st: ServerState, asker: McpAsker) {
        if (!this.interactive) return undefined;
        return mcpInput(visibleName(st.name), {
            ...asker,
            askQuestion: asker.askQuestion && ((q, options, multi) => asker.askQuestion!(maskConfigValues(q, st.config), options.map((o) => ({ ...o, label: maskConfigValues(o.label, st.config), ...(o.description ? { description: maskConfigValues(o.description, st.config) } : {}) })), multi)),
        });
    }

    /** Connected servers that offer resources, including unlisted links returned by tools. */
    resourceServers(): ServerState[] {
        return [...this.servers.values()].filter((s) => s.status === "connected" && s.client && (s.resources?.length || s.templates?.length || s.client.offers("resources")));
    }

    /** Every connected server's resources, for @-mention menus: `mention` is what to type after the @. */
    resourceList(): ResourceEntry[] {
        const out: ResourceEntry[] = [];
        for (const st of this.resourceServers()) {
            const list = st.resources ?? [];
            // Masked once per list the server sends, not on every keystroke of a menu.
            let entries = this.listed.get(list);
            if (!entries) {
                // A URI with a configured secret in it can't be put in a prompt (or shown): not offered for @.
                entries = list.filter((r) => maskConfigValues(r.uri, st.config) === r.uri).map((r) => ({ server: st.name, uri: r.uri, name: maskConfigValues(r.name || r.uri, st.config), title: r.title ? maskConfigValues(r.title, st.config) : undefined, description: r.description ? maskConfigValues(r.description, st.config).slice(0, 300) : undefined, mimeType: r.mimeType, mention: `${st.name}:${r.uri}` }));
                this.listed.set(list, entries);
            }
            out.push(...entries);
        }
        return out;
    }
    private listed = new WeakMap<McpResource[], ResourceEntry[]>();

    /**
     * Read a resource and format it for the model: text (masked, capped)
     * and images. Throws an McpError the caller shows (unknown server, not
     * connected, refused, timed out).
     */
    async readResource(server: string, uri: string, asker: McpAsker, signal?: AbortSignal): Promise<{ text: string; images: ImagePart[]; uri: string }> {
        const st = this.servers.get(server);
        if (!st) throw new McpError(`There's no MCP server named "${server}".`);
        if (st.status !== "connected" || !st.client || !mayStart(st) || !this.stillApproved(st)) throw new McpError(`MCP server ${server} isn't connected${st.status === "needs-auth" ? " (sign in with /mcp)" : ""}.`);
        const client = st.client;
        const contents = await client.readResource(uri, { signal, input: this.inputFor(st, asker) }).catch((e) => {
            throw this.authLost(st, client, e) ? new McpError(`MCP server ${server} needs signing in again (sign in with /mcp).`) : maskedError(e, st.config);
        });
        const f = formatResourceContents(contents);
        return { text: truncateMiddle(maskConfigValues(f.text, st.config), MAX_OUTPUT), images: f.images, uri: maskConfigValues(uri, st.config) };
    }

    /** The two tools that let the model find and read resources. */
    private resourceTools(): Tool<any>[] {
        const self = this;
        const servers = () => this.resourceServers();
        return [
            {
                name: "ListMcpResources",
                category: "meta",
                readOnly: true,
                description: "List the resources connected MCP servers offer (files, records, documents), with their URIs and resource templates. Read one with ReadMcpResource.",
                parameters: { type: "object", properties: { server: { type: "string", description: "Only this server's resources" } } },
                title: (input: { server?: string }) => `List MCP resources${input?.server ? ` (${input.server})` : ""}`,
                async run(input: { server?: string }): Promise<ToolResult> {
                    const list = servers().filter((s) => !input?.server || s.name === input.server);
                    if (!list.length) return { content: input?.server ? `No connected MCP server named "${input.server}" offers resources.` : "No connected MCP server offers resources.", isError: Boolean(input?.server) };
                    const lines: string[] = [];
                    for (const st of list) {
                        const own: string[] = [`## ${st.name}`];
                        for (const r of st.resources ?? []) own.push(`- ${r.uri}${r.title || r.name ? ` (${r.title ?? r.name})` : ""}${r.mimeType ? ` [${r.mimeType}]` : ""}${r.description ? `: ${r.description.split("\n")[0]!.slice(0, 200)}` : ""}`);
                        for (const t of st.templates ?? []) own.push(`- template ${t.uriTemplate}${t.title || t.name ? ` (${t.title ?? t.name})` : ""}${t.description ? `: ${t.description.split("\n")[0]!.slice(0, 200)}` : ""}`);
                        // Each server's lines masked for its own configuration.
                        lines.push(maskConfigValues(own.join("\n"), st.config));
                    }
                    const count = list.reduce((n, s) => n + (s.resources?.length ?? 0), 0);
                    return { content: truncateMiddle(lines.join("\n\n"), MAX_OUTPUT), display: { summary: `${count} resource${count === 1 ? "" : "s"}` } };
                },
            },
            {
                name: "ReadMcpResource",
                category: "mcp",
                readOnly: true,
                description: "Read one resource from a connected MCP server by its URI (from ListMcpResources, a resource link returned by a tool, or a template filled in).",
                parameters: { type: "object", properties: { server: { type: "string", description: "The MCP server's name" }, uri: { type: "string", description: "The resource URI" } }, required: ["server", "uri"] },
                title: (input: { server?: string; uri?: string }) => `Read MCP resource ${input?.server ?? ""}:${(input?.uri ?? "").slice(0, 80)}`,
                async run(input: { server: string; uri: string }, ctx): Promise<ToolResult> {
                    try {
                        const r = await self.readResource(String(input?.server ?? ""), String(input?.uri ?? ""), { askQuestion: ctx.ui?.askQuestion?.bind(ctx.ui), sample: ctx.sample }, ctx.signal);
                        return { content: r.text || "(empty resource)", images: r.images.length ? r.images : undefined, display: { summary: `${r.text.split("\n").length} lines${r.images.length ? `, ${r.images.length} image(s)` : ""}` } };
                    } catch (e) {
                        return { content: `Couldn't read ${input?.uri} from ${input?.server}: ${(e as Error).message}`, isError: true };
                    }
                },
            },
        ];
    }

    /**
     * Every connected server's prompts as slash commands: mcp__<server>__<prompt>,
     * names that clean to the same command suffixed so each stays reachable.
     */
    promptCommands(): { command: string; server: string; prompt: McpPrompt; description: string; args?: string }[] {
        const out: ReturnType<McpManager["promptCommands"]> = [];
        const seen = new Map<string, number>();
        for (const st of this.servers.values()) {
            if (st.status !== "connected" || !st.client) continue;
            for (const p of st.prompts ?? []) {
                // A name becomes a command anyone sees unmasked: one holding a configured secret is left out, as a tool's is.
                if (hasConfigValue(p.name, st.config)) continue;
                let command = `mcp__${serverSegment(st.name)}__${clean(p.name)}`.toLowerCase();
                const n = seen.get(command) ?? 0;
                seen.set(command, n + 1);
                if (n) command = `${command}_${createHash("sha256").update(`${st.name}\0${p.name}`).digest("hex").slice(0, 6)}`;
                const args = (p.arguments ?? []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
                const what = maskConfigValues(p.description ?? p.title ?? p.name, st.config).split("\n")[0]!.slice(0, 200);
                out.push({ command, server: st.name, prompt: p, description: `${what} (MCP prompt from ${st.name})`, args: args ? maskConfigValues(args, st.config) : undefined });
            }
        }
        return out;
    }

    /**
     * Run a prompt command: its arguments from `argText` (in order, quotes
     * group words; the last one takes the rest), then the server's messages
     * as one prompt. Throws an McpError with a usage line when a required
     * argument is missing.
     */
    async runPrompt(command: string, argText: string, asker: McpAsker, signal?: AbortSignal): Promise<{ text: string; images: ImagePart[] }> {
        const pc = this.promptCommands().find((c) => c.command === command.toLowerCase());
        if (!pc) throw new McpError(`There's no MCP prompt /${command}.`);
        const st = this.servers.get(pc.server)!;
        if (!st.client || !mayStart(st) || !this.stillApproved(st)) throw new McpError(`MCP server ${pc.server} isn't connected.`);
        const defs = pc.prompt.arguments ?? [];
        const words = splitArgs(argText, defs.length);
        const args: Record<string, string> = {};
        defs.forEach((a, i) => {
            if (words[i] !== undefined && words[i] !== "") args[a.name] = words[i]!;
        });
        const missing = defs.filter((a) => a.required && args[a.name] === undefined);
        if (missing.length) throw new McpError(`/${pc.command} needs ${missing.map((a) => a.name).join(", ")}. Usage: /${pc.command} ${pc.args ?? ""}`.trim());
        const client = st.client;
        const r = await client.getPrompt(pc.prompt.name, args, { signal, input: this.inputFor(st, asker) }).catch((e) => {
            throw this.authLost(st, client, e) ? new McpError(`MCP server ${pc.server} needs signing in again (sign in with /mcp).`) : maskedError(e, st.config);
        });
        const f = formatPromptMessages(r.messages);
        if (!f.text.trim() && !f.images.length) throw new McpError(`${pc.server}'s prompt ${pc.prompt.name} came back empty.`);
        return { text: truncateMiddle(maskConfigValues(f.text, st.config), MAX_OUTPUT), images: f.images };
    }

    instructions(): string {
        const parts: string[] = [];
        for (const st of this.servers.values()) {
            const ins = st.client?.instructions?.trim();
            if (st.status === "connected" && ins) parts.push(`## ${st.name}\n${maskConfigValues(ins, st.config).slice(0, 4000)}`);
        }
        return parts.length ? `# MCP server instructions\nThese come from the connected MCP servers and describe how to use their tools.\n\n${parts.join("\n\n")}` : "";
    }

    /** What `name` runs and where it stands, as both front ends show it (secrets masked, bounded). */
    describe(name: string): McpServerInfo | undefined {
        const st = this.servers.get(name);
        return st && this.withSignIn(describeServer(st, this.cwd), st);
    }

    /** Whether there's a sign-in to sign out of (remote servers only; it reads the token file, which is cached). */
    private withSignIn(info: McpServerInfo, st: ServerState): McpServerInfo {
        return info.transport !== "stdio" && hasOAuthTokens(st.name, st.config) ? { ...info, signedIn: true } : info;
    }

    /**
     * Every server, described, within a size budget: past it, servers come as
     * summaries (`partial`; ask for one with describe()), and past MAX_LISTED
     * they're left out and counted.
     */
    list(): { servers: McpServerInfo[]; omitted: number } {
        const all = [...this.servers.values()];
        const servers: McpServerInfo[] = [];
        let size = 0;
        for (const st of all.slice(0, MAX_LISTED)) {
            const full = this.withSignIn(describeServer(st, this.cwd), st);
            const n = JSON.stringify(full).length;
            if (size + n <= LIST_BUDGET) {
                servers.push(full);
                size += n;
                continue;
            }
            const { name, label, source, status, tools, transport, approval, disabledInFile, signedIn } = full;
            const summary: McpServerInfo = { name, label, source, status, tools, transport, approval, disabledInFile, ...(signedIn ? { signedIn } : {}), partial: true };
            const m = JSON.stringify(summary).length;
            // Summaries count too; past twice the budget, the rest are only counted.
            if (size + m > 2 * LIST_BUDGET) break;
            servers.push(summary);
            size += m;
        }
        return { servers, omitted: all.length - servers.length + this.skipped };
    }

    needsApproval(): ServerState[] {
        return [...this.servers.values()].filter((s) => s.status === "needs-approval");
    }
}

/** A server name as shown in questions: invisible characters made visible. */
function visibleName(name: string): string {
    return name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, (c) => `⟨U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`).slice(0, 100);
}

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

/** A resource's contents as text for the model, images as image parts; other binaries named, not attached. */
/** A server's error as shown: masked for its own configuration, as its results are. */
function maskedError(e: unknown, config: McpServerConfig): Error {
    if (!(e instanceof Error)) return new McpError(maskConfigValues(String(e), config));
    e.message = maskConfigValues(e.message, config);
    return e;
}

export function formatResourceContents(contents: McpResourceContents[]): { text: string; images: ImagePart[] } {
    const texts: string[] = [];
    const images: ImagePart[] = [];
    for (const c of contents) {
        if (typeof c.text === "string") texts.push(contents.length > 1 ? `${c.uri}:\n${c.text}` : c.text);
        else if (typeof c.blob === "string" && c.mimeType && IMAGE_TYPES.test(c.mimeType)) images.push({ type: "image", mediaType: c.mimeType, data: c.blob });
        else if (typeof c.blob === "string") texts.push(`[binary resource ${c.uri}${c.mimeType ? ` (${c.mimeType})` : ""}, ${Math.round((c.blob.length * 3) / 4 / 1024)} KB, not attached]`);
    }
    return { text: texts.join("\n\n"), images };
}

/** A prompt's messages as one prompt: the assistant's parts marked as such, resources inlined, images attached. */
export function formatPromptMessages(messages: { role: "user" | "assistant"; content: McpContent }[]): { text: string; images: ImagePart[] } {
    const parts: string[] = [];
    const images: ImagePart[] = [];
    const multiRole = messages.some((m) => m.role === "assistant");
    for (const m of messages) {
        const r = formatMcpResult({ content: [m.content] });
        images.push(...r.images);
        if (r.content) parts.push(multiRole ? `${m.role === "assistant" ? "Assistant" : "User"}: ${r.content}` : r.content);
    }
    return { text: parts.join("\n\n"), images };
}

/** Words of a command line, quotes grouping; past `max - 1` words the rest is the last argument. */
export function splitArgs(text: string, max: number): string[] {
    const out: string[] = [];
    let rest = text.trim();
    while (rest && out.length < Math.max(max, 1) - 1) {
        const m = rest.match(/^"((?:[^"\\]|\\.)*)"\s*|^'([^']*)'\s*|^(\S+)\s*/);
        if (!m) break;
        out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3])!);
        rest = rest.slice(m[0].length);
    }
    if (rest) out.push(/^"(.*)"$/s.test(rest) || /^'(.*)'$/s.test(rest) ? rest.slice(1, -1) : rest);
    return out;
}
