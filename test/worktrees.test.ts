import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { createWorktree, listWorktrees, parseWorktrees, removeWorktree, runGitAsync } = await import("../src/server/worktrees");
const { Engine } = await import("../src/server/engine");
const { gitArgv, gitEnv } = await import("../src/util/git");
const { trustFolder } = await import("../src/config/trust");
afterAll(() => iso.cleanup());

function git(cwd: string, ...args: string[]): string {
    const result = Bun.spawnSync(gitArgv(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Harness Test", "-c", "user.email=test@example.invalid", ...args]), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
}

function repo(name: string, commit = true) {
    const path = join(realpathSync(iso.home), name);
    mkdirSync(path);
    git(path, "init", "-b", "main");
    if (commit) git(path, "commit", "--allow-empty", "-m", "Initial commit");
    return path;
}

describe("worktree selection", () => {
    test("discovers branches, detached paths, locks, and missing worktrees from any nested cwd", () => {
        const main = repo("repository");
        const linked = join(realpathSync(iso.home), "feature worktree");
        const detached = join(realpathSync(iso.home), "detached \\\"name\n");
        const deleted = join(realpathSync(iso.home), "deleted tree");
        git(main, "worktree", "add", "-b", "feature/test", linked);
        git(main, "worktree", "add", "--detach", detached);
        git(main, "worktree", "lock", "--reason", "On external disk\nkeep registered", linked);
        git(main, "worktree", "add", "-b", "stale", deleted);
        rmSync(deleted, { recursive: true });
        const nested = join(linked, "nested");
        mkdirSync(nested);

        const found = listWorktrees(nested);
        expect(found).toHaveLength(4);
        expect(found.find((w) => w.path === main)).toMatchObject({ branch: "main", current: false, exists: true, detached: false });
        expect(found.find((w) => w.path === linked)).toMatchObject({ branch: "feature/test", current: true, exists: true, locked: "On external disk\nkeep registered" });
        expect(found.find((w) => w.path === detached)).toMatchObject({ detached: true, exists: true, current: false });
        expect(found.find((w) => w.path === detached)?.branch).toBeUndefined();
        expect(found.find((w) => w.path === deleted)?.exists).toBe(false);
        expect(found.find((w) => w.path === deleted)?.prunable).toBeDefined();
        expect(listWorktrees(detached).find((w) => w.current)?.path).toBe(detached);
    });

    test("a fresh repository still offers its initial branch", () => {
        const main = repo("unborn", false);
        expect(listWorktrees(main)).toMatchObject([{ path: main, branch: "main", exists: true, current: true }]);
    });

    test("reads worktrees attached to a bare repository without offering its Git directory", () => {
        const bare = join(iso.home, "bare.git");
        git(iso.home, "init", "--bare", bare);
        expect(listWorktrees(bare)).toEqual([]);
    });

    test("NUL fields preserve odd paths and distinguish flag-only locks", () => {
        expect(parseWorktrees("worktree /a\n b\0HEAD 123\0branch refs/heads/topic\0locked\0\0worktree /bare\0bare\0\0"))
            .toEqual([{ path: "/a\n b", head: "123", branch: "topic", locked: "", detached: false, bare: false }, { path: "/bare", detached: false, bare: true }]);
    });

    test("the RPC refreshes without trusting folders or invoking repository fsmonitor", async () => {
        const main = repo("rpc repository");
        const sentinel = join(main, "executed");
        const monitor = join(main, "fsmonitor");
        writeFileSync(monitor, `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 });
        git(main, "config", "core.fsmonitor", monitor);
        mkdirSync(join(main, ".harness"));
        writeFileSync(join(main, ".harness", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch '${sentinel}'` }] }] } }));
        const engine = new Engine({ listModels: async () => [] });
        const client = { subs: new Set<string>(), send: () => {} };
        try {
            expect(await engine.handle(client, "projects.worktrees", { path: main })).toHaveLength(1);
            const linked = join(realpathSync(iso.home), "rpc new worktree");
            git(main, "worktree", "add", "-b", "new", linked);
            expect(await engine.handle(client, "projects.worktrees", { path: main })).toHaveLength(2);
            expect(existsSync(sentinel)).toBe(false);
            expect(engine.workspaces.size).toBe(0);
        } finally { await engine.stop(); }
    });

    test("outside a repository reports an error rather than a fabricated main branch", () => {
        expect(() => listWorktrees(iso.home)).toThrow("Could not list this project's Git worktrees.");
    });

    test("marks the main worktree and those under its .claude/worktrees", () => {
        const main = repo("marks");
        const managed = join(main, ".claude", "worktrees", "inside");
        const outside = join(realpathSync(iso.home), "marks outside");
        git(main, "worktree", "add", "-b", "inside", managed);
        git(main, "worktree", "add", "-b", "outside", outside);
        const found = listWorktrees(main);
        expect(found.find((w) => w.path === main)).toMatchObject({ main: true, managed: false });
        expect(found.find((w) => w.path === managed)).toMatchObject({ main: false, managed: true });
        expect(found.find((w) => w.path === outside)).toMatchObject({ main: false, managed: false });
    });
});

const noop = () => false;
const head = (cwd: string, rev = "HEAD") => git(cwd, "rev-parse", rev);
const managedDir = (main: string) => join(main, ".claude", "worktrees");

describe("creating a worktree", () => {
    test("defaults to .claude/worktrees/<branch with - for />, on a new branch from the folder's HEAD, with no upstream and no hooks", async () => {
        const main = repo("create default");
        const sentinel = join(main, "hook-ran");
        writeFileSync(join(main, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 });
        const made = await createWorktree({ path: main, branch: "feat/login" });
        expect(made).toEqual({ path: join(managedDir(main), "feat-login"), branch: "feat/login" });
        expect(git(made.path, "branch", "--show-current")).toBe("feat/login");
        expect(head(made.path)).toBe(head(main));
        expect(() => git(made.path, "rev-parse", "--abbrev-ref", "feat/login@{upstream}")).toThrow();
        expect(existsSync(sentinel)).toBe(false);
        expect(listWorktrees(main).find((w) => w.path === made.path)).toMatchObject({ managed: true, branch: "feat/login" });
    });

    test("starts from another branch or commit, in a folder the user named", async () => {
        const main = repo("create base");
        git(main, "checkout", "-q", "-b", "other");
        git(main, "commit", "--allow-empty", "-m", "on other");
        const other = head(main);
        git(main, "checkout", "-q", "main");
        expect(head((await createWorktree({ path: main, branch: "from-other", base: "other", folder: "named" })).path)).toBe(other);
        expect(existsSync(join(managedDir(main), "named"))).toBe(true);
        const first = head(main, "main");
        expect(head((await createWorktree({ path: main, branch: "from-commit", base: first })).path)).toBe(first);
    });

    test("from a linked worktree it goes under the main worktree, starting at the linked worktree's HEAD", async () => {
        const main = repo("create linked");
        const linked = join(realpathSync(iso.home), "create linked sibling");
        git(main, "worktree", "add", "-b", "sibling", linked);
        git(linked, "commit", "--allow-empty", "-m", "sibling work");
        const nested = join(linked, "sub");
        mkdirSync(nested);
        const made = await createWorktree({ path: nested, branch: "next" });
        expect(made.path).toBe(join(managedDir(main), "next"));
        expect(head(made.path)).toBe(head(linked));
        expect(existsSync(join(linked, ".claude"))).toBe(false);
    });

    test("invalid branch names are refused before anything is made", async () => {
        const main = repo("create invalid");
        for (const branch of ["", "has space", "-x", "@", "a..b", "@{-1}", "HEAD", "ends/", "x.lock", "tab\tname"]) {
            await expect(createWorktree({ path: main, branch })).rejects.toMatchObject({ code: "invalid_branch" });
        }
        await expect(createWorktree({ path: main, branch: "has space" })).rejects.toThrow("can't contain spaces");
        expect(existsSync(join(main, ".claude"))).toBe(false);
    });

    test("an existing branch, an existing path and an unknown base are refused", async () => {
        const main = repo("create taken");
        git(main, "branch", "taken");
        await expect(createWorktree({ path: main, branch: "taken" })).rejects.toMatchObject({ code: "branch_exists" });
        mkdirSync(join(managedDir(main), "there"), { recursive: true });
        await expect(createWorktree({ path: main, branch: "there" })).rejects.toMatchObject({ code: "path_exists" });
        await expect(createWorktree({ path: main, branch: "fresh", base: "no-such-ref" })).rejects.toMatchObject({ code: "bad_base" });
        await expect(createWorktree({ path: main, branch: "fresh", base: "--orphan" })).rejects.toMatchObject({ code: "bad_base" });
        expect(() => git(main, "rev-parse", "--verify", "refs/heads/fresh")).toThrow();
    });

    test("an unborn HEAD has no base", async () => {
        await expect(createWorktree({ path: repo("create unborn", false), branch: "x" })).rejects.toMatchObject({ code: "bad_base" });
    });

    test("the folder is one path segment", async () => {
        const main = repo("create folder");
        for (const folder of ["../escape", "a/b", "..", ".", "-rf", "x\\y", "a..b"]) {
            await expect(createWorktree({ path: main, branch: "ok", folder })).rejects.toMatchObject({ code: "bad_folder" });
        }
        expect(existsSync(join(realpathSync(iso.home), "escape"))).toBe(false);
    });

    test("a symlinked .claude (or worktrees) can't send the checkout elsewhere", async () => {
        const elsewhere = join(realpathSync(iso.home), "elsewhere");
        mkdirSync(elsewhere);
        const main = repo("create symlink");
        symlinkSync(elsewhere, join(main, ".claude"));
        await expect(createWorktree({ path: main, branch: "escape" })).rejects.toMatchObject({ code: "path_outside" });
        const other = repo("create symlink inner");
        mkdirSync(join(other, ".claude"));
        symlinkSync(elsewhere, managedDir(other));
        await expect(createWorktree({ path: other, branch: "escape" })).rejects.toMatchObject({ code: "path_outside" });
        expect(existsSync(join(elsewhere, "escape"))).toBe(false);
        expect(existsSync(join(elsewhere, "worktrees"))).toBe(false);
    });

    test("a location the user chose: absolute, new, in an existing folder", async () => {
        const main = repo("create location");
        const parent = join(realpathSync(iso.home), "chosen parent");
        mkdirSync(parent);
        const made = await createWorktree({ path: main, branch: "chosen", location: join(parent, "wt") });
        expect(made.path).toBe(join(parent, "wt"));
        expect(git(made.path, "branch", "--show-current")).toBe("chosen");
        await expect(createWorktree({ path: main, branch: "rel", location: "relative/wt" })).rejects.toMatchObject({ code: "bad_location" });
        await expect(createWorktree({ path: main, branch: "nop", location: join(parent, "missing", "wt") })).rejects.toMatchObject({ code: "bad_location" });
        await expect(createWorktree({ path: main, branch: "again", location: made.path })).rejects.toMatchObject({ code: "path_exists" });
        expect(existsSync(join(main, ".claude"))).toBe(false);
    });

    test("outside a repository", async () => {
        const plain = join(realpathSync(iso.home), "not a repo");
        mkdirSync(plain);
        await expect(createWorktree({ path: plain, branch: "x" })).rejects.toMatchObject({ code: "not_git" });
    });

    test("Git's own failure text is logged, never shown", async () => {
        const main = repo("create git fails");
        // Passes every check, then git can't take the ref's lock.
        writeFileSync(join(main, ".git", "refs", "heads", "locked-ref.lock"), "");
        const logged: string[] = [];
        const failed = createWorktree({ path: main, branch: "locked-ref" }, (m) => logged.push(m));
        await expect(failed).rejects.toMatchObject({ code: "git_failed", message: "Git couldn't create the worktree." });
        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain("git worktree add failed: ");
        expect(logged[0]).toContain("locked-ref.lock");
    });
});

describe("a repository's own config in a project that isn't trusted", () => {
    /** A repository whose *.txt files go through `filter`, and a smudge command that leaves a mark. */
    function filtered(name: string) {
        const main = repo(name);
        writeFileSync(join(main, ".gitattributes"), "*.txt filter=evil\n");
        writeFileSync(join(main, "a.txt"), "hi\n");
        git(main, "add", ".");
        git(main, "commit", "-m", "files");
        const mark = join(main, "..", `${name} smudged`);
        const script = join(main, "..", `${name} smudge.sh`);
        writeFileSync(script, `#!/bin/sh\ntouch '${mark}'\ncat\n`, { mode: 0o755 });
        const config = `[filter "evil"]\n\tsmudge = '${script}'\n`;
        return { main, mark, config };
    }

    test("a filter driver in .git/config needs trust: nothing is checked out or made", async () => {
        const { main, mark, config } = filtered("filter-local");
        writeFileSync(join(main, ".git", "config"), config, { flag: "a" });
        const failed = createWorktree({ path: main, branch: "smudged" });
        await expect(failed).rejects.toMatchObject({ code: "needs_trust" });
        await expect(createWorktree({ path: main, branch: "smudged" })).rejects.toThrow("(filter)");
        expect(existsSync(mark)).toBe(false);
        expect(existsSync(join(main, ".claude"))).toBe(false);
        expect(() => git(main, "rev-parse", "--verify", "refs/heads/smudged")).toThrow();
    });

    test("an include that could bring one in needs trust too", async () => {
        const { main, mark, config } = filtered("filter-include");
        const included = join(main, "..", "filter-include.cfg");
        writeFileSync(included, config);
        git(main, "config", "include.path", included);
        await expect(createWorktree({ path: main, branch: "smudged" })).rejects.toMatchObject({ code: "needs_trust" });
        expect(existsSync(mark)).toBe(false);
    });

    test("so does one in per-worktree config", async () => {
        const { main, mark, config } = filtered("filter-worktree");
        git(main, "worktree", "add", "-b", "second", join(main, "..", "filter-worktree second"));
        git(main, "config", "extensions.worktreeConfig", "true");
        writeFileSync(join(main, ".git", "config.worktree"), config);
        await expect(createWorktree({ path: main, branch: "smudged" })).rejects.toMatchObject({ code: "needs_trust" });
        expect(existsSync(mark)).toBe(false);
    });

    test("ordinary clone bookkeeping doesn't", async () => {
        const main = repo("config-inert");
        git(main, "remote", "add", "origin", "https://example.invalid/repo.git");
        git(main, "config", "branch.main.remote", "origin");
        git(main, "config", "branch.main.merge", "refs/heads/main");
        git(main, "config", "branch.main.vscode-merge-base", "origin/main");
        expect((await createWorktree({ path: main, branch: "plain" })).branch).toBe("plain");
    });

    test("in a trusted project the filters run, as Git LFS needs", async () => {
        const { main, mark, config } = filtered("filter-trusted");
        writeFileSync(join(main, ".git", "config"), config, { flag: "a" });
        trustFolder(main);
        const made = await createWorktree({ path: main, branch: "smudged" });
        expect(existsSync(join(made.path, "a.txt"))).toBe(true);
        expect(existsSync(mark)).toBe(true);
    });
});

describe("removing a worktree", () => {
    async function setup(name: string) {
        const main = repo(name);
        const made = await createWorktree({ path: main, branch: `${name.replace(/ /g, "-")}-wt` });
        return { main, path: made.path, branch: made.branch };
    }

    test("a clean worktree goes and its branch stays", async () => {
        const { main, path, branch } = await setup("remove clean");
        expect(await removeWorktree({ path: main, worktree: path, inUse: noop })).toEqual({ removed: true });
        expect(existsSync(path)).toBe(false);
        expect(listWorktrees(main).map((w) => w.path)).toEqual([main]);
        expect(git(main, "branch", "--list", branch)).toContain(branch);
    });

    test("modified or untracked files are refused, even when the repo's config hides untracked files", async () => {
        const { main, path } = await setup("remove dirty");
        git(main, "config", "status.showUntrackedFiles", "no");
        writeFileSync(join(path, "untracked.txt"), "keep me");
        await expect(removeWorktree({ path: main, worktree: path, inUse: noop })).rejects.toMatchObject({ code: "dirty" });
        expect(existsSync(join(path, "untracked.txt"))).toBe(true);
        rmSync(join(path, "untracked.txt"));
        writeFileSync(join(path, "tracked.txt"), "one");
        git(path, "add", "tracked.txt");
        await expect(removeWorktree({ path: main, worktree: path, inUse: noop })).rejects.toThrow("has uncommitted or untracked changes");
        expect(existsSync(path)).toBe(true);
    });

    test("the main worktree and worktrees outside .claude/worktrees are refused", async () => {
        const main = repo("remove refused");
        const outside = join(realpathSync(iso.home), "remove refused outside");
        git(main, "worktree", "add", "-b", "outside", outside);
        await expect(removeWorktree({ path: main, worktree: main, inUse: noop })).rejects.toMatchObject({ code: "not_managed" });
        await expect(removeWorktree({ path: main, worktree: outside, inUse: noop })).rejects.toMatchObject({ code: "not_managed" });
        await expect(removeWorktree({ path: main, worktree: join(managedDir(main), "unknown"), inUse: noop })).rejects.toMatchObject({ code: "not_found" });
        expect(existsSync(outside)).toBe(true);
    });

    test("a worktree reached through a symlinked .claude isn't managed", async () => {
        const main = repo("remove symlink");
        const elsewhere = join(realpathSync(iso.home), "remove symlink target");
        mkdirSync(join(elsewhere, "worktrees"), { recursive: true });
        symlinkSync(elsewhere, join(main, ".claude"));
        git(main, "worktree", "add", "-b", "via-link", join(main, ".claude", "worktrees", "via-link"));
        const listed = listWorktrees(main).find((w) => w.branch === "via-link");
        expect(listed?.managed).toBe(false);
        await expect(removeWorktree({ path: main, worktree: listed!.path, inUse: noop })).rejects.toMatchObject({ code: "not_managed" });
    });

    test("locked, or with a session open, is refused", async () => {
        const { main, path } = await setup("remove locked");
        git(main, "worktree", "lock", path);
        await expect(removeWorktree({ path: main, worktree: path, inUse: noop })).rejects.toMatchObject({ code: "locked" });
        git(main, "worktree", "unlock", path);
        await expect(removeWorktree({ path: main, worktree: path, inUse: (p) => p === path })).rejects.toMatchObject({ code: "in_use" });
        expect(existsSync(path)).toBe(true);
    });

    test("a detached worktree is removed only when its commit is on a branch", async () => {
        const main = repo("remove detached");
        const path = join(managedDir(main), "detached");
        git(main, "worktree", "add", "--detach", path);
        git(path, "commit", "--allow-empty", "-m", "only here");
        await expect(removeWorktree({ path: main, worktree: path, inUse: noop })).rejects.toMatchObject({ code: "unreachable" });
        git(path, "checkout", "-q", "--detach", "main");
        await removeWorktree({ path: main, worktree: path, inUse: noop });
        expect(existsSync(path)).toBe(false);
    });

    test("a missing worktree loses only its own record, not those of others that are away (#3)", async () => {
        const { main, path } = await setup("remove missing only");
        const away = join(realpathSync(iso.home), "remove-missing-only-away");
        git(main, "worktree", "add", "-b", "away", away);
        rmSync(path, { recursive: true });
        // Like a drive that isn't mounted right now.
        renameSync(away, `${away}-unmounted`);
        expect(await removeWorktree({ path: main, worktree: path, inUse: noop })).toEqual({ removed: true });
        const left = listWorktrees(main);
        expect(left.map((w) => w.path)).toEqual([main, away]);
        expect(left[1]?.exists).toBe(false);
    });

    test("a missing detached worktree whose commit is on no branch is refused", async () => {
        const main = repo("remove missing detached");
        const detached = join(managedDir(main), "lost");
        git(main, "worktree", "add", "--detach", detached);
        git(detached, "commit", "--allow-empty", "-m", "only here");
        rmSync(detached, { recursive: true });
        await expect(removeWorktree({ path: main, worktree: detached, inUse: noop })).rejects.toMatchObject({ code: "unreachable" });
        expect(listWorktrees(main)).toHaveLength(2);
    });

    test("one whose folder is already gone loses its record", async () => {
        const { main, path } = await setup("remove gone");
        rmSync(path, { recursive: true });
        expect(listWorktrees(main).find((w) => w.path === path)).toMatchObject({ exists: false, managed: true });
        await removeWorktree({ path: main, worktree: path, inUse: noop });
        expect(listWorktrees(main).map((w) => w.path)).toEqual([main]);
    });

    test("works when asked from inside the worktree being removed's sibling", async () => {
        const { main, path } = await setup("remove from linked");
        const other = await createWorktree({ path: main, branch: "other-wt" });
        await removeWorktree({ path: other.path, worktree: path, inUse: noop });
        expect(existsSync(path)).toBe(false);
        expect(lstatSync(other.path).isDirectory()).toBe(true);
    });
});

describe("the worktree RPCs", () => {
    test("create, list, refuse removal while a session is open there, then remove", async () => {
        const main = repo("rpc create");
        const engine = new Engine({ listModels: async () => [] });
        const client = { subs: new Set<string>(), send: () => {} };
        try {
            const made = (await engine.handle(client, "projects.createWorktree", { path: main, branch: "rpc/made" })) as { path: string; branch: string };
            expect(made.path).toBe(join(main, ".claude", "worktrees", "rpc-made"));
            const listed = (await engine.handle(client, "projects.worktrees", { path: main })) as { path: string; managed: boolean }[];
            expect(listed.find((w) => w.path === made.path)?.managed).toBe(true);
            await engine.handle(client, "session.create", { cwd: made.path });
            await expect(engine.handle(client, "projects.removeWorktree", { path: main, worktree: made.path })).rejects.toMatchObject({ code: "in_use" });
            for (const rt of [...engine.runtimes.values()]) {
                engine.runtimes.delete(rt.id);
                await rt.close();
            }
            expect(engine.workspaces.has(made.path)).toBe(true);
            expect(await engine.handle(client, "projects.removeWorktree", { path: main, worktree: made.path })).toEqual({ removed: true });
            expect(existsSync(made.path)).toBe(false);
            expect(engine.workspaces.has(made.path)).toBe(false);
        } finally { await engine.stop(); }
    });

    test("a session can't open in a worktree while it's being removed, and one open in another process blocks removal", async () => {
        const main = repo("rpc reserve");
        const engine = new Engine({ listModels: async () => [] });
        const client = { subs: new Set<string>(), send: () => {} };
        try {
            const made = (await engine.handle(client, "projects.createWorktree", { path: main, branch: "reserved" })) as { path: string };
            const removing = engine.handle(client, "projects.removeWorktree", { path: main, worktree: made.path });
            await expect(engine.handle(client, "session.create", { cwd: made.path })).rejects.toMatchObject({ code: "busy" });
            await removing;
            expect(existsSync(made.path)).toBe(false);

            // A session file in another process, with no recent activity and beyond the sidebar's listing.
            const other = (await engine.handle(client, "projects.createWorktree", { path: main, branch: "elsewhere" })) as { path: string };
            const { projectStateDir } = await import("../src/config/paths");
            const dir = projectStateDir(other.path);
            mkdirSync(dir, { recursive: true });
            const file = join(dir, "held.jsonl");
            writeFileSync(file, JSON.stringify({ t: "meta", v: 1, id: "held", cwd: other.path, createdAt: 0 }) + "\n");
            const holder = Bun.spawn(["sleep", "30"]);
            try {
                writeFileSync(`${file}.lock`, JSON.stringify({ pid: holder.pid, at: Date.now() }));
                await expect(engine.handle(client, "projects.removeWorktree", { path: main, worktree: other.path })).rejects.toMatchObject({ code: "in_use" });
            } finally { holder.kill(); }
            expect(existsSync(other.path)).toBe(true);
        } finally { await engine.stop(); }
    });

    test("parameters are checked at the boundary", async () => {
        const main = repo("rpc params");
        const engine = new Engine({ listModels: async () => [] });
        const client = { subs: new Set<string>(), send: () => {} };
        try {
            await expect(engine.handle(client, "projects.createWorktree", { path: main, branch: 7 })).rejects.toThrow("branch must be a string");
            await expect(engine.handle(client, "projects.createWorktree", { path: main, branch: "x".repeat(201) })).rejects.toMatchObject({ code: "invalid" });
            await expect(engine.handle(client, "projects.createWorktree", { path: main, branch: "nul\0name" })).rejects.toMatchObject({ code: "invalid" });
            await expect(engine.handle(client, "projects.createWorktree", { path: main, branch: "ok", folder: "../up" })).rejects.toMatchObject({ code: "bad_folder" });
            await expect(engine.handle(client, "projects.removeWorktree", { path: main })).rejects.toThrow("worktree must be a string");
            expect(existsSync(join(main, ".claude"))).toBe(false);
        } finally { await engine.stop(); }
    });
});

/** A repository whose *.txt files have `attribute` set, and a script that leaves a mark then passes its input through. */
function withFilterScript(name: string) {
    const main = repo(name);
    writeFileSync(join(main, ".gitattributes"), "*.txt filter=evil\n");
    writeFileSync(join(main, "a.txt"), "hi\n");
    git(main, "add", ".");
    git(main, "commit", "-m", "files");
    const mark = join(main, "..", `${name}-ran`);
    const script = join(main, "..", `${name}-filter.sh`);
    writeFileSync(script, `#!/bin/sh\ntouch '${mark}'\ncat\n`, { mode: 0o755 });
    return { main, mark, script };
}

describe("review fixes", () => {
    test("#1 removal in an untrusted project doesn't let status run the repository's clean filter", async () => {
        const { main, mark, script } = withFilterScript("rm-clean");
        const made = await createWorktree({ path: main, branch: "wt" });
        git(main, "config", "filter.evil.clean", `'${script}'`);
        const later = new Date(Date.now() + 60_000);
        utimesSync(join(made.path, "a.txt"), later, later);
        await expect(removeWorktree({ path: main, worktree: made.path, inUse: noop })).rejects.toMatchObject({ code: "needs_trust" });
        expect(existsSync(mark)).toBe(false);
        expect(existsSync(made.path)).toBe(true);
    });

    test("#1 the worktree's own per-worktree config is audited too", async () => {
        const { main, mark, script } = withFilterScript("rm-wtconfig");
        const made = await createWorktree({ path: main, branch: "wt" });
        git(main, "config", "extensions.worktreeConfig", "true");
        git(made.path, "config", "--worktree", "filter.evil.clean", `'${script}'`);
        const later = new Date(Date.now() + 60_000);
        utimesSync(join(made.path, "a.txt"), later, later);
        await expect(removeWorktree({ path: main, worktree: made.path, inUse: noop })).rejects.toMatchObject({ code: "needs_trust" });
        expect(existsSync(mark)).toBe(false);
    });

    test("#1 in a trusted project removal goes ahead", async () => {
        const { main, script } = withFilterScript("rm-trusted");
        const made = await createWorktree({ path: main, branch: "wt" });
        git(main, "config", "filter.evil.clean", `'${script}'`);
        trustFolder(main);
        expect(await removeWorktree({ path: main, worktree: made.path, inUse: noop })).toEqual({ removed: true });
    });

    /** A partial clone (blobs fetched on demand) whose promisor remote runs a marked upload-pack. */
    function partialClone(name: string) {
        const src = repo(`${name}-src`);
        writeFileSync(join(src, "f.txt"), "content\n");
        git(src, "add", ".");
        git(src, "commit", "-m", "f");
        git(src, "config", "uploadpack.allowFilter", "true");
        const pc = join(realpathSync(iso.home), `${name}-pc`);
        git(iso.home, "clone", "-q", "--filter=blob:none", `file://${src}`, pc);
        const mark = join(realpathSync(iso.home), `${name}-fetched`);
        const script = join(realpathSync(iso.home), `${name}-upload-pack.sh`);
        writeFileSync(script, `#!/bin/sh\ntouch '${mark}'\nexec git-upload-pack "$@"\n`, { mode: 0o755 });
        git(pc, "config", "remote.origin.uploadpack", script);
        return { pc, mark };
    }
    const missing = "0123456789abcdef0123456789abcdef01234567";

    test("#2 in an untrusted partial clone the trust check comes before resolving the base", async () => {
        const { pc, mark } = partialClone("pc-untrusted");
        await expect(createWorktree({ path: pc, branch: "x1", base: missing })).rejects.toMatchObject({ code: "needs_trust" });
        expect(existsSync(mark)).toBe(false);
    });

    test("#2 even in a trusted one, checking the base doesn't fetch", async () => {
        const { pc, mark } = partialClone("pc-trusted");
        trustFolder(pc);
        await expect(createWorktree({ path: pc, branch: "x1", base: missing })).rejects.toMatchObject({ code: "bad_base" });
        expect(existsSync(mark)).toBe(false);
    });

    test("#2 the per-worktree config of the folder the request comes from is audited", async () => {
        const { main, mark, script } = withFilterScript("cwd-wtconfig");
        const linked = join(realpathSync(iso.home), "cwd-wtconfig-linked");
        git(main, "worktree", "add", "-b", "linked", linked);
        git(main, "config", "extensions.worktreeConfig", "true");
        git(linked, "config", "--worktree", "filter.evil.smudge", `'${script}'`);
        await expect(createWorktree({ path: linked, branch: "next" })).rejects.toMatchObject({ code: "needs_trust" });
        expect(existsSync(mark)).toBe(false);
    });

    test("with per-worktree config turned on but no worktree having any, nothing needs trust", async () => {
        const main = repo("wtconfig-empty");
        git(main, "worktree", "add", "-b", "linked", join(realpathSync(iso.home), "wtconfig-empty-linked"));
        git(main, "config", "extensions.worktreeConfig", "true");
        const made = await createWorktree({ path: main, branch: "wt" });
        expect(await removeWorktree({ path: main, worktree: made.path, inUse: noop })).toEqual({ removed: true });
    });

    test("#4 ignored files aren't deleted until the user has seen exactly them", async () => {
        const main = repo("rm-ignored");
        writeFileSync(join(main, ".gitignore"), ".env\nnode_modules/\n*.log\n");
        git(main, "add", ".");
        git(main, "commit", "-m", "ignore");
        const made = await createWorktree({ path: main, branch: "wt" });
        writeFileSync(join(made.path, ".env"), "SECRET=1\n");
        mkdirSync(join(made.path, "node_modules", "pkg"), { recursive: true });
        writeFileSync(join(made.path, "node_modules", "pkg", "index.js"), "");
        const first = await removeWorktree({ path: main, worktree: made.path, inUse: noop });
        expect(first).toMatchObject({ removed: false, ignored: [".env", "node_modules/"], total: 2 });
        expect(existsSync(join(made.path, ".env"))).toBe(true);
        if (first.removed) throw new Error("unreachable");
        // Something new appeared after the user looked: asked again.
        writeFileSync(join(made.path, "debug.log"), "");
        const second = await removeWorktree({ path: main, worktree: made.path, inUse: noop, deleteIgnored: first.confirm });
        expect(second).toMatchObject({ removed: false, ignored: [".env", "debug.log", "node_modules/"], total: 3 });
        expect(existsSync(join(made.path, ".env"))).toBe(true);
        if (second.removed) throw new Error("unreachable");
        expect(await removeWorktree({ path: main, worktree: made.path, inUse: noop, deleteIgnored: "0".repeat(64) })).toMatchObject({ removed: false });
        expect(await removeWorktree({ path: main, worktree: made.path, inUse: noop, deleteIgnored: second.confirm })).toEqual({ removed: true });
        expect(existsSync(made.path)).toBe(false);
    });

    test("#5 a filter's background child holding stderr open doesn't hold the call", async () => {
        const main = repo("slow-filter");
        writeFileSync(join(main, ".gitattributes"), "*.txt filter=slow\n");
        writeFileSync(join(main, "a.txt"), "hi\n");
        git(main, "add", ".");
        git(main, "commit", "-m", "files");
        git(main, "config", "filter.slow.smudge", "sh -c 'sleep 8 >/dev/null </dev/null & cat'");
        trustFolder(main);
        const start = Date.now();
        const made = await createWorktree({ path: main, branch: "wt" });
        expect(Date.now() - start).toBeLessThan(3000);
        expect(existsSync(join(made.path, "a.txt"))).toBe(true);
    });

    test("#6 a second removal of a worktree that's being removed is refused", async () => {
        const main = repo("rm-overlap");
        const engine = new Engine({ listModels: async () => [] });
        const client = { subs: new Set<string>(), send: () => {} };
        try {
            const made = (await engine.handle(client, "projects.createWorktree", { path: main, branch: "wt" })) as { path: string };
            const first = engine.handle(client, "projects.removeWorktree", { path: main, worktree: made.path });
            await expect(engine.handle(client, "projects.removeWorktree", { path: main, worktree: made.path })).rejects.toMatchObject({ code: "busy" });
            expect(await first).toEqual({ removed: true });
        } finally { await engine.stop(); }
    });

    test("#7 a session that's still closing in the worktree keeps it from being removed", async () => {
        const main = repo("rm-closing");
        const engine = new Engine({ listModels: async () => [], unloadAfterMs: 1 });
        const client = { subs: new Set<string>(), send: () => {} };
        engine.clients.add(client);
        let release = () => {};
        const gate = new Promise<void>((r) => (release = r));
        try {
            const made = (await engine.handle(client, "projects.createWorktree", { path: main, branch: "wt" })) as { path: string };
            await engine.handle(client, "session.create", { cwd: made.path });
            const rt = [...engine.runtimes.values()][0]!;
            const close = rt.close.bind(rt);
            rt.close = () => gate.then(close);
            engine.dropClient(client);
            for (let i = 0; i < 100 && engine.runtimes.size; i++) await Bun.sleep(10);
            expect(engine.runtimes.size).toBe(0);
            await expect(engine.handle(client, "projects.removeWorktree", { path: main, worktree: made.path })).rejects.toMatchObject({ code: "in_use" });
            release();
            await Bun.sleep(20);
            expect(await engine.handle(client, "projects.removeWorktree", { path: main, worktree: made.path })).toEqual({ removed: true });
        } finally {
            release();
            await engine.stop();
        }
    });

    test("#7 a session being deleted from the worktree keeps it from being removed until it's closed", async () => {
        const main = repo("rm-deleting");
        const engine = new Engine({ listModels: async () => [] });
        const client = { subs: new Set<string>(), send: () => {} };
        engine.clients.add(client);
        let release = () => {};
        const gate = new Promise<void>((r) => (release = r));
        try {
            const made = (await engine.handle(client, "projects.createWorktree", { path: main, branch: "wt" })) as { path: string };
            await engine.handle(client, "session.create", { cwd: made.path });
            const rt = [...engine.runtimes.values()][0]!;
            rt.session.push({ role: "user", content: [{ type: "text", text: "hello" }], meta: { kind: "prompt" } });
            const close = rt.close.bind(rt);
            rt.close = () => gate.then(close);
            const deleting = engine.handle(client, "session.delete", { id: rt.id });
            for (let i = 0; i < 100 && engine.runtimes.size; i++) await Bun.sleep(10);
            expect(engine.runtimes.size).toBe(0);
            await expect(engine.handle(client, "projects.removeWorktree", { path: main, worktree: made.path })).rejects.toMatchObject({ code: "in_use" });
            release();
            await deleting;
            expect(await engine.handle(client, "projects.removeWorktree", { path: main, worktree: made.path })).toEqual({ removed: true });
        } finally {
            release();
            await engine.stop();
        }
    });

    test("second review #1: trusting a sibling worktree doesn't accept another worktree's own config", async () => {
        const { main, mark, script } = withFilterScript("rm-sibling");
        const a = await createWorktree({ path: main, branch: "a" });
        const b = await createWorktree({ path: main, branch: "b" });
        git(main, "config", "extensions.worktreeConfig", "true");
        git(b.path, "config", "--worktree", "filter.evil.clean", `'${script}'`);
        const later = new Date(Date.now() + 60_000);
        utimesSync(join(b.path, "a.txt"), later, later);
        trustFolder(a.path);
        const fromSibling = removeWorktree({ path: a.path, worktree: b.path, inUse: noop });
        await expect(fromSibling).rejects.toMatchObject({ code: "needs_trust", folder: b.path });
        await expect(removeWorktree({ path: main, worktree: b.path, inUse: noop })).rejects.toMatchObject({ code: "needs_trust", folder: b.path });
        expect(existsSync(mark)).toBe(false);
        expect(existsSync(b.path)).toBe(true);
        // The sibling's own trust still covers the shared config and its own: removing A goes ahead.
        expect(await removeWorktree({ path: a.path, worktree: a.path, inUse: noop })).toEqual({ removed: true });
        // Trusting B itself is what lets B go.
        trustFolder(b.path);
        expect(await removeWorktree({ path: main, worktree: b.path, inUse: noop })).toEqual({ removed: true });
    });

    test("second review #1: a refusal over the shared config names the requesting folder", async () => {
        const { main, script } = withFilterScript("shared-names");
        git(main, "config", "filter.evil.smudge", `'${script}'`);
        await expect(createWorktree({ path: main, branch: "x" })).rejects.toMatchObject({ code: "needs_trust", folder: main });
    });

    test("second review #3: Git exiting just before its deadline isn't reported as timed out while a child holds the pipe", async () => {
        const main = repo("deadline");
        // Git exits after ~200ms of a 400ms allowance; a background child keeps stderr open past both.
        const alias = "!sh -c 'sleep 0.2; (sleep 3 >/dev/null </dev/null &); true'";
        const r = await runGitAsync(main, ["-c", `alias.slowexit=${alias}`, "slowexit"], 400);
        expect(r).toMatchObject({ code: 0, timedOut: false });
    });

    test("final review: trusting a subfolder of a worktree doesn't accept that worktree's own config", async () => {
        const { main, mark, script } = withFilterScript("sub-trusted");
        const a = await createWorktree({ path: main, branch: "a" });
        git(main, "config", "extensions.worktreeConfig", "true");
        git(a.path, "config", "--worktree", "filter.evil.smudge", `'${script}'`);
        const sub = join(a.path, "sub");
        mkdirSync(sub);
        trustFolder(sub);
        await expect(createWorktree({ path: sub, branch: "next" })).rejects.toMatchObject({ code: "needs_trust", folder: a.path });
        expect(existsSync(mark)).toBe(false);
        // Trusting the worktree itself is what counts.
        trustFolder(a.path);
        expect((await createWorktree({ path: sub, branch: "next" })).branch).toBe("next");
    });

    /** B's own config.worktree points core.worktree at `to` and sets a clean filter; B's a.txt looks changed. */
    async function redirected(name: string, to: (main: string, a: string) => string) {
        const { main, mark, script } = withFilterScript(name);
        const a = await createWorktree({ path: main, branch: "a" });
        const b = await createWorktree({ path: main, branch: "b" });
        git(main, "config", "extensions.worktreeConfig", "true");
        writeFileSync(join(b.path, "..", "..", "..", ".git", "worktrees", "b", "config.worktree"), `[core]\n\tworktree = ${to(main, a.path)}\n[filter "evil"]\n\tclean = '${script}'\n`);
        const later = new Date(Date.now() + 60_000);
        utimesSync(join(b.path, "a.txt"), later, later);
        return { main, a: a.path, b: b.path, mark };
    }

    test("core.worktree in a worktree's own config can't redirect the audit to the main worktree", async () => {
        const { main, b, mark } = await redirected("redirect-main", (main) => main);
        await expect(removeWorktree({ path: main, worktree: b, inUse: noop })).rejects.toMatchObject({ code: "needs_trust", folder: b });
        expect(existsSync(mark)).toBe(false);
        expect(existsSync(b)).toBe(true);
    });

    test("nor to a trusted sibling", async () => {
        const { main, a, b, mark } = await redirected("redirect-sibling", (_main, a) => a);
        trustFolder(a);
        await expect(removeWorktree({ path: main, worktree: b, inUse: noop })).rejects.toMatchObject({ code: "needs_trust", folder: b });
        await expect(removeWorktree({ path: a, worktree: b, inUse: noop })).rejects.toMatchObject({ code: "needs_trust", folder: b });
        expect(existsSync(mark)).toBe(false);
        expect(existsSync(b)).toBe(true);
    });

    test("a worktree whose commondir names another repository is refused before Git runs in it", async () => {
        const { main, mark, script } = withFilterScript("commondir");
        const b = await createWorktree({ path: main, branch: "b" });
        const other = join(realpathSync(iso.home), "commondir-other.git");
        cpSync(join(main, ".git"), other, { recursive: true });
        git(main, "config", "--file", join(other, "config"), "filter.evil.clean", `'${script}'`);
        writeFileSync(join(main, ".git", "worktrees", "b", "commondir"), `${other}\n`);
        const later = new Date(Date.now() + 60_000);
        utimesSync(join(b.path, "a.txt"), later, later);
        await expect(removeWorktree({ path: main, worktree: b.path, inUse: noop })).rejects.toMatchObject({ code: "inconsistent" });
        // Asked from B itself, or creating from it: refused too.
        await expect(removeWorktree({ path: b.path, worktree: b.path, inUse: noop })).rejects.toMatchObject({ code: "inconsistent" });
        await expect(createWorktree({ path: b.path, branch: "c" })).rejects.toMatchObject({ code: "inconsistent" });
        expect(existsSync(mark)).toBe(false);
        expect(existsSync(b.path)).toBe(true);
    });

    test("ordinary worktrees, asked from the main worktree, a linked one, or a subfolder, pass the identity check", async () => {
        const main = repo("identity-ok");
        const a = await createWorktree({ path: main, branch: "a" });
        mkdirSync(join(a.path, "sub"));
        const b = await createWorktree({ path: join(a.path, "sub"), branch: "b" });
        mkdirSync(join(main, "inner"));
        expect(await removeWorktree({ path: join(main, "inner"), worktree: b.path, inUse: noop })).toEqual({ removed: true });
        expect(await removeWorktree({ path: a.path, worktree: a.path, inUse: noop })).toEqual({ removed: true });
    });
});
