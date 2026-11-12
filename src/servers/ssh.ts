// Running the system's ssh for a server (src/servers/store.ts), so ~/.ssh/config,
// the agent and jump hosts apply as they do in a terminal.
//
// What it never does:
//   - ask for a password or passphrase (BatchMode): nobody may be at a terminal;
//   - accept a host key by itself (StrictHostKeyChecking=yes). A key ssh doesn't
//     know is shown to the user, and saved only when they say to (trustHostKey);
//     one that changed is refused, with the command that removes the old one;
//   - let a destination be read as an option (`--` before it, and store.ts checks it).

import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { childEnv } from "../util/env";
import { ServerError, type ServerEntry } from "./store";

export type SshFailure =
    | "no-ssh"
    /** No answer, refused, or the name doesn't resolve: trying again later may work. */
    | "unreachable"
    | "auth"
    | "passphrase"
    | "identity"
    | "host-unknown"
    | "host-changed"
    | "other";

export class SshError extends ServerError {
    constructor(
        readonly kind: SshFailure,
        message: string,
        /** ssh's own words, for the line under the message. */
        readonly detail?: string,
        /** A command that puts it right. */
        readonly fix?: string,
    ) {
        super(message);
    }

    /** Nothing changes until the user does something: don't try again by itself. */
    get permanent(): boolean {
        return this.kind !== "unreachable" && this.kind !== "other";
    }
}

/** The machine's name in a destination, for messages. */
export function hostOf(e: Pick<ServerEntry, "destination">): string {
    return e.destination.slice(e.destination.lastIndexOf("@") + 1);
}

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function sshBin(): string {
    const bin = process.env.CAVVY_SSH || Bun.which("ssh", { PATH: process.env.PATH ?? "" });
    if (!bin) throw new SshError("no-ssh", "ssh isn't installed on this machine.");
    return bin;
}

/** Seconds without an answer before ssh gives a connection up (three of these in a row). */
const ALIVE_SECONDS = 10;

/** Options every connection gets. `forwardings`: the tunnel keeps the ones it asks for; a command drops any the config adds. */
function baseOptions(e: ServerEntry, o: { forwardings?: boolean } = {}): string[] {
    const opts = [
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        "ConnectTimeout=10",
        "ConnectionAttempts=1",
        `ServerAliveInterval=${ALIVE_SECONDS}`,
        "ServerAliveCountMax=3",
        "ForwardAgent=no",
        "ForwardX11=no",
        "PermitLocalCommand=no",
        // A connection of its own: not one a ControlMaster in the user's config shares, which would outlive it.
        "ControlMaster=no",
        "ControlPath=none",
        ...(o.forwardings ? ["ExitOnForwardFailure=yes"] : ["ClearAllForwardings=yes"]),
    ];
    const argv = opts.flatMap((x) => ["-o", x]);
    if (e.port) argv.push("-p", String(e.port));
    if (e.identityFile) argv.push("-i", expand(e.identityFile), "-o", "IdentitiesOnly=yes");
    return argv;
}

/** POSIX quoting: one word, whatever is in it. */
export function shQuote(s: string): string {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * A script for the server's `sh`, with its arguments ($1…), as the one command
 * ssh sends. The login shell there only has to run `sh -c '…'`, whichever it is.
 */
export function remoteSh(script: string, args: string[] = []): string {
    return ["sh", "-c", shQuote(script), "cavvy", ...args.map(shQuote)].join(" ");
}

/** argv for a command on the server. `tty`: an interactive one, on this terminal. */
export function sshCommandArgv(e: ServerEntry, command: string, o: { tty?: boolean } = {}): string[] {
    return [sshBin(), ...baseOptions(e), o.tty ? "-t" : "-T", "--", e.destination, command];
}

/** argv for a tunnel and nothing else: this machine's `local` port to the server's own `remote`. */
export function sshTunnelArgv(e: ServerEntry, local: number, remote: number): string[] {
    return [sshBin(), ...baseOptions(e, { forwardings: true }), "-N", "-T", "-L", `127.0.0.1:${local}:127.0.0.1:${remote}`, "--", e.destination];
}

const lines = (text: string) =>
    text
        .split("\n")
        .map((l) => l.replace(/\r$/, "").trim())
        .filter(Boolean);

/** ssh's own line about what went wrong: not its banners or warnings. */
function sshLine(stderr: string): string | undefined {
    const all = lines(stderr).filter((l) => !/^(Warning: Permanently added|\*\*|@@@|debug\d:)/.test(l));
    return (all.find((l) => /^ssh: |^ssh_|Permission denied|Host key verification failed|kex_|Connection (closed|reset|timed out|refused)|Too many authentication|Could not resolve|Bad (owner|configuration)|No such file|not accessible/i.test(l)) ?? all.at(-1))?.slice(0, 300);
}

/** Why ssh itself failed (exit 255), from what it wrote. */
export function sshFailure(stderr: string, e: ServerEntry): SshError {
    const host = hostOf(e);
    const detail = sshLine(stderr);
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .+ has changed|Offending .*key in /.test(stderr)) {
        const file = /Offending \S+ key in (.+?):\d+/.exec(stderr)?.[1];
        const known = /Host key for (\S+) has changed/.exec(stderr)?.[1] ?? host;
        const standard = !file || expand(file) === join(homedir(), ".ssh", "known_hosts");
        return new SshError("host-changed", `${host}'s identity changed.`, "If you rebuilt it, remove its old key, then add it again.", `ssh-keygen -R ${shQuote(known)}${standard ? "" : ` -f ${shQuote(file!)}`}`);
    }
    if (/Host key verification failed|No \S+ host key is known for|No host key is known for/.test(stderr)) return new SshError("host-unknown", `${host} isn't a server this machine has connected to before.`, detail);
    if (/Bad owner or permissions|UNPROTECTED PRIVATE KEY FILE|bad permissions/.test(stderr)) return new SshError("identity", e.identityFile ? `ssh won't use the key at ${e.identityFile}.` : "ssh won't use one of your SSH files.", detail);
    if (/no such identity|Identity file .* not accessible|Load key .*: (No such file|invalid format|error in libcrypto)/i.test(stderr) && e.identityFile) return new SshError("identity", `Can't read the key at ${e.identityFile}.`, detail);
    if (/Permission denied \(|Too many authentication failures|No more authentication methods|Authentication failed/.test(stderr)) {
        if (e.identityFile && keyNeedsPassphrase(e.identityFile)) return new SshError("passphrase", "This key needs its passphrase. Add it to ssh-agent, then retry.", detail, `ssh-add ${shQuote(e.identityFile)}`);
        return new SshError("auth", e.identityFile ? `${host} refused this key.` : `${host} refused your SSH keys.`, detail);
    }
    if (/Could not resolve hostname|Name or service not known|nodename nor servname|Temporary failure in name resolution|timed out|Connection refused|No route to host|Network is unreachable|Connection closed by|closed by remote host|Connection reset|kex_exchange_identification|Broken pipe|Host is down|Timeout, server .* not responding/i.test(stderr)) {
        return new SshError("unreachable", `Can't reach ${host}.`, detail);
    }
    if (/Killed by signal \d+/.test(stderr)) return new SshError("other", `The connection to ${host} was cut off.`);
    return new SshError("other", `Couldn't connect to ${host}.`, detail);
}

/** Whether a private key file is encrypted (so only an agent holding it can use it here). */
export function keyNeedsPassphrase(file: string): boolean {
    const keygen = Bun.which("ssh-keygen", { PATH: process.env.PATH ?? "" });
    const path = expand(file);
    if (!keygen || !existsSync(path)) return false;
    const r = Bun.spawnSync([keygen, "-y", "-P", "", "-f", path], { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: childEnv() });
    return r.exitCode !== 0 && /passphrase/i.test(r.stderr.toString());
}

export interface SshResult {
    /** The command's own exit code (ssh's failures throw). */
    code: number;
    stdout: string;
    stderr: string;
}

export interface SshRunOptions {
    /** Sent as the command's stdin. */
    stdin?: Uint8Array | AsyncIterable<Uint8Array>;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Bytes of `stdin` sent so far. */
    onSent?: (bytes: number) => void;
}

const OUTPUT_CAP = 4 * 1024 * 1024;

async function capped(stream: ReadableStream<Uint8Array>): Promise<string> {
    const d = new TextDecoder();
    let out = "";
    for await (const chunk of stream) if (out.length < OUTPUT_CAP) out += d.decode(chunk, { stream: true });
    return out.slice(0, OUTPUT_CAP);
}

/**
 * Runs a command on the server and waits for it. The command's own failure is
 * its exit code; a failure to connect, to sign in, or a connection lost part
 * way throws an SshError saying which.
 */
export async function ssh(e: ServerEntry, command: string, o: SshRunOptions = {}): Promise<SshResult> {
    const argv = sshCommandArgv(e, command);
    if (o.signal?.aborted) throw new SshError("other", "Stopped.");
    let proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
    try {
        proc = Bun.spawn(argv, { stdin: o.stdin ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe", env: childEnv() });
    } catch (err) {
        throw new SshError("no-ssh", `ssh couldn't start: ${(err as Error).message}`);
    }
    let timedOut = false;
    const kill = () => proc.kill();
    const timer = setTimeout(() => {
        timedOut = true;
        kill();
    }, o.timeoutMs ?? 60_000);
    o.signal?.addEventListener("abort", kill, { once: true });
    const feed = (async () => {
        if (!o.stdin) return;
        const sink = proc.stdin as import("bun").FileSink;
        let sent = 0;
        try {
            const chunks = o.stdin instanceof Uint8Array ? [o.stdin] : o.stdin;
            for await (const chunk of chunks) {
                // A write the pipe can't take at once is a promise, which fails when ssh has gone.
                await sink.write(chunk);
                await sink.flush();
                sent += chunk.byteLength;
                o.onSent?.(sent);
            }
        } catch {
            // it went away: its exit says why
        } finally {
            try {
                await sink.end();
            } catch {
                // already closed
            }
        }
    })();
    try {
        const [stdout, stderr, code] = await Promise.all([capped(proc.stdout), capped(proc.stderr), proc.exited, feed]);
        if (o.signal?.aborted) throw new SshError("other", "Stopped.");
        if (timedOut) throw new SshError("unreachable", `${hostOf(e)} didn't answer in time.`);
        if (code === 255) throw sshFailure(stderr, e);
        // ssh itself was killed (not by us): whatever it was doing didn't finish.
        if (proc.signalCode) throw new SshError("other", `The connection to ${hostOf(e)} was cut off.`);
        return { code, stdout, stderr };
    } finally {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", kill);
    }
}

/** Runs it and returns its output, or throws with what it wrote when it fails. */
export async function sshOk(e: ServerEntry, command: string, o: SshRunOptions = {}): Promise<string> {
    const r = await ssh(e, command, o);
    if (r.code !== 0) throw new ServerError(`A command on ${hostOf(e)} failed (${r.code}): ${(lines(r.stderr).at(-1) ?? lines(r.stdout).at(-1) ?? "no output").slice(0, 300)}`);
    return r.stdout;
}

// ---------------------------------------------------------------------------
// A host key ssh doesn't know yet.

export interface OfferedHostKey {
    /** As ssh would save them: the lines trustHostKey appends. */
    lines: string[];
    /** What to show: "SHA256:… (ED25519)". */
    fingerprints: string[];
}

/**
 * The key the server offers, without signing in or sending anything: ssh
 * connects with no way to authenticate, and writes the key to a file of its
 * own. Nothing is trusted by this.
 */
export async function offeredHostKey(e: ServerEntry, signal?: AbortSignal): Promise<OfferedHostKey> {
    const keygen = Bun.which("ssh-keygen", { PATH: process.env.PATH ?? "" });
    const dir = mkdtempSync(join(tmpdir(), "cavvy-hostkey-"));
    const file = join(dir, "known_hosts");
    try {
        const opts = ["BatchMode=yes", "StrictHostKeyChecking=no", `UserKnownHostsFile=${file}`, "GlobalKnownHostsFile=/dev/null", "PreferredAuthentications=none", "PubkeyAuthentication=no", "PasswordAuthentication=no", "KbdInteractiveAuthentication=no", "ConnectTimeout=10", "ConnectionAttempts=1", "ClearAllForwardings=yes", "ForwardAgent=no", "UpdateHostKeys=no", "ControlMaster=no", "ControlPath=none"];
        const argv = [sshBin(), ...opts.flatMap((x) => ["-o", x]), ...(e.port ? ["-p", String(e.port)] : []), "-T", "--", e.destination, "true"];
        const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: childEnv() });
        const kill = () => proc.kill();
        const timer = setTimeout(kill, 30_000);
        signal?.addEventListener("abort", kill, { once: true });
        const [stderr] = await Promise.all([capped(proc.stderr), proc.exited]);
        clearTimeout(timer);
        signal?.removeEventListener("abort", kill);
        const saved = existsSync(file) ? lines(readFileSync(file, "utf-8")).filter((l) => !l.startsWith("#")) : [];
        if (!saved.length) throw sshFailure(stderr, e);
        const fingerprints: string[] = [];
        if (keygen) {
            const r = Bun.spawnSync([keygen, "-l", "-f", file], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: childEnv() });
            // "256 SHA256:… host (ED25519)"
            for (const l of lines(r.stdout.toString())) {
                const m = /^\d+\s+(\S+)\s.*\((\S+)\)$/.exec(l);
                if (m) fingerprints.push(`${m[1]} (${m[2]})`);
            }
        }
        if (!fingerprints.length) throw new ServerError(`Couldn't read ${hostOf(e)}'s key.`);
        return { lines: saved, fingerprints };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** Where ssh keeps the hosts this user trusts for that destination. */
function knownHostsFile(e: ServerEntry): string {
    try {
        const r = Bun.spawnSync([sshBin(), "-G", ...(e.port ? ["-p", String(e.port)] : []), "--", e.destination], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: childEnv() });
        const first = /^userknownhostsfile\s+(\S+)/im.exec(r.stdout.toString())?.[1];
        if (first && first !== "/dev/null") return expand(first);
    } catch {
        // the usual place
    }
    return join(homedir(), ".ssh", "known_hosts");
}

/** The user said to trust it: the key they were shown is saved, and only that one. */
export function trustHostKey(e: ServerEntry, key: OfferedHostKey) {
    const file = knownHostsFile(e);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const fresh = !existsSync(file);
    const before = fresh ? "" : readFileSync(file, "utf-8");
    appendFileSync(file, (before && !before.endsWith("\n") ? "\n" : "") + key.lines.join("\n") + "\n", { mode: 0o600 });
    if (fresh) chmodSync(file, 0o600);
}
