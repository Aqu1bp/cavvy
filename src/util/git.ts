import { spawnSync } from "bun";
import { lstatSync } from "fs";
import { delimiter, isAbsolute } from "path";
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

function git(cwd: string, args: string[], timeoutMs = 3000): string | undefined {
    try {
        // Config reads cannot run fsmonitor. Audit the original settings without
        // adding our own core.fsmonitor override to the list of configured keys.
        const argv = args[0] === "config" ? ["git", ...args] : gitArgv(args);
        const env = untrustedGitEnv();
        // GIT_CONFIG redirects only `git config`, not status. It must not hide
        // the effective settings that ordinary git commands will actually use.
        if (args[0] === "config") delete env.GIT_CONFIG;
        const r = spawnSync(argv, { cwd, stdout: "pipe", stderr: "ignore", timeout: timeoutMs, env });
        if (r.exitCode === 1 && args[0] === "config" && args.includes("--get-regexp")) return "";
        if (r.exitCode !== 0) return undefined;
        return r.stdout.toString().trimEnd();
    } catch {
        return undefined;
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
function repositoryConfigKeys(cwd: string): string[] | undefined {
    // Repository-owned settings and includes require trust regardless of value.
    // Resolve conditional includes with all scopes present, then retain repo keys.
    const scoped = git(cwd, ["config", "--includes", "--show-scope", "--name-only", "--list", "-z"]);
    if (scoped === undefined) return undefined;
    const names = scoped.split("\0");
    const keys: string[] = [];
    for (let i = 0; i < names.length - 1; i += 2) {
        if (names[i] === "local" || names[i] === "worktree") keys.push(names[i + 1]!);
    }
    const file = git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "config.worktree"]);
    if (!file) return undefined;
    let worktree = "";
    try {
        lstatSync(file);
        const keys = git(cwd, ["config", "--file", file, "--includes", "--name-only", "--list", "-z"]);
        if (keys === undefined) return undefined;
        worktree = keys;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    keys.push(...worktree.split("\0"));
    return keys;
}

/** Network transports can execute helpers or redirect traffic before any push. */
export function gitNetworkSkipReason(cwd: string): string | undefined {
    try {
        if (trustedByUser(cwd)) return undefined;
        const keys = repositoryConfigKeys(cwd);
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

function statusSkipReason(cwd: string): string | undefined {
    const unreadable = "repository configuration could not be checked";
    const keys = repositoryConfigKeys(cwd);
    if (!keys) return unreadable;
    let key = keys.find((key) => STATUS_EXEC_CONFIG.some((pattern) => pattern.test(key)))
        ?? keys.find((key) => /^(include|includeif)\./.test(key));
    if (!key) {
        // User-owned scopes (including their includes) may use installed programs.
        // Only relative-path drivers can select programs controlled by this repo.
        const effective = git(cwd, ["config", "--includes", "--show-scope", "-z", "--get-regexp", "^(filter|diff|core)\\."]);
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

/** Point-in-time git info; untrusted folders only get status after repository config checks. */
export function gitSnapshot(cwd: string): GitSnapshot | undefined {
    if (!gitRoot(cwd)) return undefined;
    const branch = gitBranch(cwd);
    let main = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.replace(/^origin\//, "");
    if (!main) {
        for (const b of ["main", "master"]) if (git(cwd, ["rev-parse", "--verify", "--quiet", b]) !== undefined) main = b;
    }
    // Implicit session trust (no Harness configuration) says nothing about .git/config.
    let statusSkipped: string | undefined;
    try {
        if (!trustedByUser(cwd)) statusSkipped = statusSkipReason(cwd);
    } catch {
        statusSkipped = "folder trust could not be checked";
    }
    // Log has no diff output by default, so external diff/textconv drivers are unused.
    // Disable signature verification and lazy fetching (in git()) so gpg programs and
    // promisor transport/credential helpers cannot run (log.mailmap can fetch a
    // missing mailmap.blob even without diff output). Output is piped, never paged.
    // https://git-scm.com/docs/git-log (diff formatting, --show-signature)
    // https://git-scm.com/docs/git-config (log.showSignature, gpg.program, log.mailmap, mailmap.blob)
    // https://git-scm.com/docs/git (GIT_NO_LAZY_FETCH, --paginate)
    const recentCommits = git(cwd, ["log", "--no-show-signature", "--oneline", "-n", "5"]) ?? "";
    if (statusSkipped) return { branch, mainBranch: main, statusSkipped, recentCommits };
    let status = git(cwd, ["status", "--short", "--ignore-submodules=all"]) ?? "";
    const lines = status.split("\n");
    if (lines.length > 40) status = [...lines.slice(0, 40), `… and ${lines.length - 40} more`].join("\n");
    return { branch, mainBranch: main, status: status || "(clean)", recentCommits };
}
