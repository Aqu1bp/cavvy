// Searching what was said in every session: the prompts and the replies,
// read straight from the session files (no session is loaded or locked, and
// nothing is written). What each file says is kept by size and mtime, so the
// next keystroke reads only what changed. Tool output, thinking and images
// aren't searched, and lines too long to be worth parsing (a pasted image's
// base64) are only counted.

import { closeSync, lstatSync, openSync, readdirSync, readSync } from "fs";
import { basename, dirname, join } from "path";
import { paths } from "../config/paths";
import type { Message } from "../providers/types";
import { redact, redactionVersion } from "../util/redact";
import { promptText, STEERING, withoutActionsNote } from "./history";
import { foldCase } from "./protocol";

const CHUNK_BYTES = 256 * 1024;
/** Enough of a line to see its record type. */
const PREFIX_BYTES = 32;
/** Longer lines (images, huge pastes) are counted, not parsed. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** A message's text beyond this isn't searched. */
const MAX_TEXT = 256 * 1024;
const MSG_PREFIX = '{"t":"msg"';
/** How much of a file before where its reading ended is kept, to tell later that it's only grown since. */
const TAIL_BYTES = 256;
const WANTED = /^\{"t":"(msg|meta|title|compact|rewind|withdraw)"/;

/** Hits from one session, at most (a session that says the word often doesn't fill the list). */
const PER_SESSION = 3;
const SNIPPET_BEFORE = 50;
const SNIPPET_AFTER = 110;

export const SEARCH_LIMITS = {
    /** Per query: reading stops after this long or this many bytes, and what was found so far is returned. */
    budgetMs: 2500,
    budgetBytes: 768 * 1024 * 1024,
    /** What's kept across queries, in characters (each piece of text, its folded copy, and a cost per entry, turn start and session). */
    cacheChars: 64 * 1024 * 1024,
    /** Turn times kept across queries, in records (and one for each log). */
    cacheTurnTimes: 200_000,
};

/**
 * A session's runs of three characters, each a bit in a set about four times as many bits as its text has characters
 * (a run that hashes to an unset bit isn't in it; one that's set may be). A search for something with a run none of
 * its messages has skips it without looking through them: with 10,000 sessions, one for a word found nowhere read 20
 * million characters, every one of them, at the first keystroke that had it.
 */
const GRAM_BITS_PER_CHAR = 4;
const GRAM_MIN_BITS = 1 << 9;
const GRAM_MAX_BITS = 1 << 20;
const gram = (a: number, b: number, c: number) => (Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca77) ^ Math.imul(c, 0xc2b2ae3d)) >>> 0;
function gramsOf(entries: readonly Entry[]): Uint32Array {
    const chars = entries.reduce((n, e) => n + e.folded.length, 0);
    let bits = GRAM_MIN_BITS;
    while (bits < chars * GRAM_BITS_PER_CHAR && bits < GRAM_MAX_BITS) bits <<= 1;
    const set = new Uint32Array(bits >>> 5);
    const mask = bits - 1;
    for (const e of entries) {
        const t = e.folded;
        for (let i = 0; i + 2 < t.length; i++) {
            const h = gram(t.charCodeAt(i), t.charCodeAt(i + 1), t.charCodeAt(i + 2)) & mask;
            set[h >>> 5]! |= 1 << (h & 31);
        }
    }
    return set;
}
/** The query's runs of three characters (none under three characters: then every session is looked through). */
function gramsOfQuery(fq: string): number[] {
    const out: number[] = [];
    for (let i = 0; i + 2 < fq.length; i++) out.push(gram(fq.charCodeAt(i), fq.charCodeAt(i + 1), fq.charCodeAt(i + 2)));
    return out;
}
/** Whether `doc` may have all of them (false: it can't). */
function mayHave(doc: Doc, wanted: readonly number[]): boolean {
    const set = doc.grams;
    if (!set || !wanted.length) return true;
    const mask = set.length * 32 - 1;
    for (const w of wanted) {
        const h = w & mask;
        if (!(set[h >>> 5]! & (1 << (h & 31)))) return false;
    }
    return true;
}

/** Rough cost, in characters, of what's kept besides the text itself. */
const ENTRY_COST = 64;
const START_COST = 32;
const DOC_COST = 256;
/** The listing yields (and checks the budget) after this many files. */
const LIST_TICK = 64;

interface Entry {
    seg: number;
    index: number;
    role: "user" | "assistant";
    text: string;
    folded: string;
}

interface Doc {
    size: number;
    mtimeMs: number;
    redaction: number;
    cwd?: string;
    title?: string;
    entries: Entry[];
    /** Where each turn starts (a prompt, a command, a steering message), as replay starts them. */
    starts: { seg: number; index: number }[];
    /** All it keeps, in characters (see SEARCH_LIMITS.cacheChars). */
    chars: number;
    /** Which runs of three characters its messages have (gramsOf): a search for something it can't have skips it. */
    grams?: Uint32Array;
    /**
     * Where its reading ended, for the next read of the file once it's grown (a session being written to grows all
     * the time, and searching while ten stream read each of them whole on every keystroke): from there, if what's
     * just before is still what was read. None when the file didn't end with a whole line.
     */
    resume?: { at: number; ino: number; tail: string; seg: number; count: number; first?: string; titleLine?: string };
}

interface TurnTimes {
    size: number;
    mtimeMs: number;
    /** "seg:index" of each prompt with its start. */
    turns: { seg: number; index: number; at: number }[];
}

const docs = new Map<string, Doc>();
const times = new Map<string, TurnTimes>();
let cachedChars = 0;
let cachedTimes = 0;

export function clearSearchCache() {
    listing = undefined;
    lastScan = undefined;
    docs.clear();
    times.clear();
    cachedChars = 0;
    cachedTimes = 0;
}

/** What the cache holds now (for tests). */
export function searchCacheSize(): { docs: number; chars: number; turnTimes: number; records: number } {
    return { docs: docs.size, chars: cachedChars, turnTimes: times.size, records: cachedTimes };
}

/** Not followed: a symlinked folder or file isn't part of the Cavvy home. */
function plainStat(path: string) {
    const st = lstatSync(path);
    return st.isSymbolicLink() ? undefined : st;
}

// ---------------------------------------------------------------------------
// Reading

class Control {
    bytes = 0;
    stopped?: "stale" | "budget";
    private readonly start = Date.now();
    private lastYield = Date.now();
    constructor(
        private readonly stale: () => boolean,
        private readonly budgetMs: number,
        private readonly budgetBytes: number,
    ) {}

    /**
     * As tick, without a wait when it's not yet time to let others run: a boolean then, else tick's promise. Searching
     * thousands of sessions already read, a wait at each was a third of a search for a word found nowhere.
     */
    check(): boolean | Promise<boolean> {
        if (Date.now() - this.lastYield > 8) return this.tick();
        if (this.stale()) this.stopped = "stale";
        else if (Date.now() - this.start > this.budgetMs || this.bytes > this.budgetBytes) this.stopped = "budget";
        return !this.stopped;
    }

    /** Lets other requests run now and then; false once this search should stop. */
    async tick(): Promise<boolean> {
        if (Date.now() - this.lastYield > 8) {
            await new Promise((r) => setImmediate(r));
            this.lastYield = Date.now();
        }
        if (this.stale()) this.stopped = "stale";
        else if (Date.now() - this.start > this.budgetMs || this.bytes > this.budgetBytes) this.stopped = "budget";
        return !this.stopped;
    }
}

/**
 * Whether the bytes fed are one whole JSON value: braces balanced outside
 * strings, nothing after. A line too long to parse that a crash cut short
 * isn't (replay's JSON.parse skips it, so it mustn't be counted either).
 */
class WholeJson {
    private depth = 0;
    private str = false;
    private esc = false;
    private opened = false;
    private closed = false;
    private bad = false;

    feed(b: Uint8Array) {
        for (let i = 0; i < b.length; i++) {
            const c = b[i]!;
            if (this.str) {
                if (this.esc) this.esc = false;
                else if (c === 92) this.esc = true;
                else if (c === 34) this.str = false;
            } else if (this.closed) {
                if (c !== 32 && c !== 9 && c !== 13) this.bad = true;
            } else if (c === 34) this.str = true;
            else if (c === 123 || c === 91) {
                this.depth++;
                this.opened = true;
            } else if (c === 125 || c === 93) {
                if (--this.depth === 0) this.closed = true;
                else if (this.depth < 0) this.bad = true;
            }
        }
    }

    get whole(): boolean {
        return this.opened && this.closed && !this.bad;
    }
}

/**
 * Each line whose start `want`s it, whole (undefined when it's longer than
 * MAX_LINE_BYTES, with whether it was still whole JSON). Other lines are
 * skipped as they're read. False when the search stopped halfway.
 */
async function scanLines(file: string, want: (prefix: string) => boolean, fn: (prefix: string, line: string | undefined, whole: boolean) => void, ctl: Control, from = 0, ended?: { at: number; torn: boolean }): Promise<boolean> {
    const fd = openSync(file, "r");
    try {
        const chunk = Buffer.alloc(CHUNK_BYTES);
        let parts: Buffer[] = [];
        let len = 0;
        let prefix = "";
        let wanted: boolean | undefined;
        let over: WholeJson | undefined;
        const decide = () => {
            prefix = Buffer.concat(parts).subarray(0, PREFIX_BYTES).toString("latin1");
            wanted = want(prefix);
            if (!wanted) parts = [];
        };
        const emit = () => {
            if (wanted === undefined) decide();
            if (wanted) fn(prefix, over ? undefined : Buffer.concat(parts).toString("utf-8"), over ? over.whole : true);
            parts = [];
            len = 0;
            prefix = "";
            wanted = undefined;
            over = undefined;
        };
        let chunks = 0;
        // Where the last line read to its newline ends: a later read of the file, grown since, goes on from there.
        let lineEnd = from;
        for (let pos = from, n: number; (n = readSync(fd, chunk, 0, chunk.length, pos)) > 0; pos += n) {
            ctl.bytes += n;
            if (++chunks % 8 === 0 && !(await ctl.tick())) return false;
            const c = chunk.subarray(0, n);
            for (let start = 0; start < n; ) {
                const nl = c.indexOf(10, start);
                const piece = c.subarray(start, nl < 0 ? n : nl);
                if (over) over.feed(piece);
                else if (wanted !== false) {
                    parts.push(Buffer.from(piece)); // chunk is reused
                    len += piece.length;
                }
                if (wanted === undefined && len >= PREFIX_BYTES) decide();
                if (wanted && !over && len > MAX_LINE_BYTES) {
                    over = new WholeJson();
                    for (const part of parts) over.feed(part);
                    parts = [];
                }
                if (nl < 0) break;
                emit();
                start = nl + 1;
                lineEnd = pos + start;
            }
        }
        // A last line without its newline still counts if it's whole, as readSegments has it.
        const torn = Boolean(len || over);
        if (torn) emit();
        if (ended) Object.assign(ended, { at: lineEnd, torn });
        return true;
    } finally {
        closeSync(fd);
    }
}

/** A message that starts a turn in replay: a prompt, a command, or a steering message riding with tool results. */
function startsTurn(m: Message): boolean {
    if (m?.role !== "user" || !Array.isArray(m.content)) return false;
    const kind = m.meta?.kind ?? "prompt";
    if (kind === "prompt" || kind === "command" || kind === "wake") return true;
    return kind === "tool_results" && m.content.some((p) => p.type === "text" && p.text.startsWith(STEERING));
}

/** Redact both the stored form and the whole whitespace-folded display form before cutting either. */
function displayText(text: string): string {
    return redact(redact(text).replace(/\s+/g, " "));
}

/** A message's text up to MAX_TEXT, redacted before it's cut (a key cut in two isn't recognized), and cut between words. */
function clip(text: string): string {
    if (text.length <= MAX_TEXT) return text;
    const red = redact(text).slice(0, MAX_TEXT);
    const gap = red.search(/\s\S*$/);
    return gap > MAX_TEXT - 4096 ? red.slice(0, gap) : red;
}

function textOfParts(m: Message, keep: (text: string) => string | undefined): string {
    const out: string[] = [];
    for (const p of m.content as { type: string; text?: unknown }[]) {
        if (p.type !== "text" || typeof p.text !== "string") continue;
        const t = keep(p.text);
        if (t) out.push(t);
    }
    return out.join("\n\n");
}

/** The searchable text of a message: a prompt, a steering message, a reply. Tool results, thinking and images aren't. */
function messageText(m: Message, clean = (text: string) => text): { role: "user" | "assistant"; text: string } | undefined {
    if (!m || !Array.isArray(m.content)) return undefined;
    if (m.role === "user") {
        const kind = m.meta?.kind ?? "prompt";
        if (kind === "prompt" || kind === "command") return { role: "user", text: promptText({
            ...m,
            content: m.content.map((p) => p.type === "text" ? { ...p, text: clean(p.text) } : p),
            ...(m.meta?.display !== undefined ? { meta: { ...m.meta, display: clean(m.meta.display) } } : {}),
        }) };
        if (kind === "tool_results") return { role: "user", text: textOfParts(m, (t) => (t.startsWith(STEERING) ? clean(t.slice(STEERING.length)).trim() : undefined)) };
        return undefined;
    }
    if (m.role === "assistant") return { role: "assistant", text: withoutActionsNote(clean(textOfParts(m, (t) => t))) };
    return undefined;
}

/** A session file as search sees it: its messages' text, placed the way replay places them (compactions, rewinds). */
async function readDoc(file: string, size: number, mtimeMs: number, ctl: Control, ino = 0, had?: Doc): Promise<Doc | undefined> {
    const from = had && had.redaction === redactionVersion() && had.resume && had.resume.ino === ino && size >= had.resume.at && tailAt(file, had.resume.at) === had.resume.tail ? had.resume : undefined;
    const doc: Doc = from && had
        ? { size, mtimeMs, redaction: had.redaction, cwd: had.cwd, title: from.titleLine, entries: [...had.entries], starts: [...had.starts], chars: 0 }
        : { size, mtimeMs, redaction: redactionVersion(), entries: [], starts: [], chars: 0 };
    let seg = from?.seg ?? 0;
    let count = from?.count ?? 0;
    let first: string | undefined = from?.first;
    const ended = { at: 0, torn: false };
    const done = await scanLines(
        file,
        (prefix) => WANTED.test(prefix),
        (prefix, line, whole) => {
            if (line === undefined) {
                // Too long to read; it still takes its place, unless it's torn.
                if (prefix.startsWith(MSG_PREFIX) && whole) count++;
                return;
            }
            let l: { t?: string; m?: Message; cwd?: unknown; title?: unknown; count?: unknown; kept?: unknown; index?: unknown };
            try {
                l = JSON.parse(line);
            } catch {
                return; // torn
            }
            if (l.t === "msg" && l.m) {
                try {
                    if (startsTurn(l.m)) doc.starts.push({ seg, index: count });
                    const found = messageText(l.m);
                    // Match the original text, but redact display text before
                    // replay's trimming/reminder removal or our size cap.
                    const text = found && clip(displayText(messageText(l.m, redact)!.text));
                    if (found && text) {
                        doc.entries.push({ seg, index: count, role: found.role, text, folded: foldCase(clip(found.text)) });
                        if (found.role === "user" && first === undefined && seg === 0) first = text;
                    }
                } catch {
                    // a message of a shape this doesn't know
                }
                count++;
            } else if (l.t === "meta" && typeof l.cwd === "string") doc.cwd = l.cwd;
            else if (l.t === "title" && typeof l.title === "string") doc.title = l.title;
            else if (l.t === "compact") {
                // A prompt it kept is shown where it went on (replay), and found there.
                if (l.kept === true) {
                    const moved = count - 1;
                    doc.entries = doc.entries.filter((e) => e.seg !== seg || e.index !== moved);
                    doc.starts = doc.starts.filter((t) => t.seg !== seg || t.index !== moved);
                }
                seg++;
                count = 0;
            } else if (l.t === "rewind" && typeof l.count === "number") {
                const keep = l.count;
                count = Math.min(count, keep);
                doc.entries = doc.entries.filter((e) => e.seg !== seg || e.index < keep);
                doc.starts = doc.starts.filter((t) => t.seg !== seg || t.index < keep);
                if (seg === 0 && !doc.entries.some((e) => e.role === "user")) first = undefined;
            } else if (l.t === "withdraw" && typeof l.index === "number" && l.index < count) {
                // As Session.withdraw: the message goes, what came after it moves back one.
                const at = l.index;
                count--;
                const moved = <T extends { seg: number; index: number }>(xs: T[]) => xs.filter((e) => e.seg !== seg || e.index !== at).map((e) => (e.seg === seg && e.index > at ? { ...e, index: e.index - 1 } : e));
                doc.entries = moved(doc.entries);
                doc.starts = moved(doc.starts);
            }
        },
        ctl,
        from?.at ?? 0,
        ended,
    );
    if (!done) return undefined;
    if (!ended.torn && ino) doc.resume = { at: ended.at, ino, tail: tailAt(file, ended.at), seg, count, first, titleLine: doc.title };
    if (!doc.title) doc.title = first ?? doc.entries.find((e) => e.role === "user")?.text;
    doc.grams = gramsOf(doc.entries);
    doc.chars = DOC_COST + (doc.cwd?.length ?? 0) + (doc.title?.length ?? 0) + doc.starts.length * START_COST + doc.entries.reduce((n, e) => n + e.text.length + e.folded.length + ENTRY_COST, 0) + doc.grams.length * 2;
    return doc;
}

/** What's just before `at` in the file (what a read that ended there last saw), to tell it's the same file grown. */
function tailAt(file: string, at: number): string {
    const n = Math.min(TAIL_BYTES, at);
    if (!n) return "";
    const fd = openSync(file, "r");
    try {
        const b = Buffer.alloc(n);
        return b.subarray(0, readSync(fd, b, 0, n, at - n)).toString("latin1");
    } finally {
        closeSync(fd);
    }
}

function remember(file: string, doc: Doc) {
    const old = docs.get(file);
    if (old) cachedChars -= old.chars;
    docs.delete(file);
    docs.set(file, doc);
    cachedChars += doc.chars;
    // Oldest first out.
    for (const [f, d] of docs) {
        if (cachedChars <= SEARCH_LIMITS.cacheChars) break;
        docs.delete(f);
        cachedChars -= d.chars;
    }
}

/** A log's place in the cache: its records, and one for itself (a log with none still takes room). */
const timesCost = (turns: TurnTimes["turns"]) => 1 + turns.length;

/** When each prompt started, from the GUI's log next to the transcript (ui/<id>.jsonl). */
async function turnTimes(sessionFile: string, id: string, ctl: Control): Promise<TurnTimes["turns"]> {
    const file = join(dirname(sessionFile), "ui", `${id}.jsonl`);
    let st;
    try {
        // The ui folder as well as the log: a link to a folder elsewhere isn't followed either.
        if (!plainStat(dirname(file))?.isDirectory()) return [];
        st = plainStat(file);
    } catch {
        return [];
    }
    if (!st?.isFile()) return [];
    const cached = times.get(file);
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.turns;
    const turns: TurnTimes["turns"] = [];
    const done = await scanLines(
        file,
        (prefix) => prefix.startsWith('{"t":"turn"'),
        (_prefix, line) => {
            if (!line) return;
            try {
                const r = JSON.parse(line) as { seg?: unknown; index?: unknown; at?: unknown };
                if (typeof r.seg === "number" && typeof r.index === "number" && typeof r.at === "number") turns.push({ seg: r.seg, index: r.index, at: r.at });
            } catch {
                // torn
            }
        },
        ctl,
    ).catch(() => false);
    if (!done) return turns;
    const old = times.get(file);
    if (old) cachedTimes -= timesCost(old.turns);
    times.delete(file);
    times.set(file, { size: st.size, mtimeMs: st.mtimeMs, turns });
    cachedTimes += timesCost(turns);
    // Oldest first out, by records (one log can hold many).
    for (const [f, t] of times) {
        if (cachedTimes <= SEARCH_LIMITS.cacheTurnTimes) break;
        times.delete(f);
        cachedTimes -= timesCost(t.turns);
    }
    return turns;
}

// ---------------------------------------------------------------------------
// Matching

/** Position after folding the whitespace before the original match. */
function foldedAt(text: string, at: number): number {
    return text.slice(0, at).replace(/\s+/g, " ").length;
}

/**
 * The part of `text` around the match at `at`, whitespace folded, redacted
 * (the transcript was redacted when written; a key registered since, or one
 * the patterns learned later, still isn't shown).
 */
export function snippetAround(text: string, at: number, query: string): { snippet: string; match?: [number, number] } {
    // The whole message, before any of it is cut: a secret of any length is only recognized whole.
    const red = displayText(text);
    at = foldedAt(text, at);
    // Redaction and whitespace folding may move the match (or swallow it): take the nearest one.
    query = query.replace(/\s+/g, " ");
    const fr = foldCase(red);
    const fq = foldCase(query);
    let m = -1;
    for (let i = fr.indexOf(fq); i >= 0; i = fr.indexOf(fq, i + 1)) {
        if (m < 0 || Math.abs(i - at) < Math.abs(m - at)) m = i;
        if (i > at) break;
    }
    const centre = m >= 0 ? m : Math.min(at, red.length);
    const qlen = m >= 0 ? query.length : 0;
    let start = Math.max(0, centre - SNIPPET_BEFORE);
    // Not mid-word, when a space is near.
    if (start > 0) {
        const sp = red.slice(start, centre).search(/\s/);
        if (sp >= 0 && sp < 16) start += sp + 1;
    }
    const stop = Math.min(red.length, centre + qlen + SNIPPET_AFTER);
    const pre = (start > 0 ? "…" : "") + red.slice(start, centre).trimStart();
    const mid = red.slice(centre, centre + qlen);
    const post = red.slice(centre + qlen, stop).trimEnd() + (stop < red.length ? "…" : "");
    return { snippet: pre + mid + post, ...(m >= 0 ? { match: [pre.length, pre.length + mid.length] as [number, number] } : {}) };
}

export interface SearchHit {
    id: string;
    file: string;
    cwd: string;
    title: string;
    updatedAt: number;
    seg: number;
    index: number;
    role: "user" | "assistant";
    snippet: string;
    match?: [number, number];
    at: number;
}

export interface SearchOptions {
    limit?: number;
    /** Which sessions to look in, by id (archived or not). */
    include?: (id: string) => boolean;
    /** True once a newer search replaced this one: it stops. */
    stale?: () => boolean;
    budgetMs?: number;
    budgetBytes?: number;
}

/** Every session file, newest first; undefined when the search stopped while listing them. */
type Listed = { id: string; file: string; size: number; mtimeMs: number; ino: number };

/** The session files as last listed: the same list again while none has changed (lastScan holds to it). */
let listing: Listed[] | undefined;
/** When the files were last listed whole, and each project folder's mtime then (a file put in or taken out changes it). */
let listedAt = -Infinity;
let folders: Map<string, number> | undefined;
/**
 * Typed into, a search a keystroke: within this of the last whole listing, only the newest RECENT files are looked at
 * again (what's being written to is among them), not each one of thousands (10,000 sessions: 23 of a search's 26 ms).
 * One older than those, written to meanwhile by another process, is seen at the next whole listing.
 */
const LIST_FRESH_MS = 1000;
const RECENT = 64;

function foldersAsListed(): boolean {
    if (!folders) return false;
    try {
        const root = paths.projectsDir();
        const dirs = readdirSync(root);
        if (dirs.length !== folders.size) return false;
        for (const d of dirs) if (plainStat(join(root, d))?.mtimeMs !== folders.get(d)) return false;
        return true;
    } catch {
        return false;
    }
}

/** The session files, newest first. The list from before when every one is as it was then. */
async function sessionFiles(ctl: Control): Promise<Listed[] | undefined> {
    const was = listing;
    if (was && performance.now() - listedAt < LIST_FRESH_MS && foldersAsListed()) {
        let changed = false;
        const head = was.slice(0, RECENT).map((f) => {
            const st = plainStat(f.file);
            if (st && st.size === f.size && st.mtimeMs === f.mtimeMs && st.ino === f.ino) return f;
            changed = true;
            return st?.isFile() ? { ...f, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino } : undefined;
        });
        if (!changed) return was;
        listing = [...head.filter((f): f is Listed => f !== undefined), ...was.slice(RECENT)].sort((x, y) => y.mtimeMs - x.mtimeMs);
        return listing;
    }
    const files = await listSessionFiles(ctl);
    if (!files) return undefined;
    listedAt = performance.now();
    if (was && was.length === files.length && files.every((f, i) => f.file === was[i]!.file && f.size === was[i]!.size && f.mtimeMs === was[i]!.mtimeMs && f.ino === was[i]!.ino)) return was;
    listing = files;
    return files;
}

async function listSessionFiles(ctl: Control): Promise<Listed[] | undefined> {
    const root = paths.projectsDir();
    const out: { id: string; file: string; size: number; mtimeMs: number; ino: number }[] = [];
    let dirs: string[];
    try {
        dirs = readdirSync(root);
    } catch {
        return out;
    }
    let seen = 0;
    const stamps = new Map<string, number>();
    for (const d of dirs) {
        if (!(await ctl.tick())) return undefined;
        const dir = join(root, d);
        let names: string[];
        try {
            const st = plainStat(dir);
            if (st) stamps.set(d, st.mtimeMs);
            if (!st?.isDirectory()) continue;
            names = readdirSync(dir);
        } catch {
            continue;
        }
        for (const f of names) {
            if (!f.endsWith(".jsonl")) continue;
            // A folder of thousands: other requests still run, and a newer search or the budget still stops it.
            if (++seen % LIST_TICK === 0 && !(await ctl.tick())) return undefined;
            const file = join(dir, f);
            try {
                const st = plainStat(file);
                if (st?.isFile()) out.push({ id: f.slice(0, -".jsonl".length), file, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
            } catch {
                // vanished or unreadable
            }
        }
    }
    out.sort((x, y) => y.mtimeMs - x.mtimeMs);
    // The budget may have run out while listing: then nothing after it counts as whole.
    if (!(await ctl.tick())) return undefined;
    folders = stamps;
    return out;
}

/**
 * The session files read into the cache ahead of the first search, newest first, while there's room (what a
 * search would read anyway, before it's asked): it yields as a search does. The number read; it stops when the
 * secrets used to redact change, or `stale` says so.
 */
export async function warmSearch(o: { stale?: () => boolean } = {}): Promise<number> {
    const redaction = redactionVersion();
    const ctl = new Control(() => redaction !== redactionVersion() || Boolean(o.stale?.()), Number.POSITIVE_INFINITY, SEARCH_LIMITS.budgetBytes);
    let read = 0;
    for (const f of (await sessionFiles(ctl)) ?? []) {
        if (cachedChars >= SEARCH_LIMITS.cacheChars * 0.9 || !(await ctl.tick())) break;
        const had = docs.get(f.file);
        if (had && had.size === f.size && had.mtimeMs === f.mtimeMs && had.redaction === redaction) continue;
        let doc: Doc | undefined;
        try {
            doc = await readDoc(f.file, f.size, f.mtimeMs, ctl, f.ino, docs.get(f.file));
        } catch {
            continue; // vanished or unreadable
        }
        if (!doc) break;
        remember(f.file, doc);
        read++;
    }
    return read;
}

/**
 * Messages containing `query` (a literal, in any case), newest sessions
 * first, at most PER_SESSION from one session. Stops early, with what it has
 * (`partial`), when the budget runs out; with nothing (`stale`) when replaced.
 */
/**
 * The last search that went through every session (none stopped it, nor its limit): what it was, in which listing
 * (the same while no file has changed: sessionFiles), and the sessions it was found in. A query that has it in it can
 * only be in those (typing on: each keystroke a search, and each went through all of them again).
 */
let lastScan: { fq: string; files: Listed[]; redaction: number; found: Set<string> } | undefined;

export async function searchSessions(query: string, o: SearchOptions = {}): Promise<{ hits: SearchHit[]; partial: boolean; stale: boolean }> {
    const limit = Math.max(1, Math.min(o.limit ?? 50, 200));
    const fq = foldCase(query);
    const redaction = redactionVersion();
    const outdated = () => redaction !== redactionVersion() || Boolean(o.stale?.());
    const ctl = new Control(outdated, o.budgetMs ?? SEARCH_LIMITS.budgetMs, o.budgetBytes ?? SEARCH_LIMITS.budgetBytes);
    const hits: SearchHit[] = [];
    if (!fq) return { hits, partial: false, stale: false };
    const files = (await sessionFiles(ctl)) ?? [];
    // Typed on from a query whose search went through every session: only those it was found in can have this one.
    const narrowed = !o.include && lastScan?.files === files && lastScan.redaction === redaction && fq.includes(lastScan.fq) ? lastScan.found : undefined;
    // Each session it's found in, while it's gone through all of them (a search stopped at `limit` hasn't).
    const found = new Set<string>();
    const wanted = gramsOfQuery(fq);
    let whole = true;
    for (const f of files) {
        if (hits.length >= limit) {
            whole = false;
            break;
        }
        if (narrowed && !narrowed.has(f.file)) continue;
        if (o.include && !o.include(f.id)) continue;
        const go = ctl.check();
        if (!(go === true || (go !== false && (await go)))) break;
        let doc = docs.get(f.file);
        if (!doc || doc.size !== f.size || doc.mtimeMs !== f.mtimeMs || doc.redaction !== redactionVersion()) {
            try {
                doc = await readDoc(f.file, f.size, f.mtimeMs, ctl, f.ino, docs.get(f.file));
            } catch {
                continue; // vanished or unreadable
            }
            if (!doc) break; // stopped halfway
            remember(f.file, doc);
        }
        if (!doc.cwd) continue;
        if (!mayHave(doc, wanted)) continue;
        const inDoc: { e: Entry; at: number }[] = [];
        for (const e of doc.entries) {
            const at = e.folded.indexOf(fq);
            if (at < 0) continue;
            inDoc.push({ e, at });
            if (inDoc.length >= PER_SESSION) break;
        }
        if (!inDoc.length) continue;
        found.add(f.file);
        const turns = await turnTimes(f.file, f.id, ctl);
        for (const { e, at } of inDoc) {
            if (hits.length >= limit) break;
            // The turn it's in: the last start at or before it (not one a rewind took away), and
            // when that started: the latest record for its place, as UiLog has it (a rewind reuses places).
            let start: { seg: number; index: number } | undefined;
            for (const t of doc.starts) if (t.seg === e.seg && t.index <= e.index) start = t;
            let when: number | undefined;
            if (start) for (const t of turns) if (t.seg === start.seg && t.index === start.index) when = t.at;
            hits.push({
                id: f.id,
                file: f.file,
                cwd: doc.cwd,
                // Redacted whole, before it's cut: a key cut short isn't recognized.
                title: displayText(redact(doc.title ?? "(untitled)").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")).trim().slice(0, 120) || basename(doc.cwd),
                updatedAt: f.mtimeMs,
                seg: e.seg,
                index: e.index,
                role: e.role,
                ...snippetAround(e.text, foldedAt(e.folded, at), query),
                at: when ?? f.mtimeMs,
            });
        }
    }
    // Registration can happen at any yield, even after an earlier hit was built.
    // Never return snippets assembled under the old secret registry.
    const stale = ctl.stopped === "stale" || outdated();
    if (whole && !ctl.stopped && !stale && !o.include) lastScan = { fq, files, redaction, found };
    return { hits: stale ? [] : hits, partial: stale || Boolean(ctl.stopped), stale };
}
