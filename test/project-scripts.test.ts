import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import type { ServerEvent } from "../src/server/protocol";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { deleteScript, findScript, forgetProjectKeys, listScripts, markUsed, projectFolder, projectKey, reorderScripts, saveScript, scriptsFile, validateScript } = await import("../src/server/scripts");
const { Terminals } = await import("../src/server/terminals");
const { gitArgv, gitEnv } = await import("../src/util/git");

afterAll(() => iso.cleanup());

function git(cwd: string, ...args: string[]) {
    const result = Bun.spawnSync(gitArgv(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Harness Test", "-c", "user.email=test@example.invalid", ...args]), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

/** A repository with one commit and a linked worktree beside it. */
function repoWithWorktree() {
    const base = realpathSync(tempDir("harness-scripts-repo-"));
    const main = join(base, "app");
    const linked = join(base, "app-feature");
    mkdirSync(join(main, "packages", "web"), { recursive: true });
    mkdirSync(join(main, "..tools"));
    writeFileSync(join(main, "packages", "web", "index.js"), "");
    git(main, "init", "-b", "main");
    git(main, "add", ".");
    git(main, "commit", "-m", "Initial commit");
    git(main, "worktree", "add", "-b", "feature", linked);
    return { main, linked };
}

const folder = () => realpathSync(tempDir("harness-scripts-dir-"));
const resetStore = () => rmSync(scriptsFile(), { force: true });

describe("validation", () => {
    test("trims and accepts a name, a one-line command and an optional icon", () => {
        expect(validateScript({ name: "  dev ", command: "  bun run dev\n", icon: "play" })).toEqual({ name: "dev", command: "bun run dev", icon: "play" });
        expect(validateScript({ name: "test", command: "npm test -- --watch=false && echo ok", icon: null })).toEqual({ name: "test", command: "npm test -- --watch=false && echo ok" });
        expect(validateScript({ name: "lint", command: "eslint .", icon: "" })).toEqual({ name: "lint", command: "eslint ." });
    });

    test("rejects bad names", () => {
        expect(() => validateScript({ name: "   ", command: "x" })).toThrow("Give the script a name");
        expect(() => validateScript({ name: 42, command: "x" })).toThrow("must be text");
        expect(() => validateScript({ name: "x".repeat(41), command: "x" })).toThrow("at most 40 characters");
        expect(() => validateScript({ name: "a\u0007b", command: "x" })).toThrow("control characters");
    });

    test("rejects bad commands: empty, several lines, control characters, too long", () => {
        expect(() => validateScript({ name: "a", command: " " })).toThrow("Enter the command");
        expect(() => validateScript({ name: "a", command: undefined })).toThrow("must be text");
        expect(() => validateScript({ name: "a", command: "echo one\necho two" })).toThrow("single line");
        expect(() => validateScript({ name: "a", command: "echo one\recho two" })).toThrow("single line");
        expect(() => validateScript({ name: "a", command: "echo one\u2028two" })).toThrow("single line");
        expect(() => validateScript({ name: "a", command: "echo\tone" })).toThrow("control characters");
        expect(() => validateScript({ name: "a", command: "printf \u001b[31m" })).toThrow("control characters");
        expect(() => validateScript({ name: "a", command: "echo \u0003" })).toThrow("control characters");
        expect(() => validateScript({ name: "a", command: "rm -rf \u202e/ fi" })).toThrow("control characters");
        expect(() => validateScript({ name: "a", command: "x".repeat(2001) })).toThrow("at most 2000 characters");
        expect(validateScript({ name: "a", command: "x".repeat(2000) }).command.length).toBe(2000);
    });

    test("rejects icons outside the fixed set", () => {
        expect(() => validateScript({ name: "a", command: "x", icon: "rocket" })).toThrow("Unknown script icon");
        expect(() => validateScript({ name: "a", command: "x", icon: 3 })).toThrow("Unknown script icon");
    });

    test("the project folder must be an existing absolute directory", async () => {
        await expect(projectFolder("relative/path")).rejects.toThrow("absolute path");
        await expect(projectFolder(undefined)).rejects.toThrow("absolute path");
        await expect(projectFolder(join(folder(), "gone"))).rejects.toThrow("no longer exists");
        const dir = folder();
        writeFileSync(join(dir, "file"), "");
        await expect(projectFolder(join(dir, "file"))).rejects.toThrow("no longer exists");
    });
});

describe("project keys", () => {
    test("a repository and its worktrees share the main checkout's key; a subfolder keeps its own", async () => {
        const { main, linked } = repoWithWorktree();
        expect(await projectKey(main)).toBe(main);
        expect(await projectKey(linked)).toBe(main);
        expect(await projectKey(join(main, "packages", "web"))).toBe(join(main, "packages", "web"));
        expect(await projectKey(join(linked, "packages", "web"))).toBe(join(main, "packages", "web"));
        // A folder whose name starts with two dots is still a subfolder, not the root.
        expect(await projectKey(join(main, "..tools"))).toBe(join(main, "..tools"));
    });

    test("outside git, the folder itself", async () => {
        const dir = folder();
        expect(await projectKey(dir)).toBe(dir);
    });

    test("a folder's key is looked up once for a little while, not on every request", async () => {
        const dir = folder();
        const first = projectKey(dir);
        expect(projectKey(dir)).toBe(first);
        expect(await first).toBe(dir);
        expect(projectKey(dir)).toBe(first);
        forgetProjectKeys();
        const again = projectKey(dir);
        expect(again).not.toBe(first);
        expect(await again).toBe(dir);
    });
});

describe("storage", () => {
    beforeAll(resetStore);

    test("scripts saved in a worktree show up in the main checkout and other worktrees, and nowhere else", async () => {
        resetStore();
        const { main, linked } = repoWithWorktree();
        const { script, project } = await saveScript(linked, { name: "dev", command: "bun run dev", icon: "play" });
        expect(project).toBe(main);
        expect(await listScripts(main)).toEqual({ project: main, scripts: [script] });
        expect((await listScripts(linked)).scripts).toEqual([script]);
        expect((await listScripts(folder())).scripts).toEqual([]);
        // Not in the repository: nothing under .harness/ in either checkout.
        expect(existsSync(join(main, ".harness"))).toBe(false);
        expect(existsSync(join(linked, ".harness"))).toBe(false);
    });

    test("create, update, delete; names are unique per project ignoring case", async () => {
        resetStore();
        const dir = folder();
        const dev = (await saveScript(dir, { name: "Dev", command: "bun run dev" })).script;
        const test = (await saveScript(dir, { name: "test", command: "bun test", icon: "test" })).script;
        await expect(saveScript(dir, { name: "dev", command: "other" })).rejects.toThrow("already has a script named “Dev”");
        await expect(saveScript(dir, { id: test.id, name: " DEV ", command: "bun test" })).rejects.toThrow("already has a script named");
        // Renaming a script to itself in another case is fine.
        const renamed = (await saveScript(dir, { id: dev.id, name: "dev", command: "bun run dev --port 4000", icon: "debug" })).script;
        expect(renamed).toEqual({ id: dev.id, name: "dev", command: "bun run dev --port 4000", icon: "debug" });
        expect((await listScripts(dir)).scripts).toEqual([renamed, test]);
        // The same name in another project is a different script.
        expect((await saveScript(folder(), { name: "dev", command: "make dev" })).script.name).toBe("dev");
        await deleteScript(dir, dev.id);
        expect((await listScripts(dir)).scripts).toEqual([test]);
        await expect(deleteScript(dir, dev.id)).rejects.toThrow("no longer exists");
        await expect(saveScript(dir, { id: dev.id, name: "dev", command: "x" })).rejects.toThrow("no longer exists");
        await expect(deleteScript(dir, "../../etc")).rejects.toThrow("Unknown script");
    });

    test("bad input never reaches the store", async () => {
        resetStore();
        const dir = folder();
        await expect(saveScript(dir, { name: "evil", command: "echo hi\nrm -rf ~" })).rejects.toThrow("single line");
        await expect(saveScript("not/absolute", { name: "a", command: "b" })).rejects.toThrow("absolute path");
        await expect(saveScript(dir, { name: "", command: "b" })).rejects.toThrow("name");
        expect(existsSync(scriptsFile())).toBe(false);
    });

    test("a project holds at most 50 scripts", async () => {
        resetStore();
        const dir = folder();
        for (let i = 0; i < 50; i++) await saveScript(dir, { name: `s${i}`, command: `echo ${i}` });
        await expect(saveScript(dir, { name: "one more", command: "echo" })).rejects.toThrow("at most 50 scripts");
        // Editing one still works at the cap.
        const first = (await listScripts(dir)).scripts[0]!;
        expect((await saveScript(dir, { id: first.id, name: "first", command: "echo first" })).script.name).toBe("first");
    });

    test("saves made at the same moment in one server are all kept", async () => {
        resetStore();
        const dir = folder();
        await Promise.all(Array.from({ length: 20 }, (_, i) => saveScript(dir, { name: `n${i}`, command: `echo ${i}` })));
        expect((await listScripts(dir)).scripts.length).toBe(20);
    });

    test("reorder takes every id once, or says the list changed", async () => {
        resetStore();
        const dir = folder();
        const [a, b, c] = [(await saveScript(dir, { name: "a", command: "echo a" })).script, (await saveScript(dir, { name: "b", command: "echo b" })).script, (await saveScript(dir, { name: "c", command: "echo c" })).script];
        expect((await reorderScripts(dir, [c.id, a.id, b.id])).scripts.map((s) => s.name)).toEqual(["c", "a", "b"]);
        expect((await listScripts(dir)).scripts.map((s) => s.name)).toEqual(["c", "a", "b"]);
        await expect(reorderScripts(dir, [a.id, b.id])).rejects.toThrow("changed in another window");
        await expect(reorderScripts(dir, [a.id, a.id, b.id])).rejects.toThrow("changed in another window");
        await expect(reorderScripts(dir, "nope")).rejects.toThrow("list of script ids");
    });

    test("the last script run is remembered until it's deleted", async () => {
        resetStore();
        const dir = folder();
        const a = await saveScript(dir, { name: "a", command: "echo a" });
        const b = await saveScript(dir, { name: "b", command: "echo b" });
        expect((await findScript(dir, b.script.id)).script).toEqual(b.script);
        await markUsed(b.project, b.script.id);
        expect((await listScripts(dir)).lastUsed).toBe(b.script.id);
        await deleteScript(dir, b.script.id);
        expect((await listScripts(dir)).lastUsed).toBeUndefined();
        await markUsed(a.project, "not-a-script");
        expect((await listScripts(dir)).lastUsed).toBeUndefined();
    });

    test("the store is private to the user and replaced whole", async () => {
        resetStore();
        await saveScript(folder(), { name: "a", command: "echo a" });
        expect(statSync(scriptsFile()).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(scriptsFile(), "utf-8")).version).toBe(1);
    });

    test("edits from two server processes at once are all kept", async () => {
        resetStore();
        const dir = folder();
        const writer = (n: number) => Bun.spawn([process.execPath, "-e", `
            const { saveScript } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/scripts.ts"))});
            for (let i = 0; i < 20; i++) await saveScript(${JSON.stringify(dir)}, { name: "p${n}-" + i, command: "echo " + i });
        `], { env: { ...process.env, HARNESS_HOME: iso.home }, stdout: "ignore", stderr: "pipe" });
        const procs = [writer(1), writer(2)];
        const codes = await Promise.all(procs.map((p) => p.exited));
        for (const p of procs) if (p.exitCode) throw new Error(await new Response(p.stderr).text());
        expect(codes).toEqual([0, 0]);
        expect((await listScripts(dir)).scripts.length).toBe(40);
        expect(existsSync(`${scriptsFile()}.lock`)).toBe(false);
    }, 20_000);

    test("a lock left by a process that died is taken over", async () => {
        resetStore();
        const lock = `${scriptsFile()}.lock`;
        writeFileSync(lock, "999999");
        const old = new Date(Date.now() - 60_000);
        utimesSync(lock, old, old);
        const dir = folder();
        await saveScript(dir, { name: "a", command: "echo a" });
        expect(existsSync(lock)).toBe(false);
        expect((await listScripts(dir)).scripts.map((s) => s.name)).toEqual(["a"]);
    });

    test("waiting for another process's lock doesn't hold up the server, and gives up after a while", async () => {
        resetStore();
        const lock = `${scriptsFile()}.lock`;
        const dir = folder();
        await saveScript(dir, { name: "a", command: "echo a" });
        writeFileSync(lock, "1");
        try {
            const started = Date.now();
            const waiting = saveScript(dir, { name: "b", command: "echo b" });
            // The call hands back at once; meanwhile timers run and other requests are answered.
            expect(Date.now() - started).toBeLessThan(500);
            let ticks = 0;
            const timer = setInterval(() => ticks++, 20);
            expect((await listScripts(dir)).scripts.map((s) => s.name)).toEqual(["a"]);
            await expect(waiting).rejects.toThrow("being saved by another Harness window");
            clearInterval(timer);
            expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
            expect(ticks).toBeGreaterThan(20);
        } finally {
            rmSync(lock, { force: true });
        }
        // Once it's released, a save goes through.
        await saveScript(dir, { name: "b", command: "echo b" });
        expect((await listScripts(dir)).scripts.map((s) => s.name)).toEqual(["a", "b"]);
    }, 10_000);

    test("a store that isn't valid JSON is reported, and left alone", async () => {
        writeFileSync(scriptsFile(), "{ not json");
        const dir = folder();
        await expect(listScripts(dir)).rejects.toThrow("isn't valid JSON");
        await expect(saveScript(dir, { name: "a", command: "echo a" })).rejects.toThrow("isn't valid JSON");
        expect(readFileSync(scriptsFile(), "utf-8")).toBe("{ not json");
        resetStore();
    });

    test("entries edited by hand that don't hold up are never offered to run", async () => {
        const dir = folder();
        const good = { id: "good-1", name: "ok", command: "echo ok" };
        writeFileSync(scriptsFile(), JSON.stringify({ version: 1, projects: { [dir]: { lastUsed: "bad-1", scripts: [
            good,
            { id: "bad-1", name: "two lines", command: "echo a\nrm -rf ~" },
            { id: "bad-2", name: "icon", command: "echo", icon: "rocket" },
            { id: "../x", name: "id", command: "echo" },
            { id: "good-2", name: "OK", command: "echo duplicate name" },
        ] } } }));
        expect(await listScripts(dir)).toEqual({ project: dir, scripts: [good] });
        await expect(findScript(dir, "bad-1")).rejects.toThrow("no longer exists");
        resetStore();
    });
});

describe("typed input in a new terminal", () => {
    const saved = { SHELL: process.env.SHELL, HOME: process.env.HOME };
    beforeAll(() => {
        process.env.SHELL = "/bin/sh";
        process.env.HOME = tempDir("harness-scripts-home-");
    });
    afterAll(() => {
        for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    });

    async function until(check: () => boolean) {
        const deadline = Date.now() + 8000;
        while (!check()) {
            if (Date.now() > deadline) throw new Error("Terminal timed out");
            await Bun.sleep(20);
        }
    }

    test("is typed once the shell is ready, runs, and leaves the shell open", async () => {
        const events: ServerEvent[] = [];
        const owner = { send: (e: ServerEvent) => events.push(e) };
        const output = () => events.filter((e) => e.type === "terminal.data").map((e) => (e as { data: string }).data).join("");
        const dir = folder();
        const shells = new Terminals();
        try {
            shells.open(owner, "script-1", dir, 90, 28, { input: "printf '__%s__\\n' ran; pwd\r" });
            await until(() => output().includes(`__ran__\r\n${dir}`));
            // Still a shell: another command runs in it.
            shells.write(owner, "script-1", "printf '__%s__\\n' again\n");
            await until(() => output().includes("__again__\r\n"));
            expect(output().split("__ran__").length).toBe(2);
            expect(events.some((e) => e.type === "terminal.exit")).toBe(false);
        } finally {
            shells.stop();
        }
    });

    test("Ctrl+C before the shell is ready means the command is never typed", async () => {
        const events: ServerEvent[] = [];
        const owner = { send: (e: ServerEvent) => events.push(e) };
        const output = () => events.filter((e) => e.type === "terminal.data").map((e) => (e as { data: string }).data).join("");
        const shells = new Terminals();
        try {
            shells.open(owner, "script-2", folder(), 90, 28, { input: "printf '__%s__\n' ran\r" });
            shells.write(owner, "script-2", "\x03");
            // Past the latest the command would have been typed.
            await Bun.sleep(3400);
            shells.write(owner, "script-2", "printf '__%s__\n' mine\n");
            await until(() => output().includes("__mine__\r\n"));
            expect(output()).not.toContain("__ran__");
        } finally {
            shells.stop();
        }
    }, 15_000);
});
