// The auto-mode shell sandbox: the policy and profile it generates, the
// command heuristics around it, and (on macOS) what a sandboxed command can
// and can't actually do.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const { home: HARNESS_HOME, cleanup } = isolate();
const { sandboxPolicy, seatbeltProfile, bwrapArgs, sandboxArgv, needsHostAccess, accessNeeded, looksDestructive, blockedBySandbox, sandboxKind, SANDBOX_HINT, WORKTREE_HINT } = await import("../src/permissions/sandbox");
const { pushesDefaultBranch } = await import("../src/permissions/bash-safety");
const { BashTool, BashOutputTool, KillShellTool, killAllShells } = await import("../src/tools/bash");
import type { Sandbox } from "../src/permissions/sandbox";

afterAll(cleanup);

const real = (p: string) => realpathSync(p);

describe("sandboxPolicy", () => {
    test("writable: the workspace roots and the temp dirs; protected: harness config and home; unreadable: credentials", () => {
        const ws = real(tempDir());
        const home = real(tempDir());
        const p = sandboxPolicy([ws], { harnessHome: HARNESS_HOME, home });
        expect(p.writable).toContain(ws);
        expect(p.writable).toContain(real(tmpdir()));
        expect(p.writable).toContain(process.platform === "darwin" ? "/private/tmp" : "/tmp");
        expect(p.readOnly).toEqual([join(ws, ".harness"), join(ws, ".mcp.json"), real(HARNESS_HOME), real(process.env.CLAUDE_CONFIG_DIR!), real(process.env.CODEX_HOME!)]);
        for (const c of [".ssh", ".aws", ".gnupg", ".config/gcloud", ".netrc", ".npmrc", ".git-credentials", "Library/Keychains"]) expect(p.unreadable).toContain(join(home, c));
        expect(p.unreadable).toContain(real(HARNESS_HOME));
        // Covered before a repo exists, so `git init` can't plant hooks either.
        expect(p.gitDirs).toEqual([join(ws, ".git")]);
    });

    test("a worktree's own git dir and the shared one are writable and protected", () => {
        const main = real(tempDir());
        const common = join(main, ".git");
        const own = join(common, "worktrees", "wt");
        mkdirSync(own, { recursive: true });
        writeFileSync(join(own, "commondir"), "../..\n");
        const wt = real(tempDir());
        writeFileSync(join(wt, ".git"), `gitdir: ${own}\n`);
        const p = sandboxPolicy([wt], { harnessHome: HARNESS_HOME });
        expect(p.writable).toContain(own);
        expect(p.writable).toContain(common);
        expect(p.gitDirs).toEqual([join(wt, ".git"), own, common]);
    });

    test("a worktree's git dirs are resolved once: a repointed .git file doesn't widen later policies", () => {
        const main = real(tempDir());
        const own = join(main, ".git", "worktrees", "wt");
        mkdirSync(own, { recursive: true });
        const wt = real(tempDir());
        writeFileSync(join(wt, ".git"), `gitdir: ${own}\n`);
        const first = sandboxPolicy([wt], { harnessHome: HARNESS_HOME });
        const elsewhere = real(tempDir());
        writeFileSync(join(wt, ".git"), `gitdir: ${elsewhere}\n`);
        const second = sandboxPolicy([wt], { harnessHome: HARNESS_HOME });
        expect(second.writable).toEqual(first.writable);
        expect(second.writable).not.toContain(elsewhere);
    });

    test("roots given twice or through a symlink appear once, resolved", () => {
        const ws = real(tempDir());
        const link = join(tempDir(), "link");
        require("fs").symlinkSync(ws, link);
        expect(sandboxPolicy([ws, link], { harnessHome: HARNESS_HOME }).writable.filter((w) => w === ws)).toHaveLength(1);
    });
});

describe("seatbeltProfile", () => {
    const policy = { writable: ["/w/proj", "/private/tmp"], readOnly: ["/w/proj/.harness", "/h"], unreadable: ["/home/.ssh", "/h"], gitDirs: ["/w/proj/.git"] };
    const profile = seatbeltProfile(policy);

    test("network: everything denied, then only localhost (no unix-socket allowance)", () => {
        expect(profile).toContain("(deny network*)");
        expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))');
        expect(profile).toContain('(allow network-bind (local ip "localhost:*"))');
        expect(profile).not.toMatch(/unix-socket/);
        expect(profile).not.toMatch(/\(allow network\* /);
    });

    test("writes: denied everywhere, allowed in the writable dirs, then denied again for protected paths", () => {
        const lines = profile.split("\n");
        const denyAll = lines.indexOf('(deny file-write* (subpath "/"))');
        const allow = lines.findIndex((l) => l.startsWith("(allow file-write*"));
        const protect = lines.findIndex((l) => l.startsWith("(deny file-write*") && l.includes("/w/proj/.harness"));
        expect(denyAll).toBeGreaterThan(-1);
        // Later rules win, so the order is what makes the exceptions work.
        expect(allow).toBeGreaterThan(denyAll);
        expect(protect).toBeGreaterThan(allow);
        expect(lines[allow]).toContain('(subpath "/w/proj")');
        for (const p of ["/w/proj/.git/hooks", "/w/proj/.git/config", "/w/proj/.git/config.worktree", "/w/proj/.git/info/attributes", "/w/proj/.git/commondir", "/w/proj/.git/gitdir", "/h"]) {
            expect(lines[protect]).toContain(`(subpath "${p}")`);
        }
        expect(profile).toContain(
            '(deny file-write* (regex #"^/w/proj/\\.git/(modules|worktrees)/.+/(hooks(/|$)|config$|config\\.worktree$|info/attributes$|commondir$|gitdir$)") (regex #"^/w/proj/\\.git/(modules|worktrees(/[^/]+)?)$"))',
        );
        expect(profile).toContain('(deny file-read* (subpath "/home/.ssh") (subpath "/h"))');
    });

    test("the git dirs themselves can't be written: moved away and back, or repointed, they'd dodge the rules", () => {
        const lines = profile.split("\n");
        const allow = lines.findIndex((l) => l.startsWith("(allow file-write*"));
        // The git dir, .git/info, and the writable directories above them (here the workspace root).
        const own = lines.indexOf('(deny file-write* (literal "/w/proj/.git") (literal "/w/proj") (literal "/w/proj/.git/info"))');
        expect(own).toBeGreaterThan(allow);
        expect(seatbeltProfile({ ...policy, gitDirs: [] })).not.toContain("(deny file-write* )");
        // Unreadable paths can't be written or renamed either.
        expect(lines.find((l) => l.includes("/w/proj/.harness"))).toContain('(subpath "/home/.ssh")');
    });

    test("signals stay inside; app launching, launchd jobs and escape services are denied", () => {
        expect(profile).toContain("(deny signal)\n(allow signal (target same-sandbox))");
        expect(profile).toContain("(deny lsopen)");
        expect(profile).toContain("(deny job-creation)");
        for (const s of ["com.apple.coreservices.appleevents", "com.apple.pasteboard.1", "com.apple.SecurityServer", "com.apple.windowserver.active"]) expect(profile).toContain(`(global-name "${s}")`);
        for (const x of ["/usr/bin/osascript", "/usr/bin/open", "/bin/launchctl", "/usr/bin/security", "/usr/bin/crontab"]) expect(profile).toContain(`(literal "${x}")`);
    });

    test("quotes and backslashes in paths can't break out of the profile's strings", () => {
        const p = seatbeltProfile({ writable: ['/w/a"b\\c'], readOnly: [], unreadable: [], gitDirs: ['/w/a"b'] });
        expect(p).toContain('(subpath "/w/a\\"b\\\\c")');
        expect(p).toContain('#"^/w/a\\"b/(modules');
    });
});

test("bwrapArgs binds existing paths: writable read-write, protected read-only, unreadable hidden", () => {
    const ws = real(tempDir());
    mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
    mkdirSync(join(ws, ".git", "modules", "sub", "hooks"), { recursive: true });
    writeFileSync(join(ws, ".git", "modules", "sub", "config"), "");
    const secret = join(ws, "secret-dir");
    mkdirSync(secret);
    writeFileSync(join(ws, "secret-file"), "");
    const wt = real(tempDir());
    writeFileSync(join(wt, ".git"), "gitdir: /elsewhere\n");
    const args = bwrapArgs({ writable: [ws, "/nonexistent-dir"], readOnly: [join(ws, ".mcp.json")], unreadable: [secret, join(ws, "secret-file")], gitDirs: [join(ws, ".git"), join(wt, ".git")] });
    expect(args.slice(0, 8)).toEqual(["--die-with-parent", "--new-session", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--ro-bind", "/", "/"]);
    const pairs = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
    // Git dirs bound onto themselves are mount points: they can't be moved or replaced.
    expect(pairs("--bind")).toEqual([ws, join(ws, ".git"), join(ws, ".git", "modules", "sub")]);
    expect(pairs("--ro-bind")).toContain(join(wt, ".git"));
    expect(pairs("--ro-bind")).toContain(join(ws, ".git", "hooks"));
    expect(pairs("--ro-bind")).toContain(join(ws, ".git", "modules", "sub", "hooks"));
    expect(pairs("--ro-bind")).toContain(join(ws, ".git", "modules", "sub", "config"));
    expect(pairs("--tmpfs")[0]).toBe(secret);
    expect(args.join(" ")).toContain(`--ro-bind /dev/null ${join(ws, "secret-file")}`);
    expect(sandboxArgv({ kind: "bwrap", policy: { writable: [], readOnly: [], unreadable: [], gitDirs: [] } }, "/bin/sh", "echo hi").slice(-4)).toEqual(["--", "/bin/sh", "-c", "echo hi"]);
});

describe("needsHostAccess", () => {
    test.each([
        "npm install lodash", "npm i", "pnpm add zod", "yarn add react", "bun install", "pip install -r requirements.txt", "pip3 install x",
        "python3 -m pip install -e .", "uv sync", "cargo add serde", "go get ./...", "git push", "git fetch origin", "git pull --rebase",
        "git clone https://github.com/a/b", "curl https://example.com", "wget https://example.com/x", "ssh host", "gh pr create",
        "docker build .", "kubectl get pods", "npx prettier --write .", "brew install jq", "kill 4821", "pkill -f jest", "open .", "crontab -l",
        "cd sub && npm ci", "FOO=1 npm install", "git -C . push", "git -c http.proxy=x fetch", "git --git-dir .git pull",
    ])("%p needs the network or the host", (cmd) => {
        expect(needsHostAccess(cmd)).toBeDefined();
    });

    test.each([
        "npm test", "npm run build", "npm run deploy:staging", "bun test", "bun run x.ts", "make", "cargo build", "go test ./...",
        "python3 -m venv .venv", "python3 -m pytest", "git commit -am x", "git status", "git rebase main", "node script.js",
        "curl -s http://localhost:3000/", "curl http://127.0.0.1:8080/api", "sleep 5 & kill %1", "tsc --noEmit",
    ])("%p runs locally", (cmd) => {
        expect(needsHostAccess(cmd)).toBeUndefined();
    });

    test("a local URL next to a remote one still needs the network", () => {
        expect(needsHostAccess("curl http://localhost:3000 https://example.com")).toBe("curl");
    });
});

describe("accessNeeded", () => {
    test.each([
        ["npm install lodash", { network: "npm install" }],
        ["bun add zod", { network: "bun add" }],
        ["uv sync", { network: "uv sync" }],
        ["python3 -m pip install -e .", { network: "python3 -m pip" }],
        ["curl https://example.com", { network: "curl" }],
        ["npx prettier --write .", { network: "npx" }],
        ["git clone https://github.com/a/b", { network: "git clone" }],
        ["git clone git@github.com:a/b.git", { host: "git clone" }],
        ["git clone ssh://git@github.com/a/b https://x", { host: "git clone" }],
        ["git fetch origin", { host: "git fetch" }],
        ["npm publish", { host: "npm publish" }],
        ["bun upgrade", { host: "bun upgrade" }],
        ["uv tool install ruff", { host: "uv tool" }],
        ["cargo add serde", { host: "cargo add" }],
        ["npm install && gh pr create", { network: "npm install", host: "gh" }],
        ["curl --version", {}],
        ["curl http://localhost:3000/", {}],
        // .git/worktrees is read-only in the sandbox.
        ["git worktree add -b x .claude/worktrees/x", { host: "git worktree add" }],
        ["git -C repo worktree remove wt", { host: "git worktree remove" }],
        ["git worktree prune", { host: "git worktree prune" }],
        ["git worktree list", {}],
        ["git worktree lock wt", {}],
        ["npm test", {}],
    ])("%p", (cmd, want) => {
        expect(accessNeeded(cmd)).toEqual(want);
    });

    test("npx and bunx of a tool the project has installed need nothing; a version, a scope or pnpx do", () => {
        const ws = real(tempDir());
        mkdirSync(join(ws, "node_modules", ".bin"), { recursive: true });
        mkdirSync(join(ws, "packages", "app"), { recursive: true });
        writeFileSync(join(ws, "node_modules", ".bin", "jest"), "");
        for (const cmd of ["npx jest --runInBand", "bunx jest", "npx --no-install jest", "cd packages/app && npx jest"]) expect(accessNeeded(cmd, ws)).toEqual({});
        expect(accessNeeded("npx jest", join(ws, "packages", "app"))).toEqual({});
        for (const cmd of ["npx jest@29", "npx @jest/core", "pnpx jest", "npx prettier", "cd $PKG && npx jest"]) expect(accessNeeded(cmd, ws).network).toBeDefined();
        // Without a directory to look in, it's assumed to download.
        expect(accessNeeded("npx jest").network).toBe("npx");
    });
});

describe("Bash allowedHosts validation", () => {
    const v = (allowedHosts: unknown) => BashTool.validate!({ command: "true", allowedHosts } as any, {} as any);
    test("host names, wildcards and ports pass", () => {
        expect(v(["registry.npmjs.org", "*.example.com", "example.com:8443", "10.0.0.5", "[::1]:5432"])).toBeUndefined();
        expect(v(undefined)).toBeUndefined();
    });
    test("URLs, bare wildcards and non-strings don't", () => {
        expect(v(["https://registry.npmjs.org"])).toContain('"https://registry.npmjs.org" isn\'t a host');
        expect(v(["*", "*.com"])).toContain("aren't hosts");
        expect(v([42])).toContain("42");
        expect(v("registry.npmjs.org")).toBe("allowedHosts must be an array of host names");
        expect(v(Array.from({ length: 31 }, (_, i) => `h${i}.example.com`))).toContain("at most 30");
    });
});

describe("looksDestructive", () => {
    test.each([
        "rm build.log", "rm -rf dist", "cd x && rm -f y", "ls | xargs rm", "find . -name '*.o' -delete", "find . -exec rm {} \\;",
        "bash -c 'rm -rf src'", "unlink f", "truncate -s 0 f", "shred f", "git rm f", "git clean -fd", "git checkout -- src",
        "git checkout .", "git checkout -f main", "git switch --discard-changes main", "git restore src/a.ts", "git restore --staged --worktree a",
        "git reset --hard", "git stash drop", "git stash clear", "git branch -D old", "git branch -df old", "git reflog expire --all",
        "git gc --prune=now", "git worktree remove x", "git update-ref -d refs/heads/x", "git filter-branch --tree-filter x",
        "python3 -c 'import shutil; shutil.rmtree(\"x\")'", "node -e \"require('fs').rmSync('x',{recursive:true})\"", "python -c 'import os; os.remove(\"x\")'",
        "/bin/rm src/index.ts", "ls | xargs /bin/rm", "git -C . restore src/a.ts", "git -c core.x=1 clean -fd", "git --work-tree=. checkout -- a",
        "git checkout main src/a.ts", "git checkout '*.ts'", "git checkout --theirs a.ts", "git checkout -b fresh --force", "git checkout -fb fresh",
    ])("%p deletes or discards", (cmd) => {
        expect(looksDestructive(cmd)).toBeDefined();
    });

    test.each([
        "npm test", "git commit -am x", "git checkout -b feat", "git checkout main", "git switch main", "git restore --staged a",
        "git reset --soft HEAD~1", "git reset HEAD~1", "git stash", "git stash pop", "git branch -d merged", "docker run --rm alpine true",
        "echo hello", "mkdir -p out", "mv a b", "git commit -m 'remove the old flag'", "git checkout -b feat origin/main", "git -C sub checkout main",
    ])("%p doesn't", (cmd) => {
        expect(looksDestructive(cmd)).toBeUndefined();
    });

    test("with cwd, git checkout of a name that's a file there discards it; of a branch it doesn't", () => {
        const ws = real(tempDir());
        mkdirSync(join(ws, "sub", "src"), { recursive: true });
        writeFileSync(join(ws, "sub", "src", "a.ts"), "");
        expect(looksDestructive("git checkout sub/src/a.ts", ws)).toBeDefined();
        expect(looksDestructive("git -C sub checkout src/a.ts", ws)).toBeDefined();
        expect(looksDestructive("git checkout sub", ws)).toBeDefined();
        expect(looksDestructive("git checkout feature/login", ws)).toBeUndefined();
        // Following cd, and assuming the worst after one it can't follow.
        expect(looksDestructive("cd sub/src && git checkout a.ts", ws)).toBeDefined();
        expect(looksDestructive("cd sub && git -C src checkout a.ts", ws)).toBeDefined();
        expect(looksDestructive("cd sub && git checkout feature/login", ws)).toBeUndefined();
        expect(looksDestructive('cd "$DIR" && git checkout main', ws)).toBeDefined();
    });
});

describe("pushesDefaultBranch", () => {
    test.each([
        ["git push origin main", "git push to main"],
        ["git push origin HEAD:main", "git push to main"],
        ["git push origin feature:refs/heads/master", "git push to master"],
        ["git push -u origin +HEAD:trunk", "git push to trunk"],
        ["git -C sub push origin main", "git push to main"],
        ["git push --all origin", "git push --all"],
        ["git push --mirror", "git push --mirror"],
        ["cd x && git push origin main", "git push to main"],
        ["git --git-dir .git push origin main", "git push to main"],
    ])("%p", (cmd, why) => {
        expect(pushesDefaultBranch(cmd)).toBe(why);
    });

    test.each(["git push", "git push -u origin dark-mode", "git push origin main-fix", "git push origin HEAD:feature/main", "git push -o ci.skip origin feat", "git push origin -o main feat", "git pull origin main", "git push --repo main origin feat"])(
        "%p doesn't",
        (cmd) => {
            expect(pushesDefaultBranch(cmd)).toBeUndefined();
        },
    );

    test("follows cd to the repo whose branch it checks", () => {
        const parent = real(tempDir());
        mkdirSync(join(parent, "repo", ".git"), { recursive: true });
        writeFileSync(join(parent, "repo", ".git", "HEAD"), "ref: refs/heads/main\n");
        expect(pushesDefaultBranch("cd repo && git push", parent)).toBe("git push from main");
        expect(pushesDefaultBranch("git push", parent)).toBeUndefined();
    });

    test("a redirection after the push doesn't read as a remote or branch", () => {
        const repo = real(tempDir());
        mkdirSync(join(repo, ".git"));
        writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
        for (const cmd of ["git push 2>&1", "git push origin 2>/dev/null", "git push >/dev/null 2>&1 | tail -1"]) expect(pushesDefaultBranch(cmd, repo)).toBe("git push from main");
        expect(pushesDefaultBranch("git push origin feat 2>&1", repo)).toBeUndefined();
    });

    test("a HEAD that isn't a regular file (a FIFO would block) is ignored, not read", () => {
        const repo = real(tempDir());
        mkdirSync(join(repo, ".git"));
        Bun.spawnSync(["mkfifo", join(repo, ".git", "HEAD")]);
        const t0 = Date.now();
        expect(pushesDefaultBranch("git push", repo)).toBeUndefined();
        expect(Date.now() - t0).toBeLessThan(1000);
    });
});

test.each([
    "curl: (6) Could not resolve host: example.com",
    "curl: (7) Failed to connect to 1.1.1.1 port 80 after 0 ms: Couldn't connect to server",
    "urllib.error.URLError: <urlopen error [Errno 8] nodename nor servname provided, or not known>",
    "TypeError: fetch failed Error: getaddrinfo ENOTFOUND example.com",
    "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com",
    "zsh:1: operation not permitted: ../outside.txt",
    "touch: .git/hooks/x: Operation not permitted",
])("blockedBySandbox recognizes %p", (out) => {
    expect(blockedBySandbox(out)).toBe(true);
});

test("blockedBySandbox ignores ordinary failures", () => {
    expect(blockedBySandbox("FAIL src/a.test.ts\n  expected 2, received 3")).toBe(false);
});

// ---------------------------------------------------------------------------
// The real thing (macOS: Seatbelt is always there).

const seatbelt = process.platform === "darwin" && sandboxKind() === "seatbelt";

describe.skipIf(!seatbelt)("a sandboxed Bash command (Seatbelt)", () => {
    const ws = real(tempDir());
    mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
    writeFileSync(join(HARNESS_HOME, "credentials.json"), "{}");
    const sandbox: Sandbox = { kind: "seatbelt", policy: sandboxPolicy([ws], { harnessHome: HARNESS_HOME }) };
    const state = { cwd: ws, projectRoot: ws, fileState: new Map(), todos: [], shells: new Map() } as any;
    /** null: run without the sandbox. */
    const ctx = (sb: Sandbox | null = sandbox) => ({ state, settings: {}, signal: new AbortController().signal, mode: () => "auto", setMode() {}, ui: {}, sandbox: sb ?? undefined }) as any;
    const bash = (command: string, sb: Sandbox | null = sandbox) => BashTool.run({ command }, ctx(sb));

    afterAll(() => killAllShells({ state }));

    test("works in the workspace and temp dirs", async () => {
        const r = await bash(`echo hi > out.txt && mkdir -p d && mv out.txt d/ && cat d/out.txt && echo t > "${join(tmpdir(), `sbx-test-${process.pid}`)}" && echo done`);
        expect(r.isError).toBeFalsy();
        expect(r.content).toBe("hi\ndone");
    });

    test("can't plant git hooks or touch the harness home, and says how to retry", async () => {
        const hook = await bash("echo 'echo pwned' > .git/hooks/pre-commit");
        expect(hook.isError).toBe(true);
        expect(existsSync(join(ws, ".git", "hooks", "pre-commit"))).toBe(false);
        expect(hook.content).toContain(SANDBOX_HINT);
        const cfg = await bash(`echo x > "${join(HARNESS_HOME, "settings.json")}"`);
        expect(cfg.isError).toBe(true);
        expect(existsSync(join(HARNESS_HOME, "settings.json"))).toBe(false);
        const read = await bash(`cat "${join(HARNESS_HOME, "credentials.json")}"`);
        expect(read.isError).toBe(true);
    });

    test("git worktree add fails inside, and the hint says why, how to finish, and about the branch it left", async () => {
        const repo = real(tempDir());
        const git = (args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo });
        git(["init", "-q", "-b", "main"]);
        git(["commit", "-q", "--allow-empty", "-m", "init"]);
        const sb: Sandbox = { kind: "seatbelt", policy: sandboxPolicy([repo], { harnessHome: HARNESS_HOME }) };
        const r = await BashTool.run({ command: "git worktree add -b feature-x .claude/worktrees/feature-x" }, { ...ctx(sb), state: { ...state, cwd: repo, projectRoot: repo } });
        expect(r.isError).toBe(true);
        expect(r.content).toContain(".git/worktrees");
        expect(r.content).toContain(WORKTREE_HINT);
        // The branch git made before failing.
        expect(git(["branch", "--list", "feature-x"]).stdout.toString()).toContain("feature-x");
        // Other blocked writes don't get the worktree advice.
        const hook = await bash("echo x > .git/hooks/post-commit");
        expect(hook.content).not.toContain(WORKTREE_HINT);
    });

    test("unsandboxed, the same read works (so the sandbox is what stopped it)", async () => {
        const plain = await bash(`cat "${join(HARNESS_HOME, "credentials.json")}"`, null);
        expect(plain.content).toBe("{}");
    });

    test("reaches a localhost server but not the internet or unix sockets", async () => {
        const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("local ok") });
        const sock = join(real(tempDir()), "s.sock");
        const unix = Bun.listen({ unix: sock, socket: { data() {}, open(s) { s.write("hi"); s.end(); } } });
        try {
            const local = await bash(`curl -s http://127.0.0.1:${server.port}/`);
            expect(local.content).toBe("local ok");
            // Through the proxy, an unlisted host is refused and named.
            const remote = await bash("curl -fsS -m 5 -o /dev/null http://1.1.1.1/");
            expect(remote.isError).toBe(true);
            expect(remote.content).toContain('The sandbox refused connections to 1.1.1.1:80. If the command needs them, run it again with allowedHosts: ["1.1.1.1"]');
            // Around it, nothing gets out.
            const direct = await bash("curl --noproxy '*' -sS -m 5 -o /dev/null http://1.1.1.1/");
            expect(direct.isError).toBe(true);
            expect(direct.content).toContain(SANDBOX_HINT);
            const viaSocket = await bash(`/usr/bin/nc -U "${sock}" < /dev/null`);
            expect(viaSocket.content).not.toContain("hi");
        } finally {
            server.stop(true);
            unix.stop(true);
        }
    });

    test("reaches the hosts it lists, through its own proxy", async () => {
        // A local server stands in for a remote host: listed as an IP, the proxy connects to it.
        const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => new Response(`via proxy ${new URL(r.url).pathname} ${r.headers.get("proxy-authorization") ?? "no-auth"}`) });
        try {
            const viaProxy = `NO_PROXY= no_proxy= curl -fsS -m 5 http://127.0.0.1:${server.port}/x`;
            const open = await BashTool.run({ command: viaProxy, allowedHosts: ["127.0.0.1"] }, ctx());
            // The proxy's credentials don't reach the server.
            expect(open.content).toBe("via proxy /x no-auth");
            const shut = await bash(viaProxy);
            expect(shut.isError).toBe(true);
            expect(shut.content).toContain(`run it again with allowedHosts: ["127.0.0.1:${server.port}"]`);
            // Unsandboxed, allowedHosts changes nothing.
            const plain = await BashTool.run({ command: "echo ${HTTPS_PROXY:-none}", allowedHosts: ["127.0.0.1"] }, ctx(null));
            expect(plain.content).toBe("none");
        } finally {
            server.stop(true);
        }
    });

    test("package caches it can write", async () => {
        const r = await bash('for d in "$npm_config_cache" "$BUN_INSTALL_CACHE_DIR" "$UV_CACHE_DIR"; do mkdir -p "$d" && touch "$d/.w" && echo ok; done');
        expect(r.content).toBe("ok\nok\nok");
        expect((await bash("echo $npm_config_cache", null)).content).not.toContain("harness-sandbox-cache");
    });

    test("another sandboxed command can't read a running command's proxy password", async () => {
        const started = await BashTool.run({ command: 'echo "$HTTPS_PROXY" > proxy-url.txt; sleep 5', run_in_background: true, allowedHosts: ["example.com"] }, ctx());
        const id = started.content.match(/bash_\d+/)![0];
        const pid = started.content.match(/pid (\d+)/)![1];
        try {
            await Bun.sleep(300);
            const password = new URL(require("fs").readFileSync(join(ws, "proxy-url.txt"), "utf8").trim()).password;
            expect(password.length).toBeGreaterThan(20);
            // What ps reads (KERN_PROCARGS2: a process's arguments and environment); ps itself, being setuid, can't run in there.
            const procargs = (target: string) => `/usr/bin/python3 -I -c 'import ctypes,os,sys; l=ctypes.CDLL(None); m=(ctypes.c_int*3)(1,49,${target}); n=ctypes.c_size_t(1<<20); b=ctypes.create_string_buffer(n.value); l.sysctl(m,3,b,ctypes.byref(n),None,0); sys.stdout.write(b.raw[:n.value].decode("latin1").replace(chr(0), chr(10)))'`;
            const peek = await bash(`${procargs(pid!)}; ps eww -p ${pid}`);
            expect(peek.content).toContain("sleep");
            expect(peek.content).not.toContain(password);
            // The same look at itself does show its own, so the check above could have seen one.
            const self = await BashTool.run({ command: `${procargs("os.getpid()")} | grep "^HTTPS_PROXY="`, allowedHosts: ["example.com"] }, ctx());
            expect(self.content).toMatch(/^HTTPS_PROXY=http:\/\/harness:[\w-]{20,}@127\.0\.0\.1:\d+$/);
        } finally {
            await KillShellTool.run({ shell_id: id }, ctx());
        }
    });

    test("Corepack gets a home it can write only when the command can download", async () => {
        const plain = await bash('echo "${COREPACK_HOME:-default}"');
        expect(plain.content).toBe("default");
        const net = await BashTool.run({ command: 'mkdir -p "$COREPACK_HOME" && touch "$COREPACK_HOME/.w" && echo "$COREPACK_HOME"', allowedHosts: ["registry.npmjs.org"] }, ctx());
        expect(net.content).toContain("harness-sandbox-cache");
    });

    test("a background shell's proxy closes when it exits", async () => {
        const started = await BashTool.run({ command: 'echo "$HTTPS_PROXY"', run_in_background: true, allowedHosts: ["example.com"] }, ctx());
        const id = started.content.match(/bash_\d+/)![0];
        await Bun.sleep(300);
        const out = await BashOutputTool.run({ bash_id: id }, ctx());
        const port = Number(out.content.match(/@127\.0\.0\.1:(\d+)/)![1]);
        const connect = () => new Promise<boolean>((resolve) => {
            const s = require("net").connect(port, "127.0.0.1");
            s.once("connect", () => (s.destroy(), resolve(true)));
            s.once("error", () => resolve(false));
        });
        expect(await connect()).toBe(false);
    });

    test("can't signal processes it didn't start, can its own", async () => {
        const victim = Bun.spawn(["sleep", "30"]);
        try {
            const r = await bash(`kill ${victim.pid}`);
            expect(r.isError).toBe(true);
            expect(victim.killed || victim.exitCode !== null).toBe(false);
            const own = await bash("sleep 30 & kill $! && echo stopped");
            expect(own.content).toBe("stopped");
        } finally {
            victim.kill();
        }
    });

    test("background shells run sandboxed too, and their failures carry the hint", async () => {
        const started = await BashTool.run({ command: "echo x > .git/hooks/post-checkout", run_in_background: true }, ctx());
        expect(started.content).toContain("in the auto-mode sandbox");
        const id = started.content.match(/bash_\d+/)![0];
        await Bun.sleep(300);
        const out = await BashOutputTool.run({ bash_id: id }, ctx());
        expect(out.content).toContain("exited with code 1");
        expect(out.content).toContain(SANDBOX_HINT);
        expect(existsSync(join(ws, ".git", "hooks", "post-checkout"))).toBe(false);
    });

    test("ordinary failures get no hint", async () => {
        const r = await bash("exit 3");
        expect(r.isError).toBe(true);
        expect(r.content).not.toContain(SANDBOX_HINT);
    });

    test("can't move the workspace itself, or a credential dir out from under the read rule", async () => {
        const moved = await bash(`mv "${ws}" "${ws}-moved"`);
        expect(moved.isError).toBe(true);
        expect(existsSync(ws)).toBe(true);
        // A workspace that contains a credential dir (the home dir as the workspace, say).
        const home = join(ws, "fakehome");
        mkdirSync(join(home, ".ssh"), { recursive: true });
        writeFileSync(join(home, ".ssh", "id_test"), "KEY");
        const sb: Sandbox = { kind: "seatbelt", policy: sandboxPolicy([ws], { harnessHome: HARNESS_HOME, home }) };
        const r = await bash(`mv fakehome/.ssh fakehome/ssh2; cat fakehome/ssh2/id_test fakehome/.ssh/id_test`, sb);
        expect(r.content).not.toContain("KEY");
        expect(existsSync(join(home, ".ssh", "id_test"))).toBe(true);
    });

    test("can't move .git away (to edit its config and move it back)", async () => {
        const r = await bash("mv .git .g");
        expect(r.isError).toBe(true);
        expect(existsSync(join(ws, ".git", "hooks"))).toBe(true);
        expect(existsSync(join(ws, ".g"))).toBe(false);
    });

    test("in a worktree, can't repoint .git or commondir at a git dir it made", async () => {
        const own = join(real(tempDir()), "wt-gitdir");
        mkdirSync(own);
        writeFileSync(join(own, "commondir"), "../..\n");
        const wt = real(tempDir());
        writeFileSync(join(wt, ".git"), `gitdir: ${own}\n`);
        const sb: Sandbox = { kind: "seatbelt", policy: sandboxPolicy([wt], { harnessHome: HARNESS_HOME }) };
        const wtState = { cwd: wt, projectRoot: wt, fileState: new Map(), todos: [], shells: new Map() } as any;
        const run = (command: string) => BashTool.run({ command }, { ...ctx(sb), state: wtState });
        const evil = real(tempDir());
        await run(`printf 'gitdir: ${evil}\\n' > .git`);
        expect(require("fs").readFileSync(join(wt, ".git"), "utf-8")).toBe(`gitdir: ${own}\n`);
        await run(`printf '${evil}\\n' > "${join(own, "commondir")}"`);
        expect(require("fs").readFileSync(join(own, "commondir"), "utf-8")).toBe("../..\n");
        // Its own git dir stays writable (commits, the index).
        const ok = await run(`echo x > "${join(own, "index.lock")}" && echo wrote`);
        expect(ok.content).toBe("wrote");
    }, 20_000);
});
