// Which language server handles which files. Built-in servers run only when
// their binary is installed; settings add more or change them, in the shape
// of Claude Code's plugin `lspServers`, so a plugin can supply them too:
//
//   "lsp": { "servers": { "deno": { "command": "deno", "args": ["lsp"], "extensionToLanguage": { ".ts": "typescript" } } } }
//
// `"lsp": false` (or `{ "enabled": false }`) turns diagnostics after edits off.

import { existsSync } from "fs";
import { extname, isAbsolute, join } from "path";
import type { Settings } from "../config/settings";

export interface LspServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    /** File extension (with the dot) to LSP language id. */
    extensionToLanguage: Record<string, string>;
    initializationOptions?: unknown;
    /** Answers to the server's workspace/configuration requests, by section ("python.analysis"). */
    settings?: Record<string, unknown>;
    /** How long to wait for it to start, in ms (default 15000). */
    startupTimeout?: number;
    disabled?: boolean;
}

export interface LspServer extends LspServerConfig {
    name: string;
    /** Where it came from: a built-in only runs when its binary is found, and a missing one says nothing. */
    builtin: boolean;
}

const TS = { ".ts": "typescript", ".tsx": "typescriptreact", ".mts": "typescript", ".cts": "typescript", ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript", ".cjs": "javascript" };

/** Tried in order: the first whose command is found handles its extensions. */
export const BUILTIN_SERVERS: Record<string, LspServerConfig> = {
    // One tsserver, not two: the separate syntax server only speeds up editor features the harness doesn't use.
    typescript: { command: "typescript-language-server", args: ["--stdio"], extensionToLanguage: TS, initializationOptions: { tsserver: { useSyntaxServer: "never" } } },
    pyright: { command: "pyright-langserver", args: ["--stdio"], extensionToLanguage: { ".py": "python", ".pyi": "python" } },
    basedpyright: { command: "basedpyright-langserver", args: ["--stdio"], extensionToLanguage: { ".py": "python", ".pyi": "python" } },
    gopls: { command: "gopls", extensionToLanguage: { ".go": "go" } },
    "rust-analyzer": { command: "rust-analyzer", extensionToLanguage: { ".rs": "rust" } },
    clangd: { command: "clangd", extensionToLanguage: { ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp" } },
};

export function lspEnabled(s: Settings): boolean {
    if (s.lsp === false) return false;
    return !(typeof s.lsp === "object" && s.lsp !== null && s.lsp.enabled === false);
}

/** Servers from settings (with plugins' merged in), each checked for the fields it needs. */
function configured(s: Settings): Record<string, LspServerConfig> {
    const raw = typeof s.lsp === "object" && s.lsp !== null ? s.lsp.servers : undefined;
    const out: Record<string, LspServerConfig> = {};
    if (!raw || typeof raw !== "object") return out;
    for (const [name, c] of Object.entries(raw)) {
        if (name === "__proto__" || !c || typeof c !== "object") continue;
        out[name] = c as LspServerConfig;
    }
    return out;
}

function valid(c: LspServerConfig): boolean {
    return typeof c.command === "string" && c.command.trim() !== "" && !!c.extensionToLanguage && typeof c.extensionToLanguage === "object" && (c.args === undefined || (Array.isArray(c.args) && c.args.every((a) => typeof a === "string")));
}

/**
 * Every server that could run, settings' first (in their order), then the
 * built-ins they don't replace. A settings server named like a built-in
 * replaces it, and `disabled: true` turns either off.
 */
export function lspServers(s: Settings): LspServer[] {
    const mine = configured(s);
    const out: LspServer[] = [];
    for (const [name, c] of Object.entries(mine)) if (!c.disabled && valid(c)) out.push({ ...c, name, builtin: false });
    for (const [name, c] of Object.entries(BUILTIN_SERVERS)) if (!(name in mine)) out.push({ ...c, name, builtin: true });
    return out;
}

/** The server for a file and its language id, among those `available` says can run. */
export function serverFor(path: string, servers: LspServer[], available: (s: LspServer) => boolean): { server: LspServer; languageId: string } | undefined {
    const ext = extname(path).toLowerCase();
    if (!ext) return undefined;
    for (const server of servers) {
        const languageId = server.extensionToLanguage[ext] ?? server.extensionToLanguage[extname(path)];
        if (typeof languageId === "string" && available(server)) return { server, languageId };
    }
    return undefined;
}

/**
 * The executable for a server's command: an explicit path as is, else the
 * project's node_modules/.bin (trusted folders only: it's the repo's own
 * code), else PATH. Undefined when it isn't installed.
 */
export function resolveCommand(command: string, root: string, trusted: boolean, env?: Record<string, string>): string | undefined {
    if (command.includes("/")) {
        const abs = isAbsolute(command) ? command : join(root, command);
        return existsSync(abs) ? abs : undefined;
    }
    if (trusted) {
        const local = join(root, "node_modules", ".bin", command);
        if (existsSync(local)) return local;
    }
    return Bun.which(command, env?.PATH ? { PATH: env.PATH } : undefined) ?? undefined;
}
