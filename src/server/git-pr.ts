// Working on a GitHub pull request: its open ones listed with `gh`, and one checked out in a worktree of its own (a
// fork's too), for a new session there. The network goes through git-publish's rules (runGh, runGit with `network`),
// and the worktree is made as **New worktree…** makes one (worktrees.ts, its trust checks unchanged).
import type { GitPrListInfo, GitPrWorktree, WorktreeInfo } from "./protocol";
import { cleanGitText, ghState, githubRepo, remoteUrl, runGh, runGit } from "./git-publish";
import { gitReason } from "./git-sync";
import { RpcError } from "./rpc-error";
import { createWorktree, createWorktreeWithHooks, listWorktrees } from "./worktrees";
import type { Log } from "./worktrees";

const fail = (message: string, code = "gh") => new RpcError(cleanGitText(message, 600), code);

/** "#123", "123", or a pull request's URL on github.com: its number, and its repository when a URL names one. */
export function parsePrRef(input: string): { number: number; repo?: string } | undefined {
    const s = input.trim();
    const n = /^#?(\d{1,9})$/.exec(s);
    if (n) return { number: Number(n[1]) };
    const u = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,9})(?:[/?#].*)?$/i.exec(s);
    if (u && ![".", ".."].includes(u[1]!) && ![".", ".."].includes(u[2]!)) return { number: Number(u[3]), repo: `${u[1]}/${u[2]}` };
    return undefined;
}

async function local(cwd: string, args: string[]): Promise<string> {
    const r = await runGit(cwd, args, false);
    return r.code ? "" : r.out.trimEnd();
}

/** The remote pull requests come from (the branch's upstream's, else origin, else the only one) and its GitHub repository. */
async function githubRemote(cwd: string): Promise<{ remote: string; url: string; repo: string }> {
    const branch = await local(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const [upstream, names] = await Promise.all([branch ? local(cwd, ["config", "--get", `branch.${branch}.remote`]) : "", local(cwd, ["remote"])]);
    const remotes = names.split("\n").filter(Boolean);
    const remote = upstream && upstream !== "." ? upstream : remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0]! : "";
    if (!remote) throw fail(remotes.length ? "Set an upstream for this branch to choose the GitHub remote." : "This repository has no remote on GitHub.", "not_github");
    const url = await remoteUrl(cwd, remote, false);
    const repo = githubRepo(url);
    if (!repo) throw fail("Pull requests work only with GitHub for now.", "not_github");
    return { remote, url, repo };
}

/** gh here and signed in, or why not: `sign_in` (a sign-in is all that's missing), `gh_missing`. */
async function needGh(cwd: string) {
    const state = await ghState(cwd);
    if (state === "signed-out") throw fail("GitHub isn't signed in.", "sign_in");
    if (state === "missing") throw fail("Pull requests need the GitHub CLI (gh).", "gh_missing");
}

async function ghJson(cwd: string, args: string[]): Promise<unknown> {
    const r = await runGh(cwd, args);
    if (r.code) throw fail(gitReason(r.err + r.out) || "gh couldn't read the pull request.");
    try {
        return JSON.parse(r.out);
    } catch {
        throw fail("Couldn't read gh's answer. Try again.");
    }
}

const text = (v: unknown, max = 300) => (typeof v === "string" ? cleanGitText(v, max) : "");

/** The repository's open pull requests, newest first (50 at most). */
export async function gitPullRequests(cwd: string): Promise<GitPrListInfo> {
    const { repo } = await githubRemote(cwd);
    await needGh(cwd);
    const values = await ghJson(cwd, ["pr", "list", "--repo", `https://github.com/${repo}`, "--state", "open", "--limit", "50", "--json", "number,title,headRefName,author,isDraft,url,isCrossRepository,updatedAt"]);
    if (!Array.isArray(values)) throw fail("Couldn't read gh's answer. Try again.");
    const prs = values
        .filter((v) => v && Number.isSafeInteger(v.number) && v.number > 0 && typeof v.title === "string")
        .map((v) => ({
            number: v.number as number,
            title: text(v.title, 250),
            branch: text(v.headRefName, 200),
            author: text(v.author?.login, 100),
            draft: v.isDraft === true,
            fork: v.isCrossRepository === true,
            updatedAt: Date.parse(v.updatedAt) || undefined,
        }));
    return { repo, prs };
}

const validBranch = (b: string) => Boolean(b) && b.length <= 200 && !b.startsWith("-") && !/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.lock$|\.$/.test(b);

/**
 * Pull request `input` (#123, 123 or its URL) checked out in a worktree: a pull request from this repository on its own
 * branch, tracking it (push and pull work); one from a fork on `pr-123`, at its head, with no upstream. A worktree
 * already on that branch is used as it is; a local branch of that name, not checked out, gets a worktree of its own.
 */
export async function gitPrWorktree(cwd: string, input: string, log?: Log): Promise<GitPrWorktree> {
    const ref = parsePrRef(input);
    if (!ref) throw fail("Enter a pull request number, like #123, or its URL.", "invalid");
    const { remote, url, repo } = await githubRemote(cwd);
    if (ref.repo && ref.repo.toLowerCase() !== repo.toLowerCase()) throw fail(`That pull request is in ${ref.repo}; this repository is ${repo}.`, "other_repo");
    await needGh(cwd);
    const v = (await ghJson(cwd, ["pr", "view", String(ref.number), "--repo", `https://github.com/${repo}`, "--json", "number,title,url,headRefName,isCrossRepository,state"])) as Record<string, any>;
    const prUrl = `https://github.com/${repo}/pull/${ref.number}`;
    if (!v || v.number !== ref.number || typeof v.title !== "string" || typeof v.url !== "string" || v.url.toLowerCase() !== prUrl.toLowerCase()) throw fail("Couldn't read gh's answer. Try again.");
    const pr = { number: ref.number, title: text(v.title, 250), url: prUrl, state: text(v.state, 20).toLowerCase() };
    const head = typeof v.headRefName === "string" ? v.headRefName : "";
    const fork = v.isCrossRepository !== false || !validBranch(head);
    const branch = fork ? `pr-${ref.number}` : head;

    // Already checked out somewhere: that worktree, as it is.
    let worktrees: WorktreeInfo[] = [];
    try { worktrees = listWorktrees(cwd); } catch { /* not listed: one is made */ }
    const there = worktrees.find((w) => w.branch === branch && w.exists);
    if (there) return { path: there.path, branch, reused: true, pr };

    // Fetched from the URL checked as publishing checks it: the branch into its remote-tracking ref, a fork's head into FETCH_HEAD.
    const spec = fork ? `refs/pull/${ref.number}/head` : `+refs/heads/${head}:refs/remotes/${remote}/${head}`;
    const fetched = await runGit(cwd, ["-c", "fetch.recurseSubmodules=false", "fetch", "--no-recurse-submodules", "--no-tags", "--", url, spec], true);
    if (fetched.code) throw fail(`Couldn't fetch pull request #${ref.number}. ${gitReason(fetched.err + fetched.out)}`, "fetch_failed");
    const commit = await local(cwd, ["rev-parse", "--verify", "--quiet", `${fork ? "FETCH_HEAD" : `refs/remotes/${remote}/${head}`}^{commit}`]);
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw fail(`Couldn't find pull request #${ref.number}'s commits after fetching.`, "fetch_failed");

    const exists = Boolean(await local(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]));
    const made = exists ? await createWorktree({ path: cwd, branch }, log, { existingBranch: true }) : await createWorktreeWithHooks({ path: cwd, branch, base: commit }, log);
    if (!exists && !fork) {
        // Tracking the pull request's branch, as `gh pr checkout` would have it: ahead/behind, Push and Pull work.
        await runGit(made.path, ["config", "--local", `branch.${branch}.remote`, remote], false);
        await runGit(made.path, ["config", "--local", `branch.${branch}.merge`, `refs/heads/${head}`], false);
    }
    return { path: made.path, branch: made.branch, ...(exists ? { existing: true } : {}), pr };
}
