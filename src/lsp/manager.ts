// The language servers of a project, started on the first edit of a file one
// handles. One pool per project folder serves every session open in it (a
// TypeScript server alone takes a few hundred MB); each session has its own
// LspManager, which remembers what it has told its model. After an edit the
// file's new text goes to its server and the edit waits a bounded time for
// the diagnostics; what comes later is picked up with the next tool results.

import { readFileSync, statSync } from "fs";
import { extname } from "path";
import { fileURLToPath } from "url";
import { canonical, displayPath, isInside } from "../util/files";
import type { Settings } from "../config/settings";
import { fileUri, LspClient, type LspDiagnostic } from "./client";
import { lspEnabled, lspServers, resolveCommand, serverFor, type LspServer, type LspServerConfig } from "./config";
import { buildReport, compare, type DiagnosticReport, type FileReport } from "./diagnostics";

type Notice = (level: "info" | "warn", message: string) => void;

export interface LspTiming {
    /** How long an edit waits for diagnostics once its server is up (default 3s). */
    warmTimeoutMs?: number;
    /** ...and when the edit has to start it first (default 12s). */
    coldTimeoutMs?: number;
    /** After the first diagnostics, how long to wait for more (servers publish in stages). */
    settleMs?: number;
    /** A server with no edits for this long is stopped (default 10 minutes). */
    idleMs?: number;
    /** Crashes before a server is left off (default 3). */
    maxCrashes?: number;
}

export interface LspManagerOptions extends LspTiming {
    root: string;
    settings: () => Settings;
    /** Whether the user trusted the folder themselves: no server runs otherwise (they run the project's code). */
    trusted?: () => boolean;
    /** Something the user should know (a server that's missing, or keeps crashing). */
    notice?: Notice;
}

interface Running {
    server: LspServer;
    client: LspClient;
    /** Resolves true once initialized, false if it failed to start. */
    ready: Promise<boolean>;
    up?: boolean;
    /** How long it usually takes to publish after a change (ms, a moving average). */
    latency?: number;
    idle?: ReturnType<typeof setTimeout>;
    /** The latest request for each file's diagnostics, so an older answer can't overwrite a newer one. */
    pulling: Map<string, number>;
    /** Asking for diagnostics failed once: waits for pushes from then on. */
    pushOnly?: boolean;
    /** While asking works: what it pushed, by file. */
    pushed: Map<string, Published>;
    /** Requests for diagnostics that failed in a row. */
    pullFailures: number;
    /** Edits being checked now: it isn't idle while there are any. */
    checking: number;
}

interface Published {
    seq: number;
    version?: number;
    diagnostics: LspDiagnostic[];
    /** When it came (performance.now()). */
    at?: number;
}

/** The edit tools whose results get the file's diagnostics. */
export const DIAGNOSED_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);

/** Files above this aren't sent to a server: generated or vendored, and slow to check. */
export const MAX_FILE_CHARS = 2 * 1024 * 1024;

/** A server that wasn't installed is looked for again after this long. */
const MISSING_RECHECK_MS = 30_000;

/** Other files asked about again after an edit (where the server answers on request). */
const MAX_RECHECKED = 5;

/** The shortest wait for a server that may stay silent. */
const QUIET_MIN_MS = 600;

const METHOD_NOT_FOUND = -32601;
const CANCELLED = -32800;
const SERVER_CANCELLED = -32802;

/** Not text a language server should be sent (a NUL byte: an image or a build output named like code). */
function isBinary(text: string): boolean {
    return text.includes("\0");
}

function mtimeOf(path: string): number | undefined {
    try {
        return statSync(path).mtimeMs;
    } catch {
        return undefined;
    }
}

/** Whether a running server was started the way `b` says to start it. */
function sameLaunch(a: LspServerConfig, b: LspServerConfig): boolean {
    const launch = (c: LspServerConfig) => JSON.stringify([c.command, c.args, c.env, c.extensionToLanguage, c.initializationOptions, c.settings]);
    return launch(a) === launch(b);
}

/** The servers of one project folder and what they last published. */
export class LspPool {
    private running = new Map<string, Running>();
    private crashes = new Map<string, number>();
    /** Servers left off: crashed too often. */
    private off = new Set<string>();
    private resolved = new Map<string, { exe: string | null; at: number }>();
    readonly published = new Map<string, Published>();
    private seq = 0;
    private waiters = new Set<() => void>();
    /** The sessions using it, for crash notices. */
    readonly listeners = new Set<Notice>();
    refs = 0;
    disposed = false;

    constructor(
        readonly root: string,
        readonly timing: LspTiming = {},
    ) {}

    status(): { name: string; command: string; pid?: number; files: number }[] {
        return [...this.running.values()].map((r) => ({ name: r.server.name, command: r.server.command, pid: r.client.pid, files: r.client.docs.size }));
    }

    /** "ok", "missing" (not installed: looked for again after a while, in case it's installed meanwhile) or "off" (crashed too often). */
    available(s: LspServer, trusted: boolean): "ok" | "missing" | "off" {
        if (this.off.has(s.name)) return "off";
        const key = `${s.name}\u0000${s.command}\u0000${trusted}`;
        let found = this.resolved.get(key);
        if (!found || (!found.exe && Date.now() - found.at > MISSING_RECHECK_MS)) {
            found = { exe: resolveCommand(s.command, this.root, trusted, s.env) ?? null, at: Date.now() };
            this.resolved.set(key, found);
        }
        return found.exe ? "ok" : "missing";
    }

    /**
     * Send the file's text and get its diagnostics: true once fresh ones are
     * in. `others` are more files whose diagnostics may have changed with it
     * (ones the session edited before), asked for too where the server
     * answers on request.
     */
    async check(server: LspServer, trusted: boolean, languageId: string, path: string, text: string, signal?: AbortSignal, others: string[] = []): Promise<boolean> {
        const t = this.timing;
        const cold = !this.running.get(server.name)?.up;
        const deadline = Date.now() + (cold ? (t.coldTimeoutMs ?? 12_000) : (t.warmTimeoutMs ?? 3_000));
        const r = this.start(server, trusted);
        if (!r) return false;
        r.checking++;
        if (r.idle) clearTimeout(r.idle);
        try {
            return await this.checkOn(r, languageId, path, text, deadline, signal, others);
        } finally {
            // Idle from when the check ends, so a slow start or a long wait isn't counted.
            if (--r.checking === 0 && this.running.get(server.name) === r) this.touch(r);
        }
    }

    private async checkOn(r: Running, languageId: string, path: string, text: string, deadline: number, signal: AbortSignal | undefined, others: string[]): Promise<boolean> {
        const t = this.timing;
        const uri = fileUri(path);
        const before = this.seq;
        // Chained on start-up, so an edit that stops waiting still reaches the server, in order, and its diagnostics come later.
        let version: number | undefined;
        let settled = false;
        let waiting = true;
        const synced = r.ready.then((ok) => {
            if (ok && r.client.alive && !this.disposed) {
                this.refresh(r, path);
                // A restarted server hasn't seen the files edited before: open them, so they're checked again too.
                for (const o of others) if (o !== path && !r.client.docs.has(fileUri(o))) this.reopen(r, o);
                version = r.client.sync(path, languageId, text, mtimeOf(path));
                // Started after the edit stopped waiting: ask all the same (about the files edited before too), and the answers are reported later.
                if (!waiting && this.pulls(r)) for (const p of [path, ...others.filter((o) => o !== path && r.client.docs.has(fileUri(o)))]) void this.pullNow(r, p, Date.now());
            }
            settled = true;
        });
        await this.until(() => settled, deadline, signal, synced);
        waiting = false;
        if (version === undefined || signal?.aborted) return false;
        if (this.pulls(r)) {
            let failed = false;
            const pulled = this.pullNow(r, path, deadline).then((got) => (failed = !got));
            let rest = false;
            const rechecked = Promise.all(others.filter((o) => o !== path && r.client.docs.has(fileUri(o))).map((o) => this.pullNow(r, o, deadline))).then(() => (rest = true));
            const ok = await this.until(() => this.isFresh(uri, before, version!) || !r.client.alive || failed, deadline, signal, pulled);
            // The others are asked at the same time; their answers usually come right after.
            if (ok && !failed) await this.until(() => rest || !r.client.alive, deadline, signal, rechecked);
            if (!failed || this.pulls(r)) return ok && !failed && r.client.alive && !signal?.aborted;
            // It stopped answering on request: wait for what it pushes instead.
        }
        const v = version;
        // Some servers say nothing when nothing changed (typescript-language-server, for a file that stays clean):
        // once one has answered before, silence for a while longer than it usually takes means no news.
        const sent = Date.now();
        const quiet = r.latency === undefined ? deadline : Math.min(deadline, sent + Math.max(QUIET_MIN_MS, r.latency * 1.5 + 300));
        const arrived = await this.until(() => this.isFresh(uri, before, v) || !r.client.alive, quiet, signal);
        if (!arrived || !r.client.alive || signal?.aborted) return false;
        const took = Date.now() - sent;
        r.latency = r.latency === undefined ? took : Math.round(r.latency * 0.6 + took * 0.4);
        // Servers publish in stages (syntax, then types): take what comes within a moment more.
        const settle = t.settleMs ?? 100;
        for (;;) {
            const seen = this.published.get(uri)?.seq;
            const more = await this.until(() => this.published.get(uri)?.seq !== seen, Math.min(deadline, Date.now() + settle), signal);
            if (!more) break;
        }
        return !signal?.aborted;
    }

    /**
     * Files open in the server that changed since they were sent (a shell
     * command, the user's editor, a rewind) go again, and ones that are gone
     * are closed, so it doesn't check against text that isn't there any more.
     */
    private refresh(r: Running, except: string) {
        for (const doc of [...r.client.docs.values()]) {
            if (doc.path === except) continue;
            // Replaced by a symlink out of the project since: closed like a deleted one.
            const inside = this.inside(doc.path);
            const now = mtimeOf(doc.path);
            if (inside && now === doc.mtimeMs) continue;
            const text = inside ? this.readDoc(doc.path) : undefined;
            if (text === undefined) this.drop(r, doc.path);
            else r.client.sync(doc.path, doc.languageId, text, now);
        }
    }

    /** By real paths: a symlink inside the project can lead out of it. */
    inside(path: string): boolean {
        return isInside(canonical(path), canonical(this.root));
    }

    /** A file's text to send: not when it's gone, too big, or binary. */
    private readDoc(path: string): string | undefined {
        try {
            if (statSync(path).size > MAX_FILE_CHARS) return undefined;
            const text = readFileSync(path, "utf-8");
            return isBinary(text) ? undefined : text;
        } catch {
            return undefined; // gone or unreadable
        }
    }

    /** Close a file in its server, and drop what was said about it (an answer on its way too). */
    private drop(r: Running, path: string) {
        const uri = fileUri(path);
        r.client.close(path);
        r.pulling.set(uri, (r.pulling.get(uri) ?? 0) + 1);
        r.pushed.delete(uri);
        this.published.delete(uri);
    }

    /** Open a file from disk in a server that doesn't have it (one that restarted). */
    private reopen(r: Running, path: string) {
        const languageId = r.server.extensionToLanguage[extname(path).toLowerCase()] ?? r.server.extensionToLanguage[extname(path)];
        if (typeof languageId !== "string" || !this.inside(path)) return;
        const text = this.readDoc(path);
        if (text !== undefined) r.client.sync(path, languageId, text, mtimeOf(path));
    }

    /** A server that stopped: what it said about its files goes with it (the next one says it again, about the text as it is then). */
    private forget(r: Running) {
        for (const uri of r.client.docs.keys()) this.published.delete(uri);
    }

    /** Asking failed: wait for pushes from now on, starting with the ones that came meanwhile. */
    private pushOnly(r: Running) {
        if (r.pushOnly) return;
        r.pushOnly = true;
        // Only pushes about the text sent last: by its version, or (one that doesn't say) by coming after it was sent.
        for (const [uri, p] of r.pushed) {
            const doc = r.client.docs.get(uri);
            const current = doc && (p.version !== undefined ? p.version >= doc.version : (p.at ?? 0) >= doc.sentAt);
            if (current) this.published.set(uri, { ...p, seq: ++this.seq });
        }
        r.pushed.clear();
        this.wake();
    }

    /** Asked for rather than waited on: it answers on request, and hasn't failed to. */
    private pulls(r: Running): boolean {
        return !!r.client.pull && !r.pushOnly;
    }

    /**
     * Ask for a file's diagnostics. An answer that comes after the edit
     * stopped waiting is kept all the same (it's reported later); one
     * overtaken by a newer request for the file is dropped.
     */
    private pullNow(r: Running, path: string, deadline: number): Promise<boolean> {
        const uri = fileUri(path);
        const gen = (r.pulling.get(uri) ?? 0) + 1;
        r.pulling.set(uri, gen);
        const version = r.client.docs.get(uri)?.version;
        // Late answers are still worth having: give it longer than the edit waits.
        const timeout = Math.max(deadline - Date.now(), 0) + 30_000;
        const current = () => r.pulling.get(uri) === gen && this.running.get(r.server.name) === r;
        return r.client.pullDiagnostics(path, timeout).then(
            (items) => {
                if (!current() || this.outdated(r, uri, version)) return true;
                // It can't say after all (an answer it doesn't support): wait for pushes from now on.
                if (!items) return this.pushOnly(r), false;
                r.pullFailures = 0;
                this.published.set(uri, { seq: ++this.seq, version, diagnostics: items, at: performance.now() });
                this.wake();
                return true;
            },
            (e: { code?: number }) => {
                // Not supported after all, or failing again and again: wait for pushes. A cancelled
                // request (overtaken by a newer change) or one slow answer doesn't count.
                if (current() && r.client.alive) {
                    const cancelled = e?.code === CANCELLED || e?.code === SERVER_CANCELLED;
                    if (e?.code === METHOD_NOT_FOUND || (!cancelled && ++r.pullFailures >= 3)) this.pushOnly(r);
                }
                this.wake();
                return false;
            },
        );
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        const all = [...this.running.values()];
        this.running.clear();
        for (const r of all) if (r.idle) clearTimeout(r.idle);
        this.wake();
        await Promise.all(all.map((r) => r.client.stop().catch(() => {})));
    }

    /**
     * A file's latest diagnostics, if they're about the text sent last: ones
     * that came before a newer version went out describe text that's gone.
     */
    latest(uri: string): Published | undefined {
        const p = this.published.get(uri);
        if (!p) return undefined;
        for (const r of this.running.values()) {
            const doc = r.client.docs.get(uri);
            if (doc && (p.version !== undefined ? p.version < doc.version : (p.at ?? 0) < doc.sentAt)) return undefined;
        }
        return p;
    }

    /** Diagnostics about a version of the file older than the one sent last (ones that don't say can't be told apart). */
    private outdated(r: Running, uri: string, version: number | undefined): boolean {
        const doc = r.client.docs.get(uri);
        return version !== undefined && !!doc && version < doc.version;
    }

    /** Diagnostics newer than `seq` for this version of the file (servers that don't say the version: any newer). */
    private isFresh(uri: string, seq: number, version: number): boolean {
        const p = this.published.get(uri);
        return !!p && p.seq > seq && (p.version === undefined || p.version >= version);
    }

    private start(server: LspServer, trusted: boolean): Running | undefined {
        const have = this.running.get(server.name);
        if (have && sameLaunch(have.server, server)) return have;
        // Set up differently since it started (settings edited, a plugin updated or swapped): the old one goes.
        if (have) this.retire(have);
        const exe = this.resolved.get(`${server.name}\u0000${server.command}\u0000${trusted}`)?.exe;
        if (!exe) return undefined;
        let r: Running;
        const client = new LspClient({
            server,
            executable: exe,
            root: this.root,
            onDiagnostics: (d) => {
                const p = { seq: 0, version: typeof d.version === "number" ? d.version : undefined, diagnostics: d.diagnostics, at: performance.now() };
                // About text that was replaced since: reporting it would have the agent fix what it already fixed.
                if (this.outdated(r, d.uri, p.version)) return;
                // Asked for, its pushes would only race the answers (an older state arriving after a newer one): kept aside in case asking stops working.
                if (this.pulls(r)) return void r.pushed.set(d.uri, p);
                this.published.set(d.uri, { ...p, seq: ++this.seq });
                this.wake();
            },
            onExit: (code, stderr) => this.crashed(r, code, stderr),
        });
        r = {
            server,
            client,
            pulling: new Map(),
            pushed: new Map(),
            pullFailures: 0,
            checking: 0,
            ready: client.start().then(
                () => {
                    r.up = true;
                    return true;
                },
                (e: Error) => {
                    this.crashed(r, null, e.message);
                    void client.stop(200);
                    return false;
                },
            ),
        };
        this.running.set(server.name, r);
        return r;
    }

    private crashed(r: Running, code: number | null, why: string) {
        if (this.running.get(r.server.name) !== r) return;
        this.running.delete(r.server.name);
        if (r.idle) clearTimeout(r.idle);
        this.forget(r);
        this.wake();
        if (this.disposed) return;
        const n = (this.crashes.get(r.server.name) ?? 0) + 1;
        this.crashes.set(r.server.name, n);
        const last = why.split("\n").filter(Boolean).pop()?.slice(0, 200);
        const what = `${r.server.command}${code !== null ? ` exited with code ${code}` : " failed to start"}${last ? `: ${last}` : ""}`;
        let msg: string | undefined;
        if (n >= (this.timing.maxCrashes ?? 3)) {
            this.off.add(r.server.name);
            msg = `Language server ${what}. It stopped ${n} times, so its diagnostics are off until Cavvy restarts.`;
        } else if (n === 1) msg = `Language server ${what}. It restarts on the next edit.`;
        if (msg) for (const l of this.listeners) l("warn", msg);
    }

    private retire(r: Running) {
        this.running.delete(r.server.name);
        if (r.idle) clearTimeout(r.idle);
        this.forget(r);
        void r.client.stop();
    }

    /** Stop a server nothing has edited for a while (it starts again on the next edit). */
    private touch(r: Running) {
        if (r.idle) clearTimeout(r.idle);
        r.idle = setTimeout(() => {
            if (this.running.get(r.server.name) !== r) return;
            this.running.delete(r.server.name);
            this.forget(r);
            void r.client.stop();
        }, this.timing.idleMs ?? 10 * 60_000);
        r.idle.unref?.();
    }

    private wake() {
        for (const w of [...this.waiters]) w();
    }

    /** Wait until `cond` holds (true), the deadline passes or the signal fires (false). */
    private until(cond: () => boolean, deadline: number, signal?: AbortSignal, also?: Promise<unknown>): Promise<boolean> {
        if (cond()) return Promise.resolve(true);
        if (Date.now() >= deadline || signal?.aborted || this.disposed) return Promise.resolve(false);
        return new Promise((resolve) => {
            const done = (v: boolean) => {
                clearTimeout(timer);
                this.waiters.delete(check);
                signal?.removeEventListener("abort", abort);
                resolve(v);
            };
            const check = () => {
                if (this.disposed) done(false);
                else if (cond()) done(true);
            };
            const abort = () => done(false);
            const timer = setTimeout(() => done(cond()), deadline - Date.now());
            this.waiters.add(check);
            signal?.addEventListener("abort", abort, { once: true });
            void also?.then(check, check);
        });
    }
}

const pools = new Map<string, LspPool>();

/** The pool for a project folder, made on first use; each acquire needs a release. */
export function acquirePool(root: string, timing?: LspTiming): LspPool {
    let p = pools.get(root);
    if (!p || p.disposed) {
        p = new LspPool(root, timing);
        pools.set(root, p);
    }
    p.refs++;
    return p;
}

async function releasePool(p: LspPool) {
    if (--p.refs > 0) return;
    if (pools.get(p.root) === p) pools.delete(p.root);
    await p.dispose();
}

/**
 * One agent's use of its project's servers: what it has edited, and what it
 * has told its model. A sub-agent gets its own (fork), over the same pool.
 */

export class LspManager {
    private pool?: LspPool;
    /** What the last report on each file said. */
    private reported = new Map<string, Published>();
    /** Files edited by this agent, by uri: only their diagnostics are reported. */
    private tracked = new Map<string, string>();
    private session?: string;
    disposed = false;
    /** Servers from settings it has said are missing. */
    private warned = new Set<string>();
    private toldUntrusted = false;
    private notice: Notice = (level, message) => this.o.notice?.(level, message);

    /** `parent`: the manager whose pool this one uses (a sub-agent's); it owns the pool. */
    constructor(
        private o: LspManagerOptions,
        private parent?: LspManager,
    ) {}

    get root(): string {
        return this.o.root;
    }

    /**
     * The agent now using it: where notices go, and the session it reports
     * to. Another session hasn't seen what was reported, so that starts over.
     */
    attach(sessionId: string, notice: Notice | undefined) {
        this.o.notice = notice;
        if (this.session !== undefined && this.session !== sessionId) {
            this.reported.clear();
            this.tracked.clear();
        }
        this.session = sessionId;
    }

    /** A view for a sub-agent: its own record of what it edited and was told, the same servers. */
    fork(notice?: Notice): LspManager {
        return new LspManager({ ...this.o, notice }, this.parent ?? this);
    }

    /** The servers running for this project now. */
    status() {
        return this.pool?.status() ?? [];
    }

    /** Whether a server would check this file (it needn't be running yet). */
    handles(path: string): boolean {
        return this.pick(path) !== undefined;
    }

    /**
     * Send an edited file's new text to its server and wait (bounded) for the
     * diagnostics. Undefined when no server handles it, nothing new came in
     * time, or nothing changed; the report also covers other files this
     * agent edited whose problems changed meanwhile.
     */
    async afterEdit(path: string, text: string, signal?: AbortSignal): Promise<DiagnosticReport | undefined> {
        return this.afterEdits([{ path, text }], signal);
    }

    /** afterEdit for several files changed at once (a Codex patch), checked together, in one report. */
    async afterEdits(files: { path: string; text: string }[], signal?: AbortSignal): Promise<DiagnosticReport | undefined> {
        if (signal?.aborted) return undefined;
        const picked = files.flatMap((f) => {
            const pick = f.text.length <= MAX_FILE_CHARS && !isBinary(f.text) ? this.pick(f.path) : undefined;
            return pick ? [{ ...f, pick, uri: fileUri(f.path) }] : [];
        });
        if (!picked.length) return undefined;
        const edited = new Set(picked.map((f) => f.uri));
        // Latest edited last.
        for (const f of picked) {
            this.tracked.delete(f.uri);
            this.tracked.set(f.uri, displayPath(f.path, this.o.root));
        }
        // The files edited before these, latest first: an edit here can break them.
        const others = [...this.tracked.keys()].filter((u) => !edited.has(u)).reverse().slice(0, MAX_RECHECKED).map((u) => fileURLToPath(u));
        const fresh = await Promise.all(picked.map((f) => f.pick.pool.check(f.pick.server, true, f.pick.languageId, f.path, f.text, signal, others)));
        if (!fresh.some(Boolean) || this.disposed) return undefined;
        return this.report([...edited, ...[...this.tracked.keys()].filter((u) => !edited.has(u))]);
    }

    /** Diagnostics that came in after their edit stopped waiting: for the next tool results. */
    takeLate(): DiagnosticReport | undefined {
        if (this.disposed || !this.pool) return undefined;
        return this.report([...this.tracked.keys()]);
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        const pool = this.pool;
        this.pool = undefined;
        if (!pool || this.parent) return;
        pool.listeners.delete(this.notice);
        await releasePool(pool);
    }

    private pick(path: string) {
        if (this.disposed || this.parent?.disposed) return undefined;
        const settings = this.o.settings();
        // By real paths: a symlink inside the project can lead out of it.
        if (!lspEnabled(settings) || !isInside(canonical(path), canonical(this.o.root))) return undefined;
        const servers = lspServers(settings);
        // No pool until a file some server could handle comes along.
        if (!servers.some((s) => serverFor(path, [s], () => true))) return undefined;
        // Language servers run the project's own code (its TypeScript install, build scripts, its interpreter):
        // only in a folder the user trusted themselves, not one trusted for the session because it had nothing to protect.
        if (!(this.o.trusted?.() ?? true)) {
            if (!this.toldUntrusted && !this.parent) this.notice("info", "Diagnostics after edits are off in this folder until you trust it (/trust): language servers run the project's own code.");
            this.toldUntrusted = true;
            return undefined;
        }
        const pool = this.usePool();
        const found = serverFor(path, servers, (s) => {
            const state = pool.available(s, true);
            // A built-in that isn't installed is simply not used; one the user set up should work.
            if (state === "missing" && !s.builtin && !this.warned.has(s.name)) {
                this.warned.add(s.name);
                this.notice("warn", `Language server "${s.name}" can't start: ${s.command} isn't installed or isn't on PATH.`);
            }
            return state === "ok";
        });
        return found && { ...found, pool };
    }

    private usePool(): LspPool {
        if (!this.pool) {
            if (this.parent) this.pool = this.parent.usePool();
            else {
                this.pool = acquirePool(this.o.root, this.o);
                this.pool.listeners.add(this.notice);
            }
        }
        return this.pool;
    }

    private report(uris: string[]): DiagnosticReport | undefined {
        const pool = this.pool;
        if (!pool) return undefined;
        const files: FileReport[] = [];
        for (const uri of uris) {
            const now = pool.latest(uri);
            const path = this.tracked.get(uri);
            if (!now || !path) continue;
            const last = this.reported.get(uri);
            if (last && last.seq >= now.seq) continue;
            files.push(compare(path, last?.diagnostics, now.diagnostics));
            this.reported.set(uri, now);
        }
        return buildReport(files);
    }
}
