// Keys Cavvy makes for a server an agent is about to create, so that adding
// it needs no key file and asks no "Trust this host?": the key Cavvy signs in
// with, and the server's own identity (its host key). Both go to the new
// machine in its start-up script (cloud-init's user data), so this machine
// knows the server's fingerprint before it first connects.
//
// The private half of the sign-in key stays in ~/.cavvy/server-keys, which
// only Cavvy reads. The start-up script holds the server's private host key
// (it has to: that's how the server gets it), in a file the provider's CLI is
// given; it's deleted once the server is added.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { cavvyHome } from "../config/paths";
import { childEnv } from "../util/env";
import { ownKnownHosts } from "./ssh";
import { ServerError } from "./store";

export const serverKeysDir = () => join(cavvyHome(), "server-keys");
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

const keyFile = (name: string) => join(serverKeysDir(), name);
const hostKeyFile = (name: string) => join(serverKeysDir(), `${name}.host`);
const scriptNote = (name: string) => join(serverKeysDir(), `${name}.script`);

export interface MadeKey {
    /** The private key Cavvy signs in with: only its path leaves this module. */
    identityFile: string;
    publicKey: string;
    /** The server's own public key, as it will present it. */
    hostPublicKey: string;
    /** The start-up script to give the provider: installs both, turns password logins off, and installs what agents need. */
    userDataFile: string;
}

async function keygen(file: string, comment: string) {
    rmSync(file, { force: true });
    rmSync(`${file}.pub`, { force: true });
    const proc = Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", file], { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: childEnv() });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new ServerError(`Couldn't make a key: ${err.trim() || "ssh-keygen failed"}`);
    chmodSync(file, 0o600);
}

/**
 * What the new machine runs once, as root, when it first starts. Written for sh, which every image's cloud-init
 * runs (some providers take nothing else). The sign-in comes first, so Cavvy can connect while the rest installs.
 */
export function startupScript(publicKey: string, hostPrivateKey: string, hostPublicKey: string): string {
    return `#!/bin/sh
# Set up by Cavvy: this server's SSH identity, the key Cavvy signs in with, and what agents need.
umask 077
cat > /etc/ssh/ssh_host_ed25519_key <<'CAVVY_HOST_KEY'
${hostPrivateKey.trimEnd()}
CAVVY_HOST_KEY
cat > /etc/ssh/ssh_host_ed25519_key.pub <<'CAVVY_HOST_KEY'
${hostPublicKey.trim()}
CAVVY_HOST_KEY
chmod 600 /etc/ssh/ssh_host_ed25519_key
chmod 644 /etc/ssh/ssh_host_ed25519_key.pub

# The image's own login user (ubuntu, admin, ec2-user); root where there's none.
user=$(awk -F: '$3 == 1000 { print $1; exit }' /etc/passwd)
[ -n "$user" ] || user=root
home=$(awk -F: -v u="$user" '$1 == u { print $6; exit }' /etc/passwd)
mkdir -p "$home/.ssh"
cat >> "$home/.ssh/authorized_keys" <<'CAVVY_KEY'
${publicKey.trim()}
CAVVY_KEY
chmod 700 "$home/.ssh"
chmod 600 "$home/.ssh/authorized_keys"
chown -R "$user" "$home/.ssh"

# Keys only: no password gets in.
mkdir -p /etc/ssh/sshd_config.d
printf 'PasswordAuthentication no\\nKbdInteractiveAuthentication no\\n' > /etc/ssh/sshd_config.d/00-cavvy.conf
chmod 644 /etc/ssh/sshd_config.d/00-cavvy.conf
systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || service ssh restart 2>/dev/null || service sshd restart 2>/dev/null

# What agents there use. Best effort: Cavvy says what's missing once the server is added.
umask 022
(
    export DEBIAN_FRONTEND=noninteractive
    # One at a time: an image that lacks one package still gets the rest.
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq
        for p in git curl ca-certificates gh nodejs npm; do apt-get install -y -qq "$p"; done
    elif command -v dnf >/dev/null 2>&1; then
        for p in git curl ca-certificates gh nodejs npm; do dnf install -y -q "$p"; done
    fi
    command -v npm >/dev/null 2>&1 && npm install -g @openai/codex
    su - "$user" -c 'curl -fsSL https://claude.ai/install.sh | bash'
) > /var/log/cavvy-setup.log 2>&1
touch /var/lib/cavvy-setup-done
`;
}

/**
 * Makes both keys for a server about to be created. Asked again for the same name, they're made anew: the ones
 * from an attempt that went nowhere are never reused.
 */
export async function makeServerKey(name: string): Promise<MadeKey> {
    if (!NAME.test(name)) throw new ServerError("A server's name is lowercase letters, digits and dashes, up to 40 (like build-box).");
    mkdirSync(serverKeysDir(), { recursive: true, mode: 0o700 });
    chmodSync(serverKeysDir(), 0o700);
    forgetScript(name);
    await keygen(keyFile(name), `cavvy-${name}`);
    await keygen(hostKeyFile(name), `cavvy-${name}-host`);
    const publicKey = readFileSync(`${keyFile(name)}.pub`, "utf-8").trim();
    const hostPublicKey = readFileSync(`${hostKeyFile(name)}.pub`, "utf-8").trim();
    // Outside Cavvy's own folder: the provider's CLI, run by the agent, has to read it.
    const dir = mkdtempSync(join(tmpdir(), `cavvy-${name}-`));
    const userDataFile = join(dir, "user-data.sh");
    writeFileSync(userDataFile, startupScript(publicKey, readFileSync(hostKeyFile(name), "utf-8"), hostPublicKey), { mode: 0o600 });
    writeFileSync(scriptNote(name), userDataFile, { mode: 0o600 });
    // The private host key is in the script now, and nowhere else here.
    rmSync(hostKeyFile(name), { force: true });
    return { identityFile: keyFile(name), publicKey, hostPublicKey, userDataFile };
}

/** The key made for a server of that name, if one was: where it is, and the host key the server will show. */
export function madeKey(name: string): { identityFile: string; hostPublicKey: string } | undefined {
    if (!NAME.test(name) || !existsSync(keyFile(name)) || !existsSync(`${hostKeyFile(name)}.pub`)) return undefined;
    return { identityFile: keyFile(name), hostPublicKey: readFileSync(`${hostKeyFile(name)}.pub`, "utf-8").trim() };
}

/** How long after its key was made a server counts as just created (still starting, the user's Create still standing). */
const FRESH_MS = 6 * 3_600_000;

/**
 * Whether the key made for `name` is for a machine being created now: its start-up script hasn't done its part
 * yet (the note of it goes when the server is added), and it was made lately. A key left from long ago, or one
 * kept for a server that was forgotten, is no sign of that.
 */
export function freshKey(name: string): boolean {
    if (!madeKey(name)) return false;
    try {
        return Date.now() - statSync(scriptNote(name)).mtimeMs < FRESH_MS;
    } catch {
        return false;
    }
}

/** `host` as known_hosts names it (with its port, when that isn't 22). */
const knownName = (host: string, port?: number) => (port && port !== 22 ? `[${host}]:${port}` : host);

/** What Cavvy's own list holds for that address. */
export function knownHostLines(host: string, port?: number): string[] {
    const file = ownKnownHosts();
    const named = knownName(host, port);
    return (existsSync(file) ? readFileSync(file, "utf-8") : "").split("\n").filter((l) => l.trim() && l.split(/\s+/)[0] === named);
}

/** Puts back what the list held for that address (nothing, if it held nothing), in place of what it holds now. */
export function setKnownHostLines(host: string, port: number | undefined, lines: string[]) {
    const file = ownKnownHosts();
    if (!existsSync(file)) return;
    const named = knownName(host, port);
    const kept = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim() && l.split(/\s+/)[0] !== named);
    writeFileSync(file, [...kept, ...lines].length ? [...kept, ...lines].join("\n") + "\n" : "", { mode: 0o600 });
}

/**
 * Records the host key made for `name` as the one `host` must show, in Cavvy's own list (the only one its
 * connections to this server consult). Anything that list held for that address goes: an address handed on from a
 * machine that's gone would otherwise be refused as changed. Returns the list's path, for the server's entry.
 */
export function expectHostKey(name: string, host: string, port?: number): string {
    const key = madeKey(name);
    if (!key) throw new ServerError(`No key was made for ${name}.`);
    const [type, data] = key.hostPublicKey.split(/\s+/);
    if (!type || !data) throw new ServerError(`The host key made for ${name} can't be read.`);
    const file = ownKnownHosts();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const named = knownName(host, port);
    const kept = (existsSync(file) ? readFileSync(file, "utf-8") : "").split("\n").filter((l) => l.trim() && l.split(/\s+/)[0] !== named);
    writeFileSync(file, [...kept, `${named} ${type} ${data}`].join("\n") + "\n", { mode: 0o600 });
    chmodSync(file, 0o600);
    return file;
}

/** The start-up script is of no more use (the server is added, or won't be): it holds a private key, so it goes. */
export function forgetScript(name: string) {
    const note = scriptNote(name);
    if (!existsSync(note)) return;
    try {
        const file = readFileSync(note, "utf-8").trim();
        // Only what this module made: a folder of its own under the temp folder.
        if (file.endsWith(join("", "user-data.sh")) && dirname(file).startsWith(tmpdir())) rmSync(dirname(file), { recursive: true, force: true });
    } catch {
        // already gone
    }
    rmSync(note, { force: true });
}

/** The server is gone: so are its keys, and what Cavvy's list said its address shows. */
export function forgetServerKey(name: string, host?: string, port?: number) {
    if (!NAME.test(name)) return;
    forgetScript(name);
    for (const f of [keyFile(name), `${keyFile(name)}.pub`, hostKeyFile(name), `${hostKeyFile(name)}.pub`]) rmSync(f, { force: true });
    const file = ownKnownHosts();
    if (!host || !existsSync(file)) return;
    const named = knownName(host, port);
    const kept = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim() && l.split(/\s+/)[0] !== named);
    writeFileSync(file, kept.length ? kept.join("\n") + "\n" : "", { mode: 0o600 });
}
