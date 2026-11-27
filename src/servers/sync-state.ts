// Structured state synced from this machine to its servers (settings, remote plugins, custom providers,
// agent CLI + named account topology, and opt-in Cavvy API keys / remote MCP secrets).
//
// Policy & safety invariants:
//   - CLI subscription credentials (Claude Code, Codex, OpenCode, Grok, Antigravity) are NEVER read,
//     stored, copied or transmitted. Only non-secret CLI topology (which CLIs are on and managed account
//     names/ids/default) syncs, so each server keeps its own independent login.
//   - Cavvy API keys and MCP secrets are NEVER included unless `includeSecrets` is explicitly enabled
//     for that server. Even then, only Cavvy-owned API/search keys stored in keychain/credentials.json
//     (never ambient env vars, never a CLI's own sign-in token) are synced, bound to their effective
//     endpoint URL, and only their sha256 hashes are recorded in synced-state.json. Turned off again,
//     the keys and secrets sync put on the server are removed from it.
//   - Permission rules stay strictly portable in all modes; MCP servers stay restricted to public remote
//     URLs or portable package runners; custom provider and marketplace URLs must carry no credentials,
//     query strings, or local hosts.
//   - Pre-existing server files, rules, accounts, plugins, keys and machine-local settings are never adopted
//     as sync-owned or overwritten on conflict.

import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { forgetCachedKeys, getKey, removeKey, setKey, storedKey } from "../auth/credentials";
import { checkAgentCli } from "../backends";
import { findCli } from "../backends/cli";
import { AGENT_CLIS, agentCli } from "../backends/defs";
import { cavvyHome, paths } from "../config/paths";
import { loadScope, loadScopeChecked, readJsonForUpdate, updateSettings, type Effort, type McpServerConfig, type Settings } from "../config/settings";
import { enablePlugin, installPlugin, uninstallPlugin, updatePlugin } from "../plugins/install";
import { addMarketplace, forgetMarketplace, updateMarketplace } from "../plugins/marketplaces";
import { pluginPaths, readInstalled, readKnownMarketplaces, splitId, type MarketplaceSource } from "../plugins/store";
import { ACCOUNT_PROVIDERS, addAccount, listAccounts, removeAccount, renameAccount, setDefaultAccount } from "../providers/accounts";
import { allProviders, BUILTIN_PROVIDERS, customEnvKey, readAgentConfig, readProvidersFileForUpdate, readVertexConfig, removeAgentConfig, resolveBaseUrl, SEARCH_PROVIDERS, validGoogleAccount, validVertexLocation, validVertexProject, writeProvidersFile, type CustomProviderEntry, type VertexConfig } from "../providers/registry";
import { matchesSecretPattern } from "../util/secret-patterns";
import { CLI_SIGN_IN_TOKEN, isProtectedCredentialPath, localHost, packageSpec, portableMcpEntry, portableRule, RUNNER_FLAGS, RUNNERS, SETTINGS_KEYS, SUBSCRIPTION_OAUTH_TOKEN } from "./copy";
import { syncTo, type SyncFilesResult } from "./sync";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const stableJson = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
    const entries = Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableJson(x)}`).join(",")}}`;
};
const hashVal = (v: unknown) => sha(stableJson(v));

export type RemoteMarketplaceSource = Exclude<MarketplaceSource, { source: "directory" } | { source: "file" }>;

export interface SyncedMarketplace {
    name: string;
    source: RemoteMarketplaceSource;
    gitCommitSha?: string;
}

export interface SyncedPlugin {
    id: string;
    /** Undefined when sender's settings.json was unreadable, so server's enablement is left untouched. */
    enabled?: boolean;
    version: string;
    gitCommitSha?: string;
}

export interface SyncedAgentCli {
    id: string;
    /** Managed named accounts only (never external paths, never credentials). */
    accounts: { id: string; name: string }[];
    defaultAccount?: string;
}

export interface SyncedApiKey {
    value: string;
    /** Effective provider endpoint this key belongs to, so a key is never installed onto a different endpoint. */
    endpoint: string;
}

export interface SyncStatePayload {
    /** Omitted when the sender's settings file was unreadable, so server settings are left alone. */
    settings?: Record<string, unknown>;
    permissions?: { allow: string[]; ask: string[]; deny: string[] };
    mcpServers?: Record<string, McpServerConfig>;
    /** Omitted when the sender's plugin manifests were unreadable, so server plugins are left alone. */
    marketplaces?: SyncedMarketplace[];
    plugins?: SyncedPlugin[];
    /** Omitted when the sender's providers file was unreadable, so server providers are left alone. */
    customProviders?: CustomProviderEntry[];
    vertex?: VertexConfig;
    agents?: SyncedAgentCli[];
    /** Present ONLY when `includeSecrets` is true; contains Cavvy API/search keys only (never CLI tokens). */
    apiKeys?: Record<string, SyncedApiKey>;
    includeSecrets?: boolean;
}

export interface SyncNeedsSignIn {
    provider: string;
    accountId: string;
    name: string;
}

export interface SyncRemoteStateStatus {
    digest?: string;
    missingClis: string[];
    needsSignIn: SyncNeedsSignIn[];
}

export interface ApplyStateResult {
    settingsChanged: number;
    providersChanged: number;
    keysChanged: number;
    pluginsChanged: number;
    accountsAdded: number;
    /** Provider IDs whose API keys or custom definitions changed (so running sessions reload their clients). */
    changedProviders: string[];
    /** Plugin IDs whose installed files changed on update (so running plugin MCP servers restart). */
    restartedPlugins: string[];
    missingClis: string[];
    needsSignIn: SyncNeedsSignIn[];
    warnings: string[];
    /** Providers whose synced key was to be taken off this server and is still there. */
    keysLeft?: string[];
}

export interface SyncStateSummary {
    unsupported?: boolean;
    unchanged?: boolean;
    missingClis?: string[];
    needsSignIn?: SyncNeedsSignIn[];
    result?: ApplyStateResult;
}

/** Env variable names that select or inject CLI subscription auth must never be carried in MCP env. */
const BLOCKED_CLI_ENV_NAME = /^(CLAUDE_CODE_OAUTH|CLAUDE_CONFIG_DIR|CLAUDE_SECURESTORAGE|CODEX_HOME|ANTHROPIC_AUTH_TOKEN)/i;
const SAFE_GIT_REF = /^[A-Za-z0-9._/@+-]{1,200}$/;

/** Public remote URL with no embedded credentials, query string, hash, subscription token, or local/private host. */
export function isSafeRemoteUrl(raw: unknown, protocols: readonly string[] = ["https:", "http:"]): boolean {
    if (typeof raw !== "string" || raw.length > 500 || SUBSCRIPTION_OAUTH_TOKEN.test(raw)) return false;
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return false;
    }
    if (!protocols.includes(u.protocol)) return false;
    if (u.username || u.password || u.search || u.hash || localHost(u.hostname)) return false;
    return true;
}

function sanitizeMarketplaceSource(s: unknown): RemoteMarketplaceSource | undefined {
    if (!s || typeof s !== "object") return undefined;
    const x = s as Record<string, unknown>;
    if (x.source === "github") {
        if (typeof x.repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(x.repo)) return undefined;
        const ref = typeof x.ref === "string" && SAFE_GIT_REF.test(x.ref) && !x.ref.startsWith("-") ? x.ref : undefined;
        return { source: "github", repo: x.repo, ...(ref ? { ref } : {}) };
    }
    if (x.source === "git") {
        if (!isSafeRemoteUrl(x.url, ["https:", "http:"])) return undefined;
        const ref = typeof x.ref === "string" && SAFE_GIT_REF.test(x.ref) && !x.ref.startsWith("-") ? x.ref : undefined;
        return { source: "git", url: x.url as string, ...(ref ? { ref } : {}) };
    }
    if (x.source === "url") {
        if (!isSafeRemoteUrl(x.url, ["https:"])) return undefined;
        return { source: "url", url: x.url as string };
    }
    return undefined;
}

/**
 * An MCP server entry sanitized for opt-in secrets sync: allows env, headers, and oauth secrets on
 * public remote URLs or portable package runners (`npx`, `bunx`, `uvx`, `pnpm dlx`, `yarn dlx`, `pipx run`),
 * while refusing local hosts, machine-local commands/cwd, plugin entries, and CLI subscription credentials.
 */
export function secretMcpEntry(c: McpServerConfig): McpServerConfig | undefined {
    if (!c || typeof c !== "object" || c.plugin || c.cwd) return undefined;
    const out: McpServerConfig = {};
    if (typeof c.type === "string" && ["stdio", "http", "streamable-http", "sse", "ws"].includes(c.type)) out.type = c.type;
    if (c.disabled === true) out.disabled = true;

    if (c.url) {
        if (c.command || c.args !== undefined || !isSafeRemoteUrl(c.url, ["https:", "http:", "wss:", "ws:"])) return undefined;
        out.url = c.url;
    } else {
        if (typeof c.command !== "string" || !Object.hasOwn(RUNNERS, c.command)) return undefined;
        if (!Array.isArray(c.args) || !c.args.every((a) => typeof a === "string")) return undefined;
        const first = RUNNERS[c.command];
        const rest = first === undefined ? c.args : c.args[0] === first ? c.args.slice(1) : undefined;
        if (!rest?.length || !rest.slice(0, -1).every((a) => RUNNER_FLAGS.has(a)) || !packageSpec(rest.at(-1)!)) return undefined;
        out.command = c.command;
        out.args = [...c.args];
    }

    if (c.env && typeof c.env === "object" && !Array.isArray(c.env)) {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(c.env)) {
            if (typeof v !== "string") continue;
            if (BLOCKED_CLI_ENV_NAME.test(k) || CLI_SIGN_IN_TOKEN.test(v)) return undefined;
            env[k] = v;
        }
        if (Object.keys(env).length) out.env = env;
    }
    if (c.headers && typeof c.headers === "object" && !Array.isArray(c.headers)) {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(c.headers)) {
            if (typeof v !== "string") continue;
            if (CLI_SIGN_IN_TOKEN.test(v)) return undefined;
            headers[k] = v;
        }
        if (Object.keys(headers).length) out.headers = headers;
    }
    if (c.oauth && typeof c.oauth === "object") {
        const o = c.oauth;
        const oauth: NonNullable<McpServerConfig["oauth"]> = {};
        if (typeof o.clientId === "string" && o.clientId.length <= 200) {
            if (CLI_SIGN_IN_TOKEN.test(o.clientId)) return undefined;
            oauth.clientId = o.clientId;
        }
        if (typeof o.clientSecret === "string" && o.clientSecret.length <= 500) {
            if (CLI_SIGN_IN_TOKEN.test(o.clientSecret)) return undefined;
            oauth.clientSecret = o.clientSecret;
        }
        if (typeof o.callbackPort === "number") oauth.callbackPort = o.callbackPort;
        if (typeof o.scopes === "string") {
            if (CLI_SIGN_IN_TOKEN.test(o.scopes)) return undefined;
            oauth.scopes = o.scopes;
        } else if (Array.isArray(o.scopes) && o.scopes.every((x) => typeof x === "string")) {
            if (o.scopes.some((x) => CLI_SIGN_IN_TOKEN.test(x))) return undefined;
            oauth.scopes = o.scopes;
        }
        if (Object.keys(oauth).length) out.oauth = oauth;
    }
    // Check the complete reconstructed entry (args, env names, header names, oauth, url) for subscription tokens.
    if (CLI_SIGN_IN_TOKEN.test(JSON.stringify(out))) return undefined;
    return out;
}

function sanitizeCustomProvider(c: CustomProviderEntry, includeSecrets: boolean): CustomProviderEntry | undefined {
    if (!c || typeof c !== "object" || typeof c.id !== "string" || typeof c.name !== "string") return undefined;
    if (!/^[a-z0-9][a-z0-9._-]{0,47}$/i.test(c.id)) return undefined;
    if (!isSafeRemoteUrl(c.baseUrl, ["https:", "http:"])) return undefined;
    const out: CustomProviderEntry = {
        id: c.id,
        name: c.name,
        baseUrl: c.baseUrl.replace(/\/+$/, ""),
        ...(c.kind === "anthropic" || c.kind === "openai" || c.kind === "responses" ? { kind: c.kind } : {}),
        ...(typeof c.requiresKey === "boolean" ? { requiresKey: c.requiresKey } : {}),
        ...(Array.isArray(c.models) ? { models: c.models.filter((m): m is string => typeof m === "string") } : {}),
        ...(c.maxTokensField === "max_tokens" || c.maxTokensField === "max_completion_tokens" ? { maxTokensField: c.maxTokensField } : {}),
        ...(typeof c.deepseekCompat === "boolean" ? { deepseekCompat: c.deepseekCompat } : {}),
        ...(c.modelEffortLevels && typeof c.modelEffortLevels === "object" ? { modelEffortLevels: c.modelEffortLevels as Record<string, Effort[]> } : {}),
    };
    if (includeSecrets && c.headers && typeof c.headers === "object") {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(c.headers)) {
            if (typeof v !== "string") continue;
            if (CLI_SIGN_IN_TOKEN.test(v)) return undefined;
            headers[k] = v;
        }
        if (Object.keys(headers).length) out.headers = headers;
    }
    return out;
}

/** Effective endpoint URL for an API or search provider on this machine (validated to be a safe remote URL). */
function effectiveEndpoint(id: string, customList: readonly CustomProviderEntry[]): string | undefined {
    if (SEARCH_PROVIDERS.some((s) => s.id === id)) return `search:${id}`;
    const builtin = BUILTIN_PROVIDERS.find((p) => p.id === id);
    if (builtin) {
        if (builtin.auth === "cli" || builtin.auth === "gcloud" || builtin.local) return undefined;
        const url = resolveBaseUrl(builtin);
        return isSafeRemoteUrl(url, ["https:", "http:"]) ? url.replace(/\/+$/, "") : undefined;
    }
    const custom = customList.find((c) => c.id === id);
    if (custom && isSafeRemoteUrl(custom.baseUrl, ["https:", "http:"])) return custom.baseUrl.replace(/\/+$/, "");
    return undefined;
}

/** Collects this machine's syncable settings, plugins, provider topology, and (when opted in) Cavvy API keys. */
export async function localSyncState(o: { includeSecrets?: boolean } = {}): Promise<SyncStatePayload> {
    const includeSecrets = o.includeSecrets === true;

    // Never open settings.json if it was symlinked or hard-linked to a protected CLI credential file.
    const settingsFile = paths.userSettings();
    const settingsBlocked = existsSync(settingsFile) && isProtectedCredentialPath(settingsFile);
    const checkedSettings = settingsBlocked ? { settings: {} as Settings, unreadable: true } : loadScopeChecked("user", homedir());
    let settings: Record<string, unknown> | undefined;
    let permissions: { allow: string[]; ask: string[]; deny: string[] } | undefined;
    let mcpServers: Record<string, McpServerConfig> | undefined;
    const enabledMap = !checkedSettings.unreadable && checkedSettings.settings.enabledPlugins && typeof checkedSettings.settings.enabledPlugins === "object" ? checkedSettings.settings.enabledPlugins : undefined;

    if (!checkedSettings.unreadable) {
        const user = checkedSettings.settings;
        settings = {};
        for (const k of SETTINGS_KEYS) {
            if (user[k] === undefined) continue;
            if (matchesSecretPattern(JSON.stringify(user[k]))) continue;
            settings[k] = user[k];
        }
        // Permission rules stay strictly portable in both modes.
        permissions = { allow: [], ask: [], deny: [] };
        for (const k of ["allow", "ask", "deny"] as const) {
            const all = (Array.isArray(user.permissions?.[k]) ? user.permissions![k]! : []).filter((r): r is string => typeof r === "string");
            permissions[k] = all.filter(portableRule);
        }
        mcpServers = {};
        for (const [name, cfg] of Object.entries(user.mcpServers ?? {})) {
            if (!cfg || typeof cfg !== "object") continue;
            const entry = includeSecrets ? secretMcpEntry(cfg) : portableMcpEntry(cfg);
            if (entry) mcpServers[name] = entry;
        }
    }

    // Checked read + shape validation of plugin manifests: unreadable, empty, or malformed manifests skip the plugin section.
    let marketplaces: SyncedMarketplace[] | undefined;
    let plugins: SyncedPlugin[] | undefined;
    let pluginsReadable = true;
    const isPlainObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
    try {
        const knownFile = pluginPaths.known();
        if (existsSync(knownFile)) {
            if (isProtectedCredentialPath(knownFile)) pluginsReadable = false;
            else {
                const parsed = readJsonForUpdate<unknown>(knownFile);
                if (!isPlainObj(parsed)) pluginsReadable = false;
            }
        }
        const installedFile = pluginPaths.installed();
        if (pluginsReadable && existsSync(installedFile)) {
            if (isProtectedCredentialPath(installedFile)) pluginsReadable = false;
            else {
                const parsed = readJsonForUpdate<unknown>(installedFile);
                if (!isPlainObj(parsed) || !isPlainObj(parsed.plugins)) pluginsReadable = false;
            }
        }
    } catch {
        pluginsReadable = false;
    }

    if (pluginsReadable) {
        const known = readKnownMarketplaces();
        marketplaces = [];
        const remoteNames = new Set<string>();
        for (const [name, m] of Object.entries(known).sort(([a], [b]) => a.localeCompare(b))) {
            const src = sanitizeMarketplaceSource(m.source);
            if (src) {
                marketplaces.push({ name, source: src, ...(m.gitCommitSha ? { gitCommitSha: m.gitCommitSha } : {}) });
                remoteNames.add(name);
            }
        }
        const installed = readInstalled();
        plugins = [];
        for (const [id, rec] of Object.entries(installed).sort(([a], [b]) => a.localeCompare(b))) {
            const { marketplace } = splitId(id);
            if (!marketplace || !remoteNames.has(marketplace)) continue;
            if (!rec.scopes.some((s) => s.scope === "user")) continue;
            // With readable settings.json, a missing enabledPlugins entry means disabled at user scope (loader.ts:78).
            // Reserve `undefined` strictly for unreadable settings.json so server enablement is preserved.
            const enabled = checkedSettings.unreadable ? undefined : Boolean(enabledMap && Object.hasOwn(enabledMap, id) && enabledMap[id] === true);
            plugins.push({
                id,
                ...(enabled !== undefined ? { enabled } : {}),
                version: rec.version,
                ...(rec.gitCommitSha ? { gitCommitSha: rec.gitCommitSha } : {}),
            });
        }
    }

    // Checked read of providers.json: a corrupt or credential-linked file skips the providers section.
    let customProviders: CustomProviderEntry[] | undefined;
    let vertex: VertexConfig | undefined;
    let agents: SyncedAgentCli[] | undefined;
    let apiKeys: Record<string, SyncedApiKey> | undefined;

    const providersFile = paths.providers();
    let providersReadable = !(existsSync(providersFile) && isProtectedCredentialPath(providersFile));
    let pf: ReturnType<typeof readProvidersFileForUpdate> = {};
    if (providersReadable) {
        try {
            pf = readProvidersFileForUpdate();
        } catch {
            providersReadable = false;
        }
    }

    if (providersReadable) {
        customProviders = (pf.custom ?? [])
            .map((c) => sanitizeCustomProvider(c, includeSecrets))
            .filter((c): c is CustomProviderEntry => c !== undefined)
            .sort((a, b) => a.id.localeCompare(b.id));

        vertex = readVertexConfig();

        agents = [];
        for (const def of AGENT_CLIS) {
            const cfg = readAgentConfig(def.id);
            if (!cfg) continue;
            const accounts = (cfg.accounts ?? [])
                .filter((a) => a.managed && !a.invalid)
                .map((a) => ({ id: a.id, name: a.name }))
                .sort((a, b) => a.id.localeCompare(b.id));
            const defaultAccount = cfg.defaultAccount === "default" || accounts.some((a) => a.id === cfg.defaultAccount) ? cfg.defaultAccount : undefined;
            agents.push({
                id: def.id,
                accounts,
                ...(defaultAccount ? { defaultAccount } : {}),
            });
        }

        if (includeSecrets) {
            apiKeys = {};
            forgetCachedKeys();
            const ids = [
                ...allProviders()
                    .filter((p) => p.auth !== "cli" && p.auth !== "gcloud" && !p.local)
                    .map((p) => p.id),
                ...customProviders.map((c) => c.id),
                ...SEARCH_PROVIDERS.map((s) => s.id),
            ];
            for (const id of [...new Set(ids)].sort()) {
                const endpoint = effectiveEndpoint(id, customProviders);
                if (!endpoint) continue;
                const resolved = await getKey(id);
                // Only explicitly stored Cavvy keys (keychain or credentials.json), never ambient env vars or CLI OAuth tokens.
                if (!resolved || resolved.source === "env" || typeof resolved.value !== "string") continue;
                if (CLI_SIGN_IN_TOKEN.test(resolved.value)) continue;
                apiKeys[id] = { value: resolved.value, endpoint };
            }
        }
    }

    return {
        ...(settings !== undefined ? { settings, permissions, mcpServers } : {}),
        ...(marketplaces !== undefined ? { marketplaces, plugins } : {}),
        ...(customProviders !== undefined ? { customProviders, ...(vertex ? { vertex } : {}), agents } : {}),
        // Said whenever it's on, keys read or not: without it a server takes the MCP servers that carry a secret for removed.
        ...(includeSecrets ? { includeSecrets: true, ...(apiKeys !== undefined ? { apiKeys } : {}) } : {}),
    };
}

// ---------------------------------------------------------------------------
// On a server

interface SyncedAgentRecord {
    owned: boolean;
    defaultAccount?: string;
    /** Managed account IDs CREATED/OWNED by sync -> last synced display name. Never includes pre-existing server accounts. */
    accounts: Record<string, string>;
}

interface SyncedMarketplaceRecord {
    source: string;
    gitCommitSha?: string;
}

interface SyncedPluginRecord {
    enabled: boolean;
    version: string;
    gitCommitSha?: string;
}

interface SyncedKeyRecord {
    /** sha256 of the synced key value — never plaintext. */
    hash: string;
    endpoint: string;
}

interface SyncedStateRecord {
    digest?: string;
    /** Sorted list of AGENT_CLIS installed when `digest` was recorded: installing a CLI later invalidates `digest`. */
    installedClis?: string[];
    /** CLIs last requested by the Mac that weren't installed yet. */
    missingClis?: string[];
    settings: Record<string, string>;
    /** Only rules INSERTED/OWNED by sync: pre-existing server rules are never added here. */
    rules: { allow: string[]; ask: string[]; deny: string[] };
    mcpServers: Record<string, string>;
    customProviders: Record<string, string>;
    vertex?: string;
    apiKeys: Record<string, SyncedKeyRecord>;
    agents: Record<string, SyncedAgentRecord>;
    marketplaces: Record<string, SyncedMarketplaceRecord>;
    /** Only plugins INSTALLED/OWNED by sync: pre-existing server plugins are never added here. */
    plugins: Record<string, SyncedPluginRecord>;
}

const emptyRecord = (): SyncedStateRecord => ({
    settings: {},
    rules: { allow: [], ask: [], deny: [] },
    mcpServers: {},
    customProviders: {},
    apiKeys: {},
    agents: {},
    marketplaces: {},
    plugins: {},
});

const SYNCED_STATE_FILE = () => join(cavvyHome(), "synced-state.json");

export function readSyncedStateRecord(): SyncedStateRecord {
    try {
        const v = JSON.parse(readFileSync(SYNCED_STATE_FILE(), "utf-8"));
        if (!v || typeof v !== "object") return emptyRecord();
        return {
            ...(typeof v.digest === "string" ? { digest: v.digest } : {}),
            ...(Array.isArray(v.installedClis) ? { installedClis: v.installedClis.filter((x: unknown): x is string => typeof x === "string") } : {}),
            ...(Array.isArray(v.missingClis) ? { missingClis: v.missingClis.filter((x: unknown): x is string => typeof x === "string") } : {}),
            settings: v.settings && typeof v.settings === "object" ? v.settings : {},
            rules: {
                allow: Array.isArray(v.rules?.allow) ? v.rules.allow.filter((x: unknown): x is string => typeof x === "string") : [],
                ask: Array.isArray(v.rules?.ask) ? v.rules.ask.filter((x: unknown): x is string => typeof x === "string") : [],
                deny: Array.isArray(v.rules?.deny) ? v.rules.deny.filter((x: unknown): x is string => typeof x === "string") : [],
            },
            mcpServers: v.mcpServers && typeof v.mcpServers === "object" ? v.mcpServers : {},
            customProviders: v.customProviders && typeof v.customProviders === "object" ? v.customProviders : {},
            ...(typeof v.vertex === "string" ? { vertex: v.vertex } : {}),
            apiKeys: v.apiKeys && typeof v.apiKeys === "object" ? v.apiKeys : {},
            agents: v.agents && typeof v.agents === "object" ? v.agents : {},
            marketplaces: v.marketplaces && typeof v.marketplaces === "object" ? v.marketplaces : {},
            plugins: v.plugins && typeof v.plugins === "object" ? v.plugins : {},
        };
    } catch {
        return emptyRecord();
    }
}

function writeSyncedStateRecord(record: SyncedStateRecord) {
    const file = SYNCED_STATE_FILE();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = join(dirname(file), `.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    try {
        renameSync(tmp, file);
    } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
    }
}

function installedAgentClis(): string[] {
    return AGENT_CLIS.filter((def) => Boolean(findCli(def.id, def.cli)))
        .map((d) => d.id)
        .sort();
}

/** Total budget for probing all CLI/account statuses in one sync call, well within the 20s RPC timeout. */
const STATUS_BUDGET_MS = 4000;

/**
 * Probes whether an agent CLI + account is signed in via the CLI's own status interface.
 * Returns `undefined` when the probe fails or times out so unknown status NEVER authorizes deleting an account/CLI.
 */
async function probeAccountSignedIn(cliId: string, accountId: string, signal?: AbortSignal): Promise<boolean | undefined> {
    const def = agentCli(cliId);
    if (!def) return undefined;
    try {
        const st = await checkAgentCli(def.id, signal ?? AbortSignal.timeout(STATUS_BUDGET_MS), accountId);
        if (!st.installed || st.probeFailed) return undefined;
        return st.signedIn;
    } catch {
        return undefined;
    }
}

/** Collects unsigned CLI accounts on this server in parallel under one bounded deadline. */
async function collectNeedsSignIn(cliIds: readonly string[]): Promise<SyncNeedsSignIn[]> {
    const signal = AbortSignal.timeout(STATUS_BUDGET_MS);
    const jobs: { provider: string; accountId: string; name: string }[] = [];
    for (const cliId of cliIds) {
        const def = agentCli(cliId);
        if (!def || !findCli(def.id, def.cli)) continue;
        if ((ACCOUNT_PROVIDERS as readonly string[]).includes(def.id)) {
            for (const acc of listAccounts(def.id)) jobs.push({ provider: def.id, accountId: acc.id, name: acc.name });
        } else {
            jobs.push({ provider: def.id, accountId: "default", name: "Default" });
        }
    }
    const results = await Promise.all(jobs.map(async (j) => ((await probeAccountSignedIn(j.provider, j.accountId, signal)) === false ? j : undefined)));
    return results.filter((x): x is SyncNeedsSignIn => x !== undefined);
}

/**
 * Reports the server's sync digest and live CLI/account sign-in status (bounded to STATUS_BUDGET_MS total).
 * If the set of installed CLIs changed since the digest was recorded, `digest` is omitted so topology reconciles.
 */
export async function readSyncedStateDigest(): Promise<SyncRemoteStateStatus> {
    const r = readSyncedStateRecord();
    const installed = installedAgentClis();
    const sameClis = Array.isArray(r.installedClis) && r.installedClis.length === installed.length && r.installedClis.every((c, i) => c === installed[i]);
    const trackedClis = Object.keys(r.agents);
    const missingClis = (r.missingClis ?? []).filter((id) => !installed.includes(id));
    const needsSignIn = await collectNeedsSignIn(trackedClis);
    return {
        ...(r.digest && sameClis ? { digest: r.digest } : {}),
        missingClis,
        needsSignIn,
    };
}

const ALLOWED_SETTINGS_KEYS = new Set<string>(SETTINGS_KEYS);

/**
 * Takes back a key sync put on this server. It's compared with the one Cavvy keeps, not the one in use, so an
 * environment variable over it doesn't hide it. "kept": changed here since, so this server's own. "stuck": still
 * there after removing it.
 */
async function takeBackKey(id: string, hash: string): Promise<"gone" | "absent" | "kept" | "stuck"> {
    const stored = await storedKey(id);
    if (!stored) return "absent";
    if (sha(stored.value) !== hash) return "kept";
    try {
        await removeKey(id);
    } catch {
        return "stuck";
    }
    const after = await storedKey(id);
    return after && sha(after.value) === hash ? "stuck" : "gone";
}

/**
 * Applies synced settings, remote plugins, provider topology, and (when included) Cavvy API keys on a server.
 * Always preserves server-local overrides, pre-existing server rules/accounts/plugins, never redirects a
 * server key to a new endpoint, and never reads, copies or destroys independent CLI subscription logins.
 */
export async function applyStateSync(digest: unknown, raw: unknown): Promise<ApplyStateResult> {
    const p = (raw && typeof raw === "object" ? raw : {}) as Partial<SyncStatePayload>;
    const record = readSyncedStateRecord();
    let settingsChanged = 0;
    let providersChanged = 0;
    let keysChanged = 0;
    let pluginsChanged = 0;
    let accountsAdded = 0;
    const changedProviders = new Set<string>();
    const restartedPlugins = new Set<string>();
    const missingClis: string[] = [];
    const warnings: string[] = [];
    const keysLeft: string[] = [];
    const allowSecrets = p.includeSecrets === true;
    // What sync owns is recorded as it's written. While a section works towards its write, this puts its part of
    // the record back: a failure on the way leaves the record saying what's still on disk, so the next sync knows its own.
    let undo: (() => void) | undefined;

    try {
        // 1. User settings (key-level merge), portable permission rules, and MCP servers.
        // Skipped completely when the sender's settings file was unreadable.
        if (p.settings && typeof p.settings === "object" && !Array.isArray(p.settings)) {
            const incomingSettings = p.settings as Record<string, unknown>;
            const incomingPerms = p.permissions && typeof p.permissions === "object" ? p.permissions : undefined;
            const incomingMcp = p.mcpServers && typeof p.mcpServers === "object" && !Array.isArray(p.mcpServers) ? (p.mcpServers as Record<string, McpServerConfig>) : {};

            let settingsDirty = false;
            const curSettings = readJsonForUpdate<Settings>(paths.userSettings()) ?? {};
            const recorded = { settings: record.settings, rules: { ...record.rules }, mcpServers: record.mcpServers };
            undo = () => void Object.assign(record, recorded);

            const nextSettingsRec: Record<string, string> = {};
            for (const k of ALLOWED_SETTINGS_KEYS) {
                const hasNew = Object.hasOwn(incomingSettings, k) && incomingSettings[k] !== undefined;
                const curVal = (curSettings as Record<string, unknown>)[k];
                const prevHash = record.settings[k];
                if (hasNew) {
                    const nextVal = incomingSettings[k];
                    const nextHash = hashVal(nextVal);
                    if (curVal === undefined) {
                        (curSettings as Record<string, unknown>)[k] = nextVal;
                        nextSettingsRec[k] = nextHash;
                        settingsDirty = true;
                        settingsChanged++;
                    } else {
                        const curHash = hashVal(curVal);
                        if (curHash === nextHash) {
                            if (prevHash !== undefined) nextSettingsRec[k] = nextHash;
                        } else if (prevHash !== undefined && curHash === prevHash) {
                            (curSettings as Record<string, unknown>)[k] = nextVal;
                            nextSettingsRec[k] = nextHash;
                            settingsDirty = true;
                            settingsChanged++;
                        }
                    }
                } else if (prevHash !== undefined && curVal !== undefined && hashVal(curVal) === prevHash) {
                    delete (curSettings as Record<string, unknown>)[k];
                    settingsDirty = true;
                    settingsChanged++;
                }
            }
            record.settings = nextSettingsRec;

            // Permission rules: strictly portable in all modes; ONLY rules inserted or already owned by sync are tracked.
            // Pre-existing server deny/ask/allow rules are never adopted as sync-owned.
            if (incomingPerms) {
                for (const list of ["allow", "ask", "deny"] as const) {
                    const rawList = Array.isArray(incomingPerms[list]) ? incomingPerms[list]!.filter((r): r is string => typeof r === "string") : [];
                    const valid = rawList.filter(portableRule);
                    const prev = new Set(record.rules[list]);
                    const cur = [...(curSettings.permissions?.[list] ?? [])];
                    const curSet = new Set(cur);
                    const validSet = new Set(valid);
                    const filtered = cur.filter((r) => !(prev.has(r) && !validSet.has(r)));
                    const nextOwned: string[] = [];
                    for (const r of valid) {
                        if (!filtered.includes(r)) {
                            filtered.push(r);
                            nextOwned.push(r);
                        } else if (prev.has(r) && curSet.has(r)) {
                            nextOwned.push(r);
                        }
                        // If `r` was already on the server and NOT in `prev`, leave it server-owned (not in nextOwned).
                    }
                    if (filtered.length !== cur.length || filtered.some((r, i) => r !== cur[i])) {
                        const perms = (curSettings.permissions ??= {});
                        if (filtered.length) perms[list] = filtered;
                        else delete perms[list];
                        if (!Object.keys(perms).length) delete curSettings.permissions;
                        settingsDirty = true;
                        settingsChanged++;
                    }
                    record.rules[list] = nextOwned;
                }
            }

            // MCP servers (strictly sanitized server-side too).
            const sanitizedMcp: Record<string, McpServerConfig> = {};
            for (const [name, cfg] of Object.entries(incomingMcp)) {
                if (!name || name.length > 100 || !cfg || typeof cfg !== "object") continue;
                const entry = allowSecrets ? secretMcpEntry(cfg) : portableMcpEntry(cfg);
                if (entry) sanitizedMcp[name] = entry;
            }
            const nextMcpRec: Record<string, string> = {};
            const curMcp = curSettings.mcpServers ?? {};
            for (const [name, entry] of Object.entries(sanitizedMcp)) {
                const nextHash = hashVal(entry);
                const existing = Object.hasOwn(curMcp, name) ? curMcp[name] : undefined;
                const prevHash = record.mcpServers[name];
                if (existing === undefined) {
                    (curSettings.mcpServers ??= {})[name] = entry;
                    nextMcpRec[name] = nextHash;
                    settingsDirty = true;
                    settingsChanged++;
                } else {
                    const curHash = hashVal(existing);
                    if (curHash === nextHash) {
                        if (prevHash !== undefined) nextMcpRec[name] = nextHash;
                    } else if (prevHash !== undefined && curHash === prevHash) {
                        curSettings.mcpServers![name] = entry;
                        nextMcpRec[name] = nextHash;
                        settingsDirty = true;
                        settingsChanged++;
                    }
                }
            }
            for (const [name, prevHash] of Object.entries(record.mcpServers)) {
                if (Object.hasOwn(sanitizedMcp, name)) continue;
                const existing = Object.hasOwn(curMcp, name) ? curMcp[name] : undefined;
                if (existing !== undefined && hashVal(existing) === prevHash) {
                    delete curSettings.mcpServers![name];
                    if (!Object.keys(curSettings.mcpServers!).length) delete curSettings.mcpServers;
                    settingsDirty = true;
                    settingsChanged++;
                }
            }
            record.mcpServers = nextMcpRec;

            if (settingsDirty) {
                updateSettings("user", homedir(), (s) => {
                    for (const k of ALLOWED_SETTINGS_KEYS) {
                        if (Object.hasOwn(curSettings, k) && (curSettings as Record<string, unknown>)[k] !== undefined) {
                            (s as Record<string, unknown>)[k] = (curSettings as Record<string, unknown>)[k];
                        } else if (!Object.hasOwn(curSettings, k)) {
                            delete (s as Record<string, unknown>)[k];
                        }
                    }
                    if (curSettings.permissions) {
                        const nextPerms = { ...(s.permissions ?? {}) };
                        for (const list of ["allow", "ask", "deny"] as const) {
                            if (curSettings.permissions[list]?.length) nextPerms[list] = curSettings.permissions[list];
                            else delete nextPerms[list];
                        }
                        if (Object.keys(nextPerms).length) s.permissions = nextPerms;
                        else delete s.permissions;
                    } else if (s.permissions) {
                        delete s.permissions.allow;
                        delete s.permissions.ask;
                        delete s.permissions.deny;
                        if (!Object.keys(s.permissions).length) delete s.permissions;
                    }
                    if (curSettings.mcpServers && Object.keys(curSettings.mcpServers).length) s.mcpServers = curSettings.mcpServers;
                    else delete s.mcpServers;
                });
            }
            undo = undefined;
        }

        // Key sync is off for this server: the keys sync put here go, before the providers they belong to are
        // looked at, so one of them never holds a provider's address back. A key changed here since is this
        // server's own and stays. One that can't be removed stays on record, and is said.
        if (!allowSecrets) {
            for (const [id, prev] of Object.entries({ ...record.apiKeys })) {
                const took = await takeBackKey(id, prev.hash);
                if (took === "stuck") {
                    keysLeft.push(id);
                    warnings.push(`The API key for ${id} couldn't be removed from this server.`);
                    continue;
                }
                if (took === "gone") {
                    keysChanged++;
                    changedProviders.add(id);
                }
                delete record.apiKeys[id];
            }
            forgetCachedKeys();
        }

        // 2. Custom API providers & Vertex metadata.
        // Skipped completely when sender's providers.json was unreadable.
        if (Array.isArray(p.customProviders)) {
            forgetCachedKeys();
            const incomingCustom = p.customProviders
                .map((c) => sanitizeCustomProvider(c, allowSecrets))
                .filter((c): c is CustomProviderEntry => c !== undefined);
            const pf = readProvidersFileForUpdate();
            let pfDirty = false;
            const recorded = { customProviders: record.customProviders, vertex: record.vertex };
            undo = () => {
                record.customProviders = recorded.customProviders;
                if (recorded.vertex === undefined) delete record.vertex;
                else record.vertex = recorded.vertex;
            };
            const curCustom = [...(pf.custom ?? [])];
            const nextCustomRec: Record<string, string> = {};
            const incomingCustomIds = new Set<string>();
            for (const c of incomingCustom) {
                incomingCustomIds.add(c.id);
                const nextHash = hashVal(c);
                const idx = curCustom.findIndex((x) => x.id === c.id);
                const prevHash = record.customProviders[c.id];
                if (idx < 0) {
                    // Never attach an existing local/leftover server API key (stored or derived env var) to a newly
                    // inserted custom provider unless secrets sync is active and owns that stored key.
                    const curKey = await getKey(c.id);
                    const hasDerivedEnvKey = Boolean(process.env[customEnvKey(c.id)]?.trim());
                    const prevKey = record.apiKeys[c.id];
                    const syncOwnsKey = Boolean(allowSecrets && !hasDerivedEnvKey && curKey && prevKey && curKey.source !== "env" && sha(curKey.value) === prevKey.hash);
                    if ((curKey || hasDerivedEnvKey) && !syncOwnsKey) {
                        warnings.push(`Custom provider ${c.id} already has a local API key on this server; skipped.`);
                        continue;
                    }
                    curCustom.push(c);
                    nextCustomRec[c.id] = nextHash;
                    pfDirty = true;
                    providersChanged++;
                    changedProviders.add(c.id);
                } else {
                    const existing = curCustom[idx]!;
                    const curHash = hashVal(existing);
                    if (curHash === nextHash) {
                        if (prevHash !== undefined) nextCustomRec[c.id] = nextHash;
                    } else if (prevHash !== undefined && curHash === prevHash) {
                        // Never redirect an installed API key to a different baseUrl unless secrets sync is active
                        // AND owns that key (so section 3 reconciles the key atomically with the new endpoint).
                        const endpointChanged = existing.baseUrl.replace(/\/+$/, "") !== c.baseUrl.replace(/\/+$/, "");
                        let blocksRedirect = false;
                        if (endpointChanged) {
                            const curKey = await getKey(c.id);
                            if (curKey) {
                                const prevKey = record.apiKeys[c.id];
                                const syncOwnsKey = allowSecrets && Boolean(prevKey && curKey.source !== "env" && sha(curKey.value) === prevKey.hash);
                                if (!syncOwnsKey) blocksRedirect = true;
                            }
                        }
                        if (blocksRedirect) {
                            // Still sync's own, and said: it's taken once the key here is gone.
                            nextCustomRec[c.id] = prevHash;
                            warnings.push(`Custom provider ${c.id} has its own API key on this server; its address wasn't changed.`);
                        } else {
                            curCustom[idx] = c;
                            nextCustomRec[c.id] = nextHash;
                            pfDirty = true;
                            providersChanged++;
                            changedProviders.add(c.id);
                        }
                    }
                }
            }
            for (const [id, prevHash] of Object.entries(record.customProviders)) {
                if (incomingCustomIds.has(id)) continue;
                const idx = curCustom.findIndex((x) => x.id === id);
                if (idx >= 0 && hashVal(curCustom[idx]) === prevHash) {
                    curCustom.splice(idx, 1);
                    pfDirty = true;
                    providersChanged++;
                    changedProviders.add(id);
                }
            }
            if (pfDirty) {
                if (curCustom.length) pf.custom = curCustom;
                else delete pf.custom;
            }
            record.customProviders = nextCustomRec;

            // Vertex metadata (non-secret project/location/account).
            const v = p.vertex;
            const validVertex =
                v && typeof v === "object" && typeof v.project === "string" && typeof v.location === "string" && typeof v.account === "string" && validVertexProject(v.project) && validVertexLocation(v.location) && validGoogleAccount(v.account)
                    ? { project: v.project, location: v.location, account: v.account }
                    : undefined;
            if (validVertex) {
                const nextHash = hashVal(validVertex);
                if (!pf.vertex) {
                    pf.vertex = validVertex;
                    record.vertex = nextHash;
                    pfDirty = true;
                    providersChanged++;
                    changedProviders.add("vertex");
                } else {
                    const curHash = hashVal(pf.vertex);
                    if (curHash === nextHash) {
                        if (record.vertex !== undefined) record.vertex = nextHash;
                    } else if (record.vertex && curHash === record.vertex) {
                        pf.vertex = validVertex;
                        record.vertex = nextHash;
                        pfDirty = true;
                        providersChanged++;
                        changedProviders.add("vertex");
                    } else {
                        delete record.vertex;
                    }
                }
            } else if (record.vertex && pf.vertex && hashVal(pf.vertex) === record.vertex) {
                delete pf.vertex;
                delete record.vertex;
                pfDirty = true;
                providersChanged++;
                changedProviders.add("vertex");
            }

            if (pfDirty) writeProvidersFile(pf);
            undo = undefined;

            // 3. Opt-in Cavvy API keys (strictly non-CLI, non-gcloud, non-OAuth, bound to effective endpoint).
            // Ownership in `record.apiKeys` is updated immediately after each write/delete so partial failures persist it.
            if (allowSecrets && p.apiKeys && typeof p.apiKeys === "object" && !Array.isArray(p.apiKeys)) {
                forgetCachedKeys();
                const latestCustom = pf.custom ?? [];
                const allowedIds = new Set([
                    ...allProviders()
                        .filter((pr) => pr.auth !== "cli" && pr.auth !== "gcloud" && !pr.local)
                        .map((pr) => pr.id),
                    ...latestCustom.map((c) => c.id),
                    ...SEARCH_PROVIDERS.map((s) => s.id),
                ]);
                const incomingKeys = new Set<string>();
                for (const [id, entry] of Object.entries(p.apiKeys)) {
                    if (!allowedIds.has(id) || !entry || typeof entry !== "object") continue;
                    const val = (entry as Partial<SyncedApiKey>).value;
                    const endpoint = (entry as Partial<SyncedApiKey>).endpoint;
                    if (typeof val !== "string" || !val.trim() || val.length > 4096 || typeof endpoint !== "string") continue;
                    if (CLI_SIGN_IN_TOKEN.test(val.trim())) continue;
                    // Endpoint binding: never install a Mac key if the server points this provider ID elsewhere.
                    const serverEndpoint = effectiveEndpoint(id, latestCustom);
                    if (!serverEndpoint || serverEndpoint !== endpoint) continue;
                    incomingKeys.add(id);
                    const nextHash = sha(val.trim());
                    const cur = await getKey(id);
                    const prev = record.apiKeys[id];
                    if (!cur) {
                        await setKey(id, val.trim());
                        record.apiKeys[id] = { hash: nextHash, endpoint };
                        keysChanged++;
                        changedProviders.add(id);
                    } else if (cur.source !== "env") {
                        const curHash = sha(cur.value);
                        if (curHash === nextHash && prev !== undefined) {
                            record.apiKeys[id] = { hash: nextHash, endpoint };
                        } else if (prev !== undefined && curHash === prev.hash) {
                            await setKey(id, val.trim());
                            record.apiKeys[id] = { hash: nextHash, endpoint };
                            keysChanged++;
                            changedProviders.add(id);
                        } else if (prev !== undefined) {
                            delete record.apiKeys[id];
                        }
                    }
                    // Under an environment variable here, the one sync stored stays on record: it's still sync's to take back.
                }
                for (const [id, prev] of Object.entries({ ...record.apiKeys })) {
                    if (incomingKeys.has(id)) continue;
                    const took = await takeBackKey(id, prev.hash);
                    if (took === "stuck") {
                        keysLeft.push(id);
                        warnings.push(`The API key for ${id} couldn't be removed from this server.`);
                        continue;
                    }
                    if (took === "gone") {
                        keysChanged++;
                        changedProviders.add(id);
                    }
                    delete record.apiKeys[id];
                }
                forgetCachedKeys();
            }
        }

        // 4. Agent CLI topology & managed named accounts (ZERO credentials).
        if (Array.isArray(p.agents)) {
            const probeSignal = AbortSignal.timeout(STATUS_BUDGET_MS);
            const incomingIds = new Set<string>();
            const nextAgentRec: Record<string, SyncedAgentRecord> = {};

            for (const a of p.agents) {
                if (!a || typeof a !== "object" || typeof a.id !== "string") continue;
                const def = agentCli(a.id);
                if (!def) continue;
                incomingIds.add(def.id);
                if (!findCli(def.id, def.cli)) {
                    missingClis.push(def.id);
                    continue;
                }
                const prevRec = record.agents[def.id];
                const latestPf = readProvidersFileForUpdate();
                let owned = prevRec?.owned ?? false;
                if (!latestPf.agents?.[def.id]) {
                    (latestPf.agents ??= {})[def.id] = {};
                    writeProvidersFile(latestPf);
                    owned = true;
                    providersChanged++;
                    changedProviders.add(def.id);
                }

                const nextAccounts: Record<string, string> = {};
                let nextDefault: string | undefined = prevRec?.defaultAccount;

                if ((ACCOUNT_PROVIDERS as readonly string[]).includes(def.id)) {
                    const existingAccounts = listAccounts(def.id);
                    const incomingAccIds = new Set<string>();
                    for (const acc of Array.isArray(a.accounts) ? a.accounts : []) {
                        if (!acc || typeof acc.id !== "string" || typeof acc.name !== "string") continue;
                        incomingAccIds.add(acc.id);
                        const found = existingAccounts.find((x) => x.id === acc.id);
                        const prevName = prevRec?.accounts?.[acc.id];
                        if (!found) {
                            try {
                                addAccount(def.id, { id: acc.id, name: acc.name });
                                accountsAdded++;
                                changedProviders.add(def.id);
                                nextAccounts[acc.id] = acc.name;
                            } catch (e) {
                                warnings.push(`${def.name} account ${acc.name}: ${(e as Error).message}`);
                            }
                        } else if (found.managed && prevName !== undefined) {
                            // Only sync-owned managed accounts are tracked/renamed; pre-existing server accounts stay server-owned.
                            if (found.name === acc.name) {
                                nextAccounts[acc.id] = acc.name;
                            } else if (found.name === prevName) {
                                try {
                                    renameAccount(def.id, acc.id, acc.name);
                                    providersChanged++;
                                    changedProviders.add(def.id);
                                    nextAccounts[acc.id] = acc.name;
                                } catch {
                                    nextAccounts[acc.id] = found.name;
                                }
                            }
                        }
                    }

                    // Remove sync-owned managed accounts dropped on Mac ONLY when CLI status explicitly says signedIn === false.
                    for (const prevId of Object.keys(prevRec?.accounts ?? {})) {
                        if (incomingAccIds.has(prevId)) continue;
                        const existing = listAccounts(def.id).find((x) => x.id === prevId);
                        if (!existing || !existing.managed || existing.invalid) continue;
                        const signedIn = await probeAccountSignedIn(def.id, prevId, probeSignal);
                        if (signedIn === false) {
                            try {
                                removeAccount(def.id, prevId, existing.folder);
                                providersChanged++;
                                changedProviders.add(def.id);
                            } catch {
                                // Busy or login-leased: keep tracked so a later sync retries or leaves it once signed in.
                                nextAccounts[prevId] = prevRec!.accounts[prevId]!;
                            }
                        }
                        // If signedIn === true or undefined (probe failed), preserve the server account and detach.
                    }

                    // Reconcile defaultAccount when sync owns it (absent on server or unchanged from last sync).
                    const curDefault = readAgentConfig(def.id)?.defaultAccount;
                    if (typeof a.defaultAccount === "string") {
                        const targetExists = listAccounts(def.id).some((x) => x.id === a.defaultAccount);
                        if (targetExists && (curDefault === undefined || curDefault === prevRec?.defaultAccount)) {
                            if (curDefault !== a.defaultAccount) {
                                try {
                                    setDefaultAccount(def.id, a.defaultAccount);
                                    providersChanged++;
                                    changedProviders.add(def.id);
                                } catch {
                                    // ignore
                                }
                            }
                            nextDefault = a.defaultAccount;
                        } else if (curDefault === a.defaultAccount && prevRec?.defaultAccount !== undefined) {
                            nextDefault = a.defaultAccount;
                        } else {
                            nextDefault = undefined;
                        }
                    } else if (prevRec?.defaultAccount && curDefault === prevRec.defaultAccount) {
                        try {
                            setDefaultAccount(def.id, "default");
                            providersChanged++;
                            changedProviders.add(def.id);
                        } catch {
                            // ignore
                        }
                        nextDefault = undefined;
                    }
                }

                nextAgentRec[def.id] = { owned, ...(nextDefault ? { defaultAccount: nextDefault } : {}), accounts: nextAccounts };
            }

            // Handle CLIs dropped on Mac: clean up sync-owned unsigned accounts even if the CLI itself pre-existed,
            // and only turn off the CLI if sync owned it AND it has no remaining accounts or active sign-in.
            for (const [prevCli, prevRec] of Object.entries(record.agents)) {
                if (incomingIds.has(prevCli)) continue;
                const cfg = readAgentConfig(prevCli);
                if (!cfg) continue;
                if ((ACCOUNT_PROVIDERS as readonly string[]).includes(prevCli)) {
                    for (const accId of Object.keys(prevRec.accounts)) {
                        const existing = listAccounts(prevCli).find((x) => x.id === accId);
                        if (!existing || !existing.managed || existing.invalid) continue;
                        if ((await probeAccountSignedIn(prevCli, accId, probeSignal)) === false) {
                            try {
                                removeAccount(prevCli, accId, existing.folder);
                                providersChanged++;
                                changedProviders.add(prevCli);
                            } catch {
                                // Busy or login-leased: leave untouched.
                            }
                        }
                    }
                }
                if (!prevRec.owned) continue;
                const remaining = readAgentConfig(prevCli);
                if (remaining && !(remaining.accounts?.length) && (await probeAccountSignedIn(prevCli, "default", probeSignal)) === false) {
                    try {
                        removeAgentConfig(prevCli);
                        providersChanged++;
                        changedProviders.add(prevCli);
                    } catch {
                        // leave untouched
                    }
                }
            }

            record.agents = nextAgentRec;
            record.missingClis = [...missingClis].sort();
        }

        // 5. Remote marketplaces & user-scoped plugins (skipped when sender's plugin manifests were unreadable).
        if (Array.isArray(p.marketplaces) && Array.isArray(p.plugins)) {
            const known = readKnownMarketplaces();
            const conflictedMarketplaces = new Set<string>();
            const incomingMarketplaces = new Map<string, SyncedMarketplace>();

            for (const m of p.marketplaces) {
                if (!m || typeof m !== "object" || typeof m.name !== "string") continue;
                const src = sanitizeMarketplaceSource(m.source);
                if (!src) continue;
                incomingMarketplaces.set(m.name, { name: m.name, source: src, ...(typeof m.gitCommitSha === "string" ? { gitCommitSha: m.gitCommitSha } : {}) });
            }

            for (const [name, m] of incomingMarketplaces) {
                const srcJson = stableJson(m.source);
                const existing = Object.hasOwn(known, name) ? known[name] : undefined;
                const prev = record.marketplaces[name];
                if (!existing) {
                    try {
                        // Pass validated RemoteMarketplaceSource + expectedName + publicOnly directly so redirects,
                        // upstream renames, and pre-existing same-source server marketplaces are never clobbered.
                        await addMarketplace(m.source, homedir(), { expectedName: name, publicOnly: true });
                        pluginsChanged++;
                        record.marketplaces[name] = { source: srcJson, ...(m.gitCommitSha ? { gitCommitSha: m.gitCommitSha } : {}) };
                    } catch (e) {
                        warnings.push(`Marketplace ${name}: ${(e as Error).message}`);
                    }
                } else if (stableJson(existing.source) !== srcJson) {
                    conflictedMarketplaces.add(name);
                    delete record.marketplaces[name];
                    warnings.push(`Marketplace ${name} points to a different source on this server; skipped.`);
                } else if (prev) {
                    let nextSha = prev.gitCommitSha;
                    if (m.gitCommitSha && m.gitCommitSha !== prev.gitCommitSha && existing.gitCommitSha !== m.gitCommitSha) {
                        try {
                            await updateMarketplace(name, { publicOnly: true });
                            pluginsChanged++;
                            nextSha = m.gitCommitSha;
                        } catch (e) {
                            warnings.push(`Marketplace ${name}: ${(e as Error).message}`);
                        }
                    }
                    record.marketplaces[name] = { source: srcJson, ...(nextSha ? { gitCommitSha: nextSha } : {}) };
                }
                // Pre-existing same-source server marketplace is NOT adopted into record.marketplaces.
            }

            const installedPlugins = readInstalled();
            const curUserSettings = loadScope("user", homedir());
            const curEnabled = curUserSettings.enabledPlugins ?? {};
            const incomingPlugins = new Map<string, SyncedPlugin>();

            for (const pl of p.plugins) {
                if (!pl || typeof pl !== "object" || typeof pl.id !== "string" || typeof pl.version !== "string") continue;
                if (pl.enabled !== undefined && typeof pl.enabled !== "boolean") continue;
                const { marketplace } = splitId(pl.id);
                if (!marketplace || !incomingMarketplaces.has(marketplace) || conflictedMarketplaces.has(marketplace)) continue;
                incomingPlugins.set(pl.id, {
                    id: pl.id,
                    ...(pl.enabled !== undefined ? { enabled: pl.enabled } : {}),
                    version: pl.version,
                    ...(typeof pl.gitCommitSha === "string" ? { gitCommitSha: pl.gitCommitSha } : {}),
                });
            }

            const refreshedMarkets = new Set<string>();
            for (const [id, pl] of incomingPlugins) {
                const existing = Object.hasOwn(installedPlugins, id) ? installedPlugins[id] : undefined;
                const prev = record.plugins[id];
                if (!existing) {
                    try {
                        await installPlugin(id, "user", homedir(), { publicOnly: true });
                        pluginsChanged++;
                        // Record ownership with actual post-install state (enabled at user scope) BEFORE reconciling disable.
                        record.plugins[id] = { enabled: true, version: pl.version, ...(pl.gitCommitSha ? { gitCommitSha: pl.gitCommitSha } : {}) };
                        if (pl.enabled === false) {
                            enablePlugin(id, false, homedir(), false, "user");
                            record.plugins[id].enabled = false;
                        }
                    } catch (e) {
                        warnings.push(`Plugin ${id}: ${(e as Error).message}`);
                    }
                } else if (prev) {
                    // Sync-owned plugin: update revision (preserving previous revision on failure so next run retries).
                    let nextVersion = prev.version;
                    let nextSha = prev.gitCommitSha;
                    if (pl.version !== prev.version || pl.gitCommitSha !== prev.gitCommitSha) {
                        try {
                            const upd = await updatePlugin(id, homedir(), false, refreshedMarkets, { publicOnly: true });
                            pluginsChanged++;
                            nextVersion = pl.version;
                            nextSha = pl.gitCommitSha;
                            if (upd.changed || upd.filesChanged) restartedPlugins.add(id);
                        } catch (e) {
                            warnings.push(`Plugin ${id}: ${(e as Error).message}`);
                        }
                    }
                    let nextEnabled = prev.enabled;
                    if (pl.enabled !== undefined) {
                        const nowEnabled = Object.hasOwn(curEnabled, id) ? curEnabled[id] : undefined;
                        if (nowEnabled === undefined || (nowEnabled === prev.enabled && nowEnabled !== pl.enabled)) {
                            try {
                                enablePlugin(id, pl.enabled, homedir(), false, "user");
                                pluginsChanged++;
                                nextEnabled = pl.enabled;
                            } catch (e) {
                                warnings.push(`Plugin ${id}: ${(e as Error).message}`);
                            }
                        } else if (nowEnabled === pl.enabled) {
                            nextEnabled = pl.enabled;
                        }
                    }
                    record.plugins[id] = { enabled: nextEnabled, version: nextVersion, ...(nextSha ? { gitCommitSha: nextSha } : {}) };
                }
                // Pre-existing server plugin (`existing && !prev`) is left server-owned and untouched.
            }

            // Uninstall sync-owned plugins removed on Mac (skipping any whose marketplace conflicted).
            for (const [prevId] of Object.entries({ ...record.plugins })) {
                if (incomingPlugins.has(prevId)) continue;
                const { marketplace } = splitId(prevId);
                if (marketplace && conflictedMarketplaces.has(marketplace)) continue;
                const latestInstalled = readInstalled();
                const rec = Object.hasOwn(latestInstalled, prevId) ? latestInstalled[prevId] : undefined;
                if (rec?.scopes.some((s) => s.scope === "user")) {
                    try {
                        uninstallPlugin(prevId, homedir(), false, "user");
                        delete record.plugins[prevId];
                        pluginsChanged++;
                    } catch (e) {
                        warnings.push(`Plugin ${prevId}: ${(e as Error).message}`);
                    }
                } else {
                    delete record.plugins[prevId];
                }
            }

            // Forget sync-owned marketplaces removed on Mac if no installed plugins still use them.
            const finalInstalled = readInstalled();
            for (const [prevMkt, prevRec] of Object.entries({ ...record.marketplaces })) {
                if (incomingMarketplaces.has(prevMkt) || conflictedMarketplaces.has(prevMkt)) continue;
                const stillUsed = Object.keys(finalInstalled).some((id) => splitId(id).marketplace === prevMkt);
                const curKnown = readKnownMarketplaces();
                if (!stillUsed && Object.hasOwn(curKnown, prevMkt) && stableJson(curKnown[prevMkt]!.source) === prevRec.source) {
                    try {
                        forgetMarketplace(prevMkt);
                        delete record.marketplaces[prevMkt];
                        pluginsChanged++;
                    } catch {
                        // ignore
                    }
                } else if (!Object.hasOwn(curKnown, prevMkt) || stableJson(curKnown[prevMkt]!.source) !== prevRec.source) {
                    delete record.marketplaces[prevMkt];
                }
            }
        }

        record.installedClis = installedAgentClis();

        // Only record digest when nothing warned; CLI changes invalidate digest dynamically in readSyncedStateDigest().
        if (!warnings.length && typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)) {
            record.digest = digest;
        } else if (warnings.length) {
            delete record.digest;
        }
    } catch (e) {
        undo?.();
        // Clear digest on mid-apply failure so the next sync reconciles partial writes cleanly.
        delete record.digest;
        throw e;
    } finally {
        writeSyncedStateRecord(record);
    }

    const needsSignIn = await collectNeedsSignIn(Object.keys(record.agents));
    return {
        settingsChanged,
        providersChanged,
        keysChanged,
        pluginsChanged,
        accountsAdded,
        changedProviders: [...changedProviders],
        restartedPlugins: [...restartedPlugins],
        ...(keysLeft.length ? { keysLeft } : {}),
        missingClis,
        needsSignIn,
        warnings,
    };
}

/** Brings a server's structured state (settings, plugins, providers, and opt-in API keys) level with this machine. */
export async function syncStateTo(
    ask: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    o: { includeSecrets?: boolean | (() => boolean) } = {},
): Promise<SyncStateSummary> {
    const wantSecrets = () => (typeof o.includeSecrets === "function" ? o.includeSecrets() : o.includeSecrets === true);
    const includeSecrets = wantSecrets();
    const payload = await localSyncState({ includeSecrets });
    const digest = hashVal(payload);
    let theirs: unknown;
    try {
        theirs = await ask("sync.state", {});
    } catch (e) {
        const code = (e as { code?: string }).code;
        const msg = (e as Error)?.message ?? "";
        if (code === "unknown" || code === "unsupported" || /unknown method/i.test(msg)) return { unsupported: true };
        throw e;
    }
    const status = theirs && typeof theirs === "object" ? (theirs as Partial<SyncRemoteStateStatus>) : {};
    if (status.digest === digest) {
        return {
            unchanged: true,
            missingClis: Array.isArray(status.missingClis) ? status.missingClis : [],
            needsSignIn: Array.isArray(status.needsSignIn) ? status.needsSignIn : [],
        };
    }
    // Re-check opt-in immediately before dispatching a secret-bearing payload so a concurrent opt-out is honored.
    if (includeSecrets && !wantSecrets()) {
        const safePayload = await localSyncState({ includeSecrets: false });
        const safeDigest = hashVal(safePayload);
        const result = (await ask("sync.applyState", { digest: safeDigest, payload: safePayload })) as ApplyStateResult;
        return { result, missingClis: result.missingClis, needsSignIn: result.needsSignIn };
    }
    const result = (await ask("sync.applyState", { digest, payload })) as ApplyStateResult;
    return { result, missingClis: result.missingClis, needsSignIn: result.needsSignIn };
}

export interface SyncRunResult {
    files: SyncFilesResult;
    state: SyncStateSummary;
}

/** Runs both file sync and structured state sync against one server over its connection. */
export async function syncAllTo(
    ask: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    o: { includeSecrets?: boolean | (() => boolean) } = {},
): Promise<SyncRunResult> {
    // Each is tried though the other failed: a file the server can't take mustn't keep its settings, or keys
    // that are to leave it, as they were.
    let files: SyncFilesResult | undefined;
    let failed: unknown;
    try {
        files = await syncTo(ask);
    } catch (e) {
        failed = e;
    }
    const state = await syncStateTo(ask, o);
    if (!files) throw failed;
    return { files, state };
}

/** Short human summary of what a sync changed, or "" when already up to date. */
export function describeSyncRun(r: SyncRunResult): string {
    const parts: string[] = [];
    const fc = r.files.written + r.files.removed;
    if (fc) parts.push(`${fc} file${fc === 1 ? "" : "s"}`);
    const s = r.state.result;
    if (s) {
        if (s.settingsChanged) parts.push("settings");
        if (s.providersChanged) parts.push("providers");
        if (s.keysChanged) parts.push(`${s.keysChanged} API key${s.keysChanged === 1 ? "" : "s"}`);
        if (s.accountsAdded) parts.push(`${s.accountsAdded} account${s.accountsAdded === 1 ? "" : "s"}`);
        if (s.pluginsChanged) parts.push("plugins");
    }
    if (!parts.length) return "";
    return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
