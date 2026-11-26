// Keeping a server's Cavvy running (src/servers/host.ts), from the machine
// that set it up: plain `sh` over ssh, since the server may have nothing else.
//
// Linux: where the server has a systemd user manager that keeps services
// running with nobody signed in ("linger"), Cavvy is a user service there:
// started at boot, restarted if it crashes. Cavvy asks for linger itself; where
// that's refused, or there's no systemd, it runs detached instead: it outlives
// the connection that started it, but not a reboot, and the user is told how
// to fix that (ServiceReport.bootFix).
//
// A Mac: launchd keeps it running, restarted if it crashes, as one of two jobs
// (MAC below). A LaunchDaemon that runs as the user starts it at boot with
// nobody signed in; installing and starting one takes an administrator, so
// Cavvy does both only where `sudo` doesn't ask. Otherwise it's an agent in the
// user's background session: it outlives the connection, but not a reboot, and
// the user is told the one command that installs the daemon. Never `nohup`
// there: it can't detach from a connection that has no terminal, and starts
// nothing.
//
// An update is a trial: the new build is started, and if it isn't answering
// as itself within the wait, the build before it is put back and started.

import { agentCli } from "../backends/defs";
import { ServerError, type ServerEntry } from "./store";
import { hostOf, printable, remoteSh, ssh, shQuote } from "./ssh";
import { BUILD_ID, MAC_DAEMON, MAC_LABEL, REMOTE_DIR, type ServerFacts } from "./remote";
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
const seconds = (n: number) => String(Math.max(1, Math.round(n)));

/**
 * A Mac's part of LIB. Both jobs run the same thing: `current/cavvy`, unless Cavvy was stopped on purpose (launchd
 * starts a job at boot whatever it was told before), with its output in the server's log. They leave it alone when it
 * exits by itself (stopped: exit 0) and start it again when it doesn't. `Interactive`: not held back as background
 * work, since what it runs is someone's builds. The agent is `Background`: the only kind of session a connection over
 * SSH has, and one without it isn't loaded there at all.
 */
const MAC = `
mac=""
if [ "$(uname -s)" = Darwin ]; then mac=1; uid=$(id -u); fi
label="${MAC_LABEL}"
agent="$HOME/Library/LaunchAgents/$label.plist"
${MAC_DAEMON}
admin() { sudo -n true >/dev/null 2>&1; }
xml() { printf '%s' "$1" | sed -e 's/&/\\&amp;/g' -e 's/</\\&lt;/g' -e 's/>/\\&gt;/g'; }
# The job, as launchd reads it. $1: what only one of the two has.
mac_plist() {
    cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$label</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>if [ -f "\\$0/stopped" ]; then exit 0; fi; exec "\\$0/current/cavvy" host run --login-env &gt;&gt; "\\$0/server.log" 2&gt;&amp;1</string><string>$(xml "$d")</string></array>
<key>EnvironmentVariables</key><dict><key>CAVVY_NO_KEYCHAIN</key><string>1</string><key>HOME</key><string>$(xml "$HOME")</string><key>USER</key><string>$(xml "$(id -un)")</string><key>LOGNAME</key><string>$(xml "$(id -un)")</string><key>SHELL</key><string>$(xml "\${SHELL:-/bin/zsh}")</string></dict>
<key>WorkingDirectory</key><string>$(xml "$HOME")</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ProcessType</key><string>Interactive</string>
<key>ExitTimeOut</key><integer>30</integer>
$1
</dict></plist>
PLIST
}
# launchctl, as an administrator for the system's jobs.
lctl() { case "$2" in system*) sudo -n launchctl "$@" ;; *) launchctl "$@" ;; esac; }
# Takes job $1 out of launchd, which ends it if it runs, and waits until it's out: one loaded while the last is
# still going is refused.
mac_unload() {
    lctl bootout "$1" >/dev/null 2>&1
    n=0
    while launchctl print "$1" >/dev/null 2>&1 && [ "$n" -lt 80 ]; do sleep 0.5; n=$((n + 1)); done
}
# Loads the job in file $2 into $1 in place of the one there, which starts it.
mac_load() {
    mac_unload "$1/$label"
    n=0
    until out=$(lctl bootstrap "$1" "$2" 2>&1); do
        n=$((n + 1))
        if [ "$n" -ge 6 ]; then echo "$out" >&2; return 1; fi
        sleep 0.5
    done
}
mac_start() {
    if [ -f "$d/server.log" ] && [ "$(wc -c < "$d/server.log")" -gt 5000000 ]; then mv -f "$d/server.log" "$d/server.log.1"; fi
    if boots && admin; then
        # The daemon has it from here: an agent that ran it until now goes.
        mac_unload "user/$uid/$label"
        rm -f "$agent"
        mac_load system "$daemon"
    else
        # Also where the daemon is installed and only an administrator may start it: it starts Cavvy at boot, and
        # the agent whenever it's started after that.
        mkdir -p "$(dirname "$agent")"
        mac_plist '<key>LimitLoadToSessionType</key><string>Background</string>' > "$agent.tmp" && mv -f "$agent.tmp" "$agent"
        mac_load "user/$uid" "$agent"
    fi
}
# After Cavvy's own stop: out of launchd too, so one that didn't answer (hung, or crashing each time it's started)
# isn't started again. A daemon that can't be taken out stays loaded, with nothing running. Only this user's daemon:
# the system's job of that name may be another account's Cavvy on the same Mac.
mac_stop() {
    mac_unload "user/$uid/$label"
    if boots && admin; then mac_unload "system/$label"; fi
}
`;

/** Shell functions every script below starts with. `$d` is the server folder. */
const LIB = `
d="${REMOTE_DIR}"
unit="$HOME/.config/systemd/user/cavvy.service"
bin="$d/current/cavvy"
${MAC}
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
    if [ -n "$mac" ]; then
        mac_start
    elif as_service; then
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
    if [ -n "$mac" ]; then mac_stop; return 0; fi
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

/**
 * Writes the unit and asks for linger. Prints `systemd=`, `linger=`, `user=`. On a Mac: writes the LaunchDaemon's
 * file beside Cavvy, and installs it where sudo doesn't ask (what's loaded is left: the next start reads it).
 * Prints `mac=1`, and `boot=` (`mine`, or `other` for another user's) when a daemon is installed.
 */
const SETUP = `${LIB}
if [ -n "$mac" ]; then
    mkdir -p "$d"
    mac_plist "<key>UserName</key><string>$(xml "$(id -un)")</string>" > "$d/$label.plist.tmp" && mv -f "$d/$label.plist.tmp" "$d/$label.plist"
    if { boots || [ ! -f "$daemon" ]; } && ! cmp -s "$d/$label.plist" "$daemon" && admin; then
        sudo -n install -o root -g wheel -m 644 "$d/$label.plist" "$daemon" >/dev/null 2>&1 || true
    fi
    echo "mac=1"
    if boots; then echo "boot=mine"; elif [ -f "$daemon" ]; then echo "boot=other"; fi
elif has_systemd; then
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
if wait_up "$new"; then
    # What it ran before, for going back to (PREVIOUS): kept by the pruning that follows an update.
    if [ -n "$prev" ] && [ "$prev" != "$new" ]; then echo "$prev" > "$d/previous"; fi
    echo "status=$(status)"
    exit 0
fi
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
# Stopped on purpose: what was working isn't carried on when it's next started (src/server/working.ts).
rm -f "$d/working.json"
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

/**
 * How Xcode stands on a Mac, for building and running iOS apps there: `missing` (none, or only the command line
 * tools), `unopened` (it's there and hasn't been opened at the Mac's screen, which is where macOS asks whether it may
 * run and where it installs the rest of itself), `no-simulator` (no iOS simulator to run an app in), or `ready`.
 */
export const XCODE_STATES = ["ready", "missing", "unopened", "no-simulator"] as const;
export type XcodeState = (typeof XCODE_STATES)[number];

/** How long Xcode's tools are given to answer (changeable for tests). */
export const xcodeTiming = { versionSeconds: 8, simulatorsSeconds: 15 };

/**
 * Prints `check=` with the server's own account, and on a Mac `xcode=` (XcodeState). An Xcode that macOS hasn't let
 * run yet is killed as it starts when nobody is signed in at the Mac, and waits on a question at its screen when
 * somebody is: so it's given a few seconds, and one that fails or runs out of them is `unopened`. Asked while the
 * server's Cavvy answers, so the wait isn't added to it.
 */
const CHECK = `${LIB}
[ -x "$bin" ] || exit 46
# Runs the rest for at most $1 seconds (a Mac has no timeout).
within() {
    t=$1; shift
    "$@" &
    p=$!
    # What watches the clock takes its sleep with it when it's told the wait is over.
    ( trap 'kill "$s" 2>/dev/null; exit 0' TERM; sleep "$t" & s=$!; wait "$s" && kill -9 "$p" ) >/dev/null 2>&1 < /dev/null &
    w=$!
    wait "$p" 2>/dev/null
    code=$?
    kill "$w" >/dev/null 2>&1
    return $code
}
xcode() {
    dev=$(xcode-select -p 2>/dev/null) || { echo missing; return; }
    case "$dev" in *.app/*) [ -d "$dev" ] || { echo missing; return; } ;; *) echo missing; return ;; esac
    within @@XCODE_VERSION@@ xcodebuild -version >/dev/null 2>&1 || { echo unopened; return; }
    sims=$(within @@XCODE_SIMULATORS@@ xcrun simctl list runtimes 2>/dev/null) || { echo unopened; return; }
    if echo "$sims" | grep -v unavailable | grep -q 'SimRuntime\\.iOS-'; then echo ready; else echo no-simulator; fi
}
if [ -n "$mac" ]; then
    x="$d/.xcode.$$"
    xcode > "$x" 2>/dev/null &
    asking=$!
fi
c=$("$bin" host check)
code=$?
if [ -n "$mac" ]; then
    wait "$asking" 2>/dev/null
    echo "xcode=$(cat "$x" 2>/dev/null)"
    rm -f "$x"
fi
[ "$code" -eq 0 ] || exit 1
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
    case "$n" in "$cur"|"$1"|"$2"|"$(cat "$d/previous" 2>/dev/null)") continue ;; esac
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
    /** What to run on the server (it needs an administrator) so Cavvy starts at boot there. */
    bootFix?: string;
}

/** On a Mac: puts the LaunchDaemon that SETUP wrote beside Cavvy where launchd reads it at boot. What runs now is left. */
export const MAC_BOOT_FIX = `sudo install -o root -g wheel -m 644 ~/.cavvy/server/${MAC_LABEL}.plist /Library/LaunchDaemons/`;

function report(o: { systemd: boolean; linger: boolean; user: string; mac: boolean; boot?: string }): ServiceReport {
    // Another user's daemon has the name there: nothing this user runs would change that.
    if (o.mac) return o.boot === "mine" ? { service: true } : { service: false, bootFix: o.boot === undefined ? MAC_BOOT_FIX : undefined };
    if (o.systemd && o.linger) return { service: true };
    return { service: false, bootFix: o.systemd && /^[\w.-]+$/.test(o.user) ? `sudo loginctl enable-linger ${shQuote(o.user)}` : undefined };
}

/** The same report, from what a probe found, for a server that's only being looked at. */
export function serviceReport(facts: ServerFacts): ServiceReport {
    return report({ systemd: facts.systemd, linger: facts.linger === true, user: facts.user, mac: facts.os === "Darwin", boot: facts.launchDaemon });
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
        ...(typeof s.builtAt === "number" && Number.isSafeInteger(s.builtAt) && s.builtAt > 0 ? { builtAt: s.builtAt } : {}),
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
    const boot = value(r.stdout, "boot");
    return report({ systemd: value(r.stdout, "systemd") === "1", linger: value(r.stdout, "linger") === "yes", user: value(r.stdout, "user") ?? "", mac: value(r.stdout, "mac") === "1", boot: boot === "mine" || boot === "other" ? boot : undefined });
}

export class UpdateFailed extends ServerError {
    constructor(
        message: string,
        /** What runs there now: the build before, when it could be put back. */
        readonly status?: HostStatus,
        /** Neither the build asked for nor the one before it started: nothing runs there now. */
        readonly down = false,
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
    throw new UpdateFailed(`Cavvy didn't start on ${hostOf(e)}${why ? `: ${why}` : "."}`, undefined, r.code === 45);
}

/** The build the server ran before the one it runs now, if it's still there: prints `previous=`. */
const PREVIOUS = `${LIB}
[ -x "$bin" ] || exit 46
p=$(cat "$d/previous" 2>/dev/null) || exit 49
case "$p" in ""|*[!0-9a-z-]*) exit 49 ;; esac
[ -x "$d/builds/$p/cavvy" ] || exit 49
[ "$p" != "$(current || true)" ] || exit 49
echo "previous=$p"
`;

/** The build a server can be put back on: the one it ran before its last update. Undefined when there's none to go back to. */
export async function previousBuild(e: ServerEntry, signal?: AbortSignal): Promise<string | undefined> {
    const r = await ssh(e, remoteSh(timed(PREVIOUS), []), { timeoutMs: 30_000, signal });
    if (r.code === 46) throw new NotSetUp(`Cavvy isn't set up on ${hostOf(e)}.`);
    const p = value(r.stdout, "previous");
    return r.code === 0 && p && BUILD_ID.test(p) ? p : undefined;
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
    /** When its build's commit was made (seconds), if it says: what orders two builds without a checkout. */
    builtAt?: number;
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
    return { code: p.code as string, port: p.port as number, run: p.run as string, gui: p.gui === true, build: p.build as string, ...(typeof p.builtAt === "number" && Number.isSafeInteger(p.builtAt) && p.builtAt > 0 ? { builtAt: p.builtAt } : {}), version: printable(String(p.version ?? ""), 40), protocol: count(p.protocol) };
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

/** The server's own account of what's there for agents, and on a Mac how Xcode stands. */
export async function remoteCheck(e: ServerEntry, signal?: AbortSignal): Promise<HostCheck> {
    const script = timed(CHECK).replaceAll("@@XCODE_VERSION@@", seconds(xcodeTiming.versionSeconds)).replaceAll("@@XCODE_SIMULATORS@@", seconds(xcodeTiming.simulatorsSeconds));
    const r = await ssh(e, remoteSh(script), { timeoutMs: 60_000, signal });
    if (r.code === 46) throw new NotSetUp(`Cavvy isn't set up on ${hostOf(e)}.`);
    const check = r.code === 0 ? readCheck(value(r.stdout, "check")) : undefined;
    if (!check) throw new ServerError(`Couldn't check ${hostOf(e)}${said(r.stderr) ? `: ${said(r.stderr)}` : "."}`);
    const xcode = XCODE_STATES.find((x) => x === value(r.stdout, "xcode"));
    return xcode ? { ...check, xcode } : check;
}

/** Builds the server no longer needs go: all but the one running, `previous` and `keep`. */
export async function pruneBuilds(e: ServerEntry, previous: string | undefined, keep: string, signal?: AbortSignal): Promise<void> {
    await ssh(e, remoteSh(timed(PRUNE), [previous && BUILD_ID.test(previous) ? previous : "-", BUILD_ID.test(keep) ? keep : "-"]), { timeoutMs: 30_000, signal }).catch(() => undefined);
}
