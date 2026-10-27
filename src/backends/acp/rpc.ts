// JSON-RPC 2.0 over an ACP agent's stdin and stdout, one object a line. Both
// sides send requests: Cavvy's (initialize, session/prompt, ...) and the
// agent's (session/request_permission). Codex's Rpc (codex.ts) leaves out
// "jsonrpc", which ACP agents require.

import type { JsonLinesProcess } from "../cli";
import { EXIT_DRAIN_MS } from "../live/session";

/** An error answer: the agent's to a request of ours, or ours to one of its. */
export class AcpError extends Error {
    constructor(
        message: string,
        readonly code: number,
        readonly data?: unknown,
    ) {
        super(message);
    }
}

/** A request that never reached the agent (its stdin was gone): it can't have acted on it. */
export class AcpNotSent extends Error {}

/** Its output ended before it answered: the process went (why is in its exit, not here). */
export class AcpGone extends Error {}

export const METHOD_NOT_FOUND = -32601;

export class AcpRpc {
    private seq = 0;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    private ended = false;
    /** Settles once its output has ended; requests still waiting are rejected then. */
    readonly done: Promise<void>;

    constructor(
        readonly proc: JsonLinesProcess,
        private onNotification: (method: string, params: any) => void,
        /** Answers a request of the agent's: what it returns, or an AcpError it throws. */
        private onRequest: (method: string, params: any, id: number | string) => Promise<unknown>,
    ) {
        this.done = this.read();
    }

    /** A request: its answer, or an AcpError. `sent` settles once it's written (false: it wasn't). */
    call(method: string, params: unknown): { sent: Promise<boolean>; result: Promise<any> } {
        const id = ++this.seq;
        let fail!: (e: Error) => void;
        const result = new Promise<any>((resolve, reject) => {
            fail = reject;
            if (this.ended) return reject(new AcpGone(`${method}: the agent's output had ended`));
            this.pending.set(id, { resolve, reject });
        });
        const sent = this.ended
            ? Promise.resolve(false)
            : this.proc.send({ jsonrpc: "2.0", id, method, params }).then((ok) => {
                  if (!ok && this.pending.delete(id)) fail(new AcpNotSent(`${method}: the agent's input was closed`));
                  return ok;
              });
        return { sent, result };
    }

    request(method: string, params: unknown): Promise<any> {
        return this.call(method, params).result;
    }

    notify(method: string, params: unknown): Promise<boolean> {
        return this.proc.send({ jsonrpc: "2.0", method, params });
    }

    private respond(id: number | string, answer: { result: unknown } | { error: { code: number; message: string } }): Promise<boolean> {
        return this.proc.send({ jsonrpc: "2.0", id, ...answer });
    }

    private async read() {
        try {
            for await (const m of this.proc.messages({ quietAfterExitMs: EXIT_DRAIN_MS })) {
                if (m.jsonrpc !== "2.0") continue;
                const hasId = typeof m.id === "number" || typeof m.id === "string";
                if (typeof m.method === "string") {
                    if (!hasId) {
                        try {
                            this.onNotification(m.method, m.params);
                        } catch {
                            // one bad update doesn't stop the rest
                        }
                        continue;
                    }
                    const id = m.id as number | string;
                    void this.onRequest(m.method, m.params, id).then(
                        (result) => this.respond(id, { result: result ?? null }),
                        (e) => this.respond(id, { error: { code: e instanceof AcpError ? e.code : -32603, message: e instanceof Error ? e.message : String(e) } }),
                    );
                    continue;
                }
                if (!hasId) continue;
                const p = this.pending.get(m.id as number);
                if (!p) continue;
                this.pending.delete(m.id as number);
                if (m.error) p.reject(new AcpError(String(m.error.message ?? "error"), Number(m.error.code ?? -32603), m.error.data));
                else p.resolve(m.result);
            }
        } finally {
            this.ended = true;
            for (const p of this.pending.values()) p.reject(new AcpGone("The agent's output ended before it answered"));
            this.pending.clear();
        }
    }
}
