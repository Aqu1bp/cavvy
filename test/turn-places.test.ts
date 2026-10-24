import { afterAll, expect, test } from "bun:test";
import { mkdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { TurnSnapshots } = await import("../src/agent/turn-snapshots");
const { gitArgv, gitEnv } = await import("../src/util/git");
afterAll(() => iso.cleanup());

let next = 0;
const IDENTITY = ["-c", "maintenance.auto=false", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Harness Test", "-c", "user.email=test@example.invalid"];

function git(cwd: string, args: string[]): string {
    const env = gitEnv();
    for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
    const r = Bun.spawnSync(gitArgv([...IDENTITY, ...args]), { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString();
}

function write(dir: string, path: string, body: string) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
}

/** A repository on main with a file, and worktrees on branches of their own inside its .claude/worktrees. */
function setup(worktrees: string[] = []) {
    const base = join(realpathSync(iso.home), `places-${next++}`);
    const cwd = join(base, "repo");
    const dir = join(base, "history");
    mkdirSync(cwd, { recursive: true });
    git(cwd, ["init", "-q", "-b", "main"]);
    write(cwd, "a.txt", "one\ntwo\n");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-q", "-m", "Initial commit"]);
    const wt = (name: string) => join(cwd, ".claude", "worktrees", name);
    for (const name of worktrees) git(cwd, ["worktree", "add", "-q", "-b", `agent/${name}`, wt(name)]);
    return { base, cwd, dir, wt, snapshots: new TurnSnapshots(dir, cwd) };
}

/** Work in a worktree: an edit, committed, and a new file, not. */
function work(path: string, tag: string) {
    write(path, "a.txt", `one\ntwo\n${tag}\n`);
    git(path, ["commit", "-q", "-am", `Work on ${tag}`]);
    write(path, `${tag}.txt`, "new\nfile\nhere\n");
}

test("a turn that works in a worktree inside the folder lists it as a place: its branch against main, committed or not", async () => {
    const { wt, snapshots } = setup(["home", "idle"]);
    await snapshots.begin(1, "port the home screen");
    work(wt("home"), "home");
    await snapshots.end();
    const info = await snapshots.changes({ scope: "turn", turnId: 1 });
    expect(info.places?.map((p) => [p.path, p.branch, p.base, p.files, p.added, p.removed, p.commits])).toEqual([[wt("home"), "agent/home", "main", 2, 4, 0, 1]]);
    expect(info.places![0]!.top).toEqual([
        { path: "home.txt", change: "added", added: 3, removed: 0 },
        { path: "a.txt", change: "modified", added: 1, removed: 0 },
    ]);
    // The worktree's folder is a place of its own now, not contents left out of the session folder's snapshot.
    expect(info.incomplete).toBe(false);
    expect((info.notes ?? []).some((n) => n.includes(".claude/worktrees"))).toBe(false);
    expect(info.files).toEqual([]);
});

test("only what the turn worked in: an untouched worktree isn't listed, one made during the turn is", async () => {
    const { cwd, wt, snapshots } = setup(["idle", "busy"]);
    write(wt("idle"), "before.txt", "dirty before the turn\n");
    await snapshots.begin(1, "fan out");
    work(wt("busy"), "busy");
    git(cwd, ["worktree", "add", "-q", "-b", "agent/fresh", wt("fresh")]);
    work(wt("fresh"), "fresh");
    await snapshots.end();
    const info = await snapshots.changes({ scope: "turn", turnId: 1 });
    expect(info.places?.map((p) => p.branch).sort()).toEqual(["agent/busy", "agent/fresh"]);
    // A turn that leaves them alone lists none.
    await snapshots.begin(2, "just talk");
    await snapshots.end();
    expect((await snapshots.changes({ scope: "turn", turnId: 2 })).places).toBeUndefined();
});

test("a file edited again in a worktree that was already dirty still counts as worked in", async () => {
    const { wt, snapshots } = setup(["dirty"]);
    write(wt("dirty"), "a.txt", "one\ntwo\nthree\n");
    await snapshots.begin(1, "keep going");
    await Bun.sleep(5);
    write(wt("dirty"), "a.txt", "one\ntwo\nthree\nfour\n");
    await snapshots.end();
    const info = await snapshots.changes({ scope: "turn", turnId: 1 });
    expect(info.places?.map((p) => [p.branch, p.files, p.added])).toEqual([["agent/dirty", 1, 2]]);
});

test("a worktree outside the folder isn't looked at", async () => {
    const { base, cwd, snapshots } = setup();
    const outside = join(base, "elsewhere");
    git(cwd, ["worktree", "add", "-q", "-b", "agent/outside", outside]);
    await snapshots.begin(1, "elsewhere");
    work(outside, "outside");
    await snapshots.end();
    expect((await snapshots.changes({ scope: "turn", turnId: 1 })).places).toBeUndefined();
});

test("reading the worktrees inherits no git tracing: no trace file, and the places still read", async () => {
    const { cwd, wt, snapshots } = setup(["home"]);
    const trace = join(cwd, "..", "trace-output.txt");
    const saved = process.env.GIT_TRACE;
    process.env.GIT_TRACE = trace;
    try {
        await snapshots.begin(1, "a traced parent process");
        work(wt("home"), "home");
        await snapshots.end();
    } finally {
        if (saved === undefined) delete process.env.GIT_TRACE;
        else process.env.GIT_TRACE = saved;
    }
    expect(await Bun.file(trace).exists()).toBe(false);
    expect((await snapshots.changes({ scope: "turn", turnId: 1 })).places?.map((p) => p.files)).toEqual([2]);
});

test("at a steering boundary, what the next turn does in a worktree isn't the turn before's", async () => {
    const { wt, snapshots } = setup(["home"]);
    await snapshots.begin(1, "first");
    work(wt("home"), "home");
    // The boundary is captured when the steered prompt goes; the turn before is finished only later.
    const boundary = await snapshots.prepare();
    write(wt("home"), "next.txt", "the next turn's\n");
    await snapshots.beginWith(2, "steered", boundary);
    await snapshots.end();
    expect((await snapshots.changes({ scope: "turn", turnId: 1 })).places?.map((p) => [p.files, (p.top ?? []).map((f) => f.path).sort()])).toEqual([[2, ["a.txt", "home.txt"]]]);
    // The next turn's start isn't carrying the turn before's places.
    expect(snapshots.list().find((t) => t.id === 2)!.start).not.toHaveProperty("worked");
});

test("a fetch that moves a worktree's upstream isn't work in it", async () => {
    const { base, cwd, wt, snapshots } = setup(["synced"]);
    const remote = join(base, "remote.git");
    git(base, ["init", "-q", "--bare", remote]);
    git(cwd, ["remote", "add", "origin", remote]);
    git(cwd, ["push", "-q", "origin", "agent/synced"]);
    git(wt("synced"), ["branch", "-q", "-u", "origin/agent/synced"]);
    // Someone else pushes to the branch; this turn only fetches.
    const other = join(base, "other");
    git(base, ["clone", "-q", "-b", "agent/synced", remote, other]);
    write(other, "theirs.txt", "theirs\n");
    git(other, ["add", "-A"]);
    git(other, ["commit", "-q", "-m", "Theirs"]);
    git(other, ["push", "-q", "origin", "agent/synced"]);
    await snapshots.begin(1, "fetch");
    git(wt("synced"), ["fetch", "-q", "origin"]);
    expect(git(wt("synced"), ["status", "--porcelain=v2", "--branch"])).toContain("# branch.ab +0 -1");
    await snapshots.end();
    expect((await snapshots.changes({ scope: "turn", turnId: 1 })).places).toBeUndefined();
});

test("a file swapped in by rename, the same size and time, still counts (its inode changed)", async () => {
    const { wt, snapshots } = setup(["swap"]);
    write(wt("swap"), "a.txt", "one\nTWO\n");
    const { mtime } = statSync(join(wt("swap"), "a.txt"));
    await snapshots.begin(1, "save as an editor does");
    write(wt("swap"), "a.tmp", "one\nTW0\n");
    utimesSync(join(wt("swap"), "a.tmp"), mtime, mtime);
    renameSync(join(wt("swap"), "a.tmp"), join(wt("swap"), "a.txt"));
    await snapshots.end();
    expect((await snapshots.changes({ scope: "turn", turnId: 1 })).places?.map((p) => p.branch)).toEqual(["agent/swap"]);
});

test("out of time, a worktree's fingerprint is unknown, and a listing git can't give is unknown, not empty", async () => {
    const { wt } = setup(["late"]);
    const { fingerprint, listWorktrees, UNKNOWN } = await import("../src/agent/turn-places");
    expect(await fingerprint({ path: wt("late"), main: false }, Date.now() - 1)).toBe(UNKNOWN);
    const notRepo = join(realpathSync(iso.home), `not-a-repo-${next++}`);
    mkdirSync(notRepo, { recursive: true });
    expect(await listWorktrees(notRepo, Date.now() + 2000)).toBeUndefined();
});

test("shown: a place's branch is redacted, and a file whose name hides a secret gets a handle for its worktree", async () => {
    const { registerSecret, unregisterSecret } = await import("../src/util/redact");
    const { GitHandles } = await import("../src/server/git-handles");
    const secret = "sk-test-places-0123456789abcdef";
    registerSecret(secret);
    try {
        const { wt } = setup(["leaky"]);
        const handles = new GitHandles();
        const shown = handles.shown({
            repo: true, scope: "turn", files: [], added: 0, removed: 0, tracked: true, bases: [], more: 0,
            places: [{ path: wt("leaky"), branch: `fix/${secret}`, base: "main", files: 1, added: 1, removed: 0, top: [{ path: `notes-${secret}.txt`, change: "added", added: 1, removed: 0 }, { path: "plain.txt", change: "added", added: 0, removed: 0 }] }],
        }, "/elsewhere");
        const place = shown.places![0]!;
        expect(JSON.stringify(place)).not.toContain(secret);
        expect(place.top![0]!.pathToken).toBeString();
        expect(place.top![1]).not.toHaveProperty("pathToken");
        // The handle resolves in the worktree's own folder, as the diff reader lists it there.
        expect(handles.resolve("path", realpathSync(wt("leaky")), place.top![0]!.pathToken)).toBe(`notes-${secret}.txt`);
    } finally {
        unregisterSecret(secret);
    }
});

test("reading a worktree runs none of the repository's programs: a clean filter on its dirty files never runs", async () => {
    const { base, cwd, wt, snapshots } = setup(["filtered"]);
    const marker = join(base, "filter-ran");
    // The repository asks for a filter on .txt files: one that would leave a marker if anything ran it.
    git(cwd, ["config", "filter.mark.clean", `sh -c 'touch "${marker}"; cat'`]);
    git(cwd, ["config", "filter.mark.process", `sh -c 'touch "${marker}"'`]);
    write(wt("filtered"), ".gitattributes", "*.txt filter=mark\n");
    await snapshots.begin(1, "edit a filtered file");
    write(wt("filtered"), "a.txt", "one\ntwo\nthree\n");
    write(wt("filtered"), "b.txt", "new\n");
    await snapshots.end();
    expect(await Bun.file(marker).exists()).toBe(false);
    expect((await snapshots.changes({ scope: "turn", turnId: 1 })).places?.map((p) => p.branch)).toEqual(["agent/filtered"]);
});

test("a worktree's folder swapped for a link to another repository isn't read", async () => {
    const { base, cwd, wt, snapshots } = setup(["swapped"]);
    const other = join(base, "other-repo");
    mkdirSync(other, { recursive: true });
    git(other, ["init", "-q", "-b", "main"]);
    write(other, "private.txt", "someone else's\n");
    git(other, ["add", "-A"]);
    git(other, ["commit", "-q", "-m", "Other"]);
    git(cwd, ["worktree", "lock", wt("swapped")]);
    await snapshots.begin(1, "swap it");
    rmSync(wt("swapped"), { recursive: true, force: true });
    symlinkSync(other, wt("swapped"));
    write(other, "more.txt", "changed\n");
    await snapshots.end();
    const info = await snapshots.changes({ scope: "turn", turnId: 1 });
    expect(JSON.stringify(info.places ?? [])).not.toContain("private.txt");
    expect(JSON.stringify(info.places ?? [])).not.toContain("more.txt");
});

test("a file untracked but kept (git rm --cached) isn't counted twice: the place is counted as the diff reader shows it", async () => {
    const { wt, snapshots } = setup(["untracked"]);
    await snapshots.begin(1, "stop tracking a file");
    git(wt("untracked"), ["rm", "-q", "--cached", "a.txt"]);
    write(wt("untracked"), "a.txt", "one\ntwo\nthree\n");
    await snapshots.end();
    const place = (await snapshots.changes({ scope: "turn", turnId: 1 })).places?.[0];
    // Worked in (its index changed); the file once, as on disk against main, not a deletion plus an addition.
    expect(place?.branch).toBe("agent/untracked");
    expect(place?.files).toBe(1);
    expect((place?.top ?? []).filter((f) => f.path === "a.txt")).toHaveLength(1);
});

test("a turn's places are kept: reopened, the session shows them as they were", async () => {
    const { cwd, dir, wt, snapshots } = setup(["home"]);
    await snapshots.begin(1, "port the home screen");
    work(wt("home"), "home");
    await snapshots.end();
    // Later work on the branch doesn't change what the turn recorded.
    write(wt("home"), "later.txt", "after the turn\n");
    const reopened = new TurnSnapshots(dir, cwd);
    const info = await reopened.changes({ scope: "turn", turnId: 1 });
    expect(info.places?.map((p) => [p.branch, p.files, p.commits])).toEqual([["agent/home", 2, 1]]);
});
