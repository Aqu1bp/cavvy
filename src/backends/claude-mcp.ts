import { realpathSync } from "fs";
import type { McpServerConfig } from "../config/settings";
import { MCP_SERVER_NAME } from "../agent/delegation";
import { serverSegment } from "../mcp/manager";
import { redact } from "../util/redact";

export type ClaudeMcpServer =
    | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
    | { type: "http"; url: string; headers?: Record<string, string> };

function isStringMap(value: unknown): value is Record<string, string> {
    return value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string");
}

/** Only Harness fields cross this boundary; Claude-only fields can execute unapproved commands. */
export function claudeMcpServers(approved: Record<string, McpServerConfig>, cwd: string, warn: (message: string) => void): Record<string, ClaudeMcpServer> {
    const entries: [string, ClaudeMcpServer][] = [];
    const omitted: string[] = [];
    for (const [name, cfg] of Object.entries(approved)) {
        const skip = (why: string) => omitted.push(`${redact(name)} (${why})`);
        if (serverSegment(name) === MCP_SERVER_NAME) { skip("reserved for Harness delegation"); continue; }
        if (cfg.disabled) continue;
        if (cfg.url) {
            if (typeof cfg.url !== "string" || (cfg.headers !== undefined && !isStringMap(cfg.headers))) throw new Error("Invalid MCP HTTP configuration");
            // Unlike Harness, Claude expands HTTP headers even on its stdin control path.
            if (Object.values(cfg.headers ?? {}).some((v) => v.includes("${"))) { skip("Claude Code would expand HTTP header variables"); continue; }
            entries.push([name, { type: "http", url: cfg.url, ...(cfg.headers ? { headers: { ...cfg.headers } } : {}) }]);
        } else {
            if (typeof cfg.command !== "string" || !cfg.command || (cfg.args !== undefined && (!Array.isArray(cfg.args) || !cfg.args.every((v) => typeof v === "string"))) || (cfg.env !== undefined && !isStringMap(cfg.env))) throw new Error("Invalid MCP stdio configuration");
            // Claude ignores cwd even over mcp_set_servers; relative commands must still refer to the approved files.
            if (typeof cfg.cwd !== "string") { skip("server launch directory is unavailable"); continue; }
            if (realpathSync(cfg.cwd) !== realpathSync(cwd)) { skip("server launch directory differs from the Claude Code turn"); continue; }
            // mcp_set_servers preserves literal ${VAR} and ~ in command/args/env, as Harness does.
            entries.push([name, { type: "stdio", command: cfg.command, ...(cfg.args ? { args: [...cfg.args] } : {}), ...(cfg.env ? { env: { ...cfg.env } } : {}) }]);
        }
    }
    if (omitted.length) warn(`MCP servers omitted from Claude Code: ${omitted.join("; ")}.`);
    return Object.fromEntries(entries);
}
