// Minimal dual-era MCP client: tools, resources, prompts, and what servers
// ask of the client (elicitation, sampling, roots).
//
// Modern servers (protocol 2026-07-28) are stateless: every request carries
// the protocol version and client capabilities in params._meta, and there is
// no initialize handshake. Legacy servers (2025-11-25 and earlier) need
// initialize + notifications/initialized. Per the spec's dual-era guidance we
// probe with server/discover and fall back to initialize on any other error
// or a timeout.
//
// A server asks the client for input in two ways: a legacy server sends a
// request of its own (elicitation/create, sampling/createMessage,
// roots/list) while one of ours is open; a modern one answers ours with
// resultType "input_required" and we retry it with the answers (multi
// round-trip requests). Both reach the same McpInput.
//
// Transports: stdio, Streamable HTTP, the older HTTP+SSE, and WebSocket.

import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseSse } from "../providers/sse";
import { APP_NAME, APP_VERSION } from "../config/paths";
import type { McpServerConfig } from "../config/settings";
import { childEnv } from "../tools/bash";
import { serverCwd } from "./approval";

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MODERN_ERRORS = new Set([-32020, -32021, -32022]);
/** How many times one request is retried with answers before the server is taken to be looping. */
const MAX_INPUT_ROUNDS = 8;
/** Pages of a list read before giving up on the rest (a server that never stops paginating). */
const MAX_PAGES = 50;

export interface McpTool {
    name: string;
    title?: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export interface McpResource {
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
    size?: number;
}

export interface McpResourceTemplate {
    uriTemplate: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
}

export interface McpPromptArgument {
    name: string;
    title?: string;
    description?: string;
    required?: boolean;
}

export interface McpPrompt {
    name: string;
    title?: string;
    description?: string;
    arguments?: McpPromptArgument[];
}

export type McpContent =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "audio"; data: string; mimeType: string }
    | { type: "resource_link"; uri: string; name: string; title?: string; description?: string; mimeType?: string }
    | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

export interface McpResourceContents {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
}

export interface McpPromptMessage {
    role: "user" | "assistant";
    content: McpContent;
}

export interface McpCallResult {
    content: McpContent[];
    structuredContent?: unknown;
    isError?: boolean;
}

/** An elicitation/create request's params: a form (requestedSchema) or a link to open (url). */
export interface McpElicitParams {
    mode?: "form" | "url";
    message: string;
    requestedSchema?: Record<string, unknown>;
    url?: string;
}

export interface McpElicitResult {
    action: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
}

export interface McpSamplingParams {
    messages: { role: "user" | "assistant"; content: unknown }[];
    systemPrompt?: string;
    maxTokens?: number;
    modelPreferences?: { hints?: { name?: string }[]; intelligencePriority?: number; speedPriority?: number; costPriority?: number };
    temperature?: number;
    stopSequences?: string[];
}

export interface McpSamplingResult {
    role: "assistant";
    content: { type: "text"; text: string };
    model: string;
    stopReason?: string;
}

/**
 * Who answers what a server asks for while a request of ours is open. A
 * front end with someone to ask gives one; without it, forms are declined
 * and sampling refused.
 */
export interface McpInput {
    elicit?(params: McpElicitParams, signal: AbortSignal): Promise<McpElicitResult>;
    sample?(params: McpSamplingParams, signal: AbortSignal): Promise<McpSamplingResult>;
}

export class McpError extends Error {
    constructor(
        message: string,
        public code?: number,
        public data?: unknown,
    ) {
        super(message);
        this.name = "McpError";
    }
}

/** A 401 from the server: it wants an OAuth token (or a fresh one). `challenge` is its WWW-Authenticate header. */
export class McpAuthError extends McpError {
    constructor(
        message: string,
        readonly challenge: string,
    ) {
        super(message, 401);
        this.name = "McpAuthError";
    }
}

type Json = Record<string, any>;

const CLIENT_INFO = { name: APP_NAME, version: APP_VERSION };

/** The transport a configuration asks for: an explicit type, else a ws:// URL, a URL, or a command. */
export function transportOf(cfg: McpServerConfig): "stdio" | "http" | "sse" | "ws" | undefined {
    const t = cfg.type;
    // A url always means a remote server, whatever the type says: that's what the approval card shows and checks.
    if (cfg.url) {
        if (t === "sse" || t === "ws" || t === "http") return t;
        if (t === "streamable-http") return "http";
        return /^wss?:\/\//i.test(cfg.url) ? "ws" : "http";
    }
    if (t === "sse" || t === "ws" || t === "http") return t;
    if (t === "streamable-http") return "http";
    if (t === "stdio" || cfg.command) return "stdio";
    return undefined;
}

/**
 * Credentials for a remote server: the Authorization header to send, and
 * what to do on a 401 (true: a fresh token is ready, send it again).
 */
export interface McpAuth {
    header(signal?: AbortSignal): Promise<string | undefined>;
    unauthorized(challenge: string, signal?: AbortSignal): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Transports

type RequestOpts = { signal?: AbortSignal; timeoutMs?: number; headers?: Record<string, string>; input?: McpInput };
/** A request the server sent us: answer it (the result), or throw an McpError. */
type ServerRequestHandler = (method: string, params: Json, input: McpInput | undefined, signal: AbortSignal) => Promise<Json>;

interface Transport {
    /** Send a request and wait for its response (result or error). */
    request(method: string, params: Json, opts: RequestOpts): Promise<Json>;
    notify(method: string, params?: Json, signal?: AbortSignal): Promise<void>;
    close(): Promise<void>;
    onNotification?: (method: string, params: Json) => void;
    onRequest?: ServerRequestHandler;
    onExit?: () => void;
    era: "modern" | "legacy" | "unknown";
    stderrTail(): string;
}

/**
 * JSON-RPC over a channel that carries whole messages both ways (stdio,
 * HTTP+SSE, WebSocket): requests matched to responses by id, and the
 * server's own requests answered on the same channel.
 */
abstract class MessageTransport implements Transport {
    private nextId = 1;
    private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
    /** Server requests being answered, so a cancel can stop one. */
    private answering = new Map<string, AbortController>();
    protected dead?: McpError;
    era: "modern" | "legacy" | "unknown" = "unknown";
    onNotification?: (method: string, params: Json) => void;
    onRequest?: ServerRequestHandler;
    onExit?: () => void;

    protected abstract send(msg: Json): void;
    /** Resolves once messages can be sent (the SSE endpoint is known, the socket open). */
    protected ready: Promise<void> = Promise.resolve();
    abstract close(): Promise<void>;

    stderrTail(): string {
        return "";
    }

    /** The channel is gone: every open request fails, and later ones fail at once. */
    protected fail(e: McpError) {
        if (this.dead) return;
        this.dead = e;
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
        for (const ac of this.answering.values()) ac.abort();
        this.answering.clear();
        this.onExit?.();
    }

    /** A request that failed before reaching the server (its POST was refused). */
    protected rejectRequest(id: unknown, e: McpError) {
        const p = this.pending.get(Number(id));
        if (!p) return;
        this.pending.delete(Number(id));
        p.reject(e);
    }

    protected handle(msg: Json) {
        if (!msg || typeof msg !== "object") return;
        if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined) && msg.method === undefined) {
            const p = this.pending.get(Number(msg.id));
            if (!p) return;
            this.pending.delete(Number(msg.id));
            if (msg.error) p.reject(new McpError(msg.error.message ?? "error", msg.error.code, msg.error.data));
            else p.resolve(msg.result ?? {});
            return;
        }
        if (typeof msg.method !== "string") return;
        if (msg.id === undefined || msg.id === null) {
            if (msg.method === "notifications/cancelled") this.answering.get(String(msg.params?.requestId))?.abort();
            this.onNotification?.(msg.method, msg.params ?? {});
            return;
        }
        // A server request. Modern servers ask through results (MRTR), never like this.
        if (this.era === "modern") return;
        void this.answer(msg.id, msg.method, msg.params ?? {});
    }

    private async answer(id: string | number, method: string, params: Json) {
        const ac = new AbortController();
        this.answering.set(String(id), ac);
        try {
            const result = method === "ping" ? {} : this.onRequest ? await this.onRequest(method, params, undefined, ac.signal) : undefined;
            if (result === undefined) throw new McpError(`Method not found: ${method}`, -32601);
            if (!ac.signal.aborted) this.send({ jsonrpc: "2.0", id, result });
        } catch (e) {
            const err = e as McpError;
            if (!ac.signal.aborted) this.send({ jsonrpc: "2.0", id, error: { code: typeof err.code === "number" ? err.code : -32603, message: err.message } });
        } finally {
            this.answering.delete(String(id));
        }
    }

    get isDead(): boolean {
        return this.dead !== undefined;
    }

    /** What a request made after the channel is gone fails with. */
    protected gone(): McpError {
        return this.dead!;
    }

    async request(method: string, params: Json, opts: RequestOpts): Promise<Json> {
        if (this.dead) throw this.gone();
        if (opts.signal?.aborted) throw new McpError("aborted");
        await this.ready;
        if (this.dead) throw this.gone();
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const cleanup = () => {
                if (timer) clearTimeout(timer);
                opts.signal?.removeEventListener("abort", onAbort);
            };
            const onAbort = () => {
                cleanup();
                this.pending.delete(id);
                this.trySend({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Cancelled by user" } });
                reject(new McpError("aborted"));
            };
            this.pending.set(id, {
                resolve: (v) => {
                    cleanup();
                    resolve(v);
                },
                reject: (e) => {
                    cleanup();
                    reject(e);
                },
            });
            if (opts.timeoutMs) {
                timer = setTimeout(() => {
                    this.pending.delete(id);
                    opts.signal?.removeEventListener("abort", onAbort);
                    if (method !== "initialize") this.trySend({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Timed out" } });
                    reject(new McpError(`${method} timed out after ${Math.round(opts.timeoutMs! / 1000)}s`, -1));
                }, opts.timeoutMs);
            }
            opts.signal?.addEventListener("abort", onAbort, { once: true });
            this.trySend({ jsonrpc: "2.0", id, method, params });
        });
    }

    private trySend(msg: Json) {
        try {
            this.send(msg);
        } catch (e) {
            this.fail(e instanceof McpError ? e : new McpError(`send failed: ${(e as Error).message}`, -1));
        }
    }

    async notify(method: string, params?: Json) {
        if (this.dead) return;
        await this.ready.catch(() => undefined);
        if (!this.dead) this.trySend({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
    }
}

class StdioTransport extends MessageTransport {
    private proc: ChildProcess;
    private buf = "";
    private stderr = "";
    private exited = false;

    /** `runCwd`: the folder, already resolved (by McpManager.start, which checked the approval for it). */
    constructor(cfg: McpServerConfig, runCwd: string) {
        super();
        this.proc = spawn(cfg.command!, cfg.args ?? [], {
            cwd: runCwd,
            env: { ...childEnv(), ...(cfg.env ?? {}) },
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.proc.stdout!.setEncoding("utf8");
        this.proc.stdout!.on("data", (chunk: string) => this.onData(chunk));
        this.proc.stderr!.setEncoding("utf8");
        this.proc.stderr!.on("data", (chunk: string) => {
            this.stderr = (this.stderr + chunk).slice(-4000);
        });
        // A spawn failure (ENOENT, EACCES) emits "error" but no "exit": mark the
        // transport dead so later requests fail now instead of timing out.
        this.proc.on("error", (e) => {
            this.exited = true;
            this.fail(new McpError(`failed to start: ${e.message}`));
        });
        this.proc.on("exit", (code, sig) => {
            this.exited = true;
            this.fail(new McpError(`server exited (${sig ?? code})`));
        });
        this.proc.stdin!.on("error", () => {});
    }

    protected override gone(): McpError {
        return new McpError("server is not running");
    }

    override stderrTail(): string {
        return this.stderr.trim().split("\n").slice(-5).join("\n");
    }

    private onData(chunk: string) {
        this.buf += chunk;
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, nl).trim();
            this.buf = this.buf.slice(nl + 1);
            if (!line) continue;
            let msg: Json;
            try {
                msg = JSON.parse(line);
            } catch {
                continue; // non-protocol output; servers shouldn't do this
            }
            this.handle(msg);
        }
    }

    protected send(msg: Json) {
        if (this.exited) return;
        // JSON.stringify never emits raw newlines, satisfying the framing rule.
        this.proc.stdin!.write(JSON.stringify(msg) + "\n");
    }

    async close() {
        if (this.exited) return;
        // Spec: close stdin, wait, then SIGTERM, then SIGKILL.
        try {
            this.proc.stdin!.end();
        } catch {
            // ignore
        }
        const exited = new Promise<void>((r) => this.proc.once("exit", () => r()));
        const wait = (ms: number) => Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
        if (await wait(1500)) return;
        this.proc.kill("SIGTERM");
        if (await wait(2000)) return;
        this.proc.kill("SIGKILL");
    }
}

const HEADER_SAFE = /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/;

/** Header value per the Streamable HTTP rules: plain if safe, else the base64 sentinel. */
export function headerValue(v: string): string {
    if (HEADER_SAFE.test(v) && !v.startsWith("=?base64?")) return v;
    return `=?base64?${Buffer.from(v, "utf-8").toString("base64")}?=`;
}

/** The configured headers, with an Authorization from OAuth unless one is configured. */
async function withAuth(cfg: McpServerConfig, auth: McpAuth | undefined, signal?: AbortSignal): Promise<Record<string, string>> {
    const h: Record<string, string> = { ...(cfg.headers ?? {}) };
    if (auth && !Object.keys(h).some((k) => k.toLowerCase() === "authorization")) {
        const a = await auth.header(signal);
        if (a) h.Authorization = a;
    }
    return h;
}

function unauthorized(name: string, res: Response, oauth: boolean): McpError {
    const challenge = res.headers.get("www-authenticate") ?? "";
    if (oauth) return new McpAuthError(`${name} needs you to sign in. Run /mcp and choose Sign in.`, challenge);
    return new McpError(`${name} requires authorization${/bearer/i.test(challenge) ? " (OAuth)" : ""}. Add an Authorization header to this server's "headers" in settings.`, 401);
}

class HttpTransport implements Transport {
    private nextId = 1;
    private sessionId?: string;
    era: "modern" | "legacy" | "unknown" = "unknown";
    legacyVersion?: string;
    onNotification?: (method: string, params: Json) => void;
    onRequest?: ServerRequestHandler;

    constructor(
        private cfg: McpServerConfig,
        private name: string,
        private auth?: McpAuth,
    ) {}

    stderrTail(): string {
        return "";
    }

    private async baseHeaders(method: string, extra?: Record<string, string>, signal?: AbortSignal): Promise<Record<string, string>> {
        const h: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(await withAuth(this.cfg, this.auth, signal)),
        };
        if (this.era === "modern") {
            h["MCP-Protocol-Version"] = MODERN_VERSION;
            h["Mcp-Method"] = method;
        } else if (this.era === "legacy" && this.legacyVersion) {
            h["MCP-Protocol-Version"] = this.legacyVersion;
        }
        if (this.sessionId) h["MCP-Session-Id"] = this.sessionId;
        return { ...h, ...(extra ?? {}) };
    }

    async request(method: string, params: Json, opts: RequestOpts): Promise<Json> {
        const id = this.nextId++;
        const signals = [opts.signal, opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined].filter(Boolean) as AbortSignal[];
        const signal = signals.length ? AbortSignal.any(signals) : undefined;
        let res: Response;
        for (let attempt = 0; ; attempt++) {
            try {
                res = await fetch(this.cfg.url!, {
                    method: "POST",
                    headers: await this.baseHeaders(method, opts.headers, signal),
                    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
                    signal,
                });
            } catch (e) {
                if (e instanceof McpError) throw e;
                if (opts.signal?.aborted) throw new McpError("aborted");
                throw new McpError(`${this.name}: ${(e as Error).message}`, -1);
            }
            if (res.status !== 401) break;
            const challenge = res.headers.get("www-authenticate") ?? "";
            await res.body?.cancel();
            // A refreshed token gets one more try; past that it's the user's to sign in again.
            if (attempt === 0 && this.auth && (await this.auth.unauthorized(challenge, signal))) continue;
            throw unauthorized(this.name, res, Boolean(this.auth));
        }
        const sid = res.headers.get("mcp-session-id");
        if (sid && method === "initialize") this.sessionId = sid;
        if (res.status === 404 && this.sessionId && this.era === "legacy") {
            this.sessionId = undefined;
            await res.body?.cancel();
            throw new McpError("session expired", 404);
        }
        const ctype = res.headers.get("content-type") ?? "";
        if (ctype.includes("text/event-stream") && res.body) {
            for await (const ev of parseSse(res.body, signal)) {
                let msg: Json;
                try {
                    msg = JSON.parse(ev.data);
                } catch {
                    continue;
                }
                if (msg.id === id && (msg.result !== undefined || msg.error !== undefined)) {
                    if (msg.error) throw new McpError(msg.error.message ?? "error", msg.error.code, msg.error.data);
                    return msg.result ?? {};
                }
                if (typeof msg.method === "string" && (msg.id === undefined || msg.id === null)) this.onNotification?.(msg.method, msg.params ?? {});
                else if (typeof msg.method === "string" && this.era !== "modern") {
                    // A legacy server's request on this request's stream: it's about this request, so this request's input answers it.
                    void this.answer(msg.id, msg.method, msg.params ?? {}, opts.input, signal);
                }
            }
            throw new McpError(`${this.name}: stream closed before the response`, -1);
        }
        const text = await res.text();
        let msg: Json | undefined;
        try {
            msg = text ? JSON.parse(text) : undefined;
        } catch {
            // not JSON
        }
        if (msg?.error) throw new McpError(msg.error.message ?? `HTTP ${res.status}`, msg.error.code, msg.error.data);
        if (!res.ok) throw new McpError(`${this.name}: HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`, res.status);
        if (!msg) throw new McpError(`${this.name}: empty response`, -1);
        return msg.result ?? {};
    }

    private async answer(id: unknown, method: string, params: Json, input: McpInput | undefined, signal?: AbortSignal) {
        let reply: Json;
        try {
            const result = method === "ping" ? {} : this.onRequest ? await this.onRequest(method, params, input, signal ?? new AbortController().signal) : undefined;
            if (result === undefined) throw new McpError("Method not found", -32601);
            reply = { jsonrpc: "2.0", id, result };
        } catch (e) {
            const err = e as McpError;
            reply = { jsonrpc: "2.0", id, error: { code: typeof err.code === "number" ? err.code : -32603, message: err.message } };
        }
        await this.postRaw(reply, signal);
    }

    // Fire-and-forget messages still get a deadline: a server that never
    // answers must not stall connecting (initialized) or quitting (DELETE).
    private async postRaw(body: Json, signal?: AbortSignal) {
        const deadline = AbortSignal.timeout(10_000);
        try {
            const s = signal ? AbortSignal.any([signal, deadline]) : deadline;
            const r = await fetch(this.cfg.url!, { method: "POST", headers: await this.baseHeaders(String(body.method ?? ""), undefined, s), body: JSON.stringify(body), signal: s });
            await r.body?.cancel();
        } catch {
            // ignore
        }
    }

    async notify(method: string, params?: Json, signal?: AbortSignal) {
        await this.postRaw({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }, signal);
    }

    async close() {
        if (this.era === "legacy" && this.sessionId) {
            try {
                const r = await fetch(this.cfg.url!, { method: "DELETE", headers: await this.baseHeaders("", undefined, AbortSignal.timeout(3_000)), signal: AbortSignal.timeout(3_000) });
                await r.body?.cancel();
            } catch {
                // ignore
            }
        }
    }
}

/** How long an SSE server has to open its stream and name its endpoint (tests shorten it). */
export const sseTiming = { connectMs: 30_000 };

/**
 * The HTTP+SSE transport of protocol 2024-11-05 (deprecated, still common):
 * a GET opens an event stream whose first event names the URL to POST
 * messages to; every response comes back on the stream.
 */
class SseTransport extends MessageTransport {
    private life = new AbortController();
    private endpoint?: string;

    constructor(
        private cfg: McpServerConfig,
        private name: string,
        private auth?: McpAuth,
    ) {
        super();
        this.ready = this.open();
        this.ready.catch(() => undefined);
    }

    private async open(): Promise<void> {
        // A deadline for opening the stream and hearing its endpoint, and only that: it's cleared once
        // the stream is up (the fetch's signal stays with the stream for as long as it's open).
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), sseTiming.connectMs);
        try {
            await this.connectStream(AbortSignal.any([this.life.signal, deadline.signal]), deadline.signal);
        } finally {
            clearTimeout(timer);
        }
    }

    private async connectStream(connectBy: AbortSignal, late: AbortSignal): Promise<void> {
        const seconds = Math.round(sseTiming.connectMs / 1000);
        let res: Response | undefined;
        for (let attempt = 0; ; attempt++) {
            try {
                res = await fetch(this.cfg.url!, { headers: { Accept: "text/event-stream", ...(await withAuth(this.cfg, this.auth, connectBy)) }, signal: connectBy });
            } catch (e) {
                const err = e instanceof McpError ? e : new McpError(this.life.signal.aborted ? "closed" : late.aborted ? `${this.name}: the SSE endpoint didn't answer within ${seconds}s` : `${this.name}: ${(e as Error).message}`, -1);
                this.fail(err);
                throw err;
            }
            if (res.status !== 401) break;
            const challenge = res.headers.get("www-authenticate") ?? "";
            await res.body?.cancel();
            if (attempt === 0 && this.auth && (await this.auth.unauthorized(challenge, connectBy).catch(() => false))) continue;
            const err = unauthorized(this.name, res, Boolean(this.auth));
            this.fail(err);
            throw err;
        }
        if (!res.ok || !res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
            await res.body?.cancel();
            const err = new McpError(`${this.name}: the SSE endpoint answered HTTP ${res.status}${res.ok ? " without an event stream" : ""}`, res.status);
            this.fail(err);
            throw err;
        }
        const events = parseSse(res.body, this.life.signal)[Symbol.asyncIterator]();
        let first: IteratorResult<{ event?: string; data: string }>;
        try {
            first = await Promise.race([
                events.next(),
                new Promise<never>((_, rej) => connectBy.addEventListener("abort", () => rej(new McpError(`${this.name}: no endpoint event from the SSE stream`, -1)), { once: true })),
            ]);
        } catch (e) {
            const err = e instanceof McpError ? e : new McpError(late.aborted && !this.life.signal.aborted ? `${this.name}: no endpoint event from the SSE stream` : `${this.name}: ${(e as Error).message}`, -1);
            this.fail(err);
            throw err;
        }
        if (first.done || first.value.event !== "endpoint") {
            const err = new McpError(`${this.name}: the SSE stream didn't start with an endpoint event`, -1);
            this.fail(err);
            throw err;
        }
        const endpoint = new URL(first.value.data.trim(), this.cfg.url);
        // Messages (and the headers with them) go only where the stream itself came from.
        if (endpoint.origin !== new URL(this.cfg.url!).origin) {
            const err = new McpError(`${this.name}: the SSE endpoint points to another origin (${endpoint.origin})`, -1);
            this.fail(err);
            throw err;
        }
        this.endpoint = endpoint.href;
        void (async () => {
            try {
                for (;;) {
                    const r = await events.next();
                    if (r.done) break;
                    if (r.value.event !== undefined && r.value.event !== "message") continue;
                    try {
                        this.handle(JSON.parse(r.value.data));
                    } catch {
                        // not JSON
                    }
                }
                this.fail(new McpError(`${this.name}: the SSE stream closed`, -1));
            } catch (e) {
                this.fail(new McpError(this.life.signal.aborted ? "closed" : `${this.name}: the SSE stream broke: ${(e as Error).message}`, -1));
            }
        })();
    }

    protected send(msg: Json) {
        if (this.dead || !this.endpoint) return;
        const url = this.endpoint;
        void (async () => {
            try {
                const post = async () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(await withAuth(this.cfg, this.auth, this.life.signal)) }, body: JSON.stringify(msg), signal: AbortSignal.any([this.life.signal, AbortSignal.timeout(30_000)]) });
                let res = await post();
                if (res.status === 401) {
                    // As over Streamable HTTP: a fresh token and one more try, else it needs signing in.
                    const challenge = res.headers.get("www-authenticate") ?? "";
                    // Read, not cancelled: a cancelled body can leave the kept-alive connection out of step.
                    await res.text().catch(() => "");
                    if (this.auth && (await this.auth.unauthorized(challenge, this.life.signal).catch(() => false))) res = await post();
                    if (res.status === 401) {
                        await res.text().catch(() => "");
                        if (msg.id !== undefined && msg.method !== undefined) this.rejectRequest(msg.id, unauthorized(this.name, res, Boolean(this.auth)));
                        return;
                    }
                }
                const text = await res.text().catch(() => "");
                if (!res.ok && msg.id !== undefined && msg.method !== undefined) this.handle({ jsonrpc: "2.0", id: msg.id, error: { code: res.status, message: `${this.name}: HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` } });
            } catch (e) {
                if (msg.id !== undefined && msg.method !== undefined && !this.life.signal.aborted) this.handle({ jsonrpc: "2.0", id: msg.id, error: { code: -1, message: `${this.name}: ${(e as Error).message}` } });
            }
        })();
    }

    async close() {
        this.life.abort();
        this.fail(new McpError("closed"));
    }
}

/** JSON-RPC over a WebSocket (subprotocol "mcp"), one message per text frame. */
class WsTransport extends MessageTransport {
    private ws?: WebSocket;

    constructor(
        private cfg: McpServerConfig,
        private name: string,
        private auth?: McpAuth,
    ) {
        super();
        this.ready = this.open();
        this.ready.catch(() => undefined);
    }

    private async open(): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            const failed = await this.connect(await withAuth(this.cfg, this.auth));
            if (!failed) return;
            if (this.dead) throw this.dead;
            // A WebSocket doesn't say why its upgrade was refused: ask the same URL over HTTP whether it wants a sign-in.
            const res = failed.refused ? await this.probe() : undefined;
            if (res?.status === 401) {
                const challenge = res.headers.get("www-authenticate") ?? "";
                if (attempt === 0 && this.auth && (await this.auth.unauthorized(challenge).catch(() => false))) continue;
                const err = unauthorized(this.name, res, Boolean(this.auth));
                this.fail(err);
                throw err;
            }
            this.fail(failed.error);
            throw failed.error;
        }
    }

    private async probe(): Promise<Response | undefined> {
        try {
            const res = await fetch(this.cfg.url!.replace(/^ws/i, "http"), { headers: await withAuth(this.cfg, this.auth), signal: AbortSignal.timeout(10_000) });
            await res.body?.cancel();
            return res;
        } catch {
            return undefined;
        }
    }

    /** Undefined once open; else why not (refused: the upgrade itself failed). */
    private connect(headers: Record<string, string>): Promise<{ error: McpError; refused: boolean } | undefined> {
        return new Promise((resolve) => {
            let ws: WebSocket;
            let opened = false;
            try {
                // Bun takes headers for the upgrade request; browsers would ignore them.
                ws = new WebSocket(this.cfg.url!, { protocols: ["mcp"], headers } as unknown as string[]);
            } catch (e) {
                return resolve({ error: new McpError(`${this.name}: ${(e as Error).message}`, -1), refused: false });
            }
            this.ws = ws;
            const timer = setTimeout(() => {
                resolve({ error: new McpError(`${this.name}: the WebSocket didn't open within 30s`, -1), refused: false });
                ws.close();
            }, 30_000);
            ws.onopen = () => {
                opened = true;
                clearTimeout(timer);
                resolve(undefined);
            };
            ws.onmessage = (ev) => {
                if (typeof ev.data !== "string") return;
                try {
                    this.handle(JSON.parse(ev.data));
                } catch {
                    // not JSON
                }
            };
            ws.onerror = () => {
                clearTimeout(timer);
                const error = new McpError(`${this.name}: the WebSocket connection failed`, -1);
                if (opened) this.fail(error);
                else resolve({ error, refused: true });
            };
            ws.onclose = (ev) => {
                clearTimeout(timer);
                const error = new McpError(`${this.name}: the WebSocket closed${ev.code && ev.code !== 1000 ? ` (${ev.code}${ev.reason ? `: ${ev.reason}` : ""})` : ""}`, -1);
                if (opened) this.fail(error);
                else resolve({ error, refused: true });
            };
        });
    }

    protected send(msg: Json) {
        if (this.dead || this.ws?.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify(msg));
    }

    async close() {
        this.fail(new McpError("closed"));
        try {
            this.ws?.close(1000);
        } catch {
            // ignore
        }
    }
}

// ---------------------------------------------------------------------------
// Client

export interface McpClientOptions {
    /** Credentials for a remote server (OAuth). */
    auth?: McpAuth;
    /**
     * Someone can answer forms and approve sampling here: legacy servers are
     * told so at initialize. (Modern ones learn it per request, from the
     * McpInput that request carries.)
     */
    interactive?: boolean;
}

export class McpClient {
    private t: Transport;
    /** Aborted by close(): every request this client makes ends with it, and none starts after. */
    private life = new AbortController();
    era: "modern" | "legacy" = "legacy";
    protocolVersion = MODERN_VERSION;
    serverInfo?: { name?: string; version?: string };
    instructions?: string;
    /** What the server says it offers (tools, resources, prompts…). */
    capabilities: Json = {};
    tools: McpTool[] = [];
    /** Tool name -> property -> header name, for x-mcp-header arguments. */
    private paramHeaders = new Map<string, Record<string, string>>();
    /** The inputs of open requests, latest last: a legacy stdio server's request goes to the latest. */
    private inputs: McpInput[] = [];
    private readonly projectCwd: string;
    onToolsChanged?: () => void;
    onResourcesChanged?: () => void;
    onPromptsChanged?: () => void;
    onExit?: () => void;

    /**
     * `cwd` is the project folder. `runCwd`, when given, is the folder a stdio
     * server runs in, resolved once by the caller; otherwise it's resolved here.
     */
    constructor(
        readonly name: string,
        private cfg: McpServerConfig,
        cwd: string,
        runCwd?: string,
        private opts: McpClientOptions = {},
    ) {
        this.projectCwd = cwd;
        const kind = transportOf(cfg);
        if ((kind === "http" || kind === "sse" || kind === "ws") && !cfg.url) throw new McpError(`MCP server "${name}" has type "${cfg.type}" but no "url"`);
        if (kind === "stdio" && !cfg.command) throw new McpError(`MCP server "${name}" has type "stdio" but no "command"`);
        if (kind === "http") this.t = new HttpTransport(cfg, name, opts.auth);
        else if (kind === "sse") this.t = new SseTransport(cfg, name, opts.auth);
        else if (kind === "ws") this.t = new WsTransport(cfg, name, opts.auth);
        else if (kind === "stdio") this.t = new StdioTransport(cfg, runCwd ?? serverCwd(cfg, cwd));
        else throw new McpError(`MCP server "${name}" needs a "command" or a "url"${cfg.type ? ` (unknown type "${String(cfg.type)}")` : ""}`);
        // Not after close(): a server closed on purpose didn't fail.
        this.t.onExit = () => {
            if (!this.life.signal.aborted) this.onExit?.();
        };
        this.t.onNotification = (method) => {
            if (method === "notifications/tools/list_changed") this.onToolsChanged?.();
            else if (method === "notifications/resources/list_changed") this.onResourcesChanged?.();
            else if (method === "notifications/prompts/list_changed") this.onPromptsChanged?.();
        };
        this.t.onRequest = (method, params, input, signal) => this.serve(method, params, input ?? this.inputs.at(-1), signal);
    }

    get isHttp(): boolean {
        return transportOf(this.cfg) === "http";
    }

    get transport(): "stdio" | "http" | "sse" | "ws" {
        return transportOf(this.cfg)!;
    }

    get closed(): boolean {
        return this.life.signal.aborted;
    }

    /** The caller's signal joined with this client's lifetime; throws once it's closed, so nothing more is sent. */
    private live(signal?: AbortSignal): AbortSignal {
        if (this.closed) throw new McpError(`MCP server "${this.name}" was closed`);
        return signal ? AbortSignal.any([signal, this.life.signal]) : this.life.signal;
    }

    stderrTail(): string {
        return this.t.stderrTail();
    }

    /** What this client can do for the server: answer forms and sampling only where someone can. */
    private clientCapabilities(input?: McpInput, declareAll = false): Json {
        return {
            roots: {},
            ...(declareAll || input?.elicit ? { elicitation: { form: {}, url: {} } } : {}),
            ...(declareAll || input?.sample ? { sampling: {} } : {}),
        };
    }

    private meta(input?: McpInput): Json {
        return {
            "io.modelcontextprotocol/protocolVersion": this.protocolVersion,
            "io.modelcontextprotocol/clientCapabilities": this.clientCapabilities(input),
            "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
        };
    }

    private params(p: Json = {}, input?: McpInput): Json {
        return this.era === "modern" ? { ...p, _meta: this.meta(input) } : p;
    }

    /** The project folder, for servers that ask which folders they may work in. */
    private roots(): Json {
        return { roots: [{ uri: pathToFileURL(this.projectCwd).href, name: this.projectCwd.split(/[\\/]/).filter(Boolean).at(-1) ?? this.projectCwd }] };
    }

    /** Answer one thing the server asked for (a legacy request, or one entry of an input_required result). */
    private async serve(method: string, params: Json, input: McpInput | undefined, signal: AbortSignal): Promise<Json> {
        switch (method) {
            case "ping":
                return {};
            case "roots/list":
                return this.roots();
            case "elicitation/create": {
                const mode = params.mode === "url" ? "url" : "form";
                if (mode === "url" && (typeof params.url !== "string" || !/^https?:\/\//i.test(params.url))) return { action: "decline" };
                if (!input?.elicit) return { action: "decline" };
                const r = await input.elicit({ mode, message: typeof params.message === "string" ? params.message : "", requestedSchema: params.requestedSchema, url: params.url }, signal);
                return r.action === "accept" && mode === "form" ? { action: "accept", content: r.content ?? {} } : { action: r.action };
            }
            case "sampling/createMessage": {
                if (!input?.sample) throw new McpError("Sampling isn't available here: nobody can approve it.", -1);
                if (!Array.isArray(params.messages)) throw new McpError("sampling/createMessage needs messages", -32602);
                return { ...(await input.sample(params as McpSamplingParams, signal)) };
            }
            default:
                throw new McpError(`Method not found: ${method}`, -32601);
        }
    }

    /**
     * A request that may come back asking for input first (MRTR): the
     * answers go in a retry, with a new id and the exact requestState, until
     * the result is complete.
     */
    private async call(method: string, params: Json, opts: { signal?: AbortSignal; timeoutMs: number; headers?: Record<string, string>; input?: McpInput }): Promise<Json> {
        const signal = this.live(opts.signal);
        if (opts.input) this.inputs.push(opts.input);
        try {
            let extra: Json = {};
            for (let round = 0; ; round++) {
                const r = await this.t.request(method, this.params({ ...params, ...extra }, opts.input), { signal, timeoutMs: opts.timeoutMs, headers: opts.headers, input: opts.input });
                const rt = r.resultType;
                if (rt === undefined || rt === "complete") return r;
                if (rt !== "input_required") throw new McpError(`invalid resultType "${rt}"`);
                if (round + 1 >= MAX_INPUT_ROUNDS) throw new McpError(`the server asked for input ${MAX_INPUT_ROUNDS} times without finishing`);
                const asked = r.inputRequests && typeof r.inputRequests === "object" && !Array.isArray(r.inputRequests) ? (r.inputRequests as Record<string, Json>) : undefined;
                if (!asked && typeof r.requestState !== "string") throw new McpError("the server asked for input without saying what");
                const answers: Json = {};
                for (const [key, req] of Object.entries(asked ?? {})) {
                    if (!req || typeof req.method !== "string") throw new McpError(`the server's input request "${key}" has no method`);
                    if (!["elicitation/create", "sampling/createMessage", "roots/list"].includes(req.method)) throw new McpError(`the server asked for "${req.method}", which isn't something a server may ask for`);
                    answers[key] = await this.serve(req.method, req.params ?? {}, opts.input, signal);
                    if (signal.aborted) throw new McpError("aborted");
                }
                extra = { ...(asked ? { inputResponses: answers } : {}), ...(typeof r.requestState === "string" ? { requestState: r.requestState } : {}) };
            }
        } finally {
            if (opts.input) this.inputs.splice(this.inputs.lastIndexOf(opts.input), 1);
        }
    }

    async connect(outer?: AbortSignal): Promise<void> {
        const signal = this.live(outer);
        this.t.era = "modern";
        let modern = false;
        try {
            const r = await this.t.request("server/discover", { _meta: this.meta() }, { signal, timeoutMs: 10_000, headers: { "Mcp-Method": "server/discover" } });
            if (Array.isArray(r.supportedVersions) || r.resultType || r.capabilities) {
                modern = true;
                const supported: string[] = r.supportedVersions ?? [MODERN_VERSION];
                if (!supported.includes(MODERN_VERSION)) {
                    // A modern server that doesn't speak our modern version.
                    const legacyOk = supported.find((v) => LEGACY_VERSIONS.includes(v));
                    if (!legacyOk) throw new McpError(`server supports protocol versions ${supported.join(", ")}; this client supports ${MODERN_VERSION}`);
                    modern = false;
                }
                this.instructions = r.instructions;
                this.serverInfo = r._meta?.["io.modelcontextprotocol/serverInfo"];
                this.capabilities = r.capabilities && typeof r.capabilities === "object" ? r.capabilities : {};
            }
        } catch (e) {
            // Closed (rejected, revoked) while discovering: no falling back to the legacy handshake.
            if (signal.aborted) throw this.closed ? new McpError(`MCP server "${this.name}" was closed`) : e;
            const err = e as McpError;
            if (err.code !== undefined && MODERN_ERRORS.has(err.code)) {
                const supported = (err.data as { supported?: string[] } | undefined)?.supported ?? [];
                if (err.code === -32022 && !supported.includes(MODERN_VERSION) && !supported.some((v) => LEGACY_VERSIONS.includes(v))) {
                    throw new McpError(`server supports protocol versions ${supported.join(", ") || "(none listed)"}, none of which this client speaks`);
                }
                modern = err.code !== -32022 || supported.includes(MODERN_VERSION);
            }
            if (err.code === 401) throw err;
            // A channel that's gone (an SSE stream that never opened, a refused socket) has nothing to fall back on.
            if ((this.t instanceof SseTransport || this.t instanceof WsTransport) && this.t.isDead) throw err;
        }

        this.live(outer);
        if (modern) {
            this.era = "modern";
            this.t.era = "modern";
            return;
        }

        // Legacy handshake.
        this.live(outer);
        this.era = "legacy";
        this.t.era = "legacy";
        this.capabilities = {};
        const init = await this.t.request(
            "initialize",
            { protocolVersion: LEGACY_VERSIONS[0], capabilities: this.clientCapabilities(undefined, this.opts.interactive), clientInfo: CLIENT_INFO },
            { signal, timeoutMs: 60_000 },
        );
        const v = String(init.protocolVersion ?? "");
        if (!LEGACY_VERSIONS.includes(v)) {
            await this.close();
            throw new McpError(`server answered with protocol version "${v}", which this client doesn't support`);
        }
        this.protocolVersion = v;
        if (this.t instanceof HttpTransport) this.t.legacyVersion = v;
        this.serverInfo = init.serverInfo;
        this.instructions = init.instructions;
        this.capabilities = init.capabilities && typeof init.capabilities === "object" ? init.capabilities : {};
        this.live(outer);
        await this.t.notify("notifications/initialized", undefined, signal);
        if (signal.aborted) {
            await this.close();
            throw new McpError("aborted");
        }
    }

    /** Every page of a list (bounded), as `key` holds it in each result. */
    private async listAllPages<T>(method: string, key: string, signal?: AbortSignal, keep: (item: any) => boolean = (x) => Boolean(x)): Promise<T[]> {
        const out: T[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
            const r = await this.t.request(method, this.params(cursor !== undefined ? { cursor } : {}), { signal: this.live(signal), timeoutMs: 30_000 });
            for (const item of Array.isArray(r[key]) ? r[key] : []) if (item && typeof item === "object" && keep(item)) out.push(item as T);
            if (typeof r.nextCursor !== "string" || r.nextCursor === cursor) break;
            cursor = r.nextCursor;
        }
        return out;
    }

    async listTools(signal?: AbortSignal): Promise<McpTool[]> {
        const out = await this.listAllPages<McpTool>("tools/list", "tools", signal, (tool) => {
            if (typeof tool.name !== "string" || !tool.name) return false;
            if (this.isHttp && this.era === "modern") {
                const hdrs = headerParams(tool);
                if (hdrs === null) return false; // invalid x-mcp-header: must be dropped
                this.paramHeaders.set(tool.name, hdrs);
            }
            return true;
        });
        this.tools = out;
        return out;
    }

    /** Whether the server offers `what` (it said so, or, for a legacy server that lists no capabilities at all, it may). */
    offers(what: "tools" | "resources" | "prompts"): boolean {
        return Boolean(this.capabilities?.[what]);
    }

    async listResources(signal?: AbortSignal): Promise<McpResource[]> {
        return this.listAllPages<McpResource>("resources/list", "resources", signal, (r) => typeof r.uri === "string" && r.uri !== "");
    }

    async listResourceTemplates(signal?: AbortSignal): Promise<McpResourceTemplate[]> {
        return this.listAllPages<McpResourceTemplate>("resources/templates/list", "resourceTemplates", signal, (r) => typeof r.uriTemplate === "string" && r.uriTemplate !== "");
    }

    async readResource(uri: string, opts: { signal?: AbortSignal; input?: McpInput; timeoutMs?: number } = {}): Promise<McpResourceContents[]> {
        const r = await this.call("resources/read", { uri }, { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 60_000, input: opts.input, headers: this.isHttp && this.era === "modern" ? { "Mcp-Name": headerValue(uri) } : undefined });
        return (Array.isArray(r.contents) ? r.contents : []).filter((c: any) => c && typeof c === "object" && typeof c.uri === "string");
    }

    async listPrompts(signal?: AbortSignal): Promise<McpPrompt[]> {
        return this.listAllPages<McpPrompt>("prompts/list", "prompts", signal, (p) => typeof p.name === "string" && p.name !== "");
    }

    async getPrompt(name: string, args: Record<string, string>, opts: { signal?: AbortSignal; input?: McpInput } = {}): Promise<{ description?: string; messages: McpPromptMessage[] }> {
        const r = await this.call("prompts/get", { name, arguments: args }, { signal: opts.signal, timeoutMs: 60_000, input: opts.input, headers: this.isHttp && this.era === "modern" ? { "Mcp-Name": headerValue(name) } : undefined });
        const messages = (Array.isArray(r.messages) ? r.messages : []).filter((m: any) => m && (m.role === "user" || m.role === "assistant") && m.content && typeof m.content === "object");
        return { description: typeof r.description === "string" ? r.description : undefined, messages };
    }

    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 10 * 60_000, input?: McpInput): Promise<McpCallResult> {
        const headers: Record<string, string> = {};
        if (this.isHttp && this.era === "modern") {
            headers["Mcp-Name"] = headerValue(name);
            for (const [prop, header] of Object.entries(this.paramHeaders.get(name) ?? {})) {
                const v = args[prop];
                if (v === undefined || v === null) continue;
                headers[`Mcp-Param-${header}`] = headerValue(typeof v === "string" ? v : String(v));
            }
        }
        const r = await this.call("tools/call", { name, arguments: args }, { signal, timeoutMs, headers, input });
        return { content: Array.isArray(r.content) ? r.content : [], structuredContent: r.structuredContent, isError: Boolean(r.isError) };
    }

    async close() {
        this.life.abort();
        await this.t.close().catch(() => {});
    }
}

/** Map of argument -> header name; null if any annotation is invalid. */
function headerParams(tool: McpTool): Record<string, string> | null {
    const props = (tool.inputSchema?.properties ?? {}) as Record<string, Json>;
    const out: Record<string, string> = {};
    for (const [prop, schema] of Object.entries(props)) {
        const h = schema?.["x-mcp-header"];
        if (h === undefined) continue;
        if (typeof h !== "string" || !/^[A-Za-z0-9-]+$/.test(h)) return null;
        const ty = schema.type;
        if (ty !== undefined && !["string", "integer", "number", "boolean"].includes(ty)) return null;
        out[prop] = h;
    }
    return out;
}
