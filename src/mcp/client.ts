// Minimal dual-era MCP client (tools only).
//
// Modern servers (protocol 2026-07-28) are stateless: every request carries
// the protocol version and client capabilities in params._meta, and there is
// no initialize handshake. Legacy servers (2025-11-25 and earlier) need
// initialize + notifications/initialized. Per the spec's dual-era guidance we
// probe with server/discover and fall back to initialize on any other error
// or a timeout.

import { spawn, type ChildProcess } from "node:child_process";
import { parseSse } from "../providers/sse";
import { APP_NAME, APP_VERSION } from "../config/paths";
import type { McpServerConfig } from "../config/settings";
import { childEnv } from "../tools/bash";

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MODERN_ERRORS = new Set([-32020, -32021, -32022]);

export interface McpTool {
    name: string;
    title?: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export type McpContent =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: "audio"; data: string; mimeType: string }
    | { type: "resource_link"; uri: string; name: string; title?: string; description?: string; mimeType?: string }
    | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

export interface McpCallResult {
    content: McpContent[];
    structuredContent?: unknown;
    isError?: boolean;
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

type Json = Record<string, any>;

const CLIENT_INFO = { name: APP_NAME, version: APP_VERSION };

// ---------------------------------------------------------------------------
// Transports

interface Transport {
    /** Send a request and wait for its response (result or error). */
    request(method: string, params: Json, opts: { signal?: AbortSignal; timeoutMs?: number; headers?: Record<string, string> }): Promise<Json>;
    notify(method: string, params?: Json, signal?: AbortSignal): Promise<void>;
    close(): Promise<void>;
    onNotification?: (method: string, params: Json) => void;
    /** Legacy servers may send requests (ping). */
    era: "modern" | "legacy" | "unknown";
    stderrTail(): string;
}

class StdioTransport implements Transport {
    private proc: ChildProcess;
    private nextId = 1;
    private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
    private buf = "";
    private stderr = "";
    private exited = false;
    era: "modern" | "legacy" | "unknown" = "unknown";
    onNotification?: (method: string, params: Json) => void;
    onExit?: () => void;

    constructor(cfg: McpServerConfig, cwd: string) {
        this.proc = spawn(cfg.command!, cfg.args ?? [], {
            cwd: cfg.cwd ?? cwd,
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
            this.onExit?.();
        });
        this.proc.on("exit", (code, sig) => {
            this.exited = true;
            this.fail(new McpError(`server exited (${sig ?? code})`));
            this.onExit?.();
        });
        this.proc.stdin!.on("error", () => {});
    }

    stderrTail(): string {
        return this.stderr.trim().split("\n").slice(-5).join("\n");
    }

    private fail(e: Error) {
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
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

    private handle(msg: Json) {
        if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined)) {
            const p = this.pending.get(Number(msg.id));
            if (!p) return;
            this.pending.delete(Number(msg.id));
            if (msg.error) p.reject(new McpError(msg.error.message ?? "error", msg.error.code, msg.error.data));
            else p.resolve(msg.result ?? {});
            return;
        }
        if (typeof msg.method === "string") {
            if (msg.id !== undefined && msg.id !== null) {
                // A legacy server request. We declare no client capabilities, so only ping is expected.
                if (this.era === "modern") return;
                if (msg.method === "ping") this.write({ jsonrpc: "2.0", id: msg.id, result: {} });
                else this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
                return;
            }
            this.onNotification?.(msg.method, msg.params ?? {});
        }
    }

    private write(msg: Json) {
        if (this.exited) return;
        // JSON.stringify never emits raw newlines, satisfying the framing rule.
        this.proc.stdin!.write(JSON.stringify(msg) + "\n");
    }

    request(method: string, params: Json, opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<Json> {
        if (this.exited) return Promise.reject(new McpError("server is not running"));
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
                this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Cancelled by user" } });
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
                    if (method !== "initialize") this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Timed out" } });
                    reject(new McpError(`${method} timed out after ${Math.round(opts.timeoutMs! / 1000)}s`, -1));
                }, opts.timeoutMs);
            }
            opts.signal?.addEventListener("abort", onAbort, { once: true });
            this.write({ jsonrpc: "2.0", id, method, params });
        });
    }

    async notify(method: string, params?: Json) {
        this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
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

class HttpTransport implements Transport {
    private nextId = 1;
    private sessionId?: string;
    era: "modern" | "legacy" | "unknown" = "unknown";
    legacyVersion?: string;
    onNotification?: (method: string, params: Json) => void;

    constructor(
        private cfg: McpServerConfig,
        private name: string,
    ) {}

    stderrTail(): string {
        return "";
    }

    private baseHeaders(method: string, extra?: Record<string, string>): Record<string, string> {
        const h: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(this.cfg.headers ?? {}),
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

    async request(method: string, params: Json, opts: { signal?: AbortSignal; timeoutMs?: number; headers?: Record<string, string> }): Promise<Json> {
        const id = this.nextId++;
        const signals = [opts.signal, opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined].filter(Boolean) as AbortSignal[];
        const signal = signals.length ? AbortSignal.any(signals) : undefined;
        let res: Response;
        try {
            res = await fetch(this.cfg.url!, {
                method: "POST",
                headers: this.baseHeaders(method, opts.headers),
                body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
                signal,
            });
        } catch (e) {
            if (opts.signal?.aborted) throw new McpError("aborted");
            throw new McpError(`${this.name}: ${(e as Error).message}`, -1);
        }
        const sid = res.headers.get("mcp-session-id");
        if (sid && method === "initialize") this.sessionId = sid;
        if (res.status === 401) {
            const auth = res.headers.get("www-authenticate") ?? "";
            await res.body?.cancel();
            throw new McpError(`${this.name} requires authorization${/bearer/i.test(auth) ? " (OAuth)" : ""}. Add an Authorization header to this server's "headers" in settings.`, 401);
        }
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
                    // legacy server request on the stream: answer ping, refuse the rest
                    void this.postRaw(msg.method === "ping" ? { jsonrpc: "2.0", id: msg.id, result: {} } : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
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

    // Fire-and-forget messages still get a deadline: a server that never
    // answers must not stall connecting (initialized) or quitting (DELETE).
    private async postRaw(body: Json, signal?: AbortSignal) {
        const deadline = AbortSignal.timeout(10_000);
        try {
            const r = await fetch(this.cfg.url!, { method: "POST", headers: this.baseHeaders(String(body.method ?? "")), body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
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
                const r = await fetch(this.cfg.url!, { method: "DELETE", headers: this.baseHeaders(""), signal: AbortSignal.timeout(3_000) });
                await r.body?.cancel();
            } catch {
                // ignore
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Client

export class McpClient {
    private t: Transport;
    era: "modern" | "legacy" = "legacy";
    protocolVersion = MODERN_VERSION;
    serverInfo?: { name?: string; version?: string };
    instructions?: string;
    tools: McpTool[] = [];
    /** Tool name -> property -> header name, for x-mcp-header arguments. */
    private paramHeaders = new Map<string, Record<string, string>>();
    onToolsChanged?: () => void;
    onExit?: () => void;

    constructor(
        readonly name: string,
        private cfg: McpServerConfig,
        cwd: string,
    ) {
        if (cfg.url) this.t = new HttpTransport(cfg, name);
        else if (cfg.command) {
            const st = new StdioTransport(cfg, cwd);
            st.onExit = () => this.onExit?.();
            this.t = st;
        } else throw new McpError(`MCP server "${name}" needs a "command" or a "url"`);
        this.t.onNotification = (method) => {
            if (method === "notifications/tools/list_changed") this.onToolsChanged?.();
        };
    }

    get isHttp(): boolean {
        return Boolean(this.cfg.url);
    }

    stderrTail(): string {
        return this.t.stderrTail();
    }

    private meta(): Json {
        return {
            "io.modelcontextprotocol/protocolVersion": this.protocolVersion,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
        };
    }

    private params(p: Json = {}): Json {
        return this.era === "modern" ? { ...p, _meta: this.meta() } : p;
    }

    async connect(signal?: AbortSignal): Promise<void> {
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
            }
        } catch (e) {
            if (signal?.aborted) throw e;
            const err = e as McpError;
            if (err.code !== undefined && MODERN_ERRORS.has(err.code)) {
                const supported = (err.data as { supported?: string[] } | undefined)?.supported ?? [];
                if (err.code === -32022 && !supported.includes(MODERN_VERSION) && !supported.some((v) => LEGACY_VERSIONS.includes(v))) {
                    throw new McpError(`server supports protocol versions ${supported.join(", ") || "(none listed)"}, none of which this client speaks`);
                }
                modern = err.code !== -32022 || supported.includes(MODERN_VERSION);
            }
            if (err.code === 401) throw err;
        }

        if (modern) {
            this.era = "modern";
            this.t.era = "modern";
            return;
        }

        // Legacy handshake.
        this.era = "legacy";
        this.t.era = "legacy";
        const init = await this.t.request(
            "initialize",
            { protocolVersion: LEGACY_VERSIONS[0], capabilities: {}, clientInfo: CLIENT_INFO },
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
        await this.t.notify("notifications/initialized", undefined, signal);
        if (signal?.aborted) {
            await this.close();
            throw new McpError("aborted");
        }
    }

    async listTools(signal?: AbortSignal): Promise<McpTool[]> {
        const out: McpTool[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 50; page++) {
            const r = await this.t.request("tools/list", this.params(cursor !== undefined ? { cursor } : {}), { signal, timeoutMs: 30_000 });
            for (const tool of (r.tools ?? []) as McpTool[]) {
                if (!tool?.name) continue;
                if (this.isHttp && this.era === "modern") {
                    const hdrs = headerParams(tool);
                    if (hdrs === null) continue; // invalid x-mcp-header: must be dropped
                    this.paramHeaders.set(tool.name, hdrs);
                }
                out.push(tool);
            }
            if (typeof r.nextCursor !== "string") break;
            cursor = r.nextCursor;
        }
        this.tools = out;
        return out;
    }

    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 10 * 60_000): Promise<McpCallResult> {
        const headers: Record<string, string> = {};
        if (this.isHttp && this.era === "modern") {
            headers["Mcp-Name"] = headerValue(name);
            for (const [prop, header] of Object.entries(this.paramHeaders.get(name) ?? {})) {
                const v = args[prop];
                if (v === undefined || v === null) continue;
                headers[`Mcp-Param-${header}`] = headerValue(typeof v === "string" ? v : String(v));
            }
        }
        const r = await this.t.request("tools/call", this.params({ name, arguments: args }), { signal, timeoutMs, headers });
        const rt = r.resultType;
        if (rt !== undefined && rt !== "complete") {
            if (rt === "input_required") throw new McpError("the server asked for extra input (sampling/elicitation), which this client doesn't support");
            throw new McpError(`invalid resultType "${rt}"`);
        }
        return { content: Array.isArray(r.content) ? r.content : [], structuredContent: r.structuredContent, isError: Boolean(r.isError) };
    }

    async close() {
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
