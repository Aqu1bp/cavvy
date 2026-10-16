import { spawnSync } from "bun";
import { realpathSync, statSync } from "fs";
import { gitArgv, gitEnv } from "../util/git";
import type { WorktreeInfo } from "./protocol";

type WorktreeRecord = Omit<WorktreeInfo, "current" | "exists"> & { bare: boolean };

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

/** Read-only discovery; never checks out branches or runs repository configuration. */
export function listWorktrees(cwd: string): WorktreeInfo[] {
    const output = runGit(cwd, ["worktree", "list", "--porcelain", "-z"]);
    if (output === undefined) throw new Error("Could not list this project's Git worktrees.");
    // Remove only Git's line terminator: a working directory itself can end in a newline.
    const root = runGit(cwd, ["rev-parse", "--show-toplevel"])?.replace(/\n$/, "");
    const current = root ? canonical(root) : undefined;
    return parseWorktrees(output).filter((record) => !record.bare).map(({ bare: _bare, ...record }) => {
        let exists = false;
        try { exists = statSync(record.path).isDirectory(); } catch { /* A deleted worktree remains registered until pruned. */ }
        return { ...record, exists, current: canonical(record.path) === current };
    });
}
