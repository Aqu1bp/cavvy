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

import { existsSync, realpathSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { readJsonCached, readJsonForUpdate, writeJson } from "./settings";
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

interface TrustFile {
    dirs?: string[];
    /** Folders whose trust is their own (someone else's code checked out inside a trusted folder): see trustOwnOnly. */
    own?: string[];
}
/** Asked for every turn, MCP server and permission check: read again only once the file has changed. */
const saved = () => readJsonCached<TrustFile>(file())?.dirs ?? [];
const ownOnly = () => readJsonCached<TrustFile>(file())?.own ?? [];

/**
 * The folder as the disk has it: links followed, its letters as stored (a disk that ignores case takes any spelling).
 * One that doesn't exist (removed, or not made yet), by its parent's. For folders whose trust is their own: another
 * spelling of one mustn't escape it.
 */
function onDisk(p: string): string {
    try {
        return realpathSync.native(p);
    } catch {
        const up = dirname(p);
        return up === p ? p : join(onDisk(up), basename(p));
    }
}

export function isTrusted(dir: string): boolean {
    const d = resolve(dir);
    return emptyTrusted.has(d) || trustedByUser(d);
}

/** The user said they trust this folder (now or before); a folder trusted only for having nothing to protect doesn't count. */
export function trustedByUser(dir: string): boolean {
    const d = resolve(dir);
    // Inside a folder whose trust is its own, trust from around it doesn't reach in, however either is spelled.
    const all = ownOnly();
    const own = all.length ? all.filter((o) => isInside(onDisk(d), o)) : all;
    const counts = (t: string) => isInside(d, t) && own.every((o) => isInside(onDisk(t), o));
    if ([...userTrusted].some(counts)) return true;
    return saved().some(counts);
}

/** Inside a folder whose trust is its own (trustOwnOnly) that the user hasn't trusted: someone else's code. */
export function othersCode(dir: string): boolean {
    const d = resolve(dir);
    const all = ownOnly();
    return all.length > 0 && all.some((o) => isInside(onDisk(d), o)) && !trustedByUser(d);
}

/**
 * Trust of the folders around `dir` doesn't reach into it: it's trusted only when the user trusts it (or a folder
 * inside it) themselves. For someone else's code checked out inside a trusted repository, such as a fork's pull
 * request in a worktree under it. Saved, so it holds after a restart; forgotten with the folder (forgetTrustInside).
 */
export function trustOwnOnly(dir: string) {
    const d = onDisk(resolve(dir));
    const cur = readJsonForUpdate<TrustFile>(file()) ?? {};
    if ((cur.own ?? []).includes(d)) return;
    writeJson(file(), { ...cur, own: [...(cur.own ?? []), d].sort() }, 0o600);
}

export function trustFolder(dir: string) {
    const d = resolve(dir);
    // Trusting the whole home directory is only remembered for this session.
    if (d === homedir() || d === "/") {
        userTrusted.add(d);
        return;
    }
    let cur: TrustFile;
    try {
        cur = readJsonForUpdate<TrustFile>(file()) ?? {};
    } catch (e) {
        // Don't drop the other trusted folders; trust this one until exit.
        userTrusted.add(d);
        throw e;
    }
    const dirs = new Set(cur.dirs ?? []);
    dirs.add(d);
    writeJson(file(), { ...cur, dirs: [...dirs].sort() }, 0o600);
}

/**
 * Forget saved trust for `dir` and folders inside it (a removed worktree: a
 * new checkout at the same path may hold anything). Trust saved for a folder
 * containing it is untouched.
 */
export function forgetTrustInside(dir: string) {
    const d = resolve(dir);
    for (const t of [...userTrusted]) if (isInside(t, d)) userTrusted.delete(t);
    for (const t of [...emptyTrusted]) if (isInside(t, d)) emptyTrusted.delete(t);
    const cur = readJsonForUpdate<TrustFile>(file()) ?? {};
    const dirs = (cur.dirs ?? []).filter((t) => !isInside(resolve(t), d));
    const own = (cur.own ?? []).filter((t) => !isInside(t, onDisk(d)));
    if (dirs.length !== (cur.dirs ?? []).length || own.length !== (cur.own ?? []).length) writeJson(file(), { ...cur, dirs, ...(cur.own ? { own } : {}) }, 0o600);
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
    // Someone else's code in a trusted repository (a fork's pull request): the repository's Git hooks can run its
    // files as you commit, so it's asked about even with nothing of the above.
    if (has === existsSync && othersCode(cwd)) found.push("Git hooks");
    return [...new Set(found)];
}
