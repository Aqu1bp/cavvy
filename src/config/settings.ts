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
    /** Servers from the project's .mcp.json the user approved. */
    enabledMcpjsonServers?: string[];
    disabledMcpjsonServers?: string[];
    /** Approve every server in the project's .mcp.json. */
    enableAllProjectMcpServers?: boolean;
    /** Custom status line: a shell command whose first output line is shown. */
    statusLine?: { command: string };
    /** Auto mode runs shell commands in a sandbox where the OS has one (default true). */
    sandbox?: boolean;
    /** How to alert you to a long turn ending, a prompt or an error while the window isn't focused (auto: terminal or bell). */
    notifications?: NotificationMode;
    /** A finished turn alerts only when it took at least this long (default 30). */
    notifyAfterSeconds?: number;
    /** Claude Code and Codex get tools to hand tasks to other providers' models (default true). */
    delegation?: boolean;
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
 * project shouldn't choose who checks the actions taken in it.
 */
export function loadSettings(cwd: string, opts: { trusted?: boolean } = {}): Settings {
    const trusted = opts.trusted ?? true;
    const user = loadScope("user", cwd);
    const layers = trusted
        ? [user, loadScope("project", cwd), loadScope("local", cwd)]
        : [user, restrictiveOnly(loadScope("project", cwd)), restrictiveOnly(loadScope("local", cwd))];
    const merged: Settings = {};
    for (const s of layers) {
        const { permissions, env, mcpServers, hooks, ...rest } = s;
        Object.assign(merged, rest);
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
    return merged;
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
