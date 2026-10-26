// query(): the SDK's async generator. Light on purpose: the engine
// (runner.ts, and with it the agent, providers and tools) loads on the first
// next(), so importing the SDK costs almost nothing.

import type { SDKMessage } from "./messages";
import type { PermissionMode } from "../permissions/modes";
import type { QueryParams } from "./types";
import type { RunControl } from "./runner";
import { CavvySdkError } from "./errors";

// As in permissions/modes.ts, which this light module doesn't load.
const MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"];

export interface Query extends AsyncGenerator<SDKMessage, void, undefined> {
    /** Stop the running turn. Its result has subtype "error_aborted"; a streaming query goes on to the next message. */
    interrupt(): Promise<void>;
    /**
     * Send a message to the running turn: the model gets it after its current
     * step (between tool calls), as when you type while the agent works. With
     * no turn running it becomes the next turn. Resolves false once the query
     * is over and the message went nowhere.
     */
    steer(message: string): Promise<boolean>;
    /** Change the permission mode, for the running turn's later calls and the turns after. */
    setPermissionMode(mode: PermissionMode): Promise<void>;
    /**
     * End the query: stop the running turn, run SessionEnd hooks, stop
     * background shells and MCP servers, and let go of the session. Breaking
     * out of `for await` does the same.
     */
    close(): Promise<void>;
    /** The session's id, once the query has started (rejects if it fails first). */
    readonly sessionId: Promise<string>;
}

class QueryImpl implements Query {
    private queue: SDKMessage[] = [];
    /** next() calls waiting for a message, in order. */
    private waiting: (() => void)[] = [];
    private ended = false;
    private failure: { error: unknown } | undefined;
    private control: RunControl | undefined;
    private starting: Promise<RunControl> | undefined;
    private closed = false;
    private mode: PermissionMode | undefined;
    /** steer() before the query started: sent once it has. */
    private early: string[] = [];
    private idResolve!: (id: string) => void;
    private idReject!: (e: unknown) => void;
    readonly sessionId: Promise<string>;

    constructor(private params: QueryParams) {
        this.sessionId = new Promise((res, rej) => ((this.idResolve = res), (this.idReject = rej)));
        this.sessionId.catch(() => {});
    }

    private start(): Promise<RunControl> {
        return (this.starting ??= import("./runner").then(({ startQuery }) => {
            const c = startQuery(this.params, {
                push: (m) => {
                    this.queue.push(m);
                    this.wake();
                },
                end: (failure) => {
                    this.ended = true;
                    this.failure = failure;
                    this.wake();
                },
            });
            c.sessionId.then(this.idResolve, this.idReject);
            // Checked when it was set.
            if (this.mode) c.setPermissionMode(this.mode);
            for (const m of this.early.splice(0)) c.steer(m);
            this.control = c;
            if (this.closed) void c.close();
            return c;
        }));
    }

    private wake() {
        for (const w of this.waiting.splice(0)) w();
    }

    /** next() calls answer in the order they were made, as a generator's do. */
    private chain: Promise<unknown> = Promise.resolve();

    next(): Promise<IteratorResult<SDKMessage, void>> {
        const r = this.chain.then(() => this.take());
        this.chain = r.catch(() => {});
        return r;
    }

    private async take(): Promise<IteratorResult<SDKMessage, void>> {
        if (!this.closed && !this.starting) await this.start();
        for (;;) {
            if (this.queue.length) return { done: false, value: this.queue.shift()! };
            if (this.ended || (this.closed && !this.starting)) {
                if (this.failure) {
                    const { error } = this.failure;
                    this.failure = undefined;
                    throw error;
                }
                return { done: true, value: undefined };
            }
            await new Promise<void>((r) => this.waiting.push(r));
        }
    }

    async return(): Promise<IteratorResult<SDKMessage, void>> {
        await this.close();
        this.queue = [];
        this.failure = undefined;
        return { done: true, value: undefined };
    }

    async throw(e: unknown): Promise<IteratorResult<SDKMessage, void>> {
        await this.close();
        throw e;
    }

    [Symbol.asyncIterator]() {
        return this;
    }

    async [Symbol.asyncDispose]() {
        await this.close();
    }

    async interrupt() {
        this.control?.interrupt();
    }

    async steer(message: string): Promise<boolean> {
        if (typeof message !== "string") throw new TypeError("steer(): the message must be a string.");
        if (this.control) return this.control.steer(message);
        if (this.closed) return false;
        this.early.push(message);
        return true;
    }

    async setPermissionMode(mode: PermissionMode) {
        if (!MODES.includes(mode)) throw new CavvySdkError(`Unknown permission mode "${mode}". Use one of: ${MODES.join(", ")}.`);
        if (this.control) this.control.setPermissionMode(mode);
        else this.mode = mode;
    }

    async close() {
        this.closed = true;
        if (!this.starting) {
            this.ended = true;
            this.idReject(new Error("The query was closed before it started."));
            this.wake();
            return;
        }
        const c = await this.starting;
        await c.close();
    }
}

/**
 * Run a prompt (or a conversation) through Cavvy and iterate over what
 * happens: an init message, the model's messages and tool results, and one
 * result message for each turn. Nothing runs until you start iterating.
 *
 * @example
 * for await (const m of query({ prompt: "What does src/index.ts do?" })) {
 *     if (m.type === "result") console.log(m.result);
 * }
 */
export function query(params: QueryParams): Query {
    if (!params || (typeof params.prompt !== "string" && typeof (params.prompt as AsyncIterable<unknown>)?.[Symbol.asyncIterator] !== "function")) {
        throw new TypeError("query(): prompt must be a string or an async iterable of messages.");
    }
    return new QueryImpl(params);
}
