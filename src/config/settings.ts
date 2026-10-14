import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { ensureDir, paths } from "./paths";
import type { PermissionMode } from "../permissions/modes";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

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
    /** Cheaper model used for the auto-mode classifier, titles and summaries. */
    smallModel?: string;
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
}

export type SettingsScope = "user" | "project" | "local";

export function settingsPath(scope: SettingsScope, cwd: string): string {
    if (scope === "user") return paths.userSettings();
    if (scope === "project") return paths.projectSettings(cwd);
    return paths.localSettings(cwd);
}

export function readJson<T>(file: string): T | undefined {
    try {
        if (!existsSync(file)) return undefined;
        const text = readFileSync(file, "utf-8");
        if (!text.trim()) return undefined;
        return JSON.parse(stripJsonComments(text)) as T;
    } catch (e) {
        process.stderr.write(`warning: could not parse ${file}: ${(e as Error).message}\n`);
        return undefined;
    }
}

/** Allow // and /* *\/ comments in settings files. Strings are respected. */
function stripJsonComments(text: string): string {
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
 * stricter, and /permissions can save local rules in any folder).
 */
export function loadSettings(cwd: string, opts: { trusted?: boolean } = {}): Settings {
    const trusted = opts.trusted ?? true;
    const layers = trusted
        ? [loadScope("user", cwd), loadScope("project", cwd), loadScope("local", cwd)]
        : [loadScope("user", cwd), restrictiveOnly(loadScope("project", cwd)), restrictiveOnly(loadScope("local", cwd))];
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
    return merged;
}

function restrictiveOnly(s: Settings): Settings {
    return { permissions: { deny: s.permissions?.deny, ask: s.permissions?.ask } };
}

/** Read-modify-write one settings file. */
export function updateSettings(scope: SettingsScope, cwd: string, fn: (s: Settings) => void) {
    const file = settingsPath(scope, cwd);
    const s = readJson<Settings>(file) ?? {};
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
