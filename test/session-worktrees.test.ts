// The diff reader's worktree picker, server side: session.worktrees lists the
// session's repository's worktrees with their lead on the main branch, and
// session.gitChanges reads another of them only when Git lists it.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { gitArgv, gitEnv } = await import("../src/util/git");
const { committerTime } = await import("../src/server/session-worktrees");
import type { AgentRun, GitChangesInfo, SessionSnapshot, SessionWorktreeInfo } from "../src/server/protocol";
afterAll(() => iso.cleanup());

function git(cwd: string, ...args: string[]): string {
    const result = Bun.spawnSync(gitArgv(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Harness Test", "-c", "user.email=test@example.invalid", ...args]), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
}

function repo(name: string) {
    const path = join(realpathSync(iso.home), name);
    mkdirSync(path);
    git(path, "init", "-b", "main");
    writeFileSync(join(path, "readme.txt"), "hello\n");
    git(path, "add", "-A");
    git(path, "commit", "-m", "Initial commit");
    return path;
}

/** A repository with a session in its main checkout and an agent's worktree that committed once and has an edit on top. */
async function setup(name: string) {
    const main = repo(name);
    const linked = join(realpathSync(iso.home), `${name} agent`);
    git(main, "worktree", "add", "-b", "agent/work", linked);
    writeFileSync(join(linked, "feature.txt"), "one\n");
    git(linked, "add", "-A");
    git(linked, "commit", "-m", "Add feature");
    writeFileSync(join(linked, "readme.txt"), "hello\nmore\n");
    // Something uncommitted in the main checkout too, which another worktree's view must not show.
    writeFileSync(join(main, "scratch.txt"), "main only\n");
    const engine = new Engine({ listModels: async () => [] });
    const client = { subs: new Set<string>(), send: () => {} };
    const snap = (await engine.handle(client, "session.create", { cwd: main })) as SessionSnapshot;
    const call = <T>(method: string, params: Record<string, unknown>) => engine.handle(client, method as any, { id: snap.state.id, ...params }) as Promise<T>;
    return { main, linked, engine, call };
}

describe("session.worktrees", () => {
    test("lists the repository's worktrees with the session's own marked, each one's lead on main and its last commit", async () => {
        const { main, linked, engine, call } = await setup("listing");
        try {
            const list = await call<SessionWorktreeInfo[]>("session.worktrees", {});
            expect(list.map((w) => [w.path, w.current, w.branch])).toEqual([
                [main, true, "main"],
                [linked, false, "agent/work"],
            ]);
            expect(list[0]).toMatchObject({ base: "main", ahead: 0 });
            expect(list[1]).toMatchObject({ base: "main", ahead: 1 });
            expect(Math.abs(list[1]!.committedAt! - Date.now())).toBeLessThan(120_000);
        } finally {
            await engine.stop();
        }
    });

    test("marks each worktree with the running sub-agents of every loaded session working in it", async () => {
        const { main, linked, engine, call } = await setup("agents");
        const client = { subs: new Set<string>(), send: () => {} };
        try {
            // Another session's sub-agent, working in the linked worktree, and one that finished there.
            const other = (await engine.handle(client, "session.create", { cwd: main })) as SessionSnapshot;
            const runs = (engine.runtimes.get(other.state.id) as any).view.agents as AgentRun[];
            const run = (id: string, status: AgentRun["status"], command: string): AgentRun => ({ id, turnId: "t", description: `Agent ${id}`, agentType: "general-purpose", status, startedAt: 0, toolCount: 1, tokens: 0, blocks: [{ t: "tool", id: `${id}-1`, name: "Bash", title: "Bash", input: { command }, status: "ok" }] });
            runs.push(run("busy", "running", `cd '${linked}' && bun test`), run("over", "done", `cd '${linked}'`), run("home", "waiting", `git -C '${main}' status`));
            const list = await call<SessionWorktreeInfo[]>("session.worktrees", {});
            expect(list.find((w) => w.path === linked)?.agents).toEqual([{ id: "busy", sessionId: other.state.id, description: "Agent busy", waiting: false }]);
            expect(list.find((w) => w.path === main)?.agents).toEqual([{ id: "home", sessionId: other.state.id, description: "Agent home", waiting: true }]);
        } finally {
            await engine.stop();
        }
    });

    test("a commit's committer time is read from its header, not its message", () => {
        const commit = "tree abc\nauthor A <a@x> 100 +0000\ncommitter C <c@x> 1700000000 -0500\n\ncommitter fake <f@x> 5 +0000\n";
        expect(committerTime(commit)).toBe(1_700_000_000_000);
        expect(committerTime("tree abc\n\nno header")).toBeUndefined();
    });
});

describe("session.gitChanges with a worktree", () => {
    test("reads another worktree's branch and uncommitted changes, not the session's folder", async () => {
        const { linked, engine, call } = await setup("reading");
        try {
            const branch = await call<GitChangesInfo>("session.gitChanges", { scope: "branch", worktree: linked });
            expect(branch.head?.branch).toBe("agent/work");
            expect(branch.base?.ref).toBe("main");
            expect(branch.files.map((f) => f.path).sort()).toEqual(["feature.txt", "readme.txt"]);
            expect(branch.turns).toBeUndefined();
            const uncommitted = await call<GitChangesInfo>("session.gitChanges", { scope: "uncommitted", worktree: linked });
            expect(uncommitted.files.map((f) => f.path)).toEqual(["readme.txt"]);
            // A file of it on its own, as the reader asks for one whose hunks were left out.
            const one = await call<GitChangesInfo>("session.gitChanges", { scope: "branch", worktree: linked, path: "feature.txt" });
            expect(one.files.map((f) => f.path)).toEqual(["feature.txt"]);
            // Its own folder, named as a worktree, is the session's view.
            const own = await call<GitChangesInfo>("session.gitChanges", { scope: "uncommitted" });
            expect(own.files.map((f) => f.path)).toEqual(["scratch.txt"]);
        } finally {
            await engine.stop();
        }
    });

    test("refuses any folder git doesn't list as one of the repository's worktrees", async () => {
        const { main, linked, engine, call } = await setup("refusing");
        const other = repo("refusing other repo");
        const inner = join(main, "inner");
        mkdirSync(inner);
        const plain = join(realpathSync(iso.home), "refusing plain");
        mkdirSync(plain);
        try {
            for (const worktree of [other, inner, plain, join(realpathSync(iso.home), "nowhere"), "/", "..", `${linked}/..`]) {
                await expect(call("session.gitChanges", { scope: "uncommitted", worktree })).rejects.toMatchObject({ code: "not_found" });
            }
            for (const worktree of ["", 7, "a\0b"]) {
                await expect(call("session.gitChanges", { scope: "uncommitted", worktree })).rejects.toMatchObject({ code: "invalid" });
            }
            // Turns are the session's own folder's.
            await expect(call("session.gitChanges", { scope: "last-turn", worktree: linked })).rejects.toMatchObject({ code: "invalid" });
            // A link to a listed worktree reads that worktree, as git records it.
            const link = join(realpathSync(iso.home), "refusing link");
            symlinkSync(linked, link);
            expect((await call<GitChangesInfo>("session.gitChanges", { scope: "uncommitted", worktree: link })).files.map((f) => f.path)).toEqual(["readme.txt"]);
        } finally {
            await engine.stop();
        }
    });

    test("a registered worktree whose folder now leads somewhere else is refused: another repository, or another of its worktrees", async () => {
        const { main, linked, engine, call } = await setup("swapped");
        const other = repo("swapped other repo");
        writeFileSync(join(other, "secret.txt"), "not this repository's\n");
        const second = join(realpathSync(iso.home), "swapped second");
        git(main, "worktree", "add", "-b", "agent/second", second);
        writeFileSync(join(second, "second.txt"), "second\n");
        try {
            // Locked, so git keeps it registered (and never calls it prunable) with its folder gone.
            git(main, "worktree", "lock", linked);
            rmSync(linked, { recursive: true, force: true });
            symlinkSync(other, linked);
            await expect(call("session.gitChanges", { scope: "uncommitted", worktree: linked })).rejects.toMatchObject({ code: "not_found" });
            rmSync(linked);
            symlinkSync(second, linked);
            await expect(call("session.gitChanges", { scope: "uncommitted", worktree: linked })).rejects.toMatchObject({ code: "not_found" });
            // The real one still reads.
            expect((await call<GitChangesInfo>("session.gitChanges", { scope: "uncommitted", worktree: second })).files.map((f) => f.path)).toEqual(["second.txt"]);
        } finally {
            await engine.stop();
        }
    });

    test("a worktree whose folder was deleted is refused until it's back", async () => {
        const { linked, engine, call } = await setup("deleted");
        try {
            rmSync(linked, { recursive: true, force: true });
            await expect(call("session.gitChanges", { scope: "branch", worktree: linked })).rejects.toMatchObject({ code: "not_found" });
            const list = await call<SessionWorktreeInfo[]>("session.worktrees", {});
            expect(list.find((w) => w.path === linked)?.exists).toBe(false);
        } finally {
            await engine.stop();
        }
    });
});
