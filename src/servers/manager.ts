// The servers a running Cavvy (the GUI's own engine) knows and is connected
// to, for its windows: what `cavvy servers …` does in a terminal (cli.ts),
// as calls a window makes and answers it gets back. One connection per
// server, shared by every window, kept until the engine stops.
//
// Nothing here asks a question: a call that needs one (an unknown host key,
// a server that's working, a copy) says so in what it returns, and the
// window calls again with the answer.

import { PROTOCOL_VERSION } from "../server/protocol";
import { loadScope } from "../config/settings";
import { thisBuild, UNKNOWN_BUILD, type BuildSource } from "./build";
import { exchangeCode, ServerLink, type LinkState } from "./connect";
import { countCopied, describeCopy, describeLeft, planCopy, sendCopy } from "./copy";
import type { HostCheck } from "./host";
import { ServerBusy, setUpServer, type SetupProgress } from "./install";
import { probeServer } from "./remote";
import { NotSetUp, remoteCheck, remoteStatus, revokeOverSsh, serviceReport, stopRemote, StoppedThere } from "./service";
import { hostOf, offeredHostKey, printable, SshError, trustHostKey, type OfferedHostKey } from "./ssh";
import { draftServer, listServers, removeServer, requireServer, saveServer, ServerError, thisDesktop, type ServerEntry } from "./store";

/** A server as a window lists it. */
export interface ServerSummary {
    name: string;
    destination: string;
    /** Connected to from this Cavvy right now. */
    connected: boolean;
}

/** Why something on a server didn't happen, in words for the user: what, ssh's own line, and what to do. */
export interface ServerProblem {
    message: string;
    detail?: string;
    fix?: string;
}

/** A host key this machine hasn't seen: shown, and saved only if the user says so (`servers.trust`). */
export interface UnknownHost {
    host: string;
    fingerprints: string[];
}

export type ConnectResult =
    /** Where a window reaches the server's Cavvy, and what signs it in there. */
    | { status: "connected"; url: string; token: string }
    | { status: "unknown-host"; unknown: UnknownHost }
    /** The Cavvy there speaks another version of the protocol than this one: `servers.update` brings it level. */
    | { status: "other-version" }
    | { status: "failed"; problem: ServerProblem };

export type AddResult =
    | { status: "added"; name: string; note?: string; copy?: { what: string; left?: string } }
    | { status: "unknown-host"; unknown: UnknownHost }
    | { status: "failed"; problem: ServerProblem };

export type UpdateResult =
    | { status: "updated"; note?: string }
    /** Sessions there are working or waiting: updating stops them, so it's asked (`force`). */
    | { status: "busy"; working: number; waiting: number }
    | { status: "unknown-host"; unknown: UnknownHost }
    | { status: "failed"; problem: ServerProblem };

/** What a server has for agents, and what it lacks, as a window shows it. */
export interface ServerCheck {
    running: boolean;
    /** Runs the same build as this Cavvy. */
    current: boolean;
    clis: { id: string; product: string; installed: boolean; signedIn?: boolean; on?: boolean; install: string }[];
    git: boolean;
    gh: { installed: boolean; signedIn?: boolean };
    browser: boolean;
    /** Starts again by itself after the server restarts; when not, the command that makes it so. */
    service: boolean;
    lingerFix?: string;
}

export interface ServerProgress {
    name: string;
    text: string;
    /** Of the copy to the server, while that's what is happening. */
    percent?: number;
}

/** What changed for a server this Cavvy is connected to, told to every window. */
export interface ServerLinkEvent {
    name: string;
    state: "connected" | "reconnecting" | "stopped";
    problem?: ServerProblem;
}

function problemOf(e: unknown): ServerProblem {
    // Some of these words are a server's own: nothing in them may draw on a screen.
    if (e instanceof SshError) return { message: printable(e.message, 2000), ...(e.detail ? { detail: printable(e.detail) } : {}), ...(e.fix ? { fix: printable(e.fix) } : {}) };
    if (e instanceof ServerError) return { message: printable(e.message, 2000) };
    return { message: printable(String((e as Error)?.message ?? e), 2000) };
}

interface Linked {
    link: ServerLink;
    entry: ServerEntry;
    /** The run of the server's Cavvy the token is for: a restart there forgets every sign-in. */
    run?: string;
    token?: string;
    localPort?: number;
    /** Being opened by `connect`, which signs in itself: what the link says meanwhile isn't acted on twice. */
    opening?: boolean;
}

export class ServerLinks {
    private links = new Map<string, Linked>();
    /** Servers being connected to right now: every caller waits for the same attempt. */
    private starting = new Map<string, Promise<ConnectResult>>();
    /** The key each unknown host offered, by the server's name: what `trust` saves is what was shown. */
    private offered = new Map<string, { entry: ServerEntry; key: OfferedHostKey }>();

    /** `source`: where builds for servers come from (tests bring their own; otherwise this checkout). */
    constructor(private o: { onProgress?: (p: ServerProgress) => void; onLink?: (e: ServerLinkEvent) => void; source?: BuildSource } = {}) {}

    /** This Cavvy's own build, as a server would have it. */
    private build(): string {
        return this.o.source?.id ?? thisBuild();
    }

    list(): ServerSummary[] {
        return listServers().map((s) => ({ name: s.name, destination: s.destination, connected: this.links.get(s.name)?.link.state.state === "connected" }));
    }

    private progress(name: string): SetupProgress {
        return {
            step: (text) => this.o.onProgress?.({ name, text }),
            copied: (sent, total) => total > 0 && this.o.onProgress?.({ name, text: `Copying Cavvy to ${name}…`, percent: Math.min(100, Math.floor((sent / total) * 100)) }),
        };
    }

    /** An unknown host's key, fetched to be shown; undefined when the failure isn't that. */
    private async unknown(name: string, entry: ServerEntry, e: unknown): Promise<UnknownHost | undefined> {
        if (!(e instanceof SshError) || e.kind !== "host-unknown") return undefined;
        const key = await offeredHostKey(entry);
        this.offered.set(name, { entry, key });
        return { host: hostOf(entry), fingerprints: key.fingerprints };
    }

    /**
     * Saves the key that was shown for this server, if it's still the one shown (`fingerprints`). The entry as it's
     * now reached: a server already added is saved with it; one being added is saved by `add`.
     */
    trust(name: string, fingerprints: string[]): ServerEntry {
        const o = this.offered.get(name);
        if (!o || o.key.fingerprints.join("\n") !== fingerprints.join("\n")) throw new ServerError("That key is no longer the one on offer. Try again.");
        this.offered.delete(name);
        const entry = trustHostKey(o.entry, o.key);
        if (listServers().some((s) => s.name === name)) saveServer(entry);
        return entry;
    }

    /**
     * Adds a server: connects, puts this machine's build of Cavvy there and starts it. `trusted`: the entry `trust`
     * handed back, when the host's key was just accepted.
     */
    async add(draft: { name: string; destination: string; port?: number; identityFile?: string }, trusted?: ServerEntry): Promise<AddResult> {
        let entry: ServerEntry;
        try {
            entry = trusted ?? draftServer(draft);
        } catch (e) {
            return { status: "failed", problem: problemOf(e) };
        }
        this.o.onProgress?.({ name: entry.name, text: `Connecting to ${hostOf(entry)}…` });
        let note: string | undefined;
        try {
            const setup = await setUpServer(entry, { progress: this.progress(entry.name), source: this.o.source });
            if (setup.kept === "newer") note = "It runs a newer Cavvy than this machine.";
        } catch (e) {
            const unknown = await this.unknown(entry.name, entry, e).catch(() => undefined);
            if (unknown) return { status: "unknown-host", unknown };
            // It's there and working, on its own version: added, and updated another time.
            if (e instanceof ServerBusy) note = "It's working, so Cavvy there wasn't updated.";
            else return { status: "failed", problem: problemOf(e) };
        }
        saveServer(entry);
        return { status: "added", name: entry.name, ...(note ? { note } : {}), ...this.copyOffer() };
    }

    /** What the one-time copy would carry, and what would stay, as the question is worded. */
    private copyOffer(): { copy?: { what: string; left?: string } } {
        let plan;
        try {
            plan = planCopy(this.userSettings());
        } catch {
            return {};
        }
        try {
            const what = describeCopy(plan.counts);
            const left = describeLeft(plan.left);
            return what ? { copy: { what, ...(left ? { left } : {}) } } : {};
        } finally {
            plan.cleanup();
        }
    }

    private userSettings() {
        try {
            return loadScope("user", process.cwd());
        } catch {
            return undefined;
        }
    }

    /** The one-time copy of settings, memory, skills and commands. What the server took, in words ("" when it had them all). */
    async copy(name: string): Promise<{ took: string; left?: string }> {
        const entry = requireServer(name);
        const plan = planCopy(this.userSettings());
        try {
            const took = describeCopy(countCopied(await sendCopy(entry, plan)));
            const left = describeLeft(plan.left);
            return { took, ...(left ? { left } : {}) };
        } finally {
            plan.cleanup();
        }
    }

    async check(name: string): Promise<ServerCheck> {
        const entry = requireServer(name);
        const [status, facts, check] = await Promise.all([remoteStatus(entry), probeServer(entry), remoteCheck(entry) as Promise<HostCheck>]);
        const service = serviceReport(facts);
        return {
            running: Boolean(status),
            current: !status || this.build() === UNKNOWN_BUILD || status.build === this.build(),
            clis: check.clis.map((c) => ({ id: c.id, product: c.product, installed: c.installed, signedIn: c.signedIn, on: c.on, install: c.install })),
            git: check.git,
            gh: check.gh,
            browser: check.browser,
            service: service.service,
            ...(service.lingerFix ? { lingerFix: service.lingerFix } : {}),
        };
    }

    /** Brings the server's Cavvy level with this one. `force`: also when that stops work there, or replaces a build that isn't older. */
    async update(name: string, force = false): Promise<UpdateResult> {
        const entry = requireServer(name);
        let busy: { working: number; waiting: number } | undefined;
        try {
            const r = await setUpServer(entry, {
                source: this.o.source,
                progress: this.progress(name),
                confirmRestart: async (b) => {
                    busy = b;
                    return force;
                },
                confirmReplace: async (theirs) => force || theirs === "different",
            });
            // Its Cavvy restarted: what signed this one in there is gone, and the next connect signs in again.
            await this.drop(name, false);
            return { status: "updated", ...(r.kept === "newer" ? { note: "It runs a newer Cavvy than this machine, so it was left as it is." } : {}) };
        } catch (e) {
            if (e instanceof ServerBusy) return { status: "busy", working: busy?.working ?? e.busy.working, waiting: busy?.waiting ?? e.busy.waiting };
            const unknown = await this.unknown(name, entry, e).catch(() => undefined);
            if (unknown) return { status: "unknown-host", unknown };
            return { status: "failed", problem: problemOf(e) };
        }
    }

    /**
     * Connects to a server's Cavvy and signs this one in there. Called again by a window that lost its connection,
     * it answers with where things stand now: the same address and sign-in while those still hold.
     */
    connect(name: string): Promise<ConnectResult> {
        const going = this.starting.get(name);
        if (going) return going;
        const had = this.links.get(name);
        if (had && had.link.state.state === "connected" && had.token && had.localPort) return Promise.resolve({ status: "connected", url: `ws://127.0.0.1:${had.localPort}/ws`, token: had.token });
        const attempt = this.start(name).finally(() => {
            if (this.starting.get(name) === attempt) this.starting.delete(name);
        });
        this.starting.set(name, attempt);
        return attempt;
    }

    private async start(name: string): Promise<ConnectResult> {
        let entry: ServerEntry;
        try {
            entry = requireServer(name);
        } catch (e) {
            return { status: "failed", problem: problemOf(e) };
        }
        // One that gave up, or was for the server as it used to be reached: made again.
        await this.drop(name, false);
        const linked: Linked = {
            entry,
            link: new ServerLink(entry, { onState: (s) => void this.linkChanged(name, linked, s) }),
        };
        this.links.set(name, linked);
        const open = async (): Promise<ConnectResult> => {
            linked.opening = true;
            await linked.link.start();
            const s = linked.link.state;
            if (s.state !== "connected") return { status: "failed", problem: { message: `Couldn't connect to ${name}.` } };
            if (s.pairing.protocol !== PROTOCOL_VERSION) {
                await this.drop(name, true);
                return { status: "other-version" };
            }
            await this.signIn(linked, s);
            linked.opening = false;
            return { status: "connected", url: `ws://127.0.0.1:${linked.localPort}/ws`, token: linked.token! };
        };
        try {
            return await open();
        } catch (first) {
            try {
                const unknown = await this.unknown(name, entry, first);
                if (unknown) {
                    this.links.delete(name);
                    return { status: "unknown-host", unknown };
                }
                // Stopped there on purpose, or never set up: opening it is asking for it, so it's started (or set up).
                if (first instanceof NotSetUp || first instanceof StoppedThere) {
                    this.o.onProgress?.({ name, text: `Starting Cavvy on ${name}…` });
                    await setUpServer(entry, { progress: this.progress(name), source: this.o.source });
                    return await open();
                }
                throw first;
            } catch (e) {
                this.links.delete(name);
                return { status: "failed", problem: problemOf(e) };
            }
        }
    }

    /** Trades the connection's one-time code for a sign-in, once per run of the server's Cavvy. */
    private async signIn(linked: Linked, s: Extract<LinkState, { state: "connected" }>) {
        linked.localPort = s.localPort;
        if (linked.token && linked.run === s.pairing.run) return;
        linked.token = await exchangeCode(s.localPort, s.pairing.code);
        linked.run = s.pairing.run;
    }

    private async linkChanged(name: string, linked: Linked, s: LinkState) {
        if (this.links.get(name) !== linked || linked.opening) return;
        if (s.state === "connected") {
            // Back, perhaps to a Cavvy that restarted meanwhile and has forgotten this one: signed in again before it's said.
            try {
                await this.signIn(linked, s);
                this.o.onLink?.({ name, state: "connected" });
            } catch (e) {
                this.o.onLink?.({ name, state: "stopped", problem: problemOf(e) });
            }
        } else if (s.state === "reconnecting") {
            if (s.attempt === 1) this.o.onLink?.({ name, state: "reconnecting", problem: problemOf(s.error) });
        } else if (s.state === "stopped") {
            this.links.delete(name);
            this.o.onLink?.({ name, state: "stopped", ...(s.error ? { problem: problemOf(s.error) } : {}) });
        }
    }

    private async drop(name: string, signOut: boolean) {
        const l = this.links.get(name);
        if (!l) return;
        this.links.delete(name);
        await l.link.stop({ signOut }).catch(() => undefined);
    }

    /** Closes this Cavvy's connection to a server and signs it out there. Work there keeps running. */
    async disconnect(name: string) {
        await this.drop(name, true);
    }

    /** Stops the server's Cavvy. It stays stopped until it's opened again. */
    async stop(name: string): Promise<void> {
        const entry = requireServer(name);
        await this.drop(name, false);
        await stopRemote(entry);
    }

    /** Forgets the server here and signs this machine out there. False when it couldn't be reached to sign out. */
    async remove(name: string): Promise<{ signedOut: boolean }> {
        await this.drop(name, false);
        const entry = removeServer(name);
        try {
            await revokeOverSsh(entry, thisDesktop().id);
            return { signedOut: true };
        } catch {
            return { signedOut: false };
        }
    }

    /** The engine is stopping: every connection is closed and signed out. */
    async stopAll() {
        await Promise.all([...this.links.keys()].map((name) => this.drop(name, true)));
    }
}
