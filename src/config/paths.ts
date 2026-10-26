import { homedir } from "os";
import { join, resolve } from "path";
import { mkdirSync } from "fs";

export { APP_NAME } from "./name";
export const APP_TITLE = "Cavvy";
export const APP_VERSION = "1.0.0";

/** Root of all user-level state. Override with CAVVY_HOME. */
export function cavvyHome(): string {
    return process.env.CAVVY_HOME ? resolve(process.env.CAVVY_HOME) : join(homedir(), ".cavvy");
}

export const paths = {
    home: () => cavvyHome(),
    userSettings: () => join(cavvyHome(), "settings.json"),
    providers: () => join(cavvyHome(), "providers.json"),
    credentialsFile: () => join(cavvyHome(), "credentials.json"),
    /** OAuth tokens for remote MCP servers (src/mcp/oauth.ts): part of the credential store. */
    mcpOAuth: () => join(cavvyHome(), "mcp-oauth.json"),
    history: () => join(cavvyHome(), "history.jsonl"),
    modelCache: () => join(cavvyHome(), "cache", "models.json"),
    /** The last plan limits the agent CLIs reported (src/server/limits-store.ts). */
    planLimits: () => join(cavvyHome(), "limits.json"),
    userCommands: () => join(cavvyHome(), "commands"),
    userAgents: () => join(cavvyHome(), "agents"),
    userMemory: () => join(cavvyHome(), "CAVVY.md"),
    projectsDir: () => join(cavvyHome(), "projects"),
    logs: () => join(cavvyHome(), "logs"),
    plugins: () => join(cavvyHome(), "plugins"),

    projectDir: (cwd: string) => join(cwd, ".cavvy"),
    projectSettings: (cwd: string) => join(cwd, ".cavvy", "settings.json"),
    localSettings: (cwd: string) => join(cwd, ".cavvy", "settings.local.json"),
    projectCommands: (cwd: string) => join(cwd, ".cavvy", "commands"),
    projectAgents: (cwd: string) => join(cwd, ".cavvy", "agents"),
    projectMcp: (cwd: string) => join(cwd, ".mcp.json"),
};

/** Directory for a project's sessions: ~/.cavvy/projects/<slug>/ */
export function projectStateDir(cwd: string): string {
    const slug = resolve(cwd).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(-120) || "root";
    return join(paths.projectsDir(), slug);
}

export function ensureDir(dir: string, mode = 0o700): string {
    mkdirSync(dir, { recursive: true, mode });
    return dir;
}
