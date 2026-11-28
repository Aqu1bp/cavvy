// The servers a running Cavvy (the GUI's own engine) knows and is connected
// to, for its windows: what `cavvy servers …` does in a terminal (cli.ts),
// as calls a window makes and answers it gets back. One connection per
// server, shared by every window, kept until the engine stops.
//
// Nothing here asks a question: a call that needs one (an unknown host key,
// a server that's working, a copy) says so in what it returns, and the
// window calls again with the answer.

import { PROTOCOL_VERSION, RELAYED_ARCHIVE_OFFER, RELAYED_SESSION_METHODS, type AddResult, type ConnectResult, type MachineOverview, type ServerCheck, type ServerProblem, type ServerSummary, type ServerSyncItemResult, type UnknownHost, type UpdateResult } from "../server/protocol";
import { existsSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "fs";
import { dirname, join, relative, sep } from "path";
import { cavvyHome, ensureDir } from "../config/paths";
import { loadScope } from "../config/settings";
import { compareBuilds, thisBuild, thisBuildTime, UNKNOWN_BUILD, type BuildSource } from "./build";
import { exchangeCode, ServerLink, type LinkState } from "./connect";
import { countCopied, describeCopy, describeLeft, planCopy, sendCopy } from "./copy";
import type { HostCheck } from "./host";
import { ServerBusy, setUpServer, type SetupProgress } from "./install";
import { probeServer } from "./remote";
import { NotSetUp, remoteCheck, remoteStatus, revokeOverSsh, serviceReport, stopRemote, StoppedThere } from "./service";
import { hostOf, offeredHostKey, printable, SshError, trustHostKey, type OfferedHostKey } from "./ssh";
import { draftServer, getServer, listServers, removeServer, requireServer, saveServer, ServerError, thisDesktop, type ServerEntry } from "./store";
import { syncedWatchTargets, syncTo } from "./sync";
import { describeSyncRun, syncAllTo, type SyncRunResult } from "./sync-state";
import { MachineWatch, type LentCall, type LentResult, type MachineNotice, type SessionChange } from "./watch";

/** A server's sessions as last heard (MachineWatch kept): listed while it can't be reached, from the next launch too. */
const keptFile = (name: string) => join(cavvyHome(), "servers", `${encodeURIComponent(name)}.sessions.json`);
function readKept(name: string): unknown {
    try {
        return existsSync(keptFile(name)) ? JSON.parse(readFileSync(keptFile(name), "utf8")) : undefined;
    } catch {
        return undefined;
    }
}
function writeKept(name: string, sessions: unknown[], file = keptFile(name)) {
    try {
        ensureDir(join(cavvyHome(), "servers"));
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(sessions), { mode: 0o600 });
        renameSync(tmp, file);
    } catch {
        // Not kept this time: listed again once it's reached.
    }
}
/** The changes made to a server's sessions here while it couldn't be reached, not sent yet (watch.ts PendingChange). */
const pendingFile = (name: string) => join(cavvyHome(), "servers", `${encodeURIComponent(name)}.pending.json`);
function readPending(name: string): unknown {
    try {
        return existsSync(pendingFile(name)) ? JSON.parse(readFileSync(pendingFile(name), "utf8")) : undefined;
    } catch {
        return undefined;
    }
}
function writePending(name: string, changes: unknown[]) {
    if (!changes.length) return void rmSync(pendingFile(name), { force: true });
    writeKept(name, changes, pendingFile(name));
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
            /** How a watched server is reached changed, or its sessions were listed anew. */
            onOverview?: (m: MachineOverview) => void;
            /** One session on a watched server changed, or went. */
            onSession?: (name: string, change: SessionChange) => void;
            /** A session on a watched server has something to tell its user. */
            onNotice?: (name: string, n: MachineNotice) => void;
            /** What this machine lends its servers' sessions (src/tools/lent.ts), and the running of one call of it. */
            lends?: () => string[];
            lendMode?: () => string;
            lend?: (name: string, call: LentCall, signal: AbortSignal) => Promise<LentResult>;
            /** This machine's skills and commands are kept on its servers (src/servers/sync.ts): the user's own machine. */
            sync?: boolean;
            /** How long a change to them settles before servers hear of it. */
            syncSettleMs?: number;
            /** Sync asks a server which of its CLIs need signing in, which `servers sync` says. The app has its own check. */
            signIns?: boolean;
            /** Answers what a session on server `name` asks about the user's other machines' sessions (src/server/far-peers.ts). */
            peers?: (name: string, op: string, params: Record<string, unknown>) => Promise<unknown>;
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
            rmSync(keptFile(name), { force: true });
            rmSync(pendingFile(name), { force: true });
            this.o.onOverview?.({ name, state: "removed", sessions: [] });
        }
        for (const name of names) {
            if (this.watches.has(name) || this.stopped) continue;
            const w = new MachineWatch(name, {
                reach: async (renew) => (this.apart.has(name) ? { status: "disconnected" } : this.connect(name, { retry: true, renew, quiet: true })),
                changed: () => this.tell(name),
                session: (change) => this.o.onSession?.(name, change),
                notice: (n) => this.o.onNotice?.(name, n),
                lends: this.o.lends,
                lendMode: this.o.lendMode,
                lend: this.o.lend && ((call, signal) => this.o.lend!(name, call, signal)),
                sync: this.o.sync ? (ask) => this.syncFor(name, ask) : undefined,
                peers: this.o.peers && ((op, params) => this.o.peers!(name, op, params)),
                retryMs: this.o.watchRetryMs,
                kept: { read: () => readKept(name), write: (sessions) => writeKept(name, sessions) },
                pending: { read: () => readPending(name), write: (changes) => writePending(name, changes) },
            });
            this.watches.set(name, w);
            w.start();
        }
        this.watchSynced();
        return [...this.watches.values()].map((w) => this.shown(w));
    }

    /**
     * Asks a server's Cavvy for something a session's row offers (rename, pin, archive, delete and the like), for a
     * window that isn't on that server. Only those: anything else is done in a window that's on it.
     */
    async relay(name: string, method: string, params: Record<string, unknown>): Promise<{ worktree: true } | { unsaved: true } | { title: string } | null> {
        const known = method === RELAYED_ARCHIVE_OFFER ? RELAYED_ARCHIVE_OFFER : RELAYED_SESSION_METHODS.find((m) => m === method);
        if (!known) throw new Error("Open the session to do that.");
        const id = params.id;
        if (typeof id !== "string" || !/^[\w.-]{1,120}$/.test(id)) throw new Error("That isn't a session's id.");
        const w = this.watches.get(name);
        if (!w) throw new Error(`${name} isn't one of this Cavvy's servers.`);
        // Each with what it takes and nothing else (archiving never removes a worktree from here), and nothing of
        // what the server answers is passed on, but the two flags and the new title below.
        const sent =
            known === "session.rename" ? { id, title: typeof params.title === "string" ? params.title.slice(0, 300) : "" }
            : known === "session.pin" ? { id, pinned: params.pinned === true }
            : known === "session.settle" ? { id, settled: params.settled === true }
            : known === "session.archive" ? { id, archived: params.archived === true }
            : known === "session.neverSettle" ? { id, on: params.on === true }
            : known === "session.snooze" ? { id, until: typeof params.until === "number" && Number.isFinite(params.until) ? params.until : null }
            : { id };
        const answer = await w.call(known, sent);
        // Only that it has one: where it is and what removing it would take are that machine's to ask about.
        if (known === RELAYED_ARCHIVE_OFFER) return answer && typeof answer === "object" && (answer as { worktree?: unknown }).worktree ? { worktree: true } : null;
        // A delete there that had nothing to put in its trash: no Undo here either.
        if (known === "session.delete") return answer && typeof answer === "object" && (answer as { unsaved?: unknown }).unsaved === true ? { unsaved: true } : null;
        // The title it was given there, for the row's toast and its Undo here.
        if (known === "session.regenerateTitle") {
            const title = answer && typeof answer === "object" ? (answer as { title?: unknown }).title : undefined;
            return typeof title === "string" ? { title: title.slice(0, 300) } : null;
        }
        return null;
    }

    /** This machine asks its user something for a session on a server (it lends it a tool), or no longer does: its row there says it waits. */
    asking(name: string, id: string, on: boolean) {
        this.watches.get(name)?.setAsking(id, on);
    }

    private tell(name: string) {
        if (this.told.has(name) || !this.o.onOverview) return;
        const t = setTimeout(() => {
            this.told.delete(name);
            const w = this.watches.get(name);
            if (w) this.o.onOverview?.(this.shown(w));
        }, 150);
        (t as { unref?: () => void }).unref?.();
        this.told.set(name, t);
    }

    /** This Cavvy's own build, as a server would have it. */
    private build(): string {
        return this.o.source?.id ?? thisBuild();
    }

    /** How each build met on a server stands to this one: asked of the checkout once. */
    private relations = new Map<string, boolean>();
    /**
     * The Cavvy connected to on `name` isn't this machine's build, nor a newer one: updating it is offered. Not said
     * of one this Cavvy can't compare (it doesn't know its own build).
     */
    private behind(name: string): boolean {
        const s = this.links.get(name)?.link.state;
        const mine = this.build();
        if (s?.state !== "connected" || mine === UNKNOWN_BUILD || s.pairing.build === mine) return false;
        // By its time too: the same build said with one, later, can be placed where it couldn't before.
        const key = `${s.pairing.build}@${s.pairing.builtAt ?? ""}`;
        let behind = this.relations.get(key);
        if (behind === undefined) {
            // With its build's time, as the update itself compares them: an app with no checkout tells a newer one by it.
            const relation = this.o.source ? this.o.source.compare(s.pairing.build, s.pairing.builtAt) : compareBuilds(s.pairing.build, mine, undefined, { theirs: s.pairing.builtAt, mine: thisBuildTime() });
            this.relations.set(key, (behind = relation === "older" || relation === "different"));
        }
        return behind;
    }

    /** A watched machine as a window shows it. */
    private shown(w: MachineWatch): MachineOverview {
        const o = w.overview();
        return o.state === "connected" && this.behind(o.name) ? { ...o, behind: true } : o;
    }

    list(): ServerSummary[] {
        return listServers().map((s) => {
            const sync = this.watches.get(s.name)?.syncStatus();
            const showSync = sync && (sync.state === "error" || Boolean(sync.missingClis?.length) || Boolean(sync.needsSignIn?.length));
            return {
                name: s.name,
                destination: s.destination,
                connected: this.links.get(s.name)?.link.state.state === "connected",
                ...(this.behind(s.name) ? { behind: true } : {}),
                ...(s.cloud?.cost ? { cost: s.cloud.cost } : {}),
                // Removing it can delete the machine too (ServerRemove): the window asks which is meant.
                ...(s.cloud?.teardown?.length ? { rented: true } : {}),
                ...(s.sync !== undefined ? { syncOn: s.sync } : {}),
                ...(showSync ? { sync } : {}),
            };
        });
    }

    /** `also`: whoever asked for this setup hears each step too (an agent's tool call, which shows it in the conversation). */
    private progress(name: string, also?: (text: string) => void): SetupProgress {
        let said = -1;
        return {
            step: (text) => {
                this.o.onProgress?.({ name, text });
                also?.(text);
            },
            copied: (sent, total) => {
                if (total <= 0) return;
                const percent = Math.min(100, Math.floor((sent / total) * 100));
                this.o.onProgress?.({ name, text: `Copying Cavvy to ${name}…`, percent });
                // A line per quarter, not per chunk.
                const quarter = Math.floor(percent / 25);
                if (also && quarter > said) also(`Copying Cavvy to ${name}… ${percent}%`);
                said = Math.max(said, quarter);
            },
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
    async add(draft: { name: string; destination: string; port?: number; identityFile?: string; knownHostsFile?: string; cloud?: ServerEntry["cloud"]; sync?: boolean }, trusted?: ServerEntry, heard?: (text: string) => void): Promise<AddResult> {
        let entry: ServerEntry;
        try {
            entry = trusted ?? draftServer(draft);
        } catch (e) {
            return { status: "failed", problem: problemOf(e) };
        }
        this.o.onProgress?.({ name: entry.name, text: `Connecting to ${hostOf(entry)}…` });
        heard?.(`Connecting to ${hostOf(entry)}…`);
        let note: string | undefined;
        try {
            const setup = await setUpServer(entry, { progress: this.progress(entry.name, heard), source: this.o.source });
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
        // When live sync is active, skills, commands, agents, memory, themes, keybindings, settings, plugins and
        // providers sync automatically once connected, so no one-time copy dialog is needed.
        if (this.o.sync) return {};
        let plan;
        try {
            plan = planCopy(this.userSettings(), { skills: true });
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
        const plan = planCopy(this.userSettings(), { skills: !this.o.sync });
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
            ...(service.bootFix ? { bootFix: service.bootFix } : {}),
            ...(service.bootHere ? { bootHere: true as const } : {}),
            ...(check.xcode ? { xcode: check.xcode } : {}),
        };
    }

    /** Brings the server's Cavvy level with this one. `force`: also when that stops work there, or replaces a build that isn't older. */
    /** `stop`: though sessions there are working or waiting (the user said so). `force`: that, and though it runs a newer build. */
    async update(name: string, force = false, stop = false): Promise<UpdateResult> {
        const entry = requireServer(name);
        let busy: { working: number; waiting: number } | undefined;
        try {
            const r = await setUpServer(entry, {
                source: this.o.source,
                progress: this.progress(name),
                confirmRestart: async (b) => {
                    busy = b;
                    return force || stop;
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
                // Connected for anyone but the watch of its sessions (the user opened it, a window's connection came back
                // by itself): those are listed at once, not when the watch's own wait is over (up to a minute).
                if (!o.quiet) this.watches.get(name)?.poke();
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
        // Synced with this machine and reachable now: its keys are taken off it first, by the connection there is,
        // while the list already goes without it. One out of reach keeps them (and is told when it's put back).
        const w = this.watches.get(name);
        const leaving = getServer(name)?.sync === true && w?.overview().state === "connected" ? w : undefined;
        if (leaving) {
            this.watches.delete(name);
            rmSync(keptFile(name), { force: true });
            rmSync(pendingFile(name), { force: true });
            this.o.onOverview?.({ name, state: "removed", sessions: [] });
        }
        const entry = removeServer(name);
        this.removed.set(name, entry);
        if (this.watching) this.watchAll();
        const takeBack = leaving ? Promise.race([leaving.syncNow((ask) => syncAllTo(ask, { includeSecrets: false })).catch(() => undefined), new Promise((r) => setTimeout(r, 20_000))]).finally(() => leaving.stop()) : Promise.resolve();
        const out = takeBack
            .then(() => this.drop(name, false))
            .then(() => revokeOverSsh(entry, thisDesktop().id))
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

    /** The servers connected now, to ask about their sessions (src/server/far-peers.ts), by name. */
    connectedServers(): Map<string, MachineWatch> {
        return new Map([...this.watches].filter(([, w]) => w.overview().state === "connected"));
    }

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
        this.unwatchSynced();
    }

    /** Triggers a debounced resync to all connected watched servers (called after local key/settings/provider/account changes). */
    resyncAll() {
        if (!this.o.sync || this.stopped) return;
        this.syncChanged();
    }

    /**
     * What a server gets (ServerEntry.sync). On: everything but sign-ins, its keys included, and the CLIs this machine
     * uses installed there. Not asked yet: skills and commands, as every server always had. Off: nothing, but once
     * after it was on, one last sync without keys takes the ones sync put there away.
     */
    private syncFor(name: string, ask: (method: string, params: Record<string, unknown>) => Promise<unknown>): Promise<SyncRunResult | undefined> {
        const entry = getServer(name);
        const signIns = this.o.signIns === true;
        if (entry?.sync === true) return syncAllTo(ask, { includeSecrets: () => getServer(name)?.sync === true, installMissing: true, signIns });
        if (entry?.sync === false) {
            if (!entry.takeBack) return Promise.resolve(undefined);
            return syncAllTo(ask, { includeSecrets: false, signIns }).then((r) => {
                const now = getServer(name);
                if (now?.sync === false && now.takeBack && !r.state.result?.keysLeft?.length && !r.state.unsupported) saveServer({ ...now, takeBack: undefined });
                return r;
            });
        }
        return syncTo(ask, { basic: true }).then((files) => ({ files, state: {} }));
    }

    /** Turns `name`'s sync with this machine on or off (ServerEntry.sync), and syncs it now if it's connected. */
    setSync(name: string, on: boolean) {
        const entry = requireServer(name);
        // Off after on: its keys are taken away with one more sync, however long it takes to reach it.
        saveServer({ ...entry, sync: on, takeBack: on ? undefined : entry.sync === true || entry.takeBack || undefined });
        if (this.o.sync) this.watches.get(name)?.resync();
    }

    /** Per-server in-flight manual sync, so concurrent manual runs share/serialize cleanly. */
    private manualSyncs = new Map<string, Promise<ServerSyncItemResult>>();

    /** Syncs one server (or all servers) right now, connecting first if needed. */
    async syncNow(name?: string): Promise<ServerSyncItemResult[]> {
        const targets = name ? [requireServer(name)] : listServers();
        if (!targets.length) return [];
        return Promise.all(targets.map((entry) => this.syncOneServer(entry)));
    }

    private syncOneServer(entry: ServerEntry): Promise<ServerSyncItemResult> {
        const prev = this.manualSyncs.get(entry.name) ?? Promise.resolve(undefined);
        const next = prev.then(
            () => this.runSyncOneServer(entry),
            () => this.runSyncOneServer(entry),
        );
        this.manualSyncs.set(entry.name, next);
        void next.finally(() => {
            if (this.manualSyncs.get(entry.name) === next) this.manualSyncs.delete(entry.name);
        });
        return next;
    }

    private async runSyncOneServer(entry: ServerEntry): Promise<ServerSyncItemResult> {
        const existing = this.watches.get(entry.name);
        try {
            let run;
            if (existing) {
                // Always route through the server's watch when one exists so manual and automatic syncs never overlap.
                if (existing.overview().state !== "connected") {
                    const conn = await this.connect(entry.name);
                    if (conn.status !== "connected") {
                        const err =
                            conn.status === "failed" ? conn.problem.message
                            : conn.status === "stopped" ? `Cavvy on ${entry.name} is stopped.`
                            : conn.status === "other-version" ? `${entry.name} runs another version of Cavvy.`
                            : `${entry.name}'s host key isn't trusted yet.`;
                        return { name: entry.name, ok: false, error: err };
                    }
                    await existing.connectNow(15_000);
                }
                if (existing.overview().state !== "connected") {
                    return { name: entry.name, ok: false, error: `${entry.name} isn't connected.` };
                }
                run = await existing.syncNow();
            } else {
                const conn = await this.connect(entry.name);
                if (conn.status !== "connected") {
                    const err =
                        conn.status === "failed" ? conn.problem.message
                        : conn.status === "stopped" ? `Cavvy on ${entry.name} is stopped.`
                        : conn.status === "other-version" ? `${entry.name} runs another version of Cavvy.`
                        : `${entry.name}'s host key isn't trusted yet.`;
                    return { name: entry.name, ok: false, error: err };
                }
                run = await this.syncOverDirectWs(conn.url, conn.token, (ask) => this.syncFor(entry.name, ask));
            }
            const st = run?.state?.result;
            const summary = run ? describeSyncRun(run) : "";
            const missingClis = run?.state.missingClis ?? st?.missingClis;
            const needsSignIn = run?.state.needsSignIn ?? st?.needsSignIn;
            if (run?.state.unsupported) {
                return {
                    name: entry.name,
                    ok: false,
                    ...(summary ? { summary } : {}),
                    error: `${entry.name} runs an older Cavvy that doesn't support full sync. Update it first.`,
                };
            }
            if (st?.warnings?.length) {
                return {
                    name: entry.name,
                    ok: false,
                    summary: summary || "Partial sync",
                    error: st.warnings[0],
                    warnings: st.warnings,
                    ...(st.keysLeft?.length ? { keysLeft: st.keysLeft } : {}),
                    ...(missingClis?.length ? { missingClis } : {}),
                    ...(needsSignIn?.length ? { needsSignIn } : {}),
                };
            }
            return {
                name: entry.name,
                ok: true,
                summary: summary || "Up to date",
                ...(missingClis?.length ? { missingClis } : {}),
                ...(needsSignIn?.length ? { needsSignIn } : {}),
            };
        } catch (e) {
            return { name: entry.name, ok: false, error: printable((e as Error)?.message ?? String(e), 300) };
        }
    }

    /** Opens a short-lived WebSocket to run syncAllTo when no MachineWatch is already connected (e.g. CLI `cavvy servers sync`). */
    private async syncOverDirectWs(url: string, token: string, sync: (ask: (method: string, params: Record<string, unknown>) => Promise<unknown>) => Promise<SyncRunResult | undefined>) {
        const ws = new WebSocket(url, ["cavvy.v1", `auth.${token}`]);
        let nextId = 1;
        const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
        await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("Timed out connecting to server.")), 15_000);
            ws.onopen = () => {
                clearTimeout(t);
                resolve();
            };
            ws.onerror = () => {
                clearTimeout(t);
                reject(new Error("Couldn't open connection to server."));
            };
        });
        ws.onmessage = (ev) => {
            try {
                const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message?: string; code?: string } };
                if (typeof msg.id !== "number") return;
                const p = pending.get(msg.id);
                if (!p) return;
                pending.delete(msg.id);
                clearTimeout(p.timer);
                if (msg.error) p.reject(Object.assign(new Error(msg.error.message ?? "Sync failed."), msg.error.code ? { code: msg.error.code } : {}));
                else p.resolve(msg.result);
            } catch {
                // ignore malformed frames
            }
        };
        const ask = (method: string, params: Record<string, unknown>) =>
            new Promise<unknown>((resolve, reject) => {
                const id = nextId++;
                const ms = method === "sync.applyState" ? 90_000 : 20_000;
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`Timed out waiting for ${method}.`));
                }, ms);
                pending.set(id, { resolve, reject, timer });
                ws.send(JSON.stringify({ id, method, params }));
            });
        try {
            return await sync(ask);
        } finally {
            for (const p of pending.values()) clearTimeout(p.timer);
            pending.clear();
            ws.close();
        }
    }

    /** What watches each of this machine's synced folders (and symlink targets) and config files for changes, while servers are watched. */
    private syncWatchers = new Map<string, FSWatcher>();
    private syncTimer?: ReturnType<typeof setTimeout>;

    private syncChanged() {
        clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => {
            // Re-scan in case a new symlinked skill directory was added since startup.
            this.watchSynced();
            for (const w of this.watches.values()) w.resync();
        }, this.o.syncSettleMs ?? 1500);
        (this.syncTimer as { unref?: () => void }).unref?.();
    }

    private watchSynced() {
        if (!this.o.sync || this.stopped) return;
        const { recursive, shallow } = syncedWatchTargets();
        for (const dir of recursive) this.watchSyncedFolder(dir);
        for (const s of shallow) this.watchShallowDir(s.dir, s.names);
    }

    /** Watches a parent folder non-recursively for changes to specific config/memory filenames; if absent, watches its nearest existing ancestor until created. */
    private watchShallowDir(dir: string, names: Set<string>) {
        const key = `shallow:${dir}`;
        if (this.syncWatchers.has(key) || this.stopped) return;
        let at = dir;
        while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
        const there = at === dir;
        const next = there ? "" : relative(at, dir).split(sep)[0]!;
        try {
            const w = watch(at, { persistent: false }, (_e, name) => {
                if (!there) {
                    if (String(name) !== next || !existsSync(join(at, next))) return;
                    this.unwatchSyncedFolder(key, w);
                    this.watchShallowDir(dir, names);
                    this.syncChanged();
                    return;
                }
                if (!name) return this.syncChanged();
                const s = String(name);
                if (names.has(s) || [...names].some((f) => s.startsWith(`.${f}.`))) this.syncChanged();
            });
            w.on("error", () => this.unwatchSyncedFolder(key, w));
            this.syncWatchers.set(key, w);
            if (!there && existsSync(join(at, next))) {
                this.unwatchSyncedFolder(key, w);
                this.watchShallowDir(dir, names);
                this.syncChanged();
            }
        } catch {
            // Can't be watched here: brought level on connect and explicit changes.
        }
    }

    /** `dir` and what's in it; not there yet, the nearest folder above it that is, till the next one down is made. */
    private watchSyncedFolder(dir: string) {
        if (this.syncWatchers.has(dir) || this.stopped) return;
        let at = dir;
        while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
        const there = at === dir;
        // The name made in `at` that leads to `dir`.
        const next = there ? "" : relative(at, dir).split(sep)[0]!;
        try {
            const w = watch(at, { recursive: there, persistent: false }, (_e, name) => {
                if (there) return this.syncChanged();
                if (String(name) !== next || !existsSync(join(at, next))) return;
                this.unwatchSyncedFolder(dir, w);
                this.watchSyncedFolder(dir);
                this.syncChanged();
            });
            // Gone (the folder removed): watched again the next time servers are.
            w.on("error", () => this.unwatchSyncedFolder(dir, w));
            this.syncWatchers.set(dir, w);
            // Made while the watch was being set up: down a level now.
            if (!there && existsSync(join(at, next))) {
                this.unwatchSyncedFolder(dir, w);
                this.watchSyncedFolder(dir);
                this.syncChanged();
            }
        } catch {
            // Can't be watched here: it's brought level each time a server connects.
        }
    }

    private unwatchSyncedFolder(dir: string, w: FSWatcher) {
        w.close();
        if (this.syncWatchers.get(dir) === w) this.syncWatchers.delete(dir);
    }

    private unwatchSynced() {
        clearTimeout(this.syncTimer);
        for (const w of this.syncWatchers.values()) w.close();
        this.syncWatchers.clear();
    }

    /** The engine is stopping: every connection is closed and signed out. */
    async stopAll() {
        this.stopped = true;
        this.unwatchSynced();
        for (const w of this.watches.values()) w.stop();
        this.watches.clear();
        for (const t of this.told.values()) clearTimeout(t);
        this.told.clear();
        await Promise.all([...this.links.keys()].map((name) => this.drop(name, true)));
    }
}
