import { spawnSync } from "bun";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "fs";
import { delimiter, dirname, isAbsolute, join } from "path";
import { childEnv } from "./env";
import { trustedByUser } from "../config/trust";

/**
 * argv for Cavvy's own git calls. These run in whatever repository the
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
    return { ...env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "cavvy-none" };
}

/** The command and environment a Cavvy git call runs with. */
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
 * The process groups of async git calls still running. Out of Cavvy's own group, they'd miss the
 * terminal's Ctrl-C and outlive their deadline should Cavvy end first: they're killed with it.
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

const mine = (path: string) => statSync(path).uid === process.getuid?.();

/** A file of ours and of a size HEAD could be, or nothing. Opened so that neither a pipe (it would hang) nor a link gets further. */
function readSmall(path: string): string | undefined {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.size > 4096 || st.uid !== process.getuid?.()) return undefined;
        const bytes = Buffer.alloc(4097);
        const n = readSync(fd, bytes, 0, bytes.length, 0);
        return n > 4096 ? undefined : bytes.toString("utf8", 0, n);
    } finally {
        closeSync(fd);
    }
}

/**
 * What `git branch --show-current` says, from the HEAD file: this runs on the server's thread, and a process would stop
 * every session until it returned. "" when HEAD is detached; undefined whenever it takes git to say, as anything not plain
 * does: a reftable repository (its HEAD names nothing), a bare one, a stop to the search, a mount on the way up.
 */
function headBranch(cwd: string): string | undefined {
    if (process.env.GIT_CEILING_DIRECTORIES !== undefined || process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM !== undefined) return undefined;
    try {
        let dir = realpathSync(cwd);
        const device = lstatSync(dir).dev;
        let dot = lstatSync(join(dir, ".git"), { throwIfNoEntry: false });
        while (!dot) {
            // Inside a repository's own folder.
            if (existsSync(join(dir, "HEAD")) || dir === dirname(dir)) return undefined;
            dir = dirname(dir);
            dot = lstatSync(join(dir, ".git"), { throwIfNoEntry: false });
        }
        if (lstatSync(dir).dev !== device) return undefined;
        let gitDir = join(dir, ".git");
        if (dot.isFile()) {
            const pointer = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readSmall(gitDir) ?? "")?.[1];
            if (!pointer) return undefined;
            // As written: normalized, a `..` after a link would be somewhere else.
            gitDir = isAbsolute(pointer) ? pointer : `${dir}/${pointer}`;
        } else if (!dot.isDirectory()) return undefined;
        // Someone else's repository: git decides, and may refuse it.
        if (!mine(dir) || !mine(gitDir)) return undefined;
        if (!existsSync(`${gitDir}/commondir`) && !(existsSync(`${gitDir}/objects`) && existsSync(`${gitDir}/refs`))) return undefined;
        const head = readSmall(`${gitDir}/HEAD`);
        if (head === undefined) return undefined;
        if (/^([0-9a-f]{40}|[0-9a-f]{64})\n$/.test(head)) return "";
        const name = /^ref: refs\/heads\/(\S+)\n$/.exec(head)?.[1];
        const plain = name && !name.includes("..") && name.split("/").every((part) => /^\w[\w.+-]*$/.test(part) && !part.endsWith(".") && !part.endsWith(".lock"));
        return plain ? name : undefined;
    } catch {
        return undefined;
    }
}

/** Branch discovery never reads working file contents or commit signatures. */
export function gitBranch(cwd: string): string | undefined {
    return (headBranch(cwd) ?? git(cwd, ["branch", "--show-current"])) || undefined;
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
    } catch {
        return "folder trust or repository configuration could not be checked";
    }
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
        Promise.resolve(headBranch(cwd) ?? gitAsync(cwd, ["branch", "--show-current"], { signal })).then((b) => b || undefined),
        mainBranch(cwd, signal),
        // Implicit session trust (no Cavvy configuration) says nothing about .git/config.
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
    const out = await gitAsync(cwd, ["for-each-ref", "--format=%(refname) %(symref)", "refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master"], { signal });
    const refs = new Map((out ?? "").split("\n").map((line) => line.split(" ") as [string, string]));
    const head = refs.get("refs/remotes/origin/HEAD")?.replace(/^refs\/remotes\/(origin\/)?/, "");
    if (head) return head;
    return refs.has("refs/heads/master") ? "master" : refs.has("refs/heads/main") ? "main" : undefined;
}
