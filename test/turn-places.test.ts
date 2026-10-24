import { afterAll, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "fs";
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
