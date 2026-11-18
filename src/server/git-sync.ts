// A branch and its upstream: ahead/behind from local refs, fetch and fast-forward pull on the user's click, the
// branches to switch to, switching and creating one. Network calls go through git-publish's rules (runGit with
// `network`: the folder's network trust, URL rewrites refused, run away from the work tree, output redacted).
import { redact } from "../util/redact";
import { headBranch } from "../util/git";
import type { GitBranchList, GitPullResult, GitSyncInfo } from "./protocol";
import { cleanGitText, remoteUrl, runGit } from "./git-publish";
import { RpcError } from "./rpc-error";

const fail = (message: string, code = "git") => new RpcError(cleanGitText(message, 600), code);

/** A local git call (publishing's rules: no hooks, no lazy fetch, no transport); its output, or "" when `optional` and it failed. */
async function git(cwd: string, args: string[], signal?: AbortSignal, optional = false): Promise<string> {
    const r = await runGit(cwd, args, false, signal);
    if (r.code) {
        if (optional) return "";
        throw fail(gitReason(r.err + r.out) || "Git command failed.");
    }
    return r.out.trimEnd();
}

/** The top of the work tree `cwd` is in. */
export async function worktreeTop(cwd: string, signal?: AbortSignal): Promise<string> {
    const top = await git(cwd, ["rev-parse", "--show-toplevel"], signal, true);
    if (!top) throw new RpcError("This folder isn't in a Git repository.", "not_git");
    return top;
}

/**
 * Git's refusal, briefly: which files are in the way and what to do, or its first line that says something.
 * "error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\n…" becomes
 * "Uncommitted changes to a.txt would be overwritten. Commit or stash them first."
 */
export function gitReason(text: string): string {
    const lines = text.split("\n").map((l) => l.trimEnd());
    const files = (from: number) => {
        const list: string[] = [];
        for (let i = from + 1; i < lines.length && /^\s/.test(lines[i]!); i++) list.push(lines[i]!.trim());
        return list.length > 3 ? `${list.slice(0, 3).join(", ")} and ${list.length - 3} more` : list.join(", ");
    };
    const local = lines.findIndex((l) => /local changes to the following files would be overwritten/.test(l));
    if (local >= 0) return `Uncommitted changes to ${files(local) || "some files"} would be overwritten. Commit or stash them first.`;
    const untracked = lines.findIndex((l) => /untracked working tree files would be (overwritten|removed)/.test(l));
    if (untracked >= 0) return `Untracked ${files(untracked) || "files"} would be overwritten. Move or remove them first.`;
    const said = lines.map((l) => l.replace(/^(error|fatal|warning): /, "").trim()).filter((l) => l && !/^(hint:|Aborting$|Updating [0-9a-f]+\.\.[0-9a-f]+$)/.test(l));
    return (said[0] ?? "").slice(0, 300);
}

/** Ahead/behind of the upstream, from what was last fetched: `git for-each-ref`'s own count, no network. */
export async function gitSyncInfo(cwd: string, signal?: AbortSignal): Promise<GitSyncInfo> {
    // The title bar asks this as turns end: the branch comes from the HEAD file where that says it, so it's one git, not two.
    const branch = headBranch(cwd) ?? (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal, true));
    if (!branch) return { detached: true };
    // The branch's own ref, exactly: a pattern names it and what's under it, which a branch of that name can't have.
    const line = await git(cwd, ["for-each-ref", "--format=%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)", `refs/heads/${branch}`], signal, true);
    const fields = line.split("\n").map((l) => l.split("\0")).find((f) => f[0] === `refs/heads/${branch}`);
    const info: GitSyncInfo = { detached: false, branch: redact(branch) };
    if (!fields?.[1]) return info;
    info.upstream = redact(fields[1]);
    const track = fields[2] ?? "";
    if (track === "gone") return { ...info, gone: true };
    info.ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0);
    info.behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0);
    return info;
}

/** The current branch, its upstream's remote and tracking ref, for fetch and pull. */
async function upstreamOf(cwd: string, signal?: AbortSignal) {
    const branch = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal, true);
    const [remote, tracking, remotes] = await Promise.all([
        branch ? git(cwd, ["config", "--get", `branch.${branch}.remote`], signal, true) : "",
        branch ? git(cwd, ["rev-parse", "--symbolic-full-name", "@{upstream}"], signal, true) : "",
        git(cwd, ["remote"], signal, true),
    ]);
    return { branch, remote, tracking, remotes: remotes.split("\n").filter(Boolean) };
}

/** The remote a fetch reads: the branch's upstream's, else origin, else the only one. */
function fetchRemote(u: { remote: string; remotes: string[] }): string {
    if (u.remote && u.remote !== ".") return u.remote;
    if (u.remotes.includes("origin")) return "origin";
    if (u.remotes.length === 1) return u.remotes[0]!;
    throw fail(u.remotes.length ? "Set an upstream for this branch to choose which remote to fetch." : "This repository has no remote.", "no_remote");
}

/**
 * `git fetch` of one remote, to the URL checked as publishing checks it (rewrites refused), with the remote's own
 * fetch refspecs: its remote-tracking branches move as `git fetch <remote>` would move them. No submodules.
 */
async function fetchFrom(cwd: string, remote: string, signal?: AbortSignal) {
    const [url, specs] = await Promise.all([
        remoteUrl(cwd, remote, false, signal),
        git(cwd, ["config", "--get-all", `remote.${remote}.fetch`], signal, true),
    ]);
    const refspecs = specs.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!refspecs.length) throw fail(`The remote ${remote} has nothing set to fetch.`, "invalid");
    if (refspecs.some((s) => s.startsWith("-") || /[\x00-\x20\x7f]/.test(s))) throw fail(`The remote ${remote} has a fetch setting Cavvy can't use.`, "invalid");
    const r = await runGit(cwd, ["-c", "fetch.recurseSubmodules=false", "-c", "submodule.recurse=false", "fetch", "--no-recurse-submodules", "--", url, ...refspecs], true, signal);
    if (r.code) throw fail(`Couldn't fetch ${remote}. ${gitReason(r.err + r.out)}`, "fetch_failed");
}

/** Fetch the current branch's remote (or origin); the counts after. */
export async function gitFetch(cwd: string, signal?: AbortSignal): Promise<GitSyncInfo & { remote: string }> {
    const u = await upstreamOf(cwd, signal);
    const remote = fetchRemote(u);
    await fetchFrom(cwd, remote, signal);
    return { ...(await gitSyncInfo(cwd, signal)), remote: redact(remote) };
}

/**
 * Fetch, then fast-forward the branch to its upstream, and only that: diverged (commits on both sides) is said, and
 * nothing is changed. Git refuses a fast-forward that would overwrite uncommitted changes; its reason is said.
 */
export async function gitPull(cwd: string, signal?: AbortSignal): Promise<GitPullResult> {
    const u = await upstreamOf(cwd, signal);
    if (!u.branch) throw fail("Check out a branch to pull.", "detached");
    if (!u.tracking) throw fail("This branch has no upstream to pull from. Push it first.", "no_upstream");
    if (u.remote !== ".") await fetchFrom(cwd, fetchRemote(u), signal);
    const counts = await git(cwd, ["rev-list", "--left-right", "--count", `HEAD...${u.tracking}`, "--"], signal, true);
    if (!/^\d+\s+\d+$/.test(counts)) throw fail("Git couldn't compare this branch with its upstream.");
    const [ahead, behind] = counts.split(/\s+/).map(Number) as [number, number];
    const base = { branch: redact(u.branch), upstream: redact(u.tracking.replace(/^refs\/(remotes|heads)\//, "")), ahead, behind };
    if (!behind) return { ...base, result: "current" };
    if (ahead) return { ...base, result: "diverged" };
    const merged = await runGit(cwd, ["merge", "--ff-only", "--no-edit", "--no-stat", u.tracking], false, signal);
    if (merged.code) throw fail(gitReason(merged.err + merged.out) || "Git couldn't fast-forward this branch.", "blocked");
    return { ...base, ahead: 0, behind: 0, result: "pulled", pulled: behind };
}

const MAX_BRANCHES = 400;

/** Local branches, then remote ones, each most recently committed first; names that hide a secret are left out. */
export async function gitBranches(cwd: string, signal?: AbortSignal): Promise<GitBranchList> {
    const [current, out] = await Promise.all([
        git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal, true),
        git(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(upstream:short)%00%(committerdate:unix)%00%(worktreepath)%00%(symref)", "refs/heads", "refs/remotes"], signal),
    ]);
    const list: GitBranchList = { ...(current ? { current: redact(current) } : {}), local: [], remote: [] };
    for (const line of out.split("\n")) {
        const [ref, upstream, date, worktree, symref] = line.split("\0");
        if (!ref || symref) continue;
        const local = ref.startsWith("refs/heads/");
        const name = ref.slice(local ? 11 : 13);
        if (redact(name) !== name) continue;
        const entry = { name, at: Number(date) * 1000 || undefined, ...(upstream && redact(upstream) === upstream ? { upstream } : {}), ...(worktree && name !== current ? { worktree } : {}) };
        const into = local ? list.local : list.remote;
        if (into.length < MAX_BRANCHES) into.push(entry);
    }
    return list;
}

/** A name git takes for a new branch, or the reason it doesn't. */
async function newBranchName(cwd: string, name: string, signal?: AbortSignal): Promise<string> {
    const n = name.trim();
    if (!n || n.length > 200 || n.startsWith("-") || /[\x00-\x20\x7f]/.test(n)) throw fail("Enter a branch name without spaces.", "invalid");
    const ok = await runGit(cwd, ["check-ref-format", "--branch", n], false, signal);
    if (ok.code) throw fail(`“${n}” isn't a valid branch name.`, "invalid");
    if (await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${n}`], signal, true)) throw fail(`A branch named ${n} already exists.`, "branch_exists");
    return n;
}

/**
 * Switch to a local branch, or to a remote one: its local branch when there is one, else a new local branch
 * tracking it. Git refuses when uncommitted changes would be overwritten, or the branch is checked out elsewhere.
 */
export async function gitSwitch(cwd: string, o: { branch: string; remote?: boolean }, signal?: AbortSignal): Promise<{ branch: string; created?: boolean }> {
    const b = o.branch;
    if (!b || b.length > 400 || b.startsWith("-") || /[\x00-\x20\x7f]/.test(b)) throw fail("Invalid branch name.", "invalid");
    let args: string[];
    let target = b;
    let created = false;
    if (o.remote) {
        if (!(await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${b}^{commit}`], signal, true))) throw fail(`${b} isn't a remote branch here. Fetch, then try again.`, "not_found");
        // origin/feature → feature: the remote's name is the first part that names a remote.
        const remotes = (await git(cwd, ["remote"], signal, true)).split("\n").filter(Boolean).sort((x, y) => y.length - x.length);
        const remote = remotes.find((r) => b.startsWith(`${r}/`));
        target = remote ? b.slice(remote.length + 1) : b.slice(b.indexOf("/") + 1);
        if (await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${target}`], signal, true)) args = ["switch", "--no-guess", target];
        else {
            await newBranchName(cwd, target, signal);
            args = ["switch", "--no-guess", "-c", target, "--track", `refs/remotes/${b}`];
            created = true;
        }
    } else {
        if (!(await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], signal, true))) throw fail(`There's no branch named ${b}.`, "not_found");
        args = ["switch", "--no-guess", b];
    }
    const r = await runGit(cwd, args, false, signal);
    if (r.code) throw fail(gitReason(r.err + r.out) || `Git couldn't switch to ${target}.`, "blocked");
    return { branch: redact(target), ...(created ? { created } : {}) };
}

/** A new branch at HEAD, switched to; nothing in the work tree changes. */
export async function gitCreateBranch(cwd: string, name: string, signal?: AbortSignal): Promise<{ branch: string }> {
    const n = await newBranchName(cwd, name, signal);
    const r = await runGit(cwd, ["switch", "--no-guess", "-c", n], false, signal);
    if (r.code) throw fail(gitReason(r.err + r.out) || `Git couldn't create ${n}.`, "blocked");
    return { branch: redact(n) };
}
