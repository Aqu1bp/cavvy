// Reading the conversations Claude Code and Codex keep on disk, so one started
// in a terminal can be picked up in Harness. Strictly read-only: files are
// opened for reading and never written, renamed, locked or touched, and only
// conversation files are read (never credentials, settings, config or prompt
// history). What's in them is data: shown, and later handed to a model as
// history, never run or followed (paths inside a transcript are ignored).
//
// Claude Code: <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<folder>/<uuid>.jsonl,
// <folder> being the working directory with every non-alphanumeric character
// turned into "-" (cut to 200 characters plus a hash when longer).
// Codex: <CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl,
// thread titles in session_index.jsonl. Codex's app-server could list these
// too, but starting it writes its databases into CODEX_HOME, so the files
// are read directly.
//
// Both formats are internal to the CLIs and change between versions: every
// field is optional here, and a line that doesn't parse is skipped.

import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { commandTitle } from "../backends/cli";
import { titleFor } from "../backends/claude-code";
import { redact, redactPrefix } from "../util/redact";

export type CliSource = "claude-code" | "codex";
export const CLI_SOURCES: CliSource[] = ["claude-code", "codex"];

export interface CliLimits {
    /** Sessions shown per source. */
    list: number;
    /** Files looked at per source (newest first); older ones only count as "more". */
    scan: number;
    /** Bytes read from the start (and again from the end) of a file when listing. */
    head: number;
    /** Longer lines (pasted images, huge tool output) are skipped. */
    line: number;
    /** Bigger files aren't listed or imported. */
    file: number;
    /** Messages and characters imported; the earliest are left out beyond these. */
    messages: number;
    chars: number;
}

export const LIMITS: CliLimits = {
    list: 50,
    scan: 1000,
    head: 256 * 1024,
    line: 2 * 1024 * 1024,
    file: 64 * 1024 * 1024,
    messages: 400,
    chars: 400_000,
};

/** One prompt or reply is cut to this. */
const MAX_MESSAGE_CHARS = 40_000;
const MAX_TITLE = 120;

/** A session id as both CLIs make them (a UUID); nothing else is looked up. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validCliId(id: unknown): id is string {
    return typeof id === "string" && ID.test(id);
}

export function claudeRoot(): string {
    return process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");
}

export function codexRoot(): string {
    return process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
}

export interface CliSessionEntry {
    source: CliSource;
    id: string;
    /** The file it's in (stays on the server). */
    file: string;
    /** The folder it ran in, as it recorded it. */
    cwd: string;
    /** The client that started it (Codex's session_meta originator). */
    originator?: string;
    title: string;
    /** Its own title (Claude Code's custom or generated one, Codex's thread name), not the first prompt. */
    named: boolean;
    startedAt?: number;
    updatedAt: number;
    size: number;
    /** Prompts and replies seen; a lower bound when `partial`. */
    messages: number;
    partial: boolean;
    model?: string;
}

export interface CliListing {
    sessions: CliSessionEntry[];
    /** Sessions of this folder not listed (over the limit). */
    more: number;
    /** Ones already in Harness: listed apart, with a limit of their own, so they don't crowd out the rest. */
    held: CliSessionEntry[];
    moreHeld: number;
}

/**
 * How a listing treats a session, from its id and the client that started it
 * (Codex): one to offer, one already in Harness, or one to leave out (a run
 * of Harness's own sub-agents).
 */
export type CliSort = (id: string, originator: string | undefined) => "new" | "held" | "hidden";

// ---------------------------------------------------------------------------
// Reading files

/** A regular file (not a symlink) with its size and mtime, or nothing. */
function regularFile(path: string): { size: number; mtimeMs: number } | undefined {
    try {
        const st = lstatSync(path);
        return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : undefined;
    } catch {
        return undefined;
    }
}

/**
 * A file opened for reading only if it's a regular file: a symlink isn't
 * followed (even one swapped in since it was listed) and a FIFO can't block
 * the open. Returns the descriptor, or nothing.
 */
function openRegular(file: string): number | undefined {
    let fd: number;
    try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
        return undefined;
    }
    try {
        if (fstatSync(fd).isFile()) return fd;
    } catch {
        // fall through
    }
    closeSync(fd);
    return undefined;
}

/** Entries of a directory that is itself a real directory (not a symlink). */
function entries(dir: string): string[] {
    try {
        if (!lstatSync(dir).isDirectory()) return [];
        return readdirSync(dir);
    } catch {
        return [];
    }
}

/**
 * Whole lines from `[start, end)` of a file, skipping lines longer than
 * `maxLine` without holding them. A line cut by the range (or a torn last
 * line, still being written) is dropped. Opened read-only; nothing else.
 */
function readLines(file: string, start: number, end: number, maxLine: number, each: (line: string) => boolean | void, skipped?: () => void) {
    const fd = openRegular(file);
    if (fd === undefined) return;
    try {
        const chunk = Buffer.alloc(64 * 1024);
        let parts: Buffer[] = [];
        let len = 0;
        let skipping = false;
        // A range that doesn't start at 0 starts mid-line: drop up to the first newline.
        let first = start > 0;
        for (let pos = start; pos < end; ) {
            const n = readSync(fd, chunk, 0, Math.min(chunk.length, end - pos), pos);
            if (n <= 0) break;
            pos += n;
            const c = chunk.subarray(0, n);
            for (let i = 0; i < n; ) {
                const nl = c.indexOf(10, i);
                const piece = c.subarray(i, nl < 0 ? n : nl);
                if (!skipping && !first) {
                    len += piece.length;
                    if (len > maxLine) {
                        skipping = true;
                        parts = [];
                    } else parts.push(Buffer.from(piece));
                }
                if (nl < 0) break;
                if (!skipping && !first && len) {
                    if (each(Buffer.concat(parts).toString("utf-8")) === false) return;
                } else if (skipping) skipped?.();
                parts = [];
                len = 0;
                skipping = false;
                first = false;
                i = nl + 1;
            }
        }
    } finally {
        closeSync(fd);
    }
}

/** Lines of a file as JSON objects; unparseable lines are skipped. */
function readJsonLines(file: string, start: number, end: number, maxLine: number, each: (v: Record<string, any>) => boolean | void, skipped?: () => void) {
    readLines(file, start, end, maxLine, (line) => {
        let v: unknown;
        try {
            v = JSON.parse(line);
        } catch {
            return;
        }
        if (v && typeof v === "object" && !Array.isArray(v)) return each(v as Record<string, any>);
    }, skipped);
}

/** The head and (for a file longer than that) the tail. */
function headAndTail(file: string, size: number, limits: CliLimits, each: (v: Record<string, any>, inTail: boolean) => void) {
    readJsonLines(file, 0, Math.min(size, limits.head), limits.line, (v) => each(v, false));
    if (size > limits.head) readJsonLines(file, Math.max(limits.head, size - limits.head), size, limits.line, (v) => each(v, true));
}

/** What the first lines say about a session: the folder it ran in, and (Codex) the client that started it. */
interface Probe {
    cwd?: string;
    originator?: string;
}

/** A string field of a first line too long to parse (Codex's holds its whole system prompt). */
function fieldOfFirstLine(text: string, key: string): string | undefined {
    const m = new RegExp(`^\\{[^\\n]*?"${key}"\\s*:\\s*("(?:[^"\\\\\\n]|\\\\.)*")`).exec(text);
    if (!m) return undefined;
    try {
        const v = JSON.parse(m[1]!);
        return typeof v === "string" && v ? v : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The folder a session ran in, from its first lines: a whole line's own `cwd`
 * (Claude Code's entries, Codex's session_meta payload). Only a first line too
 * long for the read is searched as text. A few KB usually do; a pasted image
 * up front takes up to the head.
 */
function probe(file: string, size: number, limits: CliLimits): Probe {
    for (const bytes of [16 * 1024, limits.head]) {
        const end = Math.min(size, bytes);
        let found: Probe | undefined;
        let lines = 0;
        readJsonLines(file, 0, end, limits.line, (v) => {
            lines++;
            const meta = v.type === "session_meta" && v.payload && typeof v.payload === "object" ? v.payload : undefined;
            const cwd = typeof v.cwd === "string" ? v.cwd : typeof meta?.cwd === "string" ? meta.cwd : undefined;
            if (cwd) {
                found = { cwd, originator: typeof meta?.originator === "string" ? meta.originator : undefined };
                return false;
            }
        });
        if (found) return found;
        if (!lines) {
            const text = headText(file, Math.min(end, 64 * 1024));
            const cwd = fieldOfFirstLine(text, "cwd");
            if (cwd) return { cwd, originator: fieldOfFirstLine(text, "originator") };
        }
        if (end >= size) break;
    }
    return {};
}

function headText(file: string, bytes: number): string {
    const fd = openRegular(file);
    if (fd === undefined) return "";
    try {
        const buf = Buffer.alloc(bytes);
        return buf.subarray(0, readSync(fd, buf, 0, bytes, 0)).toString("utf-8");
    } finally {
        closeSync(fd);
    }
}

// ---------------------------------------------------------------------------
// Folders

/** The folder as the file system has it (/tmp and /private/tmp are one on macOS). */
function realFolder(p: string, cache: Map<string, string>): string {
    const r = resolve(p);
    let real = cache.get(r);
    if (real === undefined) {
        try {
            real = realpathSync(r);
        } catch {
            real = r;
        }
        cache.set(r, real);
    }
    return real;
}

/** Claude Code's folder name for a working directory. */
function claudeFolderName(cwd: string): string {
    return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Folders under projects/ that may hold this folder's sessions (several paths can share one; each session's own cwd decides). */
function claudeFolders(root: string, cwd: string, real: string): string[] {
    const projects = join(root, "projects");
    const names = new Set([claudeFolderName(resolve(cwd)), claudeFolderName(real)]);
    const pinned = process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
    if (pinned && /^[A-Za-z0-9_-]{1,64}$/.test(pinned)) names.add(pinned);
    const out: string[] = [];
    const all = entries(projects);
    for (const name of all) {
        const hit = [...names].some((n) => name === n || (n.length > 200 && name.startsWith(n.slice(0, 200))));
        if (hit) out.push(join(projects, name));
    }
    return out;
}

// ---------------------------------------------------------------------------
// Listing

interface Candidate {
    file: string;
    id: string;
    size: number;
    mtimeMs: number;
}

/** Files that may hold this folder's sessions, newest first, within the size cap. */
function candidatesFor(source: CliSource, root: string, cwd: string, real: string, limits: CliLimits): Candidate[] {
    const candidates = (source === "claude-code" ? claudeCandidates(root, cwd, real) : codexCandidates(root, limits)).filter((c) => c.size <= limits.file);
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates;
}

/** Recent sessions of one folder, newest first. `cwd` is compared by real path. */
export function listCliSessions(source: CliSource, cwd: string, o: { root?: string; limits?: Partial<CliLimits>; sort?: CliSort } = {}): CliListing {
    const limits = { ...LIMITS, ...o.limits };
    const root = o.root ?? (source === "claude-code" ? claudeRoot() : codexRoot());
    const cache = new Map<string, string>();
    const real = realFolder(cwd, cache);
    const candidates = candidatesFor(source, root, cwd, real, limits);
    const titles = source === "codex" ? codexTitles(root, limits) : undefined;
    const out: CliListing = { sessions: [], more: 0, held: [], moreHeld: 0 };
    candidates.forEach((c, i) => {
        if (i >= limits.scan) {
            // Not looked at: Claude Code's are in this folder's own store folder; Codex's could be anyone's.
            if (source === "claude-code") out.more++;
            return;
        }
        const p = probe(c.file, c.size, limits);
        if (!p.cwd || realFolder(p.cwd, cache) !== real) return;
        const kind = o.sort?.(c.id, p.originator) ?? "new";
        if (kind === "hidden") return;
        const list = kind === "held" ? out.held : out.sessions;
        // Counted without being read: the limit is reached.
        if (list.length >= limits.list) {
            if (kind === "held") out.moreHeld++;
            else out.more++;
            return;
        }
        const e = source === "claude-code" ? claudeEntry(c, limits) : codexEntry(c, limits, titles!);
        if (e && e.messages > 0) list.push(e);
    });
    return out;
}

/** One session by id, found only among the files a listing of this folder looks at, and only if it ran here. */
export function findCliSession(source: CliSource, cwd: string, id: string, o: { root?: string; limits?: Partial<CliLimits> } = {}): CliSessionEntry | undefined {
    if (!validCliId(id)) return undefined;
    const limits = { ...LIMITS, ...o.limits };
    const root = o.root ?? (source === "claude-code" ? claudeRoot() : codexRoot());
    const cache = new Map<string, string>();
    const real = realFolder(cwd, cache);
    const c = candidatesFor(source, root, cwd, real, limits)
        .slice(0, limits.scan)
        .find((x) => x.id.toLowerCase() === id.toLowerCase());
    if (!c) return undefined;
    const p = probe(c.file, c.size, limits);
    if (!p.cwd || realFolder(p.cwd, cache) !== real) return undefined;
    const e = source === "claude-code" ? claudeEntry(c, limits) : codexEntry(c, limits, codexTitles(root, limits));
    return e && e.messages > 0 ? e : undefined;
}

function claudeCandidates(root: string, cwd: string, real: string): Candidate[] {
    const out: Candidate[] = [];
    for (const dir of claudeFolders(root, cwd, real)) {
        for (const name of entries(dir)) {
            const m = /^(.+)\.jsonl$/.exec(name);
            if (!m || !validCliId(m[1])) continue;
            const file = join(dir, name);
            const st = regularFile(file);
            if (st) out.push({ file, id: m[1]!, size: st.size, mtimeMs: st.mtimeMs });
        }
    }
    return out;
}

/** Rollout files, newest days first, at most `scan` (and some slack for files of other folders). */
function codexCandidates(root: string, limits: CliLimits): Candidate[] {
    const out: Candidate[] = [];
    const cap = limits.scan * 4;
    const desc = (names: string[], re: RegExp) => names.filter((n) => re.test(n)).sort().reverse();
    const sessions = join(root, "sessions");
    for (const y of desc(entries(sessions), /^\d{4}$/)) {
        for (const m of desc(entries(join(sessions, y)), /^\d{2}$/)) {
            for (const d of desc(entries(join(sessions, y, m)), /^\d{2}$/)) {
                const dir = join(sessions, y, m, d);
                for (const name of desc(entries(dir), /^rollout-.*\.jsonl$/)) {
                    const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name)?.[1];
                    if (!id) continue;
                    const file = join(dir, name);
                    const st = regularFile(file);
                    if (st) out.push({ file, id, size: st.size, mtimeMs: st.mtimeMs });
                    if (out.length >= cap) return out;
                }
            }
        }
    }
    return out;
}

/** Codex's thread names (the newest entry for an id wins), from the end of its index. */
function codexTitles(root: string, limits: CliLimits): Map<string, string> {
    const titles = new Map<string, string>();
    const file = join(root, "session_index.jsonl");
    const st = regularFile(file);
    if (!st) return titles;
    const span = Math.min(st.size, limits.head * 4);
    readJsonLines(file, st.size - span, st.size, limits.line, (v) => {
        if (typeof v.id === "string" && typeof v.thread_name === "string" && v.thread_name.trim()) titles.set(v.id.toLowerCase(), v.thread_name);
    });
    return titles;
}

function shortTitle(text: string): string {
    const one = redact(text).replace(/\s+/g, " ").trim();
    return one.length > MAX_TITLE ? one.slice(0, MAX_TITLE - 1) + "…" : one;
}

function time(v: unknown): number | undefined {
    const t = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : NaN;
    return Number.isFinite(t) ? t : undefined;
}

// ---------------------------------------------------------------------------
// Claude Code

/** Text of a user prompt, or nothing for tool results, meta and command output. */
function claudePromptText(e: Record<string, any>): { text: string; command?: boolean } | undefined {
    if (e.type !== "user" || e.isSidechain || e.isMeta || e.isCompactSummary || e.isVisibleInTranscriptOnly) return undefined;
    const c = e.message?.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
        if (c.some((p) => p?.type === "tool_result")) return undefined;
        text = c.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n\n");
    }
    text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    if (!text) return undefined;
    // A slash command: shown as typed. Its output and caveats are left out.
    const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
    if (name) {
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
        return { text: args ? `${name} ${args}` : name, command: true };
    }
    if (/^<(local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr)>/.test(text)) return undefined;
    return { text };
}

function claudeEntry(c: Candidate, limits: CliLimits): CliSessionEntry | undefined {
    let cwd: string | undefined;
    let first: string | undefined;
    let title: string | undefined;
    let startedAt: number | undefined;
    let model: string | undefined;
    let messages = 0;
    // Counted in the tail only for a file whose head holds none (a huge first line).
    let tailMessages = 0;
    let tailFirst: string | undefined;
    const replies = new Set<string>();
    headAndTail(c.file, c.size, limits, (e, inTail) => {
        if (typeof e.sessionId === "string" && e.sessionId.toLowerCase() !== c.id.toLowerCase()) return;
        if (e.type === "custom-title" && typeof e.customTitle === "string" && e.customTitle.trim()) title = e.customTitle;
        else if (e.type === "ai-title" && typeof e.aiTitle === "string" && e.aiTitle.trim()) title ??= e.aiTitle;
        else if (e.type === "summary" && typeof e.summary === "string" && e.summary.trim()) title ??= e.summary;
        if (e.isSidechain) return;
        if (!cwd && typeof e.cwd === "string") cwd = e.cwd;
        if (!inTail) startedAt ??= time(e.timestamp);
        const p = claudePromptText(e);
        if (p) {
            if (inTail) {
                tailFirst ??= p.text;
                tailMessages++;
            } else {
                first ??= p.text;
                messages++;
            }
        }
        if (e.type === "assistant" && e.message) {
            if (typeof e.message.model === "string" && e.message.model !== "<synthetic>") model = e.message.model;
            const id = typeof e.message.id === "string" ? e.message.id : e.uuid;
            if (typeof id === "string" && !replies.has(id)) {
                replies.add(id);
                if (inTail) tailMessages++;
                else messages++;
            }
        }
    });
    if (!cwd) return undefined;
    if (!messages) {
        messages = tailMessages;
        first ??= tailFirst;
    }
    return {
        source: "claude-code",
        id: c.id,
        file: c.file,
        cwd,
        title: shortTitle(title ?? first ?? "(untitled)"),
        named: Boolean(title),
        startedAt,
        updatedAt: c.mtimeMs,
        size: c.size,
        messages,
        partial: c.size > limits.head,
        model: model ? redact(model) : undefined,
    };
}

// ---------------------------------------------------------------------------
// Codex

/** Wrappers Codex adds as user messages (instructions, environment), not typed by anyone. */
const CODEX_INJECTED = /^\s*(<(environment_context|user_instructions|user_shell_command|turn_aborted|subagent_notification|permissions instructions|skills_instructions|collaboration_mode)\b|# AGENTS\.md instructions)/;

function codexText(content: unknown, kind: "input_text" | "output_text"): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((p) => p && (p.type === kind || p.type === "text") && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n\n");
}

/** A prompt the user typed, from a response item. */
function codexPrompt(e: Record<string, any>): string | undefined {
    const p = e.payload;
    if (e.type !== "response_item" || p?.type !== "message" || p.role !== "user") return undefined;
    const text = codexText(p.content, "input_text").trim();
    if (!text || CODEX_INJECTED.test(text)) return undefined;
    return text;
}

function codexReply(e: Record<string, any>): string | undefined {
    const p = e.payload;
    if (e.type !== "response_item" || p?.type !== "message" || p.role !== "assistant") return undefined;
    const text = codexText(p.content, "output_text").trim();
    return text || undefined;
}

/** A thread a sub-agent ran (its own rollout file): not a conversation of the user's. */
function codexSubAgent(meta: Record<string, any>): boolean {
    const s = meta.source;
    return Boolean(s && typeof s === "object" && ("subagent" in s || "subAgent" in s)) || typeof meta.parent_thread_id === "string";
}

function codexEntry(c: Candidate, limits: CliLimits, titles: Map<string, string>): CliSessionEntry | undefined {
    let cwd: string | undefined;
    let first: string | undefined;
    let startedAt: number | undefined;
    let model: string | undefined;
    let messages = 0;
    let tailMessages = 0;
    let tailFirst: string | undefined;
    let originator: string | undefined;
    let sub = false;
    let other = false;
    headAndTail(c.file, c.size, limits, (e, inTail) => {
        const p = e.payload;
        if (e.type === "session_meta" && p && typeof p === "object") {
            if (typeof p.id === "string" && p.id.toLowerCase() !== c.id.toLowerCase()) other = true;
            if (typeof p.cwd === "string") cwd ??= p.cwd;
            if (typeof p.originator === "string") originator ??= p.originator;
            startedAt ??= time(p.timestamp) ?? time(e.timestamp);
            if (codexSubAgent(p)) sub = true;
            return;
        }
        if (e.type === "turn_context" && typeof p?.model === "string") model = p.model;
        const prompt = codexPrompt(e);
        if (prompt) {
            if (inTail) {
                tailFirst ??= prompt;
                tailMessages++;
            } else {
                first ??= prompt;
                messages++;
            }
        } else if (codexReply(e)) {
            if (inTail) tailMessages++;
            else messages++;
        }
    });
    // Counted in the tail only for a file whose head holds none (a system prompt longer than the head).
    if (!messages) {
        messages = tailMessages;
        first ??= tailFirst;
    }
    // The first line (with the folder) can be longer than the head read: the probe found it.
    const p = cwd && originator ? undefined : probe(c.file, c.size, limits);
    cwd ??= p?.cwd;
    originator ??= p?.originator;
    if (!cwd || sub || other) return undefined;
    const name = titles.get(c.id.toLowerCase());
    return {
        source: "codex",
        id: c.id,
        file: c.file,
        cwd,
        ...(originator ? { originator } : {}),
        title: shortTitle(name ?? first ?? "(untitled)"),
        named: Boolean(name),
        startedAt,
        updatedAt: c.mtimeMs,
        size: c.size,
        messages,
        partial: c.size > limits.head,
        model: model ? redact(model) : undefined,
    };
}

// ---------------------------------------------------------------------------
// Transcripts

export interface CliTurn {
    prompt: string;
    command?: boolean;
    at?: number;
    /** The agent's replies in this turn, in order. */
    replies: string[];
    /** Tools it used, as titles ("Bash(npm test)", "Edit(src/x.ts)"): the first ones. */
    actions: string[];
    /** Tools used beyond those listed. */
    moreActions?: number;
    end?: number;
}

export interface CliTranscript {
    turns: CliTurn[];
    /** Prompts and replies left out (the earliest), over the limits. */
    omitted: number;
    model?: string;
}

const CUT = "\n\n[…cut short on import]";
/** Tool titles kept per turn (Harness lists as many after a backend's turn). */
const MAX_ACTIONS = 50;
const MAX_ACTION_CHARS = 200;

function clip(text: string, max = MAX_MESSAGE_CHARS, suffix = CUT): string {
    if (text.length <= max) return text;
    const mark = suffix.slice(0, max);
    return text.slice(0, max - mark.length) + mark;
}

/** A turn's replies within one message's budget, all of them together: the rest is cut. */
function clipReplies(replies: string[]): string[] {
    const out: string[] = [];
    let left = MAX_MESSAGE_CHARS;
    for (const r of replies) {
        if (left <= 0) break;
        if (r.length <= left) {
            out.push(r);
            left -= r.length + 2;
            continue;
        }
        out.push(clip(r, left));
        break;
    }
    return out;
}

/** The conversation in a listed session: prompts, replies and what tools were used. Redacted. */
export function readCliTranscript(entry: CliSessionEntry, o: { limits?: Partial<CliLimits> } = {}): CliTranscript {
    const limits = { ...LIMITS, ...o.limits };
    const st = regularFile(entry.file);
    if (!st || st.size > limits.file) return { turns: [], omitted: 0 };
    const raw = entry.source === "claude-code" ? claudeTurns(entry, st.size, limits) : codexTurns(entry, st.size, limits);
    return bound(raw, limits);
}

/** Keep the latest turns within the limits; count what's left out. */
function bound(t: CliTranscript, limits: CliLimits): CliTranscript {
    const turns = t.turns.map((x) => ({
        ...x,
        prompt: clip(redact(x.prompt)),
        replies: clipReplies(x.replies.map((r) => redact(r))),
        actions: x.actions.slice(0, MAX_ACTIONS).map((a) => clip(redact(a), MAX_ACTION_CHARS, "…")),
        ...(x.actions.length > MAX_ACTIONS ? { moreActions: x.actions.length - MAX_ACTIONS } : {}),
    }));
    // Keep even the newest turn, but not at the cost of an unbounded import.
    // Clipping markers count toward the budget too.
    const newest = turns.at(-1);
    if (newest) {
        let left = Math.max(0, limits.chars);
        const take = (text: string, suffix = CUT) => {
            const kept = clip(text, left, suffix);
            left -= kept.length;
            return kept;
        };
        newest.prompt = take(newest.prompt);
        newest.replies = newest.replies.map((r) => take(r)).filter(Boolean);
        const actions = newest.actions.map((a) => take(a, "…")).filter(Boolean);
        newest.moreActions = (newest.moreActions ?? 0) + newest.actions.length - actions.length;
        newest.actions = actions;
    }
    let messages = 0;
    let chars = 0;
    let from = turns.length;
    while (from > 0) {
        const x = turns[from - 1]!;
        const m = 1 + (x.replies.length || x.actions.length ? 1 : 0);
        const c = x.prompt.length + x.replies.reduce((n, r) => n + r.length, 0) + x.actions.reduce((n, a) => n + a.length, 0);
        if (from < turns.length && (messages + m > limits.messages || chars + c > limits.chars)) break;
        messages += m;
        chars += c;
        from--;
    }
    const omitted = turns.slice(0, from).reduce((n, x) => n + 1 + x.replies.length, 0);
    return { turns: turns.slice(from), omitted: t.omitted + omitted, model: t.model ? redact(t.model) : undefined };
}

function claudeTurns(entry: CliSessionEntry, size: number, limits: CliLimits): CliTranscript {
    // Entries chain by parentUuid; a file can hold abandoned branches (a rewind) and
    // sub-agents' sidechains. Follow the chain back from the last entry when it's whole.
    const byUuid = new Map<string, Record<string, any>>();
    const order: Record<string, any>[] = [];
    let leaf: string | undefined;
    readJsonLines(entry.file, 0, size, limits.line, (e) => {
        if (typeof e.sessionId === "string" && e.sessionId.toLowerCase() !== entry.id.toLowerCase()) return;
        if (e.type === "last-prompt" && typeof e.leafUuid === "string") leaf = e.leafUuid;
        if (typeof e.uuid !== "string" || e.isSidechain) return;
        // Every entry links the chain; only what the import uses is kept of each.
        const slim = slimClaude(e);
        byUuid.set(e.uuid, slim);
        order.push(slim);
    }, () => order.push(SKIPPED));
    let chain: Record<string, any>[] = order;
    const lastConversational = [...order].reverse().find((e) => e !== SKIPPED && (e.type === "user" || e.type === "assistant"));
    const start = lastConversational?.uuid ?? (leaf && byUuid.has(leaf) ? leaf : undefined);
    if (start) {
        const walked: Record<string, any>[] = [];
        const seen = new Set<string>();
        let cur: string | undefined = start;
        let whole = true;
        while (cur) {
            if (seen.has(cur)) break;
            seen.add(cur);
            const e = byUuid.get(cur);
            if (!e) {
                // A line too long to read (a big tool result) is missing from the chain: entries are
                // appended in order, so its parent is the entry written just before it.
                const child = walked[walked.length - 1];
                let j = child ? order.indexOf(child) - 1 : -1;
                if (order[j] !== SKIPPED) {
                    whole = false;
                    break;
                }
                while (order[j] === SKIPPED) j--;
                cur = order[j]?.uuid;
                continue;
            }
            walked.push(e);
            cur = typeof e.parentUuid === "string" ? e.parentUuid : typeof e.logicalParentUuid === "string" ? e.logicalParentUuid : undefined;
        }
        walked.reverse();
        if (whole) chain = walked;
        else {
            // A link is missing (a skipped line): what's known of the chain, and before it, the file's
            // earlier entries in order. Branches abandoned after that point stay out.
            const known = new Set(walked);
            const firstAt = order.indexOf(walked[0]!);
            chain = [...order.slice(0, Math.max(0, firstAt)).filter((e) => e !== SKIPPED && !known.has(e)), ...walked];
        }
    }
    const turns: CliTurn[] = [];
    let turn: CliTurn | undefined;
    let model: string | undefined;
    let replyId: string | undefined;
    for (const e of chain) {
        const at = time(e.timestamp);
        const prompt = claudePromptText(e);
        if (prompt) {
            turn = { prompt: prompt.text, ...(prompt.command ? { command: true } : {}), at, replies: [], actions: [] };
            turns.push(turn);
            replyId = undefined;
            continue;
        }
        if (e.type !== "assistant" || !turn) continue;
        if (typeof e.message?.model === "string" && e.message.model !== "<synthetic>") model = e.message.model;
        const content = Array.isArray(e.message?.content) ? e.message.content : [];
        for (const p of content) {
            if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) {
                // Blocks of one reply are written as separate entries with the same message id.
                const id = e.message?.id;
                if (id && id === replyId && turn.replies.length) turn.replies[turn.replies.length - 1] += "\n\n" + p.text;
                else turn.replies.push(p.text);
                replyId = id;
            } else if (p?.type === "tool_use" && typeof p.name === "string") {
                const input = p.input && typeof p.input === "object" ? (p.input as Record<string, unknown>) : {};
                turn.actions.push(titleFor(p.name === "Agent" ? "Task" : p.name, input));
            }
        }
        if (at) turn.end = at;
    }
    return { turns, omitted: 0, model };
}

/** Where a line was too long to read, in a Claude Code file's entries. */
const SKIPPED: Record<string, any> = Object.freeze({ type: "skipped" });

/** What's used from an entry; tool results and other bulk are dropped as soon as it's read. */
function slimClaude(e: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = { type: e.type, uuid: e.uuid, parentUuid: e.parentUuid, logicalParentUuid: e.logicalParentUuid, timestamp: e.timestamp };
    if (e.type === "user") {
        Object.assign(out, { isMeta: e.isMeta, isCompactSummary: e.isCompactSummary, isVisibleInTranscriptOnly: e.isVisibleInTranscriptOnly });
        const c = e.message?.content;
        out.message = { content: Array.isArray(c) ? c.map((p: any) => (p?.type === "text" ? { type: "text", text: p.text } : { type: p?.type })) : c };
    } else if (e.type === "assistant") {
        const c = Array.isArray(e.message?.content) ? e.message.content : [];
        out.message = {
            id: e.message?.id,
            model: e.message?.model,
            content: c.filter((p: any) => p?.type === "text" || p?.type === "tool_use").map((p: any) => (p.type === "text" ? { type: "text", text: p.text } : { type: "tool_use", name: p.name, input: slimInput(p.input) })),
        };
    }
    return out;
}

/** Only the fields tool titles use, so a big Write doesn't stay in memory. */
function slimInput(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== "object") return {};
    const i = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of ["command", "file_path", "notebook_path", "pattern", "path", "url", "query", "description", "subagent_type", "skill", "name"]) {
        // Redacted whole, then cut: a registered value crossing the cut must not leave its first part.
        if (typeof i[k] === "string") out[k] = redactPrefix(i[k] as string, 500);
    }
    return out;
}

function codexTurns(entry: CliSessionEntry, size: number, limits: CliLimits): CliTranscript {
    const turns: CliTurn[] = [];
    let turn: CliTurn | undefined;
    let model: string | undefined;
    readJsonLines(entry.file, 0, size, limits.line, (e) => {
        const p = e.payload;
        const at = time(e.timestamp);
        if (e.type === "turn_context" && typeof p?.model === "string") model = p.model;
        if (e.type !== "response_item" || !p || typeof p !== "object") return;
        const prompt = codexPrompt(e);
        if (prompt) {
            turn = { prompt, at, replies: [], actions: [] };
            turns.push(turn);
            return;
        }
        if (!turn) return;
        const reply = codexReply(e);
        if (reply) turn.replies.push(reply);
        else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") turn.actions.push(codexAction(p));
        else if (p.type === "web_search_call") turn.actions.push(`WebSearch(${typeof p.action?.query === "string" ? p.action.query : ""})`);
        else return;
        if (at) turn.end = at;
    });
    return { turns, omitted: 0, model };
}

/** A title for one of Codex's tool calls, like Harness's Codex backend gives them. */
function codexAction(p: Record<string, any>): string {
    const name = typeof p.name === "string" ? p.name : p.type === "local_shell_call" ? "shell" : "tool";
    let args: Record<string, any> = {};
    if (typeof p.arguments === "string") {
        try {
            const v = JSON.parse(p.arguments);
            if (v && typeof v === "object") args = v;
        } catch {
            // not JSON: nothing to show but the name
        }
    } else if (p.action && typeof p.action === "object") args = p.action;
    if (name === "shell" || name === "exec_command" || name === "shell_command" || name === "local_shell" || p.type === "local_shell_call") {
        const cmd = Array.isArray(args.command) ? shellCommand(args.command) : typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
        // The title cuts the command: redact it whole first.
        return commandTitle(redact(cmd));
    }
    if (name === "apply_patch") {
        const patch = typeof p.input === "string" ? p.input : typeof args.input === "string" ? args.input : "";
        const files = [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)];
        if (!files.length) return "Edit";
        const verb = files.every((f) => f[1] === "Add") ? "Write" : "Edit";
        // Redacted before trimming: a registered value with spaces at its ends wouldn't match after.
        return `${verb}(${redact(files[0]![2]!).trim()}${files.length > 1 ? ` +${files.length - 1} more` : ""})`;
    }
    return name;
}

/** ["bash", "-lc", "npm test"] reads as "npm test". */
function shellCommand(argv: unknown[]): string {
    const parts = argv.filter((a): a is string => typeof a === "string");
    if (parts.length === 3 && /(^|\/)(ba|z)?sh$/.test(parts[0]!) && /^-l?c$/.test(parts[1]!)) return parts[2]!;
    return parts.join(" ");
}
