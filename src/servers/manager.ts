// The servers a running Cavvy (the GUI's own engine) knows and is connected
// to, for its windows: what `cavvy servers …` does in a terminal (cli.ts),
// as calls a window makes and answers it gets back. One connection per
// server, shared by every window, kept until the engine stops.
//
// Nothing here asks a question: a call that needs one (an unknown host key,
// a server that's working, a copy) says so in what it returns, and the
// window calls again with the answer.

import { PROTOCOL_VERSION, type AddResult, type ConnectResult, type MachineOverview, type ServerCheck, type ServerProblem, type ServerSummary, type UnknownHost, type UpdateResult } from "../server/protocol";
import { loadScope } from "../config/settings";
import { thisBuild, UNKNOWN_BUILD, type BuildSource } from "./build";
import { exchangeCode, ServerLink, type LinkState } from "./connect";
import { countCopied, describeCopy, describeLeft, planCopy, sendCopy } from "./copy";
import type { HostCheck } from "./host";
import { ServerBusy, setUpServer, type SetupProgress } from "./install";
import { probeServer } from "./remote";
import { NotSetUp, remoteCheck, remoteStatus, revokeOverSsh, serviceReport, stopRemote, StoppedThere } from "./service";
import { hostOf, offeredHostKey, printable, SshError, trustHostKey, type OfferedHostKey } from "./ssh";
import { draftServer, getServer, listServers, removeServer, requireServer, saveServer, ServerError, thisDesktop, type ServerEntry } from "./store";
import { MachineWatch, type LentCall, type LentResult, type MachineNotice } from "./watch";

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
    /** When the sign-in was made: one that's getting old is replaced before it's handed out again (RENEW_AFTER_MS). */
    signedAt?: number;
    /** When a window's retry last made the link try at once (TRY_NOW_EVERY_MS). */
    poked?: number;
    /** Being opened by `connect`, which signs in itself: what the link says meanwhile isn't acted on twice. */
    opening?: boolean;
    /** Callers waiting for it to say where it stands next (it's coming back by itself). */
    waiting?: Set<() => void>;
}

/**
 * A server's sign-ins stop working twelve hours after they're made (src/servers/host.ts), however much they're used.
 * One older than this is replaced when a window next asks, so a window is never handed one about to run out, or one
 * that has: a window left open overnight comes back by itself.
 */
const RENEW_AFTER_MS = 6 * 3600_000;
/** A window's own retries make a connection that's coming back try at once, but not more often than this. */
const TRY_NOW_EVERY_MS = 10_000;

export class ServerLinks {
    private links = new Map<string, Linked>();
    /** Servers being connected to right now: every caller waits for the same attempt. */
    private starting = new Map<string, { attempt: Promise<ConnectResult>; retry: boolean }>();
    /** Removed since this Cavvy started, as they were: what `restore` puts back. */
    private removed = new Map<string, ServerEntry>();
    /** This machine being signed out of a server that was just removed, by name: still on its way there. */
    private revoking = new Map<string, Promise<void>>();
    /** The key each unknown host offered, by the server's name: what `trust` saves is what was shown. */
    private offered = new Map<string, { entry: ServerEntry; key: OfferedHostKey }>();

    /** Each server's sessions, watched from here once a window asks for them (watchAll). */
    private watches = new Map<string, MachineWatch>();
    /** Servers whose sessions changed, told together a moment later. */
    private told = new Map<string, ReturnType<typeof setTimeout>>();
    /** Disconnected on the user's word: not connected to again until they ask. */
    private apart = new Set<string>();
    /** A window has asked for the servers' sessions: servers added from here on are watched too. */
    private watching = false;
    private stopped = false;

    /** `source`: where builds for servers come from (tests bring their own; otherwise this checkout). */
    /** `renewAfterMs`, `watchRetryMs`: for tests (RENEW_AFTER_MS; watch.ts). */
    constructor(
        private o: {
            onProgress?: (p: ServerProgress) => void;
            onLink?: (e: ServerLinkEvent) => void;
            /** A watched server's sessions, or how it's reached, changed. */
            onOverview?: (m: MachineOverview) => void;
            /** A session on a watched server has something to tell its user. */
            onNotice?: (name: string, n: MachineNotice) => void;
            /** What this machine lends its servers' sessions (src/tools/lent.ts), and the running of one call of it. */
            lends?: () => string[];
            lend?: (name: string, call: LentCall, signal: AbortSignal) => Promise<LentResult>;
            source?: BuildSource;
            renewAfterMs?: number;
            watchRetryMs?: number[];
        } = {},
    ) {}

    /**
     * Every server's sessions, watched from now on: a connection to each that's kept, and made again when it's lost,
     * without starting or setting up anything there. Asked again, it takes in servers added or removed since.
     */
    watchAll(): MachineOverview[] {
        this.watching = true;
        const names = new Set(listServers().map((s) => s.name));
        for (const [name, w] of this.watches) {
            if (names.has(name)) continue;
            w.stop();
            this.watches.delete(name);
            this.o.onOverview?.({ name, state: "removed", sessions: [] });
        }
        for (const name of names) {
            if (this.watches.has(name) || this.stopped) continue;
            const w = new MachineWatch(name, {
                reach: async (renew) => (this.apart.has(name) ? { status: "disconnected" } : this.connect(name, { retry: true, renew, quiet: true })),
                changed: () => this.tell(name),
                notice: (n) => this.o.onNotice?.(name, n),
                lends: this.o.lends,
                lend: this.o.lend && ((call, signal) => this.o.lend!(name, call, signal)),
                retryMs: this.o.watchRetryMs,
            });
            this.watches.set(name, w);
            w.start();
        }
        return [...this.watches.values()].map((w) => w.overview());
    }

    private tell(name: string) {
        if (this.told.has(name) || !this.o.onOverview) return;
        const t = setTimeout(() => {
            this.told.delete(name);
            const w = this.watches.get(name);
            if (w) this.o.onOverview?.(w.overview());
        }, 150);
        (t as { unref?: () => void }).unref?.();
        this.told.set(name, t);
    }

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
        if (this.watching) this.watchAll();
        return { status: "added", name: entry.name, ...(note ? { note } : {}), ...this.copyOffer() };
    }

    /** What the one-time copy would carry, and what would stay, as the question is worded. */
    private copyOffer(): { copy?: { what: string }; left?: string } {
        let plan;
        try {
            plan = planCopy(this.userSettings());
        } catch {
            return {};
        }
        try {
            const what = describeCopy(plan.counts);
            const left = describeLeft(plan.left);
            return { ...(what ? { copy: { what } } : {}), ...(left ? { left } : {}) };
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
     * `retry`: the window's connection trying again by itself, not the user asking. That waits for a connection
     * that's coming back instead of making another, and leaves a server that was stopped on purpose stopped.
     * `renew`: the sign-in last handed out didn't open anything (it had run out, or was taken away): a new one.
     */
    connect(name: string, o: { retry?: boolean; renew?: boolean; quiet?: boolean } = {}): Promise<ConnectResult> {
        if (!o.retry) {
            this.apart.delete(name);
            // The user is waiting: a connection that's coming back by itself, which the watch of its sessions only
            // waits on, is tried now.
            const link = this.links.get(name)?.link;
            if (link?.state.state === "reconnecting") link.tryNow();
        }
        const going = this.starting.get(name);
        // One attempt at a time, shared. Not a retry's answer for the user's asking, though: a retry leaves a
        // stopped server stopped and waits on a connection that's coming back, where the user's asking doesn't.
        if (going && (o.retry || !going.retry)) return going.attempt;
        const attempt = (going ? going.attempt.then((r) => (r.status === "connected" ? r : this.reach(name, o))) : this.reach(name, o))
            .then(async (r): Promise<ConnectResult> => {
                if (r.status !== "connected") return r;
                // Removed while it was being connected to: nothing of it is kept, and this machine is signed out again.
                if (!getServer(name)) {
                    await this.drop(name, true);
                    return { status: "failed", problem: { message: `No server named ${name}.` } };
                }
                // The user's own doing (they opened it, started it, trusted its key): its sessions are listed at once.
                if (!o.retry) this.watches.get(name)?.poke();
                return r;
            })
            .finally(() => {
                if (this.starting.get(name)?.attempt === attempt) this.starting.delete(name);
            });
        this.starting.set(name, { attempt, retry: Boolean(o.retry) });
        return attempt;
    }

    private async reach(name: string, o: { retry?: boolean; renew?: boolean; quiet?: boolean }): Promise<ConnectResult> {
        const had = this.links.get(name);
        const here = (l: Linked): ConnectResult => ({ status: "connected", url: `ws://127.0.0.1:${l.localPort}/ws`, token: l.token! });
        const up = (l: Linked) => l.link.state.state === "connected" && l.token !== undefined && l.localPort !== undefined;
        if (had && up(had)) {
            if (!o.renew && Date.now() - (had.signedAt ?? 0) < (this.o.renewAfterMs ?? RENEW_AFTER_MS)) return here(had);
            try {
                const pairing = await had.link.pair();
                had.token = await exchangeCode(had.localPort!, pairing.code);
                had.run = pairing.run;
                had.signedAt = Date.now();
                return here(had);
            } catch {
                // Not through this connection: made again below.
            }
        } else if (had && o.retry && had.link.state.state === "reconnecting") {
            // Coming back by itself: waited for, not replaced (the address and the sign-in then stay as they were).
            // Tried now rather than when its own wait is over: a window asks again when there's reason to.
            // Not for the watch of its sessions (`quiet`), which nobody is waiting on: the connection's own pace will do.
            if (!o.quiet && Date.now() - (had.poked ?? 0) >= TRY_NOW_EVERY_MS) {
                had.poked = Date.now();
                had.link.tryNow();
            }
            await this.changed(had, 20_000);
            if (this.links.get(name) === had) {
                if (up(had)) return here(had);
                const s = had.link.state;
                if (s.state === "reconnecting") return { status: "failed", problem: problemOf(s.error) };
            }
        }
        return this.start(name, Boolean(o.retry));
    }

    /** Settles when the link next says where it stands (linkChanged), or after `ms`. */
    private changed(linked: Linked, ms: number): Promise<void> {
        return new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                linked.waiting?.delete(done);
                resolve();
            };
            const timer = setTimeout(done, ms);
            (linked.waiting ??= new Set()).add(done);
        });
    }

    private async start(name: string, resume: boolean): Promise<ConnectResult> {
        let entry: ServerEntry;
        try {
            entry = requireServer(name);
        } catch (e) {
            return { status: "failed", problem: problemOf(e) };
        }
        // One that gave up, or was for the server as it used to be reached: made again.
        await this.drop(name, false);
        // A sign-out still on its way there (remove, then put back) would take this sign-in with it.
        await this.revoking.get(name);
        let linked!: Linked;
        const open = async (): Promise<ConnectResult> => {
            const made: Linked = { entry, link: new ServerLink(entry, { onState: (s) => void this.linkChanged(name, made, s), resume }), opening: true };
            linked = made;
            this.links.set(name, made);
            await made.link.start();
            const s = made.link.state;
            if (s.state !== "connected") throw new ServerError(`Couldn't connect to ${name}.`);
            if (s.pairing.protocol !== PROTOCOL_VERSION) {
                await this.drop(name, true);
                return { status: "other-version" };
            }
            await this.signIn(made, s);
            made.opening = false;
            return { status: "connected", url: `ws://127.0.0.1:${made.localPort}/ws`, token: made.token! };
        };
        /** Nothing of a failed attempt is left running: its tunnel may be up though the sign-in failed. */
        const end = async () => {
            if (this.links.get(name) === linked) this.links.delete(name);
            await linked.link.stop({ signOut: false }).catch(() => undefined);
        };
        try {
            return await open();
        } catch (first) {
            await end();
            try {
                const unknown = await this.unknown(name, entry, first);
                if (unknown) return { status: "unknown-host", unknown };
                // Stopped there on purpose: only the user's asking starts it again.
                if (first instanceof StoppedThere) return { status: "stopped" };
                // Never set up, and the user is asking for it: set up, then connected to anew.
                if (first instanceof NotSetUp && !resume) {
                    this.o.onProgress?.({ name, text: `Starting Cavvy on ${name}…` });
                    await setUpServer(entry, { progress: this.progress(name), source: this.o.source });
                    return await open();
                }
                throw first;
            } catch (e) {
                await end();
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
        linked.signedAt = Date.now();
    }

    private async linkChanged(name: string, linked: Linked, s: LinkState) {
        if (this.links.get(name) !== linked || linked.opening) return;
        if (s.state === "connected") {
            // Back, perhaps to a Cavvy that restarted meanwhile and has forgotten this one: signed in again before it's said.
            try {
                await this.signIn(linked, s);
                this.o.onLink?.({ name, state: "connected" });
                this.watches.get(name)?.poke();
            } catch (e) {
                // Connected and not signed in is no use to a window: ended, so the next one to ask starts over.
                await this.drop(name, false);
                this.o.onLink?.({ name, state: "stopped", problem: problemOf(e) });
            }
        } else if (s.state === "reconnecting") {
            if (s.attempt === 1) this.o.onLink?.({ name, state: "reconnecting", problem: problemOf(s.error) });
        } else if (s.state === "stopped") {
            this.links.delete(name);
            this.o.onLink?.({ name, state: "stopped", ...(s.error ? { problem: problemOf(s.error) } : {}) });
        }
        for (const told of [...(linked.waiting ?? [])]) told();
    }

    private async drop(name: string, signOut: boolean) {
        const l = this.links.get(name);
        if (!l) return;
        this.links.delete(name);
        // Whoever waits on it hears now, not when their wait runs out: it says nothing more once it's out of the list.
        for (const told of [...(l.waiting ?? [])]) told();
        await l.link.stop({ signOut }).catch(() => undefined);
    }

    /** Closes this Cavvy's connection to a server and signs it out there. Work there keeps running. */
    async disconnect(name: string) {
        // Its sessions aren't watched either until the user opens it again: a watch would connect straight back.
        this.apart.add(name);
        await this.drop(name, true);
        this.watches.get(name)?.poke();
    }

    /** Stops the server's Cavvy. It stays stopped until it's opened again. */
    async stop(name: string): Promise<void> {
        const entry = requireServer(name);
        await this.drop(name, false);
        await stopRemote(entry);
        this.watches.get(name)?.poke();
    }

    /**
     * Forgets a server: gone from the list at once. This machine is then signed out there, which isn't waited for
     * (a server that doesn't answer takes ssh ten seconds or more to say so, and its sign-ins end by themselves).
     */
    async remove(name: string): Promise<null> {
        await this.drop(name, false);
        const entry = removeServer(name);
        this.removed.set(name, entry);
        if (this.watching) this.watchAll();
        const out = revokeOverSsh(entry, thisDesktop().id)
            .catch(() => undefined)
            .then(() => {
                if (this.revoking.get(name) === out) this.revoking.delete(name);
            });
        this.revoking.set(name, out);
        return null;
    }

    /** Undoes a removal made since this Cavvy started: the server is listed again as it was, and signs in when next opened. */
    restore(name: string): void {
        const entry = this.removed.get(name);
        if (!entry) throw new ServerError(`${name} can't be put back. Add it again.`);
        if (getServer(name)) throw new ServerError(`There's already a server named ${name}.`);
        saveServer(entry);
        this.removed.delete(name);
        if (this.watching) this.watchAll();
    }

    /** The engine is stopping: every connection is closed and signed out. */
    /** What this machine lends changed (its Simulator turned off or on): each server it's connected to is told now. */
    relend() {
        for (const w of this.watches.values()) w.relend();
    }

    /**
     * This Cavvy is going: the servers aren't listened to from here on, before anything else of it ends. What a
     * session there still waits for from this machine is then "it went away", not whatever closing its sessions
     * here would answer for the user.
     */
    stopWatching() {
        this.stopped = true;
        for (const w of this.watches.values()) w.stop();
    }

    async stopAll() {
        this.stopped = true;
        for (const w of this.watches.values()) w.stop();
        this.watches.clear();
        for (const t of this.told.values()) clearTimeout(t);
        this.told.clear();
        await Promise.all([...this.links.keys()].map((name) => this.drop(name, true)));
    }
}
