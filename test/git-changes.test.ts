import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { convertsEol, findRenames, gitChanges, gitSeesBinary, removeWhere, render } = await import("../src/server/git-changes");
const { coalesce } = await import("../src/server/coalesce");
const { gitArgv, gitEnv } = await import("../src/util/git");
afterAll(() => iso.cleanup());

const IDENTITY = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Harness Test", "-c", "user.email=test@example.invalid", "-c", "protocol.file.allow=always"];

function git(cwd: string, ...args: string[]): string {
    const r = Bun.spawnSync(gitArgv([...IDENTITY, ...args]), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString();
}

let n = 0;
/** A repository on main with `files` committed. */
function repo(files: Record<string, string | Buffer> = {}): string {
    const dir = join(realpathSync(iso.home), `repo-${n++}`);
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    for (const [path, body] of Object.entries(files)) write(dir, path, body);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--allow-empty", "-m", "Initial commit");
    return dir;
}

function write(dir: string, path: string, body: string | Buffer) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
}

/**
 * What a reader of the index would see: if any of this moves, something wrote
 * it. `git status` is left out where it would run the repo's own filters.
 */
function indexState(dir: string, status = true) {
    const st = statSync(join(dir, ".git/index"));
    return { bytes: readFileSync(join(dir, ".git/index")).toString("base64"), mtime: st.mtimeMs, cached: git(dir, "diff", "--cached", "--name-status"), status: status ? git(dir, "status", "--porcelain=v1", "-z") : "" };
}

const summary = (r: { files: { path: string; change: string; added: number; removed: number }[] }) => r.files.map((f) => `${f.change} ${f.path} +${f.added} -${f.removed}`);

describe("git changes", () => {
    test("modified, staged, deleted and untracked files, with awkward names", async () => {
        const dir = repo({ "a.txt": "one\ntwo\n", "gone.txt": "bye\n", "with space.txt": "x\n", "-dash.txt": "d\n", "ünï.txt": "u\n", "img.bin": Buffer.from([0, 1, 2, 3]) });
        write(dir, "a.txt", "one\nTWO\nthree\n");
        rmSync(join(dir, "gone.txt"));
        write(dir, "staged.txt", "new\n");
        git(dir, "add", "staged.txt");
        write(dir, "with space.txt", "x\ny\n");
        write(dir, "-dash.txt", "D\n");
        write(dir, "ünï.txt", "u\nv\n");
        write(dir, "line\nbreak.txt", "n\n");
        write(dir, "img.bin", Buffer.from([0, 1, 2, 4]));
        write(dir, "new/fresh.ts", "export {};\n");
        const before = indexState(dir);

        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(r.repo).toBe(true);
        expect(r.head?.branch).toBe("main");
        expect(summary(r)).toEqual([
            "modified -dash.txt +1 -1",
            "modified a.txt +2 -1",
            "deleted gone.txt +0 -1",
            "modified img.bin +0 -0",
            "added staged.txt +1 -0",
            "modified with space.txt +1 -0",
            "modified ünï.txt +1 -0",
            "untracked line\nbreak.txt +1 -0",
            "untracked new/fresh.ts +1 -0",
        ]);
        expect(r.files.find((f) => f.path === "img.bin")?.note).toBe("Binary file");
        expect(r.files.find((f) => f.path === "a.txt")?.hunks[0]?.lines.map((l) => `${l.t}:${l.text}`)).toEqual(["ctx:one", "del:two", "add:TWO", "add:three"]);
        expect([r.added, r.removed]).toEqual([8, 3]);
        expect(r.more).toBe(0);
        expect(indexState(dir)).toEqual(before);
    });

    test("a clean tree has nothing, and an untouched file with a new mtime isn't a change", async () => {
        const dir = repo({ "a.txt": "same\n" });
        const before = statSync(join(dir, "a.txt")).mtimeMs;
        const later = new Date(before + 60_000);
        utimesSync(join(dir, "a.txt"), later, later);
        expect(statSync(join(dir, "a.txt")).mtimeMs).not.toBe(before);
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(r.files).toEqual([]);
    });

    test("an exact rename is one entry", async () => {
        const dir = repo({ "old.txt": "content\nhere\n" });
        renameSync(join(dir, "old.txt"), join(dir, "new.txt"));
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(r.files.map((f) => [f.change, f.path, f.from])).toEqual([["renamed", "new.txt", "old.txt"]]);
    });

    test("a mode change is a change, and its note says so", async () => {
        const dir = repo({ "run.sh": "echo\n" });
        chmodSync(join(dir, "run.sh"), 0o755);
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(r.files.map((f) => [f.change, f.note])).toEqual([["modified", "Mode changed 100644 → 100755"]]);
    });

    test("symlinks are diffed as links and never followed out of the repo", async () => {
        const outside = tempDir("harness-outside-");
        writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
        const dir = repo({ "keep.txt": "k\n", "sub/inner.txt": "i\n" });
        symlinkSync("keep.txt", join(dir, "link"));
        git(dir, "add", "link");
        git(dir, "commit", "-q", "-m", "link");
        rmSync(join(dir, "link"));
        symlinkSync(join(outside, "secret.txt"), join(dir, "link"));
        // A tracked folder swapped for a link to somewhere else: its files are gone, not read through the link.
        mkdirSync(join(outside, "sub"));
        writeFileSync(join(outside, "sub", "inner.txt"), "TOP SECRET\n");
        rmSync(join(dir, "sub"), { recursive: true });
        symlinkSync(join(outside, "sub"), join(dir, "sub"));
        const r = await gitChanges(dir, { scope: "uncommitted" });
        const link = r.files.find((f) => f.path === "link");
        expect(link?.kind).toBe("link");
        expect(link?.hunks.flatMap((h) => h.lines.map((l) => `${l.t}:${l.text}`))).toEqual(["del:keep.txt", `add:${join(outside, "secret.txt")}`]);
        expect(r.files.find((f) => f.path === "sub/inner.txt")?.change).toBe("deleted");
        expect(JSON.stringify(r)).not.toContain("TOP SECRET");
    });

    test("a submodule is one entry, not recursed into; so is a repository inside an untracked folder", async () => {
        const dir = repo({ "top.txt": "t\n" });
        const sub = join(dir, "lib");
        mkdirSync(sub);
        git(sub, "init", "-q", "-b", "main");
        write(sub, "x.txt", "1\n");
        git(sub, "add", "-A");
        git(sub, "commit", "-q", "-m", "one");
        const first = git(sub, "rev-parse", "HEAD").trim();
        git(dir, "add", "lib");
        git(dir, "commit", "-q", "-m", "add lib");
        write(sub, "x.txt", "2\n");
        git(sub, "commit", "-q", "-am", "two");
        const second = git(sub, "rev-parse", "HEAD").trim();
        write(sub, "dirty.txt", "not listed\n");
        const nested = join(dir, "vendor", "thing");
        mkdirSync(nested, { recursive: true });
        git(nested, "init", "-q");
        write(nested, "inside.txt", "not listed\n");

        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(r.files.map((f) => [f.change, f.path, f.kind])).toEqual([
            ["modified", "lib", "submodule"],
            ["untracked", "vendor/thing", "repo"],
        ]);
        expect(r.files[0]!.note).toBe(`Submodule ${first.slice(0, 7)} → ${second.slice(0, 7)}`);
    });

    test("a big untracked folder is one entry, and long lists are capped", async () => {
        const dir = repo({ "src/a.ts": "a\n" });
        for (let i = 0; i < 450; i++) write(dir, `node_modules/p${i}/index.js`, "x\n");
        for (let i = 0; i < 320; i++) write(dir, `gen/f${String(i).padStart(3, "0")}.txt`, "g\n");
        git(dir, "add", "gen");
        write(dir, "src/a.ts", "b\n");
        const r = await gitChanges(dir, { scope: "uncommitted" });
        // Tracked changes come first, as in `git status`.
        expect(r.files[0]?.change).toBe("added");
        expect(r.files.length).toBe(300);
        expect(r.more).toBe(322 - 300);
        expect(r.files.some((f) => f.path.startsWith("node_modules/"))).toBe(false);
        const all = await gitChanges(dir, { scope: "uncommitted", path: "node_modules" });
        expect(all.files[0]?.kind).toBe("folder");
        expect(all.files[0]?.note).toContain("450 untracked files");
    });

    test("hunks past the reply's budget are left for a request of their own", async () => {
        const big = Array.from({ length: 1400 }, (_, i) => `line ${i}`).join("\n") + "\n";
        const files: Record<string, string> = {};
        for (let i = 0; i < 20; i++) files[`f${String(i).padStart(2, "0")}.txt`] = big;
        const dir = repo(files);
        for (const p of Object.keys(files)) write(dir, p, big.replace(/^line (\d+)$/gm, "LINE $1"));
        const r = await gitChanges(dir, { scope: "uncommitted" });
        const later = r.files.filter((f) => f.deferred);
        expect(later.length).toBeGreaterThan(0);
        expect(later[0]!.hunks).toEqual([]);
        expect(later[0]!.added).toBe(1400);
        const one = await gitChanges(dir, { scope: "uncommitted", path: later[0]!.path });
        expect(one.files.length).toBe(1);
        expect(one.files[0]!.deferred).toBeUndefined();
        expect(one.files[0]!.hunks.length).toBeGreaterThan(0);
    });

    test("a GIT_DIR the server inherited doesn't redirect it to another repository", async () => {
        const other = repo({ "theirs.txt": "t\n" });
        write(other, "theirs.txt", "changed\n");
        const dir = repo({ "mine.txt": "m\n" });
        write(dir, "mine.txt", "mine changed\n");
        process.env.GIT_DIR = join(other, ".git");
        try {
            expect(summary(await gitChanges(dir, { scope: "uncommitted" }))).toEqual(["modified mine.txt +1 -1"]);
        } finally {
            delete process.env.GIT_DIR;
        }
    });

    test("what's staged still shows when the file itself is back as it was", async () => {
        const dir = repo({ "a.txt": "A\n", "b.txt": "B\n" });
        write(dir, "a.txt", "staged\n");
        git(dir, "add", "a.txt");
        write(dir, "a.txt", "A\n");
        git(dir, "rm", "-q", "--cached", "b.txt");
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(r.files.map((f) => [f.path, f.note])).toEqual([
            ["a.txt", "Staged changes the file itself no longer has."],
            ["b.txt", "Staged for deletion, though the file is still here."],
        ]);
    });

    test("an unresolved conflict shows even when the file matches", async () => {
        const dir = repo({ "c.txt": "base\n" });
        git(dir, "switch", "-q", "-c", "side");
        write(dir, "c.txt", "side\n");
        git(dir, "commit", "-q", "-am", "side");
        git(dir, "switch", "-q", "main");
        write(dir, "c.txt", "main\n");
        git(dir, "commit", "-q", "-am", "main");
        Bun.spawnSync(gitArgv([...IDENTITY, "merge", "-q", "side"]), { cwd: dir, env: gitEnv(), stdout: "ignore", stderr: "ignore" });
        write(dir, "c.txt", "main\n");
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(r.files.map((f) => [f.path, f.note])).toEqual([["c.txt", "Unmerged: the conflict isn't marked resolved."]]);
    });

    test("a deleted submodule folder is a deletion", async () => {
        const dir = repo({ "top.txt": "t\n" });
        const sub = join(dir, "lib");
        mkdirSync(sub);
        git(sub, "init", "-q", "-b", "main");
        git(sub, "commit", "-q", "--allow-empty", "-m", "one");
        git(dir, "add", "lib");
        git(dir, "commit", "-q", "-m", "add lib");
        rmSync(sub, { recursive: true });
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(r.files.map((f) => [f.change, f.path, f.kind])).toEqual([["deleted", "lib", "submodule"]]);
    });

    test("identical files renamed together are each a rename", async () => {
        const dir = repo({ "a1.txt": "same\n", "a2.txt": "same\n" });
        renameSync(join(dir, "a1.txt"), join(dir, "b1.txt"));
        renameSync(join(dir, "a2.txt"), join(dir, "b2.txt"));
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(r.files.map((f) => f.change)).toEqual(["renamed", "renamed"]);
    });

    test("an untracked symlink is shown as a link", async () => {
        const dir = repo({ "a.txt": "a\n" });
        symlinkSync("/etc/hosts", join(dir, "hosts"));
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(r.files.map((f) => [f.change, f.kind, f.hunks[0]?.lines[0]?.text])).toEqual([["untracked", "link", "/etc/hosts"]]);
    });

    test("CRLF-only differences count only where git wouldn't convert them", async () => {
        const dir = repo({ ".gitattributes": "keep.txt -text\n", "auto.txt": "one\ntwo\n", "keep.txt": "one\ntwo\n" });
        git(dir, "config", "core.autocrlf", "true");
        write(dir, "auto.txt", "one\r\ntwo\r\n");
        write(dir, "keep.txt", "one\r\ntwo\r\n");
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(r.files.map((f) => f.path)).toEqual(["keep.txt"]);
    });

    test("a skip-worktree file is shown as the index has it, not as missing", async () => {
        const dir = repo({ "s.txt": "A\n" });
        git(dir, "switch", "-q", "-c", "feat");
        write(dir, "s.txt", "B\n");
        git(dir, "commit", "-q", "-am", "B");
        git(dir, "update-index", "--skip-worktree", "s.txt");
        rmSync(join(dir, "s.txt"));
        const r = await gitChanges(dir, { scope: "branch", base: "main" });
        expect(r.files.map((f) => `${f.change} ${f.path}`)).toEqual(["modified s.txt"]);
        expect(r.files[0]!.hunks[0]!.lines.map((l) => `${l.t}:${l.text}`)).toEqual(["del:A", "add:B"]);
    });

    test("a file the base tracks and the index dropped is listed once", async () => {
        const dir = repo({ "d.txt": "old\n" });
        git(dir, "rm", "-q", "--cached", "d.txt");
        write(dir, "d.txt", "new\n");
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(r.files.map((f) => `${f.change} ${f.path}`)).toEqual(["modified d.txt"]);
    });

    test("a staged new file deleted on disk is still listed", async () => {
        const dir = repo({ "a.txt": "a\n" });
        write(dir, "new.txt", "new\n");
        git(dir, "add", "new.txt");
        rmSync(join(dir, "new.txt"));
        expect(git(dir, "status", "--porcelain")).toBe("AD new.txt\n");
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(r.files.map((f) => [f.change, f.path, f.note])).toEqual([["added", "new.txt", "Staged as a new file, then deleted on disk."]]);
    });

    test("a staged mode change undone on disk is still listed", async () => {
        const dir = repo({ "a.txt": "a\n" });
        chmodSync(join(dir, "a.txt"), 0o755);
        git(dir, "add", "a.txt");
        chmodSync(join(dir, "a.txt"), 0o644);
        expect(git(dir, "status", "--porcelain")).toBe("MM a.txt\n");
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(r.files.map((f) => [f.path, f.note])).toEqual([["a.txt", "Staged mode change (100644 → 100755) the file itself no longer has."]]);
    });

    test("in a CRLF checkout, a one-line edit is one line", async () => {
        const dir = repo({ ".gitattributes": "*.txt text eol=crlf\n", "a.txt": "one\ntwo\n" });
        expect(git(dir, "show", "HEAD:a.txt")).toBe("one\ntwo\n");
        write(dir, "a.txt", "one\r\nTWO\r\n");
        expect(git(dir, "diff", "--numstat").trim()).toBe("1\t1\ta.txt");
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(summary(r)).toEqual(["modified a.txt +1 -1"]);
        expect(r.files[0]!.hunks[0]!.lines.map((l) => `${l.t}:${l.text}`)).toEqual(["ctx:one", "del:two", "add:TWO"]);
    });

    test("with autocrlf, a file git already has with CRLFs isn't normalized", async () => {
        const dir = repo({ "a.txt": "one\r\ntwo\r\n" });
        git(dir, "config", "core.autocrlf", "true");
        write(dir, "a.txt", "one\r\nTWO\r\n");
        expect(git(dir, "diff", "--numstat").trim()).toBe("1\t1\ta.txt");
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(summary(r)).toEqual(["modified a.txt +1 -1"]);
        expect(r.files[0]!.hunks[0]!.lines.map((l) => `${l.t}:${l.text}`)).toEqual(["ctx:one\r", "del:two\r", "add:TWO\r"]);
    });

    test("in branch scope, CRLFs committed over an LF base are a change when the index keeps them", async () => {
        const dir = repo({ "a.txt": "one\ntwo\n" });
        git(dir, "switch", "-q", "-c", "feat");
        write(dir, "a.txt", "one\r\ntwo\r\n");
        git(dir, "commit", "-q", "-am", "crlf");
        git(dir, "config", "core.autocrlf", "true");
        expect(git(dir, "show", ":a.txt")).toBe("one\r\ntwo\r\n");
        expect(git(dir, "diff", "--numstat", "main").trim()).toBe("2\t2\ta.txt");
        const r = await gitChanges(dir, { scope: "branch", base: "main" });
        expect(summary(r)).toEqual(["modified a.txt +2 -2"]);
        expect((await gitChanges(dir, { scope: "uncommitted" })).files).toEqual([]);
    });

    test("auto conversion leaves content git sees as binary alone", async () => {
        const dir = repo({ "a.txt": "one\rtwo\n" });
        git(dir, "config", "core.autocrlf", "true");
        write(dir, "a.txt", "one\rtwo\r\n");
        expect(git(dir, "diff", "--numstat").trim()).not.toBe("");
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(r.files.map((f) => [f.change, f.path])).toEqual([["modified", "a.txt"]]);
    });

    test("git's own auto conversion agrees with gitSeesBinary", async () => {
        const dir = repo();
        git(dir, "config", "core.autocrlf", "true");
        const samples = [
            "plain\r\ntext\r\n",
            "lone\rcr\r\n",
            "nul\0\r\n",
            "tab\tbs\bff\fesc\x1b\r\n",
            "a".repeat(128) + "\x01\r\n", // 1 non-printable per 128: text
            "a".repeat(128) + "\x01\x01\r\n", // 2: binary
            "a".repeat(127) + "\x7f\r\n", // 127 printable >> 7 is 0 < 1: binary
            "dos\r\nend\x1a", // a final \032 isn't counted
            "\u00e9t\u00e9\r\n", // UTF-8 bytes from 128 up are printable
        ].map((t) => Buffer.from(t, "utf-8"));
        for (const buf of samples) {
            const r = Bun.spawnSync(gitArgv(["hash-object", "--path=x.txt", "--stdin"]), { cwd: dir, env: gitEnv(), stdin: buf, stdout: "pipe" });
            const raw = Bun.spawnSync(gitArgv(["hash-object", "--no-filters", "--stdin"]), { cwd: dir, env: gitEnv(), stdin: buf, stdout: "pipe" });
            const gitConverted = r.stdout.toString() !== raw.stdout.toString();
            expect([JSON.stringify(buf.toString("latin1")), convertsEol("auto", { binary: gitSeesBinary(buf) }, null)]).toEqual([JSON.stringify(buf.toString("latin1")), gitConverted]);
        }
        // The index's copy: text with CRLFs keeps auto from converting; binary with CRLFs doesn't.
        const text = Buffer.from("a\r\n");
        expect(convertsEol("auto", { binary: false }, Buffer.from("x\r\ny\r\n"))).toBe(false);
        expect(convertsEol("auto", { binary: false }, Buffer.from("x\0\r\n"))).toBe(true);
        expect(convertsEol("auto", { binary: false }, undefined)).toBe(false);
        expect(convertsEol("always", { binary: gitSeesBinary(text) }, undefined)).toBe(true);
    });

    test("a conflicted file gets its line endings normalized too", async () => {
        const dir = repo({ ".gitattributes": "*.txt text eol=crlf\n", "c.txt": "one\ntwo\n" });
        git(dir, "switch", "-q", "-c", "side");
        write(dir, "c.txt", "one\r\nside\r\n");
        git(dir, "commit", "-q", "-am", "side");
        git(dir, "switch", "-q", "main");
        write(dir, "c.txt", "one\r\nmain\r\n");
        git(dir, "commit", "-q", "-am", "main");
        Bun.spawnSync(gitArgv([...IDENTITY, "merge", "-q", "side"]), { cwd: dir, env: gitEnv(), stdout: "ignore", stderr: "ignore" });
        expect(git(dir, "ls-files", "-u").trim().split("\n").length).toBe(3);
        write(dir, "c.txt", "one\r\nmain\r\nextra\r\n");
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(summary(r)).toEqual(["modified c.txt +1 -0"]);
    });

    test("with autocrlf, a staged change whose file normalizes back is still listed", async () => {
        const dir = repo({ "a.txt": "one\ntwo\n" });
        git(dir, "config", "core.autocrlf", "true");
        write(dir, "a.txt", "staged\n");
        git(dir, "add", "a.txt");
        write(dir, "a.txt", "one\r\ntwo\r\n");
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(r.files.map((f) => [f.path, f.note])).toEqual([["a.txt", "Staged changes the file itself no longer has."]]);
    });

    test("renames among 50,000 identical deleted files take linear time", async () => {
        const oid = "e69de29bb2d1d6434b8b29ae775ad8c2e48cc391";
        const changes: any[] = [];
        for (let i = 0; i < 50_000; i++) changes.push({ path: `old/${i}`, change: "deleted", old: { mode: "100644", oid, size: 0 } });
        for (let i = 0; i < 50_000; i++) changes.push({ path: `new/${i}`, change: "added", now: { mode: "100644", oid, size: 0 } });
        let checks = 0;
        const t = performance.now();
        await findRenames(changes, undefined as any, false, () => void checks++);
        expect(performance.now() - t).toBeLessThan(1000);
        expect(changes.length).toBe(50_000);
        expect(changes.every((c) => c.change === "renamed")).toBe(true);
        expect(new Set(changes.map((c) => c.from)).size).toBe(50_000);
        expect(checks).toBe(50_000);
    });

    test("very many changes are dropped from in place, not by spreading them into a call", async () => {
        const oid = "e69de29bb2d1d6434b8b29ae775ad8c2e48cc391";
        const changes: any[] = [{ path: "gone", change: "deleted", old: { mode: "100644", oid, size: 0 } }];
        for (let i = 0; i < 750_000; i++) changes.push({ path: `new/${i}`, change: "added", now: { mode: "100644", oid, size: 0 } });
        await findRenames(changes, undefined as any, false, () => {});
        expect(changes.length).toBe(750_000);
        expect(changes.filter((c) => c.change === "renamed").map((c) => c.from)).toEqual(["gone"]);
        const many = Array.from({ length: 1_000_000 }, (_, i) => i);
        removeWhere(many, (n) => n % 2 === 1);
        expect([many.length, many[1]]).toEqual([500_000, 2]);
    });

    test("past the deadline, render leaves files for their own requests", async () => {
        const dir = repo({ "a.txt": "a\n" });
        write(dir, "a.txt", "b\n");
        const oid = git(dir, "rev-parse", "HEAD:a.txt").trim();
        const files = await render([{ path: "a.txt", change: "modified", old: { mode: "100644", oid, size: 2 }, now: { mode: "100644", oid: "x", size: 2 } }], {
            root: dir,
            wt: undefined as any,
            shown: (p: string) => p,
            single: false,
            deadline: Date.now() - 1,
            eolOf: () => undefined,
            indexOid: () => undefined,
        });
        expect(files.map((f) => [f.path, f.deferred, f.hunks.length])).toEqual([["a.txt", true, 0]]);
    });

    test("secrets in a diff are redacted", async () => {
        const dir = repo({ "conf.txt": "nothing\n" });
        write(dir, "conf.txt", "key = sk-ant-api03-" + "a".repeat(90) + "\n");
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(JSON.stringify(r)).not.toContain("a".repeat(90));
        expect(JSON.stringify(r)).toContain("REDACTED");
    });
});

describe("branch scope", () => {
    function branched() {
        const dir = repo({ "base.txt": "b\n" });
        git(dir, "switch", "-q", "-c", "feat/x");
        write(dir, "committed.txt", "c\n");
        git(dir, "add", "-A");
        git(dir, "commit", "-q", "-m", "on the branch");
        git(dir, "branch", "-q", "other");
        write(dir, "later.txt", "l\n");
        git(dir, "add", "-A");
        git(dir, "commit", "-q", "-m", "after other");
        write(dir, "base.txt", "b\nb2\n");
        return dir;
    }

    test("shows committed and uncommitted work since the branch left main", async () => {
        const dir = branched();
        const before = indexState(dir);
        const r = await gitChanges(dir, { scope: "branch" });
        expect(r.defaultBase).toBe("main");
        expect(r.base?.ref).toBe("main");
        expect(r.head?.branch).toBe("feat/x");
        expect(summary(r)).toEqual(["modified base.txt +1 -0", "added committed.txt +1 -0", "added later.txt +1 -0"]);
        expect(r.bases).toEqual(expect.arrayContaining(["main", "other", "feat/x"]));
        const u = await gitChanges(dir, { scope: "uncommitted" });
        expect(summary(u)).toEqual(["modified base.txt +1 -0"]);
        expect(indexState(dir)).toEqual(before);
    });

    test("another base changes what's compared", async () => {
        const dir = branched();
        const r = await gitChanges(dir, { scope: "branch", base: "other" });
        expect(r.base?.ref).toBe("other");
        expect(summary(r)).toEqual(["modified base.txt +1 -0", "added later.txt +1 -0"]);
    });

    test("prefers what origin/HEAD points at", async () => {
        const dir = branched();
        git(dir, "update-ref", "refs/remotes/origin/main", "main");
        git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
        const r = await gitChanges(dir, { scope: "branch" });
        expect(r.defaultBase).toBe("origin/main");
        expect(r.bases).not.toContain("origin/HEAD");
    });

    test("a base git doesn't list is refused, options included", async () => {
        const dir = branched();
        for (const base of ["nope", "-x", "--output=/tmp/harness-x", "main~1", "HEAD", "refs/heads/main"]) {
            await expect(gitChanges(dir, { scope: "branch", base })).rejects.toThrow(/isn't a branch/);
        }
        expect(existsSync("/tmp/harness-x")).toBe(false);
    });
});

describe("files git converts on check-in", () => {
    /** The Git LFS shape: the blob holds the clean form, the disk the smudged one. */
    function filtered() {
        const marks = tempDir("harness-marks-");
        const dir = repo();
        git(dir, "config", "filter.up.clean", `touch ${join(marks, "clean")}; tr a-z A-Z`);
        git(dir, "config", "filter.up.smudge", `touch ${join(marks, "smudge")}; tr A-Z a-z`);
        write(dir, ".gitattributes", "*.lfs filter=up\n");
        write(dir, "big.lfs", "hello world\n");
        git(dir, "add", "-A");
        git(dir, "commit", "-q", "-m", "init");
        rmSync(join(dir, "big.lfs"));
        git(dir, "checkout", "--", "big.lfs");
        const marked = () => Bun.spawnSync(["ls", marks]).stdout.toString().split("\n").filter(Boolean);
        const clear = () => {
            for (const m of marked()) rmSync(join(marks, m));
        };
        clear();
        return { dir, marked, clear };
    }

    test("a checked-out filtered file git calls clean isn't listed, and its filter never runs", async () => {
        const { dir, marked, clear } = filtered();
        expect(readFileSync(join(dir, "big.lfs"), "utf-8")).toBe("hello world\n");
        expect(git(dir, "show", "HEAD:big.lfs")).toBe("HELLO WORLD\n");
        clear();
        const before = indexState(dir, false);
        expect((await gitChanges(dir, { scope: "uncommitted" })).files).toEqual([]);
        expect((await gitChanges(dir, { scope: "branch", base: "main" })).files).toEqual([]);
        expect(marked()).toEqual([]);
        expect(indexState(dir, false)).toEqual(before);
    });

    test("an edited filtered file is listed with a note instead of a diff", async () => {
        const { dir, marked } = filtered();
        write(dir, "big.lfs", "hello there\n");
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(r.files.map((f) => [f.change, f.path, f.filter, f.hunks.length])).toEqual([["modified", "big.lfs", "up", 0]]);
        expect(r.files[0]!.note).toMatch(/“up” filter.*would mean running that filter/);
        expect(marked()).toEqual([]);
    });

    test("a staged filtered file shows the stored form's diff", async () => {
        const { dir, marked, clear } = filtered();
        write(dir, "big.lfs", "hello there\n");
        git(dir, "add", "big.lfs"); // the test's own git runs the filter
        clear();
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(marked()).toEqual([]);
        expect(r.files.map((f) => [f.path, f.filter, f.hunks.flatMap((h) => h.lines.map((l) => `${l.t}:${l.text}`))])).toEqual([["big.lfs", "up", ["del:HELLO WORLD", "add:HELLO THERE"]]]);
    });

    test("an entry not older than the index itself (racy) isn't trusted as clean", async () => {
        const { dir } = filtered();
        // Stamped later than the index file, then recorded: git itself would re-read it.
        const future = new Date("2099-01-01T00:00:00Z");
        utimesSync(join(dir, "big.lfs"), future, future);
        expect(statSync(join(dir, "big.lfs")).mtime.getUTCFullYear()).toBe(2099);
        git(dir, "update-index", "--refresh");
        const r = await gitChanges(dir, { scope: "uncommitted" });
        expect(r.files.map((f) => [f.path, f.filter])).toEqual([["big.lfs", "up"]]);
    });
});

describe("a session in a subfolder", () => {
    test("names files elsewhere in the repository with ../", async () => {
        const dir = repo({ "top.txt": "t\n", "sub/x.txt": "x\n" });
        write(dir, "top.txt", "T\n");
        write(dir, "sub/x.txt", "X\n");
        const r = await gitChanges(join(dir, "sub"), { scope: "uncommitted" });
        expect(r.files.map((f) => f.path)).toEqual(["x.txt", "../top.txt"]); // in the repository's order, as git status lists them
        const one = await gitChanges(join(dir, "sub"), { scope: "uncommitted", path: "../top.txt" });
        expect(one.files.map((f) => f.path)).toEqual(["../top.txt"]);
        // A turn card may name it absolutely.
        const abs = await gitChanges(join(dir, "sub"), { scope: "uncommitted", path: join(dir, "top.txt") });
        expect(abs.files.map((f) => f.path)).toEqual(["../top.txt"]);
    });

    test("an absolute path naming a link asks about the link, not its target", async () => {
        const dir = repo({ "target.txt": "t\n", "other.txt": "o\n" });
        symlinkSync("target.txt", join(dir, "link"));
        git(dir, "add", "link");
        git(dir, "commit", "-q", "-m", "link");
        rmSync(join(dir, "link"));
        symlinkSync("other.txt", join(dir, "link"));
        write(dir, "target.txt", "changed\n");
        const r = await gitChanges(dir, { scope: "uncommitted", path: join(dir, "link") });
        expect(r.files.map((f) => [f.path, f.kind])).toEqual([["link", "link"]]);
    });
});

describe("coalescing", () => {
    /** After every pending promise reaction. */
    const tick = () => new Promise((r) => setTimeout(r, 0));
    test("a request made during a run gets a run that starts after it", async () => {
        const slots = new Map();
        let runs = 0;
        let release: () => void = () => {};
        const run = () => {
            const n = ++runs;
            return new Promise<number>((done) => (release = () => done(n)));
        };
        const first = coalesce(slots, "k", run);
        const second = coalesce(slots, "k", run);
        const third = coalesce(slots, "k", run);
        expect(runs).toBe(1);
        release();
        expect(await first).toBe(1);
        await tick();
        expect(runs).toBe(2);
        // Asked during the second run: a third run, not the second's result.
        const fourth = coalesce(slots, "k", run);
        release();
        expect([await second, await third]).toEqual([2, 2]);
        await tick();
        release();
        expect(await fourth).toBe(3);
        expect(slots.size).toBe(0);
    });

    test("a failed run doesn't stop the next one", async () => {
        const slots = new Map();
        let n = 0;
        const run = () => (++n === 1 ? Promise.reject(new Error("no")) : Promise.resolve(n));
        const first = coalesce(slots, "k", run);
        const second = coalesce(slots, "k", run);
        await expect(first).rejects.toThrow("no");
        expect(await second).toBe(2);
    });
});

describe("outside a repository", () => {
    test("says why, so the pane can fall back to Harness's edits", async () => {
        const r = await gitChanges(tempDir("harness-plain-"), { scope: "uncommitted" });
        expect(r.repo).toBe(false);
        expect(r.reason).toMatch(/isn't a Git repository/);
        expect(r.files).toEqual([]);
    });
});

describe("repository config never runs a program", () => {
    test("in a partial clone, a missing old blob is never fetched", async () => {
        const src = repo({ "f.txt": "v1\n" });
        write(src, "f.txt", "v2\n");
        git(src, "commit", "-q", "-am", "v2");
        git(src, "config", "uploadpack.allowFilter", "true");
        const pc = join(realpathSync(iso.home), `pc-${n++}`);
        git(iso.home, "clone", "-q", "--filter=blob:none", `file://${src}`, pc);
        // Every fetch from the promisor remote goes through this, and leaves a mark.
        const mark = join(realpathSync(iso.home), `pc-fetched-${n++}`);
        const script = join(realpathSync(iso.home), `pc-upload-pack-${n++}.sh`);
        writeFileSync(script, `#!/bin/sh\ntouch '${mark}'\nexec git-upload-pack "$@"\n`, { mode: 0o755 });
        git(pc, "config", "remote.origin.uploadpack", script);
        // The first commit's blob wasn't cloned; branch scope against it needs that blob.
        git(pc, "branch", "-q", "old", "HEAD~1");
        write(pc, "f.txt", "v3\n");
        const v1 = git(src, "rev-parse", "HEAD~1:f.txt").trim();
        const has = () => Bun.spawnSync(gitArgv(["cat-file", "-e", v1]), { cwd: pc, env: { ...gitEnv(), GIT_NO_LAZY_FETCH: "1" }, stdout: "ignore", stderr: "ignore" }).exitCode === 0;
        expect(has()).toBe(false);

        await gitChanges(pc, { scope: "branch", base: "old" }).catch(() => undefined);
        await gitChanges(pc, { scope: "uncommitted" });
        expect(existsSync(mark)).toBe(false);
        expect(has()).toBe(false);

        // Control: plain git in the same clone does fetch it, so the test would notice.
        git(pc, "cat-file", "-p", v1);
        expect(existsSync(mark)).toBe(true);
    });

    test("filters, textconv, external diff and fsmonitor stay unrun", async () => {
        const marks = tempDir("harness-marks-");
        const dir = repo({ "a.txt": "hi\n", "b.txt": "same size\n", ".gitattributes": "* filter=evil diff=evil\n" });
        const touch = (name: string) => `touch ${join(marks, name)}; cat`;
        git(dir, "config", "filter.evil.clean", touch("clean"));
        git(dir, "config", "filter.evil.smudge", touch("smudge"));
        git(dir, "config", "filter.evil.process", `touch ${join(marks, "process")}; false`);
        git(dir, "config", "filter.evil.required", "true");
        git(dir, "config", "diff.evil.textconv", touch("textconv"));
        git(dir, "config", "diff.evil.command", `touch ${join(marks, "diffcmd")}`);
        writeFileSync(join(marks, "ext.sh"), `#!/bin/sh\ntouch ${join(marks, "external")}\n`);
        chmodSync(join(marks, "ext.sh"), 0o755);
        git(dir, "config", "diff.external", join(marks, "ext.sh"));
        git(dir, "config", "core.fsmonitor", `touch ${join(marks, "fsmonitor")}; false`);
        write(dir, "a.txt", "hi\nthere\n");
        write(dir, "b.txt", "SAME SIZE\n"); // same size: git would have to look at the content
        write(dir, "c.txt", "untracked\n");
        git(dir, "branch", "-q", "other");
        const marked = () => (Bun.spawnSync(["ls", marks]).stdout.toString().split("\n").filter((f) => f && f !== "ext.sh"));

        // Control: plain git does run them, so the test would notice.
        Bun.spawnSync(["git", "diff", "--no-ext-diff", "--no-textconv"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
        expect(marked().length).toBeGreaterThan(0);
        for (const m of marked()) rmSync(join(marks, m));

        const before = indexState(dir, false);
        const u = await gitChanges(dir, { scope: "uncommitted" });
        const b = await gitChanges(dir, { scope: "branch", base: "other" });
        await gitChanges(dir, { scope: "uncommitted", path: "a.txt" });
        expect(marked()).toEqual([]);
        // Their filter would be needed to diff them, so they're listed without one.
        expect(summary(u)).toEqual(["modified a.txt +0 -0", "modified b.txt +0 -0", "untracked c.txt +1 -0"]);
        expect(u.files.slice(0, 2).map((f) => [f.filter, f.note?.includes("filter")])).toEqual([
            ["evil", true],
            ["evil", true],
        ]);
        expect(summary(b)).toEqual(summary(u));
        expect(indexState(dir, false)).toEqual(before);
    });
});
