// The WebSocket to the harness server: typed requests, server events, and
// reconnecting with backoff (asking for fresh credentials each time, so a
// restarted desktop sidecar with a new port and token is picked up).

import type { Method, ParamsOf, ResultOf, ServerEvent, ServerMessage } from "@shared/protocol";

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
    private openWaiters: (() => void)[] = [];
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

    async connect(): Promise<void> {
        if (this.closed) return;
        let creds: Credentials | undefined;
        try {
            creds = await this.credentials();
        } catch {
            // The desktop app's server isn't up yet (a slow first start, a restart): ask again.
            if (this.retriesCredentials) return this.retry();
            creds = undefined;
        }
        if (!creds) {
            this.setState("unauthorized");
            return;
        }
        const ws = new WebSocket(creds.url, ["harness.v1", `auth.${creds.token}`]);
        this.ws = ws;
        let opened = false;
        ws.onopen = () => {
            opened = true;
            this.attempt = 0;
            this.setState("open");
            for (const w of this.openWaiters.splice(0)) w();
        };
        ws.onmessage = (m) => this.receive(String(m.data));
        ws.onclose = (ev) => {
            if (this.ws !== ws) return;
            this.ws = undefined;
            for (const p of this.pending.values()) p.reject(new RpcError("Disconnected from the harness server", "disconnected"));
            this.pending.clear();
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
        this.attempt++;
        this.setState(this.attempt > 8 ? "unavailable" : "reconnecting");
        const delay = Math.min(10_000, 250 * 2 ** Math.min(this.attempt, 6)) * (0.8 + Math.random() * 0.4);
        setTimeout(() => void this.connect(), delay);
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
        if ("error" in msg) p.reject(new RpcError(msg.error.message, msg.error.code));
        else p.resolve(msg.result);
    }

    /** Resolves once connected (immediately when already). */
    ready(): Promise<void> {
        if (this.state === "open") return Promise.resolve();
        return new Promise((r) => this.openWaiters.push(r));
    }

    async call<M extends Method>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
        if (this.state !== "open") await this.ready();
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) throw new RpcError("Not connected", "disconnected");
        const id = this.next++;
        return new Promise<ResultOf<M>>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
            ws.send(JSON.stringify({ id, method, params }));
        });
    }

    close() {
        this.closed = true;
        this.ws?.close();
    }
}
