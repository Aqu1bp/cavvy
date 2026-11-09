import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tempDir } from "./helpers/isolate";

const { gitBranch, gitSnapshot } = await import("../src/util/git");

const root = tempDir("cavvy-git-branch-");
afterAll(() => rmSync(root, { recursive: true, force: true }));

// A git on PATH that only writes down that it ran, so what's read without one shows.
const shim = tempDir("cavvy-git-branch-shim-");
const realPath = process.env.PATH;
const realGit = Bun.which("git")!;
const log = join(shim, "log");
writeFileSync(join(shim, "git"), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${realGit}" "$@"\n`);
chmodSync(join(shim, "git"), 0o755);
afterAll(() => { process.env.PATH = realPath; rmSync(shim, { recursive: true, force: true }); });

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
function git(cwd: string, ...args: string[]) {
    const r = Bun.spawnSync([realGit, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
}
function repo(name: string, ...init: string[]) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main", ...init);
    return dir;
}
function commit(dir: string) {
    git(dir, "commit", "-q", "--allow-empty", "-m", "x");
}
/** gitBranch's answer, what git itself says, and how many times it took git to say. */
function ask(cwd: string, compare = true) {
    rmSync(log, { force: true });
    process.env.PATH = `${shim}:${realPath}`;
    const branch = gitBranch(cwd);
    process.env.PATH = realPath;
    const spawned = Bun.spawnSync(["sh", "-c", `test -f "${log}" && wc -l < "${log}" || echo 0`], { stdout: "pipe" }).stdout.toString().trim();
    if (!compare) return { branch, spawned: Number(spawned) };
    const r = Bun.spawnSync([realGit, "branch", "--show-current"], { cwd, env: { ...env, ...process.env }, stdout: "pipe", stderr: "ignore" });
    return { branch, git: (r.exitCode === 0 && r.stdout.toString().trim()) || undefined, spawned: Number(spawned) };
}

test("the plain layouts are read without starting git, and say what git says", () => {
    const dir = repo("plain");
    expect(ask(dir)).toEqual({ branch: "main", git: "main", spawned: 0 });
    mkdirSync(join(dir, "a/b"), { recursive: true });
    expect(ask(join(dir, "a/b"))).toEqual({ branch: "main", git: "main", spawned: 0 });
    commit(dir);
    git(dir, "switch", "-q", "-c", "feat/login-2.0_x+y");
    expect(ask(dir)).toEqual({ branch: "feat/login-2.0_x+y", git: "feat/login-2.0_x+y", spawned: 0 });
    git(dir, "switch", "-q", "--detach");
    expect(ask(dir)).toEqual({ branch: undefined, git: undefined, spawned: 0 });
});

test("a worktree and a link to a repository's folder read like the repository", () => {
    const dir = repo("linked");
    commit(dir);
    const tree = join(root, "linked-tree");
    git(dir, "worktree", "add", "-q", "-b", "other", tree);
    mkdirSync(join(tree, "sub"));
    expect(ask(tree)).toEqual({ branch: "other", git: "other", spawned: 0 });
    expect(ask(join(tree, "sub"))).toEqual({ branch: "other", git: "other", spawned: 0 });
    symlinkSync(join(tree, "sub"), join(root, "to-sub"));
    expect(ask(join(root, "to-sub"))).toEqual({ branch: "other", git: "other", spawned: 0 });
});

test("what the file can't say goes to git", () => {
    // A name outside the plain characters.
    const odd = repo("odd");
    commit(odd);
    git(odd, "switch", "-q", "-c", "fix#12-é");
    expect(ask(odd)).toEqual({ branch: "fix#12-é", git: "fix#12-é", spawned: 1 });
    // A bare repository, one inside a repository's work tree included: it's the nearer one.
    const outer = repo("outer");
    const bare = join(outer, "inner.git");
    mkdirSync(bare);
    git(bare, "init", "-q", "--bare", "-b", "trunk");
    const barely = ask(bare);
    expect(barely).toEqual({ branch: "trunk", git: "trunk", spawned: 1 });
    // A .git folder that isn't a repository's: git looks further up.
    const stray = join(outer, "stray");
    mkdirSync(join(stray, ".git"), { recursive: true });
    writeFileSync(join(stray, ".git/HEAD"), "ref: refs/heads/fake\n");
    expect(ask(stray)).toEqual({ branch: "main", git: "main", spawned: 1 });
    // HEAD a pipe would hang the read. It hangs git too, until the time it's given is up.
    const piped = repo("piped");
    rmSync(join(piped, ".git/HEAD"));
    Bun.spawnSync(["mkfifo", join(piped, ".git/HEAD")]);
    expect(ask(piped, false)).toMatchObject({ branch: undefined, spawned: 1 });
    // A worktree whose pointer goes through a link: `..` is the link's parent, as the system reads it.
    const away = join(root, "away/deep");
    mkdirSync(away, { recursive: true });
    const pointed = repo("pointed");
    const moved = join(root, "pointed.git");
    Bun.spawnSync(["mv", join(pointed, ".git"), moved]);
    symlinkSync(away, join(pointed, "link"));
    Bun.spawnSync(["mkdir", "-p", join(root, "away/pointed.git")]);
    writeFileSync(join(pointed, ".git"), `gitdir: link/../pointed.git\n`);
    Bun.spawnSync(["sh", "-c", `git init -q -b thisone "${join(root, "away/pointed.git")}" --bare`], { env });
    const through = ask(pointed);
    expect(through.branch).toBe("thisone");
    expect(through.git).toBe("thisone");
    // A link for HEAD, as old repositories have.
    const old = repo("old-link");
    rmSync(join(old, ".git/HEAD"));
    symlinkSync("refs/heads/main", join(old, ".git/HEAD"));
    expect(ask(old).spawned).toBe(1);
    // Past where it's been told to stop looking.
    const within = join(outer, "within");
    mkdirSync(within);
    process.env.GIT_CEILING_DIRECTORIES = outer;
    try {
        expect(ask(within)).toEqual({ branch: undefined, git: undefined, spawned: 1 });
    } finally {
        delete process.env.GIT_CEILING_DIRECTORIES;
    }
    // No repository at all.
    expect(ask(tempDir("cavvy-git-none-"))).toEqual({ branch: undefined, git: undefined, spawned: 1 });
});

test("a reftable repository goes to git", () => {
    const made = Bun.spawnSync([realGit, "init", "-q", "--ref-format=reftable", "-b", "main", join(root, "reftable")], { env, stderr: "ignore" });
    if (made.exitCode !== 0) return; // An older git.
    expect(ask(join(root, "reftable"))).toEqual({ branch: "main", git: "main", spawned: 1 });
});

test("the main branch: origin's, else master, else main, and one git to say", async () => {
    const dir = repo("mains");
    expect((await gitSnapshot(dir))?.mainBranch).toBeUndefined();
    commit(dir);
    expect((await gitSnapshot(dir))?.mainBranch).toBe("main");
    git(dir, "branch", "master");
    expect((await gitSnapshot(dir))?.mainBranch).toBe("master");
    git(dir, "update-ref", "refs/remotes/origin/develop", "HEAD");
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    expect((await gitSnapshot(dir))?.mainBranch).toBe("develop");
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/team/main");
    git(dir, "update-ref", "refs/remotes/origin/team/main", "HEAD");
    expect((await gitSnapshot(dir))?.mainBranch).toBe("team/main");
    // A default the remote no longer has isn't claimed.
    git(dir, "update-ref", "-d", "refs/remotes/origin/team/main");
    expect((await gitSnapshot(dir))?.mainBranch).toBe("master");
});
