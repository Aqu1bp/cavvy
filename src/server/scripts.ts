// Project scripts: named shell commands per project ("dev", "test", "lint")
// that the user runs from the GUI, each in a terminal tab. They belong to the
// user, not the repository: they're kept in the Harness home (scripts.json),
// never in the project's .harness/, and nothing runs one but a click in the GUI.
// A repository's main checkout and its worktrees share one list.
//
// The file may be shared with another Harness (the desktop app and a
// `harness gui` of another version) or edited by hand, so a write never drops
// what this one doesn't understand: a file of another format or shape isn't
// written at all, other projects' entries are written back as they were read,
// and in the project being changed, entries that can't be used are kept as
// they are (neither shown nor run), as are fields this Harness doesn't know.

import { randomUUID } from "crypto";
import { closeSync, fstatSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "fs";
import { readFile, realpath, stat } from "fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { ensureDir, harnessHome } from "../config/paths";
import { gitArgv, gitEnv } from "../util/git";
import { RpcError } from "./rpc-error";
import { SCRIPT_ICONS, SCRIPT_LIMITS, type ProjectScript, type ProjectScripts, type ScriptIcon } from "./protocol";

export const scriptsFile = () => join(harnessHome(), "scripts.json");

// Nothing here holds up the server's one thread while it waits: git and the
// folder checks run asynchronously, and a save waits its turn for the lock
// with timers. Only the store's own small read and write are synchronous, so
// that nothing comes between them.

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
export async function projectFolder(cwd: unknown): Promise<string> {
    if (typeof cwd !== "string" || !cwd || !isAbsolute(cwd)) throw new RpcError("The project folder must be an absolute path", "invalid");
    try {
        const dir = await realpath(cwd);
        if ((await stat(dir)).isDirectory()) return dir;
    } catch {
        // gone
    }
    throw new RpcError(`The project folder no longer exists: ${cwd}`, "not_found");
}

// ---------------------------------------------------------------------------
// Project keys

const GIT_TIMEOUT_MS = 3000;

const keyError = (dir: string, why: string) => new RpcError(`Couldn't tell which repository ${dir} belongs to, so its scripts can't be found: ${why}`, "git");

/**
 * git's answer; undefined when there's no repository to ask (not one, or no
 * git installed). Any other failure (a timeout, a signal, a repository git
 * refuses to read) throws: guessing would file scripts under the wrong project.
 */
async function git(dir: string, args: string[]): Promise<string | undefined> {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
        // In English, so "not a git repository" can be told from other failures. In a
        // process group of its own, so a timeout stops whatever it started as well.
        proc = Bun.spawn(gitArgv(args), { cwd: dir, env: { ...gitEnv(), LC_ALL: "C" }, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw keyError(dir, (e as Error).message);
    }
    const done = Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
    // Timed here, not with spawn's own timeout: a timeout and another signal are told apart, and
    // the answer doesn't wait for a git (or a wrapper's child) that ignores SIGTERM or keeps its output open.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            try {
                process.kill(-proc.pid, "SIGKILL");
            } catch {
                proc.kill("SIGKILL");
            }
            reject(keyError(dir, `git didn't answer within ${GIT_TIMEOUT_MS / 1000} s`));
        }, GIT_TIMEOUT_MS);
    });
    const [out, err] = await Promise.race([done, late]).finally(() => clearTimeout(timer));
    if (proc.signalCode) throw keyError(dir, `git was stopped (${proc.signalCode})`);
    // Only git's line terminator: a path can itself end in a newline.
    if (proc.exitCode === 0) return out.replace(/\n$/, "");
    if (/not a git repository|must be run in a work tree/i.test(err)) return undefined;
    const owner = /detected dubious ownership in repository at '(.*)'/.exec(err);
    if (owner) {
        const repo = owner[1] || dir;
        throw keyError(dir, `git refuses to read the repository at ${repo} because it belongs to another user. If you trust it, run: git config --global --add safe.directory '${repo.replace(/'/g, "'\\''")}'`);
    }
    throw keyError(dir, err.trim().split("\n")[0] || `git exited with ${proc.exitCode}`);
}

async function canonical(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        return path;
    }
}

/**
 * A folder's key, for a little while: the GUI asks on every window focus, and
 * a folder rarely becomes (or stops being) part of a repository. Lookups
 * already under way are shared; one that fails isn't kept.
 */
const KEY_TTL_MS = 10_000;
const keys = new Map<string, { key: Promise<string>; at: number }>();

export function forgetProjectKeys() {
    keys.clear();
}

/**
 * What a folder's scripts are filed under. In a repository's main checkout or
 * one of its worktrees, the main checkout, so they all share one list; a
 * subfolder keeps its place below it (packages/web in a worktree shares with
 * packages/web in the main checkout, not with the root). Anywhere else, the
 * folder itself. Read-only git plumbing, safe in an untrusted folder.
 */
export function projectKey(folder: string): Promise<string> {
    const now = Date.now();
    for (const [dir, k] of keys) if (now - k.at > KEY_TTL_MS) keys.delete(dir);
    const known = keys.get(folder);
    if (known) return known.key;
    const key = lookUpKey(folder);
    keys.set(folder, { key, at: now });
    key.catch(() => keys.delete(folder));
    return key;
}

async function lookUpKey(folder: string): Promise<string> {
    const dir = await canonical(folder);
    const [top, common, own] = await Promise.all(["--show-toplevel", "--git-common-dir", "--git-dir"].map((what) => git(dir, ["rev-parse", what])));
    if (top === undefined || common === undefined || own === undefined) return dir;
    const [topDir, commonDir, ownDir] = await Promise.all([canonical(top), canonical(resolve(dir, common)), canonical(resolve(dir, own))]);
    const main = await mainCheckout(topDir, commonDir, ownDir);
    if (!main) return dir;
    const below = relative(topDir, dir);
    const outside = below === ".." || below.startsWith(`..${sep}`) || isAbsolute(below);
    return below && !outside ? join(main, below) : main;
}

/**
 * The checkout a work tree shares scripts with, when git's pointers hold both
 * ways: it's the repository's main checkout (its own git dir is the shared
 * one, `<top>/.git`), or a worktree the repository lists (its git dir is
 * `<common>/worktrees/<name>`, whose gitdir file points back at `<top>/.git`).
 * A `.git` that's a symlink to another repository's (or to a worktree's .git
 * file), or a `.git` file naming another repository's worktree, doesn't make a
 * folder part of it.
 */
async function mainCheckout(top: string, common: string, own: string): Promise<string | undefined> {
    // A bare repository (worktrees only) has no main checkout: its git dir names it.
    const main = basename(common) === ".git" ? dirname(common) : common;
    if (own === common) return basename(common) === ".git" && dirname(common) === top ? main : undefined;
    if (dirname(own) !== join(common, "worktrees")) return undefined;
    try {
        // The worktree's .git file, by the folder it's in: following the folder's own .git (a symlink
        // to the real worktree's .git file, say) would prove nothing.
        const back = (await readFile(join(own, "gitdir"), "utf-8")).replace(/\r?\n$/, "");
        const backlink = resolve(own, back);
        return basename(backlink) === ".git" && (await canonical(dirname(backlink))) === top ? main : undefined;
    } catch {
        return undefined;
    }
}

const keyOf = async (cwd: unknown) => projectKey(await projectFolder(cwd));

// ---------------------------------------------------------------------------
// Storage

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** The file as read: written back with only the changed project's entry replaced. */
interface Store {
    file: string;
    raw: Json;
    projects: Json;
}

/** A script this Harness can use, with the entry it came from (fields it doesn't know are written back); or an entry kept as it was. */
type Item = { script: ProjectScript; raw: Json } | { kept: unknown };

interface Project {
    /** In the file's order. */
    items: Item[];
    lastUsed?: unknown;
    /** The entry's other fields. */
    raw: Json;
}

const storeError = (file: string, why: string) => new RpcError(`${why} It's left as it is: fix or move ${file}.`, "store");

function readStore(): Store {
    const file = scriptsFile();
    let text: string;
    try {
        text = readFileSync(file, "utf-8");
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new RpcError(`Couldn't read the project scripts (${file}): ${(e as Error).message}`, "store");
        text = "";
    }
    if (!text.trim()) {
        const projects = {};
        return { file, raw: { version: 1, projects }, projects };
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw storeError(file, "The project scripts file isn't valid JSON.");
    }
    if (isObject(raw) && typeof raw.version === "number" && raw.version > 1) throw storeError(file, `The project scripts file was written by a newer Harness (format ${raw.version}).`);
    if (!isObject(raw) || raw.version !== 1 || (raw.projects !== undefined && !isObject(raw.projects))) throw storeError(file, "The project scripts file isn't in a form this Harness understands.");
    const projects = (raw.projects ??= {}) as Json;
    return { file, raw, projects };
}

/** An entry's id and name as written (whatever else is wrong with it), for telling duplicates apart. */
const idOf = (s: unknown) => (isObject(s) && typeof s.id === "string" ? s.id : undefined);
const nameOf = (s: unknown) => (isObject(s) && typeof s.name === "string" ? s.name.trim().toLowerCase() : undefined);

function readProject(store: Store, key: string): Project {
    const entry = store.projects[key];
    if (entry === undefined) return { items: [], raw: {} };
    if (!isObject(entry) || (entry.scripts !== undefined && !Array.isArray(entry.scripts))) throw storeError(store.file, "This project's entry in the project scripts file isn't in a form this Harness understands.");
    const { scripts = [], lastUsed, ...rest } = entry as { scripts?: unknown[]; lastUsed?: unknown };
    // Entries sharing an id, or a name in any case, are all set aside, wherever they are: which one
    // ran mustn't depend on their order (a reorder would change what an id runs).
    const count = (of: (s: unknown) => string | undefined) => {
        const n = new Map<string, number>();
        for (const s of scripts) {
            const k = of(s);
            if (k !== undefined) n.set(k, (n.get(k) ?? 0) + 1);
        }
        return n;
    };
    const ids = count(idOf);
    const names = count(nameOf);
    const items = scripts.map((s): Item => {
        if (!isObject(s) || typeof s.id !== "string" || !SCRIPT_ID.test(s.id) || ids.get(s.id)! > 1 || (names.get(nameOf(s) ?? "") ?? 0) > 1) return { kept: s };
        try {
            return { script: { id: s.id, ...validateScript(s) }, raw: s };
        } catch {
            // A two-line command, an unknown icon: not run, but not lost either.
            return { kept: s };
        }
    });
    return { items, lastUsed, raw: rest };
}

const usable = (p: Project) => p.items.flatMap((i) => ("script" in i ? [i] : []));
const keptAside = (p: Project) => p.items.flatMap((i) => ("kept" in i ? [i.kept] : []));

function entryOf(p: Project): Json | undefined {
    const scripts = p.items.map((i) => {
        if ("kept" in i) return i.kept;
        const { icon: _icon, ...rest } = i.raw;
        return { ...rest, id: i.script.id, name: i.script.name, command: i.script.command, ...(i.script.icon ? { icon: i.script.icon } : {}) };
    });
    if (!scripts.length && !Object.keys(p.raw).length) return undefined;
    return { ...p.raw, scripts, ...(p.lastUsed !== undefined && scripts.length ? { lastUsed: p.lastUsed } : {}) };
}

/**
 * Replaced in one rename, so a reader never sees half a file; and only while
 * the lock is still this writer's (`fence` throws if it was taken over, say
 * while this process was stopped), so a stale snapshot never lands on a save
 * made since.
 */
function writeStore(store: Store, fence: () => void) {
    const tmp = `${store.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
        ensureDir(dirname(store.file));
        writeFileSync(tmp, JSON.stringify(store.raw, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
        fence();
        renameSync(tmp, store.file);
    } catch (e) {
        try {
            unlinkSync(tmp);
        } catch {
            // never written
        }
        if (e instanceof RpcError) throw e;
        throw new RpcError(`Couldn't save the project scripts: ${(e as Error).message}`, "store");
    }
}

const LOCK_WAIT_MS = 2000;
/** A lock whose holder is still running is taken over only when it's this old (its pid may have been reused since). */
const LOCK_STALE_MS = 60_000;
/** A lock with no pid in it yet: being made, or left by a process that died making it. */
const LOCK_EMPTY_STALE_MS = 5000;

/** The lock's inode when it's been left behind: its holder has gone, or it's too old to be anyone's. */
function abandoned(lock: string): number | undefined {
    try {
        const st = statSync(lock);
        const body = readFileSync(lock, "utf-8").trim();
        const age = Date.now() - st.mtimeMs;
        const pid = /^\d+$/.test(body) ? Number(body) : 0;
        if (!pid) return age > LOCK_EMPTY_STALE_MS ? st.ino : undefined;
        if (age > LOCK_STALE_MS) return st.ino;
        try {
            process.kill(pid, 0);
            return undefined;
        } catch (e) {
            // EPERM: running, as another user.
            return (e as NodeJS.ErrnoException).code === "ESRCH" ? st.ino : undefined;
        }
    } catch {
        // released meanwhile
        return undefined;
    }
}

/**
 * Remove the abandoned lock, if it's still the one found abandoned. Two
 * processes can find it at once, and by the time the second removes it the
 * first may have made its own: so it's removed only while holding
 * `<lock>.takeover`. True when it's gone.
 */
function takeOver(lock: string, ino: number): boolean {
    const guard = `${lock}.takeover`;
    let fd: number;
    try {
        fd = openSync(guard, "wx", 0o600);
    } catch {
        // Another process is taking it over. One that crashed doing so left this behind.
        try {
            if (Date.now() - statSync(guard).mtimeMs > LOCK_EMPTY_STALE_MS) unlinkSync(guard);
        } catch {
            // gone meanwhile
        }
        return false;
    }
    try {
        if (statSync(lock).ino === ino) unlinkSync(lock);
        return true;
    } catch {
        return true;
    } finally {
        closeSync(fd);
        try {
            unlinkSync(guard);
        } catch {
            // already gone
        }
    }
}

const busy = () => new RpcError("The project scripts are being saved by another Harness window; try again", "busy");

type LockId = { ino: number; dev: number };

/**
 * Make the lock, already holding this process's pid, so no one ever sees it
 * empty: written aside, then linked into place (EEXIST: it's held). Undefined
 * when it's held. Where there are no hard links, it's made in place instead.
 */
/** How the lock is made; tests stand in for a file system without hard links, or another process taking it over. */
export const lockFiles = { link: linkSync, open: openSync };

function makeLock(lock: string): LockId | undefined {
    const tmp = `${lock}.${process.pid}.${randomUUID()}`;
    try {
        writeFileSync(tmp, String(process.pid), { flag: "wx", mode: 0o600 });
        const id = statSync(tmp);
        try {
            lockFiles.link(tmp, lock);
            return { ino: id.ino, dev: id.dev };
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === "EEXIST") return undefined;
            if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV") throw e;
        }
        let fd: number;
        try {
            fd = lockFiles.open(lock, "wx", 0o600);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "EEXIST") return undefined;
            throw e;
        }
        try {
            writeSync(fd, String(process.pid));
            // The file this process made, by its descriptor: the path may name another process's lock by
            // now (it was taken over meanwhile), and that one mustn't be taken for ours. Then it's held.
            const made = fstatSync(fd);
            const id = { ino: made.ino, dev: made.dev };
            return stillMine(lock, id) ? id : undefined;
        } finally {
            closeSync(fd);
        }
    } catch (e) {
        throw new RpcError(`Couldn't save the project scripts: ${(e as Error).message}`, "store");
    } finally {
        try {
            unlinkSync(tmp);
        } catch {
            // never made
        }
    }
}

/** The lock at `lock` is the one this process made. */
function stillMine(lock: string, mine: LockId): boolean {
    try {
        const there = statSync(lock);
        return there.ino === mine.ino && there.dev === mine.dev;
    } catch {
        return false;
    }
}

/**
 * Held around a read-change-write, so another server process (the desktop app
 * and a `harness gui`) can't interleave its own; another request in this one
 * waits for it too. Waiting is on a timer, so the server carries on meanwhile.
 * `fn` gets the fence a write checks first.
 */
async function withLock<T>(fn: (fence: () => void) => T): Promise<T> {
    const lock = `${scriptsFile()}.lock`;
    ensureDir(dirname(lock));
    const deadline = Date.now() + LOCK_WAIT_MS;
    let mine: LockId | undefined;
    while (!(mine = makeLock(lock))) {
        const ino = abandoned(lock);
        if (ino !== undefined && takeOver(lock, ino)) continue;
        if (Date.now() > deadline) throw busy();
        await Bun.sleep(10);
    }
    const held = mine;
    try {
        return fn(() => {
            if (!stillMine(lock, held)) throw busy();
        });
    } finally {
        // Not if it was taken over meanwhile: the lock there now is someone else's.
        if (stillMine(lock, held)) {
            try {
                unlinkSync(lock);
            } catch {
                // gone
            }
        }
    }
}

/**
 * Read, change, write, with nothing in between: under the lock, and with no
 * await inside, so edits from two windows or two server processes apply one
 * after the other. `fn` returns false to leave the file as it is. Exported for
 * tests, which stand in for another process between the read and the write.
 */
export function updateProject<T>(key: string, fn: (p: Project) => T): Promise<T> {
    return withLock((fence) => {
        const store = readStore();
        const p = readProject(store, key);
        const result = fn(p);
        if (result === false) return result;
        const entry = entryOf(p);
        if (entry) store.projects[key] = entry;
        else delete store.projects[key];
        writeStore(store, fence);
        return result;
    });
}

function view(project: string, p: Project): ProjectScripts {
    const scripts = usable(p).map((i) => ({ ...i.script }));
    const last = typeof p.lastUsed === "string" && scripts.some((s) => s.id === p.lastUsed) ? p.lastUsed : undefined;
    const aside = keptAside(p).length;
    return { project, scripts, ...(last ? { lastUsed: last } : {}), ...(aside ? { setAside: { count: aside, file: scriptsFile() } } : {}) };
}

function scriptId(id: unknown): string {
    if (typeof id !== "string" || !SCRIPT_ID.test(id)) throw new RpcError("Unknown script", "invalid");
    return id;
}

const gone = () => new RpcError("That script no longer exists (it may have been deleted in another window)", "not_found");

// ---------------------------------------------------------------------------
// Operations (each takes the folder the request names; errors are RpcErrors for the GUI)

export async function listScripts(cwd: unknown): Promise<ProjectScripts> {
    const project = await keyOf(cwd);
    return view(project, readProject(readStore(), project));
}

/** Creates a script, or, given `id`, updates that one. */
export async function saveScript(cwd: unknown, input: { id?: unknown; name?: unknown; command?: unknown; icon?: unknown }): Promise<{ project: string; script: ProjectScript }> {
    const fields = validateScript(input);
    const id = input.id === undefined || input.id === null || input.id === "" ? undefined : scriptId(input.id);
    const project = await keyOf(cwd);
    return updateProject(project, (p) => {
        const scripts = usable(p);
        const clash = scripts.find((i) => i.script.id !== id && i.script.name.toLowerCase() === fields.name.toLowerCase());
        if (clash) throw new RpcError(`This project already has a script named “${clash.script.name}”`, "invalid");
        // Sharing a name (or id) with an entry set aside would set this one aside too: it would vanish.
        const aside = keptAside(p);
        if (aside.some((k) => nameOf(k) === fields.name.toLowerCase())) throw new RpcError(`An entry named “${fields.name}” in ${scriptsFile()} has been set aside (it can't be used as it is); pick another name, or fix or remove that entry`, "invalid");
        let newId = id ?? randomUUID();
        while (!id && aside.some((k) => idOf(k) === newId)) newId = randomUUID();
        const script = { id: newId, ...fields };
        if (id) {
            const item = scripts.find((i) => i.script.id === id);
            if (!item) throw gone();
            item.script = script;
        } else {
            // Entries kept aside count too: the file doesn't grow without bound.
            if (p.items.length >= SCRIPT_LIMITS.perProject) throw new RpcError(`A project can have at most ${SCRIPT_LIMITS.perProject} scripts`, "limit");
            p.items.push({ script, raw: {} });
        }
        return { project, script };
    });
}

export async function deleteScript(cwd: unknown, id: unknown): Promise<{ project: string }> {
    const sid = scriptId(id);
    const project = await keyOf(cwd);
    return updateProject(project, (p) => {
        const i = p.items.findIndex((item) => "script" in item && item.script.id === sid);
        if (i < 0) throw gone();
        p.items.splice(i, 1);
        if (p.lastUsed === sid) p.lastUsed = undefined;
        return { project };
    });
}

/** `ids`: every script's id, in the new order (entries kept aside stay where they are). */
export async function reorderScripts(cwd: unknown, ids: unknown): Promise<ProjectScripts> {
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) throw new RpcError("ids must be a list of script ids", "invalid");
    const project = await keyOf(cwd);
    return updateProject(project, (p) => {
        const byId = new Map(usable(p).map((i) => [i.script.id, i]));
        if (ids.length !== byId.size || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) throw new RpcError("The scripts changed in another window; try again", "conflict");
        const order = ids.map((id) => byId.get(id)!);
        p.items = p.items.map((i) => ("script" in i ? order.shift()! : i));
        return view(project, p);
    });
}

/** The stored script to run in `cwd`. */
export async function findScript(cwd: unknown, id: unknown): Promise<{ project: string; script: ProjectScript }> {
    const sid = scriptId(id);
    const project = await keyOf(cwd);
    const item = usable(readProject(readStore(), project)).find((i) => i.script.id === sid);
    if (!item) throw gone();
    return { project, script: { ...item.script } };
}

/**
 * Remembers the script the header button runs next. Running a script rewrites
 * nothing it didn't fully understand: with entries kept aside in the project,
 * it isn't remembered.
 */
export async function markUsed(project: string, id: string) {
    await updateProject(project, (p) => {
        if (p.items.some((i) => "kept" in i) || p.lastUsed === id || !usable(p).some((i) => i.script.id === id)) return false;
        p.lastUsed = id;
        return true;
    });
}
