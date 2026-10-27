// Folder trust. A cloned repository can ship .cavvy/settings.json (hooks,
// allow rules, env) and .mcp.json (servers that run commands). None of that
// is honored until the user says they trust the folder.
//
// Two kinds of trust: a folder the user trusted (saved, or answered yes this
// session), and a folder trusted for this session only because it had
// nothing to protect when Cavvy started. Agent CLIs (Claude Code,
// Codex) get a project's own configuration only with the first kind: they
// read more of it than Cavvy checks at startup, and `claude -p` shows
// no trust prompt of its own.

import { existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { readJson, readJsonForUpdate, writeJson } from "./settings";
import { cavvyHome, paths } from "./paths";
import { LEGACY } from "./legacy";
import { isInside } from "../util/files";
import { readAgentConfig } from "../providers/registry";
import { AGENT_CLIS, agentCli } from "../backends/defs";
import { externalImports } from "../agent/memory";

const file = () => join(cavvyHome(), "trusted.json");
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

/**
 * Forget saved trust for `dir` and folders inside it (a removed worktree: a
 * new checkout at the same path may hold anything). Trust saved for a folder
 * containing it is untouched.
 */
export function forgetTrustInside(dir: string) {
    const d = resolve(dir);
    for (const t of [...userTrusted]) if (isInside(t, d)) userTrusted.delete(t);
    const cur = readJsonForUpdate<{ dirs?: string[] }>(file()) ?? {};
    const dirs = (cur.dirs ?? []).filter((t) => !isInside(resolve(t), d));
    if (dirs.length !== (cur.dirs ?? []).length) writeJson(file(), { dirs }, 0o600);
}

/** The user's own trust in this folder (and the ones inside it), for this session only: not saved. */
export function trustUntilExit(dir: string) {
    userTrusted.add(resolve(dir));
}

/** Trust this folder (not the ones inside it) for this session because there's nothing to protect yet (not the user's say-so). */
export function trustForSession(dir: string) {
    emptyTrusted.add(resolve(dir));
}

/**
 * A project's own configuration for an agent CLI, which that CLI would load
 * (hooks, skills, sub-agents, commands, permission rules). Claude Code also
 * reads .mcp.json, which Cavvy's own check already covers.
 */
export function agentProjectConfig(cwd: string, provider: string, has: (path: string) => boolean = existsSync): string[] {
    return agentCli(provider)?.projectConfig?.(cwd, has) ?? [];
}

/** Whether the folder has anything that trust would unlock. `has` says whether a path exists (a commit's tree, for a checkout yet to be made). */
export function projectConfigSummary(cwd: string, has: (path: string) => boolean = existsSync): string[] {
    const found: string[] = [];
    // Each of Cavvy's files where it's read from, by `has` (inProjectDir asks the disk): in Harness's .harness/ when only that has it.
    const own = (name: string, suffix = "") => {
        for (const dir of [".cavvy", LEGACY.dir]) if (has(join(cwd, dir, name))) return found.push(`${dir}/${name}${suffix}`);
    };
    own("settings.json");
    own("settings.local.json");
    if (has(paths.projectMcp(cwd))) found.push(".mcp.json");
    own("commands", "/");
    own("agents", "/");
    // Agent CLIs that are turned on load their own project configuration only in a folder the user trusted.
    for (const d of AGENT_CLIS) if (readAgentConfig(d.id)) found.push(...agentProjectConfig(cwd, d.id, has));
    // Skills are instructions for the model, read natively from both folders whatever the model (src/agent/skills.ts).
    own("skills", "/");
    if (has(join(cwd, ".claude", "skills"))) found.push(".claude/skills/");
    // Memory files load in a folder with nothing to protect, but their imports stay inside the project
    // until the user trusts it (src/agent/memory.ts): one that imports from outside has something to unlock.
    // Only on disk: `has` for a commit's tree can't read what the files say, so a caller checking
    // a commit reads its memory files itself (committedExternalImports, in src/server/runs.ts).
    if (has === existsSync) found.push(...externalImports(cwd));
    return [...new Set(found)];
}
