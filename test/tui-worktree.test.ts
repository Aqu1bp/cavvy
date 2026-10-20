// `harness --worktree [name]`: making or reopening the worktree, the branch
// prefix and base settings, and what happens to it on exit (removed when
// nothing was done, asked about, or kept), through the library, the App's
// exit and the real entry point with -p.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const W = await import("../src/server/worktrees");
const { decideWorktree, endingLines, worktreeLine } = await import("../src/ui/worktree");
const { worktreeSettings } = await import("../src/config/settings");
const { gitArgv, gitEnv } = await import("../src/util/git");
const { stripAnsi } = await import("../src/ui/ansi");
const { App } = await import("../src/ui/app");
const { Session } = await import("../src/agent/session");
afterAll(() => iso.cleanup());

const ROOT = resolve(import.meta.dir, "..");

function git(cwd: string, ...args: string[]): string {
    const result = Bun.spawnSync(gitArgv(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Harness Test", "-c", "user.email=test@example.invalid", ...args]), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
}

let n = 0;
function repo(o: { commit?: boolean } = {}): string {
    const path = join(realpathSync(iso.home), `repo-${++n}`);
    mkdirSync(join(path, "src", "deep"), { recursive: true });
    git(path, "init", "-b", "main");
    writeFileSync(join(path, ".gitignore"), "node_modules/\n.env\n");
    writeFileSync(join(path, "src", "deep", "a.ts"), "export const a = 1;\n");
    if (o.commit !== false) {
        git(path, "add", "-A");
        git(path, "commit", "-m", "Initial commit");
    }
    return path;
}

const branches = (main: string) => git(main, "branch", "--format=%(refname:short)").split("\n").filter(Boolean).sort();
const worktreePaths = (main: string) => W.listWorktrees(main).map((w) => w.path);
const failure = async (p: Promise<unknown>) => {
    try {
        await p;
    } catch (e) {
        return e as Error & { code?: string };
    }
    throw new Error("expected it to fail");
};

describe("making the worktree", () => {
    test("a named one goes in .claude/worktrees on a prefixed branch, starts where you were, and is marked", async () => {
        const main = repo();
        const wt = await W.enterSessionWorktree({ cwd: join(main, "src", "deep"), name: "feature/login" });
        expect(wt).toMatchObject({ name: "feature/login", path: join(main, ".claude", "worktrees", "feature-login"), branch: "harness/feature/login", baseLabel: "main", created: true, main });
        // The same subfolder, inside the worktree.
        expect(wt.cwd).toBe(join(wt.path, "src", "deep"));
        expect(W.readMarker(wt.path)).toMatchObject({ name: "feature/login", branch: "harness/feature/login", base: git(main, "rev-parse", "HEAD") });
        // The marker is in Git's own folder, never in the checkout.
        expect(git(wt.path, "status", "--porcelain")).toBe("");
        expect(wt.ms).toBeGreaterThanOrEqual(0);
        expect(stripAnsi(worktreeLine(wt))).toBe("worktree: .claude/worktrees/feature-login · branch harness/feature/login · from main");
    });

    test("the same name again reopens it instead of making another", async () => {
        const main = repo();
        const first = await W.enterSessionWorktree({ cwd: main, name: "again" });
        writeFileSync(join(first.path, "work.txt"), "unsaved\n");
        const second = await W.enterSessionWorktree({ cwd: main, name: "again" });
        expect(second).toMatchObject({ path: first.path, branch: "harness/again", created: false, base: first.base });
        expect(existsSync(join(second.path, "work.txt"))).toBe(true);
        expect(worktreePaths(main)).toHaveLength(2);
        expect(stripAnsi(worktreeLine(second))).toContain("(reopened)");
    });

    test("no name: a made-up one that's free as both folder and branch", async () => {
        const main = repo();
        const a = await W.enterSessionWorktree({ cwd: main });
        expect(a.name).toMatch(/^[a-z]+-[a-z]+(-\d+)?$/);
        expect(a.branch).toBe(`harness/${a.name}`);
        const b = await W.enterSessionWorktree({ cwd: main });
        expect(b.path).not.toBe(a.path);
    });

    test("the branch prefix can be changed or left out", async () => {
        const main = repo();
        expect((await W.enterSessionWorktree({ cwd: main, name: "x", branchPrefix: "aquib/" })).branch).toBe("aquib/x");
        expect((await W.enterSessionWorktree({ cwd: main, name: "y", branchPrefix: "" })).branch).toBe("y");
        // A prefix that makes the branch invalid is refused before anything's made.
        const e = await failure(W.enterSessionWorktree({ cwd: main, name: "z", branchPrefix: "bad prefix/" }));
        expect(e.message).toContain("Not a valid branch name");
        expect(existsSync(join(main, ".claude", "worktrees", "z"))).toBe(false);
    });

    test("a detached HEAD starts the worktree from its commit", async () => {
        const main = repo();
        const head = git(main, "rev-parse", "HEAD");
        git(main, "checkout", "--detach");
        const wt = await W.enterSessionWorktree({ cwd: main, name: "det" });
        expect(wt).toMatchObject({ branch: "harness/det", base: head, baseLabel: head.slice(0, 12) });
    });

    test("baseRef fresh starts from origin/HEAD as last fetched, and falls back to HEAD with a note", async () => {
        const upstream = repo();
        const clone = join(realpathSync(iso.home), `clone-${++n}`);
        git(iso.home, "clone", "-q", upstream, clone);
        git(clone, "checkout", "-q", "-b", "local-work");
        git(clone, "commit", "--allow-empty", "-m", "local only");
        const fresh = await W.enterSessionWorktree({ cwd: clone, name: "fresh", baseRef: "fresh" });
        expect(fresh).toMatchObject({ base: git(upstream, "rev-parse", "HEAD"), baseLabel: "origin/main" });
        expect(fresh.note).toBeUndefined();
        const head = await W.enterSessionWorktree({ cwd: clone, name: "head", baseRef: "head" });
        expect(head).toMatchObject({ base: git(clone, "rev-parse", "HEAD"), baseLabel: "local-work" });

        const lonely = repo();
        const fallback = await W.enterSessionWorktree({ cwd: lonely, name: "f", baseRef: "fresh" });
        expect(fallback.base).toBe(git(lonely, "rev-parse", "HEAD"));
        expect(fallback.note).toContain("no origin/HEAD");
    });

    test("refuses, with nothing made, where it can't work", async () => {
        const plain = join(realpathSync(iso.home), `plain-${++n}`);
        mkdirSync(plain);
        expect((await failure(W.enterSessionWorktree({ cwd: plain, name: "x" }))).message).toBe("This folder isn't in a Git repository.");

        const unborn = repo({ commit: false });
        expect((await failure(W.enterSessionWorktree({ cwd: unborn, name: "x" }))).message).toContain("no commits yet");
        expect(existsSync(join(unborn, ".claude", "worktrees", "x"))).toBe(false);

        const main = repo();
        for (const bad of ["-rf", "a b", "../up", "", ".hidden"]) {
            expect((await failure(W.enterSessionWorktree({ cwd: main, name: bad }))).code).toBe("bad_folder");
        }
        git(main, "branch", "harness/taken");
        const taken = await failure(W.enterSessionWorktree({ cwd: main, name: "taken" }));
        expect(taken.message).toContain("A branch named harness/taken already exists, but there's no worktree called taken");
        mkdirSync(join(main, ".claude", "worktrees", "stray"), { recursive: true });
        expect((await failure(W.enterSessionWorktree({ cwd: main, name: "stray" }))).message).toContain("isn't one of this repository's worktrees");
        expect(worktreePaths(main)).toEqual([main]);
    });

    test("a worktree whose folder was deleted says how to clear it", async () => {
        const main = repo();
        const wt = await W.enterSessionWorktree({ cwd: main, name: "gone" });
        Bun.spawnSync(["rm", "-rf", wt.path]);
        expect((await failure(W.enterSessionWorktree({ cwd: main, name: "gone" }))).message).toContain("git worktree prune");
    });

    test("names: what looks like one, and made-up ones", () => {
        for (const ok of ["fix-1", "feature/login", "v2.0", "A_b"]) expect(W.looksLikeWorktreeName(ok)).toBe(true);
        for (const no of ["fix the tests", "-x", "", "a..b", "/abs", ".dot"]) expect(W.looksLikeWorktreeName(no)).toBe(false);
        expect(W.randomName(() => 0)).toBe("amber-badger");
        expect(W.randomName(() => 0.9999)).toBe("zesty-zebra");
    });
});

describe("settings", () => {
    test("defaults, and malformed values fall back to them", () => {
        expect(worktreeSettings({})).toEqual({ branchPrefix: "harness/", baseRef: "head", cleanup: "auto" });
        expect(worktreeSettings({ worktree: { branchPrefix: " me/ ", baseRef: "fresh", cleanup: "keep" } })).toEqual({ branchPrefix: "me/", baseRef: "fresh", cleanup: "keep" });
        expect(worktreeSettings({ worktree: { branchPrefix: 3, baseRef: "main", cleanup: "always" } } as any)).toEqual({ branchPrefix: "harness/", baseRef: "head", cleanup: "auto" });
        expect(worktreeSettings({ worktree: "yes" } as any)).toEqual({ branchPrefix: "harness/", baseRef: "head", cleanup: "auto" });
    });
});

describe("on exit", () => {
    const asked: string[] = [];
    const answer = (v: "keep" | "remove" | undefined) => async (q: { title: string; header: string[]; items: { label: string }[] }) => {
        asked.push([q.title, ...q.header.map(stripAnsi), ...q.items.map((i) => i.label)].join("\n"));
        return v;
    };
    const fresh = async (name = "w") => {
        const main = repo();
        return { main, wt: await W.enterSessionWorktree({ cwd: main, name }) };
    };

    test("nothing done: removed with its branch, without asking", async () => {
        const { main, wt } = await fresh();
        asked.length = 0;
        const end = await (await decideWorktree(wt, { cleanup: "auto", ask: answer("keep") }))();
        expect(end).toEqual({ kind: "removed", branchDeleted: true });
        expect(asked).toEqual([]);
        expect(worktreePaths(main)).toEqual([main]);
        expect(branches(main)).toEqual(["main"]);
        expect(stripAnsi(endingLines(wt, end).join("\n"))).toBe("Removed worktree .claude/worktrees/w and branch harness/w.");
    });

    test("uncommitted or untracked changes keep it whatever the setting, and nothing is asked", async () => {
        for (const cleanup of ["auto", "ask"] as const) {
            const { main, wt } = await fresh();
            writeFileSync(join(wt.path, "new.txt"), "untracked\n");
            writeFileSync(join(wt.path, "src", "deep", "a.ts"), "export const a = 2;\n");
            asked.length = 0;
            const end = await (await decideWorktree(wt, { cleanup, ask: answer("remove") }))();
            expect(end).toEqual({ kind: "kept", why: "2 uncommitted changes" });
            expect(asked).toEqual([]);
            expect(existsSync(join(wt.path, "new.txt"))).toBe(true);
            expect(branches(main)).toContain("harness/w");
            const lines = stripAnsi(endingLines(wt, end).join("\n"));
            expect(lines).toContain(`Worktree kept (2 uncommitted changes): ${wt.path} · branch harness/w`);
            expect(lines).toContain("Come back to it with: harness -w w --continue");
        }
    });

    test("a staged change counts too", async () => {
        const { wt } = await fresh();
        writeFileSync(join(wt.path, "staged.txt"), "x\n");
        git(wt.path, "add", "staged.txt");
        expect(await (await decideWorktree(wt, { cleanup: "auto" }))()).toEqual({ kind: "kept", why: "1 uncommitted change" });
    });

    test("commits: asks; removing keeps the branch and its commits", async () => {
        const { main, wt } = await fresh();
        writeFileSync(join(wt.path, "f.txt"), "x\n");
        git(wt.path, "add", "f.txt");
        git(wt.path, "commit", "-m", "work");
        const tip = git(wt.path, "rev-parse", "HEAD");
        asked.length = 0;
        const end = await (await decideWorktree(wt, { cleanup: "auto", ask: answer("remove") }))();
        expect(asked[0]).toContain("Keep this worktree?");
        expect(asked[0]).toContain("It has 1 commit on harness/w.");
        expect(asked[0]).toContain("Remove the worktree, keep branch harness/w");
        expect(end).toEqual({ kind: "removed", branchDeleted: false });
        expect(worktreePaths(main)).toEqual([main]);
        expect(git(main, "rev-parse", "harness/w")).toBe(tip);
        expect(stripAnsi(endingLines(wt, end)[0]!)).toBe("Removed worktree .claude/worktrees/w; branch harness/w is kept.");
    });

    test("commits: keeping (or dismissing the question) keeps everything", async () => {
        for (const v of ["keep", undefined] as const) {
            const { main, wt } = await fresh();
            git(wt.path, "commit", "--allow-empty", "-m", "work");
            expect(await (await decideWorktree(wt, { cleanup: "auto", ask: answer(v) }))()).toEqual({ kind: "kept", why: undefined });
            expect(worktreePaths(main)).toContain(wt.path);
        }
    });

    test("with nobody to ask (a signal), commits keep it and say why", async () => {
        const { main, wt } = await fresh();
        git(wt.path, "commit", "--allow-empty", "-m", "work");
        expect(await (await decideWorktree(wt, { cleanup: "auto" }))()).toEqual({ kind: "kept", why: "1 commit on harness/w" });
        expect(worktreePaths(main)).toContain(wt.path);
    });

    test("ignored files: asks, names them, and deletes exactly those when told to", async () => {
        const { main, wt } = await fresh();
        mkdirSync(join(wt.path, "node_modules", "x"), { recursive: true });
        writeFileSync(join(wt.path, "node_modules", "x", "i.js"), "");
        writeFileSync(join(wt.path, ".env"), "SECRET=1\n");
        asked.length = 0;
        const end = await (await decideWorktree(wt, { cleanup: "auto", ask: answer("remove") }))();
        expect(asked[0]).toContain("It has 2 ignored files or folders.");
        expect(asked[0]).toContain("Removing it deletes .env, node_modules/.");
        expect(asked[0]).toContain("Remove the worktree and branch harness/w");
        expect(end).toEqual({ kind: "removed", branchDeleted: true });
        expect(worktreePaths(main)).toEqual([main]);
    });

    test("an ignored file that appears after the question keeps it", async () => {
        const { main, wt } = await fresh();
        writeFileSync(join(wt.path, ".env"), "A=1\n");
        const finish = await decideWorktree(wt, { cleanup: "auto", ask: answer("remove") });
        mkdirSync(join(wt.path, "node_modules"));
        writeFileSync(join(wt.path, "node_modules", "late.js"), "");
        expect(await finish()).toEqual({ kind: "kept", why: "its ignored files changed meanwhile" });
        expect(worktreePaths(main)).toContain(wt.path);
    });

    test("a change made after the question keeps it: Git refuses", async () => {
        const { main, wt } = await fresh();
        git(wt.path, "commit", "--allow-empty", "-m", "work");
        const finish = await decideWorktree(wt, { cleanup: "auto", ask: answer("remove") });
        writeFileSync(join(wt.path, "late.txt"), "x\n");
        const end = await finish();
        expect(end.kind).toBe("kept");
        expect((end as { why?: string }).why).toContain("uncommitted or untracked changes");
        expect(existsSync(join(wt.path, "late.txt"))).toBe(true);
        expect(worktreePaths(main)).toContain(wt.path);
    });

    test("cleanup ask asks even when nothing was done; keep never removes", async () => {
        const a = await fresh();
        asked.length = 0;
        expect(await (await decideWorktree(a.wt, { cleanup: "ask", ask: answer("keep") }))()).toEqual({ kind: "kept", why: undefined });
        expect(asked[0]).toContain("Nothing was changed in it.");
        expect(await (await decideWorktree(a.wt, { cleanup: "ask", ask: answer("remove") }))()).toEqual({ kind: "removed", branchDeleted: true });

        const b = await fresh();
        asked.length = 0;
        expect(await (await decideWorktree(b.wt, { cleanup: "keep", ask: answer("remove") }))()).toEqual({ kind: "kept", why: undefined });
        expect(asked).toEqual([]);
        expect(worktreePaths(b.main)).toContain(b.wt.path);
    });

    test("one Harness didn't make (no marker) is never removed", async () => {
        const main = repo();
        const path = join(main, ".claude", "worktrees", "mine");
        mkdirSync(join(main, ".claude", "worktrees"), { recursive: true });
        git(main, "worktree", "add", "-b", "mine", path);
        const wt = await W.enterSessionWorktree({ cwd: main, name: "mine" });
        expect(wt.created).toBe(false);
        expect(await (await decideWorktree(wt, { cleanup: "auto" }))()).toEqual({ kind: "kept", why: "harness didn't create it" });
        expect(worktreePaths(main)).toContain(path);
    });

    test("a locked worktree is kept, and says so", async () => {
        const { wt } = await fresh();
        git(wt.path, "worktree", "lock", "--reason", "on a USB disk", wt.path);
        const end = await (await decideWorktree(wt, { cleanup: "auto" }))();
        expect(end.kind).toBe("kept");
        expect((end as { why?: string }).why).toContain("locked (on a USB disk)");
    });

    test("HEAD moved to another commit without new ones: asks, and the branch stays", async () => {
        const { main, wt } = await fresh();
        git(wt.path, "commit", "--allow-empty", "-m", "c");
        git(wt.path, "reset", "--hard", "HEAD~1");
        git(wt.path, "checkout", "-q", "--detach", "HEAD");
        asked.length = 0;
        const end = await (await decideWorktree(wt, { cleanup: "auto", ask: answer("remove") }))();
        expect(asked[0]).toContain("HEAD moved off its starting commit");
        expect(end).toEqual({ kind: "removed", branchDeleted: false });
        expect(branches(main)).toContain("harness/w");
    });
});

describe("the shared pieces", () => {
    test("deleteBranchAtBase deletes only a branch still at its base, whose commit another ref has", async () => {
        const main = repo();
        const base = git(main, "rev-parse", "HEAD");
        git(main, "branch", "at-base");
        expect(W.deleteBranchAtBase(main, "at-base", base)).toBe(true);
        git(main, "branch", "moved");
        git(main, "checkout", "-q", "moved");
        git(main, "commit", "--allow-empty", "-m", "x");
        git(main, "checkout", "-q", "main");
        expect(W.deleteBranchAtBase(main, "moved", base)).toBe(false);
        // An orphan commit only that branch has.
        git(main, "checkout", "-q", "--orphan", "lonely");
        git(main, "commit", "--allow-empty", "-m", "only here");
        const lonely = git(main, "rev-parse", "HEAD");
        git(main, "checkout", "-q", "main");
        expect(W.deleteBranchAtBase(main, "lonely", lonely)).toBe(false);
        expect(W.deleteBranchAtBase(main, "-x", base)).toBe(false);
        expect(branches(main)).toEqual(["lonely", "main", "moved"]);
    });

    test("removeIfPristine: for sub-agents, ignored files can count as nothing", async () => {
        const main = repo();
        const wt = await W.enterSessionWorktree({ cwd: main, name: "agent" });
        writeFileSync(join(wt.path, ".env"), "x\n");
        expect(await W.removeIfPristine({ main, path: wt.path })).toMatchObject({ removed: false, kept: "It has work in it." });
        expect(await W.removeIfPristine({ main, path: wt.path, ignoredIsWork: false })).toEqual({ removed: true, branchDeleted: true });
        expect(worktreePaths(main)).toEqual([main]);
        expect(branches(main)).toEqual(["main"]);
    });

    test("worktreeWork refuses while another session is in it", async () => {
        const main = repo();
        const wt = await W.enterSessionWorktree({ cwd: main, name: "busy" });
        const marker = W.readMarker(wt.path)!;
        expect((await failure(W.worktreeWork({ main, path: wt.path, marker, inUse: () => true }))).code).toBe("in_use");
    });
});

describe("App exit", () => {
    test("asks while the TUI is up, then removes once shells are gone, and prints the outcome", async () => {
        const cwd = realpathSync(iso.home);
        const order: string[] = [];
        const app = new App({
            cwd,
            trusted: true,
            mode: "default",
            allowBypass: false,
            startupNotes: [],
            worktree: {
                line: "worktree: x",
                resume: "harness -w x",
                decide: async (ask) => {
                    order.push(`decide:${(await ask?.({ title: "Keep this worktree?", header: [], items: [{ label: "Remove", value: "remove" }] })) ?? "no-ask"}`);
                    return async () => (order.push("finish"), ["Removed worktree x."]);
                },
            },
        });
        const printed: string[] = [];
        (app as any).screen = { interactive: true, print: (l: string) => (printed.push(l), order.push("print")), replace() {}, redraw() {}, setLive() {}, settle() {}, flushNow() {}, stop: () => order.push("stop"), clearScreen() {} };
        (app as any).renderLive = () => {};
        (app as any).showDialog = async () => "remove";
        app.session = Session.create(cwd, { persist: false });
        const exit = spyOn(process, "exit").mockImplementation((() => undefined) as never);
        try {
            await app.exit(0);
            // A second exit (Ctrl+C again) while it's asking or finishing does nothing.
            await app.exit(0);
        } finally {
            exit.mockRestore();
        }
        expect(order).toEqual(["decide:remove", "finish", "print", "stop"]);
        expect(printed).toEqual(["Removed worktree x."]);
    });

    test("after a signal nothing is asked", async () => {
        const cwd = realpathSync(iso.home);
        let asked: unknown = "unset";
        const app = new App({ cwd, trusted: true, mode: "default", allowBypass: false, startupNotes: [], worktree: { line: "", resume: "", decide: async (ask) => ((asked = ask), async () => []) } });
        (app as any).screen = { interactive: true, print() {}, replace() {}, redraw() {}, setLive() {}, settle() {}, flushNow() {}, stop() {}, clearScreen() {} };
        (app as any).renderLive = () => {};
        app.session = Session.create(cwd, { persist: false });
        const exit = spyOn(process, "exit").mockImplementation((() => undefined) as never);
        try {
            await app.exit(0, { signal: true });
        } finally {
            exit.mockRestore();
        }
        expect(asked).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// The real entry point, with -p and a local mock provider.

describe("harness -p --worktree", () => {
    let server: ReturnType<typeof Bun.serve>;
    const cwds: string[] = [];
    beforeAll(() => {
        server = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            fetch: async (req) => {
                if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "m1" }] });
                await req.json();
                const chunks = [{ choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];
                return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
            },
        });
        writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: `http://127.0.0.1:${server.port}/v1`, kind: "openai", requiresKey: false, models: ["m1"] }] }));
    });
    afterAll(() => server.stop(true));

    async function harness(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
        const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: iso.home, HARNESS_HOME: iso.home, HARNESS_NO_KEYCHAIN: "1" };
        const child = spawn(process.execPath, ["--no-env-file", `--config=${join(ROOT, "bunfig.toml")}`, join(ROOT, "src/index.ts"), "-p", "--model", "mock:m1", ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (b) => (stdout += b));
        child.stderr.on("data", (b) => (stderr += b));
        const killer = setTimeout(() => child.kill("SIGKILL"), 30_000);
        const code = await new Promise<number>((r) => child.on("close", (c) => r(c ?? -1)));
        clearTimeout(killer);
        cwds.push(cwd);
        return { code, stdout, stderr };
    }

    test("runs in the worktree, and removes it after when nothing was done", async () => {
        const main = repo();
        const r = await harness(["-w", "quick", "say ok"], main);
        expect(r).toMatchObject({ code: 0, stdout: "ok\n" });
        expect(r.stderr).toContain("harness: worktree: .claude/worktrees/quick · branch harness/quick · from main");
        expect(r.stderr).toContain("harness: Removed worktree .claude/worktrees/quick and branch harness/quick.");
        expect(worktreePaths(main)).toEqual([main]);
    });

    test("a prompt with spaces after -w is the prompt, not the name", async () => {
        const main = repo();
        const r = await harness(["--worktree", "fix the tests"], main);
        expect(r.code).toBe(0);
        expect(r.stderr).toMatch(/worktree: \.claude\/worktrees\/[a-z]+-[a-z]+/);
        expect(r.stderr).not.toContain("fix the tests");
    });

    test("--worktree=name, and with cleanup keep it stays and says how to come back", async () => {
        const main = repo();
        writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ worktree: { cleanup: "keep", branchPrefix: "bot/" } }));
        let r;
        try {
            r = await harness(["--worktree=kept", "say ok"], main);
        } finally {
            rmSync(join(iso.home, "settings.json"));
        }
        expect(r.code).toBe(0);
        expect(r.stderr).toContain("branch bot/kept");
        expect(r.stderr).toContain(`harness: Worktree kept: ${join(main, ".claude", "worktrees", "kept")} · branch bot/kept`);
        expect(r.stderr).toContain("harness: Come back to it with: harness -w kept --continue");
    });

    test("outside a Git repository it says so and exits 1", async () => {
        const plain = join(realpathSync(iso.home), `plain-cli-${++n}`);
        mkdirSync(plain);
        const r = await harness(["-w", "x", "hi"], plain);
        expect(r).toMatchObject({ code: 1, stderr: "harness: This folder isn't in a Git repository.\n" });
    });
});
