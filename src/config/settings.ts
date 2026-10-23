import { accessSync, closeSync, constants, existsSync, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { dirname, isAbsolute, join, basename, resolve } from "path";
import { ensureDir, paths } from "./paths";
import type { PermissionMode } from "../permissions/modes";
import { normalizeHooks, type HookEvent, type HookType } from "./hook-config";
import type { FollowUp } from "../agent/queue-store";
import type { LspServerConfig } from "../lsp/config";
import { stripJsonComments } from "../util/jsonc";
import { applyPlugins, mergeEnabled, pluginsFor } from "../plugins/loader";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export type NotificationMode = "auto" | "terminal" | "bell" | "system" | "off";
export const NOTIFICATION_MODES: NotificationMode[] = ["auto", "terminal", "bell", "system", "off"];

export interface McpServerConfig {
    /**
     * The transport. Unset: stdio with a command; with a url, Streamable
     * HTTP, or WebSocket for a ws:// or wss:// one. "sse" is the older
     * HTTP+SSE transport.
     */
    type?: "stdio" | "http" | "streamable-http" | "sse" | "ws";
    /** stdio transport */
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    /** http, sse and ws transports */
    url?: string;
    headers?: Record<string, string>;
    /** OAuth sign-in for a remote server: a client registered by hand, a fixed callback port, scopes. */
    /** `scopes` as a list, or space-separated as Claude Code's .mcp.json has it. */
    oauth?: { clientId?: string; clientSecret?: string; callbackPort?: number; scopes?: string | string[] };
    disabled?: boolean;
    /** Set on servers a plugin adds: its id (name@marketplace). */
    plugin?: string;
}

/**
 * One hook handler, flat. Settings may also use Claude Code's nested form
 * ({ matcher, hooks: [...] }); src/config/hook-config.ts flattens it.
 */
export interface HookConfig {
    /** What the event is filtered on (a tool name, a source, …): exact, a list like "Edit|Write", "*" or a regex. */
    matcher?: string;
    /** Left out: "command". */
    type?: HookType;
    /** One permission rule, like "Bash(git *)": tool events run the hook only for calls it matches. */
    if?: string;
    /** Seconds (default 60; prompt hooks 30). */
    timeout?: number;
    statusMessage?: string;
    /** command: a shell command, or with `args` an executable run without a shell. */
    command?: string;
    args?: string[];
    /** command: run in the background; it can't block, and its context comes with the next request. */
    async?: boolean;
    /** http: POSTed the input as JSON. */
    url?: string;
    headers?: Record<string, string>;
    /** http: the environment variables header values may use ($VAR, ${VAR}). */
    allowedEnvVars?: string[];
    /** prompt: asked of a small model, with $ARGUMENTS as the input. */
    prompt?: string;
    model?: string;
    /** mcp_tool: a tool on a connected MCP server; string values in input take ${field.path} from the hook input. */
    server?: string;
    tool?: string;
    input?: Record<string, unknown>;
    /** Set on hooks a plugin adds: its id (name@marketplace). */
    plugin?: string;
    /** Set for a plugin's hooks: HARNESS_PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT. */
    pluginRoot?: string;
}

export interface Settings {
    /** Default model as "provider:model". */
    model?: string;
    /** Cheaper model used for titles and summaries. */
    smallModel?: string;
    /** The auto-mode reviewer ("provider:model"). Unset: Claude Sonnet 5.5 with an Anthropic key, else the session's model. User settings only. */
    reviewModel?: string;
    effort?: Effort;
    /** Prefer the provider’s faster service on models that explicitly support it. */
    fastMode?: boolean;
    permissions?: {
        allow?: string[];
        ask?: string[];
        deny?: string[];
        defaultMode?: PermissionMode;
        additionalDirectories?: string[];
        /** Include bypassPermissions in the shift+tab cycle. */
        allowBypass?: boolean;
    };
    autoCompact?: boolean;
    /** Fraction of the context window at which to auto-compact (0-1). */
    autoCompactThreshold?: number;
    /**
     * Compact a long conversation left idle, shortly before its prompt cache
     * expires (src/agent/idle-compact.ts). On (the default) for one-hour caches;
     * "always" adds five-minute ones; false turns it off.
     */
    idleCompaction?: boolean | "always";
    /** The context it takes for idle compaction, in tokens (default 200K, never under 100K). */
    idleCompactionMinTokens?: number;
    /** Extra environment variables for Bash tool commands. */
    env?: Record<string, string>;
    mcpServers?: Record<string, McpServerConfig>;
    hooks?: Partial<Record<HookEvent, HookConfig[]>>;
    /** Show model reasoning/thinking text when the provider returns it. */
    showThinking?: boolean;
    /** Upper bound for max output tokens per response. */
    maxOutputTokens?: number;
    /** Web search backend: auto picks the first available. */
    webSearch?: "auto" | "anthropic" | "brave" | "tavily" | "duckduckgo" | "off";
    /** Bash tool default timeout in ms. */
    bashTimeout?: number;
    /**
     * Read what Bash and Monitor commands print at Harness's own pace, so a command that floods its
     * output waits for it instead of stalling the server (#298; default true). False: ordinary pipes, as before.
     */
    pacedOutput?: boolean;
    /** Claude Code's grace after an answer for shells without a timeout of their own, and monitors; agents keep their own limit. */
    claudeCode?: { backgroundWaitSec?: number };
    /**
     * Agent CLIs (Claude Code, Codex). `liveSessions`: keep one CLI process per session between turns, so
     * background work outlives the turn that started it and Esc stops only the answer (#219; default true).
     * False: a process per turn, as before, which waits for background work and stops it at the turn's end.
     */
    agentCli?: { liveSessions?: boolean };
    /** Codex. wakeOnBackgroundCommand: when a background command ends after its turn, start a turn that tells Codex (default true). */
    codex?: { wakeOnBackgroundCommand?: boolean };
    /**
     * Servers from the project's .mcp.json the user approved: name -> a keyed
     * hash of what it runs (src/mcp/approval.ts). Any change asks again.
     * It and the two lists below count from user and local settings only.
     */
    approvedMcpjsonServers?: Record<string, string>;
    /** Approvals by name only, from before they were bound to what runs: each server asks once more. */
    enabledMcpjsonServers?: string[];
    /** Servers from .mcp.json the user rejected (by name). */
    disabledMcpjsonServers?: string[];
    /** Approve every server in every project's .mcp.json, including later changes to what they run. User settings only. */
    enableAllProjectMcpServers?: boolean;
    /** Custom status line: a shell command whose first output line is shown. */
    statusLine?: { command: string };
    /**
     * Auto mode runs shell commands in a sandbox where the OS has one (default true).
     * The object form adds hosts and exemptions. Those count from user settings
     * alone: a cloned repo mustn't grant its own commands network or a way out.
     */
    sandbox?: boolean | SandboxSettings;
    /** How to alert you to a long turn ending, a prompt or an error while the window isn't focused (auto: terminal or bell). */
    notifications?: NotificationMode;
    /** A finished turn alerts only when it took at least this long (default 30). */
    notifyAfterSeconds?: number;
    /** A message sent while a turn runs: "steer" joins it at its next step (default), "queue" waits for it to end. Tab (TUI) or mod+shift+enter (GUI) does the other. */
    followUpBehavior?: FollowUp;
    /** After a Claude Code or Codex turn stops on the plan's usage limit, continue by itself when it resets (default true). */
    autoResume?: boolean;
    /** Claude Code and Codex get tools to hand tasks to other providers' models (default true). */
    delegation?: boolean;
    /**
     * Diagnostics after edits from language servers (src/lsp). Built-in servers
     * run when installed; `servers` adds or replaces them (Claude Code's
     * lspServers shape). false turns it off.
     */
    lsp?: false | { enabled?: boolean; servers?: Record<string, LspServerConfig> };
    /** Plugins turned on or off at this scope, by "name@marketplace" (src/plugins). */
    enabledPlugins?: Record<string, boolean>;
    /** The GUI's "Open files with" editor, an id from src/server/editors.ts. User settings only: a project mustn't choose what gets launched. */
    editor?: string;
    /** `harness --worktree`: the new branch's name prefix (default "harness/"), where it starts, and what happens to it on exit. */
    worktree?: {
        branchPrefix?: string;
        /** head (default): the current HEAD. fresh: origin/HEAD as last fetched. */
        baseRef?: "head" | "fresh";
        /** auto (default): remove a worktree nothing was done in, ask when there are commits. ask: always ask. keep: never remove. Uncommitted changes always keep it. */
        cleanup?: "auto" | "ask" | "keep";
    };
}

/** The worktree settings, with anything malformed (a hand edit) replaced by its default. */
export function worktreeSettings(s: Settings): { branchPrefix: string; baseRef: "head" | "fresh"; cleanup: "auto" | "ask" | "keep" } {
    const w = typeof s.worktree === "object" && s.worktree !== null ? s.worktree : {};
    return {
        branchPrefix: typeof w.branchPrefix === "string" ? w.branchPrefix.trim() : "harness/",
        baseRef: w.baseRef === "fresh" ? "fresh" : "head",
        cleanup: w.cleanup === "ask" || w.cleanup === "keep" ? w.cleanup : "auto",
    };
}

export interface SandboxSettings {
    /** false turns the sandbox off (same as `"sandbox": false`). */
    enabled?: boolean;
    /** Hosts open to every sandboxed command, with no listing and no review. */
    allowedHosts?: string[];
    /** Bash rule patterns (`docker:*`, `Bash(make deploy)`) for commands that run unsandboxed: the whole call must match. They still go to the reviewer in auto mode. */
    excludedCommands?: string[];
}

/** The sandbox's on/off setting, whichever form it's written in. */
export function sandboxSwitch(s: Settings): boolean | undefined {
    return typeof s.sandbox === "object" && s.sandbox !== null ? s.sandbox.enabled : s.sandbox;
}

const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : []);

/** Hosts the user opened for every sandboxed command. */
export function sandboxAllowedHosts(s: Settings): string[] {
    return typeof s.sandbox === "object" && s.sandbox !== null ? stringList(s.sandbox.allowedHosts) : [];
}

/** Rules for commands that run outside the sandbox. */
export function sandboxExcludedCommands(s: Settings): string[] {
    return typeof s.sandbox === "object" && s.sandbox !== null ? stringList(s.sandbox.excludedCommands) : [];
}

export type SettingsScope = "user" | "project" | "local";

export function settingsPath(scope: SettingsScope, cwd: string): string {
    if (scope === "user") return paths.userSettings();
    if (scope === "project") return paths.projectSettings(cwd);
    return paths.localSettings(cwd);
}

/** A config file that exists but can't be parsed; writing it would lose what's in it. */
export class JsonFileError extends Error {
    constructor(
        readonly file: string,
        readonly reason: string,
    ) {
        // Not the parser's message (kept in `reason`): it can quote what's in the file.
        super(`Can't update ${file}: it isn't valid JSON. Fix or remove the file, then try again.`);
    }
}

let warn: (msg: string) => void = (msg) => process.stderr.write(`warning: ${msg}\n`);
const warned = new Set<string>();

/** Where parse warnings go (the TUI shows them as notices instead of writing to stderr). */
export function onConfigWarning(fn: (msg: string) => void) {
    warn = fn;
}

/** For files that are read and then written back: throws rather than treating a broken file as empty. */
export function readJsonForUpdate<T>(file: string): T | undefined {
    if (!existsSync(file)) return undefined;
    const text = readFileSync(file, "utf-8");
    if (!text.trim()) return undefined;
    try {
        return JSON.parse(stripJsonComments(text)) as T;
    } catch (e) {
        throw new JsonFileError(file, (e as Error).message);
    }
}

export function readJson<T>(file: string): T | undefined {
    try {
        return readJsonForUpdate<T>(file);
    } catch (e) {
        const msg = e instanceof JsonFileError ? `${file} isn't valid JSON, so it's being ignored` : `could not read ${file}: ${(e as Error).message}`;
        if (!warned.has(msg)) {
            warned.add(msg);
            warn(msg);
        }
        return undefined;
    }
}

/**
 * One read of a settings file: what it holds (nothing when it's missing, empty or broken); whether it exists but
 * can't be relied on (unreadable, not JSON, not an object, or with a rejection list that isn't a list); and whether
 * it exists but is empty. Broken files are warned of by name only: a parser's message can quote what's in them.
 */
function readSettingsFile(file: string, warnOf = true): { settings: Settings; unreadable: boolean; empty: boolean } {
    const note = (msg: string) => {
        if (warnOf && !warned.has(msg)) {
            warned.add(msg);
            warn(msg);
        }
    };
    const none = { settings: {}, unreadable: false, empty: false };
    let text: string;
    try {
        text = readFileSync(file, "utf-8");
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return none;
        note(`could not read ${file} (${code ?? "error"})`);
        return { ...none, unreadable: true };
    }
    if (!text.trim()) return { ...none, empty: true };
    let v: unknown;
    try {
        v = JSON.parse(stripJsonComments(text));
    } catch {
        note(`${file} isn't valid JSON, so it's being ignored`);
        return { ...none, unreadable: true };
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) {
        note(`${file} isn't a JSON object, so it's being ignored`);
        return { ...none, unreadable: true };
    }
    return { settings: v as Settings, unreadable: "disabledMcpjsonServers" in v && !Array.isArray((v as Settings).disabledMcpjsonServers), empty: false };
}

/** A settings file that exists but can't be relied on to hold MCP approvals and rejections: an empty one counts too (a rejection may have been cut from it). */
export function unreadableSettings(file: string): boolean {
    const r = readSettingsFile(file, false);
    return r.unreadable || r.empty;
}

/**
 * Of the files that can hold approvals or rejections of a folder's .mcp.json servers (the user's settings, the
 * folder's local ones), one that existed but couldn't be read: a rejection in it would be lost, and a blanket or
 * saved approval win. As they are now, or (`s`) when these settings were loaded from them.
 */
export function unreadableMcpApprovals(cwd: string, s?: Settings): string | undefined {
    return (s && unreadableWhenLoaded.get(s)) ?? [paths.userSettings(), paths.localSettings(cwd)].find(unreadableSettings);
}

const unreadableWhenLoaded = new WeakMap<Settings, string>();

/** A copy of loaded settings (a run's own on top of them) was loaded as they were: what couldn't be read then counts for it too. */
export function asLoaded(copy: Settings, loaded: Settings): Settings {
    const file = unreadableWhenLoaded.get(loaded);
    if (file) unreadableWhenLoaded.set(copy, file);
    return copy;
}

/** Where a write to `file` lands: the end of a symlink chain, so a symlinked settings file keeps its link. */
function writeTarget(file: string): string {
    let cur = file;
    for (let i = 0; i < 40; i++) {
        let link: string;
        try {
            // A relative link is relative to its directory as the filesystem sees it, which may itself be reached through a symlink.
            cur = join(realpathSync(dirname(cur)), basename(cur));
            if (!lstatSync(cur).isSymbolicLink()) return cur;
            link = readlinkSync(cur);
        } catch {
            return cur;
        }
        cur = isAbsolute(link) ? link : resolve(dirname(cur), link);
    }
    return cur;
}

/**
 * Write `data` as JSON without a reader ever seeing a partial file: write a
 * temp file beside the target, fsync it, then rename it over the target. An
 * existing file keeps its mode; a new one gets `mode`. A symlinked target is
 * written through, so the link survives.
 */
export function writeJson(file: string, data: unknown, mode = 0o644) {
    const target = writeTarget(file);
    ensureDir(dirname(target));
    let keep = mode;
    let existed = false;
    try {
        keep = statSync(target).mode & 0o7777;
        existed = true;
    } catch {
        // new file: it gets `mode`, filtered by the umask like any new file
    }
    // Rename only needs the directory to be writable, so check the file itself: a read-only settings file fails here as an in-place write would.
    if (existed) accessSync(target, constants.W_OK);
    const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    const text = JSON.stringify(data, null, 2) + "\n";
    let fd: number | undefined;
    try {
        fd = openSync(tmp, "wx", keep);
        if (existed) fchmodSync(fd, keep); // not for a new file: that honors the umask
        writeFileSync(fd, text); // loops until everything is written
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(tmp, target);
    } catch (e) {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            } catch {
                // already closed
            }
        }
        try {
            unlinkSync(tmp);
        } catch {
            // never created, or already gone
        }
        throw e;
    }
    try {
        const dfd = openSync(dirname(target), "r");
        try {
            fsyncSync(dfd);
        } finally {
            closeSync(dfd);
        }
    } catch {
        // best effort: not every platform can fsync a directory
    }
}

export function loadScope(scope: SettingsScope, cwd: string): Settings {
    return readSettingsFile(settingsPath(scope, cwd)).settings;
}

/**
 * Merge user < project < local. Permission lists concatenate; objects merge.
 * In an untrusted folder only the user's own settings apply, plus the
 * project's and local file's deny/ask rules (they can only make things
 * stricter, and /permissions can save local rules in any folder). The
 * auto-mode reviewer comes from the user's settings alone, in any folder: a
 * project shouldn't choose who checks the actions taken in it. Approvals of
 * .mcp.json servers come from the user's and the folder's local settings,
 * never the committed project file: a repo can't approve its own servers.
 * (Those in local settings are keyed hashes a repo can't make; the blanket
 * enableAllProjectMcpServers is a plain flag, so it counts from user
 * settings alone: a repo could ship a settings.local.json.)
 */
/** Hook entries a load's settings files had that can't run, kept with the settings they came from (/hooks shows them, rather than every load). */
const hookWarnings = new WeakMap<Settings, string[]>();

export function hookConfigWarnings(s: Settings): readonly string[] {
    return hookWarnings.get(s) ?? [];
}

export function loadSettings(cwd: string, opts: { trusted?: boolean } = {}): Settings {
    const trusted = opts.trusted ?? true;
    // Read once each: what an MCP approval is decided from, and whether its files could be read, agree.
    const userFile = readSettingsFile(settingsPath("user", cwd));
    const localFile = readSettingsFile(settingsPath("local", cwd));
    const user = userFile.settings;
    const local = localFile.settings;
    const layers = trusted ? [user, loadScope("project", cwd), local] : [user, restrictiveOnly(loadScope("project", cwd)), restrictiveOnly(local)];
    const merged: Settings = {};
    const warnings = new Set<string>();
    for (const s of layers) {
        const { permissions, env, mcpServers, hooks, worktree, lsp, enabledPlugins: _, ...rest } = s;
        // JSON.parse keeps a "__proto__" key as data; assigning it would set merged's prototype (and settings it seems to have).
        for (const [k, v] of Object.entries(rest)) if (k !== "__proto__") (merged as Record<string, unknown>)[k] = v;
        if (permissions) {
            const p = (merged.permissions ??= {});
            for (const key of ["allow", "ask", "deny", "additionalDirectories"] as const) {
                if (permissions[key]) p[key] = [...(p[key] ?? []), ...permissions[key]!];
            }
            if (permissions.defaultMode) p.defaultMode = permissions.defaultMode;
            if (permissions.allowBypass !== undefined) p.allowBypass = permissions.allowBypass;
        }
        if (env) merged.env = { ...merged.env, ...env };
        // Field by field: a project's baseRef mustn't drop the user's own cleanup or prefix.
        if (worktree && typeof worktree === "object") merged.worktree = { ...merged.worktree, ...worktree };
        if (mcpServers) merged.mcpServers = { ...merged.mcpServers, ...mcpServers };
        if (lsp !== undefined) merged.lsp = mergeLsp(merged.lsp, lsp);
        const flat = normalizeHooks(hooks, (msg) => warnings.add(msg));
        if (flat) {
            const h = (merged.hooks ??= {});
            for (const [k, v] of Object.entries(flat) as [HookEvent, HookConfig[]][]) h[k] = [...(h[k] ?? []), ...v];
        }
    }
    // Plugins: the user's own in any folder; a project's (and its local file's) only once it's trusted.
    const enabled = mergeEnabled(trusted ? layers : [user]);
    if (Object.keys(enabled).length) {
        merged.enabledPlugins = enabled;
        applyPlugins(merged, pluginsFor(enabled).plugins);
    }
    if (user.reviewModel) merged.reviewModel = user.reviewModel;
    else delete merged.reviewModel;
    mergeSandbox(merged, layers, user);
    mergeMcpApprovals(merged, trusted ? [user, local] : [user]);
    const unreadable = userFile.unreadable || userFile.empty ? settingsPath("user", cwd) : localFile.unreadable || localFile.empty ? settingsPath("local", cwd) : undefined;
    if (unreadable) unreadableWhenLoaded.set(merged, unreadable);
    if (warnings.size) hookWarnings.set(merged, [...warnings]);
    return merged;
}

/** Servers add up by name across layers (a later one replaces one of the same name); a later on/off wins. */
function mergeLsp(prev: Settings["lsp"], next: Settings["lsp"]): Settings["lsp"] {
    if (next === false || next === null || typeof next !== "object") return next === false ? false : prev;
    const base = typeof prev === "object" && prev !== null ? prev : {};
    const servers = next.servers && typeof next.servers === "object" ? { ...base.servers, ...next.servers } : base.servers;
    const enabled = next.enabled ?? (prev === false ? false : base.enabled);
    return { ...(enabled !== undefined ? { enabled } : {}), ...(servers ? { servers } : {}) };
}

/** Any layer can turn the sandbox off; hosts and exemptions come from the user's own settings only. */
function mergeSandbox(merged: Settings, layers: Settings[], user: Settings) {
    delete merged.sandbox;
    const enabled = layers.map(sandboxSwitch).filter((v): v is boolean => typeof v === "boolean").at(-1);
    const allowedHosts = sandboxAllowedHosts(user);
    const excludedCommands = sandboxExcludedCommands(user);
    if (!allowedHosts.length && !excludedCommands.length) {
        if (enabled !== undefined) merged.sandbox = enabled;
        return;
    }
    merged.sandbox = { ...(enabled !== undefined ? { enabled } : {}), ...(allowedHosts.length ? { allowedHosts } : {}), ...(excludedCommands.length ? { excludedCommands } : {}) };
}

/** Each layer adds approvals and rejections; a later one decides a name both approve. */
function mergeMcpApprovals(merged: Settings, own: Settings[]) {
    const user = own[0]!;
    delete merged.approvedMcpjsonServers;
    delete merged.enabledMcpjsonServers;
    delete merged.disabledMcpjsonServers;
    delete merged.enableAllProjectMcpServers;
    const names = (k: "enabledMcpjsonServers" | "disabledMcpjsonServers") => {
        const all = own.flatMap((s) => (Array.isArray(s[k]) ? s[k]! : []));
        return all.length ? [...new Set(all)] : undefined;
    };
    const approved: Record<string, string> = {};
    for (const s of own) {
        const a = s.approvedMcpjsonServers;
        if (a && typeof a === "object" && !Array.isArray(a)) for (const [k, v] of Object.entries(a)) if (typeof v === "string") Object.defineProperty(approved, k, { value: v, enumerable: true, writable: true, configurable: true });
    }
    if (Object.keys(approved).length) merged.approvedMcpjsonServers = approved;
    if (user.enableAllProjectMcpServers === true) merged.enableAllProjectMcpServers = true;
    const enabled = names("enabledMcpjsonServers");
    const disabled = names("disabledMcpjsonServers");
    if (enabled) merged.enabledMcpjsonServers = enabled;
    if (disabled) merged.disabledMcpjsonServers = disabled;
}

function restrictiveOnly(s: Settings): Settings {
    return { permissions: { deny: s.permissions?.deny, ask: s.permissions?.ask } };
}

/** Read-modify-write one settings file. */
export function updateSettings(scope: SettingsScope, cwd: string, fn: (s: Settings) => void) {
    const file = settingsPath(scope, cwd);
    const s = readJsonForUpdate<Settings>(file) ?? {};
    fn(s);
    writeJson(file, s);
    if (scope === "local") ensureLocalGitignore(cwd);
}

/** Keep settings.local.json out of git without touching the user's root .gitignore. */
function ensureLocalGitignore(cwd: string) {
    const gi = join(paths.projectDir(cwd), ".gitignore");
    try {
        if (!existsSync(gi)) writeFileSync(gi, "settings.local.json\n");
    } catch {
        // best effort
    }
}

export function addPermissionRule(scope: SettingsScope, cwd: string, list: "allow" | "deny" | "ask", rule: string) {
    updateSettings(scope, cwd, (s) => {
        const p = (s.permissions ??= {});
        const arr = (p[list] ??= []);
        if (!arr.includes(rule)) arr.push(rule);
    });
}

export function removePermissionRule(scope: SettingsScope, cwd: string, rule: string): boolean {
    let removed = false;
    updateSettings(scope, cwd, (s) => {
        for (const list of ["allow", "deny", "ask"] as const) {
            const arr = s.permissions?.[list];
            if (!arr) continue;
            const idx = arr.indexOf(rule);
            if (idx >= 0) {
                arr.splice(idx, 1);
                removed = true;
            }
        }
    });
    return removed;
}
