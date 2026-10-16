import type { McpServerConfig } from "../config/settings";
import { MCP_SERVER_NAME } from "../agent/delegation";
import { serverSegment } from "../mcp/manager";
import { redact } from "../util/redact";

export type ClaudeMcpServer =
    | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
    | { type: "http"; url: string; headers?: Record<string, string> };

function stringMap(value: unknown): value is Record<string, string> {
    return value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string");
}

/** Only Harness fields cross this boundary; Claude-only fields can execute unapproved commands. */
export function claudeMcpServers(approved: Record<string, McpServerConfig>, warn: (message: string) => void): Record<string, ClaudeMcpServer> {
    const entries: [string, ClaudeMcpServer][] = [];
    const omitted: string[] = [];
    for (const [name, cfg] of Object.entries(approved)) {
        const skip = (why: string) => omitted.push(`${redact(name)} (${why})`);
        if (serverSegment(name) === MCP_SERVER_NAME) { skip("reserved for Harness delegation"); continue; }
        if (cfg.disabled) continue;
        // Claude 2.1.301 ignores cwd even over mcp_set_servers. Do not silently run in another folder.
        if (cfg.cwd !== undefined) { skip("Claude Code cannot honor a server cwd"); continue; }
        if (cfg.url) {
            if (typeof cfg.url !== "string" || (cfg.headers !== undefined && !stringMap(cfg.headers))) throw new Error("Invalid MCP HTTP configuration");
            // Unlike Harness, Claude expands HTTP headers even on its stdin control path.
            if (Object.values(cfg.headers ?? {}).some((v) => v.includes("${"))) { skip("Claude Code would expand HTTP header variables"); continue; }
            entries.push([name, { type: "http", url: cfg.url, ...(cfg.headers ? { headers: { ...cfg.headers } } : {}) }]);
        } else {
            if (typeof cfg.command !== "string" || !cfg.command || (cfg.args !== undefined && (!Array.isArray(cfg.args) || !cfg.args.every((v) => typeof v === "string"))) || (cfg.env !== undefined && !stringMap(cfg.env))) throw new Error("Invalid MCP stdio configuration");
            // mcp_set_servers preserves literal ${VAR} and ~ in command/args/env, as Harness does.
            entries.push([name, { type: "stdio", command: cfg.command, ...(cfg.args ? { args: [...cfg.args] } : {}), ...(cfg.env ? { env: { ...cfg.env } } : {}) }]);
        }
    }
    if (omitted.length) warn(`MCP servers omitted from Claude Code: ${omitted.join("; ")}.`);
    return Object.fromEntries(entries);
}

/** --mcp-config is variadic: leaving any explicit config would bypass the manager even in strict mode. */
export function withoutMcpConfig(args: string[], warn?: (message: string) => void): string[] {
    const out: string[] = [];
    let skipping = false;
    let removed = false;
    for (const arg of args) {
        if (arg === "--mcp-config" || arg.startsWith("--mcp-config=")) {
            skipping = removed = true;
        } else if (skipping && !arg.startsWith("-")) continue;
        else { skipping = false; out.push(arg); }
    }
    if (removed) warn?.("Ignored extra Claude Code --mcp-config arguments; Harness supplies the approved MCP servers.");
    return out;
}
