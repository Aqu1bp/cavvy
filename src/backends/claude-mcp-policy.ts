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

/** Only names enter argv. Current definitions must still match the manager's project approval snapshot. */
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
        const file = join(cwd, ".mcp.json");
        if (exists(file)) {
            const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
            if (!record(parsed) || !record(parsed.mcpServers)) return fallback("the project MCP configuration is malformed");
            for (const [name, config] of Object.entries(parsed.mcpServers)) {
                // Claude's documented name grammar; special object keys cannot safely identify a server.
                if (!/^[a-zA-Z0-9_-]+$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) return fallback("a project MCP server name cannot be expressed safely");
                if (!record(config)) return fallback("a project MCP server definition is malformed");
                const entry = Object.hasOwn(approved.servers, name) ? approved.servers[name] : undefined;
                if (name !== MCP_SERVER_NAME && entry?.source === "project" && isDeepStrictEqual(config, entry.config)) enabled.push(name);
                else disabled.add(name);
            }
        }
        // disabledMcpjsonServers rejects entries in every mode, including -p; enableAll from other settings cannot override it.
        // https://code.claude.com/docs/en/mcp#project-server-approvals-and-workspace-trust
        return { strict: false, settings: { enabledMcpjsonServers: enabled.sort(), disabledMcpjsonServers: [...disabled].sort() } };
    } catch {
        // Paths, file contents and parser errors can contain credentials. Report only a static reason.
        return fallback("project MCP configuration or its directory could not be read");
    }
}
