import { lstatSync, readFileSync, realpathSync } from "fs";
import { dirname, join } from "path";
import { isDeepStrictEqual } from "util";
import type { ApprovedMcpServers } from "../mcp/manager";
import { MCP_SERVER_NAME } from "../agent/delegation";

interface ClaudeMcpPolicy {
    strict: boolean;
    settings?: { enabledMcpjsonServers: string[]; disabledMcpjsonServers: string[] };
    warning?: string;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The definition fields Harness's approval fingerprint covers (mcpFingerprint), plus ones that
 * run nothing. Claude Code acts on others (headersHelper runs a program, oauth signs in), which
 * an approval doesn't bind, so a definition with any other field isn't passed on.
 */
const BOUND_FIELDS = new Set(["command", "args", "env", "cwd", "url", "headers", "type", "disabled"]);

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
                const bound = Object.keys(config).every((k) => BOUND_FIELDS.has(k));
                if (!bound && entry?.source === "project") unboundField = true;
                if (name !== MCP_SERVER_NAME && entry?.source === "project" && bound && isDeepStrictEqual(config, entry.config)) {
                    // Claude ignores server cwd; compare the directory Harness would actually use.
                    if (realpathSync(entry.config.cwd ?? approved.cwd) === real) enabled.push(name);
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
            ...(incompatibleCwd || unboundField ? { warning: [
                incompatibleCwd && "Claude Code skipped approved project MCP servers whose working directory differs from the project root because it ignores server cwd.",
                unboundField && "Claude Code skipped approved project MCP servers whose .mcp.json definitions use fields a Harness approval doesn't cover (such as headersHelper or oauth).",
            ].filter(Boolean).join(" ") } : {}),
        };
    } catch {
        // Paths, file contents and parser errors can contain credentials. Report only a static reason.
        return fallback("project MCP configuration or its directory could not be read");
    }
}
