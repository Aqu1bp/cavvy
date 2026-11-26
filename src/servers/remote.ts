// What's on a server, found out by asking it: one plain `sh` script over ssh,
// before anything of Cavvy's is there. What Cavvy itself can tell once it's
// installed (which CLIs are signed in, whether a sandbox works) comes from the
// server's own Cavvy instead (`cavvy host check`, src/servers/host.ts).
//
// Where Cavvy lives on a server, under the signed-in user's home:
//   ~/.cavvy/server/builds/<build>/cavvy   each build put there, and its GUI beside it
//   ~/.cavvy/server/current                a link to the build the server runs
//   ~/.cavvy/server/…                      the running server's own files (host.ts)

import { ServerError, type ServerEntry } from "./store";
import { hostOf, printable, remoteSh, ssh } from "./ssh";

/** `$HOME`-relative, for scripts: always inside double quotes there. */
export const REMOTE_DIR = "$HOME/.cavvy/server";

export const remoteBuildDir = (build: string) => `${REMOTE_DIR}/builds/${build}`;
export const REMOTE_CURRENT = `${REMOTE_DIR}/current/cavvy`;

/** `cavvy host login`'s exit codes: what the machine that ran it over SSH says for each (src/servers/cli.ts). */
export const LOGIN_EXIT = { notInstalled: 4, notSignedIn: 5, unknown: 6, problem: 7, stopped: 130 } as const;

/** A build's name on disk: nothing a shell or a path would read into. */
export const BUILD_ID = /^[0-9a-z][0-9a-z.-]{5,60}$/;

/** The kinds of machine a server's build is made for: Linux with glibc, and a Mac with Apple silicon. */
export type ServerTarget = "linux-x64" | "linux-x64-baseline" | "linux-arm64" | "darwin-arm64";

/** The name of Cavvy's job in launchd, and of its files. */
export const MAC_LABEL = "dev.cavvy.server";

/** Where a Mac keeps what only an administrator changes, and the PATH its root is given (changeable for tests: the pretend Mac's own). */
export const macLaunchd = { daemons: "/Library/LaunchDaemons", rootPath: "/usr/bin:/bin:/usr/sbin:/sbin", sudo: "/usr/bin/sudo" };

/** A script with those filled in. */
export const withMacPaths = (script: string) => script.replaceAll("@@DAEMONS@@", macLaunchd.daemons).replaceAll("@@ROOT_PATH@@", macLaunchd.rootPath).replaceAll("@@SUDO@@", macLaunchd.sudo);

/**
 * `$daemon`: the LaunchDaemon's file, and `boots`: whether it's there and runs Cavvy as this account (another account
 * of the same Mac may have its own under that name, which is left alone). Root wrote the file (service.ts MAC_BOOT),
 * so what it says can be believed.
 */
export const MAC_DAEMON = `
daemon="@@DAEMONS@@/${MAC_LABEL}.plist"
boots() { [ -f "$daemon" ] && grep -qF "<key>UserName</key><string>$(id -un)</string>" "$daemon"; }
`;

export interface ServerFacts {
    os: string;
    arch: string;
    /** "glibc 2.39", "musl", or "unknown" (a Mac isn't asked). */
    libc: string;
    home: string;
    user: string;
    shell: string;
    avx2: boolean;
    /** A systemd user manager answers. */
    systemd: boolean;
    /** Its services keep running with nobody signed in. Undefined where there's no saying. */
    linger?: boolean;
    /** A Mac: a LaunchDaemon for Cavvy is installed, so it starts at boot: this user's (`mine`), or another's under the same name. */
    launchDaemon?: "mine" | "other";
    memMb?: number;
    diskFreeMb?: number;
    /** Builds already there. */
    builds: string[];
    /** Of those, the ones that have their GUI beside them. */
    guiBuilds: string[];
    /** The one `current` points at. */
    current?: string;
}

const PROBE = `
os=$(uname -s)
echo "os=$os"
echo "arch=$(uname -m)"
echo "home=$HOME"
echo "user=$(id -un)"
echo "shell=\${SHELL:-}"
if [ "$os" = Darwin ]; then
    # A Mac has no /proc, and neither glibc nor a processor too old for the build to ask about.
    if m=$(sysctl -n hw.memsize 2>/dev/null); then echo "mem=$((m / 1048576))"; fi
    ${MAC_DAEMON}
    if boots; then echo "boot=mine"; elif [ -f "$daemon" ]; then echo "boot=other"; fi
else
    if v=$(getconf GNU_LIBC_VERSION 2>/dev/null); then echo "libc=$v"
    elif ldd --version 2>&1 | grep -qi musl; then echo "libc=musl"
    else echo "libc=unknown"; fi
    grep -qw avx2 /proc/cpuinfo 2>/dev/null && echo "avx2=1"
    if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
        echo "systemd=1"
        echo "linger=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)"
    fi
    awk '/^MemTotal:/ { printf "mem=%d\\n", $2 / 1024 }' /proc/meminfo 2>/dev/null
fi
df -Pk "$HOME" 2>/dev/null | awk 'NR == 2 { printf "disk=%d\\n", $4 / 1024 }'
d="${REMOTE_DIR}"
if [ -d "$d/builds" ]; then
    for b in "$d"/builds/*/; do
        [ -x "\${b}cavvy" ] || continue
        echo "build=$(basename "$b")"
        [ -f "\${b}gui/index.html" ] && echo "gui=$(basename "$b")"
    done
fi
if [ -L "$d/current" ]; then echo "current=$(basename "$(readlink "$d/current")")"; fi
exit 0
`;

export function parseFacts(out: string): ServerFacts {
    const one = new Map<string, string>();
    const builds: string[] = [];
    const guiBuilds: string[] = [];
    for (const line of out.split("\n")) {
        const i = line.indexOf("=");
        if (i <= 0) continue;
        const k = line.slice(0, i).trim();
        // Shown to the user in places (the system's name, the user's): nothing that would draw on a terminal.
        const v = printable(line.slice(i + 1).trim(), 200);
        if (k === "build" || k === "gui") {
            if (BUILD_ID.test(v)) (k === "build" ? builds : guiBuilds).push(v);
        } else if (!one.has(k)) one.set(k, v);
    }
    const num = (k: string) => {
        const n = Number(one.get(k));
        return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
    };
    const linger = one.get("linger");
    const boot = one.get("boot");
    const current = one.get("current");
    return {
        os: one.get("os") ?? "",
        arch: one.get("arch") ?? "",
        libc: one.get("libc") ?? "unknown",
        home: one.get("home") ?? "",
        user: one.get("user") ?? "",
        shell: one.get("shell") ?? "",
        avx2: one.get("avx2") === "1",
        systemd: one.get("systemd") === "1",
        linger: linger === "yes" ? true : linger === "no" ? false : undefined,
        ...(boot === "mine" || boot === "other" ? { launchDaemon: boot } : {}),
        memMb: num("mem"),
        diskFreeMb: num("disk"),
        builds,
        guiBuilds,
        current: current && BUILD_ID.test(current) ? current : undefined,
    };
}

export async function probeServer(e: ServerEntry, signal?: AbortSignal): Promise<ServerFacts> {
    const r = await ssh(e, remoteSh(withMacPaths(PROBE)), { timeoutMs: 45_000, signal });
    // csh and tcsh can't take a quoted script of several lines, which is how every command is sent (ssh.ts remoteSh).
    if (r.code !== 0 && /Unmatched ['"]/.test(r.stderr)) throw new ServerError(`Cavvy can't run commands on ${hostOf(e)}: your login shell there is csh or tcsh. It needs sh, bash, zsh, dash or ksh.`);
    if (r.code !== 0) throw new ServerError(`A command on ${hostOf(e)} failed (${r.code}): ${printable(r.stderr.trim().split("\n").at(-1) ?? "no output")}`);
    const facts = parseFacts(r.stdout);
    if (!facts.os || !facts.home) throw new ServerError(`${hostOf(e)} didn't answer as a server Cavvy can read (no \`sh\`, \`uname\` or home folder there).`);
    return facts;
}

/** Room a build and its copy in transit need. */
const NEEDED_MB = 400;

/** Throws when there isn't room for a build to be copied there. Asked only when one will be. */
export function checkRoom(facts: ServerFacts, e: ServerEntry) {
    if (facts.diskFreeMb !== undefined && facts.diskFreeMb < NEEDED_MB) throw new ServerError(`There isn't room on ${hostOf(e)} for Cavvy: it needs ${NEEDED_MB} MB free, and there are ${facts.diskFreeMb}.`);
}

/** Which build runs there, or why none does: thrown as what the user reads. */
export function targetFor(facts: ServerFacts, e: ServerEntry): ServerTarget {
    const host = hostOf(e);
    const cant = (why: string) => new ServerError(`Cavvy can't run on ${host}: ${why}`);
    if (facts.os === "Darwin") {
        if (facts.arch === "arm64") return "darwin-arm64";
        throw cant(facts.arch === "x86_64" ? "it needs a Mac with Apple silicon, and this one has an Intel processor." : `it needs a Mac with Apple silicon, and this one's processor is ${facts.arch || "unknown"}.`);
    }
    if (facts.os !== "Linux") throw cant(`it needs Linux or macOS, and this is ${facts.os || "something else"}.`);
    const arch = facts.arch === "x86_64" || facts.arch === "amd64" ? "x64" : facts.arch === "aarch64" || facts.arch === "arm64" ? "arm64" : undefined;
    if (!arch) throw cant(`it needs an x64 or arm64 processor, and this is ${facts.arch || "unknown"}.`);
    if (!facts.libc.startsWith("glibc")) throw cant(facts.libc === "musl" ? "it needs glibc, and this system uses musl (Alpine)." : "it needs glibc, which wasn't found there.");
    if (arch === "arm64") return "linux-arm64";
    return facts.avx2 ? "linux-x64" : "linux-x64-baseline";
}
