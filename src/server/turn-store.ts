// A session's turns as they were built (replay), kept beside its logs, so the server needn't keep them all in memory,
// nor build them all again each time the session is opened. A long session's turns are its whole content (what each
// tool printed, each diff): the server kept every one, 132 MB for 30,000 items of a Claude Code session.
//
// <project>/turns/<id>.jsonl holds turns, a line each, appended (the latest line for a turn is it); <id>.json is the
// index: each turn's place in the store and what the turn is without its blocks (the window's list, and what the
// server keeps of a turn it lets go of), the sub-agents, and the session's logs as they were when it was written.
// Written as the session is closed: a session opened again with its logs unchanged since opens from it. One whose
// logs changed (a crash after the store was written, the session written to elsewhere) doesn't: it's built again.
//
// The index is lines: a turn's, then its sub-agents', for each turn in order; then the sub-agents kept with the latest
// whatever their turn (still at work, a background task's, or of no turn); then what it says of the session (Meta).
// An open reads it from its end, as far back as its last turns (read), and the rest as it's asked for (readEarlier):
// a 100,000-item session's whole index is 1.8 MB (3.4 for a Claude Code one's), and an open read all of it; its last
// 100 turns are 49 KB of it (82 KB), whatever its length (Linux, after a restart: scripts/perf-thread.ts sessions).

import { closeSync, existsSync, fstatSync, fsync, readdirSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from "fs";
import { basename, dirname, join } from "path";
import { constants as zlib, zstdCompressSync, zstdDecompressSync } from "zlib";
import type { UiLight } from "./history";
import type { AgentRun, Turn } from "./protocol";
import { linesFromEnd } from "../util/lines";

/** The store's format: an index of another is not read. */
const VERSION = 4;
/** Old versions of turns the store may hold beyond twice what's current, before it's rewritten without them. */
const COMPACT_SLACK = 8 * 1024 * 1024;
/**
 * A turn this long or longer is kept compressed (zstd, its fastest level): the store was a second copy of the logs,
 * nearly as large (100,000 items: 112 MB beside a 132 MB log). Each turn on its own (Linux): the generated sessions'
 * 7-7.8x smaller, real agent output (a Claude Code transcript, 147 MB) 2.3x a line and 3.2x for ten together, at
 * 1.7-4 ms a MB to write and 1.1-2 ms a MB to read. Shorter ones gain little. A turn written as JSON (before this, or
 * short) starts with `{`: read as it is.
 */
const COMPRESS_FROM = 512;
/** How much of a log's end is kept, to tell later that it's the same log, unchanged. */
const TAIL_BYTES = 256;

/** What a log was when the store was written: which file (its inode), its size and its last bytes. */
interface LogStamp {
    size: number;
    tail: string;
    ino?: number;
}

/** A turn without its blocks: what the server keeps of a turn it isn't showing. */
export type TurnHead = Omit<Turn, "blocks">;

/** The index's last line. */
interface Meta {
    v: number;
    logs: LogStamp[];
    /** The runtime's id counter when it was written: new ids go on from there, so none is used twice. */
    ids: number;
    /** How many turns and sub-agents it has, and how many of those failed (a window counts the ones it isn't sent). */
    turns: number;
    agents: number;
    failed: number;
    /** The first prompt's text, as Runtime.firstPrompt gives it: the sidebar's name for a session without a title. */
    first?: string;
    /** The GUI log, light (UiLog.lightState): the session's opened without reading it. */
    ui: UiLight;
}

/** A turn's line, and a sub-agent's: `i` is its place among the sub-agents; `keep`, one of those kept with the latest. */
type IndexLine = { k: "t"; head: TurnHead; at: number; len: number } | ({ k: "a"; i: number; keep?: true } & StoredAgent);

export interface StoredTurn {
    head: TurnHead;
    at: number;
    len: number;
}

/** What an open reads of the index: its last turns, and what it says of the rest. */
export interface StoreRead {
    heads: StoredTurn[];
    /** The sub-agents of those turns, and the ones kept with the latest (at work, a background task's), in order. */
    agents: StoredAgent[];
    ids: number;
    ui: UiLight;
    first?: string;
    /** The turns before `heads`, and their sub-agents, not read (readEarlier): how many. */
    earlier?: { turns: number; agents: number; failed: number };
}

/** A sub-agent at work, or a background task's: kept with the latest turns, whichever turn it's of. */
const keptWithLatest = (a: AgentHead) => a.status === "running" || a.status === "waiting" || Boolean(a.taskId);

/** Lines of the index read at a time from its end (linesFromEnd): a 100-turn screen's heads are a few KB. */
const INDEX_CHUNK = 16 * 1024;

/** The same log as when `was` was taken: the same file (another restored or synced in its place isn't), size and end. */
const sameLog = (now: LogStamp, was: LogStamp | undefined) => Boolean(was) && now.size === was!.size && now.tail === was!.tail && now.ino === was!.ino;

function stamp(file: string): LogStamp {
    let fd: number;
    try {
        fd = openSync(file, "r");
    } catch {
        return { size: -1, tail: "" };
    }
    try {
        const st = fstatSync(fd);
        const size = st.size;
        const n = Math.min(TAIL_BYTES, size);
        const b = Buffer.alloc(n);
        readSync(fd, b, 0, n, size - n);
        return { size, tail: b.toString("base64"), ino: st.ino };
    } finally {
        closeSync(fd);
    }
}

/** Written through to the disk, on a thread of the runtime's own. */
const synced = (fd: number) => new Promise<void>((resolve, reject) => fsync(fd, (e) => (e ? reject(e) : resolve())));

/** A sub-agent without its steps, its prompt and its report: what its list shows (AgentRun.partial). */
export type AgentHead = Omit<AgentRun, "blocks" | "prompt" | "report">;
export interface StoredAgent {
    head: AgentHead;
    /** Where it is whole in the store; none: the head is all of it (no steps, prompt or report). */
    at?: number;
    len?: number;
    /** Its place among all the session's sub-agents (as read: the index's order). */
    i?: number;
}

export function agentHeadOf(a: AgentRun): AgentHead {
    const { blocks: _b, prompt: _p, report: _r, partial: _partial, ...head } = a;
    return head;
}

export function headOf(t: Turn): TurnHead {
    const { blocks: _blocks, ...head } = t;
    return head;
}

export class TurnStore {
    private readonly file: string;
    private readonly indexFile: string;
    private fd?: number;
    /** Where the store's next turn goes. */
    private end = 0;
    /** A turn in it couldn't be read: not indexed again (the session is built from its logs next time). */
    damaged = false;
    /**
     * What the index on the disk says, while nothing has been put since it was read or written: the session closed
     * with nothing changed writes nothing (its index rewritten whole and synced each time, 8 ms for 4,000 turns).
     */
    private written?: { logs: LogStamp[]; ids: number; turns: number; agents: number };
    /**
     * The index an open read the end of, while what's before is still to be read (readEarlier): open, so that what's
     * read later is what was there then, whatever's written in its place meanwhile. And how far that is.
     */
    private index?: { fd: number; end: number };

    private constructor(dir: string, id: string, private readonly logs: string[]) {
        this.file = join(dir, `${id}.jsonl`);
        this.indexFile = join(dir, `${id}.json`);
    }

    /** The store of the session in `sessionFile`, whose logs are `logs` (the session's file and its GUI log). */
    static of(sessionFile: string, id: string, logs: string[]): TurnStore {
        return new TurnStore(join(dirname(sessionFile), "turns"), id, logs);
    }

    /**
     * What it was when written, if its logs are still as they were then (else nothing: the turns are built again). Only
     * its last `last` turns, and their sub-agents (with those kept with the latest): the rest stay on the disk until
     * they're asked for (readEarlier).
     */
    read(last = Infinity): StoreRead | undefined {
        this.dropLeftovers();
        this.closeIndex();
        let fd: number;
        try {
            fd = openSync(this.indexFile, "r");
        } catch {
            return undefined;
        }
        let meta: Meta | undefined;
        let stamps: LogStamp[] | undefined;
        const heads: StoredTurn[] = [];
        const agents: StoredAgent[] = [];
        let failed = 0;
        let end = 0;
        try {
            // One of an older version is a single line of JSON: told by its first bytes, not read back from its end.
            const b = Buffer.alloc(12);
            const v = /^\{"v":(\d+)[,}]/.exec(b.toString("latin1", 0, readSync(fd, b, 0, 12, 0)));
            if (v && Number(v[1]) !== VERSION) throw new Error("Another version.");
            linesFromEnd(fd, (line, at) => {
                if (!meta) {
                    const m = JSON.parse(line) as Meta;
                    if (m.v !== VERSION || m.logs.length !== this.logs.length || !m.ui) return false;
                    const now: LogStamp[] = [];
                    for (let i = 0; i < this.logs.length; i++) {
                        const s = stamp(this.logs[i]!);
                        now.push(s);
                        // Another file in its place (restored from a backup, synced) of the same size and end: not the one it was.
                        if (!sameLog(s, m.logs[i]!)) return false;
                    }
                    meta = m;
                    stamps = now;
                    return true;
                }
                if (!line) return true;
                const l = JSON.parse(line) as IndexLine;
                if (l.k === "t") {
                    heads.push({ head: l.head, at: l.at, len: l.len });
                    // As far back as that: what's before is read when it's asked for.
                    if (heads.length >= last && at > 0) {
                        end = at;
                        return false;
                    }
                } else if (l.k === "a") {
                    const { k: _k, keep, ...a } = l;
                    agents.push(a);
                    if (!keep && a.head.status === "failed") failed++;
                }
                return true;
            }, INDEX_CHUNK);
        } catch {
            closeSync(fd);
            return undefined;
        }
        if (!meta || !stamps || !existsSync(this.file)) {
            closeSync(fd);
            return undefined;
        }
        heads.reverse();
        agents.sort((a, b) => a.i! - b.i!);
        if (end > 0) this.index = { fd, end };
        else closeSync(fd);
        this.end = this.open();
        // The logs as just read (the same): not the index's own.
        this.written = { logs: stamps, ids: meta.ids, turns: meta.turns, agents: meta.agents };
        const earlier = end > 0 ? { turns: meta.turns - heads.length, agents: meta.agents - agents.length, failed: meta.failed - failed } : undefined;
        return { heads, agents, ids: meta.ids, ui: meta.ui, ...(meta.first !== undefined ? { first: meta.first } : {}), ...(earlier ? { earlier } : {}) };
    }

    /**
     * Up to `count` more turns before those read so far (read, then each call), and their sub-agents, from the index as
     * it was when it was read: each call goes on from where the last one stopped, until none are left (partial: false).
     * Thrown when they can't be read (the index damaged): then the store isn't read again, nor indexed.
     */
    readEarlier(count = Infinity): { heads: StoredTurn[]; agents: StoredAgent[] } {
        const index = this.index;
        const heads: StoredTurn[] = [];
        const agents: StoredAgent[] = [];
        if (!index || count <= 0) return { heads, agents };
        let end = 0;
        try {
            linesFromEnd(index.fd, (line, at) => {
                if (!line) return true;
                const l = JSON.parse(line) as IndexLine;
                if (l.k === "t") {
                    heads.push({ head: l.head, at: l.at, len: l.len });
                    if (heads.length >= count && at > 0) {
                        end = at;
                        return false;
                    }
                } else if (l.k === "a") {
                    const { k: _k, keep: _keep, ...a } = l;
                    agents.push(a);
                }
                return true;
            }, INDEX_CHUNK, index.end);
        } catch (e) {
            this.damaged = true;
            this.forget();
            this.closeIndex();
            throw e;
        }
        if (end > 0) index.end = end;
        else this.closeIndex();
        heads.reverse();
        agents.sort((a, b) => a.i! - b.i!);
        return { heads, agents };
    }

    /** Turns of its index are still to be read (readEarlier). */
    get partial(): boolean {
        return this.index !== undefined;
    }

    /**
     * Its index says what writing it again would, as far as these tell: nothing put since it was read or written, as
     * many turns, sub-agents and ids, and its logs as they were (writeIndex passes over writing it then).
     */
    unchanged(turns: number, agents: number, ids: number, logs: LogStamp[] = this.logs.map(stamp)): boolean {
        const was = this.written;
        return Boolean(was && was.ids === ids && was.turns === turns && was.agents === agents && logs.every((l, i) => sameLog(l, was.logs[i])));
    }

    private closeIndex() {
        if (this.index) closeSync(this.index.fd);
        this.index = undefined;
    }

    /** A turn (or a sub-agent) as the store has it, at `at` (its line). */
    get<T = Turn>(at: number, len: number): T {
        const fd = this.fd ?? (this.open(), this.fd!);
        const b = Buffer.allocUnsafe(len);
        // Not all there (cut short, a power cut before it was on the disk), or not what was written: thrown, for the
        // caller to build the session from its logs instead (and the index let go of, so the next open does).
        if (readSync(fd, b, 0, len, at) !== len) {
            this.damaged = true;
            this.forget();
            throw new Error("The turn store is incomplete.");
        }
        try {
            return JSON.parse((b[0] === 0x7b ? b : zstdDecompressSync(b)).toString("utf-8")) as T;
        } catch (e) {
            this.damaged = true;
            this.forget();
            throw e;
        }
    }

    /** Put a turn (or a sub-agent) in the store (its latest): where it went. */
    put(t: Turn | AgentRun): { at: number; len: number } {
        this.written = undefined;
        if (this.fd === undefined) this.end = this.open();
        const json = Buffer.from(JSON.stringify(t));
        const body = json.length < COMPRESS_FROM ? json : zstdCompressSync(json, { params: { [zlib.ZSTD_c_compressionLevel]: 1 } });
        // Each on a line of its own, as it was: a compressed one may hold newlines (it's read by place, never by line).
        const b = Buffer.allocUnsafe(body.length + 1);
        body.copy(b);
        b[body.length] = 0x0a;
        // Written whole or not at all (a full disk): an index never points at a turn half written.
        if (writeSync(this.fd!, b, 0, b.length, this.end) !== b.length) throw new Error("The turn store couldn't be written.");
        const at = this.end;
        this.end += b.length;
        return { at, len: b.length - 1 };
    }

    /** How much of it there is, old versions of turns included. */
    get size(): number {
        return this.end;
    }

    /**
     * Rewritten with only `kept` (what the index will point at), in their order, when the rest (versions since
     * replaced) is most of it: where each went, by where it was. Before the index is written: the old index points
     * into the old file, and a store whose index doesn't match its logs isn't read.
     */
    async compact(kept: { at: number; len: number }[]): Promise<Map<number, number> | undefined> {
        const live = kept.reduce((n, k) => n + k.len + 1, 0);
        if (this.end <= 2 * live + COMPACT_SLACK) return undefined;
        const moved = new Map<number, number>();
        const tmp = `${this.file}.${process.pid}.tmp`;
        const out = openSync(tmp, "w", 0o600);
        try {
            let end = 0;
            for (const k of kept) {
                if (moved.has(k.at)) continue;
                const b = Buffer.allocUnsafe(k.len + 1);
                const read = readSync(this.fd ?? (this.open(), this.fd!), b, 0, k.len, k.at);
                b[k.len] = 0x0a;
                if (read !== k.len || writeSync(out, b, 0, b.length, end) !== b.length) throw new Error("The turn store couldn't be rewritten.");
                moved.set(k.at, end);
                end += b.length;
            }
            await synced(out);
        } catch (e) {
            closeSync(out);
            rmSync(tmp, { force: true });
            throw e;
        }
        closeSync(out);
        // The index goes first: the store isn't read without one that matches it.
        this.forget();
        renameSync(tmp, this.file);
        this.closeData();
        this.end = this.open();
        return moved;
    }

    /** A rewrite (compact) another process didn't finish (it was stopped mid-way): its copy let go of. */
    private dropLeftovers() {
        const dir = dirname(this.file);
        const name = `${basename(this.file)}.`;
        let files: string[];
        try {
            files = readdirSync(dir);
        } catch {
            return;
        }
        for (const f of files) {
            if (!f.startsWith(name) || !f.endsWith(".tmp") || f === `${name}${process.pid}.tmp`) continue;
            rmSync(join(dir, f), { force: true });
        }
    }

    /** Starts the store afresh (the turns were built again: nothing in it is theirs). */
    clear() {
        this.close();
        this.written = undefined;
        rmSync(this.file, { force: true });
        rmSync(this.indexFile, { force: true });
    }

    /** The logs as they are now (taken as the session is let go of: writeIndex checks they're still so). */
    stamps(): LogStamp[] {
        return this.logs.map(stamp);
    }

    /**
     * Writes the index: each turn's head and place (in order) with its sub-agents, those kept with the latest, and the
     * logs as they are now. Written last, and whole (a new file put in place): a store without it, or with one from
     * before, isn't read. `as`: the logs as they were when the turns were taken (stamps()). Written to since (another
     * process took the session up meanwhile): no index, as it would vouch for turns that lack what was written.
     * `first`: the first prompt's text (Runtime.firstPrompt), which an open that reads only the last turns can't see.
     */
    async writeIndex(turns: StoredTurn[], agents: StoredAgent[], ids: number, ui: UiLight, as?: LogStamp[], first?: string) {
        if (this.damaged) return;
        const logs = this.logs.map(stamp);
        if (as && logs.some((l, i) => !sameLog(l, as[i]))) return;
        // Nothing put since, its logs and ids as they were, as many turns and sub-agents: it says this already. (A turn's
        // head changes as it's put again; the GUI log's state, with that log.)
        if (this.unchanged(turns.length, agents.length, ids, logs)) return;
        // Each sub-agent after its turn's line, or with those kept with the latest (an open reads those whatever their turn).
        const turnIds = new Set(turns.map((t) => t.head.id));
        const byTurn = new Map<string, number[]>();
        const kept: number[] = [];
        let failed = 0;
        agents.forEach((a, i) => {
            if (keptWithLatest(a.head) || !turnIds.has(a.head.turnId)) return void kept.push(i);
            if (a.head.status === "failed") failed++;
            const list = byTurn.get(a.head.turnId);
            if (list) list.push(i);
            else byTurn.set(a.head.turnId, [i]);
        });
        const agentLine = (i: number, keep?: true) => JSON.stringify({ k: "a", ...agents[i]!, i, ...(keep ? { keep } : {}) } satisfies IndexLine);
        const lines: string[] = [];
        for (const t of turns) {
            lines.push(JSON.stringify({ k: "t", head: t.head, at: t.at, len: t.len } satisfies IndexLine));
            for (const i of byTurn.get(t.head.id) ?? []) lines.push(agentLine(i));
            // Once: a turn's id twice (it shouldn't be) doesn't list its sub-agents twice.
            byTurn.delete(t.head.id);
        }
        for (const i of kept) lines.push(agentLine(i, true));
        const meta: Meta = { v: VERSION, logs, ids, turns: turns.length, agents: agents.length, failed, ...(first !== undefined ? { first } : {}), ui };
        lines.push(JSON.stringify(meta));
        // On the disk before the index that points into it is (a power cut leaves no index over turns that aren't).
        // Off the server's thread: 30-44 ms for a 30,000-item session's store, at its close (Linux).
        if (this.fd !== undefined) await synced(this.fd);
        mkdirSync(dirname(this.indexFile), { recursive: true, mode: 0o700 });
        const tmp = `${this.indexFile}.${process.pid}.tmp`;
        writeFileSync(tmp, lines.join("\n") + "\n", { mode: 0o600 });
        renameSync(tmp, this.indexFile);
        this.written = { logs, ids, turns: turns.length, agents: agents.length };
    }

    /** Not to be read until written again: the logs are about to change in ways it doesn't know (a rewind). */
    forget() {
        this.written = undefined;
        rmSync(this.indexFile, { force: true });
    }

    /** Let go of: its files closed (turns of its index not read yet aren't read now). */
    close() {
        this.closeData();
        this.closeIndex();
    }

    private closeData() {
        if (this.fd !== undefined) closeSync(this.fd);
        this.fd = undefined;
    }

    private open(): number {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        this.fd = openSync(this.file, existsSync(this.file) ? "r+" : "w+", 0o600);
        return fstatSync(this.fd).size;
    }
}
