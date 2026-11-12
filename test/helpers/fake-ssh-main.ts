// The program behind test/helpers/fake-ssh.ts: what `ssh` is while a test runs.
//
// It takes ssh's own command line and does, on this machine, what ssh would
// have a server do: a command runs under `sh` with HOME set to the pretend
// server's home; `-N -L` carries a local port to another; and it fails the
// ways ssh fails, in ssh's own words (copied from OpenSSH's output), when the
// test says so or when the pretend server's host key isn't in the pretend
// known_hosts. It reads nothing of the real ~/.ssh and opens no connection.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { connect, createServer } from "net";
import { join } from "path";

const dir = process.env.FAKE_SSH_DIR!;
const argv = process.argv.slice(2);

const opts = new Map<string, string>();
const flags = new Set<string>();
let port: string | undefined;
let forward: string | undefined;
let i = 0;
for (; i < argv.length && argv[i] !== "--"; i++) {
    const a = argv[i]!;
    if (a === "-o") {
        const kv = argv[++i]!;
        const eq = kv.indexOf("=");
        opts.set(kv.slice(0, eq), kv.slice(eq + 1));
    } else if (a === "-p") port = argv[++i];
    else if (a === "-i") opts.set("IdentityFile", argv[++i]!);
    else if (a === "-L") forward = argv[++i];
    else flags.add(a);
}
const separated = argv[i] === "--";
const dest = argv[i + 1] ?? "";
const command = argv[i + 2];
const host = dest.slice(dest.lastIndexOf("@") + 1);

interface Behavior {
    /** Fail every connection this way. */
    fail?: "timeout" | "refused" | "dns" | "auth" | "closed";
    /** The key the server offers (a public key line's type and base64), when it isn't the first one it had. */
    hostKey?: string;
    /** What `ssh -G` says, in place of the usual: lines like "userknownhostsfile /dev/null". */
    settings?: string[];
    /** A command's connection is lost this many milliseconds in. */
    dropSessionAfterMs?: number;
    /**
     * A command's connection is lost this many milliseconds in without the server noticing (a laptop closing, a
     * network going): ssh gives up here, and what was running at the other end runs on.
     */
    vanishSessionAfterMs?: number;
    /** A connection that's slow to be made: having got as far as signing in, it waits until this file is there. */
    holdUntil?: string;
}
const behavior: Behavior = existsSync(join(dir, "behavior.json")) ? JSON.parse(readFileSync(join(dir, "behavior.json"), "utf-8")) : {};
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ opts: Object.fromEntries(opts), flags: [...flags], port, forward, separated, dest, command }) + "\n");

const fail = (text: string): never => {
    process.stderr.write(text + "\n");
    process.exit(255);
};

// As ssh does: the file named on the command line, else the one its settings name, else the usual one.
const said = (key: string) => behavior.settings?.find((l) => l.toLowerCase().startsWith(`${key} `))?.slice(key.length + 1).split(" ")[0];
const knownHosts = opts.get("UserKnownHostsFile") && opts.get("StrictHostKeyChecking") === "yes" ? opts.get("UserKnownHostsFile")! : (said("userknownhostsfile") ?? join(dir, "known_hosts"));
if (flags.has("-G")) {
    const lines = [`hostname ${host}`, ...(port ? [`port ${port}`] : []), ...(behavior.settings ?? [])];
    if (!said("userknownhostsfile")) lines.push(`userknownhostsfile ${knownHosts} ${knownHosts}2`);
    process.stdout.write(lines.join("\n") + "\n");
    process.exit(0);
}

if (behavior.fail === "timeout") fail(`ssh: connect to host ${host} port ${port ?? 22}: Operation timed out`);
if (behavior.fail === "refused") fail(`ssh: connect to host ${host} port ${port ?? 22}: Connection refused`);
if (behavior.fail === "dns") fail(`ssh: Could not resolve hostname ${host}: nodename nor servname provided, or not known`);
if (behavior.fail === "closed") fail(`kex_exchange_identification: Connection closed by remote host\nConnection closed by ${host} port ${port ?? 22}`);

// The host key comes before signing in, as it does with ssh.
const offered = behavior.hostKey ?? readFileSync(join(dir, "hostkey.pub"), "utf-8").trim().split(" ").slice(0, 2).join(" ");
const name = port && port !== "22" ? `[${host}]:${port}` : host;
if (opts.get("StrictHostKeyChecking") === "no" && opts.get("UserKnownHostsFile")) {
    // The look at a key ssh doesn't know: it's written where asked, and nothing signs in.
    writeFileSync(opts.get("UserKnownHostsFile")!, `${name} ${offered}\n`);
    process.stderr.write(`Warning: Permanently added '${name}' (ED25519) to the list of known hosts.\n`);
    fail(`${dest}: Permission denied (publickey).`);
}
const known = knownHosts !== "/dev/null" && existsSync(knownHosts)
    ? readFileSync(knownHosts, "utf-8")
          .split("\n")
          .filter((l) => l.split(" ")[0] === name)
    : [];
if (opts.get("StrictHostKeyChecking") !== "yes") fail("fake ssh: a connection that would accept a host key by itself");
if (!known.length) fail(`No ED25519 host key is known for ${name} and you have requested strict checking.\nHost key verification failed.`);
if (!known.some((l) => l.split(" ").slice(1, 3).join(" ") === offered)) {
    fail(
        [
            "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
            "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
            "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
            "IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!",
            "Someone could be eavesdropping on you right now (man-in-the-middle attack)!",
            "It is also possible that a host key has just been changed.",
            "The fingerprint for the ED25519 key sent by the remote host is",
            "SHA256:0000000000000000000000000000000000000000000.",
            "Please contact your system administrator.",
            `Add correct host key in ${knownHosts} to get rid of this message.`,
            `Offending ED25519 key in ${knownHosts}:1`,
            `Host key for ${name} has changed and you have requested strict checking.`,
            "Host key verification failed.",
        ].join("\n"),
    );
}
if (opts.get("BatchMode") !== "yes") fail("fake ssh: a connection that could stop to ask for a password");
if (behavior.fail === "auth") fail(`${dest}: Permission denied (publickey).`);

if (behavior.holdUntil) while (!existsSync(behavior.holdUntil)) await Bun.sleep(20);

if (flags.has("-N")) {
    // -L 127.0.0.1:<local>:127.0.0.1:<remote>
    const parts = (forward ?? "").split(":");
    const local = Number(parts[1]);
    const remote = Number(parts[3]);
    const server = createServer((from) => {
        const to = connect(remote, "127.0.0.1");
        from.pipe(to);
        to.pipe(from);
        const end = () => {
            from.destroy();
            to.destroy();
        };
        from.on("error", end);
        to.on("error", end);
        from.on("close", end);
        to.on("close", end);
    });
    server.on("error", (e) => fail(`bind [127.0.0.1]:${local}: ${(e as NodeJS.ErrnoException).code === "EADDRINUSE" ? "Address already in use" : e.message}\nchannel_setup_fwd_listener_tcpip: cannot listen to port: ${local}\nCould not request local forwarding.`));
    server.listen(local, "127.0.0.1", () => writeFileSync(join(dir, "tunnel.pid"), String(process.pid)));
    process.on("SIGTERM", () => process.exit(0));
    await new Promise(() => {});
}

if (command === undefined) fail("fake ssh: no command, and no terminal to give a shell");
// The pretend server: its own home and nothing of the test's Cavvy home.
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !["CAVVY_HOME", "HARNESS_HOME", "FAKE_SSH_DIR", "CAVVY_SSH"].includes(k)) env[k] = v;
env.HOME = join(dir, "home");
env.PATH = `${join(dir, "bin")}:${process.env.PATH ?? ""}`;
env.FAKE_REAL_PATH = process.env.PATH ?? "";
// In a process group of its own, so that a lost connection can take everything it started with it, as a server
// does when a session's connection goes: where `sh` doesn't replace itself with the command (dash), killing `sh`
// alone would leave the command running, still holding this test's pipes open.
// One that will be left running takes nothing of this process's with it: it would hold the test's pipes open.
const child = spawn("sh", ["-c", command!], { stdio: behavior.vanishSessionAfterMs !== undefined ? "ignore" : "inherit", env, cwd: env.HOME, detached: true });
const exited = new Promise<number>((resolve) => child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1))));
if (behavior.dropSessionAfterMs !== undefined) {
    setTimeout(() => {
        try {
            process.kill(-child.pid!, "SIGKILL");
        } catch {
            // already gone
        }
        fail("client_loop: send disconnect: Broken pipe");
    }, behavior.dropSessionAfterMs);
}
if (behavior.vanishSessionAfterMs !== undefined) {
    setTimeout(() => {
        child.unref();
        fail(`Timeout, server ${host} not responding.`);
    }, behavior.vanishSessionAfterMs);
}
process.exit(await exited);
