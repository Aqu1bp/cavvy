// Other sessions as the app reaches them for an agent (src/agent/peers.ts):
// the ones it has open as they are now, the rest from disk. It can send to
// and start sessions: a message goes in as a wake from the sender, opening
// the session first when it isn't open (and letting it go again once it's
// done, as one no window shows is).

import { diskPeers, freerMode, narrowerMode, PeerError, peerWake, readFromDisk, type Delivery, type PeerStatus, type PeerSummary, type SessionPeers } from "../agent/peers";
import { findSessionAnywhere, sessionHolder } from "../agent/session";
import { ACCOUNT_PROVIDERS } from "../providers/accounts";
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
    create(cwd: string, o: { mode: PermissionMode; accounts: Record<string, string> }): Promise<Runtime>;
    defaultMode(ws: Workspace): PermissionMode;
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
        start: async ({ prompt, title, model }) => {
            // No chains: a session another started can't start more (its first message, from its starter, says so after a
            // restart too). And no more than so many an hour from one, counted before anything is awaited.
            const first = self.session.messages[0];
            if (host.starts.startedBy.has(self.id) || (first?.role === "user" && first.meta?.kind === "wake" && first.meta.from)) throw new PeerError("This session was started by another session, so it can't start sessions itself. Ask the user to start it, or send the request to the session that started this one.");
            const now = Date.now();
            const times = (host.starts.times.get(self.id) ?? []).filter((t) => now - t < 3_600_000);
            if (times.length >= MAX_STARTS_PER_HOUR) throw new PeerError(`This session has started ${MAX_STARTS_PER_HOUR} sessions in the last hour, as many as it may. Ask the user before starting more.`);
            host.starts.times.set(self.id, [...times, now]);
            /** A start that didn't happen doesn't count. */
            const uncount = () => host.starts.times.set(self.id, (host.starts.times.get(self.id) ?? []).filter((t) => t !== now));
            let rt: Runtime;
            try {
                // On the starter's Claude Code and Codex accounts, as a plan taken to a worktree is.
                const accounts = Object.fromEntries(ACCOUNT_PROVIDERS.map((p) => [p, self.session.accountId(p)]));
                rt = await host.create(self.ws.cwd, { mode: narrowerMode(self.mode, host.defaultMode(self.ws)), accounts });
            } catch (e) {
                uncount();
                throw new PeerError(`The session couldn't be started: ${redact((e as Error).message)}`);
            }
            const ref = model ?? self.session.model;
            try {
                if (ref) await rt.setModel(ref);
            } catch (e) {
                uncount();
                host.release(rt.id);
                throw new PeerError(`The session couldn't be started on ${ref}: ${redact((e as Error).message)}`);
            }
            host.starts.startedBy.set(rt.id, self.id);
            rt.rename(title);
            deliver(rt, prompt);
            return runtimeSummary(rt);
        },
    };
}
