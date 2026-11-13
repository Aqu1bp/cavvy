// One server's sessions, as this computer's Cavvy sees them: a connection of its own to the Cavvy there (through the
// tunnel the windows use, with the same sign-in), which lists the sessions, hears each change and each thing a
// session there has to tell its user. It's what lets a window show the other machines' sessions beside its own,
// and a notification come from a machine no window is on (manager.ts keeps one of these per server).
//
// It never starts or sets up anything there: a server that's stopped, or that needs the user's word, is left as it
// is and said to be so.

import type { ConnectResult, MachineOverview, RELAYED_SESSION_METHODS, ServerEvent, SessionSummary } from "../server/protocol";
import { openBoundedSocket, type BoundedSocket } from "./bounded-socket";

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
/** What a reply is waited for. */
const REPLY_MS = 20_000;
/**
 * A server's own words are its to choose: only so much of each is kept, and only so many sessions heard of (this
 * many in play, as many archived: what a window lists of its own machine).
 */
const HEARD = 300;
/** How long the archived list is waited for before the sessions in play are told without it. */
const ARCHIVED_MS = 3000;
/** One session's change is told by itself this many times a second at most: past that, the whole list, now and then. */
const CHANGES_PER_SECOND = 20;
/** What a window asked of a session there: only so many at once, and an answer no bigger than this. */
const MAX_CALLS = 16;
const MAX_ANSWER = 64 * 1024;
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
/** What a call is answered when this machine lends nothing (now). */
const NOT_LENT: LentResult = { text: "Your Mac's Simulator isn't available now: it's turned off in Cavvy's settings there, or Xcode isn't set up.", isError: true };
/** Calls of what this machine lends that one server may have running here at once. */
const LENT_AT_ONCE = 4;
/** What one call's input may hold, as text: a device's name, a tap, a few lines to type. */
const LENT_INPUT = 16 * 1024;
/** Answers to those that may wait to go out to a server that's slow to take them: a few screenshots' worth. */
const LENT_UNSENT = 32 * 1024 * 1024;

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
        pinned: s.pinned === true,
        archived: s.archived === true,
        settled: s.settled === true,
        live: s.live === true,
        ...(typeof s.model === "string" && s.model ? { model: cut(s.model, 100) } : {}),
        ...(status === "waiting" && (s.waitingKind === "permission" || s.waitingKind === "question" || s.waitingKind === "plan" || s.waitingKind === "secret") ? { waitingKind: s.waitingKind } : {}),
        ...(typeof s.turnStartedAt === "number" && Number.isFinite(s.turnStartedAt) ? { turnStartedAt: s.turnStartedAt } : {}),
    };
}

/**
 * One change to a server's sessions: a session as it is now, the id of one that's gone from the server (`remove`),
 * or of one that's still there and no longer among those kept here (`unlisted`: the list is only so long).
 */
export type SessionChange = { session: SessionSummary } | { remove: string } | { unlisted: string };


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
            /** How it's reached changed, or its sessions were listed anew. */
            changed: () => void;
            /** One of its sessions changed, or went. */
            session?: (change: SessionChange) => void;
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
        // Connected, or a connection is being opened: that one stands.
        if (this.stopped || this.ws) return;
        this.tries = 0;
        void this.attempt(false);
    }

    /** Its sessions as last heard, archived ones among them, the most recent first. */
    overview(): MachineOverview {
        return { name: this.name, state: this.state, sessions: [...this.sessions.values()].map((s) => this.shown(s)).sort((a, b) => b.updatedAt - a.updatedAt) };
    }

    /** The sessions there that wait for the user's answer on this machine (it lends them a tool, and asks first). */
    private asking = new Set<string>();

    /** A session as the list shows it now. */
    private shown(s: SessionSummary): SessionSummary {
        // While it isn't heard from, what it last said of a session at work would be a ring for news that isn't coming.
        if (this.state !== "connected" && this.state !== "connecting") return s.status === "idle" && !s.live ? s : { ...s, status: "idle", live: false, waitingKind: undefined, turnStartedAt: undefined };
        // Waiting, though the server doesn't know it: it's this machine that asks.
        return this.asking.has(s.id) && s.status !== "waiting" ? { ...s, status: "waiting", waitingKind: "permission" } : s;
    }

    /** This machine asks its user something for a session there (or no longer does): its row says it waits. */
    setAsking(id: string, on: boolean) {
        if (this.asking.has(id) === on) return;
        if (on) this.asking.add(id);
        else this.asking.delete(id);
        const s = this.sessions.get(id);
        if (s) this.say({ session: this.shown(s) });
    }

    /** Session changes told in this second (CHANGES_PER_SECOND). */
    private burst = { from: 0, told: 0 };

    /** Tells one change, unless there are more in a second than a server's sessions ever change: then the list is told anew, which is only so often (manager.ts). */
    private say(change: SessionChange) {
        const now = Date.now();
        if (now - this.burst.from >= 1000) this.burst = { from: now, told: 0 };
        if (++this.burst.told > CHANGES_PER_SECOND) return this.o.changed();
        this.o.session?.(change);
    }

    /**
     * Makes room when a server has more sessions than are kept: those least recently at work go, the ones in play
     * and the archived alike. `told`: each is said to be out of the list (it isn't gone from the server).
     */
    private bound(told: boolean) {
        const over = this.sessions.size - 2 * HEARD;
        if (over <= 0) return;
        for (const s of [...this.sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, over)) {
            this.sessions.delete(s.id);
            if (told) this.say({ unlisted: s.id });
        }
    }

    /** Calls waiting for the server's answer (call), by the id they were sent with. */
    private calls = new Map<number, { done: (r: { result?: unknown; error?: unknown }) => void; gone: () => void; timer: ReturnType<typeof setTimeout> }>();
    private nextId = 10;

    /**
     * Asks the server's Cavvy for one of the things a session's row offers (RELAYED_SESSION_METHODS), for a window that isn't on
     * that server. Its answer is passed on only if it's small; what went wrong, in a few of its words.
     */
    call(method: (typeof RELAYED_SESSION_METHODS)[number], params: Record<string, unknown>): Promise<unknown> {
        const ws = this.ws;
        if (!ws?.open || this.state !== "connected") return Promise.reject(new Error(`${this.name} isn't connected.`));
        if (this.calls.size >= MAX_CALLS) return Promise.reject(new Error(`${this.name} is still busy. Try again.`));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.calls.delete(id);
                reject(new Error(`${this.name} didn't answer.`));
            }, REPLY_MS);
            (timer as { unref?: () => void }).unref?.();
            this.calls.set(id, {
                timer,
                gone: () => reject(new Error(`${this.name} went away before it answered.`)),
                done: (r) => {
                    const error = r.error && typeof r.error === "object" ? (r.error as { message?: unknown; code?: unknown }) : undefined;
                    // Why, in a few of its words on one line (marked as its words, so they're shown as that server's),
                    // and its kind when it names one (a window treats some apart).
                    if (error) return reject(Object.assign(new Error(cut(error.message, 300).replace(/\s+/g, " ").trim() || "It didn't work."), { theirs: true }, typeof error.code === "string" && /^[a-z_]{1,40}$/.test(error.code) ? { code: error.code } : {}));
                    const result = r.result ?? null;
                    if (JSON.stringify(result).length > MAX_ANSWER) return reject(new Error(`${this.name} answered with more than was asked for.`));
                    resolve(result);
                },
            });
            ws.send(JSON.stringify({ id, method, params }));
        });
    }

    /** What this machine lends changed: said to the server on the connection there is, if any. */
    relend() {
        if (this.ws?.open) this.relendNow?.();
    }
    private relendNow?: () => void;

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
        /** Calls of tools this machine lends that are running here, by the server's id for each. */
        const lending = new Map<string, AbortController>();
        /** The lists asked for when the connection opens: those in play, then the archived. */
        let archivedListed = false;
        const list = (rows: unknown, archived: boolean) => {
            for (const v of Array.isArray(rows) ? rows.slice(0, HEARD) : []) {
                const s = heardSession(v);
                if (s && s.archived === archived) this.sessions.set(s.id, s);
            }
            // Bounded, whatever the server lists.
            this.bound(false);
        };
        /** Both lists are in, or the archived one is slow to come: the list is told. */
        let told: ReturnType<typeof setTimeout> | undefined;
        const answerTo = (callId: string, r: LentResult) => void (ws.open && ws.send(JSON.stringify({ id: this.nextId++, method: "offers.result", params: { callId, ...r } })));
        // What this machine lends changed while connected (the Simulator turned off or on in its settings): the server
        // is told now. Turned off, the calls still waiting here (for the user's answer, say) are answered and given up:
        // nothing is left asking for what can't run.
        this.relendNow = () => {
            if (!listed || !this.o.lend) return;
            const kinds = this.o.lends?.() ?? [];
            if (!kinds.length) {
                for (const [callId, stop] of lending) {
                    answerTo(callId, NOT_LENT);
                    stop.abort();
                }
                lending.clear();
            }
            if (ws.open) ws.send(JSON.stringify({ id: this.nextId++, method: "offers.set", params: { kinds } }));
        };
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
                list(msg.result, false);
                this.state = "connected";
                // Told once the archived are in too (they come at once), so a window's archived rows aren't dropped and put back.
                told = setTimeout(() => this.ws === ws && this.o.changed(), ARCHIVED_MS);
                (told as { unref?: () => void }).unref?.();
                ws.send(JSON.stringify({ id: 2, method: "sessions.list", params: { limit: HEARD, archived: true } }));
                const kinds = this.o.lends?.() ?? [];
                if (kinds.length && this.o.lend) ws.send(JSON.stringify({ id: this.nextId++, method: "offers.set", params: { kinds } }));
                return;
            }
            if (msg.id === 2) {
                if (!listed || archivedListed) return;
                archivedListed = true;
                list(msg.result, true);
                clearTimeout(told);
                this.o.changed();
                return;
            }
            if (typeof msg.id === "number") {
                const call = this.calls.get(msg.id);
                if (!call) return;
                this.calls.delete(msg.id);
                clearTimeout(call.timer);
                return call.done(msg as { result?: unknown; error?: unknown });
            }
            const ev = msg.event;
            if (!ev || typeof ev !== "object" || !listed) return;
            if (ev.type === "sessions.upsert") {
                const s = heardSession(ev.session);
                if (!s) return;
                this.sessions.delete(s.id);
                this.sessions.set(s.id, s);
                this.say({ session: this.shown(s) });
                // Bounded, whatever the server sends.
                this.bound(true);
            } else if (ev.type === "sessions.remove") {
                if (typeof ev.id === "string" && this.sessions.delete(ev.id)) this.say({ remove: ev.id });
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
            } else if (ev.type === "offers.call") {
                // What this machine lends is asked for by a session there. Whatever is wrong with a call, it's
                // answered: nothing there waits on a call that was only dropped here.
                if (!this.o.lend || typeof ev.callId !== "string" || ev.callId.length > 100 || lending.has(ev.callId)) return;
                const callId = ev.callId;
                const answer = (r: LentResult) => answerTo(callId, r);
                const session = ev.session && typeof ev.session === "object" ? ev.session : ({} as { id?: unknown; title?: unknown });
                if (typeof ev.tool !== "string" || typeof session.id !== "string" || !/^[\w.-]{1,120}$/.test(session.id)) return answer({ text: "That call isn't one your Mac takes.", isError: true });
                const input = ev.input && typeof ev.input === "object" && !Array.isArray(ev.input) ? ev.input : {};
                if (JSON.stringify(input).length > LENT_INPUT) return answer({ text: "That call's input is too long for your Mac to take.", isError: true });
                // Only so many at once: a server gone wrong can't have calls here without end.
                if (lending.size >= LENT_AT_ONCE) return answer({ text: `Your Mac is still on ${LENT_AT_ONCE} other calls from this machine (it may be waiting for the user's answer there). Wait for them, then try again.`, isError: true });
                // What's lent may have changed since the connection was made (the Simulator turned off there): said, so
                // sessions there stop being offered what can't run.
                const kinds = this.o.lends?.() ?? [];
                if (!kinds.length) {
                    // The answer first: saying nothing is lent ends every call this machine still has there.
                    answer(NOT_LENT);
                    return void ws.send(JSON.stringify({ id: this.nextId++, method: "offers.set", params: { kinds } }));
                }
                const stop = new AbortController();
                lending.set(callId, stop);
                const call: LentCall = { tool: ev.tool.slice(0, 100), input, session: { id: session.id, title: cut(session.title, 80) } };
                void this.o
                    .lend(call, stop.signal)
                    .catch((e): LentResult => ({ text: `It couldn't be run on your Mac: ${cut((e as Error).message, 300)}`, isError: true }))
                    .then((r) => {
                        lending.delete(callId);
                        // Given up there meanwhile, or the connection is another one now: nobody waits for it.
                        if (!stop.signal.aborted) answer(r);
                    });
            } else if (ev.type === "offers.cancel") {
                if (typeof ev.callId === "string") lending.get(ev.callId)?.abort();
            }
        };
        const ws = openBoundedSocket({
            port: Number(new URL(url).port),
            path: "/ws",
            protocols: ["cavvy.v1", `auth.${token}`],
            maxMessage: MAX_MESSAGE,
            maxPerMinute: MAX_PER_MINUTE,
            // What this machine lends is answered with what was asked for, a picture of a screen among it: that may
            // wait to go out, where otherwise this end says next to nothing.
            ...(this.o.lend ? { maxUnsent: LENT_UNSENT } : {}),
            onOpen: () => ws.send(JSON.stringify({ id: 1, method: "sessions.list", params: { limit: HEARD } })),
            onMessage: (text) => {
                try {
                    heard(text);
                } catch {
                    // Nothing a server sends may bring this machine's Cavvy down.
                }
            },
            onClose: (why) => {
                clearTimeout(timeout);
                clearTimeout(told);
                // Whoever asked can't be answered any more.
                for (const stop of lending.values()) stop.abort();
                lending.clear();
                if (this.ws !== ws) return;
                // Nor can what a window asked of a session there be answered.
                for (const [id, call] of this.calls) {
                    this.calls.delete(id);
                    clearTimeout(call.timer);
                    call.gone();
                }
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
