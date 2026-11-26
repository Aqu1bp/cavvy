// A pretend server for tests of src/servers: `ssh` is replaced (CAVVY_SSH)
// by a program that runs each "remote" command on this machine, in a home
// folder of the pretend server's own (fake-ssh-main.ts). The Cavvy "installed"
// there is this checkout's, run from source, so the real server code answers.
//
// The pretend server reports itself as Linux x64 with glibc whatever this
// machine is, so the flow is the same on a Mac and in CI. Asked to (`mac`), it
// is a Mac with Apple silicon instead, on any machine: launchd, sudo and
// Xcode's tools are stand-ins there (fake-launchctl.sh and the shims below).
//
// This module must not import anything from src.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join, resolve } from "path";

const REPO = resolve(import.meta.dir, "..", "..");

export interface FakeServer {
    /** The pretend server's home folder. */
    home: string;
    /** The stand-in for ssh: what CAVVY_SSH names while this server is the one in use. */
    bin: string;
    /** Makes every connection fail one way (undefined: connect normally again). */
    fail(kind?: "timeout" | "refused" | "dns" | "auth" | "closed"): void;
    /** The server starts offering another host key, as a rebuilt one would. */
    changeHostKey(): void;
    /** The key it first had, again. */
    restoreHostKey(): void;
    /** The server shows this key from now on (a public key's line): a new machine whose start-up script installed the identity it was given. */
    showHostKey(publicKey: string): void;
    /** What `ssh -G` says about the server, as lines ("userknownhostsfile /dev/null"); none: the usual. */
    settings(lines?: string[]): void;
    /** The pretend server's disk has this many MB free (undefined: as this machine's has). */
    diskFree(mb?: number): void;
    /** Commands' connections are lost this long after they start (undefined: they aren't). */
    dropSessions(afterMs?: number): void;
    /** Commands' connections are lost this long in without the server noticing: what they started runs on. */
    vanishSessions(afterMs?: number): void;
    /** With `systemd`: what was asked of the pretend service manager, in order ("enable cavvy.service"). */
    asked(): string[];
    /** With `systemd`: whether the server lets a user's services outlive their sign-in when asked. */
    allowLinger(yes: boolean): void;
    /** With `mac`: whether `sudo` there runs things without asking for a password. */
    allowSudo(yes: boolean): void;
    /** With `mac`: launchd there won't load a daemon, whoever asks (true), or will again. */
    refuseDaemon(yes: boolean): void;
    /** With `mac`: what was asked of the pretend launchd, in order ("user bootstrap user/501 <file>"; "root …" when through sudo). */
    launchd(): string[];
    /** With `mac`: where the pretend Mac keeps its LaunchDaemons. */
    daemons: string;
    /** With `mac`: how Xcode stands there. `hangs`: it's there and waits on a question at the Mac's screen. `broken`: it runs and its simulator tool doesn't. */
    xcode(state: "ready" | "missing" | "unopened" | "hangs" | "broken" | "no-simulator"): void;
    /** As if the user had connected to it before: its key is in the pretend known_hosts. */
    trust(host: string): void;
    knownHosts(): string;
    /** Every ssh command line so far. */
    calls(): { opts: Record<string, string>; flags: string[]; separated: boolean; dest: string; command?: string; forward?: string }[];
    /** Ends the tunnel that's up, as a dropped connection would. */
    dropTunnel(): boolean;
    /**
     * Connections started from now on are slow to be made: each waits, signed in and with nothing run yet, until
     * `release()`. After `only()`, ones started later go straight through while those already waiting still wait.
     */
    hold(): { only(): void; release(): void };
    /** Lets every waiting connection through, and no later one waits. */
    unhold(): void;
    /**
     * Puts a program on the pretend server's PATH, as a CLI installed there (`body` is a `sh` script), or takes it
     * away again with no body.
     */
    install(name: string, body?: string): void;
    /** A build of Cavvy to "install": this checkout, run from source. `gui`: with a GUI page beside it. */
    bundle(id: string, o?: { gui?: boolean; broken?: boolean }): { id: string; target: "linux-x64" | "darwin-arm64"; bundle: string; bundleBytes: number; sha256: string; gui: boolean };
    cleanup(): void;
}

function keygen(file: string) {
    const r = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "fake", "-f", file], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`ssh-keygen failed: ${r.stderr.toString()}`);
}

/**
 * `systemd`: the pretend server has a service manager, of a kind: it answers, records what it's asked, and says
 * whether lingering is on. It starts nothing itself, and lingering is refused until allowLinger(true), so Cavvy
 * there runs detached as on a server that refuses it.
 */
export function fakeSsh(o: { systemd?: boolean; mac?: boolean } = {}): FakeServer {
    // Short: a socket's path under it has to fit in 104 bytes on macOS.
    const dir = mkdtempSync("/tmp/cvr-");
    const home = join(dir, "home");
    mkdirSync(home);
    mkdirSync(join(dir, "bin"));
    // What's "installed" on the pretend server: on its Cavvy's PATH, and empty until a test puts something there.
    mkdirSync(join(dir, "tools"));
    keygen(join(dir, "hostkey"));
    const shim = (name: string, body: string) => {
        writeFileSync(join(dir, "bin", name), `#!/bin/sh\n${body}\n`);
        chmodSync(join(dir, "bin", name), 0o755);
    };
    // What the probe asks, answered as a Linux x64 server would, or a Mac.
    if (o.mac) shim("uname", 'case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; *) echo "Darwin fake 27.2.0 arm64" ;; esac');
    else shim("uname", 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo "Linux fake 6.8.0 x86_64" ;; esac');
    const daemons = join(dir, "LaunchDaemons");
    const mac = Boolean(o.mac);
    if (mac) {
        const q = JSON.stringify;
        mkdirSync(daemons);
        mkdirSync(join(dir, "Xcode.app", "Contents", "Developer"), { recursive: true });
        writeFileSync(join(dir, "xcode"), "ready");
        shim("sysctl", 'if [ "$2" = hw.memsize ]; then echo 17179869184; else exit 1; fi');
        shim("launchctl", `FAKE_DIR=${q(dir)} exec sh ${q(join(REPO, "test", "helpers", "fake-launchctl.sh"))} "$@"`);
        shim("sudo", `[ -f ${q(join(dir, "sudo-allowed"))} ] || { echo "sudo: a password is required" >&2; exit 1; }\n[ "$1" = "-n" ] && shift\nFAKE_SUDO=1 exec "$@"`);
        // Only as an administrator, as into /Library: the owner and mode it's asked for are taken as given.
        shim("install", '[ -n "$FAKE_SUDO" ] || { echo "install: Operation not permitted" >&2; exit 1; }\nwhile [ $# -gt 2 ]; do shift; done\ncp "$1" "$2"');
        const state = `$(cat ${q(join(dir, "xcode"))})`;
        shim("xcode-select", `if [ "${state}" = missing ]; then echo /Library/Developer/CommandLineTools; else echo ${q(join(dir, "Xcode.app", "Contents", "Developer"))}; fi`);
        // Not let run yet: killed as it starts with nobody at the Mac, left waiting when somebody is.
        shim("xcodebuild", `case "${state}" in unopened) kill -9 $$ ;; hangs) exec sleep 60 ;; esac\necho "Xcode 27.2"`);
        shim("xcrun", `case "${state}" in broken) exit 72 ;; esac\necho "== Runtimes =="\necho "watchOS 27.2 (27.2 - 24S5) - com.apple.CoreSimulator.SimRuntime.watchOS-27-2"\n[ "${state}" = no-simulator ] || echo "iOS 27.2 (27.2 - 24C5) - com.apple.CoreSimulator.SimRuntime.iOS-27-2"`);
    }
    // A login shell that says nothing, so the system's profile can't add this machine's tools to the pretend server's PATH.
    shim("quiet-shell", "exit 0");
    if (o.systemd) {
        shim("systemctl", `[ "$1 $2" = "--user show-environment" ] && exit 0\nshift\necho "$*" >> ${JSON.stringify(join(dir, "systemctl.log"))}\nexit 0`);
        shim(
            "loginctl",
            `f=${JSON.stringify(join(dir, "linger"))}\ncase "$1" in\n  show-user) cat "$f" 2>/dev/null || echo no ;;\n  enable-linger) [ -f ${JSON.stringify(join(dir, "linger-allowed"))} ] || exit 1; echo yes > "$f" ;;\n  *) exit 1 ;;\nesac`,
        );
    } else {
        // No service manager, on any machine the tests run on: Cavvy runs detached (the real one is tried on a real server).
        shim("systemctl", "exit 1");
        shim("loginctl", "exit 1");
    }
    shim("getconf", 'if [ "$1" = GNU_LIBC_VERSION ]; then echo "glibc 2.39"; else PATH="$FAKE_REAL_PATH" exec getconf "$@"; fi');
    const bin = join(dir, "ssh");
    writeFileSync(bin, `#!/bin/sh\n${o.mac ? `CAVVY_LAUNCH_DAEMONS=${JSON.stringify(daemons)} ` : ""}FAKE_SSH_DIR=${JSON.stringify(dir)} exec ${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(join(REPO, "test", "helpers", "fake-ssh-main.ts"))} "$@"\n`);
    chmodSync(bin, 0o755);
    process.env.CAVVY_SSH = bin;

    const behaviorFile = join(dir, "behavior.json");
    const behavior: Record<string, unknown> = {};
    let rebuilt = 0;
    const held: string[] = [];
    const save = () => writeFileSync(behaviorFile, JSON.stringify(behavior));
    const hostKey = () => readFileSync(join(dir, "hostkey.pub"), "utf-8").trim().split(" ").slice(0, 2).join(" ");

    return {
        home,
        bin,
        fail(kind) {
            behavior.fail = kind;
            save();
        },
        changeHostKey() {
            const file = join(dir, `hostkey-${++rebuilt}`);
            keygen(file);
            behavior.hostKey = readFileSync(`${file}.pub`, "utf-8").trim().split(" ").slice(0, 2).join(" ");
            save();
        },
        restoreHostKey() {
            delete behavior.hostKey;
            save();
        },
        showHostKey(publicKey) {
            behavior.hostKey = publicKey.trim().split(" ").slice(0, 2).join(" ");
            save();
        },
        settings(lines) {
            behavior.settings = lines;
            save();
        },
        diskFree(mb) {
            if (mb === undefined) rmSync(join(dir, "bin", "df"), { force: true });
            else shim("df", `echo "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/fake 100000000 1 ${mb * 1024} 1% /"`);
        },
        hold() {
            const file = join(dir, `release-${++rebuilt}`);
            held.push(file);
            behavior.holdUntil = file;
            save();
            const only = () => {
                if (behavior.holdUntil === file) delete behavior.holdUntil;
                save();
            };
            return {
                only,
                release() {
                    writeFileSync(file, "");
                    only();
                },
            };
        },
        unhold() {
            for (const file of held) writeFileSync(file, "");
            delete behavior.holdUntil;
            save();
        },
        install(name, body) {
            const file = join(dir, "tools", name);
            if (body === undefined) return rmSync(file, { force: true });
            writeFileSync(file, `#!/bin/sh\n${body}\n`);
            chmodSync(file, 0o755);
        },
        dropSessions(afterMs) {
            behavior.dropSessionAfterMs = afterMs;
            save();
        },
        vanishSessions(afterMs) {
            behavior.vanishSessionAfterMs = afterMs;
            save();
        },
        asked: () =>
            existsSync(join(dir, "systemctl.log"))
                ? readFileSync(join(dir, "systemctl.log"), "utf-8")
                      .split("\n")
                      .filter(Boolean)
                : [],
        allowLinger(yes) {
            if (yes) writeFileSync(join(dir, "linger-allowed"), "");
            else rmSync(join(dir, "linger-allowed"), { force: true });
        },
        allowSudo(yes) {
            if (yes) writeFileSync(join(dir, "sudo-allowed"), "");
            else rmSync(join(dir, "sudo-allowed"), { force: true });
        },
        refuseDaemon(yes) {
            if (yes) writeFileSync(join(dir, "refuse-daemon"), "");
            else rmSync(join(dir, "refuse-daemon"), { force: true });
        },
        launchd: () =>
            existsSync(join(dir, "launchctl.log"))
                ? readFileSync(join(dir, "launchctl.log"), "utf-8")
                      .split("\n")
                      .filter(Boolean)
                : [],
        daemons,
        xcode(state) {
            writeFileSync(join(dir, "xcode"), state);
        },
        trust(host) {
            writeFileSync(join(dir, "known_hosts"), `${host} ${hostKey()}\n`, { flag: "a" });
        },
        knownHosts: () => (existsSync(join(dir, "known_hosts")) ? readFileSync(join(dir, "known_hosts"), "utf-8") : ""),
        calls: () =>
            existsSync(join(dir, "calls.jsonl"))
                ? readFileSync(join(dir, "calls.jsonl"), "utf-8")
                      .split("\n")
                      .filter(Boolean)
                      .map((l) => JSON.parse(l))
                : [],
        dropTunnel() {
            try {
                process.kill(Number(readFileSync(join(dir, "tunnel.pid"), "utf-8")), "SIGKILL");
                rmSync(join(dir, "tunnel.pid"), { force: true });
                return true;
            } catch {
                return false;
            }
        },
        bundle(id, o = {}) {
            const stage = mkdtempSync(join(dir, "stage-"));
            // The system's own tools and what a test installed (install()), with a login shell that adds nothing: the
            // pretend server has no agent CLIs of its own, whatever is installed on the machine the tests run on.
            const program = o.broken
                ? "#!/bin/sh\necho 'cannot execute binary file: Exec format error' >&2\nexit 126\n"
                : `#!/bin/sh\nPATH=${join(dir, "tools")}:/usr/bin:/bin:/usr/sbin:/sbin; SHELL=${join(dir, "bin", "quiet-shell")}; CAVVY_BUILD=${id}; CAVVY_GUI_DIST="$(dirname "$0")/gui"; CAVVY_SERVER_PROGRAM="$0"; export PATH SHELL CAVVY_BUILD CAVVY_GUI_DIST CAVVY_SERVER_PROGRAM\nexec ${JSON.stringify(process.execPath)} --no-env-file --config=${JSON.stringify(join(REPO, "bunfig.toml"))} ${JSON.stringify(join(REPO, "src", "index.ts"))} "$@"\n`;
            writeFileSync(join(stage, "cavvy"), program);
            chmodSync(join(stage, "cavvy"), 0o755);
            if (o.gui) {
                mkdirSync(join(stage, "gui"));
                writeFileSync(join(stage, "gui", "index.html"), "<!doctype html><title>Cavvy</title><div id=\"root\"></div>\n");
            }
            const bundle = join(dir, `bundle-${id}-${o.gui ? "gui" : "plain"}.tar.gz`);
            const tar = Bun.spawnSync(["tar", "-czf", bundle, "-C", stage, "cavvy", ...(o.gui ? ["gui"] : [])], { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: { ...process.env, COPYFILE_DISABLE: "1" } as Record<string, string> });
            if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
            return { id, target: mac ? "darwin-arm64" : "linux-x64", bundle, bundleBytes: readFileSync(bundle).length, sha256: createHash("sha256").update(program).digest("hex"), gui: Boolean(o.gui) };
        },
        cleanup() {
            delete process.env.CAVVY_SSH;
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
