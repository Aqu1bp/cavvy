// A pretend server for tests of src/servers: `ssh` is replaced (CAVVY_SSH)
// by a program that runs each "remote" command on this machine, in a home
// folder of the pretend server's own (fake-ssh-main.ts). The Cavvy "installed"
// there is this checkout's, run from source, so the real server code answers.
//
// The pretend server reports itself as Linux x64 with glibc whatever this
// machine is, so the flow is the same on a Mac and in CI.
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
    /** As if the user had connected to it before: its key is in the pretend known_hosts. */
    trust(host: string): void;
    knownHosts(): string;
    /** Every ssh command line so far. */
    calls(): { opts: Record<string, string>; flags: string[]; separated: boolean; dest: string; command?: string; forward?: string }[];
    /** Ends the tunnel that's up, as a dropped connection would. */
    dropTunnel(): boolean;
    /** A build of Cavvy to "install": this checkout, run from source. `gui`: with a GUI page beside it. */
    bundle(id: string, o?: { gui?: boolean; broken?: boolean }): { id: string; target: "linux-x64"; bundle: string; bundleBytes: number; sha256: string; gui: boolean };
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
export function fakeSsh(o: { systemd?: boolean } = {}): FakeServer {
    // Short: a socket's path under it has to fit in 104 bytes on macOS.
    const dir = mkdtempSync("/tmp/cvr-");
    const home = join(dir, "home");
    mkdirSync(home);
    mkdirSync(join(dir, "bin"));
    keygen(join(dir, "hostkey"));
    const shim = (name: string, body: string) => {
        writeFileSync(join(dir, "bin", name), `#!/bin/sh\n${body}\n`);
        chmodSync(join(dir, "bin", name), 0o755);
    };
    // What the probe asks, answered as a Linux x64 server would.
    shim("uname", 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo "Linux fake 6.8.0 x86_64" ;; esac');
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
    writeFileSync(bin, `#!/bin/sh\nFAKE_SSH_DIR=${JSON.stringify(dir)} exec ${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(join(REPO, "test", "helpers", "fake-ssh-main.ts"))} "$@"\n`);
    chmodSync(bin, 0o755);
    process.env.CAVVY_SSH = bin;

    const behaviorFile = join(dir, "behavior.json");
    const behavior: Record<string, unknown> = {};
    let rebuilt = 0;
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
        settings(lines) {
            behavior.settings = lines;
            save();
        },
        diskFree(mb) {
            if (mb === undefined) rmSync(join(dir, "bin", "df"), { force: true });
            else shim("df", `echo "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/fake 100000000 1 ${mb * 1024} 1% /"`);
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
            // The system's own tools and no more, with a login shell that adds nothing: the pretend server has no agent
            // CLIs, whatever is installed on the machine the tests run on.
            const program = o.broken
                ? "#!/bin/sh\necho 'cannot execute binary file: Exec format error' >&2\nexit 126\n"
                : `#!/bin/sh\nPATH=/usr/bin:/bin:/usr/sbin:/sbin; SHELL=${join(dir, "bin", "quiet-shell")}; CAVVY_BUILD=${id}; CAVVY_GUI_DIST="$(dirname "$0")/gui"; export PATH SHELL CAVVY_BUILD CAVVY_GUI_DIST\nexec ${JSON.stringify(process.execPath)} --no-env-file --config=${JSON.stringify(join(REPO, "bunfig.toml"))} ${JSON.stringify(join(REPO, "src", "index.ts"))} "$@"\n`;
            writeFileSync(join(stage, "cavvy"), program);
            chmodSync(join(stage, "cavvy"), 0o755);
            if (o.gui) {
                mkdirSync(join(stage, "gui"));
                writeFileSync(join(stage, "gui", "index.html"), "<!doctype html><title>Cavvy</title><div id=\"root\"></div>\n");
            }
            const bundle = join(dir, `bundle-${id}-${o.gui ? "gui" : "plain"}.tar.gz`);
            const tar = Bun.spawnSync(["tar", "-czf", bundle, "-C", stage, "cavvy", ...(o.gui ? ["gui"] : [])], { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: { ...process.env, COPYFILE_DISABLE: "1" } as Record<string, string> });
            if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
            return { id, target: "linux-x64", bundle, bundleBytes: readFileSync(bundle).length, sha256: createHash("sha256").update(program).digest("hex"), gui: Boolean(o.gui) };
        },
        cleanup() {
            delete process.env.CAVVY_SSH;
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
