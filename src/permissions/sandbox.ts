// Shell sandbox for auto mode. A sandboxed command can write only inside the
// workspace and the temp directories (never git hooks or git config, or the
// harness's own config), can't read credential files, has no network beyond
// localhost, can't signal processes outside the sandbox, and can't reach the
// usual ways out of one: opening apps, Apple Events, launchd jobs, the
// keychain, the clipboard and the window server.
//
// macOS: sandbox-exec (Seatbelt). Linux: bubblewrap, when it's installed and
// allowed to create namespaces, and only when turned on (it's untested).
// Elsewhere there's no sandbox, and auto mode sends commands to its reviewer
// instead.

import { existsSync, lstatSync, realpathSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { analyzeCommand, commandsWithDirs, effectiveArgv, gitSubcommand, readSmallFile } from "./bash-safety";

export type SandboxKind = "seatbelt" | "bwrap";

export interface SandboxPolicy {
    /** Directories commands may write to. */
    writable: string[];
    /** Inside those, paths that stay read-only. */
    readOnly: string[];
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

/** What a sandboxed command may touch, for these workspace roots. */
export function sandboxPolicy(roots: string[], opts: { home?: string; harnessHome: string }): SandboxPolicy {
    const home = real(opts.home ?? homedir());
    const ws = [...new Set(roots.map(real))];
    // Listed even before a repo exists, so a new one can't get hooks planted either.
    const git = [...new Set([...ws.map((w) => join(w, ".git")), ...ws.flatMap(gitDirs)])];
    const temp = [...new Set([process.platform === "darwin" ? "/private/tmp" : "/tmp", real(tmpdir())])];
    const harness = real(opts.harnessHome);
    return {
        writable: [...new Set([...ws, ...git.filter((g) => !ws.some((w) => isWithin(g, w))), ...temp])],
        readOnly: [...ws.flatMap((w) => [join(w, ".harness"), join(w, ".mcp.json")]), harness],
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
    const fixed = [...new Set(p.gitDirs.flatMap((g) => [g, join(g, "info"), ...nestedGitDirs(g)]).flatMap(withAncestors))].filter((f) => p.writable.some((w) => isWithin(f, w)));
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
        // Unreadable paths can't be written (or renamed out from under the read rule) either.
        `(deny file-write* ${subpaths([...p.readOnly, ...p.gitDirs.flatMap(gitProtectedPaths), ...p.unreadable])})`,
        // Paths that can't be moved, replaced or repointed, only written inside:
        // the git dirs and `.git` pointer files, and the writable directories
        // above them (the workspace roots, say). Moved away, edited and moved
        // back, they'd get round the rules above.
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

const NET_SUBCOMMANDS: Record<string, RegExp> = {
    npm: /^(install|i|add|ci|update|up|upgrade|outdated|audit|publish|unpublish|login|adduser|view|info|show|search|create|init|exec|pack|deprecate|dist-tag|owner|access|token|whoami)$/,
    pnpm: /^(install|i|add|update|up|upgrade|outdated|audit|publish|dlx|create|fetch|import|login|view|info)$/,
    yarn: /^(install|add|upgrade|up|outdated|audit|publish|dlx|create|login|info|npm)$/,
    bun: /^(install|i|add|a|update|upgrade|outdated|publish|create|x|pm)$/,
    pip: /^(install|download|search|index)$/,
    pip3: /^(install|download|search|index)$/,
    uv: /^(add|sync|lock|pip|tool|python|venv|init|run|publish|self)$/,
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
/** Programs that need the network or services outside the sandbox whatever their arguments. */
const HOST_PROGRAMS = new Set([
    "curl", "wget", "http", "https", "xh", "ssh", "scp", "sftp", "rsync", "ftp", "telnet", "nc", "ncat", "gh", "glab", "hub",
    "docker", "podman", "docker-compose", "kubectl", "helm", "terraform", "tofu", "pulumi", "aws", "gcloud", "gsutil", "az",
    "fly", "flyctl", "vercel", "netlify", "heroku", "firebase", "wrangler", "railway", "brew", "apt", "apt-get", "yum", "dnf",
    "pacman", "port", "snap", "pipx", "npx", "bunx", "pnpx", "open", "osascript", "pbcopy", "pbpaste", "security", "launchctl",
    "crontab", "say", "afplay", "shortcuts", "sudo", "kill", "pkill", "killall",
]);
const LOCAL_URL = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/;

/**
 * What a command needs from outside the sandbox (the network, other
 * processes, system services), or undefined. A guess from the command text,
 * used only to skip a sandboxed attempt that would fail: a command it misses
 * fails in the sandbox and can be retried outside it.
 */
export function needsHostAccess(cmd: string): string | undefined {
    for (const c of analyzeCommand(cmd).commands) {
        const argv = effectiveArgv(c.argv);
        const prog = (argv[0] ?? "").split("/").pop()!;
        const args = argv.slice(1);
        const sub = prog === "git" ? argv[gitSubcommand(argv).index] : args.find((a) => !a.startsWith("-"));
        if (HOST_PROGRAMS.has(prog)) {
            // Fetching from a local dev server works inside.
            if (/^(curl|wget|http|https|xh)$/.test(prog) && args.some((a) => LOCAL_URL.test(a)) && !args.some((a) => /^https?:\/\//.test(a) && !LOCAL_URL.test(a))) continue;
            // So does managing processes the same command started.
            if (/^(kill|pkill)$/.test(prog) && /%\d|\$!/.test(c.text)) continue;
            return prog;
        }
        const re = NET_SUBCOMMANDS[prog];
        if (re && sub && re.test(sub)) return `${prog} ${sub}`;
        if (/^python[\d.]*$/.test(prog) && args[0] === "-m" && /^(pip|ensurepip)$/.test(args[1] ?? "") && /\b(install|download)\b/.test(args.join(" "))) return `${prog} -m ${args[1]}`;
    }
    return undefined;
}

// `/` so a program given by path (/bin/rm) counts too.
const DELETE_WORD = /(^|[\s;|&(`'"/])(rm|rmdir|unlink|shred|truncate|srm)(?=\s|$|[;|&)`'"])/;
// Deletion from inline code: python -c, node -e, ruby -e, PowerShell.
const DELETE_CALL = /\b(rmtree|rmSync|rmdirSync|unlinkSync|os\.(remove|unlink|rmdir|removedirs)|fs\.(rm|unlink|rmdir)|fs\.promises\.(rm|unlink)|FileUtils\.(rm|rm_r|rm_rf|remove)|Remove-Item)\b/;

/**
 * Discards or deletes work by name. The reviewer sees these even when they'd
 * run in the sandbox, which contains everything except damage inside the
 * project itself. With cwd, `git checkout <name>` counts when the name is a
 * file there (it discards that file's changes) and not when it's a branch.
 */
export function looksDestructive(cmd: string, cwd?: string): string | undefined {
    if (DELETE_WORD.test(cmd)) return cmd.match(DELETE_WORD)![2];
    if (DELETE_CALL.test(cmd)) return "deletes files";
    for (const { argv, dir } of commandsWithDirs(cmd, cwd)) {
        const prog = (argv[0] ?? "").split("/").pop()!;
        const args = argv.slice(1);
        if (prog === "find" && args.some((a) => a === "-delete")) return "find -delete";
        if (prog === "dd" || prog === "mkfs" || prog === "diskutil") return prog;
        if (prog !== "git") continue;
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
    "[This ran in the auto-mode sandbox: no network except localhost, writes only inside the project and temp directories, no credential files, no signals to other processes. If the failure comes from that, run the command again with dangerouslyDisableSandbox: true; the safety reviewer or the user then decides.]";
