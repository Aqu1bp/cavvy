// The desktop app updating itself from main (src/server/app-update.ts): what a
// check finds against the install record, in real git repositories, and how a
// started update's state moves, with a stand-in update script.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AppUpdates, bundleOf, capture, lastLogLine } from "../src/server/app-update";
import { appSourceDir, installRecordPath } from "../src/config/desktop-install";
import type { AppUpdateInfo } from "../src/server/protocol";

let dir: string;
let savedHome: string | undefined;
const BUNDLE = "/Applications/Harness.app";

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

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-app-update-"));
    savedHome = process.env.HARNESS_HOME;
    process.env.HARNESS_HOME = join(dir, "home");
});

afterEach(() => {
    process.env.HARNESS_HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
});

describe("bundleOf", () => {
    test("the .app a program runs from", () => {
        expect(bundleOf("/Applications/Harness.app/Contents/MacOS/harness")).toBe("/Applications/Harness.app");
        expect(bundleOf("/Users/me/Applications/My Apps/Harness.app/Contents/MacOS/harness")).toBe("/Users/me/Applications/My Apps/Harness.app");
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
        record({ commit: head, source: work, app: "/Users/me/Applications/Harness.app" });
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

    test("installed: it waits for the restart, and says so if none comes", async () => {
        const { work } = repos();
        record({ commit: sh(work, "rev-parse", "HEAD~1"), source: work });
        script(work, `await Bun.write(process.env.HARNESS_HOME + "/desktop-install.json", JSON.stringify({ commit: "x", dirty: false, source: "s", installedAt: new Date().toISOString() }));`);
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
        script(work, `console.log("Harness is up to date with main.");`);
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
    const r = await capture(["sh", "-c", "sleep 20 >&2 & sleep 20"], dir, 300);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r).toMatchObject({ ok: false, timedOut: true });
    expect(r.err).toContain("took longer than");
    expect(await capture(["sh", "-c", "echo hi; echo oops >&2; exit 2"], dir, 5000)).toEqual({ ok: false, out: "hi", err: "oops" });
    expect(await capture(["no-such-command-here"], dir, 5000)).toMatchObject({ ok: false });
});
