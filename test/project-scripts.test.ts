import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import type { ServerEvent } from "../src/server/protocol";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { deleteScript, findScript, listScripts, markUsed, projectFolder, projectKey, reorderScripts, saveScript, scriptsFile, validateScript } = await import("../src/server/scripts");
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

    test("the project folder must be an existing absolute directory", () => {
        expect(() => projectFolder("relative/path")).toThrow("absolute path");
        expect(() => projectFolder(undefined)).toThrow("absolute path");
        expect(() => projectFolder(join(folder(), "gone"))).toThrow("no longer exists");
        const dir = folder();
        writeFileSync(join(dir, "file"), "");
        expect(() => projectFolder(join(dir, "file"))).toThrow("no longer exists");
    });
});

describe("project keys", () => {
    test("a repository and its worktrees share the main checkout's key; a subfolder keeps its own", () => {
        const { main, linked } = repoWithWorktree();
        expect(projectKey(main)).toBe(main);
        expect(projectKey(linked)).toBe(main);
        expect(projectKey(join(main, "packages", "web"))).toBe(join(main, "packages", "web"));
        expect(projectKey(join(linked, "packages", "web"))).toBe(join(main, "packages", "web"));
        // A folder whose name starts with two dots is still a subfolder, not the root.
        expect(projectKey(join(main, "..tools"))).toBe(join(main, "..tools"));
    });

    test("outside git, the folder itself", () => {
        const dir = folder();
        expect(projectKey(dir)).toBe(dir);
    });
});

describe("storage", () => {
    beforeAll(resetStore);

    test("scripts saved in a worktree show up in the main checkout and other worktrees, and nowhere else", () => {
        resetStore();
        const { main, linked } = repoWithWorktree();
        const { script, project } = saveScript(linked, { name: "dev", command: "bun run dev", icon: "play" });
        expect(project).toBe(main);
        expect(listScripts(main)).toEqual({ project: main, scripts: [script] });
        expect(listScripts(linked).scripts).toEqual([script]);
        expect(listScripts(folder()).scripts).toEqual([]);
        // Not in the repository: nothing under .harness/ in either checkout.
        expect(existsSync(join(main, ".harness"))).toBe(false);
        expect(existsSync(join(linked, ".harness"))).toBe(false);
    });

    test("create, update, delete; names are unique per project ignoring case", () => {
        resetStore();
        const dir = folder();
        const dev = saveScript(dir, { name: "Dev", command: "bun run dev" }).script;
        const test = saveScript(dir, { name: "test", command: "bun test", icon: "test" }).script;
        expect(() => saveScript(dir, { name: "dev", command: "other" })).toThrow("already has a script named “Dev”");
        expect(() => saveScript(dir, { id: test.id, name: " DEV ", command: "bun test" })).toThrow("already has a script named");
        // Renaming a script to itself in another case is fine.
        const renamed = saveScript(dir, { id: dev.id, name: "dev", command: "bun run dev --port 4000", icon: "debug" }).script;
        expect(renamed).toEqual({ id: dev.id, name: "dev", command: "bun run dev --port 4000", icon: "debug" });
        expect(listScripts(dir).scripts).toEqual([renamed, test]);
        // The same name in another project is a different script.
        expect(saveScript(folder(), { name: "dev", command: "make dev" }).script.name).toBe("dev");
        deleteScript(dir, dev.id);
        expect(listScripts(dir).scripts).toEqual([test]);
        expect(() => deleteScript(dir, dev.id)).toThrow("no longer exists");
        expect(() => saveScript(dir, { id: dev.id, name: "dev", command: "x" })).toThrow("no longer exists");
        expect(() => deleteScript(dir, "../../etc")).toThrow("Unknown script");
    });

    test("bad input never reaches the store", () => {
        resetStore();
        const dir = folder();
        expect(() => saveScript(dir, { name: "evil", command: "echo hi\nrm -rf ~" })).toThrow("single line");
        expect(() => saveScript("not/absolute", { name: "a", command: "b" })).toThrow("absolute path");
        expect(() => saveScript(dir, { name: "", command: "b" })).toThrow("name");
        expect(existsSync(scriptsFile())).toBe(false);
    });

    test("a project holds at most 50 scripts", () => {
        resetStore();
        const dir = folder();
        for (let i = 0; i < 50; i++) saveScript(dir, { name: `s${i}`, command: `echo ${i}` });
        expect(() => saveScript(dir, { name: "one more", command: "echo" })).toThrow("at most 50 scripts");
        // Editing one still works at the cap.
        const first = listScripts(dir).scripts[0]!;
        expect(saveScript(dir, { id: first.id, name: "first", command: "echo first" }).script.name).toBe("first");
    });

    test("reorder takes every id once, or says the list changed", () => {
        resetStore();
        const dir = folder();
        const [a, b, c] = ["a", "b", "c"].map((name) => saveScript(dir, { name, command: `echo ${name}` }).script);
        expect(reorderScripts(dir, [c!.id, a!.id, b!.id]).scripts.map((s) => s.name)).toEqual(["c", "a", "b"]);
        expect(listScripts(dir).scripts.map((s) => s.name)).toEqual(["c", "a", "b"]);
        expect(() => reorderScripts(dir, [a!.id, b!.id])).toThrow("changed in another window");
        expect(() => reorderScripts(dir, [a!.id, a!.id, b!.id])).toThrow("changed in another window");
        expect(() => reorderScripts(dir, "nope")).toThrow("list of script ids");
    });

    test("the last script run is remembered until it's deleted", () => {
        resetStore();
        const dir = folder();
        const a = saveScript(dir, { name: "a", command: "echo a" });
        const b = saveScript(dir, { name: "b", command: "echo b" });
        expect(findScript(dir, b.script.id).script).toEqual(b.script);
        markUsed(b.project, b.script.id);
        expect(listScripts(dir).lastUsed).toBe(b.script.id);
        deleteScript(dir, b.script.id);
        expect(listScripts(dir).lastUsed).toBeUndefined();
        markUsed(a.project, "not-a-script");
        expect(listScripts(dir).lastUsed).toBeUndefined();
    });

    test("the store is private to the user and replaced whole", () => {
        resetStore();
        saveScript(folder(), { name: "a", command: "echo a" });
        expect(statSync(scriptsFile()).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(scriptsFile(), "utf-8")).version).toBe(1);
    });

    test("edits from two server processes at once are all kept", async () => {
        resetStore();
        const dir = folder();
        const writer = (n: number) => Bun.spawn([process.execPath, "-e", `
            const { saveScript } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/scripts.ts"))});
            for (let i = 0; i < 20; i++) saveScript(${JSON.stringify(dir)}, { name: "p${n}-" + i, command: "echo " + i });
        `], { env: { ...process.env, HARNESS_HOME: iso.home }, stdout: "ignore", stderr: "pipe" });
        const procs = [writer(1), writer(2)];
        const codes = await Promise.all(procs.map((p) => p.exited));
        for (const p of procs) if (p.exitCode) throw new Error(await new Response(p.stderr).text());
        expect(codes).toEqual([0, 0]);
        expect(listScripts(dir).scripts.length).toBe(40);
        expect(existsSync(`${scriptsFile()}.lock`)).toBe(false);
    }, 20_000);

    test("a lock left by a process that died is taken over; a live one makes a save wait, then give up", () => {
        resetStore();
        const lock = `${scriptsFile()}.lock`;
        writeFileSync(lock, "999999");
        const old = new Date(Date.now() - 60_000);
        utimesSync(lock, old, old);
        const dir = folder();
        saveScript(dir, { name: "a", command: "echo a" });
        expect(existsSync(lock)).toBe(false);
        writeFileSync(lock, String(process.pid));
        try {
            expect(() => saveScript(dir, { name: "b", command: "echo b" })).toThrow("being saved by another Harness window");
        } finally {
            rmSync(lock, { force: true });
        }
        expect(listScripts(dir).scripts.map((s) => s.name)).toEqual(["a"]);
    });

    test("a store that isn't valid JSON is reported, and left alone", () => {
        writeFileSync(scriptsFile(), "{ not json");
        const dir = folder();
        expect(() => listScripts(dir)).toThrow("isn't valid JSON");
        expect(() => saveScript(dir, { name: "a", command: "echo a" })).toThrow("isn't valid JSON");
        expect(readFileSync(scriptsFile(), "utf-8")).toBe("{ not json");
        resetStore();
    });

    test("entries edited by hand that don't hold up are never offered to run", () => {
        const dir = folder();
        const good = { id: "good-1", name: "ok", command: "echo ok" };
        writeFileSync(scriptsFile(), JSON.stringify({ version: 1, projects: { [dir]: { lastUsed: "bad-1", scripts: [
            good,
            { id: "bad-1", name: "two lines", command: "echo a\nrm -rf ~" },
            { id: "bad-2", name: "icon", command: "echo", icon: "rocket" },
            { id: "../x", name: "id", command: "echo" },
            { id: "good-2", name: "OK", command: "echo duplicate name" },
        ] } } }));
        expect(listScripts(dir)).toEqual({ project: dir, scripts: [good] });
        expect(() => findScript(dir, "bad-1")).toThrow("no longer exists");
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
