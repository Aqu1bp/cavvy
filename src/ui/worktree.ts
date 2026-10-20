// `harness --worktree [name]`: start the session in a worktree of its own,
// and on exit remove it when nothing was done there, or ask, or keep it.
// The Git side is src/server/worktrees.ts (shared with the GUI); this is the
// terminal side: the questions, and what's printed.

import { homedir } from "os";
import { relative, sep } from "path";
import { APP_NAME } from "../config/paths";
import { forgetTrustInside, projectConfigSummary, trustFolder } from "../config/trust";
import { askOnce } from "./ask";
import type { CleanupMode, SessionWorktree, WorktreeMarker, WorktreeWork } from "../server/worktrees";
import { enterSessionWorktree, isPristine, readMarker, removeSessionWorktree, worktreeWork, type BaseRef } from "../server/worktrees";
import { RpcError } from "../server/rpc-error";
import { heldSessionFolders } from "../agent/session";
import { isInside } from "../util/files";
import { redact } from "../util/redact";
import { bold, theme } from "./ansi";
import type { SelectItem } from "./components";


/** `.claude/worktrees/x` rather than the whole path. */
export function shortPath(wt: { main: string; path: string }): string {
    const rel = relative(wt.main, wt.path);
    return rel && !rel.startsWith("..") ? rel : wt.path;
}

/** ~/code/x rather than /Users/me/code/x. */
function tildePath(path: string): string {
    const home = homedir();
    return home && home !== "/" && isInside(path, home) && path !== home ? `~${sep}${relative(home, path)}` : path;
}

/** The welcome box's line: where, on which branch, from what. */
export function worktreeLine(wt: SessionWorktree): string {
    // The cwd line above it has the path.
    const where = `${wt.name}${wt.branch ? ` · branch ${wt.branch}` : " · detached HEAD"}`;
    if (!wt.created) return `worktree: ${where} (reopened)`;
    if (wt.fromBranch) return `worktree: ${where} (back on its kept branch)`;
    return `worktree: ${where}${wt.baseLabel ? ` · from ${wt.baseLabel}` : ""}`;
}

/** The command that comes back to this worktree. */
export function resumeCommand(name: string): string {
    return `${APP_NAME} -w ${name}`;
}

/**
 * The worktree the session runs in, made or reopened. When the repository's
 * Git config needs trust first, asks (interactive) or says how. Throws an
 * Error whose message is for the user.
 */
export async function startWorktree(o: { cwd: string; name?: string; branchPrefix: string; baseRef: BaseRef; interactive: boolean }): Promise<SessionWorktree> {
    const enter = () => enterSessionWorktree({ cwd: o.cwd, name: o.name, branchPrefix: o.branchPrefix, baseRef: o.baseRef });
    try {
        return await enter();
    } catch (e) {
        if (!(e instanceof RpcError) || e.code !== "needs_trust" || !e.folder) throw e;
        if (!o.interactive) throw new Error(`${e.message} Run ${APP_NAME} --worktree interactively once to trust it.`);
        const v = await askOnce<"yes" | "no">({
            title: "Trust this repository's Git configuration?",
            header: [
                bold(e.folder),
                "",
                e.message,
                theme.muted("Git runs those settings while it checks files out into the new worktree."),
                ...trustAlso(e.folder),
            ],
            items: [
                { label: "Yes, trust this folder and create the worktree", value: "yes" },
                { label: "No, exit", value: "no" },
            ],
            color: theme.warning,
        });
        if (v !== "yes") throw new Error("No worktree was created.");
        trustFolder(e.folder);
        return await enter();
    }
}

/** What else trusting a folder turns on, when it has project configuration. */
function trustAlso(folder: string): string[] {
    const found = projectConfigSummary(folder);
    return found.length ? [theme.muted(`Trusting it also turns on its project configuration (${found.join(", ")}), which can run hooks and MCP servers.`)] : [];
}

export type Ending =
    | { kind: "removed"; branchDeleted: boolean }
    | { kind: "kept"; why?: string };

/** Asks one question with these choices (the TUI's own dialog); undefined when dismissed. */
export type Ask = (o: { title: string; header: string[]; items: SelectItem<"keep" | "remove">[] }) => Promise<"keep" | "remove" | undefined>;

/** Why a worktree is kept, in a few words, from what's in it. */
function workWords(w: WorktreeWork, branch: string): string[] {
    const out: string[] = [];
    if (w.changes) out.push(`${w.changes} uncommitted ${w.changes === 1 ? "change" : "changes"}`);
    if (w.commits) out.push(`${w.commits} ${w.commits === 1 ? "commit" : "commits"} on ${branch}`);
    else if (!w.atBase) out.push("HEAD moved off its starting commit");
    if (w.ignoredTotal) out.push(`${w.ignoredTotal} ignored ${w.ignoredTotal === 1 ? "file or folder" : "files or folders"}`);
    return out;
}

/**
 * What becomes of the worktree as the session ends, decided (and asked, when
 * `ask` is given) while the TUI still runs; `finish` then does it, once the
 * session's shells are gone. Without `ask` (a signal, nobody at the keyboard)
 * only what needs no question happens. Uncommitted or untracked work always
 * keeps it, whatever the setting, and Git checks that again as it removes.
 */
export async function decideWorktree(wt: SessionWorktree, o: { cleanup: CleanupMode; ask?: Ask; marker?: WorktreeMarker }): Promise<() => Promise<Ending>> {
    const kept = (why?: string) => async (): Promise<Ending> => ({ kind: "kept", why });
    const marker = o.marker ?? readMarker(wt.path);
    if (!marker) return kept(`${APP_NAME} didn't create it`);
    if (o.cleanup === "keep") return kept();
    let found;
    try {
        // Another process's session in it keeps it; this one's own lock doesn't count.
        const held = heldSessionFolders();
        found = await worktreeWork({ main: wt.main, path: wt.path, marker, inUse: (dir) => held.some((h) => isInside(h, dir)) });
    } catch (e) {
        return kept(clean(e));
    }
    const { plan, work } = found;
    const remove = async (): Promise<Ending> => {
        try {
            const r = await removeSessionWorktree({ plan, marker, work });
            if (r.removed) {
                try {
                    forgetTrustInside(wt.path);
                } catch {
                    // A trust list that can't be read now is left alone.
                }
            }
            return r.removed ? { kind: "removed", branchDeleted: r.branchDeleted } : { kind: "kept", why: "its ignored files changed meanwhile" };
        } catch (e) {
            return { kind: "kept", why: clean(e) };
        }
    };
    if (work.changes) return kept(workWords(work, marker.branch).join(", "));
    const pristine = isPristine(work);
    if (pristine && o.cleanup === "auto") return remove;
    if (!o.ask) return kept(pristine ? undefined : workWords(work, marker.branch).join(", "));

    const header = [bold(shortPath(wt)) + theme.muted(` · branch ${marker.branch}`), ""];
    const words = workWords(work, marker.branch);
    header.push(words.length ? `It has ${words.join(" and ")}.` : "Nothing was changed in it.");
    if (work.ignoredTotal) {
        const more = work.ignoredTotal - work.ignored.length;
        header.push(theme.muted(`Removing it deletes ${work.ignored.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`));
    }
    // Commits of its own, a moved HEAD, or a branch it came back to: the branch stays.
    const keepsBranch = work.commits > 0 || !work.atBase || marker.ownBranch === false;
    const v = await o.ask({
        title: "Keep this worktree?",
        header,
        items: [
            { label: "Keep it", value: "keep", description: "nothing is deleted" },
            keepsBranch
                ? { label: `Remove the worktree, keep branch ${marker.branch}`, value: "remove", description: work.commits ? "its commits stay on the branch" : undefined }
                : { label: `Remove the worktree and branch ${marker.branch}`, value: "remove" },
        ],
    });
    return v === "remove" ? remove : kept();
}

const clean = (e: unknown) => redact((e as Error).message).replace(/\.$/, "");

/** The lines printed for an ending. */
export function endingLines(wt: SessionWorktree, end: Ending): string[] {
    const branch = wt.branch;
    if (end.kind === "removed") {
        return [theme.muted(`Removed worktree ${shortPath(wt)}${end.branchDeleted ? ` and branch ${branch}` : branch ? `; branch ${branch} is kept` : ""}.`)];
    }
    return [
        `Worktree ${bold(wt.name)} kept${end.why ? ` (${end.why})` : ""}${branch ? `, on branch ${branch}` : ""}`,
        theme.muted(`  at ${tildePath(wt.path)}`),
        // Sessions are found by folder: --continue finds this one from the same subfolder it started in.
        theme.muted(`  come back with: ${resumeCommand(wt.name)} --continue${wt.cwd !== wt.path ? ` (from ${relative(wt.path, wt.cwd)})` : ""}`),
    ];
}
