import { afterAll, expect, test, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join, relative } from "path";
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
    writeFileSync(state, JSON.stringify({ number: 7, url: result.pr!.url, title: "Merged", state: "MERGED", isDraft: true, headRefName: "feature", headRepository: { name: "project" }, headRepositoryOwner: { login: "example" }, updatedAt: "2026-10-17T00:00:00Z" }));
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


test("repository transport config is audited across local, worktree and nested includes", async () => {
    const { gitNetworkSkipReason } = await import("../src/util/git");
    const { cwd, state } = repo();
    for (const key of ["core.sshCommand", "core.gitProxy", "core.askPass", "core.alternateRefsCommand", "credential.helper", "credential.https://example.invalid.helper", "remote.origin.uploadpack", "remote.origin.receivepack", "remote.origin.proxy", "remote.origin.vcs", "http.proxy", "http.https://example.invalid.proxy", "gpg.program", "gpg.openpgp.program", "gpg.ssh.program", "gpg.ssh.defaultKeyCommand", "push.gpgSign", "url.ext::payload.insteadOf", "url./tmp/transport.pushInsteadOf"]) {
        git(cwd, "config", key, "payload");
        expect(await gitNetworkSkipReason(cwd)).toContain("explicit user trust");
        git(cwd, "config", "--unset-all", key);
    }
    expect(await gitNetworkSkipReason(cwd)).toBeUndefined();
    expect(calls(state, ".git-calls")).toHaveLength(0);
    for (const kind of ["include", "worktree", "worktree-include", "conditional-worktree", "inactive-worktree"]) {
        const project = repo();
        const nested = join(project.cwd, ".git", "nested-config");
        git(project.cwd, "config", "--file", nested, "credential.helper", "!sh ./payload.sh");
        const included = join(project.cwd, ".git", "included-config");
        git(project.cwd, "config", "--file", included, "include.path", nested);
        if (kind === "include") git(project.cwd, "config", "include.path", included);
        else {
            if (kind !== "inactive-worktree") git(project.cwd, "config", "extensions.worktreeConfig", "true");
            const file = join(project.cwd, ".git", "config.worktree");
            git(project.cwd, "config", "--file", file, kind === "worktree" ? "core.sshCommand" : kind === "conditional-worktree" ? "includeIf.onbranch:feature.path" : "include.path", kind === "worktree" ? "sh ./payload.sh" : included);
        }
        await expect(gitPublishInfo(project.cwd)).rejects.toMatchObject({ code: "needs_trust" });
        expect(calls(project.state, ".git-calls")).toHaveLength(0);
        expect(calls(project.state)).toHaveLength(0);
    }
});

test("an SSH payload proven executable stays blocked before explicit trust, including with redirected audit environment", async () => {
    const { trustFolder, trustForSession } = await import("../src/config/trust");
    const { cwd, state } = repo();
    const preview = await gitPublishInfo(cwd);
    const marker = join(cwd, "ssh-ran");
    writeFileSync(join(cwd, "payload.sh"), ": > ssh-ran\nexit 1\n");
    git(cwd, "config", "core.sshCommand", "sh ./payload.sh");
    // The replacement SSH command exits locally: this proof never connects.
    const proof = Bun.spawnSync([process.env.FAKE_PUBLISH_GIT!, "ls-remote", "ssh://git@example.invalid/repo.git"], { cwd, env: { ...process.env, GIT_ALLOW_PROTOCOL: "ssh", GIT_SSH_VARIANT: "ssh" }, stdout: "pipe", stderr: "pipe" });
    expect(proof.exitCode).not.toBe(0); expect(existsSync(marker)).toBe(true); rmSync(marker);
    trustForSession(cwd);
    const before = calls(state, ".git-calls").length;
    const benign = join(cwd, "benign-config"); writeFileSync(benign, "");
    const savedConfig = process.env.GIT_CONFIG, savedDir = process.env.GIT_DIR;
    const other = join(cwd, "other"); mkdirSync(other); git(other, "init", "-q");
    process.env.GIT_CONFIG = benign; process.env.GIT_DIR = join(other, ".git");
    try {
        await expect(gitPublishInfo(cwd)).rejects.toMatchObject({ code: "needs_trust" });
        await expect(gitPrState(cwd)).rejects.toMatchObject({ code: "needs_trust" });
        await expect(gitPublish(cwd, { fingerprint: preview.fingerprint, action: "push" })).rejects.toMatchObject({ code: "needs_trust" });
    } finally {
        if (savedConfig === undefined) delete process.env.GIT_CONFIG; else process.env.GIT_CONFIG = savedConfig;
        if (savedDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = savedDir;
    }
    expect(existsSync(marker)).toBe(false); expect(calls(state, ".git-calls")).toHaveLength(before);
    trustFolder(cwd);
    expect((await gitPublishInfo(cwd)).branch).toBe("feature");
    expect(existsSync(marker)).toBe(false);
});

test("ordinary user-global transport config and its includes remain allowed", async () => {
    const { gitNetworkSkipReason } = await import("../src/util/git");
    const { cwd } = repo();
    const config = join(cwd, "user-global"), included = join(cwd, "user-global-included");
    git(cwd, "config", "--file", included, "core.sshCommand", "ssh");
    git(cwd, "config", "--file", included, "credential.helper", "fixture-unused");
    git(cwd, "config", "--file", included, "http.proxy", "http://proxy.invalid");
    git(cwd, "config", "--file", config, "include.path", included);
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = config;
    try {
        expect(await gitNetworkSkipReason(cwd)).toBeUndefined();
        expect((await gitPublishInfo(cwd)).branch).toBe("feature");
    } finally { process.env.GIT_CONFIG_GLOBAL = saved; }
});

for (const scope of ["local", "global", "included-global"]) test(`${scope} chained URL rewrites cannot split discovery from the push destination`, async () => {
    const { trustFolder } = await import("../src/config/trust");
    const { cwd, remote, state } = repo();
    trustFolder(cwd);
    const saved = process.env.GIT_CONFIG_GLOBAL;
    const config = join(cwd, "rewrite-config");
    if (scope === "global") process.env.GIT_CONFIG_GLOBAL = config;
    if (scope === "included-global") {
        const outer = join(cwd, "global-outer"); git(cwd, "config", "--file", outer, "include.path", config);
        process.env.GIT_CONFIG_GLOBAL = outer;
    }
    try {
        for (const rule of ["insteadOf", "pushInsteadOf"]) {
            const options = scope === "local" ? [] : ["--file", config];
            git(cwd, "remote", "set-url", "origin", "publish:fixture");
            git(cwd, "config", ...options, `url.${remote}.${rule}`, "publish:fixture");
            git(cwd, "config", ...options, "url./tmp/other-destination.insteadOf", remote);
            expect(git(cwd, "remote", "get-url", "--push", "origin")).toBe(remote);
            await expect(gitPublishInfo(cwd)).rejects.toThrow("URL rewrite applies");
            await expect(gitPublish(cwd, { fingerprint: "a".repeat(64), action: "push", confirmProtected: true })).rejects.toThrow("URL rewrite applies");
            expect(calls(state, ".git-calls")).toHaveLength(0);
            git(cwd, "config", ...options, "--remove-section", `url.${remote}`);
            git(cwd, "config", ...options, "--remove-section", "url./tmp/other-destination");
        }
    } finally { process.env.GIT_CONFIG_GLOBAL = saved; }
});

test("push URLs are audited for rewrites; unrelated rewrites do not block publishing", async () => {
    const { trustFolder } = await import("../src/config/trust");
    const { cwd, remote, state } = repo(); trustFolder(cwd);
    git(cwd, "config", "remote.origin.pushurl", "publish:fixture");
    git(cwd, "config", `url.${remote}.insteadOf`, "publish:");
    await expect(gitPublishInfo(cwd)).rejects.toThrow("URL rewrite applies");
    expect(calls(state, ".git-calls")).toHaveLength(0);
    git(cwd, "config", "--unset-all", "remote.origin.pushurl");
    expect((await gitPublishInfo(cwd)).destination).toBe(remote);
});

test("moving the source branch after the last check can only push the confirmed SHA", async () => {
    const { cwd, remote, state } = repo();
    const confirmed = git(cwd, "rev-parse", "HEAD");
    const preview = await gitPublishInfo(cwd);
    const later = git(cwd, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "unconfirmed commit");
    process.env.FAKE_PUBLISH_MOVE_HEAD = later;
    await gitPublish(cwd, { fingerprint: preview.fingerprint, action: "push" });
    expect(git(cwd, "rev-parse", "HEAD")).toBe(later);
    expect(git(remote, "rev-parse", "feature")).toBe(confirmed);
    expect(git(cwd, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feature");
    const push = calls(state, ".git-calls").find((args) => args.includes("push"))!;
    expect(push).toContain(`${confirmed}:refs/heads/feature`);
    expect(push).toContain("--no-force"); expect(push).not.toContain("-u");
});

test("numeric branches select the exact head in this repo, prefer open/draft, then newest history", async () => {
    const { cwd, state } = repo(true); git(cwd, "checkout", "-b", "123");
    const record = (number: number, headRefName: string, prState: string, updatedAt: string) => ({ number, url: `https://github.com/example/project/pull/${number}`, headRefName, state: prState, updatedAt, title: `PR ${number}`, isDraft: prState === "OPEN", headRepository: { name: "project" }, headRepositoryOwner: { login: "example" } });
    const open = record(7, "123", "OPEN", "2025-01-01T00:00:00Z");
    const recent = record(8, "123", "MERGED", "2026-10-17T00:00:00Z");
    const wrong = record(123, "different-branch", "OPEN", "2026-10-18T00:00:00Z");
    const fork = { ...record(999, "123", "OPEN", "2026-10-19T00:00:00Z"), headRepositoryOwner: { login: "someone-else" } };
    const otherRepo = { ...record(1000, "123", "OPEN", "2026-10-20T00:00:00Z"), headRepository: { name: "another-project" } };
    writeFileSync(state, JSON.stringify([wrong, fork, otherRepo, recent, open]));
    expect(await gitPrState(cwd)).toMatchObject({ number: 7, state: "draft" });
    const preview = await gitPublishInfo(cwd);
    expect((await gitPublish(cwd, { fingerprint: preview.fingerprint, action: "pr", base: "main", title: "Existing numeric branch" })).pr?.number).toBe(7);
    expect(calls(state).some((args) => args[1] === "create")).toBe(false);
    // Looked up by head owner and branch, then read by the number picked.
    expect(calls(state).filter((args) => args[0] === "api").every((args) => args.includes("head=example:123"))).toBe(true);
    expect(calls(state).filter((args) => args[1] === "view").every((args) => args[2] === "7")).toBe(true);
    writeFileSync(state, JSON.stringify([wrong, fork, otherRepo, record(6, "123", "CLOSED", "2026-01-01T00:00:00Z"), recent]));
    expect(await gitPrState(cwd)).toMatchObject({ number: 8, state: "merged" });
    writeFileSync(state, JSON.stringify([wrong, fork, otherRepo]));
    expect(await gitPrState(cwd)).toBeUndefined();
    writeFileSync(state, JSON.stringify([open]));
    git(cwd, "remote", "set-url", "origin", "https://github.com/EXAMPLE/Project.git");
    expect((await gitPrState(cwd))?.number).toBe(7);
});


test("each network call reaudits config added after a preceding network read", async () => {
    for (const read of [gitPrState, gitPublishInfo]) {
        const { cwd, state } = repo(true);
        process.env.FAKE_PUBLISH_MODE = "install-ssh-config";
        await expect(read(cwd)).rejects.toMatchObject({ code: "needs_trust" });
        expect(calls(state)).toHaveLength(1);
        expect(calls(state)[0]!.slice(0, 2)).toEqual(["auth", "status"]);
    }
});

test("other owners' PRs from a branch of the same name can't hide this repository's open PR (#107)", async () => {
    const { cwd, state } = repo(true);
    const record = (number: number, login: string, updatedAt: string) => ({ number, url: `https://github.com/example/project/pull/${number}`, headRefName: "feature", state: "OPEN", updatedAt, title: `PR ${number}`, isDraft: false, headRepository: { name: "project" }, headRepositoryOwner: { login } });
    const forks = Array.from({ length: 100 }, (_, i) => record(100 + i, `fork-${i}`, "2026-10-20T00:00:00Z"));
    writeFileSync(state, JSON.stringify([record(7, "example", "2026-10-01T00:00:00Z"), ...forks]));
    expect(await gitPrState(cwd)).toMatchObject({ number: 7, state: "open" });
    const preview = await gitPublishInfo(cwd);
    expect((await gitPublish(cwd, { fingerprint: preview.fingerprint, action: "pr", base: "main", title: "Duplicate?" })).pr?.number).toBe(7);
    expect(calls(state).some((args) => args[1] === "create")).toBe(false);
});

test("a remote URL changed after the last check doesn't move the push: it goes to the URL confirmed (#107)", async () => {
    const { cwd, remote, state } = repo();
    const other = `${cwd}-other`; mkdirSync(other); git(other, "init", "--bare", "-q", "-b", "main");
    const preview = await gitPublishInfo(cwd);
    process.env.FAKE_PUBLISH_PUSH_CONFIG = `remote.origin.url=${other}`;
    await gitPublish(cwd, { fingerprint: preview.fingerprint, action: "push" });
    expect(git(remote, "rev-parse", "feature")).toBe(git(cwd, "rev-parse", "HEAD"));
    expect(() => git(other, "rev-parse", "--verify", "feature")).toThrow();
    // The remote's tracking branch moves as a push to the remote would have moved it.
    expect(git(cwd, "rev-parse", "origin/feature")).toBe(git(cwd, "rev-parse", "HEAD"));
    expect(calls(state, ".git-calls").find((args) => args.includes("push"))).toContain(remote);
});

for (const rule of ["insteadOf", "pushInsteadOf"]) test(`a URL ${rule} rewrite added after the last check is refused before anything is pushed (#107)`, async () => {
    const { trustFolder } = await import("../src/config/trust");
    const { cwd, remote } = repo(); trustFolder(cwd);
    const other = `${cwd}-other`; mkdirSync(other); git(other, "init", "--bare", "-q", "-b", "main");
    const preview = await gitPublishInfo(cwd);
    process.env.FAKE_PUBLISH_PUSH_CONFIG = `url.${other}.${rule}=${remote}`;
    await expect(gitPublish(cwd, { fingerprint: preview.fingerprint, action: "push" })).rejects.toThrow("push destination changed");
    expect(() => git(other, "rev-parse", "--verify", "feature")).toThrow();
    expect(() => git(remote, "rev-parse", "--verify", "feature")).toThrow();
});

test("network calls run from an empty folder of their own: a helper the user's settings name by a relative path can't reach the repository's files (#107)", async () => {
    const { cwd, state } = repo(true);
    writeFileSync(join(cwd, "payload.sh"), ": > ssh-ran\nexit 1\n");
    // In the repository, git runs a helper at its top, so `sh payload.sh` there would be the repository's.
    expect(await gitPrState(cwd)).toBeUndefined();
    const preview = await gitPublishInfo(cwd);
    await gitPublish(cwd, { fingerprint: preview.fingerprint, action: "push" });
    const cwds = readFileSync(`${state}.cwds`, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { cwd: string; empty: boolean });
    // gh's (auth status, the PR lookup) and git's (ls-remote, push).
    expect(cwds.length).toBeGreaterThanOrEqual(4);
    for (const at of cwds) {
        expect(relative(cwd, at.cwd).startsWith("..")).toBe(true);
        expect(at.empty).toBe(true);
        expect(existsSync(at.cwd)).toBe(false);
    }
});

test("a push to the confirmed URL moves the tracking refs the remote's fetch refspecs name, as git would (#107)", async () => {
    const { trackingRefs } = await import("../src/server/git-publish");
    const ref = "refs/heads/feature";
    expect(trackingRefs(["+refs/heads/*:refs/remotes/origin/*"], ref)).toEqual(["refs/remotes/origin/feature"]);
    // A single-branch clone's, a negative one, several, and one for another branch.
    expect(trackingRefs(["+refs/heads/feature:refs/remotes/origin/feature"], ref)).toEqual(["refs/remotes/origin/feature"]);
    expect(trackingRefs(["+refs/heads/*:refs/remotes/origin/*", "^refs/heads/feature"], ref)).toEqual([]);
    // Only the first that matches, as git updates it: not a later one into the local branches.
    expect(trackingRefs(["+refs/heads/*:refs/remotes/origin/*", "+refs/heads/*:refs/heads/archive/*"], ref)).toEqual(["refs/remotes/origin/feature"]);
    expect(trackingRefs(["+refs/heads/main:refs/remotes/origin/main", "refs/heads/feat*:refs/remotes/mirror/feat*"], ref)).toEqual(["refs/remotes/mirror/feature"]);
    expect(trackingRefs(["+refs/heads/main:refs/remotes/origin/main"], ref)).toEqual([]);
    const { cwd } = repo();
    git(cwd, "config", "--replace-all", "remote.origin.fetch", "+refs/heads/feature:refs/remotes/origin/feature");
    const preview = await gitPublishInfo(cwd);
    await gitPublish(cwd, { fingerprint: preview.fingerprint, action: "push" });
    expect(git(cwd, "rev-parse", "origin/feature")).toBe(git(cwd, "rev-parse", "HEAD"));
});

test("100 newer closed PRs from this branch to other bases can't hide its open PR (#107)", async () => {
    const { cwd, state } = repo(true);
    const record = (number: number, prState: string, updatedAt: string) => ({ number, url: `https://github.com/example/project/pull/${number}`, headRefName: "feature", state: prState, updatedAt, title: `PR ${number}`, isDraft: false, headRepository: { name: "project" }, headRepositoryOwner: { login: "example" } });
    const closed = Array.from({ length: 100 }, (_, i) => record(100 + i, "CLOSED", "2026-10-20T00:00:00Z"));
    writeFileSync(state, JSON.stringify([record(7, "OPEN", "2026-10-01T00:00:00Z"), ...closed]));
    expect(await gitPrState(cwd)).toMatchObject({ number: 7, state: "open" });
    // On github.com, whatever host gh would pick by default.
    expect(calls(state).filter((args) => args[0] === "api").every((args) => args[args.indexOf("--hostname") + 1] === "github.com")).toBe(true);
    // None open: the most recently updated of the rest.
    writeFileSync(state, JSON.stringify([record(7, "CLOSED", "2026-10-01T00:00:00Z"), record(9, "MERGED", "2026-10-25T00:00:00Z"), record(8, "CLOSED", "2026-10-02T00:00:00Z")]));
    expect(await gitPrState(cwd)).toMatchObject({ number: 9, state: "merged" });
});
