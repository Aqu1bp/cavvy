import { spawnSync } from "bun";
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
        const r = spawnSync(gitArgv(args), { cwd, stdout: "pipe", stderr: "ignore", timeout: timeoutMs, env: gitEnv() });
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
    /** Absent until the user trusts the folder. */
    status?: string;
    recentCommits: string;
}

/** Branch discovery never reads working file contents or commit signatures. */
export function gitBranch(cwd: string): string | undefined {
    return git(cwd, ["branch", "--show-current"]) || undefined;
}

/** Point-in-time git info for the system prompt; content reads require explicit user trust. */
export function gitSnapshot(cwd: string): GitSnapshot | undefined {
    if (!gitRoot(cwd)) return undefined;
    const branch = gitBranch(cwd);
    let main = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.replace(/^origin\//, "");
    if (!main) {
        for (const b of ["main", "master"]) if (git(cwd, ["rev-parse", "--verify", "--quiet", b]) !== undefined) main = b;
    }
    // Implicit session trust (no Harness configuration) says nothing about .git/config.
    let trusted = false;
    try { trusted = trustedByUser(cwd); } catch { /* A failed trust check must not run repository programs. */ }
    if (!trusted) return { branch, mainBranch: main, recentCommits: "" };
    let status = git(cwd, ["status", "--short"]) ?? "";
    const lines = status.split("\n");
    if (lines.length > 40) status = [...lines.slice(0, 40), `… and ${lines.length - 40} more`].join("\n");
    const recentCommits = git(cwd, ["log", "--no-show-signature", "--oneline", "-n", "5"]) ?? "";
    return { branch, mainBranch: main, status: status || "(clean)", recentCommits };
}
