// Keeping a server's Cavvy running (src/servers/host.ts), from the machine
// that set it up: plain `sh` over ssh, since the server may have nothing else.
//
// Where the server has a systemd user manager that keeps services running
// with nobody signed in ("linger"), Cavvy is a user service there: started at
// boot, restarted if it crashes. Cavvy asks for linger itself; where that's
// refused, or there's no systemd, it runs detached instead: it outlives the
// connection that started it, but not a reboot, and the user is told how to
// fix that (ServiceReport.lingerFix).
//
// An update is a trial: the new build is started, and if it isn't answering
// as itself within the wait, the build before it is put back and started.

import { ServerError, type ServerEntry } from "./store";
import { hostOf, remoteSh, ssh, shQuote } from "./ssh";
import { BUILD_ID, REMOTE_DIR } from "./remote";
import { NOT_RUNNING, type HostStatus } from "./host";

/**
 * The unit. `mixed`: stopping it asks Cavvy alone to stop, which closes its
 * sessions' CLIs and shells in its own time; what's left after the wait is
 * killed. `OOMPolicy=continue`: a command an agent runs being killed for
 * memory doesn't take the server and every other session with it.
 */
export const UNIT = `[Unit]
Description=Cavvy server
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
ExecStart=%h/.cavvy/server/current/cavvy host run --login-env
WorkingDirectory=%h
Environment=CAVVY_NO_KEYCHAIN=1
Restart=on-failure
RestartSec=2
KillMode=mixed
TimeoutStopSec=30
OOMPolicy=continue

[Install]
WantedBy=default.target
`;

/** How long things are given (changeable for tests). */
export const serviceTiming = {
    /** A started server, to answer as the build it should be. */
    startWaitSeconds: 40,
};

/** A script with the waits as they're set now. */
const timed = (script: string) => script.replaceAll("@@START_TRIES@@", String(Math.max(1, Math.round(serviceTiming.startWaitSeconds * 2))));

/** Shell functions every script below starts with. `$d` is the server folder. */
const LIB = `
d="${REMOTE_DIR}"
unit="$HOME/.config/systemd/user/cavvy.service"
bin="$d/current/cavvy"
has_systemd() { command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; }
linger() { loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null; }
# A service only where it would keep running once this connection closes.
as_service() { [ -f "$unit" ] && has_systemd && [ "$(linger)" = "yes" ]; }
status() { "$bin" host status 2>/dev/null; }
current() { [ -L "$d/current" ] && basename "$(readlink "$d/current")"; }
point_at() {
    ln -s "builds/$1" "$d/current.new.$$"
    # -T: onto the link itself, not into the folder it names (GNU and BusyBox have it).
    mv -T "$d/current.new.$$" "$d/current" 2>/dev/null || { rm -f "$d/current"; mv "$d/current.new.$$" "$d/current"; }
}
start() {
    if as_service; then
        systemctl --user reset-failed cavvy.service >/dev/null 2>&1
        systemctl --user start cavvy.service
    else
        if [ -f "$d/server.log" ] && [ "$(wc -c < "$d/server.log")" -gt 5000000 ]; then mv -f "$d/server.log" "$d/server.log.1"; fi
        if command -v setsid >/dev/null 2>&1; then
            CAVVY_NO_KEYCHAIN=1 nohup setsid "$bin" host run --login-env >> "$d/server.log" 2>&1 < /dev/null &
        else
            CAVVY_NO_KEYCHAIN=1 nohup "$bin" host run --login-env >> "$d/server.log" 2>&1 < /dev/null &
        fi
    fi
}
stop() {
    # Cavvy's own stop waits until the process is gone, sessions closed.
    "$bin" host stop >/dev/null 2>&1
    if has_systemd && [ -f "$unit" ]; then systemctl --user stop cavvy.service >/dev/null 2>&1; fi
    return 0
}
# Answering, and as build $1 when one is given.
wait_up() {
    n=0
    while [ "$n" -lt @@START_TRIES@@ ]; do
        if s=$(status); then
            case "$1" in "") return 0 ;; esac
            case "$s" in *"\\"build\\":\\"$1\\""*) return 0 ;; esac
        fi
        n=$((n + 1))
        sleep 0.5
    done
    return 1
}
`;

/** Writes the unit and asks for linger. Prints `service=`, `linger=`, `user=`. */
const SETUP = `${LIB}
if has_systemd; then
    mkdir -p "$(dirname "$unit")"
    printf '%s' "$1" > "$unit.tmp" && mv -f "$unit.tmp" "$unit"
    systemctl --user daemon-reload
    systemctl --user enable cavvy.service >/dev/null 2>&1
    [ "$(linger)" = "yes" ] || loginctl enable-linger --no-ask-password >/dev/null 2>&1 || true
    echo "systemd=1"
    echo "linger=$(linger)"
fi
echo "user=$(id -un)"
`;

/**
 * Makes build $1 the one that runs: stops what's running, starts $1, and puts
 * the build before it back if $1 doesn't come up. Prints the status it ends
 * with as `status=`. Exits 44 when it went back, 45 when nothing runs.
 */
const APPLY = `${LIB}
new="$1"
[ -x "$d/builds/$new/cavvy" ] || { echo "no build $new there" >&2; exit 43; }
prev=$(current || true)
stop
point_at "$new"
start
if wait_up "$new"; then echo "status=$(status)"; exit 0; fi
echo "the new build didn't start" >&2
stop
if [ -n "$prev" ] && [ "$prev" != "$new" ] && [ -x "$d/builds/$prev/cavvy" ]; then
    point_at "$prev"
    start
    if wait_up "$prev"; then echo "status=$(status)"; exit 44; fi
fi
exit 45
`;

/** Starts it if it isn't running, and signs machine $1 (called $2) in: prints `pair=` with the code. */
const CONNECT = `${LIB}
[ -x "$bin" ] || exit 46
if ! status >/dev/null; then
    start
    wait_up "" || exit 45
fi
p=$("$bin" host pair --machine "$1" --label "$2") || exit 45
echo "pair=$p"
`;

const STATUS = `${LIB}
[ -x "$bin" ] || exit 46
s=$(status)
code=$?
echo "status=$s"
exit $code
`;

const STOP = `${LIB}
[ -x "$bin" ] || exit 0
stop
if has_systemd && [ -f "$unit" ]; then systemctl --user disable cavvy.service >/dev/null 2>&1; fi
exit 0
`;

const REVOKE = `${LIB}
[ -x "$bin" ] || exit 0
"$bin" host revoke --machine "$1" >/dev/null 2>&1
exit 0
`;

const CHECK = `${LIB}
[ -x "$bin" ] || exit 46
"$bin" host check
`;

/** Removes builds no longer wanted: every one but the current, the one before it ($1) and the one named $2. */
const PRUNE = `${LIB}
cur=$(current || true)
for b in "$d"/builds/*/; do
    [ -d "$b" ] || continue
    n=$(basename "$b")
    case "$n" in "$cur"|"$1"|"$2") continue ;; esac
    rm -rf "$b"
done
exit 0
`;

function value(out: string, key: string): string | undefined {
    for (const line of out.split("\n")) if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
    return undefined;
}

function json<T>(text: string | undefined): T | undefined {
    if (!text) return undefined;
    try {
        const v: unknown = JSON.parse(text);
        return v && typeof v === "object" ? (v as T) : undefined;
    } catch {
        return undefined;
    }
}

export interface ServiceReport {
    /** Started at boot and restarted if it crashes. Otherwise it runs until the server restarts. */
    service: boolean;
    /** What to run on the server (it needs an administrator) so it can be a service. */
    lingerFix?: string;
}

/** Sets the server up to keep Cavvy running, as well as it allows. */
export async function setUpService(e: ServerEntry, signal?: AbortSignal): Promise<ServiceReport> {
    const r = await ssh(e, remoteSh(timed(SETUP), [UNIT]), { timeoutMs: 60_000, signal });
    if (r.code !== 0) throw new ServerError(`Couldn't set ${hostOf(e)} up to keep Cavvy running: ${r.stderr.trim().split("\n").at(-1) ?? `exit ${r.code}`}`);
    const systemd = value(r.stdout, "systemd") === "1";
    const linger = value(r.stdout, "linger") === "yes";
    const user = value(r.stdout, "user") ?? "";
    if (systemd && linger) return { service: true };
    return { service: false, lingerFix: systemd && /^[\w.-]+$/.test(user) ? `sudo loginctl enable-linger ${shQuote(user)}` : undefined };
}

export class UpdateFailed extends ServerError {
    constructor(
        message: string,
        /** What runs there now: the build before, when it could be put back. */
        readonly status?: HostStatus,
    ) {
        super(message);
    }
}

/** Runs `build` there in place of whatever runs now, going back to that if the new one doesn't start. */
export async function applyBuild(e: ServerEntry, build: string, signal?: AbortSignal): Promise<HostStatus> {
    if (!BUILD_ID.test(build)) throw new ServerError("That isn't a build.");
    const r = await ssh(e, remoteSh(timed(APPLY), [build]), { timeoutMs: (serviceTiming.startWaitSeconds * 2 + 90) * 1000, signal });
    const status = json<HostStatus>(value(r.stdout, "status"));
    if (r.code === 0 && status) return status;
    const said = r.stderr.trim().split("\n").at(-1);
    if (r.code === 44) throw new UpdateFailed(`Cavvy didn't start on ${hostOf(e)}, so it's back on the version before.`, status);
    throw new UpdateFailed(`Cavvy didn't start on ${hostOf(e)}${said ? `: ${said}` : "."}`);
}

export interface Pairing {
    code: string;
    /** The server's own port. */
    port: number;
    /** Which run of the server made it: a different one means every earlier sign-in is gone. */
    run: string;
    /** It has its GUI to serve to a browser. */
    gui: boolean;
    build: string;
    version: string;
    protocol: number;
}

/** Thrown when there's no Cavvy on the server to connect to: it needs setting up. */
export class NotSetUp extends ServerError {}

/** Starts the server's Cavvy if it isn't running and makes a code that signs this machine in. */
export async function pairOverSsh(e: ServerEntry, machine: { id: string; label: string }, signal?: AbortSignal): Promise<Pairing> {
    const r = await ssh(e, remoteSh(timed(CONNECT), [machine.id, machine.label]), { timeoutMs: (serviceTiming.startWaitSeconds + 30) * 1000, signal });
    if (r.code === 46) throw new NotSetUp(`Cavvy isn't set up on ${hostOf(e)}.`);
    const p = json<Pairing>(value(r.stdout, "pair"));
    if (r.code !== 0 || !p || typeof p.code !== "string" || typeof p.port !== "number" || typeof p.run !== "string") throw new ServerError(`Cavvy didn't start on ${hostOf(e)}${r.stderr.trim() ? `: ${r.stderr.trim().split("\n").at(-1)}` : "."}`);
    return p;
}

/** What runs there: undefined when nothing does. Throws NotSetUp when Cavvy isn't there at all. */
export async function remoteStatus(e: ServerEntry, signal?: AbortSignal): Promise<HostStatus | undefined> {
    const r = await ssh(e, remoteSh(timed(STATUS)), { timeoutMs: 30_000, signal });
    if (r.code === 46) throw new NotSetUp(`Cavvy isn't set up on ${hostOf(e)}.`);
    if (r.code === NOT_RUNNING) return undefined;
    const s = json<HostStatus>(value(r.stdout, "status"));
    return r.code === 0 && s?.running ? s : undefined;
}

/** Stops the server's Cavvy and leaves it stopped (not started again at boot). */
export async function stopRemote(e: ServerEntry, signal?: AbortSignal): Promise<void> {
    await ssh(e, remoteSh(timed(STOP)), { timeoutMs: 60_000, signal });
}

/** This machine's sign-ins there stop working. */
export async function revokeOverSsh(e: ServerEntry, machine: string, signal?: AbortSignal): Promise<void> {
    await ssh(e, remoteSh(timed(REVOKE), [machine]), { timeoutMs: 30_000, signal });
}

/** The server's own account of what's there for agents (host.ts HostCheck), as JSON text. */
export async function remoteCheck(e: ServerEntry, signal?: AbortSignal): Promise<string> {
    const r = await ssh(e, remoteSh(timed(CHECK)), { timeoutMs: 60_000, signal });
    if (r.code === 46) throw new NotSetUp(`Cavvy isn't set up on ${hostOf(e)}.`);
    if (r.code !== 0) throw new ServerError(`Couldn't check ${hostOf(e)}: ${r.stderr.trim().split("\n").at(-1) ?? `exit ${r.code}`}`);
    return r.stdout;
}

/** Builds the server no longer needs go: all but the one running, `previous` and `keep`. */
export async function pruneBuilds(e: ServerEntry, previous: string | undefined, keep: string, signal?: AbortSignal): Promise<void> {
    await ssh(e, remoteSh(timed(PRUNE), [previous && BUILD_ID.test(previous) ? previous : "-", BUILD_ID.test(keep) ? keep : "-"]), { timeoutMs: 30_000, signal }).catch(() => undefined);
}
