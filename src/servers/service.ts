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

import { agentCli } from "../backends/defs";
import { ServerError, type ServerEntry } from "./store";
import { hostOf, printable, remoteSh, ssh, shQuote } from "./ssh";
import { BUILD_ID, REMOTE_DIR, type ServerFacts } from "./remote";
import { NOT_RUNNING, type HostCheck, type HostStatus } from "./host";
import { PERMISSION_MODES } from "../permissions/modes";

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
        # Started on purpose, so started at boot again too (a stop turns that off).
        systemctl --user enable cavvy.service >/dev/null 2>&1
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
    [ "$(linger)" = "yes" ] || loginctl enable-linger --no-ask-password >/dev/null 2>&1 || true
    # Started at boot only where it would keep running with nobody signed in. Without that, the unit would start
    # at the next login and take Cavvy down with it when that connection closed.
    if [ "$(linger)" = "yes" ]; then systemctl --user enable cavvy.service >/dev/null 2>&1
    else systemctl --user disable cavvy.service >/dev/null 2>&1 || true; fi
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
# Carried through once begun, whatever becomes of the connection that asked: its closing, or nobody left to read
# what's printed, mustn't stop this between stopping one build and starting another.
trap '' HUP PIPE
# One at a time: two changing what runs would each undo the other. The folder names the shell doing it; one whose
# shell is gone (it was killed) doesn't count.
if ! mkdir "$d/applying" 2>/dev/null; then
    other=$(cat "$d/applying/pid" 2>/dev/null)
    if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then exit 48; fi
    # No pid yet: another began this moment.
    if [ -z "$other" ] && [ -z "$(find "$d/applying" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then exit 48; fi
    rm -rf "$d/applying"
    mkdir "$d/applying" 2>/dev/null || exit 48
fi
echo $$ > "$d/applying/pid"
trap 'rm -rf "$d/applying"' EXIT
# A shell that dies of a signal skips that (dash does): ended by one, it leaves the ordinary way.
trap 'exit 130' INT TERM
prev=$(current || true)
stop
rm -f "$d/stopped"
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

/**
 * Starts it if it isn't running, and signs machine $1 (called $2) in: prints `pair=` with the code. $3 is
 * `resume` for a connection coming back by itself, which doesn't start a server that was stopped on purpose
 * (exit 47): only someone asking to connect does. $4, when there is one, names which of the machine's
 * connections asks.
 */
const CONNECT = `${LIB}
[ -x "$bin" ] || exit 46
if ! status >/dev/null; then
    if [ "$3" = "resume" ] && [ -f "$d/stopped" ]; then exit 47; fi
    rm -f "$d/stopped"
    start
    wait_up "" || exit 45
fi
if [ -n "$4" ]; then p=$("$bin" host pair --machine "$1" --label "$2" --client "$4") || exit 45
else p=$("$bin" host pair --machine "$1" --label "$2") || exit 45; fi
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
: > "$d/stopped"
if has_systemd && [ -f "$unit" ]; then systemctl --user disable cavvy.service >/dev/null 2>&1; fi
exit 0
`;

/** Signs machine $1 out: all of it, or what its connection $2 signed in. */
const REVOKE = `${LIB}
[ -x "$bin" ] || exit 0
if [ -n "$2" ]; then "$bin" host revoke --machine "$1" --client "$2" >/dev/null 2>&1
else "$bin" host revoke --machine "$1" >/dev/null 2>&1; fi
exit 0
`;

const CHECK = `${LIB}
[ -x "$bin" ] || exit 46
c=$("$bin" host check) || exit 1
echo "check=$c"
`;

/**
 * Removes builds no longer wanted: every one but the current, the one before it ($1), the one named $2, and any
 * put there in the last hour (another machine may have just copied its own, and not started it yet).
 */
const PRUNE = `${LIB}
cur=$(current || true)
for b in "$d"/builds/*/; do
    [ -d "$b" ] || continue
    n=$(basename "$b")
    case "$n" in "$cur"|"$1"|"$2") continue ;; esac
    [ -n "$(find "$b" -maxdepth 0 -mmin +60 2>/dev/null)" ] || continue
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

function report(systemd: boolean, linger: boolean, user: string): ServiceReport {
    if (systemd && linger) return { service: true };
    return { service: false, lingerFix: systemd && /^[\w.-]+$/.test(user) ? `sudo loginctl enable-linger ${shQuote(user)}` : undefined };
}

/** The same report, from what a probe found, for a server that's only being looked at. */
export function serviceReport(facts: ServerFacts): ServiceReport {
    return report(facts.systemd, facts.linger === true, facts.user);
}

const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

/**
 * A status as the server printed it, with only what has the shape it should:
 * the server's words are shown to the user and decide what's done next, and a
 * server that isn't what it seems could print anything.
 */
function readStatus(text: string | undefined): HostStatus | undefined {
    const s = json<Record<string, unknown>>(text);
    if (!s || s.running !== true || typeof s.build !== "string" || !BUILD_ID.test(s.build)) return undefined;
    if (typeof s.pid !== "number" || !Number.isInteger(s.pid) || s.pid <= 0) return undefined;
    if (typeof s.port !== "number" || !Number.isInteger(s.port) || s.port < 0 || s.port > 65535) return undefined;
    const machines = (Array.isArray(s.machines) ? s.machines : []).flatMap((m: unknown) => {
        const x = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
        return typeof x.id === "string" && /^[0-9a-f]{32}$/.test(x.id) ? [{ id: x.id, label: printable(String(x.label ?? ""), 60), connections: count(x.connections) }] : [];
    });
    return {
        running: true,
        pid: s.pid,
        start: typeof s.start === "string" ? printable(s.start, 80) : undefined,
        port: s.port,
        startedAt: typeof s.startedAt === "string" ? printable(s.startedAt, 40) : "",
        version: printable(String(s.version ?? ""), 40),
        protocol: count(s.protocol),
        build: s.build,
        sessions: count(s.sessions),
        working: count(s.working),
        waiting: count(s.waiting),
        machines,
        gui: s.gui === true,
    };
}

/**
 * What a server says it has for agents, with only what has the shape it should (see readStatus). Of its CLIs, only
 * the ones this Cavvy knows, each once, and named and described in this Cavvy's own words: a server says which it
 * has and how each stands, never what a question about one will read.
 */
export function readCheck(text: string | undefined): HostCheck | undefined {
    const c = json<Record<string, unknown>>(text);
    if (!c || !Array.isArray(c.clis)) return undefined;
    const flag = (v: unknown) => (typeof v === "boolean" ? v : undefined);
    const gh = (c.gh && typeof c.gh === "object" ? c.gh : {}) as Record<string, unknown>;
    const seen = new Set<string>();
    return {
        clis: c.clis.flatMap((v: unknown) => {
            const x = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
            const def = typeof x.id === "string" ? agentCli(x.id) : undefined;
            if (!def || seen.has(def.id)) return [];
            seen.add(def.id);
            return [{ id: def.id, product: def.cli.product, installed: x.installed === true, signedIn: flag(x.signedIn), on: flag(x.on), install: def.cli.install, signIn: def.cli.signIn }];
        }),
        git: c.git === true,
        gh: { installed: gh.installed === true, signedIn: flag(gh.signedIn) },
        browser: c.browser === true,
        sandbox: typeof c.sandbox === "string" ? printable(c.sandbox, 40) : undefined,
        sandboxOn: flag(c.sandboxOn),
        mode: PERMISSION_MODES.find((m) => m === c.mode),
        memMb: count(c.memMb),
    };
}

/** What the server's last line of complaint was, safe to show. */
const said = (stderr: string) => printable(stderr.trim().split("\n").at(-1) ?? "");

/** Sets the server up to keep Cavvy running, as well as it allows. */
export async function setUpService(e: ServerEntry, signal?: AbortSignal): Promise<ServiceReport> {
    const r = await ssh(e, remoteSh(timed(SETUP), [UNIT]), { timeoutMs: 60_000, signal });
    if (r.code !== 0) throw new ServerError(`Couldn't set ${hostOf(e)} up to keep Cavvy running: ${said(r.stderr) || `exit ${r.code}`}`);
    return report(value(r.stdout, "systemd") === "1", value(r.stdout, "linger") === "yes", value(r.stdout, "user") ?? "");
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
    const status = readStatus(value(r.stdout, "status"));
    if (r.code === 0 && status) return status;
    if (r.code === 48) throw new ServerError(`Cavvy on ${e.name} is being updated right now. Try again in a minute.`);
    if (r.code === 44) throw new UpdateFailed(`Cavvy didn't start on ${hostOf(e)}, so it's back on the version before.`, status);
    const why = said(r.stderr);
    throw new UpdateFailed(`Cavvy didn't start on ${hostOf(e)}${why ? `: ${why}` : "."}`);
}

export interface Pairing {
    /** Good once, for two minutes. */
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

/** Thrown to a connection coming back by itself when Cavvy there was stopped on purpose. */
export class StoppedThere extends ServerError {}

/**
 * Starts the server's Cavvy if it isn't running and makes a code that signs this machine in. `resume`: for a
 * connection coming back by itself, which leaves a server that was stopped on purpose stopped. `client`: which
 * of this machine's connections the sign-in is for, so it can be taken away alone.
 */
export async function pairOverSsh(e: ServerEntry, machine: { id: string; label: string; client?: string }, o: { signal?: AbortSignal; resume?: boolean } = {}): Promise<Pairing> {
    const r = await ssh(e, remoteSh(timed(CONNECT), [machine.id, machine.label, o.resume ? "resume" : "start", machine.client ?? ""]), { timeoutMs: (serviceTiming.startWaitSeconds + 30) * 1000, signal: o.signal });
    if (r.code === 46) throw new NotSetUp(`Cavvy isn't set up on ${hostOf(e)}.`);
    if (r.code === 47) throw new StoppedThere(`Cavvy on ${e.name} was stopped.`);
    const p = json<Record<string, unknown>>(value(r.stdout, "pair"));
    // Every part goes into a link that's printed and opened, or decides what's connected to: only the shapes Cavvy makes.
    const ok =
        r.code === 0 &&
        p !== undefined &&
        typeof p.code === "string" &&
        /^[A-Za-z0-9_-]{16,64}$/.test(p.code) &&
        typeof p.port === "number" &&
        Number.isInteger(p.port) &&
        p.port >= 1 &&
        p.port <= 65535 &&
        typeof p.run === "string" &&
        /^[0-9a-z-]{1,40}$/.test(p.run) &&
        typeof p.build === "string" &&
        BUILD_ID.test(p.build);
    if (!ok) throw new ServerError(`Cavvy didn't start on ${hostOf(e)}${said(r.stderr) ? `: ${said(r.stderr)}` : "."}`);
    return { code: p.code as string, port: p.port as number, run: p.run as string, gui: p.gui === true, build: p.build as string, version: printable(String(p.version ?? ""), 40), protocol: count(p.protocol) };
}

/** What runs there: undefined when nothing does. Throws NotSetUp when Cavvy isn't there at all. */
export async function remoteStatus(e: ServerEntry, signal?: AbortSignal): Promise<HostStatus | undefined> {
    const r = await ssh(e, remoteSh(timed(STATUS)), { timeoutMs: 30_000, signal });
    if (r.code === 46) throw new NotSetUp(`Cavvy isn't set up on ${hostOf(e)}.`);
    if (r.code === NOT_RUNNING) return undefined;
    return r.code === 0 ? readStatus(value(r.stdout, "status")) : undefined;
}

/** Stops the server's Cavvy and leaves it stopped (not started again at boot). */
export async function stopRemote(e: ServerEntry, signal?: AbortSignal): Promise<void> {
    await ssh(e, remoteSh(timed(STOP)), { timeoutMs: 60_000, signal });
}

/** This machine's sign-ins there stop working: all of them, or the ones its connection `client` made. */
export async function revokeOverSsh(e: ServerEntry, machine: string, o: { client?: string; signal?: AbortSignal } = {}): Promise<void> {
    await ssh(e, remoteSh(timed(REVOKE), [machine, o.client ?? ""]), { timeoutMs: 30_000, signal: o.signal });
}

/** The server's own account of what's there for agents. */
export async function remoteCheck(e: ServerEntry, signal?: AbortSignal): Promise<HostCheck> {
    const r = await ssh(e, remoteSh(timed(CHECK)), { timeoutMs: 60_000, signal });
    if (r.code === 46) throw new NotSetUp(`Cavvy isn't set up on ${hostOf(e)}.`);
    const check = r.code === 0 ? readCheck(value(r.stdout, "check")) : undefined;
    if (!check) throw new ServerError(`Couldn't check ${hostOf(e)}${said(r.stderr) ? `: ${said(r.stderr)}` : "."}`);
    return check;
}

/** Builds the server no longer needs go: all but the one running, `previous` and `keep`. */
export async function pruneBuilds(e: ServerEntry, previous: string | undefined, keep: string, signal?: AbortSignal): Promise<void> {
    await ssh(e, remoteSh(timed(PRUNE), [previous && BUILD_ID.test(previous) ? previous : "-", BUILD_ID.test(keep) ? keep : "-"]), { timeoutMs: 30_000, signal }).catch(() => undefined);
}
