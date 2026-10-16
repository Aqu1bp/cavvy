import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { createWorktree, listWorktrees, parseWorktrees, removeWorktree } = await import("../src/server/worktrees");
const { Engine } = await import("../src/server/engine");
const { gitArgv, gitEnv } = await import("../src/util/git");
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

describe("removing a worktree", () => {
    async function setup(name: string) {
        const main = repo(name);
        const made = await createWorktree({ path: main, branch: `${name.replace(/ /g, "-")}-wt` });
        return { main, path: made.path, branch: made.branch };
    }

    test("a clean worktree goes and its branch stays", async () => {
        const { main, path, branch } = await setup("remove clean");
        expect(await removeWorktree({ path: main, worktree: path, inUse: noop })).toBe(path);
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

    test("pruning is refused while any missing worktree's detached commit is on no branch", async () => {
        const { main, path } = await setup("remove prune guard");
        const detached = join(managedDir(main), "lost");
        git(main, "worktree", "add", "--detach", detached);
        git(detached, "commit", "--allow-empty", "-m", "only here");
        rmSync(detached, { recursive: true });
        rmSync(path, { recursive: true });
        await expect(removeWorktree({ path: main, worktree: path, inUse: noop })).rejects.toMatchObject({ code: "unreachable" });
        await expect(removeWorktree({ path: main, worktree: detached, inUse: noop })).rejects.toMatchObject({ code: "unreachable" });
        expect(listWorktrees(main)).toHaveLength(3);
    });

    test("one whose folder is already gone is pruned", async () => {
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
            expect(await engine.handle(client, "projects.removeWorktree", { path: main, worktree: made.path })).toBeNull();
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
