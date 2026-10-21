// GitCommit, GitPush, CreatePullRequest, WatchPullRequest and
// UnwatchPullRequest against real repositories with a local "remote" and a
// fake gh: no network. Also who may run them in which permission mode.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";
import { publishFixtures } from "./helpers/git-publish";
setDefaultTimeout(120_000);

const iso = isolate();
const fixture = publishFixtures(iso.home);
const { git, repo, calls } = fixture;
const { GitCommitTool, GitPushTool, CreatePullRequestTool, WatchPullRequestTool, UnwatchPullRequestTool, gitToolDeps } = await import("../src/tools/git-tools");
const { WakeQueue, WatcherMap } = await import("../src/agent/wakes");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
import type { Tool, ToolContext, ToolState } from "../src/tools/types";
import type { PermissionMode } from "../src/permissions/modes";

const realDeps = { ...gitToolDeps };
afterAll(() => {
    Object.assign(gitToolDeps, realDeps);
    fixture.cleanup();
    iso.cleanup();
});
gitToolDeps.trusted = () => true;

const contexts: ToolContext[] = [];
function ctxFor(cwd: string, opts: { wakes?: boolean } = {}): ToolContext {
    const wakes = opts.wakes === false ? undefined : new WakeQueue({ coalesceMs: 60_000 });
    const state: ToolState = { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map(), wakes, watchers: new WatcherMap() };
    const ctx: ToolContext = { state, settings: {} as any, signal: new AbortController().signal, mode: () => "default", setMode: () => {}, ui: {}, wakes };
    contexts.push(ctx);
    return ctx;
}
afterAll(() => {
    for (const c of contexts) {
        for (const w of c.state.watchers?.values() ?? []) w.stop();
        c.wakes?.dispose();
    }
});
const run = <I,>(tool: Tool<I>, input: I, ctx: ToolContext) => tool.run(input, ctx);

/** A GraphQL answer for PR #7 in example/project. */
function graphql(over: Record<string, unknown> = {}) {
    return JSON.stringify({
        data: {
            viewer: { login: "me" },
            rateLimit: { remaining: 4990, resetAt: "2026-10-20T11:00:00Z" },
            repository: {
                pullRequest: {
                    number: 7,
                    url: "https://github.com/example/project/pull/7",
                    title: "feat: publish from GUI",
                    state: "OPEN",
                    isDraft: false,
                    headRefOid: "abc1234",
                    headRefName: "feature",
                    baseRefName: "main",
                    mergeable: "MERGEABLE",
                    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS" }] } } } }] },
                    comments: { nodes: [{ id: "C1", author: { login: "reviewer" }, body: "Please add a test", createdAt: "2026-10-20T10:00:00Z" }] },
                    reviews: { nodes: [] },
                    reviewThreads: { nodes: [] },
                    ...over,
                },
            },
        },
    });
}
function fakeGraphql(answer: () => string) {
    const seen: string[][] = [];
    gitToolDeps.gh = () => async (args) => {
        seen.push(args);
        return { out: answer(), err: "", code: 0 };
    };
    return seen;
}

describe("GitCommit", () => {
    test("commits every changed file, new ones included, with the message", async () => {
        const { cwd } = repo();
        writeFileSync(join(cwd, "a.txt"), "a\n");
        mkdirSync(join(cwd, "src"));
        writeFileSync(join(cwd, "src", "b.ts"), "export {}\n");
        const r = await run(GitCommitTool, { message: "Add a and b\n\nBody" }, ctxFor(cwd));
        expect(r.isError).toBeFalsy();
        expect(r.content).toMatch(/^Committed [0-9a-f]{7} on feature: Add a and b \(2 files\)$/);
        expect(git(cwd, "log", "-1", "--format=%B")).toBe("Add a and b\n\nBody");
        expect(git(cwd, "status", "--porcelain")).toBe("");
    });

    test("commits only the files named (absolute or relative), leaving the rest", async () => {
        const { cwd } = repo();
        writeFileSync(join(cwd, "keep.txt"), "keep\n");
        writeFileSync(join(cwd, "one.txt"), "1\n");
        writeFileSync(join(cwd, "two.txt"), "2\n");
        const r = await run(GitCommitTool, { message: "Two files", paths: ["one.txt", join(cwd, "two.txt")] }, ctxFor(cwd));
        expect(r.content).toContain("(2 files)");
        expect(git(cwd, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["one.txt", "two.txt"]);
        expect(git(cwd, "status", "--porcelain")).toBe("?? keep.txt");
    });

    test("from a subfolder, paths are taken from that folder, as the model sees them", async () => {
        const { cwd } = repo();
        mkdirSync(join(cwd, "src", "src"), { recursive: true });
        writeFileSync(join(cwd, "src", "a.ts"), "a\n");
        writeFileSync(join(cwd, "src", "src", "a.ts"), "decoy\n");
        writeFileSync(join(cwd, "top.txt"), "t\n");
        const ctx = ctxFor(join(cwd, "src"));
        const r = await run(GitCommitTool, { message: "Just a", paths: ["a.ts", "../top.txt"] }, ctx);
        expect(r.isError).toBeFalsy();
        expect(git(cwd, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["src/a.ts", "top.txt"]);
        expect(git(cwd, "status", "--porcelain")).toBe("?? src/src/");
    });

    test("more changed files than one commit takes is refused up front, not cut short", async () => {
        const { cwd } = repo();
        for (let i = 0; i < 301; i++) writeFileSync(join(cwd, `f${i}.txt`), `${i}\n`);
        const ctx = ctxFor(cwd);
        const input = { message: "Everything" };
        const p = await GitCommitTool.preview!(input, ctx);
        expect(p?.summary).toContain("301");
        const r = await run(GitCommitTool, input, ctx);
        expect(r).toMatchObject({ isError: true, content: expect.stringContaining("at most 300") });
        expect(git(cwd, "rev-list", "--count", "HEAD")).toBe("2");
    });

    test("nothing to commit, a path outside the repository, an unchanged file and an untrusted folder are errors", async () => {
        const { cwd } = repo();
        const ctx = ctxFor(cwd);
        expect(await run(GitCommitTool, { message: "x" }, ctx)).toMatchObject({ isError: true, content: expect.stringContaining("Nothing to commit") });
        expect(await run(GitCommitTool, { message: "x", paths: ["/etc/passwd"] }, ctx)).toMatchObject({ isError: true, content: expect.stringContaining("Not inside the repository") });
        expect(await run(GitCommitTool, { message: "x", paths: ["README-missing.md"] }, ctx)).toMatchObject({ isError: true, content: expect.stringContaining("Not a changed file") });
        expect(GitCommitTool.validate!({ message: "  " }, ctx)).toContain("commit message");
        gitToolDeps.trusted = () => false;
        try {
            writeFileSync(join(cwd, "x.txt"), "x");
            expect(await run(GitCommitTool, { message: "x" }, ctx)).toMatchObject({ isError: true, content: expect.stringContaining("Trust this folder") });
            expect(git(cwd, "status", "--porcelain")).toBe("?? x.txt");
        } finally {
            gitToolDeps.trusted = () => true;
        }
    });

    test("the permission prompt shows the message and the files", async () => {
        const { cwd } = repo();
        writeFileSync(join(cwd, "a.txt"), "a\n");
        const p = await GitCommitTool.preview!({ message: "Add a" }, ctxFor(cwd));
        expect(p).toEqual({ summary: "1 file on feature", body: "Add a\n\n  a.txt" });
    });

    test("commits only the files the prompt showed, not ones that appeared while it was open", async () => {
        const { cwd } = repo();
        const ctx = ctxFor(cwd);
        writeFileSync(join(cwd, "reviewed.txt"), "r\n");
        const input = { message: "Reviewed" };
        expect((await GitCommitTool.preview!(input, ctx))?.summary).toBe("1 file on feature");
        writeFileSync(join(cwd, "unreviewed.txt"), "u\n");
        const r = await run(GitCommitTool, input, ctx);
        expect(r.isError).toBeFalsy();
        expect(r.content).toContain("(1 file)");
        expect(r.content).toContain("unreviewed.txt");
        expect(git(cwd, "show", "--name-only", "--format=", "HEAD")).toBe("reviewed.txt");
        expect(git(cwd, "status", "--porcelain")).toBe("?? unreviewed.txt");
    });

    test("won't commit on a different branch from the one the prompt showed", async () => {
        const { cwd } = repo();
        const ctx = ctxFor(cwd);
        writeFileSync(join(cwd, "a.txt"), "a\n");
        const input = { message: "Add a" };
        await GitCommitTool.preview!(input, ctx);
        git(cwd, "checkout", "-q", "-b", "unexpected");
        const r = await run(GitCommitTool, input, ctx);
        expect(r).toMatchObject({ isError: true, content: expect.stringContaining("feature") });
        expect(git(cwd, "status", "--porcelain")).toBe("?? a.txt");
    });
});

describe("GitPush", () => {
    test("first push sets the upstream; the next says how many commits; uncommitted files are mentioned", async () => {
        const { cwd, remote } = repo();
        const ctx = ctxFor(cwd);
        const first = await run(GitPushTool, {}, ctx);
        expect(first.isError).toBeFalsy();
        expect(first.content).toStartWith("Pushed feature to origin/feature.");
        expect(git(remote, "rev-parse", "feature")).toBe(git(cwd, "rev-parse", "HEAD"));
        expect(git(cwd, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feature");
        git(cwd, "commit", "--allow-empty", "-qm", "next");
        writeFileSync(join(cwd, "wip.txt"), "wip");
        const second = await run(GitPushTool, {}, ctx);
        expect(second.content).toContain("Pushed feature to origin/feature (1 commit).");
        expect(second.content).toContain("Not included: 1 uncommitted change");
    });

    test("refuses the main branch without pushing anything", async () => {
        const { cwd, state } = repo();
        git(cwd, "checkout", "-q", "main");
        git(cwd, "commit", "--allow-empty", "-qm", "direct to main");
        const r = await run(GitPushTool, {}, ctxFor(cwd));
        expect(r.isError).toBe(true);
        expect(r.content).toContain("it's the repository's main branch");
        expect(calls(state, ".git-calls").some((a) => a.includes("push"))).toBe(false);
    });

    test("a rejected push says to reconcile and never forces", async () => {
        const { cwd, remote } = repo();
        const ctx = ctxFor(cwd);
        await run(GitPushTool, {}, ctx);
        // Someone else pushed to the branch meanwhile.
        const other = `${cwd}-other`;
        git(iso.home, "clone", "-q", "-b", "feature", remote, other);
        git(other, "-c", "user.name=O", "-c", "user.email=o@example.invalid", "commit", "--allow-empty", "-qm", "theirs");
        git(other, "push", "-q", "origin", "feature");
        git(cwd, "commit", "--allow-empty", "-qm", "mine");
        const r = await run(GitPushTool, {}, ctx);
        expect(r.isError).toBe(true);
        expect(r.content).toMatch(/rejected|fetch/i);
        expect(r.content).toContain("No force push was attempted");
        expect(git(remote, "log", "-1", "--format=%s", "feature")).toBe("theirs");
    });

    test("won't push a different branch from the one the prompt showed", async () => {
        const { cwd, state } = repo();
        const ctx = ctxFor(cwd);
        const input = {};
        expect((await GitPushTool.preview!(input, ctx))?.summary).toBe("feature → origin/feature");
        git(cwd, "checkout", "-q", "-b", "unexpected");
        const r = await run(GitPushTool, input, ctx);
        expect(r).toMatchObject({ isError: true, content: expect.stringContaining("Branch changed") });
        expect(calls(state, ".git-calls").some((a) => a.includes("push"))).toBe(false);
    });

    test("won't push to a different remote than the prompt showed", async () => {
        const { cwd, remote, state } = repo();
        const ctx = ctxFor(cwd);
        const input = {};
        const p = await GitPushTool.preview!(input, ctx);
        expect(p?.body).toContain(remote);
        const other = `${remote}-other`;
        git(iso.home, "init", "--bare", "-q", "-b", "main", other);
        git(cwd, "remote", "set-url", "origin", other);
        const r = await run(GitPushTool, input, ctx);
        expect(r).toMatchObject({ isError: true, content: expect.stringContaining("changed since the user was asked") });
        expect(calls(state, ".git-calls").some((a) => a.includes("push"))).toBe(false);
        expect(git(other, "branch", "--list")).toBe("");
    });

    test("won't push a commit made after the prompt showed the branch", async () => {
        const { cwd, remote, state } = repo();
        const ctx = ctxFor(cwd);
        const input = {};
        const p = await GitPushTool.preview!(input, ctx);
        expect(p?.body).toContain(git(cwd, "rev-parse", "--short", "HEAD"));
        git(cwd, "commit", "--allow-empty", "-qm", "late, unreviewed");
        const r = await run(GitPushTool, input, ctx);
        expect(r).toMatchObject({ isError: true, content: expect.stringContaining("changed since the user was asked") });
        expect(calls(state, ".git-calls").some((a) => a.includes("push"))).toBe(false);
        expect(git(remote, "branch", "--list", "feature")).toBe("");
    });

    test("a detached HEAD can't be pushed", async () => {
        const { cwd } = repo();
        git(cwd, "checkout", "-q", "--detach");
        const r = await run(GitPushTool, {}, ctxFor(cwd));
        expect(r).toMatchObject({ isError: true, content: expect.stringContaining("detached HEAD") });
    });
});

describe("CreatePullRequest", () => {
    test("pushes and opens the pull request with the title, body and draft flag", async () => {
        const { cwd, remote, state } = repo(true);
        const r = await run(CreatePullRequestTool, { title: "Add publishing", body: "What and why", draft: true }, ctxFor(cwd));
        expect(r.isError).toBeFalsy();
        expect(r.content).toStartWith("Opened pull request #7 (draft): Add publishing\nhttps://github.com/example/project/pull/7");
        expect(git(remote, "rev-parse", "feature")).toBe(git(cwd, "rev-parse", "HEAD"));
        const create = calls(state).find((a) => a[1] === "create")!;
        expect(create).toEqual(expect.arrayContaining(["--base", "main", "--title", "Add publishing", "--body", "What and why", "--draft"]));
    });

    test("a branch that already has one gets the latest commits pushed, not a second pull request", async () => {
        const { cwd, state } = repo(true);
        const ctx = ctxFor(cwd);
        await run(CreatePullRequestTool, { title: "First" }, ctx);
        git(cwd, "commit", "--allow-empty", "-qm", "more");
        const r = await run(CreatePullRequestTool, { title: "Second" }, ctx);
        expect(r.content).toStartWith("This branch already has an open pull request");
        expect(calls(state).filter((a) => a[1] === "create")).toHaveLength(1);
    });

    test("won't push or open one from a different branch than the prompt showed", async () => {
        const { cwd, state } = repo(true);
        const ctx = ctxFor(cwd);
        const input = { title: "Reviewed" };
        expect((await CreatePullRequestTool.preview!(input, ctx))?.summary).toBe("feature → origin/feature");
        git(cwd, "checkout", "-q", "-b", "unexpected");
        const r = await run(CreatePullRequestTool, input, ctx);
        expect(r).toMatchObject({ isError: true, content: expect.stringContaining("Branch changed") });
        expect(calls(state, ".git-calls").some((a) => a.includes("push"))).toBe(false);
        expect(calls(state).some((a) => a[1] === "create")).toBe(false);
    });

    test("won't push or open one for a commit made after the prompt", async () => {
        const { cwd, state } = repo(true);
        const ctx = ctxFor(cwd);
        const input = { title: "Reviewed" };
        await CreatePullRequestTool.preview!(input, ctx);
        git(cwd, "commit", "--allow-empty", "-qm", "late, unreviewed");
        const r = await run(CreatePullRequestTool, input, ctx);
        expect(r).toMatchObject({ isError: true, content: expect.stringContaining("changed since the user was asked") });
        expect(calls(state, ".git-calls").some((a) => a.includes("push"))).toBe(false);
        expect(calls(state).some((a) => a[1] === "create")).toBe(false);
    });

    test("without a logged-in gh nothing is pushed", async () => {
        const { cwd, state } = repo(true);
        process.env.FAKE_PUBLISH_MODE = "unauthenticated";
        const r = await run(CreatePullRequestTool, { title: "T" }, ctxFor(cwd));
        delete process.env.FAKE_PUBLISH_MODE;
        expect(r).toMatchObject({ isError: true, content: expect.stringContaining("gh auth login") });
        expect(calls(state, ".git-calls").some((a) => a.includes("push"))).toBe(false);
    });

    test("watch: true starts watching what it opened", async () => {
        const { cwd } = repo(true);
        fakeGraphql(() => graphql());
        const ctx = ctxFor(cwd);
        const r = await run(CreatePullRequestTool, { title: "Watched", watch: true }, ctx);
        expect(r.content).toContain("Watching it now.");
        expect([...ctx.state.watchers!.keys()]).toEqual(["pr:example/project#7"]);
    });
});

describe("WatchPullRequest", () => {
    test("the current branch's pull request by default: reports its state and starts one watch", async () => {
        const { cwd } = repo(true);
        const ctx = ctxFor(cwd);
        await run(CreatePullRequestTool, { title: "T" }, ctx);
        const seen = fakeGraphql(() => graphql());
        const r = await run(WatchPullRequestTool, {}, ctx);
        expect(r.isError).toBeFalsy();
        expect(r.content).toContain("Pull request #7");
        expect(r.content).toContain("Checks: 0 passed or skipped, 1 pending, 0 failed");
        expect(r.content).toContain('reviewer: "Please add a test"');
        expect(r.content).toContain("Watching it now.");
        expect(seen[0]).toEqual(expect.arrayContaining(["owner=example", "name=project", "number=7"]));
        const again = await run(WatchPullRequestTool, { pr: "#7" }, ctx);
        expect(again.content).toContain("Already watching it");
        expect(ctx.state.watchers!.size).toBe(1);
        expect((ctx.state.watchers as InstanceType<typeof WatcherMap>).info()).toEqual([{ id: "pr:example/project#7", kind: "pull-request", label: "PR #7 in example/project", url: "https://github.com/example/project/pull/7", detail: "checks running" }]);
    });

    test("by URL, in another repository", async () => {
        const { cwd } = repo();
        const seen = fakeGraphql(() => graphql({ number: 99, url: "https://github.com/other/repo/pull/99" }));
        const ctx = ctxFor(cwd);
        const r = await run(WatchPullRequestTool, { pr: "https://github.com/other/repo/pull/99" }, ctx);
        expect(r.content).toContain("Watching it now.");
        expect(seen[0]).toEqual(expect.arrayContaining(["owner=other", "name=repo", "number=99"]));
    });

    test("a merged pull request isn't watched; a bad reference or no pull request is an error", async () => {
        const { cwd } = repo(true);
        const ctx = ctxFor(cwd);
        fakeGraphql(() => graphql({ state: "MERGED" }));
        const merged = await run(WatchPullRequestTool, { pr: 7 }, ctx);
        expect(merged.content).toContain("It's merged, so there's nothing to watch.");
        expect(ctx.state.watchers!.size).toBe(0);
        expect(await run(WatchPullRequestTool, { pr: "seven" }, ctx)).toMatchObject({ isError: true, content: expect.stringContaining("Not a pull request") });
        // No PR for this branch yet (the fake gh lists none).
        expect(await run(WatchPullRequestTool, {}, ctx)).toMatchObject({ isError: true, content: expect.stringContaining("has no pull request") });
    });

    test("gh not logged in or the pull request missing: an error, no watch", async () => {
        const { cwd } = repo(true);
        const ctx = ctxFor(cwd);
        gitToolDeps.gh = () => async () => ({ out: "", err: "HTTP 401: Bad credentials", code: 1 });
        expect(await run(WatchPullRequestTool, { pr: 7 }, ctx)).toMatchObject({ isError: true, content: expect.stringContaining("gh auth login") });
        gitToolDeps.gh = () => async () => ({ out: "", err: "GraphQL: Could not resolve to a PullRequest with the number of 7.", code: 1 });
        expect(await run(WatchPullRequestTool, { pr: 7 }, ctx)).toMatchObject({ isError: true, content: expect.stringContaining("not found") });
        expect(ctx.state.watchers!.size).toBe(0);
    });

    test("a sub-agent (no wake queue) can't watch", async () => {
        const { cwd } = repo(true);
        const r = await run(WatchPullRequestTool, { pr: 7 }, ctxFor(cwd, { wakes: false }));
        expect(r).toMatchObject({ isError: true, content: expect.stringContaining("Only the session's own agent") });
    });

    test("UnwatchPullRequest stops one or all and drops their pending wakes", async () => {
        const { cwd } = repo(true);
        const ctx = ctxFor(cwd);
        fakeGraphql(() => graphql());
        await run(WatchPullRequestTool, { pr: 7 }, ctx);
        fakeGraphql(() => graphql({ number: 8, url: "https://github.com/example/project/pull/8" }));
        await run(WatchPullRequestTool, { pr: 8 }, ctx);
        ctx.wakes!.push({ source: "pull-request", key: "pr:example/project#7", label: "x", text: "x" });
        expect(await run(UnwatchPullRequestTool, { pr: 3 }, ctx)).toMatchObject({ isError: true, content: expect.stringContaining("Not watching #3") });
        const one = await run(UnwatchPullRequestTool, { pr: "7" }, ctx);
        expect(one.content).toBe("Stopped watching PR #7 in example/project.");
        expect(ctx.wakes!.size).toBe(0);
        expect([...ctx.state.watchers!.keys()]).toEqual(["pr:example/project#8"]);
        expect((await run(UnwatchPullRequestTool, {}, ctx)).content).toBe("Stopped watching PR #8 in example/project.");
        expect((await run(UnwatchPullRequestTool, {}, ctx)).content).toBe("No pull request is being watched.");
    });
});

describe("permissions", () => {
    const tool = (name: string) => BUILTIN_TOOLS.find((t) => t.name === name)!;
    const decide = (name: string, mode: PermissionMode, input: Record<string, unknown> = {}) => {
        const { cwd } = { cwd: iso.home };
        return new PermissionChecker(() => ({}) as any, cwd).check(tool(name), input, mode, cwd);
    };

    test("committing, pushing and opening a pull request ask, offer 'don't ask again', go to the reviewer in auto, and are refused in plan mode", () => {
        for (const name of ["GitCommit", "GitPush", "CreatePullRequest"]) {
            expect(decide(name, "default")).toMatchObject({ behavior: "ask", suggestions: [name] });
            expect(decide(name, "acceptEdits")).toMatchObject({ behavior: "ask" });
            expect(decide(name, "auto")).toMatchObject({ behavior: "ask", needsClassifier: true });
            expect(decide(name, "plan").behavior).toBe("deny");
            expect(decide(name, "bypassPermissions").behavior).toBe("allow");
        }
    });

    test("an allow rule for the tool lets it run; a deny rule stops it even in bypass", () => {
        const cwd = iso.home;
        const allow = new PermissionChecker(() => ({ permissions: { allow: ["GitCommit"] } }) as any, cwd);
        expect(allow.check(tool("GitCommit"), { message: "x" }, "default", cwd).behavior).toBe("allow");
        const deny = new PermissionChecker(() => ({ permissions: { deny: ["GitPush"] } }) as any, cwd);
        expect(deny.check(tool("GitPush"), {}, "bypassPermissions", cwd).behavior).toBe("deny");
    });

    test("watching only reads, so it runs without asking, plan mode included", () => {
        for (const mode of ["default", "plan", "auto"] as const) {
            expect(decide("WatchPullRequest", mode).behavior).toBe("allow");
            expect(decide("UnwatchPullRequest", mode).behavior).toBe("allow");
        }
    });
});

test("fixture sanity: no real gh or network was used", () => {
    expect(existsSync(join(iso.home, "bin", "gh"))).toBe(true);
});
