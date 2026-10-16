import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { listWorktrees, parseWorktrees } = await import("../src/server/worktrees");
const { Engine } = await import("../src/server/engine");
const { gitArgv, gitEnv } = await import("../src/util/git");
afterAll(() => iso.cleanup());

function git(cwd: string, ...args: string[]) {
    const result = Bun.spawnSync(gitArgv(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Harness Test", "-c", "user.email=test@example.invalid", ...args]), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
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
});
