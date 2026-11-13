// Putting Cavvy on a server and bringing it up to this machine's build.
//
// A build is unpacked beside the others, never over one: it's checked against
// its checksum there, then run once to see that it starts on that machine,
// and only then given its place. A copy that stops part way, arrives changed,
// or can't run leaves the server as it was. What's permanent (the wrong kind
// of machine, a checksum that doesn't match) is said once and not tried again.

import { createReadStream } from "fs";
import { type BuildSource, type ServerBuild } from "./build";
import { buildSource } from "./sources";
import type { HostStatus } from "./host";
import { checkRoom, probeServer, REMOTE_DIR, targetFor, type ServerFacts } from "./remote";
import { applyBuild, pruneBuilds, remoteStatus, NotSetUp, setUpService, type ServiceReport } from "./service";
import { hostOf, printable, remoteSh, ssh } from "./ssh";
import { ServerError, type ServerEntry } from "./store";

/**
 * Unpacks stdin as build $1, whose program must hash to $2. Exits 41 when it
 * doesn't, 42 when it can't run there.
 */
const RECEIVE = `
set -e
umask 077
b="${REMOTE_DIR}/builds"
id="$1"
mkdir -p "$b"
chmod 700 "${REMOTE_DIR}"
in="$b/.incoming-$id-$$"
# What copies that were cut off left behind. Not one still arriving from another machine: only what's sat for half an hour.
find "$b" -maxdepth 1 -name '.incoming-*' -mmin +30 -exec rm -rf {} + 2>/dev/null || true
mkdir "$in"
trap 'rm -rf "$in"' EXIT
# A shell that dies of a signal skips that (dash does): ended by one, it leaves the ordinary way.
trap 'exit 1' HUP INT TERM
tar -xzf - -C "$in"
got=$( (sha256sum "$in/cavvy" 2>/dev/null || shasum -a 256 "$in/cavvy") | cut -d' ' -f1)
if [ "$got" != "$2" ]; then echo "expected $2, got $got" >&2; exit 41; fi
chmod 700 "$in/cavvy"
if ! out=$("$in/cavvy" host version 2>&1); then echo "$out" | tail -n 3 >&2; exit 42; fi
case "$out" in *"\\"build\\":\\"$id\\""*) ;; *) echo "it answered: $out" | tail -n 3 >&2; exit 42 ;; esac
rm -rf "$b/$id"
mv "$in" "$b/$id"
trap - EXIT
`;

export interface SetupProgress {
    /** A new line: what's being done now. */
    step(text: string): void;
    /** The copy to the server, as it goes. */
    copied?(sent: number, total: number): void;
}

/** Copies a build to the server, unless it's there already. */
export async function sendBuild(e: ServerEntry, build: ServerBuild, facts: ServerFacts, o: { progress?: SetupProgress; signal?: AbortSignal } = {}): Promise<void> {
    // There already, with its GUI if this one has it.
    if (facts.builds.includes(build.id) && (!build.gui || facts.guiBuilds.includes(build.id))) return;
    checkRoom(facts, e);
    const host = hostOf(e);
    o.progress?.step(`Copying Cavvy to ${e.name}…`);
    const r = await ssh(e, remoteSh(RECEIVE, [build.id, build.sha256]), {
        stdin: createReadStream(build.bundle) as unknown as AsyncIterable<Uint8Array>,
        // A slow line still gets there: 55 MB at 100 KB/s is ten minutes.
        timeoutMs: 30 * 60_000,
        signal: o.signal,
        onSent: (sent) => o.progress?.copied?.(sent, build.bundleBytes),
    });
    if (r.code === 0) return;
    const said = printable(r.stderr.trim().split("\n").slice(-3).join(" "), 400);
    if (r.code === 41) throw new ServerError(`The copy of Cavvy that reached ${host} isn't the one sent (${said}). Nothing was installed.`);
    if (r.code === 42) throw new ServerError(`Cavvy doesn't run on ${host}: ${said || "it didn't start."}`);
    throw new ServerError(`Couldn't copy Cavvy to ${host}: ${said || `exit ${r.code}`}`);
}

export interface SetupResult {
    facts: ServerFacts;
    status: HostStatus;
    /** Missing when the server was left on its own build. */
    service?: ServiceReport;
    /** The build that ran there before, when this changed it. */
    replaced?: string;
    /** The server kept its own build, which is this to ours. */
    kept?: "newer" | "different";
}

export interface SetupOptions {
    progress?: SetupProgress;
    signal?: AbortSignal;
    /**
     * Asked before a running server is restarted while sessions on it are
     * working or waiting for an answer, which the restart loses. Without it,
     * or when it says no, the server is left as it is.
     */
    confirmRestart?: (busy: { working: number; waiting: number }) => Promise<boolean>;
    /**
     * Asked before a build that isn't known to be older than this one is
     * replaced: another machine may have put it there. Without it, or when it
     * says no, the server keeps its build.
     */
    confirmReplace?: (theirs: "newer" | "different") => Promise<boolean>;
    /** Where the build comes from (tests bring their own). */
    source?: BuildSource;
}

/** Thrown when the server was left on its own build because restarting it would cut work off. */
export class ServerBusy extends ServerError {
    constructor(
        readonly server: string,
        readonly busy: { working: number; waiting: number },
        readonly status: HostStatus,
    ) {
        super(`${server} is working, so Cavvy there wasn't updated.`);
    }
}

/**
 * Brings the server to this machine's build, running: first set-up and
 * update are the same steps. A server already on this build is only made
 * sure of. One on a build that may be newer keeps it unless the caller says
 * otherwise: a server's version only moves forward by itself, so two machines
 * that share one don't each put their own back.
 */
export async function setUpServer(e: ServerEntry, o: SetupOptions = {}): Promise<SetupResult> {
    const facts = await probeServer(e, o.signal);
    const target = targetFor(facts, e);
    const source = o.source ?? buildSource();
    const id = source.id;
    let running: HostStatus | undefined;
    try {
        running = await remoteStatus(e, o.signal);
    } catch (err) {
        if (!(err instanceof NotSetUp)) throw err;
    }
    const theirs = running?.build ?? facts.current;
    // The time comes with the build it's of: only from a server that's running, which says both.
    const relation = theirs ? source.compare(theirs, running?.build === theirs ? running.builtAt : undefined) : undefined;
    if (theirs && (relation === "newer" || relation === "different") && !(await o.confirmReplace?.(relation))) {
        if (running) return { facts, status: running, kept: relation };
        o.progress?.step(`Starting Cavvy on ${e.name}…`);
        return { facts, status: await applyBuild(e, theirs, o.signal), kept: relation };
    }
    const settled = Boolean(running) && relation === "same" && facts.current === id;
    // The same build, but put there before its GUI was built here: sent again with it, if a build made now has it.
    const wantsGui = source.gui && !facts.guiBuilds.includes(id);
    if (settled && !wantsGui) return { facts, status: running!, service: await setUpService(e, o.signal) };
    /** Everything past this restarts the server: asked about first when that would cut work off. */
    const mayRestart = async () => {
        if (!running || (running.working === 0 && running.waiting === 0)) return;
        const busy = { working: running.working, waiting: running.waiting };
        if (!(await o.confirmRestart?.(busy))) throw new ServerBusy(e.name, busy, running);
    };
    // Another build is certain to restart it: asked before anything is built or copied for nothing.
    if (!settled) await mayRestart();
    // And no room for one is said before it's built, not after.
    if (!facts.builds.includes(id)) checkRoom(facts, e);
    const build = !facts.builds.includes(id) || wantsGui ? await source.build(target, { onStep: o.progress?.step, signal: o.signal }) : undefined;
    const send = build !== undefined && (!facts.builds.includes(id) || (build.gui && !facts.guiBuilds.includes(id)));
    // The GUI didn't build here after all: what's there is as good as it gets, and restarting it would change nothing.
    if (settled && !send) return { facts, status: running!, service: await setUpService(e, o.signal) };
    if (settled) await mayRestart();
    if (send) await sendBuild(e, build, facts, o);
    const service = await setUpService(e, o.signal);
    o.progress?.step(`Starting Cavvy on ${e.name}…`);
    const status = await applyBuild(e, id, o.signal);
    void pruneBuilds(e, theirs, id);
    return { facts, status, service, replaced: theirs && theirs !== id ? theirs : undefined };
}

/** Makes sure this machine's build is on the server, without touching the one that runs there. */
export async function ensureBuildThere(e: ServerEntry, o: { progress?: SetupProgress; signal?: AbortSignal; source?: BuildSource } = {}): Promise<void> {
    const facts = await probeServer(e, o.signal);
    const target = targetFor(facts, e);
    const source = o.source ?? buildSource();
    if (facts.builds.includes(source.id)) return;
    checkRoom(facts, e);
    await sendBuild(e, await source.build(target, { onStep: o.progress?.step, signal: o.signal }), facts, o);
    // Each change here makes another build: the ones before it go, but for what runs there.
    void pruneBuilds(e, facts.current, source.id);
}
