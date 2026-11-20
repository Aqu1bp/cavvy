// Other sessions as the app reaches them for an agent (src/agent/peers.ts):
// the ones it has open as they are now, the rest from disk. It can send to
// and start sessions: a message goes in as a wake from the sender, opening
// the session first when it isn't open (and letting it go again once it's
// done, as one no window shows is).

import { deliveryText, diskPeers, freerMode, modelChoices, modelEfforts, narrowerMode, PEER_LIMITS, PeerError, PeerUnsure, peerWake, readFromDisk, readText, type Delivery, type FarPeers, type FarStart, type PeerStatus, type PeerSummary, type SessionPeers, type StartChoice } from "../agent/peers";
import { findSessionAnywhere, sessionHolder } from "../agent/session";
import type { Effort } from "../config/settings";
import { ACCOUNT_PROVIDERS } from "../providers/accounts";
import { clientFor, resolveModelInfo, type ProviderListing } from "../providers/models";
import { getProvider } from "../providers/registry";
import { modelRef, parseModelRef } from "../providers/types";
import { MODE_INFO, type PermissionMode } from "../permissions/modes";
import { redact } from "../util/redact";
import type { Runtime } from "./runtime";
import type { Workspace } from "./engine";

/** What it needs of the engine. */
export interface PeerHost {
    live(): Iterable<Runtime>;
    get(id: string): Runtime | undefined;
    /** Open a session that isn't (throws when it can't be: its folder gone, untrusted). */
    open(id: string): Promise<Runtime>;
    create(cwd: string, o: { mode: PermissionMode; accounts: Record<string, string>; startedBy: string }): Promise<Runtime>;
    defaultMode(ws: Workspace): PermissionMode;
    /** The mode a session made in `cwd` starts in (throws when the folder can't be opened: not one, untrusted with configuration). */
    defaultModeIn(cwd: string): PermissionMode;
    /**
     * `cwd` as the folder it really is (links followed), when that's one the user has worked in here or one inside
     * it (a worktree of theirs); undefined when it isn't, or isn't a folder.
     */
    known(cwd: string): string | undefined;
    /** The models the providers set up here list. */
    listings(): ProviderListing[];
    /** Let it go once it has nothing to do, unless a window has it open. */
    release(id: string): void;
    /** Sessions started by another, and when each session started others: kept while the server runs. */
    starts: { startedBy: Map<string, string>; times: Map<string, number[]> };
}

/** Sessions one may start an hour: an agent that starts sessions needs the user before it starts many. */
export const MAX_STARTS_PER_HOUR = 5;
/**
 * Sessions another machine's sessions may start here an hour, all of them together: which session asks is that
 * machine's word, so the count that holds is by machine.
 */
export const MAX_STARTS_PER_MACHINE_HOUR = 10;

function statusOf(rt: Runtime): PeerStatus {
    if (rt.status === "waiting") return "waiting";
    return rt.busy || rt.status === "running" ? "working" : "idle";
}

function titleOf(rt: Runtime): string {
    return (rt.title ?? rt.firstPrompt() ?? "New session").replace(/\s+/g, " ").trim().slice(0, 120);
}

export function runtimeSummary(rt: Runtime): PeerSummary {
    return { id: rt.id, title: titleOf(rt), cwd: rt.ws.cwd, status: statusOf(rt), model: rt.session.model, updatedAt: Math.max(rt.lastActive, rt.session.workedAt ?? -Infinity) };
}

const modeName = (m: PermissionMode) => MODE_INFO[m].label;

/** The session to send to, open here. */
async function reach(host: PeerHost, id: string): Promise<Runtime> {
    const live = host.get(id);
    if (live) return live;
    const file = findSessionAnywhere(id);
    if (!file) throw new PeerError(`No session ${id}. ListSessions shows the ones there are (all: true for other projects').`);
    if (sessionHolder(file) !== undefined) throw new PeerError(`Session ${id} is open in another Cavvy process (a terminal, say), so it can't be sent to from here. Ask the user to tell it there.`);
    try {
        return await host.open(id);
    } catch (e) {
        throw new PeerError(`Session ${id} couldn't be opened: ${redact((e as Error).message)}`);
    }
}

/** `text` given to `rt` as a message from `from`: how it will be taken. */
function deliverTo(host: PeerHost, rt: Runtime, from: { id: string; title: string }, text: string, task = false): Delivery {
    const wakes = rt.toolState.wakes;
    if (!wakes) throw new PeerError(`Session ${rt.id} can't take messages.`);
    const waits = rt.wakeWaitsFor;
    // As it will be taken: into the running turn (or the one coming: a goal's next, the user's queued message), a turn of
    // its own when idle; held by Esc, the hourly limit, the user's answer or a missing account.
    const delivery: Delivery = wakes.isPaused ? "waiting" : wakes.full() ? "limited" : rt.status === "waiting" || waits === "user" ? "held" : rt.busy || waits === "turn" ? "joined" : "started";
    wakes.push(peerWake(from, text, task));
    host.release(rt.id);
    return delivery;
}

/** This machine's sessions, newest first: on disk, and those open here as they are now. */
function listHere(host: PeerHost, disk: ReturnType<typeof diskPeers>, o: { limit: number; match?: (s: PeerSummary) => boolean }) {
    const out = new Map<string, PeerSummary>();
    const listed = disk.list(o);
    for (const s of listed.rows) out.set(s.id, s);
    // Open here: as they are now (a session with nothing said yet isn't listed).
    for (const rt of host.live()) {
        if (!rt.session.messageCount && !rt.busy) continue;
        const s = runtimeSummary(rt);
        if (!o.match || o.match(s)) out.set(rt.id, s);
        // On disk it matched, as it is now it doesn't (renamed since): not listed.
        else out.delete(rt.id);
    }
    return { rows: [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt), capped: listed.capped };
}

/**
 * What a session on another of the user's machines asks of this one's (src/server/far-peers.ts): list, read and send
 * to its sessions, by their ids here. `server`: this Cavvy is a server, which a session's mode can't be freer than
 * a sender's on (servers run freely by design: what they do stays on them).
 */
export function peerOps(host: PeerHost, server: boolean) {
    const disk = diskPeers(() => "", () => "/");
    return {
        list: (o: { query?: string; limit: number }): PeerSummary[] => {
            const q = o.query?.trim().toLowerCase();
            const limit = Math.max(1, Math.min(Math.floor(o.limit), PEER_LIMITS.maxList));
            return listHere(host, disk, { limit, match: (s) => !q || s.title.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) }).rows.slice(0, limit);
        },
        read: (id: string, turns?: number): { text: string; title: string; turns: number } | undefined => {
            const rt = host.get(id);
            const found = rt ? { summary: runtimeSummary(rt), messages: rt.session.messages } : readFromDisk(id);
            if (!found) return undefined;
            const r = readText(found, { turns });
            return { text: r.text, title: found.summary.title, turns: r.turns };
        },
        send: async (id: string, text: string, from: { id: string; title: string; mode: PermissionMode }): Promise<{ text: string; delivery: Delivery; title: string }> => {
            const rt = await reach(host, id);
            if (!server && freerMode(rt.mode, from.mode)) throw new PeerError(
                    // From another machine (`<machine>/<id>`): it counts as Auto at most here, whatever it runs in there.
                    from.id.includes("/")
                        ? `Session ${id} runs in ${modeName(rt.mode)} mode, which asks the user less than a session on another machine counts for here (${modeName(from.mode)} mode at most), so it can't be sent work from there. Ask the user to send it themselves.`
                        : `Session ${id} runs in ${modeName(rt.mode)} mode, which asks the user less than the sending session's ${modeName(from.mode)} mode, so it can't be sent work from there. Ask the user to send it themselves.`,
                );
            const delivery = deliverTo(host, rt, { id: from.id, title: from.title }, text);
            return { text: deliveryText(runtimeSummary(rt), delivery), delivery, title: runtimeSummary(rt).title };
        },
        /**
         * A new session here in `cwd`, started by one on another machine (`from`, named `<machine>/<id>`), with `prompt`
         * as a message from it. On the user's own computer: only in a folder they've worked in there, and in a mode that
         * asks no less than Auto (answerPeers caps `from.mode`); everywhere: no freer than the starter's mode or the
         * folder's default, and no more an hour from one starter than a session may start here.
         */
        start: async (o: { cwd: string; prompt: string; title: string } & StartChoice, from: { id: string; title: string; mode: PermissionMode }): Promise<PeerSummary & { effort?: Effort }> => {
            // On the user's own computer: the folder it really is (a link inside an opened folder may lead out of it), and
            // that one is where the session is made and what its trust is read for.
            const cwd = server ? o.cwd : host.known(o.cwd);
            if (cwd === undefined) throw new PeerError(`${redact(o.cwd).slice(0, 300)} isn't a folder the user has opened in Cavvy on this machine, so a session can't be started there from another machine. Ask the user to open it there once.`);
            const now = Date.now();
            // By session; and on the user's own computer by the server it's on too: which session it is is that server's word.
            const machine = `${from.id.slice(0, from.id.indexOf("/"))}/`;
            const keys: [string, number, string][] = [[from.id, MAX_STARTS_PER_HOUR, `Session ${from.id} has started ${MAX_STARTS_PER_HOUR} sessions here in the last hour, as many as it may. Ask the user before starting more.`]];
            if (!server) keys.push([machine, MAX_STARTS_PER_MACHINE_HOUR, `Sessions on ${machine.slice(0, -1)} have started ${MAX_STARTS_PER_MACHINE_HOUR} sessions here in the last hour, as many as they may together. Ask the user before starting more.`]);
            for (const [key, most, why] of keys) if ((host.starts.times.get(key) ?? []).filter((t) => now - t < 3_600_000).length >= most) throw new PeerError(why);
            for (const [key] of keys) host.starts.times.set(key, [...(host.starts.times.get(key) ?? []).filter((t) => now - t < 3_600_000), now]);
            const uncount = () => {
                for (const [key] of keys) {
                    const list = host.starts.times.get(key) ?? [];
                    const i = list.indexOf(now);
                    if (i >= 0) list.splice(i, 1);
                }
            };
            // Once the session is made its folder's start-up has run: refused after that, it still counts.
            let made = false;
            try {
                // A model asked for has to be one this machine has, said before anything is made.
                const asked = o.model === undefined ? undefined : askedModel(host, o.model);
                // And an effort that model doesn't take, where it's known which it takes.
                if (asked?.efforts && o.effort !== undefined && !asked.efforts.includes(o.effort as Effort)) throw new PeerError(`${asked.ref} doesn't take "${redact(o.effort).slice(0, 40)}" effort. It takes: ${asked.efforts.join(", ") || "none"}.`);
                let rt: Runtime;
                try {
                    const mode = narrowerMode(from.mode, host.defaultModeIn(cwd));
                    made = true;
                    rt = await host.create(cwd, { mode, accounts: {}, startedBy: from.id });
                } catch (e) {
                    throw new PeerError(`The session couldn't be started: ${redact((e as Error).message)}`);
                }
                const gaveUp = (why: string): never => {
                    host.release(rt.id);
                    throw new PeerError(why);
                };
                if (asked) {
                    let set = false;
                    let why = "";
                    try {
                        await clientFor(asked.provider);
                        set = await rt.setModel(asked.ref, { quiet: true });
                    } catch (e) {
                        why = redact((e as Error).message);
                    }
                    if (!set) gaveUp(`The session couldn't be started on ${asked.ref}${why ? `: ${why}` : "."}`);
                }
                if (!rt.model) gaveUp("No model is set up on this machine for a new session: say which model, or ask the user to set one up there.");
                const efforts = modelEfforts(rt.model!);
                if (o.effort !== undefined) {
                    if (!efforts.includes(o.effort as Effort)) gaveUp(`${modelRef(rt.model!)} doesn't take "${redact(o.effort).slice(0, 40)}" effort. It takes: ${efforts.join(", ") || "none"}.`);
                    rt.setEffort(o.effort as Effort);
                }
                host.starts.startedBy.set(rt.id, from.id);
                rt.rename(o.title);
                deliverTo(host, rt, { id: from.id, title: from.title }, o.prompt, true);
                const runs = rt.settings().effort;
                return { ...runtimeSummary(rt), effort: runs && efforts.includes(runs) ? runs : undefined };
            } catch (e) {
                if (!made) uncount();
                throw e;
            }
        },
    };
}

/** A model another machine's session asked to start one on: one a provider set up here lists. Throws PeerError, with the models there are. */
function askedModel(host: PeerHost, ref: string): { ref: string; provider: string; efforts?: Effort[] } {
    const listings = host.listings();
    const shown = (t: string) => `"${redact(t).slice(0, 120)}"`;
    const refuse = (why: string, provider?: string, match?: string): never => {
        throw new PeerError(`${why}\n\n${modelChoices(listings, provider, match)}`);
    };
    const p = parseModelRef(ref);
    const def = p && getProvider(p.provider);
    if (!p || !def) return refuse(`${shown(ref)} isn't a model on this machine.`, getProvider(ref.split(":")[0]!.trim())?.id);
    if (!p.id) return refuse(`Say which of ${def.name}'s models.`, def.id);
    const listed = listings.find((l) => l.provider.id === def.id)?.models ?? [];
    // One its provider lists; where the provider lists none, what's known of the model by its name.
    const info = listed.find((m) => m.id === p.id) ?? (listed.length ? undefined : resolveModelInfo(ref));
    if (!info) return refuse(`${def.name} has no model ${shown(p.id)} on this machine.`, def.id, p.id);
    return { ref, provider: def.id, efforts: modelEfforts(info) };
}

/** `far`: the user's other machines' sessions, as they can be reached when asked (none: not from here). */
export function appPeers(host: PeerHost, self: Runtime, far?: () => FarPeers | undefined): SessionPeers {
    const disk = diskPeers(() => self.id, () => self.ws.cwd);
    const mode = modeName;
    const deliver = (rt: Runtime, text: string, task = false): Delivery => deliverTo(host, rt, { id: self.id, title: titleOf(self) }, text, task);

    /**
     * The model and effort to start a session on: as asked (a model a provider set up here has, an effort it takes), else
     * this session's (its effort where the model takes it). Throws PeerError, with the models there are.
     */
    const choose = async ({ model, effort }: StartChoice): Promise<{ ref: string; efforts: Effort[]; effort?: Effort; asked: boolean }> => {
        const listings = host.listings();
        const shown = (t: string) => `"${redact(t).slice(0, 120)}"`;
        const refuse = (why: string, provider?: string, match?: string): never => {
            throw new PeerError(`${why}\n\n${modelChoices(listings, provider, match)}`);
        };
        const ref = model ?? (self.model ? modelRef(self.model) : self.session.model);
        if (!ref) return refuse("This session has no model to start one on: say which.");
        const p = parseModelRef(ref);
        const def = p && getProvider(p.provider);
        if (!p || !def) return refuse(`${shown(ref)} isn't a model here.`, getProvider(ref.split(":")[0]!.trim())?.id);
        try {
            await clientFor(def.id);
        } catch {
            return refuse(`${def.name} isn't set up here, so ${shown(ref)} can't run.`);
        }
        if (!p.id) return refuse(`Say which of ${def.name}'s models.`, def.id);
        const listed = listings.find((l) => l.provider.id === def.id)?.models ?? [];
        // This session's own model is what it runs on, listed or not; one asked for has to be listed (where its provider lists any).
        const info = !model && self.model ? self.model : (listed.find((m) => m.id === p.id) ?? (listed.length ? undefined : resolveModelInfo(ref)));
        if (!info) return refuse(`${def.name} has no model ${shown(p.id)}.`, def.id, p.id);
        const efforts = modelEfforts(info);
        if (effort === undefined) {
            const mine = self.settings().effort;
            return { ref, efforts, effort: mine && efforts.includes(mine) ? mine : undefined, asked: false };
        }
        if (!efforts.includes(effort as Effort)) throw new PeerError(`${ref} doesn't take ${shown(effort)} effort. It takes: ${efforts.join(", ") || "none"}.`);
        return { ref, efforts, effort: effort as Effort, asked: true };
    };

    /**
     * This session may start one more: no chains (a session another started can't start more: its own record says so,
     * through compaction and restarts), and no more than so many an hour from one, counted before anything is awaited.
     * Returns what takes the count back: a start that didn't happen doesn't count (this one's, not another's from the same moment).
     */
    const reserve = (): (() => void) => {
        if (self.session.meta.startedBy || host.starts.startedBy.has(self.id)) throw new PeerError("This session was started by another session, so it can't start sessions itself. Ask the user to start it, or send the request to the session that started this one.");
        const now = Date.now();
        const times = (host.starts.times.get(self.id) ?? []).filter((t) => now - t < 3_600_000);
        if (times.length >= MAX_STARTS_PER_HOUR) throw new PeerError(`This session has started ${MAX_STARTS_PER_HOUR} sessions in the last hour, as many as it may. Ask the user before starting more.`);
        host.starts.times.set(self.id, [...times, now]);
        return () => {
            const list = host.starts.times.get(self.id) ?? [];
            const i = list.indexOf(now);
            if (i >= 0) list.splice(i, 1);
        };
    };

    return {
        self: self.id,
        get cwd() {
            return self.ws.cwd;
        },
        list: (o) => listHere(host, disk, o),
        read: (id) => {
            const rt = host.get(id);
            return rt ? { summary: runtimeSummary(rt), messages: rt.session.messages } : readFromDisk(id);
        },
        // The user's other machines' sessions, sent to as this one: looked for each time (a server added since counts).
        get far() {
            const f = far?.();
            return (
                f && {
                    list: f.list,
                    read: f.read,
                    send: (id: string, text: string) => f.send(id, text, { id: self.id, title: titleOf(self), mode: self.mode }),
                    // Counted with the sessions it starts here: one bound on what a session starts, wherever.
                    start: async (o: FarStart) => {
                        const uncount = reserve();
                        try {
                            return await f.start(o, { id: self.id, title: titleOf(self), mode: self.mode });
                        } catch (e) {
                            // Not answered: it may have started, and counts. Refused: it didn't.
                            if (!(e instanceof PeerUnsure)) uncount();
                            throw e;
                        }
                    },
                }
            );
        },
        send: async (id, text) => {
            const rt = await reach(host, id);
            // Work handed to a session that asks the user less would be done with less asking than here.
            if (freerMode(rt.mode, self.mode)) throw new PeerError(`Session ${id} runs in ${mode(rt.mode)} mode, which asks the user less than this session's ${mode(self.mode)} mode, so it can't be sent work from here. Ask the user to send it themselves.`);
            return { summary: runtimeSummary(rt), delivery: deliver(rt, text) };
        },
        checkStart: async (o) => {
            try {
                await choose(o);
            } catch (e) {
                if (e instanceof PeerError) return e.message;
                throw e;
            }
        },
        start: async ({ prompt, title, model, effort }) => {
            const uncount = reserve();
            // Checked again: the user may have changed providers since the call was.
            let chosen: Awaited<ReturnType<typeof choose>>;
            try {
                chosen = await choose({ model, effort });
            } catch (e) {
                uncount();
                throw e;
            }
            let rt: Runtime;
            try {
                // On the starter's Claude Code and Codex accounts, as a plan taken to a worktree is.
                const accounts = Object.fromEntries(ACCOUNT_PROVIDERS.map((p) => [p, self.session.accountId(p)]));
                rt = await host.create(self.ws.cwd, { mode: narrowerMode(self.mode, host.defaultMode(self.ws)), accounts, startedBy: self.id });
            } catch (e) {
                uncount();
                throw new PeerError(`The session couldn't be started: ${redact((e as Error).message)}`);
            }
            // Never on a model nobody asked for: one it can't take stops the start.
            let set = false;
            let why = "";
            try {
                set = await rt.setModel(chosen.ref, { quiet: true });
            } catch (e) {
                why = redact((e as Error).message);
            }
            if (!set) {
                uncount();
                host.release(rt.id);
                throw new PeerError(`The session couldn't be started on ${chosen.ref}${why ? `: ${why}` : "."}`);
            }
            // One asked for is the session's own, whatever the folder's default becomes; the starter's only where it differs.
            if (chosen.effort && (chosen.asked || chosen.effort !== rt.settings().effort)) rt.setEffort(chosen.effort);
            host.starts.startedBy.set(rt.id, self.id);
            rt.rename(title);
            deliver(rt, prompt, true);
            // The effort it runs at, said only where the model takes it (a provider puts another at the nearest it takes).
            const runs = rt.settings().effort;
            return { ...runtimeSummary(rt), effort: runs && chosen.efforts.includes(runs) ? runs : undefined };
        },
    };
}
