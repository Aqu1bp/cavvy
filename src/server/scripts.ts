// Project scripts: named shell commands per project ("dev", "test", "lint")
// that the user runs from the GUI, each in a terminal tab. They belong to the
// user, not the repository: they're kept in the Harness home (scripts.json),
// never in the project's .harness/, and nothing runs one but a click in the GUI.
// A repository's main checkout and its worktrees share one list.

import { spawnSync } from "bun";
import { randomUUID } from "crypto";
import { closeSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { ensureDir, harnessHome } from "../config/paths";
import { gitArgv, gitEnv } from "../util/git";
import { RpcError } from "./rpc-error";
import { SCRIPT_ICONS, SCRIPT_LIMITS, type ProjectScript, type ProjectScripts, type ScriptIcon } from "./protocol";

export const scriptsFile = () => join(harnessHome(), "scripts.json");

interface ProjectEntry {
    scripts: ProjectScript[];
    lastUsed?: string;
}

interface Store {
    version: 1;
    /** By project key (see projectKey). */
    projects: Record<string, ProjectEntry>;
}

// ---------------------------------------------------------------------------
// Validation

/** C0 and C1 controls (tabs and newlines among them), line separators, and the invisible characters that reorder text. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const LINE_BREAK = /[\r\n\u2028\u2029]/;
const SCRIPT_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface ScriptInput {
    name: string;
    command: string;
    icon?: ScriptIcon;
}

/** A script's fields, trimmed and checked; throws an RpcError (code "invalid") that says what's wrong. */
export function validateScript(input: { name?: unknown; command?: unknown; icon?: unknown }): ScriptInput {
    if (typeof input.name !== "string") throw new RpcError("The script's name must be text", "invalid");
    const name = input.name.trim();
    if (!name) throw new RpcError("Give the script a name", "invalid");
    if (name.length > SCRIPT_LIMITS.name) throw new RpcError(`Script names can be at most ${SCRIPT_LIMITS.name} characters`, "invalid");
    if (CONTROL.test(name)) throw new RpcError("Script names can't contain control characters", "invalid");

    if (typeof input.command !== "string") throw new RpcError("The script's command must be text", "invalid");
    const command = input.command.trim();
    if (!command) throw new RpcError("Enter the command the script runs", "invalid");
    if (LINE_BREAK.test(command)) throw new RpcError("A script's command must be a single line (join several commands with && or ;)", "invalid");
    if (CONTROL.test(command)) throw new RpcError("A script's command can't contain tabs, escapes or other control characters", "invalid");
    if (command.length > SCRIPT_LIMITS.command) throw new RpcError(`A script's command can be at most ${SCRIPT_LIMITS.command} characters`, "invalid");

    let icon: ScriptIcon | undefined;
    if (input.icon !== undefined && input.icon !== null && input.icon !== "") {
        if (typeof input.icon !== "string" || !(SCRIPT_ICONS as readonly string[]).includes(input.icon)) throw new RpcError(`Unknown script icon (use one of: ${SCRIPT_ICONS.join(", ")})`, "invalid");
        icon = input.icon as ScriptIcon;
    }
    return icon ? { name, command, icon } : { name, command };
}

/** The project's folder: an existing directory, by its real path. */
export function projectFolder(cwd: unknown): string {
    if (typeof cwd !== "string" || !cwd || !isAbsolute(cwd)) throw new RpcError("The project folder must be an absolute path", "invalid");
    let dir: string;
    try {
        dir = realpathSync(cwd);
        if (!statSync(dir).isDirectory()) throw new Error();
    } catch {
        throw new RpcError(`The project folder no longer exists: ${cwd}`, "not_found");
    }
    return dir;
}

// ---------------------------------------------------------------------------
// Project keys

function git(cwd: string, args: string[]): string | undefined {
    try {
        const r = spawnSync(gitArgv(args), { cwd, env: gitEnv(), stdout: "pipe", stderr: "ignore", timeout: 3000 });
        // Only git's line terminator: a path can itself end in a newline.
        return r.exitCode === 0 ? r.stdout.toString().replace(/\n$/, "") : undefined;
    } catch {
        return undefined;
    }
}

function canonical(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/**
 * What a folder's scripts are filed under. In a git work tree it's the main
 * checkout (from the shared git dir), so a repository and all its worktrees
 * share one list; a subfolder keeps its place below it (packages/web in a
 * worktree shares with packages/web in the main checkout, not with the root).
 * Anywhere else, the folder itself. Read-only git plumbing, safe in an
 * untrusted folder.
 */
export function projectKey(folder: string): string {
    const dir = canonical(folder);
    const top = git(dir, ["rev-parse", "--show-toplevel"]);
    const common = top ? git(dir, ["rev-parse", "--git-common-dir"]) : undefined;
    if (!top || !common) return dir;
    const commonDir = canonical(resolve(dir, common));
    // A bare repository's worktrees have no main checkout: the git dir names the project.
    const main = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
    const below = relative(canonical(top), dir);
    const outside = below === ".." || below.startsWith(`..${sep}`) || isAbsolute(below);
    return below && !outside ? join(main, below) : main;
}

// ---------------------------------------------------------------------------
// Storage

const empty = (): Store => ({ version: 1, projects: {} });

/** Entries that don't hold up (a hand edit, an older format) are left out rather than run. */
function sanitize(entry: unknown): ProjectEntry | undefined {
    const raw = (entry as { scripts?: unknown })?.scripts;
    if (!Array.isArray(raw)) return undefined;
    const scripts: ProjectScript[] = [];
    for (const s of raw) {
        if (typeof s?.id !== "string" || !SCRIPT_ID.test(s.id) || scripts.some((x) => x.id === s.id)) continue;
        try {
            const v = validateScript(s);
            if (scripts.some((x) => x.name.toLowerCase() === v.name.toLowerCase())) continue;
            scripts.push({ id: s.id, ...v });
        } catch {
            // left out
        }
    }
    const last = (entry as { lastUsed?: unknown }).lastUsed;
    return { scripts: scripts.slice(0, SCRIPT_LIMITS.perProject), ...(typeof last === "string" && scripts.some((s) => s.id === last) ? { lastUsed: last } : {}) };
}

function readStore(): Store {
    const file = scriptsFile();
    let text: string;
    try {
        text = readFileSync(file, "utf-8");
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty();
        throw new RpcError(`Couldn't read the project scripts (${file}): ${(e as Error).message}`, "store");
    }
    if (!text.trim()) return empty();
    let data: { projects?: unknown };
    try {
        data = JSON.parse(text);
    } catch {
        // Not overwritten: fixing it by hand keeps every script.
        throw new RpcError(`The project scripts file isn't valid JSON, so it's left as it is. Fix or move ${file}.`, "store");
    }
    const store = empty();
    if (data && typeof data.projects === "object" && data.projects && !Array.isArray(data.projects)) {
        for (const [key, entry] of Object.entries(data.projects)) {
            const clean = sanitize(entry);
            if (clean) store.projects[key] = clean;
        }
    }
    return store;
}

/** Replaced in one rename, so a reader never sees half a file. */
function writeStore(store: Store) {
    const file = scriptsFile();
    for (const [key, entry] of Object.entries(store.projects)) if (!entry.scripts.length) delete store.projects[key];
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
        ensureDir(dirname(file));
        writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
        renameSync(tmp, file);
    } catch (e) {
        try {
            unlinkSync(tmp);
        } catch {
            // never written
        }
        throw new RpcError(`Couldn't save the project scripts: ${(e as Error).message}`, "store");
    }
}

const LOCK_WAIT_MS = 2000;
/** A lock is held for one read and write; one this old was left by a process that died holding it. */
const LOCK_STALE_MS = 5000;

function sleepSync(ms: number) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Held around a read-change-write, so another server process (the desktop app and a `harness gui`) can't interleave its own. */
function withLock<T>(fn: () => T): T {
    const lock = `${scriptsFile()}.lock`;
    ensureDir(dirname(lock));
    const deadline = Date.now() + LOCK_WAIT_MS;
    let fd: number | undefined;
    while (fd === undefined) {
        try {
            fd = openSync(lock, "wx", 0o600);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new RpcError(`Couldn't save the project scripts: ${(e as Error).message}`, "store");
            try {
                if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
            } catch {
                // released meanwhile
            }
            if (Date.now() > deadline) throw new RpcError("The project scripts are being saved by another Harness window; try again", "busy");
            sleepSync(10);
        }
    }
    try {
        writeSync(fd, String(process.pid));
        return fn();
    } finally {
        closeSync(fd);
        try {
            unlinkSync(lock);
        } catch {
            // taken as stale
        }
    }
}

/**
 * Read, change, write, with nothing in between: within the server, requests
 * run on one thread, so edits from two windows apply one after the other;
 * across server processes, the lock keeps them apart.
 */
function update<T>(fn: (store: Store) => T): T {
    return withLock(() => {
        const store = readStore();
        const result = fn(store);
        writeStore(store);
        return result;
    });
}

function view(project: string, entry: ProjectEntry | undefined): ProjectScripts {
    const scripts = entry?.scripts.map((s) => ({ ...s })) ?? [];
    return { project, scripts, ...(entry?.lastUsed ? { lastUsed: entry.lastUsed } : {}) };
}

function scriptId(id: unknown): string {
    if (typeof id !== "string" || !SCRIPT_ID.test(id)) throw new RpcError("Unknown script", "invalid");
    return id;
}

const gone = () => new RpcError("That script no longer exists (it may have been deleted in another window)", "not_found");

// ---------------------------------------------------------------------------
// Operations (each takes the folder the request names; errors are RpcErrors for the GUI)

export function listScripts(cwd: unknown): ProjectScripts {
    const project = projectKey(projectFolder(cwd));
    return view(project, readStore().projects[project]);
}

/** Creates a script, or, given `id`, updates that one. */
export function saveScript(cwd: unknown, input: { id?: unknown; name?: unknown; command?: unknown; icon?: unknown }): { project: string; script: ProjectScript } {
    const project = projectKey(projectFolder(cwd));
    const fields = validateScript(input);
    const id = input.id === undefined || input.id === null || input.id === "" ? undefined : scriptId(input.id);
    return update((store) => {
        const entry = (store.projects[project] ??= { scripts: [] });
        const clash = entry.scripts.find((s) => s.id !== id && s.name.toLowerCase() === fields.name.toLowerCase());
        if (clash) throw new RpcError(`This project already has a script named “${clash.name}”`, "invalid");
        if (id) {
            const i = entry.scripts.findIndex((s) => s.id === id);
            if (i < 0) throw gone();
            const script = { id, ...fields };
            entry.scripts[i] = script;
            return { project, script };
        }
        if (entry.scripts.length >= SCRIPT_LIMITS.perProject) throw new RpcError(`A project can have at most ${SCRIPT_LIMITS.perProject} scripts`, "limit");
        const script = { id: randomUUID(), ...fields };
        entry.scripts.push(script);
        return { project, script };
    });
}

export function deleteScript(cwd: unknown, id: unknown): { project: string } {
    const project = projectKey(projectFolder(cwd));
    const sid = scriptId(id);
    return update((store) => {
        const entry = store.projects[project];
        if (!entry?.scripts.some((s) => s.id === sid)) throw gone();
        entry.scripts = entry.scripts.filter((s) => s.id !== sid);
        if (entry.lastUsed === sid) delete entry.lastUsed;
        return { project };
    });
}

/** `ids`: every script's id, in the new order. */
export function reorderScripts(cwd: unknown, ids: unknown): ProjectScripts {
    const project = projectKey(projectFolder(cwd));
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) throw new RpcError("ids must be a list of script ids", "invalid");
    return update((store) => {
        const entry = store.projects[project] ?? { scripts: [] };
        const byId = new Map(entry.scripts.map((s) => [s.id, s]));
        if (ids.length !== byId.size || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) throw new RpcError("The scripts changed in another window; try again", "conflict");
        entry.scripts = ids.map((id) => byId.get(id)!);
        return view(project, entry);
    });
}

/** The stored script to run in `cwd`. */
export function findScript(cwd: unknown, id: unknown): { project: string; script: ProjectScript } {
    const project = projectKey(projectFolder(cwd));
    const sid = scriptId(id);
    const script = readStore().projects[project]?.scripts.find((s) => s.id === sid);
    if (!script) throw gone();
    return { project, script: { ...script } };
}

/** Remembers the script the header button runs next. */
export function markUsed(project: string, id: string) {
    update((store) => {
        const entry = store.projects[project];
        if (entry?.scripts.some((s) => s.id === id)) entry.lastUsed = id;
    });
}
