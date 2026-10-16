// The WebSocket to the harness server: typed requests, server events, and
// reconnecting with backoff (asking for fresh credentials each time, so a
// restarted desktop sidecar with a new port and token is picked up).

import type { Method, ParamsOf, ResultOf, ServerEvent, ServerMessage } from "@shared/protocol";
import { RequestAges } from "./request-age";

export interface Credentials {
    /** ws:// URL of the server's /ws endpoint. */
    url: string;
    token: string;
}

export type ConnectionState = "connecting" | "open" | "reconnecting" | "unauthorized" | "unavailable";

export class RpcError extends Error {
    constructor(
        message: string,
        readonly code?: string,
        /** With "needs_trust": the folder to trust. */
        readonly folder?: string,
    ) {
        super(message);
    }
}

interface Pending {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
}

export class Rpc {
    private ws?: WebSocket;
    private next = 1;
    private pending = new Map<number, Pending>();
    private listeners = new Set<(e: ServerEvent) => void>();
    private stateListeners = new Set<(s: ConnectionState, attempt: number) => void>();
    private attempt = 0;
    private closed = false;
    private ages = new RequestAges();
    private slowListeners = new Set<(slow: boolean) => void>();
    private noticeTimer?: ReturnType<typeof setTimeout>;
    private retryTimer?: ReturnType<typeof setTimeout>;
    private connecting = false;
    private generation = 0;
    state: ConnectionState = "connecting";

    constructor(private credentials: () => Promise<Credentials | undefined>) {}

    onEvent(fn: (e: ServerEvent) => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    onState(fn: (s: ConnectionState, attempt: number) => void): () => void {
        this.stateListeners.add(fn);
        return () => this.stateListeners.delete(fn);
    }

    private setState(s: ConnectionState) {
        this.state = s;
        for (const fn of this.stateListeners) fn(s, this.attempt);
    }

    onSlow(fn: (slow: boolean) => void): () => void {
        this.slowListeners.add(fn);
        return () => this.slowListeners.delete(fn);
    }

    private updateNotice() {
        clearTimeout(this.noticeTimer);
        const now = performance.now();
        for (const fn of this.slowListeners) fn(this.ages.slow(now));
        const delay = this.ages.nextDelay(now);
        if (delay !== undefined) this.noticeTimer = setTimeout(() => this.updateNotice(), delay);
    }

    private rejectPending() {
        for (const p of this.pending.values()) p.reject(new RpcError("Disconnected from the harness server", "disconnected"));
        this.pending.clear();
        this.ages.clear();
        this.updateNotice();
    }

    async connect(): Promise<void> {
        if (this.closed || this.connecting || this.ws) return;
        clearTimeout(this.retryTimer);
        this.connecting = true;
        const generation = ++this.generation;
        let creds: Credentials | undefined;
        try {
            creds = await this.credentials();
        } catch {
            if (generation !== this.generation || this.closed) return;
            this.connecting = false;
            // The desktop app's server isn't up yet (a slow first start, a restart): ask again.
            if (this.retriesCredentials) return this.retry();
            creds = undefined;
        }
        if (generation !== this.generation || this.closed) return;
        this.connecting = false;
        if (!creds) {
            this.setState("unauthorized");
            return;
        }
        const ws = new WebSocket(creds.url, ["harness.v1", `auth.${creds.token}`]);
        this.ws = ws;
        let opened = false;
        ws.onopen = () => {
            if (this.ws !== ws || this.closed) return;
            opened = true;
            this.attempt = 0;
            this.setState("open");
        };
        ws.onmessage = (m) => {
            if (this.ws === ws && !this.closed) this.receive(String(m.data));
        };
        ws.onclose = (ev) => {
            if (this.ws !== ws) return;
            this.ws = undefined;
            this.rejectPending();
            if (this.closed) return;
            // Refused before opening, more than a few times: probably a stale token.
            if (!opened && ev.code === 1006 && this.attempt >= 3 && !this.retriesCredentials) {
                this.setState("unauthorized");
                return;
            }
            this.retry();
        };
    }

    private retry() {
        if (this.closed) return;
        clearTimeout(this.retryTimer);
        this.attempt++;
        this.setState(this.attempt > 8 ? "unavailable" : "reconnecting");
        const delay = Math.min(10_000, 250 * 2 ** Math.min(this.attempt, 6)) * (0.8 + Math.random() * 0.4);
        this.retryTimer = setTimeout(() => void this.connect(), delay);
    }

    /** Retry the connection, never a request: a lost reply may still have taken effect. */
    reconnectNow() {
        if (this.closed || this.state === "open") return;
        clearTimeout(this.retryTimer);
        this.generation++;
        this.connecting = false;
        const ws = this.ws;
        this.ws = undefined;
        ws?.close();
        this.attempt = 0;
        this.setState("reconnecting");
        void this.connect();
    }

    /** The desktop app asks the sidecar for credentials each time, so a stale token is never the problem there. */
    retriesCredentials = false;

    private receive(raw: string) {
        let msg: ServerMessage;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }
        if ("event" in msg) {
            for (const fn of this.listeners) {
                try {
                    fn(msg.event);
                } catch (e) {
                    console.error(e);
                }
            }
            return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        this.ages.remove(msg.id);
        this.updateNotice();
        if ("error" in msg) p.reject(new RpcError(msg.error.message, msg.error.code, msg.error.folder));
        else p.resolve(msg.result);
    }

    /** Never wait for reconnect: an offline action must not run later without the user. */
    async call<M extends Method>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
        if (this.closed || this.state !== "open") throw new RpcError("Not connected", "disconnected");
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) throw new RpcError("Not connected", "disconnected");
        const id = this.next++;
        return new Promise<ResultOf<M>>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
            this.ages.add(id, method, performance.now());
            this.updateNotice();
            try {
                ws.send(JSON.stringify({ id, method, params }));
            } catch (e) {
                this.pending.delete(id);
                this.ages.remove(id);
                this.updateNotice();
                reject(e);
            }
        });
    }

    close() {
        this.closed = true;
        this.generation++;
        clearTimeout(this.retryTimer);
        this.rejectPending();
        this.setState("unavailable");
        this.ws?.close();
    }
}
