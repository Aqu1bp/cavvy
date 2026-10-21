import { spawn, spawnSync } from "bun";
import { createHash } from "crypto";
import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { gitArgv, gitEnv } from "../util/git";
import { isInside } from "../util/files";
import { isTrusted, trustedByUser } from "../config/trust";
import { loadSettings, type Settings } from "../config/settings";
import { runHooks } from "../agent/hooks";
import { redact } from "../util/redact";
import { RpcError } from "./rpc-error";
import type { CreateWorktreeParams, RemoveWorktreeResult, WorktreeInfo } from "./protocol";

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

/**
 * In a partial clone, a missing object makes Git fetch it through the
 * promisor remote, which can run that remote's configured commands. None of
 * the checks and reads here need one.
 */
const noLazyFetch = () => ({ ...gitEnv(), GIT_NO_LAZY_FETCH: "1" });

function runGit(cwd: string, args: string[]): string | undefined {
    const result = spawnSync(gitArgv(args), { cwd, env: noLazyFetch(), stdout: "pipe", stderr: "pipe", timeout: 3000 });
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
/** The repository's hooks (post-checkout) never run; its other config is checked (checkConfigTrust). */
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

/** The main worktree's root (symlinks resolved) of the repository `cwd` is in; read-only. */
export function mainCheckoutOf(cwd: string): string {
    return repoOf(cwd).main;
}

const CONTROL = /[\x00-\x1f\x7f]/;

/** Git decides (check-ref-format); the hints only say why in words. */
function checkBranch(cwd: string, branch: string, o: { existing?: boolean } = {}): string {
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
    const exists = runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) !== undefined;
    if (o.existing) {
        if (!exists) throw new RpcError(`There's no branch named ${branch}.`, "bad_base");
        return branch;
    }
    if (exists) {
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

/** How long output is still read once Git has exited: a filter's background child can hold the pipe open indefinitely. */
const DRAIN_MS = 500;

interface GitRun {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

/** Waits for Git itself (killed at the timeout), not for its pipes to close. `lazyFetch` only for the checkout itself. Exported for tests. */
export async function runGitAsync(cwd: string, args: string[], timeoutMs: number, o: { lazyFetch?: boolean } = {}): Promise<GitRun> {
    const proc = spawn(gitArgv(args), { cwd, env: o.lazyFetch ? gitEnv() : noLazyFetch(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
    }, timeoutMs);
    const readers: { cancel(): Promise<void> }[] = [];
    const collect = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        readers.push(reader);
        const chunks: Uint8Array[] = [];
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
            }
        } catch {
            // cancelled below
        }
        return chunks;
    };
    const out = collect(proc.stdout);
    const err = collect(proc.stderr);
    let code: number | null;
    try {
        code = await proc.exited;
    } finally {
        // Git is done: the drain below has its own deadline and mustn't count as Git timing out.
        clearTimeout(timer);
    }
    let drained: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all([out, err]), new Promise((r) => (drained = setTimeout(r, DRAIN_MS)))]);
    clearTimeout(drained);
    for (const reader of readers) reader.cancel().catch(() => undefined);
    const text = async (p: Promise<Uint8Array[]>) => Buffer.concat(await p).toString();
    return { code, stdout: await text(out), stderr: await text(err), timedOut };
}

function logFailure(log: Log | undefined, what: string, stderr: string) {
    log?.(`${what}: ${redact(stderr.trim()).slice(0, 2000)}`);
}

/**
 * Repository config keys that can't make a checkout run anything: what git
 * init and clone write, and branch and remote bookkeeping. Anything else in
 * the repository's own config (a filter driver, an include that could bring
 * one in, core.sshCommand, credential helpers, a partial clone's promisor
 * fetch, ...) needs the user's trust before files are checked out with it.
 */
const INERT_CONFIG = [
    /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|checkstat|trustctime|longpaths|untrackedcache|fsmonitor|hookspath)$/,
    /^remote\..+\.(url|pushurl|fetch|push|tagopt|prune|prunetags|mirror|skipdefaultupdate|skipfetchall)$/,
    /^branch\..+\.[a-z0-9-]+$/,
    /^extensions\.(worktreeconfig|objectformat|refstorage)$/,
    /^(user\.(name|email|signingkey)|commit\.gpgsign|tag\.gpgsign|init\.defaultbranch|pull\.(rebase|ff)|push\.(default|autosetupremote)|fetch\.prune|status\.showuntrackedfiles|rerere\.enabled|lfs\.repositoryformatversion)$/,
];

const notInert = (keys: string[]) => [...new Set(keys.filter((k) => !INERT_CONFIG.some((re) => re.test(k))))];

/** A single file (--local, --file) doesn't follow includes: an include directive shows up as itself. */
function configKeys(cwd: string, scope: string[]): string[] | undefined {
    return runGit(cwd, ["config", ...scope, "--list", "--name-only", "-z"])?.split("\0").filter(Boolean);
}

/**
 * A worktree's own config.worktree (used only with extensions.worktreeConfig), from the git dir its folder's
 * .git leads to (core.worktree doesn't move that); [] when it has none, undefined when it can't be read.
 */
function perWorktreeKeys(dir: string): string[] | undefined {
    const file = runGit(dir, ["rev-parse", "--path-format=absolute", "--git-path", "config.worktree"])?.replace(/\n$/, "");
    if (!file) return undefined;
    if (!lexists(file)) return [];
    return configKeys(dir, ["--file", file]);
}

/**
 * The registered worktree (Git's own records, not --show-toplevel, which the
 * repository's core.worktree can point anywhere) a folder is in: the deepest
 * one containing it.
 */
function worktreeOf(repo: Repo, dir: string): string | undefined {
    const real = canonical(dir);
    return repo.records
        .filter((r) => !r.bare && isDir(r.path))
        .map((r) => canonical(r.path))
        .filter((w) => isInside(real, w))
        .sort((a, b) => b.length - a.length)[0];
}

/**
 * Every folder Git will run in must be this repository's: its common Git dir
 * the main worktree's, and its own Git dir that common dir (the main
 * worktree) or a direct child of <common>/worktrees/ (a linked one). A
 * linked worktree's commondir file can name another repository, whose config
 * Git would then use there although only this one's was audited; trusting
 * wouldn't make that consistent, so it isn't offered. Comes before anything
 * that trusts what Git reads in those folders.
 */
function checkIdentity(repo: Repo, folders: string[]) {
    const dirOf = (cwd: string, flag: string[]) => {
        const d = runGit(cwd, ["rev-parse", ...flag])?.replace(/\n$/, "");
        return d ? canonical(d) : undefined;
    };
    const common = (cwd: string) => dirOf(cwd, ["--path-format=absolute", "--git-common-dir"]);
    const inconsistent = (dir: string) =>
        new RpcError(`${dir} has Git metadata that doesn't match this repository (its Git directory or common directory points elsewhere), so Harness won't run Git there. Check it with git rev-parse --git-common-dir.`, "inconsistent");
    const expected = common(repo.main);
    if (!expected) throw inconsistent(repo.main);
    const main = canonical(repo.main);
    for (const dir of folders) {
        const worktree = worktreeOf(repo, dir);
        if (!worktree || common(dir) !== expected) throw inconsistent(dir);
        const own = dirOf(dir, ["--absolute-git-dir"]);
        if (worktree === main ? own !== expected : !own || dirname(own) !== join(expected, "worktrees")) throw inconsistent(dir);
    }
}

/**
 * Hooks are off, but Git reading file contents (checking files out, or
 * comparing them for status) still runs whatever the repository's own config
 * sets up: filter drivers above all. In a project the user hasn't trusted,
 * only config with nothing like that is used. Comes before any other Git
 * call that could read objects or files.
 *
 * The shared config is accepted when the main worktree or the requesting
 * folder (`cwd`) is trusted. Per-worktree config applies only in its own
 * worktree, so each one Git will run in (`worktrees`) is accepted only when
 * that worktree's folder is trusted (or one containing it): trusting a
 * sibling says nothing about it. A refusal names the folder to trust.
 */
function checkConfigTrust(repo: Repo, cwd: string, worktrees: string[], action: "create" | "remove") {
    const main = repo.main;
    const refuse = (whose: string, folder: string, keys: string[] | undefined) => {
        // Only section names: a key's middle part can be a URL with credentials in it.
        const sections = keys ? [...new Set(keys.map((k) => k.split(".")[0]))].slice(0, 6).join(", ") : "";
        const when = action === "create" ? "while files are checked out" : "while Git checks the worktree for changes";
        return new RpcError(
            `${whose} ${sections ? `has settings (${sections}) that can` : "couldn't be checked, and could"} run commands ${when}. Trust ${folder} to ${action} the worktree.`,
            "needs_trust",
            folder,
        );
    };
    if (!trustedByUser(main) && !trustedByUser(cwd)) {
        const shared = configKeys(main, ["--local"]);
        const risky = shared && notInert(shared);
        if (!risky || risky.length) throw refuse("This repository's Git configuration", cwd, risky);
    }
    if (runGit(main, ["config", "--local", "--type=bool", "--get", "extensions.worktreeConfig"])?.trim() !== "true") return;
    // Each folder as the registered worktree it's in (Git's own records, not --show-toplevel, which the
    // repository's core.worktree can point anywhere): trusting a subfolder isn't trusting its worktree's config.
    const roots = new Set<string>([canonical(main), ...worktrees.filter(isDir).map(canonical)]);
    const own = worktreeOf(repo, cwd);
    if (!own) throw refuse(`The worktree configuration for ${cwd}`, cwd, undefined);
    roots.add(own);
    for (const dir of roots) {
        if (trustedByUser(dir)) continue;
        const keys = perWorktreeKeys(dir);
        const risky = keys && notInert(keys);
        if (!risky || risky.length) throw refuse(`The worktree configuration of ${dir}`, dir, risky);
    }
}

/**
 * What creating a worktree from `cwd` checks before anything else: a
 * repository with a main worktree, Git metadata that's its own, and config
 * the user trusts (or that can't run anything). Returns the main worktree.
 */
export function checkCreate(cwd: string): string {
    const repo = repoOf(cwd);
    checkIdentity(repo, [cwd]);
    checkConfigTrust(repo, cwd, [], "create");
    return repo.main;
}

/** Keep managed checkouts out of status and git add in every worktree, without changing tracked files. */
function excludeManagedWorktrees(main: string, log?: Log) {
    try {
        const common = runGit(main, ["rev-parse", "--git-common-dir"])?.replace(/\n$/, "");
        if (!common) throw new Error("Couldn't find the common Git directory.");
        const file = resolve(main, common, "info", "exclude");
        // An exclude (or info directory) linked into the checkout mustn't change tracked files.
        for (const path of [dirname(file), file]) {
            if (lexists(path) && lstatSync(path).isSymbolicLink()) throw new Error("Git's info/exclude is a symbolic link.");
        }
        if (lexists(file) && lstatSync(file).nlink > 1) throw new Error("Git's info/exclude has multiple hard links.");
        let content = "";
        try { content = readFileSync(file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        if (content.split(/\r?\n/).some((line) => /^\/?\.claude\/worktrees\/?$/.test(line))) return;
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${content && !content.endsWith("\n") ? "\n" : ""}/.claude/worktrees/\n`);
    } catch (e) {
        logFailure(log, "couldn't exclude managed worktrees", String(e));
    }
}

/**
 * `git worktree add -b <branch> <path> <commit>`; the new branch starts at the base's commit, with no upstream.
 * `existingBranch`: checks out a branch that's already there instead (`base` is ignored).
 */
export async function createWorktree(o: CreateWorktreeParams, log?: Log, x: { existingBranch?: boolean } = {}): Promise<{ path: string; branch: string; commit: string }> {
    const cwd = resolve(o.path);
    const main = checkCreate(cwd);
    const branch = checkBranch(cwd, o.branch, { existing: x.existingBranch });
    // The commit, not the name: a remote branch as base doesn't become the new branch's upstream.
    const commit = resolveBase(cwd, x.existingBranch ? `refs/heads/${branch}` : o.base);
    const target = o.location ? chosenTarget(o.location) : managedTarget(main, o.folder || defaultFolder(branch));
    target.prepare();
    // A partial clone fetches the files it checks out (its config is trusted, or it would have been refused above).
    const add = x.existingBranch ? [target.path, branch] : ["-b", branch, target.path, commit];
    const r = await runGitAsync(main, [...NO_HOOKS, "worktree", "add", ...add], CREATE_TIMEOUT_MS, { lazyFetch: true });
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
    if (isManaged(main, target.path, true)) excludeManagedWorktrees(main, log);
    return { path: target.path, branch, commit };
}

/** The repository's settings, as a session in it would have them (project hooks only once it's trusted). */
function repoSettings(dir: string): Settings {
    return loadSettings(dir, { trusted: isTrusted(dir) });
}

/** The hook's answer as a folder to work in: an existing directory, a plain path, and not through a symlink inside the repository. */
function hookWorktreePath(main: string, given: string): string {
    if (given.split(/[\\/]/).some((s) => s === "." || s === "..")) throw new RpcError(`The WorktreeCreate hook gave ${given}: use a path without . or .. in it.`, "hook_failed");
    const path = resolve(main, given);
    if (!isDir(path)) throw new RpcError(`The WorktreeCreate hook gave ${path}, which isn't a folder.`, "hook_failed");
    // A symlink committed to the repository could point the worktree anywhere.
    if (isInside(path, main) && realpathSync(path) !== path) throw new RpcError(`The WorktreeCreate hook gave ${path}, which goes through a symlink inside the repository.`, "hook_failed");
    return path;
}

/**
 * A worktree, as createWorktree makes it, unless the repository's settings
 * have WorktreeCreate hooks: then they make it instead of Git (as in Claude
 * Code), printing the folder's path, and it's checked like any folder.
 */
export async function createWorktreeWithHooks(o: CreateWorktreeParams, log?: Log, settings?: Settings): Promise<{ path: string; branch: string; commit: string }> {
    const cwd = resolve(o.path);
    const s = settings ?? repoSettings(cwd);
    // Awaited, so its errors reject this call (handed back unawaited, Bun reported them as unhandled and the server stopped).
    if (!s.hooks?.WorktreeCreate?.length) return await createWorktree(o, log);
    const main = checkCreate(cwd);
    const name = o.folder || defaultFolder(o.branch);
    const h = await runHooks(s, "WorktreeCreate", { name, branch: o.branch, base: o.base ?? null, ...(o.location ? { location: o.location } : {}) }, main);
    if (h.blocked) throw new RpcError(`A WorktreeCreate hook refused: ${redact(h.blocked)}`, "hook_failed");
    if (h.errors.length) throw new RpcError(`The WorktreeCreate hook failed: ${redact(h.errors[0]!)}`, "hook_failed");
    if (!h.worktreePath) throw new RpcError("The WorktreeCreate hook didn't print the new worktree's path.", "hook_failed");
    const path = hookWorktreePath(main, h.worktreePath);
    const head = await runGitAsync(path, ["rev-parse", "--verify", "HEAD"], CREATE_TIMEOUT_MS);
    return { path, branch: o.branch, commit: head.code === 0 ? head.stdout.trim() : "" };
}

/** `wanted`, or wanted-2, -3, … when a branch has that name already (only a suggestion: checkBranch decides). */
export function suggestBranch(cwd: string, wanted: string): string {
    const taken = (b: string) => runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${b}`]) !== undefined;
    for (let n = 1; n < 100; n++) {
        const b = n > 1 ? `${wanted}-${n}` : wanted;
        if (!taken(b)) return b;
    }
    return `${wanted}-${Date.now().toString(36)}`;
}

/** The folder's current branch, or its commit (abbreviated) when HEAD is detached; undefined before the first commit. */
export function currentBase(cwd: string): string | undefined {
    const branch = runGit(cwd, ["branch", "--show-current"])?.trim();
    if (branch && runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]) !== undefined) return branch;
    return runGit(cwd, ["rev-parse", "--verify", "--quiet", "--short=12", "HEAD^{commit}"])?.trim() || undefined;
}

/** The managed worktree a folder is in (the deepest one), from Git's records; undefined outside one. */
export function managedWorktreeOf(cwd: string): { worktree: WorktreeInfo; main: string } | undefined {
    let all: WorktreeInfo[];
    try {
        all = listWorktrees(cwd);
    } catch {
        return undefined;
    }
    const main = all.find((w) => w.main);
    const real = canonical(cwd);
    const worktree = all
        .filter((w) => w.managed && (isInside(resolve(cwd), resolve(w.path)) || isInside(real, canonical(w.path))))
        .sort((a, b) => b.path.length - a.path.length)[0];
    return worktree && main ? { worktree, main: main.path } : undefined;
}

/** Some branch, tag or other ref contains the commit. */
function reachable(main: string, commit: string | undefined): boolean {
    if (!commit || !/^[0-9a-f]{40,64}$/.test(commit)) return false;
    return Boolean(runGit(main, ["for-each-ref", "--count=1", "--format=%(refname)", "--contains", commit])?.trim());
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
    const cwd = resolve(o.path);
    const repo = repoOf(cwd);
    checkIdentity(repo, [cwd]);
    const wanted = resolve(o.worktree);
    const index = repo.records.findIndex((r) => resolve(r.path) === wanted || canonical(r.path) === canonical(wanted));
    const record = repo.records[index];
    if (!record) throw new RpcError(`${wanted} isn't one of this repository's worktrees.`, "not_found");
    if (index === 0) throw new RpcError("The main worktree can't be removed.", "not_managed");
    const exists = isDir(record.path);
    if (exists) checkIdentity(repo, [record.path]);
    if (!isManaged(repo.main, record.path, exists)) throw new RpcError(`Only worktrees in ${join(repo.main, WORKTREES_DIR)} can be removed here.`, "not_managed");
    if (record.locked !== undefined) throw new RpcError(`${record.path} is locked${record.locked ? ` (${record.locked})` : ""}. Unlock it with git worktree unlock first.`, "locked");
    if (o.inUse(record.path)) throw new RpcError(`A Harness session is open in ${record.path} (in this app, or in another process such as a terminal). Close it first.`, "in_use");
    // Git's status runs in the worktree itself, and runs clean filters on files whose stat changed.
    checkConfigTrust(repo, cwd, exists ? [record.path] : [], "remove");
    // A detached HEAD's commit is kept only by the worktree's own HEAD and reflog, which go with it.
    if (record.detached && !reachable(repo.main, record.head)) throw new RpcError(`${record.path} is on a detached HEAD whose commit isn't on any branch. Create a branch for it first.`, "unreachable");
    return { main: repo.main, path: record.path, exists };
}

/** At most this many ignored entries are named; the token covers them all. */
const IGNORED_SHOWN = 12;

/** Ignored files and folders in the worktree, read without reading any contents: `shown` collapsed to the folder, `all` every file. */
async function ignoredEntries(path: string, log?: Log): Promise<{ shown: string[]; all: string[] }> {
    const list = (more: string[]) => runGitAsync(path, ["ls-files", "--others", "--ignored", "--exclude-standard", ...more, "-z"], REMOVE_TIMEOUT_MS);
    const [shown, all] = await Promise.all([list(["--directory"]), list([])]);
    for (const r of [shown, all]) {
        if (r.code !== 0 || r.timedOut) {
            logFailure(log, "git ls-files for ignored files failed", r.stderr);
            throw new RpcError("Git couldn't list the worktree's ignored files, so nothing was removed.", "git_failed");
        }
    }
    const split = (out: string) => out.split("\0").filter(Boolean).sort();
    return { shown: split(shown.stdout), all: split(all.stdout) };
}

/** Covers every ignored file, so one added inside a folder the user saw listed (node_modules/late.js) changes it. */
const ignoredToken = (path: string, entries: string[]) => createHash("sha256").update([path, ...entries].join("\0")).digest("hex");

/** The ignored files removal would delete, unless `deleteIgnored` is the token for exactly them (or there are none). */
export async function ignoredWaiting(plan: Removal, deleteIgnored: string | undefined, log?: Log): Promise<Extract<RemoveWorktreeResult, { removed: false }> | undefined> {
    if (!plan.exists) return undefined;
    const { shown, all } = await ignoredEntries(plan.path, log);
    const confirm = ignoredToken(plan.path, [...shown, "", ...all]);
    if (shown.length && deleteIgnored !== confirm) return { removed: false, ignored: shown.slice(0, IGNORED_SHOWN), total: shown.length, confirm };
    return undefined;
}

/**
 * Why a worktree's commits aren't safe on a remote, if they aren't: commits
 * at its HEAD that no remote-tracking branch contains (`rev-list --not
 * --remotes`). With no remote at all, that's every commit. Only refs and
 * commits are read, never files, so no filter can run; nothing is fetched.
 * Anything that can't be checked counts as not pushed.
 */
export async function unpushedReason(o: { path: string; worktree: string }): Promise<string | undefined> {
    const cwd = resolve(o.path);
    const repo = repoOf(cwd);
    checkIdentity(repo, [cwd]);
    const wanted = resolve(o.worktree);
    const record = repo.records.find((r) => resolve(r.path) === wanted || canonical(r.path) === canonical(wanted));
    if (!record) throw new RpcError(`${wanted} isn't one of this repository's worktrees.`, "not_found");
    if (isDir(record.path)) checkIdentity(repo, [record.path]);
    checkConfigTrust(repo, cwd, isDir(record.path) ? [record.path] : [], "remove");
    const what = record.branch ? `Branch ${record.branch}` : "Its detached HEAD";
    const unchecked = `Couldn't check whether ${record.path}'s commits are on a remote, so it's kept.`;
    const head = record.head;
    if (!head || !/^[0-9a-f]{40,64}$/.test(head)) return unchecked;
    const remotes = runGit(repo.main, ["remote"]);
    if (remotes === undefined) return unchecked;
    if (!remotes.trim()) return `This repository has no remote, so none of the worktree's commits are on a remote branch. It's kept; you can still remove it from the worktree picker.`;
    const r = await runGitAsync(repo.main, ["rev-list", "--count", head, "--not", "--remotes"], REMOVE_TIMEOUT_MS);
    const count = r.code === 0 && !r.timedOut ? Number(r.stdout.trim()) : NaN;
    if (!Number.isInteger(count)) return unchecked;
    if (count > 0) return `${what} has ${count === 1 ? "a commit" : `${count} commits`} that ${count === 1 ? "isn't" : "aren't"} on any remote branch. Push ${count === 1 ? "it" : "them"} first, or remove the worktree from the worktree picker.`;
    return undefined;
}

/**
 * `git worktree remove` without --force, so Git refuses when anything tracked
 * or untracked would be lost; the branch stays. Git would delete ignored files
 * (an .env, node_modules/) without asking, so they're listed first, and only
 * deleted when `deleteIgnored` is the token for exactly the list the user saw.
 * A folder that's already gone loses only its own record.
 */
export async function runRemoval(plan: Removal, o: { deleteIgnored?: string; settings?: Settings; inUse?: (path: string) => boolean } = {}, log?: Log): Promise<RemoveWorktreeResult> {
    const waiting = await ignoredWaiting(plan, o.deleteIgnored, log);
    if (waiting) return waiting;
    // Asked again after the awaits above: a session may have opened there since the plan.
    if (plan.exists && o.inUse?.(plan.path)) throw new RpcError(`A Harness session is open in ${plan.path} (in this app, or in another process such as a terminal). Close it first.`, "in_use");
    // WorktreeRemove hooks run first (after the same checks). One that deleted the folder
    // removed it (a worktree a WorktreeCreate hook made); otherwise Git removes it as usual.
    const settings = o.settings ?? repoSettings(plan.main);
    if (settings.hooks?.WorktreeRemove?.length) {
        const h = await runHooks(settings, "WorktreeRemove", { worktree_path: plan.path }, plan.main);
        const stays = isDir(plan.path);
        if (h.errors.length && stays) {
            logFailure(log, "WorktreeRemove hook failed", h.errors.join("\n"));
            throw new RpcError(`The WorktreeRemove hook failed, so ${plan.path} stays: ${redact(h.errors[0]!)}`, "hook_failed");
        }
        if (!stays) {
            // Git's record of a folder the hook deleted.
            await runGitAsync(plan.main, [...NO_HOOKS, "worktree", "prune"], REMOVE_TIMEOUT_MS);
            return { removed: true };
        }
    }
    // Untracked files count even where the user's config hides them from status.
    const r = await runGitAsync(plan.main, [...NO_HOOKS, "-c", "status.showUntrackedFiles=normal", "worktree", "remove", plan.exists ? canonical(plan.path) : plan.path], REMOVE_TIMEOUT_MS);
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
    return { removed: true };
}

export async function removeWorktree(o: { path: string; worktree: string; inUse: (path: string) => boolean; deleteIgnored?: string }, log?: Log): Promise<RemoveWorktreeResult> {
    return runRemoval(planRemoval(o), o, log);
}

// ---------------------------------------------------------------------------
// Session worktrees: `harness --worktree [name]` (and anything else that wants
// a throwaway checkout). Harness marks the ones it makes so cleanup knows the
// commit each started from; it only ever removes a marked one, and never one
// with uncommitted or untracked changes (Git refuses those, without --force).

export type BaseRef = "head" | "fresh";
export type CleanupMode = "auto" | "ask" | "keep";

/** Written in the worktree's own Git dir, so it's never part of the checkout and goes with it. */
const MARKER = "harness-worktree.json";

export interface WorktreeMarker {
    /** The name it was asked for by (`harness -w <name>`). */
    name: string;
    branch: string;
    /** The commit the branch started at. */
    base: string;
    createdAt: number;
    /** False when it checked out a branch that was already there: cleanup never deletes that one. */
    ownBranch?: boolean;
}

function gitDirOf(worktree: string): string | undefined {
    return runGit(worktree, ["rev-parse", "--absolute-git-dir"])?.replace(/\n$/, "") || undefined;
}

/** One empty file per process working in a session worktree, named by its pid, in the worktree's Git dir. */
const PRESENT = "harness-present";

/**
 * Marks this process as working in the worktree until it exits, so another
 * session's cleanup leaves it alone, also before this session takes its lock
 * (with its first message). Best effort: returns whether it was marked.
 */
export function markPresent(worktree: string): boolean {
    const dir = gitDirOf(worktree);
    if (!dir) return false;
    const file = join(dir, PRESENT, String(process.pid));
    try {
        mkdirSync(join(dir, PRESENT), { recursive: true });
        writeFileSync(file, "");
    } catch {
        return false;
    }
    process.once("exit", () => {
        try {
            rmSync(file, { force: true });
        } catch {
            // the worktree went first
        }
    });
    return true;
}

/** Whether another running process marked itself present in the worktree. A stale mark (its process gone) doesn't count. */
export function othersPresent(worktree: string): boolean {
    const dir = gitDirOf(worktree);
    if (!dir) return false;
    let names: string[];
    try {
        names = readdirSync(join(dir, PRESENT));
    } catch {
        return false;
    }
    return names.some((n) => {
        const pid = Number(n);
        if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
        try {
            process.kill(pid, 0);
            return true;
        } catch (e) {
            return (e as NodeJS.ErrnoException).code === "EPERM";
        }
    });
}

export function writeMarker(worktree: string, marker: WorktreeMarker) {
    const dir = gitDirOf(worktree);
    if (!dir) throw new Error(`Couldn't find ${worktree}'s Git directory.`);
    writeFileSync(join(dir, MARKER), JSON.stringify(marker) + "\n");
}

export function readMarker(worktree: string): WorktreeMarker | undefined {
    const dir = gitDirOf(worktree);
    if (!dir) return undefined;
    try {
        const m = JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as Partial<WorktreeMarker>;
        if (typeof m.name !== "string" || typeof m.branch !== "string" || typeof m.base !== "string" || !/^[0-9a-f]{40,64}$/.test(m.base)) return undefined;
        return { name: m.name, branch: m.branch, base: m.base, createdAt: typeof m.createdAt === "number" ? m.createdAt : 0, ownBranch: m.ownBranch !== false };
    } catch {
        return undefined;
    }
}

const ADJECTIVES = ["amber", "brave", "bright", "calm", "clever", "cosmic", "crisp", "eager", "gentle", "golden", "happy", "humble", "jolly", "keen", "lively", "lucky", "mellow", "nimble", "proud", "quick", "quiet", "rapid", "shiny", "silent", "steady", "sunny", "swift", "tidy", "witty", "zesty"];
const NOUNS = ["badger", "beacon", "cedar", "comet", "falcon", "fern", "harbor", "heron", "lantern", "maple", "meadow", "otter", "panda", "pebble", "pine", "puffin", "quartz", "raven", "river", "robin", "sparrow", "spruce", "summit", "tiger", "tulip", "walrus", "willow", "wren", "yak", "zebra"];

/** adjective-noun, like swift-otter. */
export function randomName(random: () => number = Math.random): string {
    const pick = (list: string[]) => list[Math.floor(random() * list.length) % list.length]!;
    return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

/** Something a worktree name can be: what a user would type, no spaces or leading "-". */
export function looksLikeWorktreeName(s: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(s) && !s.includes("..");
}

export interface SessionWorktree {
    name: string;
    /** The worktree's root. */
    path: string;
    /** Where the session starts: the folder it was launched from, at the same place in the worktree (when it's there). */
    cwd: string;
    /** Whether `cwd` is that same place, not the root it fell back to. */
    sameFolder: boolean;
    main: string;
    /** Undefined when it's on a detached HEAD (a reopened one). */
    branch?: string;
    /** The commit it started from, when Harness made it. */
    base?: string;
    /** What the base was, in words: a branch, origin/main, or a commit. */
    baseLabel?: string;
    /** False when an existing worktree of that name was reopened. */
    created: boolean;
    /** Made again on the branch an earlier one of that name left behind. */
    fromBranch?: boolean;
    /** How long getting it ready took. */
    ms: number;
    /** Something the user should know (a fresh base that fell back to HEAD). */
    note?: string;
}

/** The base commit and how to name it: HEAD, or `origin/HEAD` as last fetched (nothing is fetched). */
function pickBase(cwd: string, baseRef: BaseRef): { ref?: string; label?: string; note?: string } {
    if (baseRef === "fresh") {
        const commit = runGit(cwd, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD^{commit}"])?.trim();
        if (commit && /^[0-9a-f]{40,64}$/.test(commit)) {
            const label = runGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])?.trim() || "origin/HEAD";
            return { ref: commit, label };
        }
        return { label: currentBase(cwd), note: "worktree.baseRef is “fresh”, but this repository has no origin/HEAD (run git remote set-head origin --auto), so the worktree starts from HEAD." };
    }
    return { label: currentBase(cwd) };
}

/** The same place in `worktree` as `cwd` is in its own worktree, if that folder is there. */
function sameSubfolder(cwd: string, worktree: string): { cwd: string; matched: boolean } {
    const top = runGit(cwd, ["rev-parse", "--show-toplevel"])?.replace(/\n$/, "");
    if (!top) return { cwd: worktree, matched: false };
    const rel = relative(canonical(top), canonical(cwd));
    if (!rel) return { cwd: worktree, matched: true };
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { cwd: worktree, matched: false };
    const there = join(worktree, rel);
    if (!isDir(there)) return { cwd: worktree, matched: false };
    // Still inside the worktree once links are followed: a linked src/ could lead back into the main checkout.
    const real = canonical(worktree);
    const resolved = canonical(there);
    if (!isInside(resolved, real)) return { cwd: worktree, matched: false };
    // The same folder only when no link is on the way: a link could stand for the root, or any folder above.
    return { cwd: there, matched: resolved === join(real, rel) };
}

/**
 * Creates `<main>/.claude/worktrees/<name>` on branch `<prefix><name>`, or
 * reopens it when Git already has a managed worktree there. Without a name,
 * one is made up that's free as both folder and branch. Throws RpcError with
 * a message for the user when it can't.
 */
export async function enterSessionWorktree(o: { cwd: string; name?: string; branchPrefix?: string; baseRef?: BaseRef }, log?: Log): Promise<SessionWorktree> {
    const started = performance.now();
    const cwd = resolve(o.cwd);
    // Only where things are, for now: creating (or reopening) checks the rest, once.
    const repo = repoOf(cwd);
    const main = repo.main;
    const prefix = o.branchPrefix ?? "harness/";
    const done = (w: Omit<SessionWorktree, "ms" | "main">): SessionWorktree => ({ ...w, main, ms: Math.round(performance.now() - started) });

    let name = o.name;
    if (name !== undefined) {
        if (!looksLikeWorktreeName(name)) throw new RpcError(`“${name}” can't be a worktree name: use letters, digits, “.”, “_”, “-” and “/”, starting with a letter or digit.`, "bad_folder");
        const folder = checkFolder(defaultFolder(name));
        const path = join(main, WORKTREES_DIR, folder);
        // Only a real folder under .claude/worktrees: a link there (it can be committed) could point at the main checkout.
        const linked = lexists(path) && lstatSync(path).isSymbolicLink();
        const record = linked ? undefined : repo.records.find((r) => !r.bare && (resolve(r.path) === path || canonical(r.path) === canonical(path)) && isManaged(main, r.path, isDir(r.path)));
        if (record) {
            const existing = { ...record, exists: isDir(record.path) };
            if (!existing.exists) throw new RpcError(`Git still lists the worktree ${existing.path}, but its folder is gone. Run git worktree prune, then try again.`, "path_missing");
            // Git will run there: its metadata must be this repository's, and its config trusted.
            checkCreate(existing.path);
            const marker = readMarker(existing.path);
            // feat/login and feat-login share a folder name, not a worktree.
            if (marker && marker.name !== name) throw new RpcError(`The folder ${folder} is already the worktree for “${marker.name}”. Use that name to reopen it, or pick another.`, "path_exists");
            const at = sameSubfolder(cwd, existing.path);
            return done({ name, path: existing.path, cwd: at.cwd, sameFolder: at.matched, branch: existing.branch, base: marker?.base, created: false });
        }
        if (lexists(path)) throw new RpcError(`${path} exists but isn't one of this repository's worktrees. Move it, or pick another name.`, "path_exists");
    } else {
        const taken = (n: string) => lexists(join(main, WORKTREES_DIR, n)) || runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${prefix}${n}`]) !== undefined;
        name = randomName();
        for (let i = 2; taken(name) && i < 50; i++) name = `${randomName()}${i > 10 ? `-${i}` : ""}`;
    }

    // A worktree removed earlier with its branch kept comes back on that branch.
    const branch = `${prefix}${name}`;
    const kept = o.name !== undefined && runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) !== undefined;
    const base = kept ? { label: branch } : pickBase(cwd, o.baseRef ?? "head");
    let made;
    try {
        made = await createWorktree({ path: cwd, branch, folder: defaultFolder(name), base: base.ref }, log, { existingBranch: kept });
    } catch (e) {
        if (e instanceof RpcError && e.code === "branch_in_use") throw new RpcError(`${branch} is checked out in another worktree. Pick another name, or work there.`, "branch_in_use");
        if (e instanceof RpcError && e.code === "bad_base" && !base.ref && !kept) throw new RpcError("This repository has no commits yet, so there's nothing to check out. Make a first commit, then try again.", "bad_base");
        throw e;
    }
    try {
        writeMarker(made.path, { name, branch: made.branch, base: made.commit, createdAt: Date.now(), ownBranch: !kept });
    } catch (e) {
        // Without it the worktree is never cleaned up automatically, which is the safe side.
        logFailure(log, "couldn't mark the worktree", String(e));
    }
    const at = sameSubfolder(cwd, made.path);
    return done({ name, path: made.path, cwd: at.cwd, sameFolder: at.matched, branch: made.branch, base: made.commit, baseLabel: base.label, created: true, fromBranch: kept, note: base.note });
}

/** What removing a worktree would lose. Nothing here changes anything. */
export interface WorktreeWork {
    /** Changed, staged, deleted or untracked paths (git status). */
    changes: number;
    /** Commits at HEAD that the base doesn't have. */
    commits: number;
    /** HEAD is still the base commit, on the branch it was made with. */
    atBase: boolean;
    /** HEAD's commit and branch (undefined when detached) as they were seen: removal goes ahead only if they still are. */
    head: string;
    branch?: string;
    /** Ignored files and folders removal would delete (at most a dozen named). */
    ignored: string[];
    ignoredTotal: number;
    /** Hands the user's go-ahead for exactly those ignored files to runRemoval. */
    confirm?: string;
}

/** The checks removal makes (a managed worktree, not locked, no other session in it, trusted config), then what's in it. */
export async function worktreeWork(o: { main: string; path: string; marker: WorktreeMarker; inUse: (path: string) => boolean }, log?: Log): Promise<{ plan: Removal; work: WorktreeWork }> {
    const plan = planRemoval({ path: o.main, worktree: o.path, inUse: o.inUse });
    if (!plan.exists) return { plan, work: { changes: 0, commits: 0, atBase: true, ignored: [], ignoredTotal: 0, head: o.marker.base, branch: o.marker.branch } };
    const status = await runGitAsync(plan.path, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=none"], REMOVE_TIMEOUT_MS);
    if (status.code !== 0 || status.timedOut) {
        logFailure(log, "git status failed", status.stderr);
        throw new RpcError("Git couldn't check the worktree for changes.", "git_failed");
    }
    // -z: one NUL per entry, and a rename's old path as one more field.
    const fields = status.stdout.split("\0").filter(Boolean);
    let changes = 0;
    for (let i = 0; i < fields.length; i++) {
        changes++;
        if (/^[RC]/.test(fields[i]!)) i++;
    }
    const head = runGit(plan.path, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?.trim();
    const branch = runGit(plan.path, ["symbolic-ref", "--quiet", "--short", "HEAD"])?.trim();
    const counted = head ? runGit(plan.main, ["rev-list", "--count", head, "--not", o.marker.base]) : undefined;
    const commits = counted === undefined ? NaN : Number(counted.trim());
    if (!head || !Number.isInteger(commits)) throw new RpcError("Git couldn't count the worktree's commits.", "git_failed");
    const waiting = await ignoredWaiting(plan, undefined, log);
    return {
        plan,
        work: { changes, commits, atBase: head === o.marker.base && branch === o.marker.branch, head, branch: branch || undefined, ignored: waiting?.ignored ?? [], ignoredTotal: waiting?.total ?? 0, confirm: waiting?.confirm },
    };
}

/** Nothing would be lost: no changes, no commits of its own, and (unless they don't count) no ignored files. */
export function isPristine(work: WorktreeWork, o: { ignoredIsWork?: boolean } = {}): boolean {
    return work.changes === 0 && work.commits === 0 && work.atBase && (o.ignoredIsWork === false || work.ignoredTotal === 0);
}

/**
 * Deletes the branch a removed worktree was made with, only while it still
 * points at its base commit (compare-and-delete, so a commit made meanwhile
 * keeps it) and some other ref has that commit: nothing can be lost.
 */
export function deleteBranchAtBase(main: string, branch: string, base: string): boolean {
    if (!/^[0-9a-f]{40,64}$/.test(base) || branch.startsWith("-") || CONTROL.test(branch)) return false;
    const others = runGit(main, ["for-each-ref", "--format=%(refname)", "--contains", base])?.split("\n").filter((r) => r && r !== `refs/heads/${branch}`);
    if (!others?.length) return false;
    return runGit(main, [...NO_HOOKS, "update-ref", "-d", `refs/heads/${branch}`, base]) !== undefined;
}

/** Removes the worktree (Git refuses if anything uncommitted is there) and, when it was never moved, its branch. */
export async function removeSessionWorktree(o: { plan: Removal; marker: WorktreeMarker; work: WorktreeWork; inUse?: (path: string) => boolean }, log?: Log): Promise<{ removed: boolean; branchDeleted: boolean; changed?: boolean }> {
    // A commit made since it was looked at (by a SessionEnd hook, another terminal) keeps it: on a
    // detached HEAD nothing else would hold that commit once the worktree's HEAD and reflog are gone.
    // So does a session opened in it meanwhile: asked again, not taken from the plan.
    if (o.plan.exists) {
        if (o.inUse?.(o.plan.path)) throw new RpcError(`A Harness session is open in ${o.plan.path} (in this app, or in another process such as a terminal). Close it first.`, "in_use");
        const head = runGit(o.plan.path, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?.trim();
        const branch = runGit(o.plan.path, ["symbolic-ref", "--quiet", "--short", "HEAD"])?.trim() || undefined;
        if (head !== o.work.head || branch !== o.work.branch) return { removed: false, branchDeleted: false, changed: true };
        if (!branch && !reachable(o.plan.main, head)) return { removed: false, branchDeleted: false, changed: true };
    }
    const r = await runRemoval(o.plan, { deleteIgnored: o.work.confirm }, log);
    if (!r.removed) return { removed: false, branchDeleted: false };
    const branchDeleted = o.marker.ownBranch !== false && o.work.atBase && o.work.commits === 0 && deleteBranchAtBase(o.plan.main, o.marker.branch, o.marker.base);
    return { removed: true, branchDeleted };
}

/**
 * A throwaway worktree's whole cleanup for callers with nobody to ask (a
 * sub-agent's): removed with its branch when nothing would be lost, else
 * kept. `ignoredIsWork: false` lets ignored files (build output) go too.
 */
export async function removeIfPristine(o: { main: string; path: string; inUse?: (path: string) => boolean; ignoredIsWork?: boolean }, log?: Log): Promise<{ removed: boolean; branchDeleted: boolean; kept?: string }> {
    const marker = readMarker(o.path);
    if (!marker) return { removed: false, branchDeleted: false, kept: "Harness didn't make this worktree." };
    try {
        const { plan, work } = await worktreeWork({ main: o.main, path: o.path, marker, inUse: o.inUse ?? (() => false) }, log);
        if (!isPristine(work, o)) return { removed: false, branchDeleted: false, kept: "It has work in it." };
        return await removeSessionWorktree({ plan, marker, work, inUse: o.inUse }, log);
    } catch (e) {
        return { removed: false, branchDeleted: false, kept: (e as Error).message };
    }
}
