import { spawn, spawnSync } from "bun";
import { lstatSync, mkdirSync, realpathSync, statSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { gitArgv, gitEnv } from "../util/git";
import { isInside } from "../util/files";
import { redact } from "../util/redact";
import { RpcError } from "./rpc-error";
import type { CreateWorktreeParams, WorktreeInfo } from "./protocol";

type WorktreeRecord = Omit<WorktreeInfo, "current" | "exists" | "main" | "managed"> & { bare: boolean };

/** With -z both fields and records are NUL-delimited; paths are never quoted. */
export function parseWorktrees(output: string): WorktreeRecord[] {
    const records: WorktreeRecord[] = [];
    let record: WorktreeRecord | undefined;
    for (const field of output.split("\0")) {
        if (field.startsWith("worktree ")) {
            record = { path: field.slice(9), detached: false, bare: false };
            records.push(record);
        } else if (record) {
            if (!field) record = undefined;
            else if (field.startsWith("HEAD ")) record.head = field.slice(5);
            else if (field.startsWith("branch ")) record.branch = field.slice(7).replace(/^refs\/heads\//, "");
            else if (field === "detached") record.detached = true;
            else if (field === "bare") record.bare = true;
            else if (field === "locked" || field.startsWith("locked ")) record.locked = field.slice(7);
            else if (field === "prunable" || field.startsWith("prunable ")) record.prunable = field.slice(9);
        }
    }
    return records;
}

function runGit(cwd: string, args: string[]): string | undefined {
    const result = spawnSync(gitArgv(args), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe", timeout: 3000 });
    return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

function canonical(path: string): string {
    try { return realpathSync(path); } catch { return path; }
}

function isDir(path: string): boolean {
    try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Where Harness (like Claude Code) keeps a repository's worktrees, under its main worktree. */
export const WORKTREES_DIR = join(".claude", "worktrees");

/** Strictly inside <main>/.claude/worktrees/ once symlinks are resolved; a folder that's gone is judged by the path Git recorded. */
function isManaged(main: string, path: string, exists: boolean): boolean {
    const real = join(canonical(main), WORKTREES_DIR);
    const within = (p: string, dir: string) => p !== dir && isInside(p, dir);
    if (exists) return within(canonical(path), real);
    return within(resolve(path), real) || within(resolve(path), join(main, WORKTREES_DIR));
}

/** Read-only discovery; never checks out branches or runs repository configuration. */
export function listWorktrees(cwd: string): WorktreeInfo[] {
    const output = runGit(cwd, ["worktree", "list", "--porcelain", "-z"]);
    if (output === undefined) throw new Error("Could not list this project's Git worktrees.");
    // Remove only Git's line terminator: a working directory itself can end in a newline.
    const root = runGit(cwd, ["rev-parse", "--show-toplevel"])?.replace(/\n$/, "");
    const current = root ? canonical(root) : undefined;
    const records = parseWorktrees(output);
    // Git lists the main worktree first; a bare repository has none.
    const main = records[0] && !records[0].bare ? records[0].path : undefined;
    return records.filter((record) => !record.bare).map(({ bare: _bare, ...record }) => {
        let exists = false;
        try { exists = statSync(record.path).isDirectory(); } catch { /* A deleted worktree remains registered until pruned. */ }
        const isMain = record.path === main;
        return { ...record, exists, current: canonical(record.path) === current, main: isMain, managed: !isMain && main !== undefined && isManaged(main, record.path, exists) };
    });
}

// ---------------------------------------------------------------------------
// Creating and removing. Messages are our own: Git's stderr can echo remote
// URLs and credentials, so it's only logged (redacted).

/** Checking out a big repository takes a while. */
const CREATE_TIMEOUT_MS = 5 * 60_000;
const REMOVE_TIMEOUT_MS = 2 * 60_000;
/** The repository's hooks (post-checkout) don't run: the project needn't be trusted to create a worktree in it. */
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

export type Log = (message: string) => void;

interface Repo {
    /** The main worktree's root, symlinks resolved. */
    main: string;
    records: WorktreeRecord[];
}

function repoOf(cwd: string): Repo {
    if (!isDir(cwd)) throw new RpcError(`${cwd} isn't a folder.`, "not_git");
    const output = runGit(cwd, ["worktree", "list", "--porcelain", "-z"]);
    if (output === undefined) throw new RpcError("This folder isn't in a Git repository.", "not_git");
    const records = parseWorktrees(output);
    const first = records[0];
    if (!first || first.bare) throw new RpcError("This repository has no main worktree (it's bare), so there's nowhere to put new worktrees.", "not_git");
    return { main: canonical(first.path), records };
}

const CONTROL = /[\x00-\x1f\x7f]/;

/** Git decides (check-ref-format); the hints only say why in words. */
function checkBranch(cwd: string, branch: string): string {
    const invalid = (why: string) => new RpcError(`Not a valid branch name: ${why}`, "invalid_branch");
    if (!branch) throw new RpcError("Enter a branch name.", "invalid_branch");
    if (CONTROL.test(branch)) throw invalid("it can't contain control characters.");
    // Never an option to git, whatever check-ref-format would say.
    if (branch.startsWith("-")) throw invalid("it can't start with “-”.");
    // check-ref-format --branch accepts it, but it reads as HEAD everywhere.
    if (branch === "@") throw invalid("“@” means HEAD.");
    const checked = runGit(cwd, ["check-ref-format", "--branch", branch])?.replace(/\n$/, "");
    // --branch expands @{-1} and the like; only the name as typed is wanted.
    if (checked !== branch) throw invalid(branchHint(branch));
    if (runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) !== undefined) {
        throw new RpcError(`A branch named ${branch} already exists. Pick a new name (a worktree for an existing branch isn't supported yet).`, "branch_exists");
    }
    return branch;
}

function branchHint(b: string): string {
    if (/\s/.test(b)) return "it can't contain spaces.";
    if (CONTROL.test(b) || /[~^:?*[\\]/.test(b)) return "it can't contain ~ ^ : ? * [ or \\.";
    if (b.includes("..")) return "it can't contain “..”.";
    if (b.includes("@{")) return "it can't contain “@{”.";
    if (b.startsWith("/") || b.endsWith("/") || b.includes("//")) return "it can't start or end with “/”, or contain “//”.";
    if (/(^|\/)\./.test(b)) return "no part of it can start with “.”.";
    if (/\.lock(\/|$)/.test(b)) return "no part of it can end with “.lock”.";
    if (b.endsWith(".")) return "it can't end with “.”.";
    return "Git doesn't accept it.";
}

/** The commit `base` names, checked before anything runs. */
function resolveBase(cwd: string, base: string | undefined): string {
    const ref = base || "HEAD";
    const bad = () => new RpcError(base ? `${base} isn't a branch or commit in this repository.` : "This folder's HEAD has no commit yet: make a first commit, or enter a base.", "bad_base");
    if (ref.startsWith("-") || CONTROL.test(ref)) throw bad();
    const commit = runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])?.trim();
    if (!commit || !/^[0-9a-f]{40,64}$/.test(commit)) throw bad();
    return commit;
}

/** A single path segment: no separators, no "..", no leading "-". */
export function checkFolder(folder: string): string {
    const bad = (why: string) => new RpcError(`Not a valid folder name: ${why}`, "bad_folder");
    if (!folder) throw bad("it's empty.");
    if (folder.length > 255) throw bad("it's too long.");
    if (folder.includes("/") || folder.includes("\\")) throw bad("it can't contain “/” or “\\”.");
    if (folder.includes("..") || folder === ".") throw bad("it can't be “.” or contain “..”.");
    if (folder.startsWith("-")) throw bad("it can't start with “-”.");
    if (CONTROL.test(folder)) throw bad("it can't contain control characters.");
    return folder;
}

export function defaultFolder(branch: string): string {
    return branch.replaceAll("/", "-");
}

function lexists(path: string): boolean {
    try { lstatSync(path); return true; } catch { return false; }
}

interface Target {
    path: string;
    /** Folders to make before Git runs (none for a location the user chose). */
    prepare: () => void;
}

/**
 * <main>/.claude/worktrees/<folder>, with no symlink on the way: a linked
 * .claude (or worktrees) could send the checkout anywhere.
 */
function managedTarget(main: string, folder: string): Target {
    const dirs = [join(main, ".claude"), join(main, WORKTREES_DIR)];
    for (const dir of dirs) {
        let st;
        try { st = lstatSync(dir); } catch { continue; }
        if (st.isSymbolicLink() || !st.isDirectory()) throw new RpcError(`${dir} is a link or a file, so worktrees can't go there. Choose another location.`, "path_outside");
    }
    const path = join(main, WORKTREES_DIR, checkFolder(folder));
    if (lexists(path)) throw new RpcError(`${path} already exists.`, "path_exists");
    return {
        path,
        prepare: () => {
            // One level at a time, each checked before the next is made in it: replaced by a link meanwhile?
            for (const dir of dirs) {
                try { mkdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new RpcError(`Couldn't create ${dir}.`, "bad_location"); }
                const st = lstatSync(dir);
                if (st.isSymbolicLink() || !st.isDirectory()) throw new RpcError(`${dir} is a link or a file, so worktrees can't go there. Choose another location.`, "path_outside");
            }
            if (canonical(dirs[1]!) !== dirs[1]) throw new RpcError(`${dirs[1]} is a link, so worktrees can't go there. Choose another location.`, "path_outside");
        },
    };
}

/** A path the user chose elsewhere: absolute, not there yet, in a folder that is. */
function chosenTarget(location: string): Target {
    if (!isAbsolute(location)) throw new RpcError("The location must be an absolute path.", "bad_location");
    const p = resolve(location);
    const name = checkFolder(basename(p));
    const parent = dirname(p);
    if (!isDir(parent)) throw new RpcError(`${parent} isn't a folder.`, "bad_location");
    const path = join(canonical(parent), name);
    if (lexists(path)) throw new RpcError(`${path} already exists.`, "path_exists");
    return { path, prepare: () => {} };
}

async function runGitAsync(cwd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string; timedOut: boolean }> {
    const proc = spawn(gitArgv(args), { cwd, env: gitEnv(), stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
    }, timeoutMs);
    try {
        const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        return { code, stderr, timedOut };
    } finally {
        clearTimeout(timer);
    }
}

function logFailure(log: Log | undefined, what: string, stderr: string) {
    log?.(`${what}: ${redact(stderr.trim()).slice(0, 2000)}`);
}

/** `git worktree add -b <branch> <path> <commit>`; the new branch starts at the base's commit, with no upstream. */
export async function createWorktree(o: CreateWorktreeParams, log?: Log): Promise<{ path: string; branch: string }> {
    const cwd = resolve(o.path);
    const repo = repoOf(cwd);
    const branch = checkBranch(cwd, o.branch);
    // The commit, not the name: a remote branch as base doesn't become the new branch's upstream.
    const commit = resolveBase(cwd, o.base);
    const target = o.location ? chosenTarget(o.location) : managedTarget(repo.main, o.folder || defaultFolder(branch));
    target.prepare();
    const r = await runGitAsync(repo.main, [...NO_HOOKS, "worktree", "add", "-b", branch, target.path, commit], CREATE_TIMEOUT_MS);
    if (r.timedOut) {
        logFailure(log, "git worktree add timed out", r.stderr);
        throw new RpcError(`Git took too long to create the worktree. If ${target.path} was left half made, remove it with git worktree remove --force.`, "timeout");
    }
    if (r.code !== 0) {
        logFailure(log, "git worktree add failed", r.stderr);
        if (/a branch named .* already exists/.test(r.stderr)) throw new RpcError(`A branch named ${branch} already exists.`, "branch_exists");
        if (/already (checked out|used by worktree)/.test(r.stderr)) throw new RpcError(`${branch} is checked out in another worktree.`, "branch_in_use");
        if (/already exists/.test(r.stderr)) throw new RpcError(`${target.path} already exists.`, "path_exists");
        if (/invalid reference|not a valid object|unknown revision/.test(r.stderr)) throw new RpcError("The base isn't a branch or commit in this repository.", "bad_base");
        throw new RpcError("Git couldn't create the worktree.", "git_failed");
    }
    return { path: target.path, branch };
}

/** Some branch, tag or other ref contains the commit. */
function reachable(main: string, commit: string | undefined): boolean {
    if (!commit || !/^[0-9a-f]{40,64}$/.test(commit)) return false;
    return Boolean(runGit(main, ["for-each-ref", "--count=1", "--format=%(refname)", "--contains", commit])?.trim());
}

/** A detached HEAD's commit is kept only by the worktree's own HEAD and reflog, which go with it. */
function unreachable(path: string): RpcError {
    return new RpcError(`${path} is on a detached HEAD whose commit isn't on any branch. Create a branch for it first.`, "unreachable");
}

export interface Removal {
    main: string;
    /** As Git records it. */
    path: string;
    exists: boolean;
}

/**
 * Everything removal checks before Git runs, synchronously, so a caller can
 * reserve the folder before anything else gets a turn. Only a managed
 * worktree that isn't locked and has no session open in it (`inUse`).
 */
export function planRemoval(o: { path: string; worktree: string; inUse: (path: string) => boolean }): Removal {
    const repo = repoOf(resolve(o.path));
    const wanted = resolve(o.worktree);
    const index = repo.records.findIndex((r) => resolve(r.path) === wanted || canonical(r.path) === canonical(wanted));
    const record = repo.records[index];
    if (!record) throw new RpcError(`${wanted} isn't one of this repository's worktrees.`, "not_found");
    if (index === 0) throw new RpcError("The main worktree can't be removed.", "not_managed");
    const exists = isDir(record.path);
    if (!isManaged(repo.main, record.path, exists)) throw new RpcError(`Only worktrees in ${join(repo.main, WORKTREES_DIR)} can be removed here.`, "not_managed");
    if (record.locked !== undefined) throw new RpcError(`${record.path} is locked${record.locked ? ` (${record.locked})` : ""}. Unlock it with git worktree unlock first.`, "locked");
    if (o.inUse(record.path)) throw new RpcError(`A Harness session is open in ${record.path}. Close it first.`, "in_use");
    if (exists) {
        if (record.detached && !reachable(repo.main, record.head)) throw unreachable(record.path);
    } else {
        // Pruning drops every missing worktree that isn't locked, not just this one.
        const lost = repo.records.find((r, i) => i > 0 && r.locked === undefined && !isDir(r.path) && r.detached && !reachable(repo.main, r.head));
        if (lost) throw unreachable(lost.path);
    }
    return { main: repo.main, path: record.path, exists };
}

/** `git worktree remove` without --force, so Git refuses when anything would be lost; the branch stays. A folder that's already gone is pruned. */
export async function runRemoval(plan: Removal, log?: Log): Promise<string> {
    if (!plan.exists) {
        // Only Git's records go; there are no files to lose.
        const r = await runGitAsync(plan.main, ["worktree", "prune"], REMOVE_TIMEOUT_MS);
        if (r.code !== 0) {
            logFailure(log, "git worktree prune failed", r.stderr);
            throw new RpcError("Git couldn't forget the missing worktree.", "git_failed");
        }
        return plan.path;
    }
    // Untracked files count even where the user's config hides them from status.
    const r = await runGitAsync(plan.main, [...NO_HOOKS, "-c", "status.showUntrackedFiles=normal", "worktree", "remove", canonical(plan.path)], REMOVE_TIMEOUT_MS);
    if (r.timedOut) {
        logFailure(log, "git worktree remove timed out", r.stderr);
        throw new RpcError("Git took too long to remove the worktree.", "timeout");
    }
    if (r.code !== 0) {
        logFailure(log, "git worktree remove failed", r.stderr);
        if (/modified or untracked/.test(r.stderr)) throw new RpcError(`${plan.path} has uncommitted or untracked changes. Commit, stash or delete them first.`, "dirty");
        if (/locked/.test(r.stderr)) throw new RpcError(`${plan.path} is locked. Unlock it with git worktree unlock first.`, "locked");
        if (/submodule/.test(r.stderr)) throw new RpcError("Git can't remove a worktree that contains submodules.", "git_failed");
        throw new RpcError("Git couldn't remove the worktree.", "git_failed");
    }
    return plan.path;
}

export async function removeWorktree(o: { path: string; worktree: string; inUse: (path: string) => boolean }, log?: Log): Promise<string> {
    return runRemoval(planRemoval(o), log);
}
