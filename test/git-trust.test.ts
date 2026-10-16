import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { gitBranch, gitSnapshot } = await import("../src/util/git");
const { environmentBlock } = await import("../src/agent/system-prompt");
const { trustFolder, trustForSession } = await import("../src/config/trust");
const { Engine } = await import("../src/server/engine");
const repo = tempDir("hostile-git-");
const plain = tempDir("not-git-");
afterAll(() => {
    iso.cleanup();
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
});
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function git(args: string[], input?: string) {
    const r = Bun.spawnSync(["git", ...args], { cwd: repo, env, stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe", timeout: 3000 });
    expect(r.exitCode).toBe(0);
    return r.stdout.toString().trim();
}
const markers = ["clean", "process", "smudge", "gpg"].map((n) => join(repo, `${n}.marker`));
const clear = () => markers.forEach((p) => rmSync(p, { force: true }));
const untouched = () => markers.forEach((p) => expect(existsSync(p)).toBe(false));
let mtime = 1_000_000;
function stale() {
    mtime += 10_000;
    for (const f of ["a", "b"]) {
        writeFileSync(join(repo, f), "contents\n");
        utimesSync(join(repo, f), new Date(mtime), new Date(mtime));
    }
}

test("opening an implicitly trusted repo never executes its filters or signature verifier", async () => {
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.invalid"]);
    writeFileSync(join(repo, ".gitattributes"), "a filter=x\nb filter=y\n");
    stale();
    git(["add", "."]);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
    const commit = git(["cat-file", "commit", "HEAD"]);
    const signed = commit.replace("\n\n", "\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\n");
    git(["update-ref", "HEAD", git(["hash-object", "-t", "commit", "-w", "--stdin"], signed)]);
    for (const name of ["clean", "process", "smudge", "gpg"]) {
        const script = join(repo, `${name}.sh`);
        writeFileSync(script, `#!/bin/sh\ntouch '${join(repo, `${name}.marker`)}'\n${name === "process" || name === "gpg" ? "exit 1" : "cat"}\n`);
        chmodSync(script, 0o700);
        git(["config", name === "gpg" ? "gpg.program" : `filter.${name === "process" ? "y" : "x"}.${name}`, script]);
    }
    git(["config", "log.showSignature", "true"]);
    stale();
    git(["status", "--short"]);
    expect(existsSync(markers[0]!)).toBe(true);
    expect(existsSync(markers[1]!)).toBe(true);
    git(["log", "--oneline", "-n", "5"]);
    expect(existsSync(markers[3]!)).toBe(true);
    // Smudge runs on checkout, not status: prove that tripwire too.
    rmSync(join(repo, "a"));
    git(["checkout-index", "--force", "--", "a"]);
    expect(existsSync(markers[2]!)).toBe(true);
    clear();
    stale();
    trustForSession(repo);
    expect(gitBranch(repo)).toBe("main");
    expect(gitSnapshot(repo)).toMatchObject({ branch: "main", statusSkipped: "repository filter configuration requires user trust" });
    expect(gitSnapshot(repo)?.status).toBeUndefined();
    expect(gitSnapshot(repo)?.recentCommits).toContain("fixture");
    const engine = new Engine({ listModels: async () => [] });
    try {
        expect(engine.inspectProject(repo).branch).toBe("main");
        untouched();
        const runtime = await engine.createSession(repo);
        expect(runtime.snapshot().state.branch).toBe("main");
        untouched();
        expect(environmentBlock(repo, { provider: "test", id: "test" }, true)).toContain("not read: repository filter configuration requires user trust");
        untouched();
    } finally {
        await engine.stop();
    }
    trustFolder(repo);
    const snapshot = gitSnapshot(repo)!;
    expect(snapshot.status).toBeDefined();
    expect(snapshot.recentCommits).toContain("fixture");
    expect(existsSync(markers[0]!)).toBe(true);
    expect(existsSync(markers[1]!)).toBe(true);
    expect(existsSync(markers[2]!)).toBe(false);
    expect(existsSync(markers[3]!)).toBe(false);
    // Branch-only callers remain branch-only even after trust.
    clear();
    stale();
    expect(engine.inspectProject(repo).branch).toBe("main");
    untouched();
    git(["-c", "core.hooksPath=/dev/null", "checkout", "--detach", "HEAD"]);
    expect(gitBranch(repo)).toBeUndefined();
    expect(gitSnapshot(repo)?.branch).toBeUndefined();
    expect(gitBranch(plain)).toBeUndefined();
    expect(gitSnapshot(plain)).toBeUndefined();
});

const repos: string[] = [];
afterAll(() => {
    for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

function run(dir: string, args: string[], extraEnv: Record<string, string> = {}) {
    const result = Bun.spawnSync(["git", ...args], { cwd: dir, env: { ...env, ...extraEnv }, stdout: "pipe", stderr: "pipe", timeout: 3000 });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
}

function freshRepo() {
    const dir = tempDir("git-status-trust-");
    repos.push(dir);
    run(dir, ["init", "-b", "main"]);
    run(dir, ["config", "user.name", "Test"]);
    run(dir, ["config", "user.email", "test@example.invalid"]);
    writeFileSync(join(dir, ".gitattributes"), "a filter=x\n");
    writeFileSync(join(dir, "a"), "contents\n");
    run(dir, ["add", "."]);
    run(dir, ["-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
    return dir;
}

function staleFile(dir: string) {
    mtime += 10_000;
    writeFileSync(join(dir, "a"), "contents\n");
    utimesSync(join(dir, "a"), new Date(mtime), new Date(mtime));
}

function markerScript(dir: string, body = "cat") {
    const script = join(dir, ".git", "marker.sh");
    const marker = join(dir, ".git", "executed");
    writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n${body}\n`, { mode: 0o700 });
    return { script, marker };
}

for (const kind of ["clean", "process", "include", "worktree", "conditional-worktree", "fsmonitor", "hookspath", "hook"] as const) {
    test(`untrusted status skips ${kind} configuration after proving plain status executes it`, () => {
        const dir = freshRepo();
        const { script, marker } = markerScript(dir, kind === "process" || kind === "fsmonitor" ? "exit 1" : "cat");
        let section = "filter";
        if (kind === "conditional-worktree") {
            const included = join(dir, ".git", "included-config");
            run(dir, ["config", "--file", included, "filter.x.clean", script]);
            run(dir, ["config", "remote.origin.url", "https://example.invalid/repo"]);
            run(dir, ["config", "extensions.worktreeConfig", "true"]);
            run(dir, ["config", "--worktree", "includeIf.hasconfig:remote.*.url:https://example.invalid/**.path", included]);
        } else if (kind === "include" || kind === "worktree") {
            const file = join(dir, ".git", kind === "worktree" ? "config.worktree" : "included-config");
            run(dir, ["config", "--file", file, "filter.x.clean", script]);
            run(dir, ["config", ...(kind === "worktree" ? ["extensions.worktreeConfig", "true"] : ["include.path", file])]);
        } else if (kind === "fsmonitor") {
            section = "core.fsmonitor";
            run(dir, ["config", "core.fsmonitor", script]);
        } else if (kind === "hookspath") {
            section = "core.hookspath";
            const hooks = join(dir, ".git", "custom-hooks");
            mkdirSync(hooks);
            writeFileSync(join(hooks, "post-index-change"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
            run(dir, ["config", "core.hooksPath", hooks]);
        } else if (kind === "hook") {
            section = "hook";
            run(dir, ["config", "hook.tripwire.command", script]);
            run(dir, ["config", "hook.tripwire.event", "post-index-change"]);
        } else {
            run(dir, ["config", `filter.x.${kind}`, script]);
        }
        staleFile(dir);
        run(dir, ["status", "--short"], { GIT_OPTIONAL_LOCKS: "1" });
        expect(existsSync(marker)).toBe(true);
        rmSync(marker);
        staleFile(dir);
        const snapshot = gitSnapshot(dir)!;
        expect(snapshot.status).toBeUndefined();
        expect(snapshot.statusSkipped).toBe(`repository ${section} configuration requires user trust`);
        expect(snapshot.recentCommits).toContain("fixture");
        expect(existsSync(marker)).toBe(false);
        const prompt = environmentBlock(dir, { provider: "test", id: "test" });
        expect(prompt).toContain(`Git status was not read: repository ${section} configuration requires user trust.`);
        expect(prompt).not.toContain(script);
    });
}

test("submodule configuration skips status before entering a hostile real submodule", () => {
    const source = freshRepo();
    const dir = freshRepo();
    run(dir, ["-c", "protocol.file.allow=always", "submodule", "add", source, "nested"]);
    run(dir, ["-c", "commit.gpgsign=false", "commit", "-am", "submodule"]);
    const nested = join(dir, "nested");
    const { script, marker } = markerScript(dir);
    run(nested, ["config", "filter.x.clean", script]);
    staleFile(nested);
    run(dir, ["status", "--short"]);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    staleFile(nested);
    expect(gitSnapshot(dir)?.statusSkipped).toBe("repository submodule configuration requires user trust");
    expect(existsSync(marker)).toBe(false);
    // Even without a local submodule key, --ignore-submodules=all prevents recursion.
    run(dir, ["config", "--remove-section", "submodule.nested"]);
    expect(gitSnapshot(dir)?.status).toBe("(clean)");
    expect(existsSync(marker)).toBe(false);
});

test("ordinary init and clone repositories keep status and commits before user trust", () => {
    const dir = freshRepo();
    expect(gitSnapshot(dir)).toMatchObject({ branch: "main", status: "(clean)" });
    expect(gitSnapshot(dir)?.recentCommits).toContain("fixture");
    writeFileSync(join(dir, "a"), "changed\n");
    expect(gitSnapshot(dir)?.status).toContain(" M a");
    const clone = tempDir("git-status-clone-");
    repos.push(clone);
    run(dir, ["clone", dir, clone]);
    expect(gitSnapshot(clone)?.status).toBe("(clean)");
    expect(gitSnapshot(clone)?.recentCommits).toContain("fixture");
});

test("a failed included or per-worktree config read skips status", () => {
    for (const worktree of [false, true]) {
        const dir = freshRepo();
        expect(gitSnapshot(dir)?.status).toBe("(clean)");
        const file = join(dir, ".git", worktree ? "config.worktree" : "broken-config");
        writeFileSync(file, "[malformed\n");
        if (!worktree) run(dir, ["config", "include.path", file]);
        const snapshot = gitSnapshot(dir);
        expect(snapshot?.status).toBeUndefined();
        expect(snapshot?.statusSkipped).toBe("repository configuration could not be checked");
    }
});

test("log never lazy-fetches a configured mailmap blob through the repository transport", () => {
    const source = freshRepo();
    writeFileSync(join(source, "a"), "Mapped <mapped@example.invalid> Original <original@example.invalid>\n");
    run(source, ["-c", "commit.gpgsign=false", "commit", "-am", "mailmap blob"]);
    const blob = run(source, ["rev-parse", "HEAD:a"]);
    const dir = freshRepo();
    const { script, marker } = markerScript(dir, 'exec git-upload-pack "$@"');
    run(dir, ["config", "remote.origin.url", `file://${source}`]);
    run(dir, ["config", "remote.origin.promisor", "true"]);
    run(dir, ["config", "remote.origin.uploadpack", script]);
    run(dir, ["config", "mailmap.blob", blob]);
    run(dir, ["config", "log.mailmap", "true"]);
    run(dir, ["log", "--oneline"]);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    // The fixture's own objects are loose; only the fetched mailmap was packed.
    for (const name of readdirSync(join(dir, ".git", "objects", "pack"))) rmSync(join(dir, ".git", "objects", "pack", name));
    expect(gitSnapshot(dir)?.status).toBe("(clean)");
    expect(gitSnapshot(dir)?.recentCommits).toContain("fixture");
    expect(existsSync(marker)).toBe(false);
    trustFolder(dir);
    expect(gitSnapshot(dir)?.status).toBe("(clean)");
    expect(gitSnapshot(dir)?.recentCommits).toContain("fixture");
    expect(existsSync(marker)).toBe(false);
});

test("user-global execution settings do not suppress status in an ordinary repository", () => {
    const dir = freshRepo();
    const global = join(dir, ".git", "global-config");
    run(dir, ["config", "--file", global, "core.fsmonitor", "false"]);
    const included = join(dir, ".git", "empty-config");
    writeFileSync(included, "");
    run(dir, ["config", "includeIf.onbranch:main.path", included]);
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = global;
    try {
        expect(gitSnapshot(dir)?.status).toBe("(clean)");
    } finally {
        if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = before;
    }
});


test("a timed-out per-worktree config read skips status", () => {
    const dir = freshRepo();
    const fifo = Bun.spawnSync(["mkfifo", join(dir, ".git", "config.worktree")], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
    expect(fifo.exitCode).toBe(0);
    expect(gitSnapshot(dir)?.statusSkipped).toBe("repository configuration could not be checked");
}, 10_000);
