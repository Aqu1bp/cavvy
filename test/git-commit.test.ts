import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { gitCommit, gitCommitPrompt } = await import("../src/server/git-commit");
const { gitChanges } = await import("../src/server/git-changes");
const { gitArgv, gitEnv } = await import("../src/util/git");
afterAll(() => iso.cleanup());

function git(cwd: string, ...args: string[]): string {
    const r = Bun.spawnSync(gitArgv(args), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString();
}

let n = 0;
function repo(files: Record<string, string> = {}, initial = true): string {
    const dir = join(realpathSync(iso.home), `commit-repo-${n++}`);
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.name", "Harness Test");
    git(dir, "config", "user.email", "test@example.invalid");
    git(dir, "config", "commit.gpgsign", "false");
    git(dir, "config", "core.hooksPath", join(dir, ".git", "hooks"));
    for (const [path, body] of Object.entries(files)) write(dir, path, body);
    if (initial) {
        git(dir, "add", "-A");
        git(dir, "commit", "-q", "--allow-empty", "-m", "feat: initial fixture");
    }
    return dir;
}

function write(dir: string, path: string, body: string) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
}

/** Real executable hooks, with git invocations using the same argv/env helpers. */
function hook(dir: string, name: string, body: string) {
    const path = join(dir, ".git", "hooks", name);
    const gitModule = new URL("../src/util/git.ts", import.meta.url).href;
    writeFileSync(path, `#!${process.execPath} --no-env-file\nimport { appendFileSync, writeFileSync } from "fs";\nimport { gitArgv, gitEnv } from ${JSON.stringify(gitModule)};\n${body}\n`);
    chmodSync(path, 0o755);
}

function untouched(dir: string, paths: string[]) {
    return {
        index: git(dir, "--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...paths),
        staged: git(dir, "--literal-pathspecs", "diff", "--cached", "--binary", "--", ...paths),
        unstaged: git(dir, "--literal-pathspecs", "diff", "--binary", "--", ...paths),
        contents: paths.map((p) => readFileSync(join(dir, p)).toString("base64")),
    };
}

const changed = (dir: string) => git(dir, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").trim().split("\n").sort();
const index = (dir: string) => readFileSync(join(dir, ".git", "index")).toString("base64");

describe("git commit from Review", () => {
    test("reconciliation preserves detection of unchecked edits with racy index timestamps", async () => {
        const dir = repo({ "selected.txt": "old\n", "unchecked.txt": "old\n" });
        git(dir, "config", "core.trustctime", "false");
        git(dir, "config", "core.checkStat", "minimal");
        const time = Math.floor(Date.now() / 1000) - 10;
        const file = join(dir, "unchecked.txt");
        utimesSync(file, time, time);
        git(dir, "add", "--refresh", "--", "unchecked.txt");
        utimesSync(join(dir, ".git", "index"), time, time);
        write(dir, "unchecked.txt", "NEW\n");
        utimesSync(file, time, time);
        write(dir, "selected.txt", "selected change\n");
        expect(git(dir, "status", "--porcelain", "--", "unchecked.txt")).toBe(" M unchecked.txt\n");

        await gitCommit(dir, ["selected.txt"], "selected only");

        expect(git(dir, "status", "--porcelain", "--", "unchecked.txt")).toBe(" M unchecked.txt\n");
        expect(git(dir, "show", "HEAD:unchecked.txt")).toBe("old\n");
    });

    test("a linked worktree commits using its separate gitdir and preserves unchecked staging", async () => {
        const dir = repo({ "selected.txt": "old\n", "unchecked.txt": "old\n" });
        const worktree = join(realpathSync(iso.home), `linked-${n++}`);
        git(dir, "worktree", "add", "-qb", "linked", worktree);
        write(worktree, "selected.txt", "new\n");
        write(worktree, "unchecked.txt", "staged\n");
        git(worktree, "add", "--", "unchecked.txt");
        write(worktree, "unchecked.txt", "working\n");
        const before = untouched(worktree, ["unchecked.txt"]);
        const originalHead = git(dir, "rev-parse", "HEAD");

        const result = await gitCommit(worktree, ["selected.txt"], "linked worktree change");

        expect(result.branch).toBe("linked");
        expect(changed(worktree)).toEqual(["selected.txt"]);
        expect(untouched(worktree, ["unchecked.txt"])).toEqual(before);
        expect(git(dir, "rev-parse", "HEAD")).toBe(originalHead);
        const lock = git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "index.lock").trim();
        expect(existsSync(lock)).toBe(false);
    });

    test("relative core.hooksPath runs hooks from the repository root", async () => {
        const dir = repo({ "sub/selected.txt": "old\n" });
        write(dir, "sub/selected.txt", "new\n");
        mkdirSync(join(dir, "repo-hooks"));
        hook(dir, "commit-msg", 'appendFileSync(process.argv[2], "\\nrelative hook ran\\n");');
        renameSync(join(dir, ".git", "hooks", "commit-msg"), join(dir, "repo-hooks", "commit-msg"));
        git(dir, "config", "core.hooksPath", "repo-hooks");

        await gitCommit(join(dir, "sub"), ["selected.txt"], "subject\n");

        expect(git(dir, "log", "-1", "--format=%B")).toContain("subject\n\nrelative hook ran\n");
        expect(changed(dir)).toEqual(["sub/selected.txt"]);
    });

    test("a commit-msg hook leaving only whitespace aborts without changing HEAD or staging", async () => {
        const dir = repo({ "selected.txt": "old\n" });
        write(dir, "selected.txt", "new\n");
        hook(dir, "commit-msg", 'writeFileSync(process.argv[2], " \\t\\r\\n\\n");');
        const before = index(dir);
        const head = git(dir, "rev-parse", "HEAD");

        await expect(gitCommit(dir, ["selected.txt"], "user message")).rejects.toThrow("empty commit message");

        expect(index(dir)).toBe(before);
        expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    });

    test("an absent skip-worktree selection is refused without committing a deletion", async () => {
        const dir = repo({ "sparse.txt": "old\n" });
        write(dir, "sparse.txt", "staged\n");
        git(dir, "add", "--", "sparse.txt");
        git(dir, "update-index", "--skip-worktree", "--", "sparse.txt");
        rmSync(join(dir, "sparse.txt"));
        const before = index(dir);
        const head = git(dir, "rev-parse", "HEAD");
        expect((await gitChanges(dir, { scope: "uncommitted" })).files.some((f) => f.path === "sparse.txt")).toBe(true);

        await expect(gitCommit(dir, ["sparse.txt"], "sparse change")).rejects.toThrow("skip-worktree");

        expect(index(dir)).toBe(before);
        expect(git(dir, "rev-parse", "HEAD")).toBe(head);
        expect(existsSync(join(dir, ".git", "index.lock"))).toBe(false);
    });

    test("internal index reconciliation cannot run post-index-change hooks", async () => {
        const dir = repo({ "selected.txt": "old\n", "unchecked.txt": "old\n", "flagged.txt": "old\n" });
        write(dir, "selected.txt", "new\n");
        write(dir, "unchecked.txt", "staged\n");
        git(dir, "add", "--", "unchecked.txt");
        write(dir, "unchecked.txt", "working\n");
        git(dir, "update-index", "--assume-unchanged", "--", "flagged.txt");
        const before = untouched(dir, ["unchecked.txt", "flagged.txt"]);
        const flags = git(dir, "ls-files", "-v", "--", "unchecked.txt", "flagged.txt");
        hook(dir, "post-index-change", `if (process.env.GIT_INDEX_FILE?.endsWith("index.lock")) {\n    const r = Bun.spawnSync(gitArgv(["-c", "core.hooksPath=/dev/null", "add", "--", "unchecked.txt"]), { env: gitEnv() });\n    process.exit(r.exitCode);\n}`);

        await gitCommit(dir, ["selected.txt"], "selected only");

        expect(untouched(dir, ["unchecked.txt", "flagged.txt"])).toEqual(before);
        expect(git(dir, "ls-files", "-v", "--", "unchecked.txt", "flagged.txt")).toBe(flags);
        expect(changed(dir)).toEqual(["selected.txt"]);
    });

    test("submodule ignore config cannot hide an unchecked hook-staged gitlink", async () => {
        const dir = repo({ "selected.txt": "old\n" });
        const oldLink = git(dir, "rev-parse", "HEAD").trim();
        git(dir, "update-index", "--add", "--cacheinfo", `160000,${oldLink},submodule`);
        git(dir, "commit", "-qm", "add gitlink");
        const newLink = git(dir, "rev-parse", "HEAD").trim();
        git(dir, "config", "diff.ignoreSubmodules", "all");
        write(dir, "selected.txt", "new\n");
        hook(dir, "pre-commit", `const r = Bun.spawnSync(gitArgv(["update-index", "--cacheinfo", "160000,${newLink},submodule"]), { env: gitEnv() });\nprocess.exit(r.exitCode);`);
        const before = index(dir);
        const head = git(dir, "rev-parse", "HEAD");

        await expect(gitCommit(dir, ["selected.txt"], "selected only")).rejects.toThrow("unchecked paths");

        expect(index(dir)).toBe(before);
        expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    });

    test("commits exactly selected current contents and preserves other staging and working files", async () => {
        const dir = repo({ "one.txt": "one\n", "two.txt": "two\n", "third.txt": "third\n", "unstaged.txt": "old\n" });
        write(dir, "one.txt", "staged selected\n");
        write(dir, "third.txt", "staged third\n");
        git(dir, "add", "--", "one.txt", "third.txt");
        write(dir, "one.txt", "current selected\n");
        write(dir, "two.txt", "current two\n");
        write(dir, "third.txt", "unstaged third\n");
        write(dir, "unstaged.txt", "unstaged only\n");
        const before = untouched(dir, ["third.txt", "unstaged.txt"]);

        const result = await gitCommit(dir, ["one.txt", "two.txt"], "feat: selected files");

        expect(changed(dir)).toEqual(["one.txt", "two.txt"]);
        expect(git(dir, "show", "HEAD:one.txt")).toBe("current selected\n");
        expect(git(dir, "show", "HEAD:two.txt")).toBe("current two\n");
        expect(untouched(dir, ["third.txt", "unstaged.txt"])).toEqual(before);
        expect(git(dir, "status", "--porcelain", "--", "one.txt", "two.txt")).toBe("");
        expect(git(dir, "rev-parse", "HEAD").trim().startsWith(result.hash)).toBe(true);
        expect(result.subject).toBe("feat: selected files");
        expect(result.branch).toBe("main");
    });

    test("untracked names with spaces, leading dashes and pathspec magic are literal", async () => {
        const dir = repo();
        const names = ["with space.txt", "-dash.txt", "[abc].txt", ":(glob)*.txt"];
        for (const p of [...names, "a.txt", "other.txt"]) write(dir, p, `${p}\n`);
        await gitCommit(dir, names, "add awkward names");
        expect(changed(dir)).toEqual([...names].sort());
        expect(git(dir, "ls-files", "--", "a.txt", "other.txt")).toBe("");
        expect(git(dir, "status", "--porcelain")).toContain("?? a.txt");
    });

    test("message quotes, newlines and shell syntax are stored verbatim without execution", async () => {
        const dir = repo({ "a.txt": "old\n" });
        write(dir, "a.txt", "new\n");
        const marker = join(realpathSync(iso.home), "message-marker");
        const message = `fix: 'quotes' and "double quotes"\n\n$(touch ${marker})\n\`touch ${marker}\`\n# literal body\n\n`;
        await gitCommit(dir, ["a.txt"], message);
        const raw = git(dir, "cat-file", "commit", "HEAD");
        expect(raw.slice(raw.indexOf("\n\n") + 2)).toBe(message);
        expect(existsSync(marker)).toBe(false);
    });

    test("a message without a trailing newline follows native git's verbatim handling", async () => {
        const message = "subject without trailing newline\n\nbody with 'quotes' and $(literal)";
        const native = repo({ "a.txt": "old\n" });
        write(native, "a.txt", "new\n");
        git(native, "add", "--", "a.txt");
        const nativeCommit = Bun.spawnSync(gitArgv(["commit", "--cleanup=verbatim", "-F", "-"]), {
            cwd: native, env: gitEnv(), stdin: Buffer.from(message), stdout: "pipe", stderr: "pipe",
        });
        expect(nativeCommit.exitCode).toBe(0);
        const nativeRaw = git(native, "cat-file", "commit", "HEAD");
        const nativeMessage = nativeRaw.slice(nativeRaw.indexOf("\n\n") + 2);
        const dir = repo({ "a.txt": "old\n" });
        write(dir, "a.txt", "new\n");

        await gitCommit(dir, ["a.txt"], message);

        const raw = git(dir, "cat-file", "commit", "HEAD");
        expect(raw.slice(raw.indexOf("\n\n") + 2)).toBe(nativeMessage);
    });

    test("selected content restored to HEAD reports nothing to commit and preserves staging", async () => {
        const dir = repo({ "selected.txt": "original\n", "other.txt": "original\n" });
        write(dir, "selected.txt", "staged intermediate\n");
        write(dir, "other.txt", "staged other\n");
        git(dir, "add", "--", "selected.txt", "other.txt");
        write(dir, "selected.txt", "original\n");
        const before = index(dir);
        const head = git(dir, "rev-parse", "HEAD");

        await expect(gitCommit(dir, ["selected.txt"], "no current change")).rejects.toThrow(/nothing to commit|no changes added to commit/);

        expect(index(dir)).toBe(before);
        expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    });

    test("a failing pre-commit hook surfaces output and leaves HEAD and index unchanged", async () => {
        const dir = repo({ "a.txt": "old\n", "other.txt": "old\n" });
        write(dir, "a.txt", "new\n");
        write(dir, "other.txt", "staged\n");
        git(dir, "add", "other.txt");
        const hook = join(dir, ".git", "hooks", "pre-commit");
        writeFileSync(hook, "#!/bin/sh\nprintf 'hook refuses this commit\\n' >&2\nexit 1\n");
        chmodSync(hook, 0o755);
        const before = index(dir);
        const head = git(dir, "rev-parse", "HEAD");
        await expect(gitCommit(dir, ["a.txt"], "rejected")).rejects.toThrow("hook refuses this commit");
        expect(index(dir)).toBe(before);
        expect(git(dir, "rev-parse", "HEAD")).toBe(head);
        expect(existsSync(join(dir, ".git", "index.lock"))).toBe(false);
    });

    for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg"]) {
        test(`${name} cannot add an unchecked file even when the hook succeeds`, async () => {
            const dir = repo({ "selected.txt": "old selected\n", "unchecked.txt": "old unchecked\n" });
            write(dir, "selected.txt", "new selected\n");
            write(dir, "unchecked.txt", "staged unchecked\n");
            git(dir, "add", "--", "unchecked.txt");
            write(dir, "unchecked.txt", "working unchecked\n");
            const before = index(dir);
            const unselected = untouched(dir, ["unchecked.txt"]);
            const head = git(dir, "rev-parse", "HEAD");
            hook(dir, name, `const r = Bun.spawnSync(gitArgv(["add", "--", "unchecked.txt"]), { env: gitEnv(), stdout: "inherit", stderr: "inherit" });\nprocess.exit(r.exitCode);`);

            await expect(gitCommit(dir, ["selected.txt"], "selected change")).rejects.toThrow();

            expect(git(dir, "rev-parse", "HEAD")).toBe(head);
            expect(index(dir)).toBe(before);
            expect(untouched(dir, ["unchecked.txt"])).toEqual(unselected);
            expect(existsSync(join(dir, ".git", "index.lock"))).toBe(false);
        });
    }

    test("hooks run in normal order and commit-msg can edit the message", async () => {
        const dir = repo({ "a.txt": "old\n" });
        write(dir, "a.txt", "new\n");
        for (const name of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
            hook(dir, name, `appendFileSync(".git/hook-order", ${JSON.stringify(`${name}\n`)});\n${name === "commit-msg" ? 'appendFileSync(process.argv[2], "\\nEdited by repository hook.\\n");' : ""}`);
        }

        await gitCommit(dir, ["a.txt"], "subject from user\n");

        expect(readFileSync(join(dir, ".git", "hook-order"), "utf-8")).toBe("pre-commit\nprepare-commit-msg\ncommit-msg\npost-commit\n");
        expect(git(dir, "log", "-1", "--format=%B")).toContain("subject from user\n\nEdited by repository hook.\n");
        expect(git(dir, "status", "--porcelain")).toBe("");
    });

    test("post-commit's new index lock belongs to the hook and is preserved", async () => {
        const dir = repo({ "selected.txt": "old\n" });
        write(dir, "selected.txt", "new\n");
        hook(dir, "post-commit", 'writeFileSync(".git/index.lock", "lock created after commit", { flag: "wx" });');

        await gitCommit(dir, ["selected.txt"], "selected change");

        expect(readFileSync(join(dir, ".git", "index.lock"), "utf-8")).toBe("lock created after commit");
        expect(git(dir, "show", "HEAD:selected.txt")).toBe("new\n");
    });

    test("hooks retain normal Git glob pathspec behavior", async () => {
        const dir = repo({ "selected.txt": "old\n" });
        write(dir, "selected.txt", "new\n");
        hook(dir, "pre-commit", `const r = Bun.spawnSync(gitArgv(["diff", "--cached", "--name-only", "--", "*.txt"]), { env: gitEnv(), stdout: "pipe", stderr: "inherit" });\nwriteFileSync(".git/hook-glob-files", r.stdout);\nprocess.exit(r.exitCode);`);

        await gitCommit(dir, ["selected.txt"], "selected change");

        expect(readFileSync(join(dir, ".git", "hook-glob-files"), "utf-8")).toBe("selected.txt\n");
    });

    test("pre-commit receives Git's resolved author identity and date", async () => {
        const dir = repo({ "selected.txt": "old\n" });
        write(dir, "selected.txt", "new\n");
        hook(dir, "pre-commit", 'writeFileSync(".git/hook-author", JSON.stringify([process.env.GIT_AUTHOR_NAME, process.env.GIT_AUTHOR_EMAIL, process.env.GIT_AUTHOR_DATE]));');

        await gitCommit(dir, ["selected.txt"], "selected change");

        const author = JSON.parse(readFileSync(join(dir, ".git", "hook-author"), "utf-8"));
        expect(author[0]).toBe("Harness Test");
        expect(author[1]).toBe("test@example.invalid");
        expect(typeof author[2]).toBe("string");
        expect(author[2].length).toBeGreaterThan(0);
    });

    test("a committed clean-filter file disappears from the Uncommitted listing", async () => {
        const dir = repo({}, false);
        git(dir, "config", "filter.fixture.clean", "sed 's/^working: /stored: /'");
        write(dir, ".gitattributes", "selected.txt filter=fixture\n");
        write(dir, "selected.txt", "working: old\n");
        git(dir, "add", "--", ".gitattributes", "selected.txt");
        git(dir, "commit", "-q", "-m", "initial filtered file");
        write(dir, "selected.txt", "working: new\n");

        await gitCommit(dir, ["selected.txt"], "update filtered file");

        expect(git(dir, "show", "HEAD:selected.txt")).toBe("stored: new\n");
        expect((await gitChanges(dir, { scope: "uncommitted" })).files).toEqual([]);
        expect(readFileSync(join(dir, "selected.txt"), "utf-8")).toBe("working: new\n");
    });

    test("a force-added ignored file remains committable with its current contents", async () => {
        const dir = repo({ ".gitignore": "*.ignored\n" });
        write(dir, "selected.ignored", "staged\n");
        git(dir, "add", "-f", "--", "selected.ignored");
        write(dir, "selected.ignored", "current\n");
        write(dir, "unchecked.ignored", "leave ignored\n");

        await gitCommit(dir, ["selected.ignored"], "add selected ignored file");

        expect(changed(dir)).toEqual(["selected.ignored"]);
        expect(git(dir, "show", "HEAD:selected.ignored")).toBe("current\n");
        expect(git(dir, "ls-files", "--", "unchecked.ignored")).toBe("");
        expect(git(dir, "status", "--porcelain")).toBe("");
    });

    test("a hook that empties the message is rejected like native git", async () => {
        const emptyMessage = 'writeFileSync(process.argv[2], "");';
        const native = repo({ "a.txt": "old\n" });
        write(native, "a.txt", "new\n");
        git(native, "add", "--", "a.txt");
        hook(native, "commit-msg", emptyMessage);
        const result = Bun.spawnSync(gitArgv(["commit", "--cleanup=verbatim", "-F", "-"]), {
            cwd: native, env: gitEnv(), stdin: Buffer.from("user message"), stdout: "pipe", stderr: "pipe",
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain("empty commit message");
        const dir = repo({ "a.txt": "old\n" });
        write(dir, "a.txt", "new\n");
        hook(dir, "commit-msg", emptyMessage);
        const before = index(dir);
        const head = git(dir, "rev-parse", "HEAD");

        await expect(gitCommit(dir, ["a.txt"], "user message")).rejects.toThrow(result.stderr.toString());

        expect(index(dir)).toBe(before);
        expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    });

    test("commit signing configuration is honored and signer failure preserves HEAD and staging", async () => {
        const dir = repo({ "a.txt": "old\n", "other.txt": "old\n" });
        write(dir, "a.txt", "new\n");
        write(dir, "other.txt", "staged\n");
        git(dir, "add", "--", "other.txt");
        hook(dir, "fake-gpg", 'console.error("fixture signer refused commit"); process.exit(1);');
        git(dir, "config", "gpg.format", "openpgp");
        git(dir, "config", "gpg.program", join(dir, ".git", "hooks", "fake-gpg"));
        git(dir, "config", "user.signingkey", "fixture-key");
        git(dir, "config", "commit.gpgsign", "true");
        const before = index(dir);
        const head = git(dir, "rev-parse", "HEAD");

        await expect(gitCommit(dir, ["a.txt"], "signed change")).rejects.toThrow("fixture signer refused commit");

        expect(index(dir)).toBe(before);
        expect(git(dir, "rev-parse", "HEAD")).toBe(head);
        expect(existsSync(join(dir, ".git", "index.lock"))).toBe(false);
    });

    test("reference-transaction rejection reports hook output without moving HEAD or real index", async () => {
        const dir = repo({ "a.txt": "old\n", "other.txt": "old\n" });
        write(dir, "a.txt", "new\n");
        write(dir, "other.txt", "staged\n");
        git(dir, "add", "--", "other.txt");
        const before = index(dir);
        const head = git(dir, "rev-parse", "HEAD");
        hook(dir, "reference-transaction", 'if (process.argv[2] === "prepared") { console.error("reference hook refuses commit"); process.exit(1); }');

        await expect(gitCommit(dir, ["a.txt"], "rejected ref")).rejects.toThrow("reference hook refuses commit");

        expect(git(dir, "rev-parse", "HEAD")).toBe(head);
        expect(index(dir)).toBe(before);
        expect(existsSync(join(dir, ".git", "index.lock"))).toBe(false);
    });

    test("selected files retain the real index's line-ending normalization semantics", async () => {
        const dir = repo({}, false);
        git(dir, "config", "core.autocrlf", "false");
        write(dir, "selected.txt", "first\r\nsecond\r\n");
        git(dir, "add", "--", "selected.txt");
        git(dir, "commit", "-q", "-m", "initial CRLF");
        expect(git(dir, "show", "HEAD:selected.txt")).toBe("first\r\nsecond\r\n");
        git(dir, "config", "core.autocrlf", "true");
        git(dir, "add", "--renormalize", "--", "selected.txt");
        expect(git(dir, "show", ":selected.txt")).toBe("first\nsecond\n");
        write(dir, "selected.txt", "first\r\nCHANGED\r\n");

        await gitCommit(dir, ["selected.txt"], "normalize current contents");

        expect(git(dir, "show", "HEAD:selected.txt")).toBe("first\nCHANGED\n");
        expect(readFileSync(join(dir, "selected.txt"), "utf-8")).toBe("first\r\nCHANGED\r\n");
        expect(git(dir, "status", "--porcelain")).toBe("");
    });

    test("selected files retain a staged executable bit when core.filemode is false", async () => {
        const dir = repo({ "selected.sh": "echo old\n" });
        git(dir, "config", "core.filemode", "false");
        git(dir, "update-index", "--chmod=+x", "--", "selected.sh");
        write(dir, "selected.sh", "echo current\n");

        await gitCommit(dir, ["selected.sh"], "update executable script");

        expect(git(dir, "ls-tree", "HEAD", "--", "selected.sh")).toStartWith("100755 blob ");
        expect(git(dir, "show", "HEAD:selected.sh")).toBe("echo current\n");
        expect(git(dir, "status", "--porcelain")).toBe("");
    });

    test("renames, deletions and typechanges commit whole", async () => {
        const dir = repo({ "old.txt": "rename me\n", "gone.txt": "delete me\n", "type.txt": "plain file\n", "keep.txt": "keep\n" });
        renameSync(join(dir, "old.txt"), join(dir, "new.txt"));
        rmSync(join(dir, "gone.txt"));
        rmSync(join(dir, "type.txt"));
        symlinkSync("keep.txt", join(dir, "type.txt"));
        await gitCommit(dir, ["new.txt", "gone.txt", "type.txt"], "refactor: whole file changes");
        expect(changed(dir)).toEqual(["gone.txt", "new.txt", "old.txt", "type.txt"]);
        expect(git(dir, "ls-tree", "HEAD", "--", "type.txt")).toStartWith("120000 blob ");
        expect(git(dir, "show", "HEAD:type.txt")).toBe("keep.txt");
        expect(git(dir, "status", "--porcelain")).toBe("");
    });

    test("first commit on an unborn branch includes only selected files", async () => {
        const dir = repo({ "first.txt": "first\n", "later.txt": "later\n" }, false);
        const result = await gitCommit(dir, ["first.txt"], "first commit");
        expect(result.branch).toBe("main");
        expect(git(dir, "ls-tree", "--name-only", "HEAD")).toBe("first.txt\n");
        expect(git(dir, "status", "--porcelain")).toBe("?? later.txt\n");
    });

    test("detached HEAD commits succeed without moving the former branch", async () => {
        const dir = repo({ "a.txt": "old\n" });
        const branchHead = git(dir, "rev-parse", "main");
        git(dir, "checkout", "--detach", "-q");
        write(dir, "a.txt", "new\n");

        const result = await gitCommit(dir, ["a.txt"], "detached change");

        expect(result.branch).toBeUndefined();
        expect(git(dir, "rev-parse", "HEAD").trim()).toBe(result.hash);
        expect(git(dir, "rev-parse", "main")).toBe(branchHead);
        expect(git(dir, "show", "HEAD:a.txt")).toBe("new\n");
        expect(git(dir, "status", "--porcelain")).toBe("");
    });

    test("selecting a deleted file replaced by a directory does not include unchecked children", async () => {
        const dir = repo({ "replaced": "was a file\n" });
        rmSync(join(dir, "replaced"));
        write(dir, "replaced/child.txt", "unchecked new child\n");
        await gitCommit(dir, ["replaced"], "remove old file");
        expect(changed(dir)).toEqual(["replaced"]);
        expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD")).toBe("");
        expect(readFileSync(join(dir, "replaced/child.txt"), "utf-8")).toBe("unchecked new child\n");
        expect(git(dir, "status", "--porcelain")).toBe("?? replaced/\n");
    });

    test("a child cannot silently delete an unchecked tracked parent file", async () => {
        const dir = repo({ "replaced": "was a file\n" });
        rmSync(join(dir, "replaced"));
        write(dir, "replaced/child.txt", "new child\n");
        const before = index(dir);
        const head = git(dir, "rev-parse", "HEAD");
        await expect(gitCommit(dir, ["replaced/child.txt"], "add only child")).rejects.toThrow();
        expect(index(dir)).toBe(before);
        expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    });

    test("a session in a subfolder uses listing-relative paths, including ../", async () => {
        const dir = repo({ "sub/a.txt": "a\n", "root.txt": "root\n", "keep.txt": "keep\n" });
        write(dir, "sub/a.txt", "A\n");
        write(dir, "root.txt", "ROOT\n");
        write(dir, "keep.txt", "KEEP\n");
        await gitCommit(join(dir, "sub"), ["a.txt", "../root.txt"], "fix: from nested folder");
        expect(changed(dir)).toEqual(["root.txt", "sub/a.txt"]);
        expect(git(dir, "status", "--porcelain")).toBe(" M keep.txt\n");
    });

    test("rejects unknown paths and collapsed untracked directories", async () => {
        const dir = repo({ "a.txt": "a\n" });
        for (let i = 0; i < 201; i++) write(dir, `large/${i}.txt`, "new\n");
        const before = index(dir);
        await expect(gitCommit(dir, ["missing.txt"], "invalid")).rejects.toThrow();
        await expect(gitCommit(dir, ["large"], "invalid")).rejects.toThrow();
        expect(index(dir)).toBe(before);
    });

    test("refuses merge and rebase in progress without changing the index", async () => {
        const dir = repo({ "a.txt": "old\n" });
        write(dir, "a.txt", "new\n");
        const before = index(dir);
        writeFileSync(join(dir, ".git", "MERGE_HEAD"), git(dir, "rev-parse", "HEAD"));
        await expect(gitCommit(dir, ["a.txt"], "merge")).rejects.toThrow(/merg/i);
        rmSync(join(dir, ".git", "MERGE_HEAD"));
        mkdirSync(join(dir, ".git", "rebase-merge"));
        await expect(gitCommit(dir, ["a.txt"], "rebase")).rejects.toThrow(/rebas/i);
        expect(index(dir)).toBe(before);
    });

    test("missing identity exposes git's error and preserves the real index", async () => {
        const dir = repo({ "a.txt": "old\n" });
        write(dir, "a.txt", "new\n");
        git(dir, "config", "user.name", "");
        git(dir, "config", "user.email", "");
        const before = index(dir);
        await expect(gitCommit(dir, ["a.txt"], "identity")).rejects.toThrow(/empty ident|identity unknown|tell me who you are/i);
        expect(index(dir)).toBe(before);
    });

    test("message prompt contains recent style and only selected redacted changes within a modest budget", async () => {
        const dir = repo({ "selected.txt": "old\n", "other.txt": "old\n" });
        const key = `sk-proj-${"x".repeat(40)}`;
        write(dir, "selected.txt", `api_key=${key}\n${Array.from({ length: 5000 }, (_, i) => `new selected line ${i}`).join("\n")}\n`);
        write(dir, "other.txt", "UNSELECTED_PRIVATE_CONTENT\n");
        const prompt = await gitCommitPrompt(dir, ["selected.txt"]);
        expect(prompt).toContain("feat: initial fixture");
        expect(prompt).toContain("selected.txt");
        expect(prompt).toContain("REDACTED");
        expect(prompt).not.toContain(key);
        expect(prompt).not.toContain("UNSELECTED_PRIVATE_CONTENT");
        expect(prompt.length).toBeLessThanOrEqual(40_000);
        expect(git(dir, "log", "--format=%s")).toBe("feat: initial fixture\n");
    });
});
