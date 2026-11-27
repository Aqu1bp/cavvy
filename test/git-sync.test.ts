// Fetch, pull, ahead/behind and branch switching, on scratch repositories: a bare remote and two clones of it.
import { afterAll, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";
setDefaultTimeout(60_000);

const iso = isolate();
const saved = { ...process.env };
for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" });
afterAll(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    iso.cleanup();
});

const { gitBranches, gitCreateBranch, gitFetch, gitPull, gitReason, gitSwitch, gitSyncInfo, withReason } = await import("../src/server/git-sync");

const realGit = Bun.which("git")!;
function git(cwd: string, ...args: string[]) {
    const r = Bun.spawnSync([realGit, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
}
let n = 0;
/** A bare remote with main, and two clones of it: `mine` (the one Cavvy works in) and `theirs` (someone else pushing). */
function setup() {
    const root = join(realpathSync(iso.home), `sync-${n++}`);
    mkdirSync(root);
    const remote = join(root, "remote.git");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    const seed = join(root, "seed");
    git(root, "init", "-q", "-b", "main", seed);
    writeFileSync(join(seed, "a.txt"), "one\n");
    git(seed, "add", "a.txt");
    git(seed, "commit", "-qm", "first");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "-q", "-u", "origin", "main");
    const mine = join(root, "mine");
    const theirs = join(root, "theirs");
    git(root, "clone", "-q", remote, mine);
    git(root, "clone", "-q", remote, theirs);
    return { remote, mine, theirs };
}
function commitFile(cwd: string, file: string, text: string, push = false) {
    writeFileSync(join(cwd, file), text);
    git(cwd, "add", file);
    git(cwd, "commit", "-qm", `change ${file}`);
    if (push) git(cwd, "push", "-q");
}

test("ahead/behind come from local refs, and move after a fetch", async () => {
    const { mine, theirs } = setup();
    expect(await gitSyncInfo(mine)).toEqual({ detached: false, branch: "main", upstream: "origin/main", ahead: 0, behind: 0 });
    commitFile(theirs, "b.txt", "b\n", true);
    commitFile(theirs, "c.txt", "c\n", true);
    commitFile(mine, "d.txt", "d\n");
    // Nothing fetched yet: it doesn't know about theirs.
    expect(await gitSyncInfo(mine)).toMatchObject({ ahead: 1, behind: 0 });
    expect(await gitFetch(mine)).toMatchObject({ remote: "origin", ahead: 1, behind: 2 });
    git(mine, "checkout", "-q", "--detach");
    expect(await gitSyncInfo(mine)).toEqual({ detached: true });
});

test("reading the counts is one git process: the title bar asks as each turn ends", async () => {
    const { mine } = setup();
    const shim = join(realpathSync(iso.home), `shim-${n++}`);
    mkdirSync(shim);
    const log = join(shim, "log");
    writeFileSync(join(shim, "git"), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${shim}:${path}`;
    try {
        expect(await gitSyncInfo(mine)).toEqual({ detached: false, branch: "main", upstream: "origin/main", ahead: 0, behind: 0 });
        const ran = readFileSync(log, "utf8").split("\n").filter(Boolean);
        expect(ran).toHaveLength(1);
        expect(ran[0]).toContain("for-each-ref");
    } finally {
        process.env.PATH = path;
    }
});

test("a branch without an upstream has no counts; one whose upstream is gone says so", async () => {
    const { mine } = setup();
    git(mine, "switch", "-q", "-c", "loose");
    expect(await gitSyncInfo(mine)).toEqual({ detached: false, branch: "loose" });
    git(mine, "push", "-q", "-u", "origin", "loose");
    git(mine, "push", "-q", "origin", "--delete", "loose");
    expect(await gitSyncInfo(mine)).toMatchObject({ upstream: "origin/loose", gone: true });
});

test("pull fast-forwards, and says when there's nothing to pull", async () => {
    const { mine, theirs } = setup();
    commitFile(theirs, "b.txt", "b\n", true);
    const r = await gitPull(mine);
    expect(r).toMatchObject({ result: "pulled", pulled: 1, ahead: 0, behind: 0, branch: "main", upstream: "origin/main" });
    expect(git(mine, "rev-parse", "HEAD")).toBe(git(theirs, "rev-parse", "HEAD"));
    expect(await gitPull(mine)).toMatchObject({ result: "current" });
});

test("diverged: says how far on each side, and changes nothing", async () => {
    const { mine, theirs } = setup();
    commitFile(theirs, "b.txt", "b\n", true);
    commitFile(theirs, "c.txt", "c\n", true);
    commitFile(theirs, "e.txt", "e\n", true);
    commitFile(mine, "d.txt", "d\n");
    commitFile(mine, "f.txt", "f\n");
    const head = git(mine, "rev-parse", "HEAD");
    expect(await gitPull(mine)).toMatchObject({ result: "diverged", ahead: 2, behind: 3 });
    expect(git(mine, "rev-parse", "HEAD")).toBe(head);
});

test("uncommitted changes that would be overwritten block a pull with git's reason, briefly", async () => {
    const { mine, theirs } = setup();
    commitFile(theirs, "a.txt", "theirs\n", true);
    writeFileSync(join(mine, "a.txt"), "mine, uncommitted\n");
    const head = git(mine, "rev-parse", "HEAD");
    await expect(gitPull(mine)).rejects.toMatchObject({ code: "blocked", message: "Can't pull: a.txt has uncommitted changes. Commit or stash them." });
    expect(git(mine, "rev-parse", "HEAD")).toBe(head);
});

test("a branch with no upstream can't be pulled", async () => {
    const { mine } = setup();
    git(mine, "switch", "-q", "-c", "loose");
    await expect(gitPull(mine)).rejects.toMatchObject({ code: "no_upstream" });
});

test("branches: local and remote, current marked, the remote's HEAD left out", async () => {
    const { mine, theirs } = setup();
    git(theirs, "switch", "-q", "-c", "feature");
    commitFile(theirs, "f.txt", "f\n");
    git(theirs, "push", "-q", "-u", "origin", "feature");
    await gitFetch(mine);
    git(mine, "branch", "-q", "local-only");
    const list = await gitBranches(mine);
    expect(list.current).toBe("main");
    expect(list.local.map((b) => b.name).sort()).toEqual(["local-only", "main"]);
    expect(list.local.find((b) => b.name === "main")?.upstream).toBe("origin/main");
    expect(list.remote.map((b) => b.name).sort()).toEqual(["origin/feature", "origin/main"]);
});

test("switch to a remote branch makes a local one tracking it; back to a local one", async () => {
    const { mine, theirs } = setup();
    git(theirs, "switch", "-q", "-c", "feature");
    commitFile(theirs, "f.txt", "f\n");
    git(theirs, "push", "-q", "-u", "origin", "feature");
    await gitFetch(mine);
    expect(await gitSwitch(mine, { branch: "origin/feature", remote: true })).toEqual({ branch: "feature", created: true });
    expect(git(mine, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feature");
    expect(await gitSwitch(mine, { branch: "main" })).toEqual({ branch: "main" });
    // Its local branch is there now: switched to, not made again.
    expect(await gitSwitch(mine, { branch: "origin/feature", remote: true })).toEqual({ branch: "feature" });
});

test("branches checked out in other worktrees: where, the main checkout's seen from a worktree, one whose folder is gone", async () => {
    const { mine } = setup();
    const root = join(mine, "..");
    git(mine, "worktree", "add", "-q", join(root, "wt-a"), "-b", "feat/a");
    git(mine, "worktree", "add", "-q", join(root, "wt-gone"), "-b", "feat/gone");
    git(mine, "worktree", "add", "-q", join(root, "wt-locked"), "-b", "feat/locked");
    git(mine, "worktree", "lock", join(root, "wt-locked"));
    rmSync(join(root, "wt-gone"), { recursive: true });
    rmSync(join(root, "wt-locked"), { recursive: true });
    const seen = (l: Awaited<ReturnType<typeof gitBranches>>) => Object.fromEntries(l.local.map((b) => [b.name, [b.worktree ?? "", b.worktreeGone ?? false]]));
    expect(seen(await gitBranches(mine))).toEqual({
        main: ["", false],
        "feat/a": [join(root, "wt-a"), false],
        "feat/gone": [join(root, "wt-gone"), true],
        "feat/locked": [join(root, "wt-locked"), true],
    });
    // From a worktree, the main checkout's branch is the one held elsewhere.
    expect(seen(await gitBranches(join(root, "wt-a")))).toMatchObject({ main: [mine, false], "feat/a": ["", false] });
    // A branch a live worktree holds: git's reason, nothing removed.
    await expect(gitSwitch(mine, { branch: "feat/a" })).rejects.toMatchObject({ code: "blocked" });
    expect(git(mine, "worktree", "list")).toContain("wt-a");
    // One whose folder is gone: that worktree is removed, then it switches.
    expect(await gitSwitch(mine, { branch: "feat/gone" })).toEqual({ branch: "feat/gone" });
    expect(git(mine, "worktree", "list")).not.toContain("wt-gone");
    // A locked one stays, with git's reason.
    await expect(gitSwitch(mine, { branch: "feat/locked" })).rejects.toMatchObject({ code: "blocked", message: expect.stringContaining("locked") });
    expect(git(mine, "branch", "--show-current")).toBe("feat/gone");
});

test("a switch blocked by local changes says git's reason, and stays put", async () => {
    const { mine } = setup();
    git(mine, "switch", "-q", "-c", "other");
    commitFile(mine, "a.txt", "other\n");
    git(mine, "switch", "-q", "main");
    writeFileSync(join(mine, "a.txt"), "uncommitted\n");
    await expect(gitSwitch(mine, { branch: "other" })).rejects.toMatchObject({ code: "blocked", message: "Can't switch to other: a.txt has uncommitted changes. Commit or stash them." });
    expect(git(mine, "branch", "--show-current")).toBe("main");
    await expect(gitSwitch(mine, { branch: "nope" })).rejects.toMatchObject({ code: "not_found" });
});

test("create a branch at HEAD, keeping uncommitted changes; refuse a taken or invalid name", async () => {
    const { mine } = setup();
    writeFileSync(join(mine, "a.txt"), "uncommitted\n");
    const head = git(mine, "rev-parse", "HEAD");
    expect(await gitCreateBranch(mine, "feature/new")).toEqual({ branch: "feature/new" });
    expect(git(mine, "branch", "--show-current")).toBe("feature/new");
    expect(git(mine, "rev-parse", "HEAD")).toBe(head);
    expect(git(mine, "status", "--porcelain")).toBe("M a.txt");
    // Shown after "Can't create <name>:", so the name isn't said again.
    await expect(gitCreateBranch(mine, "main")).rejects.toMatchObject({ code: "branch_exists", message: "That branch already exists." });
    await expect(gitCreateBranch(mine, "bad..name")).rejects.toMatchObject({ code: "invalid", message: "Not a valid branch name." });
    // Each refusal says why: not "without spaces" for a name that has none.
    await expect(gitCreateBranch(mine, "-x")).rejects.toMatchObject({ code: "invalid", message: "It can't start with -." });
    await expect(gitCreateBranch(mine, "has space")).rejects.toMatchObject({ code: "invalid", message: "Enter a branch name without spaces." });
    await expect(gitCreateBranch(mine, "  ")).rejects.toMatchObject({ code: "invalid", message: "Enter a branch name." });
    await expect(gitCreateBranch(mine, "b".repeat(201))).rejects.toMatchObject({ code: "invalid", message: "Use 200 characters or fewer." });
});

test("a URL rewrite on the remote is refused, as for publishing", async () => {
    const { mine, remote } = setup();
    git(mine, "config", `url.${remote}.insteadOf`, "elsewhere:");
    git(mine, "remote", "set-url", "origin", "elsewhere:repo");
    await expect(gitFetch(mine)).rejects.toThrow("Git rewrites this remote");
});

test("git's reasons, briefly", () => {
    expect(gitReason("error: The following untracked working tree files would be overwritten by checkout:\n\tx\n\ty\n\tz\n\tw\nPlease move or remove them before you switch branches.\nAborting\n")).toBe("x, y, z and 1 more are untracked and would be overwritten. Move or remove them.");
    expect(gitReason("error: The following untracked working tree files would be overwritten by checkout:\n\tsso.txt\nAborting\n", "Can't switch to feat/sso")).toBe("Can't switch to feat/sso: sso.txt is untracked and would be overwritten. Move or remove it.");
    expect(gitReason("fatal: 'feature' is already used by worktree at '/tmp/wt'\n")).toBe("'feature' is already used by worktree at '/tmp/wt'");
    const local = "error: Your local changes to the following files would be overwritten by merge:\n\ta.txt\n\tb.txt\nPlease commit your changes or stash them before you merge.\nAborting\n";
    expect(gitReason(local, "Can't pull")).toBe("Can't pull: a.txt, b.txt have uncommitted changes. Commit or stash them.");
    expect(gitReason(local)).toBe("a.txt, b.txt have uncommitted changes. Commit or stash them.");
    expect(gitReason("error: Your local changes to the following files would be overwritten by merge:\n", "Can't pull")).toBe("Can't pull: some files have uncommitted changes. Commit or stash them.");
    // After a sentence of Cavvy's: a sentence of its own.
    expect(withReason("Couldn't fetch origin.", gitReason("fatal: could not read from remote repository\n"))).toBe("Couldn't fetch origin. Could not read from remote repository.");
    expect(withReason("Couldn't fetch origin.", "Connection timed out.")).toBe("Couldn't fetch origin. Connection timed out.");
    // A server's own "ERROR:" (GitHub's, for a repository it can't find) goes as git's own prefixes do.
    expect(withReason("Couldn't fetch origin.", gitReason("ERROR: Repository not found.\nfatal: Could not read from remote repository.\n"))).toBe("Couldn't fetch origin. Repository not found.");
    expect(withReason("Couldn't fetch origin.", "")).toBe("Couldn't fetch origin.");
    expect(withReason("Couldn't fetch origin.", "git@github.com: Permission denied (publickey).")).toBe("Couldn't fetch origin. git@github.com: Permission denied (publickey).");
});

test("engine: switching waits for the folder's sessions, and the header's branch follows", async () => {
    const { Engine } = await import("../src/server/engine");
    const { mine } = setup();
    git(mine, "branch", "other");
    const engine = new Engine({ listModels: async () => [] });
    const client = { subs: new Set<string>(), send() {} };
    engine.clients.add(client);
    try {
        const snap = await engine.handle(client, "session.create", { cwd: mine });
        const rt = engine.runtimes.get(snap.state.id)!;
        await rt.ready;
        rt.busy = true;
        await expect(engine.handle(client, "git.switch", { cwd: mine, branch: "other" })).rejects.toMatchObject({ code: "busy" });
        // Fetching changes neither HEAD nor files: not held up by a working session.
        expect(await engine.handle(client, "git.fetch", { cwd: mine })).toMatchObject({ remote: "origin", branch: "main" });
        rt.busy = false;
        expect(await engine.handle(client, "git.switch", { cwd: mine, branch: "other" })).toEqual({ branch: "other" });
        expect(rt.view.state.branch).toBe("other");
        expect(await engine.handle(client, "git.sync", { cwd: mine })).toEqual({ detached: false, branch: "other" });
    } finally {
        await engine.stop();
    }
});

test("engine: the branch list suggests a new branch named from the session's title, until there's one", async () => {
    const { Engine } = await import("../src/server/engine");
    const { mine } = setup();
    const engine = new Engine({ listModels: async () => [] });
    const client = { subs: new Set<string>(), send() {} };
    engine.clients.add(client);
    try {
        const snap = await engine.handle(client, "session.create", { cwd: mine });
        await engine.runtimes.get(snap.state.id)!.ready;
        // No title yet, or no session: none.
        expect((await engine.handle(client, "git.branches", { cwd: mine, sessionId: snap.state.id })).suggested).toBeUndefined();
        await engine.handle(client, "session.rename", { id: snap.state.id, title: "Fix the login redirect" });
        expect((await engine.handle(client, "git.branches", { cwd: mine })).suggested).toBeUndefined();
        const suggested = (await engine.handle(client, "git.branches", { cwd: mine, sessionId: snap.state.id })).suggested;
        expect(suggested).toMatch(/(^|\/)fix-the-login-redirect$/);
        git(mine, "branch", suggested!);
        expect((await engine.handle(client, "git.branches", { cwd: mine, sessionId: snap.state.id })).suggested).toBeUndefined();
    } finally {
        await engine.stop();
    }
});

test("engine: a branch change reaches every session in the folder, however it was made", async () => {
    const { Engine } = await import("../src/server/engine");
    const { mine } = setup();
    const engine = new Engine({ listModels: async () => [] });
    const client = { subs: new Set<string>(), send() {} };
    engine.clients.add(client);
    try {
        const [a, b] = await Promise.all([engine.handle(client, "session.create", { cwd: mine }), engine.handle(client, "session.create", { cwd: mine })]);
        const ra = engine.runtimes.get(a.state.id)!;
        const rb = engine.runtimes.get(b.state.id)!;
        await Promise.all([ra.ready, rb.ready]);
        // Committed to a new branch from one session: the other's title bar follows.
        writeFileSync(join(mine, "a.txt"), "changed\n");
        await engine.handle(client, "session.gitCommit", { id: a.state.id, paths: ["a.txt"], message: "change a", newBranch: "feature/x" });
        expect([ra.view.state.branch, rb.view.state.branch]).toEqual(["feature/x", "feature/x"]);
        // Switched outside Cavvy: the next read (a turn's end, the window's focus) brings both along.
        git(mine, "switch", "-q", "main");
        expect(await engine.handle(client, "git.sync", { cwd: mine, sessionId: a.state.id })).toMatchObject({ branch: "main" });
        expect([ra.view.state.branch, rb.view.state.branch]).toEqual(["main", "main"]);
    } finally {
        await engine.stop();
    }
});
