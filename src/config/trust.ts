// Folder trust. A cloned repository can ship .harness/settings.json (hooks,
// allow rules, env) and .mcp.json (servers that run commands). None of that
// is honored until the user says they trust the folder.

import { existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { readJson, writeJson } from "./settings";
import { harnessHome, paths } from "./paths";
import { isInside } from "../util/files";

const file = () => join(harnessHome(), "trusted.json");
const sessionTrusted = new Set<string>();

export function isTrusted(dir: string): boolean {
    const d = resolve(dir);
    if ([...sessionTrusted].some((t) => isInside(d, t))) return true;
    const list = readJson<{ dirs?: string[] }>(file())?.dirs ?? [];
    return list.some((t) => isInside(d, t));
}

export function trustFolder(dir: string) {
    const d = resolve(dir);
    // Trusting the whole home directory is only remembered for this session.
    if (d === homedir() || d === "/") {
        sessionTrusted.add(d);
        return;
    }
    const cur = readJson<{ dirs?: string[] }>(file()) ?? {};
    const dirs = new Set(cur.dirs ?? []);
    dirs.add(d);
    writeJson(file(), { dirs: [...dirs].sort() }, 0o600);
}

export function trustForSession(dir: string) {
    sessionTrusted.add(resolve(dir));
}

/** Whether the folder has anything that trust would unlock. */
export function projectConfigSummary(cwd: string): string[] {
    const found: string[] = [];
    if (existsSync(paths.projectSettings(cwd))) found.push(".harness/settings.json");
    if (existsSync(paths.localSettings(cwd))) found.push(".harness/settings.local.json");
    if (existsSync(paths.projectMcp(cwd))) found.push(".mcp.json");
    if (existsSync(paths.projectCommands(cwd))) found.push(".harness/commands/");
    if (existsSync(paths.projectAgents(cwd))) found.push(".harness/agents/");
    return found;
}
