import { spawnSync } from "bun";
import { lstatSync } from "fs";
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

function git(cwd: string, args: string[], timeoutMs = 3000): string | undefined {
    try {
        const r = spawnSync(gitArgv(args), { cwd, stdout: "pipe", stderr: "ignore", timeout: timeoutMs, env: { ...gitEnv(), GIT_NO_LAZY_FETCH: "1" } });
        if (r.exitCode !== 0) return undefined;
        return r.stdout.toString().trimEnd();
    } catch {
        return undefined;
    }
}

/** Tracked and untracked-but-not-ignored files under `cwd`, relative to it; undefined outside a git work tree. */
export function gitListFiles(cwd: string): string[] | undefined {
    try {
        const r = spawnSync(gitArgv(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]), { cwd, stdout: "pipe", stderr: "ignore", timeout: 10_000, env: gitEnv() });
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
const STATUS_EXEC_CONFIG = [/^filter\./, /^core\.fsmonitor$/, /^submodule\./, /^core\.hookspath$/, /^hook\./];

function statusSkipReason(cwd: string): string | undefined {
    const unreadable = "repository configuration could not be checked";
    const local = git(cwd, ["config", "--local", "--includes", "--name-only", "--list", "-z"]);
    if (local === undefined) return unreadable;
    const file = git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "config.worktree"]);
    if (!file) return unreadable;
    let worktree = "";
    try {
        lstatSync(file);
        const keys = git(cwd, ["config", "--file", file, "--includes", "--name-only", "--list", "-z"]);
        if (keys === undefined) return unreadable;
        worktree = keys;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return unreadable;
    }
    const keys = [...local.split("\0"), ...worktree.split("\0")];
    if (keys.some((key) => key.startsWith("includeif."))) {
        // hasconfig conditions can depend on another scope (e.g. a worktree include
        // selected by a local remote URL). Resolve those with the complete config,
        // but only count repository-owned keys. See git-config's Conditional includes.
        const scoped = git(cwd, ["config", "--includes", "--show-scope", "--name-only", "--list", "-z"]);
        if (scoped === undefined) return unreadable;
        const fields = scoped.split("\0");
        for (let i = 0; i < fields.length - 1; i += 2) {
            if (fields[i] === "local" || fields[i] === "worktree") keys.push(fields[i + 1]!);
        }
    }
    const key = keys.find((key) => STATUS_EXEC_CONFIG.some((pattern) => pattern.test(key)));
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
