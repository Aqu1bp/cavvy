// Codex's own computer use, as the ChatGPT app sets it up in Codex's home (its unified-computer-use plugin), is kept
// off in every Codex thread Cavvy runs: its service doesn't serve a Codex the ChatGPT app didn't start (measured with
// Codex 0.169, the app open). Codex uses Cavvy's Mac app tools instead, over Cavvy's MCP server, as Claude Code does.

/**
 * The MCP servers Codex's computer use runs as: `cua_repl` (the ChatGPT app's unified-computer-use plugin, Codex
 * 0.167–0.169 and ChatGPT 26.1106), and the names older builds used (`computer-use`, `node_repl`). Each is turned off by name.
 */
export const CODEX_CU_SERVERS = ["cua_repl", "computer-use", "node_repl"] as const;
/** The ChatGPT app's plugins that bring it (its bundled marketplace): each is turned off. */
export const CODEX_CU_PLUGINS = ["unified-computer-use@openai-bundled", "computer-use@openai-bundled"] as const;

/** A thread's config for Codex: its MCP servers and plugins by name, and other keys. */
export type ThreadConfig = { mcp_servers?: Record<string, unknown>; plugins?: Record<string, unknown>; [key: string]: unknown };

const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The thread config that keeps it off, from Codex's effective config (config/read): its plugins turned off where
 * they're on, and a server of its names turned off where one is configured (Codex refuses an entry for a server that
 * has none). Empty when there's nothing to turn off.
 */
export function computerUseOffConfig(effective: unknown): ThreadConfig {
    const config = record(effective) ? effective : {};
    const plugins = record(config.plugins) ? config.plugins : {};
    const servers = record(config.mcp_servers) ? config.mcp_servers : {};
    const pluginsOff = CODEX_CU_PLUGINS.filter((id) => record(plugins[id]) && plugins[id].enabled !== false);
    const serversOff = CODEX_CU_SERVERS.filter((n) => Object.hasOwn(servers, n));
    const off = (names: readonly string[]) => Object.fromEntries(names.map((n) => [n, { enabled: false as const }]));
    return { ...(pluginsOff.length ? { plugins: off(pluginsOff) } : {}), ...(serversOff.length ? { mcp_servers: off(serversOff) } : {}) };
}

/** Two thread configs as one: their MCP servers and plugins merged (the second's win), anything else the second's. */
export function mergeThreadConfig(a: ThreadConfig | undefined, b: ThreadConfig | undefined): ThreadConfig | undefined {
    if (!b || !Object.keys(b).length) return a;
    if (!a) return b;
    const merged: ThreadConfig = { ...a, ...b };
    for (const key of ["mcp_servers", "plugins"]) {
        const x = a[key];
        const y = b[key];
        if (record(x) || record(y)) merged[key] = { ...(record(x) ? x : {}), ...(record(y) ? y : {}) };
    }
    return merged;
}

/** One of Codex's computer-use servers. */
export function isComputerUseServer(server: unknown): boolean {
    return typeof server === "string" && (CODEX_CU_SERVERS as readonly string[]).includes(server);
}

/**
 * Whether an elicitation Codex passes on (mcpServer/elicitation/request) comes from its computer use: from one of its
 * servers, or naming its connector (an app approval). Kept off, any that still arrives is declined.
 */
export function fromComputerUse(p: any): boolean {
    return (record(p?._meta) && p._meta.connector_id === "computer-use") || isComputerUseServer(p?.serverName);
}
