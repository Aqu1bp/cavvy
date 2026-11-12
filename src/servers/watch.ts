// One server's sessions, as this computer's Cavvy sees them: a connection of its own to the Cavvy there (through the
// tunnel the windows use, with the same sign-in), which lists the sessions, hears each change and each thing a
// session there has to tell its user. It's what lets a window show the other machines' sessions beside its own,
// and a notification come from a machine no window is on (manager.ts keeps one of these per server).
//
// It never starts or sets up anything there: a server that's stopped, or that needs the user's word, is left as it
// is and said to be so.

import type { ConnectResult, MachineOverview, ServerEvent, SessionSummary } from "../server/protocol";

/** A call of a tool this machine lends, as the server sent it. */
export interface LentCall {
    tool: string;
    input: Record<string, unknown>;
    /** The session on the server that asked. */
    session: { id: string; title: string };
}

/** What this machine answers one with. */
export interface LentResult {
    text: string;
    isError?: boolean;
    images?: { type: "image"; mediaType: string; data: string }[];
}

/** What a session on another machine has to tell its user. */
export type MachineNotice = Pick<Extract<ServerEvent, { type: "servers.notify" }>, "sessionId" | "kind" | "title" | "body">;

/** How long until the next try at a server that couldn't be reached, by tries in a row. */
const RETRY_MS = [5000, 15_000, 30_000, 60_000];
/** A server that's stopped, or waits for the user's word, is asked about again this often, in case that changed elsewhere. */
const IDLE_RETRY_MS = 300_000;
/** Sessions kept per server: those in play, the most recent first. */
const KEPT = 20;
/** What a reply is waited for. */
const REPLY_MS = 20_000;

export class MachineWatch {
    private ws?: WebSocket;
    private sessions = new Map<string, SessionSummary>();
    private state: MachineOverview["state"] = "connecting";
    private stopped = false;
    private tries = 0;
    private timer?: ReturnType<typeof setTimeout>;
    /** A try is under way: another isn't begun beside it. */
    private trying = false;

    constructor(
        readonly name: string,
        private o: {
            /** Where the server's Cavvy is and the sign-in for it, without starting anything there. `renew`: the last sign-in opened nothing. */
            reach: (renew: boolean) => Promise<ConnectResult | { status: "disconnected" }>;
            changed: () => void;
            notice: (n: MachineNotice) => void;
            /** What this machine lends the server's sessions (src/tools/lent.ts), said once the connection is up. */
            lends?: () => string[];
            /** Runs a call of one of those, through this machine's own checks. */
            lend?: (call: LentCall, signal: AbortSignal) => Promise<LentResult>;
            retryMs?: number[];
            idleRetryMs?: number;
        },
    ) {}

    start() {
        void this.attempt(false);
    }

    /** Something changed for this server (a window connected to it, it came back): tried now, not when the wait is over. */
    poke() {
        if (this.stopped || this.state === "connected") return;
        this.tries = 0;
        void this.attempt(false);
    }

    overview(): MachineOverview {
        const rank = (s: SessionSummary) => (s.status === "waiting" ? 0 : s.status === "running" ? 1 : 2);
        const sessions = [...this.sessions.values()]
            .filter((s) => !s.archived && !s.settled)
            .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
            .slice(0, KEPT);
        return { name: this.name, state: this.state, sessions };
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.timer);
        this.ws?.close();
    }

    private set(state: MachineOverview["state"]) {
        if (this.state === state) return;
        this.state = state;
        this.o.changed();
    }

    private later(ms?: number) {
        if (this.stopped) return;
        const waits = this.o.retryMs ?? RETRY_MS;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.attempt(false), ms ?? waits[Math.min(this.tries, waits.length - 1)]);
        (this.timer as { unref?: () => void }).unref?.();
        if (ms === undefined) this.tries++;
    }

    private async attempt(renew: boolean): Promise<void> {
        if (this.stopped || this.trying) return;
        this.trying = true;
        clearTimeout(this.timer);
        try {
            const at = await this.o.reach(renew).catch((): ConnectResult => ({ status: "failed", problem: { message: "" } }));
            if (at.status === "disconnected") return this.set("disconnected");
            if (this.stopped) return;
            if (at.status !== "connected") {
                // Stopped on purpose, or waiting for the user's word (its key, its version): theirs to change, from a
                // window. Until then it's asked about again only now and then, in case it changed some other way.
                this.set(at.status === "stopped" ? "stopped" : at.status === "failed" ? "unreachable" : "needs-you");
                this.later(at.status === "failed" ? undefined : (this.o.idleRetryMs ?? IDLE_RETRY_MS));
                return;
            }
            this.listen(at.url, at.token, renew);
        } finally {
            this.trying = false;
        }
    }

    private listen(url: string, token: string, renewed: boolean) {
        const ws = new WebSocket(url, ["cavvy.v1", `auth.${token}`]);
        this.ws = ws;
        let listed = false;
        const waiting = new Map<number, (result: unknown) => void>();
        /** Calls of tools this machine lends that are running here, by the server's id for each. */
        const lending = new Map<string, AbortController>();
        let next = 3;
        const timeout = setTimeout(() => ws.close(), REPLY_MS);
        ws.onopen = () => {
            waiting.set(1, (result) => {
                clearTimeout(timeout);
                listed = true;
                this.tries = 0;
                this.sessions.clear();
                for (const s of Array.isArray(result) ? (result as SessionSummary[]) : []) if (s && typeof s.id === "string") this.sessions.set(s.id, s);
                this.state = "connected";
                this.o.changed();
                const kinds = this.o.lends?.() ?? [];
                if (kinds.length && this.o.lend) ws.send(JSON.stringify({ id: 2, method: "offers.set", params: { kinds } }));
            });
            ws.send(JSON.stringify({ id: 1, method: "sessions.list", params: { limit: 100 } }));
        };
        ws.onmessage = (m) => {
            let msg: { id?: number; result?: unknown; event?: ServerEvent };
            try {
                msg = JSON.parse(String(m.data));
            } catch {
                return;
            }
            if (typeof msg.id === "number") {
                waiting.get(msg.id)?.(msg.result);
                waiting.delete(msg.id);
                return;
            }
            const ev = msg.event;
            if (!ev || !listed) return;
            if (ev.type === "sessions.upsert" && ev.session && typeof ev.session.id === "string") {
                this.sessions.delete(ev.session.id);
                this.sessions.set(ev.session.id, ev.session);
                // Bounded, whatever the server sends: the oldest heard of go first.
                for (const id of this.sessions.keys()) {
                    if (this.sessions.size <= 500) break;
                    this.sessions.delete(id);
                }
                this.o.changed();
            } else if (ev.type === "sessions.remove") {
                if (this.sessions.delete(ev.id)) this.o.changed();
            } else if (ev.type === "notify" && ev.kind !== "background") {
                this.o.notice({ sessionId: ev.sessionId, kind: ev.kind, title: ev.title, body: ev.body });
            } else if (ev.type === "offers.call" && this.o.lend && typeof ev.callId === "string" && !lending.has(ev.callId)) {
                const stop = new AbortController();
                lending.set(ev.callId, stop);
                const call: LentCall = { tool: String(ev.tool), input: ev.input && typeof ev.input === "object" ? ev.input : {}, session: { id: String(ev.session?.id ?? ""), title: String(ev.session?.title ?? "") } };
                void this.o
                    .lend(call, stop.signal)
                    .catch((e): LentResult => ({ text: `It couldn't be run: ${(e as Error).message}`, isError: true }))
                    .then((r) => {
                        lending.delete(ev.callId);
                        // Given up there meanwhile, or the connection is another one now: nobody waits for it.
                        if (stop.signal.aborted || ws.readyState !== WebSocket.OPEN) return;
                        ws.send(JSON.stringify({ id: next++, method: "offers.result", params: { callId: ev.callId, ...r } }));
                    });
            } else if (ev.type === "offers.cancel") {
                lending.get(ev.callId)?.abort();
            }
        };
        ws.onclose = () => {
            clearTimeout(timeout);
            // Whoever asked can't be answered any more.
            for (const stop of lending.values()) stop.abort();
            lending.clear();
            if (this.ws !== ws) return;
            this.ws = undefined;
            if (this.stopped) return;
            this.set("connecting");
            // Closed before it answered once: the sign-in may be one the server has forgotten. A new one, once.
            if (!listed && !renewed) void this.attempt(true);
            else this.later();
        };
    }
}
