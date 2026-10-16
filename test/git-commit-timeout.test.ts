import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
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
function repo() {
    const cwd = join(realpathSync(iso.home), `timeout-${next++}`);
    mkdirSync(cwd);
    git(cwd, "init", "-q", "-b", "main");
    git(cwd, "config", "user.name", "Harness Test");
    git(cwd, "config", "user.email", "test@example.invalid");
    git(cwd, "config", "commit.gpgsign", "false");
    git(cwd, "config", "core.hooksPath", join(cwd, ".git", "hooks"));
    writeFileSync(join(cwd, "selected.txt"), "before\n");
    git(cwd, "add", "--", "selected.txt");
    git(cwd, "commit", "-qm", "initial");
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

async function hookStopped(cwd: string) {
    const pid = Number(readFileSync(join(cwd, ".git", "hook-pid"), "utf8"));
    const alive = () => {
        try { process.kill(pid, 0); return true; }
        catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return false; throw e; }
    };
    for (let i = 0; i < 100 && alive(); i++) await Bun.sleep(10);
    expect(alive()).toBe(false);
    expect(existsSync(join(cwd, ".git", "index.lock"))).toBe(false);
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

test("normal final index validation is not limited to the shutdown recovery deadline", async () => {
    const cwd = repo();
    const hook = join(cwd, ".git", "hooks", "reference-transaction");
    writeFileSync(hook, '#!/bin/sh\n[ "$1" != committed ] || touch .git/commit-published\n');
    chmodSync(hook, 0o755);
    const realGit = Bun.which("git")!;
    const bin = join(cwd, ".git", "slow-git");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh
case " $* " in
    *" ls-files --stage --debug -z "*)
        if [ -e .git/commit-published ]; then
            echo delayed >> .git/slow-final-reads
            sleep 1.1
        fi
        ;;
esac
exec '${realGit.replace(/'/g, "'\\''")}' "$@"
`);
    chmodSync(join(bin, "git"), 0o755);
    const path = process.env.PATH;
    try {
        process.env.PATH = `${bin}:${path}`;
        const result = await gitCommit(cwd, ["selected.txt"], "slow final index validation");
        expect(result.subject).toBe("slow final index validation");
        expect(readFileSync(join(cwd, ".git", "slow-final-reads"), "utf8")).toContain("delayed\n");
        expect(git(cwd, "rev-parse", "HEAD").trim()).toBe(result.hash);
        expect(git(cwd, "status", "--porcelain")).toBe("");
        expect(existsSync(join(cwd, ".git", "index.lock"))).toBe(false);
    } finally {
        process.env.PATH = path;
    }
}, 10_000);
