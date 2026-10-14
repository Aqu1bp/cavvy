import { spawnSync } from "bun";
import { childEnv } from "./env";

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
    status: string;
    recentCommits: string;
}

/** Point-in-time git info for the system prompt. */
export function gitSnapshot(cwd: string): GitSnapshot | undefined {
    if (!gitRoot(cwd)) return undefined;
    const branch = git(cwd, ["branch", "--show-current"]) || undefined;
    let main = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.replace(/^origin\//, "");
    if (!main) {
        for (const b of ["main", "master"]) if (git(cwd, ["rev-parse", "--verify", "--quiet", b]) !== undefined) main = b;
    }
    let status = git(cwd, ["status", "--short"]) ?? "";
    const lines = status.split("\n");
    if (lines.length > 40) status = [...lines.slice(0, 40), `… and ${lines.length - 40} more`].join("\n");
    const recentCommits = git(cwd, ["log", "--oneline", "-n", "5"]) ?? "";
    return { branch, mainBranch: main, status: status || "(clean)", recentCommits };
}
