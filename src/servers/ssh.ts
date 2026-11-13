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
import { cavvyHome } from "../config/paths";
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
        // The command is Cavvy's, whatever the user's config would run there.
        "RemoteCommand=none",
        // A connection of its own: not one a ControlMaster in the user's config shares, which would outlive it.
        "ControlMaster=no",
        "ControlPath=none",
        ...(o.forwardings ? ["ExitOnForwardFailure=yes"] : ["ClearAllForwardings=yes"]),
    ];
    // Where this server's key was saved, when the user's config keeps none for it (trustHostKey).
    if (e.knownHostsFile) opts.push(`UserKnownHostsFile=${expand(e.knownHostsFile)}`);
    const argv = opts.flatMap((x) => ["-o", x]);
    if (e.port) argv.push("-p", String(e.port));
    if (e.identityFile) argv.push("-i", expand(e.identityFile), "-o", "IdentitiesOnly=yes");
    return argv;
}

/** POSIX quoting: one word, whatever is in it. */
export function shQuote(s: string): string {
    // Not `=`: zsh reads a word that starts with one as a command to look up.
    return /^[A-Za-z0-9_@%+:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * A script for the server's `sh`, with its arguments ($1…), as the one command
 * ssh sends. The login shell there only has to run `sh -c '…'`: sh, bash, zsh,
 * dash and ksh read that as written. csh and tcsh can't take a quoted string
 * of several lines (probeServer says so), and fish reads `\\` inside quotes as
 * one backslash, so an argument with two in a row arrives with one there.
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

/** Text from a server or from ssh, safe to print: no control characters (a hostile server would draw on the terminal with them). */
export function printable(text: string, max = 300): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").slice(0, max);
}

/** ssh's own line about what went wrong: not its banners or warnings. */
function sshLine(stderr: string): string | undefined {
    const all = lines(printable(stderr, 8000)).filter((l) => !/^(Warning: Permanently added|\*\*|@@@|debug\d:)/.test(l));
    return (all.find((l) => /^ssh: |^ssh_|Permission denied|Host key verification failed|kex_|Connection (closed|reset|timed out|refused)|Too many authentication|Could not resolve|Bad (owner|configuration)|No such file|not accessible/i.test(l)) ?? all.at(-1))?.slice(0, 300);
}

/** What ssh would do for this server, by its own account (`ssh -G`): each setting's values. Empty when ssh can't say. */
function sshSettings(e: ServerEntry): Map<string, string[]> {
    const out = new Map<string, string[]>();
    try {
        const r = Bun.spawnSync([sshBin(), "-G", ...(e.port ? ["-p", String(e.port)] : []), "--", e.destination], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: childEnv() });
        for (const line of lines(r.stdout.toString())) {
            const i = line.indexOf(" ");
            if (i <= 0) continue;
            const key = line.slice(0, i).toLowerCase();
            out.set(key, [...(out.get(key) ?? []), line.slice(i + 1).trim()]);
        }
    } catch {
        // nothing known
    }
    return out;
}

/** The name ssh keeps this server's key under. */
function knownName(e: ServerEntry): string {
    const cfg = sshSettings(e);
    const alias = cfg.get("hostkeyalias")?.[0];
    if (alias) return alias;
    const host = cfg.get("hostname")?.[0] ?? hostOf(e);
    const port = Number(cfg.get("port")?.[0] ?? e.port ?? 22);
    return port && port !== 22 ? `[${host}]:${port}` : host;
}

function tool(name: string): string | undefined {
    return Bun.which(name, { PATH: process.env.PATH ?? "" }) ?? undefined;
}

function output(argv: string[], env: Record<string, string> = {}): string | undefined {
    try {
        const r = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...childEnv(), ...env } });
        return r.exitCode === 0 ? r.stdout.toString() : undefined;
    } catch {
        return undefined;
    }
}

/**
 * A key file ssh would use for this server that's encrypted and that no agent
 * holds: nothing can use it without its passphrase, which Cavvy never asks for.
 */
function lockedKey(e: ServerEntry): string | undefined {
    const keygen = tool("ssh-keygen");
    if (!keygen) return undefined;
    const cfg = sshSettings(e);
    const files = (e.identityFile ? [e.identityFile] : (cfg.get("identityfile") ?? [])).filter((f) => existsSync(expand(f)));
    if (!files.length) return undefined;
    const add = tool("ssh-add");
    // The agent ssh itself would ask for this server: one its config names (a password manager's), none, or the usual.
    const named = cfg.get("identityagent")?.[0];
    const agent = named === undefined || named === "SSH_AUTH_SOCK" ? process.env.SSH_AUTH_SOCK : named === "none" ? undefined : expand(named);
    // "256 SHA256:… comment (ED25519)": what that agent holds, by fingerprint.
    const listed = add && agent ? (output([add, "-l"], { SSH_AUTH_SOCK: agent }) ?? "") : "";
    const held = new Set(listed.split("\n").map((l) => l.split(" ")[1]).filter(Boolean));
    for (const f of files) {
        if (!keyNeedsPassphrase(f)) continue;
        const print = output([keygen, "-l", "-f", expand(f)])?.split(" ")[1];
        if (!print || !held.has(print)) return f;
    }
    return undefined;
}

/** Why ssh itself failed (exit 255), from what it wrote. */
export function sshFailure(stderr: string, e: ServerEntry): SshError {
    const host = hostOf(e);
    const detail = sshLine(stderr);
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .+ has changed|Offending .*key in /.test(stderr)) {
        // The name and the file are this machine's own account of that server, never what the failure's text names:
        // a server's command can print these lines too, and would have the user forget some other host's key.
        const file = e.knownHostsFile ?? sshSettings(e).get("userknownhostsfile")?.[0]?.split(" ")[0];
        const standard = !file || expand(file) === join(homedir(), ".ssh", "known_hosts");
        return new SshError("host-changed", `${host}'s identity changed.`, "If you rebuilt it, remove its old key, then add it again.", `ssh-keygen -R ${shQuote(knownName(e))}${standard ? "" : ` -f ${shQuote(file!)}`}`);
    }
    if (/Host key verification failed|No \S+ host key is known for|No host key is known for/.test(stderr)) return new SshError("host-unknown", `${host} isn't a server this machine has connected to before.`, detail);
    if (/Bad owner or permissions|UNPROTECTED PRIVATE KEY FILE|bad permissions/.test(stderr)) return new SshError("identity", e.identityFile ? `ssh won't use the key at ${e.identityFile}.` : "ssh won't use one of your SSH files.", detail);
    if (/no such identity|Identity file .* not accessible|Load key .*: (No such file|invalid format|error in libcrypto)/i.test(stderr) && e.identityFile) return new SshError("identity", `Can't read the key at ${e.identityFile}.`, detail);
    if (/Permission denied \(|Too many authentication failures|No more authentication methods|Authentication failed/.test(stderr)) {
        const locked = lockedKey(e);
        if (locked) return new SshError("passphrase", `${e.identityFile ? "This key" : "Your SSH key"} needs its passphrase. Add it to ssh-agent, then retry.`, detail, `ssh-add ${shQuote(locked)}`);
        return new SshError("auth", e.identityFile ? `${host} refused this key.` : `${host} refused your SSH keys.`, detail);
    }
    // Whatever kept the connection from being made: the reason varies with the system and how it's off the network.
    if (/^ssh: connect to host /m.test(stderr) || /Could not resolve hostname|Name or service not known|nodename nor servname|Temporary failure in name resolution|timed out|Connection refused|No route to host|Network is (unreachable|down)|Connection closed by|closed by remote host|Connection reset|Connection abort|kex_exchange_identification|Broken pipe|Host is down|Timeout, server .* not responding/i.test(stderr)) {
        return new SshError("unreachable", `Can't reach ${host}.`, detail);
    }
    // By the name the user gave it, not its address: this is said of a server they already use.
    if (/Killed by signal \d+/.test(stderr)) return new SshError("other", `The connection to ${e.name || host} was cut off.`);
    return new SshError("other", `Couldn't connect to ${host}.`, detail);
}

/** Whether a private key file is encrypted (so only an agent holding it can use it here). */
export function keyNeedsPassphrase(file: string): boolean {
    const keygen = tool("ssh-keygen");
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
    /**
     * What the command has printed, as it arrives, and once more with `done` when there's no more to come (also
     * when it never connected). For a command that's answered part way: `stdin` can wait on what this hears.
     */
    onStdout?: (text: string, done: boolean) => void;
}

const OUTPUT_CAP = 4 * 1024 * 1024;

async function capped(stream: ReadableStream<Uint8Array>, heard?: (text: string, done: boolean) => void): Promise<string> {
    const d = new TextDecoder();
    let out = "";
    try {
        for await (const chunk of stream) {
            if (out.length >= OUTPUT_CAP) continue;
            const text = d.decode(chunk, { stream: true });
            out += text;
            heard?.(text, false);
        }
    } finally {
        heard?.("", true);
    }
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
        const [stdout, stderr, code] = await Promise.all([capped(proc.stdout, o.onStdout), capped(proc.stderr), proc.exited, feed]);
        if (o.signal?.aborted) throw new SshError("other", "Stopped.");
        if (timedOut) throw new SshError("unreachable", `${hostOf(e)} didn't answer in time.`);
        if (code === 255) throw sshFailure(stderr, e);
        // ssh itself was killed (not by us): whatever it was doing didn't finish.
        if (proc.signalCode) throw new SshError("other", `The connection to ${e.name || hostOf(e)} was cut off.`);
        return { code, stdout, stderr };
    } finally {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", kill);
    }
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
        const opts = ["BatchMode=yes", "StrictHostKeyChecking=no", `UserKnownHostsFile=${file}`, "GlobalKnownHostsFile=/dev/null", "PreferredAuthentications=none", "PubkeyAuthentication=no", "PasswordAuthentication=no", "KbdInteractiveAuthentication=no", "ConnectTimeout=10", "ConnectionAttempts=1", "ClearAllForwardings=yes", "ForwardAgent=no", "UpdateHostKeys=no", "ControlMaster=no", "ControlPath=none", "RemoteCommand=none", "PermitLocalCommand=no"];
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

/** Cavvy's own list of servers' keys, for a server whose keys the user's ssh config keeps nowhere. */
export const ownKnownHosts = () => join(cavvyHome(), "known_hosts");

/**
 * The user said to trust it: the key they were shown is saved, and only that
 * one, where ssh keeps this user's keys for that server. Where their config
 * keeps none (`UserKnownHostsFile /dev/null`, as for machines that come and
 * go), it goes in Cavvy's own file, and the entry says so (`knownHostsFile`),
 * since Cavvy's connections check the key every time.
 */
export function trustHostKey<T extends ServerEntry>(e: T, key: OfferedHostKey): T {
    const configured = e.knownHostsFile ?? sshSettings(e).get("userknownhostsfile")?.[0]?.split(" ")[0];
    const own = configured === "/dev/null" || configured === "none";
    const file = own ? ownKnownHosts() : expand(configured ?? join("~", ".ssh", "known_hosts"));
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const fresh = !existsSync(file);
    const before = fresh ? "" : readFileSync(file, "utf-8");
    const have = new Set(lines(before));
    const add = key.lines.filter((l) => !have.has(l));
    if (add.length) appendFileSync(file, (before && !before.endsWith("\n") ? "\n" : "") + add.join("\n") + "\n", { mode: 0o600 });
    if (fresh) chmodSync(file, 0o600);
    return own ? { ...e, knownHostsFile: file } : e;
}
