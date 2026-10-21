// The worktrees a session's diff reader can look at: those of the repository
// the session's folder is in, as `git worktree list` reports them, and no other
// folder. Read-only: Git only lists and counts commits here, so nothing from
// the repository's config runs (see git-changes.ts).

import { realpathSync } from "fs";
import { resolve } from "path";
import { defaultBase, git } from "./git-changes";
import type { SessionWorktreeInfo, WorktreeInfo } from "./protocol";
import { RpcError } from "./rpc-error";
import { listWorktrees } from "./worktrees";

/** Worktrees whose lead and last commit are looked up (each is a git call or two); the rest are listed bare. */
const MAX_DETAILED = 60;
/** Git calls at once. */
const PARALLEL = 6;

function canonical(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

function listed(cwd: string): WorktreeInfo[] {
    try {
        return listWorktrees(cwd);
    } catch {
        return [];
    }
}

/**
 * The worktree `wanted` names, if it's one of the repository `cwd` is in and
 * is there to read; otherwise an error. Compared once symlinks are resolved,
 * and what comes back is Git's own record, never the path as asked.
 */
export function sessionWorktree(cwd: string, wanted: string): WorktreeInfo {
    const want = canonical(resolve(cwd, wanted));
    const record = listed(cwd).find((w) => canonical(w.path) === want);
    if (!record) throw new RpcError(`${wanted} isn't one of this repository's worktrees.`, "not_found");
    if (!record.exists || record.prunable !== undefined) throw new RpcError(`The worktree ${wanted} is missing.`, "not_found");
    return record;
}

/** The repository's worktrees, each with how far its HEAD is ahead of the main branch and when it was committed. */
export async function sessionWorktrees(cwd: string): Promise<SessionWorktreeInfo[]> {
    const all = listed(cwd);
    const own = all.find((w) => w.current) ?? all.find((w) => w.main);
    if (!own) return all;
    let base: Awaited<ReturnType<typeof defaultBase>>;
    try {
        base = await defaultBase(own.path);
    } catch {
        base = undefined;
    }
    const out: SessionWorktreeInfo[] = all.map((w) => ({ ...w }));
    const todo = out.filter((w) => w.exists && w.head && /^[0-9a-f]{40,64}$/.test(w.head)).slice(0, MAX_DETAILED);
    let next = 0;
    const work = async () => {
        while (next < todo.length) {
            const w = todo[next++]!;
            try {
                const [ahead, when] = await Promise.all([
                    base ? git(own.path, ["rev-list", "--count", `${base.ref}..${w.head}`, "--"]) : undefined,
                    // The commit object itself: nothing to format, so no signature check or other program.
                    git(own.path, ["cat-file", "commit", w.head!]),
                ]);
                if (base && ahead?.code === 0) {
                    const n = Number(ahead.out.toString().trim());
                    if (Number.isSafeInteger(n)) {
                        w.base = base.name;
                        w.ahead = n;
                    }
                }
                const t = when.code === 0 ? committerTime(when.out.toString("utf-8")) : undefined;
                if (t) w.committedAt = t;
            } catch {
                // Too slow or unreadable: listed without them.
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, work));
    return out;
}

/** A commit object's committer time, in ms. */
export function committerTime(commit: string): number | undefined {
    const header = commit.slice(0, commit.indexOf("\n\n") >>> 0);
    const m = /^committer .* (\d+) [+-]\d{4}$/m.exec(header);
    const t = m ? Number(m[1]) : NaN;
    return Number.isSafeInteger(t) && t > 0 ? t * 1000 : undefined;
}
