import { lstatSync, readFileSync, realpathSync } from "fs";
import { dirname, join } from "path";
import { isDeepStrictEqual } from "util";
import type { ApprovedMcpServers } from "../mcp/manager";
import { MCP_SERVER_NAME } from "../agent/delegation";
import { mcpFingerprint, serverCwd } from "../mcp/approval";

interface ClaudeMcpPolicy {
    strict: boolean;
    settings?: { enabledMcpjsonServers: string[]; disabledMcpjsonServers: string[] };
    warning?: string;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The definition fields Cavvy's approval fingerprint covers (mcpFingerprint), plus ones that
 * run nothing. Claude Code acts on others (headersHelper runs a program), which an approval
 * doesn't bind, so a definition with any other field isn't passed on. `oauth` is fingerprinted:
 * Claude Code signs in to such a server itself.
 */
const BOUND_FIELDS = new Set(["command", "args", "env", "cwd", "url", "headers", "type", "disabled", "oauth"]);

/** Claude Code expands ${VAR} in definitions; Cavvy doesn't, so an approval binds only the literal text. */
const expands = (v: unknown): boolean => typeof v === "string" ? v.includes("${") : Array.isArray(v) ? v.some(expands) : record(v) ? Object.values(v).some(expands) : false;

/** One transport, as Claude Code will read it: `type` isn't fingerprinted, so it may not pick between a command and a URL. */
function oneTransport(config: Record<string, unknown>): boolean {
    const command = config.command !== undefined, url = config.url !== undefined;
    // Without a type Claude Code reads a stdio server, and skips one that has only a URL.
    if (config.type === undefined) return command && !url;
    if (config.type === "stdio") return command && !url;
    if (config.type === "http" || config.type === "sse") return url && !command;
    return false;
}

/**
 * An oauth block Claude Code reads as Cavvy does: its schema has scopes as one string and no
 * inline clientSecret (it keeps that in its own credential store), so a block with either isn't passed on.
 */
const claudeOAuth = (oauth: unknown) => oauth === undefined || (record(oauth) && Object.keys(oauth).every((k) => ["clientId", "callbackPort", "scopes"].includes(k)) && (oauth.scopes === undefined || typeof oauth.scopes === "string"));

/** What Claude Code would run is exactly what the approval covers. */
const bound = (config: Record<string, unknown>) => Object.keys(config).every((k) => BOUND_FIELDS.has(k)) && claudeOAuth(config.oauth) && oneTransport(config) && !expands(config);

function exists(file: string): boolean {
    try {
        lstatSync(file);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

/** Claude 2.1.301 reads physical ancestor .mcp.json files too, but not descendants or --add-dir folders. */
function hasAncestorConfig(cwd: string): boolean {
    let dir = cwd;
    while (dirname(dir) !== dir) {
        dir = dirname(dir);
        if (exists(join(dir, ".mcp.json"))) return true;
    }
    return false;
}

/** Only names enter argv. The snapshot contains only mayStart() servers; Claude's raw definitions must match it exactly. */
export function claudeMcpPolicy(cwd: string, approved: ApprovedMcpServers | undefined): ClaudeMcpPolicy {
    const fallback = (reason: string): ClaudeMcpPolicy => ({ strict: true, warning: `Claude Code uses strict MCP isolation: ${reason}.` });
    if (!approved) return fallback("the MCP manager snapshot is unavailable");
    try {
        const real = realpathSync(cwd);
        if (real !== realpathSync(approved.cwd)) return fallback("the turn directory differs from the MCP manager's folder");
        if (hasAncestorConfig(real)) return fallback("an ancestor has MCP configuration outside the manager's folder");
        if (!record(approved.servers)) return fallback("the MCP manager snapshot is invalid");
        const enabled: string[] = [];
        const disabled = new Set([MCP_SERVER_NAME]);
        let incompatibleCwd = false;
        let unboundField = false;
        let stale = false;
        const file = join(cwd, ".mcp.json");
        if (exists(file)) {
            // Claude rereads this file after our check: a race requires a concurrent
            // writer in that narrow window. Accepted for now only in trusted writable
            // turns; untrusted and read-only turns stay strict.
            const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
            if (!record(parsed) || !record(parsed.mcpServers)) return fallback("the project MCP configuration is malformed");
            for (const [name, config] of Object.entries(parsed.mcpServers)) {
                // Claude's documented name grammar; special object keys cannot safely identify a server.
                if (!/^[a-zA-Z0-9_-]+$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) return fallback("a project MCP server name cannot be expressed safely");
                if (!record(config)) return fallback("a project MCP server definition is malformed");
                const entry = Object.hasOwn(approved.servers, name) ? approved.servers[name] : undefined;
                // These names convey the manager's config-bound approvals to Claude, never legacy name-only approvals.
                const covered = bound(config);
                if (!covered && entry?.source === "project") unboundField = true;
                if (name !== MCP_SERVER_NAME && entry?.source === "project" && covered && isDeepStrictEqual(config, entry.config)) {
                    // What it resolves to now (a symlinked cwd may point elsewhere since load()) must still be what was approved.
                    if (!entry.fingerprint || mcpFingerprint(entry.config, approved.cwd) !== entry.fingerprint) {
                        disabled.add(name);
                        stale = true;
                    }
                    // Claude ignores server cwd; compare the directory Cavvy would actually use (a relative one is the project's).
                    else if (serverCwd(entry.config, approved.cwd) === real) enabled.push(name);
                    else {
                        disabled.add(name);
                        incompatibleCwd = true;
                    }
                } else disabled.add(name);
            }
        }
        // disabledMcpjsonServers rejects entries in every mode, including -p; enableAll from other settings cannot override it.
        // https://code.claude.com/docs/en/mcp#project-server-approvals-and-workspace-trust
        return {
            strict: false,
            settings: { enabledMcpjsonServers: enabled.sort(), disabledMcpjsonServers: [...disabled].sort() },
            ...(incompatibleCwd || unboundField || stale ? { warning: [
                incompatibleCwd && "Claude Code skipped approved project MCP servers whose working directory differs from the project root because it ignores server cwd.",
                stale && "Claude Code skipped approved project MCP servers whose definitions no longer resolve to what was approved (a symlinked working directory may point elsewhere now); reopen /mcp to review them.",
                unboundField && "Claude Code skipped approved project MCP servers that it would read differently from what Cavvy approved: fields an approval doesn't cover (such as headersHelper) or an oauth block it reads differently (an inline clientSecret, scopes as a list), ${VAR} expansion, or a type that doesn't match a single command or URL.",
            ].filter(Boolean).join(" ") } : {}),
        };
    } catch {
        // Paths, file contents and parser errors can contain credentials. Report only a static reason.
        return fallback("project MCP configuration or its directory could not be read");
    }
}
