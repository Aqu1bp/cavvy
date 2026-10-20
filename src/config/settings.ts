import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { ensureDir, paths } from "./paths";
import type { PermissionMode } from "../permissions/modes";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export type NotificationMode = "auto" | "terminal" | "bell" | "system" | "off";
export const NOTIFICATION_MODES: NotificationMode[] = ["auto", "terminal", "bell", "system", "off"];

export interface McpServerConfig {
    /** stdio transport */
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    /** http transport (streamable HTTP) */
    url?: string;
    headers?: Record<string, string>;
    disabled?: boolean;
}

export interface HookConfig {
    /** Tool-name matcher: exact name, "*" or a regex like "Edit|Write". */
    matcher?: string;
    command: string;
    timeout?: number;
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
    /** Extra environment variables for Bash tool commands. */
    env?: Record<string, string>;
    mcpServers?: Record<string, McpServerConfig>;
    hooks?: {
        PreToolUse?: HookConfig[];
        PostToolUse?: HookConfig[];
        UserPromptSubmit?: HookConfig[];
        Stop?: HookConfig[];
        SubagentStop?: HookConfig[];
        Notification?: HookConfig[];
        SessionStart?: HookConfig[];
        SessionEnd?: HookConfig[];
        PreCompact?: HookConfig[];
    };
    /** Show model reasoning/thinking text when the provider returns it. */
    showThinking?: boolean;
    /** Upper bound for max output tokens per response. */
    maxOutputTokens?: number;
    /** Web search backend: auto picks the first available. */
    webSearch?: "auto" | "anthropic" | "brave" | "tavily" | "duckduckgo" | "off";
    /** Bash tool default timeout in ms. */
    bashTimeout?: number;
    /** Claude Code's shell/Monitor grace after an answer; agents keep their own limit. */
    claudeCode?: { backgroundWaitSec?: number };
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
    followUpBehavior?: "steer" | "queue";
    /** Claude Code and Codex get tools to hand tasks to other providers' models (default true). */
    delegation?: boolean;
    /** The GUI's "Open files with" editor, an id from src/server/editors.ts. User settings only: a project mustn't choose what gets launched. */
    editor?: string;
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
        super(`Can't update ${file}: it isn't valid JSON (${reason}). Fix or remove the file, then try again.`);
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
        const msg = e instanceof JsonFileError ? `${file} isn't valid JSON, so it's being ignored (${e.reason})` : `could not read ${file}: ${(e as Error).message}`;
        if (!warned.has(msg)) {
            warned.add(msg);
            warn(msg);
        }
        return undefined;
    }
}

/** Allow // and /* *\/ comments and trailing commas in settings files. Strings are respected. */
function stripJsonComments(text: string): string {
    return stripTrailingCommas(stripComments(text));
}

function stripTrailingCommas(text: string): string {
    let out = "";
    let inStr = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (inStr) {
            out += c;
            if (c === "\\") out += text[++i] ?? "";
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        if (c === ",") {
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j]!)) j++;
            if (text[j] === "}" || text[j] === "]") continue;
        }
        out += c;
    }
    return out;
}

function stripComments(text: string): string {
    let out = "";
    let inStr = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        const n = text[i + 1];
        if (inStr) {
            out += c;
            if (c === "\\") {
                out += n ?? "";
                i++;
            } else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') {
            inStr = true;
            out += c;
        } else if (c === "/" && n === "/") {
            while (i < text.length && text[i] !== "\n") i++;
            out += "\n";
        } else if (c === "/" && n === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
            i++;
        } else out += c;
    }
    return out;
}

export function writeJson(file: string, data: unknown, mode = 0o644) {
    ensureDir(dirname(file));
    writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode });
}

export function loadScope(scope: SettingsScope, cwd: string): Settings {
    return readJson<Settings>(settingsPath(scope, cwd)) ?? {};
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
export function loadSettings(cwd: string, opts: { trusted?: boolean } = {}): Settings {
    const trusted = opts.trusted ?? true;
    const user = loadScope("user", cwd);
    const local = loadScope("local", cwd);
    const layers = trusted ? [user, loadScope("project", cwd), local] : [user, restrictiveOnly(loadScope("project", cwd)), restrictiveOnly(local)];
    const merged: Settings = {};
    for (const s of layers) {
        const { permissions, env, mcpServers, hooks, ...rest } = s;
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
        if (mcpServers) merged.mcpServers = { ...merged.mcpServers, ...mcpServers };
        if (hooks) {
            const h = (merged.hooks ??= {});
            for (const [k, v] of Object.entries(hooks) as [keyof NonNullable<Settings["hooks"]>, HookConfig[]][]) {
                h[k] = [...(h[k] ?? []), ...v];
            }
        }
    }
    if (user.reviewModel) merged.reviewModel = user.reviewModel;
    else delete merged.reviewModel;
    mergeSandbox(merged, layers, user);
    mergeMcpApprovals(merged, trusted ? [user, local] : [user]);
    return merged;
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
