// Where a server's build comes from when this Cavvy has no checkout to make one from: the builds a packed desktop
// app carries; and how two builds are put in order where no checkout can say (src/servers/build.ts).

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const build = await import("../src/servers/build");
const { bundledBuildsDir, bundledSource } = build;
const { ServerError } = await import("../src/servers/store");

const ID = "0123456789ab";
const SHA = "a".repeat(64);
const work = mkdtempSync(join(tmpdir(), "cavvy-builds-"));

afterAll(() => {
    rmSync(work, { recursive: true, force: true });
    iso.cleanup();
});

describe("which of two builds is the later, where no checkout can say", () => {
    const { compareBuilds } = build;
    // Two commits no checkout has: only the times they were made can order them.
    const mine = "0123456789ab";
    const theirs = "ba9876543210";
    test("the times the two commits were made order them, when both are known", () => {
        expect(compareBuilds(theirs, mine, undefined, { theirs: 100, mine: 200 })).toBe("older");
        expect(compareBuilds(theirs, mine, undefined, { theirs: 300, mine: 200 })).toBe("newer");
        expect(compareBuilds(theirs, mine, undefined, { theirs: 200, mine: 200 })).toBe("different");
        expect(compareBuilds(theirs, mine, undefined, { mine: 200 })).toBe("different");
        expect(compareBuilds(theirs, mine, undefined, { theirs: 100 })).toBe("different");
        expect(compareBuilds(theirs, mine, undefined)).toBe("different");
        expect(compareBuilds(mine, mine, undefined, { theirs: 100, mine: 200 })).toBe("same");
    });

    test("a checkout that has both commits and knows neither comes after the other says so, whatever the times", async () => {
        // A repository with two branches from one commit.
        const repo = mkdtempSync(join(work, "branches-"));
        const git = (...args: string[]) => {
            const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", HOME: work, GIT_CONFIG_NOSYSTEM: "1" } });
            if (r.exitCode !== 0) throw new Error(r.stderr.toString());
            return r.stdout.toString().trim();
        };
        git("init", "-q", "-b", "main");
        git("commit", "-q", "--allow-empty", "-m", "base");
        const base = git("rev-parse", "HEAD").slice(0, 12);
        git("checkout", "-q", "-b", "one");
        git("commit", "-q", "--allow-empty", "-m", "one");
        const one = git("rev-parse", "HEAD").slice(0, 12);
        git("checkout", "-q", "-b", "two", "main");
        git("commit", "-q", "--allow-empty", "-m", "two");
        const two = git("rev-parse", "HEAD").slice(0, 12);
        expect(compareBuilds(one, two, repo, { theirs: 100, mine: 200 })).toBe("different");
        expect(compareBuilds(one, two, repo, { theirs: 300, mine: 200 })).toBe("different");
        // What it can place by its history, it does, whatever the times say.
        expect(compareBuilds(base, two, repo, { theirs: 300, mine: 200 })).toBe("older");
        expect(compareBuilds(two, base, repo, { theirs: 100, mine: 200 })).toBe("newer");
        // A commit it doesn't have: the times are all there is.
        expect(compareBuilds(theirs, two, repo, { theirs: 100, mine: 200 })).toBe("older");
        expect(compareBuilds(theirs, two, repo)).toBe("different");
    });

    test("a build with changes on top of its commit is never placed", () => {
        expect(compareBuilds(`${theirs}-1a2b3c4d`, mine, undefined, { theirs: 100, mine: 200 })).toBe("different");
        expect(compareBuilds(theirs, `${mine}-1a2b3c4d`, undefined, { theirs: 100, mine: 200 })).toBe("different");
    });

    test("a source without a checkout passes the server's time on: one that runs a later build is left alone", () => {
        const dir = join(work, "ordered");
        mkdirSync(join(dir, "linux-arm64"), { recursive: true });
        writeFileSync(join(dir, "linux-arm64", "bundle.tar.gz"), "bundle");
        writeFileSync(join(dir, "linux-arm64", "bundle.json"), JSON.stringify({ id: mine, sha256: SHA, gui: true }));
        const source = build.bundledSource(dir, mine);
        const now = build.thisBuildTime()!;
        expect(typeof now).toBe("number");
        expect(source.compare(theirs, now + 60)).toBe("newer");
        expect(source.compare(theirs, now - 60)).toBe("older");
        expect(source.compare(theirs)).toBe("different");
    });
});

describe("the builds a packed desktop app carries", () => {
    const carried = (id: string, target = "linux-x64") => {
        const dir = join(work, `app-${id}`);
        mkdirSync(join(dir, target), { recursive: true });
        writeFileSync(join(dir, target, "bundle.tar.gz"), "bundle");
        writeFileSync(join(dir, target, "bundle.json"), JSON.stringify({ id, sha256: SHA, gui: true }));
        return dir;
    };

    test("this build's own are used as they are; another build's, or a kind of machine it has none for, aren't", async () => {
        const dir = carried(ID);
        const source = bundledSource(dir, ID);
        expect(source).toMatchObject({ id: ID, gui: true });
        expect(await source.build("linux-x64")).toEqual({ id: ID, target: "linux-x64", bundle: join(dir, "linux-x64", "bundle.tar.gz"), bundleBytes: 6, sha256: SHA, gui: true });
        await expect(source.build("linux-arm64")).rejects.toThrow("This copy of Cavvy came without a build for Linux arm64 servers.");
        await expect(source.build("linux-x64-baseline")).rejects.toThrow("This copy of Cavvy came without a build for Linux x64 servers.");
        // The x64 build an app carries is the one every x64 processor runs: a machine that could take the other gets it too.
        const packed = "ab0123456789";
        const app = bundledSource(carried(packed, "linux-x64-baseline"), packed);
        const every = join(work, `app-${packed}`, "linux-x64-baseline", "bundle.tar.gz");
        expect((await app.build("linux-x64-baseline")).bundle).toBe(every);
        expect(await app.build("linux-x64")).toMatchObject({ target: "linux-x64", sha256: SHA, bundle: every });
        await expect(app.build("linux-arm64")).rejects.toThrow("came without a build for Linux arm64");
        await expect(bundledSource(carried("ba9876543210"), ID).build("linux-x64")).rejects.toBeInstanceOf(ServerError);
        expect(source.compare(ID)).toBe("same");
        expect(source.compare("ba9876543210")).toBe("different");
    });

    test("a Mac's build isn't carried: on Apple silicon the app's own program is it, packed with the GUI beside it", async () => {
        const { appsOwn, appsOwnBuild } = build;
        const app = join(work, "Own.app");
        const program = join(app, "Contents", "MacOS", "cavvy");
        mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
        mkdirSync(join(app, "Contents", "Resources", "gui"), { recursive: true });
        const text = `#!/bin/sh\necho '{"version":"1.0.0","protocol":1,"build":"${ID}"}'\n`;
        writeFileSync(program, text);
        chmodSync(program, 0o755);
        writeFileSync(join(app, "Contents", "Resources", "gui", "index.html"), "<!doctype html>");
        // Only the server program of an app, on a Mac with Apple silicon.
        expect(appsOwn(program, "arm64", "darwin")).toEqual({ program, gui: join(app, "Contents", "Resources", "gui") });
        expect(appsOwn(program, "x64", "darwin")).toBeUndefined();
        expect(appsOwn(program, "arm64", "linux")).toBeUndefined();
        expect(appsOwn(join(app, "Contents", "MacOS", "cavvy-desktop"), "arm64", "darwin")).toBeUndefined();
        expect(appsOwn("/usr/local/bin/cavvy", "arm64", "darwin")).toBeUndefined();

        const steps: string[] = [];
        const own = appsOwn(program, "arm64", "darwin")!;
        const b = await appsOwnBuild(own, ID, { onStep: (t) => steps.push(t) });
        expect(steps).toEqual(["Packing Cavvy for macOS…"]);
        expect(b).toMatchObject({ id: ID, target: "darwin-arm64", gui: true, sha256: createHash("sha256").update(text).digest("hex") });
        // What a server unpacks: the program, and its GUI beside it.
        const out = mkdtempSync(join(work, "unpacked-"));
        expect(Bun.spawnSync(["tar", "-xzf", b.bundle, "-C", out]).exitCode).toBe(0);
        expect(readFileSync(join(out, "cavvy"), "utf-8")).toBe(text);
        expect(readFileSync(join(out, "gui", "index.html"), "utf-8")).toBe("<!doctype html>");
        // Packed once.
        const at = statSync(b.bundle).mtimeMs;
        expect((await appsOwnBuild(own, ID, { onStep: (t) => steps.push(t) })).bundle).toBe(b.bundle);
        expect(statSync(b.bundle).mtimeMs).toBe(at);
        expect(steps.length).toBe(1);
        // The app was replaced under this program: what's in it now is another build, and isn't sent as this one.
        await expect(appsOwnBuild(own, "ba9876543210")).rejects.toThrow("Cavvy was updated since it started. Quit and reopen it, then try again.");
        await expect(appsOwnBuild(own, "unknown-build")).rejects.toThrow("it doesn't know which build it is");
    });

    test("they're looked for in the app the program runs from", () => {
        const app = join(work, "Cavvy.app");
        mkdirSync(join(app, "Contents", "Resources", "server-builds"), { recursive: true });
        expect(bundledBuildsDir(join(app, "Contents", "MacOS", "cavvy"))).toBe(join(app, "Contents", "Resources", "server-builds"));
        expect(bundledBuildsDir(join(work, "Other.app", "Contents", "MacOS", "cavvy"))).toBeUndefined();
        expect(bundledBuildsDir("/usr/local/bin/cavvy")).toBeUndefined();
    });
});
