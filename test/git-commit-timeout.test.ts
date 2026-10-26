import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { gitCommit, gitCommitTiming } = await import("../src/server/git-commit");
const { gitArgv, gitEnv } = await import("../src/util/git");
afterAll(() => iso.cleanup());

function git(cwd: string, ...args: string[]) {
    const result = Bun.spawnSync(gitArgv(args), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString();
}

let next = 0;
function repo(initial = true) {
    const cwd = join(realpathSync(iso.home), `timeout-${next++}`);
    mkdirSync(cwd);
    git(cwd, "init", "-q", "-b", "main");
    git(cwd, "config", "user.name", "Cavvy Test");
    git(cwd, "config", "user.email", "test@example.invalid");
    git(cwd, "config", "commit.gpgsign", "false");
    git(cwd, "config", "core.hooksPath", join(cwd, ".git", "hooks"));
    writeFileSync(join(cwd, "selected.txt"), "before\n");
    git(cwd, "add", "--", "selected.txt");
    if (initial) git(cwd, "commit", "-qm", "initial");
    writeFileSync(join(cwd, "selected.txt"), "after\n");
    return cwd;
}

function hangingHook(cwd: string, name: string, phase?: "prepared" | "committed") {
    const path = join(cwd, ".git", "hooks", name);
    writeFileSync(path, `#!/bin/sh
${phase ? `[ "$1" = "${phase}" ] || exit 0` : ""}
trap '' TERM
echo $$ > .git/hook-pid
echo 'waiting in ${name}' >&2
while :; do sleep 1; done
`);
    chmodSync(path, 0o755);
    return path;
}

async function hookStopped(cwd: string, keepsIndex = false) {
    const pid = Number(readFileSync(join(cwd, ".git", "hook-pid"), "utf8"));
    const alive = () => {
        try { process.kill(pid, 0); return true; }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return false; throw e; }
    };
    for (let i = 0; i < 100 && alive(); i++) await Bun.sleep(10);
    expect(alive()).toBe(false);
    expect(existsSync(join(cwd, ".git", "index.lock"))).toBe(keepsIndex);
}

async function bounded(run: () => Promise<void>) {
    const saved = { ...gitCommitTiming };
    gitCommitTiming.commandMs = 1000;
    gitCommitTiming.killGraceMs = 50;
    try { await run(); }
    finally { Object.assign(gitCommitTiming, saved); }
}

test("a hung pre-commit hook is killed with its process group and releases the index", () => bounded(async () => {
    const cwd = repo();
    const head = git(cwd, "rev-parse", "HEAD");
    const index = readFileSync(join(cwd, ".git", "index"));
    const hook = hangingHook(cwd, "pre-commit");
    await expect(gitCommit(cwd, ["selected.txt"], "selected change")).rejects.toMatchObject({ code: "git_timeout", message: expect.stringContaining("waiting in pre-commit") });
    await hookStopped(cwd);
    expect(git(cwd, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(cwd, ".git", "index"))).toEqual(index);
    rmSync(hook);
    expect((await gitCommit(cwd, ["selected.txt"], "retry after timeout")).subject).toBe("retry after timeout");
}));

test("a hung prepared reference hook preserves HEAD and releases native reference locks", () => bounded(async () => {
    const cwd = repo();
    const head = git(cwd, "rev-parse", "HEAD");
    const index = readFileSync(join(cwd, ".git", "index"));
    const hook = hangingHook(cwd, "reference-transaction", "prepared");
    await expect(gitCommit(cwd, ["selected.txt"], "not published")).rejects.toMatchObject({ code: "git_timeout" });
    await hookStopped(cwd);
    expect(git(cwd, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(cwd, ".git", "index"))).toEqual(index);
    expect(existsSync(join(cwd, ".git", "refs", "heads", "main.lock"))).toBe(false);
    rmSync(hook);
    expect((await gitCommit(cwd, ["selected.txt"], "retry after reference timeout")).subject).toBe("retry after reference timeout");
}));

test("a hung prepared reference hook on an unborn branch releases the index for retry", () => bounded(async () => {
    const cwd = repo(false);
    const index = readFileSync(join(cwd, ".git", "index"));
    const hook = hangingHook(cwd, "reference-transaction", "prepared");
    await expect(gitCommit(cwd, ["selected.txt"], "not published")).rejects.toMatchObject({ code: "git_timeout" });
    await hookStopped(cwd);
    expect(Bun.spawnSync(gitArgv(["rev-parse", "--quiet", "--verify", "HEAD"]), { cwd, env: gitEnv() }).exitCode).toBe(1);
    expect(readFileSync(join(cwd, ".git", "index"))).toEqual(index);
    rmSync(hook);
    expect((await gitCommit(cwd, ["selected.txt"], "retry initial commit")).subject).toBe("retry initial commit");
}));

test("a hung committed reference hook preserves the published commit and reconciles staging", () => bounded(async () => {
    const cwd = repo();
    writeFileSync(join(cwd, "other.txt"), "staged\n");
    git(cwd, "add", "--", "other.txt");
    writeFileSync(join(cwd, "other.txt"), "unstaged\n");
    const staged = git(cwd, "diff", "--cached", "--", "other.txt");
    const unstaged = git(cwd, "diff", "--", "other.txt");
    hangingHook(cwd, "reference-transaction", "committed");
    const result = await gitCommit(cwd, ["selected.txt"], "published before timeout");
    await hookStopped(cwd);
    expect(git(cwd, "rev-parse", "HEAD").trim()).toBe(result.hash);
    expect(result.subject).toBe("published before timeout");
    expect(git(cwd, "status", "--porcelain", "--", "selected.txt")).toBe("");
    expect(git(cwd, "diff", "--cached", "--", "other.txt")).toBe(staged);
    expect(git(cwd, "diff", "--", "other.txt")).toBe(unstaged);
}));

test("a hung post-commit hook cannot turn a successful commit into a failure", () => bounded(async () => {
    const cwd = repo();
    hangingHook(cwd, "post-commit");
    const result = await gitCommit(cwd, ["selected.txt"], "post-commit timeout");
    await hookStopped(cwd);
    expect(git(cwd, "rev-parse", "HEAD").trim()).toBe(result.hash);
    expect(git(cwd, "status", "--porcelain")).toBe("");
}));

for (const shutdown of [false, true]) {
    test(`a branch advanced during a committed hook reconciles staging on ${shutdown ? "shutdown" : "timeout"}`, () => bounded(async () => {
        const cwd = repo();
        writeFileSync(join(cwd, "other.txt"), "staged\n");
        git(cwd, "add", "--", "other.txt");
        writeFileSync(join(cwd, "other.txt"), "unstaged\n");
        const staged = git(cwd, "diff", "--cached", "--", "other.txt");
        const unstaged = git(cwd, "diff", "--", "other.txt");
        hangingHook(cwd, "reference-transaction", "committed");
        const abort = new AbortController();
        const pending = gitCommit(cwd, ["selected.txt"], "published before advance", { signal: abort.signal }).catch((e) => e);
        try {
            for (let i = 0; i < 200 && !existsSync(join(cwd, ".git", "hook-pid")); i++) await Bun.sleep(10);
            expect(existsSync(join(cwd, ".git", "hook-pid"))).toBe(true);
            const published = git(cwd, "rev-parse", "HEAD").trim();
            const descendant = git(cwd, "commit-tree", "HEAD^{tree}", "-p", published, "-m", "concurrent advance").trim();
            git(cwd, "-c", "core.hooksPath=/dev/null", "update-ref", "refs/heads/main", descendant, published);
            if (shutdown) abort.abort();

            expect(await pending).toMatchObject({ hash: published, subject: "published before advance" });
            await hookStopped(cwd);
            expect(git(cwd, "rev-parse", "HEAD").trim()).toBe(descendant);
            expect(git(cwd, "status", "--porcelain", "--", "selected.txt")).toBe("");
            expect(git(cwd, "diff", "--cached", "--", "other.txt")).toBe(staged);
            expect(git(cwd, "diff", "--", "other.txt")).toBe(unstaged);
        } finally {
            abort.abort();
            await pending;
        }
    }));
}

test("uncertain publication preserves the prepared index and reports recovery files", () => bounded(async () => {
    const cwd = repo();
    const head = git(cwd, "rev-parse", "HEAD").trim();
    const index = readFileSync(join(cwd, ".git", "index"));
    hangingHook(cwd, "reference-transaction", "committed");
    const abort = new AbortController();
    const pending = gitCommit(cwd, ["selected.txt"], "publication uncertain", { signal: abort.signal }).catch((e) => e);
    try {
        for (let i = 0; i < 200 && !existsSync(join(cwd, ".git", "hook-pid")); i++) await Bun.sleep(10);
        expect(existsSync(join(cwd, ".git", "hook-pid"))).toBe(true);
        const replacement = git(cwd, "commit-tree", `${head}^{tree}`, "-p", head, "-m", "concurrent replacement").trim();
        git(cwd, "-c", "core.hooksPath=/dev/null", "update-ref", "refs/heads/main", replacement);

        const result = await pending;
        expect(result).toBeInstanceOf(Error);
        expect(result.code).toBe("git");
        expect(result.message).toContain("publication could not be confirmed");
        expect(result.message).toContain(join(cwd, ".git", "index.lock"));
        await hookStopped(cwd, true);
        expect(readFileSync(join(cwd, ".git", "index"))).toEqual(index);
        expect(git(cwd, "rev-parse", "HEAD").trim()).toBe(replacement);
        const recovery = readdirSync(join(cwd, ".git")).find((name) => name.startsWith("cavvy-commit-"));
        expect(recovery).toBeDefined();
        expect(result.message).toContain(join(cwd, ".git", recovery!));
        const prepared = Bun.spawnSync(gitArgv(["show", ":selected.txt"]), {
            cwd, env: { ...gitEnv(), GIT_INDEX_FILE: join(cwd, ".git", "index.lock") }, stdout: "pipe", stderr: "pipe",
        });
        expect(prepared.exitCode).toBe(0);
        expect(prepared.stdout.toString()).toBe("after\n");
    } finally {
        abort.abort();
        await pending;
    }
}));

for (const shutdown of [false, true]) {
    test(`${shutdown ? "shutdown after publication" : "normal publication"} installs the validated index without another slow read`, async () => {
        const cwd = repo();
        const hook = join(cwd, ".git", "hooks", "reference-transaction");
        writeFileSync(hook, '#!/bin/sh\n[ "$1" = committed ] || exit 0\ntouch .git/commit-published\n' +
            (shutdown ? 'while [ ! -e .git/commit-release ]; do sleep 0.02; done\n' : ""));
        chmodSync(hook, 0o755);
        const realGit = Bun.which("git")!;
        const bin = join(cwd, ".git", "slow-git");
        mkdirSync(bin);
        writeFileSync(join(bin, "git"), `#!/bin/sh
    case " $* " in
        *" ls-files --stage --debug -z "*)
            if [ -e .git/commit-published ]; then
                echo delayed >> .git/slow-final-reads
                sleep 3
            fi
            ;;
    esac
    exec '${realGit.replace(/'/g, "'\\''")}' "$@"
    `);
        chmodSync(join(bin, "git"), 0o755);
        const path = process.env.PATH;
        const abort = new AbortController();
        let pending: Promise<unknown> | undefined;
        try {
            process.env.PATH = `${bin}:${path}`;
            pending = gitCommit(cwd, ["selected.txt"], "install prepared index", { signal: abort.signal }).catch((e) => e);
            if (shutdown) {
                for (let i = 0; i < 200 && !existsSync(join(cwd, ".git", "commit-published")); i++) await Bun.sleep(10);
                expect(existsSync(join(cwd, ".git", "commit-published"))).toBe(true);
                abort.abort();
            }
            const result = await pending;
            expect(git(cwd, "show", "HEAD:selected.txt")).toBe("after\n");
            expect(git(cwd, "status", "--porcelain")).toBe("");
            expect(result).toMatchObject({ hash: git(cwd, "rev-parse", "HEAD").trim(), subject: "install prepared index" });
            expect(existsSync(join(cwd, ".git", "slow-final-reads"))).toBe(false);
            expect(existsSync(join(cwd, ".git", "index.lock"))).toBe(false);
        } finally {
            writeFileSync(join(cwd, ".git", "commit-release"), "");
            await pending;
            process.env.PATH = path;
        }
    }, 10_000);
}
