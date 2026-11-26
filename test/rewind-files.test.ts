import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const inheritedGitConfig = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_CONFIG")));
for (const key of Object.keys(inheritedGitConfig)) delete process.env[key];
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
const { TurnSnapshots } = await import("../src/agent/turn-snapshots");
const { FileHistory } = await import("../src/agent/checkpoints");
const { planFileRestore, restoreFiles, undoRestore, canUndoRestore, changedBy } = await import("../src/agent/rewind-files");
const { gitArgv, gitEnv } = await import("../src/util/git");
afterAll(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_CONFIG")) delete process.env[key];
    Object.assign(process.env, inheritedGitConfig);
    iso.cleanup();
});

let next = 0;
const IDENTITY = ["-c", "maintenance.auto=false", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Cavvy Test", "-c", "user.email=test@example.invalid"];

function git(cwd: string, args: string[]) {
    const env = gitEnv();
    for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
    const r = Bun.spawnSync(gitArgv([...IDENTITY, ...args]), { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout;
}

function write(dir: string, path: string, body: string | Buffer) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
}

const BINARY = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13, 0, 128]);

/** A repository with tracked files, an untracked (not ignored) one, an ignored one; its session's history and snapshots. */
function setup() {
    const base = join(realpathSync(iso.home), `rewind-${next++}`);
    const cwd = join(base, "repo");
    const dir = join(base, "history");
    mkdirSync(cwd, { recursive: true });
    git(cwd, ["init", "-q", "-b", "main"]);
    write(cwd, ".gitignore", "ignored.log\n");
    write(cwd, "a.txt", "a\n");
    write(cwd, "src/b.txt", "b\n");
    write(cwd, "old-name.txt", "renamed\n");
    write(cwd, "gone.txt", "will be deleted\n");
    write(cwd, "image.bin", BINARY);
    write(cwd, "run.sh", "#!/bin/sh\necho hi\n");
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-q", "-m", "Initial commit"]);
    write(cwd, "notes.md", "untracked, not ignored\n");
    write(cwd, "ignored.log", "ignored at first\n");
    return { cwd, dir, snapshots: new TurnSnapshots(dir, cwd), history: new FileHistory(dir) };
}

const read = (cwd: string, path: string) => readFileSync(join(cwd, path), "utf-8");

/** A turn whose work is `work`: what it changes, as a shell command would (nothing through the edit tools). */
async function turn(s: { snapshots: InstanceType<typeof TurnSnapshots>; history: InstanceType<typeof FileHistory> }, work: () => void | Promise<void>): Promise<number> {
    const cp = s.history.begin();
    await s.snapshots.begin(cp, "prompt");
    await work();
    await s.snapshots.end();
    await s.snapshots.settled();
    return cp;
}

describe("restoring files on rewind", () => {
    test("leaves Cavvy's own local settings alone: an Always allow rule, and the .gitignore beside it", async () => {
        const s = setup();
        const { cwd } = s;
        const cp = await turn(s, () => {
            write(cwd, "a.txt", "changed\n");
            // What "Always allow" writes (config/settings.ts updateSettings, ensureLocalGitignore).
            write(cwd, ".cavvy/settings.local.json", '{"permissions":{"allow":["Bash(bun test)"]}}\n');
            write(cwd, ".cavvy/.gitignore", "settings.local.json\n");
            write(cwd, "src/.cavvy/.gitignore", "settings.local.json\n");
        });
        const plan = await planFileRestore({ snapshots: s.snapshots, history: s.history, checkpoint: cp });
        expect(plan.items.map((i) => i.path.slice(cwd.length + 1))).toEqual(["a.txt"]);
        await restoreFiles(plan);
        expect(read(cwd, "a.txt")).toBe("a\n");
        expect(read(cwd, ".cavvy/settings.local.json")).toContain("Bash(bun test)");
        expect(existsSync(join(cwd, ".cavvy/.gitignore"))).toBe(true);
        expect(existsSync(join(cwd, "src/.cavvy/.gitignore"))).toBe(true);
    });

    test("puts back every change since the prompt, whoever made it, and Undo puts them back again", async () => {
        const s = setup();
        const { cwd } = s;
        const cp = await turn(s, () => {
            write(cwd, "a.txt", "changed by a shell command\n");
            write(cwd, "src/new/created.txt", "new\n");
            rmSync(join(cwd, "gone.txt"));
            renameSync(join(cwd, "old-name.txt"), join(cwd, "new-name.txt"));
            write(cwd, "image.bin", Buffer.from([9, 9, 0, 9]));
            write(cwd, "notes.md", "edited untracked\n");
            write(cwd, "ignored.log", "ignored, changed\n");
            chmodSync(join(cwd, "run.sh"), 0o755);
        });
        // Between turns, too: the user (or anything) changed a file.
        write(cwd, "src/b.txt", "b, by hand\n");
        const labels = changedBy(s.snapshots, s.history, cp);
        expect(labels.whole).toBe(true);
        expect(labels.files).toBeGreaterThanOrEqual(7);

        const plan = await planFileRestore({ snapshots: s.snapshots, history: s.history, checkpoint: cp });
        expect(plan.whole).toBe(true);
        expect(plan.refused).toBeUndefined();
        const actions = Object.fromEntries(plan.items.map((i) => [i.path.slice(cwd.length + 1), i.action]));
        expect(actions).toEqual({
            "a.txt": "write",
            "gone.txt": "create",
            "image.bin": "write",
            "new-name.txt": "delete",
            "notes.md": "write",
            "old-name.txt": "create",
            "run.sh": "write",
            "src/b.txt": "write",
            "src/new/created.txt": "delete",
        });
        expect(plan.items.every((i) => i.undoable)).toBe(true);

        const r = await restoreFiles(plan);
        expect(r.failed).toEqual([]);
        expect(r.done.length).toBe(9);
        expect(read(cwd, "a.txt")).toBe("a\n");
        expect(read(cwd, "src/b.txt")).toBe("b\n");
        expect(read(cwd, "gone.txt")).toBe("will be deleted\n");
        expect(read(cwd, "old-name.txt")).toBe("renamed\n");
        expect(existsSync(join(cwd, "new-name.txt"))).toBe(false);
        expect(existsSync(join(cwd, "src/new"))).toBe(false);
        expect(readFileSync(join(cwd, "image.bin")).equals(BINARY)).toBe(true);
        expect(read(cwd, "notes.md")).toBe("untracked, not ignored\n");
        expect(statSync(join(cwd, "run.sh")).mode & 0o111).toBe(0);
        // Ignored: not the snapshot's, so left as it is.
        expect(read(cwd, "ignored.log")).toBe("ignored, changed\n");

        expect(r.undo).toBeTruthy();
        expect(canUndoRestore(s.snapshots, r.undo!)).toBe(true);
        const u = await undoRestore(s.snapshots, r.undo!);
        expect(u.failed).toEqual([]);
        expect(u.done.length).toBe(9);
        expect(read(cwd, "a.txt")).toBe("changed by a shell command\n");
        expect(read(cwd, "src/b.txt")).toBe("b, by hand\n");
        expect(read(cwd, "src/new/created.txt")).toBe("new\n");
        expect(existsSync(join(cwd, "gone.txt"))).toBe(false);
        expect(existsSync(join(cwd, "old-name.txt"))).toBe(false);
        expect(read(cwd, "new-name.txt")).toBe("renamed\n");
        expect(readFileSync(join(cwd, "image.bin")).equals(Buffer.from([9, 9, 0, 9]))).toBe(true);
        expect(read(cwd, "notes.md")).toBe("edited untracked\n");
        expect(statSync(join(cwd, "run.sh")).mode & 0o100).toBe(0o100);
        // Once.
        expect(canUndoRestore(s.snapshots, r.undo!)).toBe(false);
        await expect(undoRestore(s.snapshots, r.undo!)).rejects.toThrow(/can't be undone/);
        await s.snapshots.stop();
    });

    test("files that didn't change since are left alone, and a later prompt restores only what came after it", async () => {
        const s = setup();
        const { cwd } = s;
        await turn(s, () => write(cwd, "a.txt", "first turn\n"));
        const second = await turn(s, () => write(cwd, "src/b.txt", "second turn\n"));
        const plan = await planFileRestore({ snapshots: s.snapshots, history: s.history, checkpoint: second });
        expect(plan.items.map((i) => i.path.slice(cwd.length + 1))).toEqual(["src/b.txt"]);
        await restoreFiles(plan);
        expect(read(cwd, "a.txt")).toBe("first turn\n");
        expect(read(cwd, "src/b.txt")).toBe("b\n");
        await s.snapshots.stop();
    });

    test("a symlink is put back as a link, and never written through", async () => {
        const s = setup();
        const { cwd } = s;
        symlinkSync("a.txt", join(cwd, "link"));
        git(cwd, ["add", "link"]);
        git(cwd, ["commit", "-q", "-m", "link"]);
        const cp = await turn(s, () => {
            rmSync(join(cwd, "link"));
            write(cwd, "link", "now a file\n");
        });
        const r = await restoreFiles(await planFileRestore({ snapshots: s.snapshots, history: s.history, checkpoint: cp }));
        expect(r.failed).toEqual([]);
        expect(lstatSync(join(cwd, "link")).isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(cwd, "link"))).toBe("a.txt");
        expect(read(cwd, "a.txt")).toBe("a\n");
        await s.snapshots.stop();
    });

    test("a file changed again after the plan was shown is left alone", async () => {
        const s = setup();
        const { cwd } = s;
        const cp = await turn(s, () => {
            write(cwd, "a.txt", "turn\n");
            write(cwd, "src/b.txt", "turn\n");
        });
        const plan = await planFileRestore({ snapshots: s.snapshots, history: s.history, checkpoint: cp });
        write(cwd, "a.txt", "changed while choosing\n");
        const r = await restoreFiles(plan);
        expect(r.failed.map((f) => f.path.slice(cwd.length + 1))).toEqual(["a.txt"]);
        expect(read(cwd, "a.txt")).toBe("changed while choosing\n");
        expect(read(cwd, "src/b.txt")).toBe("b\n");
        await s.snapshots.stop();
    });

    test("another session working in the folder: refused, and only Cavvy's own edits are offered", async () => {
        const s = setup();
        const { cwd } = s;
        const cp = await turn(s, async () => {
            await s.history.write(join(cwd, "a.txt"), Buffer.from("by the edit tool\n"));
            write(cwd, "src/b.txt", "by a shell command\n");
        });
        const plan = await planFileRestore({ snapshots: s.snapshots, history: s.history, checkpoint: cp, alongside: [join(cwd, "src")] });
        expect(plan.whole).toBe(false);
        expect(plan.refused).toBe("Another session is working here.");
        expect(plan.items.map((i) => [i.path.slice(cwd.length + 1), i.action])).toEqual([["a.txt", "write"]]);
        const r = await restoreFiles(plan);
        expect(r.failed).toEqual([]);
        expect(read(cwd, "a.txt")).toBe("a\n");
        expect(read(cwd, "src/b.txt")).toBe("by a shell command\n");
        // Still undoable: the files were captured before.
        expect(r.undo).toBeTruthy();
        await undoRestore(s.snapshots, r.undo!, s.history);
        expect(read(cwd, "a.txt")).toBe("by the edit tool\n");
        // And refused at restore time too, if another session started working since the plan.
        const again = await planFileRestore({ snapshots: s.snapshots, history: s.history, checkpoint: cp });
        expect(again.whole).toBe(true);
        await expect(restoreFiles(again, { alongside: [cwd] })).rejects.toThrow(/Another session is working here. Nothing was restored./);
        expect(read(cwd, "src/b.txt")).toBe("by a shell command\n");
        await s.snapshots.stop();
    });

    test("a missing or incomplete snapshot falls back to Cavvy's own edits and says why", async () => {
        const s = setup();
        const { cwd } = s;
        await turn(s, () => write(cwd, "a.txt", "recorded\n"));
        // A prompt whose snapshot was never recorded (or was pruned).
        const cp = s.history.begin();
        await s.history.write(join(cwd, "src/b.txt"), Buffer.from("edited\n"));
        const plan = await planFileRestore({ snapshots: s.snapshots, history: s.history, checkpoint: cp });
        expect(plan.whole).toBe(false);
        expect(plan.refused).toBe("No record of the files from then.");
        expect(plan.items.map((i) => i.path.slice(cwd.length + 1))).toEqual(["src/b.txt"]);
        await restoreFiles(plan);
        expect(read(cwd, "src/b.txt")).toBe("b\n");
        expect(read(cwd, "a.txt")).toBe("recorded\n");

        // A snapshot that ran out of time has no tree.
        const late = new TurnSnapshots(join(s.dir, "late"), cwd, { budgetMs: 0 });
        await late.begin(42, "late");
        await late.end();
        await late.settled();
        const incomplete = await planFileRestore({ snapshots: late, history: s.history, checkpoint: 42 });
        expect(incomplete.refused).toBe("The record of the files from then is incomplete.");
        await late.stop();
        await s.snapshots.stop();
    });

    test("without turn snapshots (not a Git repository, say), it's the edit tools' copies as before, with nothing refused", async () => {
        const base = join(realpathSync(iso.home), `plain-${next++}`);
        mkdirSync(base, { recursive: true });
        write(base, "f.txt", "before\n");
        const history = new FileHistory(join(base, ".history"));
        const cp = history.begin();
        await history.write(join(base, "f.txt"), Buffer.from("after\n"));
        const plan = await planFileRestore({ history, checkpoint: cp });
        expect(plan.whole).toBe(false);
        expect(plan.refused).toBeUndefined();
        expect(plan.items.map((i) => [i.action, i.undoable])).toEqual([["write", false]]);
        const r = await restoreFiles(plan);
        expect(r.undo).toBeUndefined();
        expect(read(base, "f.txt")).toBe("before\n");
    });
});
