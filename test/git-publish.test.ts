import { afterAll, expect, test, setDefaultTimeout } from "bun:test";
import { renameSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";
import { publishFixtures } from "./helpers/git-publish";
setDefaultTimeout(120_000);
const iso = isolate();
const fixture = publishFixtures(iso.home);
const { git, repo, calls } = fixture;
const { gitPublishInfo, gitPublish, gitPrState, githubRepo } = await import("../src/server/git-publish");
afterAll(() => { fixture.cleanup(); iso.cleanup(); });

test("push creates upstream, updates only the selected branch, and reports ahead/behind", async () => {
    const { cwd, remote, state } = repo();
    const preview = await gitPublishInfo(cwd);
    expect(preview).toMatchObject({ branch: "feature", remote: "origin", target: "feature", base: "main", protected: false, hasUpstream: false, gh: false });
    expect(calls(state, ".git-calls").some((args) => args.includes("push"))).toBe(false);
    await gitPublish(cwd, { fingerprint: preview.fingerprint, action: "push" });
    expect(git(cwd, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feature");
    expect(git(remote, "rev-parse", "feature")).toBe(git(cwd, "rev-parse", "HEAD"));
    expect(await gitPublishInfo(cwd)).toMatchObject({ ahead: 0, behind: 0, hasUpstream: true });
    git(cwd, "commit", "--allow-empty", "-qm", "next");
    const next = await gitPublishInfo(cwd);
    expect(next.ahead).toBe(1);
    await gitPublish(cwd, { fingerprint: next.fingerprint, action: "push" });
    expect(git(remote, "rev-parse", "feature")).toBe(git(cwd, "rev-parse", "HEAD"));
});

test("no remote, ambiguous remotes, detached HEAD and changed confirmation cannot push", async () => {
    const { cwd, state } = repo();
    const preview = await gitPublishInfo(cwd);
    git(cwd, "commit", "--allow-empty", "-qm", "changed");
    await expect(gitPublish(cwd, { fingerprint: preview.fingerprint, action: "push" })).rejects.toMatchObject({ code: "stale" });
    git(cwd, "remote", "add", "other", "/tmp/nonexistent");
    await expect(gitPublishInfo(cwd)).rejects.toThrow("unambiguous");
    git(cwd, "remote", "remove", "origin"); git(cwd, "remote", "remove", "other");
    await expect(gitPublishInfo(cwd)).rejects.toThrow("unambiguous");
    git(cwd, "checkout", "--detach");
    await expect(gitPublishInfo(cwd)).rejects.toThrow("detached HEAD");
    expect(calls(state, ".git-calls").some((args) => args.includes("push"))).toBe(false);
});

for (const branch of ["main", "master", "release"]) test(`protected ${branch} requires separate explicit acknowledgement`, async () => {
    const { cwd, remote } = repo();
    if (branch === "main") git(cwd, "checkout", "main");
    else git(cwd, "checkout", "-b", branch);
    if (branch === "release") { git(cwd, "push", "origin", "release"); git(remote, "symbolic-ref", "HEAD", "refs/heads/release"); }
    const preview = await gitPublishInfo(cwd);
    expect(preview.protected).toBe(true);
    await expect(gitPublish(cwd, { fingerprint: preview.fingerprint, action: "push" })).rejects.toMatchObject({ code: "protected_branch" });
    await gitPublish(cwd, { fingerprint: preview.fingerprint, action: "push", confirmProtected: true });
});

test("upstream destination is protected even when local branch has a different name", async () => {
    const { cwd } = repo();
    git(cwd, "branch", "--set-upstream-to=origin/main");
    const preview = await gitPublishInfo(cwd);
    expect(preview).toMatchObject({ branch: "feature", target: "main", protected: true });
    await expect(gitPublish(cwd, { fingerprint: preview.fingerprint, action: "push" })).rejects.toMatchObject({ code: "protected_branch" });
});

test("non-fast-forward is visible, never forced even with mirror and force refspec config", async () => {
    const { cwd, remote } = repo();
    await gitPublish(cwd, { fingerprint: (await gitPublishInfo(cwd)).fingerprint, action: "push" });
    git(cwd, "commit", "--allow-empty", "-qm", "remote version"); git(cwd, "push", "origin", "feature");
    const remoteHead = git(remote, "rev-parse", "feature");
    git(cwd, "reset", "--hard", "HEAD~1"); git(cwd, "commit", "--allow-empty", "-qm", "local version");
    git(cwd, "config", "remote.origin.mirror", "true"); git(cwd, "config", "remote.origin.push", "+refs/heads/*:refs/heads/*");
    const preview = await gitPublishInfo(cwd);
    await expect(gitPublish(cwd, { fingerprint: preview.fingerprint, action: "push" })).rejects.toThrow("No force push was attempted");
    expect(git(remote, "rev-parse", "feature")).toBe(remoteHead);
});

test("unsafe remote and branch inputs, multiple push URLs and destination changes are refused", async () => {
    const { cwd } = repo();
    const preview = await gitPublishInfo(cwd);
    git(cwd, "remote", "set-url", "origin", "/tmp/changed");
    await expect(gitPublish(cwd, { fingerprint: preview.fingerprint, action: "push" })).rejects.toMatchObject({ code: "stale" });
    git(cwd, "remote", "set-url", "origin", "ext::sh bad");
    await expect(gitPublishInfo(cwd)).rejects.toThrow("ordinary push URL");
    git(cwd, "remote", "set-url", "origin", "/tmp/one"); git(cwd, "remote", "set-url", "--add", "--push", "origin", "/tmp/a"); git(cwd, "remote", "set-url", "--add", "--push", "origin", "/tmp/b");
    await expect(gitPublishInfo(cwd)).rejects.toThrow("ordinary push URL");
});

test("fake gh creates editable draft PR after local push, redacts prefill and outgoing text, and reads PR state", async () => {
    const { cwd, remote, state } = repo(true);
    const secret = `ghp_${"x".repeat(40)}`;
    git(cwd, "commit", "--allow-empty", "-qm", `Never publish ${secret}`);
    const preview = await gitPublishInfo(cwd);
    expect(preview.gh).toBe(true); expect(preview.title).not.toContain(secret); expect(preview.body).not.toContain(secret);
    const result = await gitPublish(cwd, { fingerprint: preview.fingerprint, action: "pr", base: "main", title: `Edited ${secret}`, body: `Body ${secret}\n$(touch nope)`, draft: true });
    expect(result.pr).toMatchObject({ number: 7, state: "draft", checks: 1 });
    expect(result.pr!.title).toContain("REDACTED");
    expect(git(remote, "rev-parse", "feature")).toBe(git(cwd, "rev-parse", "HEAD"));
    const create = calls(state).find((args) => args[1] === "create")!;
    expect(create).toContain("--draft"); expect(create.join(" ")).not.toContain(secret); expect(create).toContain("Body [REDACTED github-token]\n$(touch nope)");
    expect(await gitPrState(cwd)).toEqual(result.pr);
    writeFileSync(state, JSON.stringify({ number: 7, url: result.pr!.url, title: "Merged", state: "MERGED", isDraft: true }));
    expect((await gitPrState(cwd))?.state).toBe("merged");
});

test("unauthenticated gh offers compare and refuses PR creation before push", async () => {
    const { cwd, state } = repo(true); process.env.FAKE_PUBLISH_MODE = "unauthenticated";
    const preview = await gitPublishInfo(cwd);
    expect(preview.gh).toBe(false); expect(preview.compareUrl).toBe("https://github.com/example/project/compare/main...feature?expand=1");
    await expect(gitPublish(cwd, { fingerprint: preview.fingerprint, action: "pr", base: "main", title: "Title" })).rejects.toThrow("not authenticated");
    expect(calls(state, ".git-calls").some((args) => args.includes("push"))).toBe(false);
});

test("existing PR and concurrent creation return the PR without duplicate creation", async () => {
    const { cwd, state } = repo(true);
    const preview = await gitPublishInfo(cwd);
    process.env.FAKE_PUBLISH_MODE = "already-exists";
    const request = { fingerprint: preview.fingerprint, action: "pr" as const, base: "main", title: "Title" };
    expect((await gitPublish(cwd, request)).pr?.number).toBe(7);
    const current = await gitPublishInfo(cwd);
    expect((await gitPublish(cwd, { ...request, fingerprint: current.fingerprint })).pr?.number).toBe(7);
    expect(calls(state).filter((args) => args[1] === "create")).toHaveLength(1);
});

test("PR failure reports that push succeeded; errors are redacted and bounded", async () => {
    const { cwd, remote } = repo(true);
    const preview = await gitPublishInfo(cwd); process.env.FAKE_PUBLISH_MODE = "create-error";
    await expect(gitPublish(cwd, { fingerprint: preview.fingerprint, action: "pr", base: "main", title: "Title" })).rejects.toThrow("Branch pushed, but pull request creation failed");
    expect(git(remote, "rev-parse", "feature")).toBe(git(cwd, "rev-parse", "HEAD"));
    process.env.FAKE_PUBLISH_MODE = "error";
    try { await gitPrState(cwd); throw new Error("expected failure"); } catch (e) {
        expect((e as Error).message).toContain("REDACTED"); expect((e as Error).message.length).toBeLessThanOrEqual(4000);
        expect((e as Error).message).not.toContain(`ghp_${"x".repeat(40)}`);
    }
});

test("compare links accept github.com only and never credentials, queries or executable schemes", () => {
    for (const value of ["git@github.com:example/project.git", "ssh://git@github.com/example/project.git", "https://github.com/example/project.git"]) expect(githubRepo(value)).toBe("example/project");
    for (const value of ["https://token@github.com/example/project", "https://github.com.evil/example/project", "https://github.com/example/project?token=secret", "javascript:alert(1)", "https://github.com/../project", `https://github.com/ghp_${"x".repeat(40)}/project`]) expect(githubRepo(value)).toBeUndefined();
});

test("linked worktree publishes its own branch", async () => {
    const { cwd, remote } = repo(); const worktree = `${cwd}-worktree`;
    git(cwd, "worktree", "add", "-b", "worktree", worktree);
    writeFileSync(join(worktree, "a"), "worktree"); git(worktree, "add", "a"); git(worktree, "commit", "-qm", "worktree commit");
    await gitPublish(worktree, { fingerprint: (await gitPublishInfo(worktree)).fingerprint, action: "push" });
    expect(git(remote, "rev-parse", "worktree")).toBe(git(worktree, "rev-parse", "HEAD"));
});


test("URL userinfo and query credentials never reach preview or git errors", async () => {
    const { cwd } = repo();
    for (const url of ["https://opaque-user:opaque-password@example.test/project.git?access_token=opaque-query#opaque-fragment", "ssh://opaque-user:opaque-password@example.test/project.git"]) {
        git(cwd, "remote", "set-url", "origin", url);
        const preview = await gitPublishInfo(cwd);
        expect(preview.destination).not.toContain("opaque-");
        expect(preview.compareUrl).toBeUndefined();
    }
});

test("missing gh falls back to compare without running real gh", async () => {
    const { cwd } = repo(true);
    const savedPath = process.env.PATH;
    const path = join(iso.home, "bin", "gh");
    renameSync(path, `${path}-hidden`);
    process.env.PATH = join(iso.home, "bin");
    try {
        expect(Bun.which("gh", { PATH: process.env.PATH })).toBeNull();
        const preview = await gitPublishInfo(cwd);
        expect(preview.gh).toBe(false);
        expect(preview.compareUrl).toContain("https://github.com/example/project/compare/");
    } finally { process.env.PATH = savedPath; renameSync(`${path}-hidden`, path); }
});


test("PR state lookup failure leaves the push preview usable", async () => {
    const { cwd } = repo(true); process.env.FAKE_PUBLISH_MODE = "error";
    const preview = await gitPublishInfo(cwd);
    expect(preview).toMatchObject({ gh: true, branch: "feature", pr: undefined });
    expect(preview.prError).toContain("REDACTED");
});

test("an unknown remote default requires explicit confirmation and cancellation starts no processes", async () => {
    const { cwd, remote, state } = repo();
    git(remote, "symbolic-ref", "HEAD", "refs/heads/unborn-default");
    const preview = await gitPublishInfo(cwd);
    expect(preview.defaultUnknown).toBe(true);
    await expect(gitPublish(cwd, { fingerprint: preview.fingerprint, action: "push" })).rejects.toMatchObject({ code: "protected_branch" });
    const before = calls(state, ".git-calls").length;
    await expect(gitPublish(cwd, { fingerprint: preview.fingerprint, action: "push", confirmProtected: true }, AbortSignal.abort())).rejects.toMatchObject({ code: "git_cancelled" });
    expect(calls(state, ".git-calls")).toHaveLength(before);
    await gitPublish(cwd, { fingerprint: preview.fingerprint, action: "push", confirmProtected: true });
    expect(git(remote, "rev-parse", "feature")).toBe(git(cwd, "rev-parse", "HEAD"));
});


test("compare links never expose a secret-shaped branch name", async () => {
    const { cwd } = repo(true);
    const secret = `ghp_${"x".repeat(40)}`;
    git(cwd, "checkout", "-b", secret);
    const preview = await gitPublishInfo(cwd);
    expect(preview.compareUrl).toBeUndefined();
    expect(JSON.stringify(preview)).not.toContain(secret);
});
