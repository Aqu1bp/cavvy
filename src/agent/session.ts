// Sessions are append-only JSONL files under ~/.harness/projects/<slug>/.
// Each line is one record; a "compact" record starts a fresh history and a
// "rewind" record cuts it back (/rewind).
// Everything is passed through the redactor before it touches disk.

import { appendFileSync, existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync, chmodSync, linkSync, unlinkSync, writeFileSync, writeSync } from "fs";
import { join, resolve } from "path";
import { randomBytes } from "crypto";
import { ensureDir, paths, projectStateDir, APP_TITLE, APP_VERSION } from "../config/paths";
import type { Message, Usage } from "../providers/types";
import { textOf } from "../providers/types";
import { redact, redactedJson } from "../util/redact";

export { redactedJson };

export interface SessionMeta {
    id: string;
    cwd: string;
    createdAt: number;
    version: string;
    /** Frozen system prompt; reused on resume so the prompt prefix stays identical. */
    system?: string;
}


/**
 * Content as the providers will see it: text and tool results redacted, so a
 * key pasted into a prompt or printed by a tool reaches neither the
 * transcript nor any model. Assistant turns keep their signed or encrypted
 * reasoning byte for byte (replay verifies it); their text, tool inputs and
 * raw wire copies are redacted like everything else.
 */
export function redactMessage(m: Message): Message {
    if (m.role === "assistant") {
        const plain = JSON.stringify(m);
        const red = redactedJson(m);
        return red === plain ? m : (JSON.parse(red) as Message);
    }
    let changed = false;
    const content = m.content.map((p) => {
        if (p.type === "text") {
            const text = redact(p.text);
            if (text === p.text) return p;
            changed = true;
            return { ...p, text };
        }
        if (p.type === "tool_result") {
            const c = redact(p.content);
            if (c === p.content) return p;
            changed = true;
            return { ...p, content: c };
        }
        return p;
    });
    return changed ? { ...m, content } : m;
}

type Line =
    | ({ t: "meta" } & SessionMeta)
    | { t: "msg"; m: Message }
    | { t: "model"; model: string }
    | { t: "title"; title: string }
    | { t: "compact"; summary: string }
    | { t: "rewind"; count: number }
    | { t: "usage"; usage: Usage; cost: number; model: string }
    /** An agent backend's own session (Claude Code) or thread (Codex); id null forgets it. */
    | { t: "backend"; provider: string; id: string | null; synced?: number };

/**
 * An agent backend's session behind this one, and how much of this session's
 * history it has seen: `synced` messages. Turns other models answered after
 * that are passed to the backend as context on its next turn.
 */
export interface BackendSession {
    id: string;
    synced: number;
}

export interface SessionSummary {
    id: string;
    file: string;
    cwd: string;
    createdAt: number;
    updatedAt: number;
    title: string;
    messages: number;
    model?: string;
}

export class Session {
    readonly meta: SessionMeta;
    messages: Message[] = [];
    model?: string;
    title?: string;
    /** The latest compaction summary (/summary). */
    summary?: string;
    /** USD spent in this session (estimates included). */
    cost = 0;
    usageByModel = new Map<string, { usage: Usage; cost: number }>();
    /** Agent backends' own sessions, by provider. */
    backends = new Map<string, BackendSession>();
    private file: string;
    private persist: boolean;

    constructor(meta: SessionMeta, opts: { persist?: boolean; file?: string } = {}) {
        this.meta = meta;
        this.persist = opts.persist ?? true;
        this.file = opts.file ?? join(projectStateDir(meta.cwd), `${meta.id}.jsonl`);
    }

    static create(cwd: string, opts: { persist?: boolean; system?: string } = {}): Session {
        const id = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")}-${randomBytes(3).toString("hex")}`;
        const s = new Session({ id, cwd, createdAt: Date.now(), version: APP_VERSION, system: opts.system }, opts);
        return s;
    }

    get path(): string {
        return this.file;
    }

    get persisted(): boolean {
        return this.persist;
    }

    /**
     * Done writing it (another session took its place, or it was closed):
     * another process may open it now. Anything this copy is still asked to
     * write (a title arriving late, say) is dropped.
     */
    release() {
        this.released = true;
        if (!this.holding) return;
        this.holding = false;
        letGo(this.file);
    }

    private claim() {
        if (this.holding) return;
        hold(this.file);
        this.holding = true;
    }

    /** This object has claimed the file (see hold()). */
    private holding = false;
    private released = false;
    private started = false;
    /** Lines held back until the first message, so idle launches leave no file. */
    private pending: Line[] = [];

    private write(line: Line) {
        if (!this.persist || this.released) return;
        if (!this.started && line.t !== "msg" && !existsSync(this.file)) {
            this.pending.push(line);
            return;
        }
        try {
            if (!this.started) {
                ensureDir(projectStateDir(this.meta.cwd));
                this.claim();
                this.started = true;
                if (!existsSync(this.file)) {
                    appendFileSync(this.file, redactedJson({ t: "meta", ...this.meta }) + "\n", { mode: 0o600 });
                    chmodSync(this.file, 0o600);
                }
            }
            const lines = [...this.pending.splice(0), line];
            appendFileSync(this.file, lines.map((l) => redactedJson(l) + "\n").join(""));
        } catch {
            // Persistence is best effort; the session keeps working in memory.
        }
    }

    setSystem(system: string) {
        this.meta.system = system;
    }

    /** Store a message (redacted); returns the stored copy. */
    push<M extends Message>(m: M): M {
        m = redactMessage(m) as M;
        this.messages.push(m);
        this.write({ t: "msg", m });
        return m;
    }

    setModel(ref: string) {
        this.model = ref;
        this.write({ t: "model", model: ref });
    }

    setTitle(title: string) {
        this.title = title;
        this.write({ t: "title", title });
    }

    recordUsage(model: string, usage: Usage, cost: number) {
        this.accumulate(model, usage, cost);
        this.write({ t: "usage", usage, cost, model });
    }

    private accumulate(model: string, usage: Usage, cost: number) {
        this.cost += cost;
        const cur = this.usageByModel.get(model) ?? { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, cost: 0 };
        cur.usage.inputTokens += usage.inputTokens;
        cur.usage.outputTokens += usage.outputTokens;
        cur.usage.cacheReadTokens = (cur.usage.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0);
        cur.usage.cacheWriteTokens = (cur.usage.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
        cur.cost += cost;
        this.usageByModel.set(model, cur);
    }

    setBackendSession(provider: string, id: string, synced: number) {
        const cur = this.backends.get(provider);
        if (cur?.id === id && cur.synced === synced) return;
        this.backends.set(provider, { id, synced });
        this.write({ t: "backend", provider, id, synced });
    }

    forgetBackendSession(provider: string) {
        if (!this.backends.delete(provider)) return;
        this.write({ t: "backend", provider, id: null });
    }

    /** A backend session that saw messages from `count` on can't continue a history cut back to `count`. */
    private dropBackendsAfter(count: number) {
        for (const [p, b] of this.backends) if (b.synced > count) this.backends.delete(p);
    }

    /**
     * Keep only the first `count` messages (/rewind). Recorded as a line, like
     * a compaction, rather than by rewriting the file: an append can't lose
     * what's already saved if it's cut short (a torn line is ignored on load),
     * nothing else in the file (usage and cost, titles) has to be copied over,
     * and nothing written meanwhile by another process on this session is lost.
     */
    rewind(count: number) {
        this.messages = this.messages.slice(0, count);
        this.dropBackendsAfter(count);
        this.write({ t: "rewind", count });
    }

    /** Replace history with a compacted version. Backend sessions start over from the summary. */
    compact(summary: string, messages: Message[]) {
        this.messages = [];
        this.backends.clear();
        this.summary = summary;
        this.write({ t: "compact", summary });
        for (const m of messages) this.push(m);
    }

    static load(file: string): Session {
        // Claimed before it's read, so what's read has everything the process
        // that had it open wrote (and nothing is written under that process).
        hold(file);
        try {
            const s = Session.read(file);
            s.holding = true;
            return s;
        } catch (e) {
            letGo(file);
            throw e;
        }
    }

    private static read(file: string): Session {
        const text = readFileSync(file, "utf-8");
        let meta: SessionMeta | undefined;
        const lines: Line[] = [];
        for (const raw of text.split("\n")) {
            if (!raw.trim()) continue;
            try {
                const l = JSON.parse(raw) as Line;
                if (l.t === "meta") meta = { id: l.id, cwd: l.cwd, createdAt: l.createdAt, version: l.version, system: l.system };
                else lines.push(l);
            } catch {
                // a torn final line from a crash; ignore it
            }
        }
        if (!meta) throw new Error(`Not a session file: ${file}`);
        const s = new Session(meta, { file });
        // End a torn last line, or the next record appended would join it and
        // both would be unreadable on the following load.
        if (text && !text.endsWith("\n")) {
            try {
                appendFileSync(file, "\n");
            } catch {
                // read-only file: nothing will be appended either
            }
        }
        s.started = true;
        for (const l of lines) {
            if (l.t === "msg") s.messages.push(l.m);
            else if (l.t === "compact") {
                s.messages = [];
                s.backends.clear();
                s.summary = l.summary;
            }
            else if (l.t === "rewind") {
                s.messages = s.messages.slice(0, l.count);
                s.dropBackendsAfter(l.count);
            }
            else if (l.t === "backend") {
                if (typeof l.provider !== "string") continue;
                if (typeof l.id === "string" && l.id) s.backends.set(l.provider, { id: l.id, synced: typeof l.synced === "number" ? l.synced : s.messages.length });
                else s.backends.delete(l.provider);
            }
            else if (l.t === "model") s.model = l.model;
            else if (l.t === "title") s.title = l.title;
            else if (l.t === "usage") s.accumulate(l.model, l.usage, l.cost);
        }
        repairTail(s);
        return s;
    }
}

// ---------------------------------------------------------------------------
// One writer per session. Each process keeps its own copy of the history and
// appends to the file, so two processes on one session (the GUI and a
// terminal) would interleave their turns, and the one opening it second would
// answer the other's running tool calls as interrupted. `<file>.lock` names
// the process that has it open; one that has exited doesn't count.

export class SessionInUseError extends Error {
    readonly code = "in_use";
    /** -1: a process that's claiming it right now. */
    constructor(
        readonly pid: number,
        lock: string,
    ) {
        // After a crash and a restart, an unrelated process can have the pid it names.
        super(`This session is open in another ${APP_TITLE} process${pid > 0 ? ` (pid ${pid})` : ""}, in the app or a terminal. Close it there first.${pid > 0 ? ` If none is running, delete ${lock}.` : ""}`);
    }
}

/** Files this process has claimed, with how many Session objects hold each (an unloading one can overlap the next). */
const held = new Map<string, number>();
let releaseOnExit = false;
const lockOf = (file: string) => `${file}.lock`;

function lockPid(file: string): number | undefined {
    return pidIn(lockOf(file));
}

function pidIn(lock: string): number | undefined {
    try {
        return pidOf(readFileSync(lock, "utf-8"));
    } catch {
        return undefined;
    }
}

function pidOf(body: string): number | undefined {
    try {
        const pid = Number((JSON.parse(body) as { pid?: unknown }).pid);
        return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
        return undefined;
    }
}

function running(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** The other running process that has this session open, if any. */
export function sessionHolder(file: string): number | undefined {
    return lockHolder(lockOf(file));
}

function lockHolder(lock: string): number | undefined {
    let body: string;
    try {
        body = readFileSync(lock, "utf-8");
    } catch {
        return undefined;
    }
    return holderIn(lock, body);
}

/** Who holds a lock that reads `body`: a running process, -1 for one still being written, or undefined when it's stale. */
function holderIn(lock: string, body: string): number | undefined {
    const pid = pidOf(body);
    if (pid !== undefined && pid !== process.pid && running(pid)) return pid;
    // Just created and not written yet (where there are no hard links, the other process is between two calls).
    if (pid === undefined) {
        try {
            if (Date.now() - statSync(lock).mtimeMs < 2000) return -1;
        } catch {
            // gone meanwhile
        }
    }
    return undefined;
}

/** Claim the session for this process, or throw SessionInUseError. Without a lock (a read-only folder) it carries on, as persistence does. */
function hold(file: string) {
    const n = held.get(file);
    if (n) {
        held.set(file, n + 1);
        return;
    }
    const lock = lockOf(file);
    for (let attempt = 0; attempt < 3; attempt++) {
        let made: boolean;
        try {
            made = createLock(lock);
        } catch {
            return;
        }
        if (made) {
            held.set(file, 1);
            if (!releaseOnExit) {
                releaseOnExit = true;
                process.on("exit", () => {
                    for (const f of [...held.keys()]) unlock(f);
                    held.clear();
                });
            }
            return;
        }
        const pid = sessionHolder(file);
        if (pid) throw new SessionInUseError(pid, lock);
        // Can't be removed (a read-only folder): nothing can be written here either.
        if (!takeOver(lock)) return;
    }
    throw new SessionInUseError(-1, lock);
}

/**
 * Create the lock, already holding this process's pid (so no other process
 * sees it empty); false if there's one. Throws when there can't be one here.
 */
function createLock(lock: string): boolean {
    const body = JSON.stringify({ pid: process.pid, at: Date.now() });
    const tmp = `${lock}.${process.pid}.${randomBytes(4).toString("hex")}`;
    try {
        writeFileSync(tmp, body, { flag: "wx", mode: 0o600 });
    } catch {
        return createLockInPlace(lock, body);
    }
    try {
        linkSync(tmp, lock);
        return true;
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
        // No hard links on this file system.
        return createLockInPlace(lock, body);
    } finally {
        try {
            unlinkSync(tmp);
        } catch {
            // already gone
        }
    }
}

function createLockInPlace(lock: string, body: string): boolean {
    let fd: number;
    try {
        fd = openSync(lock, "wx", 0o600);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw e;
    }
    try {
        writeSync(fd, body);
    } finally {
        closeSync(fd);
    }
    return true;
}

/**
 * Remove a lock left by a process that's gone. Two processes can find the
 * same stale lock, and by the time the second removes it the first may have
 * made its own: so it's removed only while holding `<lock>.takeover`, after
 * checking it again. True to try again (the next attempt sees who has it);
 * false if it can't be removed.
 */
export function takeOver(lock: string): boolean {
    const guard = `${lock}.takeover`;
    let fd: number;
    try {
        fd = openSync(guard, "wx", 0o600);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
        // Another process is taking it over. One that crashed doing so left this behind.
        try {
            if (Date.now() - statSync(guard).mtimeMs > 10_000) unlinkSync(guard);
        } catch {
            // gone meanwhile
        }
        return true;
    }
    try {
        // Read once: a stale lock stays as read until it's removed here, but
        // one already gone can be made again at any moment (and mustn't be removed).
        const body = readFileSync(lock, "utf-8");
        if (holderIn(lock, body) === undefined) unlinkSync(lock);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ENOENT";
    } finally {
        closeSync(fd);
        try {
            unlinkSync(guard);
        } catch {
            // already gone
        }
    }
}

function letGo(file: string) {
    const n = held.get(file);
    if (!n) return;
    if (n > 1) {
        held.set(file, n - 1);
        return;
    }
    held.delete(file);
    unlock(file);
}

function unlock(file: string) {
    try {
        if (lockPid(file) === process.pid) unlinkSync(lockOf(file));
    } catch {
        // already gone
    }
}

/**
 * A crash can leave an assistant tool call without results. Providers reject
 * that, so answer dangling calls with an "interrupted" result on load.
 */
function repairTail(s: Session) {
    const last = s.messages[s.messages.length - 1];
    if (!last || last.role !== "assistant") return;
    const calls = last.content.filter((p) => p.type === "tool_call");
    if (!calls.length) return;
    s.push({
        role: "user",
        content: calls.map((c) => ({ type: "tool_result" as const, toolCallId: (c as { id: string }).id, toolName: (c as { name: string }).name, content: "Interrupted: the session ended before this tool ran.", isError: true })),
        meta: { kind: "tool_results" },
    });
}

const CHUNK_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 64 * 1024 * 1024;
/** Enough of a line to see its record type. */
const PREFIX_BYTES = 32;
const MSG_PREFIX = '{"t":"msg"';

interface SessionHead {
    cwd?: string;
    title?: string;
    /** The model it last used ("provider:id"). */
    model?: string;
    first?: string;
    /** The index of the message `first` came from; -1 once a compaction keeps it as the title. */
    firstAt?: number;
    /** Messages after rewinds and compactions, as load() would have them. */
    count: number;
}

/**
 * The session's cwd, title, first prompt and message count, without loading
 * it (sessions can be large). Every line is scanned, so later renames,
 * rewinds and compactions count, but only those records, the meta line and
 * messages up to the first prompt are parsed; other messages are only counted.
 */
function sessionHead(file: string): SessionHead {
    const head: SessionHead = { count: 0 };
    const fd = openSync(file, "r");
    try {
        const chunk = Buffer.alloc(CHUNK_BYTES);
        let parts: Buffer[] = [];
        let len = 0;
        // The line's last two bytes: a whole message record ends with "}}".
        let end = "";
        // Whether the current line is parsed; undefined until its record type is visible.
        let wanted: boolean | undefined;
        const decide = () => {
            const prefix = Buffer.concat(parts).subarray(0, PREFIX_BYTES).toString("latin1");
            wanted = prefix.startsWith(MSG_PREFIX) ? !head.first : !/^\{"t":"(usage|backend)"/.test(prefix);
            if (!wanted) parts = [Buffer.from(prefix, "latin1")];
        };
        for (let pos = 0, n: number; (n = readSync(fd, chunk, 0, chunk.length, pos)) > 0; pos += n) {
            const c = chunk.subarray(0, n);
            for (let start = 0; start < n; ) {
                const nl = c.indexOf(10, start);
                const piece = c.subarray(start, nl < 0 ? n : nl);
                end = (end + piece.subarray(Math.max(0, piece.length - 2)).toString("latin1")).slice(-2);
                if (wanted !== false) {
                    parts.push(Buffer.from(piece)); // chunk is reused
                    len += piece.length;
                }
                if (wanted === undefined && len >= PREFIX_BYTES) decide();
                // Too big to parse: still counted if it's a message.
                if (wanted && len > MAX_LINE_BYTES) {
                    parts = [Buffer.concat(parts).subarray(0, PREFIX_BYTES)];
                    wanted = false;
                }
                if (nl < 0) break;
                if (wanted === undefined) decide();
                if (wanted) readHeadLine(Buffer.concat(parts).toString("utf-8"), head);
                // A torn line, which load() skipped (and ended), isn't counted.
                else if (end === "}}" && Buffer.concat(parts).toString("latin1").startsWith(MSG_PREFIX)) head.count++;
                parts = [];
                len = 0;
                end = "";
                wanted = undefined;
                start = nl + 1;
            }
        }
        // A torn last line (no newline yet) is ignored, as load() does.
    } finally {
        closeSync(fd);
    }
    return head;
}

function readHeadLine(raw: string, head: SessionHead) {
    if (!raw.trim()) return;
    let l: Line;
    try {
        l = JSON.parse(raw) as Line;
    } catch {
        return;
    }
    if (l.t === "meta") head.cwd = l.cwd;
    else if (l.t === "title") head.title = l.title;
    else if (l.t === "model") head.model = l.model;
    else if (l.t === "msg") {
        if (!head.first && l.m.role === "user" && (l.m.meta?.kind ?? "prompt") === "prompt") {
            head.first = l.m.meta?.display ?? textOf(l.m);
            head.firstAt = head.count;
        }
        head.count++;
    } else if (l.t === "rewind") {
        head.count = Math.min(head.count, l.count);
        if (head.firstAt !== undefined && head.firstAt >= l.count) head.first = head.firstAt = undefined;
    } else if (l.t === "compact") {
        head.count = 0;
        // The conversation's opening prompt still names it after a compaction.
        if (head.first !== undefined) head.firstAt = -1;
    }
}

/** Different paths can share a sessions folder (foo-bar and foo.bar); the session records its own. */
function sameProject(head: SessionHead, cwd: string): boolean {
    return head.cwd === undefined || resolve(head.cwd) === resolve(cwd);
}

export function listSessions(cwd: string, limit = 50): SessionSummary[] {
    const dir = projectStateDir(cwd);
    if (!existsSync(dir)) return [];
    const files: { f: string; file: string; mtimeMs: number; createdAt: number }[] = [];
    for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const file = join(dir, f);
        try {
            const st = statSync(file);
            files.push({ f, file, mtimeMs: st.mtimeMs, createdAt: st.birthtimeMs || st.ctimeMs });
        } catch {
            // vanished or unreadable
        }
    }
    // Newest first, so only as many files are read as are listed.
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out: SessionSummary[] = [];
    for (const { f, file, mtimeMs, createdAt } of files) {
        if (out.length >= limit) break;
        try {
            const head = sessionHead(file);
            if (!head.count || !sameProject(head, cwd)) continue;
            out.push({
                id: f.replace(/\.jsonl$/, ""),
                file,
                cwd,
                createdAt,
                updatedAt: mtimeMs,
                title: (head.title ?? head.first ?? "(untitled)").replace(/\s+/g, " ").trim().slice(0, 120),
                messages: head.count,
                model: head.model,
            });
        } catch {
            // skip unreadable files
        }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out.slice(0, limit);
}

/**
 * Sessions from every project, newest first (the GUI's sidebar). Each
 * session records its own folder, so the lossy folder names under
 * ~/.harness/projects/ don't matter. Only the newest `limit` files are read.
 */
export function listAllSessions(limit = 200): SessionSummary[] {
    const root = paths.projectsDir();
    if (!existsSync(root)) return [];
    const files: { f: string; file: string; mtimeMs: number; createdAt: number }[] = [];
    let dirs: string[] = [];
    try {
        dirs = readdirSync(root);
    } catch {
        return [];
    }
    for (const d of dirs) {
        const dir = join(root, d);
        let names: string[];
        try {
            names = readdirSync(dir);
        } catch {
            continue;
        }
        for (const f of names) {
            if (!f.endsWith(".jsonl")) continue;
            const file = join(dir, f);
            try {
                const st = statSync(file);
                if (st.isFile()) files.push({ f, file, mtimeMs: st.mtimeMs, createdAt: st.birthtimeMs || st.ctimeMs });
            } catch {
                // vanished or unreadable
            }
        }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out: SessionSummary[] = [];
    for (const { f, file, mtimeMs, createdAt } of files) {
        if (out.length >= limit) break;
        try {
            const head = sessionHead(file);
            if (!head.count || !head.cwd) continue;
            out.push({
                id: f.replace(/\.jsonl$/, ""),
                file,
                cwd: head.cwd,
                createdAt,
                updatedAt: mtimeMs,
                title: (head.title ?? head.first ?? "(untitled)").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/\s+/g, " ").trim().slice(0, 120),
                messages: head.count,
                model: head.model,
            });
        } catch {
            // skip unreadable files
        }
    }
    return out;
}

/** A session file by id, in any project (ids are unique: timestamp and random suffix). */
export function findSessionAnywhere(id: string): string | undefined {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
    const root = paths.projectsDir();
    let dirs: string[] = [];
    try {
        dirs = readdirSync(root);
    } catch {
        return undefined;
    }
    for (const d of dirs) {
        const file = join(root, d, `${id}.jsonl`);
        if (existsSync(file)) return file;
    }
    return undefined;
}

export function findSession(cwd: string, idOrPrefix: string): string | undefined {
    if (/^[A-Za-z0-9_-]+$/.test(idOrPrefix)) {
        const exact = join(projectStateDir(cwd), `${idOrPrefix}.jsonl`);
        try {
            const head = existsSync(exact) ? sessionHead(exact) : undefined;
            if (head?.count && sameProject(head, cwd)) return exact;
        } catch {
            // fall back to the listing
        }
    }
    const all = listSessions(cwd, 1000);
    return all.find((s) => s.id === idOrPrefix)?.file ?? all.find((s) => s.id.startsWith(idOrPrefix))?.file;
}

// ---------------------------------------------------------------------------
// Prompt history (up-arrow), shared across sessions per project.

export function loadPromptHistory(cwd: string, limit = 500): string[] {
    const file = paths.history();
    if (!existsSync(file)) return [];
    try {
        const lines = readFileSync(file, "utf-8").split("\n");
        const out: string[] = [];
        for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
            const raw = lines[i];
            if (!raw) continue;
            try {
                const e = JSON.parse(raw) as { cwd: string; text: string };
                if (e.cwd === cwd && e.text && out[out.length - 1] !== e.text) out.push(e.text);
            } catch {
                // ignore
            }
        }
        return out.reverse();
    } catch {
        return [];
    }
}

export function appendPromptHistory(cwd: string, text: string) {
    try {
        ensureDir(paths.home());
        const file = paths.history();
        const existed = existsSync(file);
        appendFileSync(file, redactedJson({ cwd, text, ts: Date.now() }) + "\n", { mode: 0o600 });
        if (!existed) chmodSync(file, 0o600);
    } catch {
        // ignore
    }
}
