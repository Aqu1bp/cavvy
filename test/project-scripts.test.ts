import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import type { ServerEvent } from "../src/server/protocol";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { deleteScript, findScript, forgetProjectKeys, listScripts, lockFiles, markUsed, projectFolder, projectKey, updateProject, reorderScripts, saveScript, scriptsFile, validateScript } = await import("../src/server/scripts");
const { Terminals, Typist, isTerminalReply } = await import("../src/server/terminals");
const { EarlyInput } = await import("../gui/src/lib/terminal");
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
            { id: "twin-1", name: "twin", command: "echo one" },
            { id: "twin-2", name: "TWIN", command: "echo two" },
        ] } } }));
        expect(await listScripts(dir)).toEqual({ project: dir, scripts: [good], setAside: { count: 5, file: scriptsFile() } });
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
            shells.arm(owner, "script-1");
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

    test("Ctrl+C before the window arms it means the command is never typed", async () => {
        const events: ServerEvent[] = [];
        const owner = { send: (e: ServerEvent) => events.push(e) };
        const output = () => events.filter((e) => e.type === "terminal.data").map((e) => (e as { data: string }).data).join("");
        const shells = new Terminals();
        try {
            shells.open(owner, "script-2", folder(), 90, 28, { input: "printf '__%s__\n' ran\r" });
            shells.write(owner, "script-2", "\x03");
            shells.arm(owner, "script-2");
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

describe("a store this Harness doesn't fully understand", () => {
    const write = (data: unknown) => writeFileSync(scriptsFile(), typeof data === "string" ? data : JSON.stringify(data, null, 2));
    const file = () => JSON.parse(readFileSync(scriptsFile(), "utf-8"));
    afterAll(resetStore);

    test("entries it can't use are kept as they are through a save, an edit, a reorder, a delete and a run", async () => {
        const dir = folder();
        const other = folder();
        const good = { id: "good-1", name: "ok", command: "echo ok", future: { colour: "teal" } };
        const kept = [
            { id: "bad-icon", name: "rocket", command: "echo", icon: "rocket" },
            { id: "bad-lines", name: "two lines", command: "echo a\nrm -rf ~" },
            { id: "dup-name", name: "Rocket", command: "echo duplicate name" },
            "not even an object",
        ];
        const otherEntry = { scripts: [{ id: "x-1", name: "x", command: "echo x", icon: "rocket" }], pinnedBy: "another Harness" };
        write({ version: 1, note: "top-level field", projects: { [dir]: { scripts: [good, ...kept], lastUsed: "bad-icon", sortBy: "name" }, [other]: otherEntry } });
        expect((await listScripts(dir)).scripts.map((s) => s.id)).toEqual(["good-1"]);
        await expect(findScript(dir, "bad-icon")).rejects.toThrow("no longer exists");

        // A run: nothing is rewritten in a project with entries kept aside.
        const before = readFileSync(scriptsFile(), "utf-8");
        const { project } = await findScript(dir, "good-1");
        await markUsed(project, "good-1");
        expect(readFileSync(scriptsFile(), "utf-8")).toBe(before);

        const added = (await saveScript(dir, { name: "new", command: "echo new" })).script;
        await saveScript(dir, { id: "good-1", name: "ok", command: "echo edited" });
        await reorderScripts(dir, [added.id, "good-1"]);
        let f = file();
        expect(f.note).toBe("top-level field");
        expect(f.projects[other]).toEqual(otherEntry);
        expect(f.projects[dir].sortBy).toBe("name");
        expect(f.projects[dir].lastUsed).toBe("bad-icon");
        // The usable scripts swap places (first and last); the kept entries stay where they were, unchanged.
        const edited = { ...good, command: "echo edited" };
        expect(f.projects[dir].scripts).toEqual([added, ...kept, edited]);
        await deleteScript(dir, added.id);
        f = file();
        expect(f.projects[dir].scripts).toEqual([...kept, edited]);
        // A save in another project leaves this one exactly as it was.
        const snapshot = file().projects[dir];
        await saveScript(folder(), { name: "elsewhere", command: "true" });
        expect(file().projects[dir]).toEqual(snapshot);
        expect(file().projects[other]).toEqual(otherEntry);
    });

    for (const [what, data, message] of [
        ["projects is null", { version: 1, projects: null }, "isn't in a form this Harness understands"],
        ["projects is a list", { version: 1, projects: [] }, "isn't in a form this Harness understands"],
        ["no version", { projects: {} }, "isn't in a form this Harness understands"],
        ["it's a list", [], "isn't in a form this Harness understands"],
        ["a newer Harness wrote it", { version: 2, projects: { "/somewhere": { scripts: [{ id: "a", name: "a", command: "a", runIn: "docker" }] } } }, "written by a newer Harness (format 2)"],
    ] as const) {
        test(`${what}: reported, and neither a save nor a run writes it`, async () => {
            const dir = folder();
            write(data);
            const before = readFileSync(scriptsFile(), "utf-8");
            await expect(listScripts(dir)).rejects.toThrow(message);
            await expect(saveScript(dir, { name: "a", command: "echo a" })).rejects.toThrow(message);
            await expect(findScript(dir, "a")).rejects.toThrow(message);
            await expect(markUsed(dir, "a")).rejects.toThrow(message);
            expect(readFileSync(scriptsFile(), "utf-8")).toBe(before);
            await expect(listScripts(dir)).rejects.toThrow(scriptsFile());
        });
    }

    test("one project's entry in the wrong shape: that project is refused, others still work and it's kept", async () => {
        const broken = folder();
        const fine = folder();
        const entry = { scripts: "dev: bun run dev" };
        write({ version: 1, projects: { [broken]: entry } });
        await expect(listScripts(broken)).rejects.toThrow("This project's entry");
        await expect(saveScript(broken, { name: "a", command: "echo a" })).rejects.toThrow("This project's entry");
        await saveScript(fine, { name: "a", command: "echo a" });
        expect(file().projects[broken]).toEqual(entry);
    });

    test("more than 50 scripts: all are kept and shown; none can be added, but they can be edited and run", async () => {
        const dir = folder();
        const scripts = Array.from({ length: 60 }, (_, i) => ({ id: `s-${i}`, name: `s${i}`, command: `echo ${i}` }));
        write({ version: 1, projects: { [dir]: { scripts } } });
        expect((await listScripts(dir)).scripts.length).toBe(60);
        await expect(saveScript(dir, { name: "one more", command: "echo" })).rejects.toThrow("at most 50 scripts");
        await saveScript(dir, { id: "s-59", name: "last", command: "echo last" });
        await markUsed(dir, "s-59");
        const f = file();
        expect(f.projects[dir].scripts.length).toBe(60);
        expect(f.projects[dir].scripts[59]).toEqual({ id: "s-59", name: "last", command: "echo last" });
        expect(f.projects[dir].lastUsed).toBe("s-59");
    });
});

describe("whose scripts a folder gets", () => {
    test("a .git symlinked to another repository's doesn't make a folder part of it", async () => {
        const { main } = repoWithWorktree();
        const fake = folder();
        symlinkSync(join(main, ".git"), join(fake, ".git"));
        forgetProjectKeys();
        expect(await projectKey(fake)).toBe(fake);
    });

    test("nor does a .git file naming another repository's worktree; the real worktree still shares", async () => {
        const { main, linked } = repoWithWorktree();
        const fake = folder();
        writeFileSync(join(fake, ".git"), `gitdir: ${join(main, ".git", "worktrees", "app-feature")}\n`);
        forgetProjectKeys();
        expect(await projectKey(fake)).toBe(fake);
        expect(await projectKey(linked)).toBe(main);
        await saveScript(main, { name: "dev", command: "bun run dev" });
        expect((await listScripts(fake)).scripts).toEqual([]);
        resetStore();
    });
});

describe("when git fails", () => {
    const savedPath = process.env.PATH;
    afterAll(() => {
        process.env.PATH = savedPath;
        forgetProjectKeys();
    });
    /** `git` on PATH is this script. */
    function fakeGit(body: string) {
        const bin = tempDir("harness-fake-git-");
        writeFileSync(join(bin, "git"), `#!/bin/sh\n${body}\n`);
        chmodSync(join(bin, "git"), 0o755);
        process.env.PATH = `${bin}:${savedPath}`;
        forgetProjectKeys();
    }

    test("a failure that isn't 'not a repository' is reported, and not kept", async () => {
        const { main, linked } = repoWithWorktree();
        fakeGit(`printf "fatal: detected dubious ownership in repository at '%s'\\nTo add an exception for this directory, call:\\n\\n\\tgit config --global --add safe.directory %s\\n" "$PWD" "$PWD" >&2; exit 128`);
        try {
            await expect(listScripts(linked)).rejects.toThrow(/Couldn't tell which repository .* belongs to.*refuses to read the repository at .* because it belongs to another user/);
            await expect(saveScript(linked, { name: "dev", command: "x" })).rejects.toThrow(`run: git config --global --add safe.directory '${linked}'`);
        } finally {
            process.env.PATH = savedPath;
        }
        // Not cached: with git working again, the worktree shares the main checkout's list.
        expect((await listScripts(linked)).project).toBe(main);
    });

    test("git stopped by a signal is reported", async () => {
        const { linked } = repoWithWorktree();
        fakeGit("kill -TERM $$");
        try {
            await expect(listScripts(linked)).rejects.toThrow("git was stopped (SIGTERM)");
        } finally {
            process.env.PATH = savedPath;
        }
    });

    test("git that doesn't answer in time is reported", async () => {
        const { linked } = repoWithWorktree();
        fakeGit("exec sleep 10");
        try {
            const started = Date.now();
            await expect(listScripts(linked)).rejects.toThrow("git didn't answer within 3 s");
            expect(Date.now() - started).toBeLessThan(6000);
        } finally {
            process.env.PATH = savedPath;
        }
    }, 15_000);

    test("no git at all: the folder is its own project", async () => {
        const { linked } = repoWithWorktree();
        process.env.PATH = tempDir("harness-no-git-");
        forgetProjectKeys();
        try {
            expect((await listScripts(linked)).project).toBe(linked);
        } finally {
            process.env.PATH = savedPath;
            forgetProjectKeys();
        }
    });
});

describe("the store's lock", () => {
    const lock = () => `${scriptsFile()}.lock`;
    afterAll(() => rmSync(lock(), { force: true }));

    test("held by a live process, it isn't taken from it, even after 10 s", async () => {
        resetStore();
        writeFileSync(lock(), String(process.pid));
        const old = new Date(Date.now() - 10_000);
        utimesSync(lock(), old, old);
        try {
            await expect(saveScript(folder(), { name: "a", command: "echo a" })).rejects.toThrow("being saved by another Harness window");
            expect(readFileSync(lock(), "utf-8")).toBe(String(process.pid));
        } finally {
            rmSync(lock(), { force: true });
        }
    }, 10_000);

    test("left by a process that has gone, it's taken over at once, however new", async () => {
        resetStore();
        const dead = Bun.spawn(["true"]);
        await dead.exited;
        writeFileSync(lock(), String(dead.pid));
        const started = Date.now();
        await saveScript(folder(), { name: "a", command: "echo a" });
        expect(Date.now() - started).toBeLessThan(1000);
        expect(existsSync(lock())).toBe(false);
    });
});

describe("telling the user's input from the terminal's replies", () => {
    test("xterm.js's own replies are recognised, alone or several together", () => {
        for (const reply of ["\x1b[?1;2c", "\x1b[?6c", "\x1b[>0;276;0c", "\x1b[0n", "\x1b[12;40R", "\x1b[?12;40R", "\x1b[?2004;1$y", "\x1b[4;2$y", "\x1b[I", "\x1b[O", "\x1b[8;24;80t", "\x1b[4;600;800t", "\x1b[6;17;8t", "\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\", "\x1b]10;rgb:ffff/ffff/ffff\x07", "\x1bP1$r0m\x1b\\", "\x1bP0\x1b\\", "\x1b[?1;2c\x1b[12;1R"]) {
            expect(isTerminalReply(reply)).toBe(true);
        }
    });

    test("keys, Escape, Alt+key, arrows, paste and mouse are the user", () => {
        for (const input of ["a", "\x03", "\x04", "\r", "\x1b", "\x1bb", "\x1b[A", "\x1bOA", "\x1b[1;5C", "\x1b[15~", "\x1b[200~ls\x1b[201~", "\x1b[<0;10;5M", "\x1b[?1;2cx", ""]) {
            expect(isTerminalReply(input)).toBe(false);
        }
    });

    test("what's typed while the shell opens is held and sent once, in order; dropped if it fails", () => {
        const early = new EarlyInput();
        expect(early.hold("x")).toBe(false);
        early.begin();
        expect(early.hold("\x03")).toBe(true);
        expect(early.hold("ls")).toBe(true);
        expect(early.take()).toBe("\x03ls");
        expect(early.hold("after")).toBe(false);
        expect(early.take()).toBe("");
        // A big paste is the user typing too: all of it goes, not nothing.
        early.begin();
        expect(early.hold("x".repeat(200_000))).toBe(true);
        expect(early.take().length).toBe(200_000);
    });
});

describe("typing into a shell once it's reading", () => {
    const saved = { SHELL: process.env.SHELL, HOME: process.env.HOME, ZDOTDIR: process.env.ZDOTDIR };
    beforeAll(() => {
        process.env.SHELL = "/bin/sh";
        process.env.HOME = tempDir("harness-scripts-home-");
    });
    afterAll(() => {
        for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    });
    async function until(check: () => boolean, ms = 8000) {
        const deadline = Date.now() + ms;
        while (!check()) {
            if (Date.now() > deadline) throw new Error("Terminal timed out");
            await Bun.sleep(20);
        }
    }
    function shell() {
        const events: ServerEvent[] = [];
        const owner = { send: (e: ServerEvent) => events.push(e) };
        const output = () => events.filter((e) => e.type === "terminal.data").map((e) => (e as { data: string }).data).join("");
        return { owner, output };
    }
    const COMMAND = "printf '__%s__\\n' ran\r";

    test("an arrow key or a paste before then means the command is never typed", async () => {
        const shells = new Terminals();
        const arrow = shell();
        const paste = shell();
        try {
            shells.open(arrow.owner, "arrow", folder(), 90, 28, { input: COMMAND });
            shells.open(paste.owner, "paste", folder(), 90, 28, { input: COMMAND });
            shells.write(arrow.owner, "arrow", "\x1b[A");
            shells.write(paste.owner, "paste", "\x1b[200~echo pasted\x1b[201~");
            shells.arm(arrow.owner, "arrow");
            shells.arm(paste.owner, "paste");
            // Past the latest the command would have been typed.
            await Bun.sleep(3400);
            expect(arrow.output()).not.toContain("__ran__");
            expect(paste.output()).not.toContain("__ran__");
        } finally {
            shells.stop();
        }
    }, 15_000);

    test.skipIf(!existsSync("/bin/zsh"))("the terminal answering the shell's query before then doesn't stop the command being typed", async () => {
        const zdot = tempDir("harness-zdotdir-");
        // As a prompt theme does: ask the terminal, and read its answer.
        writeFileSync(join(zdot, ".zshrc"), "print -n '\\e[c'; read -rs -d c reply; print __got_reply__; PS1='READY> '\n");
        process.env.SHELL = "/bin/zsh";
        process.env.ZDOTDIR = zdot;
        const shells = new Terminals();
        const t = shell();
        try {
            shells.open(t.owner, "reply", folder(), 90, 28, { input: COMMAND });
            shells.arm(t.owner, "reply");
            // The window's reply, as xterm.js sends it.
            await until(() => t.output().includes("\x1b[c"));
            shells.write(t.owner, "reply", "\x1b[?1;2c");
            await until(() => t.output().includes("__ran__\r\n"));
            expect(t.output()).toContain("__got_reply__");
        } finally {
            shells.stop();
            process.env.SHELL = "/bin/sh";
            delete process.env.ZDOTDIR;
        }
    }, 15_000);

    test.skipIf(!existsSync("/bin/zsh"))("zsh: typed only when its line editor starts reading, after slow rc files, and echoed once", async () => {
        const zdot = tempDir("harness-zdotdir-");
        // A banner, then slow, silent work: quiet output that isn't a shell reading yet.
        writeFileSync(join(zdot, ".zshrc"), "print __banner__\nsleep 1\nPS1='READY> '\n");
        process.env.SHELL = "/bin/zsh";
        process.env.ZDOTDIR = zdot;
        const shells = new Terminals();
        const t = shell();
        try {
            shells.open(t.owner, "zsh", folder(), 90, 28, { input: COMMAND });
            shells.arm(t.owner, "zsh");
            await until(() => t.output().includes("__ran__\r\n"));
            const out = t.output();
            const typed = out.indexOf("printf '__%s__\\n' ran");
            expect(out.indexOf("__banner__")).toBeLessThan(typed);
            expect(out.indexOf("READY> ")).toBeGreaterThan(-1);
            expect(out.indexOf("READY> ")).toBeLessThan(typed);
            expect(out.split("printf '__%s__\\n' ran").length).toBe(2);
        } finally {
            shells.stop();
            process.env.SHELL = "/bin/sh";
            delete process.env.ZDOTDIR;
        }
    }, 15_000);
});

describe("second review", () => {
    afterAll(resetStore);
    const write = (data: unknown) => writeFileSync(scriptsFile(), JSON.stringify(data, null, 2));
    const file = () => JSON.parse(readFileSync(scriptsFile(), "utf-8"));

    test("a .git symlinked to a real worktree's .git file doesn't make a folder that worktree", async () => {
        const { main, linked } = repoWithWorktree();
        const fake = folder();
        symlinkSync(join(linked, ".git"), join(fake, ".git"));
        forgetProjectKeys();
        expect(await projectKey(fake)).toBe(fake);
        expect(await projectKey(linked)).toBe(main);
    });

    test("what an id runs never changes: entries sharing an id or a name are all set aside, whatever their order", async () => {
        const dir = folder();
        const approved = { id: "a", name: "approved", command: "echo approved" };
        const hidden = { id: "a", name: "hidden", command: "echo hidden" };
        const b = { id: "b", name: "b", command: "echo b" };
        const dev1 = { id: "d1", name: "dev", command: "echo one" };
        const dev2 = { id: "d2", name: "DEV ", command: "echo two" };
        write({ version: 1, projects: { [dir]: { scripts: [approved, hidden, b, dev1, dev2] } } });
        const listed = await listScripts(dir);
        expect(listed.scripts.map((s) => s.id)).toEqual(["b"]);
        expect(listed.setAside).toEqual({ count: 4, file: scriptsFile() });
        const runs = async (id: string) => (await findScript(dir, id)).script.command;
        await expect(runs("a")).rejects.toThrow("no longer exists");
        await expect(runs("d1")).rejects.toThrow("no longer exists");

        // A reorder, a save and a delete of other scripts: still nothing runs as "a"; b still runs its own command.
        await reorderScripts(dir, ["b"]);
        const c = (await saveScript(dir, { name: "c", command: "echo c" })).script;
        await reorderScripts(dir, [c.id, "b"]);
        expect(file().projects[dir].scripts).toEqual([approved, hidden, c, dev1, dev2, b]);
        await expect(runs("a")).rejects.toThrow("no longer exists");
        expect(await runs("b")).toBe("echo b");
        await deleteScript(dir, c.id);
        await expect(runs("a")).rejects.toThrow("no longer exists");
        expect(await runs("b")).toBe("echo b");
        expect(file().projects[dir].scripts).toEqual([approved, hidden, dev1, dev2, b]);
    });

    test("a create or a rename can't take a name set aside, so a save never makes the user's script vanish", async () => {
        const dir = folder();
        write({ version: 1, projects: { [dir]: { scripts: [{ id: "x", name: "dev", command: "echo", icon: "rocket" }, { id: "y", name: "ok", command: "echo ok" }] } } });
        await expect(saveScript(dir, { name: "Dev", command: "bun run dev" })).rejects.toThrow("has been set aside");
        await expect(saveScript(dir, { id: "y", name: "DEV", command: "echo ok" })).rejects.toThrow("has been set aside");
        expect((await listScripts(dir)).scripts.map((s) => s.name)).toEqual(["ok"]);
        expect((await saveScript(dir, { name: "dev2", command: "bun run dev" })).script.name).toBe("dev2");
    });

    test("an owner whose lock was taken over between its read and its write writes nothing; the new owner's save stays", async () => {
        resetStore();
        const dir = folder();
        await saveScript(dir, { name: "original", command: "echo original" });
        const lock = `${scriptsFile()}.lock`;
        const theirs = { version: 1, projects: { [dir]: { scripts: [{ id: "new-owner", name: "theirs", command: "echo theirs" }] } } };
        try {
            await expect(updateProject(dir, (p) => {
                // Meanwhile (this process stopped, say), another took the lock over and saved.
                rmSync(lock);
                writeFileSync(lock, "1");
                write(theirs);
                p.items = [];
                return true;
            })).rejects.toThrow("being saved by another Harness window");
            expect(file()).toEqual(theirs);
            // And its lock is left alone.
            expect(readFileSync(lock, "utf-8")).toBe("1");
        } finally {
            rmSync(lock, { force: true });
        }
    });

    test("the lock is never seen without a pid in it", async () => {
        resetStore();
        const dir = folder();
        const lock = `${scriptsFile()}.lock`;
        // Another process watches the lock as fast as it can while this one saves.
        const watcher = Bun.spawn([process.execPath, "-e", `
            const { readFileSync } = require("fs");
            let seen = 0, empty = 0;
            const end = Date.now() + 1500;
            while (Date.now() < end) {
                let body;
                try { body = readFileSync(${JSON.stringify(lock)}, "utf-8"); } catch { continue; }
                seen++;
                if (!/^\\d+$/.test(body)) empty++;
            }
            console.log(JSON.stringify({ seen, empty }));
        `], { stdout: "pipe" });
        const end = Date.now() + 1400;
        for (let i = 0; Date.now() < end; i++) {
            const { script } = await saveScript(dir, { name: `n${i}`, command: "true" });
            await deleteScript(dir, script.id);
        }
        const result = JSON.parse(await new Response(watcher.stdout).text());
        expect(result.seen).toBeGreaterThan(0);
        expect(result.empty).toBe(0);
    }, 10_000);
});

describe("arming, and when typing happens", () => {
    /** Timers run only when the test says. */
    function timers() {
        const due: { ms: number; fn: () => void; live: boolean }[] = [];
        const after = (ms: number, fn: () => void) => {
            const t = { ms, fn, live: true };
            due.push(t);
            return () => void (t.live = false);
        };
        const run = (upTo = Infinity) => {
            for (const t of [...due]) if (t.live && t.ms <= upTo) (t.live = false), t.fn();
        };
        return { after, run };
    }
    const READING = "\x1b[?2004h";

    test("nothing is typed until it's armed, even once the shell is reading, nor after the fallback", () => {
        const t = timers();
        const typed: string[] = [];
        const typist = new Typist("cmd\r", true, (x) => typed.push(x), t.after);
        typist.output(READING);
        t.run();
        expect(typed).toEqual([]);
        typist.arm();
        expect(typed).toEqual(["cmd\r"]);
    });

    test("zsh: reading, once seen, stays seen whatever output follows", () => {
        const t = timers();
        const typed: string[] = [];
        const typist = new Typist("cmd\r", true, (x) => typed.push(x), t.after);
        typist.output("banner\r\n" + READING.slice(0, 4));
        typist.output(READING.slice(4) + "prompt");
        typist.output("more output, before any timer runs");
        typist.arm();
        expect(typed).toEqual(["cmd\r"]);
    });

    test("zsh: without reading, nothing but the fallback types it, and only once armed", () => {
        const t = timers();
        const typed: string[] = [];
        const typist = new Typist("cmd\r", true, (x) => typed.push(x), t.after);
        typist.output("banner, then silence");
        t.run(150);
        expect(typed).toEqual([]);
        typist.arm();
        expect(typed).toEqual([]);
        t.run(3000);
        expect(typed).toEqual(["cmd\r"]);
    });

    test("other shells: quiet output counts as reading; cancelled, it's never typed", () => {
        const t = timers();
        const typed: string[] = [];
        const typist = new Typist("cmd\r", false, (x) => typed.push(x), t.after);
        typist.output("$ ");
        typist.arm();
        t.run(150);
        expect(typed).toEqual(["cmd\r"]);
        const cancelled = new Typist("cmd\r", false, (x) => typed.push(x), t.after);
        cancelled.output("$ ");
        cancelled.cancel();
        cancelled.arm();
        t.run();
        expect(typed).toEqual(["cmd\r"]);
    });

    describe("in a real shell", () => {
        const saved = { SHELL: process.env.SHELL, HOME: process.env.HOME };
        beforeAll(() => {
            process.env.SHELL = "/bin/sh";
            process.env.HOME = tempDir("harness-arm-home-");
        });
        afterAll(() => {
            for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
        });
        const COMMAND = "printf '__%s__\\n' ran\r";
        function shell() {
            const events: ServerEvent[] = [];
            const owner = { send: (e: ServerEvent) => events.push(e) };
            const output = () => events.filter((e) => e.type === "terminal.data").map((e) => (e as { data: string }).data).join("");
            return { owner, output };
        }

        test("never armed: never typed, though the shell is ready and the fallback time has passed; armed alone: typed", async () => {
            const shells = new Terminals();
            const never = shell();
            const armed = shell();
            try {
                shells.open(never.owner, "never", folder(), 90, 28, { input: COMMAND });
                shells.open(armed.owner, "armed", folder(), 90, 28, { input: COMMAND });
                shells.arm(armed.owner, "armed");
                await Bun.sleep(3400);
                expect(never.output()).not.toContain("__ran__");
                expect(armed.output()).toContain("__ran__\r\n");
                expect(() => shells.arm(armed.owner, "nope")).toThrow("not open");
            } finally {
                shells.stop();
            }
        }, 15_000);
    });
});

describe("git that won't stop", () => {
    const savedPath = process.env.PATH;
    afterAll(() => {
        process.env.PATH = savedPath;
        forgetProjectKeys();
    });

    test("ignoring SIGTERM, with a child keeping its output open: the error still comes after about 3 s", async () => {
        const { linked } = repoWithWorktree();
        const bin = tempDir("harness-stuck-git-");
        // A child in the group, and (where perl is) one in a session of its own that the group kill can't reach.
        writeFileSync(join(bin, "git"), "#!/bin/sh\ntrap '' TERM\nperl -e 'use POSIX qw(setsid); setsid(); sleep 6' &\nsleep 10 &\nwait\n");
        chmodSync(join(bin, "git"), 0o755);
        process.env.PATH = `${bin}:${savedPath}`;
        forgetProjectKeys();
        try {
            const started = Date.now();
            await expect(listScripts(linked)).rejects.toThrow("git didn't answer within 3 s");
            const took = Date.now() - started;
            expect(took).toBeGreaterThanOrEqual(2900);
            expect(took).toBeLessThan(4500);
        } finally {
            process.env.PATH = savedPath;
            forgetProjectKeys();
        }
    }, 15_000);
});

describe("the lock, where there are no hard links", () => {
    const real = { ...lockFiles };
    const lock = () => `${scriptsFile()}.lock`;
    const noLinks = () => {
        lockFiles.link = () => {
            throw Object.assign(new Error("hard links aren't supported here"), { code: "EPERM" });
        };
    };
    afterAll(() => {
        Object.assign(lockFiles, real);
        rmSync(lock(), { force: true });
        resetStore();
    });

    test("it's made in place, with the pid in it, and released", async () => {
        resetStore();
        noLinks();
        try {
            const dir = folder();
            let held = "";
            await updateProject(dir, () => {
                held = readFileSync(lock(), "utf-8");
                return false;
            });
            expect(held).toBe(String(process.pid));
            await saveScript(dir, { name: "a", command: "echo a" });
            expect((await listScripts(dir)).scripts.map((s) => s.name)).toEqual(["a"]);
            expect(existsSync(lock())).toBe(false);
        } finally {
            Object.assign(lockFiles, real);
        }
    });

    test("taken over just after it was made: the new owner's lock isn't mistaken for ours", async () => {
        resetStore();
        const dir = folder();
        await saveScript(dir, { name: "before", command: "echo before" });
        const before = readFileSync(scriptsFile(), "utf-8");
        noLinks();
        let tookOver = false;
        lockFiles.open = ((path: string, flags: string, mode: number) => {
            const fd = real.open(path, flags, mode);
            if (!tookOver) {
                // Another process takes it over between the open and the identity check (pid 1 is running).
                tookOver = true;
                rmSync(path);
                writeFileSync(path, "1");
            }
            return fd;
        }) as typeof lockFiles.open;
        try {
            await expect(saveScript(dir, { name: "after", command: "echo after" })).rejects.toThrow("being saved by another Harness window");
            expect(tookOver).toBe(true);
            // Nothing was written, and the other process's lock is still there.
            expect(readFileSync(scriptsFile(), "utf-8")).toBe(before);
            expect(readFileSync(lock(), "utf-8")).toBe("1");
        } finally {
            Object.assign(lockFiles, real);
            rmSync(lock(), { force: true });
        }
    }, 10_000);
});
