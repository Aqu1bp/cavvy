// One language server process: starts it, keeps documents in sync (whole
// text on every change, which every server accepts) and passes on the
// diagnostics it publishes. The harness only asks for diagnostics, so it
// claims little and answers the server's own requests with the minimum.

import { pathToFileURL } from "url";
import { childEnv } from "../util/env";
import { encodeMessage, MessageReader, type RpcMessage } from "./protocol";
import type { LspServer } from "./config";

export interface LspPosition {
    line: number;
    character: number;
}

export interface LspDiagnostic {
    range: { start: LspPosition; end: LspPosition };
    /** 1 error, 2 warning, 3 information, 4 hint. */
    severity?: number;
    code?: string | number;
    source?: string;
    message: string;
}

export interface PublishedDiagnostics {
    uri: string;
    version?: number;
    diagnostics: LspDiagnostic[];
}

export interface ClientOptions {
    server: LspServer;
    /** The resolved executable. */
    executable: string;
    root: string;
    onDiagnostics: (d: PublishedDiagnostics) => void;
    /** It exited without being asked to (crash, or killed). */
    onExit: (code: number | null, stderr: string) => void;
}

interface Pending {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export const fileUri = (path: string) => pathToFileURL(path).href;

/** Every server still running, killed if the harness exits without stopping them. */
const live = new Set<{ kill: (sig?: number | NodeJS.Signals) => void }>();
let exitHook = false;
function track(proc: { kill: (sig?: number | NodeJS.Signals) => void; exited: Promise<number> }) {
    live.add(proc);
    void proc.exited.then(() => live.delete(proc));
    if (exitHook) return;
    exitHook = true;
    process.once("exit", () => {
        for (const p of live) {
            try {
                p.kill("SIGKILL");
            } catch {
                // gone
            }
        }
    });
}

export class LspClient {
    private proc?: ReturnType<typeof Bun.spawn>;
    private reader: MessageReader;
    private nextId = 1;
    private pending = new Map<number, Pending>();
    private stopping = false;
    private exited = false;
    /** The last of its stderr, for saying why it stopped. */
    private stderrTail = "";
    /** Open documents by uri: the version sent last, and the file's mtime when it was read (to see it change elsewhere). */
    readonly docs = new Map<string, { path: string; version: number; languageId: string; mtimeMs?: number; sentAt: number }>();
    /** What it said it can do, once initialized. */
    capabilities: ServerCapabilities = {};

    constructor(private o: ClientOptions) {
        this.reader = new MessageReader((m) => this.onMessage(m));
    }

    get pid(): number | undefined {
        return this.proc?.pid;
    }

    get alive(): boolean {
        return !!this.proc && !this.exited;
    }

    /** Spawn and initialize; rejects if it fails to start or doesn't answer in time. */
    async start(): Promise<void> {
        const { server, root } = this.o;
        this.proc = Bun.spawn([this.o.executable, ...(server.args ?? [])], {
            cwd: root,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: childEnv(server.env),
        });
        track(this.proc);
        void this.readStdout();
        void this.readStderr();
        void this.proc.exited.then((code) => {
            this.exited = true;
            this.failPending(new Error(`${server.name} exited${code === null ? "" : ` with code ${code}`}`));
            if (!this.stopping) this.o.onExit(code, this.stderrTail.trim());
        });
        const uri = fileUri(root);
        const init = await this.request(
            "initialize",
            {
                processId: process.pid,
                clientInfo: { name: "harness" },
                rootUri: uri,
                rootPath: root,
                workspaceFolders: [{ uri, name: root.split("/").pop() || root }],
                initializationOptions: server.initializationOptions,
                capabilities: {
                    general: { positionEncodings: ["utf-16"] },
                    textDocument: {
                        synchronization: { dynamicRegistration: false, didSave: true, willSave: false, willSaveWaitUntil: false },
                        publishDiagnostics: { relatedInformation: false, versionSupport: true, tagSupport: { valueSet: [1, 2] }, codeDescriptionSupport: false, dataSupport: false },
                        diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
                    },
                    workspace: { configuration: true, workspaceFolders: true, didChangeConfiguration: { dynamicRegistration: false } },
                    window: { workDoneProgress: true },
                },
            },
            server.startupTimeout ?? 15_000,
        );
        this.capabilities = ((init as { capabilities?: ServerCapabilities } | null)?.capabilities ?? {}) as ServerCapabilities;
        this.notify("initialized", {});
        if (server.settings) this.notify("workspace/didChangeConfiguration", { settings: server.settings });
    }

    /** Send a file's whole new text: opens it the first time, changes it after, then saves it (some servers check on save). */
    sync(path: string, languageId: string, text: string, mtimeMs?: number): number {
        const uri = fileUri(path);
        const doc = this.docs.get(uri);
        const version = (doc?.version ?? 0) + 1;
        if (!doc || doc.languageId !== languageId) {
            if (doc) this.notify("textDocument/didClose", { textDocument: { uri } });
            this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version, text } });
        } else {
            this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
        }
        this.docs.set(uri, { path, version, languageId, mtimeMs, sentAt: performance.now() });
        this.notify("textDocument/didSave", { textDocument: { uri } });
        return version;
    }

    /** Stop tracking a document (its file is gone). */
    close(path: string) {
        const uri = fileUri(path);
        if (!this.docs.delete(uri)) return;
        this.notify("textDocument/didClose", { textDocument: { uri } });
    }

    /**
     * How to ask for a file's diagnostics instead of waiting for them:
     * "lsp" (textDocument/diagnostic, LSP 3.17), "tsserver" (TypeScript's
     * own synchronous checks, through typescript-language-server, which only
     * pushes, after a debounce of 300 ms or more), or none.
     */
    get pull(): "lsp" | "tsserver" | undefined {
        if (this.capabilities.executeCommandProvider?.commands?.includes(TSSERVER_REQUEST)) return "tsserver";
        return this.capabilities.diagnosticProvider ? "lsp" : undefined;
    }

    /** A file's diagnostics now (it must be open), or undefined if the server can't say. */
    async pullDiagnostics(path: string, timeoutMs: number): Promise<LspDiagnostic[] | undefined> {
        const how = this.pull;
        if (how === "tsserver") {
            const ask = (command: string) => this.request("workspace/executeCommand", { command: TSSERVER_REQUEST, arguments: [command, { file: path, includeLinePosition: true }] }, timeoutMs) as Promise<{ body?: TsDiagnostic[] } | undefined>;
            const [syntax, semantic] = await Promise.all([ask("syntacticDiagnosticsSync"), ask("semanticDiagnosticsSync")]);
            if (!Array.isArray(syntax?.body) || !Array.isArray(semantic?.body)) return undefined;
            return [...syntax.body, ...semantic.body].map(fromTsserver);
        }
        if (how === "lsp") {
            const r = (await this.request("textDocument/diagnostic", { textDocument: { uri: fileUri(path) } }, timeoutMs)) as { kind?: string; items?: LspDiagnostic[] } | null;
            return r?.kind === "full" && Array.isArray(r.items) ? r.items : undefined;
        }
        return undefined;
    }

    /** Ask it to shut down, then make sure it has (stdio closed, killed after a grace period). */
    async stop(graceMs = 1000): Promise<void> {
        if (!this.proc || this.stopping) return;
        this.stopping = true;
        if (!this.exited) {
            await this.request("shutdown", null, graceMs).catch(() => {});
            this.notify("exit", null);
            try {
                (this.proc.stdin as import("bun").FileSink).end();
            } catch {
                // already closed
            }
        }
        const done = await Promise.race([this.proc.exited.then(() => true), Bun.sleep(graceMs).then(() => false)]);
        if (!done) this.proc.kill("SIGKILL");
        this.failPending(new Error("stopped"));
    }

    request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
        if (this.exited) return Promise.reject(new Error(`${this.o.server.name} isn't running`));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${this.o.server.name} didn't answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.write({ jsonrpc: "2.0", id, method, params });
        });
    }

    notify(method: string, params: unknown) {
        this.write({ jsonrpc: "2.0", method, params });
    }

    private write(msg: RpcMessage) {
        if (!this.proc || this.exited) return;
        try {
            const sink = this.proc.stdin as import("bun").FileSink;
            sink.write(encodeMessage(msg));
            sink.flush();
        } catch {
            // The process is going away; its exit handler reports it.
        }
    }

    private failPending(e: Error) {
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(e);
        }
        this.pending.clear();
    }

    private async readStdout() {
        const stream = this.proc!.stdout as ReadableStream<Uint8Array>;
        try {
            for await (const chunk of stream) this.reader.push(chunk);
        } catch {
            // closed
        }
    }

    /** Drained so a chatty server never blocks on a full pipe; the tail says why one died. */
    private async readStderr() {
        const stream = this.proc!.stderr as ReadableStream<Uint8Array>;
        const dec = new TextDecoder();
        try {
            for await (const chunk of stream) this.stderrTail = (this.stderrTail + dec.decode(chunk, { stream: true })).slice(-2000);
        } catch {
            // closed
        }
    }

    private onMessage(m: RpcMessage) {
        if (m.method && m.id !== undefined && m.id !== null) return this.answer(m);
        if (m.method) {
            if (m.method === "textDocument/publishDiagnostics") {
                const p = m.params as PublishedDiagnostics | undefined;
                if (p && typeof p.uri === "string" && Array.isArray(p.diagnostics)) this.o.onDiagnostics(p);
            }
            return;
        }
        if (typeof m.id !== "number") return;
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
        else p.resolve(m.result);
    }

    /** The server's requests of the client. */
    private answer(m: RpcMessage) {
        const reply = (result: unknown) => this.write({ jsonrpc: "2.0", id: m.id, result });
        switch (m.method) {
            case "workspace/configuration": {
                const items = (m.params as { items?: { section?: string }[] } | undefined)?.items ?? [];
                return reply(items.map((it) => section(this.o.server.settings, it.section)));
            }
            case "workspace/workspaceFolders":
                return reply([{ uri: fileUri(this.o.root), name: this.o.root.split("/").pop() || this.o.root }]);
            case "client/registerCapability":
            case "client/unregisterCapability":
            case "window/workDoneProgress/create":
            case "window/showMessageRequest":
            case "workspace/diagnostic/refresh":
            case "workspace/semanticTokens/refresh":
            case "workspace/inlayHint/refresh":
            case "workspace/codeLens/refresh":
                return reply(null);
            default:
                return this.write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Unhandled method ${m.method}` } });
        }
    }
}

export interface ServerCapabilities {
    diagnosticProvider?: unknown;
    executeCommandProvider?: { commands?: string[] };
}

const TSSERVER_REQUEST = "typescript.tsserverRequest";

interface TsDiagnostic {
    message: string;
    category: string;
    code?: number;
    source?: string;
    startLocation: { line: number; offset: number };
    endLocation: { line: number; offset: number };
}

const TS_SEVERITY: Record<string, number> = { error: 1, warning: 2, message: 3, suggestion: 4 };

/** tsserver's diagnostic (1-based line and offset) as LSP's. */
function fromTsserver(d: TsDiagnostic): LspDiagnostic {
    return {
        range: { start: { line: d.startLocation.line - 1, character: d.startLocation.offset - 1 }, end: { line: d.endLocation.line - 1, character: d.endLocation.offset - 1 } },
        severity: TS_SEVERITY[d.category] ?? 1,
        ...(d.code !== undefined ? { code: d.code } : {}),
        source: d.source ?? "typescript",
        message: d.message,
    };
}

/** `settings` at a dotted section ("python.analysis"), or null. */
function section(settings: Record<string, unknown> | undefined, name: string | undefined): unknown {
    if (!settings) return null;
    if (!name) return settings;
    if (name in settings) return settings[name];
    let v: unknown = settings;
    for (const part of name.split(".")) {
        if (!v || typeof v !== "object" || !(part in v)) return null;
        v = (v as Record<string, unknown>)[part];
    }
    return v;
}
