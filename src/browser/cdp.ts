// A small Chrome DevTools Protocol client over a WebSocket: commands answered by id, each with a time limit, and
// events by name. One connection serves the browser and every page attached to it (a page's commands and events
// carry its sessionId).

export class CdpError extends Error {
    constructor(
        message: string,
        readonly code?: number,
    ) {
        super(message);
    }
}

export type CdpListener = (params: any, sessionId: string | undefined) => void;

interface Pending {
    method: string;
    resolve: (result: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** How long a command may take before it is given up on. */
export const COMMAND_TIMEOUT_MS = 30_000;

export class CdpClient {
    private seq = 0;
    private pending = new Map<number, Pending>();
    private listeners = new Map<string, Set<CdpListener>>();
    private closeListeners = new Set<(reason: string) => void>();
    closed = false;

    private constructor(private ws: WebSocket) {
        ws.onmessage = (event) => this.receive(String(event.data));
        ws.onclose = () => this.shutdown("The connection to the browser closed");
        ws.onerror = () => this.shutdown("The connection to the browser failed");
    }

    /** Opens the connection; rejects when it doesn't open within `timeoutMs`, or `signal` aborts. */
    static connect(url: string, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CdpClient> {
        return new Promise((resolve, reject) => {
            // Without compression: Bun's client fails some of Chrome's compressed frames ("Invalid compressed data"), and the connection is local.
            const ws = new WebSocket(url, { perMessageDeflate: false });
            const done = (fail?: Error) => {
                clearTimeout(timer);
                o.signal?.removeEventListener("abort", abort);
                if (fail) {
                    ws.onopen = ws.onerror = ws.onclose = null;
                    ws.close();
                    reject(fail);
                } else resolve(new CdpClient(ws));
            };
            const abort = () => done(new CdpError("Connecting to the browser was cancelled"));
            const timer = setTimeout(() => done(new CdpError(`The browser didn't accept a connection within ${o.timeoutMs ?? 10_000} ms`)), o.timeoutMs ?? 10_000);
            ws.onopen = () => done();
            ws.onerror = () => done(new CdpError("Couldn't connect to the browser"));
            ws.onclose = () => done(new CdpError("The browser closed the connection"));
            if (o.signal?.aborted) abort();
            else o.signal?.addEventListener("abort", abort, { once: true });
        });
    }

    /** Runs a command; `sessionId` aims it at an attached page. Rejects with a CdpError when the browser refuses it. */
    send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
        if (this.closed) return Promise.reject(new CdpError("The browser is closed"));
        return new Promise<T>((resolve, reject) => {
            const id = ++this.seq;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new CdpError(`${method} timed out after ${timeoutMs} ms`));
            }, timeoutMs);
            this.pending.set(id, { method, resolve, reject, timer });
            try {
                this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
            } catch (e) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new CdpError(`${method} couldn't be sent: ${(e as Error).message}`));
            }
        });
    }

    /** Calls `fn` for each event of this name, from any page (`sessionId` says which); returns how to stop. */
    on(event: string, fn: CdpListener): () => void {
        let set = this.listeners.get(event);
        if (!set) this.listeners.set(event, (set = new Set()));
        set.add(fn);
        return () => {
            set.delete(fn);
            if (!set.size && this.listeners.get(event) === set) this.listeners.delete(event);
        };
    }

    /** Calls `fn` once the connection is gone (immediately if it already is), with why. */
    onClose(fn: (reason: string) => void): void {
        if (this.closed) return fn("The browser is closed");
        this.closeListeners.add(fn);
    }

    close() {
        this.shutdown("The browser is closed");
        this.ws.close();
    }

    private receive(raw: string) {
        let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string }; sessionId?: string };
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }
        if (typeof msg.id === "number") {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new CdpError(`${p.method}: ${msg.error.message ?? "failed"}`, msg.error.code));
            else p.resolve(msg.result ?? {});
        } else if (msg.method) {
            for (const fn of [...(this.listeners.get(msg.method) ?? [])]) {
                try {
                    fn(msg.params ?? {}, msg.sessionId);
                } catch (e) {
                    console.error(e);
                }
            }
        }
    }

    private shutdown(reason: string) {
        if (this.closed) return;
        this.closed = true;
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new CdpError(reason));
        }
        this.pending.clear();
        this.listeners.clear();
        const fns = [...this.closeListeners];
        this.closeListeners.clear();
        for (const fn of fns) fn(reason);
    }
}
