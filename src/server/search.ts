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
const WANTED = /^\{"t":"(msg|meta|title|compact|rewind)"/;

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
    docs.clear();
    times.clear();
    cachedChars = 0;
    cachedTimes = 0;
}

/** What the cache holds now (for tests). */
export function searchCacheSize(): { docs: number; chars: number; turnTimes: number; records: number } {
    return { docs: docs.size, chars: cachedChars, turnTimes: times.size, records: cachedTimes };
}

/** Not followed: a symlinked folder or file isn't part of the Harness home. */
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
async function scanLines(file: string, want: (prefix: string) => boolean, fn: (prefix: string, line: string | undefined, whole: boolean) => void, ctl: Control): Promise<boolean> {
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
        for (let pos = 0, n: number; (n = readSync(fd, chunk, 0, chunk.length, pos)) > 0; pos += n) {
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
            }
        }
        // A last line without its newline still counts if it's whole, as readSegments has it.
        if (len || over) emit();
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
async function readDoc(file: string, size: number, mtimeMs: number, ctl: Control): Promise<Doc | undefined> {
    const doc: Doc = { size, mtimeMs, redaction: redactionVersion(), entries: [], starts: [], chars: 0 };
    let seg = 0;
    let count = 0;
    let first: string | undefined;
    const done = await scanLines(
        file,
        (prefix) => WANTED.test(prefix),
        (prefix, line, whole) => {
            if (line === undefined) {
                // Too long to read; it still takes its place, unless it's torn.
                if (prefix.startsWith(MSG_PREFIX) && whole) count++;
                return;
            }
            let l: { t?: string; m?: Message; cwd?: unknown; title?: unknown; count?: unknown; kept?: unknown };
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
            }
        },
        ctl,
    );
    if (!done) return undefined;
    if (!doc.title) doc.title = first ?? doc.entries.find((e) => e.role === "user")?.text;
    doc.chars = DOC_COST + (doc.cwd?.length ?? 0) + (doc.title?.length ?? 0) + doc.starts.length * START_COST + doc.entries.reduce((n, e) => n + e.text.length + e.folded.length + ENTRY_COST, 0);
    return doc;
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
async function sessionFiles(ctl: Control): Promise<{ id: string; file: string; size: number; mtimeMs: number }[] | undefined> {
    const root = paths.projectsDir();
    const out: { id: string; file: string; size: number; mtimeMs: number }[] = [];
    let dirs: string[];
    try {
        dirs = readdirSync(root);
    } catch {
        return out;
    }
    let seen = 0;
    for (const d of dirs) {
        if (!(await ctl.tick())) return undefined;
        const dir = join(root, d);
        let names: string[];
        try {
            if (!plainStat(dir)?.isDirectory()) continue;
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
                if (st?.isFile()) out.push({ id: f.slice(0, -".jsonl".length), file, size: st.size, mtimeMs: st.mtimeMs });
            } catch {
                // vanished or unreadable
            }
        }
    }
    out.sort((x, y) => y.mtimeMs - x.mtimeMs);
    // The budget may have run out while listing: then nothing after it counts as whole.
    return (await ctl.tick()) ? out : undefined;
}

/**
 * Messages containing `query` (a literal, in any case), newest sessions
 * first, at most PER_SESSION from one session. Stops early, with what it has
 * (`partial`), when the budget runs out; with nothing (`stale`) when replaced.
 */
export async function searchSessions(query: string, o: SearchOptions = {}): Promise<{ hits: SearchHit[]; partial: boolean; stale: boolean }> {
    const limit = Math.max(1, Math.min(o.limit ?? 50, 200));
    const fq = foldCase(query);
    const redaction = redactionVersion();
    const outdated = () => redaction !== redactionVersion() || Boolean(o.stale?.());
    const ctl = new Control(outdated, o.budgetMs ?? SEARCH_LIMITS.budgetMs, o.budgetBytes ?? SEARCH_LIMITS.budgetBytes);
    const hits: SearchHit[] = [];
    if (!fq) return { hits, partial: false, stale: false };
    for (const f of (await sessionFiles(ctl)) ?? []) {
        if (hits.length >= limit) break;
        if (o.include && !o.include(f.id)) continue;
        if (!(await ctl.tick())) break;
        let doc = docs.get(f.file);
        if (!doc || doc.size !== f.size || doc.mtimeMs !== f.mtimeMs || doc.redaction !== redactionVersion()) {
            try {
                doc = await readDoc(f.file, f.size, f.mtimeMs, ctl);
            } catch {
                continue; // vanished or unreadable
            }
            if (!doc) break; // stopped halfway
            remember(f.file, doc);
        }
        if (!doc.cwd) continue;
        const found: { e: Entry; at: number }[] = [];
        for (const e of doc.entries) {
            const at = e.folded.indexOf(fq);
            if (at < 0) continue;
            found.push({ e, at });
            if (found.length >= PER_SESSION) break;
        }
        if (!found.length) continue;
        const turns = await turnTimes(f.file, f.id, ctl);
        for (const { e, at } of found) {
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
    return { hits: stale ? [] : hits, partial: stale || Boolean(ctl.stopped), stale };
}
