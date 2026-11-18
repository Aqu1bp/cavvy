// The review pane's Commit view, its commit list, whitespace-insensitive diffs and a file's hidden lines,
// against scratch repositories.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { gitChanges, gitLog } = await import("../src/server/git-changes");
const { diffLines } = await import("../src/util/diff");
const { gitArgv, gitEnv } = await import("../src/util/git");
afterAll(() => iso.cleanup());

const IDENTITY = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Cavvy Test", "-c", "user.email=test@example.invalid"];

function git(cwd: string, ...args: string[]): string {
    const r = Bun.spawnSync(gitArgv([...IDENTITY, ...args]), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString();
}

let n = 0;
function repo(): string {
    const dir = join(realpathSync(iso.home), `views-${n++}`);
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    return dir;
}
const write = (dir: string, path: string, body: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
};
const commit = (dir: string, message: string) => {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--allow-empty", "-m", message);
    return git(dir, "rev-parse", "HEAD").trim();
};
const summary = (r: { files: { path: string; change: string; added: number; removed: number; from?: string }[] }) => r.files.map((f) => `${f.change} ${f.from ? `${f.from} -> ` : ""}${f.path} +${f.added} -${f.removed}`);
const lines = (n: number, tag = "") => Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}`).join("\n") + "\n";

describe("commit view", () => {
    test("a commit against its parent: modified, added, deleted and renamed files, from git's objects", async () => {
        const dir = repo();
        write(dir, "a.txt", "one\ntwo\n");
        write(dir, "gone.txt", "bye\n");
        write(dir, "moved.txt", "same content\n");
        const first = commit(dir, "First");
        write(dir, "a.txt", "one\n2\n");
        write(dir, "new.txt", "hello\n");
        git(dir, "rm", "-q", "gone.txt");
        mkdirSync(join(dir, "sub"));
        git(dir, "mv", "moved.txt", "sub/moved.txt");
        const second = commit(dir, "Second change");
        // The working tree moving on afterwards doesn't change a commit's diff.
        write(dir, "a.txt", "something else\n");
        const r = await gitChanges(dir, { scope: "commit", commit: second });
        expect(r.scope).toBe("commit");
        expect(r.commit).toMatchObject({ sha: second, subject: "Second change", author: "Cavvy Test", parents: 1 });
        expect(summary(r)).toEqual(["modified a.txt +1 -1", "deleted gone.txt +0 -1", "added new.txt +1 -0", "renamed moved.txt -> sub/moved.txt +0 -0"]);
        expect(r.files[0]!.hunks[0]!.lines.map((l) => `${l.t} ${l.text}`)).toEqual(["ctx one", "del two", "add 2"]);
        // HEAD when none is named; a root commit is all additions.
        expect((await gitChanges(dir, { scope: "commit" })).commit?.sha).toBe(second);
        const root = await gitChanges(dir, { scope: "commit", commit: first.slice(0, 10) });
        expect(root.commit?.parents).toBe(0);
        expect(summary(root)).toEqual(["added a.txt +2 -0", "added gone.txt +1 -0", "added moved.txt +1 -0"]);
        // One file by itself.
        expect(summary(await gitChanges(dir, { scope: "commit", commit: second, path: "new.txt" }))).toEqual(["added new.txt +1 -0"]);
    });

    test("a merge commit is shown against its first parent", async () => {
        const dir = repo();
        write(dir, "base.txt", "base\n");
        commit(dir, "Base");
        git(dir, "switch", "-q", "-c", "side");
        write(dir, "side.txt", "from the side\n");
        commit(dir, "Side");
        git(dir, "switch", "-q", "main");
        write(dir, "main.txt", "on main\n");
        commit(dir, "Main");
        git(dir, "merge", "-q", "--no-ff", "-m", "Merge side", "side");
        const r = await gitChanges(dir, { scope: "commit" });
        expect(r.commit).toMatchObject({ subject: "Merge side", parents: 2 });
        expect(summary(r)).toEqual(["added side.txt +1 -0"]);
    });

    test("an unknown or malformed commit is refused", async () => {
        const dir = repo();
        write(dir, "a.txt", "a\n");
        commit(dir, "First");
        await expect(gitChanges(dir, { scope: "commit", commit: "deadbeefdeadbeef" })).rejects.toThrow(/isn't in this repository/);
        await expect(gitChanges(dir, { scope: "commit", commit: "--output=x" })).rejects.toThrow(/isn't a commit id/);
        const empty = repo();
        await expect(gitChanges(empty, { scope: "commit" })).rejects.toThrow(/no commits yet/);
    });

    test("the commit list: newest first, capped at 100, merges counted", async () => {
        const dir = repo();
        expect(await gitLog(dir)).toEqual({ commits: [], more: false });
        for (let i = 0; i < 102; i++) git(dir, "commit", "-q", "--allow-empty", "-m", `Commit ${i}`);
        const log = await gitLog(dir);
        expect(log.commits.length).toBe(100);
        expect(log.more).toBe(true);
        expect(log.commits[0]).toMatchObject({ subject: "Commit 101", author: "Cavvy Test", parents: 1 });
        expect(log.commits[0]!.sha).toBe(git(dir, "rev-parse", "HEAD").trim());
        expect(log.commits[0]!.time).toBeGreaterThan(Date.now() - 600_000);
        expect(log.commits.at(-1)!.subject).toBe("Commit 2");
    });
});

describe("whitespace and hidden lines", () => {
    test("ignoring whitespace: lines that differ only in it are context, and a file with nothing else says so", async () => {
        const dir = repo();
        write(dir, "a.py", "def f():\n    return 1\n\nx = 1\n");
        write(dir, "b.txt", "same words\n");
        commit(dir, "First");
        write(dir, "a.py", "def f():\n        return 1\n\nx = 2\n");
        write(dir, "b.txt", "same   words  \n");
        const plain = await gitChanges(dir, { scope: "uncommitted" });
        expect(summary(plain)).toEqual(["modified a.py +2 -2", "modified b.txt +1 -1"]);
        const r = await gitChanges(dir, { scope: "uncommitted", ignoreWhitespace: true });
        expect(summary(r)).toEqual(["modified a.py +1 -1", "modified b.txt +0 -0"]);
        // The context shows the file as it is now.
        expect(r.files[0]!.hunks[0]!.lines.map((l) => `${l.t} ${l.text}`)).toEqual(["ctx def f():", "ctx         return 1", "ctx ", "del x = 1", "add x = 2"]);
        expect(r.files[1]).toMatchObject({ note: "Only whitespace changed", hunks: [] });
        // A commit too.
        const sha = commit(dir, "Indent");
        expect(summary(await gitChanges(dir, { scope: "commit", commit: sha, ignoreWhitespace: true }))).toEqual(["modified a.py +1 -1", "modified b.txt +0 -0"]);
    });

    test("a file asked for in full has every line as context, and each listing says how long the file is", async () => {
        const dir = repo();
        write(dir, "long.txt", lines(100));
        commit(dir, "First");
        write(dir, "long.txt", lines(100).replace("line 20\n", "line twenty\n").replace("line 80\n", "line eighty\n"));
        const listed = await gitChanges(dir, { scope: "uncommitted" });
        const f = listed.files[0]!;
        expect(f.hunks.length).toBe(2);
        expect(f.lines).toBe(100);
        expect(f.hunks[0]).toMatchObject({ oldStart: 17, newStart: 17 });
        // `full` counts only with a path.
        expect((await gitChanges(dir, { scope: "uncommitted", full: true })).files[0]!.hunks.length).toBe(2);
        const full = await gitChanges(dir, { scope: "uncommitted", path: "long.txt", full: true });
        expect(full.files[0]!.hunks.length).toBe(1);
        const all = full.files[0]!.hunks[0]!.lines;
        expect(all.length).toBe(102);
        expect(all[0]).toMatchObject({ t: "ctx", text: "line 1", a: 1, b: 1 });
        expect(all.at(-1)).toMatchObject({ t: "ctx", text: "line 100", a: 100, b: 100 });
        expect(full.files[0]!.added).toBe(2);
    });

    test("diffLines with ignoreWhitespace pairs lines by their non-space characters", () => {
        const ops = diffLines("a\n  b\nc\n", "a\nb\nC\n", { ignoreWhitespace: true });
        expect(ops.map((o) => `${o.type} ${o.line}`)).toEqual(["equal a", "equal b", "del c", "add C"]);
        expect(diffLines("a\n  b\n", "a\nb\n").map((o) => o.type)).toEqual(["equal", "del", "add"]);
    });
});
