import { homedir } from "os";
import { join, resolve } from "path";
import { mkdirSync } from "fs";

export { APP_NAME } from "./name";
export const APP_TITLE = "Harness";
export const APP_VERSION = "1.0.0";

/** Root of all user-level state. Override with HARNESS_HOME. */
export function harnessHome(): string {
    return process.env.HARNESS_HOME ? resolve(process.env.HARNESS_HOME) : join(homedir(), ".harness");
}

export const paths = {
    home: () => harnessHome(),
    userSettings: () => join(harnessHome(), "settings.json"),
    providers: () => join(harnessHome(), "providers.json"),
    credentialsFile: () => join(harnessHome(), "credentials.json"),
    /** OAuth tokens for remote MCP servers (src/mcp/oauth.ts): part of the credential store. */
    mcpOAuth: () => join(harnessHome(), "mcp-oauth.json"),
    history: () => join(harnessHome(), "history.jsonl"),
    modelCache: () => join(harnessHome(), "cache", "models.json"),
    /** The last plan limits the agent CLIs reported (src/server/limits-store.ts). */
    planLimits: () => join(harnessHome(), "limits.json"),
    userCommands: () => join(harnessHome(), "commands"),
    userAgents: () => join(harnessHome(), "agents"),
    userMemory: () => join(harnessHome(), "HARNESS.md"),
    projectsDir: () => join(harnessHome(), "projects"),
    logs: () => join(harnessHome(), "logs"),
    plugins: () => join(harnessHome(), "plugins"),

    projectDir: (cwd: string) => join(cwd, ".harness"),
    projectSettings: (cwd: string) => join(cwd, ".harness", "settings.json"),
    localSettings: (cwd: string) => join(cwd, ".harness", "settings.local.json"),
    projectCommands: (cwd: string) => join(cwd, ".harness", "commands"),
    projectAgents: (cwd: string) => join(cwd, ".harness", "agents"),
    projectMcp: (cwd: string) => join(cwd, ".mcp.json"),
};

/** Directory for a project's sessions: ~/.harness/projects/<slug>/ */
export function projectStateDir(cwd: string): string {
    const slug = resolve(cwd).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(-120) || "root";
    return join(paths.projectsDir(), slug);
}

export function ensureDir(dir: string, mode = 0o700): string {
    mkdirSync(dir, { recursive: true, mode });
    return dir;
}
