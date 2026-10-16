// Shell sandbox for auto mode. A sandboxed command can write only inside the
// workspace and the temp directories (never git hooks or git config, the
// harness's own config, or the agent CLIs' .claude/ and .codex/, except for
// Claude Code's worktrees in .claude/worktrees/), can't read credential files,
// has no network beyond localhost, can't signal processes outside the
// sandbox, and can't reach the usual ways out of one: opening apps, Apple
// Events, launchd jobs, the keychain, the clipboard and the window server.
//
// macOS: sandbox-exec (Seatbelt). Linux: bubblewrap, when it's installed and
// allowed to create namespaces, and only when turned on (it's untested).
// Elsewhere there's no sandbox, and auto mode sends commands to its reviewer
// instead.

import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { commandsWithDirs, gitSubcommand, programNames, readSmallFile, runs } from "./bash-safety";
import { CASE_INSENSITIVE_FS, spellings } from "../util/files";

export type SandboxKind = "seatbelt" | "bwrap";

export interface SandboxPolicy {
    /** Directories commands may write to. */
    writable: string[];
    /** Inside those, paths that stay read-only. */
    readOnly: string[];
    /** The agent CLIs' config folders (.claude/, .codex/): read-only too, except the worktrees in them. */
    cliConfig?: string[];
    /**
     * Git checkouts Claude Code keeps in .claude/worktrees/: projects of their
     * own, so writable again (their own config is in readOnly).
     */
    worktrees?: string[];
    /** Paths commands can't read at all. */
    unreadable: string[];
    /** Git directories: their hooks and config stay read-only, submodules' and worktrees' included. */
    gitDirs: string[];
}

export interface Sandbox {
    kind: SandboxKind;
    policy: SandboxPolicy;
}

const SEATBELT = "/usr/bin/sandbox-exec";

let detected: SandboxKind | null | undefined;

/** Which sandbox this machine has, if any (checked once). */
export function sandboxKind(): SandboxKind | undefined {
    if (detected === undefined) {
        if (process.platform === "darwin" && existsSync(SEATBELT)) detected = seatbeltWorks() ? "seatbelt" : null;
        else if (process.platform === "linux" && Bun.which("bwrap")) detected = bwrapWorks() ? "bwrap" : null;
        else detected = null;
    }
    return detected ?? undefined;
}

/** Seatbelt can't be applied inside another sandbox (the harness itself running sandboxed). */
function seatbeltWorks(): boolean {
    try {
        return Bun.spawnSync([SEATBELT, "-p", "(version 1)(allow default)", "/usr/bin/true"], { stdout: "ignore", stderr: "ignore", timeout: 5000 }).exitCode === 0;
    } catch {
        return false;
    }
}

/** bwrap needs unprivileged user namespaces, which some distributions turn off. */
function bwrapWorks(): boolean {
    try {
        const r = Bun.spawnSync(["bwrap", "--ro-bind", "/", "/", "--unshare-net", "--die-with-parent", "true"], { stdout: "ignore", stderr: "ignore", timeout: 5000 });
        return r.exitCode === 0;
    } catch {
        return false;
    }
}

function real(p: string): string {
    try {
        return realpathSync(p);
    } catch {
        return resolve(p);
    }
}

/**
 * Whether auto mode uses the sandbox, given the `sandbox` setting: on by
 * default with Seatbelt; bubblewrap only when turned on (`"sandbox": true`),
 * since its rules haven't been tested on a Linux machine yet.
 */
export function sandboxEnabled(setting: boolean | undefined): boolean {
    const kind = sandboxKind();
    return kind === "seatbelt" ? setting !== false : kind === "bwrap" ? setting === true : false;
}

// Resolved once per workspace root. Sandboxed commands can't rewrite the
// pointers (a worktree's `.git` file, `commondir`), and the policy doesn't
// re-read them either, so an earlier command can't widen a later one's writes.
const gitDirCache = new Map<string, string[]>();

/** Where a workspace's git data lives: `.git`, or for a worktree its own git dir and the shared one. */
function gitDirs(root: string): string[] {
    let dirs = gitDirCache.get(root);
    if (!dirs) gitDirCache.set(root, (dirs = resolveGitDirs(root)));
    return dirs;
}

function resolveGitDirs(root: string): string[] {
    const dotGit = join(root, ".git");
    try {
        if (statSync(dotGit).isDirectory()) return [real(dotGit)];
        const m = readSmallFile(dotGit)?.match(/^gitdir:\s*(.+?)\s*$/m);
        if (!m) return [];
        const gitdir = real(isAbsolute(m[1]!) ? m[1]! : join(root, m[1]!));
        const commondir = readSmallFile(join(gitdir, "commondir"))?.trim();
        const common = commondir ? real(resolve(gitdir, commondir)) : undefined;
        return common && common !== gitdir ? [gitdir, common] : [gitdir];
    } catch {
        return [];
    }
}

const UNREADABLE_IN_HOME = [
    ".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker/config.json", ".config/gcloud", ".config/gh", ".config/hub", ".netrc",
    ".npmrc", ".pypirc", ".git-credentials", ".pgpass", ".vault-token", ".cargo/credentials", ".cargo/credentials.toml",
    ".gem/credentials", ".terraform.d/credentials.tfrc.json", ".password-store", ".local/share/keyrings", "Library/Keychains",
];

/** A project's own config: the harness's, and the agent CLIs' (hooks, skills, MCP servers, permissions). */
const PROJECT_CONFIG = [".harness", ".mcp.json"];
const CLI_CONFIG = [".claude", ".codex"];
/** Names checker.ts doesn't take for a worktree (see withoutWorktrees there). */
const CONFIG_NAMES = new Set([".harness", ".claude", ".codex", ".git", ".mcp.json"]);

/** A path as written and, if a symlink leads elsewhere, where it leads: a rule on one alone can be sidestepped through the other. */
function bothForms(p: string): string[] {
    return [...new Set([p, real(p)])];
}

/**
 * The git checkouts Claude Code keeps in <root>/.claude/worktrees/, taken as
 * checker.ts's withoutWorktrees takes them: a folder (not a symlink) with a
 * .git in it, not named like the config. Looked up for each command, so one
 * made since counts.
 */
function claudeWorktrees(root: string): string[] {
    const dir = join(root, ".claude", "worktrees");
    try {
        if (!lstatSync(join(root, ".claude")).isDirectory() || !lstatSync(dir).isDirectory()) return [];
        return readdirSync(dir)
            .filter((name) => !spellings(name).some((n) => CONFIG_NAMES.has(n)) && lstatSync(join(dir, name)).isDirectory() && existsSync(join(dir, name, ".git")))
            .map((name) => real(join(dir, name)));
    } catch {
        return [];
    }
}

/** What a sandboxed command may touch, for these workspace roots. */
export function sandboxPolicy(roots: string[], opts: { home?: string; harnessHome: string }): SandboxPolicy {
    const home = real(opts.home ?? homedir());
    const ws = [...new Set(roots.map(real))];
    // Listed even before a repo exists, so a new one can't get hooks planted either.
    const git = [...new Set([...ws.map((w) => join(w, ".git")), ...ws.flatMap(gitDirs)])];
    const temp = [...new Set([process.platform === "darwin" ? "/private/tmp" : "/tmp", real(tmpdir())])];
    const harness = real(opts.harnessHome);
    const worktrees = [...new Set(ws.flatMap(claudeWorktrees))];
    return {
        writable: [...new Set([...ws, ...git.filter((g) => !ws.some((w) => isWithin(g, w))), ...temp])],
        // A worktree's own config and its .git pointer stay read-only, as in the project around it.
        readOnly: [...new Set([...ws.flatMap((w) => PROJECT_CONFIG.flatMap((c) => bothForms(join(w, c)))), ...worktrees.flatMap((t) => [...PROJECT_CONFIG, ...CLI_CONFIG, ".git"].flatMap((c) => bothForms(join(t, c)))), harness])],
        cliConfig: [...new Set(ws.flatMap((w) => CLI_CONFIG.flatMap((c) => bothForms(join(w, c)))))],
        worktrees,
        unreadable: [...UNREADABLE_IN_HOME.map((p) => join(home, p)), harness],
        gitDirs: git,
    };
}

/**
 * The files in a git dir that make git run programs (hooks, config,
 * attributes for filter drivers) or point it at another git dir (a
 * worktree's `commondir` and `gitdir`).
 */
function gitProtectedPaths(g: string): string[] {
    return ["hooks", "config", "config.worktree", "info/attributes", "commondir", "gitdir"].map((x) => join(g, x));
}

/** A path and every directory above it. */
function withAncestors(p: string): string[] {
    const out = [p];
    for (let d = dirname(p); d !== out.at(-1); d = dirname(d)) out.push(d);
    return out;
}

function isWithin(p: string, dir: string): boolean {
    return p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/");
}

/** A string literal in Seatbelt's profile language. */
function sb(s: string): string {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A path as a literal inside a Seatbelt regex. */
function sbRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\"]/g, "\\$&");
}

/** Programs that hand work to something outside the sandbox. */
const ESCAPES = ["/usr/bin/osascript", "/usr/bin/open", "/bin/launchctl", "/usr/bin/security", "/usr/bin/crontab", "/usr/bin/at", "/usr/bin/batch", "/usr/bin/pbcopy", "/usr/bin/pbpaste", "/usr/bin/shortcuts"];
/** The services behind them, so a copied or compiled program gets nowhere either. */
const ESCAPE_SERVICES = [
    "com.apple.coreservices.appleevents", "com.apple.coreservices.launchservicesd", "com.apple.lsd.mapdb", "com.apple.lsd.modifydb",
    "com.apple.pasteboard.1", "com.apple.SecurityServer", "com.apple.security.syspolicy", "com.apple.windowserver.active",
];

/**
 * Seatbelt profile. Later rules win over earlier ones, so each `deny` after
 * an `allow` carves an exception out of it.
 */
export function seatbeltProfile(p: SandboxPolicy): string {
    const subpaths = (list: string[]) => list.map((x) => `(subpath ${sb(x)})`).join(" ");
    const cli = p.cliConfig ?? [];
    const worktrees = (p.worktrees ?? []).filter((t) => cli.some((c) => isWithin(t, c)));
    const fixed = [...new Set([...p.gitDirs.flatMap((g) => [g, join(g, "info"), ...nestedGitDirs(g)]).flatMap(withAncestors), ...worktrees])].filter((f) => p.writable.some((w) => isWithin(f, w)));
    return [
        "(version 1)",
        "(allow default)",
        // Network: localhost only (dev servers, test databases). Unix sockets too are
        // blocked: they lead to ssh-agent, docker and other unsandboxed servers.
        "(deny network*)",
        '(allow network-outbound (remote ip "localhost:*"))',
        '(allow network-bind (local ip "localhost:*"))',
        '(allow network-inbound (local ip "localhost:*"))',
        // Writes: the workspace and temp dirs, and the null/terminal devices.
        '(deny file-write* (subpath "/"))',
        `(allow file-write* ${subpaths(p.writable)} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
        // The agent CLIs' config, except the worktrees in it (the rule below protects their own config).
        ...(cli.length ? [`(deny file-write* ${subpaths(cli)})`] : []),
        ...(worktrees.length ? [`(allow file-write* ${subpaths(worktrees)})`] : []),
        // Unreadable paths can't be written (or renamed out from under the read rule) either.
        `(deny file-write* ${subpaths([...p.readOnly, ...p.gitDirs.flatMap(gitProtectedPaths), ...p.unreadable])})`,
        // Paths that can't be moved, replaced or repointed, only written inside:
        // the git dirs and `.git` pointer files, the writable directories
        // above them (the workspace roots, say), and the worktrees. Moved away,
        // edited and moved back, they'd get round the rules above.
        ...(fixed.length ? [`(deny file-write* ${fixed.map((f) => `(literal ${sb(f)})`).join(" ")})`] : []),
        // Submodules (.git/modules/<name>/…) and other worktrees (.git/worktrees/<name>/…)
        // have their own, and a worktree's git dir can't be moved either.
        ...p.gitDirs.map(
            (g) =>
                `(deny file-write* (regex #"^${sbRegex(g)}/(modules|worktrees)/.+/(hooks(/|$)|config$|config\\.worktree$|info/attributes$|commondir$|gitdir$)") (regex #"^${sbRegex(g)}/(modules|worktrees(/[^/]+)?)$"))`,
        ),
        `(deny file-read* ${subpaths(p.unreadable)})`,
        // Signals only within this sandbox: the user's other programs can't be killed.
        "(deny signal)",
        "(allow signal (target same-sandbox))",
        // Ways out: opening apps, Apple Events, launchd jobs, keychain, clipboard, synthetic input.
        "(deny lsopen)",
        "(deny job-creation)",
        `(deny mach-lookup ${ESCAPE_SERVICES.map((s) => `(global-name ${sb(s)})`).join(" ")})`,
        `(deny process-exec ${ESCAPES.map((x) => `(literal ${sb(x)})`).join(" ")})`,
    ].join("\n");
}

/** Submodule and worktree git dirs under a git dir, as they exist now. */
function nestedGitDirs(g: string): string[] {
    const out: string[] = [];
    for (const pattern of ["modules/**/config", "worktrees/*/gitdir"]) {
        try {
            for (const f of new Bun.Glob(pattern).scanSync({ cwd: g, dot: true, absolute: true })) out.push(dirname(f));
        } catch {
            // no such directory
        }
    }
    return out;
}

/**
 * Directories where host programs usually listen on Unix sockets (D-Bus,
 * Docker and other container engines, X11, tmux, ssh-agent). A network
 * namespace doesn't cover sockets that are files, and a read-only mount doesn't
 * stop connecting to them; sockets elsewhere stay reachable.
 */
function hostSocketDirs(): string[] {
    const home = homedir();
    const out = ["/run", "/var/run", "/tmp/.X11-unix", `/tmp/tmux-${process.getuid?.() ?? ""}`, ...[".docker/desktop", ".docker/run", ".colima", ".lima", ".rd"].map((d) => join(home, d))];
    try {
        for (const d of new Bun.Glob("ssh-*").scanSync({ cwd: "/tmp", onlyFiles: false, absolute: true })) out.push(d);
    } catch {
        // no /tmp
    }
    // A symlink (/var/run → /run) is covered by its target.
    return out.filter((d) => {
        try {
            return lstatSync(d).isDirectory();
        } catch {
            return false;
        }
    });
}

/**
 * bubblewrap arguments: the whole filesystem read-only, the writable dirs
 * bound read-write, read-only and unreadable paths layered on top, network,
 * process and IPC namespaces of its own (only loopback inside), and host
 * sockets hidden. bwrap can only cover paths that exist when the command
 * starts, so a `.harness` or `.mcp.json` that doesn't exist yet can be
 * created; that's one reason it's off unless turned on (sandboxEnabled).
 */
export function bwrapArgs(p: SandboxPolicy): string[] {
    const args = ["--die-with-parent", "--new-session", "--unshare-net", "--unshare-pid", "--unshare-ipc", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
    for (const w of p.writable) if (existsSync(w)) args.push("--bind", w, w);
    // The agent CLIs' config read-only, the worktrees in it bound read-write again on top.
    for (const c of p.cliConfig ?? []) if (existsSync(c)) args.push("--ro-bind", c, c);
    for (const t of p.worktrees ?? []) if (existsSync(t)) args.push("--bind", t, t);
    const gits = p.gitDirs.flatMap((g) => [g, ...nestedGitDirs(g)]);
    // Bound onto itself, a git dir is a mount point, which can't be moved or
    // replaced; a `.git` pointer file is bound read-only.
    for (const g of gits) if (existsSync(g)) args.push(statSync(g).isDirectory() ? "--bind" : "--ro-bind", g, g);
    for (const r of [...p.readOnly, ...gits.flatMap(gitProtectedPaths)]) if (existsSync(r)) args.push("--ro-bind", r, r);
    for (const u of p.unreadable) {
        if (!existsSync(u)) continue;
        if (statSync(u).isDirectory()) args.push("--tmpfs", u);
        else args.push("--ro-bind", "/dev/null", u);
    }
    for (const d of hostSocketDirs()) args.push("--tmpfs", d);
    return args;
}

/** The command line that runs `shell -c script` inside the sandbox. */
export function sandboxArgv(s: Sandbox, shell: string, script: string): string[] {
    if (s.kind === "seatbelt") return [SEATBELT, "-p", seatbeltProfile(s.policy), shell, "-c", script];
    return ["bwrap", ...bwrapArgs(s.policy), "--", shell, "-c", script];
}

/**
 * Subcommands that need only the network, and work in the Seatbelt sandbox
 * through its proxy once given the hosts (sandboxCacheEnv gives them a cache).
 */
const NETWORK_SUBCOMMANDS: Record<string, RegExp> = {
    npm: /^(install|i|add|ci|update|up|upgrade|outdated|audit|view|info|show|search|create|init|exec|pack)$/,
    pnpm: /^(install|i|add|update|up|upgrade|outdated|audit|dlx|create|fetch|import|view|info)$/,
    yarn: /^(install|add|upgrade|up|outdated|audit|dlx|create|info)$/,
    bun: /^(install|i|add|a|update|outdated|create|x|pm)$/,
    pip: /^(install|download|search|index)$/,
    pip3: /^(install|download|search|index)$/,
    uv: /^(add|sync|lock|pip|venv|init|run)$/,
};
/** Programs that need only the network. */
const NETWORK_PROGRAMS = new Set(["curl", "wget", "http", "https", "xh", "npx", "bunx", "pnpx"]);

/**
 * Subcommands that need the network and more: credentials (publishing,
 * logging in, git remotes), or writing to the home directory (global tools,
 * toolchains, caches that are also where installs live).
 */
const HOST_SUBCOMMANDS: Record<string, RegExp> = {
    npm: /^(publish|unpublish|login|adduser|deprecate|dist-tag|owner|access|token|whoami)$/,
    pnpm: /^(publish|login)$/,
    yarn: /^(publish|login|npm)$/,
    bun: /^(publish|upgrade)$/,
    uv: /^(tool|python|publish|self)$/,
    poetry: /^(add|install|update|lock|publish|search|self)$/,
    cargo: /^(add|install|update|fetch|publish|search|login|generate-lockfile|vendor)$/,
    go: /^(get|install|mod)$/,
    git: /^(clone|fetch|pull|push|ls-remote|submodule|remote|archive|send-email|request-pull)$/,
    deno: /^(install|add|cache|upgrade|publish)$/,
    gem: /^(install|update|push|fetch|search|sources)$/,
    bundle: /^(install|update|add|exec|outdated)$/,
    composer: /^(install|update|require|create-project)$/,
    dotnet: /^(restore|add|tool|nuget|publish)$/,
    mvn: /./,
    gradle: /./,
    gradlew: /./,
};
/** Programs that need services outside the sandbox whatever their arguments (credentials, sockets, other processes). */
const HOST_PROGRAMS = new Set([
    "ssh", "scp", "sftp", "rsync", "ftp", "telnet", "nc", "ncat", "gh", "glab", "hub",
    "docker", "podman", "docker-compose", "kubectl", "helm", "terraform", "tofu", "pulumi", "aws", "gcloud", "gsutil", "az",
    "fly", "flyctl", "vercel", "netlify", "heroku", "firebase", "wrangler", "railway", "brew", "apt", "apt-get", "yum", "dnf",
    "pacman", "port", "snap", "pipx", "open", "osascript", "pbcopy", "pbpaste", "security", "launchctl",
    "crontab", "say", "afplay", "shortcuts", "sudo", "kill", "pkill", "killall",
]);
const LOCAL_URL = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/;

export interface AccessNeeded {
    /** Something that needs more than the network (credentials, other processes, system services): it can't run sandboxed. */
    host?: string;
    /** Something that needs only the network: in the Seatbelt sandbox it can, given the hosts. */
    network?: string;
}

/**
 * What a command needs from outside the sandbox, as a guess from its text.
 * It's used to skip a sandboxed attempt that would fail, and to tell the
 * model to list hosts: a command it misses fails in the sandbox and can be
 * retried with them, or outside it.
 */
export function accessNeeded(cmd: string, cwd?: string): AccessNeeded {
    const out: AccessNeeded = {};
    for (const { programs, dir, text } of commandsWithDirs(cmd, cwd)) for (const argv of programs) {
        // By the name the program is found by: `NPM install` is npm install on macOS.
        const names = programNames(argv[0] ?? "");
        const prog = names.find((n) => NETWORK_PROGRAMS.has(n) || HOST_PROGRAMS.has(n) || Object.hasOwn(HOST_SUBCOMMANDS, n) || Object.hasOwn(NETWORK_SUBCOMMANDS, n) || /^python[\d.]*$/.test(n)) ?? names[0]!;
        const args = argv.slice(1);
        const sub = prog === "git" ? argv[gitSubcommand(argv).index] : args.find((a) => !a.startsWith("-"));
        if (NETWORK_PROGRAMS.has(prog)) {
            // `curl --version` needs nothing.
            if (!sub) continue;
            // Fetching from a local dev server works inside without any.
            if (/^(curl|wget|http|https|xh)$/.test(prog) && args.some((a) => LOCAL_URL.test(a)) && !args.some((a) => /^https?:\/\//.test(a) && !LOCAL_URL.test(a))) continue;
            // `npx jest` runs the project's own copy (pnpx always downloads).
            if ((prog === "npx" || prog === "bunx") && dir && hasLocalBin(dir, sub)) continue;
            out.network ??= prog;
            continue;
        }
        if (HOST_PROGRAMS.has(prog)) {
            // Managing processes the same command started works inside.
            if (/^(kill|pkill)$/.test(prog) && /%\d|\$!/.test(text)) continue;
            out.host ??= prog;
            continue;
        }
        // git keeps a worktree's own data in .git/worktrees, which the sandbox protects (a sandboxed
        // command could otherwise point a worktree's commondir at a config that runs programs). Inside,
        // `git worktree add -b` fails after making the branch; outside, after review, it works.
        if (prog === "git" && sub === "worktree") {
            const op = argv[gitSubcommand(argv).index + 1] ?? "";
            if (/^(add|move|remove|prune|repair)$/.test(op)) out.host ??= `git worktree ${op}`;
            continue;
        }
        if (prog === "git" && sub === "clone") {
            // Over https a public repository clones fine; ssh and private ones need the user's keys.
            const rest = argv.slice(gitSubcommand(argv).index + 1);
            if (rest.some((a) => /^https:\/\//.test(a)) && !rest.some((a) => /^(ssh|git):\/\/|^[\w.-]+@[\w.-]+:/.test(a))) out.network ??= "git clone";
            else out.host ??= "git clone";
            continue;
        }
        if (sub && HOST_SUBCOMMANDS[prog]?.test(sub)) out.host ??= `${prog} ${sub}`;
        else if (sub && NETWORK_SUBCOMMANDS[prog]?.test(sub)) out.network ??= `${prog} ${sub}`;
        else if (/^python[\d.]*$/.test(prog) && args[0] === "-m" && /^(pip|ensurepip)$/.test(args[1] ?? "") && /\b(install|download)\b/.test(args.join(" "))) out.network ??= `${prog} -m ${args[1]}`;
    }
    return out;
}

/** What a command needs from outside the sandbox (the network, other processes, system services), or undefined. */
export function needsHostAccess(cmd: string, cwd?: string): string | undefined {
    const a = accessNeeded(cmd, cwd);
    return a.host ?? a.network;
}

/** A plain name (no version, no scope) installed in node_modules/.bin here or in a directory above, as npx and bunx look for it. */
function hasLocalBin(dir: string, name: string): boolean {
    if (!/^[\w.-]+$/.test(name)) return false;
    for (let d = dir; ; d = dirname(d)) {
        if (existsSync(join(d, "node_modules", ".bin", name))) return true;
        if (dirname(d) === d) return false;
    }
}

/**
 * Package caches a sandboxed command can write: npm, Bun and uv won't run
 * with theirs in the home directory read-only. Only sandboxed commands use
 * them, so what one leaves there never reaches a command outside.
 *
 * With network access, Corepack gets a home there too, so it can fetch the
 * pnpm or yarn a project pins; without, it keeps the user's, where the
 * versions already downloaded are.
 */
export function sandboxCacheEnv(network = false): Record<string, string> {
    const dir = join(real(tmpdir()), "harness-sandbox-cache");
    const env: Record<string, string> = { npm_config_cache: join(dir, "npm"), BUN_INSTALL_CACHE_DIR: join(dir, "bun"), UV_CACHE_DIR: join(dir, "uv"), PIP_CACHE_DIR: join(dir, "pip") };
    if (network) env.COREPACK_HOME = join(dir, "corepack");
    return env;
}

// `/` so a program given by path (/bin/rm) counts too. In every spelling, case ignored
// where the volume ignores it (`RM` is rm there).
const DELETE_WORD = new RegExp(/(^|[\s;|&(`'"/])(rm|rmdir|unlink|shred|truncate|srm)(?=\s|$|[;|&)`'"])/.source, CASE_INSENSITIVE_FS ? "i" : "");
// Deletion from inline code: python -c, node -e, ruby -e, PowerShell.
const DELETE_CALL = /\b(rmtree|rmSync|rmdirSync|unlinkSync|os\.(remove|unlink|rmdir|removedirs)|fs\.(rm|unlink|rmdir)|fs\.promises\.(rm|unlink)|FileUtils\.(rm|rm_r|rm_rf|remove)|Remove-Item)\b/;

/**
 * Discards or deletes work by name. The reviewer sees these even when they'd
 * run in the sandbox, which contains everything except damage inside the
 * project itself. With cwd, `git checkout <name>` counts when the name is a
 * file there (it discards that file's changes) and not when it's a branch.
 */
export function looksDestructive(cmd: string, cwd?: string): string | undefined {
    for (const t of [cmd, ...spellings(cmd)]) if (DELETE_WORD.test(t)) return t.match(DELETE_WORD)![2]!.toLowerCase();
    if (DELETE_CALL.test(cmd)) return "deletes files";
    for (const { programs, dir } of commandsWithDirs(cmd, cwd)) for (const argv of programs) {
        const prog = argv[0];
        const args = argv.slice(1);
        if (runs(prog, "find") && args.some((a) => a === "-delete")) return "find -delete";
        for (const p of ["dd", "mkfs", "diskutil"]) if (runs(prog, p)) return p;
        if (!runs(prog, "git")) continue;
        const { index, dirs } = gitSubcommand(argv);
        const sub = argv[index];
        const rest = argv.slice(index + 1);
        const has = (...flags: string[]) => rest.some((a) => flags.includes(a) || flags.some((f) => /^-[a-zA-Z]$/.test(f) && /^-[a-zA-Z]+$/.test(a) && a.includes(f[1]!)));
        switch (sub) {
            case "clean":
                return "git clean";
            case "checkout": {
                if (rest.includes("--") || has("-f", "--force") || rest.some((a) => /^--(ours|theirs|pathspec-from-file)/.test(a))) return "git checkout (discards changes)";
                // Making a branch keeps local changes.
                if (has("-b", "-B", "--orphan")) break;
                const operands = rest.filter((a) => !a.startsWith("-"));
                // After a `cd` it can't follow, any name might be a file.
                const isPath = (a: string) => a === "." || /[*?[]/.test(a) || dir === null || (dir !== undefined && existsSync(resolve(dir, ...dirs, a)));
                // A commit and paths, or a single operand that names a file, restores files.
                if (operands.length > 1 || operands.some(isPath)) return "git checkout (discards changes)";
                break;
            }
            case "switch":
                if (has("-f", "--force", "--discard-changes")) return "git switch (discards changes)";
                break;
            case "restore":
                if (!rest.includes("--staged") || rest.includes("--worktree") || has("-W")) return "git restore";
                break;
            case "reset":
                if (rest.includes("--hard") || rest.includes("--merge") || rest.includes("--keep")) return "git reset --hard";
                break;
            case "stash":
                if (/^(drop|clear)$/.test(rest[0] ?? "")) return "git stash drop";
                break;
            case "branch":
                if (has("-D") || (has("-d", "--delete") && has("-f", "--force"))) return "git branch -D";
                break;
            case "reflog":
                if (/^(expire|delete)$/.test(rest[0] ?? "")) return "git reflog expire";
                break;
            case "gc":
            case "prune":
                if (sub === "prune" || rest.some((a) => a.startsWith("--prune"))) return "git prune";
                break;
            case "update-ref":
                if (has("-d")) return "git update-ref -d";
                break;
            case "worktree":
                if (rest[0] === "remove" || rest[0] === "prune") return "git worktree remove";
                break;
            case "filter-branch":
            case "filter-repo":
                return `git ${sub}`;
        }
    }
    return undefined;
}

/** Output that suggests the sandbox got in the way. */
export function blockedBySandbox(output: string): boolean {
    return /Operation not permitted|Read-only file system|EPERM|EROFS|Could not resolve|nodename nor servname|Name or service not known|Temporary failure in name resolution|getaddrinfo|ENOTFOUND|EAI_AGAIN|Network is unreachable|Failed to connect|fetch failed|Connection refused|sandbox-exec|bwrap:/i.test(output);
}

export const SANDBOX_HINT =
    "[This ran in the auto-mode sandbox: no network except localhost and the hosts in allowedHosts, writes only inside the project and temp directories (git's hooks, config and worktree data under .git stay read-only), no credential files, no signals to other processes. If it failed for want of a host, run it again listing the host in allowedHosts; if it failed for something else the sandbox blocks, run it again with dangerouslyDisableSandbox: true. The safety reviewer or the user then decides.]";

/** bubblewrap has no proxy: a sandboxed command there gets no network at all. */
const BWRAP_HINT =
    "[This ran in the auto-mode sandbox: no network except localhost, writes only inside the project and temp directories (git's hooks, config and worktree data under .git stay read-only), no credential files, no signals to other processes. If the failure comes from that, run the command again with dangerouslyDisableSandbox: true; the safety reviewer or the user then decides.]";

/** git couldn't write its worktree data: what that leaves behind, and how to finish. */
export const WORKTREE_HINT =
    "[git worktree can't create or change .git/worktrees inside the sandbox. Run it again with dangerouslyDisableSandbox: true. `git worktree add -b <branch>` makes the branch before it fails, so the branch may exist now (check with git branch --list <branch>): add the worktree for it without -b (git worktree add <path> <branch>), or delete it first if it was made by mistake.]";

/** What to tell the model after a sandboxed command's output looked blocked. */
export function sandboxHint(kind: SandboxKind, output = ""): string {
    const base = kind === "seatbelt" ? SANDBOX_HINT : BWRAP_HINT;
    return /\.git\/worktrees\b/.test(output) ? `${base}\n${WORKTREE_HINT}` : base;
}
