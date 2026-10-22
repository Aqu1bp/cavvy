import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
// The audit now intentionally includes system/global/environment config. Keep
// host settings out of fixtures, then supply each scope explicitly below.
const inheritedGitConfig = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_CONFIG")));
for (const key of Object.keys(inheritedGitConfig)) delete process.env[key];
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
const { gitAsync, gitBranch, gitListFiles, gitSnapshot } = await import("../src/util/git");
const { sessionContextBlock } = await import("../src/agent/system-prompt");
const { trustFolder, trustForSession } = await import("../src/config/trust");
const { Engine } = await import("../src/server/engine");
const repo = tempDir("hostile-git-");
const plain = tempDir("not-git-");
afterAll(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_CONFIG")) delete process.env[key];
    Object.assign(process.env, inheritedGitConfig);
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
    expect(await gitSnapshot(repo)).toMatchObject({ branch: "main", statusSkipped: "repository filter configuration requires user trust" });
    expect((await gitSnapshot(repo))?.status).toBeUndefined();
    expect((await gitSnapshot(repo))?.recentCommits).toContain("fixture");
    const engine = new Engine({ listModels: async () => [] });
    try {
        expect(engine.inspectProject(repo).branch).toBe("main");
        untouched();
        const runtime = await engine.createSession(repo);
        expect(runtime.snapshot().state.branch).toBe("main");
        untouched();
        expect(await sessionContextBlock(repo, true)).toContain("not read: repository filter configuration requires user trust");
        untouched();
    } finally {
        await engine.stop();
    }
    trustFolder(repo);
    const snapshot = (await gitSnapshot(repo))!;
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
    expect((await gitSnapshot(repo))?.branch).toBeUndefined();
    expect(gitBranch(plain)).toBeUndefined();
    expect(await gitSnapshot(plain)).toBeUndefined();
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
    test(`untrusted status skips ${kind} configuration after proving plain status executes it`, async () => {
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
        const snapshot = (await gitSnapshot(dir))!;
        expect(snapshot.status).toBeUndefined();
        expect(snapshot.statusSkipped).toBe(`repository ${section} configuration requires user trust`);
        expect(snapshot.recentCommits).toContain("fixture");
        expect(existsSync(marker)).toBe(false);
        const prompt = await sessionContextBlock(dir);
        expect(prompt).toContain(`Git status was not read: repository ${section} configuration requires user trust.`);
        expect(prompt).not.toContain(script);
    });
}

test("submodule configuration skips status before entering a hostile real submodule", async () => {
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
    expect((await gitSnapshot(dir))?.statusSkipped).toBe("repository submodule configuration requires user trust");
    expect(existsSync(marker)).toBe(false);
    // Even without a local submodule key, --ignore-submodules=all prevents recursion.
    run(dir, ["config", "--remove-section", "submodule.nested"]);
    expect((await gitSnapshot(dir))?.status).toBe("(clean)");
    expect(existsSync(marker)).toBe(false);
});

test("ordinary init and clone repositories keep status and commits before user trust", async () => {
    const dir = freshRepo();
    expect(await gitSnapshot(dir)).toMatchObject({ branch: "main", status: "(clean)" });
    expect((await gitSnapshot(dir))?.recentCommits).toContain("fixture");
    writeFileSync(join(dir, "a"), "changed\n");
    expect((await gitSnapshot(dir))?.status).toContain(" M a");
    const clone = tempDir("git-status-clone-");
    repos.push(clone);
    run(dir, ["clone", dir, clone]);
    expect((await gitSnapshot(clone))?.status).toBe("(clean)");
    expect((await gitSnapshot(clone))?.recentCommits).toContain("fixture");
});

test("a failed included or per-worktree config read skips status", async () => {
    for (const worktree of [false, true]) {
        const dir = freshRepo();
        expect((await gitSnapshot(dir))?.status).toBe("(clean)");
        const file = join(dir, ".git", worktree ? "config.worktree" : "broken-config");
        writeFileSync(file, "[malformed\n");
        if (!worktree) run(dir, ["config", "include.path", file]);
        const snapshot = await gitSnapshot(dir);
        expect(snapshot?.status).toBeUndefined();
        expect(snapshot?.statusSkipped).toBe("repository configuration could not be checked");
    }
});

for (const legacy of [false, true]) test(`log never lazy-fetches a configured mailmap blob through the repository transport (older git: ${legacy})`, async () => {
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
    const before = process.env.PATH;
    const calls = join(dir, ".git", "protocols");
    if (legacy) {
        const bin = join(dir, ".git", "bin");
        mkdirSync(bin);
        // Model pre-2.45 git by ignoring its unsupported environment variable.
        const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
        writeFileSync(join(bin, "git"), `#!/bin/sh\nunset GIT_NO_LAZY_FETCH\nprintf '%s\\n' "$GIT_ALLOW_PROTOCOL" >> ${quote(calls)}\nexec ${quote(Bun.which("git")!)} "$@"\n`, { mode: 0o700 });
        process.env.PATH = `${bin}:${before}`;
    }
    try {
        const snapshot = await gitSnapshot(dir);
        expect(existsSync(marker)).toBe(false);
        expect(snapshot?.status).toBe("(clean)");
        expect(snapshot?.recentCommits).toContain("fixture");
        expect(gitBranch(dir)).toBe("main");
        expect(gitListFiles(dir)).toContain("a");
        trustFolder(dir);
        expect((await gitSnapshot(dir))?.status).toBe("(clean)");
        expect((await gitSnapshot(dir))?.recentCommits).toContain("fixture");
        expect(existsSync(marker)).toBe(false);
        if (legacy) {
            const protocols = readFileSync(calls, "utf8").trimEnd().split("\n");
            expect(protocols.length).toBeGreaterThan(5);
            expect(protocols.every((protocol) => protocol === "harness-none")).toBe(true);
        }
    } finally {
        if (before === undefined) delete process.env.PATH;
        else process.env.PATH = before;
    }
});

for (const scope of ["global", "system", "global-include", "global-includeIf", "env-count", "env-parameters", "env-file"]) test(`${scope} clean filters activated by repository attributes never run before trust`, async () => {
    const dir = freshRepo();
    const { marker } = markerScript(dir);
    const global = join(dir, ".git", "global-config");
    run(dir, ["config", "--file", global, "filter.x.clean", "./.git/marker.sh"]);
    let configEnv: Record<string, string> = { GIT_CONFIG_GLOBAL: global };
    if (scope === "system") configEnv = { GIT_CONFIG_NOSYSTEM: "0", GIT_CONFIG_SYSTEM: global };
    if (scope === "env-count") configEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "filter.x.clean", GIT_CONFIG_VALUE_0: "./.git/marker.sh" };
    if (scope === "env-parameters") configEnv = { GIT_CONFIG_PARAMETERS: "'filter.x.clean=./.git/marker.sh'" };
    if (scope === "env-file") {
        const benign = join(dir, ".git", "benign-config");
        run(dir, ["config", "--file", benign, "user.name", "Test"]);
        configEnv.GIT_CONFIG = benign;
    }
    if (scope === "global-include" || scope === "global-includeIf") {
        const outer = join(dir, ".git", "global-outer");
        run(dir, ["config", "--file", outer, scope === "global-include" ? "include.path" : "includeIf.onbranch:main.path", global]);
        configEnv = { GIT_CONFIG_GLOBAL: outer };
    }
    staleFile(dir);
    run(dir, ["status", "--short"], configEnv);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    staleFile(dir);
    const before = Object.fromEntries(Object.keys(configEnv).map((key) => [key, process.env[key]]));
    Object.assign(process.env, configEnv);
    try {
        const snapshot = await gitSnapshot(dir);
        expect(existsSync(marker)).toBe(false);
        expect(snapshot?.branch).toBe("main");
        expect(snapshot?.status).toBeUndefined();
        expect(snapshot?.statusSkipped).toBe("repository filter configuration requires user trust");
    } finally {
        for (const [key, value] of Object.entries(before)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

for (const key of ["include.path", "includeIf.onbranch:other.path", "diff.external", "diff.x.command", "diff.x.textconv", "core.hooksPath"]) test(`global ${key} with an absolute path keeps status`, async () => {
    const dir = freshRepo();
    const global = join(dir, ".git", "global-config");
    const empty = join(dir, ".git", "empty-config");
    writeFileSync(empty, "");
    run(dir, ["config", "--file", global, key, empty]);
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = global;
    try {
        const snapshot = await gitSnapshot(dir);
        expect(snapshot?.branch).toBe("main");
        expect(snapshot?.status).toBe("(clean)");
        expect(snapshot?.statusSkipped).toBeUndefined();
    } finally {
        if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = before;
    }
});

test("disabled user-global fsmonitor and user-owned includes keep status", async () => {
    const dir = freshRepo();
    const global = join(dir, ".git", "global-config");
    run(dir, ["config", "--file", global, "core.fsmonitor", "false"]);
    const included = join(dir, ".git", "empty-config");
    writeFileSync(included, "");
    run(dir, ["config", "--file", global, "includeIf.onbranch:main.path", included]);
    const before = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = global;
    try {
        expect((await gitSnapshot(dir))?.status).toBe("(clean)");
        expect((await gitSnapshot(dir))?.statusSkipped).toBeUndefined();
    } finally {
        if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = before;
    }
});

test("a global LFS-style filter runs status through an installed program", async () => {
    const dir = freshRepo();
    const bin = tempDir("git-lfs-bin-");
    repos.push(bin);
    const marker = join(bin, "executed");
    writeFileSync(join(bin, "git-lfs"), `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o700 });
    const global = join(dir, ".git", "global-config");
    run(dir, ["config", "--file", global, "filter.lfs.clean", "git-lfs clean -- %f"]);
    writeFileSync(join(dir, ".gitattributes"), "a filter=lfs\n");
    staleFile(dir);
    const beforeGlobal = process.env.GIT_CONFIG_GLOBAL;
    const beforePath = process.env.PATH;
    process.env.GIT_CONFIG_GLOBAL = global;
    process.env.PATH = `${bin}:${beforePath}`;
    try {
        const snapshot = await gitSnapshot(dir);
        expect(snapshot?.status).toContain(" M .gitattributes");
        expect(snapshot?.statusSkipped).toBeUndefined();
        expect(existsSync(marker)).toBe(true);
    } finally {
        if (beforeGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = beforeGlobal;
        if (beforePath === undefined) delete process.env.PATH;
        else process.env.PATH = beforePath;
    }
});

test("a relative PATH entry can't make a bare driver name run the repo's own program", async () => {
    const dir = freshRepo();
    const marker = join(dir, ".git", "repo-lfs-ran");
    // The repo ships its own git-lfs; with "." first in PATH it would win over an installed one.
    writeFileSync(join(dir, "git-lfs"), `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o700 });
    const global = join(dir, ".git", "global-config");
    run(dir, ["config", "--file", global, "filter.lfs.clean", "git-lfs clean -- %f"]);
    writeFileSync(join(dir, ".gitattributes"), "a filter=lfs\n");
    staleFile(dir);
    const beforeGlobal = process.env.GIT_CONFIG_GLOBAL;
    const beforePath = process.env.PATH;
    process.env.GIT_CONFIG_GLOBAL = global;
    process.env.PATH = `.:${beforePath}`;
    try {
        await gitSnapshot(dir);
        gitListFiles(dir);
        expect(existsSync(marker)).toBe(false);
    } finally {
        if (beforeGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = beforeGlobal;
        if (beforePath === undefined) delete process.env.PATH;
        else process.env.PATH = beforePath;
    }
});

for (const key of ["credential.helper", "gpg.program", "gpg.ssh.program", "core.sshCommand", "core.askPass"]) test(`local ${key} does not suppress status or execute`, async () => {
    const dir = freshRepo();
    const { script, marker } = markerScript(dir);
    run(dir, ["config", key, script]);
    writeFileSync(join(dir, "a"), "changed\n");
    const snapshot = await gitSnapshot(dir);
    expect(snapshot?.status).toContain(" M a");
    expect(snapshot?.statusSkipped).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
});


test("the snapshot's git calls run side by side, and the server goes on while they run", async () => {
    const dir = freshRepo();
    // The folder's root is known (and cached) before git gets slow.
    expect((await gitSnapshot(dir))?.status).toBe("(clean)");
    const calls = join(dir, ".git", "calls");
    const bin = join(dir, ".git", "slow-bin");
    mkdirSync(bin);
    // Each call takes a while, so calls made one after another never overlap.
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho start >> ${quote(calls)}\nsleep 0.3\necho end >> ${quote(calls)}\nexec ${quote(Bun.which("git")!)} "$@"\n`, { mode: 0o700 });
    const before = process.env.PATH;
    process.env.PATH = `${bin}:${before}`;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
        const snapshot = await gitSnapshot(dir);
        expect(snapshot).toMatchObject({ branch: "main", status: "(clean)" });
        expect(snapshot?.recentCommits).toContain("fixture");
    } finally {
        clearInterval(timer);
        if (before === undefined) delete process.env.PATH;
        else process.env.PATH = before;
    }
    let running = 0;
    let most = 0;
    for (const line of readFileSync(calls, "utf8").trim().split("\n")) {
        running += line === "start" ? 1 : -1;
        most = Math.max(most, running);
    }
    expect(most).toBeGreaterThan(1);
    // Timers ran while git did: the event loop wasn't held.
    expect(ticks).toBeGreaterThan(10);
}, 15_000);

for (const exits of [true, false]) test(`the async git call's timeout holds when something it started keeps its output open (git ${exits ? "exits" : "hangs"})`, async () => {
    const dir = freshRepo();
    const bin = join(dir, ".git", "holding-bin");
    mkdirSync(bin);
    const pids = join(dir, ".git", "pids");
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    // A descendant that inherits stdout and outlives the timeout by far; git itself exits at once, or waits for it.
    writeFileSync(join(bin, "git"), `#!/bin/sh\nsleep 60 &\necho $! >> ${quote(pids)}\necho partial\n${exits ? "exit 0" : "wait"}\n`, { mode: 0o700 });
    const before = process.env.PATH;
    process.env.PATH = `${bin}:${before}`;
    const started = performance.now();
    let result: string | undefined = "unset";
    try {
        // The default timeout (3 s): long enough for the wrapper to have started its descendant, however busy the machine.
        result = await gitAsync(dir, ["log"]);
    } finally {
        if (before === undefined) delete process.env.PATH;
        else process.env.PATH = before;
    }
    const took = performance.now() - started;
    expect(existsSync(pids)).toBe(true);
    const pid = Number(readFileSync(pids, "utf8").trim());
    // Killed, it may take a moment to be reaped; a zombie is gone too.
    const running = () => /^[^Z]/.test(Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim());
    let alive = running();
    for (let i = 0; alive && i < 60; i++) {
        await Bun.sleep(50);
        alive = running();
    }
    if (alive) process.kill(pid, "SIGKILL");
    // As spawnSync did: nothing, at the timeout (not when the descendant lets go, a minute later).
    expect(result).toBeUndefined();
    expect(took).toBeLessThan(6000);
    // What it started went with it.
    expect(alive).toBe(false);
}, 20_000);

test("a timed-out per-worktree config read skips status", async () => {
    const dir = freshRepo();
    const fifo = Bun.spawnSync(["mkfifo", join(dir, ".git", "config.worktree")], { stdout: "pipe", stderr: "pipe", timeout: 3000 });
    expect(fifo.exitCode).toBe(0);
    expect((await gitSnapshot(dir))?.statusSkipped).toBe("repository configuration could not be checked");
}, 10_000);
