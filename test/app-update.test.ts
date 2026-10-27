// The desktop app updating itself from main (src/server/app-update.ts): what a
// check finds against the install record, in real git repositories, and how a
// started update's state moves, with a stand-in update script.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { AppUpdates, bundleOf, capture, lastLogLine } from "../src/server/app-update";
import { appSourceDir, capUpdate, installRecordPath, lockUpdate, replaceBundle, runningUpdate, updateLockPath } from "../src/config/desktop-install";
import type { AppUpdateInfo } from "../src/server/protocol";

let dir: string;
let savedHome: string | undefined;
const BUNDLE = "/Applications/Cavvy.app";

function sh(cwd: string, ...args: string[]): string {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
}

/** A remote with main, and a clone of it (the checkout the app was built from). */
function repos(commits = ["one", "two", "three"]) {
    const origin = join(dir, "origin.git");
    const work = join(dir, "work");
    sh(dir, "init", "-q", "--bare", origin);
    sh(dir, "clone", "-q", origin, work);
    for (const c of commits) sh(work, "commit", "-q", "--allow-empty", "-m", c);
    sh(work, "push", "-q", "origin", "HEAD:main");
    return { origin, work };
}

function record(r: { commit: string; dirty?: boolean; source: string; app?: string; installedAt?: string }) {
    mkdirSync(join(dir, "home"), { recursive: true });
    writeFileSync(installRecordPath(), JSON.stringify({ dirty: false, app: BUNDLE, installedAt: new Date(0).toISOString(), ...r }));
}

function updates(o: Partial<ConstructorParameters<typeof AppUpdates>[0]> = {}) {
    const events: AppUpdateInfo[] = [];
    const u = new AppUpdates({ emit: (i) => events.push(i), bundle: BUNDLE, platform: "darwin", bun: process.execPath, ...o });
    return { u, events };
}

async function until(f: () => boolean, ms = 15_000) {
    const end = Date.now() + ms;
    while (!f()) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(25);
    }
}

/** Runs `f` with these variables set (undefined: unset), then puts them back. */
async function withEnv<T>(vars: Record<string, string | undefined>, f: () => Promise<T>): Promise<T> {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    const set = (v: Record<string, string | undefined>) => {
        for (const [k, x] of Object.entries(v)) if (x === undefined) delete process.env[k];
        else process.env[k] = x;
    };
    set(vars);
    try {
        return await f();
    } finally {
        set(saved);
    }
}

/** A stand-in ssh at bin/`name`, put first on PATH by withEnv: it writes down how it was run, then fails as an unreachable host would. */
function fakeSsh(name: string, then = "exit 255") {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const file = join(bin, name);
    const log = JSON.stringify(join(dir, "ssh.log"));
    writeFileSync(file, `#!/bin/sh\necho "$(basename "$0") $* askpass=[$GIT_ASKPASS][$SSH_ASKPASS] require=$SSH_ASKPASS_REQUIRE gcm=$GCM_INTERACTIVE prompt=$GIT_TERMINAL_PROMPT" >> ${log}\n${then}\n`, { mode: 0o755 });
    return { file, path: `${bin}:${process.env.PATH}`, log: () => (existsSync(join(dir, "ssh.log")) ? readFileSync(join(dir, "ssh.log"), "utf8") : "") };
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cavvy-app-update-"));
    savedHome = process.env.CAVVY_HOME;
    process.env.CAVVY_HOME = join(dir, "home");
});

afterEach(() => {
    process.env.CAVVY_HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
});

describe("bundleOf", () => {
    test("the .app a program runs from", () => {
        expect(bundleOf("/Applications/Cavvy.app/Contents/MacOS/cavvy")).toBe("/Applications/Cavvy.app");
        expect(bundleOf("/Users/me/Applications/My Apps/Cavvy.app/Contents/MacOS/cavvy")).toBe("/Users/me/Applications/My Apps/Cavvy.app");
        expect(bundleOf("/Users/me/.bun/bin/bun")).toBeUndefined();
    });
});

describe("where it can't update itself", () => {
    test("not macOS, not the installed app, no record, another copy, its checkout gone", async () => {
        const { work } = repos();
        const head = sh(work, "rev-parse", "HEAD");
        expect((await updates({ platform: "linux" }).u.check()).unavailable).toContain("macOS");
        expect((await updates({ bundle: undefined }).u.check()).unavailable).toContain("Only the installed desktop app");
        expect((await updates().u.check()).unavailable).toContain("no record");
        record({ commit: head, source: work, app: "/Users/me/Applications/Cavvy.app" });
        expect((await updates().u.check()).unavailable).toContain("isn't the one last installed");
        record({ commit: head, source: join(dir, "gone") });
        expect((await updates().u.check()).unavailable).toContain("is gone");
    });

    test("starting says nothing about it: most servers are never the installed app", async () => {
        const { u, events } = updates({ bundle: undefined });
        u.start();
        await until(() => Boolean(u.get().unavailable));
        u.stop();
        expect(events).toEqual([]);
    });
});

describe("check", () => {
    test("up to date when the record is main", async () => {
        const { work } = repos();
        record({ commit: sh(work, "rev-parse", "HEAD"), source: work });
        const info = await updates().u.check();
        expect(info).toMatchObject({ available: false, behind: 0, changes: [], checking: false, installed: sh(work, "rev-parse", "--short=7", "HEAD") });
        expect(info.error).toBeUndefined();
    });

    test("maxAgeMs: no fetch while the last check is newer than that, one once it's older", async () => {
        const { origin, work } = repos();
        record({ commit: sh(work, "rev-parse", "HEAD"), source: work });
        const { u } = updates();
        expect((await u.check()).available).toBe(false);
        // main moves on the remote.
        const other = join(dir, "other");
        sh(dir, "clone", "-q", origin, other);
        sh(other, "commit", "-q", "--allow-empty", "-m", "four");
        sh(other, "push", "-q", "origin", "HEAD:main");
        expect((await u.check({ maxAgeMs: 60_000 })).available).toBe(false);
        expect(await u.check({ maxAgeMs: 0 })).toMatchObject({ available: true, behind: 1 });
    });

    test("main's changes since the installed build, newest first", async () => {
        const { work } = repos(["one", "two", "three", "four"]);
        record({ commit: sh(work, "rev-parse", "HEAD~2"), source: work });
        const info = await updates().u.check();
        expect(info.available).toBe(true);
        expect(info.behind).toBe(2);
        expect(info.changes.map((c) => c.subject)).toEqual(["four", "three"]);
        expect(info.latest).toBe(sh(work, "rev-parse", "--short=7", "HEAD"));
    });

    test("fetches: main moved on the remote since the checkout last fetched", async () => {
        const { origin, work } = repos();
        record({ commit: sh(work, "rev-parse", "HEAD"), source: work });
        const other = join(dir, "other");
        sh(dir, "clone", "-q", origin, other);
        sh(other, "commit", "-q", "--allow-empty", "-m", "pushed elsewhere");
        sh(other, "push", "-q", "origin", "HEAD:main");
        const info = await updates().u.check();
        expect(info.changes.map((c) => c.subject)).toEqual(["pushed elsewhere"]);
    });

    test("uncommitted changes count, except in desktop:update's own worktree", async () => {
        const { work } = repos();
        const head = sh(work, "rev-parse", "HEAD");
        record({ commit: head, dirty: true, source: work });
        expect(await updates().u.check()).toMatchObject({ available: true, behind: 0, note: expect.stringContaining("uncommitted") });
        sh(work, "worktree", "add", "-q", "--detach", appSourceDir(), head);
        record({ commit: head, dirty: true, source: appSourceDir() });
        expect((await updates().u.check()).available).toBe(false);
    });

    test("a build from a branch that isn't on main", async () => {
        const { work } = repos();
        sh(work, "checkout", "-q", "-b", "feature");
        sh(work, "commit", "-q", "--allow-empty", "-m", "unmerged");
        record({ commit: sh(work, "rev-parse", "HEAD"), source: work });
        expect(await updates().u.check()).toMatchObject({ available: true, changes: [], note: expect.stringContaining("branch") });
    });

    test("a GIT_DIR it inherited doesn't send the check to another repository", async () => {
        const { work } = repos();
        const head = sh(work, "rev-parse", "HEAD");
        record({ commit: head, source: work });
        const other = join(dir, "other");
        sh(dir, "init", "-q", other);
        sh(other, "commit", "-q", "--allow-empty", "-m", "elsewhere");
        const info = await withEnv({ GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other }, () => updates().u.check());
        expect(info).toMatchObject({ available: false, installed: head.slice(0, 7), latest: head.slice(0, 7) });
        expect(info.error).toBeUndefined();
    });

    test("asks no one: plain ssh is told not to, and not to wait long; no askpass, no credential manager's dialog", async () => {
        const { work } = repos();
        record({ commit: sh(work, "rev-parse", "HEAD~1"), source: work });
        sh(work, "remote", "set-url", "origin", "ssh://git@example.invalid/repo.git");
        const ssh = fakeSsh("ssh");
        const info = await withEnv({ PATH: ssh.path, GIT_SSH_COMMAND: undefined, GIT_SSH: undefined, GIT_ASKPASS: "/Applications/Some Dialog", SSH_ASKPASS: "/Applications/Some Dialog" }, () => updates().u.check());
        expect(info.error).toContain("Couldn't fetch main");
        expect(ssh.log()).toContain("ssh -o BatchMode=yes -o ConnectTimeout=15 ");
        expect(ssh.log()).toContain("askpass=[][] require=never gcm=never prompt=0");
    });

    test("the checkout's own ssh command is left as it is", async () => {
        const { work } = repos();
        record({ commit: sh(work, "rev-parse", "HEAD~1"), source: work });
        sh(work, "remote", "set-url", "origin", "ssh://git@example.invalid/repo.git");
        const mine = fakeSsh("my-ssh");
        const plain = fakeSsh("ssh");
        sh(work, "config", "core.sshCommand", `${mine.file} -i somekey`);
        // A GIT_CONFIG it inherited hides the setting from git config, not from the fetch.
        const empty = join(dir, "empty.gitconfig");
        writeFileSync(empty, "");
        await withEnv({ PATH: plain.path, GIT_SSH_COMMAND: undefined, GIT_SSH: undefined, GIT_CONFIG: empty }, () => updates().u.check());
        expect(mine.log()).toContain("my-ssh -i somekey ");
        expect(mine.log()).not.toContain("BatchMode");
    });

    test("the server stopping ends a check's fetch, all of it", async () => {
        const { work } = repos();
        record({ commit: sh(work, "rev-parse", "HEAD~1"), source: work });
        sh(work, "remote", "set-url", "origin", "ssh://git@example.invalid/repo.git");
        const pidFile = join(dir, "ssh.pid");
        const ssh = fakeSsh("ssh", `echo $$ > ${JSON.stringify(pidFile)}; exec sleep 30`);
        await withEnv({ PATH: ssh.path, GIT_SSH_COMMAND: undefined, GIT_SSH: undefined }, async () => {
            const { u } = updates();
            const checked = u.check();
            await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
            const pid = Number(readFileSync(pidFile, "utf8"));
            const stopped = Date.now();
            u.stop();
            await checked;
            expect(Date.now() - stopped).toBeLessThan(3000);
            await until(() => {
                try {
                    process.kill(pid, 0);
                    return false;
                } catch {
                    return true;
                }
            }, 3000);
        });
    });

    test("a fetch that fails says so, and goes on with what's there", async () => {
        const { origin, work } = repos();
        record({ commit: sh(work, "rev-parse", "HEAD~1"), source: work });
        rmSync(origin, { recursive: true, force: true });
        const info = await updates().u.check();
        expect(info.error).toContain("Couldn't fetch main");
        expect(info.behind).toBe(1);
    });
});

describe("update", () => {
    /** The checkout's update script, a stand-in: `body` runs in it. */
    function script(work: string, body: string) {
        mkdirSync(join(work, "scripts"), { recursive: true });
        writeFileSync(join(work, "bunfig.toml"), "");
        writeFileSync(join(work, "scripts", "update-desktop.ts"), body);
    }

    test("runs the checkout's update script with --from-app, and a failure says what it last printed", async () => {
        const { work } = repos();
        record({ commit: sh(work, "rev-parse", "HEAD~1"), source: work });
        script(work, `console.log("args " + process.argv.slice(2).join(" ")); console.log("\\x1b[1mCompiling\\x1b[0m thing"); console.error("error: no space left"); process.exit(3);`);
        const { u, events } = updates();
        const started = await u.update();
        expect(started.updating).toMatchObject({ restarting: false });
        await until(() => !u.get().updating);
        expect(u.get().failed).toBe("The update failed: error: no space left");
        expect(await Bun.file(u.get().log!).text()).toContain("args --from-app");
        expect(events.some((e) => e.updating)).toBe(true);
    });

    test("the update finds the same bun first on its PATH, for the scripts that run it by name", async () => {
        const { work } = repos();
        record({ commit: sh(work, "rev-parse", "HEAD~1"), source: work });
        script(work, `console.log("first " + process.env.PATH.split(":")[0]);`);
        const { u } = updates();
        await u.update();
        await until(() => !u.get().updating);
        expect(await Bun.file(u.get().log!).text()).toContain(`first ${dirname(process.execPath)}`);
    });

    test("installed: it waits for the restart, and says so if none comes", async () => {
        const { work } = repos();
        record({ commit: sh(work, "rev-parse", "HEAD~1"), source: work });
        script(work, `await Bun.write(process.env.CAVVY_HOME + "/desktop-install.json", JSON.stringify({ commit: "x", dirty: false, source: "s", installedAt: new Date().toISOString() }));`);
        const { u } = updates({ restartWaitMs: 300 });
        await u.update();
        await until(() => Boolean(u.get().updating?.restarting));
        expect(u.get().updating?.line).toContain("Restarting");
        await until(() => !u.get().updating);
        expect(u.get().failed).toContain("didn't restart");
    });

    test("nothing installed (main hadn't moved): back to checking", async () => {
        const { work } = repos();
        record({ commit: sh(work, "rev-parse", "HEAD"), source: work });
        script(work, `console.log("Cavvy is up to date with main.");`);
        const { u } = updates();
        await u.update();
        await until(() => !u.get().updating && Boolean(u.get().checkedAt));
        expect(u.get()).toMatchObject({ available: false });
        expect(u.get().failed).toBeUndefined();
    });

    test("one at a time", async () => {
        const { work } = repos();
        record({ commit: sh(work, "rev-parse", "HEAD~1"), source: work });
        script(work, `await Bun.sleep(400);`);
        const { u } = updates();
        const a = await u.update();
        const b = await u.update();
        expect(b.updating?.startedAt).toBe(a.updating!.startedAt);
        await until(() => !u.get().updating);
    });

    test("two requests at once start one update", async () => {
        const { work } = repos();
        record({ commit: sh(work, "rev-parse", "HEAD~1"), source: work });
        const runs = join(dir, "runs");
        script(work, `const fs = require("fs"); fs.appendFileSync(${JSON.stringify(runs)}, "run\\n"); await Bun.sleep(300);`);
        const { u } = updates();
        const [a, b] = await Promise.all([u.update(), u.update()]);
        expect(b.updating?.startedAt).toBe(a.updating!.startedAt);
        await until(() => !u.get().updating);
        expect((await Bun.file(runs).text()).trim().split("\n")).toEqual(["run"]);
    });

    test("an update that prints nothing for too long is stopped, and says where it was", async () => {
        const { work } = repos();
        record({ commit: sh(work, "rev-parse", "HEAD~1"), source: work });
        script(work, `console.log("$ bun install"); await Bun.sleep(30_000); console.log("never");`);
        const { u } = updates({ stallMs: 1500 });
        const started = Date.now();
        await u.update();
        await until(() => !u.get().updating);
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(u.get().failed).toBe("The update stopped: it printed nothing for under a minute, after: $ bun install");
    });

    test("desktop:update's worktree, only if it's of the checkout the app came from", async () => {
        const { work } = repos();
        record({ commit: sh(work, "rev-parse", "HEAD~1"), source: work });
        script(work, `console.log("from the checkout");`);
        // Another repository's, there: it would update to that one's main.
        sh(dir, "init", "-q", appSourceDir());
        script(appSourceDir(), `console.log("from another repository");`);
        const { u } = updates();
        await u.update();
        await until(() => !u.get().updating);
        expect(await Bun.file(u.get().log!).text()).toContain("from the checkout");

        rmSync(appSourceDir(), { recursive: true, force: true });
        sh(work, "worktree", "add", "-q", "--detach", appSourceDir(), "HEAD");
        script(appSourceDir(), `console.log("from the worktree");`);
        await u.update();
        await until(() => !u.get().updating);
        expect(await Bun.file(u.get().log!).text()).toContain("from the worktree");
    });

    test("an update from before Cavvy last opened, still running: it says so, and starts none", async () => {
        const { work } = repos();
        record({ commit: sh(work, "rev-parse", "HEAD~1"), source: work });
        const runs = join(dir, "runs");
        script(work, `require("fs").appendFileSync(${JSON.stringify(runs)}, "run\\n");`);
        const lock = lockUpdate();
        if (!("fd" in lock)) throw new Error("the lock wasn't free");
        try {
            const info = await updates().u.update();
            expect(info.failed).toBe(`An update started earlier is still running (process ${process.pid}): Cavvy restarts when it's done.`);
            expect(info.updating).toBeUndefined();
            await Bun.sleep(300);
            expect(existsSync(runs)).toBe(false);
        } finally {
            closeSync(lock.fd);
        }
    });

    test("a checkout without the script can't update yet", async () => {
        const { work } = repos();
        record({ commit: sh(work, "rev-parse", "HEAD~1"), source: work });
        expect((await updates().u.update()).failed).toContain("has no scripts/update-desktop.ts");
    });
});

test("lastLogLine: the last line, escapes and redraws dropped", () => {
    const f = join(dir, "log");
    writeFileSync(f, "Fetching…\n\x1b[32mCompiling\x1b[0m a v1\r   Compiling b v2\n\n");
    expect(lastLogLine(f)).toBe("Compiling b v2");
    expect(lastLogLine(join(dir, "missing"))).toBe("");
});

test("capture: past its timeout it answers at once, even with a child still holding its output open", async () => {
    const started = Date.now();
    // The shell exits; the sleep it left behind keeps stderr open, as an ssh git started can.
    const r = await capture(["sh", "-c", "sleep 20 >&2 & exit 0"], dir, 300);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r).toMatchObject({ ok: false, timedOut: true });
    expect(r.err).toContain("took longer than");
    expect(await capture(["sh", "-c", "echo hi; echo oops >&2; exit 2"], dir, 5000)).toEqual({ ok: false, out: "hi", err: "oops" });
    expect(await capture(["no-such-command-here"], dir, 5000)).toMatchObject({ ok: false });
});

describe("the update lock: one update at a time, from the app or a terminal", () => {
    /** A stand-in update in a process of its own: it takes the lock, says how that went, and stays till told to go. */
    function contender() {
        mkdirSync(join(dir, "home"), { recursive: true });
        const probe = join(dir, "probe.ts");
        writeFileSync(probe, `import { lockUpdate } from ${JSON.stringify(join(import.meta.dir, "..", "src", "config", "desktop-install"))};
const lock = lockUpdate();
console.log("fd" in lock ? "locked" : "busy " + lock.holder);
for await (const _ of console) break;`);
        return Bun.spawn([process.execPath, probe], { stdin: "pipe", stdout: "pipe", env: { ...process.env } });
    }
    const said = async (p: Subprocess<"pipe", "pipe", "inherit">) => new TextDecoder().decode((await p.stdout.getReader().read()).value).trim();
    const go = (p: Subprocess<"pipe", "pipe", "inherit">) => {
        p.stdin.write("go\n");
        p.stdin.end();
        return p.exited;
    };

    test("held while its update runs, and another is told which holds it; free once it ends", async () => {
        const a = contender();
        try {
            expect(await said(a)).toBe("locked");
            expect(runningUpdate()).toEqual({ pid: a.pid });
            const b = contender();
            expect(await said(b)).toBe(`busy ${a.pid}`);
            await go(b);
        } finally {
            await go(a);
        }
        expect(runningUpdate()).toBeUndefined();
    });

    test("an update killed outright leaves no lock behind", async () => {
        const a = contender();
        expect(await said(a)).toBe("locked");
        a.kill("SIGKILL");
        await a.exited;
        expect(runningUpdate()).toBeUndefined();
        const lock = lockUpdate();
        if (!("fd" in lock)) throw new Error("the lock wasn't free");
        expect(readFileSync(updateLockPath(), "utf8").trim()).toBe(String(process.pid));
        expect(runningUpdate()).toEqual({ pid: process.pid });
        closeSync(lock.fd);
        expect(runningUpdate()).toBeUndefined();
    });
});

/** Whether any process is left in the group `pgid` leads. */
function groupAlive(pgid: number) {
    try {
        process.kill(-pgid, 0);
        return true;
    } catch {
        return false;
    }
}

describe("capUpdate", () => {
    /**
     * A stand-in update, started as the app starts one (leading a process group of its own): it takes the lock, starts
     * a step that would run 30s, starts its watcher, and leaves the lock to it. It says the step's pid, then stays till
     * told to go.
     */
    function update(seconds: number) {
        mkdirSync(join(dir, "home"), { recursive: true });
        const file = join(dir, "update.ts");
        writeFileSync(file, `import { closeSync } from "fs";
import { capUpdate, lockUpdate } from ${JSON.stringify(join(import.meta.dir, "..", "src", "config", "desktop-install"))};
const lock = lockUpdate();
if (!("fd" in lock)) throw new Error("the lock wasn't free");
const step = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
step.unref();
capUpdate(process.pid, ${seconds}, 1, lock.fd);
closeSync(lock.fd);
console.log(step.pid);
for await (const _ of console) break;`);
        const p = Bun.spawn([process.execPath, file], { stdin: "pipe", stdout: "pipe", detached: true, env: { ...process.env } });
        const step = (async () => Number(new TextDecoder().decode((await p.stdout.getReader().read()).value).trim()))();
        return { p, step };
    }
    const alive = (pid: number) => {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    };

    test("past its time the update is stopped, and all it started", async () => {
        const { p, step } = update(1);
        const pid = await step;
        expect(alive(pid)).toBe(true);
        const started = Date.now();
        await p.exited;
        expect(p.signalCode).toBe("SIGKILL");
        expect(Date.now() - started).toBeLessThan(5000);
        await until(() => !alive(pid) && !groupAlive(p.pid), 3000);
        await until(() => runningUpdate() === undefined, 3000);
    });

    test("when the update ends, a step it left running goes too; the watcher holds the lock till then", async () => {
        const { p, step } = update(3600);
        const pid = await step;
        // The update has let go of its own hold: the watcher's keeps it.
        expect(runningUpdate()).toBeDefined();
        p.stdin.write("go\n");
        p.stdin.end();
        await p.exited;
        expect(p.exitCode).toBe(0);
        await until(() => !alive(pid) && !groupAlive(p.pid), 5000);
        await until(() => runningUpdate() === undefined, 3000);
    });
});

describe("replaceBundle: the new app in place of the old, never a broken one in between", () => {
    /** A stand-in .app: a folder whose file says which build it is. */
    function bundle(path: string, build: string) {
        mkdirSync(join(path, "Contents"), { recursive: true });
        writeFileSync(join(path, "Contents", "build"), build);
    }
    const build = (app: string) => readFileSync(join(app, "Contents", "build"), "utf8");
    const copy = (from: string, to: string) => cpSync(from, to, { recursive: true });
    const apps = () => readdirSync(join(dir, "Applications")).sort();

    beforeEach(() => {
        mkdirSync(join(dir, "Applications"));
        bundle(join(dir, "built.app"), "new");
    });

    test("a swap that fails puts the installed app back at once", () => {
        const dest = join(dir, "Applications", "Cavvy.app");
        bundle(dest, "old");
        // A copy that leaves nothing to swap in.
        expect(() => replaceBundle(join(dir, "built.app"), dest, () => {})).toThrow();
        expect(build(dest)).toBe("old");
        expect(apps()).toEqual(["Cavvy.app"]);
    });

    test("in place of the installed one, or where there was none, leaving nothing beside it", () => {
        const dest = join(dir, "Applications", "Cavvy.app");
        replaceBundle(join(dir, "built.app"), dest, copy);
        expect(build(dest)).toBe("new");
        bundle(join(dir, "built.app"), "newer");
        replaceBundle(join(dir, "built.app"), dest, copy);
        expect(build(dest)).toBe("newer");
        expect(apps()).toEqual(["Cavvy.app"]);
    });

    test("a copy stopped part way leaves the installed app as it was, and the next install clears what it left", () => {
        const dest = join(dir, "Applications", "Cavvy.app");
        bundle(dest, "old");
        expect(() => replaceBundle(join(dir, "built.app"), dest, (_from, to) => {
            mkdirSync(to);
            throw new Error("stopped");
        })).toThrow("stopped");
        expect(build(dest)).toBe("old");
        replaceBundle(join(dir, "built.app"), dest, copy);
        expect(build(dest)).toBe("new");
        expect(apps()).toEqual(["Cavvy.app"]);
    });

    test("a swap stopped between its renames is put back first", () => {
        const dest = join(dir, "Applications", "Cavvy.app");
        // The old app moved aside, the new one never moved in.
        bundle(join(dir, "Applications", ".Cavvy.app.old"), "old");
        expect(existsSync(dest)).toBe(false);
        expect(() => replaceBundle(join(dir, "built.app"), dest, () => {
            throw new Error("copy failed");
        })).toThrow("copy failed");
        expect(build(dest)).toBe("old");
        expect(apps()).toEqual(["Cavvy.app"]);
    });
});
