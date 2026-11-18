// Working on a pull request: listing open ones with a fake gh, and checking one out in a worktree (from this
// repository, or a fork's via refs/pull/N/head), on scratch repositories: a bare "github.com" remote and a clone.
import { afterAll, expect, test, setDefaultTimeout } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";
setDefaultTimeout(60_000);

const iso = isolate();
const saved = { ...process.env };
const realGit = Bun.which("git")!;
for (const key of Object.keys(process.env)) if (key.startsWith("GIT_") || key.startsWith("GH_") || key === "GITHUB_TOKEN") delete process.env[key];
const bin = join(iso.home, "bin");
mkdirSync(bin);
for (const [name, file] of [["gh", "fake-pr-gh.ts"], ["git", "fake-pr-git.ts"]] as const) {
    writeFileSync(join(bin, name), `#!${process.execPath} --no-env-file\nimport ${JSON.stringify(new URL(`./fixtures/${file}`, import.meta.url).href)};\n`);
    chmodSync(join(bin, name), 0o755);
}
Object.assign(process.env, {
    PATH: `${bin}:${saved.PATH}`, FAKE_PR_GIT: realGit, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
});
afterAll(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    iso.cleanup();
});

const { gitPrWorktree, gitPullRequests, parsePrRef } = await import("../src/server/git-pr");

function git(cwd: string, ...args: string[]) {
    const r = Bun.spawnSync([realGit, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
}
const URL_ = "https://github.com/example/project.git";
let n = 0;
/** A bare remote with main, a same-repo PR #7 on `feature/login`, and a fork's PR #9 only under refs/pull/9/head. */
function setup() {
    const root = join(realpathSync(iso.home), `pr-${n++}`);
    mkdirSync(root);
    const remote = join(root, "remote.git");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    const seed = join(root, "seed");
    git(root, "init", "-q", "-b", "main", seed);
    writeFileSync(join(seed, "a.txt"), "one\n");
    git(seed, "add", "a.txt");
    git(seed, "commit", "-qm", "first");
    git(seed, "push", "-q", remote, "main");
    git(seed, "switch", "-q", "-c", "feature/login");
    git(seed, "commit", "-q", "--allow-empty", "-m", "login");
    git(seed, "push", "-q", remote, "feature/login");
    const login = git(seed, "rev-parse", "HEAD");
    git(seed, "switch", "-q", "-c", "fork-work", "main");
    git(seed, "commit", "-q", "--allow-empty", "-m", "from a fork");
    const forked = git(seed, "rev-parse", "HEAD");
    git(seed, "push", "-q", remote, `${forked}:refs/pull/9/head`);
    const cwd = join(root, "project");
    git(root, "clone", "-q", remote, cwd);
    git(cwd, "remote", "set-url", "origin", URL_);
    const list = join(root, "prs.json");
    writeFileSync(list, JSON.stringify([
        { number: 7, title: "Fix the login redirect", url: "https://github.com/example/project/pull/7", headRefName: "feature/login", isCrossRepository: false, state: "OPEN", isDraft: false, author: { login: "dev" }, updatedAt: "2026-11-01T00:00:00Z" },
        { number: 9, title: "Fork contribution", url: "https://github.com/example/project/pull/9", headRefName: "main", isCrossRepository: true, state: "OPEN", isDraft: true, author: { login: "someone" }, updatedAt: "2026-11-02T00:00:00Z" },
        { number: 3, title: "Old one", url: "https://github.com/example/project/pull/3", headRefName: "old", isCrossRepository: false, state: "MERGED", isDraft: false, author: { login: "dev" } },
    ]));
    process.env.FAKE_PR_LIST = list;
    process.env.FAKE_PR_REMOTE = remote;
    delete process.env.FAKE_PR_GH;
    return { cwd, remote, login, forked, list };
}

test("a pull request is named by #N, N or its URL", () => {
    expect(parsePrRef("#123")).toEqual({ number: 123 });
    expect(parsePrRef(" 42 ")).toEqual({ number: 42 });
    expect(parsePrRef("https://github.com/Owner/repo/pull/5/files")).toEqual({ number: 5, repo: "Owner/repo" });
    expect(parsePrRef("github.com/o/r/pull/6")).toEqual({ number: 6, repo: "o/r" });
    expect(parsePrRef("feature/x")).toBeUndefined();
    expect(parsePrRef("https://gitlab.com/o/r/-/merge_requests/1")).toBeUndefined();
});

test("lists the open pull requests", async () => {
    const { cwd } = setup();
    const info = await gitPullRequests(cwd);
    expect(info.repo).toBe("example/project");
    expect(info.prs.map((p) => [p.number, p.title, p.branch, p.author, p.draft, p.fork])).toEqual([
        [7, "Fix the login redirect", "feature/login", "dev", false, false],
        [9, "Fork contribution", "main", "someone", true, true],
    ]);
});

test("a pull request from this repository: its branch in a worktree, tracking the remote's", async () => {
    const { cwd, login } = setup();
    const made = await gitPrWorktree(cwd, "#7");
    expect(made).toMatchObject({ branch: "feature/login", pr: { number: 7, title: "Fix the login redirect", url: "https://github.com/example/project/pull/7", state: "open" } });
    expect(made.path).toBe(join(cwd, ".claude", "worktrees", "feature-login"));
    expect(git(made.path, "rev-parse", "HEAD")).toBe(login);
    expect(git(made.path, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feature/login");
    // Asked again: the same worktree, as it is.
    expect(await gitPrWorktree(cwd, "https://github.com/example/project/pull/7")).toEqual({ ...made, reused: true });
});

test("a fork's pull request: its head from refs/pull/N/head on pr-N, without an upstream", async () => {
    const { cwd, forked } = setup();
    const made = await gitPrWorktree(cwd, "9");
    expect(made.branch).toBe("pr-9");
    expect(git(made.path, "rev-parse", "HEAD")).toBe(forked);
    expect(() => git(made.path, "rev-parse", "--abbrev-ref", "@{upstream}")).toThrow();
});

test("without gh signed in, a sign-in is asked for; another repository's URL or a missing PR is refused", async () => {
    const { cwd } = setup();
    process.env.FAKE_PR_GH = "signed-out";
    await expect(gitPullRequests(cwd)).rejects.toMatchObject({ code: "sign_in" });
    await expect(gitPrWorktree(cwd, "#7")).rejects.toMatchObject({ code: "sign_in" });
    delete process.env.FAKE_PR_GH;
    await expect(gitPrWorktree(cwd, "https://github.com/other/repo/pull/7")).rejects.toMatchObject({ code: "other_repo" });
    await expect(gitPrWorktree(cwd, "#404")).rejects.toThrow("Could not resolve");
    await expect(gitPrWorktree(cwd, "not a pr")).rejects.toMatchObject({ code: "invalid" });
});

test("without gh: says the GitHub CLI is needed", async () => {
    const { cwd } = setup();
    const path = process.env.PATH;
    // Only git on PATH (a folder of its own): gh isn't there.
    const gitOnly = join(iso.home, `git-only-${n}`);
    mkdirSync(gitOnly);
    writeFileSync(join(gitOnly, "git"), readFileSync(join(bin, "git")));
    chmodSync(join(gitOnly, "git"), 0o755);
    process.env.PATH = gitOnly;
    try {
        await expect(gitPullRequests(cwd)).rejects.toMatchObject({ code: "gh_missing" });
    } finally {
        process.env.PATH = path;
    }
});

test("a remote that isn't on GitHub: only GitHub for now", async () => {
    const { cwd, remote } = setup();
    git(cwd, "remote", "set-url", "origin", remote);
    await expect(gitPullRequests(cwd)).rejects.toMatchObject({ code: "not_github", message: "Pull requests work only with GitHub for now." });
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
});
