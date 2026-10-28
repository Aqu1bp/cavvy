// The worktrees a session's diff reader can look at: those of the repository
// the session's folder is in, as `git worktree list` reports them, and no other
// folder. Read-only: Git only lists and counts commits here, so nothing from
// the repository's config runs (see git-changes.ts).

import { readFileSync, realpathSync } from "fs";
import { basename, dirname, join, resolve, sep } from "path";
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

/** A Git dir as `git rev-parse` names it, with links resolved; undefined when git can't say. */
async function gitDir(cwd: string, flags: string[]): Promise<string | undefined> {
    try {
        const r = await git(cwd, ["rev-parse", ...flags]);
        const out = r.out.toString("utf-8").replace(/\n$/, "");
        return r.code === 0 && out ? canonical(out) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The worktree `wanted` names, if it's one of the repository `cwd` is in and is there to read;
 * otherwise an error. Compared once symlinks are resolved. Git's record alone isn't enough: a
 * locked worktree stays registered whatever its folder becomes (a link to another repository,
 * say), so the folder must also be that worktree to Git: its common Git dir the session's, and
 * its own Git dir the common dir (the main worktree) or the entry in <common>/worktrees/ that
 * names this folder; and the work tree Git uses there that folder (core.worktree, in the
 * worktree's config or the repository's, can move it). What comes back is the folder checked,
 * links resolved, and its Git dir, so a read can be pinned to them (gitChanges' `pin`).
 */
export async function sessionWorktree(cwd: string, wanted: string): Promise<WorktreeInfo & { real: string; gitDir: string }> {
    const asked = resolve(cwd, wanted);
    const want = canonical(asked);
    const all = listed(cwd);
    // The worktree named as git lists it, if it is; else (a link to one) the one it leads to.
    const record = all.find((w) => w.path === asked) ?? all.find((w) => canonical(w.path) === want);
    const missing = () => new RpcError(`The worktree ${wanted} is missing.`, "not_found");
    if (!record) throw new RpcError(`${wanted} isn't one of this repository's worktrees.`, "not_found");
    if (!record.exists || record.prunable !== undefined) throw missing();
    const [expected, common, own, top] = await Promise.all([
        gitDir(cwd, ["--path-format=absolute", "--git-common-dir"]),
        gitDir(want, ["--path-format=absolute", "--git-common-dir"]),
        gitDir(want, ["--absolute-git-dir"]),
        gitDir(want, ["--show-toplevel"]),
    ]);
    if (!expected || common !== expected || !own || top !== want) throw missing();
    // Git lists a linked worktree's folder from its entry's gitdir file: the entry found in the folder must be that one.
    if (record.main ? own !== expected : dirname(own) !== join(expected, "worktrees") || !sameFolder(backLink(own), record.path)) throw missing();
    return { ...record, real: want, gitDir: own };
}

/** The folder a linked worktree's entry in <common>/worktrees/ names (its gitdir file holds <folder>/.git). */
function backLink(entry: string): string | undefined {
    try {
        const file = readFileSync(join(entry, "gitdir"), "utf-8").replace(/\r?\n$/, "");
        // A relative one counts from the entry as it really is (`entry` has its links resolved), as git takes it.
        return file ? dirname(resolve(entry, file)) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The same folder, by its parent's real path and its own name: a gitdir file can name it through a
 * linked folder (git lists the real one) and with the platform's separators, but a folder that is
 * itself a link (to another worktree, say) isn't the folder it leads to.
 */
export function sameFolder(a: string | undefined, b: string): boolean {
    const place = (p: string) => {
        const full = resolve(p);
        return join(canonical(dirname(full)), basename(full));
    };
    return a !== undefined && place(a) === place(b);
}

/**
 * The other worktree of the repository `cwd` is in that the agent works in when it's in `folder`: the innermost one git
 * lists that holds it (a worktree under .claude/worktrees is inside the main checkout's folder). Undefined when that's the
 * session's own worktree, when the folder is in none of them (outside the repository) or is gone, or when git can't say.
 */
export function workingWorktree(cwd: string, folder: string): WorktreeInfo | undefined {
    const at = canonical(folder);
    const holds = (w: WorktreeInfo) => {
        const dir = canonical(w.path);
        return at === dir || at.startsWith(dir.endsWith(sep) ? dir : dir + sep);
    };
    const inner = listed(cwd).filter((w) => w.exists && w.prunable === undefined && holds(w)).sort((a, b) => canonical(b.path).length - canonical(a.path).length)[0];
    return inner && !inner.current ? inner : undefined;
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
