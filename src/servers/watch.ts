// One server's sessions, as this computer's Cavvy sees them: a connection of its own to the Cavvy there (through the
// tunnel the windows use, with the same sign-in), which lists the sessions, hears each change and each thing a
// session there has to tell its user. It's what lets a window show the other machines' sessions beside its own,
// and a notification come from a machine no window is on (manager.ts keeps one of these per server).
//
// It never starts or sets up anything there: a server that's stopped, or that needs the user's word, is left as it
// is and said to be so.

import type { ConnectResult, MachineOverview, ServerEvent, SessionSummary } from "../server/protocol";
import { openBoundedSocket, type BoundedSocket } from "./bounded-socket";

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
/** A server's own words are its to choose: only so much of each is kept, and only so many sessions heard of. */
const HEARD = 300;
const MAX_MESSAGE = 4 * 1024 * 1024;
/** And all it sends within a minute: a list and its changes are kilobytes. Past this it isn't listened to for a while. */
const MAX_PER_MINUTE = 32 * 1024 * 1024;
/**
 * What a server's sessions have to say is passed on at most this often, turns ending and sessions asking counted
 * apart: a server gone wrong can't bury the user in it, and a busy one can't have its asking go unsaid.
 */
const DONE_PER_MINUTE = 6;
const ASKS_PER_MINUTE = 12;
const KINDS = ["done", "permission", "question", "plan", "error"] as const;

const cut = (v: unknown, max: number): string => (typeof v === "string" ? (v.length > max ? `${v.slice(0, max - 1)}…` : v) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * A session as a server described it, taken apart and put together again: only what the list shows, in the shapes
 * and sizes it expects. Undefined for what isn't one. What a server sends is never passed on as it came.
 */
export function heardSession(v: unknown): SessionSummary | undefined {
    const s = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    if (typeof s.id !== "string" || !/^[\w.-]{1,120}$/.test(s.id)) return undefined;
    const status = s.status === "running" || s.status === "waiting" || s.status === "error" ? s.status : "idle";
    return {
        id: s.id,
        cwd: cut(s.cwd, 400),
        projectName: cut(s.projectName, 100),
        title: cut(s.title, 200),
        createdAt: num(s.createdAt),
        updatedAt: num(s.updatedAt),
        messages: num(s.messages),
        status,
        pinned: false,
        archived: s.archived === true,
        settled: s.settled === true,
        live: s.live === true,
    };
}

export class MachineWatch {
    private ws?: BoundedSocket;
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
            /** It only ever waits for a connection that's coming back by itself: it doesn't hurry it. */
            reach: (renew: boolean) => Promise<ConnectResult | { status: "disconnected" }>;
            changed: () => void;
            notice: (n: MachineNotice) => void;
            retryMs?: number[];
            idleRetryMs?: number;
        },
    ) {}

    start() {
        void this.attempt(false);
    }

    /** Something changed for this server (a window connected to it, it came back): tried now, not when the wait is over. */
    poke() {
        // Connected, or a connection is being opened: that one stands.
        if (this.stopped || this.ws) return;
        this.tries = 0;
        void this.attempt(false);
    }

    overview(): MachineOverview {
        const rank = (s: SessionSummary) => (s.status === "waiting" ? 0 : s.status === "running" ? 1 : 2);
        // Only while it's heard from (or was a moment ago): what a server that's stopped or out of reach last said of
        // its sessions, a ring on the ones working, would be shown for news that isn't coming.
        const heard = this.state === "connected" || this.state === "connecting" ? [...this.sessions.values()] : [];
        const inPlay = heard.filter((s) => !s.archived && !s.settled).sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
        return { name: this.name, state: this.state, sessions: inPlay.slice(0, KEPT), more: Math.max(0, inPlay.length - KEPT) };
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
            if (this.stopped) return;
            // Until the user opens it again, which pokes this.
            if (at.status === "disconnected") return this.set("disconnected");
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

    /** When the last few notices of each sort were passed on (DONE_PER_MINUTE, ASKS_PER_MINUTE). */
    private said = { done: [] as number[], asks: [] as number[] };
    /** Asks were dropped since one was last passed on: said once, in one notice for them all. */
    private unsaid = false;

    /** Whether one more notice of this sort may be passed on now; counted when it may. */
    private maySay(sort: "done" | "asks"): boolean {
        const now = Date.now();
        const times = (this.said[sort] = this.said[sort].filter((t) => now - t < 60_000));
        if (times.length >= (sort === "done" ? DONE_PER_MINUTE : ASKS_PER_MINUTE)) return false;
        times.push(now);
        return true;
    }

    private listen(url: string, token: string, renewed: boolean) {
        // One connection at a time: an earlier one that's still there is let go, and isn't listened to any more.
        const before = this.ws;
        this.ws = undefined;
        before?.close();
        let listed = false;
        const timeout = setTimeout(() => ws.close(), REPLY_MS);
        const heard = (text: string) => {
            if (this.ws !== ws) return;
            let msg: { id?: unknown; result?: unknown; event?: ServerEvent } | null;
            try {
                msg = JSON.parse(text);
            } catch {
                return;
            }
            // Whatever it is, it's a server's to choose: anything that isn't what's expected is passed over.
            if (!msg || typeof msg !== "object") return;
            if (msg.id === 1) {
                if (listed) return;
                clearTimeout(timeout);
                listed = true;
                this.tries = 0;
                this.sessions.clear();
                for (const v of Array.isArray(msg.result) ? msg.result.slice(0, HEARD) : []) {
                    const s = heardSession(v);
                    if (s) this.sessions.set(s.id, s);
                }
                this.state = "connected";
                this.o.changed();
                return;
            }
            const ev = msg.event;
            if (!ev || typeof ev !== "object" || !listed) return;
            if (ev.type === "sessions.upsert") {
                const s = heardSession(ev.session);
                if (!s) return;
                this.sessions.delete(s.id);
                this.sessions.set(s.id, s);
                // Bounded, whatever the server sends: the oldest heard of go first.
                for (const id of this.sessions.keys()) {
                    if (this.sessions.size <= HEARD) break;
                    this.sessions.delete(id);
                }
                this.o.changed();
            } else if (ev.type === "sessions.remove") {
                if (typeof ev.id === "string" && this.sessions.delete(ev.id)) this.o.changed();
            } else if (ev.type === "notify") {
                const kind = KINDS.find((k) => k === ev.kind);
                if (!kind || typeof ev.sessionId !== "string" || !/^[\w.-]{1,120}$/.test(ev.sessionId)) return;
                // Turns ending and sessions asking are counted apart: a run of the first can't use up the second,
                // which the user is waited on for.
                const asks = kind === "permission" || kind === "question" || kind === "plan";
                if (this.maySay(asks ? "asks" : "done")) {
                    this.o.notice({ sessionId: ev.sessionId, kind, title: cut(ev.title, 120), body: cut(ev.body, 200) });
                    if (asks) this.unsaid = false;
                } else if (asks && !this.unsaid) {
                    // Past what's passed on one by one: said once that there are more, so none waits unseen.
                    this.unsaid = true;
                    this.o.notice({ sessionId: "", kind: "question", title: "More sessions need you", body: "" });
                }
            }
        };
        const ws = openBoundedSocket({
            port: Number(new URL(url).port),
            path: "/ws",
            protocols: ["cavvy.v1", `auth.${token}`],
            maxMessage: MAX_MESSAGE,
            maxPerMinute: MAX_PER_MINUTE,
            onOpen: () => ws.send(JSON.stringify({ id: 1, method: "sessions.list", params: { limit: 100 } })),
            onMessage: (text) => {
                try {
                    heard(text);
                } catch {
                    // Nothing a server sends may bring this machine's Cavvy down.
                }
            },
            onClose: (why) => {
                clearTimeout(timeout);
                if (this.ws !== ws) return;
                this.ws = undefined;
                if (this.stopped) return;
                // More than a list of sessions ever is: not read, and this server isn't listened to for a while.
                this.set(why === "too-much" ? "unreachable" : "connecting");
                // Closed before it answered once: the sign-in may be one the server has forgotten. A new one, once.
                if (why === "too-much") this.later(this.o.idleRetryMs ?? IDLE_RETRY_MS);
                else if (!listed && !renewed) void this.attempt(true);
                else this.later();
            },
        });
        this.ws = ws;
    }
}
