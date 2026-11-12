// Other sessions as the app reaches them for an agent (src/agent/peers.ts):
// the ones it has open as they are now, the rest from disk. It can send to
// and start sessions: a message goes in as a wake from the sender, opening
// the session first when it isn't open (and letting it go again once it's
// done, as one no window shows is).

import { diskPeers, freerMode, modelChoices, modelEfforts, narrowerMode, PeerError, peerWake, readFromDisk, type Delivery, type PeerStatus, type PeerSummary, type SessionPeers, type StartChoice } from "../agent/peers";
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
    /** The models the providers set up here list. */
    listings(): ProviderListing[];
    /** Let it go once it has nothing to do, unless a window has it open. */
    release(id: string): void;
    /** Sessions started by another, and when each session started others: kept while the server runs. */
    starts: { startedBy: Map<string, string>; times: Map<string, number[]> };
}

/** Sessions one may start an hour: an agent that starts sessions needs the user before it starts many. */
export const MAX_STARTS_PER_HOUR = 5;

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

export function appPeers(host: PeerHost, self: Runtime): SessionPeers {
    const disk = diskPeers(() => self.id, () => self.ws.cwd);
    const mode = (m: PermissionMode) => MODE_INFO[m].label;

    /** The session to send to, open here. */
    const reach = async (id: string): Promise<Runtime> => {
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
    };

    const deliver = (rt: Runtime, text: string): Delivery => {
        const wakes = rt.toolState.wakes;
        if (!wakes) throw new PeerError(`Session ${rt.id} can't take messages.`);
        const waits = rt.wakeWaitsFor;
        // As it will be taken: into the running turn (or the one coming: a goal's next, the user's queued message), a turn of
        // its own when idle; held by Esc, the hourly limit, the user's answer or a missing account.
        const delivery: Delivery = wakes.isPaused ? "waiting" : wakes.full() ? "limited" : rt.status === "waiting" || waits === "user" ? "held" : rt.busy || waits === "turn" ? "joined" : "started";
        wakes.push(peerWake({ id: self.id, title: titleOf(self) }, text));
        host.release(rt.id);
        return delivery;
    };

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

    return {
        self: self.id,
        get cwd() {
            return self.ws.cwd;
        },
        list: ({ limit, match }) => {
            const out = new Map<string, PeerSummary>();
            const listed = disk.list({ limit, match });
            for (const s of listed.rows) out.set(s.id, s);
            // Open here: as they are now (a session with nothing said yet isn't listed).
            for (const rt of host.live()) {
                if (!rt.session.messages.length && !rt.busy) continue;
                const s = runtimeSummary(rt);
                if (!match || match(s)) out.set(rt.id, s);
                // On disk it matched, as it is now it doesn't (renamed since): not listed.
                else out.delete(rt.id);
            }
            return { rows: [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt), capped: listed.capped };
        },
        read: (id) => {
            const rt = host.get(id);
            return rt ? { summary: runtimeSummary(rt), messages: rt.session.messages } : readFromDisk(id);
        },
        send: async (id, text) => {
            const rt = await reach(id);
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
            // No chains: a session another started can't start more (its own record says so, through compaction and restarts).
            // And no more than so many an hour from one, counted before anything is awaited.
            if (self.session.meta.startedBy || host.starts.startedBy.has(self.id)) throw new PeerError("This session was started by another session, so it can't start sessions itself. Ask the user to start it, or send the request to the session that started this one.");
            const now = Date.now();
            const times = (host.starts.times.get(self.id) ?? []).filter((t) => now - t < 3_600_000);
            if (times.length >= MAX_STARTS_PER_HOUR) throw new PeerError(`This session has started ${MAX_STARTS_PER_HOUR} sessions in the last hour, as many as it may. Ask the user before starting more.`);
            host.starts.times.set(self.id, [...times, now]);
            /** A start that didn't happen doesn't count: this one's reservation goes, not another's from the same moment. */
            const uncount = () => {
                const list = host.starts.times.get(self.id) ?? [];
                const i = list.indexOf(now);
                if (i >= 0) list.splice(i, 1);
            };
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
            deliver(rt, prompt);
            // The effort it runs at, said only where the model takes it (a provider puts another at the nearest it takes).
            const runs = rt.settings().effort;
            return { ...runtimeSummary(rt), effort: runs && chosen.efforts.includes(runs) ? runs : undefined };
        },
    };
}
