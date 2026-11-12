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
import { hostOf, remoteSh, sshOk } from "./ssh";

/** `$HOME`-relative, for scripts: always inside double quotes there. */
export const REMOTE_DIR = "$HOME/.cavvy/server";
export const remoteBuildDir = (build: string) => `${REMOTE_DIR}/builds/${build}`;
export const REMOTE_CURRENT = `${REMOTE_DIR}/current/cavvy`;

/** A build's name on disk: nothing a shell or a path would read into. */
export const BUILD_ID = /^[0-9a-z][0-9a-z.-]{5,60}$/;

export type LinuxTarget = "linux-x64" | "linux-x64-baseline" | "linux-arm64";

export interface ServerFacts {
    os: string;
    arch: string;
    /** "glibc 2.39", "musl", or "unknown". */
    libc: string;
    home: string;
    user: string;
    shell: string;
    avx2: boolean;
    /** A systemd user manager answers. */
    systemd: boolean;
    /** Its services keep running with nobody signed in. Undefined where there's no saying. */
    linger?: boolean;
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
echo "os=$(uname -s)"
echo "arch=$(uname -m)"
echo "home=$HOME"
echo "user=$(id -un)"
echo "shell=\${SHELL:-}"
if v=$(getconf GNU_LIBC_VERSION 2>/dev/null); then echo "libc=$v"
elif ldd --version 2>&1 | grep -qi musl; then echo "libc=musl"
else echo "libc=unknown"; fi
grep -qw avx2 /proc/cpuinfo 2>/dev/null && echo "avx2=1"
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    echo "systemd=1"
    echo "linger=$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)"
fi
awk '/^MemTotal:/ { printf "mem=%d\\n", $2 / 1024 }' /proc/meminfo 2>/dev/null
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
        const v = line.slice(i + 1).trim();
        if (k === "build" || k === "gui") {
            if (BUILD_ID.test(v)) (k === "build" ? builds : guiBuilds).push(v);
        } else if (!one.has(k)) one.set(k, v);
    }
    const num = (k: string) => {
        const n = Number(one.get(k));
        return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
    };
    const linger = one.get("linger");
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
        memMb: num("mem"),
        diskFreeMb: num("disk"),
        builds,
        guiBuilds,
        current: current && BUILD_ID.test(current) ? current : undefined,
    };
}

export async function probeServer(e: ServerEntry, signal?: AbortSignal): Promise<ServerFacts> {
    const facts = parseFacts(await sshOk(e, remoteSh(PROBE), { timeoutMs: 45_000, signal }));
    if (!facts.os || !facts.home) throw new ServerError(`${hostOf(e)} didn't answer as a server Cavvy can read (no \`sh\`, \`uname\` or home folder there).`);
    return facts;
}

/** Room a build and its copy in transit need. */
const NEEDED_MB = 400;

/** Which build runs there, or why none does: thrown as what the user reads. */
export function targetFor(facts: ServerFacts, e: ServerEntry): LinuxTarget {
    const host = hostOf(e);
    const cant = (why: string) => new ServerError(`Cavvy can't run on ${host}: ${why}`);
    if (facts.os !== "Linux") throw cant(`it needs Linux, and this is ${facts.os || "something else"}.`);
    const arch = facts.arch === "x86_64" || facts.arch === "amd64" ? "x64" : facts.arch === "aarch64" || facts.arch === "arm64" ? "arm64" : undefined;
    if (!arch) throw cant(`it needs an x64 or arm64 processor, and this is ${facts.arch || "unknown"}.`);
    if (!facts.libc.startsWith("glibc")) throw cant(facts.libc === "musl" ? "it needs glibc, and this system uses musl (Alpine)." : "it needs glibc, which wasn't found there.");
    if (facts.diskFreeMb !== undefined && facts.diskFreeMb < NEEDED_MB) throw cant(`it needs ${NEEDED_MB} MB free, and there are ${facts.diskFreeMb}.`);
    if (arch === "arm64") return "linux-arm64";
    return facts.avx2 ? "linux-x64" : "linux-x64-baseline";
}
