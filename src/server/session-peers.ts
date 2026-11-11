// Other sessions as the app reaches them for an agent (src/agent/peers.ts):
// the ones it has open as they are now, the rest from disk. It can send to
// and start sessions: a message goes in as a wake from the sender, opening
// the session first when it isn't open (and letting it go again once it's
// done, as one no window shows is).

import { diskPeers, freerMode, narrowerMode, PeerError, peerWake, readFromDisk, type Delivery, type PeerStatus, type PeerSummary, type SessionPeers } from "../agent/peers";
import { findSessionAnywhere, sessionHolder } from "../agent/session";
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
    create(cwd: string, o: { mode: PermissionMode }): Promise<Runtime>;
    defaultMode(ws: Workspace): PermissionMode;
    /** Let it go once it has nothing to do, unless a window has it open. */
    release(id: string): void;
}

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
        const delivery: Delivery = wakes.isPaused ? "waiting" : rt.status === "waiting" ? "held" : rt.busy ? "joined" : wakes.full() ? "limited" : "started";
        wakes.push(peerWake({ id: self.id, title: titleOf(self) }, text));
        host.release(rt.id);
        return delivery;
    };

    return {
        self: self.id,
        get cwd() {
            return self.ws.cwd;
        },
        list: ({ limit }) => {
            const out = new Map<string, PeerSummary>();
            for (const s of disk.list({ limit })) out.set(s.id, s);
            // Open here: as they are now (a session with nothing said yet isn't listed).
            for (const rt of host.live()) if (rt.session.messages.length || rt.busy) out.set(rt.id, runtimeSummary(rt));
            return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt);
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
            let rt: Runtime;
            try {
                rt = await host.create(self.ws.cwd, { mode: narrowerMode(self.mode, host.defaultMode(self.ws)) });
            } catch (e) {
                throw new PeerError(`The session couldn't be started: ${redact((e as Error).message)}`);
            }
            const ref = model ?? self.session.model;
            try {
                if (ref) await rt.setModel(ref);
            } catch (e) {
                host.release(rt.id);
                throw new PeerError(`The session couldn't be started on ${ref}: ${redact((e as Error).message)}`);
            }
            rt.rename(title);
            deliver(rt, prompt);
            return runtimeSummary(rt);
        },
    };
}
