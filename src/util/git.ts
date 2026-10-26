import { spawnSync } from "bun";
import { lstatSync, readlinkSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { basename, delimiter, dirname, isAbsolute, join, parse, relative, resolve, sep } from "path";
import { childEnv } from "./env";
import { trustedByUser } from "../config/trust";

/**
 * argv for the harness's own git calls. These run in whatever repository the
 * user opened, before it is trusted: a repo's `core.fsmonitor` would
 * otherwise run its command on every `git status`.
 */
export function gitArgv(args: string[]): string[] {
    return ["git", "-c", "core.fsmonitor=false", ...args];
}

export function gitEnv(): Record<string, string> {
    return childEnv({ GIT_OPTIONAL_LOCKS: "0" });
}

/** Variables that name a repository, its work tree or its parts: inherited, they'd point git somewhere other than cwd's repository. */
export const REPO_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE"];

/** gitEnv() without REPO_VARS: git finds the repository from cwd alone. */
export function cwdGitEnv(): Record<string, string> {
    const env = gitEnv();
    for (const key of REPO_VARS) delete env[key];
    return env;
}

function untrustedGitEnv(): Record<string, string> {
    // Git before 2.45 ignores GIT_NO_LAZY_FETCH. As in git-changes, deny every
    // real protocol too, so missing objects cannot invoke a promisor transport.
    // A relative PATH entry ("." or empty) would let the repo supply the program a
    // bare driver name (git-lfs) or git itself resolves to; only absolute ones stay.
    // Audit and discovery must inspect cwd's repository, not an inherited one.
    const env = cwdGitEnv();
    if (env.PATH !== undefined) env.PATH = env.PATH.split(delimiter).filter((d) => isAbsolute(d)).join(delimiter);
    return { ...env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "harness-none" };
}

/** The command and environment a harness git call runs with. */
function gitCall(args: string[]): { argv: string[]; env: Record<string, string> } {
    // Config reads cannot run fsmonitor. Audit the original settings without
    // adding our own core.fsmonitor override to the list of configured keys.
    const argv = args[0] === "config" ? ["git", ...args] : gitArgv(args);
    const env = untrustedGitEnv();
    // GIT_CONFIG redirects only `git config`, not status. It must not hide
    // the effective settings that ordinary git commands will actually use.
    if (args[0] === "config") delete env.GIT_CONFIG;
    return { argv, env };
}

function gitOutput(args: string[], exitCode: number | null, stdout: string): string | undefined {
    if (exitCode === 1 && args[0] === "config" && args.includes("--get-regexp")) return "";
    if (exitCode !== 0) return undefined;
    return stdout.trimEnd();
}

function git(cwd: string, args: string[], timeoutMs = 3000): string | undefined {
    try {
        const { argv, env } = gitCall(args);
        const r = spawnSync(argv, { cwd, stdout: "pipe", stderr: "ignore", timeout: timeoutMs, env });
        return gitOutput(args, r.exitCode, r.stdout.toString());
    } catch {
        return undefined;
    }
}

/**
 * The process groups of async git calls still running. Out of the harness's own group, they'd miss the
 * terminal's Ctrl-C and outlive their deadline should the harness end first: they're killed with it.
 */
const liveGroups = new Set<number>();
const killGroup = (pgid: number) => {
    try {
        process.kill(-pgid, "SIGKILL");
    } catch {
        // the group is gone already
    }
};
/** Kills every async git call still running (the process is ending). */
export function killGitGroups() {
    for (const pgid of liveGroups) killGroup(pgid);
    untrack();
}
const onSigint = () => onSignal("SIGINT");
const onSigterm = () => onSignal("SIGTERM");
function onSignal(sig: NodeJS.Signals) {
    killGitGroups();
    // No one else handles it: it ends the process, as it would have without this handler.
    if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
}
function track(pgid: number) {
    if (!liveGroups.size) {
        process.on("exit", killGitGroups);
        process.on("SIGINT", onSigint);
        process.on("SIGTERM", onSigterm);
    }
    liveGroups.add(pgid);
}
function untrack(pgid?: number) {
    if (pgid === undefined) liveGroups.clear();
    else liveGroups.delete(pgid);
    if (liveGroups.size) return;
    process.off("exit", killGitGroups);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
}

/**
 * git() without blocking: the server goes on serving while it runs. The timeout bounds the whole call,
 * output included: git runs in a process group of its own, and at the deadline (or once `signal` aborts)
 * the group is killed, with anything it started that still holds the output open, and the read given up.
 */
export async function gitAsync(cwd: string, args: string[], o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string | undefined> {
    if (o.signal?.aborted) return undefined;
    let p: Bun.Subprocess<"ignore", "pipe", "ignore">;
    try {
        const { argv, env } = gitCall(args);
        p = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore", env, detached: true });
    } catch {
        return undefined;
    }
    track(p.pid);
    const reader = p.stdout.getReader();
    const read = async () => {
        const chunks: Uint8Array[] = [];
        for (let c = await reader.read(); !c.done; c = await reader.read()) chunks.push(c.value);
        return Buffer.concat(chunks).toString();
    };
    let timer: Timer | undefined;
    let stop: (() => void) | undefined;
    const deadline = new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, o.timeoutMs ?? 3000);
        o.signal?.addEventListener("abort", (stop = () => resolve(undefined)), { once: true });
    });
    try {
        const done = await Promise.race([Promise.all([read(), p.exited]), deadline]);
        if (done) return gitOutput(args, p.exitCode, done[0]);
        killGroup(p.pid);
        return undefined;
    } catch {
        return undefined;
    } finally {
        clearTimeout(timer);
        if (stop) o.signal?.removeEventListener("abort", stop);
        untrack(p.pid);
        void reader.cancel().catch(() => undefined);
    }
}

/** Tracked and untracked-but-not-ignored files under `cwd`, relative to it; undefined outside a git work tree. */
export function gitListFiles(cwd: string): string[] | undefined {
    try {
        const r = spawnSync(gitArgv(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]), { cwd, stdout: "pipe", stderr: "ignore", timeout: 10_000, env: untrustedGitEnv() });
        if (r.exitCode !== 0) return undefined;
        return [...new Set(r.stdout.toString().split("\0").filter(Boolean))];
    } catch {
        return undefined;
    }
}

const rootCache = new Map<string, string | null>();

export function gitRoot(cwd: string): string | undefined {
    if (rootCache.has(cwd)) return rootCache.get(cwd) ?? undefined;
    const r = git(cwd, ["rev-parse", "--show-toplevel"]);
    rootCache.set(cwd, r ?? null);
    return r;
}

export interface GitSnapshot {
    branch?: string;
    mainBranch?: string;
    /** Absent when untrusted repository configuration could execute a program. */
    status?: string;
    statusSkipped?: string;
    recentCommits: string;
}

/** Branch discovery never reads working file contents or commit signatures. */
export function gitBranch(cwd: string): string | undefined {
    return git(cwd, ["branch", "--show-current"]) || undefined;
}

/**
 * Status refreshes working files through clean/process filters, consults fsmonitor,
 * recurses into submodules, and can run post-index-change hooks when writing the index.
 * https://git-scm.com/docs/gitattributes#_filter
 * https://git-scm.com/docs/git-config (core.fsmonitor, core.hooksPath, hook.*)
 * https://git-scm.com/docs/git-status (submodules and background refresh)
 * https://git-scm.com/docs/githooks#_post_index_change
 * Keep the hook checks even with optional index writes disabled, and ignore submodules
 * even without submodule.* keys: .gitmodules alone can introduce a hostile nested repo.
 */
const STATUS_EXEC_CONFIG = [/^filter\./, /^core\.(fsmonitor|hookspath)$/, /^submodule\./, /^hook\./, /^diff\.external$/, /^diff\..*\.(command|textconv)$/];
const USER_EXEC_CONFIG = [/^filter\..*\.(clean|smudge|process)$/, /^diff\..*\.(textconv|command)$/, /^diff\.external$/, /^core\.fsmonitor$/];

/** Shared by status and transport audits; includes retain their owning scope. */
async function repositoryConfigKeys(cwd: string, signal?: AbortSignal): Promise<string[] | undefined> {
    // Repository-owned settings and includes require trust regardless of value.
    // Resolve conditional includes with all scopes present, then retain repo keys.
    const [scoped, file] = await Promise.all([
        gitAsync(cwd, ["config", "--includes", "--show-scope", "--name-only", "--list", "-z"], { signal }),
        gitAsync(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "config.worktree"], { signal }),
    ]);
    if (scoped === undefined) return undefined;
    const names = scoped.split("\0");
    const keys: string[] = [];
    for (let i = 0; i < names.length - 1; i += 2) {
        if (names[i] === "local" || names[i] === "worktree") keys.push(names[i + 1]!);
    }
    if (!file) return undefined;
    let worktree = "";
    try {
        lstatSync(file);
        const keys = await gitAsync(cwd, ["config", "--file", file, "--includes", "--name-only", "--list", "-z"], { signal });
        if (keys === undefined) return undefined;
        worktree = keys;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    keys.push(...worktree.split("\0"));
    return keys;
}

/** Network transports can execute helpers or redirect traffic before any push. */
export async function gitNetworkSkipReason(cwd: string): Promise<string | undefined> {
    try {
        if (trustedByUser(cwd)) return undefined;
        const keys = await repositoryConfigKeys(cwd);
        if (!keys) return "repository configuration could not be checked";
        const key = keys.find((key) =>
            /^core\.(sshcommand|gitproxy|askpass|alternaterefscommand)$/.test(key)
            || /^(credential|http|https|ssh|protocol|url|gpg)\./.test(key)
            || /^push\.gpgsign$/.test(key)
            || /^remote\..*\.(uploadpack|receivepack|proxy|proxyauthmethod|vcs)$/.test(key)
            || /^(include|includeif)\./.test(key));
        // Subsections can contain URLs or credentials; never quote them here.
        if (key) return `repository ${key.split(".")[0]} transport configuration requires explicit user trust`;
        return await inheritedHelperReason(cwd);
    } catch {
        return "folder trust or repository configuration could not be checked";
    }
}

/** Settings that name a program git runs for a push or fetch (its transport, credentials, signing). */
const HELPER_CONFIG = "^(core\\.(sshcommand|gitproxy|askpass)|credential\\..*helper|gpg\\.(.*\\.)?program|gpg\\.ssh\\.defaultkeycommand|remote\\..*\\.(uploadpack|receivepack))$";
/** Variables that do the same, inherited by publishing's git calls (git-publish run()). */
const HELPER_VARS = ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_PROXY_COMMAND"];

/**
 * A helper the user's own settings name (global, system, command scope, the environment) may be an installed
 * program, but not one that names something of the repository's, by any path or as a file in cwd
 * (`sh ./payload.sh`, `sh payload.sh`, `sh /abs/repo/payload.sh`, a file in its git folder). Such a helper needs
 * explicit trust too, as does one whose shell syntax can't be read for sure (#107).
 */
async function inheritedHelperReason(cwd: string): Promise<string | undefined> {
    const env = gitEnv();
    // The worktree, and the git folders, which may be elsewhere (--separate-git-dir, a linked worktree's).
    const dirs = await gitAsync(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]);
    if (dirs === undefined) return "repository configuration could not be checked";
    const roots = [cwd, ...dirs.split("\n").map((d) => d.trim()).filter(Boolean)].map(realPath);
    // ~ and $HOME are what the shell git runs the helper with reads them as.
    const home = env.HOME || homedir();
    const namesRepoFile = (command: string, credential = false) => helperNamesRepoFile(cwd, roots, home, command, credential);
    const variable = HELPER_VARS.find((name) => env[name] && namesRepoFile(env[name]!));
    if (variable) return `inherited ${variable} names a file in this repository and requires explicit user trust`;
    const effective = await gitAsync(cwd, ["config", "--includes", "--show-scope", "-z", "--get-regexp", HELPER_CONFIG]);
    if (effective === undefined) return "repository configuration could not be checked";
    const fields = effective.split("\0");
    for (let i = 0; i < fields.length - 1; i += 2) {
        // The repository's own are refused whatever they say (gitNetworkSkipReason).
        if (fields[i] === "local" || fields[i] === "worktree") continue;
        // Git emits scope\0key\nvalue\0; values may themselves contain newlines.
        const entry = fields[i + 1]!;
        const newline = entry.indexOf("\n");
        const name = newline === -1 ? entry : entry.slice(0, newline);
        if (newline !== -1 && namesRepoFile(entry.slice(newline + 1), /^credential\./.test(name))) {
            // Only fixed section names enter the message; subsections may hold URLs.
            return `inherited ${name.startsWith("core.") ? name : name.split(".")[0]} configuration names a file in this repository and requires explicit user trust`;
        }
    }
    return undefined;
}

/** A word of a helper's shell command, and whether it began quoted (then a leading ~ is the word's own). */
type Word = { text: string; quoted: boolean };

/** What a helper's word may hold, quoted or not, for a shell to read it as nothing but the word's own characters. */
const PLAIN = /[A-Za-z0-9_@%+=:,./~-]/;

/**
 * A helper's shell command as words, `$HOME` read as the home folder; undefined for anything else this can't follow
 * for sure (syntax, other expansions, escapes, characters past plain ASCII, an open quote), which could read any
 * file. Words are split at spaces and tabs only, as a shell splits them. On Windows a backslash is a path's.
 */
function shellWords(command: string, home: string): Word[] | undefined {
    const words: Word[] = [];
    let word: Word | undefined;
    let quote: "'" | '"' | undefined;
    const plain = (c: string) => PLAIN.test(c) || (c === "\\" && process.platform === "win32");
    for (let i = 0; i < command.length; i++) {
        const c = command[i]!;
        const variable = quote !== "'" ? /^\$(HOME|\{HOME\})(?=[/"\s]|$)/.exec(command.slice(i)) : null;
        if (variable) {
            word ??= { text: "", quoted: quote === '"' };
            word.text += home;
            i += variable[0].length - 1;
        } else if (quote) {
            if (c === quote) quote = undefined;
            else if (plain(c) || c === " ") word!.text += c;
            else return undefined;
        } else if (c === "'" || c === '"') {
            quote = c;
            word ??= { text: "", quoted: true };
        } else if (c === " " || c === "\t") {
            if (word) words.push(word);
            word = undefined;
        } else if (plain(c)) {
            word ??= { text: "", quoted: false };
            word.text += c;
        } else return undefined;
    }
    if (quote) return undefined;
    if (word) words.push(word);
    return words;
}

/** A path's real place: its longest part that's there, with links followed as the system follows them, and the rest. */
function realPath(path: string): string {
    const rest: string[] = [];
    for (let p = resolve(path); ; p = dirname(p)) {
        try {
            return join(realpathSync(p), ...rest.reverse());
        } catch {
            if (dirname(p) === p) return resolve(path);
            rest.push(basename(p));
        }
    }
}

/**
 * Where an absolute path that's there really is, read as the system reads it: each link followed before a `..`
 * after it. Bun's realpath (the native one too) normalizes `..` first, and so can name another file.
 */
function systemPath(path: string, links = 0): string {
    const { root } = parse(path);
    let current = root;
    for (const part of path.slice(root.length).split(/[\\/]/)) {
        if (!part || part === ".") continue;
        if (part === "..") {
            current = dirname(current);
            continue;
        }
        const next = join(current, part);
        if (!lstatSync(next).isSymbolicLink()) {
            current = next;
            continue;
        }
        if (links > 40) throw new Error("too many links");
        const target = readlinkSync(next);
        current = systemPath(isAbsolute(target) ? target : `${current}${sep}${target}`, links + 1);
    }
    return current;
}

/**
 * Whether a helper command names something of the repository's (one of `roots`): the whole value, a word or a
 * word's `=` value that's there, read from cwd (with ~ and $HOME read as home), and really inside one of them,
 * links and `..` followed. Not the program when it's a bare name (looked up on PATH), nor a bare word that's a
 * folder (`gh auth`). A credential helper without `!` runs as `git credential-<its first word>`: that must be a
 * bare name. True for a command whose syntax can't be read for sure: it errs toward asking for trust.
 */
function helperNamesRepoFile(cwd: string, roots: string[], home: string, command: string, credential = false): boolean {
    const shell = command.trimStart().startsWith("!");
    const value = command.trim().replace(/^!/, "");
    const words = shellWords(value, home);
    if (!words) return true;
    const program = credential && !shell && words[0] && !isAbsolute(words[0].text);
    if (program && !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(words[0]!.text)) return true;
    const inside = (path: string) => {
        const real = systemPath(path);
        return roots.some((root) => {
            const rel = relative(root, real);
            return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
        });
    };
    // Not normalized first: `link/..` is where the link's target's parent is, as the system reads it.
    const there = (candidate: string, bare: boolean) => {
        const path = isAbsolute(candidate) ? candidate : `${cwd}${sep}${candidate}`;
        try {
            if (bare && !statSync(path).isFile()) return false;
            return inside(path);
        } catch {
            return false;
        }
    };
    const separated = (text: string) => text.includes("/") || (process.platform === "win32" && text.includes("\\"));
    if (value && there(value, !separated(value))) return true;
    return words.some((word, i) => [word.text, ...word.text.split("=").slice(1)].some((part, j) => {
        if (!part) return false;
        const tilde = !(word.quoted && j === 0) && (part === "~" || part.startsWith("~/"));
        const path = tilde ? join(home, part.slice(1)) : part;
        const bare = !tilde && !isAbsolute(path) && !separated(path);
        if (i === 0 && j === 0 && bare) return false;
        return there(path, bare);
    }));
}

async function statusSkipReason(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    const unreadable = "repository configuration could not be checked";
    const keys = await repositoryConfigKeys(cwd, signal);
    if (!keys) return unreadable;
    let key = keys.find((key) => STATUS_EXEC_CONFIG.some((pattern) => pattern.test(key)))
        ?? keys.find((key) => /^(include|includeif)\./.test(key));
    if (!key) {
        // User-owned scopes (including their includes) may use installed programs.
        // Only relative-path drivers can select programs controlled by this repo.
        const effective = await gitAsync(cwd, ["config", "--includes", "--show-scope", "-z", "--get-regexp", "^(filter|diff|core)\\."], { signal });
        if (effective === undefined) return unreadable;
        const fields = effective.split("\0");
        for (let i = 0; i < fields.length - 1; i += 2) {
            const scope = fields[i];
            if (scope === "local" || scope === "worktree") continue;
            if (scope !== "global" && scope !== "system" && scope !== "command") return unreadable;
            // Git emits scope\0key\nvalue\0; values may themselves contain newlines.
            const entry = fields[i + 1]!;
            const newline = entry.indexOf("\n");
            const name = newline === -1 ? entry : entry.slice(0, newline);
            const value = newline === -1 ? "" : entry.slice(newline + 1);
            if (USER_EXEC_CONFIG.some((pattern) => pattern.test(name))
                && (value.startsWith(".") || (value.includes("/") && !value.startsWith("/") && !value.startsWith("~")))) {
                key = name;
                break;
            }
        }
    }
    if (key) {
        // Only fixed section names enter the prompt; subsections and values may hold secrets.
        const section = key.startsWith("core.") ? key : key.split(".")[0];
        return `repository ${section} configuration requires user trust`;
    }
    return undefined;
}

/**
 * Point-in-time git info; untrusted folders only get status after repository config checks.
 * Its git calls run at once, side by side (status only once the checks have passed).
 */
export async function gitSnapshot(cwd: string, signal?: AbortSignal): Promise<GitSnapshot | undefined> {
    if (!gitRoot(cwd)) return undefined;
    const [branch, main, statusSkipped, recentCommits] = await Promise.all([
        gitAsync(cwd, ["branch", "--show-current"], { signal }).then((b) => b || undefined),
        mainBranch(cwd, signal),
        // Implicit session trust (no Harness configuration) says nothing about .git/config.
        (async () => {
            try {
                if (!trustedByUser(cwd)) return await statusSkipReason(cwd, signal);
            } catch {
                return "folder trust could not be checked";
            }
        })(),
        // Log has no diff output by default, so external diff/textconv drivers are unused.
        // Disable signature verification and lazy fetching (in git()) so gpg programs and
        // promisor transport/credential helpers cannot run (log.mailmap can fetch a
        // missing mailmap.blob even without diff output). Output is piped, never paged.
        // https://git-scm.com/docs/git-log (diff formatting, --show-signature)
        // https://git-scm.com/docs/git-config (log.showSignature, gpg.program, log.mailmap, mailmap.blob)
        // https://git-scm.com/docs/git (GIT_NO_LAZY_FETCH, --paginate)
        gitAsync(cwd, ["log", "--no-show-signature", "--oneline", "-n", "5"], { signal }).then((l) => l ?? ""),
    ]);
    if (statusSkipped) return { branch, mainBranch: main, statusSkipped, recentCommits };
    let status = (await gitAsync(cwd, ["status", "--short", "--ignore-submodules=all"], { signal })) ?? "";
    const lines = status.split("\n");
    if (lines.length > 40) status = [...lines.slice(0, 40), `… and ${lines.length - 40} more`].join("\n");
    return { branch, mainBranch: main, status: status || "(clean)", recentCommits };
}

/** What origin/HEAD points at; else master, else main, if there's one. */
async function mainBranch(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    const head = (await gitAsync(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { signal }))?.replace(/^origin\//, "");
    if (head) return head;
    const [main, master] = await Promise.all(["main", "master"].map((b) => gitAsync(cwd, ["rev-parse", "--verify", "--quiet", b], { signal })));
    return master !== undefined ? "master" : main !== undefined ? "main" : undefined;
}
