// GUI-only publishing. Reads are local except explicit dialog discovery and PR refresh.
import { createHash } from "crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, delimiter, join } from "path";
import { gitArgv, gitEnv, gitNetworkSkipReason } from "../util/git";
import { redact } from "../util/redact";
import type { GitPublishInfo, GitPublishRequest, GitPrInfo } from "./protocol";
import { RpcError } from "./rpc-error";

const clean = (s: string, limit = 4000) => redact(s
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[credentials]@")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1[redacted URL parameters]"))
    .slice(0, limit);
const fail = (message: string, code = "git") => new RpcError(clean(message), code);
export const gitPublishTiming = { commandMs: 120_000, killGraceMs: 1000 };

async function checkNetworkTrust(cwd: string) {
    const reason = await gitNetworkSkipReason(cwd);
    if (reason) throw new RpcError(`Trust this folder explicitly before publishing or reading remote state: ${reason}.`, "needs_trust", cwd);
}

async function run(cwd: string, args: string[], network = false, signal?: AbortSignal, extraEnv: Record<string, string> = {}) {
    if (signal?.aborted) throw fail("Publishing cancelled; check the remote before retrying.", "git_cancelled");
    if (network) await checkNetworkTrust(cwd);
    const env = gitEnv();
    delete env.GIT_CONFIG;
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE"]) delete env[key];
    if (env.PATH) env.PATH = env.PATH.split(delimiter).filter(isAbsolute).join(delimiter);
    Object.assign(env, { GH_PROMPT_DISABLED: "1", GIT_NO_LAZY_FETCH: "1" }, extraEnv);
    // Only inherited credentials; never consult Harness's credential store for gh.
    if (args[0] === "gh") {
        for (const key of ["GH_TOKEN", "GITHUB_TOKEN"]) if (process.env[key]) env[key] = process.env[key]!;
        delete env.GH_REPO;
        delete env.GH_HOST;
    }
    if (!network) env.GIT_ALLOW_PROTOCOL = "harness-none";
    const argv = args[0] === "git" ? gitArgv(["-c", "core.hooksPath=/dev/null", ...args.slice(1)]) : args;
    // Resolve with the same sanitized PATH passed to the child; do not fall back
    // to the server's startup PATH when a CLI disappears or PATH changes.
    const executable = Bun.which(argv[0]!, { PATH: env.PATH ?? "", cwd });
    if (!executable) throw fail(`${args[0]} is not installed or could not be started.`, "unavailable");
    let proc;
    try {
        proc = Bun.spawn([executable, ...argv.slice(1)], { cwd, env, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch {
        throw fail(`${args[0]} is not installed or could not be started.`, "unavailable");
    }
    let stopping: Promise<void> | undefined;
    const kill = (s: "SIGTERM" | "SIGKILL") => {
        try { process.kill(-proc.pid, s); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
    };
    const stop = () => {
        if (stopping) return;
        kill("SIGTERM");
        stopping = new Promise((resolve) => setTimeout(() => { kill("SIGKILL"); resolve(); }, gitPublishTiming.killGraceMs));
    };
    const timer = setTimeout(stop, gitPublishTiming.commandMs);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    try {
        const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        await stopping;
        if (stopping) throw fail("Publishing timed out or was cancelled; check the remote before retrying.", "git_timeout");
        return { out, err, code };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
    }
}
/** One `gh` call with the publish rules: inherited credentials only, no prompts, the folder's network trust checked. */
export function runGh(cwd: string, args: string[], signal?: AbortSignal): Promise<{ out: string; err: string; code: number }> {
    return run(cwd, ["gh", ...args], true, signal);
}

/** The GitHub repository ("owner/name") the current branch pushes to. */
export async function currentGithubRepo(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    return githubRepo((await local(cwd, signal)).url);
}

async function git(cwd: string, args: string[], signal?: AbortSignal, network = false, optional = false) {
    const result = await run(cwd, ["git", ...args], network, signal);
    if (result.code && (!optional || (args[0] === "config" && result.code !== 1))) throw fail(result.err + result.out || "Git command failed.");
    return result.code && optional ? "" : result.out.trimEnd();
}
async function branchName(cwd: string, name: string, signal?: AbortSignal) {
    if (!name || name.length > 400 || name.startsWith("-") || /[\x00-\x20\x7f]/.test(name)) throw fail("Invalid branch name.", "invalid");
    await git(cwd, ["check-ref-format", `refs/heads/${name}`], signal);
    return name;
}

/** Parse only ordinary github.com remotes; never emit credentials, query strings or arbitrary link schemes. */
export function githubRepo(url: string): string | undefined {
    if (redact(url) !== url) return undefined;
    const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
    if (!match || [".", ".."].includes(match[1]!) || [".", ".."].includes(match[2]!)) return undefined;
    return `${match[1]}/${match[2]}`;
}

async function local(cwd: string, signal?: AbortSignal) {
    await checkNetworkTrust(cwd);
    const [branch, sha, remoteNames] = await Promise.all([
        git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal, false, true),
        git(cwd, ["rev-parse", "--verify", "HEAD"], signal),
        git(cwd, ["remote"], signal),
    ]);
    if (!branch) throw fail("Cannot push a detached HEAD. Check out a branch first.", "invalid");
    const [, upstreamRemote, merge] = await Promise.all([
        branchName(cwd, branch, signal),
        git(cwd, ["config", "--get", `branch.${branch}.remote`], signal, false, true),
        git(cwd, ["config", "--get", `branch.${branch}.merge`], signal, false, true),
    ]);
    const remotes = remoteNames.split("\n").filter(Boolean);
    const hasUpstream = Boolean(upstreamRemote && merge);
    const remote = hasUpstream ? upstreamRemote : remotes.length === 1 && remotes[0] === "origin" ? "origin" : "";
    if (!remote || !remotes.includes(remote) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) throw fail("No unambiguous push remote. Configure an upstream, or a single origin remote, in a terminal.", "invalid");
    if (hasUpstream && !merge.startsWith("refs/heads/")) throw fail("The upstream is not a branch.", "invalid");
    const [target, configuredPushUrls, configuredUrls, rewrites, tracking] = await Promise.all([
        branchName(cwd, hasUpstream ? merge.slice(11) : branch, signal),
        git(cwd, ["config", "--includes", "-z", "--get-all", `remote.${remote}.pushurl`], signal, false, true),
        git(cwd, ["config", "--includes", "-z", "--get-all", `remote.${remote}.url`], signal, false, true),
        git(cwd, ["config", "--includes", "-z", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"], signal, false, true),
        git(cwd, ["rev-parse", "--symbolic-full-name", "@{upstream}"], signal, false, true),
    ]);
    const configValues = (value: string) => value ? value.split("\0").slice(0, -1) : [];
    const fetchUrls = configValues(configuredUrls);
    const pushUrls = configValues(configuredPushUrls);
    // Refuse applicable rewrites in *any* scope, even with explicit trust.
    // Reusing get-url's expanded output would apply insteadOf a second time.
    // Also inspect fetch URLs: pushInsteadOf operates on them when no pushurl exists.
    for (const entry of rewrites.split("\0").filter(Boolean)) {
        const newline = entry.indexOf("\n");
        if (newline < 0) throw fail("Cannot verify Git URL rewrite configuration.", "invalid");
        const prefix = entry.slice(newline + 1);
        if ([...fetchUrls, ...pushUrls].some((url) => url.startsWith(prefix))) {
            throw fail("A Git URL rewrite applies to this remote. Configure its literal destination URL without insteadOf/pushInsteadOf before publishing.", "invalid");
        }
    }
    const urls = pushUrls.length ? pushUrls : fetchUrls;
    if (urls.length !== 1 || !urls[0] || /[\x00-\x20\x7f]/.test(urls[0]) || urls[0].startsWith("-") || urls[0].includes("::")) throw fail("Use one ordinary push URL for this remote.", "invalid");
    const url = urls[0];
    let ahead: number | undefined, behind: number | undefined;
    if (tracking) {
        const counts = await git(cwd, ["rev-list", "--left-right", "--count", `${sha}...${tracking}`, "--"], signal, false, true);
        if (/^\d+\s+\d+$/.test(counts)) [ahead, behind] = counts.split(/\s+/).map(Number);
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({ branch, sha, remote, target, url, hasUpstream })).digest("hex");
    return { branch, sha, remote, target, url, hasUpstream, ahead, behind, fingerprint };
}
/** Where a push would go now (git only, no network), with the fingerprint gitPublish checks. */
export async function gitPushTarget(cwd: string, signal?: AbortSignal) {
    const t = await local(cwd, signal);
    return { branch: clean(t.branch), sha: t.sha, remote: clean(t.remote), target: clean(t.target), url: clean(t.url), fingerprint: t.fingerprint };
}

async function defaultBranch(cwd: string, url: string, signal?: AbortSignal) {
    // Query the actual push destination, not a potentially stale origin/HEAD.
    const refs = await git(cwd, ["ls-remote", "--symref", "--", url, "HEAD"], signal, true);
    const name = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(refs)?.[1];
    return name ? branchName(cwd, name, signal) : undefined;
}
async function ghReady(cwd: string, signal?: AbortSignal): Promise<boolean> {
    try { return (await run(cwd, ["gh", "auth", "status", "--hostname", "github.com"], true, signal)).code === 0; }
    catch (e) { if (e instanceof RpcError && e.code === "unavailable") return false; throw e; }
}
async function prView(cwd: string, repo: string, branch: string, signal?: AbortSignal): Promise<GitPrInfo | undefined> {
    // Asked for by head owner and branch (owner:branch), so other owners' PRs from a branch of the same name (forks)
    // can't crowd this repository's out of a page before it's filtered (#107). A branch has one open PR per base,
    // so a page holds it. The one picked is then read by its number (`pr view 123` is PR #123, never branch "123").
    const [owner, name] = repo.split("/");
    const listed = await run(cwd, ["gh", "api", "--method", "GET", `repos/${repo}/pulls`, "-f", `head=${owner}:${branch}`, "-f", "state=all", "-f", "per_page=100"], true, signal);
    if (listed.code) throw fail(listed.err + listed.out || "Could not read pull request state.", "gh");
    let values;
    try { values = JSON.parse(listed.out); } catch { throw fail("gh returned invalid pull request state.", "gh"); }
    if (!Array.isArray(values)) throw fail("gh returned invalid pull request state.", "gh");
    const candidates = values.filter((value) => value && Number.isSafeInteger(value.number) && value.head?.ref === branch
        && typeof value.head?.repo?.owner?.login === "string" && value.head.repo.owner.login.toLowerCase() === owner!.toLowerCase()
        && typeof value.head?.repo?.name === "string" && value.head.repo.name.toLowerCase() === name!.toLowerCase()
        && ["open", "closed"].includes(value.state));
    candidates.sort((a, b) => Number(b.state === "open") - Number(a.state === "open")
        || (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0) || b.number - a.number);
    if (!candidates[0]) return undefined;
    const result = await run(cwd, ["gh", "pr", "view", String(candidates[0].number), "--repo", `https://github.com/${repo}`, "--json", "number,url,title,state,isDraft,statusCheckRollup,headRefName,headRepository,headRepositoryOwner"], true, signal);
    if (result.code) throw fail(result.err + result.out || "Could not read pull request state.", "gh");
    let value;
    try { value = JSON.parse(result.out); } catch { throw fail("gh returned invalid pull request state.", "gh"); }
    const url = `https://github.com/${repo}/pull/${candidates[0].number}`;
    if (!value || value.number !== candidates[0].number || typeof value.url !== "string" || value.url.toLowerCase() !== url.toLowerCase() || value.headRefName !== branch
        || typeof value.headRepositoryOwner?.login !== "string" || value.headRepositoryOwner.login.toLowerCase() !== owner!.toLowerCase()
        || typeof value.headRepository?.name !== "string" || value.headRepository.name.toLowerCase() !== name!.toLowerCase()
        || !["OPEN", "MERGED", "CLOSED"].includes(value.state) || typeof value.title !== "string" || typeof value.isDraft !== "boolean") throw fail("gh returned invalid pull request state.", "gh");
    return { number: value.number, url, title: clean(value.title, 500), state: value.state === "OPEN" && value.isDraft ? "draft" : value.state.toLowerCase(), checks: Array.isArray(value.statusCheckRollup) ? value.statusCheckRollup.length : 0 };
}

export async function gitPrState(cwd: string, signal?: AbortSignal): Promise<GitPrInfo | undefined> {
    const info = await local(cwd, signal);
    const repo = githubRepo(info.url);
    if (!repo || !(await ghReady(cwd, signal))) return undefined;
    return prView(cwd, repo, info.target, signal);
}

export async function gitPublishInfo(cwd: string, signal?: AbortSignal): Promise<GitPublishInfo> {
    const info = await local(cwd, signal);
    const base = await defaultBranch(cwd, info.url, signal);
    const repo = githubRepo(info.url);
    const gh = Boolean(repo) && await ghReady(cwd, signal);
    let pr: GitPrInfo | undefined, prError: string | undefined;
    if (gh) {
        try { pr = await prView(cwd, repo!, info.target, signal); }
        catch (e) {
            if (e instanceof RpcError && e.code === "needs_trust") throw e;
            prError = clean(e instanceof Error ? e.message : String(e));
        }
    }
    const baseRef = base ? `refs/remotes/${info.remote}/${base}` : undefined;
    const baseSha = baseRef ? await git(cwd, ["rev-parse", "--verify", baseRef], signal, false, true) : "";
    const log = await git(cwd, ["log", "--no-show-signature", "--no-use-mailmap", "-30", "--format=%s%n%b", baseSha ? `${baseSha}..${info.sha}` : "-1", ...(baseSha ? [] : [info.sha]), "--"], signal);
    const text = clean(log, 16000);
    return {
        fingerprint: info.fingerprint, branch: clean(info.branch), remote: clean(info.remote), target: clean(info.target), destination: clean(info.url),
        ahead: info.ahead, behind: info.behind, hasUpstream: info.hasUpstream, base: base && clean(base),
        protected: ["main", "master", base].includes(info.branch) || ["main", "master", base].includes(info.target),
        // If a remote has no symbolic HEAD, require acknowledgement for every branch.
        defaultUnknown: !base, gh, pr, prError, title: text.split("\n")[0]?.slice(0, 250) || clean(info.branch), body: text,
        compareUrl: repo && redact(info.target) === info.target && (!base || redact(base) === base) ? `https://github.com/${repo}/compare/${base ? `${encodeURIComponent(base)}...` : ""}${encodeURIComponent(info.target)}?expand=1` : undefined,
    };
}

/**
 * The push, to the URL checked and confirmed: not by the remote's name, which git would look up again (a URL or
 * push URL changed since). A URL rewrite (insteadOf, pushInsteadOf) added since would still apply to it, so a
 * pre-push hook of Harness's own compares the URL git resolved with that one, and refuses any other before
 * anything is sent (#107).
 */
async function pushTo(cwd: string, info: { remote: string; target: string; url: string; sha: string }, signal?: AbortSignal) {
    const hooks = mkdtempSync(join(tmpdir(), "harness-push-"));
    try {
        const hook = join(hooks, "pre-push");
        writeFileSync(hook, '#!/bin/sh\n# Harness: push only to the destination that was checked and confirmed.\n[ "$2" = "$HARNESS_PUSH_URL" ] && exit 0\necho "The push destination changed after it was checked (a Git URL rewrite?); nothing was pushed. Reopen the dialog." >&2\nexit 1\n');
        chmodSync(hook, 0o700);
        const result = await run(cwd, ["git", "-c", `core.hooksPath=${hooks}`, "-c", "push.followTags=false", "-c", "push.pushOption=", "push", "--porcelain", "--no-force", "--no-follow-tags", "--recurse-submodules=no", "--", info.url, `${info.sha}:refs/heads/${info.target}`], true, signal, { HARNESS_PUSH_URL: info.url });
        // Pushed to the URL, git leaves the remote's tracking branch as it was: updated as a push to the remote
        // would have (by its default fetch refspec), so ahead/behind stay right.
        if (!result.code) {
            const fetch = await git(cwd, ["config", "--get-all", `remote.${info.remote}.fetch`], signal, false, true);
            if (fetch.split("\n").includes(`+refs/heads/*:refs/remotes/${info.remote}/*`)) await git(cwd, ["update-ref", `refs/remotes/${info.remote}/${info.target}`, info.sha], signal, false, true);
        }
        return result;
    } finally {
        rmSync(hooks, { recursive: true, force: true });
    }
}

export async function gitPublish(cwd: string, request: GitPublishRequest, signal?: AbortSignal): Promise<{ pr?: GitPrInfo }> {
    const info = await local(cwd, signal);
    if (info.fingerprint !== request.fingerprint) throw fail("The branch, commit or destination changed. Reopen the dialog before publishing.", "stale");
    const base = await defaultBranch(cwd, info.url, signal);
    if ((!base || ["main", "master", base].includes(info.branch) || ["main", "master", base].includes(info.target)) && request.confirmProtected !== true) throw fail("Explicit confirmation is required to push a protected branch (or a remote with unknown default branch).", "protected_branch");
    const repo = githubRepo(info.url);
    let existing: GitPrInfo | undefined;
    if (request.action === "pr") {
        await branchName(cwd, request.base ?? "", signal);
        if (!request.title?.trim() || request.title.length > 250 || (request.body?.length ?? 0) > 16000 || /\0/.test(request.title + (request.body ?? ""))) throw fail("Enter a title (up to 250 characters) and body (up to 16000 characters), without NUL bytes.", "invalid");
        if (!repo || !(await ghReady(cwd, signal))) throw fail("GitHub CLI is unavailable or not authenticated. Run gh auth login in a terminal.", "gh");
        if (request.base === info.target) throw fail("The pull request base must differ from the pushed branch.", "invalid");
        existing = await prView(cwd, repo, info.target, signal);
    }
    // Recheck after network discovery, before the external effect. Explicit refspec,
    // no configured mirror, tags, forced update, submodule push or push options.
    const remoteRef = await git(cwd, ["ls-remote", "--", info.url, `refs/heads/${info.target}`], signal, true);
    if ((await local(cwd, signal)).fingerprint !== info.fingerprint) throw fail("The branch or destination changed. Reopen the dialog.", "stale");
    const needsPush = !info.hasUpstream || remoteRef.split("\t")[0] !== info.sha;
    const result = needsPush ? await pushTo(cwd, info, signal) : { code: 0, out: "", err: "" };
    if (result.code) throw fail(`Push failed. ${/non-fast-forward|fetch first|rejected/i.test(result.out + result.err) ? "The remote rejected the update; fetch and reconcile the branch in a terminal. No force push was attempted.\n" : ""}${result.err}${result.out}`);
    if (!info.hasUpstream) {
        // A SHA source cannot set upstream via push -u. Name the reviewed local
        // branch explicitly, even if another client checked out/moved HEAD.
        try {
            await git(cwd, ["config", "--local", "--replace-all", `branch.${info.branch}.remote`, info.remote], signal);
            await git(cwd, ["config", "--local", "--replace-all", `branch.${info.branch}.merge`, `refs/heads/${info.target}`], signal);
        } catch (e) {
            throw fail(`Branch pushed, but its upstream could not be set. Configure the upstream in a terminal. ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    if (request.action === "push") return { pr: await gitPrState(cwd, signal).catch(() => undefined) };
    if (existing?.state === "open" || existing?.state === "draft") return { pr: await prView(cwd, repo!, info.target, signal).catch(() => existing) };
    const created = await run(cwd, ["gh", "pr", "create", "--repo", `https://github.com/${repo}`, "--head", info.target, "--base", request.base!, "--title", clean(request.title!, 250), "--body", clean(request.body ?? "", 16000), ...(request.draft ? ["--draft"] : [])], true, signal);
    if (created.code) {
        const existing = await prView(cwd, repo!, info.target, signal).catch(() => undefined);
        if (existing?.state === "open" || existing?.state === "draft") return { pr: existing };
        throw fail(`Branch pushed, but pull request creation failed. ${created.err}${created.out}`, "gh");
    }
    return { pr: await prView(cwd, repo!, info.target, signal) };
}
