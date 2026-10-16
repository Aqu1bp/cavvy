// Folder trust. A cloned repository can ship .harness/settings.json (hooks,
// allow rules, env) and .mcp.json (servers that run commands). None of that
// is honored until the user says they trust the folder.
//
// Two kinds of trust: a folder the user trusted (saved, or answered yes this
// session), and a folder trusted for this session only because it had
// nothing to protect when the harness started. Agent CLIs (Claude Code,
// Codex) get a project's own configuration only with the first kind: they
// read more of it than the harness checks at startup, and `claude -p` shows
// no trust prompt of its own.

import { existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { readJson, readJsonForUpdate, writeJson } from "./settings";
import { harnessHome, paths } from "./paths";
import { isInside } from "../util/files";
import { readAgentConfig } from "../providers/registry";

const file = () => join(harnessHome(), "trusted.json");
/** Trusted by the user for this session only (home, "/", or the list couldn't be saved); folders inside it too. */
const userTrusted = new Set<string>();
/**
 * Trusted for this session because it had nothing to protect when it was
 * opened: that folder only. A parent opened this way (~/code) doesn't make
 * the projects inside it trusted, which matters when one process opens many
 * folders (the GUI server).
 */
const emptyTrusted = new Set<string>();

const saved = () => readJson<{ dirs?: string[] }>(file())?.dirs ?? [];

export function isTrusted(dir: string): boolean {
    const d = resolve(dir);
    return emptyTrusted.has(d) || trustedByUser(d);
}

/** The user said they trust this folder (now or before); a folder trusted only for having nothing to protect doesn't count. */
export function trustedByUser(dir: string): boolean {
    const d = resolve(dir);
    if ([...userTrusted].some((t) => isInside(d, t))) return true;
    return saved().some((t) => isInside(d, t));
}

export function trustFolder(dir: string) {
    const d = resolve(dir);
    // Trusting the whole home directory is only remembered for this session.
    if (d === homedir() || d === "/") {
        userTrusted.add(d);
        return;
    }
    let cur: { dirs?: string[] };
    try {
        cur = readJsonForUpdate<{ dirs?: string[] }>(file()) ?? {};
    } catch (e) {
        // Don't drop the other trusted folders; trust this one until exit.
        userTrusted.add(d);
        throw e;
    }
    const dirs = new Set(cur.dirs ?? []);
    dirs.add(d);
    writeJson(file(), { dirs: [...dirs].sort() }, 0o600);
}

/** Trust this folder (not the ones inside it) for this session because there's nothing to protect yet (not the user's say-so). */
export function trustForSession(dir: string) {
    emptyTrusted.add(resolve(dir));
}

/**
 * A project's own configuration for an agent CLI, which that CLI would load
 * (hooks, skills, sub-agents, commands, permission rules). Claude Code also
 * reads .mcp.json, which the harness's own check already covers.
 */
export function agentProjectConfig(cwd: string, provider: "claude-code" | "codex", has: (path: string) => boolean = existsSync): string[] {
    const found: string[] = [];
    if (provider === "claude-code") {
        for (const f of ["settings.json", "settings.local.json"]) if (has(join(cwd, ".claude", f))) found.push(`.claude/${f}`);
        for (const d of ["skills", "agents", "commands"]) if (has(join(cwd, ".claude", d))) found.push(`.claude/${d}/`);
    } else if (has(join(cwd, ".codex"))) found.push(".codex/");
    return found;
}

/** Whether the folder has anything that trust would unlock. `has` says whether a path exists (a commit's tree, for a checkout yet to be made). */
export function projectConfigSummary(cwd: string, has: (path: string) => boolean = existsSync): string[] {
    const found: string[] = [];
    if (has(paths.projectSettings(cwd))) found.push(".harness/settings.json");
    if (has(paths.localSettings(cwd))) found.push(".harness/settings.local.json");
    if (has(paths.projectMcp(cwd))) found.push(".mcp.json");
    if (has(paths.projectCommands(cwd))) found.push(".harness/commands/");
    if (has(paths.projectAgents(cwd))) found.push(".harness/agents/");
    // Agent CLIs that are turned on load their own project configuration only in a folder the user trusted.
    for (const p of ["claude-code", "codex"] as const) if (readAgentConfig(p)) found.push(...agentProjectConfig(cwd, p, has));
    return found;
}
