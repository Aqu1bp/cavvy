import { homedir } from "os";
import { join, resolve } from "path";
import { mkdirSync } from "fs";
import { APP_NAME } from "./name";
import { fileIn, inProjectDir, LEGACY, legacyEnvNotes, moveLegacyHome } from "./legacy";

export { APP_NAME };
export const APP_TITLE = "Cavvy";
export const APP_VERSION = "1.0.0";

let defaultHome: string | undefined;
let envNoted = false;

/**
 * Root of all user-level state. Override with CAVVY_HOME (or HARNESS_HOME, its old
 * name). The first look at the default moves Harness's ~/.harness here (legacy.ts).
 */
export function cavvyHome(): string {
    if (!envNoted) {
        envNoted = true;
        for (const note of legacyEnvNotes()) process.stderr.write(`${APP_NAME}: ${note}\n`);
    }
    if (process.env.CAVVY_HOME) return resolve(process.env.CAVVY_HOME);
    if (process.env.HARNESS_HOME) return resolve(process.env.HARNESS_HOME);
    if (defaultHome === undefined) {
        const moved = moveLegacyHome(join(homedir(), ".cavvy"), join(homedir(), LEGACY.dir));
        for (const note of moved.notes) process.stderr.write(`${APP_NAME}: ${note}\n`);
        defaultHome = moved.home;
    }
    return defaultHome;
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
    /** CAVVY.md, or HARNESS.md in a home that has only Harness's. */
    userMemory: () => fileIn(cavvyHome(), "CAVVY.md", LEGACY.memory),
    projectsDir: () => join(cavvyHome(), "projects"),
    logs: () => join(cavvyHome(), "logs"),
    plugins: () => join(cavvyHome(), "plugins"),

    /** Each in the project's .cavvy/, or in .harness/ when only that one has it (legacy.ts). */
    projectSettings: (cwd: string) => inProjectDir(cwd, "settings.json"),
    localSettings: (cwd: string) => inProjectDir(cwd, "settings.local.json"),
    projectCommands: (cwd: string) => inProjectDir(cwd, "commands"),
    projectAgents: (cwd: string) => inProjectDir(cwd, "agents"),
    projectSkills: (cwd: string) => inProjectDir(cwd, "skills"),
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
