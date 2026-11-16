// A session's turns as they were built (replay), kept beside its logs, so the server needn't keep them all in memory,
// nor build them all again each time the session is opened. A long session's turns are its whole content (what each
// tool printed, each diff): the server kept every one, 132 MB for 30,000 items of a Claude Code session.
//
// <project>/turns/<id>.jsonl holds turns, a line each, appended (the latest line for a turn is it); <id>.json is the
// index: each turn's place in the store and what the turn is without its blocks (the window's list, and what the
// server keeps of a turn it lets go of), the sub-agents, and the session's logs as they were when it was written.
// Written as the session is closed: a session opened again with its logs unchanged since opens from it. One whose
// logs changed (a crash after the store was written, the session written to elsewhere) doesn't: it's built again.

import { closeSync, existsSync, fstatSync, fsync, readdirSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from "fs";
import { basename, dirname, join } from "path";
import type { UiLight } from "./history";
import type { AgentRun, Turn } from "./protocol";

/** The store's format: an index of another is not read. */
const VERSION = 3;
/** Old versions of turns the store may hold beyond twice what's current, before it's rewritten without them. */
const COMPACT_SLACK = 8 * 1024 * 1024;
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

interface Index {
    v: number;
    logs: LogStamp[];
    /** The runtime's id counter when it was written: new ids go on from there, so none is used twice. */
    ids: number;
    turns: { head: TurnHead; at: number; len: number }[];
    /** Sub-agents: each as its list shows it (AgentHead), and where it is whole in the store, if it's there. */
    agents: StoredAgent[];
    /** The GUI log, light (UiLog.lightState): the session's opened without reading it. */
    ui: UiLight;
}

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

    private constructor(dir: string, id: string, private readonly logs: string[]) {
        this.file = join(dir, `${id}.jsonl`);
        this.indexFile = join(dir, `${id}.json`);
    }

    /** The store of the session in `sessionFile`, whose logs are `logs` (the session's file and its GUI log). */
    static of(sessionFile: string, id: string, logs: string[]): TurnStore {
        return new TurnStore(join(dirname(sessionFile), "turns"), id, logs);
    }

    /** What it was when written, if its logs are still as they were then (else nothing: the turns are built again). */
    read(): { heads: { head: TurnHead; at: number; len: number }[]; agents: StoredAgent[]; ids: number; ui: UiLight } | undefined {
        this.dropLeftovers();
        let index: Index;
        try {
            index = JSON.parse(readFileSync(this.indexFile, "utf-8")) as Index;
        } catch {
            return undefined;
        }
        if (index.v !== VERSION || index.logs.length !== this.logs.length || !index.ui) return undefined;
        const stamps: LogStamp[] = [];
        for (let i = 0; i < this.logs.length; i++) {
            const now = stamp(this.logs[i]!);
            stamps.push(now);
            // Another file in its place (restored from a backup, synced) of the same size and end: not the one it was.
            if (now.size !== index.logs[i]!.size || now.tail !== index.logs[i]!.tail || now.ino !== index.logs[i]!.ino) return undefined;
        }
        if (!existsSync(this.file)) return undefined;
        this.end = this.open();
        // The logs as just read (the same): not the index's own, whose strings may hold on to the whole index text.
        this.written = { logs: stamps, ids: index.ids, turns: index.turns.length, agents: index.agents.length };
        return { heads: index.turns, agents: index.agents, ids: index.ids, ui: index.ui };
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
            return JSON.parse(b.toString("utf-8")) as T;
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
        const b = Buffer.from(JSON.stringify(t) + "\n");
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
        this.close();
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

    /**
     * Writes the index: each turn's head and place (in order), the sub-agents, and the logs as they are now. Written
     * last, and whole (a new file put in place): a store without it, or with one from before, isn't read.
     */
    /** The logs as they are now (taken as the session is let go of: writeIndex checks they're still so). */
    stamps(): LogStamp[] {
        return this.logs.map(stamp);
    }

    /**
     * `as`: the logs as they were when the turns were taken (stamps()). Written to since (another process took the
     * session up meanwhile): no index, as it would vouch for turns that lack what was written.
     */
    async writeIndex(turns: { head: TurnHead; at: number; len: number }[], agents: StoredAgent[], ids: number, ui: UiLight, as?: LogStamp[]) {
        if (this.damaged) return;
        const logs = this.logs.map(stamp);
        if (as && logs.some((l, i) => l.size !== as[i]?.size || l.tail !== as[i]?.tail || l.ino !== as[i]?.ino)) return;
        // Nothing put since, its logs and ids as they were, as many turns and sub-agents: it says this already. (A turn's
        // head changes as it's put again; the GUI log's state, with that log.)
        const was = this.written;
        if (was && was.ids === ids && was.turns === turns.length && was.agents === agents.length && logs.every((l, i) => l.size === was.logs[i]?.size && l.tail === was.logs[i]?.tail && l.ino === was.logs[i]?.ino)) return;
        const index: Index = { v: VERSION, logs, ids, turns, agents, ui };
        // On the disk before the index that points into it is (a power cut leaves no index over turns that aren't).
        // Off the server's thread: 30-44 ms for a 30,000-item session's store, at its close (Linux).
        if (this.fd !== undefined) await synced(this.fd);
        mkdirSync(dirname(this.indexFile), { recursive: true, mode: 0o700 });
        const tmp = `${this.indexFile}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(index), { mode: 0o600 });
        renameSync(tmp, this.indexFile);
        this.written = { logs, ids, turns: turns.length, agents: agents.length };
    }

    /** Not to be read until written again: the logs are about to change in ways it doesn't know (a rewind). */
    forget() {
        this.written = undefined;
        rmSync(this.indexFile, { force: true });
    }

    close() {
        if (this.fd !== undefined) closeSync(this.fd);
        this.fd = undefined;
    }

    private open(): number {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        this.fd = openSync(this.file, existsSync(this.file) ? "r+" : "w+", 0o600);
        return fstatSync(this.fd).size;
    }
}
